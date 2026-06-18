// ─── The trading-card realm ──────────────────────────────────────────
// The game's final section, picking up after the finale's screen has torn
// itself white. Every game world is now a trading card: stacked preview
// panes (space / earth / hell — only the scenes that world has opened),
// the world's resources, and an ENTER button. The player's own pre-Gabbonsaw save is dealt onto
// the table first — and promptly swindled away by an ethereal white goblin,
// who leaves a pitiful replacement ("now it's a trade."). From there the
// player can re-enter any card they hold (the world boots demonless, Bob-
// and Lolly-less, with a white border and a LEAVE WORLD button), and visit
// tier-gated trade gatherings to swap worlds with other ethereal creatures.
//
// Architecture: entering a card world swaps the card's serialized GameState
// into the regular save slot (the outer post-finale save is stashed verbatim)
// and reloads the page, so the entire existing boot pipeline does the heavy
// lifting. Leaving serializes the live world back onto its card and restores
// the stash. The realm itself is pure DOM, mounted above the finale's
// white-out (#finale-white) once the cinematic holds on 'shattered'.
//
// All the data rules (tiers, ascension demands, trade rules, world
// generation) live DOM-free in cards-core.ts, where the unit tests can
// reach them; this file is the presentation + persistence half.

import { playSound, type SoundName } from './audio';
import { BUILDING_DEFS, BuildingKind, CELL, HELL, SPACE, WORLD, formatPower } from './config';
import { getOptions } from './options';
import { clearSave, getRawSave, saveGame, setRawSave } from './save';
import { GameState, computePlayBounds, isInPlayCell } from './state';
import { ALL_TASK_IDS } from './ui';
import {
  CardMeta, CardResources, CardTier, Creature, FRAME_BASE, ManualWorld,
  TradeEvent, Want, WorldCard, cardPower, decodeWorld, encodeWorld, generateEvents,
  makeCard, mulberry32, regenerateEvent, sceneStructureCounts,
  WantSeg, wantSatisfiableBy, wantSatisfiedBy, wantSegments,
  STREET, StreetCam, StreetHouse, StreetSide, gatheringRowCount, gatheringSlot,
  streetDollyPose, streetDoor, streetEnterPose, streetFocusPose, streetHouse, streetViewSpace,
  STREET_TUNABLES, streetTunable, resetStreet,
} from './cards-core';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Every sound in the realm rides the ghostly reverb bus (audio.ts: lowpass +
// cavern convolver, the hell cries' treatment) at a slightly slowed rate —
// the in-between reads as one big, soft, far-away room.
function realmSound(name: SoundName, volume = 1, rate = 1): void {
  playSound(name, volume, rate * 0.8, true);
}

// Every generated world stamps the full task list as completed (no tutorial
// replays inside cards); bind the core's generators to ui.ts's id list once.
const newCard = (meta: CardMeta, tier: CardTier, rng: () => number, junk = false): WorldCard =>
  makeCard(meta, tier, rng, ALL_TASK_IDS, junk);

// ─── Persistence ─────────────────────────────────────────────────────
// Three keys beside the regular save slot:
//  - META_KEY:   the metagame itself (player cards, events, active card).
//  - ORIGIN_KEY: one-shot snapshot of the world taken the instant the Pain
//    Gabbonsaw was bought — becomes the first card dealt onto the table.
//  - OUTER_KEY:  verbatim stash of the post-finale save while the player is
//    inside a card world (the main slot holds the card world meanwhile).
const META_KEY = 'rts.cards.v1';
const ORIGIN_KEY = 'rts.cardorigin.v1';
const OUTER_KEY = 'rts.cardouter.v1';
// The dev World Designer's database of hand-authored worlds. These are the
// dominant card source — generateEvents/regenerateEvent draw 95% of every
// trader deck from this pool (cards-core's mintDeckCard). Shared with the
// designer module, which writes it.
const MANUAL_KEY = 'rts.manualworlds.v1';
// Set while the player is SPECTATING a trader's card world: the world sits
// in the regular save slot like an entered card, but time is frozen, the
// build/summon chrome is hidden, and leaving never serializes back — the
// trader's card is untouched by the visit.
const SPECTATE_KEY = 'rts.cardspectate.v1';

// Map a legacy creature appetite onto a want, for metas saved before wants
// existed. The opener at each gathering stays the easy rung (any one world at
// the border, a single lesser-tier card at the richer tables).
function appetiteToWant(a: string | undefined, tier: CardTier, firstSlot: boolean): Want {
  if (firstSlot) {
    if (tier === 'common') return { kind: 'any', count: 1 };
    return { kind: 'tier', tier: tier === 'uncommon' ? 'common' : 'uncommon', count: 1 };
  }
  if (a === 'blood') return { kind: 'resource', res: 'blood', amount: 1, count: 1 };
  if (a === 'rich') return { kind: 'resource', res: 'money', amount: 1000, count: 1 };
  if (a === 'bones') return { kind: 'resource', res: 'dragonBone', amount: 1, count: 1 };
  return { kind: 'tier', tier, count: 1 };
}

function loadMeta(): CardMeta | null {
  try {
    const raw = localStorage.getItem(META_KEY);
    if (!raw) return null;
    const m = JSON.parse(raw) as CardMeta;
    if (!m || m.v !== 1 || !Array.isArray(m.cards)) return null;
    // Metas saved before trader frames existed: stamp the stable slot
    // patterns onto the creatures and their unclaimed decks. Cards already
    // traded into the player's hand are unattributable and stay plain.
    if (m.events) {
      for (const ev of m.events) {
        ev.creatures.forEach((c, i) => {
          if (c.frame === undefined) {
            c.frame = FRAME_BASE[ev.tier] + i;
            for (const wc of c.deck) {
              if (wc.frame === undefined && !wc.origin) wc.frame = c.frame;
            }
          }
          // Metas saved before trader wants existed: synthesize one from the
          // legacy appetite (the first creature, the open one, becomes an
          // any-want).
          if (c.want === undefined) c.want = appetiteToWant((c as { appetite?: string }).appetite, ev.tier, i === 0);
        });
      }
    }
    // Metas saved before the per-playthrough seed existed: stamp one now so
    // future gathering rolls stop being identical across playthroughs.
    if (m.seed === undefined) {
      m.seed = (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
      saveMeta(m);
    }
    return m;
  } catch { return null; }
}

function saveMeta(meta: CardMeta): void {
  try { localStorage.setItem(META_KEY, JSON.stringify(meta)); } catch { /* storage full — skip */ }
}

export function hasCardMeta(): boolean { return loadMeta() !== null; }

// ─── Manual-world database (shared with the World Designer) ──────────
// Worlds shipped in the repo file public/worlds.json, fetched once at boot
// (initBuiltinWorlds). They form the permanent, committable base library; the
// localStorage copy below is the live working set layered on top. Empty until
// the fetch resolves — card generation that runs before then just sees the
// localStorage worlds, which is fine.
let builtinWorlds: ManualWorld[] = [];

// Fetch the committed world file and cache it. Call once at boot, before the
// trading realm can generate decks. Silently tolerates a missing/empty file.
export async function initBuiltinWorlds(): Promise<void> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}worlds.json`, { cache: 'no-store' });
    if (!res.ok) return;
    const list = await res.json();
    if (Array.isArray(list)) builtinWorlds = list as ManualWorld[];
  } catch { /* no file / offline — fall back to localStorage only */ }
}

function readLocalWorlds(): ManualWorld[] {
  try {
    const raw = localStorage.getItem(MANUAL_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw) as ManualWorld[];
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

// The merged library: the committed file plus the localStorage working copy,
// deduped by id with localStorage winning (an edited-but-unsaved-to-file world
// shadows its committed version).
export function loadManualWorlds(): ManualWorld[] {
  const byId = new Map<number, ManualWorld>();
  for (const w of builtinWorlds) byId.set(w.id, w);
  for (const w of readLocalWorlds()) byId.set(w.id, w);
  return [...byId.values()];
}

export function saveManualWorlds(list: ManualWorld[]): void {
  try { localStorage.setItem(MANUAL_KEY, JSON.stringify(list)); } catch { /* storage full — skip */ }
}

// Persist the given library to the committed repo file via the dev-only Vite
// endpoint, and sync the in-memory cache so a later loadManualWorlds() agrees
// without a reload. Resolves false in a static build (no server) or on error —
// the localStorage copy is unaffected either way.
export async function saveWorldsToFile(list: ManualWorld[]): Promise<boolean> {
  builtinWorlds = list;
  try {
    const res = await fetch('/__save-worlds', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(list),
    });
    return res.ok;
  } catch { return false; }
}

// Set just before the enter-/leave-world reloads so the next boot knows it's
// an explicit transition (skip the title screen) rather than a cold load.
// The module flag guards the gap between writing the destination save and
// the reload actually landing: main.ts's pagehide/visibility flushes would
// otherwise clobber the freshly-written slot with the departing world.
const HOP_KEY = 'rts.cardhop';
let hopInProgress = false;
export function isCardHopInProgress(): boolean { return hopInProgress; }
export function markCardHop(): void {
  hopInProgress = true;
  try { sessionStorage.setItem(HOP_KEY, '1'); } catch { /* no-op */ }
}
export function consumeCardHop(): boolean {
  try {
    const hop = sessionStorage.getItem(HOP_KEY) === '1';
    sessionStorage.removeItem(HOP_KEY);
    return hop;
  } catch { return false; }
}

// True at the very start of a boot that's RETURNING to the realm — leaving a
// card world, or the first-card reveal: an explicit hop is in progress and the
// metagame exists with no active card (so we're NOT diving into a card). Peeks
// the hop flag without consuming it. Lets main.ts raise the realm's white-out
// immediately, before the long async boot (worlds preload, fonts, Pixi) can
// paint the bare overworld underneath during the ~2s before the realm mounts.
export function isRealmReturnBoot(): boolean {
  try {
    if (sessionStorage.getItem(HOP_KEY) !== '1') return false;
  } catch { return false; }
  // Spectating dives INTO a trader's world (activeCardId stays null but the
  // spectate flag is set) — that's an arrival, not a return; don't white it out.
  if (spectateActive()) return false;
  const m = loadMeta();
  return m !== null && m.activeCardId === null;
}

export function cardWorldActive(): boolean {
  const m = loadMeta();
  return m !== null && m.activeCardId !== null;
}

// True while the save slot holds a world the player is only WATCHING.
export function spectateActive(): boolean {
  try { return localStorage.getItem(SPECTATE_KEY) === '1'; } catch { return false; }
}

// Mounted onto the realm once it becomes visible (main.ts wires the realm's
// pause/settings/dev chrome here, since it has the designer launcher too).
let realmShown: ((realm: HTMLElement) => void) | null = null;
export function onRealmShown(fn: (realm: HTMLElement) => void): void { realmShown = fn; }

// Refresh whatever realm view is up after a dev edit to the metagame.
function refreshRealmView(): void {
  const meta = loadMeta();
  if (!meta) return;
  swapView(() => routeRealmView(meta));
}

// Dev tool (realm dev cog): reshuffle every gathering's traders + decks.
export function devReshuffleGatherings(): void {
  const meta = loadMeta();
  if (!meta) return;
  if (!meta.events) meta.events = generateEvents(meta, null, ALL_TASK_IDS, loadManualWorlds());
  else for (const ev of meta.events) regenerateEvent(meta, ev, ALL_TASK_IDS, loadManualWorlds());
  saveMeta(meta);
  refreshRealmView();
}

// Dev tool (realm dev cog): drop a fresh common card into the player's hand.
export function devDealFreeCard(): void {
  const meta = loadMeta();
  if (!meta) return;
  const rng = mulberry32((Date.now() ^ 0x9e3779b9) >>> 0);
  meta.cards.push(newCard(meta, 'common', rng));
  saveMeta(meta);
  refreshRealmView();
}

// ─── Dev street-geometry tuning ──────────────────────────────────────
// The realm dev cog's sliders (options-ui.ts) write STREET fields through
// these helpers. Values persist in localStorage so a tuned framing survives a
// reload, and re-apply at module load below. Rebuilds are coalesced into one
// per frame so dragging a slider doesn't thrash the DOM.
const STREET_GEOM_KEY = 'gs.realm.streetGeom';

function saveStreetGeom(): void {
  try {
    const out: Record<string, number> = {};
    for (const t of STREET_TUNABLES) if (t.get() !== t.def) out[t.key] = t.get();
    if (Object.keys(out).length) localStorage.setItem(STREET_GEOM_KEY, JSON.stringify(out));
    else localStorage.removeItem(STREET_GEOM_KEY);
  } catch { /* storage blocked — tuning just won't persist */ }
}

function loadStreetGeom(): void {
  try {
    const raw = localStorage.getItem(STREET_GEOM_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw) as Record<string, number>;
    for (const [key, v] of Object.entries(saved)) {
      if (typeof v === 'number') streetTunable(key)?.set(v);
    }
  } catch { /* malformed — ignore and keep defaults */ }
}
// Re-apply any persisted tuning before the realm ever builds a street.
loadStreetGeom();

let streetRebuildQueued = false;
function queueStreetRebuild(): void {
  if (streetRebuildQueued) return;
  streetRebuildQueued = true;
  requestAnimationFrame(() => { streetRebuildQueued = false; refreshRealmView(); });
}

// Dev tool (realm dev cog): set one street tunable, persist it, and rebuild.
export function devSetStreetParam(key: string, value: number): void {
  const t = streetTunable(key);
  if (!t) return;
  t.set(value);
  saveStreetGeom();
  queueStreetRebuild();
}

// Dev tool (realm dev cog): restore the shipped street framing.
export function devResetStreet(): void {
  resetStreet();
  saveStreetGeom();
  queueStreetRebuild();
}

// Dev cheat (options cog): wipe ONLY the trading-section metagame and
// reload. If the player is currently inside (or spectating) a card world,
// the stashed outer save is put back first, so the main game survives the
// wipe — the next visit to the realm starts from the goblin intro again.
export function devResetCardRealm(): void {
  const outer = localStorage.getItem(OUTER_KEY);
  if (outer) setRawSave(outer);
  clearCardData();
  location.reload();
}

// Wipe the whole metagame — wired into the title screen's Erase Data.
export function clearCardData(): void {
  try {
    localStorage.removeItem(META_KEY);
    localStorage.removeItem(ORIGIN_KEY);
    localStorage.removeItem(OUTER_KEY);
    localStorage.removeItem(SPECTATE_KEY);
  } catch { /* no-op */ }
}

// One-shot snapshot taken the instant the Pain Gabbonsaw ritual is bought
// (before the bones are even spent) — "the state just before the player
// bought the pain upgrades that triggered the whole finale sequence."
// Synchronous on purpose: it's a single momentous click, and the cutscene
// that follows hides the hitch.
export function captureOriginWorld(state: GameState): void {
  try {
    const payload = {
      data: encodeWorld(state),
      resources: {
        money: state.money, blood: state.blood, dragonBone: state.dragonBone,
        power: cardPower(state), goblins: state.goblins.size,
      },
    };
    localStorage.setItem(ORIGIN_KEY, JSON.stringify(payload));
  } catch { /* storage full — the realm falls back to a generated origin */ }
}

// The player's pre-finale save as a card. Falls back to a generated rare
// world when the snapshot is missing (dev sessions that skipped the ritual).
function buildOriginCard(meta: CardMeta, rng: () => number): WorldCard {
  try {
    const raw = localStorage.getItem(ORIGIN_KEY);
    if (raw) {
      const payload = JSON.parse(raw) as { data: string; resources: WorldCard['resources'] };
      if (payload?.data && payload.resources) {
        return {
          id: meta.nextId++,
          name: 'your world',
          tier: 'rare',
          data: payload.data,
          resources: payload.resources,
          origin: true,
        };
      }
    }
  } catch { /* fall through to the generated stand-in */ }
  const card = newCard(meta, 'rare', rng);
  card.name = 'your world';
  card.origin = true;
  return card;
}

// ─── Entering / leaving a card world ─────────────────────────────────

// The white that bridges every world hop — created lazily at body level so
// it sits above both the realm (100001) and the game.
function hopWhite(): HTMLElement {
  let el = document.getElementById('card-hop-white');
  if (!el) {
    el = document.createElement('div');
    el.id = 'card-hop-white';
    document.body.appendChild(el);
  }
  return el;
}

async function enterWorld(meta: CardMeta, card: WorldCard, cardEl?: HTMLElement): Promise<void> {
  const st = decodeWorld(card.data);
  if (!st) { realmSound('error'); return; }
  // Stash the outer post-finale save verbatim, then write the card's world
  // into the slot. Only once the slot has verifiably changed does the meta
  // mark us inside the card — if the write silently failed (storage full),
  // booting "into" the card would actually boot the outer world and the
  // next LEAVE WORLD would overwrite this card with it.
  const outer = getRawSave();
  if (outer) {
    try { localStorage.setItem(OUTER_KEY, outer); } catch { /* skip */ }
  }
  saveGame(st);
  const written = getRawSave();
  if (written === null || written === outer) { realmSound('error'); return; }
  meta.activeCardId = card.id;
  saveMeta(meta);
  realmSound('ritual', 1, 0.7);
  markCardHop();
  // The dive: the chosen card swells toward the viewer while the white
  // takes over — it bridges into the arrival zoom on the far side of the
  // reload (setupCardWorldChrome).
  const white = hopWhite();
  white.style.transition = 'opacity 900ms ease-in';
  cardEl?.classList.add('dived');
  requestAnimationFrame(() => { white.style.opacity = '1'; });
  // Hold until the white fully lands so the reload cuts on a clean frame.
  await sleep(1200);
  location.reload();
}

// Spectating: dive into a TRADER'S card without owning it. Same hop as
// enterWorld — the world goes into the save slot and the page reloads — but
// the spectate flag (not meta.activeCardId) marks the visit, so boot freezes
// time, hides the build chrome, and leaveSpectate restores the outer save
// without ever writing the visit back onto the trader's card.
async function spectateWorld(card: WorldCard, cardEl?: HTMLElement): Promise<void> {
  const st = decodeWorld(card.data);
  if (!st) { realmSound('error'); return; }
  const outer = getRawSave();
  if (outer) {
    try { localStorage.setItem(OUTER_KEY, outer); } catch { /* skip */ }
  }
  saveGame(st);
  const written = getRawSave();
  if (written === null || written === outer) { realmSound('error'); return; }
  // The flag is what makes the next boot a spectate; if it can't be stored
  // the hop must not happen — booting the trader's world unflagged would
  // adopt it as the player's own. Put the outer save back and bail.
  let flagged = false;
  try {
    localStorage.setItem(SPECTATE_KEY, '1');
    flagged = localStorage.getItem(SPECTATE_KEY) === '1';
  } catch { /* flagged stays false */ }
  if (!flagged) {
    if (outer) setRawSave(outer);
    realmSound('error');
    return;
  }
  realmSound('ritual', 1, 0.7);
  markCardHop();
  const white = hopWhite();
  white.style.transition = 'opacity 900ms ease-in';
  cardEl?.classList.add('dived');
  requestAnimationFrame(() => { white.style.opacity = '1'; });
  await sleep(1200);
  location.reload();
}

async function leaveSpectate(): Promise<void> {
  markCardHop();
  // The same pull-back as leaveWorld — but nothing is serialized: the visit
  // leaves no mark on the trader's card.
  const app = document.getElementById('app');
  const white = hopWhite();
  white.style.transition = 'opacity 1150ms ease-in';
  app?.classList.add('card-exit-zoom');
  requestAnimationFrame(() => { white.style.opacity = '1'; });
  await sleep(1250);
  try { localStorage.removeItem(SPECTATE_KEY); } catch { /* no-op */ }
  const outer = localStorage.getItem(OUTER_KEY);
  if (outer) {
    setRawSave(outer);
    try { localStorage.removeItem(OUTER_KEY); } catch { /* no-op */ }
  } else {
    // Same guard as leaveWorld: never let a visited world become the save.
    clearSave();
  }
  location.reload();
}

async function leaveWorld(state: GameState): Promise<void> {
  const meta = loadMeta();
  if (!meta || meta.activeCardId === null) return;
  markCardHop();
  // The pull-back: the whole world recedes to a point as the white takes
  // over — the finale's own exit, in miniature. The state is serialized
  // AFTER the zoom so the final second of play still makes it onto the card.
  const app = document.getElementById('app');
  const white = hopWhite();
  white.style.transition = 'opacity 1150ms ease-in';
  app?.classList.add('card-exit-zoom');
  requestAnimationFrame(() => { white.style.opacity = '1'; });
  await sleep(1250);
  const card = meta.cards.find((c) => c.id === meta.activeCardId);
  if (card) {
    // The card remembers everything the player just did inside it.
    card.data = encodeWorld(state);
    card.resources = {
      money: state.money, blood: state.blood, dragonBone: state.dragonBone,
      power: cardPower(state), goblins: state.goblins.size,
    };
  }
  meta.activeCardId = null;
  // Leaving the very first (traded) world graduates the metagame: the street
  // of gatherings opens, and the next realm boot plays the one-shot reveal
  // that pulls back out of the house onto that street.
  if (meta.phase === 'firstworld') {
    meta.phase = 'free';
    meta.revealPending = true;
  }
  saveMeta(meta);
  const outer = localStorage.getItem(OUTER_KEY);
  if (outer) {
    setRawSave(outer);
    try { localStorage.removeItem(OUTER_KEY); } catch { /* no-op */ }
  } else {
    // No stashed outer world (a dev hop into the realm before any autosave
    // landed). The world was serialized onto its card above — clear the
    // slot so the card world can't masquerade as the main game.
    clearSave();
  }
  location.reload();
}

// Boot fallback: the metagame says we're inside a card but the save slot is
// unreadable. Restore the outer save (if stashed) and clear the active card
// so the player lands back on the table instead of a broken world.
export function abandonCardWorldBoot(): void {
  const meta = loadMeta();
  if (meta) { meta.activeCardId = null; saveMeta(meta); }
  try { localStorage.removeItem(SPECTATE_KEY); } catch { /* no-op */ }
  const outer = localStorage.getItem(OUTER_KEY);
  if (outer) {
    setRawSave(outer);
    try { localStorage.removeItem(OUTER_KEY); } catch { /* no-op */ }
  }
}

// Inside a card world: the white screen border (body.card-world) and the big
// white LEAVE WORLD button pinned to the bottom of the screen. When the boot
// was an explicit hop (ENTER → reload), the world arrives by zooming
// out of the white — the finale's pull-back, run in reverse.
export function setupCardWorldChrome(state: GameState, arriving = false): void {
  document.body.classList.add('card-world');
  // Spectating a trader's world: time stands still (main.ts's tick freeze
  // keys on the body class) and the mutating chrome — summon/build panels,
  // destroy buttons, right-click commands — is walled off in CSS/input.ts.
  const spectating = spectateActive();
  if (spectating) document.body.classList.add('spectate-hold');
  // The player's first time inside a world (the traded card they were just
  // handed): hold the way out back for a beat so they actually look around,
  // then let LEAVE WORLD fade in flashing. Every later visit shows it at once.
  const meta = loadMeta();
  const firstVisit = !spectating && meta?.phase === 'firstworld' && meta.activeCardId !== null;
  const btn = document.getElementById('leave-world-btn') as HTMLButtonElement | null;
  if (btn) {
    if (spectating) btn.textContent = 'STOP INSPECTING';
    btn.classList.remove('hold-hidden', 'flash-in');
    if (firstVisit) {
      btn.style.display = '';
      btn.classList.add('hold-hidden');
      window.setTimeout(() => {
        btn.classList.remove('hold-hidden');
        btn.classList.add('flash-in');
        realmSound('online', 0.45, 0.7);
      }, 10000);
    } else {
      btn.style.display = '';
    }
    btn.addEventListener('click', () => {
      btn.disabled = true;
      btn.classList.remove('flash-in');
      realmSound('ritual', 1, 0.7);
      void (spectating ? leaveSpectate() : leaveWorld(state));
    }, { once: true });
  }
  // Cards no longer ascend on their own — growing a world matters only
  // because a trader's want can read its resources — so there's no in-world
  // ascension goal ticker any more.
  if (arriving) {
    const app = document.getElementById('app');
    const white = hopWhite();
    white.style.transition = 'none';
    white.style.opacity = '1';
    app?.classList.add('card-enter-zoom');
    // Two frames so the scaled-down start commits before the release.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        app?.classList.add('card-enter-zoom-go');
        white.style.transition = 'opacity 1600ms ease-out';
        white.style.opacity = '0';
      });
    });
    window.setTimeout(() => {
      app?.classList.remove('card-enter-zoom', 'card-enter-zoom-go');
    }, 1750);
  }
}

// ─── Card previews ───────────────────────────────────────────────────
// Stacked minimap panes painted from the card's decoded state: space on
// top, earth in the middle, hell at the bottom — the world as a column.
// Only the scenes the world has actually opened get a pane (buildCardEl
// checks spaceUnlocked / hellUnlocked); most commons are all ground.

const decodedCache = new Map<number, { data: string; st: GameState | null }>();
function decodedWorld(card: WorldCard): GameState | null {
  const hit = decodedCache.get(card.id);
  if (hit && hit.data === card.data) return hit.st;
  const st = decodeWorld(card.data);
  decodedCache.set(card.id, { data: card.data, st });
  return st;
}

function hexColor(n: number): string { return `#${n.toString(16).padStart(6, '0')}`; }

// ── Building sprites for the earth pane ──
// The same PNGs the game renders, scaled down onto the card minimap so a
// world's skyline is recognizable at a glance. Loaded lazily and cached; a
// pane drawn before its sprites arrive paints the old colored blocks and
// repaints itself once they land. Kinds without a sheet (the hell portal,
// the space structures) keep their procedural look.
const SPRITE_KINDS = new Set<BuildingKind>([
  'datacentre', 'dragon_beacon', 'gas_engine', 'goblin_hole', 'goblin_wheel',
  'hypercentre', 'nuclear_reactor', 'phone_farm', 'wall',
]);
const spriteCache = new Map<BuildingKind, HTMLImageElement>();
function buildingSprite(kind: BuildingKind): HTMLImageElement | null {
  if (!SPRITE_KINDS.has(kind)) return null;
  let img = spriteCache.get(kind);
  if (!img) {
    img = new Image();
    img.src = `assets/buildings/${kind}.png`;
    spriteCache.set(kind, img);
  }
  return img;
}

// Any region holding more than two structures brightens — an additive glow
// blob over the cluster, so a built-up corner of a world reads as alive from
// the card alone.
function drawDensityGlow(
  g: CanvasRenderingContext2D,
  points: { x: number; y: number }[],
  blockPx: number,
  rgb: string,
): void {
  const blocks = new Map<string, { n: number; sx: number; sy: number }>();
  for (const p of points) {
    const key = `${Math.floor(p.x / blockPx)},${Math.floor(p.y / blockPx)}`;
    const b = blocks.get(key) ?? { n: 0, sx: 0, sy: 0 };
    b.n++; b.sx += p.x; b.sy += p.y;
    blocks.set(key, b);
  }
  g.save();
  g.globalCompositeOperation = 'lighter';
  for (const b of blocks.values()) {
    if (b.n <= 2) continue;
    const cx = b.sx / b.n, cy = b.sy / b.n;
    const r = blockPx * (1 + 0.15 * Math.min(b.n, 8));
    const a = Math.min(0.42, 0.12 + 0.06 * (b.n - 2));
    const grad = g.createRadialGradient(cx, cy, 0, cx, cy, r);
    grad.addColorStop(0, `rgba(${rgb}, ${a.toFixed(2)})`);
    grad.addColorStop(1, `rgba(${rgb}, 0)`);
    g.fillStyle = grad;
    g.fillRect(cx - r, cy - r, r * 2, r * 2);
  }
  g.restore();
}

function drawSpacePreview(cv: HTMLCanvasElement, st: GameState, seed: number): void {
  const g = cv.getContext('2d');
  if (!g) return;
  // The pane renders at 2× (see mkCanvas); paint in logical pixels so the
  // hand-tuned star/beam sizes below keep their look.
  g.setTransform(2, 0, 0, 2, 0, 0);
  const w = cv.width / 2, h = cv.height / 2;
  g.fillStyle = '#05040f';
  g.fillRect(0, 0, w, h);
  const rng = mulberry32(seed);
  // A faint nebula so the void has depth.
  for (let i = 0; i < 2; i++) {
    const nx = rng() * w, ny = rng() * h, nr = 20 + rng() * 40;
    const neb = g.createRadialGradient(nx, ny, 0, nx, ny, nr);
    neb.addColorStop(0, i === 0 ? 'rgba(110, 70, 160, 0.16)' : 'rgba(60, 110, 160, 0.13)');
    neb.addColorStop(1, 'rgba(0, 0, 0, 0)');
    g.fillStyle = neb;
    g.fillRect(nx - nr, ny - nr, nr * 2, nr * 2);
  }
  for (let i = 0; i < 44; i++) {
    const big = rng() < 0.12;
    g.globalAlpha = 0.35 + rng() * 0.65;
    g.fillStyle = big ? '#ffffff' : '#cfd4e8';
    g.fillRect(Math.floor(rng() * w), Math.floor(rng() * h), big ? 2 : 1, big ? 2 : 1);
  }
  g.globalAlpha = 1;
  const pts: { x: number; y: number }[] = [];
  for (const sb of st.spaceBuildings.values()) {
    const x = (sb.pos.x / SPACE.width) * w;
    const y = (sb.pos.y / SPACE.height) * h;
    pts.push({ x, y });
    if (sb.building.kind === 'orbital_platform') {
      g.fillStyle = '#565b66';
      g.fillRect(x - 4, y - 3, 9, 7);
      g.strokeStyle = '#9aa0ac';
      g.lineWidth = 1;
      g.strokeRect(x - 4.5, y - 3.5, 10, 8);
      g.fillStyle = '#8ad8ff';
      g.fillRect(x - 3, y - 2, 1, 1);
      g.fillRect(x + 3, y + 2, 1, 1);
    } else {
      const def = BUILDING_DEFS[sb.building.kind];
      g.fillStyle = hexColor(def.colors.active);
      g.fillRect(x - 2, y - 2, 5, 5);
      g.strokeStyle = hexColor(def.colors.activeBorder);
      g.lineWidth = 1;
      g.strokeRect(x - 2.5, y - 2.5, 6, 6);
    }
  }
  for (const su of st.spaceUnits.values()) {
    g.fillStyle = su.robot ? '#c9d0d9' : '#7fd183';
    g.fillRect((su.pos.x / SPACE.width) * w, (su.pos.y / SPACE.height) * h, 2, 2);
  }
  drawDensityGlow(g, pts, Math.max(24, w / 5), '170, 200, 255');
}

function drawEarthPreview(cv: HTMLCanvasElement, st: GameState): void {
  const g = cv.getContext('2d');
  if (!g) return;
  const w = cv.width, h = cv.height;
  g.fillStyle = '#0d0e10';
  g.fillRect(0, 0, w, h);
  const b = computePlayBounds(st);
  const bw = b.x1 - b.x0, bh = b.y1 - b.y0;
  const s = Math.min(w / (bw + 2), h / (bh + 2));
  const ox = (w - bw * s) / 2, oy = (h - bh * s) / 2;
  const px = (cx: number) => ox + (cx - b.x0) * s;
  const py = (cy: number) => oy + (cy - b.y0) * s;
  // Ground, with gentle per-cell mottling so it reads as terrain rather than a
  // flat fill. Tracks the real play-area colors (Options.bgColor/bgColor2 —
  // grey by default) lightened for legibility at thumbnail size, instead of the
  // old hardcoded green that never matched the actual grey ground in-game.
  const o = getOptions();
  const lift = (n: number, by: number): string => {
    const r = Math.min(255, ((n >> 16) & 0xff) + by);
    const gc = Math.min(255, ((n >> 8) & 0xff) + by);
    const bc = Math.min(255, (n & 0xff) + by);
    return `rgb(${r}, ${gc}, ${bc})`;
  };
  const tones = [lift(o.bgColor, 0x24), lift(o.bgColor2, 0x2e), lift(o.bgColor, 0x38)];
  for (let cy = b.y0; cy < b.y1; cy++) {
    for (let cx = b.x0; cx < b.x1; cx++) {
      if (!isInPlayCell(st, cx, cy)) continue;
      g.fillStyle = tones[(cx * 7 + cy * 13) % 3];
      g.fillRect(px(cx), py(cy), s + 0.5, s + 0.5);
    }
  }
  // Water, with a light catching its upper edge.
  for (const ws of st.waterSources.values()) {
    g.fillStyle = '#2e639a';
    g.fillRect(px(ws.x0), py(ws.y0), (ws.x1 - ws.x0) * s, (ws.y1 - ws.y0) * s);
    g.fillStyle = 'rgba(140, 190, 235, 0.7)';
    g.fillRect(px(ws.x0), py(ws.y0), (ws.x1 - ws.x0) * s, 1);
  }
  // The spawning hole.
  if (!st.holeDestroyed) {
    g.fillStyle = '#0a0a0a';
    g.beginPath();
    g.arc(px(st.hole.cell.cx + 0.5), py(st.hole.cell.cy + 0.5), Math.max(1.4, s * 0.8), 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = 'rgba(0, 0, 0, 0.5)';
    g.lineWidth = 1;
    g.stroke();
  }
  // Buildings as their real in-game sprites, bottom-anchored on their
  // footprints so taller structures rise above their plots like a skyline;
  // dormant ones sit dimmed. Kinds without a sheet (and sprites that
  // haven't finished loading) fall back to the old colored blocks.
  const pts: { x: number; y: number }[] = [];
  const pending = new Set<HTMLImageElement>();
  for (const bd of st.buildings.values()) {
    const def = BUILDING_DEFS[bd.kind];
    const x = px(bd.cell.cx), y = py(bd.cell.cy);
    const size = Math.max(1.5, def.cellSize * s);
    const active = bd.state === 'active';
    const img = buildingSprite(bd.kind);
    if (img && img.complete && img.naturalWidth > 0) {
      const hgt = Math.min(size * 2, size * (img.naturalHeight / img.naturalWidth));
      if (!active) g.globalAlpha = 0.55;
      g.drawImage(img, x, y + size - hgt, size, hgt);
      g.globalAlpha = 1;
    } else {
      if (img && !img.complete) pending.add(img);
      g.fillStyle = hexColor(active ? def.colors.active : def.colors.dormant);
      g.fillRect(x, y, size, size);
      if (bd.kind !== 'wall' && size >= 3) {
        g.strokeStyle = hexColor(active ? def.colors.activeBorder : def.colors.dormantBorder);
        g.lineWidth = 1;
        g.strokeRect(x + 0.5, y + 0.5, size - 1, size - 1);
      }
    }
    if (bd.kind !== 'wall') {
      pts.push({ x: x + size / 2, y: y + size / 2 });
    }
  }
  // Units as bright dots.
  for (const gob of st.goblins.values()) {
    g.fillStyle = gob.robot ? '#c9d0d9' : gob.gold ? '#ffd96b' : '#8ee492';
    g.fillRect(px(gob.cell.cx), py(gob.cell.cy), Math.max(2.4, s * 0.7), Math.max(2.4, s * 0.7));
  }
  // Built-up regions glow.
  drawDensityGlow(g, pts, 7 * s, '255, 236, 170');
  // Repaint once late sprites land ('error' counts too, so a missing file
  // can never strand the pane).
  if (pending.size > 0) {
    let waiting = pending.size;
    const arrived = () => { if (--waiting === 0) drawEarthPreview(cv, st); };
    for (const img of pending) {
      img.addEventListener('load', arrived, { once: true });
      img.addEventListener('error', arrived, { once: true });
    }
  }
}

function drawHellPreview(cv: HTMLCanvasElement, st: GameState, seed: number): void {
  const g = cv.getContext('2d');
  if (!g) return;
  // 2× pane, logical-pixel painting — same treatment as the space pane.
  g.setTransform(2, 0, 0, 2, 0, 0);
  const w = cv.width / 2, h = cv.height / 2;
  g.fillStyle = hexColor(HELL.bgColor);
  g.fillRect(0, 0, w, h);
  // Layers of fog rising from the floor of the pit.
  const rng = mulberry32(seed ^ 0x9e3779b9);
  for (let i = 0; i < 3; i++) {
    const fx = rng() * w, fy = h * (0.7 + rng() * 0.4), fr = 30 + rng() * 50;
    const fog = g.createRadialGradient(fx, fy, 0, fx, fy, fr);
    fog.addColorStop(0, 'rgba(96, 16, 22, 0.5)');
    fog.addColorStop(1, 'rgba(96, 16, 22, 0)');
    g.fillStyle = fog;
    g.fillRect(fx - fr, fy - fr, fr * 2, fr * 2);
  }
  // Portal beams: a soft red shaft with a hot core, grounded in a glow pool.
  for (const bd of st.buildings.values()) {
    if (bd.kind !== 'hell_portal' || bd.state === 'constructing') continue;
    const x = ((bd.cell.cx * CELL) / WORLD.width) * w;
    g.fillStyle = 'rgba(255, 32, 48, 0.22)';
    g.fillRect(x - 1.5, 0, 4, h);
    g.fillStyle = 'rgba(255, 90, 90, 0.95)';
    g.fillRect(x, 0, 1, h);
    const pool = g.createRadialGradient(x + 0.5, h, 0, x + 0.5, h, 12);
    pool.addColorStop(0, 'rgba(255, 60, 70, 0.5)');
    pool.addColorStop(1, 'rgba(255, 60, 70, 0)');
    g.fillStyle = pool;
    g.fillRect(x - 12, h - 12, 25, 12);
  }
  // Drifting ghosts — soft-glowing souls rather than bare pixels.
  g.save();
  g.globalCompositeOperation = 'lighter';
  for (const gh of st.ghosts) {
    const x = (gh.x / WORLD.width) * w;
    const y = 3 + rng() * (h - 6);
    const r = gh.kind === 'dragon' ? 3.4 : gh.kind === 'minotaur' ? 2.6 : 2;
    const tint = gh.gold ? '255, 217, 107' : gh.kind === 'dragon' ? '255, 150, 130' : '190, 200, 235';
    const glow = g.createRadialGradient(x, y, 0, x, y, r);
    glow.addColorStop(0, `rgba(${tint}, ${0.5 + rng() * 0.4})`);
    glow.addColorStop(1, `rgba(${tint}, 0)`);
    g.fillStyle = glow;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  g.restore();
  // Lit candles.
  for (const c of st.soulChairs) {
    const x = (c.hx / HELL.width) * w, y = (c.hy / HELL.height) * h;
    g.fillStyle = '#ff9a3d';
    g.fillRect(x, y, 1.5, 1.5);
  }
}

// ─── Card DOM ────────────────────────────────────────────────────────

// The card's resource line: each resource in its own color (cash yellow,
// blood red, power blue, bones grey), hidden at zero, and bold once it
// crosses its "serious" threshold (Ƶ500k / 128 blood / 1 GW / 5 bones).
function resourcesEl(r: CardResources): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'wc-res';
  const fmt = (n: number) => Math.floor(n).toLocaleString('en-US');
  const add = (cls: string, text: string, strong: boolean) => {
    const span = document.createElement('span');
    span.className = `${cls}${strong ? ' strong' : ''}`;
    span.textContent = text;
    wrap.appendChild(span);
  };
  const power = r.power ?? 0;
  const goblins = r.goblins ?? 0;
  if (r.money > 0) add('res-cash', `Ƶ ${fmt(r.money)}`, r.money >= 500_000);
  if (r.blood > 0) add('res-blood', `${fmt(r.blood)} blood`, r.blood >= 128);
  if (power > 0) add('res-power', formatPower(power), power >= 1_000_000_000);
  if (r.dragonBone > 0) add('res-bones', `${fmt(r.dragonBone)} bones`, r.dragonBone >= 5);
  if (goblins > 0) add('res-goblins', `${fmt(goblins)} goblins`, goblins >= 25);
  if (!wrap.firstChild) add('res-nothing', 'nothing', false);
  return wrap;
}

type CardElOpts = {
  big?: boolean;
  enterLabel?: string;       // when set, the card carries an enter button
  onEnter?: (cardEl: HTMLElement) => void;
  onClick?: (cardEl: HTMLElement) => void;   // whole-card click (gathering selection)
};

function buildCardEl(card: WorldCard, opts: CardElOpts = {}): HTMLElement {
  const root = document.createElement('div');
  root.className = `world-card t-${card.tier}${opts.big ? ' big' : ''}${card.origin ? ' origin' : ''}`;
  // The trade animations find a card's element by its id. Every card wears the
  // same plain thin border now (no per-trader frame patterns).
  root.dataset.cardId = String(card.id);
  const head = document.createElement('div');
  head.className = 'wc-head';
  head.innerHTML = `<span class="wc-name"></span><span class="wc-tier">${card.tier}</span>`;
  (head.querySelector('.wc-name') as HTMLElement).textContent = card.name;
  root.appendChild(head);

  const st = decodedWorld(card);
  const panes = document.createElement('div');
  panes.className = 'wc-prevs';
  const mkCanvas = (cls: string, hgt: number): HTMLCanvasElement => {
    const cv = document.createElement('canvas');
    cv.className = `wc-prev ${cls}`;
    // 2× the on-screen size (the CSS width is 100%, so the height scales
    // with it and the displayed box is unchanged) — the building sprites
    // stay crisp instead of dissolving at minimap scale.
    cv.width = 336;
    cv.height = hgt * 2;
    panes.appendChild(cv);
    return cv;
  };
  // A card only carries the scenes its world has actually opened: no space
  // pane without space unlocked, no hell pane without the descent. The earth
  // pane grows into whatever is missing (each absent strip is 40px + 3px
  // gap), so an earth-only world reads as all ground — and a three-scene
  // column quietly marks a more developed world. Undecodable worlds (st
  // null) keep the full blank column.
  const hasSpace = !st || st.spaceUnlocked;
  const hasHell = !st || st.hellUnlocked;
  const earthH = 96 + (hasSpace ? 0 : 43) + (hasHell ? 0 : 43);
  const cvSpace = hasSpace ? mkCanvas('wc-space', 40) : null;
  const cvEarth = mkCanvas('wc-earth', earthH);
  const cvHell = hasHell ? mkCanvas('wc-hell', 40) : null;
  if (st) {
    if (cvSpace) drawSpacePreview(cvSpace, st, card.id * 7919 + 17);
    drawEarthPreview(cvEarth, st);
    if (cvHell) drawHellPreview(cvHell, st, card.id * 7919 + 17);
    // Each pane reads its scene's development at a glance: nothing built →
    // faded; three or more structures → a glowing edge.
    const counts = sceneStructureCounts(st);
    const treat = (cv: HTMLCanvasElement | null, n: number) => {
      if (!cv) return;
      if (n === 0) cv.classList.add('pane-faded');
      else if (n >= 3) cv.classList.add('pane-glow');
    };
    treat(cvSpace, counts.space);
    treat(cvEarth, counts.earth);
    treat(cvHell, counts.hell);
  }
  root.appendChild(panes);

  root.appendChild(resourcesEl(card.resources));

  if (opts.enterLabel) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'wc-enter';
    btn.textContent = opts.enterLabel;
    btn.addEventListener('click', (e) => { e.stopPropagation(); opts.onEnter?.(root); });
    root.appendChild(btn);
  }
  if (opts.onClick) {
    root.classList.add('clickable');
    root.addEventListener('click', () => opts.onClick?.(root));
  }
  return root;
}

// ─── Persistent hand cards ───────────────────────────────────────────
// A held card's face never changes without a page reload (developing a world
// dives through a reload), so each hand card is built ONCE and its exact
// canvas-drawn node is reused across every view — table ↔ gathering, a
// reshuffle, a completed trade. Moving a node never re-draws its canvases, so
// the hand never flashes between gatherings. Listeners delegate to per-element
// handler slots so a node can be re-wired (table = inert, gathering = select)
// without rebuilding it. Cleared on a dev realm reset; a real dive reloads.
const handCardCache = new Map<number, HTMLElement>();

type HandWiring = {
  onEnter: (cardEl: HTMLElement) => void;
  onClick?: () => void;        // present only in the gathering (selection)
  selected?: boolean;
};

interface WiredCard extends HTMLElement {
  __onEnter?: (cardEl: HTMLElement) => void;
  __onClick?: (() => void) | null;
}

function handCardEl(card: WorldCard, w: HandWiring): HTMLElement {
  let el = handCardCache.get(card.id) as WiredCard | undefined;
  if (!el) {
    const created = buildCardEl(card, {
      enterLabel: 'ENTER',
      onEnter: (cardEl) => (cardEl as WiredCard).__onEnter?.(cardEl),
      onClick: (cardEl) => (cardEl as WiredCard).__onClick?.(),
    }) as WiredCard;
    el = created;
    handCardCache.set(card.id, created);
  } else {
    // A reused node: shed any transient animation/selection state and the
    // inline styles a trade fly-out may have left on it.
    el.classList.remove('selected', 'dealt', 'trade-arrived', 'trade-given', 'trade-received', 'dived', 'grayed');
    el.style.transition = '';
    el.style.transform = '';
    el.style.opacity = '';
    el.style.pointerEvents = '';
  }
  el.__onEnter = w.onEnter;
  el.__onClick = w.onClick ?? null;
  el.classList.toggle('clickable', !!w.onClick);
  el.classList.toggle('selected', !!w.selected);
  return el;
}


// ─── Realm dialogue machinery ────────────────────────────────────────
// A lighter cousin of intro.ts's typed dialogue: lines type into
// #card-speech, the click wall arms once a line completes, and YES/NO
// rides #card-choice. No pause integration — the world behind is over.

const TYPE_MS = 45;

function realmEl(id: string): HTMLElement { return document.getElementById(id)!; }

async function typeLine(text: string): Promise<void> {
  const speech = realmEl('card-speech');
  speech.classList.remove('done');
  speech.textContent = '';
  realmEl('card-realm').classList.add('speaking');
  let rendered = '';
  for (const ch of text) {
    rendered += ch;
    speech.textContent = rendered;
    await sleep(TYPE_MS);
  }
  speech.classList.add('done');
}

function waitForClick(target: HTMLElement): Promise<void> {
  return new Promise((resolve) => target.addEventListener('click', () => resolve(), { once: true }));
}

async function say(text: string): Promise<void> {
  const realm = realmEl('card-realm');
  const wall = realmEl('card-clickwall');
  await typeLine(text);
  await sleep(200);
  realm.classList.add('click-armed');
  await waitForClick(wall);
  realmSound('click', 0.29, 0.9);
  realm.classList.remove('click-armed');
}

// A beat that auto-advances (the ". . ." cadence).
async function sayBeat(text: string, holdMs = 1400): Promise<void> {
  await typeLine(text);
  await sleep(holdMs);
}

async function choose(labels: [string, string]): Promise<number> {
  const realm = realmEl('card-realm');
  const yes = realmEl('card-yes') as HTMLButtonElement;
  const no = realmEl('card-no') as HTMLButtonElement;
  (yes.querySelector('.build-name') as HTMLElement).textContent = labels[0];
  (no.querySelector('.build-name') as HTMLElement).textContent = labels[1];
  realm.classList.add('show-choice');
  const picked = await new Promise<number>((resolve) => {
    const h0 = () => { cleanup(); resolve(0); };
    const h1 = () => { cleanup(); resolve(1); };
    const cleanup = () => {
      yes.removeEventListener('click', h0);
      no.removeEventListener('click', h1);
    };
    yes.addEventListener('click', h0);
    no.addEventListener('click', h1);
  });
  realmSound('click', 0.8, 1);
  realm.classList.remove('show-choice');
  await sleep(200);
  return picked;
}

function clearSpeech(): void {
  realmEl('card-realm').classList.remove('speaking');
}

async function goblinIn(): Promise<void> {
  realmEl('card-realm').classList.add('goblin-in');
  await sleep(1900);
}

async function goblinOut(): Promise<void> {
  realmEl('card-realm').classList.remove('goblin-in');
  await sleep(1900);
}

// Soft cross-fade between realm views (table ↔ gathering ↔ trade). The
// builder resets #card-stage's className, which drops .waiting and lets the
// opacity transition carry the new view in.
let stageBusy = false;
function swapView(build: () => void): void {
  const stage = realmEl('card-stage');
  if (stageBusy) { build(); return; }
  stageBusy = true;
  stage.classList.add('waiting');
  window.setTimeout(() => {
    build();
    stageBusy = false;
  }, 260);
}

// ─── The realm itself ────────────────────────────────────────────────

let realmStarted = false;

// Idempotent — called every frame the finale holds on 'shattered' (and by
// the dev ?cardrealm shortcut). The realm waits out its own quiet beat on
// white before the first card drops.
export function maybeStartCardRealm(): void {
  if (realmStarted) return;
  realmStarted = true;
  void runRealm();
}

// Dev re-trigger support (resetFinaleGuards): hide the realm so the replayed
// cinematic isn't covered by it.
export function resetCardRealm(): void {
  realmStarted = false;
  handCardCache.clear();
  const realm = document.getElementById('card-realm');
  if (realm) {
    realm.classList.remove('visible', 'goblin-in', 'speaking', 'click-armed', 'show-choice');
    const stage = document.getElementById('card-stage');
    if (stage) stage.innerHTML = '';
    const hand = document.getElementById('card-hand');
    if (hand) hand.innerHTML = '';
  }
}

async function runRealm(): Promise<void> {
  const realm = document.getElementById('card-realm');
  if (!realm) return;
  let meta = loadMeta();
  // Held on white a couple of seconds before anything appears — longer for
  // the very first arrival, shorter when returning from a card world.
  await sleep(meta && meta.phase === 'free' ? 1200 : 2600);
  realm.classList.add('visible');
  realmShown?.(realm);
  if (!meta) {
    meta = {
      v: 1,
      phase: 'intro',
      seed: (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0,
      nextId: 1,
      cards: [],
      events: null,
      activeCardId: null,
    };
    const rng = mulberry32(Date.now() >>> 0);
    meta.cards = [buildOriginCard(meta, rng)];
    saveMeta(meta);
  }
  if (meta.phase === 'intro') {
    await runTradeIntro(meta);
    meta = loadMeta() ?? meta;
  }
  routeRealmView(meta);
}

// Where the realm lands after the (possible) intro: the lone traded card
// awaiting its first dive, the one-shot street reveal, or the street itself.
function routeRealmView(meta: CardMeta): void {
  if (meta.phase === 'firstworld') { showFirstCard(meta); return; }
  if (meta.revealPending) { void runStreetReveal(meta); return; }
  showStreet(meta);
}

// The held-on big-card view: after the swindle (and on any reload while the
// player still hasn't gone inside), the one traded world fills the stage with
// a single ENTER — the only thing to do is step into it.
function showFirstCard(meta: CardMeta): void {
  const stage = realmEl('card-stage');
  clearSpeech();
  stage.innerHTML = '';
  stage.className = 'intro-view firstcard-view';
  const card = meta.cards[0];
  if (!card) { showStreet(meta); return; }
  const cardEl = buildCardEl(card, {
    big: true,
    enterLabel: 'ENTER',
    onEnter: (el) => { void enterWorld(meta, card, el); },
  });
  cardEl.classList.add('dealt');
  stage.appendChild(cardEl);
  // No hand strip while we're holding here — the card on the stage IS the hand.
  const hand = document.getElementById('card-hand');
  if (hand) hand.innerHTML = '';
}

// The forced first trade: the origin card is dealt, the player reaches for
// ENTER, and the white goblin descends to take it. Leaves the metagame in
// the 'firstworld' phase (one junk card, no street yet); the caller then shows
// the held big-card view.
async function runTradeIntro(meta: CardMeta): Promise<void> {
  const stage = realmEl('card-stage');
  stage.innerHTML = '';
  stage.className = 'intro-view';

  const origin = meta.cards[0];
  await sleep(500);
  const reentered = new Promise<void>((resolve) => {
    const cardEl = buildCardEl(origin, {
      big: true,
      enterLabel: 'ENTER',
      onEnter: () => resolve(),
    });
    // The opening deal: the origin card slides in slowly from off-table,
    // turning flat like a card pushed across felt. `.dealing` carries the
    // slow transition and is dropped once the slide settles, so the later
    // goblin-dip transforms run at normal speed.
    cardEl.classList.add('deal-across', 'dealing');
    stage.appendChild(cardEl);
    // Two frames so the dealt-in transform commits before it transitions out.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        cardEl.classList.remove('deal-across');
        realmSound('place', 1.2, 0.55);
      });
    });
    window.setTimeout(() => cardEl.classList.remove('dealing'), 2400);
  });
  await reentered;

  // The player went for the button — the goblin objects.
  realmSound('online', 0.5, 0.6);
  await typeLine('wait a moment!');
  await goblinIn();
  await say('nice world.');
  await say('i like your world.');
  await sayBeat('. . .');
  await typeLine('have you traded a world before?');
  const picked = await choose(['YES', 'NO']);
  if (picked === 0) {
    await say('no you have not.');
    await say('that makes you a liar.');
    await say('and liars cannot own things. everyone knows this.');
  } else {
    await say('good.');
    await say('then let me be your first.');
  }

  // The taking: the origin card flies up into the goblin.
  clearSpeech();
  const cardEl = stage.querySelector('.world-card');
  cardEl?.classList.add('taken');
  realmSound('select', 0.9, 0.6);
  await sleep(1000);
  cardEl?.remove();

  // The giving: a pitiful replacement drops onto the table (its ascension
  // demand is pinned to plain cash — see makeCard's junk path).
  const rng = mulberry32((Date.now() ^ 0x5f356495) >>> 0);
  const junk = newCard(meta, 'common', rng, true);
  const junkEl = buildCardEl(junk, { big: true });
  junkEl.classList.add('deal-from-top');
  stage.appendChild(junkEl);
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      junkEl.classList.remove('deal-from-top');
      realmSound('place', 1.2, 0.7);
    });
  });
  await sleep(900);
  await say("now it's a trade.");
  clearSpeech();
  await goblinOut();

  // The books: origin gone (seeded into gathering III), junk card in hand.
  // Phase holds at 'firstworld' — the realm now keeps the player on the big
  // single-card view (showFirstCard) with nothing to do but ENTER it; the
  // street of gatherings only opens once they've been inside and come back.
  meta.cards = [junk];
  meta.events = generateEvents(meta, origin, ALL_TASK_IDS, loadManualWorlds());
  meta.phase = 'firstworld';
  saveMeta(meta);
  await sleep(400);
  junkEl.remove();
}

