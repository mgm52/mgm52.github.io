// ─── The trading-card realm ──────────────────────────────────────────
// The game's final section, picking up after the finale's screen has torn
// itself white. Every game world is now a trading card: three stacked
// preview panes (space / earth / hell), the world's resources, and a
// REENTER WORLD button. The player's own pre-Gabbonsaw save is dealt onto
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

import * as devalue from 'devalue';
import { compressToUTF16, decompressFromUTF16 } from 'lz-string';
import { playSound } from './audio';
import {
  BUILDING_DEFS, BuildingKind, CELL, HELL, SPACE, WORLD,
} from './config';
import { getRawSave, saveGame, setRawSave } from './save';
import {
  Building, Cell, GameState, Goblin, SpaceBuilding,
  buildingAtCell, cellCenter, cellKey, computePlayBounds, createInitialState,
  digDirection, isInPlayCell, markBuildingsChanged, nextBuildingDisplayNum,
  occupyCell, recordGhost, removeGoblin, waterSourceAtCell,
} from './state';
import { ALL_TASK_IDS } from './ui';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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

export type CardTier = 'common' | 'uncommon' | 'rare';
const TIER_RANK: Record<CardTier, number> = { common: 0, uncommon: 1, rare: 2 };
const TIER_ABOVE: Record<CardTier, CardTier | null> = { common: 'uncommon', uncommon: 'rare', rare: null };

// What a card demands before it can ascend to the next tier: hold this much
// of one resource inside its world. Different per card — part of a card's
// identity, and the reason to trade sideways for one whose demand suits the
// world you can actually grow. Null once the card is rare (top tier).
export type UpgradeReq = { res: 'money' | 'blood' | 'dragonBone'; amount: number };

export type WorldCard = {
  id: number;
  name: string;
  tier: CardTier;
  // The world itself: compressToUTF16(devalue.stringify(GameState)). Updated
  // each time the player leaves the world.
  data: string;
  // Headline numbers written on the card; refreshed alongside `data`.
  resources: { money: number; blood: number; dragonBone: number };
  // Ascension demand for the next tier (see UpgradeReq). Null at rare.
  upgradeReq?: UpgradeReq | null;
  // The player's own stolen pre-finale world — winnable back at gathering III.
  origin?: boolean;
};

// What a creature looks for in a card. Cards that match are the ones it's
// "open to trading for"; everything else greys out.
type Appetite = 'any' | 'blood' | 'rich' | 'bones';
const APPETITE_LINE: Record<Appetite, string> = {
  any: 'i will consider any world.',
  blood: 'i want worlds with blood in them.',
  rich: 'i want wealthy worlds.',
  bones: 'i want worlds that keep bones.',
};
function appetiteAccepts(a: Appetite, card: WorldCard): boolean {
  if (a === 'any') return true;
  if (a === 'blood') return card.resources.blood >= 1;
  if (a === 'rich') return card.resources.money >= 1000;
  return card.resources.dragonBone >= 1;
}

type Creature = { id: number; name: string; appetite: Appetite; deck: WorldCard[] };
// Each gathering trades one tier only — creatures there hold cards of that
// tier and accept cards of that tier. Entry needs a card of the tier in hand.
// `gifted` records the one-time welcome gift handed over on first attendance
// (it's how the collection grows past a single card — trades are always 1:1).
type TradeEvent = { id: number; name: string; tier: CardTier; creatures: Creature[]; gifted?: boolean };

type CardMeta = {
  v: 1;
  // 'intro' until the white goblin has run the forced first trade.
  phase: 'intro' | 'free';
  nextId: number;
  cards: WorldCard[];
  // Generated once, after the intro (so the stolen origin card can be seeded
  // into gathering III's deck). Null until then.
  events: TradeEvent[] | null;
  // Card the player is currently inside (boot resumes into it). Null on the table.
  activeCardId: number | null;
};

function loadMeta(): CardMeta | null {
  try {
    const raw = localStorage.getItem(META_KEY);
    if (!raw) return null;
    const m = JSON.parse(raw) as CardMeta;
    if (!m || m.v !== 1 || !Array.isArray(m.cards)) return null;
    return m;
  } catch { return null; }
}

function saveMeta(meta: CardMeta): void {
  try { localStorage.setItem(META_KEY, JSON.stringify(meta)); } catch { /* storage full — skip */ }
}

export function hasCardMeta(): boolean { return loadMeta() !== null; }

// Set just before the enter-/leave-world reloads so the next boot knows it's
// an explicit transition (skip the title screen) rather than a cold load.
// The module flag guards the gap between writing the destination save and
// the reload actually landing: main.ts's pagehide/visibility flushes would
// otherwise clobber the freshly-written slot with the departing world.
const HOP_KEY = 'rts.cardhop';
let hopInProgress = false;
export function isCardHopInProgress(): boolean { return hopInProgress; }
function markCardHop(): void {
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

export function cardWorldActive(): boolean {
  const m = loadMeta();
  return m !== null && m.activeCardId !== null;
}

// Wipe the whole metagame — wired into the title screen's Erase Data.
export function clearCardData(): void {
  try {
    localStorage.removeItem(META_KEY);
    localStorage.removeItem(ORIGIN_KEY);
    localStorage.removeItem(OUTER_KEY);
  } catch { /* no-op */ }
}

// ─── World (de)serialization ─────────────────────────────────────────
function encodeWorld(st: GameState): string {
  return compressToUTF16(devalue.stringify(st));
}

function decodeWorld(data: string): GameState | null {
  try {
    const raw = decompressFromUTF16(data);
    if (!raw) return null;
    return devalue.parse(raw) as GameState;
  } catch { return null; }
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
      resources: { money: state.money, blood: state.blood, dragonBone: state.dragonBone },
    };
    localStorage.setItem(ORIGIN_KEY, JSON.stringify(payload));
  } catch { /* storage full — the realm falls back to a generated origin */ }
}

