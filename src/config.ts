export const TICK_HZ = 20;
export const TICK_MS = 1000 / TICK_HZ;
export const TICK_S = 1 / TICK_HZ;

export const CELL = 32;
export const COLS = 24;
export const ROWS = 20;
export const WORLD = { width: COLS * CELL, height: ROWS * CELL };
export const WALL_BORDER = 2; // impassable wall thickness in cells around play area
export const CAMERA_SPEED = 700; // px/sec when panning with WASD
export const RENDER_SCALE = 1.3; // visual zoom factor applied to the world layer

export const GOBLIN = {
  speed: 110,
  radius: 12,
  spawnCost: 0,
  spawnTime: 2,
  arriveDist: 2,
  // Hard ceiling for the spawn-progress track. Per-hole capacity lives on
  // `state.hole.spawnCapacity` and currently doesn't ramp; the headroom is
  // here in case future upgrades raise it.
  concurrentBuildLimit: 12,
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
  spawnTime: 5,
  spawnCapacity: 1,
  arriveDist: 2,
  attackWindup: 0.5,
  wanderInterval: 1.2,
};

// One-shot Ritual upgrades. Autotask + Goblinsixstack unlock once a Phone
// Farm has been built; Autospawn unlocks once a Gas Engine has been built.
// "Autotask": newly-hatched goblins route themselves to understaffed
// buildings. "Goblinsixstack": permanent capacity bump (3 → 6).
// "Autospawn": queues a free spawn every 3 seconds.
export const SUMMON_UPGRADES = {
  autoAssign: { bloodCost: 13 },
  widerHole: { bloodCost: 6, capacity: 6 },
  autoSpawn: { bloodCost: 13, intervalSeconds: 3 },
};

// Killing a goblin yields this much money + this much blood.
export const KILL_REWARD = { money: 25, blood: 1 };

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
  gas_engine: def(4, {
    name: 'Gas Engine',
    short: 'GE',
    cost: 1500,
    buildersRequired: 3,
    buildTime: 15,
    maintainersRequired: 3,
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
  goblin_hole: def(2, {
    name: 'Goblin Hole',
    short: 'GH',
    cost: 1500,
    bloodCost: 150,
    buildersRequired: 1,
    buildTime: 8,
    maintainersRequired: 1,
    income: 0,
    powerOutput: -50, // 50 W
    wanderInterval: 1.0,
    wanderJitter: 0.4,
    colors: {
      active: 0x4a2a4a, activeBorder: 0xa06aff,
      dormant: 0x3a2a3a, dormantBorder: 0x705580,
      constructing: 0x3a3f47, constructingBorder: 0x808890,
    },
  }),
} as const;

// Spawn cadence for the Goblin Hole building (one free goblin per interval
// while active). Independent of the main hole's autospawn ritual.
export const GOBLIN_HOLE_SPAWN_INTERVAL = 5;

export type BuildingKind = keyof typeof BUILDING_DEFS;
export const BUILDABLE_KINDS: BuildingKind[] = ['goblin_wheel', 'gas_engine', 'datacentre', 'phone_farm', 'goblin_hole'];

export const START_MONEY = 0;
export const START_GOBLINS = 0;
// Place start near the top-left of the playable area, just inside the wall border.
export const START_CELL = { cx: WALL_BORDER + 4, cy: WALL_BORDER + 8 };

export function formatPower(w: number): string {
  const abs = Math.abs(w);
  if (abs >= 1e9) return `${(Math.floor(w / 1e9 * 100) / 100).toFixed(2)} GW`;
  if (abs >= 1e6) return `${(Math.floor(w / 1e6 * 100) / 100).toFixed(2)} MW`;
  return `${Math.floor(w)} W`;
}
