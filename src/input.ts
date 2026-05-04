import { Application, Container, FederatedPointerEvent, Graphics } from 'pixi.js';
import { playSound } from './audio';
import { flashCursor } from './cursor-fx';
import { BUILDING_DEFS, BuildingKind, CELL, GOBLIN, MINOTAUR, RENDER_SCALE, WORLD, formatPower } from './config';
import { unlockOptionsCog } from './options-ui';
import { RenderContext, clampCamera } from './render';
import { autoAssignAllIdle } from './sim';
import {
  Building, Cell, GameState, Goblin, Minotaur, WaterSource,
  appendLog, buildingAtCell, cellKey, defOf, findFreeCellNear,
  holeAtCell, isCellBlocked, isInBounds, pixelToCell, waterCarrierCount, waterSourceAtCell,
} from './state';

type ActivePointer = {
  startX: number; startY: number;
  x: number; y: number;
  worldStartX: number; worldStartY: number;
};

type InputState = {
  isDragging: boolean;
  dragStart: { x: number; y: number };
  selectionGfx: Graphics;
  placementGhost: Graphics;
  // Multi-touch / long-press tracking
  pointers: Map<number, ActivePointer>;
  panLast: { x: number; y: number } | null;
  longPressTimer: number | null;
  longPressPointerId: number | null;
  longPressFired: boolean;
};

const LONG_PRESS_MS = 450;
const LONG_PRESS_MOVE_TOL = 10; // screen-space px

