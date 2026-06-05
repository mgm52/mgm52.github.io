import * as devalue from 'devalue';
import { compressToUTF16, decompressFromUTF16 } from 'lz-string';
import {
  Building, GameState, createDemons, emptyBuildingCounts, ensureDemonRoster, pruneAllAssignedGoblins, rebuildWalls,
} from './state';

const STORAGE_KEY = 'rts.savegame.v1';
const VERSION = 2;

// v2 wraps devalue.stringify in LZString.compressToUTF16. devalue handles
// Maps/Sets/Dates natively (no more __t tags) and emits a denser payload than
// JSON.stringify; LZString gives another ~80% on top because the state is
// dominated by repeating cell coordinates and goblin IDs.
//
// Detection on load: the new format is binary-ish UTF-16. The old v1 format
// is JSON, so it always starts with '{'. We probe the first character and
// route to the right decoder.

type SaveEnvelope = {
  version: number;
  savedAt: number;
  state: GameState;
};

// ─── Legacy v1 (JSON + __t tag) — read-only path for migration. ─────────
function v1Reviver(_key: string, value: unknown): unknown {
  if (value && typeof value === 'object' && '__t' in (value as Record<string, unknown>)) {
    const v = value as { __t: string; v: unknown };
    if (v.__t === 'Map') return new Map(v.v as [unknown, unknown][]);
    if (v.__t === 'Set') return new Set(v.v as unknown[]);
  }
  return value;
}

function tryDecodeV2(raw: string): SaveEnvelope | null {
  try {
    const decoded = decompressFromUTF16(raw);
    if (!decoded) return null;
    return devalue.parse(decoded) as SaveEnvelope;
  } catch { return null; }
}

function tryDecodeV1(raw: string): SaveEnvelope | null {
  try {
    return JSON.parse(raw, v1Reviver) as SaveEnvelope;
  } catch { return null; }
}

export function saveGame(state: GameState): void {
  try {
    const env: SaveEnvelope = { version: VERSION, savedAt: Date.now(), state };
    const serialized = devalue.stringify(env);
    const compressed = compressToUTF16(serialized);
    lastSyncSaveAt = performance.now();
    localStorage.setItem(STORAGE_KEY, compressed);
  } catch { /* storage full / unavailable — silently skip */ }
}

// ─── Background autosave ────────────────────────────────────────────────
// devalue.stringify + compressToUTF16 on a mature colony block the main
// thread for hundreds of milliseconds — running that synchronously every
// autosave made the game visibly hitch every 10 seconds on mobile. The
// periodic autosave instead clones the state to a worker (structured clone
// is native and fast) and lets the worker do the heavy serialization +
// compression; only the cheap localStorage write happens back here.
//
// The synchronous saveGame above stays for the moments that can't wait for
// a worker round-trip: pagehide / tab-hidden / pause.

// Telemetry for the ?fps debug HUD — duration/size of the last completed
// background save and how it was performed.
export type SaveStats = {
  at: number;            // performance.now() when the save finished
  cloneMs: number;       // main-thread cost (structured clone postMessage)
  workMs: number;        // worker-side serialize+compress
  compressedKb: number;
  mode: 'worker' | 'sync';
};
let lastSaveStats: SaveStats | null = null;
export function getLastSaveStats(): SaveStats | null { return lastSaveStats; }

let saveWorker: Worker | null = null;
let saveWorkerBroken = false;
let saveSeq = 0;
let saveInFlight = false;
// Timestamps guarding against a stale write: if a synchronous save (pagehide,
// pause) lands while a worker save is still compressing, the worker's reply
// must not overwrite the newer snapshot with the older one.
let lastSyncSaveAt = 0;
let inFlightPostedAt = 0;

function getSaveWorker(): Worker | null {
  if (saveWorkerBroken) return null;
  if (saveWorker) return saveWorker;
  try {
    saveWorker = new Worker(new URL('./save-worker.ts', import.meta.url), { type: 'module' });
    saveWorker.onmessage = (e: MessageEvent<{ seq: number; compressed: string; rawChars: number; workMs: number }>) => {
      saveInFlight = false;
      // A sync save (pagehide/pause) wrote a NEWER snapshot while this one
      // was compressing — drop the stale result instead of clobbering it.
      if (lastSyncSaveAt > inFlightPostedAt) return;
      try { localStorage.setItem(STORAGE_KEY, e.data.compressed); } catch { /* storage full — skip */ }
      if (lastSaveStats && lastSaveStats.mode === 'worker') {
        lastSaveStats.at = performance.now();
        lastSaveStats.workMs = e.data.workMs;
        lastSaveStats.compressedKb = (e.data.compressed.length * 2) / 1024;
      }
    };
    saveWorker.onerror = () => {
      // Worker failed to load/run (CSP, bundling, old browser) — fall back
      // to synchronous saves for the rest of the session.
      saveWorkerBroken = true;
      saveInFlight = false;
      saveWorker?.terminate();
      saveWorker = null;
    };
    return saveWorker;
  } catch {
    saveWorkerBroken = true;
    return null;
  }
}