// ─── Seeded RNG + names ──────────────────────────────────────────────
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NAME_A = ['damp', 'hollow', 'sour', 'quiet', 'crooked', 'borrowed', 'backwards', 'gilded', 'sunless', 'plain', 'molten', 'patient', 'little', 'wet', 'forgotten', 'humming'];
const NAME_B = ['shelf', 'parish', 'meadow', 'engine', 'marsh', 'orchard', 'furnace', 'colony', 'yard', 'kingdom', 'hum', 'garden', 'ditch', 'plot', 'acre', 'corner'];
function worldName(rng: () => number): string {
  const a = NAME_A[Math.floor(rng() * NAME_A.length)];
  const b = NAME_B[Math.floor(rng() * NAME_B.length)];
  return `the ${a} ${b}`;
}

const CREATURE_NAMES = ['the pale one', 'tall friend', 'the collector', 'wet sister', 'the magistrate', 'kind uncle', 'little echo', 'the porcelain man'];

// ─── Weird-world generation ──────────────────────────────────────────
// Every non-origin card wraps a procedurally mutated fresh state: dug arms,
// scattered dormant buildings, idle goblins, ghosts in hell, sometimes space
// debris — and no Bob, no Lolly, no demons. All tasks arrive pre-completed
// (ALL_TASK_IDS) so a card world never replays the tutorial celebrations.

function footprintFree(st: GameState, tl: Cell, n: number): boolean {
  for (let dy = 0; dy < n; dy++) {
    for (let dx = 0; dx < n; dx++) {
      const cx = tl.cx + dx, cy = tl.cy + dy;
      if (!isInPlayCell(st, cx, cy)) return false;
      if (buildingAtCell(st, cx, cy)) return false;
      if (waterSourceAtCell(st, { cx, cy })) return false;
      if (st.occupancy.has(cellKey(cx, cy))) return false;
      // Keep a small berth around the spawning hole.
      if (Math.abs(cx - st.hole.cell.cx) <= 1 && Math.abs(cy - st.hole.cell.cy) <= 1) return false;
    }
  }
  return true;
}

function tryPlaceBuilding(st: GameState, kind: BuildingKind, rng: () => number): Building | null {
  const def = BUILDING_DEFS[kind];
  const b = computePlayBounds(st);
  for (let attempt = 0; attempt < 40; attempt++) {
    const tl: Cell = {
      cx: b.x0 + Math.floor(rng() * Math.max(1, b.x1 - b.x0 - def.cellSize)),
      cy: b.y0 + Math.floor(rng() * Math.max(1, b.y1 - b.y0 - def.cellSize)),
    };
    if (!footprintFree(st, tl, def.cellSize)) continue;
    const bld: Building = {
      id: st.nextId++,
      displayNum: nextBuildingDisplayNum(st, kind),
      kind,
      cell: tl,
      state: kind === 'wall' ? 'active' : 'dormant',
      buildProgress: 1,
      assignedGoblins: [],
      selected: false,
    };
    if (kind === 'hell_portal') bld.activatedAt = 0;
    st.buildings.set(bld.id, bld);
    markBuildingsChanged(st);
    return bld;
  }
  return null;
}

function tryPlaceGoblin(st: GameState, rng: () => number, opts: { gold?: boolean; robot?: boolean } = {}): void {
  const b = computePlayBounds(st);
  for (let attempt = 0; attempt < 40; attempt++) {
    const cx = b.x0 + Math.floor(rng() * (b.x1 - b.x0));
    const cy = b.y0 + Math.floor(rng() * (b.y1 - b.y0));
    if (!footprintFree(st, { cx, cy }, 1)) continue;
    const id = st.nextId++;
    const c: Cell = { cx, cy };
    const g: Goblin = {
      id, pos: cellCenter(c), cell: c, target: null, goal: null,
      path: [], facing: rng() * Math.PI * 2,
      state: { kind: 'idle' }, selected: false, idleSince: null, lastCellChangedAt: 0,
    };
    if (opts.gold) g.gold = true;
    if (opts.robot) g.robot = true;
    st.goblins.set(id, g);
    occupyCell(st, cx, cy, id);
    return;
  }
}

function addSpaceBuilding(st: GameState, kind: BuildingKind, rng: () => number): void {
  const b: Building = {
    id: st.nextId++,
    displayNum: nextBuildingDisplayNum(st, kind),
    kind,
    cell: { cx: 0, cy: 0 },
    state: 'active',
    buildProgress: 1,
    assignedGoblins: [],
    selected: false,
  };
  const sb: SpaceBuilding = {
    id: b.id,
    building: b,
    pos: {
      x: SPACE.margin + rng() * (SPACE.width - 2 * SPACE.margin),
      y: SPACE.margin + rng() * (SPACE.height - 2 * SPACE.margin),
    },
    vel: { x: (rng() - 0.5) * SPACE.driftSpeed, y: (rng() - 0.5) * SPACE.driftSpeed },
    spin: rng() * Math.PI * 2,
    spinRate: (rng() - 0.5) * 0.3,
    selected: false,
  };
  st.spaceBuildings.set(sb.id, sb);
}

const KIND_POOLS: Record<CardTier, BuildingKind[]> = {
  common: ['wall', 'goblin_wheel', 'goblin_wheel', 'phone_farm', 'gas_engine', 'goblin_hole'],
  uncommon: ['wall', 'goblin_wheel', 'phone_farm', 'phone_farm', 'gas_engine', 'goblin_hole', 'datacentre', 'nuclear_reactor'],
  rare: ['goblin_wheel', 'phone_farm', 'gas_engine', 'goblin_hole', 'datacentre', 'datacentre', 'nuclear_reactor', 'hypercentre', 'dragon_beacon', 'hell_portal'],
};

