export const TICK_HZ = 20;
export const TICK_MS = 1000 / TICK_HZ;
export const TICK_S = 1 / TICK_HZ;

export const CELL = 32;
// World grid is sized to fit the maximum possible play area: the initial
// 24x20 region plus DIG.cells (20) of growth in every direction. Walls fill
// everything outside the current play area, so the visible map starts small.
export const INITIAL_PLAY_COLS = 24;
export const INITIAL_PLAY_ROWS = 20;
export const DIG_GROWTH_CELLS = 12;
export const COLS = INITIAL_PLAY_COLS + DIG_GROWTH_CELLS * 2;
export const ROWS = INITIAL_PLAY_ROWS + DIG_GROWTH_CELLS * 2;
export const WORLD = { width: COLS * CELL, height: ROWS * CELL };
export const WALL_BORDER = 2; // impassable wall thickness at the world's outer edge

// Where the initial play area sits within the larger world (top-left, in cells).
// Centered so dig in any direction has 20 cells of headroom.
export const INITIAL_PLAY_X0 = DIG_GROWTH_CELLS;
export const INITIAL_PLAY_Y0 = DIG_GROWTH_CELLS;
export const CAMERA_SPEED = 700; // px/sec when panning with WASD
export const RENDER_SCALE = 1.3; // visual zoom factor applied to the world layer

// Seconds after the first dig before the pan-hint (WASD/arrows) appears, if
// the player hasn't already panned the camera to bring water into view.
export const WATER_HINT_DELAY_SEC = 4;

// Onboarding hint: nudges the player to spawn + kill goblins. Surfaces when
// either bar passes: 30 s with zero spawns, or 90 s without completing the
// first task (earn Ƶ100, which requires killing goblins).
export const SPAWN_HINT_NO_SPAWN_SEC = 30;
export const SPAWN_HINT_NO_TASK_SEC = 90;

// Drag-select onboarding nudge. Once the player is past the first task, surface
// a "drag to select many" hint if they still haven't done a multi-creature
// drag-select after this many seconds of total play. Sticky once seen.
export const DRAG_SELECT_HINT_DELAY_SEC = 300;

export const GOBLIN = {
  speed: 110,
  radius: 12,
  spawnCost: 0,
  spawnTime: 2,
  arriveDist: 2,
  // Hard ceiling for the spawn-progress track. Per-hole capacity lives on
  // `state.hole.spawnCapacity` and currently doesn't ramp; the headroom is
  // here in case future upgrades raise it.
  concurrentBuildLimit: 40,
  breakdanceAfter: 30, // seconds of continuous idle before goblins start breakdancing
};

// Minotaur — a player-summoned predator. Walks the map, hunts the nearest
// goblin, and gives the same KILL_REWARD per kill as a goblin-on-goblin kill.
// Minotaurs respect building footprints, walls, and the world border when
// stepping; goblin occupancy doesn't block them (they hunt straight through).
export const MINOTAUR = {
  speed: 70,
  radius: 22,
  bloodCost: 8,
  spawnTime: 2,
  spawnCapacity: 1,
  arriveDist: 2,
  attackWindup: 0.5,
  wanderInterval: 1.2,
};

// One-shot Ritual upgrades. Autocommand + Goldblins unlock once a Phone
// Farm has been built; Autospawn unlocks once a Gas Engine has been built.
// "Autocommand": newly-hatched goblins route themselves to understaffed
// buildings. "Autospawn": queues a free spawn every 3 seconds. "Autowater":
// extends Autocommand so idle goblins are also routed onto watering duty —
// unlocks once Autocommand is owned and a water source has been dug.
export const SUMMON_UPGRADES = {
  autoAssign: { bloodCost: 13 },
  autoSpawn: { bloodCost: 13, intervalSeconds: 3 },
  autoWater: { bloodCost: 128 },
  goldgoblins: { bloodCost: 26 },
  goldgoblinsX10: { bloodCost: 128, multiplier: 10 },
};

// Tier ladder for the Autospawn ritual. Each subsequent purchase replaces the
// previous in the menu (level → next entry). Doubling cost per tier.
export const AUTOSPAWN_TIERS: { multiplier: number; bloodCost: number }[] = [
  { multiplier: 1,  bloodCost: 13 },
  { multiplier: 2,  bloodCost: 26 },
  { multiplier: 4,  bloodCost: 52 },
  { multiplier: 8,  bloodCost: 104 },
  { multiplier: 16, bloodCost: 208 },
  { multiplier: 32, bloodCost: 416 },
];

// Dig cost ramps after the first hole — the freebie unlocks the mechanic,
// subsequent digs cost a small fortune so the player can't trivially
// surround everything with water.
export const DIG = {
  firstBloodCost: 100,
  laterBloodCost: 2000,
  cells: DIG_GROWTH_CELLS,
};
// Returns the blood cost of the next dig given the dug-direction set.
export function digBloodCost(dugCount: number): number {
  return dugCount === 0 ? DIG.firstBloodCost : DIG.laterBloodCost;
}

