// ─── Trading-card realm: core logic ──────────────────────────────────
// The DOM-free half of the post-finale trading-card section (cards.ts holds
// the realm UI, persistence, and the enter/leave-world plumbing). Everything
// here is pure data-in/data-out — card tiers and ascension demands, trade
// rules, gathering generation, and the weird-world generator — so it can be
// unit-tested in node (see tests/cards-core.test.ts) without a browser.

import * as devalue from 'devalue';
import { compressToUTF16, decompressFromUTF16 } from 'lz-string';
import {
  BUILDING_DEFS, BuildingKind, CELL, SOUL_SIGIL, SPACE, formatPower,
} from './config';
import {
  Building, Cell, GameState, Goblin, SpaceBuilding,
  buildingAtCell, cellCenter, cellKey, computePlayBounds, createInitialState,
  digDirection, isInPlayCell, markBuildingsChanged, nextBuildingDisplayNum,
  occupyCell, recordGhost, removeGoblin, unlockEverything, waterSourceAtCell,
} from './state';

export type CardTier = 'common' | 'uncommon' | 'rare';
export const TIER_RANK: Record<CardTier, number> = { common: 0, uncommon: 1, rare: 2 };
export const TIER_ABOVE: Record<CardTier, CardTier | null> = { common: 'uncommon', uncommon: 'rare', rare: null };

// The headline numbers written on a card. `power` is the world's last
// measured production in watts (0 until its buildings have actually run);
// `goblins` is the standing population. Both optional for metas saved
// before they existed.
export type CardResources = { money: number; blood: number; dragonBone: number; power?: number; goblins?: number };

export type WorldCard = {
  id: number;
  name: string;
  tier: CardTier;
  // The world itself: compressToUTF16(devalue.stringify(GameState)). Updated
  // each time the player leaves the world.
  data: string;
  // Headline numbers written on the card; refreshed alongside `data`.
  resources: CardResources;
  // The player's own stolen pre-finale world — winnable back at gathering III.
  origin?: boolean;
  // Border-pattern index (index.html's .wcf-N rules) of the trader whose
  // hand minted this card. It stays with the card through every trade, so
  // where a card came from reads at a glance; player-minted cards (the
  // origin, the junk replacement) carry none and keep the plain frame.
  frame?: number;
};

// ─── Trader wants ────────────────────────────────────────────────────
// A creature advertises ONE want — the worlds it will take. Hand it the
// card(s) that satisfy the want and it gives you its ENTIRE deck in return
// (the only way the collection grows now that cards no longer ascend on their
// own). Wants vary per trader: an open "any one world", a tier ask ("three
// common worlds"), or a resource threshold ("a world worth Ƶ10,000+").
export type Want =
  | { kind: 'any'; count: number }
  | { kind: 'tier'; tier: CardTier; count: number }
  | { kind: 'resource'; res: 'money' | 'blood' | 'dragonBone' | 'power'; amount: number; count: number };

const COUNT_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
function countWord(n: number): string { return COUNT_WORDS[n] ?? String(n); }
function worldsWord(n: number): string { return n === 1 ? 'world' : 'worlds'; }

// The card resource a want reads (power is the card's measured production).
export function wantResAmount(res: 'money' | 'blood' | 'dragonBone' | 'power', card: WorldCard): number {
  return res === 'power' ? (card.resources.power ?? 0) : (card.resources[res] ?? 0);
}

// Does a single card qualify toward a want?
export function cardQualifies(w: Want, card: WorldCard): boolean {
  if (w.kind === 'any') return true;
  if (w.kind === 'tier') return card.tier === w.tier;
  return wantResAmount(w.res, card) >= w.amount;
}