// ─── Table / gathering / trade views ─────────────────────────────────

function div(cls: string, text?: string): HTMLElement {
  const d = document.createElement('div');
  d.className = cls;
  if (text !== undefined) d.textContent = text;
  return d;
}

// ─── The player's hand ───────────────────────────────────────────────
// Lives in #card-hand, pinned to the bottom of the realm OUTSIDE the
// swapped stage, so moving between table / gathering / trade never fades
// or re-deals the cards the player is holding. Each view re-wires it (the
// handlers differ) but the DOM it builds is identical, so nothing visibly
// changes across a swap.
type HandOpts = {
  // Gathering view: whole-card clicks toggle the shared selection.
  onCardClick?: (card: WorldCard) => void;
  // Mounted above the hand's caption.
  topEl?: HTMLElement;
};

function renderHand(meta: CardMeta, opts: HandOpts = {}): void {
  const hand = document.getElementById('card-hand');
  if (!hand) return;
  hand.innerHTML = '';
  if (opts.topEl) hand.appendChild(opts.topEl);
  if (meta.cards.length > 0) {
    hand.appendChild(div('ct-caption', meta.cards.length === 1 ? 'your world' : 'your worlds'));
    const row = div('ct-cards');
    for (const c of meta.cards) {
      row.appendChild(handCardEl(c, {
        onEnter: (cardEl) => { void enterWorld(meta, c, cardEl); },
        onClick: opts.onCardClick ? () => opts.onCardClick!(c) : undefined,
      }));
    }
    hand.appendChild(row);
  }
  // Scrolled stage content must be able to clear the hand.
  const stage = document.getElementById('card-stage');
  if (stage) stage.style.paddingBottom = hand.offsetHeight > 0 ? `${hand.offsetHeight + 8}px` : '';
}

