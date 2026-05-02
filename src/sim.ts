import { BUILDING_DEFS, COLS, GOBLIN, START_CELL, TICK_S } from './config';
import {
  ALL_DIRS, Building, Cell, DX, DY, Dir, GameState, Goblin,
  appendLog, buildingAtCell, buildingFootprint, buildingPerimeter, cellCenter,
  cellKey, defOf, findFreeCellNear, isCellBlocked, isCellInBuilding, isInBounds,
  maintainerCount, occupyCell, releaseCell,
} from './state';

export function tick(state: GameState) {
  state.now += TICK_S;

  // ── 1. Spawn queue ────────────────────────────────────────────────
  for (let i = state.spawnQueue.length - 1; i >= 0; i--) {
    state.spawnQueue[i].remaining -= TICK_S;
    if (state.spawnQueue[i].remaining <= 0) {
      spawnGoblin(state);
      state.spawnQueue.splice(i, 1);
    }
  }

  // ── 2. Goblin updates ─────────────────────────────────────────────
  for (const g of state.goblins.values()) updateGoblin(state, g);

  // ── 3. Construction progress ──────────────────────────────────────
  for (const b of state.buildings.values()) updateConstruction(state, b);

  // ── 4. Power balance + active/dormant resolution ──────────────────
  resolvePowerAndState(state);

  // ── 5. Income ─────────────────────────────────────────────────────
  for (const b of state.buildings.values()) {
    if (b.state === 'active') state.money += defOf(b).income * TICK_S;
  }
}

function spawnGoblin(state: GameState) {
  const cell = findFreeCellNear(state, START_CELL.cx, START_CELL.cy);
  if (!cell) {
    appendLog(state, 'No room to spawn goblin.');
    return;
  }
  const id = state.nextId++;
  const g: Goblin = {
    id, pos: cellCenter(cell), cell,
    target: null, goal: null,
    path: [],
    facing: Math.PI / 2,
    state: { kind: 'idle' }, selected: false, idleSince: null,
  };
  state.goblins.set(id, g);
  occupyCell(state, cell.cx, cell.cy, id);
  state.spawnsCompleted++;
  appendLog(state, `Goblin #${id} hatched.`);
}

