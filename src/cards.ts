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

import { fadeOutForHop, playSound, tryResumeAudioAfterHop, type SoundName } from './audio';
import { BUILDING_DEFS, BuildingKind, CELL, HELL, SPACE, WORLD } from './config';
import { getOptions } from './options';
import { clearSave, getRawSave, saveGame, setRawSave } from './save';
import { GameState, computePlayBounds, isInPlayCell } from './state';
import { ALL_TASK_IDS } from './ui';
import {
  BranchState, CardMeta, CardResources, CardTier, CHARM_DEFS, CHARM_NOTE, CharmKind, Creature, FRAME_BASE,
  HARDCODED_LEVELS, ManualWorld, TradeEvent, Want, WorldCard, applyCharms,
  cardPower, decodeWorld, encodeWorld, ensureBranches, generateEvents, makeCard,
  makeKeyCard, makeSalon, mulberry32, pathName, regenerateEvent, resetChain,
  salonName, salonTierForDepth, sceneStructureCounts, tradeKeepsAWorld, WantSeg,
  wantSatisfiedBy, wantSegments,
} from './cards-core';
import { sleep } from './util';

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

// Pre-keyDepth keys carried only the tier they were minted at; map that onto
// the salon depth the key opens (common's opened the door to salon 1, the
// uncommon salon's to salon 2). `mintedDepth`, when known (a key still in a
// salon deck), pins it exactly; loose keys in hand fall back to the tier.
function stampLegacyKeyDepth(wc: WorldCard, mintedDepth: number | undefined): void {
  if (!wc.key || wc.keyDepth !== undefined) return;
  if (mintedDepth !== undefined) { wc.keyDepth = mintedDepth + 1; return; }
  wc.keyDepth = wc.tier === 'common' ? 1 : wc.tier === 'uncommon' ? 2 : 3;
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
      m.events.forEach((ev, depth) => {
        // Metas saved before the endless chain: the salon's array index IS its
        // depth, and a gatekeeper's key opens the door to the next one.
        if (ev.depth === undefined) ev.depth = depth;
        ev.creatures.forEach((c, i) => {
          if (c.frame === undefined) {
            c.frame = FRAME_BASE[ev.tier] + i;
            for (const wc of c.deck) {
              if (wc.frame === undefined && !wc.origin) wc.frame = c.frame;
            }
          }
          for (const wc of c.deck) stampLegacyKeyDepth(wc, ev.depth);
          // Metas saved before trader wants existed: synthesize one from the
          // legacy appetite (the first creature, the open one, becomes an
          // any-want).
          if (c.want === undefined) c.want = appetiteToWant((c as { appetite?: string }).appetite, ev.tier, i === 0);
        });
      });
    }
    // Keys already in hand from before keyDepth existed: infer which door they
    // open from the tier they were minted at (common→1, uncommon→2).
    for (const wc of m.cards) stampLegacyKeyDepth(wc, undefined);
    // Migrate the old tier-set unlock flags onto the depth counter: each tier
    // the player had climbed past is one salon depth they can still reach.
    if (m.unlockedDepth === undefined) {
      m.unlockedDepth = Array.isArray(m.unlockedTiers) ? m.unlockedTiers.length : 0;
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

// Which salon (branch + depth) is currently on screen — set by showGathering
// (null while the hall of doors is up), read by the dev cog's "refresh current
// traders" so it re-rolls the right one.
let currentGathering: { branch: number; depth: number } | null = null;

// Dev tool (realm dev cog): reshuffle every gathering's traders + decks,
// behind every door in the hall.
export function devReshuffleGatherings(): void {
  const meta = loadMeta();
  if (!meta) return;
  const branches = ensureHall(meta);
  for (const ev of branches.flatMap((b) => b.events)) {
    regenerateEvent(meta, ev, ALL_TASK_IDS, loadManualWorlds());
  }
  saveMeta(meta);
  refreshRealmView();
}

// Dev tool (realm dev cog): re-roll only the salon currently on screen — the
// old in-gathering "wait for the next gathering" reshuffle, now a dev control.
// Re-shows that same salon rather than routing home to the hall.
export function devRefreshCurrentTraders(): void {
  const meta = loadMeta();
  if (!meta) return;
  if (currentGathering == null) { devReshuffleGatherings(); return; }
  const ev = salonAt(meta, currentGathering.branch, currentGathering.depth);
  if (!ev) return;
  regenerateEvent(meta, ev, ALL_TASK_IDS, loadManualWorlds());
  saveMeta(meta);
  swapView(() => showGathering(meta, ev));
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
  // The hand's charm layer stamps onto the world on the way in — absolutely,
  // so a charm sold since the last visit takes its blessing with it.
  // Spectated worlds are deliberately untouched.
  applyCharms(st, meta.cards);
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
  // The dive cue (rides the ENTER click's gesture — a post-reload arrival
  // sound would be muted until the next gesture): the ritual tone over a deep
  // whoosh that swells as the world rushes up, then a soft impact as the white
  // lands.
  realmSound('ritual', 1, 0.7);
  realmSound('online', 0.5, 0.42);
  window.setTimeout(() => realmSound('place', 0.6, 0.5), 480);
  markCardHop();
  // The dive: the chosen card swells toward the viewer while the white
  // takes over — it bridges into the arrival zoom on the far side of the
  // reload (setupCardWorldChrome).
  const white = hopWhite();
  white.style.transition = 'opacity 520ms ease-in';
  cardEl?.classList.add('dived');
  requestAnimationFrame(() => { white.style.opacity = '1'; });
  // The white lands at ~520ms; ride the cue's slow swell out on it, then take
  // the whole mix down so the reload cuts on silence — a chopped ringing tail
  // reads as a glitch, a fade reads as passing through.
  await sleep(950);
  fadeOutForHop(260);
  await sleep(280);
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
  realmSound('online', 0.5, 0.42);
  window.setTimeout(() => realmSound('place', 0.6, 0.5), 480);
  markCardHop();
  const white = hopWhite();
  white.style.transition = 'opacity 520ms ease-in';
  cardEl?.classList.add('dived');
  requestAnimationFrame(() => { white.style.opacity = '1'; });
  // Same ride-out + fade as enterWorld: the cue completes on the white and
  // the reload lands on quiet.
  await sleep(950);
  fadeOutForHop(260);
  await sleep(280);
  location.reload();
}

async function leaveSpectate(): Promise<void> {
  markCardHop();
  // The same pull-back as leaveWorld — but nothing is serialized: the visit
  // leaves no mark on the trader's card.
  const app = document.getElementById('app');
  const white = hopWhite();
  white.style.transition = 'opacity 680ms ease-in';
  document.body.classList.add('card-hop-out');
  app?.classList.add('card-exit-zoom');
  requestAnimationFrame(() => { white.style.opacity = '1'; });
  // The landing thunk as the white takes over — the exit cue's third beat —
  // then the ride-out + fade so the reload never chops the ringing tail.
  window.setTimeout(() => realmSound('place', 0.7, 0.5), 500);
  await sleep(1000);
  fadeOutForHop(260);
  await sleep(280);
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
  // over — the finale's own exit, in miniature. The fixed chrome (border,
  // way-out button) dissolves alongside it (body.card-hop-out). The state is
  // serialized AFTER the zoom so the final second of play still makes it
  // onto the card.
  const app = document.getElementById('app');
  const white = hopWhite();
  white.style.transition = 'opacity 680ms ease-in';
  document.body.classList.add('card-hop-out');
  app?.classList.add('card-exit-zoom');
  requestAnimationFrame(() => { white.style.opacity = '1'; });
  // The landing thunk as the white takes over — the exit cue's third beat —
  // then the ride-out + fade so the reload never chops the ringing tail.
  window.setTimeout(() => realmSound('place', 0.7, 0.5), 500);
  await sleep(1000);
  fadeOutForHop(260);
  await sleep(280);
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
  // Leaving the very first (traded) world graduates the metagame: the
  // gatherings open and the realm now lands on the soft border.
  if (meta.phase === 'firstworld') {
    meta.phase = 'free';
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
      // The pull-back cue: the ritual tone over a rising swell as the whole
      // world recedes to a point.
      realmSound('ritual', 1, 0.7);
      realmSound('online', 0.45, 0.5);
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
    // The element white now owns the screen — the pre-paint reload cover
    // (html.hop, stamped by index.html's inline script) hands off to it.
    document.documentElement.classList.remove('hop');
    // The departing page carried the click; ask for the audio context back so
    // the arrival cue below can land (silent where the browser declines).
    tryResumeAudioAfterHop();
    // Hold on white until the world has actually RENDERED — main.ts calls
    // releaseCardWorldArrival() right after the first painted frame, so the
    // zoom always reveals a live world, never a blank canvas mid-boot. The
    // timer is a safety net: a stalled boot must not strand the player here.
    pendingArrival = () => {
      pendingArrival = null;
      // The world exhales as it swells out of the white.
      playSound('online', 0.4, 0.55, true);
      window.setTimeout(() => playSound('place', 0.5, 0.6, true), 620);
      // Two frames so the scaled-down start commits before the release.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          app?.classList.add('card-enter-zoom-go');
          white.style.transition = 'opacity 1050ms ease-out 80ms';
          white.style.opacity = '0';
        });
      });
      window.setTimeout(() => {
        app?.classList.remove('card-enter-zoom', 'card-enter-zoom-go');
      }, 1600);
    };
    window.setTimeout(releaseCardWorldArrival, 4000);
  }
}

