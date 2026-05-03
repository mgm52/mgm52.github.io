import { Application, Assets, ColorMatrixFilter, Container, extensions, Graphics, Rectangle, Sprite, Text, Texture } from 'pixi.js';
import { GifAsset, GifSource } from 'pixi.js/gif';

// Side-effect registration: `pixi.js/gif` does NOT auto-register the .gif
// asset loader on import. Without this, `Assets.load(*.gif)` rejects.
extensions.add(GifAsset);

// Decoded GIF: frame textures + the cumulative time-of-end of each frame, in
// game seconds. Used as a manual sprite-sheet — we pick the frame ourselves
// each tick based on (state.now - spawnAt) so playback always starts at frame 0.
type DeathFrames = { textures: Texture[]; ends: number[]; duration: number };
import { CELL, COLS, GOBLIN, RENDER_SCALE, ROWS, MINOTAUR, WORLD } from './config';
import { ensureFontLoaded, fontFamilyById, getOptions, onOptionsChange, type FontConfig, type Options } from './options';
import { Building, GameState, Goblin, HOLE_SIZE, Minotaur, buildingCenter, defOf, holeCenter, maintainerCount } from './state';

export type Camera = { x: number; y: number };

// ─── Goblin sprite sheets ───────────────────────────────────────────
// Two sheets: a moving/dancing loop and an idle loop. Each ships with a
// sibling JSON describing sprite size, frame counts, and per-row world
// heading (compass convention: 0=N, clockwise). Sheets are laid out as
// dir-rows: each row is a viewing direction, columns are animation frames.
const GOBLIN_WALK_BASE = 'assets/rigged_goblin_dancing_aligol3dart_orc_walk';
const GOBLIN_IDLE_BASE = 'assets/rigged_goblin_dancing_aligol3dart_orc_idle';
const GOBLIN_BREAKDANCE_BASE = 'assets/rigged_goblin_dancing_aligol3dart_breakdance';
const GOBLIN_SWIPE_BASE = 'assets/rigged_goblin_dancing_aligol3dart_mutant_swiping';
const MINOTAUR_WALK_BASE = 'assets/rigged_minotaur_sasswalk_aligol3dart_rigged_minotaur_sasswalk_aligol3dart';
const MINOTAUR_SWIPE_BASE = 'assets/rigged_minotaur_sasswalk_aligol3dart_mutant_swiping';

type SheetHeading = { index: number; headingDeg: number };
type SheetMeta = {
  spriteSize: number;
  directions: number;
  framesPerDirection: number;
  clipDuration: number;
  trimStartPct: number;
  trimEndPct: number;
  headings: SheetHeading[];
};
type Sheet = { meta: SheetMeta; frames: Texture[][]; fps: number };

let goblinWalkSheet: Sheet | null = null;
let goblinIdleSheet: Sheet | null = null;
let goblinBreakdanceSheet: Sheet | null = null;
let goblinSwipeSheet: Sheet | null = null;
let minotaurWalkSheet: Sheet | null = null;
let minotaurSwipeSheet: Sheet | null = null;

async function loadSheet(base: string): Promise<Sheet> {
  const meta = await fetch(`${base}.json`).then(r => r.json()) as SheetMeta;
  const tex: Texture = await Assets.load(`${base}.png`);
  const source = tex.source;
  const frames: Texture[][] = [];
  for (let d = 0; d < meta.directions; d++) {
    const row: Texture[] = [];
    for (let f = 0; f < meta.framesPerDirection; f++) {
      row.push(new Texture({
        source,
        frame: new Rectangle(
          f * meta.spriteSize,
          d * meta.spriteSize,
          meta.spriteSize,
          meta.spriteSize,
        ),
      }));
    }
    frames.push(row);
  }
  // fps preserves the clip's natural tempo, given the trim window the sheet was sampled from.
  const span = Math.max(0.001, (meta.trimEndPct - meta.trimStartPct) / 100);
  const fps = meta.framesPerDirection / (meta.clipDuration * span);
  return { meta, frames, fps };
}

