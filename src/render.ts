import { Application, Assets, ColorMatrixFilter, Container, extensions, Graphics, Rectangle, Sprite, Text, Texture } from 'pixi.js';
import { GifAsset, GifSource } from 'pixi.js/gif';

// Side-effect registration: `pixi.js/gif` does NOT auto-register the .gif
// asset loader on import. Without this, `Assets.load(*.gif)` rejects.
extensions.add(GifAsset);

// Decoded GIF: frame textures + the cumulative time-of-end of each frame, in
// game seconds. Used as a manual sprite-sheet — we pick the frame ourselves
// each tick based on (state.now - spawnAt) so playback always starts at frame 0.
type DeathFrames = { textures: Texture[]; ends: number[]; duration: number };
import { AMBIENT_DRAGON, BUILDING_DEFS, BuildingKind, CELL, COLS, DRAGON, GOBLIN, RENDER_SCALE, ROWS, MINOTAUR, SPACE, TINYTAUR, WORLD } from './config';
import { ensureFontLoaded, fontFamilyById, getOptions, onOptionsChange, type FontConfig, type Options } from './options';
import { Building, Dragon, GameState, Goblin, HOLE_SIZE, Minotaur, SpaceBuilding, WaterSource, buildingCenter, cellCenter, defOf, holeCenter, isInPlayCell, maintainerCount } from './state';

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