// The arrival zoom, parked until the destination world has painted its first
// frame (setupCardWorldChrome arms it; main.ts fires it right after the first
// render). Idempotent — the safety timeout and the frame hook can both call.
let pendingArrival: (() => void) | null = null;
export function releaseCardWorldArrival(): void {
  pendingArrival?.();
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

// Compact magnitude for a card face: 240, 1.5k, 6.5M, 2.1G. Billions read as
// "G" (giga), never "B" — so they can't be mistaken for blood's "B" suffix.
function compactAmt(n: number): string {
  const x = Math.floor(n);
  if (x < 1000) return String(x);
  for (const [v, u] of [[1e12, 'T'], [1e9, 'G'], [1e6, 'M'], [1e3, 'k']] as const) {
    if (x >= v) {
      const d = x / v;
      return (d >= 100 ? String(Math.round(d)) : String(Math.round(d * 10) / 10)) + u;
    }
  }
  return String(x);
}
// Energy on a card face — total gross output as W / kW / MW / GW.
function compactPower(w: number): string {
  if (w >= 1e9) return `${Math.round(w / 1e8) / 10}GW`;
  if (w >= 1e6) return `${Math.round(w / 1e5) / 10}MW`;
  if (w >= 1e3) return `${Math.round(w / 1e2) / 10}kW`;
  return `${Math.floor(w)}W`;
}

// The card's resource line: only the resources that matter — cash (Ƶ), blood
// (B), energy (W/MW/GW gross output) and bones (b) — and only at non-negligible
// amounts, each in its own color. Tiny dust and zeros are omitted entirely.
function resourcesEl(r: CardResources): HTMLElement {
  const wrap = div('wc-res');
  const add = (cls: string, text: string) => {
    const span = document.createElement('span');
    span.className = cls;
    span.textContent = text;
    wrap.appendChild(span);
  };
  const power = r.power ?? 0;
  if (r.money >= 100) add('res-cash', `Ƶ${compactAmt(r.money)}`);
  if (r.blood >= 5) add('res-blood', `${compactAmt(r.blood)}B`);
  if (power >= 1000) add('res-power', compactPower(power));
  if (r.dragonBone >= 1) add('res-bones', `${compactAmt(r.dragonBone)}b`);
  return wrap;
}

// The charm reading: a plaque held up over the realm with the charm's glyph,
// name, what the blessing does, and the shared holding note. One per screen;
// a click anywhere puts it down.
function showCharmRead(kind: CharmKind): void {
  document.getElementById('charm-read')?.remove();
  const def = CHARM_DEFS[kind];
  const veil = div('');
  veil.id = 'charm-read';
  const plaque = div(`charm-read-plaque charm-${kind}`);
  plaque.appendChild(div('wc-charm-glyph', def.glyph));
  plaque.appendChild(div('charm-read-name', def.name));
  plaque.appendChild(div('charm-read-desc', def.desc));
  plaque.appendChild(div('charm-read-note', CHARM_NOTE));
  plaque.appendChild(div('charm-read-hint', 'click to put it down'));
  veil.appendChild(plaque);
  document.body.appendChild(veil);
  realmSound('select', 0.5, 1.15);
  requestAnimationFrame(() => veil.classList.add('visible'));
  veil.addEventListener('click', () => {
    veil.classList.remove('visible');
    realmSound('click', 0.4, 0.85);
    window.setTimeout(() => veil.remove(), 260);
  }, { once: true });
}

type CardElOpts = {
  enterLabel?: string;       // ENTER / INSPECT — the card's primary action button
  onEnter?: (cardEl: HTMLElement) => void;
  onSelect?: (cardEl: HTMLElement) => void;  // own cards in a trade: the SELECT button
  selectLabel?: string;
};

function buildCardEl(card: WorldCard, opts: CardElOpts = {}): HTMLElement {
  // A key card has no world behind it — just the key glyph and a label. It
  // can be selected (so it sits in the hand like any card) but never entered,
  // and it carries no preview panes or resource line.
  if (card.key) {
    const keyEl = document.createElement('div');
    keyEl.className = 'world-card wc-keycard';
    keyEl.dataset.cardId = String(card.id);
    const head = document.createElement('div');
    head.className = 'wc-head';
    head.innerHTML = '<span class="wc-tier">key</span>';
    keyEl.appendChild(head);
    keyEl.appendChild(div('wc-key-art'));
    // With a whole hall of chains, a loose key must say which lock it fits:
    // the door (branch) it belongs to and the level it opens.
    if (card.keyDepth !== undefined) {
      keyEl.appendChild(div('wc-key-line', `door ${(card.keyBranch ?? 0) + 1} · level ${card.keyDepth + 1}`));
    }
    // A key carries no world, so it's never entered or inspected — only its
    // SELECT button (when it's in the player's hand) ever applies.
    const keyActs = cardActions({ onSelect: opts.onSelect, selectLabel: opts.selectLabel }, keyEl);
    if (keyActs) keyEl.appendChild(keyActs);
    return keyEl;
  }
  // A charm card: an amulet in place of the world panes. It can't be entered
  // — no world behind it — so its primary action is READ: the full text of
  // what the blessing does, held up on a plaque. In the hand it can also be
  // SELECTed, though only a charm-seeker's want will ever take it.
  if (card.charm) {
    const kind = card.charm;
    const def = CHARM_DEFS[kind];
    const charmEl = document.createElement('div');
    charmEl.className = `world-card wc-charmcard charm-${kind}`;
    charmEl.dataset.cardId = String(card.id);
    const chead = document.createElement('div');
    chead.className = 'wc-head';
    chead.innerHTML = '<span class="wc-tier">charm</span>';
    charmEl.appendChild(chead);
    const art = div('wc-charm-art');
    art.appendChild(div('wc-charm-glyph', def.glyph));
    charmEl.appendChild(art);
    charmEl.appendChild(div('wc-charm-name', def.name));
    const charmActs = cardActions({
      enterLabel: 'READ',
      onEnter: () => showCharmRead(kind),
      onSelect: opts.onSelect,
      selectLabel: opts.selectLabel,
    }, charmEl);
    if (charmActs) charmEl.appendChild(charmActs);
    return charmEl;
  }
  const root = document.createElement('div');
  root.className = `world-card t-${card.tier}${card.origin ? ' origin' : ''}`;
  // The trade animations find a card's element by its id. Every card wears the
  // same plain thin border now (no per-trader frame patterns).
  root.dataset.cardId = String(card.id);
  // No card title — just a small rarity tag in the corner (the procedural
  // world names read as bloat at card scale).
  const head = document.createElement('div');
  head.className = 'wc-head';
  head.innerHTML = `<span class="wc-tier">${card.tier}</span>`;
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

  // The compact resource read-out sits at the foot of the card (where the
  // button used to be); the action buttons float in on hover (see cardActions).
  root.appendChild(resourcesEl(card.resources));
  const acts = cardActions(opts, root);
  if (acts) root.appendChild(acts);
  return root;
}

// The card's action buttons, gathered into a `.wc-actions` group: a SELECT
// button for the player's own cards in a trade, and the ENTER / INSPECT primary
// button. In the gathering this group is hidden until the card is hovered, when
// it fades in centred over the art; on the big single-card views it just sits at
// the foot of the card. Returns null when the card has no actions at all.
function cardActions(opts: CardElOpts, root: HTMLElement): HTMLElement | null {
  if (!opts.enterLabel && !opts.onSelect) return null;
  const actions = div('wc-actions');
  if (opts.onSelect) {
    const sel = document.createElement('button');
    sel.type = 'button';
    sel.className = 'wc-select';
    sel.textContent = opts.selectLabel ?? 'SELECT';
    sel.addEventListener('click', (e) => { e.stopPropagation(); opts.onSelect?.(root); });
    actions.appendChild(sel);
  }
  if (opts.enterLabel) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'wc-enter';
    btn.textContent = opts.enterLabel;
    btn.addEventListener('click', (e) => { e.stopPropagation(); opts.onEnter?.(root); });
    actions.appendChild(btn);
  }
  return actions;
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
  onSelect?: () => void;       // present only in the gathering (the SELECT button)
  selected?: boolean;
};