async function loadGoblinSheets(): Promise<void> {
  [
    goblinWalkSheet, goblinIdleSheet, goblinBreakdanceSheet, goblinSwipeSheet,
    minotaurWalkSheet, minotaurSwipeSheet,
  ] = await Promise.all([
    loadSheet(GOBLIN_WALK_BASE),
    loadSheet(GOBLIN_IDLE_BASE),
    loadSheet(GOBLIN_BREAKDANCE_BASE),
    loadSheet(GOBLIN_SWIPE_BASE),
    loadSheet(MINOTAUR_WALK_BASE),
    loadSheet(MINOTAUR_SWIPE_BASE),
  ]);
}

// Map facing radians to a row index using the sheet's per-row heading table.
// `facing` comes from atan2(dy,dx): 0 = east, +y = south. Compass headings
// are 0=N, clockwise — convert with +90°, then pick the row whose heading is
// closest (modulo 360).
function dirIndex(meta: SheetMeta, facing: number): number {
  const facingDeg = facing * (180 / Math.PI);
  const compass = (((facingDeg + 90) % 360) + 360) % 360;
  let best = 0;
  let bestDist = Infinity;
  for (const h of meta.headings) {
    const raw = ((h.headingDeg - compass) % 360 + 540) % 360 - 180;
    const dist = Math.abs(raw);
    if (dist < bestDist) { bestDist = dist; best = h.index; }
  }
  return best;
}

type GoblinView = {
  container: Container;
  shadow: Sprite;
  outline: Sprite[];   // 4 cardinal-offset copies, black-tinted
  sprite: Sprite;
  selectionRing: Graphics;
};