function generateWeirdWorld(seed: number, tier: CardTier): GameState {
  const rng = mulberry32(seed);
  const ri = (a: number, b: number) => a + Math.floor(rng() * (b - a + 1));
  const st = createInitialState();
  st.cardWorld = true;
  st.demons = new Map();
  st.log = [];

  // Dug arms — more of the plus-shape opens up with tier.
  const dirs: ('n' | 'e' | 's' | 'w')[] = ['n', 'e', 's', 'w'];
  for (let i = dirs.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [dirs[i], dirs[j]] = [dirs[j], dirs[i]];
  }
  const digs = tier === 'common' ? ri(0, 1) : tier === 'uncommon' ? ri(1, 3) : ri(2, 4);
  for (const d of dirs.slice(0, digs)) digDirection(st, d);
  st.firstDugAt = 0;

  // Strange resource balances by tier.
  if (tier === 'common') {
    st.money = ri(0, 60);
    st.blood = ri(0, 5);
  } else if (tier === 'uncommon') {
    st.money = ri(400, 30_000);
    st.blood = ri(10, 400);
    st.dragonBone = ri(0, 2);
  } else {
    st.money = ri(100_000, 50_000_000);
    st.blood = ri(1_000, 80_000);
    st.dragonBone = ri(4, 150);
  }
  st.moneyEarned = st.money;
  st.bloodEarned = st.blood;
  st.dragonBoneEarned = st.dragonBone;
  st.bloodUnlocked = st.blood > 0;
  st.dragonBoneUnlocked = st.dragonBone > 0;

  // Scattered, unstaffed buildings — they wake (or stay dormant) under the
  // normal sim rules once the player starts assigning goblins.
  const pool = KIND_POOLS[tier];
  const buildingCount = tier === 'common' ? ri(1, 4) : tier === 'uncommon' ? ri(4, 12) : ri(10, 24);
  for (let i = 0; i < buildingCount; i++) {
    const kind = pool[Math.floor(rng() * pool.length)];
    const placed = tryPlaceBuilding(st, kind, rng);
    if (placed?.kind === 'hell_portal') st.hellUnlocked = true;
  }

  // A few inhabitants.
  const goblinCount = tier === 'common' ? ri(1, 3) : tier === 'uncommon' ? ri(2, 10) : ri(5, 25);
  for (let i = 0; i < goblinCount; i++) {
    tryPlaceGoblin(st, rng, {
      gold: rng() < 0.1,
      robot: tier === 'rare' && rng() < 0.15,
    });
  }
  st.spawnsCompleted = goblinCount;

  // Ghosts already drifting in this world's hell — somebody lived here.
  const ghostCount = tier === 'common' ? ri(0, 4) : tier === 'uncommon' ? ri(2, 12) : ri(6, 40);
  const gb = computePlayBounds(st);
  for (let i = 0; i < ghostCount; i++) {
    const kind = rng() < 0.8 ? 'goblin' : rng() < 0.5 ? 'minotaur' : 'dragon';
    const x = (gb.x0 + rng() * (gb.x1 - gb.x0)) * CELL;
    const y = (gb.y0 + rng() * (gb.y1 - gb.y0)) * CELL;
    recordGhost(st, kind, x, y, rng() * Math.PI * 2, { gold: rng() < 0.08 });
  }

  // Space debris for the richest worlds.
  if (tier === 'rare' && rng() < 0.7) {
    st.spaceUnlocked = true;
    const n = ri(1, 4);
    for (let i = 0; i < n; i++) {
      addSpaceBuilding(st, rng() < 0.6 ? 'orbital_platform' : 'phone_farm', rng);
    }
  }

  // Ritual flags loosen with tier, so richer worlds resume mid-automation.
  if (tier !== 'common') {
    st.autoAssignEnabled = rng() < 0.7;
    st.autoWaterEnabled = st.autoAssignEnabled && rng() < 0.5;
    st.goldgoblinsEnabled = rng() < 0.5;
    st.lightningUnlocked = rng() < 0.6;
  }
  if (tier === 'rare') {
    st.autoAssignEnabled = true;
    st.lightningUnlocked = true;
    st.goldgoblinMultiplier = rng() < 0.3 ? 10 : 1;
    st.tinytaurUnlocked = rng() < 0.4;
    if (rng() < 0.7) {
      const m = [1, 2, 4, 8][ri(0, 3)];
      st.autoSpawnEnabled = true;
      st.autoSpawnMultiplier = m;
      st.autoSpawnLevel = m;
    }
  }

  // Everything is unlocked in the card worlds: all tasks pre-completed (no
  // celebration replays), all onboarding hints pre-seen.
  st.unlocks = {
    completed: new Set(ALL_TASK_IDS),
    revealed: new Set(ALL_TASK_IDS),
    obsoleted: new Set(),
    everBuilt: new Set([...st.buildings.values()].map((b) => b.kind)),
    minotaurEverSummoned: tier !== 'common',
  };
  st.waterSeen = true;
  st.cameraPanSeen = true;
  st.multiSelectSeen = true;
  st.multiSpawnSeen = true;
  st.devSkippedToHell = true; // suppress the fresh-ground onboarding nudges

  sanitizeCardWorld(st);
  return st;
}

// The goblin's replacement for the player's stolen world: an obviously
// pitiful one. A handful of scattered walls, two goblins, Ƶ3.
function generateJunkWorld(seed: number): GameState {
  const rng = mulberry32(seed);
  const st = generateWeirdWorld(seed, 'common');
  st.buildings.clear();
  markBuildingsChanged(st);
  const wallCount = 5 + Math.floor(rng() * 5);
  for (let i = 0; i < wallCount; i++) tryPlaceBuilding(st, 'wall', rng);
  for (const g of [...st.goblins.values()].slice(2)) removeGoblin(st, g.id);
  st.money = 3;
  st.blood = 0;
  st.dragonBone = 0;
  st.moneyEarned = 3;
  st.bloodEarned = 0;
  st.dragonBoneEarned = 0;
  st.bloodUnlocked = false;
  st.dragonBoneUnlocked = false;
  st.ghosts = [];
  // No leftovers from the donor world: walls are the only structures, and
  // neither the hell descent nor space should read as already opened.
  st.spaceBuildings.clear();
  st.hellUnlocked = false;
  st.spaceUnlocked = false;
  st.unlocks!.everBuilt = new Set(['wall']);
  return st;
}