// ─── The street of gatherings (the 'free'-phase home view) ───────────
// The flat list of gatherings became a street: each gathering is a little
// white house lining a road that recedes into the dream. The player walks it
// row by row (a forward / back control) and steps through a door to enter a
// gathering. It's all CSS-3D — a perspective box (#sv-scene) holds a preserve-
// 3d world (.sv-camera) that we move by applying the INVERSE of the camera
// pose, so "moving the camera" is one transform on one element.

// The street's geometry + camera maths live DOM-free in cards-core (STREET,
// streetHouse, streetDoor, streetEnterPose, streetFocusPose) so the unit tests
// can prove the fly-in lands square on a door. This module is the DOM half.

// The .sv-camera transform — the INVERSE of the camera pose, applied to the
// world group — kept exactly in step with cards-core's streetViewSpace so the
// tested maths and the rendered scene agree.
function camTransform(p: StreetCam): string {
  return `rotateX(${(p.pitch ?? STREET.pitch)}deg) rotateY(${-p.yaw}deg) translate3d(${(-p.x).toFixed(1)}px, ${(-p.y).toFixed(1)}px, ${(-p.z).toFixed(1)}px)`;
}

// One simple white house: four walls, a gabled roof, a door and (for a
// gathering) a lit sign over it. `face` rotates the whole house so its door
// looks the way we want; the door/sign live on the front face's 2-D plane.
function buildHouse(opts: { tier?: CardTier; name?: string; sign?: string; plain?: boolean }): HTMLElement {
  const { w, h, d, rh } = STREET.house;
  const house = div(`sv-house${opts.plain ? ' plain' : ''}${opts.tier ? ` t-${opts.tier}` : ''}`);
  const slant = Math.hypot(w / 2, rh);
  const lean = Math.atan2(w / 2, rh) * 180 / Math.PI;
  const face = (cls: string, wpx: number, hpx: number, t: string): HTMLElement => {
    const f = div(`sv-face ${cls}`);
    f.style.width = `${wpx}px`;
    f.style.height = `${hpx}px`;
    f.style.marginLeft = `${-wpx / 2}px`;
    f.style.marginTop = `${-hpx / 2}px`;
    f.style.transform = t;
    house.appendChild(f);
    return f;
  };
  // Walls (front carries the door + sign in its own 2-D plane).
  const front = face('sv-wall sv-front', w, h, `translate3d(0,${-h / 2}px,${d / 2}px)`);
  face('sv-wall sv-back', w, h, `translate3d(0,${-h / 2}px,${-d / 2}px) rotateY(180deg)`);
  face('sv-wall sv-left', d, h, `translate3d(${-w / 2}px,${-h / 2}px,0) rotateY(-90deg)`);
  face('sv-wall sv-right', d, h, `translate3d(${w / 2}px,${-h / 2}px,0) rotateY(90deg)`);
  // Gable triangles (front/back) + the two roof slopes (left/right).
  const gableFront = face('sv-gable', w, rh, `translate3d(0,${-h - rh / 2}px,${d / 2}px)`);
  gableFront.style.clipPath = 'polygon(0 100%, 50% 0, 100% 100%)';
  const gableBack = face('sv-gable', w, rh, `translate3d(0,${-h - rh / 2}px,${-d / 2}px) rotateY(180deg)`);
  gableBack.style.clipPath = 'polygon(0 100%, 50% 0, 100% 100%)';
  face('sv-roof', d, slant, `translate3d(${w / 4}px,${-h - rh / 2}px,0) rotateZ(${-lean}deg) rotateY(90deg)`);
  face('sv-roof', d, slant, `translate3d(${-w / 4}px,${-h - rh / 2}px,0) rotateZ(${lean}deg) rotateY(-90deg)`);
  // A soft contact shadow laid flat on the ground, so the house sits rather
  // than floats.
  const shadow = div('sv-shadow');
  shadow.style.width = `${w * 1.5}px`;
  shadow.style.height = `${d * 1.5}px`;
  shadow.style.marginLeft = `${-w * 0.75}px`;
  shadow.style.marginTop = `${-d * 0.75}px`;
  shadow.style.transform = 'translateY(-1px) rotateX(90deg)';
  house.appendChild(shadow);
  // Door on the front plane.
  const door = div('sv-door');
  front.appendChild(door);
  // A gathering hangs a lit sign with its name over the door.
  if (opts.sign) {
    const sign = div('sv-sign');
    sign.textContent = opts.sign;
    front.appendChild(sign);
  }
  return house;
}