// ─── Goblin update ──────────────────────────────────────────────────
function updateGoblin(state: GameState, g: Goblin) {
  // Track continuous idle time so the renderer can switch animations once a
  // goblin's been standing around long enough.
  if (g.state.kind === 'idle') {
    if (g.idleSince === null) g.idleSince = state.now;
  } else if (g.idleSince !== null) {
    g.idleSince = null;
  }

  // Continue interpolating toward target cell if mid-step
  if (g.target) {
    const tc = cellCenter(g.target);
    const dx = tc.x - g.pos.x;
    const dy = tc.y - g.pos.y;
    const d = Math.hypot(dx, dy);
    const step = GOBLIN.speed * TICK_S;
    if (d <= step + GOBLIN.arriveDist) {
      releaseCell(state, g.cell.cx, g.cell.cy, g.id);
      g.cell = g.target;
      g.pos = tc;
      g.target = null;
    } else {
      g.pos.x += (dx / d) * step;
      g.pos.y += (dy / d) * step;
      g.facing = Math.atan2(dy, dx);
      return;
    }
  }

  const s = g.state;
  switch (s.kind) {
    case 'idle': {
      // Auto-exit if standing inside a building we don't belong to
      const here = buildingAtCell(state, g.cell.cx, g.cell.cy);
      if (here) {
        const exit = nearestExitCell(state, g, here);
        if (exit) {
          g.goal = exit;
          g.path = [];
          g.state = { kind: 'moving' };
          return;
        }
      }
      g.goal = null;
      g.path = [];
      return;
    }

    case 'moving': {
      if (!g.goal) { g.state = { kind: 'idle' }; return; }
      planStep(state, g);
      if (!g.goal && !g.target) g.state = { kind: 'idle' };
      return;
    }

    case 'going_to_build': {
      const b = state.buildings.get(s.buildingId);
      if (!b) { g.goal = null; g.path = []; g.state = { kind: 'idle' }; return; }
      const buildDef = defOf(b);

      // At-commit capacity check: count other goblins already in 'building' state.
      // First-to-arrive wins; the loser un-assigns and reverts to idle.
      const tryBecomeBuilder = (): boolean => {
        let workers = 0;
        for (const aid of b.assignedGoblins) {
          if (aid === g.id) continue;
          const og = state.goblins.get(aid);
          if (og && og.state.kind === 'building' && og.state.buildingId === b.id) workers++;
        }
        if (workers >= buildDef.buildersRequired) {
          const i = b.assignedGoblins.indexOf(g.id);
          if (i >= 0) b.assignedGoblins.splice(i, 1);
          g.state = { kind: 'idle' };
          g.goal = null;
          g.path = [];
          return false;
        }
        g.goal = null;
        g.path = [];
        g.state = { kind: 'building', buildingId: b.id };
        return true;
      };

      const middles = middleCells(b);
      if (middles.some((m) => m.cx === g.cell.cx && m.cy === g.cell.cy)) {
        tryBecomeBuilder();
        return;
      }

      if (isCellInBuilding(b, g.cell.cx, g.cell.cy)) {
        // Inside the building: direct step toward the closest middle cell.
        // If blocked by another unit, try to commit as a builder here.
        let closestMid = middles[0];
        let bestD = Math.hypot(closestMid.cx - g.cell.cx, closestMid.cy - g.cell.cy);
        for (const m of middles) {
          const d = Math.hypot(m.cx - g.cell.cx, m.cy - g.cell.cy);
          if (d < bestD) { bestD = d; closestMid = m; }
        }
        const stepDir = preferredDir(g.cell, closestMid);
        const nx = g.cell.cx + DX[stepDir];
        const ny = g.cell.cy + DY[stepDir];
        if (canStep(state, g.cell.cx, g.cell.cy, nx, ny, g.id, b.id)) {
          occupyCell(state, nx, ny, g.id);
          g.target = { cx: nx, cy: ny };
          g.facing = Math.atan2(DY[stepDir], DX[stepDir]);
          g.path = [];
        } else {
          tryBecomeBuilder();
        }
        return;
      }

      // Outside the building: pick a reachable footprint cell as the BFS goal.
      // Prefer free middle cells; fall back to any free footprint cell. Sticky
      // if the current goal is still valid.
      const footprint = buildingFootprint(b);
      const isFreeForMe = (c: Cell) =>
        (c.cx === g.cell.cx && c.cy === g.cell.cy) ||
        !isCellBlocked(state, c.cx, c.cy, g.id, b.id);
      let slot: Cell | null = null;
      if (g.goal && isCellInBuilding(b, g.goal.cx, g.goal.cy) && isFreeForMe(g.goal)) {
        slot = g.goal;
      } else {
        const freeMids = middles
          .filter(isFreeForMe)
          .sort((a, c) =>
            Math.hypot(a.cx - g.cell.cx, a.cy - g.cell.cy) -
            Math.hypot(c.cx - g.cell.cx, c.cy - g.cell.cy));
        if (freeMids.length > 0) {
          slot = freeMids[0];
        } else {
          const center = middles[0];
          const freeAll = footprint.filter(isFreeForMe).sort((a, c) =>
            Math.hypot(a.cx - center.cx, a.cy - center.cy) -
            Math.hypot(c.cx - center.cx, c.cy - center.cy));
          slot = freeAll[0] ?? null;
        }
        g.path = [];
      }
      if (!slot) return; // every footprint cell is blocked; wait a tick
      g.goal = slot;
      planStep(state, g);
      return;
    }

    case 'going_to_maintain': {
      const b = state.buildings.get(s.buildingId);
      if (!b) { g.goal = null; g.path = []; g.state = { kind: 'idle' }; return; }
      const def = defOf(b);
      const slot = maintainerSlot(state, b, g);
      if (!slot) return;
      if (g.cell.cx === slot.cx && g.cell.cy === slot.cy) {
        // At-commit cap: count other maintainers; bail if full.
        let m = 0;
        for (const aid of b.assignedGoblins) {
          if (aid === g.id) continue;
          const og = state.goblins.get(aid);
          if (og && og.state.kind === 'maintaining' && og.state.buildingId === b.id) m++;
        }
        if (m >= def.maintainersRequired) {
          const i = b.assignedGoblins.indexOf(g.id);
          if (i >= 0) b.assignedGoblins.splice(i, 1);
          g.state = { kind: 'idle' };
          g.goal = null;
          g.path = [];
          return;
        }
        g.goal = null;
        g.path = [];
        g.state = { kind: 'maintaining', buildingId: b.id, nextWanderAt: state.now + jitterInterval(b) };
        return;
      }
      if (!g.goal || g.goal.cx !== slot.cx || g.goal.cy !== slot.cy) {
        g.path = [];
        g.goal = slot;
      }
      planStep(state, g);
      return;
    }

    case 'building': {
      if (!state.buildings.has(s.buildingId)) g.state = { kind: 'idle' };
      g.goal = null;
      g.path = [];
      return;
    }

    case 'maintaining': {
      const b = state.buildings.get(s.buildingId);
      if (!b) { g.state = { kind: 'idle' }; g.goal = null; g.path = []; return; }
      // Visual-flair wander: every wander interval, try a single random step
      // to an adjacent free footprint cell. No goal, no pathfinding.
      g.goal = null;
      g.path = [];
      if (state.now >= s.nextWanderAt) {
        let chosen: Dir | null = null;
        if (b.kind === 'goblin_wheel') {
          // Walk clockwise around the 2×2 footprint — looks like a turning wheel.
          const d = wheelNextDir(b, g.cell);
          const nx = g.cell.cx + DX[d];
          const ny = g.cell.cy + DY[d];
          if (isCellInBuilding(b, nx, ny) && !isCellBlocked(state, nx, ny, g.id, b.id)) {
            chosen = d;
          }
        } else {
          const choices: Dir[] = [];
          for (const d of ALL_DIRS) {
            const nx = g.cell.cx + DX[d];
            const ny = g.cell.cy + DY[d];
            if (!isCellInBuilding(b, nx, ny)) continue;
            if (!canStep(state, g.cell.cx, g.cell.cy, nx, ny, g.id, b.id)) continue;
            choices.push(d);
          }
          if (choices.length > 0) chosen = choices[Math.floor(Math.random() * choices.length)];
        }
        if (chosen !== null) {
          const nx = g.cell.cx + DX[chosen];
          const ny = g.cell.cy + DY[chosen];
          occupyCell(state, nx, ny, g.id);
          g.target = { cx: nx, cy: ny };
          g.facing = Math.atan2(DY[chosen], DX[chosen]);
        }
        s.nextWanderAt = state.now + jitterInterval(b);
      }
      return;
    }
  }
}

