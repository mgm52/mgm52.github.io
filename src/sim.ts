import { playDecayingGoblinDeath, playDecayingGoblinSpawn, playDecayingGoldKillCash, playSound } from './audio';
import { BUILDING_DEFS, CELL, COLS, GOBLIN, GOLD_GOBLIN_CHANCE, GOLD_KILL_REWARD, KILL_REWARD, MINOTAUR_KILL_REWARD, SUMMON_UPGRADES, TICK_S, MINOTAUR, WATER_DEPLETION_PP_PER_SEC, WATER_METER_MAX, formatPower } from './config';
import {
  ALL_DIRS, Building, Cell, DX, DY, Dir, GameState, Goblin, HOLE_SIZE, Minotaur,
  appendLog, buildingAtCell, buildingCenter, buildingFootprint, buildingPerimeter,
  cellCenter, cellKey, defOf, destroyBuilding, findFreeCellNear,
  getSpawnCapacity, holeBlockedByBuilding, isCellBlocked, isCellInBuilding, isCellInWaterSource,
  isInBounds, maintainerCount, nearestCellInWaterSource, occupyCell, pushDeathEffect, pushFloater,
  releaseCell, removeGoblin, waterCarrierCount,
} from './state';

export function tick(state: GameState) {
  state.now += TICK_S;

  // ── 1. Spawn queue ────────────────────────────────────────────────
  if (state.autoSpawnEnabled) {
    state.autoSpawnTimer -= TICK_S;
    // Higher multipliers fire more often (interval / multiplier) instead of
    // queuing N goblins simultaneously — staggered cadence keeps the holes
    // pulsing evenly. One spawn per fire.
    if (state.autoSpawnTimer <= 0) {
      const cadence = SUMMON_UPGRADES.autoSpawn.intervalSeconds / Math.max(1, state.autoSpawnMultiplier);
      state.autoSpawnTimer += cadence;
      const cap = getSpawnCapacity(state);
      if (state.spawnQueue.length < cap) {
        const used = new Set(state.spawnQueue.map((s) => s.slot));
        for (let slot = 0; slot < cap; slot++) {
          if (!used.has(slot)) {
            state.spawnQueue.push({ remaining: GOBLIN.spawnTime, slot });
            break;
          }
        }
      }
    }
  }
  for (let i = state.spawnQueue.length - 1; i >= 0; i--) {
    state.spawnQueue[i].remaining -= TICK_S;
    if (state.spawnQueue[i].remaining <= 0) {
      spawnGoblin(state);
      state.spawnQueue.splice(i, 1);
    }
  }

  // ── 1b. Minotaur spawn queue ─────────────────────────────────────
  for (let i = state.minotaurSpawnQueue.length - 1; i >= 0; i--) {
    state.minotaurSpawnQueue[i].remaining -= TICK_S;
    if (state.minotaurSpawnQueue[i].remaining <= 0) {
      if (spawnMinotaur(state)) {
        state.minotaurSpawnQueue.splice(i, 1);
      } else {
        // Hole perimeter blocked — retry shortly so we don't burn the slot.
        state.minotaurSpawnQueue[i].remaining = 0.5;
      }
    }
  }

  // ── 2. Goblin updates ─────────────────────────────────────────────
  for (const g of state.goblins.values()) updateGoblin(state, g);

  // ── 2b. Minotaur updates ─────────────────────────────────────────────
  for (const t of state.minotaurs.values()) updateMinotaur(state, t);

  // ── 3. Construction progress ──────────────────────────────────────
  for (const b of state.buildings.values()) updateConstruction(state, b);

  // ── 4. Water meter depletion (before power resolution so dormancy
  //       reflects the latest meter values). Buildings with a
  //       waterDeliveryAmount lose WATER_DEPLETION_PP_PER_SEC each second.
  for (const b of state.buildings.values()) {
    const def = defOf(b);
    if (!def.waterDeliveryAmount || b.state === 'constructing') continue;
    if (b.waterMeter === undefined) b.waterMeter = 0;
    const depletion = defOf(b).waterDepletionPerSec ?? WATER_DEPLETION_PP_PER_SEC;
    b.waterMeter = Math.max(0, b.waterMeter - depletion * TICK_S);
  }

  // ── 4. Power balance + active/dormant resolution ──────────────────
  resolvePowerAndState(state);

  // ── 5. Income ─────────────────────────────────────────────────────
  for (const b of state.buildings.values()) {
    if (b.state === 'active') state.money += defOf(b).income * TICK_S;
  }

  // 1Hz floater pulse: surface per-second income for each active income
  // building so the player can see their gains accumulate.
  if (state.now >= state.nextIncomeFloatAt) {
    for (const b of state.buildings.values()) {
      if (b.state !== 'active') continue;
      const def = defOf(b);
      if (def.income <= 0) continue;
      const c = buildingCenter(b);
      pushFloater(state, c.x, c.y, `+Ƶ${def.income.toLocaleString('en-US')}`, 0xffd96b);
    }
    state.nextIncomeFloatAt = state.now + 1;
  }

  // Expire aged-out floaters and death-effect markers.
  for (let i = state.floaters.length - 1; i >= 0; i--) {
    const f = state.floaters[i];
    if (state.now - f.spawnAt >= f.lifetime) state.floaters.splice(i, 1);
  }
  for (let i = state.deathEffects.length - 1; i >= 0; i--) {
    if (state.now - state.deathEffects[i].spawnAt >= 2) state.deathEffects.splice(i, 1);
  }
}