// Strip a world of everything that can't exist inside a card: Bob (alive, in
// space, or as a ghost), Lolly, the demons, and the whole finale machinery.
// gabbonsawBought is forced true so the ritual reads as an owned trophy and
// the finale can never re-trigger from inside a card.
function sanitizeCardWorld(st: GameState): void {
  st.cardWorld = true;
  st.demons = new Map();
  for (const g of [...st.goblins.values()]) if (g.bob) removeGoblin(st, g.id);
  for (const [id, su] of [...st.spaceUnits]) if (su.bob) st.spaceUnits.delete(id);
  st.ghosts = st.ghosts.filter((g) => !g.bob);
  st.lolly = null;
  st.finale = null;
  st.gabbonsawBought = true;
  st.gabbonsawRitualRemaining = null;
  st.gabbonsawCutscenePending = false;
  st.bobSpawned = true;     // the Bob cutscene never re-offers
  st.bobPickingHole = false;
  st.bobCheatPending = false;
  st.bobLollyDeparted = true;
  st.view = 'ground';
}

// ─── Card construction ───────────────────────────────────────────────

// Roll a card's ascension demand for its CURRENT tier. The bands are sized
// so the climb is a real session inside the world but never a wall: a fresh
// common can reach five figures of cash (or a few hundred blood) with basic
// wheels and kills; an uncommon's world starts rich enough that six figures
// (or a blood/bone harvest) is reachable with the mid-game toys.
function rollUpgradeReq(tier: CardTier, rng: () => number): UpgradeReq | null {
  const ri = (a: number, b: number) => a + Math.floor(rng() * (b - a + 1));
  if (tier === 'rare') return null;
  if (tier === 'common') {
    return rng() < 0.6
      ? { res: 'money', amount: ri(5, 15) * 1000 }
      : { res: 'blood', amount: ri(2, 8) * 100 };
  }
  const roll = rng();
  if (roll < 0.5) return { res: 'money', amount: ri(25, 100) * 10_000 };
  if (roll < 0.85) return { res: 'blood', amount: ri(5, 20) * 1000 };
  return { res: 'dragonBone', amount: ri(3, 10) };
}

function reqMet(card: WorldCard): boolean {
  const r = card.upgradeReq;
  return !!r && card.resources[r.res] >= r.amount;
}

// Ascend a card one tier (caller checks reqMet) and roll its next demand.
function ascendCard(meta: CardMeta, card: WorldCard): void {
  const next = TIER_ABOVE[card.tier];
  if (!next) return;
  card.tier = next;
  const rng = mulberry32((card.id * 1103515245 + meta.nextId) >>> 0);
  card.upgradeReq = rollUpgradeReq(next, rng);
  saveMeta(meta);
}

function makeCard(meta: CardMeta, tier: CardTier, rng: () => number, junk = false): WorldCard {
  const seed = Math.floor(rng() * 0xffffffff);
  const st = junk ? generateJunkWorld(seed) : generateWeirdWorld(seed, tier);
  return {
    id: meta.nextId++,
    name: worldName(rng),
    tier,
    data: encodeWorld(st),
    resources: { money: st.money, blood: st.blood, dragonBone: st.dragonBone },
    upgradeReq: rollUpgradeReq(tier, rng),
  };
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
          upgradeReq: null,
          origin: true,
        };
      }
    }
  } catch { /* fall through to the generated stand-in */ }
  const card = makeCard(meta, 'rare', rng);
  card.name = 'your world';
  card.origin = true;
  return card;
}

// ─── The gatherings ──────────────────────────────────────────────────
// One per tier. Trades are strictly same-tier, so the way UP is always a
// card's own ascension demand — gatherings are where you swap a world whose
// demand doesn't suit you for one that does (or, at the rare exchange, win
// your own world back). Every gathering keeps one any-appetite creature so
// the player is never hard-locked; for everything else there's the "wait
// for the next gathering" reshuffle.

const EVENT_NAMES: Record<CardTier, string> = {
  common: 'gathering at the soft border',
  uncommon: 'the uncommon salon',
  rare: 'the rare exchange',
};

let creatureSeq = 1;
function rollCreatures(meta: CardMeta, tier: CardTier, rng: () => number): Creature[] {
  const names = [...CREATURE_NAMES];
  for (let i = names.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [names[i], names[j]] = [names[j], names[i]];
  }
  const appetites: Appetite[] = ['blood', 'rich', 'bones'];
  const mk = (appetite: Appetite): Creature => {
    const deckSize = 2 + Math.floor(rng() * 2);
    const deck: WorldCard[] = [];
    for (let i = 0; i < deckSize; i++) deck.push(makeCard(meta, tier, rng));
    return { id: creatureSeq++, name: names.pop() ?? 'the other one', appetite, deck };
  };
  return [mk('any'), mk(appetites[Math.floor(rng() * appetites.length)])];
}

function generateEvents(meta: CardMeta, stolen: WorldCard | null): TradeEvent[] {
  const rng = mulberry32((meta.nextId * 2654435761) >>> 0);
  const events: TradeEvent[] = (['common', 'uncommon', 'rare'] as CardTier[]).map((tier, i) => ({
    id: i + 1,
    name: EVENT_NAMES[tier],
    tier,
    creatures: rollCreatures(meta, tier, rng),
  }));
  // The stolen origin card waits at the rare exchange, with the creature who
  // will consider anything for it.
  if (stolen) events[2].creatures[0].deck.unshift(stolen);
  return events;
}

// The reshuffle: this gathering ends and the next one of the same tier
// arrives — new creatures, new decks. Whatever the player traded away leaves
// with the departing creatures, except the origin card, which always finds
// its way to the next table.
function regenerateEvent(meta: CardMeta, ev: TradeEvent): void {
  const origin = ev.creatures.flatMap((c) => c.deck).find((c) => c.origin) ?? null;
  const rng = mulberry32((meta.nextId * 48271 + ev.id) >>> 0);
  ev.creatures = rollCreatures(meta, ev.tier, rng);
  if (origin) ev.creatures[0].deck.unshift(origin);
  saveMeta(meta);
}

// ─── Trade rules ─────────────────────────────────────────────────────
// Same tier in, same tier out. A creature is open to trading FOR your card
// when it matches its appetite; the cards it offers (and asks for) are the
// ones of matching tier.
function creatureGivesFor(c: Creature, yours: WorldCard): WorldCard[] {
  return c.deck.filter((d) => d.tier === yours.tier);
}
function creatureTakesFor(c: Creature, theirs: WorldCard, mine: WorldCard[]): WorldCard[] {
  return mine.filter((m) => appetiteAccepts(c.appetite, m) && m.tier === theirs.tier);
}