export function setupInput(
  state: GameState,
  app: Application,
  uiLayer: Container,
  worldLayer: Container,
  ctx: RenderContext,
) {
  const selectionGfx = new Graphics();
  const placementGhost = new Graphics();
  uiLayer.addChild(selectionGfx);
  uiLayer.addChild(placementGhost);

  const input: InputState = {
    isDragging: false,
    dragStart: { x: 0, y: 0 },
    selectionGfx, placementGhost,
    pointers: new Map(),
    panLast: null,
    longPressTimer: null,
    longPressPointerId: null,
    longPressFired: false,
  };

  app.stage.eventMode = 'static';
  // Receive pointer events anywhere on the canvas (regardless of camera position).
  app.stage.hitArea = { contains: () => true };
  app.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  app.stage.on('pointerdown', (e: FederatedPointerEvent) => {
    const local = e.getLocalPosition(worldLayer);
    input.pointers.set(e.pointerId, {
      startX: e.global.x, startY: e.global.y,
      x: e.global.x, y: e.global.y,
      worldStartX: local.x, worldStartY: local.y,
    });

    // Two or more pointers → enter pan mode and abandon any single-pointer interaction.
    if (input.pointers.size >= 2) {
      cancelLongPress(input);
      input.isDragging = false;
      input.selectionGfx.clear();
      const pts = [...input.pointers.values()];
      input.panLast = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
      return;
    }

    if (e.button === 2) {
      flashCursor(e.clientX, e.clientY);
      handleRightClick(state, local.x, local.y);
      return;
    }
    if (state.pendingBuild) {
      placeBuilding(state, local.x, local.y);
      drawGhost(input, local.x, local.y, state);
      return;
    }
    // Schedule long-press → "right-click" on touch.
    if (e.pointerType === 'touch') {
      scheduleLongPress(input, e.pointerId, state, worldLayer);
    }
    input.isDragging = true;
    input.dragStart = { x: local.x, y: local.y };
    input.selectionGfx.clear();
  });

  app.stage.on('pointermove', (e: FederatedPointerEvent) => {
    const tracked = input.pointers.get(e.pointerId);
    if (tracked) {
      tracked.x = e.global.x;
      tracked.y = e.global.y;
    }

    // Two-finger pan: compute midpoint delta in screen-space, apply to camera in world units.
    if (input.pointers.size >= 2 && input.panLast) {
      const pts = [...input.pointers.values()];
      const midX = (pts[0].x + pts[1].x) / 2;
      const midY = (pts[0].y + pts[1].y) / 2;
      const dx = midX - input.panLast.x;
      const dy = midY - input.panLast.y;
      ctx.camera.x -= dx / RENDER_SCALE;
      ctx.camera.y -= dy / RENDER_SCALE;
      clampCamera(ctx);
      input.panLast = { x: midX, y: midY };
      return;
    }

    // Cancel long-press if the finger moved too far.
    if (input.longPressPointerId === e.pointerId && tracked) {
      const moved = Math.hypot(tracked.x - tracked.startX, tracked.y - tracked.startY);
      if (moved > LONG_PRESS_MOVE_TOL) cancelLongPress(input);
    }

    const local = e.getLocalPosition(worldLayer);
    if (state.pendingBuild) drawGhost(input, local.x, local.y, state);
    else input.placementGhost.clear();
    // Drag-paint walls — pointer is held (still in input.pointers) and the
    // current pending kind is wall. Silently skips duplicate cells.
    if (state.pendingBuild?.kind === 'wall' && input.pointers.has(e.pointerId)) {
      const c = pixelToCell(local.x, local.y);
      tryPlaceWallAt(state, c.cx, c.cy, true);
    }
    if (!input.isDragging) return;
    input.selectionGfx.clear();
    const x = Math.min(input.dragStart.x, local.x);
    const y = Math.min(input.dragStart.y, local.y);
    const w = Math.abs(local.x - input.dragStart.x);
    const h = Math.abs(local.y - input.dragStart.y);
    input.selectionGfx
      .rect(x, y, w, h)
      .fill({ color: 0xffd96b, alpha: 0.1 })
      .stroke({ width: 1, color: 0xffd96b });
  });

  const onPointerUp = (e: FederatedPointerEvent) => {
    const wasPanning = input.pointers.size >= 2;
    input.pointers.delete(e.pointerId);
    if (wasPanning) {
      // Drop pan reference — don't resume a pending drag-select with the leftover finger.
      input.panLast = null;
      input.isDragging = false;
      input.selectionGfx.clear();
      return;
    }
    if (input.longPressPointerId === e.pointerId) cancelLongPress(input);
    if (input.longPressFired) {
      input.longPressFired = false;
      input.isDragging = false;
      input.selectionGfx.clear();
      return;
    }
    if (!input.isDragging) return;
    input.isDragging = false;
    const local = e.getLocalPosition(worldLayer);
    const dist = Math.hypot(local.x - input.dragStart.x, local.y - input.dragStart.y);
    const additive = e.shiftKey;
    if (dist < 4) {
      const g = goblinAt(state, local.x, local.y);
      const m = g ? null : minotaurAt(state, local.x, local.y);
      let b: Building | null = null;
      let onHole = false;
      let w: WaterSource | null = null;
      if (!g && !m) {
        const c = pixelToCell(local.x, local.y);
        b = buildingAtCell(state, c.cx, c.cy);
        if (!b) onHole = holeAtCell(state, c.cx, c.cy);
        if (!b && !onHole) w = waterSourceAtCell(state, c);
      }
      if (!additive) clearSelection(state);
      if (g) { g.selected = true; playSound('select', 0.33); }
      else if (m) { m.selected = true; playSound('select', 0.33); }
      else if (b) { b.selected = true; playSound('select', 0.33); }
      else if (onHole) { state.hole.selected = true; playSound('select', 0.33); }
      else if (w) { w.selected = true; playSound('select', 0.33); }
    } else {
      const x1 = Math.min(input.dragStart.x, local.x);
      const y1 = Math.min(input.dragStart.y, local.y);
      const x2 = Math.max(input.dragStart.x, local.x);
      const y2 = Math.max(input.dragStart.y, local.y);
      if (!additive) clearSelection(state);
      let any = false;
      for (const g of state.goblins.values()) {
        if (g.pos.x >= x1 && g.pos.x <= x2 && g.pos.y >= y1 && g.pos.y <= y2) {
          g.selected = true;
          any = true;
        }
      }
      for (const m of state.minotaurs.values()) {
        if (m.pos.x >= x1 && m.pos.x <= x2 && m.pos.y >= y1 && m.pos.y <= y2) {
          m.selected = true;
          any = true;
        }
      }
      if (any) playSound('select', 0.33);
    }
    input.selectionGfx.clear();
  };
  app.stage.on('pointerup', onPointerUp);
  app.stage.on('pointerupoutside', onPointerUp);
  app.stage.on('pointercancel', onPointerUp);

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      state.pendingBuild = null;
      input.placementGhost.clear();
    }
  });

  return input;
}