function spawnGoblin(state: GameState) {
  // Round-robin between the main hole and every completed Goblin Hole. A
  // freshly-built hole is added to the rotation automatically.
  const holeCells: Cell[] = [{ cx: state.hole.cell.cx, cy: state.hole.cell.cy }];
  const isMain: boolean[] = [true];
  for (const b of state.buildings.values()) {
    if (b.kind !== 'goblin_hole') continue;
    if (b.state === 'constructing') continue;
    holeCells.push({ cx: b.cell.cx, cy: b.cell.cy });
    isMain.push(false);
  }
  // Try each hole starting at the rotation index; pick the first that yields
  // a free perimeter cell. Bump rotation regardless so spawns spread out.
  const start = state.spawnHoleRotation % holeCells.length;
  let cell: Cell | null = null;
  for (let i = 0; i < holeCells.length; i++) {
    const idx = (start + i) % holeCells.length;
    if (isMain[idx] && holeBlockedByBuilding(state)) continue;
    cell = pickHolePerimeterCellAt(state, holeCells[idx])
        ?? findFreeCellNear(state, holeCells[idx].cx, holeCells[idx].cy);
    if (cell) {
      state.spawnHoleRotation = idx + 1;
      break;
    }
  }
  if (!cell) {
    state.money += GOBLIN.spawnCost;
    appendLog(state, 'All Goblin Holes blocked; spawn refunded.');
    playSound('error');
    return;
  }
  const id = state.nextId++;
  const isGold = state.goldgoblinsEnabled && Math.random() < GOLD_GOBLIN_CHANCE;
  const g: Goblin = {
    id, pos: cellCenter(cell), cell,
    target: null, goal: null,
    path: [],
    facing: Math.PI / 2,
    state: { kind: 'idle' }, selected: false, idleSince: null, lastCellChangedAt: state.now,
    gold: isGold || undefined,
  };
  state.goblins.set(id, g);
  occupyCell(state, cell.cx, cell.cy, id);
  state.spawnsCompleted++;
  // Decaying-volume helper in audio.ts so a wall of late-game goblins
  // doesn't drown the rest of the soundscape.
  playDecayingGoblinSpawn();
  appendLog(state, isGold ? `Gold Goblin #${id} hatched!` : `Goblin #${id} hatched.`);
  if (state.autoAssignEnabled) autoAssignAllIdle(state);
}

// Fill every understaffed building from the pool of idle goblins, picking the
// closest idle goblin for each open slot. Tier order is constructing > dormant
// > active-short-on-maintainers; within a tier, fewer-currently-assigned wins
// the next pick (so two equally-needy buildings get filled evenly).
export function autoAssignAllIdle(state: GameState) {
  if (!state.autoAssignEnabled) return;

  type Need = { b: Building; tier: number; slots: number; center: { x: number; y: number } };
  const needs: Need[] = [];
  for (const b of state.buildings.values()) {
    const def = defOf(b);
    const required = b.state === 'constructing' ? def.buildersRequired : def.maintainersRequired;
    const slots = required - b.assignedGoblins.length;
    if (slots <= 0) continue;
    const tier =
      b.state === 'constructing' ? 3 :
      b.state === 'dormant' ? 2 : 1;
    needs.push({ b, tier, slots, center: buildingCenter(b) });
  }
  if (needs.length === 0) return;

  const idle: Goblin[] = [];
  for (const g of state.goblins.values()) {
    if (g.state.kind === 'idle') idle.push(g);
  }

  // First: keep every thirsty building staffed with its auto-assign target
  // of carriers as long as a water source exists and idle goblins remain.
  // (Manual right-click ignores this cap.)
  if (state.waterSources.size > 0) {
    for (const b of state.buildings.values()) {
      const def = defOf(b);
      const target = def.waterAutoAssignTarget ?? 0;
      if (target === 0) continue;
      if (b.state === 'constructing') continue;
      // Don't pull goblins onto water duty until the building is fully
      // staffed — maintainers are the more pressing need, and water
      // delivery doesn't even land while understaffed.
      if (maintainerCount(state, b) < def.maintainersRequired) continue;
      const source = nearestWaterSourceTo(state, b);
      if (!source) break;
      while (waterCarrierCount(state, b) < target && idle.length > 0) {
        const c = buildingCenter(b);
        let pickI = 0;
        let pickD = Infinity;
        for (let i = 0; i < idle.length; i++) {
          const g = idle[i];
          const dx = g.pos.x - c.x;
          const dy = g.pos.y - c.y;
          const d = dx * dx + dy * dy;
          if (d < pickD) { pickD = d; pickI = i; }
        }
        const g = idle.splice(pickI, 1)[0];
        b.assignedGoblins.push(g.id);
        g.goal = null;
        g.path = [];
        g.state = { kind: 'fetching_water', buildingId: b.id, sourceId: source.id, phase: 'to_source' };
        g.lastCellChangedAt = state.now;
      }
      if (idle.length === 0) break;
    }
  }

  while (idle.length > 0) {
    let best: Need | null = null;
    for (const n of needs) {
      if (n.slots <= 0) continue;
      if (!best
          || n.tier > best.tier
          || (n.tier === best.tier && n.b.assignedGoblins.length < best.b.assignedGoblins.length)) {
        best = n;
      }
    }
    if (!best) return;

    let pickI = 0;
    let pickD = Infinity;
    for (let i = 0; i < idle.length; i++) {
      const g = idle[i];
      const dx = g.pos.x - best.center.x;
      const dy = g.pos.y - best.center.y;
      const d = dx * dx + dy * dy;
      if (d < pickD) { pickD = d; pickI = i; }
    }
    const g = idle.splice(pickI, 1)[0];
    best.b.assignedGoblins.push(g.id);
    g.goal = null;
    g.path = [];
    g.state = best.b.state === 'constructing'
      ? { kind: 'going_to_build', buildingId: best.b.id }
      : { kind: 'going_to_maintain', buildingId: best.b.id };
    best.slots--;
  }
}

