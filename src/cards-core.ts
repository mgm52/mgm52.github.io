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
  // The gatekeeper's wares: a key card (a picture of a key, no world behind
  // it — `data` is empty). `tier` is the gathering it was minted at (for the
  // card's look); `keyDepth` + `keyBranch` name the one salon the key actually
  // opens — the door up out of the salon that minted it, on that salon's own
  // branch. Key cards never satisfy a normal want, so they can only ever be
  // spent on that one door. `keyBranch` is absent on keys minted before the
  // hall of doors existed (they all belong to branch 0).
  key?: boolean;
  keyDepth?: number;
  keyBranch?: number;
  // A charm card: a keepsake, not a world (`data` is empty, like a key). While
  // it sits in the player's hand, every world they ENTER is blessed with its
  // effect (applyCharms). Charms never satisfy a want, so once held they're
  // held for good.
  charm?: CharmKind;
};

// ─── Charms ──────────────────────────────────────────────────────────
// Passive keepsakes that ride in the hand: entering any owned world applies
// every held charm's blessing to it (idempotent sticky flags, so re-entry
// never double-applies). They're minted into trader decks — sometimes
// procedurally, once by hand at level 2 — and can never be traded away.
export type CharmKind = 'gold' | 'hands' | 'rain' | 'storm' | 'tiny';
export const CHARM_KINDS: CharmKind[] = ['gold', 'hands', 'rain', 'storm', 'tiny'];
// `line` is the one-liner on the card face; `desc` is the full reading,
// shown by the card's READ button (cards.ts showCharmRead) — it should spell
// out what the blessing actually does, in the realm's own voice.
export const CHARM_DEFS: Record<CharmKind, { name: string; line: string; glyph: string; desc: string }> = {
  gold: {
    name: 'the gilded charm', line: 'spawns sometimes glitter', glyph: '✺',
    desc: 'carry it into a world and the hole starts minting the occasional golden goblin. gold goblins live like any other, but their heads come off worth a clean Ƶ250. the charm does not ask how you feel about that.',
  },
  hands: {
    name: 'the busy charm', line: 'goblins find their own work', glyph: '✛',
    desc: 'carry it into a world and idle goblins stop waiting to be told: fresh hands walk themselves to whatever needs staffing. the overseers it replaces are said to feel ornamental.',
  },
  rain: {
    name: 'the wet charm', line: 'thirsty buildings water themselves', glyph: '☂',
    desc: 'carry it into a world and nothing under it runs dry: carriers fetch water for thirsty buildings without being asked, and busy hands come folded in — the rain insists on them.',
  },
  storm: {
    name: 'the storm charm', line: 'the sky answers', glyph: 'ϟ',
    desc: 'carry it into a world and the sky is yours to point: the lightning strike stands ready, no ritual owed. mind where you aim it — reactors remember being struck.',
  },
  tiny: {
    name: 'the little charm', line: 'minotaurs come out small', glyph: '♟',
    desc: 'carry it into a world and its minotaurs arrive small — same temper, same appetite for work, a fraction of the stature. they do not like being called cute.',
  },
};

export function makeCharmCard(meta: CardMeta, tier: CardTier, kind: CharmKind): WorldCard {
  return {
    id: meta.nextId++,
    name: CHARM_DEFS[kind].name,
    tier,
    data: '',
    resources: { money: 0, blood: 0, dragonBone: 0 },
    charm: kind,
  };
}

// Bless a world with every charm in the hand. All effects are sticky unlock
// flags the sim already understands (generated worlds set the same ones), so
// applying them on every entry is safe.
export function applyCharms(st: GameState, hand: WorldCard[]): void {
  for (const c of hand) {
    if (!c.charm) continue;
    switch (c.charm) {
      case 'gold': st.goldgoblinsEnabled = true; break;
      case 'hands': st.autoAssignEnabled = true; break;
      case 'rain': st.autoAssignEnabled = true; st.autoWaterEnabled = true; break;
      case 'storm': st.lightningUnlocked = true; break;
      case 'tiny': st.tinytaurUnlocked = true; break;
    }
  }
}

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
  // A key isn't a world — it can't be handed to any trader (only spent on a
  // door), so it never satisfies a want, not even an open "any one world".
  // Charms are keepsakes, likewise never tradeable.
  if (card.key || card.charm) return false;
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

