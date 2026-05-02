import { Application, Container, Graphics, Text } from 'pixi.js';
import { CELL, COLS, GOBLIN, ROWS, WORLD } from './config';
import { Building, GameState, Goblin, buildingCenter, defOf, maintainerCount } from './state';

export type Camera = { x: number; y: number };

type GoblinView = {
  container: Container;
  body: Graphics;
  selectionRing: Graphics;
  label: Text;
};

type BuildingView = {
  container: Container;
  body: Graphics;
  selectionRing: Graphics;
  label: Text;
  progress: Graphics;
  warning: Text;
  lastState: string;
  lastWarning: string;
  lastSize: number;
};

export type RenderContext = {
  app: Application;
  worldLayer: Container;
  buildingLayer: Container;
  goblinLayer: Container;
  uiLayer: Container;
  goblinViews: Map<number, GoblinView>;
  buildingViews: Map<number, BuildingView>;
  camera: Camera;
  viewport: { width: number; height: number };
};

export async function createRender(parent: HTMLElement, walls: Set<string>): Promise<RenderContext> {
  const initW = parent.clientWidth || window.innerWidth || WORLD.width;
  const initH = parent.clientHeight || window.innerHeight || WORLD.height;
  const app = new Application();
  await app.init({
    background: '#2b3036',
    width: initW,
    height: initH,
    antialias: true,
    resolution: window.devicePixelRatio || 1,
    autoDensity: true,
  });
  parent.appendChild(app.canvas);
  app.canvas.style.width = '100%';
  app.canvas.style.height = '100%';
  app.canvas.style.display = 'block';

  const worldLayer = new Container();
  const buildingLayer = new Container();
  const goblinLayer = new Container();
  const uiLayer = new Container();

  // Wall border (drawn as a single Graphics instance — cheap & static)
  const wallGfx = new Graphics();
  for (const key of walls) {
    const [cxs, cys] = key.split(',');
    const cx = +cxs;
    const cy = +cys;
    wallGfx.rect(cx * CELL, cy * CELL, CELL, CELL).fill(0x000000);
  }

  // Grid: only draw inside the play area (walls cover the rest)
  const grid = new Graphics();
  for (let x = 0; x <= COLS; x++) grid.moveTo(x * CELL, 0).lineTo(x * CELL, WORLD.height);
  for (let y = 0; y <= ROWS; y++) grid.moveTo(0, y * CELL).lineTo(WORLD.width, y * CELL);
  grid.stroke({ width: 1, color: 0x363c44, alpha: 0.5 });

  worldLayer.addChild(wallGfx);
  worldLayer.addChild(grid);
  worldLayer.addChild(buildingLayer);
  worldLayer.addChild(goblinLayer);
  worldLayer.addChild(uiLayer);
  app.stage.addChild(worldLayer);

  const ctx: RenderContext = {
    app, worldLayer, buildingLayer, goblinLayer, uiLayer,
    goblinViews: new Map(), buildingViews: new Map(),
    camera: { x: 0, y: 0 },
    viewport: { width: initW, height: initH },
  };

  const syncViewport = () => {
    const w = parent.clientWidth;
    const h = parent.clientHeight;
    if (w <= 0 || h <= 0) return;
    if (ctx.viewport.width === w && ctx.viewport.height === h) return;
    app.renderer.resize(w, h);
    ctx.viewport.width = w;
    ctx.viewport.height = h;
    clampCamera(ctx);
  };
  syncViewport();
  requestAnimationFrame(syncViewport);
  window.addEventListener('resize', syncViewport);
  if ('ResizeObserver' in window) {
    new ResizeObserver(syncViewport).observe(parent);
  }

  return ctx;
}

export function clampCamera(ctx: RenderContext) {
  const maxX = Math.max(0, WORLD.width - ctx.viewport.width);
  const maxY = Math.max(0, WORLD.height - ctx.viewport.height);
  ctx.camera.x = Math.max(0, Math.min(maxX, ctx.camera.x));
  ctx.camera.y = Math.max(0, Math.min(maxY, ctx.camera.y));
}