// Pure-Canvas radial-gradient texture for the foot shadow. Generated lazily so
// we don't need a Pixi renderer at module-init time.
let shadowTexture: Texture | null = null;
function getShadowTexture(): Texture {
  if (shadowTexture) return shadowTexture;
  const w = 64, h = 24;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const c = canvas.getContext('2d')!;
  c.translate(w / 2, h / 2);
  c.scale(1, h / w);          // squash to ellipse
  const grad = c.createRadialGradient(0, 0, 0, 0, 0, w / 2);
  grad.addColorStop(0, 'rgba(0,0,0,0.65)');
  grad.addColorStop(0.5, 'rgba(0,0,0,0.32)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  c.fillStyle = grad;
  c.fillRect(-w / 2, -w / 2, w, w);
  shadowTexture = Texture.from(canvas);
  return shadowTexture;
}

// Cardinal pixel offsets for the cheap "outline" trick. Four offset copies
// of the sprite, all tinted black, drawn behind the main sprite. The tinted
// copies bleed past the anti-aliased sprite edges, producing a thin outline.
const OUTLINE_OFFSETS: readonly [number, number][] = [
  [-1.5, 0], [1.5, 0], [0, -1.5], [0, 1.5],
];

type MinotaurView = {
  container: Container;
  shadow: Sprite;
  sprite: Sprite;
  selectionRing: Graphics;
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
  cellSize: number;
};

export type RenderContext = {
  app: Application;
  worldLayer: Container;
  buildingLayer: Container;
  goblinLayer: Container;
  uiLayer: Container;
  goblinViews: Map<number, GoblinView>;
  minotaurLayer: Container;
  minotaurViews: Map<number, MinotaurView>;
  buildingViews: Map<number, BuildingView>;
  camera: Camera;
  viewport: { width: number; height: number };
  // Goblin Hole: a fixed pit-graphic plus its selection ring. Drawn between
  // the grid and buildings so a building placed on top covers it.
  holeGfx: Graphics;
  holeRing: Graphics;
  // Floating-text overlay (kill rewards, income ticks, power online).
  floatersLayer: Container;
  floaterViews: Map<number, Text>;
  // One-shot blood-explosion GIFs played at goblin death positions. Plain
  // Sprites whose textures we swap per-frame from the decoded `deathFrames`.
  effectsLayer: Container;
  deathViews: Map<number, Sprite>;
  deathFrames: DeathFrames | null;
  // Mutable references — used by applyOptions() to redraw on the fly.
  walls: Set<string>;
  playBg: Graphics;
  wallGfx: Graphics;
  grid: Graphics;
  goblinFilter: ColorMatrixFilter;
  buildingFilter: ColorMatrixFilter;
};

export async function createRender(parent: HTMLElement, walls: Set<string>): Promise<RenderContext> {
  await loadGoblinSheets();
  const initW = parent.clientWidth || window.innerWidth || WORLD.width;
  const initH = parent.clientHeight || window.innerHeight || WORLD.height;
  const app = new Application();
  await app.init({
    background: '#000000',
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
  const minotaurLayer = new Container();
  const uiLayer = new Container();

  // Playable-area background, walls, and grid — drawn lazily from current options.
  const playBg = new Graphics();
  const wallGfx = new Graphics();
  const grid = new Graphics();
  const holeGfx = new Graphics();
  const holeRing = new Graphics();

  const floatersLayer = new Container();
  const effectsLayer = new Container();

  worldLayer.addChild(playBg);
  worldLayer.addChild(wallGfx);
  worldLayer.addChild(grid);
  worldLayer.addChild(holeGfx);
  worldLayer.addChild(buildingLayer);
  worldLayer.addChild(goblinLayer);
  worldLayer.addChild(minotaurLayer);
  worldLayer.addChild(holeRing);
  worldLayer.addChild(effectsLayer);
  worldLayer.addChild(floatersLayer);
  worldLayer.addChild(uiLayer);
  worldLayer.scale.set(RENDER_SCALE);
  app.stage.addChild(worldLayer);

  // Color filters let the user dial sprite/building saturation+brightness live.
  // They're only attached when needed — applying a filter forces Pixi to
  // render the layer to an offscreen texture each frame, which is wasteful
  // when the matrix is the identity.
  const goblinFilter = new ColorMatrixFilter();
  const buildingFilter = new ColorMatrixFilter();

  const ctx: RenderContext = {
    app, worldLayer, buildingLayer, goblinLayer, uiLayer,
    goblinViews: new Map(),
    minotaurLayer, minotaurViews: new Map(),
    buildingViews: new Map(),
    camera: { x: 0, y: 0 },
    viewport: { width: initW, height: initH },
    holeGfx, holeRing,
    floatersLayer, floaterViews: new Map(),
    effectsLayer, deathViews: new Map(),
    deathFrames: null,
    walls, playBg, wallGfx, grid, goblinFilter, buildingFilter,
  };

  // Decode the GIF once into AnimatedSprite frames. Sharing GifSprite across
  // many short-lived sprites had race-condition issues (sprites starting
  // mid-animation); AnimatedSprite indexes by frame and behaves predictably.
  Assets.load<GifSource>('assets/blood-explosion.gif')
    .then((src) => {
      const textures: Texture[] = [];
      const ends: number[] = [];
      let cum = 0;
      for (const f of src.frames) {
        // GIF delays come in ms; convert to game seconds. Floor at 30 ms so
        // an over-eager encoder can't hide a frame for one tick.
        cum += Math.max(30, f.end - f.start) / 1000;
        textures.push(f.texture);
        ends.push(cum);
      }
      ctx.deathFrames = { textures, ends, duration: cum };
    })
    .catch((err) => { console.warn('blood-explosion gif failed to load', err); });

  applyOptions(ctx, getOptions());
  onOptionsChange((o) => applyOptions(ctx, o));

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
  const maxX = Math.max(0, WORLD.width - ctx.viewport.width / RENDER_SCALE);
  const maxY = Math.max(0, WORLD.height - ctx.viewport.height / RENDER_SCALE);
  ctx.camera.x = Math.max(0, Math.min(maxX, ctx.camera.x));
  ctx.camera.y = Math.max(0, Math.min(maxY, ctx.camera.y));
}

export function centerCameraOn(ctx: RenderContext, x: number, y: number) {
  ctx.camera.x = x - ctx.viewport.width / (2 * RENDER_SCALE);
  ctx.camera.y = y - ctx.viewport.height / (2 * RENDER_SCALE);
  clampCamera(ctx);
}

// ─── Live-applied options ───────────────────────────────────────────
// Options are read each frame for things that change per-frame anyway (sprite
// scale), and re-applied on change for static things (background, filters,
// text styles, document fonts).
function applyOptions(ctx: RenderContext, o: Options) {
  redrawBackground(ctx, o);
  redrawWalls(ctx, o);
  redrawGrid(ctx, o);
  ctx.app.renderer.background.color = o.oobColor;
  applyFilter(ctx.goblinLayer, ctx.goblinFilter, o.goblinSaturation, o.goblinBrightness);
  applyFilter(ctx.buildingLayer, ctx.buildingFilter, o.buildingSaturation, o.buildingBrightness);
  applySidebarColors(o);
  applyFonts(ctx, o);
}

function applySidebarColors(o: Options) {
  const root = document.documentElement;
  root.style.setProperty('--sidebar-bg', cssHex(o.sidebarBg));
  root.style.setProperty('--sidebar-border', cssHex(o.sidebarBorder));
  root.style.setProperty('--sidebar-button-bg', cssHex(o.sidebarButtonBg));
  root.style.setProperty('--sidebar-button-border', cssHex(o.sidebarButtonBorder));
  root.style.setProperty('--sidebar-accent', cssHex(o.sidebarAccent));
  root.style.setProperty('--sidebar-title', cssHex(o.sidebarTitleColor));
}

function cssHex(n: number): string {
  return '#' + n.toString(16).padStart(6, '0');
}

function redrawBackground(ctx: RenderContext, o: Options) {
  const g = ctx.playBg;
  g.clear();
  if (o.bgPattern === 'checker') {
    // Cell-sized checker over the playable area only (walls cover the rest).
    for (let cy = 0; cy < ROWS; cy++) {
      for (let cx = 0; cx < COLS; cx++) {
        const fill = ((cx + cy) & 1) === 0 ? o.bgColor : o.bgColor2;
        g.rect(cx * CELL, cy * CELL, CELL, CELL).fill(fill);
      }
    }
  } else {
    g.rect(0, 0, WORLD.width, WORLD.height).fill(o.bgColor);
  }
}

function redrawWalls(ctx: RenderContext, o: Options) {
  const g = ctx.wallGfx;
  g.clear();
  for (const key of ctx.walls) {
    const [cxs, cys] = key.split(',');
    const cx = +cxs;
    const cy = +cys;
    g.rect(cx * CELL, cy * CELL, CELL, CELL).fill(o.wallColor);
  }
}

function redrawGrid(ctx: RenderContext, o: Options) {
  const g = ctx.grid;
  g.clear();
  if (!o.gridVisible) return;
  for (let x = 0; x <= COLS; x++) g.moveTo(x * CELL, 0).lineTo(x * CELL, WORLD.height);
  for (let y = 0; y <= ROWS; y++) g.moveTo(0, y * CELL).lineTo(WORLD.width, y * CELL);
  g.stroke({ width: 1, color: o.gridColor, alpha: o.gridAlpha });
}

function applyFilter(layer: Container, f: ColorMatrixFilter, saturation: number, brightness: number) {
  const isIdentity = Math.abs(saturation - 1) < 0.005 && Math.abs(brightness - 1) < 0.005;
  if (isIdentity) {
    layer.filters = [];
    return;
  }
  f.reset();
  f.brightness(brightness, false);
  f.saturate(saturation - 1, true); // saturate(0) is no-op; positive boosts, negative desats
  layer.filters = [f];
}

function applyFonts(ctx: RenderContext, o: Options) {
  const root = document.documentElement;
  // Lazy-load any presets that haven't loaded yet.
  for (const cfg of Object.values(o.fonts)) ensureFontLoaded(cfg.family);

  const display = fontFamilyById(o.fonts.display.family).css;
  const mono    = fontFamilyById(o.fonts.mono.family).css;
  const body    = fontFamilyById(o.fonts.body.family).css;
  root.style.setProperty('--font-display', display);
  root.style.setProperty('--font-mono', mono);
  root.style.setProperty('--font-body', body);
  root.style.setProperty('--font-display-scale', String(o.fonts.display.scale));
  root.style.setProperty('--font-mono-scale', String(o.fonts.mono.scale));
  root.style.setProperty('--font-body-scale', String(o.fonts.body.scale));
  root.style.setProperty('--font-building-label-scale', String(o.fonts.buildingLabel.scale));
  root.style.setProperty('--font-building-warning-scale', String(o.fonts.buildingWarning.scale));

  // In-canvas Text — update existing buildings live; new views read from
  // options on creation.
  const labelCss   = fontFamilyById(o.fonts.buildingLabel.family).css;
  const warningCss = fontFamilyById(o.fonts.buildingWarning.family).css;
  for (const v of ctx.buildingViews.values()) {
    v.label.style.fontFamily = labelCss;
    v.label.style.fontSize = buildingLabelSize(v.cellSize, o.fonts.buildingLabel.scale);
    v.warning.style.fontFamily = warningCss;
    v.warning.style.fontSize = buildingWarningSize(o.fonts.buildingWarning.scale);
  }
}

function buildingLabelSize(cellSize: number, scale: number): number {
  const base = cellSize >= 3 ? 32 : 24;
  return Math.round(base * scale);
}

function buildingWarningSize(scale: number): number {
  return Math.round(11 * scale);
}

function makeGoblinView(g: Goblin): GoblinView {
  const c = new Container();
  c.position.set(g.pos.x, g.pos.y);

  const shadow = new Sprite(getShadowTexture());
  shadow.anchor.set(0.5);

  const ring = new Graphics();
  ring.circle(0, 0, GOBLIN.radius + 4).stroke({ width: 2, color: 0xffd96b });
  ring.visible = false;

  const startSheet = goblinIdleSheet ?? goblinWalkSheet;
  const startTex = startSheet?.frames[0][0] ?? Texture.EMPTY;
  const px = getOptions().goblinDisplayPx;
  const scale = px / (startSheet?.meta.spriteSize ?? 64);

  const outline: Sprite[] = OUTLINE_OFFSETS.map(([dx, dy]) => {
    const s = new Sprite(startTex);
    s.anchor.set(0.5);
    s.position.set(dx, dy);
    s.tint = 0x000000;
    s.scale.set(scale);
    return s;
  });

  const sprite = new Sprite(startTex);
  sprite.anchor.set(0.5);
  sprite.scale.set(scale);

  c.addChild(shadow);
  c.addChild(ring);
  for (const s of outline) c.addChild(s);
  c.addChild(sprite);
  return { container: c, shadow, outline, sprite, selectionRing: ring };
}

function makeMinotaurView(): MinotaurView {
  const c = new Container();
  const shadow = new Sprite(getShadowTexture());
  shadow.anchor.set(0.5);
  const ring = new Graphics();
  ring.circle(0, 0, MINOTAUR.radius + 6).stroke({ width: 2, color: 0xffd96b });
  ring.visible = false;
  const startSheet = minotaurWalkSheet;
  const startTex = startSheet?.frames[0][0] ?? Texture.EMPTY;
  const sprite = new Sprite(startTex);
  sprite.anchor.set(0.5);
  c.addChild(shadow);
  c.addChild(ring);
  c.addChild(sprite);
  return { container: c, shadow, sprite, selectionRing: ring };
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

  const o = getOptions();
  const labelCfg: FontConfig = o.fonts.buildingLabel;
  const warningCfg: FontConfig = o.fonts.buildingWarning;
  const label = new Text({
    text: def.short,
    style: {
      fontFamily: fontFamilyById(labelCfg.family).css,
      fontSize: buildingLabelSize(def.cellSize, labelCfg.scale),
      fill: 0xffffff,
      fontWeight: 'bold',
    },
  });
  label.anchor.set(0.5);

  const progress = new Graphics();

  const warning = new Text({
    text: '',
    style: {
      fontFamily: fontFamilyById(warningCfg.family).css,
      fontSize: buildingWarningSize(warningCfg.scale),
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
    lastState: '', lastWarning: '', lastSize: def.size, cellSize: def.cellSize,
  };
}

function drawHole(ctx: RenderContext, state: GameState) {
  const c = holeCenter(state);
  const r = CELL * HOLE_SIZE * 0.42;
  ctx.holeGfx.clear();
  ctx.holeGfx
    .ellipse(c.x, c.y + 1, r, r * 0.6).fill({ color: 0x000000, alpha: 0.55 })
    .ellipse(c.x, c.y, r, r * 0.55).fill({ color: 0x050505 })
    .ellipse(c.x, c.y - 1, r * 0.85, r * 0.45).fill({ color: 0x101010 });
  ctx.holeRing.clear();
  if (state.hole.selected) {
    const half = (CELL * HOLE_SIZE) / 2 + 2;
    ctx.holeRing
      .rect(c.x - half, c.y - half, half * 2, half * 2)
      .stroke({ width: 2, color: 0xffd96b });
  }
}

function drawDeathEffects(ctx: RenderContext, state: GameState) {
  const seen = new Set<number>();
  const frames = ctx.deathFrames;
  for (const e of state.deathEffects) {
    seen.add(e.id);
    if (!frames) continue;
    let sprite = ctx.deathViews.get(e.id);
    if (!sprite) {
      sprite = new Sprite(frames.textures[0]);
      sprite.anchor.set(0.5);
      sprite.position.set(e.x, e.y);
      // Scale once on creation to ~one cell wide.
      const target = 40;
      const sc = target / Math.max(frames.textures[0].width || target, 1);
      sprite.scale.set(sc);
      ctx.effectsLayer.addChild(sprite);
      ctx.deathViews.set(e.id, sprite);
    }
    const elapsed = state.now - e.spawnAt;
    if (elapsed >= frames.duration) {
      sprite.visible = false;
    } else {
      // Linear scan — there are typically <20 frames, faster than a binary
      // search at this size and avoids stale-frame edge cases.
      let idx = frames.ends.length - 1;
      for (let i = 0; i < frames.ends.length; i++) {
        if (elapsed < frames.ends[i]) { idx = i; break; }
      }
      sprite.texture = frames.textures[idx];
    }
  }
  for (const [id, sprite] of ctx.deathViews) {
    if (!seen.has(id)) {
      sprite.destroy();
      ctx.deathViews.delete(id);
    }
  }
}

function drawFloaters(ctx: RenderContext, state: GameState) {
  const seen = new Set<number>();
  for (const f of state.floaters) {
    seen.add(f.id);
    let t = ctx.floaterViews.get(f.id);
    if (!t) {
      t = new Text({
        text: f.text,
        style: {
          fontFamily: fontFamilyById(getOptions().fonts.mono.family).css,
          fontSize: 14,
          fill: f.color,
          fontWeight: 'bold',
          stroke: { color: 0x000000, width: 3 },
        },
      });
      t.anchor.set(0.5, 1);
      ctx.floatersLayer.addChild(t);
      ctx.floaterViews.set(f.id, t);
    }
    const age = state.now - f.spawnAt;
    const k = Math.max(0, Math.min(1, age / f.lifetime));
    t.position.set(f.x, f.y - 18 - k * 28);
    t.alpha = 1 - k;
  }
  for (const [id, t] of ctx.floaterViews) {
    if (!seen.has(id)) {
      t.destroy();
      ctx.floaterViews.delete(id);
    }
  }
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
  if (b.kind === 'phone_farm') {
    for (let i = -1; i <= 1; i++) {
      g.rect(-half + 14, -10 + i * 14, def.size - 28, 7).fill({ color: 0x000000, alpha: 0.25 });
    }
  } else if (b.kind === 'datacentre') {
    // Big server-rack grid suggesting a real mining hall.
    for (let row = -2; row <= 2; row++) {
      g.rect(-half + 16, row * 14 - 3, def.size - 32, 6).fill({ color: 0x000000, alpha: 0.28 });
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
  } else if (b.kind === 'gas_engine') {
    // smokestacks: 3 narrow rectangles along the top
    const w = 10;
    for (let i = -1; i <= 1; i++) {
      g.rect(i * 24 - w / 2, -half + 6, w, def.size - 18)
        .fill({ color: 0x000000, alpha: 0.32 });
    }
  } else if (b.kind === 'goblin_hole') {
    // A dark pit at the center plus a smaller inner ring for depth.
    g.circle(0, 0, def.size * 0.35).fill({ color: 0x000000, alpha: 0.55 });
    g.circle(0, 0, def.size * 0.22).fill({ color: 0x000000, alpha: 0.7 });
  }
}

export function render(state: GameState, ctx: RenderContext) {
  // Apply camera by translating the world layer (UI overlays in DOM stay fixed).
  // Camera is in world units; multiply by RENDER_SCALE to get screen pixels.
  // When the viewport is larger than the scaled world, center the world.
  const scaledW = WORLD.width * RENDER_SCALE;
  const scaledH = WORLD.height * RENDER_SCALE;
  const offsetX = Math.max(0, (ctx.viewport.width - scaledW) / 2);
  const offsetY = Math.max(0, (ctx.viewport.height - scaledH) / 2);
  ctx.worldLayer.position.set(
    Math.round(offsetX - ctx.camera.x * RENDER_SCALE),
    Math.round(offsetY - ctx.camera.y * RENDER_SCALE),
  );

  const opts = getOptions();
  const displayPx = opts.goblinDisplayPx;

  // Goblin Hole — re-drawn each frame (cheap and keeps the position cell-exact
  // even if anything moves it later).
  drawHole(ctx, state);

  // Floaters: rising fading text. Sim adds & expires; renderer just animates.
  drawFloaters(ctx, state);

  // Death effects: spawn a one-shot GifSprite per new entry; the sim expires
  // entries after a couple seconds and we tear the sprite down with them.
  drawDeathEffects(ctx, state);

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
    v.selectionRing.visible = g.selected;
    // Shadow under the feet — anchored at sprite center, offset down to feet.
    v.shadow.visible = opts.goblinShadow;
    if (opts.goblinShadow) {
      v.shadow.position.set(0, displayPx * 0.32);
      const sy = displayPx / 64;
      v.shadow.scale.set(sy * 0.75, sy);
    }
    // Walk while interpolating between cells; idle when stationary; break into
    // breakdance once a goblin's been continuously idle for long enough.
    const idleFor = (g.state.kind === 'idle' && g.idleSince !== null)
      ? state.now - g.idleSince : 0;
    const breakdancing = idleFor >= GOBLIN.breakdanceAfter;
    const swinging = g.state.kind === 'going_to_kill' && g.state.attackAt !== undefined;
    const sheet =
      (swinging ? goblinSwipeSheet : null) ??
      (breakdancing ? goblinBreakdanceSheet : null) ??
      (g.target !== null ? goblinWalkSheet : goblinIdleSheet) ??
      goblinWalkSheet ?? goblinIdleSheet;
    if (sheet) {
      const dir = dirIndex(sheet.meta, g.facing);
      const fpd = sheet.meta.framesPerDirection;
      const frame = Math.floor(state.now * sheet.fps) % fpd;
      const tex = sheet.frames[dir][frame];
      const sc = displayPx / sheet.meta.spriteSize;
      v.sprite.texture = tex;
      v.sprite.scale.set(sc);
      if (opts.goblinOutline) {
        for (const s of v.outline) {
          s.texture = tex;
          s.scale.set(sc);
        }
      }
    }
    for (const s of v.outline) s.visible = opts.goblinOutline;
    let tint = 0xffffff;
    if (g.state.kind === 'building' || g.state.kind === 'going_to_build') tint = 0xfff0a8;
    else if (g.state.kind === 'maintaining' || g.state.kind === 'going_to_maintain') tint = 0xa8d8ff;
    v.sprite.tint = tint;
  }
  for (const [id, v] of ctx.goblinViews) {
    if (!seenG.has(id)) {
      v.container.destroy({ children: true });
      ctx.goblinViews.delete(id);
    }
  }

  // Minotaurs — sass-walk loop while moving / hunting, mutant swipe while
  // winding up an attack (vs. goblin, vs. minotaur, or vs. building).
  const minotaurDisplayPx = displayPx * (MINOTAUR.radius / GOBLIN.radius);
  const seenT = new Set<number>();
  for (const t of state.minotaurs.values()) {
    seenT.add(t.id);
    let v = ctx.minotaurViews.get(t.id);
    if (!v) {
      v = makeMinotaurView();
      ctx.minotaurLayer.addChild(v.container);
      ctx.minotaurViews.set(t.id, v);
    }
    v.container.position.set(t.pos.x, t.pos.y);
    v.selectionRing.visible = t.selected;
    v.shadow.visible = opts.goblinShadow;
    if (opts.goblinShadow) {
      v.shadow.position.set(0, minotaurDisplayPx * 0.32);
      const sy = minotaurDisplayPx / 64;
      v.shadow.scale.set(sy * 0.75, sy);
    }
    const winding =
      (t.state.kind === 'going_to_kill' || t.state.kind === 'going_to_kill_minotaur' || t.state.kind === 'going_to_destroy')
      && t.state.attackAt !== undefined;
    const sheet = (winding ? minotaurSwipeSheet : null) ?? minotaurWalkSheet;
    if (sheet) {
      const dir = dirIndex(sheet.meta, t.facing);
      const fpd = sheet.meta.framesPerDirection;
      const frame = Math.floor(state.now * sheet.fps) % fpd;
      v.sprite.texture = sheet.frames[dir][frame];
      v.sprite.scale.set(minotaurDisplayPx / sheet.meta.spriteSize);
    }
  }
  for (const [id, v] of ctx.minotaurViews) {
    if (!seenT.has(id)) {
      v.container.destroy({ children: true });
      ctx.minotaurViews.delete(id);
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