// ─── Building sprites ───────────────────────────────────────────────
// One PNG per building kind, keyed by the kind id. Drawn as a Sprite scaled
// to the building's pixel size. The colored body / border / short label
// underneath are independently toggleable via options.
const buildingTextures: Partial<Record<BuildingKind, Texture>> = {};
async function loadBuildingTextures(): Promise<void> {
  const kinds = Object.keys(BUILDING_DEFS) as BuildingKind[];
  await Promise.all(kinds.map(async (k) => {
    try {
      buildingTextures[k] = await Assets.load<Texture>(`assets/buildings/${k}.png`);
    } catch (err) {
      console.warn(`building sprite ${k} failed to load`, err);
    }
  }));
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

// Soft radial white glow, generated lazily. Tinted per-use (orange behind a
// dragon, pale behind a space building).
let glowTexture: Texture | null = null;
function getGlowTexture(): Texture {
  if (glowTexture) return glowTexture;
  const s = 128;
  const canvas = document.createElement('canvas');
  canvas.width = s; canvas.height = s;
  const c = canvas.getContext('2d')!;
  const grad = c.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grad.addColorStop(0, 'rgba(255,255,255,0.9)');
  grad.addColorStop(0.4, 'rgba(255,255,255,0.35)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = grad;
  c.fillRect(0, 0, s, s);
  glowTexture = Texture.from(canvas);
  return glowTexture;
}

// One-time starfield + nebula for the space scene, painted across SPACE bounds.
function drawSpaceBackground(g: Graphics): void {
  g.clear();
  // Deep base wash.
  g.rect(0, 0, SPACE.width, SPACE.height).fill(0x05060f);
  // A couple of soft nebula clouds.
  const nebula: [number, number, number, number][] = [
    [SPACE.width * 0.30, SPACE.height * 0.35, 360, 0x2a1850],
    [SPACE.width * 0.70, SPACE.height * 0.62, 420, 0x10324a],
    [SPACE.width * 0.55, SPACE.height * 0.22, 300, 0x3a1430],
  ];
  for (const [nx, ny, nr, col] of nebula) {
    for (let i = 4; i >= 1; i--) {
      g.circle(nx, ny, nr * (i / 4)).fill({ color: col, alpha: 0.06 });
    }
  }
  // Stars — many faint, a few bright, a sprinkle of colour.
  for (let i = 0; i < 900; i++) {
    const x = Math.random() * SPACE.width;
    const y = Math.random() * SPACE.height;
    const r = Math.random() < 0.92 ? 0.6 + Math.random() * 1.0 : 1.6 + Math.random() * 1.4;
    const tint = Math.random();
    const col = tint < 0.8 ? 0xffffff : tint < 0.9 ? 0xbfd0ff : 0xffe0c0;
    g.circle(x, y, r).fill({ color: col, alpha: 0.4 + Math.random() * 0.6 });
  }
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

type DragonView = {
  container: Container;   // positioned at the dragon's world pos
  glow: Sprite;           // soft radial behind the block
  block: Graphics;        // placeholder tile (drawn once)
  label: Text;            // 🐉 glyph on the tile
  carried: Sprite;        // the building currently being hauled (hidden otherwise)
  selectionRing: Graphics;
};

type SpaceBuildingView = {
  container: Container;   // positioned at the space pos, in spaceLayer
  glow: Sprite;
  sprite: Sprite;
  label: Text;
  selectionRing: Graphics;
};

// A decorative dragon drifting across the space scene. Renderer-owned: not in
// game state, never saved, never hit-tested. Position is derived each frame from
// (x0 + dir·speed·elapsed), so there's no per-tick physics to keep in sync.
type AmbientDragon = {
  id: number;
  x0: number;            // space-x at spawnAt
  y: number;             // fixed space-y the dragon cruises along
  dir: 1 | -1;           // travel direction (and sprite mirror)
  speed: number;         // space-px/sec
  scale: number;         // size multiplier vs a full dragon
  bobPhase: number;
  bobAmp: number;
  spawnAt: number;       // state.now when it entered
  container: Container;  // lives in spaceAmbientLayer
};

// A precomputed star for the climb-transition overlay (screen-space fractions).
type TransStar = { fx: number; fy: number; r: number; phase: number };
// A precomputed cloud band for the climb transition.
type TransCloud = { h: number; fx: number; scale: number; puffs: [number, number, number][] };

type WaterView = {
  container: Container;
  body: Graphics;
  selectionRing: Graphics;
};

type BuildingView = {
  container: Container;
  body: Graphics;
  sprite: Sprite;
  selectionRing: Graphics;
  label: Text;
  progress: Graphics;
  warning: Text;
  lastState: string;
  lastWarning: string;
  lastSize: number;
  cellSize: number;
  // Snapshot of the option toggles last used to draw the body — lets us redraw
  // when any of them flip without doing it every frame.
  lastBodyKey: string;
  // Tracks whether the sprite is currently greyscaled. Separate from lastState
  // because lastState gets overwritten by the bodyKey-based redraw block.
  greyscaled: boolean;
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
  dragonLayer: Container;
  dragonViews: Map<number, DragonView>;
  waterLayer: Container;
  waterViews: Map<number, WaterView>;
  buildingViews: Map<number, BuildingView>;
  camera: Camera;
  viewport: { width: number; height: number };
  // ─── Space scene + climb transition ───
  // Floating-building diorama. Scaled + camera-panned like worldLayer.
  spaceLayer: Container;
  spaceBg: Graphics;                 // starfield + nebula, drawn once
  spaceBuildingViews: Map<number, SpaceBuildingView>;
  spaceCamera: Camera;
  // Decorative dragons drifting across the void, behind the floating buildings.
  // Renderer-owned and ephemeral — spawned while in space, cleared when not.
  spaceAmbientLayer: Container;
  ambientDragons: AmbientDragon[];
  nextAmbientSpawnAt: number;
  ambientIdSeq: number;
  // Full-screen overlay for the climb between ground and space.
  skyLayer: Container;
  skyGfx: Graphics;
  cloudGfx: Graphics;
  starGfx: Graphics;
  transStars: TransStar[];
  transClouds: TransCloud[];
  // 0 = on the ground, 1 = in space. Animated by main.ts; the renderer reads it
  // to cross-fade the scenes and drive the overlay.
  altitude: number;
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
  // Lightning Strike: white blood splatters live in their own layer carrying a
  // force-white color matrix (a plain white tint can't brighten the red blood
  // asset). The bolt itself is a single re-drawn Graphics.
  whiteEffectsLayer: Container;
  lightningGfx: Graphics;
  // Mutable references — used by applyOptions() to redraw on the fly.
  walls: Set<string>;
  wallsVersion: number;     // last drawn version; render compares vs state.wallsVersion
  state: GameState;         // most-recent state ref, kept updated each render
  playBg: Graphics;
  wallGfx: Graphics;
  grid: Graphics;
  goblinFilter: ColorMatrixFilter;
  minotaurFilter: ColorMatrixFilter;
  buildingFilter: ColorMatrixFilter;
};

export async function createRender(parent: HTMLElement, state: GameState): Promise<RenderContext> {
  const walls = state.walls;
  await Promise.all([loadGoblinSheets(), loadBuildingTextures()]);
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
  const dragonLayer = new Container();
  const waterLayer = new Container();
  const uiLayer = new Container();

  // Per-child culling on the high-cardinality dynamic layers. Pixi v8 skips
  // children whose getBounds() falls outside the projected view, which
  // matters once a session crosses ~hundreds of goblins / floaters.
  // Building footprints don't move and there are few of them, so it isn't
  // worth the bounds check there.
  goblinLayer.cullableChildren = true;
  minotaurLayer.cullableChildren = true;
  // floatersLayer + effectsLayer are declared below; flag them at creation.

  // Playable-area background, walls, and grid — drawn lazily from current options.
  const playBg = new Graphics();
  const wallGfx = new Graphics();
  const grid = new Graphics();
  const holeGfx = new Graphics();
  const holeRing = new Graphics();

  const floatersLayer = new Container();
  const effectsLayer = new Container();
  const whiteEffectsLayer = new Container();
  floatersLayer.cullableChildren = true;
  effectsLayer.cullableChildren = true;
  whiteEffectsLayer.cullableChildren = true;
  // Map every pixel to opaque-following white so the blood asset reads as a
  // pale lightning scorch regardless of its native color.
  const whiteFilter = new ColorMatrixFilter();
  whiteFilter.matrix = [
    0, 0, 0, 0, 1,
    0, 0, 0, 0, 1,
    0, 0, 0, 0, 1,
    0, 0, 0, 1, 0,
  ] as typeof whiteFilter.matrix;
  whiteEffectsLayer.filters = [whiteFilter];
  const lightningGfx = new Graphics();

  worldLayer.addChild(playBg);
  worldLayer.addChild(wallGfx);
  worldLayer.addChild(grid);
  worldLayer.addChild(waterLayer);
  worldLayer.addChild(holeGfx);
  worldLayer.addChild(buildingLayer);
  worldLayer.addChild(goblinLayer);
  worldLayer.addChild(minotaurLayer);
  worldLayer.addChild(dragonLayer);
  worldLayer.addChild(holeRing);
  worldLayer.addChild(effectsLayer);
  worldLayer.addChild(whiteEffectsLayer);
  worldLayer.addChild(floatersLayer);
  worldLayer.addChild(lightningGfx);
  worldLayer.addChild(uiLayer);
  worldLayer.scale.set(RENDER_SCALE);
  app.stage.addChild(worldLayer);
  dragonLayer.cullableChildren = true;

  // ─── Space scene ───
  // Floating-building diorama, panned by spaceCamera and scaled like the world.
  const spaceLayer = new Container();
  const spaceBg = new Graphics();
  drawSpaceBackground(spaceBg);
  spaceLayer.addChild(spaceBg);
  // Ambient dragons sit above the starfield but below the floating buildings,
  // which are added to spaceLayer later (during render) and so stack on top.
  const spaceAmbientLayer = new Container();
  spaceLayer.addChild(spaceAmbientLayer);
  spaceLayer.scale.set(RENDER_SCALE);
  spaceLayer.visible = false;
  app.stage.addChild(spaceLayer);

  // ─── Climb transition overlay (screen-space) ───
  const skyLayer = new Container();
  const skyGfx = new Graphics();
  const cloudGfx = new Graphics();
  const starGfx = new Graphics();
  skyLayer.addChild(skyGfx);
  skyLayer.addChild(starGfx);
  skyLayer.addChild(cloudGfx);
  skyLayer.visible = false;
  app.stage.addChild(skyLayer);

  // Precompute the overlay's stars and cloud bands once.
  const transStars: TransStar[] = [];
  for (let i = 0; i < 220; i++) {
    transStars.push({
      fx: Math.random(),
      fy: Math.random(),
      r: 0.5 + Math.random() * 1.6,
      phase: Math.random() * Math.PI * 2,
    });
  }
  const transClouds: TransCloud[] = [];
  for (let i = 0; i < 9; i++) {
    const puffs: [number, number, number][] = [];
    const lobes = 4 + Math.floor(Math.random() * 4);
    for (let p = 0; p < lobes; p++) {
      puffs.push([
        (Math.random() - 0.5) * 1.7,    // x offset (cloud-widths)
        (Math.random() - 0.5) * 0.4,    // y offset
        0.4 + Math.random() * 0.6,      // radius (cloud-heights)
      ]);
    }
    transClouds.push({
      h: 0.05 + Math.random() * 0.34,   // altitude band of the cloud
      fx: Math.random(),
      scale: 70 + Math.random() * 90,
      puffs,
    });
  }

  // Color filters let the user dial sprite/building saturation+brightness live.
  // They're only attached when needed — applying a filter forces Pixi to
  // render the layer to an offscreen texture each frame, which is wasteful
  // when the matrix is the identity.
  const goblinFilter = new ColorMatrixFilter();
  const minotaurFilter = new ColorMatrixFilter();
  const buildingFilter = new ColorMatrixFilter();

  const ctx: RenderContext = {
    app, worldLayer, buildingLayer, goblinLayer, uiLayer,
    goblinViews: new Map(),
    minotaurLayer, minotaurViews: new Map(),
    dragonLayer, dragonViews: new Map(),
    waterLayer, waterViews: new Map(),
    buildingViews: new Map(),
    camera: { x: 0, y: 0 },
    viewport: { width: initW, height: initH },
    spaceLayer, spaceBg, spaceBuildingViews: new Map(),
    spaceCamera: { x: 0, y: 0 },
    spaceAmbientLayer, ambientDragons: [], nextAmbientSpawnAt: 0, ambientIdSeq: 1,
    skyLayer, skyGfx, cloudGfx, starGfx,
    transStars, transClouds,
    altitude: 0,
    holeGfx, holeRing,
    floatersLayer, floaterViews: new Map(),
    effectsLayer, deathViews: new Map(),
    deathFrames: null,
    whiteEffectsLayer, lightningGfx,
    walls, wallsVersion: -1, state, playBg, wallGfx, grid, goblinFilter, minotaurFilter, buildingFilter,
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
  applyFilter(ctx.minotaurLayer, ctx.minotaurFilter, o.minotaurSaturation, o.minotaurBrightness);
  applyFilter(ctx.buildingLayer, ctx.buildingFilter, o.buildingSaturation, o.buildingBrightness);
  applyDomOptions(o);
  applyFonts(ctx, o);
}

// DOM-only side of applyOptions — sidebar CSS vars + button corner classes.
// Split out so main() can call it before Pixi exists (i.e. while the title
// screen is up), otherwise the title's .build-buttons render with rounded
// corners until the player clicks and createRender runs applyOptions.
export function applyDomOptions(o: Options) {
  applySidebarColors(o);
  document.body.classList.toggle('no-rounded-buttons', !o.buttonsRounded);
  document.body.classList.toggle('cut-corner-buttons', o.buttonsCutCorners);
  document.documentElement.style.setProperty('--button-cut', `${o.buttonCutSize}px`);
  document.documentElement.style.setProperty('--button-cut-border', cssHex(o.buttonCutBorderColor));
}

function applySidebarColors(o: Options) {
  const root = document.documentElement;
  root.style.setProperty('--sidebar-bg', cssHex(o.sidebarBg));
  root.style.setProperty('--sidebar-border', cssHex(o.sidebarBorder));
  root.style.setProperty('--sidebar-button-bg', cssHex(o.sidebarButtonBg));
  root.style.setProperty('--sidebar-button-border', cssHex(o.sidebarButtonBorder));
  root.style.setProperty('--sidebar-accent', cssHex(o.sidebarAccent));
  root.style.setProperty('--sidebar-title', cssHex(o.sidebarTitleColor));
  root.style.setProperty('--sidebar-button-hover-border', cssHex(o.sidebarButtonHoverBorder));
}

function cssHex(n: number): string {
  return '#' + n.toString(16).padStart(6, '0');
}

function redrawBackground(ctx: RenderContext, o: Options) {
  const g = ctx.playBg;
  g.clear();
  // Only fill cells that are inside the plus-shaped play area. Cells outside
  // get nothing here — the canvas oobColor shows through, and the wall layer
  // paints the 2-cell border on top of it.
  const state = ctx.state;
  for (let cy = 0; cy < ROWS; cy++) {
    for (let cx = 0; cx < COLS; cx++) {
      if (!isInPlayCell(state, cx, cy)) continue;
      const fill = o.bgPattern === 'checker'
        ? (((cx + cy) & 1) === 0 ? o.bgColor : o.bgColor2)
        : o.bgColor;
      g.rect(cx * CELL, cy * CELL, CELL, CELL).fill(fill);
    }
  }
}

function redrawWalls(ctx: RenderContext, o: Options) {
  const g = ctx.wallGfx;
  g.clear();
  // Only paint cells that are within 2 cells (Chebyshev) of any play cell —
  // that's the wall band around the plus-shape. Anything further out is
  // void (renders as the canvas oobColor, no fill).
  const state = ctx.state;
  for (const key of ctx.walls) {
    const [cxs, cys] = key.split(',');
    const cx = +cxs;
    const cy = +cys;
    let nearPlay = false;
    for (let dy = -2; dy <= 2 && !nearPlay; dy++) {
      for (let dx = -2; dx <= 2 && !nearPlay; dx++) {
        if (isInPlayCell(state, cx + dx, cy + dy)) nearPlay = true;
      }
    }
    if (nearPlay) g.rect(cx * CELL, cy * CELL, CELL, CELL).fill(o.wallColor);
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

  const display  = fontFamilyById(o.fonts.display.family).css;
  const mono     = fontFamilyById(o.fonts.mono.family).css;
  const body     = fontFamilyById(o.fonts.body.family).css;
  const dialogue = fontFamilyById(o.fonts.dialogue.family).css;
  root.style.setProperty('--font-display', display);
  root.style.setProperty('--font-mono', mono);
  root.style.setProperty('--font-body', body);
  root.style.setProperty('--font-dialogue', dialogue);
  // globalFontScale multiplies every per-key scale uniformly so the player
  // can blow up (or shrink) all UI text from a single slider.
  const gs = o.globalFontScale;
  root.style.setProperty('--font-display-scale', String(o.fonts.display.scale * gs));
  root.style.setProperty('--font-mono-scale', String(o.fonts.mono.scale * gs));
  root.style.setProperty('--font-body-scale', String(o.fonts.body.scale * gs));
  root.style.setProperty('--font-building-label-scale', String(o.fonts.buildingLabel.scale * gs));
  root.style.setProperty('--font-building-warning-scale', String(o.fonts.buildingWarning.scale * gs));
  root.style.setProperty('--font-dialogue-scale', String(o.fonts.dialogue.scale * gs));

  // In-canvas Text — update existing buildings live; new views read from
  // options on creation.
  const labelCss   = fontFamilyById(o.fonts.buildingLabel.family).css;
  const warningCss = fontFamilyById(o.fonts.buildingWarning.family).css;
  for (const v of ctx.buildingViews.values()) {
    v.label.style.fontFamily = labelCss;
    v.label.style.fontSize = buildingLabelSize(v.cellSize, o.fonts.buildingLabel.scale * gs);
    v.warning.style.fontFamily = warningCss;
    v.warning.style.fontSize = buildingWarningSize(o.fonts.buildingWarning.scale * gs);
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

// No dragon sprite sheet ships, so the dragon is a placeholder tile: an orange
// rounded block with a 🐉 glyph, matching the building-placeholder look. A soft
// glow sits behind it and the carried building rides just below.
const DRAGON_BLOCK = Math.round(DRAGON.displayPx * 0.78);
function makeDragonView(): DragonView {
  const container = new Container();

  const glow = new Sprite(getGlowTexture());
  glow.anchor.set(0.5);
  glow.tint = 0xff8a3a;
  glow.scale.set(DRAGON.displayPx * 1.7 / 128);
  glow.alpha = 0.35;

  const block = new Graphics();
  const half = DRAGON_BLOCK / 2;
  block.roundRect(-half, -half, DRAGON_BLOCK, DRAGON_BLOCK, 8)
    .fill(0xe07a2a)
    .stroke({ width: 3, color: 0xffd24a });

  const label = new Text({
    text: '🐉',
    style: { fontFamily: 'sans-serif', fontSize: Math.round(DRAGON_BLOCK * 0.62), fill: 0xffffff },
  });
  label.anchor.set(0.5);

  const carried = new Sprite(Texture.EMPTY);
  carried.anchor.set(0.5);
  carried.visible = false;

  const selectionRing = new Graphics();
  selectionRing.circle(0, 0, DRAGON.displayPx * 0.5).stroke({ width: 2, color: 0xffd96b });
  selectionRing.visible = false;

  container.addChild(glow);
  container.addChild(carried);
  container.addChild(block);
  container.addChild(label);
  container.addChild(selectionRing);
  return { container, glow, block, label, carried, selectionRing };
}

// Ambient dragons reuse the placeholder-tile look but darkened: a dim block, a
// faint glow, and the whole thing held at reduced alpha so it reads as a distant
// silhouette against the stars rather than a summonable dragon.
const AMBIENT_DRAGON_FILL = 0x53300f;
const AMBIENT_DRAGON_BORDER = 0x7a4a22;
function spawnAmbientDragon(ctx: RenderContext, midScene: boolean): void {
  const cfg = AMBIENT_DRAGON;
  const dir: 1 | -1 = Math.random() < 0.5 ? 1 : -1;
  const scale = cfg.scaleMin + Math.random() * (cfg.scaleMax - cfg.scaleMin);
  const speed = cfg.speedMin + Math.random() * (cfg.speedMax - cfg.speedMin);

  const container = new Container();
  container.alpha = 0.72;

  const glow = new Sprite(getGlowTexture());
  glow.anchor.set(0.5);
  glow.tint = 0xff8a3a;
  glow.scale.set(DRAGON.displayPx * 1.4 / 128);
  glow.alpha = 0.16;

  const block = new Graphics();
  const half = DRAGON_BLOCK / 2;
  block.roundRect(-half, -half, DRAGON_BLOCK, DRAGON_BLOCK, 8)
    .fill(AMBIENT_DRAGON_FILL)
    .stroke({ width: 3, color: AMBIENT_DRAGON_BORDER });

  const label = new Text({
    text: '🐉',
    style: { fontFamily: 'sans-serif', fontSize: Math.round(DRAGON_BLOCK * 0.62), fill: 0xffffff },
  });
  label.anchor.set(0.5);
  label.alpha = 0.82;

  container.addChild(glow);
  container.addChild(block);
  container.addChild(label);
  ctx.spaceAmbientLayer.addChild(container);

  ctx.ambientDragons.push({
    id: ctx.ambientIdSeq++,
    // When pre-filling an empty scene, start somewhere on-screen so arriving in
    // space isn't a beat of emptiness; otherwise enter from just off the edge.
    x0: midScene
      ? SPACE.width * (0.15 + Math.random() * 0.70)
      : (dir > 0 ? -cfg.margin : SPACE.width + cfg.margin),
    y: SPACE.height * (0.12 + Math.random() * 0.76),
    dir, speed, scale,
    bobPhase: Math.random() * Math.PI * 2,
    bobAmp: cfg.bobAmpMin + Math.random() * (cfg.bobAmpMax - cfg.bobAmpMin),
    spawnAt: ctx.state.now,
    container,
  });
}

// Advance the decorative space dragons: top up to the cap on a relaxed cadence,
// slide each across the void, and retire any that have left the far edge. Only
// runs while space is on screen; everything is torn down when it isn't.
function updateAmbientDragons(ctx: RenderContext): void {
  const cfg = AMBIENT_DRAGON;
  if (ctx.altitude <= 0.5) {
    if (ctx.ambientDragons.length > 0) {
      for (const a of ctx.ambientDragons) a.container.destroy({ children: true });
      ctx.ambientDragons.length = 0;
    }
    ctx.nextAmbientSpawnAt = 0;
    return;
  }
  const now = ctx.state.now;
  if (ctx.ambientDragons.length < cfg.maxOnScreen && now >= ctx.nextAmbientSpawnAt) {
    spawnAmbientDragon(ctx, ctx.ambientDragons.length === 0);
    ctx.nextAmbientSpawnAt = now + cfg.spawnDelayMin + Math.random() * (cfg.spawnDelayMax - cfg.spawnDelayMin);
  }
  for (let i = ctx.ambientDragons.length - 1; i >= 0; i--) {
    const a = ctx.ambientDragons[i];
    const x = a.x0 + a.dir * a.speed * (now - a.spawnAt);
    const gone = a.dir > 0 ? x > SPACE.width + cfg.margin : x < -cfg.margin;
    if (gone) {
      a.container.destroy({ children: true });
      ctx.ambientDragons.splice(i, 1);
      continue;
    }
    const bob = Math.sin((now + a.bobPhase) * 2.2) * a.bobAmp;
    a.container.position.set(x, a.y + bob);
    // The 🐉 glyph faces left; mirror on x when travelling right.
    a.container.scale.set(a.dir > 0 ? -a.scale : a.scale, a.scale);
  }
}

function makeWaterView(w: WaterSource): WaterView {
  const c = new Container();
  const body = new Graphics();
  const x = w.x0 * CELL;
  const y = w.y0 * CELL;
  const wpx = (w.x1 - w.x0) * CELL;
  const hpx = (w.y1 - w.y0) * CELL;
  body.rect(x, y, wpx, hpx).fill(0x2a5aa8);
  // Sparse ripple highlights so the surface reads as water rather than a
  // flat blue rectangle. Random per build but stable thereafter.
  const rippleCount = Math.max(4, Math.floor((wpx * hpx) / (CELL * CELL * 4)));
  for (let i = 0; i < rippleCount; i++) {
    const rx = x + Math.random() * wpx;
    const ry = y + Math.random() * hpx;
    const rr = CELL * (0.16 + Math.random() * 0.16);
    body.circle(rx, ry, rr).fill({ color: 0x4a8acf, alpha: 0.7 });
    body.circle(rx + rr * 0.4, ry - rr * 0.4, rr * 0.3).fill({ color: 0xffffff, alpha: 0.35 });
  }
  const selectionRing = new Graphics();
  selectionRing.rect(x - 1, y - 1, wpx + 2, hpx + 2).stroke({ width: 2, color: 0xffd96b });
  selectionRing.visible = false;
  c.addChild(body);
  c.addChild(selectionRing);
  return { container: c, body, selectionRing };
}

function makeBuildingView(b: Building): BuildingView {
  const def = defOf(b);
  const c = new Container();
  const ctr = buildingCenter(b);
  c.position.set(ctr.x, ctr.y);

  const selectionRing = new Graphics();
  drawSelectionRing(selectionRing, def.size);
  selectionRing.visible = false;

  const o = getOptions();
  const body = new Graphics();
  drawBuildingBody(body, b, o);

  const tex = buildingTextures[b.kind] ?? Texture.EMPTY;
  const sprite = new Sprite(tex);
  sprite.anchor.set(0.5);
  sizeBuildingSprite(sprite, def.size);
  sprite.visible = o.buildingSpriteEnabled;
  const startGrey = b.state !== 'active';
  if (startGrey) sprite.filters = [getBuildingGreyscaleFilter()];

  const labelCfg: FontConfig = o.fonts.buildingLabel;
  const warningCfg: FontConfig = o.fonts.buildingWarning;
  const gs = o.globalFontScale;
  const label = new Text({
    text: def.short,
    style: {
      fontFamily: fontFamilyById(labelCfg.family).css,
      fontSize: buildingLabelSize(def.cellSize, labelCfg.scale * gs),
      fill: 0xffffff,
      fontWeight: 'bold',
    },
  });
  label.anchor.set(0.5);
  label.visible = o.buildingLabelEnabled;

  const progress = new Graphics();

  const warning = new Text({
    text: '',
    style: {
      fontFamily: fontFamilyById(warningCfg.family).css,
      fontSize: buildingWarningSize(warningCfg.scale * gs),
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
  c.addChild(sprite);
  c.addChild(label);
  c.addChild(progress);
  c.addChild(warning);

  return {
    container: c, body, sprite, selectionRing, label, progress, warning,
    lastState: '', lastWarning: '', lastSize: def.size, cellSize: def.cellSize,
    lastBodyKey: bodyKey(b, o),
    greyscaled: startGrey,
  };
}

// Shared full-desaturate filter applied to building sprites that aren't yet
// running (constructing or dormant). One instance is reused across sprites —
// Pixi handles a filter being attached to multiple display objects.
let buildingGreyscaleFilter: ColorMatrixFilter | null = null;
function getBuildingGreyscaleFilter(): ColorMatrixFilter {
  if (buildingGreyscaleFilter) return buildingGreyscaleFilter;
  const f = new ColorMatrixFilter();
  f.saturate(-1, false);
  buildingGreyscaleFilter = f;
  return f;
}

// Scale a building sprite so its longest side matches the building's pixel
// size. Source PNGs are square; this works for non-square art too.
function sizeBuildingSprite(s: Sprite, size: number): void {
  const w = s.texture.width || size;
  const h = s.texture.height || size;
  const sc = size / Math.max(w, h);
  s.scale.set(sc);
}

// Encodes the inputs that drawBuildingBody depends on, so we can redraw only
// when one of them changes. Includes options that toggle visual layers and
// the alpha multiplier on the fill.
function bodyKey(b: Building, o: Options): string {
  return [
    b.state,
    o.buildingFillEnabled ? 1 : 0,
    o.buildingBorderEnabled ? 1 : 0,
    o.buildingFillAlpha.toFixed(3),
  ].join('|');
}

// Both the starting Goblin Hole (state.hole) and Goblin Hole buildings render
// the same way: a black-filled circle with a thin white outline. Shared here
// so the two never visually drift.
const HOLE_RADIUS = CELL * 0.42;
function drawHoleAt(g: Graphics, x: number, y: number) {
  g.circle(x, y, HOLE_RADIUS).fill(0x000000).stroke({ width: 1.5, color: 0xffffff });
}

function drawHole(ctx: RenderContext, state: GameState) {
  const c = holeCenter(state);
  ctx.holeGfx.clear();
  drawHoleAt(ctx.holeGfx, c.x, c.y);
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
      sprite.cullable = true;
      // White splatters go in the force-white layer; the tint below is left
      // alone for them so the color matrix has the raw alpha to work with.
      (e.white ? ctx.whiteEffectsLayer : ctx.effectsLayer).addChild(sprite);
      ctx.deathViews.set(e.id, sprite);
    }
    if (!e.white) sprite.tint = getOptions().bloodColor;
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
      const opts = getOptions();
      t = new Text({
        text: f.text,
        style: {
          fontFamily: fontFamilyById(opts.fonts.mono.family).css,
          // Baseline 14 px, scaled by the global font multiplier so the same
          // slider that resizes UI text also resizes in-world numbers.
          fontSize: 14 * opts.globalFontScale,
          fill: f.color,
          fontWeight: 'bold',
          stroke: { color: 0x000000, width: 3 },
        },
      });
      t.anchor.set(0.5, 1);
      t.cullable = true;
      // Space-building floaters live in the orbit scene (panned by the space
      // camera); everything else rides the ground world layer.
      (f.space ? ctx.spaceLayer : ctx.floatersLayer).addChild(t);
      ctx.floaterViews.set(f.id, t);
    }
    const age = state.now - f.spawnAt;
    const k = Math.max(0, Math.min(1, age / f.lifetime));
    // Power-surge floater: recompute the GW readout as it decays to 0.
    if (f.powerCountdownWatts !== undefined) {
      const remaining = f.powerCountdownWatts * (1 - k);
      t.text = `+${(remaining / 1e9).toFixed(2)} GW`;
    }
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

function drawLightning(ctx: RenderContext, state: GameState) {
  const g = ctx.lightningGfx;
  g.clear();
  for (const bolt of state.lightningBolts) {
    if (bolt.points.length < 2) continue;
    const age = state.now - bolt.spawnAt;
    const alpha = Math.max(0, 1 - age / bolt.lifetime);
    if (alpha <= 0) continue;
    // Two passes over the same polyline: a wide soft glow, then a thin bright
    // core on top.
    for (const pass of [{ w: 7, a: alpha * 0.3 }, { w: 2.5, a: alpha }]) {
      g.moveTo(bolt.points[0].x, bolt.points[0].y);
      for (let i = 1; i < bolt.points.length; i++) {
        g.lineTo(bolt.points[i].x, bolt.points[i].y);
      }
      g.stroke({ width: pass.w, color: 0xffffff, alpha: pass.a });
    }
  }
}

function drawSelectionRing(g: Graphics, size: number) {
  const half = size / 2 + 4;
  g.clear();
  g.rect(-half, -half, half * 2, half * 2).stroke({ width: 2, color: 0xffd96b });
}

function drawBuildingBody(g: Graphics, b: Building, o: Options) {
  const def = defOf(b);
  const half = def.size / 2;
  g.clear();
  // Goblin Hole buildings render identically to the starting hole — black
  // circle, white outline — no purple-pad rectangle. Skip when the player
  // has disabled the fill layer (the sprite alone is enough).
  if (b.kind === 'goblin_hole') {
    if (o.buildingFillEnabled) drawHoleAt(g, 0, 0);
    return;
  }
  const c = def.colors;
  let fill = c.constructing, border = c.constructingBorder;
  if (b.state === 'active') { fill = c.active; border = c.activeBorder; }
  else if (b.state === 'dormant') { fill = c.dormant; border = c.dormantBorder; }
  const alpha = Math.max(0, Math.min(1, o.buildingFillAlpha));
  if (o.buildingFillEnabled && alpha > 0) {
    g.rect(-half, -half, def.size, def.size).fill({ color: fill, alpha });
  }
  if (o.buildingBorderEnabled) {
    g.rect(-half, -half, def.size, def.size).stroke({ width: 2, color: border });
  }
  // The colored fill carries the per-kind texture (server racks, smokestacks,
  // etc). Skip it when the fill layer is off so a custom sprite isn't muddied.
  if (!o.buildingFillEnabled) return;
  if (b.kind === 'phone_farm') {
    for (let i = -1; i <= 1; i++) {
      g.rect(-half + 14, -10 + i * 14, def.size - 28, 7).fill({ color: 0x000000, alpha: 0.25 * alpha });
    }
  } else if (b.kind === 'datacentre') {
    for (let row = -2; row <= 2; row++) {
      g.rect(-half + 16, row * 14 - 3, def.size - 32, 6).fill({ color: 0x000000, alpha: 0.28 * alpha });
    }
  } else if (b.kind === 'goblin_wheel') {
    g.circle(0, 0, def.size / 2 - 8).stroke({ width: 3, color: 0x000000, alpha: 0.35 * alpha });
    for (let a = 0; a < 4; a++) {
      const ang = (a / 4) * Math.PI;
      const r = def.size / 2 - 8;
      g.moveTo(-Math.cos(ang) * r, -Math.sin(ang) * r)
        .lineTo(Math.cos(ang) * r, Math.sin(ang) * r)
        .stroke({ width: 1, color: 0x000000, alpha: 0.3 * alpha });
    }
  } else if (b.kind === 'gas_engine') {
    const w = 10;
    for (let i = -1; i <= 1; i++) {
      g.rect(i * 24 - w / 2, -half + 6, w, def.size - 18)
        .fill({ color: 0x000000, alpha: 0.32 * alpha });
    }
  }
}

function makeSpaceBuildingView(sb: SpaceBuilding): SpaceBuildingView {
  const def = BUILDING_DEFS[sb.building.kind];
  const container = new Container();
  const o = getOptions();

  const glow = new Sprite(getGlowTexture());
  glow.anchor.set(0.5);
  glow.tint = 0x9fd0ff;
  glow.scale.set(def.size * 1.7 / 128);
  glow.alpha = 0.28;

  const selectionRing = new Graphics();
  drawSelectionRing(selectionRing, def.size);
  selectionRing.visible = false;

  const tex = buildingTextures[sb.building.kind] ?? Texture.EMPTY;
  const sprite = new Sprite(tex);
  sprite.anchor.set(0.5);
  sizeBuildingSprite(sprite, def.size);

  const gs = o.globalFontScale;
  const label = new Text({
    text: def.short,
    style: {
      fontFamily: fontFamilyById(o.fonts.buildingLabel.family).css,
      fontSize: buildingLabelSize(def.cellSize, o.fonts.buildingLabel.scale * gs),
      fill: 0xffffff,
      fontWeight: 'bold',
    },
  });
  label.anchor.set(0.5);

  container.addChild(glow);
  container.addChild(selectionRing);
  container.addChild(sprite);
  container.addChild(label);
  return { container, glow, sprite, label, selectionRing };
}

// ─── Space scene + climb transition ─────────────────────────────────
// Gradient sampled from low to high altitude. The bottom stops are nearly as
// dark as the play area (oobColor ≈ #040404) so the sky bloom doesn't slam
// against the dark ground with a bright daytime horizon. Mid-altitude stops
// give a daylight blue band, then the gradient sinks into deep space again.
const SKY_STOPS: [number, number][] = [
  [0.00, 0x06080f], [0.18, 0x122142], [0.36, 0x254a82], [0.52, 0x3f7fd8],
  [0.68, 0x1c3f86], [0.84, 0x0a1640], [1.00, 0x03040f], [1.30, 0x010109],
];
function lerpHex(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bl;
}
function skyColorAt(h: number): number {
  if (h <= SKY_STOPS[0][0]) return SKY_STOPS[0][1];
  for (let i = 1; i < SKY_STOPS.length; i++) {
    if (h <= SKY_STOPS[i][0]) {
      const [h0, c0] = SKY_STOPS[i - 1];
      const [h1, c1] = SKY_STOPS[i];
      return lerpHex(c0, c1, (h - h0) / (h1 - h0));
    }
  }
  return SKY_STOPS[SKY_STOPS.length - 1][1];
}
function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// Clamp the space camera to the SPACE bounds (mirrors clampCamera for ground).
export function clampSpaceCamera(ctx: RenderContext) {
  const maxX = Math.max(0, SPACE.width - ctx.viewport.width / RENDER_SCALE);
  const maxY = Math.max(0, SPACE.height - ctx.viewport.height / RENDER_SCALE);
  ctx.spaceCamera.x = Math.max(0, Math.min(maxX, ctx.spaceCamera.x));
  ctx.spaceCamera.y = Math.max(0, Math.min(maxY, ctx.spaceCamera.y));
}
export function centerSpaceCamera(ctx: RenderContext) {
  ctx.spaceCamera.x = SPACE.width / 2 - ctx.viewport.width / (2 * RENDER_SCALE);
  ctx.spaceCamera.y = SPACE.height / 2 - ctx.viewport.height / (2 * RENDER_SCALE);
  clampSpaceCamera(ctx);
}
// True extent the space camera can pan (so main can detect "at the bottom").
export function spaceCameraMaxY(ctx: RenderContext): number {
  return Math.max(0, SPACE.height - ctx.viewport.height / RENDER_SCALE);
}

function drawTransition(ctx: RenderContext, a: number, now: number) {
  const W = ctx.viewport.width;
  const H = ctx.viewport.height;
  const span = 0.55;                 // altitude covered by one screen height
  const hBottom = a * 1.15 - 0.05;   // altitude at the bottom edge
  const hTop = hBottom + span;       // altitude at the top edge

  // Gradient bands, top→bottom.
  const g = ctx.skyGfx;
  g.clear();
  const N = 18;
  for (let i = 0; i < N; i++) {
    const frac = i / N;
    const h = hTop + (hBottom - hTop) * frac;
    g.rect(0, Math.floor(frac * H), W, Math.ceil(H / N) + 1).fill(skyColorAt(h));
  }

  // Stars fade in over the back half of the climb, twinkling gently.
  const sg = ctx.starGfx;
  sg.clear();
  const starA = smoothstep(0.45, 0.95, a);
  if (starA > 0.01) {
    for (const s of ctx.transStars) {
      const tw = 0.55 + 0.45 * Math.sin(now * 2.5 + s.phase);
      sg.circle(s.fx * W, s.fy * H, s.r).fill({ color: 0xffffff, alpha: starA * tw });
    }
  }

  // Clouds drift past as we climb through their altitude band.
  const cg = ctx.cloudGfx;
  cg.clear();
  for (const c of ctx.transClouds) {
    const y = H * (hTop - c.h) / (hTop - hBottom);
    if (y < -c.scale || y > H + c.scale) continue;
    // Clouds bloom in as we approach their altitude band, then fade out once
    // we've climbed well above them. Without the fade-in, every cloud pops
    // into existence the moment the sky overlay does — too sudden against
    // the dark play area.
    const fadeIn = smoothstep(c.h - 0.20, c.h - 0.02, a);
    const fadeOut = 1 - smoothstep(c.h + 0.05, c.h + 0.22, a);
    const fade = fadeIn * fadeOut;
    if (fade <= 0.01) continue;
    const cx = c.fx * W;
    for (const [px, py, pr] of c.puffs) {
      cg.circle(cx + px * c.scale, y + py * c.scale, pr * c.scale * 0.6)
        .fill({ color: 0xf2f6ff, alpha: 0.5 * fade });
    }
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
  // As the climb begins, slide the whole ground scene downward (and back up on
  // descent) so the play area visibly drops away beneath you rather than just
  // fading in place under the sky. Synced to the ground's fade-out range.
  const climbDrop = smoothstep(0.02, 0.18, ctx.altitude) * ctx.viewport.height * 0.6;
  ctx.worldLayer.position.set(
    Math.round(offsetX - ctx.camera.x * RENDER_SCALE),
    Math.round(offsetY - ctx.camera.y * RENDER_SCALE + climbDrop),
  );

  const opts = getOptions();
  const displayPx = opts.goblinDisplayPx;

  // Walls expand when a Dig is purchased; redraw lazily on version drift.
  ctx.state = state;
  if (state.wallsVersion !== ctx.wallsVersion) {
    ctx.walls = state.walls;
    redrawBackground(ctx, opts);
    redrawWalls(ctx, opts);
    ctx.wallsVersion = state.wallsVersion;
  }

  // Goblin Hole — re-drawn each frame (cheap and keeps the position cell-exact
  // even if anything moves it later).
  drawHole(ctx, state);

  // Floaters: rising fading text. Sim adds & expires; renderer just animates.
  drawFloaters(ctx, state);

  // Death effects: spawn a one-shot GifSprite per new entry; the sim expires
  // entries after a couple seconds and we tear the sprite down with them.
  drawDeathEffects(ctx, state);

  // Lightning bolts: redrawn each frame from the live (fading) bolt list.
  drawLightning(ctx, state);

  // Goblins
  const seenG = new Set<number>();
  for (const g of state.goblins.values()) {
    seenG.add(g.id);
    let v = ctx.goblinViews.get(g.id);
    if (!v) {
      v = makeGoblinView(g);
      // Per-child cullable flag is needed alongside the parent layer's
      // cullableChildren; without it Pixi v8 won't run the bounds check
      // and the goblin renders even when off-camera.
      v.container.cullable = true;
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
    // Per-frame sprite-Y offset so the player can tune sprite-to-cell
    // alignment from the options panel. Outline copies preserve their
    // cardinal offsets relative to the sprite.
    v.sprite.y = opts.goblinSpriteYOffset;
    for (let i = 0; i < v.outline.length; i++) {
      v.outline[i].y = OUTLINE_OFFSETS[i][1] + opts.goblinSpriteYOffset;
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
    // Water carriers tint blue only while actually hauling water back to the
    // DC (phase to_dc). On the outbound walk to the source they look normal.
    if (g.state.kind === 'fetching_water' && g.state.phase === 'to_dc') tint = opts.waterGoblinColor;
    else if (g.gold) tint = 0xffa800;
    else if (g.state.kind === 'building' || g.state.kind === 'going_to_build') tint = 0xfff0a8;
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
  const minotaurDisplayPx = opts.minotaurDisplayPx;
  const seenT = new Set<number>();
  for (const t of state.minotaurs.values()) {
    seenT.add(t.id);
    let v = ctx.minotaurViews.get(t.id);
    if (!v) {
      v = makeMinotaurView();
      v.container.cullable = true;
      ctx.minotaurLayer.addChild(v.container);
      ctx.minotaurViews.set(t.id, v);
    }
    // Tinytaurs render at a fraction of a full Minotaur's size.
    const dispPx = t.tiny ? minotaurDisplayPx * TINYTAUR.scale : minotaurDisplayPx;
    v.container.position.set(t.pos.x, t.pos.y);
    v.selectionRing.visible = t.selected;
    v.shadow.visible = opts.goblinShadow;
    if (opts.goblinShadow) {
      v.shadow.position.set(0, dispPx * 0.32);
      const sy = dispPx / 64;
      v.shadow.scale.set(sy * 0.75, sy);
    }
    v.sprite.y = t.tiny ? 0 : opts.minotaurSpriteYOffset;
    const winding =
      (t.state.kind === 'going_to_kill' || t.state.kind === 'going_to_kill_minotaur' || t.state.kind === 'going_to_destroy')
      && t.state.attackAt !== undefined;
    const sheet = (winding ? minotaurSwipeSheet : null) ?? minotaurWalkSheet;
    if (sheet) {
      const dir = dirIndex(sheet.meta, t.facing);
      const fpd = sheet.meta.framesPerDirection;
      const frame = Math.floor(state.now * sheet.fps) % fpd;
      v.sprite.texture = sheet.frames[dir][frame];
      v.sprite.scale.set(dispPx / sheet.meta.spriteSize);
    }
  }
  for (const [id, v] of ctx.minotaurViews) {
    if (!seenT.has(id)) {
      v.container.destroy({ children: true });
      ctx.minotaurViews.delete(id);
    }
  }

  // Dragons — placeholder tiles that bob, glow, and brighten while breathing
  // fire on a commanded kill. While carrying, the lifted building rides beneath.
  const seenD = new Set<number>();
  for (const d of state.dragons.values()) {
    seenD.add(d.id);
    let v = ctx.dragonViews.get(d.id);
    if (!v) {
      v = makeDragonView();
      v.container.cullable = true;
      ctx.dragonLayer.addChild(v.container);
      ctx.dragonViews.set(d.id, v);
    }
    v.container.position.set(d.pos.x, d.pos.y);
    const phase = state.now - d.spawnAt;
    const breathing = d.state.kind === 'going_to_kill' && d.state.attackAt !== undefined;
    const bob = Math.sin(phase * 2.2) * 3;
    v.block.y = bob;
    v.label.y = bob;
    v.block.tint = breathing ? 0xff5a2a : 0xffffff;
    v.glow.alpha = breathing ? 0.85 : 0.35 + 0.12 * Math.sin(state.now * 3);
    v.selectionRing.visible = d.selected;
    if (d.carrying) {
      const def = defOf(d.carrying);
      const tex = buildingTextures[d.carrying.kind];
      if (tex && v.carried.texture !== tex) { v.carried.texture = tex; sizeBuildingSprite(v.carried, def.size * 0.8); }
      v.carried.visible = opts.buildingSpriteEnabled;
      v.carried.position.set(0, DRAGON.displayPx * 0.38);
    } else if (v.carried.visible) {
      v.carried.visible = false;
    }
  }
  for (const [id, v] of ctx.dragonViews) {
    if (!seenD.has(id)) {
      v.container.destroy({ children: true });
      ctx.dragonViews.delete(id);
    }
  }

  // Water sources — region rectangles with a few ripple highlights for life.
  const seenW = new Set<number>();
  for (const w of state.waterSources.values()) {
    seenW.add(w.id);
    let v = ctx.waterViews.get(w.id);
    if (!v) {
      v = makeWaterView(w);
      ctx.waterLayer.addChild(v.container);
      ctx.waterViews.set(w.id, v);
    }
    v.selectionRing.visible = w.selected;
    // Region is fixed once spawned, so the view only needs to be positioned
    // once at create time.
  }
  for (const [id, v] of ctx.waterViews) {
    if (!seenW.has(id)) {
      v.container.destroy({ children: true });
      ctx.waterViews.delete(id);
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
    // Redraw the colored body when state changes OR when any of the body-affecting
    // option toggles flip. bodyKey collapses both into a single string compare.
    const key = bodyKey(b, opts);
    if (v.lastBodyKey !== key) {
      drawBuildingBody(v.body, b, opts);
      v.lastState = b.state;
      v.lastBodyKey = key;
    }
    if (v.lastSize !== def.size) {
      drawSelectionRing(v.selectionRing, def.size);
      v.warning.position.set(0, -def.size / 2 + 4);
      sizeBuildingSprite(v.sprite, def.size);
      v.lastSize = def.size;
    }
    v.sprite.visible = opts.buildingSpriteEnabled;
    v.label.visible = opts.buildingLabelEnabled;
    // Greyscale the sprite until the building is fully running. Reassigning
    // .filters every frame would force a filter-pass rebuild; gate on the
    // cached flag so it only flips when running-state actually changes.
    const wantGrey = b.state !== 'active';
    if (wantGrey !== v.greyscaled) {
      v.sprite.filters = wantGrey ? [getBuildingGreyscaleFilter()] : [];
      v.greyscaled = wantGrey;
    }

    // progress bar — yellow construction fill while building, blue water
    // meter once finished (only on buildings that drink).
    v.progress.clear();
    const drinks = (def.waterDeliveryAmount ?? 0) > 0;
    if (b.state === 'constructing') {
      const w = def.size - 10;
      const h = 5;
      const y = (v.warning.visible ? -def.size / 2 + 18 : -def.size / 2 + 5);
      v.progress.rect(-w / 2, y, w, h).fill({ color: 0x000000, alpha: 0.6 }).stroke({ width: 1, color: 0x000000 });
      v.progress.rect(-w / 2, y, w * b.buildProgress, h).fill(0xffd96b);
    } else if (drinks) {
      const w = def.size - 10;
      const h = 5;
      const y = (v.warning.visible ? -def.size / 2 + 18 : -def.size / 2 + 5);
      const meter = (b.waterMeter ?? 0) / 100;
      v.progress.rect(-w / 2, y, w, h).fill({ color: 0x000000, alpha: 0.6 }).stroke({ width: 1, color: 0x000000 });
      v.progress.rect(-w / 2, y, w * meter, h).fill(0x4a8acf);
    }

    // floating warning — show unmet needs in priority order.
    // Priority: maintainers → power → water. Maintainers and power can
    // both show at once; water is only listed when staffing + power are
    // already good (otherwise watering wouldn't help).
    let warningText = '';
    if (b.state === 'dormant') {
      const reasons: string[] = [];
      const have = maintainerCount(state, b);
      const need = def.maintainersRequired - have;
      const draw = def.powerOutput < 0 ? -def.powerOutput : 0;
      const free = state.lastPowerProduced - state.lastPowerConsumed;
      const underpowered = draw > 0 && free < draw;
      if (need > 0) reasons.push(`needs ${need} goblin${need === 1 ? '' : 's'}`);
      if (underpowered) reasons.push('underpowered');
      if (need <= 0 && !underpowered && drinks && (b.waterMeter ?? 0) <= 0) {
        reasons.push('needs water');
      }
      warningText = reasons.join('\n');
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

  // ─── Space scene ───
  // Position spaceLayer exactly like the world layer, but panned by spaceCamera
  // across the SPACE bounds.
  {
    const scaledW = SPACE.width * RENDER_SCALE;
    const scaledH = SPACE.height * RENDER_SCALE;
    const offX = Math.max(0, (ctx.viewport.width - scaledW) / 2);
    const offY = Math.max(0, (ctx.viewport.height - scaledH) / 2);
    // Mirror the ground's climb-slide: as the ground drops away beneath you on
    // ascent, the whole space scene (stars, buildings, ambient dragons) drops
    // into place from above rather than just fading in. Settles to 0 once you're
    // fully in orbit; lifts back up off the top on descent.
    const spaceSlide = -(1 - smoothstep(0.84, 1.0, ctx.altitude)) * ctx.viewport.height * 0.6;
    ctx.spaceLayer.position.set(
      Math.round(offX - ctx.spaceCamera.x * RENDER_SCALE),
      Math.round(offY - ctx.spaceCamera.y * RENDER_SCALE + spaceSlide),
    );
  }
  updateAmbientDragons(ctx);
  const seenSB = new Set<number>();
  for (const sb of state.spaceBuildings.values()) {
    seenSB.add(sb.id);
    let v = ctx.spaceBuildingViews.get(sb.id);
    if (!v) {
      v = makeSpaceBuildingView(sb);
      ctx.spaceLayer.addChild(v.container);
      ctx.spaceBuildingViews.set(sb.id, v);
    }
    v.container.position.set(sb.pos.x, sb.pos.y);
    v.sprite.rotation = sb.spin;
    v.label.rotation = sb.spin;
    v.selectionRing.rotation = sb.spin;
    v.selectionRing.visible = sb.selected;
    v.sprite.visible = opts.buildingSpriteEnabled;
    v.label.visible = opts.buildingLabelEnabled;
  }
  for (const [id, v] of ctx.spaceBuildingViews) {
    if (!seenSB.has(id)) {
      v.container.destroy({ children: true });
      ctx.spaceBuildingViews.delete(id);
    }
  }

  // Scene cross-fades driven by altitude (0 ground … 1 space). Rather than
  // snapping each scene on/off, fade them so nothing pops:
  //  • the ground recedes as the climb begins,
  //  • the sky overlay blooms in over it, then dissolves near the top,
  //  • the space diorama fades up underneath the dissolving sky.
  // z-order is world < space < sky, so the late sky fade reveals space cleanly.
  const a = ctx.altitude;
  // Ground and sky overlap through the lower-altitude band so the dark play
  // area cross-fades into the (now also dark) low-sky gradient instead of the
  // sky punching in over a still-dark ground.
  const groundFade = 1 - smoothstep(0.05, 0.32, a);
  const spaceFade = smoothstep(0.84, 1.0, a);
  const skyFade = Math.min(smoothstep(0.0, 0.32, a), 1 - smoothstep(0.84, 1.0, a));

  ctx.worldLayer.visible = groundFade > 0.001;
  ctx.worldLayer.alpha = groundFade;
  ctx.spaceLayer.visible = spaceFade > 0.001;
  ctx.spaceLayer.alpha = spaceFade;
  ctx.skyLayer.visible = skyFade > 0.001;
  ctx.skyLayer.alpha = skyFade;
  if (ctx.skyLayer.visible) drawTransition(ctx, a, state.now);
}