// A gathering's house on the street, plus its focus row (= the plot it sits at).
type StreetSlot = { ev: TradeEvent; row: number; side: StreetSide; house: ReturnType<typeof streetHouse>; el?: HTMLElement };

// The player's own house, parked at the head of the street (a plot in FRONT of
// the first gathering, on the right line) — the one the reveal pulls out of,
// and just scenery thereafter. It's a normal street house: same lane and
// angled door as the residences, so it sits flush with the street instead of
// facing flat across it. Derived live so the dev sliders move it too.
function revealHome(): StreetHouse { return streetHouse(-1, 'R'); }

// Lay the gatherings into two lines (pairs of left/right plots) and fill every
// other plot — plus a couple beyond — with plain residences, so both sides read
// as a continuous street rather than a sparse handful of houses.
function streetLayout(meta: CardMeta): { gatherings: StreetSlot[]; residences: ReturnType<typeof streetHouse>[]; rows: number } {
  const evs = meta.events ?? [];
  const rows = gatheringRowCount(evs.length);
  const gatherings: StreetSlot[] = [];
  const taken = new Set<string>();
  evs.forEach((ev, i) => {
    const { plot, side } = gatheringSlot(i);
    taken.add(`${plot},${side}`);
    gatherings.push({ ev, row: plot, side, house: streetHouse(plot, side) });
  });
  const residences: ReturnType<typeof streetHouse>[] = [];
  for (let plot = 0; plot <= rows + 1; plot++) {
    for (const side of ['L', 'R'] as StreetSide[]) {
      if (!taken.has(`${plot},${side}`)) residences.push(streetHouse(plot, side));
    }
  }
  return { gatherings, residences, rows };
}