// A trade must never strip the player of every actual world — handing the
// last one to a gatekeeper for a key (which can't be traded back) would
// soft-lock the realm. Legal only if, once the given cards leave and the
// trader's deck arrives, at least one non-key, non-charm world remains.
export function tradeKeepsAWorld(hand: WorldCard[], given: WorldCard[], received: WorldCard[]): boolean {
  const givenIds = new Set(given.map((c) => c.id));
  return hand.filter((c) => !givenIds.has(c.id)).concat(received).some((c) => !c.key && !c.charm);
}

// The trader's advertised line, split into segments — the `b` (bold) ones are
// the actual requirement (the rarity, the count, the resource threshold).
export type WantSeg = { t: string; b?: boolean };
export function wantSegments(w: Want): WantSeg[] {
  if (w.kind === 'any') {
    return w.count === 1
      ? [{ t: 'i will take ' }, { t: 'any', b: true }, { t: ' world.' }]
      : [{ t: 'i want ' }, { t: `any ${countWord(w.count)}`, b: true }, { t: ` ${worldsWord(w.count)}.` }];
  }
  if (w.kind === 'tier') {
    return w.count === 1
      ? [{ t: 'i want any ' }, { t: w.tier, b: true }, { t: ' world.' }]
      : [{ t: 'i want ' }, { t: `${countWord(w.count)} ${w.tier}`, b: true }, { t: ` ${worldsWord(w.count)}.` }];
  }
  const amt = Math.floor(w.amount).toLocaleString('en-US');
  const desc = w.res === 'money' ? `worth Ƶ${amt}+`
    : w.res === 'blood' ? `with ${amt}+ blood`
    : w.res === 'dragonBone' ? `keeping ${amt}+ bones`
    : `making ${formatPower(w.amount)}+`;
  return w.count === 1
    ? [{ t: 'i want a world ' }, { t: desc, b: true }, { t: '.' }]
    : [{ t: 'i want ' }, { t: `${countWord(w.count)} worlds`, b: true }, { t: ` ${desc}.` }];
}
export function wantLine(w: Want): string {
  return wantSegments(w).map((s) => s.t).join('');
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
  // Some traders want more than one card, all meeting the same condition.
  const count = rng() < 0.55 ? 1 : rng() < 0.7 ? 2 : 3;
  if (rng() < 0.5) return { kind: 'tier', tier, count };
  const band = WANT_BANDS[tier];
  const resOptions = (Object.keys(band) as ('money' | 'blood' | 'dragonBone' | 'power')[]);
  const res = resOptions[Math.floor(rng() * resOptions.length)];
  const [lo, hi] = band[res]!;
  return { kind: 'resource', res, amount: spicyAmount(lo, hi, rng), count };
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
// only way the collection grows. `branch` is which door in the hall this
// salon's chain hangs behind (absent on salons saved before the hall of
// doors existed — those are all branch 0).
export type TradeEvent = { id: number; name: string; tier: CardTier; depth: number; branch?: number; creatures: Creature[] };

// One door in the hall: its own chain of salons (grown lazily, like the
// original single chain) and how far down it the player has opened doors.
export type BranchState = { events: TradeEvent[]; unlockedDepth: number };

export type CardMeta = {
  v: 1;
  // 'intro'     — until the white goblin has run the forced first trade.
  // 'firstworld' — the swindle is done; the player holds the one traded card
  //               and the realm holds them on its big-card view until they
  //               ENTER it (their first time inside a card world).
  // 'free'      — the gatherings are open; normal play.
  phase: 'intro' | 'firstworld' | 'free';
  // Legacy: tiers the player had unlocked the door up to. Superseded by
  // unlockedDepth (loadMeta migrates it); kept only so old saves still read.
  unlockedTiers?: CardTier[];
  // Legacy: the single chain's unlock counter, from before the hall of doors.
  // ensureBranches migrates it into branches[0].unlockedDepth; kept only so
  // old saves still read.
  unlockedDepth?: number;
  // The hall of doors: every starter door the player has unsealed, each with
  // its own chain of salons. Grown one door at a time from the hub, without
  // end. Absent until ensureBranches migrates the legacy single chain (or
  // the intro seeds branch 0).
  branches?: BranchState[];
  // How many of the hall's doors stand unsealed. Doors unseal in order, so
  // the first `doorsUnsealed` branches are open and everything past them
  // waits sealed — the realm STARTS at 0, every door shut, the first
  // unsealing the player's own act. A branch's chain can exist seeded while
  // its door is still shut (the intro deals branch 0 a home for the stolen
  // origin). Absent on metas from before the hall started sealed: those
  // count every existing branch as unsealed.
  doorsUnsealed?: number;
  // When the last starter door was unsealed (ms epoch). A fresh seal takes a
  // while to give — the hub holds the next door on a countdown from this
  // stamp (cards.ts UNSEAL_COOLDOWN_MS). Absent until the first unsealing.
  lastUnsealAt?: number;
  // How many times the player has reset the realm back to a single door.
  // 0/absent means the opening hand-authored chain is still up — branch 0's
  // levels 1–3 pre-set, level 3 a deliberate wall. From the first reset
  // onward every salon rolls procedurally.
  resets?: number;
  // The reset sigil has been introduced (the player has stood in the level-3
  // dead end). Once true it shows in every salon.
  resetSeen?: boolean;
  // Per-playthrough entropy mixed into every gathering roll. Without it the
  // event RNG keyed on nextId alone, and nextId is identical for every
  // player at the moment the tables are first dealt — so everyone met the
  // same first trader. Optional only for metas saved before it existed
  // (loadMeta stamps those).
  seed?: number;
  nextId: number;
  cards: WorldCard[];
  // Legacy: the single endless chain, from before the hall of doors. Null
  // until the intro; ensureBranches migrates it into branches[0] and leaves
  // this null. Kept only so old saves still read.
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
    st.blood = [ri(16, 60), ri(1_200, 8_000), ri(240_000, 800_000)][T];
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

  // Never deal a world with a meaningless trickle of a resource: cash is
  // either none or a real Ƶ100+, blood either none or a real 16+.
  if (st.money > 0 && st.money < 100) st.money = 0;
  if (st.blood > 0 && st.blood < 16) st.blood = 0;

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

// The power number written on a card: only what the world's POWERED buildings
// are actually generating. A generator counts solely while it's online (active
// — staffed and on the grid); a dormant reactor sitting idle on the lawn adds
// nothing. So a world that has never run, or runs with every generator
// dormant, reads no power — the card reports the real output, not the
// theoretical sum of every generator placed.
export function cardPower(st: GameState): number {
  let power = 0;
  for (const b of st.buildings.values()) {
    if (b.state !== 'active') continue;
    const out = BUILDING_DEFS[b.kind].powerOutput;
    if (out > 0) power += out;
  }
  // Orbited generators run upkeep-free, so any that finished assembly are
  // always powered.
  for (const sb of st.spaceBuildings.values()) {
    if (st.buildings.has(sb.id)) continue;
    if (sb.building.state !== 'active') continue;
    const out = BUILDING_DEFS[sb.building.kind].powerOutput;
    if (out > 0) power += out;
  }
  return power;
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

// ─── The salons ──────────────────────────────────────────────────────
// A salon seats a few traders, all on screen at once; every trader advertises
// ONE want and, satisfied, gives its WHOLE deck for the card(s) the want
// names. The way the collection grows is finding a want you can meet.
//
// The salons hang behind the HALL OF DOORS: a base-level hub of starter
// doors, unsealed one at a time without end. Each door opens onto its own
// endless chain — salon 0 the gentle common threshold (level 1; the player's
// level is depth + 1, climbing one per door), the next few uncommon, and
// everything from RARE_DEPTH down a rare exchange — and each salon but the
// way you came holds a gatekeeper whose key opens the locked door onward to
// the next. A chain that runs dry is not the end: walk back down to the hall,
// unseal the next starter door, and climb again from commons. Until the
// player's first reset branch 0's chain is hand-authored (makeHardcodedSalon:
// levels 1–3, level 3 a deliberate wall — its rare asks are only meetable by
// carrying rares home from ANOTHER door's deep salons); after it, every salon
// rolls procedurally. Every procedural salon's opener keeps an easy want so a
// chain is never hard-locked at the door; for everything else there's the
// next door in the hall, the reset, and the dev reshuffle.

// Migrate the legacy single chain into the hall: branches[0] adopts the old
// events + unlockedDepth verbatim (so a pre-hall save resumes exactly where
// it was, its chain now hanging behind door 1). Returns the branches array —
// empty until the intro has seeded branch 0.
export function ensureBranches(meta: CardMeta): BranchState[] {
  if (!meta.branches) {
    meta.branches = meta.events
      ? [{ events: meta.events, unlockedDepth: meta.unlockedDepth ?? 0 }]
      : [];
    for (const ev of meta.branches[0]?.events ?? []) ev.branch = 0;
    meta.events = null;
  }
  return meta.branches;
}

// The salon depth that holds the player's stolen origin world — the fixed
// "win your world back" rung along branch 0. Pre-reset this is the level-3
// wall: the world sits there visible, winnable only with rares carried home
// from another door's chain.
export const STOLEN_DEPTH = 2;

// The depth a chain turns rare at. Every chain escalates the same way: its
// threshold (depth 0) trades common — the gentle bootstrap whose lone trader
// holds two cards, doubling the first trade — the next few salons trade
// uncommon, and everything from here down is a rare exchange.
export const RARE_DEPTH = 4;
export function salonTierForDepth(depth: number): CardTier {
  return depth <= 0 ? 'common' : depth < RARE_DEPTH ? 'uncommon' : 'rare';
}

// Every chain needs names. Branch 0's threshold is always the soft border;
// each later door's threshold gets its own stable "the X threshold" (the
// adjectives dealt without repeats until the list runs out, so the hall's
// doors read distinct), and deeper salons get a stable procedural name seeded
// by the playthrough seed, the branch and the depth, so revisiting one reads
// the same name every time.
const SALON_ADJ = ['velvet', 'hollow', 'gilded', 'quiet', 'crooked', 'amber', 'sunken', 'porcelain', 'marble', 'candlelit', 'glass', 'copper', 'ivory', 'listening', 'patient', 'folded', 'low', 'far', 'dim', 'smoke'];
export function pathName(seed: number, branch: number): string {
  if (branch <= 0) return 'the soft border';
  const rng = mulberry32((((seed ?? 0) ^ 0x51ed270b) >>> 0));
  const adjs = [...SALON_ADJ];
  for (let i = adjs.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [adjs[i], adjs[j]] = [adjs[j], adjs[i]];
  }
  const adj = adjs[(branch - 1) % adjs.length];
  const lap = Math.floor((branch - 1) / adjs.length);
  return lap === 0 ? `the ${adj} threshold` : `the ${adj} threshold ${lap + 1}`;
}
export function salonName(seed: number, depth: number, branch = 0): string {
  if (depth <= 0) return `gathering at ${pathName(seed, branch)}`;
  const rng = mulberry32((((seed ?? 0) ^ (depth * 2654435761) ^ (branch * 0x27d4eb2d)) >>> 0));
  return `the ${SALON_ADJ[Math.floor(rng() * SALON_ADJ.length)]} salon`;
}

// The gatekeeper's single ware: a key card. It carries no world (`data` is
// empty). `tier` gives the card its look; `keyDepth` + `keyBranch` name the
// salon the key opens — the door up out of the salon that minted it (a key
// minted at salon d of a branch opens that branch's door to salon d+1). Key
// cards never satisfy a want (cardQualifies), so they can only be spent on
// that door, never re-traded.
export function makeKeyCard(meta: CardMeta, tier: CardTier, keyDepth?: number, keyBranch?: number): WorldCard {
  return {
    id: meta.nextId++,
    name: 'a key',
    tier,
    data: '',
    resources: { money: 0, blood: 0, dragonBone: 0 },
    key: true,
    keyDepth,
    keyBranch,
  };
}

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
export function rollCreatures(meta: CardMeta, tier: CardTier, branch: number, depth: number, rng: () => number, taskIds: string[], manualPool: ManualWorld[] = []): Creature[] {
  const names = [...CREATURE_NAMES];
  for (let i = names.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [names[i], names[j]] = [names[j], names[i]];
  }
  const creatures: Creature[] = CREATURE_SPECS[tier].map((deckSize, i) => {
    const frame = FRAME_BASE[tier] + i;
    const deck: WorldCard[] = [];
    for (let k = 0; k < deckSize; k++) {
      const card = mintDeckCard(meta, tier, rng, taskIds, manualPool);
      card.frame = frame;
      deck.push(card);
    }
    // A picky trader sometimes tucks a charm in with its worlds — a keepsake
    // that blesses every world its holder enters (applyCharms) and can never
    // be traded away.
    if (i > 0 && rng() < 0.25) {
      const charm = makeCharmCard(meta, tier, CHARM_KINDS[Math.floor(rng() * CHARM_KINDS.length)]);
      charm.frame = frame;
      deck.push(charm);
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
  // Every salon seats a gatekeeper too: it offers a single key card for any one
  // world — the key that opens the locked door up to the NEXT salon (depth+1,
  // on this salon's own branch). Every chain is endless, so every salon has a
  // door onward.
  creatures.push({
    id: creatureSeq++,
    name: 'the gatekeeper',
    want: { kind: 'any', count: 1 },
    deck: [makeKeyCard(meta, tier, depth + 1, branch)],
  });
  return creatures;
}

// ─── The opening chain (branch 0, levels 1–3) ────────────────────────
// Until the player's first reset branch 0's chain is hand-authored. Levels 1
// and 2 are a curated on-ramp (level 2's opener carries the charm that
// introduces charms). Level 3 is a wall on purpose: nothing the opening chain
// itself deals — no rare, nobody's Ƶ1e12 — meets any want there (the stolen
// origin world sits in this very salon's opener deck: visible, out of reach).
// The wall is what teaches the hall: unseal another starter door, climb its
// chain to the rare exchanges, and carry rares home — or stand in the dead
// end long enough for it to introduce the reset instead.
export const HARDCODED_LEVELS = 3;

export function makeHardcodedSalon(meta: CardMeta, depth: number, rng: () => number, taskIds: string[], manualPool: ManualWorld[] = []): TradeEvent {
  const tier = salonTierForDepth(depth);
  const mint = (t: CardTier, frame: number, n: number): WorldCard[] => {
    const deck: WorldCard[] = [];
    for (let k = 0; k < n; k++) {
      const card = mintDeckCard(meta, t, rng, taskIds, manualPool);
      card.frame = frame;
      deck.push(card);
    }
    return deck;
  };
  const gatekeeper = (want: Want): Creature => ({
    id: creatureSeq++,
    name: 'the gatekeeper',
    want,
    deck: [makeKeyCard(meta, tier, depth + 1, 0)],
  });
  let creatures: Creature[];
  if (depth === 0) {
    // Level 1: the current soft border, pinned — the open-want doubler and a
    // gatekeeper who takes any world.
    creatures = [
      { id: creatureSeq++, name: 'the pale one', want: { kind: 'any', count: 1 }, deck: mint('common', FRAME_BASE.common, 2), frame: FRAME_BASE.common },
      gatekeeper({ kind: 'any', count: 1 }),
    ];
  } else if (depth === 1) {
    // Level 2: a ladder the player climbs with the single common they arrive
    // holding — tall friend turns it into an uncommon (plus the gilded charm,
    // introducing charms), the collector doubles that uncommon, and the spare
    // buys the gatekeeper's key. The collector MUST be the growing trade
    // here: both gatekeepers cost a world, and the pale one's +1 alone can't
    // fund them both (see the beatability test in tests/cards-core.test.ts —
    // every legal trade order reaches level 3).
    const openerDeck = mint('uncommon', FRAME_BASE.uncommon, 1);
    const charm = makeCharmCard(meta, tier, 'gold');
    charm.frame = FRAME_BASE.uncommon;
    openerDeck.push(charm);
    creatures = [
      { id: creatureSeq++, name: 'tall friend', want: { kind: 'tier', tier: 'common', count: 1 }, deck: openerDeck, frame: FRAME_BASE.uncommon },
      { id: creatureSeq++, name: 'the collector', want: { kind: 'tier', tier: 'uncommon', count: 1 }, deck: mint('uncommon', FRAME_BASE.uncommon + 1, 2), frame: FRAME_BASE.uncommon + 1 },
      gatekeeper({ kind: 'any', count: 1 }),
    ];
  } else {
    // Level 3: the wall. The magistrate holds the stolen origin world
    // (generateEvents seats it in this opener's deck) behind a fortune nobody
    // has; the others want rare worlds this chain never deals. Even the
    // gatekeeper — so nothing here budges until the player has climbed some
    // OTHER door's chain to its rare exchanges and carried rares home (or
    // stood in the dead end long enough to be shown the reset).
    creatures = [
      { id: creatureSeq++, name: 'the magistrate', want: { kind: 'resource', res: 'money', amount: 1_000_000_000_000, count: 1 }, deck: mint('uncommon', FRAME_BASE.uncommon, 1), frame: FRAME_BASE.uncommon },
      { id: creatureSeq++, name: 'the white knuckle', want: { kind: 'tier', tier: 'rare', count: 3 }, deck: mint('uncommon', FRAME_BASE.uncommon + 1, 2), frame: FRAME_BASE.uncommon + 1 },
      gatekeeper({ kind: 'tier', tier: 'rare', count: 1 }),
    ];
  }
  return { id: depth + 1, depth, branch: 0, name: salonName(meta.seed ?? 0, depth), tier, creatures };
}

// Roll a single salon at a branch + depth (its name, tier, traders +
// gatekeeper). Before the first reset branch 0's opening levels come from the
// hand-authored chain; every other salon — deeper, or behind a later door —
// is procedural.
export function makeSalon(meta: CardMeta, branch: number, depth: number, rng: () => number, taskIds: string[], manualPool: ManualWorld[] = []): TradeEvent {
  if (branch === 0 && (meta.resets ?? 0) === 0 && depth < HARDCODED_LEVELS) {
    return makeHardcodedSalon(meta, depth, rng, taskIds, manualPool);
  }
  const tier = salonTierForDepth(depth);
  return {
    // Unique across the hall (regenerateEvent mixes it into its rng); branch
    // 0 keeps the legacy depth+1 ids.
    id: branch * 1000 + depth + 1,
    depth,
    branch,
    name: salonName(meta.seed ?? 0, depth, branch),
    tier,
    creatures: rollCreatures(meta, tier, branch, depth, rng, taskIds, manualPool),
  };
}

// Branch 0's initial salons: the chain from the soft border down to the salon
// that holds the stolen origin world. Deeper salons — and every later door's
// chain — are rolled lazily as the player reaches them (see cards.ts salonAt).
export function generateEvents(meta: CardMeta, stolen: WorldCard | null, taskIds: string[], manualPool: ManualWorld[] = []): TradeEvent[] {
  const rng = mulberry32((((meta.seed ?? 0) ^ (meta.nextId * 2654435761)) >>> 0));
  const events: TradeEvent[] = [];
  for (let depth = 0; depth <= STOLEN_DEPTH; depth++) {
    events.push(makeSalon(meta, 0, depth, rng, taskIds, manualPool));
  }
  // The stolen origin card waits at the fixed stolen-world salon, in its
  // opener's deck. Pre-reset that opener is the level-3 magistrate, meetable
  // only with another chain's rares; after the first reset the procedural
  // opener keeps the easy want, so it's winnable with a plain common.
  if (stolen) events[STOLEN_DEPTH].creatures[0].deck.unshift(stolen);
  return events;
}

// The reset: back to a single door, every salon refreshed, every door locked
// again. The player's hand is untouched — only the hall resets, its later
// doors sealed back up. Introduced by the level-3 dead end; the first reset
// is also the moment the salons go properly procedural (resets leaves 0), so
// the wall never comes back. The stolen origin world, if still untraded
// anywhere in the hall, rides into the fresh chain.
export function resetChain(meta: CardMeta, taskIds: string[], manualPool: ManualWorld[] = []): void {
  const branches = ensureBranches(meta);
  const origin = branches.flatMap((b) => b.events).flatMap((e) => e.creatures).flatMap((c) => c.deck).find((c) => c.origin) ?? null;
  meta.resets = (meta.resets ?? 0) + 1;
  meta.unlockedDepth = 0;
  meta.branches = [{ events: generateEvents(meta, origin, taskIds, manualPool), unlockedDepth: 0 }];
  // The hall seals all the way back up — even door 1 — and the seal is dry:
  // beginning again never leaves the player staring at a countdown.
  meta.doorsUnsealed = 0;
  delete meta.lastUnsealAt;
}

// The reshuffle: this salon ends and a fresh one at the same depth arrives —
// new creatures, new decks (caller persists the meta). Whatever the player
// traded away leaves with the departing creatures, except the origin card,
// which always finds its way to the next table.
export function regenerateEvent(meta: CardMeta, ev: TradeEvent, taskIds: string[], manualPool: ManualWorld[] = []): void {
  const origin = ev.creatures.flatMap((c) => c.deck).find((c) => c.origin) ?? null;
  const rng = mulberry32((((meta.seed ?? 0) ^ (meta.nextId * 48271 + ev.id)) >>> 0));
  ev.creatures = rollCreatures(meta, ev.tier, ev.branch ?? 0, ev.depth, rng, taskIds, manualPool);
  if (origin) ev.creatures[0].deck.unshift(origin);
}
