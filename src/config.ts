export const TICK_HZ = 20;
export const TICK_MS = 1000 / TICK_HZ;
export const TICK_S = 1 / TICK_HZ;

export const CELL = 32;
export const COLS = 24;
export const ROWS = 20;
export const WORLD = { width: COLS * CELL, height: ROWS * CELL };
export const WALL_BORDER = 3; // impassable wall thickness in cells around play area
export const CAMERA_SPEED = 700; // px/sec when panning with WASD

export const GOBLIN = {
  speed: 110,
  radius: 12,
  spawnCost: 50,
  spawnTime: 2,
  arriveDist: 2,
  concurrentBuildLimit: 5,
};

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
  buildersRequired: number;
  buildTime: number;      // seconds
  maintainersRequired: number;
  income: number;         // $/sec while active
  powerOutput: number;    // watts: positive = produces, negative = consumes
  wanderInterval: number;
  wanderJitter: number;
  colors: BuildingColors;
};

function def(cellSize: number, rest: Omit<BuildingDef, 'cellSize' | 'size'>): BuildingDef {
  return { cellSize, size: cellSize * CELL, ...rest };
}

export const BUILDING_DEFS = {
  datacentre: def(3, {
    name: 'Datacentre',
    short: 'DC',
    cost: 200,
    buildersRequired: 3,
    buildTime: 8,
    maintainersRequired: 3,
    income: 5,
    powerOutput: -5_000_000, // 5 MW draw
      wanderInterval: 1.4,
    wanderJitter: 0.8,
    colors: {
      active: 0x3a6a8a, activeBorder: 0x8acfff,
      dormant: 0x5a4a3a, dormantBorder: 0xd99a5a,
      constructing: 0x3a3f47, constructingBorder: 0x808890,
    },
  }),
  goblin_wheel: def(2, {
    name: 'Goblin Wheel',
    short: 'GW',
    cost: 100,
    buildersRequired: 1,
    buildTime: 5,
    maintainersRequired: 1,
    income: 0,
    powerOutput: 8_000_000, // 8 MW
      wanderInterval: 0.45,    // runs the wheel quickly
    wanderJitter: 0.15,
    colors: {
      active: 0x6a8a3a, activeBorder: 0xb8d96b,
      dormant: 0x5a4a3a, dormantBorder: 0xd99a5a,
      constructing: 0x3a3f47, constructingBorder: 0x808890,
    },
  }),
  coal_plant: def(4, {
    name: 'Coal Power Plant',
    short: 'CO',
    cost: 1200,
    buildersRequired: 3,
    buildTime: 15,
    maintainersRequired: 3,
    income: 0,
    powerOutput: 200_000_000, // 200 MW
      wanderInterval: 0.9,
    wanderJitter: 0.3,
    colors: {
      active: 0x6a4a2a, activeBorder: 0xc49a5a,
      dormant: 0x4a3a2a, dormantBorder: 0x8a6a4a,
      constructing: 0x3a3f47, constructingBorder: 0x808890,
    },
  }),
  nuclear_plant: def(5, {
    name: 'Nuclear Power Plant',
    short: 'NU',
    cost: 20000,
    buildersRequired: 5,
    buildTime: 40,
    maintainersRequired: 5,
    income: 0,
    powerOutput: 5_000_000_000, // 5 GW
      wanderInterval: 1.5,
    wanderJitter: 0.6,
    colors: {
      active: 0x2a8a4a, activeBorder: 0x6af090,
      dormant: 0x2a4a3a, dormantBorder: 0x6a8a7a,
      constructing: 0x3a3f47, constructingBorder: 0x808890,
    },
  }),
} as const;

export type BuildingKind = keyof typeof BUILDING_DEFS;
export const BUILDABLE_KINDS: BuildingKind[] = ['goblin_wheel', 'coal_plant', 'nuclear_plant', 'datacentre'];

export const START_MONEY = 1000;
export const START_GOBLINS = 0;
// Place start near the top-left of the playable area, just inside the wall border.
export const START_CELL = { cx: WALL_BORDER + 4, cy: WALL_BORDER + 8 };

export function formatPower(w: number): string {
  const abs = Math.abs(w);
  if (abs >= 1e9) return `${(w / 1e9).toFixed(1)} GW`;
  if (abs >= 1e6) return `${(w / 1e6).toFixed(1)} MW`;
  return `${Math.round(w)} W`;
}