// ─── Entering / leaving a card world ─────────────────────────────────

function enterWorld(meta: CardMeta, card: WorldCard): void {
  const st = decodeWorld(card.data);
  if (!st) { playSound('error'); return; }
  sanitizeCardWorld(st);
  meta.activeCardId = card.id;
  saveMeta(meta);
  // Stash the outer post-finale save verbatim, then write the card's world
  // into the slot and reload — the regular boot pipeline takes it from here.
  const outer = getRawSave();
  if (outer) {
    try { localStorage.setItem(OUTER_KEY, outer); } catch { /* skip */ }
  }
  saveGame(st);
  playSound('ritual', 1, 0.7);
  markCardHop();
  location.reload();
}

function leaveWorld(state: GameState): void {
  const meta = loadMeta();
  if (!meta || meta.activeCardId === null) return;
  const card = meta.cards.find((c) => c.id === meta.activeCardId);
  if (card) {
    // The card remembers everything the player just did inside it.
    card.data = encodeWorld(state);
    card.resources = { money: state.money, blood: state.blood, dragonBone: state.dragonBone };
  }
  meta.activeCardId = null;
  saveMeta(meta);
  const outer = localStorage.getItem(OUTER_KEY);
  if (outer) {
    setRawSave(outer);
    try { localStorage.removeItem(OUTER_KEY); } catch { /* no-op */ }
  }
  markCardHop();
  location.reload();
}

// Boot fallback: the metagame says we're inside a card but the save slot is
// unreadable. Restore the outer save (if stashed) and clear the active card
// so the player lands back on the table instead of a broken world.
export function abandonCardWorldBoot(): void {
  const meta = loadMeta();
  if (meta) { meta.activeCardId = null; saveMeta(meta); }
  const outer = localStorage.getItem(OUTER_KEY);
  if (outer) {
    setRawSave(outer);
    try { localStorage.removeItem(OUTER_KEY); } catch { /* no-op */ }
  }
}

// Inside a card world: the white screen border (body.card-world) and the big
// white LEAVE WORLD button pinned to the bottom of the screen.
export function setupCardWorldChrome(state: GameState): void {
  document.body.classList.add('card-world');
  const btn = document.getElementById('leave-world-btn') as HTMLButtonElement | null;
  if (!btn) return;
  btn.style.display = '';
  btn.addEventListener('click', () => {
    btn.disabled = true;
    playSound('ritual', 1, 0.7);
    leaveWorld(state);
  }, { once: true });
}

// ─── Card previews ───────────────────────────────────────────────────
// Three stacked minimap panes painted from the card's decoded state: space
// on top, earth in the middle, hell at the bottom — the world as a column.

const decodedCache = new Map<number, { data: string; st: GameState | null }>();
function decodedWorld(card: WorldCard): GameState | null {
  const hit = decodedCache.get(card.id);
  if (hit && hit.data === card.data) return hit.st;
  const st = decodeWorld(card.data);
  decodedCache.set(card.id, { data: card.data, st });
  return st;
}

function hexColor(n: number): string { return `#${n.toString(16).padStart(6, '0')}`; }

function drawSpacePreview(cv: HTMLCanvasElement, st: GameState, seed: number): void {
  const g = cv.getContext('2d');
  if (!g) return;
  const w = cv.width, h = cv.height;
  g.fillStyle = '#05040f';
  g.fillRect(0, 0, w, h);
  const rng = mulberry32(seed);
  for (let i = 0; i < 36; i++) {
    g.globalAlpha = 0.3 + rng() * 0.7;
    g.fillStyle = '#cfd4e8';
    g.fillRect(Math.floor(rng() * w), Math.floor(rng() * h), 1, 1);
  }
  g.globalAlpha = 1;
  for (const sb of st.spaceBuildings.values()) {
    const x = (sb.pos.x / SPACE.width) * w;
    const y = (sb.pos.y / SPACE.height) * h;
    g.fillStyle = sb.building.kind === 'orbital_platform' ? '#6f7480' : hexColor(BUILDING_DEFS[sb.building.kind].colors.active);
    g.fillRect(x - 2, y - 2, 5, 4);
  }
  for (const su of st.spaceUnits.values()) {
    g.fillStyle = su.robot ? '#b9c0c9' : '#7fd183';
    g.fillRect((su.pos.x / SPACE.width) * w, (su.pos.y / SPACE.height) * h, 2, 2);
  }
}

function drawEarthPreview(cv: HTMLCanvasElement, st: GameState): void {
  const g = cv.getContext('2d');
  if (!g) return;
  const w = cv.width, h = cv.height;
  g.fillStyle = '#15130e';
  g.fillRect(0, 0, w, h);
  const b = computePlayBounds(st);
  const bw = b.x1 - b.x0, bh = b.y1 - b.y0;
  const s = Math.min(w / (bw + 2), h / (bh + 2));
  const ox = (w - bw * s) / 2, oy = (h - bh * s) / 2;
  const px = (cx: number) => ox + (cx - b.x0) * s;
  const py = (cy: number) => oy + (cy - b.y0) * s;
  // Ground cells.
  g.fillStyle = '#2e4630';
  for (let cy = b.y0; cy < b.y1; cy++) {
    for (let cx = b.x0; cx < b.x1; cx++) {
      if (isInPlayCell(st, cx, cy)) g.fillRect(px(cx), py(cy), s + 0.5, s + 0.5);
    }
  }
  // Water.
  g.fillStyle = '#2e5f8a';
  for (const ws of st.waterSources.values()) {
    g.fillRect(px(ws.x0), py(ws.y0), (ws.x1 - ws.x0) * s, (ws.y1 - ws.y0) * s);
  }
  // The spawning hole.
  if (!st.holeDestroyed) {
    g.fillStyle = '#0c0c0c';
    g.beginPath();
    g.arc(px(st.hole.cell.cx + 0.5), py(st.hole.cell.cy + 0.5), Math.max(1.2, s * 0.7), 0, Math.PI * 2);
    g.fill();
  }
  // Buildings in their def colors.
  for (const bd of st.buildings.values()) {
    const def = BUILDING_DEFS[bd.kind];
    g.fillStyle = hexColor(bd.state === 'active' ? def.colors.active : def.colors.dormant);
    g.fillRect(px(bd.cell.cx), py(bd.cell.cy), Math.max(1, def.cellSize * s), Math.max(1, def.cellSize * s));
  }
  // Units as dots.
  for (const gob of st.goblins.values()) {
    g.fillStyle = gob.robot ? '#b9c0c9' : gob.gold ? '#ffd96b' : '#7fd183';
    g.fillRect(px(gob.cell.cx) , py(gob.cell.cy), Math.max(1, s * 0.6), Math.max(1, s * 0.6));
  }
}