interface WiredCard extends HTMLElement {
  __onEnter?: (cardEl: HTMLElement) => void;
  __onSelect?: (() => void) | null;
}

function handCardEl(card: WorldCard, w: HandWiring): HTMLElement {
  let el = handCardCache.get(card.id) as WiredCard | undefined;
  if (!el) {
    // Build the card ONCE with both a SELECT and an ENTER button delegating to
    // per-node slots; `.selectable` (set below) decides whether SELECT shows,
    // so the same cached node serves the inert table and the gathering.
    const created = buildCardEl(card, {
      enterLabel: 'ENTER',
      onEnter: (cardEl) => (cardEl as WiredCard).__onEnter?.(cardEl),
      onSelect: (cardEl) => (cardEl as WiredCard).__onSelect?.(),
    }) as WiredCard;
    // A selection badge that CSS reveals only while the card is .selected — a
    // real child (not ::after) so it never clashes with the frame-pattern
    // pseudo-elements traded cards carry.
    created.appendChild(div('wc-check'));
    el = created;
    handCardCache.set(card.id, created);
  } else {
    // A reused node: shed any transient animation/selection state and the
    // inline styles a trade fly-out may have left on it.
    el.classList.remove('selected', 'dealt', 'trade-arrived', 'trade-slot', 'trade-landed', 'trade-given', 'trade-received', 'dived', 'grayed');
    el.style.transition = '';
    el.style.transform = '';
    el.style.opacity = '';
    el.style.pointerEvents = '';
  }
  el.__onEnter = w.onEnter;
  el.__onSelect = w.onSelect ?? null;
  el.classList.toggle('selectable', !!w.onSelect);
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
// A second swap requested mid-fade replaces the queued builder rather than
// racing it, so the view that lands is always the most recent one asked for.
let pendingViewBuild: (() => void) | null = null;
function swapView(build: () => void): void {
  const stage = realmEl('card-stage');
  if (pendingViewBuild) { pendingViewBuild = build; return; }
  pendingViewBuild = build;
  stage.classList.add('waiting');
  window.setTimeout(() => {
    const b = pendingViewBuild;
    pendingViewBuild = null;
    b?.();
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
  // Held on white a beat before anything appears — long for the very first
  // arrival, short when returning from a card world (dead white reads as a
  // hang, not a breath).
  await sleep(meta && meta.phase === 'free' ? 600 : 2600);
  realm.classList.add('visible');
  realmShown?.(realm);
  // Returning from a hop the audio context is often resumable without a
  // fresh gesture — ask, then let the realm breathe in audibly when allowed.
  if (meta && meta.phase === 'free') {
    tryResumeAudioAfterHop();
    window.setTimeout(() => realmSound('online', 0.35, 0.5), 250);
  }
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
// awaiting its first dive, or the hall of doors (the base level).
function routeRealmView(meta: CardMeta): void {
  if (meta.phase === 'firstworld') { showFirstCard(meta); return; }
  showHub(meta);
}

// The hall of doors, generated on demand: migrates a legacy single-chain meta
// into branches[0] and seeds branch 0 when it's missing entirely (the intro
// normally seeds it, but a dev hop straight into the 'free' phase might land
// here without it).
function ensureHall(meta: CardMeta): BranchState[] {
  const branches = ensureBranches(meta);
  if (branches.length === 0) {
    branches.push({ events: generateEvents(meta, null, ALL_TASK_IDS, loadManualWorlds()), unlockedDepth: 0 });
    saveMeta(meta);
  }
  return branches;
}

// The salon at a given branch + depth, rolled (and appended) the first time
// the player reaches it. Each salon gets a stable per-(branch, depth) seed,
// so walking back down a chain and forward again lands on the same table
// until a reshuffle.
function salonAt(meta: CardMeta, branch: number, depth: number): TradeEvent {
  const branches = ensureHall(meta);
  // Branches are unsealed one at a time from the hub; the loop is a guard for
  // a truncated saved meta, not a normal path.
  while (branches.length <= branch) branches.push({ events: [], unlockedDepth: 0 });
  const b = branches[branch];
  if (depth < b.events.length) return b.events[depth];
  for (let d = b.events.length; d <= depth; d++) {
    // The reset count rides the seed so each pass through the hall deals
    // fresh tables instead of replaying the previous cycle's salons; the
    // branch rides it so every door's chain is its own.
    const rng = mulberry32((((meta.seed ?? 0) ^ (d * 2246822519) ^ (branch * 0x9e3779b1) ^ ((meta.resets ?? 0) * 0x85ebca6b)) >>> 0));
    b.events.push(makeSalon(meta, branch, d, rng, ALL_TASK_IDS, loadManualWorlds()));
  }
  saveMeta(meta);
  return b.events[depth];
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
  if (!card) { showHub(meta); return; }
  const cardEl = buildCardEl(card, {
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
  const junkEl = buildCardEl(junk);
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
  // hall of doors only opens once they've been inside and come back.
  meta.cards = [junk];
  meta.events = null;
  meta.branches = [{ events: generateEvents(meta, origin, ALL_TASK_IDS, loadManualWorlds()), unlockedDepth: 0 }];
  // The chain exists (the origin needs its home) but its door does not stand
  // open: the hall starts fully sealed, the first unsealing the player's own.
  meta.doorsUnsealed = 0;
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
        onSelect: opts.onCardClick ? () => opts.onCardClick!(c) : undefined,
      }));
    }
    hand.appendChild(row);
  }
  // Scrolled stage content must be able to clear the hand.
  const stage = document.getElementById('card-stage');
  if (stage) stage.style.paddingBottom = hand.offsetHeight > 0 ? `${hand.offsetHeight + 8}px` : '';
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

// How long a fresh seal takes to set after each unsealing — the hub's next
// door spends this long counting down before it can be opened.
const UNSEAL_COOLDOWN_MS = 90_000;

// ─── The hall of doors ───────────────────────────────────────────────
// The realm's base level: every starter door the player has unsealed, side
// by side, each opening onto its own endless chain of salons (common
// threshold → uncommon salons → rare exchanges). The hall STARTS with every
// door shut — even the first unsealing is the player's own act. One more
// door always waits sealed at the end of the row; click it and it swings
// open IN PLACE (no key, no walking through — entering is a deliberate
// second click), while the seal re-forms one door along and starts its
// countdown. Each open door wears its chain's progress — a run of pips, one
// per level climbed, coloured by that salon's tier, with the deepest level
// beneath — so how far each path has been explored reads at a glance. The
// row wraps and the stage scrolls, so the hall keeps working however many
// doors the player collects.
function showHub(meta: CardMeta): void {
  const stage = realmEl('card-stage');
  clearSpeech();
  stage.innerHTML = '';
  stage.className = 'gathering-view hub-view';
  currentGathering = null;

  const branches = ensureHall(meta);
  const unsealed = meta.doorsUnsealed ?? branches.length;
  // Guard for a truncated saved meta: every unsealed door owns a branch.
  while (branches.length < unsealed) branches.push({ events: [], unlockedDepth: 0 });

  const doorCountLine = (n: number): string => `${n} ${n === 1 ? 'door' : 'doors'} unsealed`;
  const head = div('ct-gathering-head');
  const counter = div('ct-level', doorCountLine(unsealed));
  head.appendChild(counter);
  head.appendChild(div('ct-event-title', 'the hall of doors'));
  stage.appendChild(head);

  const row = div('ct-hub-doors');
  stage.appendChild(row);

  let hubBusy = false;   // latched through the unseal beat so clicks can't double-fire
  const enterBranch = (b: number): void => {
    swapView(() => showGathering(meta, salonAt(meta, b, 0)));
  };

  const buildOpenDoor = (b: number): HTMLElement => {
    const deepest = branches[b]?.unlockedDepth ?? 0;
    const door = div(`ct-door ct-hub-door open t-${salonTierForDepth(deepest)}`);
    door.appendChild(div('ct-door-glyph'));
    // The chain's progress, worn on the door: one pip per level climbed,
    // coloured by that salon's tier, capped with an ellipsis for the truly
    // deep runs (the level line below always carries the exact figure).
    const pips = div('ct-hub-pips');
    const shown = Math.min(deepest + 1, 12);
    for (let d = 0; d < shown; d++) pips.appendChild(div(`ct-pip pip-${salonTierForDepth(d)}`));
    if (deepest + 1 > shown) pips.appendChild(div('ct-pip-more', '…'));
    door.appendChild(pips);
    door.appendChild(div('ct-door-label', pathName(meta.seed ?? 0, b)));
    door.appendChild(div('ct-hub-lvl', `level ${deepest + 1}`));
    door.addEventListener('click', () => {
      if (hubBusy) return;
      realmSound('online', 0.7, 0.9);
      enterBranch(b);
    });
    return door;
  };
  for (let b = 0; b < unsealed; b++) row.appendChild(buildOpenDoor(b));

  // The faint shape at the row's end: the hall goes on for as long as the
  // player keeps unsealing.
  const ghost = div('ct-door ct-hub-door ct-hub-ghost locked');
  ghost.appendChild(div('ct-door-glyph'));

  // The next door, still sealed. A fresh seal takes a while to set: for a
  // spell after each unsealing it only counts the seconds down under itself
  // and rattles if tugged. Unsealing swings it open where it stands — the
  // fresh chain waits for a deliberate click — and the seal re-forms on the
  // next door along, countdown running.
  const buildSealedDoor = (): HTMLElement => {
    const sealed = div('ct-door ct-hub-door ct-hub-sealed locked');
    sealed.appendChild(div('ct-door-glyph'));
    const label = div('ct-door-label', 'unseal');
    sealed.appendChild(label);
    const readyAt = (meta.lastUnsealAt ?? 0) + UNSEAL_COOLDOWN_MS;
    // Clamped both ways so a clock jumped into the future can't hold the
    // door longer than one full cooldown.
    const remaining = (): number => Math.max(0, Math.min(UNSEAL_COOLDOWN_MS, readyAt - Date.now()));
    let timer = 0;
    const syncCooldown = (): void => {
      // The view swapped away — the stage owns fresh DOM now; let go.
      if (!sealed.isConnected && timer) { window.clearInterval(timer); return; }
      const ms = remaining();
      if (ms > 0) {
        sealed.classList.add('cooling');
        label.textContent = String(Math.ceil(ms / 1000));
        return;
      }
      if (timer) { window.clearInterval(timer); timer = 0; }
      if (sealed.classList.contains('cooling')) {
        sealed.classList.remove('cooling');
        label.textContent = 'unseal';
        realmSound('online', 0.35, 0.8);   // the seal settles — ready
      }
    };
    if (remaining() > 0) {
      syncCooldown();
      timer = window.setInterval(syncCooldown, 500);
    }
    let openedAs = -1;   // ≥ 0 once this node has swung open as that branch's door
    sealed.addEventListener('click', () => {
      if (hubBusy) return;
      if (openedAs >= 0) { realmSound('online', 0.7, 0.9); enterBranch(openedAs); return; }
      if (remaining() > 0) {
        realmSound('door_locked', 0.95, 1);
        sealed.classList.remove('shake');
        void sealed.offsetWidth;             // restart the shake animation
        sealed.classList.add('shake');
        // The floaty explainer: this one just needs time.
        const float = div('ct-door-float hint', `wait ${Math.ceil(remaining() / 1000)}s`);
        sealed.appendChild(float);
        float.addEventListener('animationend', () => float.remove());
        return;
      }
      hubBusy = true;
      const b = meta.doorsUnsealed ?? branches.length;
      while (branches.length <= b) branches.push({ events: [], unlockedDepth: 0 });
      meta.doorsUnsealed = b + 1;
      meta.lastUnsealAt = Date.now();
      saveMeta(meta);
      // The same beat of payoff as a salon door: the seal gives with a
      // ka-chunk, the padlock tumbles, the doorway blooms (CSS .unlocking) —
      // but nobody walks through. The door settles open where it stands.
      sealed.classList.remove('locked');
      sealed.classList.add('open', 'unlocking');
      label.textContent = pathName(meta.seed ?? 0, b);
      realmSound('click', 0.8, 0.7);                                          // the seal turns
      window.setTimeout(() => realmSound('place', 1.1, 0.7), 110);            // the bolt drops — clunk
      window.setTimeout(() => realmSound('task_complete', 0.85, 0.95), 300);  // it gives; light spills
      window.setTimeout(() => {
        // Settled open: this node becomes the branch's door (pips, level,
        // enter-on-click), and the seal re-forms one door along with its
        // countdown already running off the stamp above.
        openedAs = b;
        sealed.classList.remove('unlocking', 'ct-hub-sealed');
        sealed.classList.add('t-common');
        const pips = div('ct-hub-pips');
        pips.appendChild(div('ct-pip pip-common'));
        sealed.insertBefore(pips, label);
        sealed.appendChild(div('ct-hub-lvl', 'level 1'));
        counter.textContent = doorCountLine(b + 1);
        row.insertBefore(buildSealedDoor(), ghost);
        hubBusy = false;
      }, 1000);
    });
    return sealed;
  };
  row.appendChild(buildSealedDoor());
  row.appendChild(ghost);

  // The player's hand, inline at the foot of the hall like in a gathering —
  // nothing to select here, but every world can still be entered.
  const handWrap = div('ct-hand-inline');
  stage.appendChild(handWrap);
  if (meta.cards.length > 0) {
    handWrap.appendChild(div('ct-caption', meta.cards.length === 1 ? 'your world' : 'your worlds'));
    const cardsRow = div('ct-cards');
    for (const c of meta.cards) {
      cardsRow.appendChild(handCardEl(c, {
        onEnter: (cardEl) => { void enterWorld(meta, c, cardEl); },
      }));
    }
    handWrap.appendChild(cardsRow);
  }
}

function showGathering(meta: CardMeta, ev: TradeEvent): void {
  const stage = realmEl('card-stage');
  clearSpeech();
  stage.innerHTML = '';
  stage.className = 'gathering-view';

  const branch = ev.branch ?? 0;
  const branches = ensureHall(meta);
  const branchState = branches[branch] ?? branches[0];

  // Swap to another salon on this branch (via a door — the forward door up,
  // or the back door down). The target salon is rolled the first time it's
  // reached.
  const goToSalon = (depth: number): void => {
    const target = salonAt(meta, branch, depth);
    swapView(() => showGathering(meta, target));
  };

  // Remember which salon is on screen, so the dev cog's "refresh current
  // traders" knows which one to re-roll.
  currentGathering = { branch, depth: ev.depth };

  const head = div('ct-gathering-head');
  // The salon's name, flanked by ornaments (CSS), with where-you-are above it
  // (which door in the hall, and the level — one per door climbed, depth + 1)
  // and a soft subtitle beneath — the realm's own "TRADE / select cards"
  // masthead. (Navigation between salons is the pair of doors, added below,
  // not a header button.)
  head.appendChild(div('ct-level', `door ${branch + 1} · level ${ev.depth + 1}`));
  head.appendChild(div(`ct-event-title t-${ev.tier}`, ev.name));
  head.appendChild(div('ct-gathering-sub', 'offer your worlds to the entities'));
  stage.appendChild(head);

  const row = div('ct-stalls');
  stage.appendChild(row);

  // The one selection shared across every stall, toggled from the hand.
  const pickedMine = new Set<number>();
  const minePicked = (): WorldCard[] => meta.cards.filter((c) => pickedMine.has(c.id));

  // While nothing is picked the per-stall confirm buttons are all inert, so
  // instead of a row of greyed buttons we show one big prompt floating in the
  // gap between the traders and the hand. It's a stage child (not inside the
  // stalls) so it centres in that gap; refreshButtons toggles it via the
  // stage's `choosing` class.
  const tradePrompt = div('ct-trade-prompt', 'select your cards to trade');
  stage.appendChild(tradePrompt);

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

  // Never let a trade strip the player of every actual world (the rule lives
  // DOM-free in cards-core so the beatability test exercises the real thing).
  const keepsAWorld = (cr: Creature, given: WorldCard[]): boolean =>
    tradeKeepsAWorld(meta.cards, given, cr.deck);

  // What a trader says for the current selection:
  //  - nothing / too few picked → its want, restated
  //  - more cards than it asked  → "too many cards."
  //  - the right count, wrong worlds → "no."
  //  - a match it will take → "yes!"; a match that would leave you with no
  //    world at all (the gatekeeper's key for your last world) → it refuses
  const lineFor = (cr: Creature): WantSeg[] => {
    if (cr.deck.length === 0) return [{ t: 'traded out. it is content.' }];
    const picked = minePicked();
    if (picked.length > cr.want.count) return [{ t: 'too many cards.' }];
    if (picked.length === cr.want.count) {
      if (!wantSatisfiedBy(cr.want, picked)) return [{ t: 'no.' }];
      if (!keepsAWorld(cr, picked)) return [{ t: 'keep a world for yourself.' }];
      return [{ t: 'yes!' }];
    }
    return wantSegments(cr.want);
  };

  // Each trader carries its OWN "confirm trade" button (built in buildStalls),
  // greyed until the current pick satisfies THAT trader's want — so when more
  // than one trader would accept the same cards, the player chooses who to
  // trade with by pressing that trader's button. This drives every button (and
  // a matching-entity highlight), fades the prompt, and outlines the picked
  // hand cards.
  const refreshButtons = (): void => {
    const picked = minePicked();
    for (const cr of ev.creatures) {
      const ready = cr.deck.length > 0 && !tradeAnimating
        && wantSatisfiedBy(cr.want, picked) && keepsAWorld(cr, picked);
      (row.querySelector(`[data-creature-id="${cr.id}"]`) as HTMLElement | null)
        ?.classList.toggle('matches', ready);
      const ref = stalls.get(cr.id);
      if (ref?.giveBtn) {
        ref.giveBtn.classList.toggle('ok', ready);
        ref.giveBtn.disabled = !ready;
      }
    }
    // Nothing picked → hide the inert confirm buttons and float the big prompt
    // in the gap instead. The trader cards are top-anchored, so the buttons
    // reappearing on the first pick doesn't shove them around.
    stage.classList.toggle('choosing', picked.length === 0);
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

  // The exchange, in motion — one continuous gesture with no layout snaps:
  //  - the given cards LIFT out of the hand into fixed-position flight
  //    (reparented to <body>, so their painted canvases ride along) and rise
  //    to the trader, while the hand row closes the gaps under them with a
  //    FLIP slide instead of snapping shut;
  //  - the trader's whole deck lifts into flight the same way and glides down
  //    onto the EXACT spots where those cards will live in the hand
  //    (invisible placeholders, appended up front, hold the spots), each one
  //    revealing with a tier flash the moment its flight lands on it;
  //  - the stall, emptied mid-air, eases into its spent dimming while its
  //    card box folds shut and the confirm button fades.
  // Only after the last landing does the trade commit to the meta — by then
  // the DOM is already correct, so nothing re-renders or flashes.
  const executeTrade = (cr: Creature): void => {
    if (tradeAnimating) return;
    const picked = minePicked();
    if (!wantSatisfiedBy(cr.want, picked)) return;
    if (!keepsAWorld(cr, picked)) return;   // never empty the hand of worlds
    const received = cr.deck;
    const stallEl = row.querySelector(`[data-creature-id="${cr.id}"]`) as HTMLElement | null;
    const handRow = gatherHandRow();
    const wonOrigin = received.some((t) => t.origin);

    // The books — shared by the animated path and the degraded fallback.
    const commit = (): void => {
      tradeAnimating = false;
      meta.cards = meta.cards.filter((c) => !pickedMine.has(c.id));
      meta.cards.push(...received);
      cr.deck = [];
      pickedMine.clear();
      saveMeta(meta);
      const ref = stalls.get(cr.id);
      if (stallEl) {
        stallEl.classList.add('spent');
        stallEl.classList.remove('spending');
        // The fold + fades finished under .spending; make their end states
        // structural so dropping the class can't blink anything back.
        const box = stallEl.querySelector('.ct-stall-cards') as HTMLElement | null;
        if (box) { box.innerHTML = ''; box.style.height = ''; box.style.transition = ''; box.style.overflow = ''; }
        stallEl.querySelector('.ct-offers-label')?.remove();
        ref?.giveBtn?.remove();
        if (ref) ref.giveBtn = null;
      }
      refreshHandCaption();
      // Selection is cleared — every stall re-states (the traded one now reads
      // "traded out", the rest revert to their want, dropping any "yes!"/"no.").
      restateAll();
      refreshButtons();
      realmSound(wonOrigin ? 'task_complete' : 'ritual', wonOrigin ? 0.9 : 1, wonOrigin ? 1 : 0.9);
    };

    tradeAnimating = true;
    refreshButtons();

    // Degraded path (the row rebuilt mid-interaction): no motion, just the swap.
    if (!stallEl || !handRow) {
      window.setTimeout(() => { commit(); renderGatherHand(); }, 200);
      return;
    }

    realmSound('select', 0.9, 0.8);

    // Geometry read before anything moves.
    const stallBox = stallEl.querySelector('.ct-stall-cards') as HTMLElement | null;
    const stallRect = (stallBox ?? stallEl).getBoundingClientRect();
    const boxHeight = stallBox?.getBoundingClientRect().height ?? 0;
    const before = new Map<HTMLElement, DOMRect>();
    for (const el of [...handRow.children] as HTMLElement[]) before.set(el, el.getBoundingClientRect());

    // Lift a card out of the layout into fixed-position flight at its exact
    // current spot. Returns where it stood.
    const lift = (el: HTMLElement): DOMRect => {
      const r = el.getBoundingClientRect();
      el.classList.remove('selected');
      el.style.transition = 'none';
      el.style.transform = '';
      el.style.position = 'fixed';
      el.style.left = `${r.left}px`;
      el.style.top = `${r.top}px`;
      el.style.width = `${r.width}px`;
      el.style.height = `${r.height}px`;
      el.style.margin = '0';
      // Above the realm (100001, appended later in the body), below the hop
      // white (100002) — the flight must never cover a dive already leaving.
      el.style.zIndex = '100001';
      el.style.pointerEvents = 'none';
      document.body.appendChild(el);
      return r;
    };
    // Send a lifted card so its centre lands on the target's centre, scaled
    // to the destination's width.
    const flight = (el: HTMLElement, from: DOMRect, to: DOMRect,
      o: { delay: number; dur: number; ease: string; scale?: number; rot?: number; fadeOut?: boolean }): void => {
      const dx = (to.left + to.width / 2) - (from.left + from.width / 2);
      const dy = (to.top + to.height / 2) - (from.top + from.height / 2);
      const scale = o.scale ?? (from.width > 0 ? to.width / from.width : 1);
      el.style.transition = `transform ${o.dur}ms ${o.ease} ${o.delay}ms`
        + (o.fadeOut ? `, opacity ${Math.round(o.dur * 0.7)}ms ease ${o.delay + Math.round(o.dur * 0.3)}ms` : '');
      void el.offsetWidth;   // commit the lifted start before the flight transition arms
      el.style.transform = `translate(${dx}px, ${dy}px) rotate(${o.rot ?? 0}deg) scale(${scale})`;
      if (o.fadeOut) el.style.opacity = '0';
    };

    // The given cards rise to the trader and shrink away into its stall.
    for (const m of picked) {
      const el = handRow.querySelector(`[data-card-id="${m.id}"]`) as HTMLElement | null;
      if (!el) continue;
      const from = lift(el);
      // The node leaves the game with the trader — never let the hand cache
      // hand its flown, fixed-position styles to a future rebuild.
      handCardCache.delete(m.id);
      flight(el, from, stallRect, { delay: 0, dur: 560, ease: 'cubic-bezier(0.55, 0, 0.8, 0.45)', scale: 0.55, rot: 5, fadeOut: true });
      window.setTimeout(() => el.remove(), 700);
    }

    // The received cards lift out of the stall, each aimed at the invisible
    // placeholder now holding its future spot in the hand.
    const arrivals: { el: HTMLElement | null; from: DOMRect | null; slot: HTMLElement }[] = [];
    for (const t of received) {
      const src = stallEl.querySelector(`[data-card-id="${t.id}"]`) as HTMLElement | null;
      const slot = buildHandCard(t);
      slot.classList.add('trade-slot');
      handRow.appendChild(slot);
      arrivals.push(src ? { el: src, from: lift(src), slot } : { el: null, from: null, slot });
    }

    // The stall dims toward spent and its emptied card box folds shut.
    stallEl.classList.add('spending');
    if (stallBox) {
      stallBox.style.height = `${boxHeight}px`;
      stallBox.style.overflow = 'hidden';
      void stallBox.offsetWidth;
      stallBox.style.transition = 'height 460ms cubic-bezier(0.3, 0.6, 0.3, 1) 200ms';
      stallBox.style.height = '0px';
    }

    // FLIP the hand row: everything that survived slides into its new place.
    for (const el of [...handRow.children] as HTMLElement[]) {
      const a = before.get(el);
      if (!a) continue;   // a fresh placeholder — it reveals on landing instead
      const b = el.getBoundingClientRect();
      const dx = a.left - b.left, dy = a.top - b.top;
      if (!dx && !dy) continue;
      el.style.transition = 'none';
      el.style.transform = `translate(${dx}px, ${dy}px)`;
    }
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        for (const el of [...handRow.children] as HTMLElement[]) {
          if (!before.has(el) || !el.style.transform) continue;
          el.style.transition = 'transform 380ms cubic-bezier(0.25, 0.7, 0.3, 1)';
          el.style.transform = '';
          window.setTimeout(() => { el.style.transition = ''; }, 430);
        }
      });
    });

    // Launch the arrivals with a soft stagger; each lands with a tier flash
    // and a little thunk exactly where its flight ends.
    let lastLanding = 0;
    arrivals.forEach((a, i) => {
      const delay = 90 + i * 90;
      const landAt = delay + 620;
      lastLanding = Math.max(lastLanding, landAt);
      const reveal = (): void => {
        a.slot.classList.remove('trade-slot');
        a.slot.classList.add('trade-landed');
        realmSound('place', 0.4, 0.85 + i * 0.06);
      };
      if (!a.el || !a.from) { window.setTimeout(reveal, landAt); return; }
      flight(a.el, a.from, a.slot.getBoundingClientRect(), { delay, dur: 620, ease: 'cubic-bezier(0.22, 0.75, 0.25, 1)' });
      const el = a.el;
      window.setTimeout(() => { reveal(); el.remove(); }, landAt);
    });

    window.setTimeout(commit, Math.max(720, lastLanding + 60));
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

  // One held card's element (reused across views via the hand cache): its
  // SELECT button toggles the shared selection, ENTER dives.
  const buildHandCard = (c: WorldCard): HTMLElement =>
    handCardEl(c, {
      onEnter: (cardEl) => { void enterWorld(meta, c, cardEl); },
      onSelect: () => onMineClick(c),
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
    // Frame header: a "your worlds" caption, then the cards — the screenshot's
    // titled "YOUR CARDS" tray. (The "select your cards" call lives up in the
    // trade band now, not here.)
    if (meta.cards.length > 0) {
      handWrap.appendChild(div('ct-caption', meta.cards.length === 1 ? 'your world' : 'your worlds'));
    }
    if (meta.cards.length > 0) {
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
      // The entity, top to bottom: its glowing avatar, its name, the want it
      // types out, an "offers" divider, then its deck face-up.
      stall.appendChild(creatureAvatar());
      stall.appendChild(div('ct-creature-name', cr.name));
      const lineEl = div('ct-creature-line');
      stall.appendChild(lineEl);
      if (!spent) stall.appendChild(div('ct-offers-label', 'offers'));

      const cards = div('ct-stall-cards');
      for (const tc of cr.deck) {
        const el = buildCardEl(tc, {
          enterLabel: 'INSPECT',
          onEnter: (cardEl) => { if (!tradeAnimating) void spectateWorld(tc, cardEl); },
        });
        cards.appendChild(el);
      }
      stall.appendChild(cards);

      // This trader's own CONFIRM TRADE button — greyed until the pick
      // satisfies its want, then a lit green primary. One per trader, so the
      // player picks who to trade with when several would accept the cards.
      let giveBtn: HTMLButtonElement | null = null;
      if (!spent) {
        giveBtn = document.createElement('button');
        giveBtn.type = 'button';
        giveBtn.className = 'ct-confirm';
        giveBtn.disabled = true;
        giveBtn.append(div('ct-confirm-label', 'confirm trade'));
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

  // The forward door: the locked door UP to the NEXT salon on this branch,
  // pinned top-right. Trade the gatekeeper for this salon's key, then click
  // the door to spend it and pass onward; without the key it just rattles.
  // Once spent the door stays open (the branch's unlockedDepth). Every chain
  // is endless — there's always a next.
  const above = ev.depth + 1;
  {
    const isOpen = (): boolean => branchState.unlockedDepth >= above;
    const door = div('ct-door ct-door-fwd');
    door.appendChild(div('ct-door-glyph'));
    const label = div('ct-door-label');
    door.appendChild(label);
    const sync = (): void => {
      door.classList.toggle('open', isOpen());
      door.classList.toggle('locked', !isOpen());
      // An open door names where it leads; a locked one stays bare (it doesn't
      // give the next salon's name away until you've opened it).
      label.textContent = isOpen() ? `${salonName(meta.seed ?? 0, above, branch)} →` : '';
    };
    sync();
    let doorBusy = false;   // latched through the unlock beat so clicks can't double-fire
    door.addEventListener('click', () => {
      if (tradeAnimating || doorBusy) return;
      if (isOpen()) { realmSound('online', 0.7, 0.9); goToSalon(above); return; }
      // Spend this salon's key (its keyDepth + keyBranch open this one door,
      // no other — legacy keys with no branch stamp belong to branch 0).
      const keyIdx = meta.cards.findIndex((c) => c.key && c.keyDepth === above && (c.keyBranch ?? 0) === branch);
      if (keyIdx >= 0) {
        doorBusy = true;
        meta.cards.splice(keyIdx, 1);
        branchState.unlockedDepth = Math.max(branchState.unlockedDepth, above);
        saveMeta(meta);
        // A beat of payoff before we pass through: the key turns with a
        // ka-chunk, the padlock springs and tumbles off, the doorway blooms
        // with light (CSS .unlocking), then the door swings us onward.
        door.classList.remove('locked');
        door.classList.add('open', 'unlocking');
        label.textContent = `${salonName(meta.seed ?? 0, above, branch)} →`;
        realmSound('click', 0.8, 0.7);                                          // the key turns
        window.setTimeout(() => realmSound('place', 1.1, 0.7), 110);            // the bolt drops — clunk
        window.setTimeout(() => realmSound('task_complete', 0.85, 0.95), 300);  // it gives; light spills
        window.setTimeout(() => { realmSound('online', 0.7, 0.7); goToSalon(above); }, 740); // swing through
      } else {
        realmSound('door_locked', 0.95, 1);
        door.classList.remove('shake');
        void door.offsetWidth;             // restart the shake animation
        door.classList.add('shake');
        // A transient explainer that floats up and fades — what the door
        // actually needs, rather than a bare "locked". (The gatekeeper always
        // holds this salon's key until it's traded for; a traded key opens
        // the door on the spot, so a locked door means the key is still his.)
        const float = div('ct-door-float hint', 'the gatekeeper holds the key');
        door.appendChild(float);
        float.addEventListener('animationend', () => float.remove());
      }
    });
    stage.appendChild(door);
  }

  // The back door: a black door pinned top-LEFT, the way DOWN — to the
  // previous salon on this branch, or, from a threshold (depth 0), back out
  // into the hall of doors. Stepping back is free — no key, always open.
  {
    const back = div('ct-door ct-door-back');
    back.appendChild(div('ct-door-glyph'));
    const label = div('ct-door-label');
    label.textContent = ev.depth > 0
      ? `← ${salonName(meta.seed ?? 0, ev.depth - 1, branch)}`
      : '← the hall of doors';
    back.appendChild(label);
    back.addEventListener('click', () => {
      if (tradeAnimating) return;
      realmSound('online', 0.7, 0.8);
      if (ev.depth > 0) goToSalon(ev.depth - 1);
      else swapView(() => showHub(meta));
    });
    stage.appendChild(back);
  }

  // The reset sigil. Standing in branch 0's level-3 dead end introduces it;
  // from then on it hangs in every salon, unexplained. Two clicks — one arms
  // it ("sure?"), the next seals the hall back to a single door with every
  // salon refreshed and every door locked again. The hand is kept; the first
  // reset is also what flips the salons from the authored opening to
  // procedural.
  if (branch === 0 && ev.depth >= HARDCODED_LEVELS - 1 && (meta.resets ?? 0) === 0 && !meta.resetSeen) {
    meta.resetSeen = true;
    saveMeta(meta);
  }
  if (meta.resetSeen || (meta.resets ?? 0) > 0) {
    const sigil = div('ct-reset');
    sigil.appendChild(div('ct-reset-glyph', '⟲'));
    const label = div('ct-door-label', 'begin again');
    sigil.appendChild(label);
    let armed = false;
    let disarm = 0;
    sigil.addEventListener('click', () => {
      if (tradeAnimating) return;
      if (!armed) {
        armed = true;
        sigil.classList.add('arming');
        label.textContent = 'sure?';
        realmSound('click', 0.7, 0.8);
        disarm = window.setTimeout(() => {
          armed = false;
          sigil.classList.remove('arming');
          label.textContent = 'begin again';
        }, 3500);
        return;
      }
      window.clearTimeout(disarm);
      realmSound('ritual', 1, 0.8);
      resetChain(meta, ALL_TASK_IDS, loadManualWorlds());
      saveMeta(meta);
      swapView(() => showHub(meta));
    });
    stage.appendChild(sigil);
  }

  renderGatherHand();
  buildStalls();
}
