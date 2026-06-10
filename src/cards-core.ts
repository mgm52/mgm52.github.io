// ─── Trading-card realm: core logic ──────────────────────────────────
// The DOM-free half of the post-finale trading-card section (cards.ts holds
// the realm UI, persistence, and the enter/leave-world plumbing). Everything
// here is pure data-in/data-out — card tiers and ascension demands, trade
// rules, gathering generation, and the weird-world generator — so it can be
// unit-tested in node (see tests/cards-core.test.ts) without a browser.

import * as devalue from 'devalue';
import { compressToUTF16, decompressFromUTF16 } from 'lz-string';
import {
  BUILDING_DEFS, BuildingKind, CELL, SPACE,
} from './config';
import {
  Building, Cell, GameState, Goblin, SpaceBuilding,
  buildingAtCell, cellCenter, cellKey, computePlayBounds, createInitialState,
  digDirection, isInPlayCell, markBuildingsChanged, nextBuildingDisplayNum,
  occupyCell, recordGhost, removeGoblin, waterSourceAtCell,
} from './state';

export type CardTier = 'common' | 'uncommon' | 'rare';
export const TIER_RANK: Record<CardTier, number> = { common: 0, uncommon: 1, rare: 2 };
export const TIER_ABOVE: Record<CardTier, CardTier | null> = { common: 'uncommon', uncommon: 'rare', rare: null };

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
export type Appetite = 'any' | 'blood' | 'rich' | 'bones';
export const APPETITE_LINE: Record<Appetite, string> = {
  any: 'i will consider any world.',
  blood: 'i want worlds with blood in them.',
  rich: 'i want wealthy worlds.',
  bones: 'i want worlds that keep bones.',
};
export function appetiteAccepts(a: Appetite, card: WorldCard): boolean {
  if (a === 'any') return true;
  if (a === 'blood') return card.resources.blood >= 1;
  if (a === 'rich') return card.resources.money >= 1000;
  return card.resources.dragonBone >= 1;
}

export type Creature = { id: number; name: string; appetite: Appetite; deck: WorldCard[] };
// Each gathering trades one tier only — creatures there hold cards of that
// tier and accept cards of that tier. Entry needs a card of the tier (or one
// tier above, breakable into two) in hand. Two-for-one breakdowns are the
// only way the collection grows.
export type TradeEvent = { id: number; name: string; tier: CardTier; creatures: Creature[] };