function scheduleLongPress(
  input: InputState,
  pointerId: number,
  state: GameState,
  worldLayer: Container,
) {
  cancelLongPress(input);
  input.longPressPointerId = pointerId;
  input.longPressFired = false;
  input.longPressTimer = window.setTimeout(() => {
    const tracked = input.pointers.get(pointerId);
    if (!tracked) return;
    if (input.pointers.size !== 1) return;
    const moved = Math.hypot(tracked.x - tracked.startX, tracked.y - tracked.startY);
    if (moved > LONG_PRESS_MOVE_TOL) return;
    input.longPressFired = true;
    // Cancel any in-progress drag-select; long-press has taken over.
    input.isDragging = false;
    input.selectionGfx.clear();
    if (state.pendingBuild) {
      // No keyboard ESC on touch — long-press cancels pending placement.
      state.pendingBuild = null;
      input.placementGhost.clear();
      return;
    }
    const world = worldLayer.toLocal({ x: tracked.x, y: tracked.y });
    flashCursor(tracked.x, tracked.y);
    handleRightClick(state, world.x, world.y);
  }, LONG_PRESS_MS);
}

function cancelLongPress(input: InputState) {
  if (input.longPressTimer !== null) {
    clearTimeout(input.longPressTimer);
    input.longPressTimer = null;
  }
  input.longPressPointerId = null;
}

// One grunt per goblin, staggered ~90ms apart with a touch of jitter so a group
// command sounds like a chorus instead of a single overlapped blob.
function playGruntBurst(count: number) {
  for (let i = 0; i < count; i++) {
    const delay = i * 100;
    setTimeout(() => {
      const rate = 0.5 + Math.random();
      playSound('command_3', 1, rate);
    }, delay);
  }
}

function clearSelection(state: GameState) {
  for (const g of state.goblins.values()) g.selected = false;
  for (const m of state.minotaurs.values()) m.selected = false;
  for (const b of state.buildings.values()) b.selected = false;
  for (const w of state.waterSources.values()) w.selected = false;
  state.hole.selected = false;
}

function goblinAt(state: GameState, x: number, y: number): Goblin | null {
  for (const g of state.goblins.values()) {
    if (Math.hypot(g.pos.x - x, g.pos.y - y) <= GOBLIN.radius + 2) return g;
  }
  return null;
}

function waterSourceAt(state: GameState, cell: Cell): WaterSource | null {
  return waterSourceAtCell(state, cell);
}

// Pick a building that drinks water (DC, HC). `waterCarrierMax` is a soft
// preference rather than a hard cap: drinkers below the cap are picked
// first; only when every drinker is at/above its cap do we fall back to
// the at-cap pool. Within each tier we still favour the lowest water meter
// so the thirstiest target wins.
function nearestThirstyDatacentre(state: GameState): Building | null {
  let bestBelow: Building | null = null;
  let bestBelowMeter = Infinity;
  let bestAbove: Building | null = null;
  let bestAboveMeter = Infinity;
  for (const b of state.buildings.values()) {
    const def = defOf(b);
    const drinks = (def.waterDeliveryAmount ?? 0) > 0;
    if (!drinks) continue;
    if (b.state === 'constructing') continue;
    const max = def.waterCarrierMax ?? Infinity;
    const m = b.waterMeter ?? 0;
    if (waterCarrierCount(state, b) < max) {
      if (m < bestBelowMeter) { bestBelowMeter = m; bestBelow = b; }
    } else {
      if (m < bestAboveMeter) { bestAboveMeter = m; bestAbove = b; }
    }
  }
  return bestBelow ?? bestAbove;
}

