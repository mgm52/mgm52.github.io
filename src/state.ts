import {
  BUILDING_DEFS, BuildingDef, BuildingKind, CELL, COLS, ROWS,
  START_CELL, START_GOBLINS, START_MONEY, WALL_BORDER, formatPower,
} from './config';

export type Vec2 = { x: number; y: number };
export type Cell = { cx: number; cy: number };
// 8-way direction, clockwise from north. Even indices are cardinals.
export type Dir = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

export const DX: Record<Dir, number> = { 0: 0, 1: 1, 2: 1, 3: 1, 4: 0, 5: -1, 6: -1, 7: -1 };
export const DY: Record<Dir, number> = { 0: -1, 1: -1, 2: 0, 3: 1, 4: 1, 5: 1, 6: 0, 7: -1 };
export const ALL_DIRS: Dir[] = [0, 1, 2, 3, 4, 5, 6, 7];
export const CARDINAL_DIRS: Dir[] = [0, 2, 4, 6];
export function isDiagonal(d: Dir): boolean { return (d & 1) === 1; }

export type GoblinState =
  | { kind: 'idle' }
  | { kind: 'moving' }
  | { kind: 'going_to_build'; buildingId: number }
  | { kind: 'going_to_maintain'; buildingId: number }
  | { kind: 'building'; buildingId: number }
  | { kind: 'maintaining'; buildingId: number; nextWanderAt: number }
  | { kind: 'going_to_kill'; targetId: number; attackAt?: number };

export type Goblin = {
  id: number;
  pos: Vec2;
  cell: Cell;
  target: Cell | null;
  goal: Cell | null;
  path: Cell[];           // BFS-cached remaining cells from current toward goal
  facing: number;
  state: GoblinState;
  selected: boolean;
  idleSince: number | null; // game time when the current idle streak began
};

export type MinotaurState =
  | { kind: 'wander' }
  | { kind: 'going_to_kill'; targetId: number; attackAt?: number }
  | { kind: 'going_to_kill_minotaur'; targetId: number; attackAt?: number }
  | { kind: 'going_to_destroy'; buildingId: number; attackAt?: number };

export type Minotaur = {
  id: number;
  pos: Vec2;
  cell: Cell;
  target: Cell | null;    // pixel-lerp target cell (mid-step)
  facing: number;
  state: MinotaurState;
  nextWanderAt: number;
  selected: boolean;
};

export type BuildingState = 'constructing' | 'active' | 'dormant';

export type Building = {
  id: number;
  kind: BuildingKind;
  cell: Cell;
  state: BuildingState;
  buildProgress: number;
  assignedGoblins: number[];
  selected: boolean;
  // goblin_hole: countdown to next free spawn. Set when the building first
  // goes active; ignored on every other kind.
  nextSpawnAt?: number;
};

export type PendingBuild = { kind: BuildingKind } | null;

// Short-lived floating text drawn at a world position — used for kill rewards,
// income ticks, power going online, etc. Removed by the renderer once aged out.
export type Floater = {
  id: number;
  x: number; y: number;
  text: string;
  color: number;
  spawnAt: number;
  lifetime: number;
};

// One-shot blood-explosion GIF effect played at a world position.
export type DeathEffect = {
  id: number;
  x: number; y: number;
  spawnAt: number;
};

// The Goblin Hole — a 1×1 spawn point. Goblins emerge from cells around it.
// Buildings CAN be placed on top of the hole's cell; while one is, new spawns
// are blocked until the building is destroyed.
export const HOLE_SIZE = 1;
export type Hole = {
  cell: Cell;
  selected: boolean;
  spawnCapacity: number;
};

