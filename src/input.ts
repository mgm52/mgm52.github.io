import { Application, Container, FederatedPointerEvent, Graphics } from 'pixi.js';
import { BUILDING_DEFS, BuildingKind, CELL, GOBLIN, WORLD, formatPower } from './config';
import {
  Building, Cell, GameState, Goblin,
  appendLog, buildingAtCell, cellCenter, cellKey, defOf, findFreeCellNear,
  isCellBlocked, isInBounds, pixelToCell,
} from './state';

type InputState = {
  isDragging: boolean;
  dragStart: { x: number; y: number };
  selectionGfx: Graphics;
  placementGhost: Graphics;
};

export function setupInput(state: GameState, app: Application, uiLayer: Container, worldLayer: Container) {
  const selectionGfx = new Graphics();
  const placementGhost = new Graphics();
  uiLayer.addChild(selectionGfx);
  uiLayer.addChild(placementGhost);

  const input: InputState = {
    isDragging: false,
    dragStart: { x: 0, y: 0 },
    selectionGfx, placementGhost,
  };

  app.stage.eventMode = 'static';
  // Receive pointer events anywhere on the canvas (regardless of camera position).
  app.stage.hitArea = { contains: () => true };
  app.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  app.stage.on('pointerdown', (e: FederatedPointerEvent) => {
    const local = e.getLocalPosition(worldLayer);
    if (e.button === 2) {
      handleRightClick(state, local.x, local.y);
      return;
    }
    if (state.pendingBuild) {
      placeBuilding(state, local.x, local.y);
      drawGhost(input, local.x, local.y, state);
      return;
    }
    input.isDragging = true;
    input.dragStart = { x: local.x, y: local.y };
    input.selectionGfx.clear();
  });

  app.stage.on('pointermove', (e: FederatedPointerEvent) => {
    const local = e.getLocalPosition(worldLayer);
    if (state.pendingBuild) drawGhost(input, local.x, local.y, state);
    else input.placementGhost.clear();
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

  app.stage.on('pointerup', (e: FederatedPointerEvent) => {
    if (!input.isDragging) return;
    input.isDragging = false;
    const local = e.getLocalPosition(worldLayer);
    const dist = Math.hypot(local.x - input.dragStart.x, local.y - input.dragStart.y);
    const additive = e.shiftKey;
    if (dist < 4) {
      const g = goblinAt(state, local.x, local.y);
      let b: Building | null = null;
      if (!g) {
        const c = pixelToCell(local.x, local.y);
        b = buildingAtCell(state, c.cx, c.cy);
      }
      if (!additive) clearSelection(state);
      if (g) g.selected = true;
      else if (b) b.selected = true;
    } else {
      const x1 = Math.min(input.dragStart.x, local.x);
      const y1 = Math.min(input.dragStart.y, local.y);
      const x2 = Math.max(input.dragStart.x, local.x);
      const y2 = Math.max(input.dragStart.y, local.y);
      if (!additive) clearSelection(state);
      for (const g of state.goblins.values()) {
        if (g.pos.x >= x1 && g.pos.x <= x2 && g.pos.y >= y1 && g.pos.y <= y2) g.selected = true;
      }
    }
    input.selectionGfx.clear();
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      state.pendingBuild = null;
      input.placementGhost.clear();
    }
  });

  return input;
}

function clearSelection(state: GameState) {
  for (const g of state.goblins.values()) g.selected = false;
  for (const b of state.buildings.values()) b.selected = false;
}

function goblinAt(state: GameState, x: number, y: number): Goblin | null {
  for (const g of state.goblins.values()) {
    if (Math.hypot(g.pos.x - x, g.pos.y - y) <= GOBLIN.radius + 2) return g;
  }
  return null;
}

function handleRightClick(state: GameState, x: number, y: number) {
  const selected = [...state.goblins.values()].filter((g) => g.selected);
  if (selected.length === 0) return;
  const target = pixelToCell(x, y);
  const b = buildingAtCell(state, target.cx, target.cy);
  if (b) {
    assignToBuilding(state, selected, b);
  } else {
    const reserved = new Set<string>();
    for (const g of selected) {
      releaseFromBuilding(state, g);
      const cell = findFreeCellNear(state, target.cx, target.cy, g.id, reserved, 600);
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
  const def = BUILDING_DEFS[kind];
  if (state.money < def.cost) { appendLog(state, 'Not enough $.'); return; }
  // Goblins are no longer required to place — any idle ones get auto-assigned;
  // shortfall is left for the player to staff up with right-clicks later.
  const idle = [...state.goblins.values()].filter((g) => g.state.kind === 'idle');
  if (def.powerOutput < 0) {
    const draw = -def.powerOutput;
    const available = state.lastPowerProduced - state.lastPowerConsumed;
    if (draw > available) {
      appendLog(state, `Need ${formatPower(draw)} of free power to build ${def.name}.`);
      return;
    }
  }
  const tl = topLeftFromClick(x, y, kind);
  if (!canPlaceBuilding(state, tl, kind)) {
    appendLog(state, 'Cannot place there — blocked.');
    return;
  }

  state.money -= def.cost;
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

  const center = cellCenter({
    cx: tl.cx + (def.cellSize - 1) / 2,
    cy: tl.cy + (def.cellSize - 1) / 2,
  });
  idle.sort((a, c) =>
    Math.hypot(a.pos.x - center.x, a.pos.y - center.y) -
    Math.hypot(c.pos.x - center.x, c.pos.y - center.y),
  );
  const initialBuilders = Math.min(idle.length, def.buildersRequired);
  for (let i = 0; i < initialBuilders; i++) {
    const g = idle[i];
    b.assignedGoblins.push(g.id);
    g.goal = null;
    g.path = [];
    g.state = { kind: 'going_to_build', buildingId: b.id };
  }
  state.pendingBuild = null;
  appendLog(state, `${def.name} #${b.id} construction started.`);
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