// The last row the player stood at, so backing out of a gathering returns the
// camera where it was rather than snapping to the top of the street.
let streetRow = 0;
// The gathering house last stepped into, so leaving it can reverse the fly-in
// (emerge back out through that same door) rather than cut to the street.
let enteredFrom: { row: number; side: StreetSide } | null = null;

// Build the 3-D street into #card-stage and return its moving parts. Interactivity
// is wired by `focusRow`; the reveal drives the camera itself before calling it.
function buildStreetScene(meta: CardMeta): {
  scene: HTMLElement; camera: HTMLElement; home: HTMLElement; gatherings: StreetSlot[]; rows: number;
  setCam: (p: StreetCam, ms: number, ease?: string, cull?: 'cull' | HTMLElement) => Promise<void>;
  focusRow: (row: number) => void;
} {
  const stage = realmEl('card-stage');
  clearSpeech();
  stage.innerHTML = '';
  stage.className = 'street-view';

  if (!meta.events) {
    meta.events = generateEvents(meta, null, ALL_TASK_IDS, loadManualWorlds());
    saveMeta(meta);
  }

  const scene = div('sv-scene');
  scene.style.perspective = `${STREET.persp}px`;
  const camera = div('sv-camera');
  scene.appendChild(camera);
  stage.appendChild(scene);

  // Ground: one big plane laid flat, with a paler road strip down the middle.
  // Pin its Y to STREET.groundY (overriding the CSS fallback) so the dev
  // ground-depth slider moves the road with the houses' bases.
  const ground = div('sv-ground');
  ground.style.transform = `translate3d(0, ${STREET.groundY}px, -2520px) rotateX(90deg)`;
  ground.appendChild(div('sv-road'));
  camera.appendChild(ground);

  // Every house, with its world centre — so a pose can hide any that have
  // crossed behind the eye (where CSS perspective would blow them up into
  // screen-filling junk) and the fly-in can keep only its target on screen.
  const houses: { el: HTMLElement; cx: number; cz: number }[] = [];
  const place = (el: HTMLElement, h: { x: number; z: number; faceYaw: number }) => {
    el.style.transform = `translate3d(${h.x}px,${STREET.groundY}px,${h.z}px) rotateY(${h.faceYaw}deg)`;
    camera.appendChild(el);
    houses.push({ el, cx: h.x, cz: h.z });
  };

  // The player's own house at the street's head — the one the reveal pulls out
  // of, scenery thereafter.
  const home = buildHouse({ plain: true });
  home.classList.add('sv-home');
  place(home, revealHome());
  const homeSign = div('sv-sign sv-home-sign');
  homeSign.textContent = 'home';
  (home.querySelector('.sv-front') as HTMLElement)?.appendChild(homeSign);

  const { gatherings, residences, rows } = streetLayout(meta);
  // Plain residences flesh the two lines out into a real street.
  for (const h of residences) place(buildHouse({ plain: true }), h);
  // The gatherings themselves, each a signed, enterable house.
  for (const slot of gatherings) {
    const el = buildHouse({ tier: slot.ev.tier, sign: slot.ev.name });
    slot.el = el;
    place(el, slot.house);
  }

  // Cull mode for a pose. The interactive street hides any house at/behind the
  // eye plane ('cull') — the ones CSS would magnify into the frame from the
  // side — and the fly-in keeps only its target on screen (an element). The
  // hand-choreographed reveal frames home up close on purpose, so it culls
  // nothing (undefined). CULL_Z gives a small in-front tolerance.
  const CULL_Z = 40;
  type Cull = 'cull' | HTMLElement | undefined;
  const show = (el: HTMLElement): void => { el.style.visibility = ''; el.style.opacity = ''; };
  const hide = (el: HTMLElement): void => { el.style.visibility = 'hidden'; el.style.opacity = ''; };
  const applyCull = (p: StreetCam, mode: Cull): void => {
    if (!mode) { for (const h of houses) show(h.el); return; }
    for (const h of houses) {
      const v = streetViewSpace({ x: h.cx, y: STREET.groundY - STREET.house.h / 2, z: h.cz }, p);
      const behind = v.z > CULL_Z;
      // Walking the street ('cull') just hides whatever has slipped behind the
      // eye. A fly-in (mode = the target house) keeps the target solid and
      // fades the rest to STREET.cullFade — but anything behind the eye is
      // still hidden outright, or CSS perspective magnifies it into junk.
      if (mode === 'cull') { behind ? hide(h.el) : show(h.el); continue; }
      if (h.el === mode) { show(h.el); continue; }
      if (behind) { hide(h.el); continue; }
      h.el.style.visibility = '';
      h.el.style.opacity = STREET.cullFade >= 1 ? '' : String(STREET.cullFade);
    }
  };

  const setCam = (p: StreetCam, ms: number, ease = 'cubic-bezier(0.66,0,0.34,1)', cull?: Cull): Promise<void> => {
    camera.style.transition = ms > 0 ? `transform ${ms}ms ${ease}` : 'none';
    camera.style.transform = camTransform(p);
    applyCull(p, cull);
    return sleep(ms);
  };

  // Controls (forward / back along the street) + the hint line, in a fixed
  // overlay so they never tip with the 3-D world.
  const controls = div('sv-controls');
  const back = document.createElement('button');
  back.type = 'button'; back.className = 'sv-step sv-step-back';
  back.innerHTML = '<span>↓</span> back';
  const label = div('sv-row-label');
  const fwd = document.createElement('button');
  fwd.type = 'button'; fwd.className = 'sv-step sv-step-fwd';
  fwd.innerHTML = 'further <span>↑</span>';
  controls.append(back, label, fwd);
  controls.classList.add('sv-hidden');   // shown when control is handed over
  stage.appendChild(controls);

  let active = false;
  const focusRow = (row: number): void => {
    controls.classList.remove('sv-hidden');
    streetRow = Math.max(0, Math.min(rows - 1, row));
    label.textContent = rows > 1 ? `street · ${streetRow + 1} / ${rows}` : 'the street';
    back.disabled = streetRow === 0;
    fwd.disabled = streetRow >= rows - 1;
    // Only the focused row's gatherings light up and take clicks.
    for (const slot of gatherings) {
      slot.el?.classList.toggle('sv-active', slot.row === streetRow);
      slot.el?.classList.toggle('sv-dim', slot.row !== streetRow);
    }
    if (active) void setCam(streetFocusPose(streetRow), 900, undefined, 'cull');
  };

  const stepTo = (row: number): void => {
    if (!active || row < 0 || row >= rows || row === streetRow) return;
    realmSound('click', 0.7, 1);
    focusRow(row);
  };
  back.addEventListener('click', () => stepTo(streetRow - 1));
  fwd.addEventListener('click', () => stepTo(streetRow + 1));

  // Clicking a focused gathering flies the camera straight into its door, then
  // hands off to the gathering view.
  for (const slot of gatherings) {
    slot.el?.addEventListener('click', () => {
      if (!active || slot.row !== streetRow) return;
      const locked = meta.cards.length === 0
        || !slot.ev.creatures.some((cr) => wantSatisfiableBy(cr.want, meta.cards));
      if (locked) {
        realmSound('error', 0.7);
        slot.el?.classList.remove('sv-shake');
        void slot.el?.offsetWidth;
        slot.el?.classList.add('sv-shake');
        return;
      }
      active = false;
      realmSound('ritual', 0.8, 0.8);
      void enterGatheringHouse(meta, slot, setCam);
    });
  }

  return {
    scene, camera, home, gatherings, rows, setCam,
    focusRow: (row: number) => { active = true; focusRow(row); },
  };
}