// Fire-and-forget autosave. Skips this round if the previous one is still
// compressing (better to save 10s later than queue up overlapping clones).
export function saveGameInBackground(state: GameState): void {
  const w = getSaveWorker();
  if (!w) {
    const t0 = performance.now();
    saveGame(state);
    lastSaveStats = { at: performance.now(), cloneMs: performance.now() - t0, workMs: 0, compressedKb: 0, mode: 'sync' };
    return;
  }
  if (saveInFlight) return;
  saveInFlight = true;
  const env: SaveEnvelope = { version: VERSION, savedAt: Date.now(), state };
  const t0 = performance.now();
  try {
    w.postMessage({ seq: ++saveSeq, env });
    inFlightPostedAt = performance.now();
    lastSaveStats = { at: performance.now(), cloneMs: performance.now() - t0, workMs: 0, compressedKb: 0, mode: 'worker' };
  } catch {
    // State contained something the structured clone rejected — save the
    // old way and stop trying the worker (it would fail every time).
    saveWorkerBroken = true;
    saveInFlight = false;
    saveGame(state);
    lastSaveStats = { at: performance.now(), cloneMs: performance.now() - t0, workMs: 0, compressedKb: 0, mode: 'sync' };
  }
}

export function loadGame(): { state: GameState; savedAt: number } | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;

    // Try the current format first; on any failure (corruption, wrong
    // codec, schema drift) fall back to the legacy v1 JSON decoder. Both
    // paths return null silently so a corrupt save just degrades to "no
    // resume available" rather than throwing.
    const env = tryDecodeV2(raw) ?? tryDecodeV1(raw);
    if (!env || !env.state) return null;

    // Defaults for fields added after a save was written, so resuming an older
    // save doesn't hit undefined arrays/flags.
    env.state.lightningBolts ??= [];
    env.state.powerBoosts ??= [];
    env.state.moneyEarned ??= 0;
    env.state.bloodEarned ??= 0;
    env.state.dragonBone ??= 0;
    env.state.dragonBoneEarned ??= 0;
    env.state.dragonBoneUnlocked ??= false;
    env.state.pendingStrike = false;
    env.state.pendingCandle = false;
    // Spatial-index version — absent from saves predating buildingAtCell's
    // cell→building index. Seed it so the first markBuildingsChanged++ doesn't
    // turn undefined into NaN (which would defeat the index's cache tag).
    env.state.buildingsVersion ??= 0;
    // Dragons / space scene — added with the Dragon Beacon payoff. Default for
    // saves predating them, and always resume on the ground (the climb is a
    // live-only animation).
    env.state.dragons ??= new Map();
    env.state.dragonSpawnQueue ??= [];
    env.state.minotaursBought ??= 0;
    // First-Minotaur mercy discount — saves predating it decide on the next
    // refresh (no-op if the player already owns Minotaurs, since the discount
    // only ever applies to purchase #1).
    env.state.minotaurFirstDiscount ??= null;
    env.state.spaceBuildings ??= new Map();
    // `selected` was added with space-building selection; default it so saves
    // predating it don't leave the field undefined.
    for (const sb of env.state.spaceBuildings.values()) sb.selected ??= false;
    // Units snatched into space (robots + the doomed) — added with the
    // dragon-snatch mechanic. Selection is ephemeral.
    env.state.spaceUnits ??= new Map();
    for (const su of env.state.spaceUnits.values()) su.selected = false;
    // Orbital Platform placement mode is ephemeral — never resume armed.
    env.state.pendingOrbital = false;
    // Strike side-tasks switched from a single struck13Goblins boolean to a
    // maxStruckAtOnce counter. Carry old progress forward (a true flag meant
    // the player had struck 13 at once, which clears the new 5-goblin tier).
    env.state.maxStruckAtOnce ??= (env.state as { struck13Goblins?: boolean }).struck13Goblins ? 13 : 0;
    env.state.spaceUnlocked ??= false;
    env.state.hellUnlocked ??= false;
    env.state.bobSpawned ??= false;
    env.state.bobPickingHole ??= false;
    env.state.bobCheatPending ??= false;
    env.state.ghosts ??= [];
    // Pre-existing ghosts from saves predating the downward drift get a
    // spawnAt anchored to load time, so they start their fall fresh rather
    // than appearing already past the bottom.
    for (const g of env.state.ghosts) {
      if (g.spawnAt === undefined) g.spawnAt = env.state.now;
      // A parlay or chat command in flight is ephemeral — never auto-trigger
      // on resume.
      g.parlayDemonId = undefined;
      g.chatTargetId = undefined;
    }
    // Same for a chat that arrived but hadn't launched its overlay yet.
    env.state.pendingGhostChat = null;
    // Demons — added with the hell parlay system. Seed them for older saves,
    // and always resume with no parlay in progress (the overlay is live-only).
    env.state.demons ??= createDemons(env.state);
    // Self-heal: a save can carry an empty demons map, or (from a pre-current
    // schema) a demon with a non-finite hx/hy. Pixi silently refuses to draw a
    // sprite at a NaN position, so such a demon is invisible everywhere — even
    // when the player pans the whole abyss. Reseed from scratch if anything's off.
    const demonsValid = env.state.demons.size > 0 &&
      [...env.state.demons.values()].every(
        (d) => Number.isFinite(d.hx) && Number.isFinite(d.hy) &&
               Number.isFinite(d.y0) && Number.isFinite(d.y1),
      );
    if (!demonsValid) env.state.demons = createDemons(env.state);
    // Bring pre-roster saves up to the full trio (the colossus, demon L, and
    // L's corner-dwelling friend) and stamp variant/scale/facing defaults.
    ensureDemonRoster(env.state);
    for (const d of env.state.demons.values()) {
      d.busyWith = null;
      d.selected = false;
      d.hintedTryAnother ??= false;
    }
    // Soul sigil — candles/chairs are player-placed, one ring per Hell Portal.
    // Drop any legacy fixed-position chairs (they predate `portalId`) along
    // with the old single completion timestamp; pruneSoulChairs sweeps chairs
    // whose portal is gone on the first tick. A pending claim is ephemeral,
    // so clear it.
    if (!Array.isArray(env.state.soulChairs) ||
        env.state.soulChairs.some((c) => (c as { portalId?: number }).portalId === undefined)) {
      env.state.soulChairs = [];
    }
    for (const c of env.state.soulChairs) { c.claimedBy = undefined; c.selected = false; }
    if (!(env.state.soulSigilCompletedAt instanceof Map)) env.state.soulSigilCompletedAt = new Map();
    env.state.bobParlayed ??= false;
    env.state.hellHintShown ??= false;
    env.state.slewTwoDragonsInOneStrike ??= false;
    env.state.lightningUnlocked ??= false;
    // Pre-existing Hell Portals from saves predating activatedAt get one set
    // to a time well before now, so the beam draw-in animation has already
    // completed when the player loads in — they expect to see the beam.
    for (const b of env.state.buildings.values()) {
      if (b.kind === 'hell_portal' && b.state !== 'constructing' && b.activatedAt === undefined) {
        b.activatedAt = Math.max(0, env.state.now - 100);
      }
    }
    env.state.view = 'ground';
    env.state.lightningStrikeCooldown ??= 0;
    env.state.selectedAmbientDragonId = null;
    // Building.displayNum + state.buildingCounts were added so each kind shows
    // its own ordinal (#1, #2…) rather than a global id. Old saves carry only
    // `id`s, so re-number every building (ground + space) in id-order per
    // kind, and seed the counters off the final tally so future placements
    // continue from the right number.
    if (env.state.buildingCounts === undefined) {
      const all: Building[] = [
        ...env.state.buildings.values(),
        ...[...env.state.spaceBuildings.values()].map((sb) => sb.building),
      ].sort((a, b) => a.id - b.id);
      const counts = emptyBuildingCounts();
      for (const b of all) {
        counts[b.kind] = (counts[b.kind] ?? 0) + 1;
        b.displayNum = counts[b.kind];
      }
      env.state.buildingCounts = counts;
    }
    // Walls are deterministic from playArea; rebuild after load so any future
    // schema drift in the persisted Set doesn't desync rendering / pathing.
    env.state.walls = rebuildWalls(env.state);
    env.state.wallsVersion = (env.state.wallsVersion ?? 0) + 1;
    // Migration: pre-fix saves accumulated duplicate / dangling IDs in
    // assignedGoblins (water-carrier reassignments leaked refs). Sweep once
    // on load so the first tick after resume sees a clean slate.
    pruneAllAssignedGoblins(env.state);
    return { state: env.state, savedAt: env.savedAt };
  } catch { return null; }
}

export function clearSave(): void {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* no-op */ }
}

export function hasSave(): boolean {
  try { return localStorage.getItem(STORAGE_KEY) !== null; } catch { return false; }
}

// Coarse human-readable "X ago" — used on the title screen's resume button.
export function formatRelativeTime(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 45) return 'just now';
  if (s < 90) return '1 minute ago';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} minutes ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return h === 1 ? '1 hour ago' : `${h} hours ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? '1 day ago' : `${d} days ago`;
}