function drawHellPreview(cv: HTMLCanvasElement, st: GameState, seed: number): void {
  const g = cv.getContext('2d');
  if (!g) return;
  const w = cv.width, h = cv.height;
  g.fillStyle = hexColor(HELL.bgColor);
  g.fillRect(0, 0, w, h);
  const grad = g.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, 'rgba(74, 10, 14, 0)');
  grad.addColorStop(1, 'rgba(74, 10, 14, 0.55)');
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
  // Portal beams, dropped at each portal's relative overworld x.
  g.fillStyle = hexColor(HELL.lineColor);
  for (const bd of st.buildings.values()) {
    if (bd.kind !== 'hell_portal' || bd.state === 'constructing') continue;
    const x = ((bd.cell.cx * CELL) / WORLD.width) * w;
    g.globalAlpha = 0.8;
    g.fillRect(x, 0, 1, h);
  }
  g.globalAlpha = 1;
  // Drifting ghosts.
  const rng = mulberry32(seed ^ 0x9e3779b9);
  for (const gh of st.ghosts) {
    const x = (gh.x / WORLD.width) * w;
    const y = 2 + rng() * (h - 4);
    g.globalAlpha = 0.55 + rng() * 0.35;
    g.fillStyle = gh.gold ? '#ffd96b' : '#cfd5e6';
    g.fillRect(x, y, gh.kind === 'dragon' ? 3 : 2, 2);
  }
  g.globalAlpha = 1;
  // Lit candles.
  g.fillStyle = '#ff9a3d';
  for (const c of st.soulChairs) {
    g.fillRect((c.hx / HELL.width) * w, (c.hy / HELL.height) * h, 2, 2);
  }
}

// ─── Card DOM ────────────────────────────────────────────────────────

function fmtResources(r: WorldCard['resources']): string {
  const parts = [`Ƶ ${Math.floor(r.money).toLocaleString('en-US')}`];
  if (r.blood > 0) parts.push(`${Math.floor(r.blood).toLocaleString('en-US')} blood`);
  if (r.dragonBone > 0) parts.push(`${Math.floor(r.dragonBone).toLocaleString('en-US')} bones`);
  return parts.join(' · ');
}

function fmtReqAmount(r: UpgradeReq): string {
  const amt = r.amount.toLocaleString('en-US');
  return r.res === 'money' ? `Ƶ ${amt}` : r.res === 'blood' ? `${amt} blood` : `${amt} bones`;
}

type CardElOpts = {
  big?: boolean;
  enterLabel?: string;       // when set, the card carries an enter button
  onEnter?: () => void;
  onClick?: () => void;      // whole-card click (trade views)
  onAscend?: () => void;     // table view: shown once the ascension demand is met
};

function buildCardEl(card: WorldCard, opts: CardElOpts = {}): HTMLElement {
  const root = document.createElement('div');
  root.className = `world-card t-${card.tier}${opts.big ? ' big' : ''}`;
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
    cv.width = 168;
    cv.height = hgt;
    panes.appendChild(cv);
    return cv;
  };
  const cvSpace = mkCanvas('wc-space', 34);
  const cvEarth = mkCanvas('wc-earth', 84);
  const cvHell = mkCanvas('wc-hell', 34);
  if (st) {
    drawSpacePreview(cvSpace, st, card.id * 7919 + 17);
    drawEarthPreview(cvEarth, st);
    drawHellPreview(cvHell, st, card.id * 7919 + 17);
  }
  root.appendChild(panes);

  const res = document.createElement('div');
  res.className = 'wc-res';
  res.textContent = fmtResources(card.resources);
  root.appendChild(res);

  // Ascension demand, printed on every card that still has a tier above it.
  if (card.upgradeReq) {
    const met = reqMet(card);
    const req = document.createElement('div');
    req.className = `wc-req${met ? ' met' : ''}`;
    req.textContent = `ascends at ${fmtReqAmount(card.upgradeReq)}`;
    root.appendChild(req);
    if (met && opts.onAscend) {
      const up = document.createElement('button');
      up.type = 'button';
      up.className = 'wc-ascend';
      up.textContent = `ASCEND — ${TIER_ABOVE[card.tier] ?? ''}`;
      up.addEventListener('click', (e) => { e.stopPropagation(); opts.onAscend?.(); });
      root.appendChild(up);
    }
  }

  if (opts.enterLabel) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'wc-enter';
    btn.textContent = opts.enterLabel;
    btn.addEventListener('click', (e) => { e.stopPropagation(); opts.onEnter?.(); });
    root.appendChild(btn);
  }
  if (opts.onClick) {
    root.classList.add('clickable');
    root.addEventListener('click', () => opts.onClick?.());
  }
  return root;
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
  playSound('click', 0.29, 0.9);
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
  playSound('click', 0.8, 1);
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
  const realm = document.getElementById('card-realm');
  if (realm) {
    realm.classList.remove('visible', 'goblin-in', 'speaking', 'click-armed', 'show-choice');
    const stage = document.getElementById('card-stage');
    if (stage) stage.innerHTML = '';
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
  if (!meta) {
    meta = { v: 1, phase: 'intro', nextId: 1, cards: [], events: null, activeCardId: null };
    const rng = mulberry32(Date.now() >>> 0);
    meta.cards = [buildOriginCard(meta, rng)];
    saveMeta(meta);
  }
  if (meta.phase === 'intro') {
    await runTradeIntro(meta);
  }
  showTable(meta);
}