// The interactive street: build it, drop the camera onto the saved row, and
// let the player walk and enter. (renderHand keeps "your worlds" along the
// bottom, exactly as the old table did.)
function showStreet(meta: CardMeta, opts: { row?: number; fromCam?: StreetCam; reverse?: { row: number; side: StreetSide } } = {}): void {
  const s = buildStreetScene(meta);
  const row = Math.max(0, Math.min(s.rows - 1, opts.row ?? streetRow));
  renderHand(meta);
  // Leaving a gathering: reverse the fly-in out of that same door.
  const from = opts.reverse && s.gatherings.find((g) => g.row === opts.reverse!.row && g.side === opts.reverse!.side);
  if (from) { void reverseOutOfHouse(s, from, row); return; }
  // Snap to a starting pose, then ease into the focus pose so the street
  // "arrives" with a touch of motion rather than a hard cut.
  void s.setCam(opts.fromCam ?? streetFocusPose(row), 0, undefined, 'cull');
  requestAnimationFrame(() => requestAnimationFrame(() => s.focusRow(row)));
}

// The fly-in, played backwards: start nose-deep past the door (white-washed,
// only that house on screen), draw back out through the threshold and onto the
// road, then turn down the street as the rest of the houses fade back in.
async function reverseOutOfHouse(
  s: { setCam: (p: StreetCam, ms: number, ease?: string, cull?: 'cull' | HTMLElement) => Promise<void>; focusRow: (row: number) => void },
  slot: StreetSlot, row: number,
): Promise<void> {
  const stage = realmEl('card-stage');
  const target = slot.el;
  stage.classList.add('sv-exiting');   // a white wash, full → fading, mirrors the door-wash
  await s.setCam(streetDollyPose(slot.house, -640), 0, undefined, target);
  await s.setCam(streetEnterPose(slot.house), 460, 'cubic-bezier(0.4,0.4,0.6,1)', target);
  await s.setCam(streetDollyPose(slot.house, 240), 540, 'cubic-bezier(0.3,0,0.5,1)', target);
  stage.classList.remove('sv-exiting');
  // Turn back onto the street; 'cull' un-hides the rest of the houses.
  await s.setCam(streetFocusPose(row), 720, 'cubic-bezier(0.5,0,0.3,1)', 'cull');
  s.focusRow(row);
}