// How many cards in a hand qualify, and whether the hand can satisfy the want
// at all (enough qualifying cards to hand over).
export function countQualifying(w: Want, hand: WorldCard[]): number {
  return hand.reduce((n, c) => n + (cardQualifies(w, c) ? 1 : 0), 0);
}
export function wantSatisfiableBy(w: Want, hand: WorldCard[]): boolean {
  return countQualifying(w, hand) >= w.count;
}
// Is THIS exact offer the trade? Every offered card must qualify and the count
// must match — you hand over precisely the cards the want names, no more.
export function wantSatisfiedBy(w: Want, offered: WorldCard[]): boolean {
  return offered.length === w.count && offered.every((c) => cardQualifies(w, c));
}

// The trader's advertised line.
export function wantLine(w: Want): string {
  if (w.kind === 'any') {
    return w.count === 1 ? 'i will take any one world.' : `i want any ${countWord(w.count)} ${worldsWord(w.count)}.`;
  }
  if (w.kind === 'tier') {
    return w.count === 1 ? `i want a ${w.tier} world.` : `i want ${countWord(w.count)} ${w.tier} ${worldsWord(w.count)}.`;
  }
  const amt = Math.floor(w.amount).toLocaleString('en-US');
  const desc = w.res === 'money' ? `worth Ƶ${amt}+`
    : w.res === 'blood' ? `with ${amt}+ blood`
    : w.res === 'dragonBone' ? `keeping ${amt}+ bones`
    : `making ${formatPower(w.amount)}+`;
  const head = w.count === 1 ? 'a world' : `${countWord(w.count)} worlds`;
  return `i want ${head} ${desc}.`;
}

// Resource bands a non-"any" want draws its threshold from, by gathering tier.
const WANT_BANDS: Record<CardTier, Partial<Record<'money' | 'blood' | 'dragonBone' | 'power', [number, number]>>> = {
  common: { money: [1_000, 15_000], blood: [50, 800] },
  uncommon: { money: [50_000, 1_000_000], blood: [2_000, 20_000], dragonBone: [2, 12], power: [1_000_000_000, 3_000_000_000] },
  rare: { money: [1_000_000, 200_000_000], blood: [50_000, 500_000], dragonBone: [50, 500], power: [1_000_000_000, 5_000_000_000] },
};

// Roll a creature's want. The first creature at every gathering keeps an easy
// ask so the player is never hard-locked — at the common border it takes any
// one world, and each richer table's opener takes a single card of the tier
// just below it (the rung you climb up by). The rest are pickier: more of the
// table's own tier, or a resource threshold.
export function rollWant(tier: CardTier, rng: () => number, firstSlot: boolean): Want {
  if (firstSlot) {
    if (tier === 'common') return { kind: 'any', count: 1 };
    const below = tier === 'uncommon' ? 'common' : 'uncommon';
    return { kind: 'tier', tier: below, count: 1 };
  }
  const roll = rng();
  if (roll < 0.5) {
    const count = rng() < 0.55 ? 1 : rng() < 0.7 ? 2 : 3;
    return { kind: 'tier', tier, count };
  }
  const band = WANT_BANDS[tier];
  const resOptions = (Object.keys(band) as ('money' | 'blood' | 'dragonBone' | 'power')[]);
  const res = resOptions[Math.floor(rng() * resOptions.length)];
  const [lo, hi] = band[res]!;
  return { kind: 'resource', res, amount: spicyAmount(lo, hi, rng), count: 1 };
}

// `frame` is the creature's own card-border pattern (see WorldCard.frame);
// optional only because metas saved before frames existed lack it (cards.ts
// stamps the missing values on load). Each creature advertises ONE `want` —
// hand it the card(s) that satisfy the want and it gives you its entire deck.
export type Creature = { id: number; name: string; want: Want; deck: WorldCard[]; frame?: number };

// The six creature slots across the three gatherings map onto the six frame
// patterns — common's lone creature takes 0, the salon pair 1–2, the rare
// exchange trio 3–5 — and the mapping is stable across reshuffles, so a
// table's frames never change mid-game.
export const FRAME_BASE: Record<CardTier, number> = { common: 0, uncommon: 1, rare: 3 };
// Each gathering trades one tier only — creatures there hold cards of that
// tier and accept cards of that tier. Entry needs a card of the tier (or one
// tier above, breakable into two) in hand. Two-for-one breakdowns are the
// only way the collection grows.
export type TradeEvent = { id: number; name: string; tier: CardTier; creatures: Creature[] };