// The forced first trade: the origin card is dealt, the player reaches for
// REENTER WORLD, and the white goblin descends to take it.
async function runTradeIntro(meta: CardMeta): Promise<void> {
  const stage = realmEl('card-stage');
  stage.innerHTML = '';
  stage.className = 'intro-view';

  const origin = meta.cards[0];
  await sleep(500);
  const reentered = new Promise<void>((resolve) => {
    const cardEl = buildCardEl(origin, {
      big: true,
      enterLabel: 'REENTER WORLD',
      onEnter: () => resolve(),
    });
    cardEl.classList.add('deal-from-top');
    stage.appendChild(cardEl);
    // Two frames so the dealt-in transform commits before it transitions out.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        cardEl.classList.remove('deal-from-top');
        playSound('place', 1.2, 0.9);
      });
    });
  });
  await reentered;

  // The player went for the button — the goblin objects.
  playSound('online', 0.5, 0.6);
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
    await say('then you would not know how to stop me from doing this.');
  }

  // The taking: the origin card flies up into the goblin.
  clearSpeech();
  const cardEl = stage.querySelector('.world-card');
  cardEl?.classList.add('taken');
  playSound('select', 0.9, 0.6);
  await sleep(1000);
  cardEl?.remove();

  // The giving: a pitiful replacement drops onto the table. Its ascension
  // demand is pinned to plain cash so the player's first climb out of the
  // dirt has a legible goal.
  const rng = mulberry32((Date.now() ^ 0x5f356495) >>> 0);
  const junk = makeCard(meta, 'common', rng, true);
  junk.upgradeReq = { res: 'money', amount: 10_000 };
  const junkEl = buildCardEl(junk, { big: true });
  junkEl.classList.add('deal-from-top');
  stage.appendChild(junkEl);
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      junkEl.classList.remove('deal-from-top');
      playSound('place', 1.2, 0.7);
    });
  });
  await sleep(900);
  await say("now it's a trade.");
  clearSpeech();
  await goblinOut();

  // The books: origin gone (seeded into gathering III), junk card in hand.
  meta.cards = [junk];
  meta.events = generateEvents(meta, origin);
  meta.phase = 'free';
  saveMeta(meta);
  await sleep(400);
}

// ─── Table / gathering / trade views ─────────────────────────────────

function div(cls: string, text?: string): HTMLElement {
  const d = document.createElement('div');
  d.className = cls;
  if (text !== undefined) d.textContent = text;
  return d;
}

function showTable(meta: CardMeta): void {
  const stage = realmEl('card-stage');
  clearSpeech();
  stage.innerHTML = '';
  stage.className = 'table-view';

  stage.appendChild(div('ct-caption', 'your worlds'));
  const row = div('ct-cards');
  for (const c of meta.cards) {
    row.appendChild(buildCardEl(c, {
      enterLabel: 'REENTER WORLD',
      onEnter: () => enterWorld(meta, c),
      onAscend: () => {
        ascendCard(meta, c);
        playSound('task_complete', 0.8, 1.1);
        showTable(meta);
      },
    }));
  }
  stage.appendChild(row);

  if (!meta.events) {
    meta.events = generateEvents(meta, null);
    saveMeta(meta);
  }
  stage.appendChild(div('ct-caption', 'gatherings'));
  const evRow = div('ct-events');
  for (const ev of meta.events) {
    // Trades are same-tier, so a gathering only opens its doors to someone
    // actually holding a card of its tier.
    const locked = !meta.cards.some((c) => c.tier === ev.tier);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `ct-event${locked ? ' locked' : ''}`;
    const sub = locked
      ? `you hold no ${ev.tier} world`
      : `trades ${ev.tier} worlds · ${ev.creatures.length} creatures attending`;
    btn.innerHTML = `<span class="ct-event-name"></span><span class="ct-event-sub">${sub}</span>`;
    (btn.querySelector('.ct-event-name') as HTMLElement).textContent = ev.name;
    btn.addEventListener('click', () => {
      if (locked) {
        playSound('error', 0.7);
        btn.classList.remove('shake');
        void btn.offsetWidth;
        btn.classList.add('shake');
        return;
      }
      playSound('click', 0.8, 1);
      showEvent(meta, ev);
    });
    evRow.appendChild(btn);
  }
  stage.appendChild(evRow);
}

function backButton(label: string, onBack: () => void): HTMLElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ct-back';
  btn.textContent = label;
  btn.addEventListener('click', () => { playSound('click', 0.8, 1); onBack(); });
  return btn;
}

function creatureAvatar(): HTMLElement {
  return div('ct-creature-sprite');
}

function showEvent(meta: CardMeta, ev: TradeEvent): void {
  const stage = realmEl('card-stage');
  clearSpeech();
  stage.innerHTML = '';
  stage.className = 'event-view';
  stage.appendChild(backButton('← leave gathering', () => showTable(meta)));
  stage.appendChild(div('ct-caption ct-event-title', ev.name));

  // First attendance: a welcome gift. This is the only way the collection
  // grows (trades are 1:1), and it doubles as insurance — a second card of
  // the gathering's tier in case the player's only one offends every
  // appetite at the table.
  if (!ev.gifted) {
    ev.gifted = true;
    const rng = mulberry32((meta.nextId * 69621 + ev.id) >>> 0);
    const gift = makeCard(meta, ev.tier, rng);
    meta.cards.push(gift);
    saveMeta(meta);
    playSound('cash', 0.8, 0.9);
    const note = div('ct-gift', `${ev.creatures[0].name} hands you a welcome gift: ${gift.name}. "now you owe me."`);
    stage.appendChild(note);
  }

  const row = div('ct-creatures');
  for (const cr of ev.creatures) {
    const cel = div('ct-creature');
    cel.appendChild(creatureAvatar());
    cel.appendChild(div('ct-creature-name', cr.name));
    cel.appendChild(div('ct-creature-line', APPETITE_LINE[cr.appetite]));
    cel.appendChild(div('ct-creature-deck', `${cr.deck.length} worlds in hand`));
    cel.addEventListener('click', () => { playSound('click', 0.8, 1); showTrade(meta, ev, cr); });
    row.appendChild(cel);
  }
  stage.appendChild(row);

  // The reshuffle: let this gathering end and meet the next one — fresh
  // creatures, fresh decks, in case nothing on this table suits.
  const wait = document.createElement('button');
  wait.type = 'button';
  wait.className = 'ct-wait';
  wait.textContent = 'wait for the next gathering';
  wait.addEventListener('click', async () => {
    wait.disabled = true;
    playSound('online', 0.4, 0.7);
    stage.classList.add('waiting');
    await sleep(700);
    regenerateEvent(meta, ev);
    showEvent(meta, ev);
  });
  stage.appendChild(wait);
}