export function centerCameraOn(ctx: RenderContext, x: number, y: number) {
  ctx.camera.x = x - ctx.viewport.width / 2;
  ctx.camera.y = y - ctx.viewport.height / 2;
  clampCamera(ctx);
}

function makeGoblinView(g: Goblin): GoblinView {
  const c = new Container();
  c.position.set(g.pos.x, g.pos.y);

  const ring = new Graphics();
  ring.circle(0, 0, GOBLIN.radius + 4).stroke({ width: 2, color: 0xffd96b });
  ring.visible = false;

  const body = new Graphics();
  body.circle(0, 0, GOBLIN.radius).fill(0x6fbf73).stroke({ width: 1, color: 0x2d4a30 });
  body
    .moveTo(GOBLIN.radius - 1, -5)
    .lineTo(GOBLIN.radius + 7, 0)
    .lineTo(GOBLIN.radius - 1, 5)
    .closePath()
    .fill(0x1f3522);

  const label = new Text({
    text: 'G',
    style: { fontFamily: 'VT323, monospace', fontSize: 18, fill: 0x102510, fontWeight: 'bold' },
  });
  label.anchor.set(0.5);

  c.addChild(ring);
  c.addChild(body);
  c.addChild(label);
  return { container: c, body, selectionRing: ring, label };
}

function makeBuildingView(b: Building): BuildingView {
  const def = defOf(b);
  const c = new Container();
  const ctr = buildingCenter(b);
  c.position.set(ctr.x, ctr.y);

  const selectionRing = new Graphics();
  drawSelectionRing(selectionRing, def.size);
  selectionRing.visible = false;

  const body = new Graphics();
  drawBuildingBody(body, b);

  const label = new Text({
    text: def.short,
    style: {
      fontFamily: 'VT323, monospace',
      fontSize: def.cellSize >= 3 ? 32 : 24,
      fill: 0xffffff,
      fontWeight: 'bold',
    },
  });
  label.anchor.set(0.5);

  const progress = new Graphics();

  const warning = new Text({
    text: '',
    style: {
      fontFamily: 'system-ui, sans-serif',
      fontSize: 11,
      fill: 0xffb0b0,
      fontWeight: 'bold',
      stroke: { color: 0x000000, width: 3 },
    },
  });
  warning.anchor.set(0.5, 0);
  warning.position.set(0, -def.size / 2 + 4);
  warning.visible = false;

  c.addChild(selectionRing);
  c.addChild(body);
  c.addChild(label);
  c.addChild(progress);
  c.addChild(warning);

  return {
    container: c, body, selectionRing, label, progress, warning,
    lastState: '', lastWarning: '', lastSize: def.size,
  };
}

function drawSelectionRing(g: Graphics, size: number) {
  const half = size / 2 + 4;
  g.clear();
  g.rect(-half, -half, half * 2, half * 2).stroke({ width: 2, color: 0xffd96b });
}

function drawBuildingBody(g: Graphics, b: Building) {
  const def = defOf(b);
  const half = def.size / 2;
  const c = def.colors;
  let fill = c.constructing, border = c.constructingBorder;
  if (b.state === 'active') { fill = c.active; border = c.activeBorder; }
  else if (b.state === 'dormant') { fill = c.dormant; border = c.dormantBorder; }
  g.clear();
  g.rect(-half, -half, def.size, def.size).fill(fill).stroke({ width: 2, color: border });
  // simple texture per kind
  if (b.kind === 'datacentre') {
    for (let i = -1; i <= 1; i++) {
      g.rect(-half + 14, -10 + i * 14, def.size - 28, 7).fill({ color: 0x000000, alpha: 0.25 });
    }
  } else if (b.kind === 'goblin_wheel') {
    g.circle(0, 0, def.size / 2 - 8).stroke({ width: 3, color: 0x000000, alpha: 0.35 });
    for (let a = 0; a < 4; a++) {
      const ang = (a / 4) * Math.PI;
      const r = def.size / 2 - 8;
      g.moveTo(-Math.cos(ang) * r, -Math.sin(ang) * r)
        .lineTo(Math.cos(ang) * r, Math.sin(ang) * r)
        .stroke({ width: 1, color: 0x000000, alpha: 0.3 });
    }
  } else if (b.kind === 'coal_plant') {
    // smokestacks: 3 narrow rectangles along the top
    const w = 10;
    for (let i = -1; i <= 1; i++) {
      g.rect(i * 24 - w / 2, -half + 6, w, def.size - 18)
        .fill({ color: 0x000000, alpha: 0.32 });
    }
  }
}