export type GameState = {
  money: number;
  // Blood is earned by killing goblins. Once any blood is earned in this run
  // `bloodUnlocked` flips true and the resource row stays visible (sticky).
  blood: number;
  bloodUnlocked: boolean;
  goblins: Map<number, Goblin>;
  minotaurs: Map<number, Minotaur>;
  buildings: Map<number, Building>;
  hole: Hole;
  // Ritual upgrades — sticky once bought, apply game-wide.
  autoAssignEnabled: boolean;
  widerHoleEnabled: boolean;
  autoSpawnEnabled: boolean;
  autoSpawnTimer: number;
  floaters: Floater[];
  deathEffects: DeathEffect[];
  // Tick state for the 1Hz income-floater cadence.
  nextIncomeFloatAt: number;
  spawnQueue: { remaining: number; slot: number }[];
  minotaurSpawnQueue: { remaining: number }[];
  pendingBuild: PendingBuild;
  log: { time: number; msg: string }[];
  occupancy: Map<string, number>;
  walls: Set<string>;     // permanently impassable cells
  nextId: number;
  now: number;
  // Snapshot of last tick's power balance for display.
  lastPowerProduced: number;
  lastPowerConsumed: number;
  // Tutorial counters (cumulative — only ever increase).
  spawnsCompleted: number;
};

export function defOf(b: Building): BuildingDef { return BUILDING_DEFS[b.kind]; }

export function cellKey(cx: number, cy: number): string { return `${cx},${cy}`; }

export function cellCenter(c: Cell): Vec2 {
  return { x: c.cx * CELL + CELL / 2, y: c.cy * CELL + CELL / 2 };
}

export function pixelToCell(x: number, y: number): Cell {
  return { cx: Math.floor(x / CELL), cy: Math.floor(y / CELL) };
}

export function isInBounds(cx: number, cy: number): boolean {
  return cx >= 0 && cy >= 0 && cx < COLS && cy < ROWS;
}

export function buildingFootprint(b: Building): Cell[] {
  const out: Cell[] = [];
  const n = defOf(b).cellSize;
  for (let dx = 0; dx < n; dx++) {
    for (let dy = 0; dy < n; dy++) {
      out.push({ cx: b.cell.cx + dx, cy: b.cell.cy + dy });
    }
  }
  return out;
}

export function buildingCenter(b: Building): Vec2 {
  const n = defOf(b).cellSize;
  return cellCenter({
    cx: b.cell.cx + (n - 1) / 2,
    cy: b.cell.cy + (n - 1) / 2,
  });
}

export function isCellInBuilding(b: Building, cx: number, cy: number): boolean {
  const n = defOf(b).cellSize;
  return cx >= b.cell.cx && cx < b.cell.cx + n &&
         cy >= b.cell.cy && cy < b.cell.cy + n;
}

export function buildingAtCell(state: GameState, cx: number, cy: number): Building | null {
  for (const b of state.buildings.values()) {
    if (isCellInBuilding(b, cx, cy)) return b;
  }
  return null;
}

export function isCellBlocked(
  state: GameState,
  cx: number, cy: number,
  exemptGoblinId?: number,
  exemptBuildingId?: number,
): boolean {
  if (!isInBounds(cx, cy)) return true;
  if (state.walls.has(cellKey(cx, cy))) return true;
  const b = buildingAtCell(state, cx, cy);
  if (b && b.id !== exemptBuildingId) return true;
  const occ = state.occupancy.get(cellKey(cx, cy));
  if (occ !== undefined && occ !== exemptGoblinId) return true;
  return false;
}

export function occupyCell(state: GameState, cx: number, cy: number, goblinId: number) {
  state.occupancy.set(cellKey(cx, cy), goblinId);
}

export function releaseCell(state: GameState, cx: number, cy: number, goblinId: number) {
  const k = cellKey(cx, cy);
  if (state.occupancy.get(k) === goblinId) state.occupancy.delete(k);
}