// Direction to step from `cell` to the next cell on the clockwise loop
// around a 2×2 building footprint (top-left → top-right → bottom-right → bottom-left → ...).
function wheelNextDir(b: Building, cell: Cell): Dir {
  const lx = cell.cx - b.cell.cx;
  const ly = cell.cy - b.cell.cy;
  if (lx === 0 && ly === 0) return 2; // east
  if (lx === 1 && ly === 0) return 4; // south
  if (lx === 1 && ly === 1) return 6; // west
  return 0;                            // (0,1) → north
}

// Can a goblin step from (fx,fy) to (tx,ty) in one move? Validates the
// destination, and for diagonals also rejects corner-cutting through static
// obstacles (walls, buildings). Other goblins are *not* corner blockers — that
// would deadlock tight crowds (e.g. a goblin surrounded on all 4 cardinals).
function canStep(
  state: GameState,
  fx: number, fy: number,
  tx: number, ty: number,
  gid: number,
  exemptB: number | undefined,
): boolean {
  if (isCellBlocked(state, tx, ty, gid, exemptB)) return false;
  const dx = tx - fx;
  const dy = ty - fy;
  if (dx !== 0 && dy !== 0) {
    if (isCornerStaticBlocked(state, fx + dx, fy, exemptB)) return false;
    if (isCornerStaticBlocked(state, fx, fy + dy, exemptB)) return false;
  }
  return true;
}

function isCornerStaticBlocked(
  state: GameState,
  cx: number, cy: number,
  exemptB: number | undefined,
): boolean {
  if (!isInBounds(cx, cy)) return true;
  if (state.walls.has(cellKey(cx, cy))) return true;
  const b = buildingAtCell(state, cx, cy);
  if (b && b.id !== exemptB) return true;
  return false;
}

function jitterInterval(b: Building): number {
  const def = defOf(b);
  return def.wanderInterval + (Math.random() - 0.5) * 2 * def.wanderJitter;
}