// Pop a minotaur out of the goblin hole. Minotaurs don't queue/take spawn time —
// summoning is instant; if the hole and its perimeter are fully blocked, the
// summon refunds.
export function spawnMinotaur(state: GameState): boolean {
  const cell = pickMinotaurSpawnCell(state);
  if (!cell) return false;
  const id = state.nextId++;
  const t: Minotaur = {
    id,
    pos: cellCenter(cell),
    cell,
    target: null,
    facing: 0,
    state: { kind: 'wander' },
    nextWanderAt: state.now + MINOTAUR.wanderInterval,
    selected: false,
  };
  state.minotaurs.set(id, t);
  appendLog(state, `Minotaur #${id} crawls out of the hole.`);
  playSound('goblin_spawn', 1.4, 0.3);
  return true;
}

function minotaurWalkable(state: GameState, cx: number, cy: number, selfId?: number): boolean {
  if (!isInBounds(cx, cy)) return false;
  if (state.walls.has(cellKey(cx, cy))) return false;
  if (buildingAtCell(state, cx, cy)) return false;
  // Reserve cells already held — current cell or in-flight step target — by
  // any other minotaur. Two of them must never share a square.
  for (const m of state.minotaurs.values()) {
    if (m.id === selfId) continue;
    if (m.cell.cx === cx && m.cell.cy === cy) return false;
    if (m.target && m.target.cx === cx && m.target.cy === cy) return false;
  }
  return true;
}

function minotaurStepToward(state: GameState, t: Minotaur, target: Cell): Cell | null {
  // Pick the 8-neighbor with smallest Chebyshev distance to the target cell.
  let best: Cell | null = null;
  let bestDist = Infinity;
  for (const d of ALL_DIRS) {
    const nx = t.cell.cx + DX[d];
    const ny = t.cell.cy + DY[d];
    if (!minotaurWalkable(state, nx, ny, t.id)) continue;
    const dist = Math.max(Math.abs(nx - target.cx), Math.abs(ny - target.cy));
    if (dist < bestDist) { bestDist = dist; best = { cx: nx, cy: ny }; }
  }
  return best;
}

function minotaurWanderStep(state: GameState, t: Minotaur): Cell | null {
  const choices: Cell[] = [];
  for (const d of ALL_DIRS) {
    const nx = t.cell.cx + DX[d];
    const ny = t.cell.cy + DY[d];
    if (minotaurWalkable(state, nx, ny, t.id)) choices.push({ cx: nx, cy: ny });
  }
  if (choices.length === 0) return null;
  return choices[Math.floor(Math.random() * choices.length)];
}

function nearestGoblin(state: GameState, t: Minotaur): Goblin | null {
  let best: Goblin | null = null;
  let bestD = Infinity;
  for (const g of state.goblins.values()) {
    // Goblins inside building footprints (workers/maintainers, plus any idle
    // straggler on a footprint cell) are sheltered from minotaurs.
    if (buildingAtCell(state, g.cell.cx, g.cell.cy)) continue;
    const dx = g.pos.x - t.pos.x;
    const dy = g.pos.y - t.pos.y;
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = g; }
  }
  return best;
}

function chebyshevToBuilding(cell: Cell, b: Building): number {
  const n = defOf(b).cellSize;
  const right = b.cell.cx + n - 1;
  const bottom = b.cell.cy + n - 1;
  const dx = Math.max(0, b.cell.cx - cell.cx, cell.cx - right);
  const dy = Math.max(0, b.cell.cy - cell.cy, cell.cy - bottom);
  return Math.max(dx, dy);
}