// Water meter — every building with `waterDeliveryAmount` keeps a 0..100
// score that depletes at this rate and is bumped per delivery.
export const WATER_METER_MAX = 100;
export const WATER_DEPLETION_PP_PER_SEC = 10;

// Default per-hole capacity. Each completed Goblin Hole building stacks
// another GOBLIN_HOLE_CAPACITY_PER_BUILDING on top of the base.
export const BASE_SPAWN_CAPACITY = 5;
export const GOBLIN_HOLE_CAPACITY_PER_BUILDING = 5;

// Killing a goblin yields this much money + this much blood.
export const KILL_REWARD = { money: 25, blood: 1 };
// A gold-tinted goblin (rolled at spawn time when Goldgoblins is owned)
// drops a much fatter pile of money on death.
export const GOLD_KILL_REWARD = { money: 250, blood: 1 };
// Probability a fresh goblin is gold-tinted, applied when Goldgoblins is
// owned. Independent per spawn.
export const GOLD_GOBLIN_CHANCE = 0.20;

// Killing a Minotaur (only possible by goring it with another Minotaur)
// drops blood but no money — the player paid summoning blood, this returns
// most of it via the kill but doesn't generate Ƶ.
export const MINOTAUR_KILL_REWARD = { money: 0, blood: 10 };

export type BuildingColors = {
  active: number; activeBorder: number;
  dormant: number; dormantBorder: number;
  constructing: number; constructingBorder: number;
};

export type BuildingDef = {
  name: string;
  short: string;          // short label drawn on the building, e.g. 'DC', 'GW'
  cellSize: number;
  size: number;           // pixel size = cellSize * CELL
  cost: number;
  bloodCost?: number;     // optional secondary cost in blood
  buildersRequired: number;
  buildTime: number;      // seconds
  maintainersRequired: number;
  // Per-delivery water bump (0..100). Set on buildings that drink (DC, HC).
  // The building maintains a 0..100 waterMeter that depletes at
  // WATER_DEPLETION_PP_PER_SEC (or `waterDepletionPerSec` if overridden)
  // and is bumped by this amount each time a carrier completes a
  // source → building round trip. The building counts as watered while
  // the meter is > 0.
  waterDeliveryAmount?: number;
  // Optional per-def override of the global depletion rate (pp/sec). Lets
  // a thirsty endgame building drain faster or a tier-1 sip more gently
  // without changing the global constant.
  waterDepletionPerSec?: number;
  // Auto-assign target — Autocommand will keep this many carriers on the
  // building. Manual right-click ignores the auto cap; `waterCarrierMax`
  // is a soft preference (drinkers below it are picked first) so a single
  // DC won't hoover up every goblin while another building is still dry.
  waterAutoAssignTarget?: number;
  waterCarrierMax?: number;
  income: number;         // Ƶ/sec while active
  powerOutput: number;    // watts: positive = produces, negative = consumes
  wanderInterval: number;
  wanderJitter: number;
  colors: BuildingColors;
};

function def(cellSize: number, rest: Omit<BuildingDef, 'cellSize' | 'size'>): BuildingDef {
  return { cellSize, size: cellSize * CELL, ...rest };
}