function nearestExitCell(state: GameState, g: Goblin, b: Building): Cell | null {
  const perim = buildingPerimeter(b).slice();
  perim.sort((a, c) =>
    Math.hypot(a.cx - g.cell.cx, a.cy - g.cell.cy) -
    Math.hypot(c.cx - g.cell.cx, c.cy - g.cell.cy),
  );
  for (const c of perim) {
    if (!isCellBlocked(state, c.cx, c.cy, g.id)) return c;
  }
  return null;
}

function middleCells(b: Building): Cell[] {
  const n = defOf(b).cellSize;
  const xs = n % 2 === 1 ? [Math.floor(n / 2)] : [n / 2 - 1, n / 2];
  const ys = n % 2 === 1 ? [Math.floor(n / 2)] : [n / 2 - 1, n / 2];
  const out: Cell[] = [];
  for (const dx of xs) for (const dy of ys) {
    out.push({ cx: b.cell.cx + dx, cy: b.cell.cy + dy });
  }
  return out;
}

function maintainerSlot(state: GameState, b: Building, g: Goblin): Cell | null {
  const idx = b.assignedGoblins.indexOf(g.id);
  if (idx < 0) return null;
  const cells = buildingFootprint(b);
  const order = [cells[idx % cells.length], ...cells];
  for (const c of order) {
    if (c.cx === g.cell.cx && c.cy === g.cell.cy) return c;
    if (!isCellBlocked(state, c.cx, c.cy, g.id, b.id)) return c;
  }
  return null;
}

// ─── Pathfinding (BFS over the cell grid) ───────────────────────────
function preferredDir(from: Cell, to: Cell): Dir {
  const sx = Math.sign(to.cx - from.cx);
  const sy = Math.sign(to.cy - from.cy);
  for (const d of ALL_DIRS) {
    if (DX[d] === sx && DY[d] === sy) return d;
  }
  return 0;
}

function exemptBuildingFor(state: GameState, g: Goblin): number | undefined {
  const s = g.state;
  if (s.kind === 'going_to_maintain' || s.kind === 'going_to_build' ||
      s.kind === 'maintaining' || s.kind === 'building') return s.buildingId;
  const here = buildingAtCell(state, g.cell.cx, g.cell.cy);
  if (here) return here.id;
  return undefined;
}

function confineToBuildingFor(g: Goblin): number | undefined {
  return g.state.kind === 'maintaining' ? g.state.buildingId : undefined;
}

// Numeric cell key used inside BFS — avoids string allocation.
function nkey(cx: number, cy: number): number { return cy * COLS + cx; }

function bfsPath(
  state: GameState,
  gid: number,
  start: Cell,
  goal: Cell,
  exemptB: number | undefined,
  confineB: number | undefined,
): Cell[] | null {
  if (start.cx === goal.cx && start.cy === goal.cy) return [];
  const goalKey = nkey(goal.cx, goal.cy);
  const startKey = nkey(start.cx, start.cy);
  // BFS with a head pointer instead of Array.shift()
  const queue: number[] = [startKey];
  const prev = new Map<number, number>();
  prev.set(startKey, -1);
  let confineBuilding: Building | null = null;
  if (confineB !== undefined) confineBuilding = state.buildings.get(confineB) ?? null;
  for (let head = 0; head < queue.length; head++) {
    const curKey = queue[head];
    if (curKey === goalKey) {
      const path: Cell[] = [];
      let k = curKey;
      while (k !== startKey) {
        path.unshift({ cx: k % COLS, cy: (k - (k % COLS)) / COLS });
        const p = prev.get(k);
        if (p === undefined || p === -1) break;
        k = p;
      }
      return path;
    }
    const cx = curKey % COLS;
    const cy = (curKey - cx) / COLS;
    for (const d of ALL_DIRS) {
      const nx = cx + DX[d];
      const ny = cy + DY[d];
      const k = nkey(nx, ny);
      if (prev.has(k)) continue;
      if (confineBuilding && !isCellInBuilding(confineBuilding, nx, ny)) continue;
      if (!canStep(state, cx, cy, nx, ny, gid, exemptB)) continue;
      prev.set(k, curKey);
      queue.push(k);
    }
  }
  return null;
}