function minotaurStepTowardBuilding(state: GameState, t: Minotaur, b: Building): Cell | null {
  let best: Cell | null = null;
  let bestDist = Infinity;
  for (const d of ALL_DIRS) {
    const nx = t.cell.cx + DX[d];
    const ny = t.cell.cy + DY[d];
    if (!minotaurWalkable(state, nx, ny, t.id)) continue;
    const dist = chebyshevToBuilding({ cx: nx, cy: ny }, b);
    if (dist < bestDist) { bestDist = dist; best = { cx: nx, cy: ny }; }
  }
  return best;
}

function updateMinotaur(state: GameState, t: Minotaur) {
  // Mid-step pixel lerp (shared with goblin movement model).
  if (t.target) {
    const tc = cellCenter(t.target);
    const dx = tc.x - t.pos.x;
    const dy = tc.y - t.pos.y;
    const d = Math.hypot(dx, dy);
    const step = MINOTAUR.speed * TICK_S;
    if (d <= step + MINOTAUR.arriveDist) {
      t.cell = t.target;
      t.pos = tc;
      t.target = null;
    } else {
      t.pos.x += (dx / d) * step;
      t.pos.y += (dy / d) * step;
      t.facing = Math.atan2(dy, dx);
      return;
    }
  }

  // Player-issued commands take priority over auto-targeting.
  if (t.state.kind === 'moving_to') {
    const goal = t.state.goal;
    if (t.cell.cx === goal.cx && t.cell.cy === goal.cy) {
      t.state = { kind: 'wander' };
      t.nextWanderAt = state.now + MINOTAUR.wanderInterval;
      return;
    }
    const next = minotaurStepToward(state, t, goal);
    if (next) {
      t.target = next;
      t.facing = Math.atan2(next.cy - t.cell.cy, next.cx - t.cell.cx);
    } else {
      // Boxed in — give up the order and resume normal behavior next tick.
      t.state = { kind: 'wander' };
      t.nextWanderAt = state.now + MINOTAUR.wanderInterval;
    }
    return;
  }

  if (t.state.kind === 'going_to_destroy') {
    const b = state.buildings.get(t.state.buildingId);
    if (!b) {
      t.state = { kind: 'wander' };
      t.nextWanderAt = state.now + MINOTAUR.wanderInterval;
      return;
    }
    const s = t.state;
    if (chebyshevToBuilding(t.cell, b) <= 1) {
      if (s.attackAt === undefined) {
        const c = buildingCenter(b);
        s.attackAt = state.now + MINOTAUR.attackWindup;
        t.facing = Math.atan2(c.y - t.pos.y, c.x - t.pos.x);
        return;
      }
      if (state.now < s.attackAt) return;
      const c = buildingCenter(b);
      const def = defOf(b);
      appendLog(state, `Minotaur #${t.id} smashes ${def.name} #${b.id}.`);
      pushDeathEffect(state, c.x, c.y);
      destroyBuilding(state, b.id);
      playSound('destroy', 0.5);
      t.state = { kind: 'wander' };
      t.nextWanderAt = state.now + MINOTAUR.wanderInterval;
      return;
    }
    const next = minotaurStepTowardBuilding(state, t, b);
    if (next) {
      t.target = next;
      t.facing = Math.atan2(next.cy - t.cell.cy, next.cx - t.cell.cx);
    }
    return;
  }

  if (t.state.kind === 'going_to_kill_minotaur') {
    const target = state.minotaurs.get(t.state.targetId);
    if (!target || target.id === t.id) {
      t.state = { kind: 'wander' };
      t.nextWanderAt = state.now + MINOTAUR.wanderInterval;
      return;
    }
    const s = t.state;
    const cdx = Math.abs(target.cell.cx - t.cell.cx);
    const cdy = Math.abs(target.cell.cy - t.cell.cy);
    if (Math.max(cdx, cdy) <= 1) {
      if (s.attackAt === undefined) {
        s.attackAt = state.now + MINOTAUR.attackWindup;
        t.facing = Math.atan2(target.pos.y - t.pos.y, target.pos.x - t.pos.x);
        return;
      }
      if (state.now < s.attackAt) return;
      const tx = target.pos.x, ty = target.pos.y;
      state.minotaurs.delete(target.id);
      state.money += MINOTAUR_KILL_REWARD.money;
      state.blood += MINOTAUR_KILL_REWARD.blood;
      state.bloodUnlocked = true;
      pushFloater(state, tx, ty, `+Ƶ${MINOTAUR_KILL_REWARD.money.toLocaleString('en-US')}`, 0xffd96b, 1.6);
      pushFloater(state, tx, ty - 14, `+${MINOTAUR_KILL_REWARD.blood} blood`, 0xff8a8a, 1.6);
      pushDeathEffect(state, tx, ty);
      playSound('goblin_death', 0.56, 0.3);
      appendLog(state, `Minotaur #${target.id} gored by Minotaur #${t.id}.`);
      t.state = { kind: 'wander' };
      t.nextWanderAt = state.now + MINOTAUR.wanderInterval;
      return;
    }
    const next = minotaurStepToward(state, t, target.cell);
    if (next) {
      t.target = next;
      t.facing = Math.atan2(next.cy - t.cell.cy, next.cx - t.cell.cx);
    }
    return;
  }

  const target = nearestGoblin(state, t);
  if (target) {
    if (t.state.kind !== 'going_to_kill' || t.state.targetId !== target.id) {
      t.state = { kind: 'going_to_kill', targetId: target.id };
    }
    const s = t.state;
    const cdx = Math.abs(target.cell.cx - t.cell.cx);
    const cdy = Math.abs(target.cell.cy - t.cell.cy);
    if (Math.max(cdx, cdy) <= 1) {
      // Windup → kill.
      if (s.attackAt === undefined) {
        s.attackAt = state.now + MINOTAUR.attackWindup;
        t.facing = Math.atan2(target.pos.y - t.pos.y, target.pos.x - t.pos.x);
        return;
      }
      if (state.now < s.attackAt) return;
      const tx = target.pos.x, ty = target.pos.y;
      const reward = goblinKillReward(state, target);
      const wasGold = !!target.gold;
      removeGoblin(state, target.id);
      state.money += reward.money;
      state.blood += reward.blood;
      state.bloodUnlocked = true;
      pushFloater(state, tx, ty, `+Ƶ${reward.money.toLocaleString('en-US')}`, 0xffd96b, 1.6);
      pushFloater(state, tx, ty - 14, `+${reward.blood} blood`, 0xff8a8a, 1.6);
      pushDeathEffect(state, tx, ty);
      playDecayingGoblinDeath();
      if (wasGold) playDecayingGoldKillCash();
      appendLog(state, `Goblin #${target.id} killed by Minotaur #${t.id}.`);
      t.state = { kind: 'wander' };
      t.nextWanderAt = state.now + MINOTAUR.wanderInterval;
      return;
    }
    // Step one cell toward the target.
    const next = minotaurStepToward(state, t, target.cell);
    if (next) {
      t.target = next;
      t.facing = Math.atan2(next.cy - t.cell.cy, next.cx - t.cell.cx);
    }
    return;
  }

  // No goblins — wander.
  if (t.state.kind !== 'wander') t.state = { kind: 'wander' };
  if (state.now >= t.nextWanderAt) {
    const next = minotaurWanderStep(state, t);
    if (next) {
      t.target = next;
      t.facing = Math.atan2(next.cy - t.cell.cy, next.cx - t.cell.cx);
    }
    t.nextWanderAt = state.now + MINOTAUR.wanderInterval;
  }
}