export const BUILDING_DEFS = {
  phone_farm: def(3, {
    name: 'Phone Farm',
    short: 'PF',
    cost: 150,
    buildersRequired: 3,
    buildTime: 4,
    maintainersRequired: 3,
    income: 12,
    powerOutput: -200, // 200 W draw
    wanderInterval: 1.4,
    wanderJitter: 0.8,
    colors: {
      active: 0x8a7a3a, activeBorder: 0xeada6a,
      dormant: 0x5a4a3a, dormantBorder: 0xa8985a,
      constructing: 0x3a3f47, constructingBorder: 0x808890,
    },
  }),
  goblin_wheel: def(2, {
    name: 'Goblin Wheel',
    short: 'GW',
    cost: 75,
    buildersRequired: 1,
    buildTime: 5,
    maintainersRequired: 1,
    income: 0,
    powerOutput: 100, // 100 W
    wanderInterval: 0.45,    // runs the wheel quickly
    wanderJitter: 0.15,
    colors: {
      active: 0x3a6a8a, activeBorder: 0x8acfff,
      dormant: 0x3a4a5a, dormantBorder: 0x7a8aa0,
      constructing: 0x3a3f47, constructingBorder: 0x808890,
    },
  }),
  datacentre: def(5, {
    name: 'Datacentre',
    short: 'DC',
    cost: 10_000,
    buildersRequired: 15,
    buildTime: 30,
    maintainersRequired: 15,
    waterDeliveryAmount: 50,
    waterAutoAssignTarget: 2,
    waterCarrierMax: 5,
    // 30% slower than the global default so a single carrier round-trip can
    // keep the DC sated longer.
    waterDepletionPerSec: 7,
    income: 1000,
    powerOutput: -6_000_000, // 6 MW draw
    wanderInterval: 1.4,
    wanderJitter: 0.8,
    colors: {
      active: 0x8a3a3a, activeBorder: 0xff8080,
      dormant: 0x4a3a3a, dormantBorder: 0x8a6a6a,
      constructing: 0x3a3f47, constructingBorder: 0x808890,
    },
  }),
  nuclear_reactor: def(2, {
    name: 'Nuclear Reactor',
    short: 'NR',
    cost: 500_000,
    buildersRequired: 4,
    buildTime: 60,
    maintainersRequired: 4,
    income: 0,
    powerOutput: 1_000_000_000, // 1 GW
    wanderInterval: 1.2,
    wanderJitter: 0.4,
    colors: {
      active: 0x2a6a4a, activeBorder: 0x6affb0,
      dormant: 0x2a4a3a, dormantBorder: 0x5a8a70,
      constructing: 0x3a3f47, constructingBorder: 0x808890,
    },
  }),
  dragon_beacon: def(3, {
    name: 'Dragon Beacon',
    short: 'DB',
    cost: 10_000_000,
    buildersRequired: 5,
    buildTime: 15,
    maintainersRequired: 0,
    income: 0,
    powerOutput: -10_000_000_000, // 10 GW
    wanderInterval: 1.0,
    wanderJitter: 0.2,
    colors: {
      active: 0xffa800, activeBorder: 0xffe080,
      dormant: 0x6a4a1a, dormantBorder: 0xa07840,
      constructing: 0x3a3f47, constructingBorder: 0x808890,
    },
  }),
  wall: def(1, {
    name: 'Wall',
    short: 'W',
    cost: 1,
    buildersRequired: 0,
    buildTime: 0,
    maintainersRequired: 0,
    income: 0,
    powerOutput: 0,
    wanderInterval: 0,
    wanderJitter: 0,
    colors: {
      active: 0x191919, activeBorder: 0x191919,
      dormant: 0x191919, dormantBorder: 0x191919,
      constructing: 0x191919, constructingBorder: 0x191919,
    },
  }),
  hypercentre: def(6, {
    name: 'Hypercentre',
    short: 'HC',
    cost: 500_000,
    buildersRequired: 20,
    buildTime: 30,
    maintainersRequired: 30,
    waterDeliveryAmount: 10,
    waterAutoAssignTarget: 5,
    waterCarrierMax: 15,
    income: 50_000,
    powerOutput: -1_000_000_000, // 1 GW draw
    wanderInterval: 1.6,
    wanderJitter: 0.9,
    colors: {
      active: 0x6a2a8a, activeBorder: 0xc080ff,
      dormant: 0x4a2a5a, dormantBorder: 0x80608a,
      constructing: 0x3a3f47, constructingBorder: 0x808890,
    },
  }),
  gas_engine: def(4, {
    name: 'Gas Engine',
    short: 'GE',
    cost: 1500,
    buildersRequired: 5,
    buildTime: 7.5,
    maintainersRequired: 5,
    income: 0,
    powerOutput: 2_500_000, // 2.5 MW
    wanderInterval: 0.9,
    wanderJitter: 0.3,
    colors: {
      active: 0x3a6aaa, activeBorder: 0x9ac8ef,
      dormant: 0x3a4a5a, dormantBorder: 0x6a7a90,
      constructing: 0x3a3f47, constructingBorder: 0x808890,
    },
  }),
  goblin_hole: def(1, {
    name: 'Goblin Hole',
    short: 'GH',
    cost: 1313,
    buildersRequired: 0,
    buildTime: 4,
    maintainersRequired: 0,
    income: 0,
    powerOutput: 0,
    wanderInterval: 1.0,
    wanderJitter: 0.4,
    colors: {
      active: 0x2a1a2a, activeBorder: 0xa06aff,
      dormant: 0x2a1a2a, dormantBorder: 0x705580,
      constructing: 0x3a3f47, constructingBorder: 0x808890,
    },
  }),
} as const;

export type BuildingKind = keyof typeof BUILDING_DEFS;
export const BUILDABLE_KINDS: BuildingKind[] = ['goblin_wheel', 'gas_engine', 'datacentre', 'phone_farm', 'goblin_hole', 'nuclear_reactor', 'hypercentre', 'dragon_beacon', 'wall'];

export const START_MONEY = 0;
export const START_GOBLINS = 0;
// Place start near the top-left of the playable area, just inside the wall border.
export const START_CELL = { cx: INITIAL_PLAY_X0 + 4, cy: INITIAL_PLAY_Y0 + 8 };

export function formatPower(w: number): string {
  const abs = Math.abs(w);
  if (abs >= 1e9) return `${(Math.floor(w / 1e9 * 100) / 100).toFixed(2)} GW`;
  if (abs >= 1e6) return `${(Math.floor(w / 1e6 * 100) / 100).toFixed(2)} MW`;
  return `${Math.floor(w)} W`;
}