function planStep(state: GameState, g: Goblin) {
  if (g.target) return;
  if (!g.goal) return;
  if (g.cell.cx === g.goal.cx && g.cell.cy === g.goal.cy) {
    g.goal = null;
    g.path = [];
    return;
  }
  const exemptB = exemptBuildingFor(state, g);
  const confineB = confineToBuildingFor(g);

  // Validate the cached next step; recompute if missing or now blocked.
  let next: Cell | undefined = g.path[0];
  let needsReplan = false;
  if (!next) needsReplan = true;
  else if (!canStep(state, g.cell.cx, g.cell.cy, next.cx, next.cy, g.id, exemptB)) needsReplan = true;
  else if (confineB !== undefined) {
    const b = state.buildings.get(confineB);
    if (b && !isCellInBuilding(b, next.cx, next.cy)) needsReplan = true;
  }
  // Sanity: next must be a single 8-way step from current cell.
  if (next) {
    const adx = Math.abs(next.cx - g.cell.cx);
    const ady = Math.abs(next.cy - g.cell.cy);
    if (Math.max(adx, ady) !== 1) needsReplan = true;
  }

  if (needsReplan) {
    const path = bfsPath(state, g.id, g.cell, g.goal, exemptB, confineB);
    g.path = path ?? [];
    next = g.path[0];
  }

  if (!next) return; // no path right now; wait a tick

  occupyCell(state, next.cx, next.cy, g.id);
  g.target = next;
  g.facing = Math.atan2(next.cy - g.cell.cy, next.cx - g.cell.cx);
  g.path = g.path.slice(1);
}

// ─── Construction & power resolution ────────────────────────────────
function updateConstruction(state: GameState, b: Building) {
  if (b.state !== 'constructing') return;
  const def = defOf(b);
  let workers = 0;
  for (const id of b.assignedGoblins) {
    const g = state.goblins.get(id);
    if (g && g.state.kind === 'building' && g.state.buildingId === b.id) workers++;
  }
  if (workers < def.buildersRequired) return;
  b.buildProgress += TICK_S / def.buildTime;
  if (b.buildProgress >= 1) {
    b.buildProgress = 1;
    const keep = def.maintainersRequired;
    const newAssigned: number[] = [];
    for (let i = 0; i < b.assignedGoblins.length; i++) {
      const gid = b.assignedGoblins[i];
      const g = state.goblins.get(gid);
      if (!g) continue;
      if (i < keep) {
        newAssigned.push(gid);
        g.state = { kind: 'going_to_maintain', buildingId: b.id };
      } else {
        g.state = { kind: 'idle' };
      }
      g.path = [];
      g.goal = null;
    }
    b.assignedGoblins = newAssigned;
    b.state = 'dormant';
    appendLog(state, `${def.name} #${b.id} construction complete.`);
  }
}

function resolvePowerAndState(state: GameState) {
  const buildings = [...state.buildings.values()];

  let production = 0;
  for (const b of buildings) {
    if (b.state === 'constructing') continue;
    const def = defOf(b);
    if (def.powerOutput <= 0) continue;
    const staffed = maintainerCount(state, b) >= def.maintainersRequired;
    setActiveOrDormant(state, b, staffed, undefined);
    if (b.state === 'active') production += def.powerOutput;
  }

  let consumed = 0;
  for (const b of buildings) {
    if (b.state === 'constructing') continue;
    const def = defOf(b);
    if (def.powerOutput >= 0) continue;
    const draw = -def.powerOutput;
    const staffed = maintainerCount(state, b) >= def.maintainersRequired;
    let reason: 'no_staff' | 'no_power' | undefined;
    let active = false;
    if (!staffed) reason = 'no_staff';
    else if (consumed + draw > production) reason = 'no_power';
    else { active = true; consumed += draw; }
    setActiveOrDormant(state, b, active, reason);
  }

  state.lastPowerProduced = production;
  state.lastPowerConsumed = consumed;
}

function setActiveOrDormant(
  state: GameState,
  b: Building,
  active: boolean,
  reason: 'no_staff' | 'no_power' | undefined,
) {
  const def = defOf(b);
  if (active) {
    if (b.state !== 'active') {
      b.state = 'active';
      appendLog(state, `${def.name} #${b.id} online.`);
    }
  } else {
    if (b.state !== 'dormant') {
      b.state = 'dormant';
      const why = reason === 'no_power'
        ? 'underpowered'
        : `needs ${def.maintainersRequired} maintainer${def.maintainersRequired === 1 ? '' : 's'}`;
      appendLog(state, `${def.name} #${b.id} dormant — ${why}.`);
    }
  }
}