export function nearestWaterSourceTo(state: GameState, b: Building) {
  const c = buildingCenter(b);
  let best = null;
  let bestD = Infinity;
  for (const w of state.waterSources.values()) {
    // Use region center for distance comparison.
    const wcx = (w.x0 + w.x1) / 2 * CELL;
    const wcy = (w.y0 + w.y1) / 2 * CELL;
    const dx = wcx - c.x;
    const dy = wcy - c.y;
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = w; }
  }
  return best;
}

// Standard kill payout, with a fatter pile for gold-tinted goblins. The
// gold multiplier (1 by default, 10 with Goldgoblins x10) scales the money
// drop without touching the blood reward.
function goblinKillReward(state: GameState, g: Goblin) {
  if (!g.gold) return KILL_REWARD;
  return {
    money: GOLD_KILL_REWARD.money * state.goldgoblinMultiplier,
    blood: GOLD_KILL_REWARD.blood,
  };
}

// Closest unblocked perimeter cell of `b` to the goblin — used by water
// carriers as the "delivery" cell where they touch the Datacentre.
function pickDcDeliveryCell(state: GameState, b: Building, g: Goblin): Cell | null {
  let best: Cell | null = null;
  let bestD = Infinity;
  for (const c of buildingPerimeter(b)) {
    if (isCellBlocked(state, c.cx, c.cy, g.id)) continue;
    const d = (c.cx - g.cell.cx) * (c.cx - g.cell.cx) + (c.cy - g.cell.cy) * (c.cy - g.cell.cy);
    if (d < bestD) { bestD = d; best = c; }
  }
  return best;
}

function nearestFreeNeighbor(state: GameState, cell: Cell, hunter: Goblin): Cell | null {
  let best: Cell | null = null;
  let bestDist = Infinity;
  for (const d of ALL_DIRS) {
    const cx = cell.cx + DX[d];
    const cy = cell.cy + DY[d];
    if (!isInBounds(cx, cy)) continue;
    if (cx === hunter.cell.cx && cy === hunter.cell.cy) return { cx, cy };
    if (isCellBlocked(state, cx, cy, hunter.id)) continue;
    const dist = Math.hypot(cx - hunter.cell.cx, cy - hunter.cell.cy);
    if (dist < bestDist) { best = { cx, cy }; bestDist = dist; }
  }
  return best;
}