export function render(state: GameState, ctx: RenderContext) {
  // Apply camera by translating the world layer (UI overlays in DOM stay fixed)
  ctx.worldLayer.position.set(-Math.round(ctx.camera.x), -Math.round(ctx.camera.y));

  // Goblins
  const seenG = new Set<number>();
  for (const g of state.goblins.values()) {
    seenG.add(g.id);
    let v = ctx.goblinViews.get(g.id);
    if (!v) {
      v = makeGoblinView(g);
      ctx.goblinLayer.addChild(v.container);
      ctx.goblinViews.set(g.id, v);
    }
    v.container.position.set(g.pos.x, g.pos.y);
    v.body.rotation = g.facing;
    v.selectionRing.visible = g.selected;
    let tint = 0xffffff;
    if (g.state.kind === 'building' || g.state.kind === 'going_to_build') tint = 0xfff0a8;
    else if (g.state.kind === 'maintaining' || g.state.kind === 'going_to_maintain') tint = 0xa8d8ff;
    v.body.tint = tint;
  }
  for (const [id, v] of ctx.goblinViews) {
    if (!seenG.has(id)) {
      v.container.destroy({ children: true });
      ctx.goblinViews.delete(id);
    }
  }

  // Buildings
  const seenB = new Set<number>();
  for (const b of state.buildings.values()) {
    seenB.add(b.id);
    let v = ctx.buildingViews.get(b.id);
    if (!v) {
      v = makeBuildingView(b);
      ctx.buildingLayer.addChild(v.container);
      ctx.buildingViews.set(b.id, v);
    }
    const def = defOf(b);
    const ctr = buildingCenter(b);
    v.container.position.set(ctr.x, ctr.y);
    v.selectionRing.visible = b.selected;
    if (v.lastState !== b.state) {
      drawBuildingBody(v.body, b);
      v.lastState = b.state;
    }
    if (v.lastSize !== def.size) {
      drawSelectionRing(v.selectionRing, def.size);
      v.warning.position.set(0, -def.size / 2 + 4);
      v.lastSize = def.size;
    }

    // progress bar — sits inside the top edge, below the warning text if any
    v.progress.clear();
    if (b.state === 'constructing') {
      const w = def.size - 10;
      const h = 5;
      // If the warning is showing, drop the bar below the warning row.
      const y = (v.warning.visible ? -def.size / 2 + 18 : -def.size / 2 + 5);
      v.progress.rect(-w / 2, y, w, h).fill({ color: 0x000000, alpha: 0.6 }).stroke({ width: 1, color: 0x000000 });
      v.progress.rect(-w / 2, y, w * b.buildProgress, h).fill(0xffd96b);
    }

    // floating warning
    let warningText = '';
    if (b.state === 'dormant') {
      const have = maintainerCount(state, b);
      const need = def.maintainersRequired - have;
      if (need > 0) {
        warningText = `needs ${need} goblin${need === 1 ? '' : 's'}`;
      } else {
        warningText = 'underpowered';
      }
    } else if (b.state === 'constructing') {
      let workers = 0;
      for (const id of b.assignedGoblins) {
        const g = state.goblins.get(id);
        if (g && g.state.kind === 'building' && g.state.buildingId === b.id) workers++;
      }
      const need = def.buildersRequired - workers;
      if (need > 0) warningText = `needs ${need} builder${need === 1 ? '' : 's'}`;
    }
    if (warningText !== v.lastWarning) {
      v.warning.text = warningText;
      v.warning.visible = warningText.length > 0;
      v.lastWarning = warningText;
    }
  }
  for (const [id, v] of ctx.buildingViews) {
    if (!seenB.has(id)) {
      v.container.destroy({ children: true });
      ctx.buildingViews.delete(id);
    }
  }
}