function minotaurAt(state: GameState, x: number, y: number): Minotaur | null {
  // Larger hit-radius than the body collider since the minotaur's sprite is
  // significantly bigger than the goblin's.
  for (const m of state.minotaurs.values()) {
    if (Math.hypot(m.pos.x - x, m.pos.y - y) <= MINOTAUR.radius * 1.4) return m;
  }
  return null;
}

function handleRightClick(state: GameState, x: number, y: number) {
  const selectedGoblins = [...state.goblins.values()].filter((g) => g.selected);
  const selectedMinotaurs = [...state.minotaurs.values()].filter((m) => m.selected);
  if (selectedGoblins.length === 0 && selectedMinotaurs.length === 0) return;
  if (selectedGoblins.length > 0) playGruntBurst(selectedGoblins.length);

  const targetGoblin = goblinAt(state, x, y);
  const targetMinotaur = targetGoblin ? null : minotaurAt(state, x, y);
  const targetCell = pixelToCell(x, y);
  const targetBuilding = (targetGoblin || targetMinotaur)
    ? null
    : buildingAtCell(state, targetCell.cx, targetCell.cy);
  const targetWater = (!targetGoblin && !targetMinotaur && !targetBuilding)
    ? waterSourceAt(state, targetCell)
    : null;

  // Water duty: right-click a water source with goblins selected to put them
  // on the loop for the closest under-watered Datacentre.
  if (targetWater && selectedGoblins.length > 0) {
    let assigned = 0;
    for (const g of selectedGoblins) {
      const dc = nearestThirstyDatacentre(state);
      if (!dc) break;
      releaseFromBuilding(state, g);
      dc.assignedGoblins.push(g.id);
      g.goal = null;
      g.path = [];
      g.state = {
        kind: 'fetching_water',
        buildingId: dc.id,
        sourceId: targetWater.id,
        phase: 'to_source',
        initialTarget: { cx: targetCell.cx, cy: targetCell.cy },
      };
      // Reset stuck timer so the new role gets a clean 3s grace window.
      g.lastCellChangedAt = state.now;
      assigned++;
    }
    if (assigned > 0) {
      appendLog(state, `${assigned} goblin(s) on water duty.`);
      return;
    }
    playSound('error');
    appendLog(state, 'Nothing to water.');
    return;
  }

  // Minotaur commands.
  if (selectedMinotaurs.length > 0) {
    if (targetMinotaur) {
      // Minotaur-on-minotaur — the target itself is excluded.
      const attackers = selectedMinotaurs.filter(m => m.id !== targetMinotaur.id);
      for (const m of attackers) {
        m.target = null;
        m.state = { kind: 'going_to_kill_minotaur', targetId: targetMinotaur.id };
      }
      if (attackers.length > 0) {
        appendLog(state, `${attackers.length} minotaur(s) ordered to gore Minotaur #${targetMinotaur.id}.`);
      }
    } else if (targetBuilding) {
      for (const m of selectedMinotaurs) {
        m.target = null;
        m.state = { kind: 'going_to_destroy', buildingId: targetBuilding.id };
      }
      appendLog(state, `${selectedMinotaurs.length} minotaur(s) ordered to smash ${defOf(targetBuilding).name} #${targetBuilding.id}.`);
    } else {
      // Empty cell — walk there, then resume the usual hunt/wander.
      for (const m of selectedMinotaurs) {
        m.target = null;
        m.state = { kind: 'moving_to', goal: { cx: targetCell.cx, cy: targetCell.cy } };
      }
      appendLog(state, `${selectedMinotaurs.length} minotaur(s) on the move.`);
    }
  }

  if (selectedGoblins.length === 0) return;

  // Kill order: right-click on another goblin sends every selected attacker
  // toward it. The target itself, even if selected, is excluded so the order
  // never resolves to "kill yourself".
  if (targetGoblin) {
    const attackers = selectedGoblins.filter(g => g.id !== targetGoblin.id);
    if (attackers.length > 0) {
      for (const g of attackers) {
        releaseFromBuilding(state, g);
        g.goal = null;
        g.path = [];
        g.state = { kind: 'going_to_kill', targetId: targetGoblin.id };
      }
      appendLog(state, `${attackers.length} goblin(s) ordered to kill #${targetGoblin.id}.`);
      return;
    }
  }

  if (targetBuilding) {
    assignToBuilding(state, selectedGoblins, targetBuilding);
  } else {
    const reserved = new Set<string>();
    for (const g of selectedGoblins) {
      releaseFromBuilding(state, g);
      const cell = findFreeCellNear(state, targetCell.cx, targetCell.cy, g.id, reserved, 600);
      if (cell) {
        reserved.add(cellKey(cell.cx, cell.cy));
        g.goal = cell;
        g.path = [];
        g.state = { kind: 'moving' };
      } else {
        appendLog(state, `Goblin #${g.id} can't find a path.`);
      }
    }
  }
}