// Dive from the street into a gathering: with only the target house on screen,
// turn to face its door head-on, fly square at it (streetEnterPose — door
// dead-centre, a nose away) and push on THROUGH the threshold, then swap to the
// gathering under the door-wash + cross-fade.
async function enterGatheringHouse(meta: CardMeta, slot: StreetSlot, setCam: (p: StreetCam, ms: number, ease?: string, cull?: 'cull' | HTMLElement) => Promise<void>): Promise<void> {
  streetRow = slot.row;
  enteredFrom = { row: slot.row, side: slot.side };
  const target = slot.el;
  // Square up out on the road in front of the door (only the target visible, so
  // nothing else crowds the frame).
  await setCam(streetDollyPose(slot.house, 240), 720, 'cubic-bezier(0.4,0,0.5,1)', target);
  realmEl('card-stage').classList.add('sv-entering');
  // Fly to the threshold (the door dead-centre), then push on through it: the
  // door swells past the eye as the wash whites out, reading as stepping in.
  await setCam(streetEnterPose(slot.house), 540, 'cubic-bezier(0.5,0,0.8,0.5)', target);
  await setCam(streetDollyPose(slot.house, -640), 460, 'cubic-bezier(0.55,0,0.95,0.7)', target);
  swapView(() => showGathering(meta, slot.ev));
}

// The one-shot reveal, played the first time the player leaves the traded
// world: we start nose-to-the-card "inside" the house, pull back through its
// front to show it as a little white house, hold a beat, then turn ninety
// degrees and draw back to look down the whole street of gatherings.
async function runStreetReveal(meta: CardMeta): Promise<void> {
  // Consume the flag up front so a reload mid-reveal just lands on the street.
  meta.revealPending = false;
  saveMeta(meta);

  const s = buildStreetScene(meta);
  const stage = realmEl('card-stage');
  // The flat card we were holding, laid over the scene, "inside" the house.
  const card = meta.cards[0];
  let cardEl: HTMLElement | null = null;
  if (card) {
    cardEl = buildCardEl(card, { big: true });
    cardEl.classList.add('sv-reveal-card');
    // Inline transition so the shrink-into-the-house still plays even when the
    // page is in reduced-motion (the realm's ambient drift parks, but this
    // one-shot beat shouldn't).
    cardEl.style.transition = 'transform 1500ms cubic-bezier(0.4,0,0.3,1), opacity 1300ms ease 200ms';
    stage.appendChild(cardEl);
  }

  // Looking square at the home's door, the card laid over it. The poses sit
  // out along the door's own normal (streetDollyPose), so they stay framed on
  // the door whatever angle the home faces; the later turn swings from here
  // onto the street, which runs down -Z.
  const hh = revealHome();
  const insidePose: StreetCam = { ...streetDollyPose(hh, 70), pitch: 3 };
  const exteriorPose: StreetCam = { ...streetDollyPose(hh, 540), pitch: 7 };
  void s.setCam(insidePose, 0);
  await sleep(1000);

  // Pull back out of the house; the card shrinks INTO the home (toward its real
  // on-screen spot, not just the screen centre) and fades as the house emerges.
  if (cardEl) {
    const homeR = s.home.getBoundingClientRect();
    const dx = (homeR.left + homeR.width / 2) - window.innerWidth / 2;
    const dy = (homeR.top + homeR.height / 2) - window.innerHeight / 2;
    cardEl.style.transform = `translate(calc(-50% + ${dx.toFixed(0)}px), calc(-50% + ${dy.toFixed(0)}px)) scale(0.05)`;
    cardEl.style.opacity = '0';
  }
  realmSound('ritual', 0.7, 0.7);
  await s.setCam(exteriorPose, 1800, 'cubic-bezier(0.4,0,0.3,1)');
  cardEl?.remove();
  await sleep(850);

  // The ninety-degree turn (yaw 90 → 0), drawing back to look down the street.
  realmSound('online', 0.4, 0.7);
  await s.setCam({ x: 0, y: STREET.eyeY, z: STREET.plotZ0 + STREET.camBack + 240, yaw: 0, pitch: STREET.pitch }, 2100, 'cubic-bezier(0.5,0,0.25,1)');
  await sleep(450);

  // Settle onto the first row (a gentle dolly in) and hand control over.
  s.focusRow(0);
  renderHand(meta);
}

function backButton(label: string, onBack: () => void): HTMLElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ct-back';
  btn.textContent = label;
  btn.addEventListener('click', () => { realmSound('click', 0.8, 1); onBack(); });
  return btn;
}

function creatureAvatar(): HTMLElement {
  return div('ct-creature-sprite');
}


// ─── The gathering: all traders at once ──────────────────────────────
// One gathering, every trader on screen together. Each is a "stall": its
// avatar, name, advertised want, its whole deck face-up (each card a
// SPECTATE entry), and a give-button that lights only when the player's
// current hand selection exactly satisfies that stall's want. One shared
// selection — driven by clicks on the persistent hand below — feeds every
// stall at once. Give & take: surrender the picked card(s), receive the
// trader's ENTIRE deck; the trader is then spent.
// How a partly-typed segmented line renders: take the first `count` characters
// across the segments, wrapping the bold (requirement) ones in <b>.
function renderSegs(segs: WantSeg[], count: number): string {
  let remaining = count, html = '';
  for (const s of segs) {
    if (remaining <= 0) break;
    const piece = s.t.slice(0, Math.min(s.t.length, remaining));
    html += s.b ? `<b>${piece}</b>` : piece;
    remaining -= piece.length;
  }
  return html;
}

const LINE_TYPE_MS = 22;