function showTrade(meta: CardMeta, ev: TradeEvent, cr: Creature): void {
  const stage = realmEl('card-stage');
  clearSpeech();
  stage.innerHTML = '';
  stage.className = 'trade-view';
  stage.appendChild(backButton('← step away', () => showEvent(meta, ev)));

  const header = div('ct-trade-header');
  header.appendChild(creatureAvatar());
  const headText = div('ct-trade-headtext');
  headText.appendChild(div('ct-creature-name', cr.name));
  const speech = div('ct-trade-line', '');
  headText.appendChild(speech);
  header.appendChild(headText);
  stage.appendChild(header);

  const theirsCap = div('ct-caption', 'their worlds');
  const theirsRow = div('ct-cards ct-theirs');
  const yoursCap = div('ct-caption', 'your worlds');
  const yoursRow = div('ct-cards ct-yours');
  stage.appendChild(theirsCap);
  stage.appendChild(theirsRow);
  stage.appendChild(yoursCap);
  stage.appendChild(yoursRow);

  // Selection state: 'idle' (nothing picked), 'offer' (one of YOUR eligible
  // cards picked — they show what they'd give), or 'request' (one of THEIR
  // cards picked — they show what they'd take).
  let mode: 'idle' | 'offer' | 'request' = 'idle';
  let selectedId: number | null = null;

  const executeTrade = (mine: WorldCard, theirs: WorldCard) => {
    meta.cards = meta.cards.filter((c) => c.id !== mine.id);
    cr.deck = cr.deck.filter((c) => c.id !== theirs.id);
    meta.cards.push(theirs);
    cr.deck.push(mine);
    saveMeta(meta);
    playSound('ritual', 1, 0.9);
    mode = 'idle';
    selectedId = null;
    render();
    speech.textContent = "now it's a trade.";
  };

  const render = () => {
    theirsRow.innerHTML = '';
    yoursRow.innerHTML = '';
    // Cards of yours the creature is open to trading for: appetite match,
    // plus it must actually hold a same-tier card to give back.
    const wanted = meta.cards.filter((c) =>
      appetiteAccepts(cr.appetite, c) && cr.deck.some((d) => d.tier === c.tier));
    const selMine = meta.cards.find((c) => c.id === selectedId) ?? null;
    const selTheirs = cr.deck.find((c) => c.id === selectedId) ?? null;

    for (const tc of cr.deck) {
      const eligible = mode === 'idle'
        || (mode === 'offer' && selMine !== null && creatureGivesFor(cr, selMine).includes(tc))
        || (mode === 'request' && tc.id === selectedId);
      const el = buildCardEl(tc, {
        onClick: () => {
          if (mode === 'offer' && selMine && creatureGivesFor(cr, selMine).includes(tc)) {
            executeTrade(selMine, tc);
            return;
          }
          if (mode === 'request' && tc.id === selectedId) {
            mode = 'idle'; selectedId = null; render();
            speech.textContent = APPETITE_LINE[cr.appetite];
            return;
          }
          if (mode !== 'offer') {
            const takers = creatureTakesFor(cr, tc, meta.cards);
            mode = 'request'; selectedId = tc.id; render();
            speech.textContent = takers.length > 0
              ? 'for this, i would take one of those.'
              : 'you hold nothing i would take for this.';
            playSound('select', 0.7, 1.1);
          }
        },
      });
      el.classList.toggle('grayed', !eligible);
      el.classList.toggle('selected', mode === 'request' && tc.id === selectedId);
      theirsRow.appendChild(el);
    }

    for (const mc of meta.cards) {
      const matches = wanted.includes(mc);
      const eligible = (mode === 'idle' && matches)
        || (mode === 'offer' && mc.id === selectedId)
        || (mode === 'request' && selTheirs !== null && creatureTakesFor(cr, selTheirs, meta.cards).includes(mc));
      const el = buildCardEl(mc, {
        onClick: () => {
          if (mode === 'request' && selTheirs && creatureTakesFor(cr, selTheirs, meta.cards).includes(mc)) {
            executeTrade(mc, selTheirs);
            return;
          }
          if (mode === 'offer' && mc.id === selectedId) {
            mode = 'idle'; selectedId = null; render();
            speech.textContent = APPETITE_LINE[cr.appetite];
            return;
          }
          if (mode !== 'request' && matches) {
            const gives = creatureGivesFor(cr, mc);
            mode = 'offer'; selectedId = mc.id; render();
            speech.textContent = gives.length > 0
              ? 'for that, i would give one of these.'
              : 'i hold nothing to give for that. wait for the next gathering.';
            playSound('select', 0.7, 1.1);
          } else if (mode === 'idle' && !matches) {
            playSound('error', 0.5);
            speech.textContent = 'that one does not interest me.';
          }
        },
      });
      el.classList.toggle('grayed', !eligible);
      el.classList.toggle('selected', mode === 'offer' && mc.id === selectedId);
      yoursRow.appendChild(el);
    }
  };

  render();
  const anyWanted = meta.cards.some((c) => appetiteAccepts(cr.appetite, c));
  speech.textContent = anyWanted ? APPETITE_LINE[cr.appetite] : 'you hold nothing i want. yet.';
}