function releaseFromBuilding(state: GameState, g: Goblin) {
  const s = g.state;
  if (s.kind === 'building' || s.kind === 'maintaining' ||
      s.kind === 'going_to_build' || s.kind === 'going_to_maintain') {
    const b = state.buildings.get(s.buildingId);
    if (b) {
      const i = b.assignedGoblins.indexOf(g.id);
      if (i >= 0) b.assignedGoblins.splice(i, 1);
    }
  }
}

function assignToBuilding(state: GameState, goblins: Goblin[], b: Building) {
  const def = defOf(b);
  const isBuilding = b.state === 'constructing';
  const role = isBuilding ? 'construct' : 'maintain';

  // Over-assignment is allowed: every selected goblin gets assigned. Extras
  // beyond the required count just enter as additional workers (they'll fan out
  // inside the footprint, or queue at the perimeter if it's full).
  let added = 0;
  for (const g of goblins) {
    if (b.assignedGoblins.includes(g.id)) continue;
    releaseFromBuilding(state, g);
    b.assignedGoblins.push(g.id);
    g.goal = null;
    g.path = [];
    g.state = isBuilding
      ? { kind: 'going_to_build', buildingId: b.id }
      : { kind: 'going_to_maintain', buildingId: b.id };
    added++;
  }
  if (added > 0) {
    appendLog(state, `${added} goblin(s) assigned to ${role} ${def.name} #${b.id}.`);
  }
}

function topLeftFromClick(x: number, y: number, kind: BuildingKind): Cell {
  const center = pixelToCell(x, y);
  const half = Math.floor((BUILDING_DEFS[kind].cellSize - 1) / 2);
  return { cx: center.cx - half, cy: center.cy - half };
}

function canPlaceBuilding(state: GameState, topLeft: Cell, kind: BuildingKind): boolean {
  const n = BUILDING_DEFS[kind].cellSize;
  for (let dx = 0; dx < n; dx++) {
    for (let dy = 0; dy < n; dy++) {
      const cx = topLeft.cx + dx;
      const cy = topLeft.cy + dy;
      if (!isInBounds(cx, cy)) return false;
      if (isCellBlocked(state, cx, cy)) return false;
    }
  }
  return true;
}

