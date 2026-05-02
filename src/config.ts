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
  phone_farm: def(3, {
    name: 'Phone Farm',
    short: 'PF',
    cost: 250,
    buildersRequired: 3,
    buildTime: 8,
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
    cost: 100,
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
  gas_genset: def(4, {
    name: 'Gas Genset',
    short: 'GG',
    cost: 1200,
    buildersRequired: 3,
    buildTime: 15,
    maintainersRequired: 3,
    income: 0,
    powerOutput: 2_000_000, // 2 MW
    wanderInterval: 0.9,
    wanderJitter: 0.3,
    colors: {
      active: 0x3a6a3a, activeBorder: 0x8aef8a,
      dormant: 0x3a4a3a, dormantBorder: 0x6a8a6a,
      constructing: 0x3a3f47, constructingBorder: 0x808890,
    },
  }),
} as const;

export type BuildingKind = keyof typeof BUILDING_DEFS;
export const BUILDABLE_KINDS: BuildingKind[] = ['goblin_wheel', 'gas_genset', 'datacentre', 'phone_farm'];

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