// Cells on the ring just outside the 2×2 hole footprint, sorted with a
// strong rightward bias and a mild "stay near the centerline" tiebreak.
// Same ring as `pickHolePerimeterCell` but the spawn-blocked check ignores
// goblin occupancy (a fresh minotaur can crowd onto a goblin's cell — it'll
// just kill them on the next tick) and rejects cells already held by another
// minotaur. Used at summon time to prevent two minotaurs sharing a square.
function pickMinotaurSpawnCell(state: GameState): Cell | null {
  const h = state.hole.cell;
  const cx0 = h.cx + (HOLE_SIZE - 1) / 2;
  const cy0 = h.cy + (HOLE_SIZE - 1) / 2;
  const ring: Cell[] = [];
  for (let dx = -1; dx <= HOLE_SIZE; dx++) {
    for (let dy = -1; dy <= HOLE_SIZE; dy++) {
      const inHole = dx >= 0 && dx < HOLE_SIZE && dy >= 0 && dy < HOLE_SIZE;
      if (inHole) continue;
      ring.push({ cx: h.cx + dx, cy: h.cy + dy });
    }
  }
  ring.sort((a, b) => {
    const sa = (a.cx - cx0) - 0.25 * Math.abs(a.cy - cy0);
    const sb = (b.cx - cx0) - 0.25 * Math.abs(b.cy - cy0);
    return sb - sa;
  });
  for (const c of ring) {
    if (minotaurWalkable(state, c.cx, c.cy)) return c;
  }
  return null;
}

function pickHolePerimeterCellAt(state: GameState, h: Cell): Cell | null {
  const cx0 = h.cx + (HOLE_SIZE - 1) / 2;
  const cy0 = h.cy + (HOLE_SIZE - 1) / 2;
  const ring: Cell[] = [];
  for (let dx = -1; dx <= HOLE_SIZE; dx++) {
    for (let dy = -1; dy <= HOLE_SIZE; dy++) {
      const inHole = dx >= 0 && dx < HOLE_SIZE && dy >= 0 && dy < HOLE_SIZE;
      if (inHole) continue;
      ring.push({ cx: h.cx + dx, cy: h.cy + dy });
    }
  }
  ring.sort((a, b) => {
    const sa = (a.cx - cx0) - 0.25 * Math.abs(a.cy - cy0);
    const sb = (b.cx - cx0) - 0.25 * Math.abs(b.cy - cy0);
    return sb - sa;
  });
  for (const c of ring) {
    if (!isCellBlocked(state, c.cx, c.cy)) return c;
  }
  return null;
}