function placeBuilding(state: GameState, x: number, y: number) {
  if (!state.pendingBuild) return;
  const kind = state.pendingBuild.kind;
  // Wall is a special case: no Building entity, just a wall cell. Stays in
  // pending mode after placement so the player can drag-paint more.
  if (kind === 'wall') {
    const c = pixelToCell(x, y);
    tryPlaceWallAt(state, c.cx, c.cy, false);
    return;
  }
  const def = BUILDING_DEFS[kind];
  if (state.money < def.cost) { playSound('error'); appendLog(state, 'Not enough Ƶ.'); return; }
  if (def.bloodCost && state.blood < def.bloodCost) { playSound('error'); appendLog(state, `Need ${def.bloodCost} blood to build ${def.name}.`); return; }
  if (def.powerOutput < 0) {
    const draw = -def.powerOutput;
    const available = state.lastPowerProduced - state.lastPowerConsumed;
    if (draw > available) {
      playSound('error');
      appendLog(state, `Need ${formatPower(draw)} of free power to build ${def.name}.`);
      return;
    }
  }
  const tl = topLeftFromClick(x, y, kind);
  if (!canPlaceBuilding(state, tl, kind)) {
    playSound('error');
    appendLog(state, 'Cannot place there — blocked.');
    return;
  }

  state.money -= def.cost;
  if (def.bloodCost) state.blood -= def.bloodCost;
  const b: Building = {
    id: state.nextId++,
    kind,
    cell: tl,
    state: 'constructing',
    buildProgress: 0,
    assignedGoblins: [],
    selected: false,
  };
  state.buildings.set(b.id, b);
  state.pendingBuild = null;
  playSound('place', 1.6);
  appendLog(state, `${def.name} #${b.id} construction started — right-click goblins onto it to staff the build.`);
  autoAssignAllIdle(state);

  // Demo-end gag: placing the Dragon Beacon pops a celebratory alert, then
  // a second one revealing the secret options menu (hidden until now in
  // production builds).
  if (kind === 'dragon_beacon') {
    window.alert(
      "congratulations, you completed the demo! dragon lives in your imagination, "
      + "heart, and soul. just imagine how cool it would be if a dragon was implemented. "
      + "ahaha yeah, honestly its amazing. im so glad you grinded here for it. "
      + "its not in the game at all LMAO. thanks! have a great day! "
      + "i hope it doesnt 'drag on' ;)"
    );
    state.optionsUnlocked = true;
    unlockOptionsCog();
    window.alert(
      "BUT WAIT --- YOU HAVE UNLOCKED THE SECRET SETTINGS MENU OF JUSTICE!!!!!!!!!! "
      + "FIND IT IN THE BOTTOM RIGHT OF THE PLAY AREA. ENJOY"
    );
  }
}

// Wall placement — Ƶ1 per cell, 1×1 Building entity that goes straight to
// active. Using a real Building means the same destroy flow as everything
// else (selection → destroy → minotaur smashes it) works for free.
// Drag-paint calls this with silent=true so duplicate-cell attempts don't
// beep on every drag tick.
function tryPlaceWallAt(state: GameState, cx: number, cy: number, silent: boolean): boolean {
  if (!isInBounds(cx, cy)) return false;
  if (state.money < 1) {
    if (!silent) { playSound('error'); appendLog(state, 'Not enough Ƶ.'); }
    return false;
  }
  if (isCellBlocked(state, cx, cy)) return false;
  state.money -= 1;
  const b: Building = {
    id: state.nextId++,
    kind: 'wall',
    cell: { cx, cy },
    state: 'active',
    buildProgress: 1,
    assignedGoblins: [],
    selected: false,
  };
  state.buildings.set(b.id, b);
  return true;
}

function drawGhost(input: InputState, x: number, y: number, state: GameState) {
  if (!state.pendingBuild) return;
  const kind = state.pendingBuild.kind;
  const def = BUILDING_DEFS[kind];
  const tl = topLeftFromClick(x, y, kind);
  const valid = canPlaceBuilding(state, tl, kind);
  const color = valid ? 0x6a8eb0 : 0xd96b6b;
  input.placementGhost.clear();
  input.placementGhost
    .rect(tl.cx * CELL, tl.cy * CELL, def.size, def.size)
    .fill({ color, alpha: 0.25 })
    .stroke({ width: 2, color });
}