export function buildingPerimeter(b: Building): Cell[] {
  const result: Cell[] = [];
  const n = defOf(b).cellSize;
  for (let dx = -1; dx <= n; dx++) {
    result.push({ cx: b.cell.cx + dx, cy: b.cell.cy - 1 });
    result.push({ cx: b.cell.cx + dx, cy: b.cell.cy + n });
  }
  for (let dy = 0; dy < n; dy++) {
    result.push({ cx: b.cell.cx - 1, cy: b.cell.cy + dy });
    result.push({ cx: b.cell.cx + n, cy: b.cell.cy + dy });
  }
  return result.filter(c => isInBounds(c.cx, c.cy));
}

export function findFreeCellNear(
  state: GameState,
  cx: number, cy: number,
  exemptGoblinId?: number,
  blocked?: Set<string>,
  maxSteps = 400,
): Cell | null {
  const visited = new Set<string>();
  const queue: Cell[] = [{ cx, cy }];
  while (queue.length > 0 && visited.size < maxSteps) {
    const c = queue.shift()!;
    const k = cellKey(c.cx, c.cy);
    if (visited.has(k)) continue;
    visited.add(k);
    if (!isInBounds(c.cx, c.cy)) continue;
    if (blocked?.has(k)) {
      // skip but explore neighbors
    } else if (!isCellBlocked(state, c.cx, c.cy, exemptGoblinId)) {
      return c;
    }
    for (const d of CARDINAL_DIRS) {
      queue.push({ cx: c.cx + DX[d], cy: c.cy + DY[d] });
    }
  }
  return null;
}

function buildBorderWalls(): Set<string> {
  const walls = new Set<string>();
  for (let cy = 0; cy < ROWS; cy++) {
    for (let cx = 0; cx < COLS; cx++) {
      const inBorder =
        cx < WALL_BORDER || cx >= COLS - WALL_BORDER ||
        cy < WALL_BORDER || cy >= ROWS - WALL_BORDER;
      if (inBorder) walls.add(cellKey(cx, cy));
    }
  }
  return walls;
}

export function createInitialState(): GameState {
  const state: GameState = {
    money: START_MONEY,
    blood: 0,
    bloodUnlocked: false,
    goblins: new Map(),
    minotaurs: new Map(),
    buildings: new Map(),
    hole: {
      cell: { cx: START_CELL.cx, cy: START_CELL.cy },
      selected: false,
      spawnCapacity: 3,
    },
    autoAssignEnabled: false,
    widerHoleEnabled: false,
    autoSpawnEnabled: false,
    autoSpawnTimer: 0,
    floaters: [],
    deathEffects: [],
    nextIncomeFloatAt: 1,
    spawnQueue: [],
    minotaurSpawnQueue: [],
    pendingBuild: null,
    log: [],
    occupancy: new Map(),
    walls: buildBorderWalls(),
    nextId: 1,
    now: 0,
    lastPowerProduced: 0,
    lastPowerConsumed: 0,
    spawnsCompleted: 0,
  };
  let placed = 0;
  let radius = 0;
  while (placed < START_GOBLINS && radius < 12) {
    for (let dy = -radius; dy <= radius && placed < START_GOBLINS; dy++) {
      for (let dx = -radius; dx <= radius && placed < START_GOBLINS; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius && radius > 0) continue;
        const cx = START_CELL.cx + dx;
        const cy = START_CELL.cy + dy;
        if (!isInBounds(cx, cy)) continue;
        if (state.occupancy.has(cellKey(cx, cy))) continue;
        const id = state.nextId++;
        const c: Cell = { cx, cy };
        const g: Goblin = {
          id, pos: cellCenter(c), cell: c, target: null, goal: null,
          path: [], facing: Math.PI / 2,
          state: { kind: 'idle' }, selected: false, idleSince: null,
        };
        state.goblins.set(id, g);
        occupyCell(state, cx, cy, id);
        placed++;
      }
    }
    radius++;
  }
  appendLog(state, 'Welcome, overseer.');
  return state;
}

export function appendLog(state: GameState, msg: string) {
  state.log.push({ time: state.now, msg });
  if (state.log.length > 60) state.log.shift();
}

export function countIdle(state: GameState): number {
  let n = 0;
  for (const g of state.goblins.values()) if (g.state.kind === 'idle') n++;
  return n;
}

