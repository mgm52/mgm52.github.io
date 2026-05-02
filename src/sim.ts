import { BUILDING_DEFS, GOBLIN, START_CELL, TICK_S } from './config';
import {
  Building, Cell, DX, DY, Dir, GameState, Goblin,
  appendLog, buildingAtCell, buildingFootprint, buildingPerimeter, cellCenter,
  defOf, findFreeCellNear, isCellBlocked, isCellInBuilding, maintainerCount,
  occupyCell, releaseCell,
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
    wallMode: false, wallDir: 2, wallHitDist: 0,
    facing: Math.PI / 2,
    state: { kind: 'idle' }, selected: false,
  };
  state.goblins.set(id, g);
  occupyCell(state, cell.cx, cell.cy, id);
  state.spawnsCompleted++;
  appendLog(state, `Goblin #${id} hatched.`);
}

// ─── Goblin update ──────────────────────────────────────────────────
function updateGoblin(state: GameState, g: Goblin) {
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
          g.wallMode = false;
          g.state = { kind: 'moving' };
          return;
        }
      }
      g.goal = null;
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
      if (!b) { g.goal = null; g.state = { kind: 'idle' }; return; }
      const middles = middleCells(b);
      if (middles.some((m) => m.cx === g.cell.cx && m.cy === g.cell.cy)) {
        g.goal = null;
        g.state = { kind: 'building', buildingId: b.id };
        return;
      }
      let slot: Cell | null = null;
      let bestD = Infinity;
      for (const m of middles) {
        const d = Math.hypot(m.cx - g.cell.cx, m.cy - g.cell.cy);
        if (d < bestD) { bestD = d; slot = m; }
      }
      if (!slot) return;
      g.goal = slot;

      if (isCellInBuilding(b, g.cell.cx, g.cell.cy)) {
        const pref = preferredDir(g.cell, slot);
        if (canStep(state, g, pref, b.id)) {
          stepInto(state, g, pref);
          g.wallMode = false;
        } else {
          g.goal = null;
          g.state = { kind: 'building', buildingId: b.id };
        }
      } else {
        planStep(state, g);
      }
      return;
    }

    case 'going_to_maintain': {
      const b = state.buildings.get(s.buildingId);
      if (!b) { g.goal = null; g.state = { kind: 'idle' }; return; }
      const slot = maintainerSlot(state, b, g);
      if (!slot) return;
      if (g.cell.cx === slot.cx && g.cell.cy === slot.cy) {
        g.goal = null;
        g.state = { kind: 'maintaining', buildingId: b.id, nextWanderAt: state.now + jitterInterval(b) };
        return;
      }
      g.goal = slot;
      planStep(state, g);
      return;
    }

    case 'building': {
      if (!state.buildings.has(s.buildingId)) g.state = { kind: 'idle' };
      g.goal = null;
      return;
    }

    case 'maintaining': {
      const b = state.buildings.get(s.buildingId);
      if (!b) { g.state = { kind: 'idle' }; g.goal = null; return; }
      if (!g.goal && state.now >= s.nextWanderAt) {
        const candidates = buildingFootprint(b).filter((c) =>
          (c.cx === g.cell.cx && c.cy === g.cell.cy) ||
          !isCellBlocked(state, c.cx, c.cy, g.id, b.id),
        );
        const others = candidates.filter((c) => c.cx !== g.cell.cx || c.cy !== g.cell.cy);
        const pick = others.length > 0
          ? others[Math.floor(Math.random() * others.length)]
          : candidates[Math.floor(Math.random() * candidates.length)];
        if (pick) g.goal = pick;
        s.nextWanderAt = state.now + jitterInterval(b);
      }
      if (g.goal) planStep(state, g);
      return;
    }
  }
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

// ─── Pathfinding (Bug-0) ────────────────────────────────────────────
function rightOf(d: Dir): Dir { return ((d + 1) % 4) as Dir; }
function leftOf(d: Dir): Dir { return ((d + 3) % 4) as Dir; }
function backOf(d: Dir): Dir { return ((d + 2) % 4) as Dir; }

