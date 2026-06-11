// ─── Trading-card realm: core logic ──────────────────────────────────
// The DOM-free half of the post-finale trading-card section (cards.ts holds
// the realm UI, persistence, and the enter/leave-world plumbing). Everything
// here is pure data-in/data-out — card tiers and ascension demands, trade
// rules, gathering generation, and the weird-world generator — so it can be
// unit-tested in node (see tests/cards-core.test.ts) without a browser.

import * as devalue from 'devalue';
import { compressToUTF16, decompressFromUTF16 } from 'lz-string';
import {
  BUILDING_DEFS, BuildingKind, CELL, SOUL_SIGIL, SPACE,
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
export type UpgradeReq = { res: 'money' | 'blood' | 'dragonBone' | 'power'; amount: number };

// The headline numbers written on a card. `power` is the world's last
// measured production in watts (0 until its buildings have actually run);
// optional for metas saved before it existed.
export type CardResources = { money: number; blood: number; dragonBone: number; power?: number };

export type WorldCard = {
  id: number;
  name: string;
  tier: CardTier;
  // The world itself: compressToUTF16(devalue.stringify(GameState)). Updated
  // each time the player leaves the world.
  data: string;
  // Headline numbers written on the card; refreshed alongside `data`.
  resources: CardResources;
  // Ascension demand for the next tier (see UpgradeReq). Null at rare.
  upgradeReq?: UpgradeReq | null;
  // The player's own stolen pre-finale world — winnable back at gathering III.
  origin?: boolean;
  // Border-pattern index (index.html's .wcf-N rules) of the trader whose
  // hand minted this card. It stays with the card through every trade, so
  // where a card came from reads at a glance; player-minted cards (the
  // origin, the junk replacement) carry none and keep the plain frame.
  frame?: number;
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

// `frame` is the creature's own card-border pattern (see WorldCard.frame);
// optional only because metas saved before frames existed lack it (cards.ts
// stamps the missing values on load).
export type Creature = { id: number; name: string; appetite: Appetite; deck: WorldCard[]; frame?: number };

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
// Two flavors are CHALLENGES — the world is a small puzzle and its
// ascension demand (challengeReq) names the puzzle's goal:
//  - seance:      a bad power source stands ready, the bank holds exactly a
//                 five-candle séance; the demand is the power only a fully
//                 soul-fed sigil can produce. Spawn them, kill them, seat them.
//  - overcharged: reactors everywhere, no cash — the opening money grind
//                 replayed without ever worrying about generators (its work
//                 track resets to the very start to match).
//  - haunted:     hell is full; the surface is thin
export type WorldFlavor = 'balanced' | 'bloodbath' | 'mint' | 'boneyard' | 'monoculture' | 'crowd' | 'seance' | 'overcharged' | 'haunted';
export const WORLD_FLAVORS: WorldFlavor[] = ['balanced', 'bloodbath', 'mint', 'boneyard', 'monoculture', 'crowd', 'seance', 'overcharged', 'haunted'];

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

// Roll a card's ascension demand for its CURRENT tier, shaped by what the
// world already holds. The demand leans INTO a world's spike — a blood farm
// is asked for more blood, a mint for more cash — at 2–4× its current
// holding, so a freshly-rolled card is never born already met and growing a
// world means growing its identity. Spike-blind floors keep the climb a real
// session even in a world that starts from nothing. Bones can only be
// demanded of a world that already keeps bones; power only at uncommon
// (reactors are mid-game toys).
export function rollUpgradeReq(tier: CardTier, rng: () => number, resources: CardResources): UpgradeReq | null {
  const ri = (a: number, b: number) => a + Math.floor(rng() * (b - a + 1));
  if (tier === 'rare') return null;
  const bands: Partial<Record<UpgradeReq['res'], [number, number]>> = tier === 'common'
    ? { money: [5_000, 15_000], blood: [200, 800] }
    : { money: [250_000, 1_000_000], blood: [5_000, 20_000], dragonBone: [3, 10], power: [1_000_000_000, 3_000_000_000] };
  const candidates: UpgradeReq['res'][] = ['money', 'blood'];
  if (tier === 'uncommon') {
    if (resources.dragonBone > 0 && rng() < 0.5) candidates.push('dragonBone');
    if (rng() < 0.25) candidates.push('power');
  }
  // Bias toward the world's dominant holding (relative to its band ceiling).
  let dominant: UpgradeReq['res'] = 'money';
  let dominance = -1;
  for (const res of candidates) {
    if (res === 'power') continue; // production is measured later, not held
    const [, hi] = bands[res]!;
    const score = (resources[res] ?? 0) / hi;
    if (score > dominance) { dominance = score; dominant = res; }
  }
  const res = dominance > 0 && rng() < 0.65 ? dominant : candidates[Math.floor(rng() * candidates.length)];
  const [lo, hi] = bands[res]!;
  let amount = ri(lo, hi);
  // Lean past the spike: never born met, always 2–4× the current holding.
  const have = resources[res] ?? 0;
  if (have * 2 > amount) amount = Math.ceil(have * (2 + rng() * 2));
  return { res, amount };
}

export function reqMet(card: WorldCard): boolean {
  const r = card.upgradeReq;
  return !!r && (card.resources[r.res] ?? 0) >= r.amount;
}

// Ascend a card one tier (caller checks reqMet and persists the meta) and
// roll its next demand against the world's current holdings.
export function ascendCard(meta: CardMeta, card: WorldCard): void {
  const next = TIER_ABOVE[card.tier];
  if (!next) return;
  card.tier = next;
  const rng = mulberry32((card.id * 1103515245 + meta.nextId) >>> 0);
  card.upgradeReq = rollUpgradeReq(next, rng, card.resources);
}

// The challenge flavors write their own ascension demand — the world IS a
// puzzle, and the demand names its goal instead of rolling a resource band:
// a séance asks for the power only a full, soul-fed sigil reaches (1 W base
// × 66⁵ from five weak souls ≈ 1.25 GW, so 1 GW means all five chairs); an
// overcharged world asks for plain cash, the only thing it lacks.
export function challengeReq(flavor: WorldFlavor, tier: CardTier, rng: () => number): UpgradeReq | null {
  if (tier === 'rare') return null;
  if (flavor === 'seance') return { res: 'power', amount: 1_000_000_000 };
  if (flavor === 'overcharged') {
    const [lo, hi] = tier === 'common' ? [5_000, 15_000] : [250_000, 1_000_000];
    return { res: 'money', amount: lo + Math.floor(rng() * (hi - lo + 1)) };
  }
  return null;
}

export function makeCard(meta: CardMeta, tier: CardTier, rng: () => number, taskIds: string[], junk = false): WorldCard {
  const seed = Math.floor(rng() * 0xffffffff);
  // The flavor is picked here (not left to the world generator's internal
  // roll) so the challenge flavors can pin their demand below.
  const flavor = WORLD_FLAVORS[Math.floor(rng() * WORLD_FLAVORS.length)];
  const st = junk ? generateJunkWorld(seed, taskIds) : generateWeirdWorld(seed, tier, taskIds, flavor);
  const resources: CardResources = {
    money: st.money, blood: st.blood, dragonBone: st.dragonBone,
    power: cardPower(st),
  };
  return {
    id: meta.nextId++,
    name: worldName(rng),
    tier,
    data: encodeWorld(st),
    resources,
    // The junk card's ascension demand is pinned to plain cash so the
    // player's first climb out of the dirt has a legible goal; challenge
    // flavors pin theirs to the puzzle's own finish line.
    upgradeReq: junk
      ? { res: 'money', amount: 10_000 }
      : challengeReq(flavor, tier, rng) ?? rollUpgradeReq(tier, rng, resources),
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
// The tables grow with the tiers — one creature at the soft border, two at
// the salon, three at the rare exchange — and stay small-handed so no view
// ever overwhelms. The first creature anywhere considers anything; the rest
// are picky. The common gathering's lone creature holds TWO cards, making it
// the first arc's two-for-one partner (ascend the junk common, break the
// uncommon down into its two cards, ascend both halves); at richer tables
// the first creature holds one card and the picky ones hold two.
const CREATURE_SPECS: Record<CardTier, number[]> = {
  common: [2],
  uncommon: [1, 2],
  rare: [1, 2, 2],
};
export function rollCreatures(meta: CardMeta, tier: CardTier, rng: () => number, taskIds: string[]): Creature[] {
  const names = [...CREATURE_NAMES];
  const appetites: Appetite[] = ['blood', 'rich', 'bones'];
  for (const arr of [names, appetites] as unknown[][]) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  }
  return CREATURE_SPECS[tier].map((deckSize, i) => {
    const frame = FRAME_BASE[tier] + i;
    const deck: WorldCard[] = [];
    for (let k = 0; k < deckSize; k++) {
      const card = makeCard(meta, tier, rng, taskIds);
      card.frame = frame;
      deck.push(card);
    }
    return {
      id: creatureSeq++,
      name: names.pop() ?? 'the other one',
      appetite: i === 0 ? 'any' as const : appetites.pop() ?? 'any' as const,
      deck,
      frame,
    };
  });
}

export function generateEvents(meta: CardMeta, stolen: WorldCard | null, taskIds: string[]): TradeEvent[] {
  const rng = mulberry32((((meta.seed ?? 0) ^ (meta.nextId * 2654435761)) >>> 0));
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
  const rng = mulberry32((((meta.seed ?? 0) ^ (meta.nextId * 48271 + ev.id)) >>> 0));
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
// Is the creature open to trading for this card at all? Appetite gates
// same-tier swaps (preference between equals); a card one tier above its
// stock is universally coveted — every creature with two lesser cards will
// break it down, whatever its tastes. This keeps the ascend → break down →
// ascend-both arc open at every table.
export function creatureOpenTo(c: Creature, card: WorldCard): boolean {
  return (appetiteAccepts(c.appetite, card) && sameTierGives(c, card).length > 0)
    || breakdownGives(c, card).length > 0;
}