function pickHolePerimeterCell(state: GameState): Cell | null {
  return pickHolePerimeterCellAt(state, state.hole.cell);
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
      g.lastCellChangedAt = state.now;
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

      // Pick the deepest free footprint cell as the goal, where depth = rings
      // from the edge. A goblin only commits once it stands at max-depth among
      // currently-free cells; otherwise it keeps walking inward. This stops
      // first-arrivals from corking the doorway on big builds (e.g. DC needs 15).
      const footprint = buildingFootprint(b);
      const isFreeForMe = (c: Cell) =>
        (c.cx === g.cell.cx && c.cy === g.cell.cy) ||
        !isCellBlocked(state, c.cx, c.cy, g.id, b.id);
      const free = footprint.filter(isFreeForMe);
      if (free.length === 0) return; // every cell blocked; wait a tick

      let maxDepth = -1;
      for (const c of free) {
        const d = cellDepth(b, c.cx, c.cy);
        if (d > maxDepth) maxDepth = d;
      }

      const insideFootprint = isCellInBuilding(b, g.cell.cx, g.cell.cy);
      if (insideFootprint && cellDepth(b, g.cell.cx, g.cell.cy) >= maxDepth) {
        tryBecomeBuilder();
        return;
      }

      const candidates = free
        .filter(c => cellDepth(b, c.cx, c.cy) === maxDepth)
        .sort((a, c) =>
          Math.hypot(a.cx - g.cell.cx, a.cy - g.cell.cy) -
          Math.hypot(c.cx - g.cell.cx, c.cy - g.cell.cy));
      const slot = candidates[0];
      if (!g.goal || g.goal.cx !== slot.cx || g.goal.cy !== slot.cy) {
        g.goal = slot;
        g.path = [];
      }
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
      const bb = state.buildings.get(s.buildingId);
      if (!bb) { g.state = { kind: 'idle' }; g.goal = null; g.path = []; return; }
      // Random idle-fidget every ~5s while standing inside the footprint
      // (typically waiting for the rest of the build crew to show up). Picks
      // a free 8-neighbor cell that's still inside the footprint and steps
      // there. No-ops if the goblin is already in motion (target set).
      if (s.nextWanderAt === undefined) s.nextWanderAt = state.now + 5;
      if (!g.target && state.now >= s.nextWanderAt) {
        const choices: Dir[] = [];
        for (const d of ALL_DIRS) {
          const nx = g.cell.cx + DX[d];
          const ny = g.cell.cy + DY[d];
          if (!isCellInBuilding(bb, nx, ny)) continue;
          if (!canStep(state, g.cell.cx, g.cell.cy, nx, ny, g.id, bb.id)) continue;
          choices.push(d);
        }
        if (choices.length > 0) {
          const chosen = choices[Math.floor(Math.random() * choices.length)];
          const nx = g.cell.cx + DX[chosen];
          const ny = g.cell.cy + DY[chosen];
          occupyCell(state, nx, ny, g.id);
          g.target = { cx: nx, cy: ny };
          g.facing = Math.atan2(DY[chosen], DX[chosen]);
        }
        s.nextWanderAt = state.now + 5;
      }
      g.goal = null;
      g.path = [];
      return;
    }

    case 'fetching_water': {
      const b = state.buildings.get(s.buildingId);
      const src = state.waterSources.get(s.sourceId);
      if (!b || !src) {
        // DC was destroyed or source vanished — drop the role.
        if (b) {
          const i = b.assignedGoblins.indexOf(g.id);
          if (i >= 0) b.assignedGoblins.splice(i, 1);
        }
        g.state = { kind: 'idle' };
        g.goal = null;
        g.path = [];
        return;
      }
      // Stuck check: if the goblin hasn't progressed a cell in 3s while on
      // water duty, drop the role and idle.
      if (state.now - g.lastCellChangedAt > 3) {
        const i = b.assignedGoblins.indexOf(g.id);
        if (i >= 0) b.assignedGoblins.splice(i, 1);
        appendLog(state, `Goblin #${g.id} stuck — water duty cancelled.`);
        g.state = { kind: 'idle' };
        g.goal = null;
        g.path = [];
        return;
      }
      // 'to_source' counts as arrived once we step into ANY cell of the water
      // region AND have stood there for at least 1s (the goblin has to dip
      // their bucket — instant jumping to to_dc looked silly).
      if (s.phase === 'to_source') {
        if (isCellInWaterSource(src, g.cell)) {
          if (s.collectingSince === undefined) s.collectingSince = state.now;
          // While dwelling, hold position — clear any goal so planStep
          // doesn't keep nudging us forward.
          g.goal = null;
          g.path = [];
          if (state.now - s.collectingSince >= 1) {
            s.phase = 'to_dc';
            s.initialTarget = undefined;  // first trip done; closest point thereafter
            s.collectingSince = undefined;
          }
          return;
        }
        // Stepped back out (or never arrived) — reset the dwell timer.
        s.collectingSince = undefined;
        // First trip aims at the click cell; later trips pick the closest
        // reachable cell in the source region. If the click cell turns out to
        // be unreachable, fall back to the closest in the same tick.
        const desired = s.initialTarget ?? nearestCellInWaterSource(src, g.cell);
        if (!g.goal || g.goal.cx !== desired.cx || g.goal.cy !== desired.cy) {
          g.goal = desired;
          g.path = [];
        }
        planStep(state, g);
        if (!g.target && s.initialTarget) {
          // Couldn't path to the click cell — drop it and try the closest.
          s.initialTarget = undefined;
          const fallback = nearestCellInWaterSource(src, g.cell);
          g.goal = fallback;
          g.path = [];
          planStep(state, g);
        }
        return;
      }
      // phase === 'to_dc'
      const dcTarget = pickDcDeliveryCell(state, b, g) ?? buildingPerimeter(b)[0];
      if (!dcTarget) return;
      if (g.cell.cx === dcTarget.cx && g.cell.cy === dcTarget.cy) {
        // Delivery: bump the building's water meter — but only if the
        // building is fully staffed. A half-built crew can't keep the
        // tanks online, so the carrier's water "spills" until maintainers
        // are in place.
        const delivery = defOf(b).waterDeliveryAmount ?? 0;
        const def2 = defOf(b);
        const fullyStaffed = maintainerCount(state, b) >= def2.maintainersRequired;
        if (delivery > 0 && fullyStaffed) {
          b.waterMeter = Math.min(WATER_METER_MAX, (b.waterMeter ?? 0) + delivery);
          playSound('water_splash', 0.5);
        }
        s.firstLoopDone = true;
        s.phase = 'to_source';
        g.goal = null;
        g.path = [];
        return;
      }
      if (!g.goal || g.goal.cx !== dcTarget.cx || g.goal.cy !== dcTarget.cy) {
        g.goal = dcTarget;
        g.path = [];
      }
      planStep(state, g);
      return;
    }

    case 'going_to_kill': {
      const target = state.goblins.get(s.targetId);
      if (!target || target.id === g.id) {
        g.state = { kind: 'idle' };
        g.goal = null;
        g.path = [];
        return;
      }
      const dx = Math.abs(target.cell.cx - g.cell.cx);
      const dy = Math.abs(target.cell.cy - g.cell.cy);
      if (Math.max(dx, dy) <= 1) {
        // Windup → swing → kill. Holding for a beat lets the swipe animation
        // visibly play before the target vanishes.
        if (s.attackAt === undefined) {
          s.attackAt = state.now + 0.4;
          g.facing = Math.atan2(target.pos.y - g.pos.y, target.pos.x - g.pos.x);
          g.goal = null;
          g.path = [];
          return;
        }
        if (state.now < s.attackAt) {
          g.goal = null;
          g.path = [];
          return;
        }
        const tx = target.pos.x, ty = target.pos.y;
        const reward = goblinKillReward(state, target);
        const wasGold = !!target.gold;
        removeGoblin(state, target.id);
        state.money += reward.money;
        state.blood += reward.blood;
        state.bloodUnlocked = true;
        pushFloater(state, tx, ty, `+Ƶ${reward.money.toLocaleString('en-US')}`, 0xffd96b, 1.6);
        pushFloater(state, tx, ty - 14, `+${reward.blood} blood`, 0xff8a8a, 1.6);
        pushDeathEffect(state, tx, ty);
        playSound('goblin_death', 0.56);
        if (wasGold) playSound('cash', 0.7);
        appendLog(state, `Goblin #${target.id} killed by #${g.id}.`);
        g.state = { kind: 'idle' };
        g.goal = null;
        g.path = [];
        return;
      }
      // Target's own cell is blocked by the target itself, so we'd never
      // path there — head to the closest free 8-neighbor instead.
      s.attackAt = undefined;
      const adj = nearestFreeNeighbor(state, target.cell, g);
      if (!adj) { g.path = []; return; }
      if (!g.goal || g.goal.cx !== adj.cx || g.goal.cy !== adj.cy) {
        g.goal = adj;
        g.path = [];
      }
      planStep(state, g);
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

// Concentric-ring depth of a footprint cell: 0 on the outer ring, increasing
// inward. Used by `going_to_build` to send arrivals to the deepest free spot.
function cellDepth(b: Building, cx: number, cy: number): number {
  const n = defOf(b).cellSize;
  const lx = cx - b.cell.cx;
  const ly = cy - b.cell.cy;
  return Math.min(lx, ly, n - 1 - lx, n - 1 - ly);
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

// Cardinals first, diagonals last. Every step costs 1 in this BFS, so
// cardinal and diagonal moves tie — and whichever neighbor is enqueued first
// claims the cell and freezes the prev-link. Visiting cardinals first means a
// straight-axis step wins ties over a diagonal that would happen to land on
// the same cell, so paths hug the axis instead of drifting "wide" before
// curving back.
const BFS_DIRS: Dir[] = [0, 2, 4, 6, 1, 3, 5, 7];

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
    for (const d of BFS_DIRS) {
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
    // Buildings with no power draw and no maintainers (e.g. Goblin Hole)
    // skip resolvePowerAndState and stay where we put them, so finish them
    // straight to active.
    b.state = (def.maintainersRequired === 0 && def.powerOutput === 0) ? 'active' : 'dormant';
    playSound('build_done');
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
    // DC counts as watered only with at least one EFFECTIVE carrier (one
    // who has completed a full source → DC loop). Carriers mid-first-loop
    // are already counted in waterCarrierCount so they don't trigger more
    // assignments, but they don't make the DC operational.
    // New mechanic: a building with `waterDeliveryAmount` is watered while
    // its meter is > 0. Carriers replenish on each delivery and the meter
    // depletes between deliveries.
    const drinks = (def.waterDeliveryAmount ?? 0) > 0;
    const watered = !drinks || (b.waterMeter ?? 0) > 0;
    let reason: 'no_staff' | 'no_power' | 'no_water' | undefined;
    let active = false;
    if (!staffed) reason = 'no_staff';
    else if (!watered) reason = 'no_water';
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
  reason: 'no_staff' | 'no_power' | 'no_water' | undefined,
) {
  const def = defOf(b);
  if (active) {
    if (b.state !== 'active') {
      b.state = 'active';
      playSound('online');
      appendLog(state, `${def.name} #${b.id} online.`);
      const c = buildingCenter(b);
      if (def.powerOutput > 0) {
        pushFloater(state, c.x, c.y, `+${formatPower(def.powerOutput)}`, 0x8acfff, 1.6);
      } else if (def.powerOutput < 0) {
        pushFloater(state, c.x, c.y, `-${formatPower(-def.powerOutput)}`, 0x8acfff, 1.6);
      }
    }
  } else {
    if (b.state !== 'dormant') {
      b.state = 'dormant';
      const why =
        reason === 'no_power' ? 'underpowered' :
        reason === 'no_water' ? 'needs water' :
        `needs ${def.maintainersRequired} maintainer${def.maintainersRequired === 1 ? '' : 's'}`;
      appendLog(state, `${def.name} #${b.id} dormant — ${why}.`);
    }
  }
}
