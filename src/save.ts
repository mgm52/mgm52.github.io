import * as devalue from 'devalue';
import { compressToUTF16, decompressFromUTF16 } from 'lz-string';
import {
  Building, GameState, createDemons, emptyBuildingCounts, pruneAllAssignedGoblins, rebuildWalls,
} from './state';
import { LEGACY_TASK_UNLOCKS } from './upgrade-tree';

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
    localStorage.setItem(STORAGE_KEY, compressed);
  } catch { /* storage full / unavailable — silently skip */ }
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
    env.state.spaceBuildings ??= new Map();
    // `selected` was added with space-building selection; default it so saves
    // predating it don't leave the field undefined.
    for (const sb of env.state.spaceBuildings.values()) sb.selected ??= false;
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
      // A parlay command in flight is ephemeral — never auto-trigger on resume.
      g.parlayDemonId = undefined;
    }
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
    for (const d of env.state.demons.values()) {
      d.busyWith = null;
      d.selected = false;
      d.hintedTryAnother ??= false;
    }
    // Soul sigil — now one ring of chairs per Hell Portal. Drop any legacy
    // fixed-position chairs (they predate `portalId`) and the old single
    // completion timestamp; syncSoulChairs rebuilds the per-portal rings from the
    // live portals on the first tick. A pending claim is ephemeral, so clear it.
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
    // Pip-based upgrade tree — saves predating it carry only completed task
    // ids, whose completion used to unlock buildings/abilities directly. Seed
    // the purchase set from the legacy task→unlocks map so the player resumes
    // with exactly what the old gating had granted (no pips refunded), and
    // mark every already-completed task as pips-paid so resuming doesn't
    // shower retroactive pips on top of the seeded purchases.
    env.state.pips ??= 0;
    // Per-creature kill counters (recordGhost). Saves predate them — seed
    // from the ghost list, which holds one entry per kill anyway.
    if (!env.state.kills) {
      const kills = { goblin: 0, minotaur: 0, dragon: 0 };
      for (const g of env.state.ghosts ?? []) {
        if (g.kind in kills) kills[g.kind]++;
      }
      env.state.kills = kills;
    }
    // Cumulative construction completions — seed older saves from whatever is
    // currently standing (ground, finished only) plus everything in orbit.
    // Demolished history is unrecoverable; best effort.
    if (!env.state.buildingsBuilt) {
      const built = emptyBuildingCounts();
      for (const b of env.state.buildings.values()) {
        if (b.state !== 'constructing') built[b.kind]++;
      }
      for (const sb of (env.state.spaceBuildings ?? new Map()).values()) {
        built[sb.building.kind]++;
      }
      env.state.buildingsBuilt = built;
    }
    if (!(env.state.purchasedUpgrades instanceof Set)) {
      const purchased = new Set<string>();
      const completed = new Set(env.state.unlocks?.completed ?? []);
      // 'earn_30_blood' is the pre-rename id of 'summon_minotaurs'.
      if (completed.has('earn_30_blood')) completed.add('summon_minotaurs');
      for (const id of completed) {
        for (const u of LEGACY_TASK_UNLOCKS[id] ?? []) purchased.add(u);
      }
      env.state.purchasedUpgrades = purchased;
    }
    if (env.state.unlocks && !(env.state.unlocks.pipsAwarded instanceof Set)) {
      env.state.unlocks.pipsAwarded = new Set(env.state.unlocks.completed);
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