export type CardMeta = {
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

// ─── Seeded RNG + names ──────────────────────────────────────────────
export function mulberry32(seed: number): () => number {
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
export function worldName(rng: () => number): string {
  const a = NAME_A[Math.floor(rng() * NAME_A.length)];
  const b = NAME_B[Math.floor(rng() * NAME_B.length)];
  return `the ${a} ${b}`;
}

export const CREATURE_NAMES = [
  'the pale one', 'tall friend', 'the collector', 'wet sister', 'the magistrate',
  'kind uncle', 'little echo', 'the porcelain man', 'the second cousin', 'quiet auntie',
  'the bargain', 'old neighbour', 'the white knuckle', 'gentle creditor',
];

// ─── World (de)serialization ─────────────────────────────────────────
export function encodeWorld(st: GameState): string {
  return compressToUTF16(devalue.stringify(st));
}

export function decodeWorld(data: string): GameState | null {
  try {
    const raw = decompressFromUTF16(data);
    if (!raw) return null;
    return devalue.parse(raw) as GameState;
  } catch { return null; }
}

// ─── Weird-world generation ──────────────────────────────────────────
// Every non-origin card wraps a procedurally mutated fresh state: dug arms,
// scattered dormant buildings, idle goblins, ghosts in hell, sometimes space
// debris — and no Bob, no Lolly, no demons. All tasks arrive pre-completed
// (the caller passes ui.ts's task id list) so a card world never replays the
// tutorial celebrations.

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

export function generateWeirdWorld(seed: number, tier: CardTier, taskIds: string[]): GameState {
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
    completed: new Set(taskIds),
    revealed: new Set(taskIds),
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
export function generateJunkWorld(seed: number, taskIds: string[]): GameState {
  const rng = mulberry32(seed);
  const st = generateWeirdWorld(seed, 'common', taskIds);
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
export function sanitizeCardWorld(st: GameState): void {
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
export function rollUpgradeReq(tier: CardTier, rng: () => number): UpgradeReq | null {
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

export function reqMet(card: WorldCard): boolean {
  const r = card.upgradeReq;
  return !!r && card.resources[r.res] >= r.amount;
}

// Ascend a card one tier (caller checks reqMet and persists the meta) and
// roll its next demand.
export function ascendCard(meta: CardMeta, card: WorldCard): void {
  const next = TIER_ABOVE[card.tier];
  if (!next) return;
  card.tier = next;
  const rng = mulberry32((card.id * 1103515245 + meta.nextId) >>> 0);
  card.upgradeReq = rollUpgradeReq(next, rng);
}

export function makeCard(meta: CardMeta, tier: CardTier, rng: () => number, taskIds: string[], junk = false): WorldCard {
  const seed = Math.floor(rng() * 0xffffffff);
  const st = junk ? generateJunkWorld(seed, taskIds) : generateWeirdWorld(seed, tier, taskIds);
  return {
    id: meta.nextId++,
    name: worldName(rng),
    tier,
    data: encodeWorld(st),
    resources: { money: st.money, blood: st.blood, dragonBone: st.dragonBone },
    // The junk card's ascension demand is pinned to plain cash so the
    // player's first climb out of the dirt has a legible goal.
    upgradeReq: junk ? { res: 'money', amount: 10_000 } : rollUpgradeReq(tier, rng),
  };
}

// ─── The gatherings ──────────────────────────────────────────────────
// One per tier. Trades are same-tier 1:1 (or one-above broken down into
// two), so the way UP is always a card's own ascension demand — gatherings
// are where you swap a world whose demand doesn't suit you for one that
// does (or, at the rare exchange, win your own world back). Every gathering
// keeps one any-appetite creature so the player is never hard-locked; for
// everything else there's the "wait for the next gathering" reshuffle.

export const EVENT_NAMES: Record<CardTier, string> = {
  common: 'gathering at the soft border',
  uncommon: 'the uncommon salon',
  rare: 'the rare exchange',
};

let creatureSeq = 1;
export function rollCreatures(meta: CardMeta, tier: CardTier, rng: () => number, taskIds: string[]): Creature[] {
  const names = [...CREATURE_NAMES];
  for (let i = names.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [names[i], names[j]] = [names[j], names[i]];
  }
  const appetites: Appetite[] = ['blood', 'rich', 'bones'];
  const mk = (appetite: Appetite): Creature => {
    const deckSize = 2 + Math.floor(rng() * 2);
    const deck: WorldCard[] = [];
    for (let i = 0; i < deckSize; i++) deck.push(makeCard(meta, tier, rng, taskIds));
    return { id: creatureSeq++, name: names.pop() ?? 'the other one', appetite, deck };
  };
  return [mk('any'), mk(appetites[Math.floor(rng() * appetites.length)])];
}

export function generateEvents(meta: CardMeta, stolen: WorldCard | null, taskIds: string[]): TradeEvent[] {
  const rng = mulberry32((meta.nextId * 2654435761) >>> 0);
  const events: TradeEvent[] = (['common', 'uncommon', 'rare'] as CardTier[]).map((tier, i) => ({
    id: i + 1,
    name: EVENT_NAMES[tier],
    tier,
    creatures: rollCreatures(meta, tier, rng, taskIds),
  }));
  // The stolen origin card waits at the rare exchange, with the creature who
  // will consider anything for it.
  if (stolen) events[2].creatures[0].deck.unshift(stolen);
  return events;
}

// The reshuffle: this gathering ends and the next one of the same tier
// arrives — new creatures, new decks (caller persists the meta). Whatever
// the player traded away leaves with the departing creatures, except the
// origin card, which always finds its way to the next table.
export function regenerateEvent(meta: CardMeta, ev: TradeEvent, taskIds: string[]): void {
  const origin = ev.creatures.flatMap((c) => c.deck).find((c) => c.origin) ?? null;
  const rng = mulberry32((meta.nextId * 48271 + ev.id) >>> 0);
  ev.creatures = rollCreatures(meta, ev.tier, rng, taskIds);
  if (origin) ev.creatures[0].deck.unshift(origin);
}

// ─── Trade rules ─────────────────────────────────────────────────────
// Same tier in, same tier out — 1:1. The one exception is breaking DOWN:
// offer a card exactly one tier above what a creature holds and it will
// give TWO of the lesser tier for it (1 uncommon → 2 commons, 1 rare →
// 2 uncommons). A creature is open to trading for your card at all only
// when it matches its appetite.
export function sameTierGives(c: Creature, yours: WorldCard): WorldCard[] {
  return c.deck.filter((d) => d.tier === yours.tier);
}
export function breakdownGives(c: Creature, yours: WorldCard): WorldCard[] {
  const below = TIER_RANK[yours.tier] - 1;
  const cards = c.deck.filter((d) => TIER_RANK[d.tier] === below);
  // A two-for-one needs two to give.
  return cards.length >= 2 ? cards : [];
}
export function creatureTakesFor(c: Creature, theirs: WorldCard, mine: WorldCard[]): WorldCard[] {
  return mine.filter((m) => appetiteAccepts(c.appetite, m) && m.tier === theirs.tier);
}