function preferredDir(from: Cell, to: Cell): Dir {
  const dx = to.cx - from.cx;
  const dy = to.cy - from.cy;
  let best: Dir = 0;
  let bestScore = -Infinity;
  for (const d of [0, 1, 2, 3] as Dir[]) {
    const score = dx * DX[d] + dy * DY[d];
    let bonus = 0;
    if (Math.abs(dx) >= Math.abs(dy)) {
      if (DX[d] !== 0) bonus = 0.1;
    } else {
      if (DY[d] !== 0) bonus = 0.1;
    }
    const total = score + bonus;
    if (total > bestScore) { bestScore = total; best = d; }
  }
  return best;
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

function canStep(state: GameState, g: Goblin, d: Dir, exemptB?: number, confineB?: number): boolean {
  const nx = g.cell.cx + DX[d];
  const ny = g.cell.cy + DY[d];
  if (confineB !== undefined) {
    const b = state.buildings.get(confineB);
    if (b && !isCellInBuilding(b, nx, ny)) return false;
  }
  return !isCellBlocked(state, nx, ny, g.id, exemptB);
}

function stepInto(state: GameState, g: Goblin, d: Dir) {
  const nx = g.cell.cx + DX[d];
  const ny = g.cell.cy + DY[d];
  occupyCell(state, nx, ny, g.id);
  g.target = { cx: nx, cy: ny };
  g.facing = Math.atan2(DY[d], DX[d]);
}

function manhattan(a: Cell, b: Cell): number {
  return Math.abs(a.cx - b.cx) + Math.abs(a.cy - b.cy);
}

function planStep(state: GameState, g: Goblin) {
  if (g.target) return;
  if (!g.goal) return;
  if (g.cell.cx === g.goal.cx && g.cell.cy === g.goal.cy) {
    g.goal = null;
    g.wallMode = false;
    return;
  }
  const exemptB = exemptBuildingFor(state, g);
  const confineB = confineToBuildingFor(g);
  const pref = preferredDir(g.cell, g.goal);

  if (g.wallMode) {
    // Bug-2: only leave wall-follow once we're STRICTLY closer to the goal
    // than where we first hit the wall. Prevents oscillation along a flat wall.
    const curDist = manhattan(g.cell, g.goal);
    if (curDist < g.wallHitDist && canStep(state, g, pref, exemptB, confineB)) {
      g.wallMode = false;
      stepInto(state, g, pref);
      return;
    }
    const order: Dir[] = [rightOf(g.wallDir), g.wallDir, leftOf(g.wallDir), backOf(g.wallDir)];
    for (const d of order) {
      if (canStep(state, g, d, exemptB, confineB)) {
        stepInto(state, g, d);
        g.wallDir = d;
        return;
      }
    }
    return;
  }

  if (canStep(state, g, pref, exemptB, confineB)) {
    stepInto(state, g, pref);
    return;
  }
  // Switch to wall-follow mode (right-hand rule). Record hit distance for Bug-2 exit.
  g.wallMode = true;
  g.wallHitDist = manhattan(g.cell, g.goal);
  g.wallDir = leftOf(pref);
  const order: Dir[] = [rightOf(g.wallDir), g.wallDir, leftOf(g.wallDir), backOf(g.wallDir)];
  for (const d of order) {
    if (canStep(state, g, d, exemptB, confineB)) {
      stepInto(state, g, d);
      g.wallDir = d;
      return;
    }
  }
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
    }
    b.assignedGoblins = newAssigned;
    b.state = 'dormant';  // power resolution will flip to active if everything checks out
    appendLog(state, `${def.name} #${b.id} construction complete.`);
  }
}

// Resolve who's active vs dormant given staffing + power balance.
function resolvePowerAndState(state: GameState) {
  // Phase A: Producers (powerOutput > 0) — active iff staffed.
  // Phase B: Consumers — active iff staffed AND enough power remaining.
  // Sum production from staffed producers first.
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