export function totalIncome(state: GameState): number {
  let inc = 0;
  for (const b of state.buildings.values()) if (b.state === 'active') inc += defOf(b).income;
  return inc;
}

export function pushDeathEffect(state: GameState, x: number, y: number) {
  state.deathEffects.push({
    id: state.nextId++,
    x, y,
    spawnAt: state.now,
  });
}

export function pushFloater(
  state: GameState,
  x: number, y: number,
  text: string,
  color: number,
  lifetime = 1.4,
) {
  state.floaters.push({
    id: state.nextId++,
    x, y, text, color,
    spawnAt: state.now,
    lifetime,
  });
}

export function removeGoblin(state: GameState, goblinId: number) {
  const g = state.goblins.get(goblinId);
  if (!g) return;
  // Detach from any building it was assigned to.
  const s = g.state;
  if (s.kind === 'going_to_build' || s.kind === 'going_to_maintain' ||
      s.kind === 'building' || s.kind === 'maintaining') {
    const b = state.buildings.get(s.buildingId);
    if (b) {
      const i = b.assignedGoblins.indexOf(goblinId);
      if (i >= 0) b.assignedGoblins.splice(i, 1);
    }
  }
  releaseCell(state, g.cell.cx, g.cell.cy, goblinId);
  if (g.target) releaseCell(state, g.target.cx, g.target.cy, goblinId);
  state.goblins.delete(goblinId);
}

export function destroyBuilding(state: GameState, buildingId: number) {
  const b = state.buildings.get(buildingId);
  if (!b) return;
  // If the building was online, its power contribution is going away — show
  // the inverse of the floater that appeared when it came online.
  const def = defOf(b);
  if (b.state === 'active' && def.powerOutput !== 0) {
    const c = buildingCenter(b);
    if (def.powerOutput > 0) {
      pushFloater(state, c.x, c.y, `-${formatPower(def.powerOutput)}`, 0xd96b6b, 1.6);
    } else {
      pushFloater(state, c.x, c.y, `+${formatPower(-def.powerOutput)}`, 0x8acfff, 1.6);
    }
  }
  // Release any assigned goblins; they'll auto-exit via the idle handler if they're
  // still standing on what used to be the footprint.
  for (const gid of b.assignedGoblins) {
    const g = state.goblins.get(gid);
    if (!g) continue;
    g.state = { kind: 'idle' };
    g.goal = null;
    g.path = [];
  }
  state.buildings.delete(buildingId);
}

export function holeAtCell(state: GameState, cx: number, cy: number): boolean {
  const h = state.hole.cell;
  return cx >= h.cx && cx < h.cx + HOLE_SIZE && cy >= h.cy && cy < h.cy + HOLE_SIZE;
}

export function holeCells(state: GameState): Cell[] {
  const h = state.hole.cell;
  const out: Cell[] = [];
  for (let dx = 0; dx < HOLE_SIZE; dx++) {
    for (let dy = 0; dy < HOLE_SIZE; dy++) {
      out.push({ cx: h.cx + dx, cy: h.cy + dy });
    }
  }
  return out;
}

export function holeCenter(state: GameState): Vec2 {
  return cellCenter({
    cx: state.hole.cell.cx + (HOLE_SIZE - 1) / 2,
    cy: state.hole.cell.cy + (HOLE_SIZE - 1) / 2,
  });
}

// True iff a building's footprint covers any of the Goblin Hole's 2×2 cells.
export function holeBlockedByBuilding(state: GameState): boolean {
  for (const c of holeCells(state)) {
    if (buildingAtCell(state, c.cx, c.cy)) return true;
  }
  return false;
}

export function maintainerCount(state: GameState, b: Building): number {
  let n = 0;
  for (const id of b.assignedGoblins) {
    const g = state.goblins.get(id);
    if (g && g.state.kind === 'maintaining' && g.state.buildingId === b.id) n++;
  }
  return n;
}