export type CardMeta = {
  v: 1;
  // 'intro' until the white goblin has run the forced first trade.
  phase: 'intro' | 'free';
  // Per-playthrough entropy mixed into every gathering roll. Without it the
  // event RNG keyed on nextId alone, and nextId is identical for every
  // player at the moment the tables are first dealt — so everyone met the
  // same first trader. Optional only for metas saved before it existed
  // (loadMeta stamps those).
  seed?: number;
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

// The spike that defines a generated world's identity. Generated worlds are
// deliberately lopsided — a card is a personality, not an average:
//  - balanced:    a bit of everything (the original behavior)
//  - bloodbath:   swimming in blood, broke
//  - mint:        swimming in cash, bloodless
//  - boneyard:    keeps bones (even at common, where bones are unheard of)
//  - monoculture: one building kind, everywhere
//  - crowd:       goblins wall to wall, little else (units ARE the wealth)
//  - flooded:     the land is mostly lake — water-hungry buildings thrive
//                 in the gaps between the shores
// Three flavors are CHALLENGES — the world is a small puzzle:
//  - seance:      a bad power source stands ready, the bank holds exactly a
//                 five-candle séance's worth of blood. Spawn them, kill them,
//                 seat them — a fully soul-fed sigil makes serious power.
//  - overcharged: reactors everywhere, no cash — the opening money grind
//                 replayed without ever worrying about generators (its work
//                 track resets to the very start to match).
//  - goldrush:    every goblin glitters — an economy of killing your own
//                 citizens for clean Ƶ250 heads.
//  - haunted:     hell is full; the surface is thin
export type WorldFlavor = 'balanced' | 'bloodbath' | 'mint' | 'boneyard' | 'monoculture' | 'crowd' | 'flooded' | 'seance' | 'overcharged' | 'goldrush' | 'haunted';
export const WORLD_FLAVORS: WorldFlavor[] = ['balanced', 'bloodbath', 'mint', 'boneyard', 'monoculture', 'crowd', 'flooded', 'seance', 'overcharged', 'goldrush', 'haunted'];

// The main game's task chain, in order (ui.ts TASKS). A generated world sits
// partway along it — like an adopted save file — so entering a card can mean
// finding a colony still grinding "Run a Phone Farm". Filtered against the
// caller's task id list, so a trimmed list (tests) still works.
export const MAIN_TRACK = [
  'earn_100', 'run_phone_farm', 'build_gas_engine', 'run_datacentre',
  'build_nuclear_reactor', 'build_hypercentre', 'collect_blood',
];

export function generateWeirdWorld(seed: number, tier: CardTier, taskIds: string[], flavorOverride?: WorldFlavor): GameState {
  const rng = mulberry32(seed);
  const ri = (a: number, b: number) => a + Math.floor(rng() * (b - a + 1));
  const st = createInitialState();
  st.cardWorld = true;
  st.demons = new Map();
  st.log = [];
  const flavor: WorldFlavor = flavorOverride ?? WORLD_FLAVORS[Math.floor(rng() * WORLD_FLAVORS.length)];
  const T = TIER_RANK[tier]; // 0 / 1 / 2 — scales every spike

  // Dug arms — more of the plus-shape opens up with tier.
  const dirs: ('n' | 'e' | 's' | 'w')[] = ['n', 'e', 's', 'w'];
  for (let i = dirs.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [dirs[i], dirs[j]] = [dirs[j], dirs[i]];
  }
  const digs = tier === 'common' ? ri(0, 1) : tier === 'uncommon' ? ri(1, 3) : ri(2, 4);
  for (const d of dirs.slice(0, digs)) digDirection(st, d);
  st.firstDugAt = 0;

  // Baseline balances by tier (the 'balanced' flavor), then the spike.
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
  let buildingCount = tier === 'common' ? ri(1, 4) : tier === 'uncommon' ? ri(4, 12) : ri(10, 24);
  let goblinCount = tier === 'common' ? ri(1, 3) : tier === 'uncommon' ? ri(2, 10) : ri(5, 25);
  let ghostCount = tier === 'common' ? ri(0, 4) : tier === 'uncommon' ? ri(2, 12) : ri(6, 40);
  let goldChance = 0.1;
  let dragonGhostBias = 0.1;
  let pool = KIND_POOLS[tier];
  let forcePortal = false;
  let lakes = 0;

  if (flavor === 'bloodbath') {
    st.blood = [ri(15, 60), ri(1_200, 8_000), ri(240_000, 800_000)][T];
    st.money = ri(0, [8, 90, 900][T]);
    st.dragonBone = 0;
    ghostCount *= 2;
    goblinCount += ri(2, 4 + T * 4);
  } else if (flavor === 'mint') {
    st.money = [ri(180, 900), ri(90_000, 400_000), ri(150_000_000, 600_000_000)][T];
    st.blood = 0;
    st.dragonBone = 0;
    buildingCount = Math.max(1, Math.floor(buildingCount / 2));
  } else if (flavor === 'boneyard') {
    st.dragonBone = [ri(1, 3), ri(4, 12), ri(150, 500)][T];
    st.money = ri(0, [10, 600, 40_000][T]);
    st.blood = Math.floor(st.blood / 4);
    dragonGhostBias = 0.7;
    ghostCount += ri(2, 6);
  } else if (flavor === 'monoculture') {
    const mono = pool[Math.floor(rng() * pool.length)];
    pool = [mono];
    buildingCount = [ri(6, 12), ri(14, 30), ri(25, 50)][T];
    st.money = Math.floor(st.money / 3);
  } else if (flavor === 'crowd') {
    goblinCount = [ri(6, 12), ri(15, 30), ri(30, 60)][T];
    goldChance = 0.25;
    buildingCount = Math.max(1, Math.floor(buildingCount / 2));
    // The crowd IS the wealth — the bank holds next to nothing.
    st.money = ri(0, 12);
    st.blood = ri(0, 10);
    st.dragonBone = 0;
  } else if (flavor === 'flooded') {
    // The land is mostly lake. Water everywhere makes this the promised
    // ground for the thirsty buildings — if you can find dry cells to
    // build them on.
    lakes = ri(3, 5 + T);
    if (tier !== 'common') pool = [...pool, 'datacentre', 'datacentre'];
    st.blood = Math.floor(st.blood / 2);
  } else if (flavor === 'goldrush') {
    // Every goblin glitters. The bank is empty; the citizens ARE the bank.
    goldChance = 1;
    goblinCount += ri(3, 6 + T * 3);
    st.money = ri(0, 30);
    st.blood = Math.floor(st.blood / 2);
    st.dragonBone = 0;
  } else if (flavor === 'seance') {
    // The candle challenge: hell stands open behind a "bad power source",
    // and the bank holds exactly five candles' worth of blood (plus crumbs).
    // Spawning is free — the souls for the chairs are made, not found.
    st.blood = SOUL_SIGIL.count * SOUL_SIGIL.candleBloodCost + ri(0, 6);
    st.money = ri(0, 40);
    st.dragonBone = 0;
    forcePortal = true;
    buildingCount = ri(0, 1);
    goblinCount = ri(1, 2);
    ghostCount = ri(0, 2); // a head start on souls, never the full five
  } else if (flavor === 'overcharged') {
    // Standing power, empty pockets: the early game replayed with the
    // generator problem already solved (by somebody with dubious taste).
    st.money = ri(0, 10);
    st.blood = 0;
    st.dragonBone = 0;
    pool = ['nuclear_reactor', 'nuclear_reactor', 'gas_engine'];
    buildingCount = [ri(2, 3), ri(3, 5), ri(4, 8)][T];
    goblinCount = Math.max(goblinCount, 4 + T * 4);
  } else if (flavor === 'haunted') {
    ghostCount = [ri(10, 25), ri(25, 60), ri(60, 120)][T];
    forcePortal = true;
    st.money = Math.floor(st.money / 4);
    st.blood = Math.floor(st.blood / 2);
    buildingCount = Math.max(1, Math.floor(buildingCount / 2));
    goblinCount = Math.max(1, Math.floor(goblinCount / 2));
  }

  st.moneyEarned = st.money;
  st.bloodEarned = st.blood;
  st.dragonBoneEarned = st.dragonBone;
  st.bloodUnlocked = st.blood > 0;
  st.dragonBoneUnlocked = st.dragonBone > 0;

  // Where this world sits on the work track — like an adopted save file.
  // Commons are still grinding the early tasks, uncommons sit mid-game,
  // rares are late or finished (a finished world has seen everything,
  // optional Work included). Overcharged worlds reset to the very start:
  // their whole point is replaying the opening grind. The buildings already
  // standing don't have to agree with the phase — some of these saves are
  // a bit hacked.
  const track = MAIN_TRACK.filter((id) => taskIds.includes(id));
  const phaseRoll = flavor === 'overcharged' ? ri(0, 1)
    : tier === 'common' ? ri(1, 3)
    : tier === 'uncommon' ? ri(3, 5)
    : ri(5, 7);
  const phase = Math.min(phaseRoll, track.length);
  const finished = phase >= track.length && flavor !== 'overcharged';
  const done = new Set<string>(track.slice(0, phase));
  if (finished) for (const id of taskIds) done.add(id);
  // The optional minotaur side-task: some mid-track worlds did the Work.
  else if (done.has('build_gas_engine') && rng() < 0.6) done.add('summon_minotaurs');

  // Extra lakes (the flooded flavor): random pools dropped before any
  // structure, so buildings and goblins place around the water. The hole
  // keeps a dry berth.
  for (let i = 0; i < lakes; i++) {
    const b = computePlayBounds(st);
    const w = ri(2, 4 + T), h = ri(2, 4);
    for (let attempt = 0; attempt < 20; attempt++) {
      const x0 = b.x0 + Math.floor(rng() * Math.max(1, b.x1 - b.x0 - w));
      const y0 = b.y0 + Math.floor(rng() * Math.max(1, b.y1 - b.y0 - h));
      if (Math.abs(x0 + w / 2 - st.hole.cell.cx) <= w / 2 + 2
        && Math.abs(y0 + h / 2 - st.hole.cell.cy) <= h / 2 + 2) continue;
      const id = st.nextId++;
      st.waterSources.set(id, { id, x0, y0, x1: x0 + w, y1: y0 + h, selected: false });
      break;
    }
  }

  // Scattered, unstaffed buildings — they wake (or stay dormant) under the
  // normal sim rules once the player starts assigning goblins.
  for (let i = 0; i < buildingCount; i++) {
    const kind = pool[Math.floor(rng() * pool.length)];
    const placed = tryPlaceBuilding(st, kind, rng);
    if (placed?.kind === 'hell_portal') st.hellUnlocked = true;
  }
  if (forcePortal && !st.hellUnlocked) {
    const portal = tryPlaceBuilding(st, 'hell_portal', rng);
    if (portal) st.hellUnlocked = true;
  }

  // Inhabitants.
  for (let i = 0; i < goblinCount; i++) {
    tryPlaceGoblin(st, rng, {
      gold: rng() < goldChance,
      robot: tier === 'rare' && rng() < 0.15,
    });
  }
  st.spawnsCompleted = goblinCount;

  // Ghosts already drifting in this world's hell — somebody lived here.
  const gb = computePlayBounds(st);
  for (let i = 0; i < ghostCount; i++) {
    const kind = rng() < dragonGhostBias ? 'dragon' : rng() < 0.85 ? 'goblin' : 'minotaur';
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

  // Ritual flags loosen with tier — but never ahead of the work track: an
  // ability's flag only sticks if the task that grants it is already done
  // in this world (autobuild rides run_phone_farm, Goldblins rides the
  // minotaur side-task, Lightning rides run_datacentre).
  if (tier !== 'common') {
    st.autoAssignEnabled = done.has('run_phone_farm') && rng() < 0.7;
    st.autoWaterEnabled = st.autoAssignEnabled && rng() < 0.5;
    st.goldgoblinsEnabled = done.has('summon_minotaurs') && rng() < 0.5;
    st.lightningUnlocked = done.has('run_datacentre') && rng() < 0.6;
  }
  if (tier === 'rare') {
    st.autoAssignEnabled = done.has('run_phone_farm');
    st.lightningUnlocked = done.has('run_datacentre');
    st.goldgoblinMultiplier = rng() < 0.3 ? 10 : 1;
    st.tinytaurUnlocked = rng() < 0.4;
    if (rng() < 0.7) {
      const m = [1, 2, 4, 8][ri(0, 3)];
      st.autoSpawnEnabled = true;
      st.autoSpawnMultiplier = m;
      st.autoSpawnLevel = m;
    }
  }
  // A goldrush keeps minting gold: fresh spawns can glitter too, whatever
  // the work track says — this world was hacked that way.
  if (flavor === 'goldrush') st.goldgoblinsEnabled = true;

  // The work track, stamped: tasks up to the phase are completed AND
  // revealed (no celebration replays for them), everything beyond is still
  // to be played inside the card. Onboarding hints stay pre-seen — these
  // are somebody's mid-game saves, not fresh ground.
  st.unlocks = {
    completed: new Set(done),
    revealed: new Set(done),
    obsoleted: new Set(),
    everBuilt: new Set([...st.buildings.values()].map((b) => b.kind)),
    minotaurEverSummoned: done.has('summon_minotaurs') || finished,
  };
  if (finished) st.lillyTasksGiven = true;
  st.waterSeen = true;
  st.cameraPanSeen = true;
  st.multiSelectSeen = true;
  st.multiSpawnSeen = true;
  st.devSkippedToHell = true; // suppress the fresh-ground onboarding nudges

  sanitizeCardWorld(st);
  return st;
}

// The goblin's replacement for the player's stolen world: an obviously
// pitiful one. A handful of scattered walls, two goblins, Ƶ3 — and no
// spawn hole, so nothing can ever be summoned. Its pinned Ƶ10,000 demand
// is unreachable from the inside; the only way up is to TRADE it, which is
// exactly the lesson the white goblin meant to teach.
export function generateJunkWorld(seed: number, taskIds: string[]): GameState {
  const rng = mulberry32(seed);
  const st = generateWeirdWorld(seed, 'common', taskIds, 'balanced');
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
  // The junk world starts at the very bottom of the work track — and with
  // the spawn hole caved in (and Goblin Holes locked behind a task it will
  // never reach), no goblin can ever join the two already standing there.
  st.unlocks!.completed = new Set();
  st.unlocks!.revealed = new Set();
  st.unlocks!.minotaurEverSummoned = false;
  st.lillyTasksGiven = false;
  st.holeDestroyed = true;
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

// The power number written on a card. What the world's generators last
// actually produced — but a world that has never run (or ran with every
// generator dormant) shouldn't read "nothing" while a reactor sits on its
// lawn, so fall back to what the placed generators COULD produce.
export function cardPower(st: GameState): number {
  if (st.lastPowerProduced > 0) return st.lastPowerProduced;
  let potential = 0;
  for (const b of st.buildings.values()) {
    const out = BUILDING_DEFS[b.kind].powerOutput;
    if (out > 0) potential += out;
  }
  for (const sb of st.spaceBuildings.values()) {
    if (st.buildings.has(sb.id)) continue;
    const out = BUILDING_DEFS[sb.building.kind].powerOutput;
    if (out > 0) potential += out;
  }
  return potential;
}

// Per-scene structure counts, driving each preview pane's treatment on the
// card: a pane with nothing built fades; one holding three or more
// structures glows. Walls are scenery, not development; hell counts what
// shows in the hell scene (portal mirrors + placed candles).
export function sceneStructureCounts(st: GameState): { space: number; earth: number; hell: number } {
  let earth = 0, portals = 0;
  for (const b of st.buildings.values()) {
    if (b.kind === 'wall') continue;
    earth++;
    if (b.kind === 'hell_portal') portals++;
  }
  return {
    space: st.spaceBuildings.size,
    earth,
    hell: portals + st.soulChairs.length,
  };
}

// ─── Card construction ───────────────────────────────────────────────

// A "charismatic" amount inside a band: half the time the rolled figure
// snaps to a power of two, a repdigit, or a clean single-digit round — so a
// trader's resource want asks for Ƶ8,192 or 6,666 blood instead of a beige
// 7,341 (rollWant uses this for its resource thresholds).
export function spicyAmount(lo: number, hi: number, rng: () => number): number {
  const plain = lo + Math.floor(rng() * (hi - lo + 1));
  if (rng() < 0.5) return plain;
  const cands: number[] = [];
  for (let p = 1; p <= 40; p++) {
    const v = 2 ** p;
    if (v >= lo && v <= hi) cands.push(v);
  }
  for (let d = 1; d <= 9; d++) {
    for (let n = 2; n <= 12; n++) {
      const v = d * Math.floor((10 ** n - 1) / 9); // d repeated n times
      if (v >= lo && v <= hi) cands.push(v);
    }
  }
  const mag = 10 ** Math.floor(Math.log10(hi));
  for (let k = 1; k <= 9; k++) {
    const v = k * mag;
    if (v >= lo && v <= hi) cands.push(v);
  }
  return cands.length > 0 ? cands[Math.floor(rng() * cands.length)] : plain;
}

export function makeCard(meta: CardMeta, tier: CardTier, rng: () => number, taskIds: string[], junk = false): WorldCard {
  const seed = Math.floor(rng() * 0xffffffff);
  const st = junk ? generateJunkWorld(seed, taskIds) : generateWeirdWorld(seed, tier, taskIds);
  const resources: CardResources = {
    money: st.money, blood: st.blood, dragonBone: st.dragonBone,
    power: cardPower(st), goblins: st.goblins.size,
  };
  return {
    id: meta.nextId++,
    name: worldName(rng),
    tier,
    data: encodeWorld(st),
    resources,
  };
}

// ─── Manual worlds (the dev World Designer's database) ───────────────
// Hand-authored worlds saved out of the designer. They are the dominant card
// source: a trader deck is filled 95% from this pool (matching the slot's
// tier) and only 5% — or whenever the pool can't field the tier — from the
// procedural generator above. A manual world's serialized GameState already
// carries `tasksDisabled` + every unlock (makeSandboxWorld), so entering one
// as a card is automatically a sandbox.
export type ManualWorld = { id: number; name: string; tier: CardTier; data: string; resources: CardResources };

// Turn a stored manual world into a fresh dealable card (new id; the caller
// stamps the minting trader's frame, as with procedural cards).
export function cardFromManual(meta: CardMeta, m: ManualWorld): WorldCard {
  return {
    id: meta.nextId++,
    name: m.name,
    tier: m.tier,
    data: m.data,
    resources: { ...m.resources },
  };
}

// Mint one card for a trader's deck: 95% drawn from the manual pool of the
// matching tier when any exist, otherwise procedurally generated.
export function mintDeckCard(meta: CardMeta, tier: CardTier, rng: () => number, taskIds: string[], manualPool: ManualWorld[] = []): WorldCard {
  const pool = manualPool.filter((m) => m.tier === tier);
  if (pool.length > 0 && rng() < 0.95) {
    return cardFromManual(meta, pool[Math.floor(rng() * pool.length)]);
  }
  return makeCard(meta, tier, rng, taskIds);
}

// A blank designer/sandbox world: a fresh state, stripped of finale/Bob/Lolly
// machinery, with every sidebar ability unlocked and the task track disabled.
// Used both to start a new manual world and (via its flags) by every world
// the designer saves.
export function makeSandboxWorld(taskIds: string[]): GameState {
  const st = createInitialState();
  sanitizeCardWorld(st);
  unlockEverything(st, taskIds);
  st.tasksDisabled = true;
  return st;
}

// ─── The gatherings ──────────────────────────────────────────────────
// One per tier. Each gathering seats a few traders, all on screen at once;
// every trader advertises ONE want and, satisfied, gives its WHOLE deck for
// the card(s) the want names. The way the collection grows is finding a want
// you can meet — gatherings are where you spend a world (or a few) to gain a
// trader's hand, or, at the rare exchange, win your own world back. Every
// gathering's opener keeps an easy want so the player is never hard-locked;
// for everything else there's the "wait for the next gathering" reshuffle.

export const EVENT_NAMES: Record<CardTier, string> = {
  common: 'gathering at the soft border',
  uncommon: 'the uncommon salon',
  rare: 'the rare exchange',
};

let creatureSeq = 1;
// The tables grow with the tiers — one trader at the soft border, two at the
// salon, three at the rare exchange — and stay small-handed so no view ever
// overwhelms. The first trader anywhere wants the easy rung (any one world at
// the border, a single lesser card at the richer tables); the rest are picky.
// The common gathering's lone trader holds TWO cards, so satisfying its open
// want with a single world doubles the player's hand on the first trade.
const CREATURE_SPECS: Record<CardTier, number[]> = {
  common: [2],
  uncommon: [1, 2],
  rare: [1, 2, 2],
};
export function rollCreatures(meta: CardMeta, tier: CardTier, rng: () => number, taskIds: string[], manualPool: ManualWorld[] = []): Creature[] {
  const names = [...CREATURE_NAMES];
  for (let i = names.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [names[i], names[j]] = [names[j], names[i]];
  }
  return CREATURE_SPECS[tier].map((deckSize, i) => {
    const frame = FRAME_BASE[tier] + i;
    const deck: WorldCard[] = [];
    for (let k = 0; k < deckSize; k++) {
      const card = mintDeckCard(meta, tier, rng, taskIds, manualPool);
      card.frame = frame;
      deck.push(card);
    }
    const want = rollWant(tier, rng, i === 0);
    return {
      id: creatureSeq++,
      name: names.pop() ?? 'the other one',
      want,
      deck,
      frame,
    };
  });
}

export function generateEvents(meta: CardMeta, stolen: WorldCard | null, taskIds: string[], manualPool: ManualWorld[] = []): TradeEvent[] {
  const rng = mulberry32((((meta.seed ?? 0) ^ (meta.nextId * 2654435761)) >>> 0));
  const events: TradeEvent[] = (['common', 'uncommon', 'rare'] as CardTier[]).map((tier, i) => ({
    id: i + 1,
    name: EVENT_NAMES[tier],
    tier,
    creatures: rollCreatures(meta, tier, rng, taskIds, manualPool),
  }));
  // The stolen origin card waits at the rare exchange, with the creature whose
  // opening want (a single uncommon) is the easiest to bring it back from.
  if (stolen) events[2].creatures[0].deck.unshift(stolen);
  return events;
}

// The reshuffle: this gathering ends and the next one of the same tier
// arrives — new creatures, new decks (caller persists the meta). Whatever
// the player traded away leaves with the departing creatures, except the
// origin card, which always finds its way to the next table.
export function regenerateEvent(meta: CardMeta, ev: TradeEvent, taskIds: string[], manualPool: ManualWorld[] = []): void {
  const origin = ev.creatures.flatMap((c) => c.deck).find((c) => c.origin) ?? null;
  const rng = mulberry32((((meta.seed ?? 0) ^ (meta.nextId * 48271 + ev.id)) >>> 0));
  ev.creatures = rollCreatures(meta, ev.tier, rng, taskIds, manualPool);
  if (origin) ev.creatures[0].deck.unshift(origin);
}