function showGathering(meta: CardMeta, ev: TradeEvent): void {
  const stage = realmEl('card-stage');
  clearSpeech();
  stage.innerHTML = '';
  stage.className = 'gathering-view';

  const head = div('ct-gathering-head');
  head.appendChild(backButton('← back to the street', () => swapView(() => showStreet(meta, { row: streetRow, reverse: enteredFrom ?? undefined }))));
  head.appendChild(div(`ct-caption ct-event-title t-${ev.tier}`, ev.name));
  stage.appendChild(head);

  // The reshuffle, pinned to the gathering's top-right corner. Only the
  // stalls shuffle — the player's hand (unchanged by a reshuffle) is left
  // alone, so the cards below never flash or re-deal between gatherings.
  const wait = document.createElement('button');
  wait.type = 'button';
  wait.className = 'ct-wait ct-wait-corner';
  wait.textContent = 'wait for the next gathering ⟳';
  wait.addEventListener('click', async () => {
    if (tradeAnimating) return;
    wait.disabled = true;
    realmSound('online', 0.4, 0.7);
    row.classList.add('swapping');
    await sleep(320);
    regenerateEvent(meta, ev, ALL_TASK_IDS, loadManualWorlds());
    saveMeta(meta);
    firstDeal = true;        // the fresh traders deal back in with a stagger
    buildStalls();
    row.classList.remove('swapping');
    wait.disabled = false;
  });
  stage.appendChild(wait);

  const row = div('ct-stalls');
  stage.appendChild(row);

  // The one selection shared across every stall, toggled from the hand.
  const pickedMine = new Set<number>();
  const minePicked = (): WorldCard[] => meta.cards.filter((c) => pickedMine.has(c.id));

  // "choose cards to trade", shown above the hand while nothing is picked.
  const choosePrompt = div('ct-choose-prompt', 'choose cards to trade');

  // The player's hand lives INSIDE the scrollable stage (below the stalls), so
  // a big collection scrolls with the gathering instead of sitting in a fixed
  // bottom layer that overlaps the traders.
  const handWrap = div('ct-hand-inline');
  stage.appendChild(handWrap);
  const gatherHandRow = (): HTMLElement | null => handWrap.querySelector('.ct-cards');

  // Per-stall handles, so a selection change re-states every want and
  // re-evaluates every give-button without rebuilding the (canvas-heavy) cards.
  type StallRef = { lineEl: HTMLElement; giveBtn: HTMLButtonElement | null; token: { v: number }; last: string };
  const stalls = new Map<number, StallRef>();

  let tradeAnimating = false;

  // Type a trader's line out letter-at-a-time (the requirement bolded); a
  // newer line cancels an older one still typing.
  const typeLine = (ref: StallRef, segs: WantSeg[]): void => {
    ref.last = segs.reduce((s, x) => s + x.t, '');
    const tok = ++ref.token.v;
    const total = segs.reduce((n, s) => n + s.t.length, 0);
    ref.lineEl.classList.add('typing');
    ref.lineEl.innerHTML = '';
    void (async () => {
      for (let n = 1; n <= total; n++) {
        if (tok !== ref.token.v) return;
        ref.lineEl.innerHTML = renderSegs(segs, n);
        await sleep(LINE_TYPE_MS);
      }
      if (tok === ref.token.v) ref.lineEl.classList.remove('typing');
    })();
  };

  // What a trader says for the current selection:
  //  - nothing / too few picked → its want, restated
  //  - more cards than it asked  → "too many cards."
  //  - the right count, wrong worlds → "no."; the right count and a match → "yes!"
  const lineFor = (cr: Creature): WantSeg[] => {
    if (cr.deck.length === 0) return [{ t: 'traded out. it is content.' }];
    const picked = minePicked();
    if (picked.length > cr.want.count) return [{ t: 'too many cards.' }];
    if (picked.length === cr.want.count) {
      return wantSatisfiedBy(cr.want, picked) ? [{ t: 'yes!' }] : [{ t: 'no.' }];
    }
    return wantSegments(cr.want);
  };

  // Give-button visibility (HIDDEN unless the pick exactly satisfies the want),
  // the choose-prompt, and the hand's selected outlines.
  const refreshButtons = (): void => {
    const picked = minePicked();
    for (const cr of ev.creatures) {
      const ref = stalls.get(cr.id);
      if (!ref?.giveBtn) continue;
      const ready = cr.deck.length > 0 && !tradeAnimating && wantSatisfiedBy(cr.want, picked);
      ref.giveBtn.classList.toggle('ok', ready);
      ref.giveBtn.disabled = !ready;
      // Hidden (not removed) so its row of space stays reserved — the cards
      // box never jumps as the button comes and goes.
      ref.giveBtn.style.visibility = ready ? 'visible' : 'hidden';
    }
    choosePrompt.style.display = picked.length === 0 ? '' : 'none';
    const handRow = gatherHandRow();
    if (handRow) {
      for (const el of [...handRow.children] as HTMLElement[]) {
        el.classList.toggle('selected', pickedMine.has(Number(el.dataset.cardId)));
      }
    }
  };

  // Re-state every trader's line for the current selection — but only retype a
  // line that actually changed (a spent "traded out", or an unchanged want,
  // never re-animates).
  const restateAll = (): void => {
    for (const cr of ev.creatures) {
      const ref = stalls.get(cr.id);
      if (!ref) continue;
      const segs = lineFor(cr);
      if (segs.reduce((s, x) => s + x.t, '') === ref.last) continue;
      typeLine(ref, segs);
    }
  };

  // The exchange, in motion: the picked cards lift toward the stall while its
  // whole deck drops into the hand. Once both halves land the swap re-renders.
  const executeTrade = (cr: Creature): void => {
    if (tradeAnimating) return;
    const picked = minePicked();
    if (!wantSatisfiedBy(cr.want, picked)) return;
    tradeAnimating = true;
    refreshButtons();
    const received = cr.deck;
    // Fly a card toward a target rect's centre — the given cards rise into the
    // trader's stall, the received cards fall toward the hand, each tracking
    // the actual on-screen direction of where it's headed.
    const flyTo = (el: HTMLElement | null | undefined, target: DOMRect | undefined, scale: number): void => {
      if (!el || !target) return;
      const r = el.getBoundingClientRect();
      const dx = (target.left + target.width / 2) - (r.left + r.width / 2);
      const dy = (target.top + target.height / 2) - (r.top + r.height / 2);
      el.style.transition = 'transform 640ms cubic-bezier(0.5, 0, 0.75, 0.4), opacity 560ms ease';
      el.style.transform = `translate(${dx}px, ${dy}px) scale(${scale})`;
      el.style.opacity = '0';
      el.style.pointerEvents = 'none';
    };
    const stallEl = row.querySelector(`[data-creature-id="${cr.id}"]`) as HTMLElement | null;
    const stallRect = stallEl?.querySelector('.ct-stall-cards')?.getBoundingClientRect()
      ?? stallEl?.getBoundingClientRect();
    const handRect = handWrap.getBoundingClientRect();
    for (const m of picked) {
      flyTo(gatherHandRow()?.querySelector(`[data-card-id="${m.id}"]`) as HTMLElement | null, stallRect, 0.6);
    }
    for (const t of received) {
      flyTo(stallEl?.querySelector(`[data-card-id="${t.id}"]`) as HTMLElement | null, handRect, 0.85);
    }
    realmSound('select', 0.9, 0.8);
    const wonOrigin = received.some((t) => t.origin);
    window.setTimeout(() => {
      tradeAnimating = false;
      meta.cards = meta.cards.filter((c) => !pickedMine.has(c.id));
      meta.cards.push(...received);
      cr.deck = [];
      pickedMine.clear();
      saveMeta(meta);
      // Update only the traded stall in place — mark it spent and empty its
      // card box — so the other traders never flash or re-deal. Then rebuild
      // just the hand and pop the arrivals in.
      const ref = stalls.get(cr.id);
      if (stallEl) {
        stallEl.classList.add('spent');
        const box = stallEl.querySelector('.ct-stall-cards');
        if (box) box.innerHTML = '';
        ref?.giveBtn?.remove();
        if (ref) ref.giveBtn = null;
      }
      // Surgically update the hand: drop the cards that flew to the trader,
      // pop the arrivals in — the cards the player kept are never re-rendered,
      // so they don't flash. (Falls back to a full build if the row is gone.)
      const handRow = gatherHandRow();
      if (handRow) {
        for (const m of picked) handRow.querySelector(`[data-card-id="${m.id}"]`)?.remove();
        for (const t of received) {
          const el = buildHandCard(t);
          el.classList.add('trade-arrived');
          handRow.appendChild(el);
        }
        refreshHandCaption();
      } else {
        renderGatherHand();
        for (const t of received) {
          gatherHandRow()?.querySelector(`[data-card-id="${t.id}"]`)?.classList.add('trade-arrived');
        }
      }
      // Selection is cleared — every stall re-states (the traded one now reads
      // "traded out", the rest revert to their want, dropping any "yes!"/"no.").
      restateAll();
      refreshButtons();
      realmSound(wonOrigin ? 'task_complete' : 'ritual', wonOrigin ? 0.9 : 1, wonOrigin ? 1 : 0.9);
    }, 680);
  };

  // Clicks on the player's hand toggle the shared selection — every trader
  // then re-states (and buttons re-evaluate).
  const onMineClick = (mc: WorldCard): void => {
    if (tradeAnimating) return;
    if (pickedMine.has(mc.id)) {
      pickedMine.delete(mc.id);
    } else {
      pickedMine.add(mc.id);
      realmSound('select', 0.7, 1.1);
    }
    restateAll();
    refreshButtons();
  };

  // One held card's element (reused across views via the hand cache): clicks
  // toggle the shared selection, ENTER dives.
  const buildHandCard = (c: WorldCard): HTMLElement =>
    handCardEl(c, {
      onEnter: (cardEl) => { void enterWorld(meta, c, cardEl); },
      onClick: () => onMineClick(c),
      selected: pickedMine.has(c.id),
    });

  // Keep the "your world(s)" caption in step with the held count.
  const refreshHandCaption = (): void => {
    const cap = handWrap.querySelector('.ct-caption') as HTMLElement | null;
    if (cap) cap.textContent = meta.cards.length === 1 ? 'your world' : 'your worlds';
  };

  // Build the in-stage hand: the choose-prompt, a caption, and the player's
  // cards.
  const renderGatherHand = (): void => {
    handWrap.innerHTML = '';
    handWrap.appendChild(choosePrompt);
    if (meta.cards.length > 0) {
      handWrap.appendChild(div('ct-caption', meta.cards.length === 1 ? 'your world' : 'your worlds'));
      const cardsRow = div('ct-cards');
      for (const c of meta.cards) cardsRow.appendChild(buildHandCard(c));
      handWrap.appendChild(cardsRow);
    }
  };

  let firstDeal = true;
  const buildStalls = (): void => {
    row.innerHTML = '';
    stalls.clear();
    ev.creatures.forEach((cr, i) => {
      const spent = cr.deck.length === 0;
      const stall = div(`ct-stall${spent ? ' spent' : ''}`);
      stall.dataset.creatureId = String(cr.id);
      stall.appendChild(creatureAvatar());
      stall.appendChild(div('ct-creature-name', cr.name));
      const lineEl = div('ct-creature-line');
      stall.appendChild(lineEl);

      const cards = div('ct-stall-cards');
      for (const tc of cr.deck) {
        const el = buildCardEl(tc, {
          enterLabel: 'INSPECT',
          onEnter: (cardEl) => { if (!tradeAnimating) void spectateWorld(tc, cardEl); },
        });
        cards.appendChild(el);
      }
      stall.appendChild(cards);

      let giveBtn: HTMLButtonElement | null = null;
      if (!spent) {
        giveBtn = document.createElement('button');
        giveBtn.type = 'button';
        giveBtn.className = 'ct-give';
        giveBtn.textContent = '✓ trade';
        giveBtn.style.visibility = 'hidden';
        const c = cr;
        giveBtn.addEventListener('click', () => {
          if (giveBtn!.disabled || tradeAnimating) return;
          realmSound('click', 0.8, 1);
          executeTrade(c);
        });
        stall.appendChild(giveBtn);
      }

      const ref: StallRef = { lineEl, giveBtn, token: { v: 0 }, last: '' };
      stalls.set(cr.id, ref);
      typeLine(ref, lineFor(cr));

      if (firstDeal) {
        stall.classList.add('dealt');
        stall.style.setProperty('--deal-i', String(i));
      }
      row.appendChild(stall);
    });
    firstDeal = false;
    refreshButtons();
  };

  renderGatherHand();
  buildStalls();
}
