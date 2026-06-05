import { Application, Assets, ColorMatrixFilter, Container, extensions, Graphics, Rectangle, Sprite, Text, Texture } from 'pixi.js';
import { GifAsset, GifSource } from 'pixi.js/gif';

// Side-effect registration: `pixi.js/gif` does NOT auto-register the .gif
// asset loader on import. Without this, `Assets.load(*.gif)` rejects.
extensions.add(GifAsset);

// Decoded GIF: frame textures + the cumulative time-of-end of each frame, in
// game seconds. Used as a manual sprite-sheet — we pick the frame ourselves
// each tick based on (state.now - spawnAt) so playback always starts at frame 0.
type DeathFrames = { textures: Texture[]; ends: number[]; duration: number };
import { AMBIENT_DRAGON, BUILDING_DEFS, BuildingKind, CELL, COLS, DEMON, DRAGON, GOBLIN, HELL, RENDER_SCALE, ROBOT, ROWS, MINOTAUR, SOUL_SIGIL, SPACE, SPACE_UNIT, TINYTAUR, WORLD, formatPower, sigilPortalOutput } from './config';
import { ensureFontLoaded, fontFamilyById, getOptions, onOptionsChange, type FontConfig, type Options } from './options';
import { Building, Demon, Dragon, GameState, Ghost, Goblin, HOLE_SIZE, Minotaur, SoulChair, SpaceBuilding, SpaceUnit, WaterSource, buildingCenter, candleSpotAt, cellCenter, defOf, demonScaleOf, holeCenter, isInPlayCell, maintainerCount } from './state';
import { getParlaySpeaker } from './demon-dialogue';

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
const DRAGON_FLY_BASE = 'assets/dragon_fly_new';

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
let dragonFlySheet: Sheet | null = null;

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
    minotaurWalkSheet, minotaurSwipeSheet, dragonFlySheet,
  ] = await Promise.all([
    loadSheet(GOBLIN_WALK_BASE),
    loadSheet(GOBLIN_IDLE_BASE),
    loadSheet(GOBLIN_BREAKDANCE_BASE),
    loadSheet(GOBLIN_SWIPE_BASE),
    loadSheet(MINOTAUR_WALK_BASE),
    loadSheet(MINOTAUR_SWIPE_BASE),
    loadSheet(DRAGON_FLY_BASE),
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

// Infernal wash + drifting fog rings for the hell scene. Re-rendered whenever
// any hell visual option changes; tunables come straight from the admin cog.
// The fixed sprinkle positions are seeded so re-draws stay stable rather than
// reshuffling on every slider tweak.
function drawHellBackground(g: Graphics, o: Options): void {
  g.clear();
  // Base wash: simple vertical gradient between two configurable colours.
  const stripes = 48;
  const topR = (o.hellBgTop >> 16) & 0xff;
  const topG = (o.hellBgTop >> 8) & 0xff;
  const topB = o.hellBgTop & 0xff;
  const botR = (o.hellBgBottom >> 16) & 0xff;
  const botG = (o.hellBgBottom >> 8) & 0xff;
  const botB = o.hellBgBottom & 0xff;
  for (let i = 0; i < stripes; i++) {
    const t = i / stripes;
    const r = Math.round(topR + (botR - topR) * t);
    const gr = Math.round(topG + (botG - topG) * t);
    const b = Math.round(topB + (botB - topB) * t);
    const col = (r << 16) | (gr << 8) | b;
    g.rect(0, Math.floor(t * HELL.height), HELL.width, Math.ceil(HELL.height / stripes) + 1).fill(col);
  }
  // Soft fog blooms — fewer than the bright pass; alpha scales with the
  // glow-intensity slider so the player can push the underworld brighter
  // if they want without re-coding.
  const mist: [number, number, number][] = [
    [HELL.width * 0.18, HELL.height * 0.22, 520],
    [HELL.width * 0.74, HELL.height * 0.32, 600],
    [HELL.width * 0.52, HELL.height * 0.58, 720],
    [HELL.width * 0.28, HELL.height * 0.78, 540],
    [HELL.width * 0.82, HELL.height * 0.86, 560],
  ];
  const baseGlow = 0.05 * o.hellGlowIntensity;
  for (const [nx, ny, nr] of mist) {
    for (let i = 5; i >= 1; i--) {
      g.circle(nx, ny, nr * (i / 5)).fill({ color: o.hellGlowColor, alpha: baseGlow });
    }
  }
  // Ember specks — count + brightness driven by the sliders. RNG is per-call
  // so the field reshuffles whenever the player tweaks these, which is fine
  // (rebuilds run after settings changes; no per-frame redraw).
  const count = Math.max(0, Math.round(o.hellEmberCount));
  const sizeMul = Math.max(0.01, o.hellEmberSize);
  for (let i = 0; i < count; i++) {
    const x = Math.random() * HELL.width;
    const y = Math.random() * HELL.height;
    const r = (0.5 + Math.random() * 1.4) * sizeMul;
    const tint = Math.random();
    const col = tint < 0.6 ? 0xff8830 : tint < 0.9 ? 0xff5020 : 0xffe0a0;
    const a = (0.35 + Math.random() * 0.45) * o.hellEmberBrightness;
    g.circle(x, y, r).fill({ color: col, alpha: a });
  }
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

// A demon in the hell scene — currently the giant patrolling Minotaur. Lives in
// hellDemonLayer, positioned at the demon's absolute hell coordinates.
type DemonView = {
  container: Container;
  shadow: Sprite;
  sprite: Sprite;
  selectionRing: Graphics;
};

type DragonView = {
  container: Container;   // positioned at the dragon's world pos
  glow: Sprite;           // soft radial behind the sprite
  sprite: Sprite;         // animated frame from the fly sheet
  carried: Sprite;        // the building currently being hauled (hidden otherwise)
  selectionRing: Graphics;
  // Heading (atan2 radians) derived from frame-to-frame movement; the sim only
  // tracks a ±1 mirror for dragons, so the renderer infers the 8-way row here.
  heading: number;
  lastX: number;
  lastY: number;
};

type SpaceBuildingView = {
  container: Container;   // positioned at the space pos, in spaceLayer
  glow: Sprite;
  sprite: Sprite;
  // Drawn fallback art — the Orbital Platform ships no PNG, so its deck is a
  // Graphics. Undefined for every hauled-up building (they have sprites).
  body?: Graphics;
  // Construction bar + "needs robot" tag — only ever populated for an
  // Orbital Platform mid-assembly.
  progress: Graphics;
  warning: Text;
  label: Text;
  selectionRing: Graphics;
};

// A unit adrift in the space scene — a snatched goblin/minotaur on its vacuum
// clock, or a robot (which survives, and builds).
type SpaceUnitView = {
  container: Container;
  sprite: Sprite;
  selectionRing: Graphics;
};

// A static silhouette of a killed unit, rendered at the world-x/y where it
// died. Lives in hellLayer. Made once on first sight; tinted dim red.
type GhostView = {
  container: Container;
  sprite: Sprite;
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
  sprite: Sprite;        // animated frame from the fly sheet
  selectionRing: Graphics;
  // Live space-x/y from the last frame (after movement + bob). Cached so a
  // pointer hit-test doesn't have to re-derive it from x0/dir/speed.
  cx: number;
  cy: number;
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
  // Visual zoom applied to the world/space/hell layers. RENDER_SCALE on a
  // desktop-sized viewport; smaller on phone-sized ones so more of the world
  // fits on screen. Recomputed in syncViewport on resize/orientation change.
  renderScale: number;
  // ─── Space scene + climb transition ───
  // Floating-building diorama. Scaled + camera-panned like worldLayer.
  spaceLayer: Container;
  spaceBg: Graphics;                 // starfield + nebula, drawn once
  spaceBuildingViews: Map<number, SpaceBuildingView>;
  spaceUnitViews: Map<number, SpaceUnitView>;
  spaceCamera: Camera;
  // Decorative dragons drifting across the void, behind the floating buildings.
  // Renderer-owned and ephemeral — spawned while in space, cleared when not.
  spaceAmbientLayer: Container;
  ambientDragons: AmbientDragon[];
  nextAmbientSpawnAt: number;
  ambientIdSeq: number;
  // Full-screen overlay for the climb between ground and space.
  // blackOverlay fades in first to cover the ground; sky paints over it; space
  // fades in last underneath the dissolving sky.
  blackOverlay: Graphics;
  skyLayer: Container;
  skyGfx: Graphics;
  cloudGfx: Graphics;
  starGfx: Graphics;
  transStars: TransStar[];
  transClouds: TransCloud[];
  // 0 = on the ground, 1 = in space. Animated by main.ts; the renderer reads it
  // to cross-fade the scenes and drive the overlay.
  altitude: number;
  // ─── Hell scene + descent transition ───
  // Mirror of the space scene, but downward. Has its own layer, camera, and
  // background. Ghosts of every killed unit are scattered across hellLayer.
  hellLayer: Container;
  hellBg: Graphics;
  // Giant demons pacing the abyss. Sits below the ghost layer so a soul walking
  // up to a demon renders in front of it.
  demonLayer: Container;
  demonViews: Map<number, DemonView>;
  hellGhostLayer: Container;
  ghostViews: Map<number, GhostView>;
  hellCamera: Camera;
  // 0 = on the ground, 1 = fully in hell. Drives the cross-fade and a darker
  // overlay between the two.
  depth: number;
  // 0 = camera at the normal RENDER_SCALE, 1 = eased out to HELL.zoomedOutScale.
  // Animated by main.ts after the descent transition completes.
  hellZoom: number;
  // The portal-to-abyss beam: a red line drawn from each hell_portal's
  // bottom-center straight down toward the world's edge. Animates in over
  // HELL.lineDrawMs ms after a portal finishes constructing.
  hellBeamGfx: Graphics;
  // The matching beam on the hell side — drawn upward from each mirror
  // portal's top toward the top of HELL bounds, so the two shafts read as a
  // single pillar connecting the worlds.
  hellSideBeamGfx: Graphics;
  // Mirror buildings rendered in hellLayer at the world-coord of every
  // overworld hell_portal. Built/destroyed in lockstep with their counterpart.
  hellPortalMirrorLayer: Container;
  hellPortalMirrors: Map<number, Container>;
  // The soul sigil: a central inner ring + outer candle ring + the pentagram
  // edges that spring between placed candles. Two Graphics (lines/rings +
  // candle discs) are redrawn each frame for the flicker/seat/completion VFX;
  // the candle labels ("needs 4 candles" / "needs soul") are Text objects made
  // once and retargeted by ring state.
  soulSigilLayer: Container;
  soulSigilGfx: Graphics;
  soulChairGfx: Graphics;
  soulChairLabels: Map<number, Text>;
  // Live wattage readout on each portal's mirror ("1 W" → ×87 per seated
  // soul), keyed by portalId.
  sigilPowerLabels: Map<number, Text>;
  // Cursor position in hell coords while candle placement is armed — drives
  // the snapped candle ghost on the outer ring. Updated by input.ts.
  candleCursor: { x: number; y: number } | null;
  // Cursor position in SPACE coords while Orbital Platform placement is
  // armed — drives the platform ghost under the cursor. Updated by input.ts.
  orbitalCursor: { x: number; y: number } | null;
  // The platform placement ghost itself (re-drawn each frame; kept on top of
  // the floating buildings while placement is armed).
  orbitalGhostGfx: Graphics;
  // Bob's yellow nametag(s) — one Text per place Bob currently exists
  // (overworld goblin, dragon claws, adrift in space, his soul in hell),
  // keyed by a per-host string. Each lives in its scene's dedicated top
  // nametag layer so the label is never covered by other units/buildings.
  bobTags: Map<string, Text>;
  worldTagLayer: Container;
  spaceTagLayer: Container;
  hellTagLayer: Container;
  // "too close" / "ring full" tag over a blocked candle-placement preview.
  // Created lazily, hidden whenever the preview isn't showing a blocked spot.
  candlePreviewLabel: Text | null;
  // Death-effect splatters that ride in the hell scene (the "born in blood"
  // appearance of a ghost). Drawn from the same DeathEffect entries flagged
  // hell:true; the renderer maps their world coords into hell coords.
  hellEffectsLayer: Container;
  // Floating-text overlay for the hell scene (the "x87" surge above a mirror
  // when a soul is seated). Mirrors floatersLayer but rides the hell
  // transform so the text tracks its hell coordinates.
  hellFloatersLayer: Container;
  // Goblin Hole: a fixed pit-graphic plus its selection ring. Drawn between
  // the grid and buildings so a building placed on top covers it.
  holeGfx: Graphics;
  holeRing: Graphics;
  // Pulsing yellow rings drawn over every Goblin Hole while the Bob picker
  // is active (state.bobPickingHole). Cleared the rest of the time.
  bobPickerGfx: Graphics;
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
  // The force-white matrix for whiteEffectsLayer. Only attached while the
  // layer has children (see render) — an attached filter costs a
  // render-to-texture pass every frame even on an empty layer.
  whiteFilter: ColorMatrixFilter;
  lightningGfx: Graphics;
  // Mutable references — used by applyOptions() to redraw on the fly.
  walls: Set<string>;
  wallsVersion: number;     // last drawn version; render compares vs state.wallsVersion
  state: GameState;         // most-recent state ref, kept updated each render
  playBg: Graphics;
  wallGfx: Graphics;
  grid: Graphics;
  goblinFilter: ColorMatrixFilter;
  demonFilter: ColorMatrixFilter;
  minotaurFilter: ColorMatrixFilter;
  dragonFilter: ColorMatrixFilter;
  buildingFilter: ColorMatrixFilter;
  hellGhostFilter: ColorMatrixFilter;
};

// Kick off the heavyweight texture loads (sprite sheets, building art, the
// blood gif) without waiting for createRender. main() calls this as soon as
// it starts, so on production the downloads+decodes overlap the title screen
// instead of stacking up inside the post-click freeze. Memoized; createRender
// awaits the same promise. The gif preload just warms the Assets cache — the
// real decode-to-frames happens in createRender as before.
let renderAssetsPromise: Promise<void> | null = null;
export function preloadRenderAssets(): Promise<void> {
  renderAssetsPromise ??= Promise.all([
    loadGoblinSheets(),
    loadBuildingTextures(),
    Assets.load<GifSource>('assets/blood-explosion.gif').catch(() => undefined),
  ]).then(() => undefined);
  return renderAssetsPromise;
}

export async function createRender(parent: HTMLElement, state: GameState): Promise<RenderContext> {
  const walls = state.walls;
  await preloadRenderAssets();
  const initW = parent.clientWidth || window.innerWidth || WORLD.width;
  const initH = parent.clientHeight || window.innerHeight || WORLD.height;
  const initScale = computeRenderScale(initW, initH);
  const app = new Application();
  // Touch devices (phones/tablets) get a cheaper render target: cap the
  // backing-store resolution at 2x and skip MSAA. Modern iPhones report a
  // devicePixelRatio of 3, which makes a fullscreen antialiased framebuffer
  // ~2.3x the pixel work of a 2x one for no perceptible visual gain at
  // phone sizes — and was a major contributor to single-digit FPS in
  // mobile Safari. Desktop keeps full DPR + antialiasing.
  const coarsePointer = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  const dpr = window.devicePixelRatio || 1;
  await app.init({
    background: '#000000',
    width: initW,
    height: initH,
    antialias: !coarsePointer,
    resolution: coarsePointer ? Math.min(dpr, 2) : dpr,
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
  const bobPickerGfx = new Graphics();

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
  // NOT attached here — a filter forces a render-to-texture pass for the
  // layer every frame even while it's empty (the common case: scorches only
  // exist for a couple of seconds after a lightning strike). render() attaches
  // it only while the layer actually has children.
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
  worldLayer.addChild(bobPickerGfx);
  worldLayer.addChild(effectsLayer);
  worldLayer.addChild(whiteEffectsLayer);
  worldLayer.addChild(floatersLayer);
  worldLayer.addChild(lightningGfx);
  // Bob's nametag rides above every world entity (only the UI overlays sit
  // higher) so it can't be covered by minotaurs, dragons, or effects.
  const worldTagLayer = new Container();
  worldLayer.addChild(worldTagLayer);
  worldLayer.addChild(uiLayer);
  worldLayer.scale.set(initScale);
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
  // Space-side Bob nametag layer + the Orbital Platform placement ghost.
  // Building/unit views are appended to spaceLayer as they're created, so the
  // render loop re-appends these whenever they're in use to keep them on top.
  const spaceTagLayer = new Container();
  spaceLayer.addChild(spaceTagLayer);
  const orbitalGhostGfx = new Graphics();
  spaceLayer.addChild(orbitalGhostGfx);
  spaceLayer.scale.set(initScale);
  spaceLayer.visible = false;
  app.stage.addChild(spaceLayer);

  // The red beam(s) from any hell_portal building down to the abyss. Drawn
  // each frame in world space (top of worldLayer) so it pans with the camera
  // and is visible from the ground; alpha is gated on the portal's draw-in
  // animation.
  const hellBeamGfx = new Graphics();
  worldLayer.addChildAt(hellBeamGfx, worldLayer.getChildIndex(uiLayer));

  // ─── Hell scene ───
  // Mirror of the space scene but downward and bigger. Has its own layer,
  // camera, and background. Hell starts hidden; visibility/scale are driven
  // by ctx.depth and ctx.hellZoom each frame.
  const hellLayer = new Container();
  const hellBg = new Graphics();
  drawHellBackground(hellBg, getOptions());
  const demonLayer = new Container();
  demonLayer.cullableChildren = true;
  const hellGhostLayer = new Container();
  hellGhostLayer.cullableChildren = true;
  const hellPortalMirrorLayer = new Container();
  const soulSigilLayer = new Container();
  const soulSigilGfx = new Graphics();
  const soulChairGfx = new Graphics();
  soulSigilLayer.addChild(soulSigilGfx);  // ring + pentagram edges behind…
  soulSigilLayer.addChild(soulChairGfx);  // …the chair discs
  const hellEffectsLayer = new Container();
  hellEffectsLayer.cullableChildren = true;
  const hellFloatersLayer = new Container();
  hellFloatersLayer.cullableChildren = true;
  const hellSideBeamGfx = new Graphics();
  // z-order (back → front): background, then the portal-mirror beacons (their
  // halo rings sit under everyone), then the drifting ghosts/units, then the
  // colossal demon on top so souls pass beneath it, then blood effects, and
  // finally the upward portal beams.
  hellLayer.addChild(hellBg);
  hellLayer.addChild(hellPortalMirrorLayer);
  hellLayer.addChild(soulSigilLayer);
  hellLayer.addChild(hellGhostLayer);
  hellLayer.addChild(demonLayer);
  hellLayer.addChild(hellEffectsLayer);
  hellLayer.addChild(hellSideBeamGfx);
  hellLayer.addChild(hellFloatersLayer);
  // Bob's hell nametag rides above everything in the underworld — demons
  // included — so his soul stays findable behind the colossi.
  const hellTagLayer = new Container();
  hellLayer.addChild(hellTagLayer);
  hellLayer.scale.set(initScale);
  hellLayer.visible = false;
  // Hell sits between the ground and the sky/space stack so the descent's
  // black overlay can cover it during the transition. The space scene
  // remains topmost in z-order so an ascend transition from hell would still
  // read correctly.
  app.stage.addChildAt(hellLayer, app.stage.getChildIndex(spaceLayer));

  // ─── Climb transition overlays (screen-space) ───
  // Phase 1: blackOverlay fades in over the ground so the play area visibly
  // dims toward black before any bright sky appears. Sits between worldLayer
  // and the space/sky stack in z-order.
  const blackOverlay = new Graphics();
  blackOverlay.visible = false;
  app.stage.addChildAt(blackOverlay, app.stage.getChildIndex(spaceLayer));

  // Phase 2/3: sky gradient with drifting clouds, then star fade.
  const skyLayer = new Container();
  const skyGfx = new Graphics();
  const cloudGfx = new Graphics();
  const starGfx = new Graphics();
  skyLayer.addChild(skyGfx);
  skyLayer.addChild(cloudGfx);   // clouds beneath stars
  skyLayer.addChild(starGfx);
  skyLayer.visible = false;
  app.stage.addChild(skyLayer);

  // Precompute the overlay's stars and cloud bands once.
  const transStars: TransStar[] = [];
  for (let i = 0; i < 260; i++) {
    transStars.push({
      fx: Math.random(),
      fy: Math.random(),
      r: 0.5 + Math.random() * 1.6,
      phase: Math.random() * Math.PI * 2,
    });
  }
  // Clouds live in the altitude band where the sky is brightest (peak blue
  // sits at h≈0.78). Spreading them across 0.50–1.05 keeps a steady stream
  // drifting through the middle of the screen for the whole sky phase.
  const transClouds: TransCloud[] = [];
  for (let i = 0; i < 18; i++) {
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
      h: 0.50 + Math.random() * 0.55,   // altitude band of the cloud (mid-sky)
      fx: Math.random(),
      scale: 80 + Math.random() * 110,
      puffs,
    });
  }

  // Color filters let the user dial sprite/building saturation+brightness live.
  // They're only attached when needed — applying a filter forces Pixi to
  // render the layer to an offscreen texture each frame, which is wasteful
  // when the matrix is the identity.
  const goblinFilter = new ColorMatrixFilter();
  const minotaurFilter = new ColorMatrixFilter();
  const dragonFilter = new ColorMatrixFilter();
  const buildingFilter = new ColorMatrixFilter();
  const hellGhostFilter = new ColorMatrixFilter();
  const demonFilter = new ColorMatrixFilter();

  const ctx: RenderContext = {
    app, worldLayer, buildingLayer, goblinLayer, uiLayer,
    goblinViews: new Map(),
    minotaurLayer, minotaurViews: new Map(),
    dragonLayer, dragonViews: new Map(),
    waterLayer, waterViews: new Map(),
    buildingViews: new Map(),
    camera: { x: 0, y: 0 },
    viewport: { width: initW, height: initH },
    renderScale: initScale,
    spaceLayer, spaceBg, spaceBuildingViews: new Map(), spaceUnitViews: new Map(),
    spaceCamera: { x: 0, y: 0 },
    spaceAmbientLayer, ambientDragons: [], nextAmbientSpawnAt: 0, ambientIdSeq: 1,
    blackOverlay, skyLayer, skyGfx, cloudGfx, starGfx,
    transStars, transClouds,
    altitude: 0,
    hellLayer, hellBg, demonLayer, demonViews: new Map(), hellGhostLayer, ghostViews: new Map(),
    hellCamera: { x: 0, y: 0 },
    depth: 0,
    hellZoom: 0,
    hellBeamGfx,
    hellSideBeamGfx,
    hellPortalMirrorLayer,
    hellPortalMirrors: new Map(),
    soulSigilLayer, soulSigilGfx, soulChairGfx, soulChairLabels: new Map(),
    sigilPowerLabels: new Map(),
    candleCursor: null,
    candlePreviewLabel: null,
    orbitalCursor: null,
    orbitalGhostGfx,
    bobTags: new Map(),
    worldTagLayer, spaceTagLayer, hellTagLayer,
    hellEffectsLayer,
    hellFloatersLayer,
    holeGfx, holeRing, bobPickerGfx,
    floatersLayer, floaterViews: new Map(),
    effectsLayer, deathViews: new Map(),
    deathFrames: null,
    whiteEffectsLayer, whiteFilter, lightningGfx,
    walls, wallsVersion: -1, state, playBg, wallGfx, grid, goblinFilter, minotaurFilter, dragonFilter, buildingFilter,
    hellGhostFilter,
    demonFilter,
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
    // Re-derive the zoom for the new size (e.g. a phone rotating between
    // portrait and landscape) and re-apply it to the ground + space layers.
    // The hell layer's scale is set every frame from currentHellScale.
    ctx.renderScale = computeRenderScale(w, h);
    ctx.worldLayer.scale.set(ctx.renderScale);
    ctx.spaceLayer.scale.set(ctx.renderScale);
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
  const maxX = Math.max(0, WORLD.width - ctx.viewport.width / ctx.renderScale);
  const maxY = Math.max(0, WORLD.height - ctx.viewport.height / ctx.renderScale);
  ctx.camera.x = Math.max(0, Math.min(maxX, ctx.camera.x));
  ctx.camera.y = Math.max(0, Math.min(maxY, ctx.camera.y));
}

export function centerCameraOn(ctx: RenderContext, x: number, y: number) {
  ctx.camera.x = x - ctx.viewport.width / (2 * ctx.renderScale);
  ctx.camera.y = y - ctx.viewport.height / (2 * ctx.renderScale);
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
  drawHellBackground(ctx.hellBg, o);
  ctx.app.renderer.background.color = o.oobColor;
  applyFilter(ctx.goblinLayer, ctx.goblinFilter, o.goblinSaturation, o.goblinBrightness);
  applyFilter(ctx.minotaurLayer, ctx.minotaurFilter, o.minotaurSaturation, o.minotaurBrightness);
  applyFilter(ctx.dragonLayer, ctx.dragonFilter, o.dragonSaturation, o.dragonBrightness);
  applyFilter(ctx.buildingLayer, ctx.buildingFilter, o.buildingSaturation, o.buildingBrightness);
  applyFilter(ctx.hellGhostLayer, ctx.hellGhostFilter, 1, o.hellGhostBrightness);
  applyFilter(ctx.demonLayer, ctx.demonFilter, o.demonSaturation, o.demonBrightness);
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
  // Robots get the greyscale filter applied per-frame in the sync loop (it's
  // a live dev option), so nothing to attach here.

  c.addChild(shadow);
  c.addChild(ring);
  for (const s of outline) c.addChild(s);
  c.addChild(sprite);

  return { container: c, shadow, outline, sprite, selectionRing: ring };
}

// Yellow "bob" label above the head — used wherever Bob currently is (alive,
// snatched, adrift, or a soul in hell; see syncBobTags), styled to match the
// gold-goblin tint so it reads as a name-plate rather than a UI label. Kept
// deliberately light — regular weight, thin outline — so the gothic display
// face stays legible at name-tag sizes. Drawn at half-pixel anchor so
// position.set(x, y) hangs the label centered over the sprite. `sizeMult`
// doubles the type for the hell Bob, whose tag reads at twice the overworld
// size.
function makeBobNametag(sizeMult = 1): Text {
  const t = new Text({
    text: 'bob',
    style: {
      fontFamily: fontFamilyById(getOptions().fonts.buildingLabel.family).css,
      fontSize: 13 * sizeMult,
      fill: 0xffd96b,
      stroke: { color: 0x000000, width: 2 },
    },
  });
  t.anchor.set(0.5, 1);
  return t;
}

// One nametag per place Bob currently exists: the living overworld goblin, a
// dragon's claws (carryingUnit), adrift in space, and his soul in hell. Each
// tag lives in its scene's dedicated top layer (worldTagLayer /
// spaceTagLayer / hellTagLayer) so nothing — minotaurs, demons, buildings —
// ever covers it. Synced every frame; tags whose host vanished are torn down.
function syncBobTags(ctx: RenderContext, state: GameState): void {
  const opts = getOptions();
  const px = opts.goblinDisplayPx;
  type TagSpec = { key: string; layer: Container; x: number; y: number; alpha: number; sizeMult: number };
  const specs: TagSpec[] = [];
  for (const g of state.goblins.values()) {
    if (!g.bob) continue;
    specs.push({ key: `g${g.id}`, layer: ctx.worldTagLayer, x: g.pos.x, y: g.pos.y - px * 0.55, alpha: 1, sizeMult: 1 });
  }
  // Bob dangling from a dragon mid-snatch — tag tracks the carried sprite.
  for (const d of state.dragons.values()) {
    if (!d.carryingUnit?.bob) continue;
    specs.push({
      key: `d${d.id}`, layer: ctx.worldTagLayer,
      x: d.pos.x, y: d.pos.y + opts.dragonDisplayPx * 0.34 - px * 0.55,
      alpha: 1, sizeMult: 1,
    });
  }
  for (const su of state.spaceUnits.values()) {
    if (!su.bob) continue;
    specs.push({ key: `su${su.id}`, layer: ctx.spaceTagLayer, x: su.pos.x, y: su.pos.y - px * 0.55, alpha: 1, sizeMult: 1 });
  }
  // His soul in hell — double size (the scene zooms out) at half opacity.
  for (const gh of state.ghosts) {
    if (!gh.bob) continue;
    const p = ghostHellPos(state, gh);
    specs.push({ key: `gh${gh.id}`, layer: ctx.hellTagLayer, x: p.x, y: p.y - px * 0.55, alpha: 0.5, sizeMult: 2 });
  }
  const seen = new Set<string>();
  for (const s of specs) {
    seen.add(s.key);
    let t = ctx.bobTags.get(s.key);
    if (!t) {
      t = makeBobNametag(s.sizeMult);
      s.layer.addChild(t);
      ctx.bobTags.set(s.key, t);
    }
    t.position.set(s.x, s.y);
    t.alpha = s.alpha;
  }
  for (const [key, t] of ctx.bobTags) {
    if (!seen.has(key)) {
      t.destroy();
      ctx.bobTags.delete(key);
    }
  }
  // Space building/unit views are appended to spaceLayer as they're created,
  // which would stack them over the tag layer — re-appending while a tag is
  // live keeps Bob's name on top of everything in orbit.
  if (ctx.spaceTagLayer.children.length > 0) ctx.spaceLayer.addChild(ctx.spaceTagLayer);
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

function makeDemonView(): DemonView {
  const container = new Container();
  // Soft foot shadow grounds the giant in the abyss — same radial-gradient
  // ellipse the goblins/minotaurs use, sat behind everything else.
  const shadow = new Sprite(getShadowTexture());
  shadow.anchor.set(0.5);
  const ring = new Graphics();
  ring.circle(0, 0, DEMON.displayPx * 0.4).stroke({ width: 3, color: 0xff5a4a });
  ring.visible = false;
  const startTex = minotaurWalkSheet?.frames[0][0] ?? Texture.EMPTY;
  const sprite = new Sprite(startTex);
  sprite.anchor.set(0.5);
  sprite.tint = 0x7a2014; // deep infernal red — bigger and darker than a Minotaur
  container.addChild(shadow);
  container.addChild(ring);
  container.addChild(sprite);
  return { container, shadow, sprite, selectionRing: ring };
}

// The dragon draws from an 8-direction fly sheet (dragonFlySheet). A soft glow
// sits behind it and the carried building rides just below. DRAGON_BLOCK
// survives as the hit-test footprint for ambient dragons.
const DRAGON_BLOCK = Math.round(DRAGON.displayPx * 0.78);
function makeDragonView(d: Dragon): DragonView {
  const container = new Container();

  const glow = new Sprite(getGlowTexture());
  glow.anchor.set(0.5);
  glow.tint = 0xff8a3a;
  glow.scale.set(DRAGON.displayPx * 1.3 / 128);
  glow.alpha = 0.18;

  const sprite = new Sprite(Texture.EMPTY);
  sprite.anchor.set(0.5);

  const carried = new Sprite(Texture.EMPTY);
  carried.anchor.set(0.5);
  carried.visible = false;

  const selectionRing = new Graphics();
  selectionRing.circle(0, 0, DRAGON.displayPx * 0.5).stroke({ width: 2, color: 0xffd96b });
  selectionRing.visible = false;

  container.addChild(glow);
  container.addChild(carried);
  container.addChild(sprite);
  container.addChild(selectionRing);
  // Seed the heading from the sim's ±1 mirror (0 = east in atan2 convention)
  // until the first frame of real movement reveals a proper direction.
  return {
    container, glow, sprite, carried, selectionRing,
    heading: d.facing > 0 ? 0 : Math.PI,
    lastX: d.pos.x, lastY: d.pos.y,
  };
}

// Ambient dragons reuse the fly sheet but darkened: a warm dim tint, a faint
// glow, and the whole thing held at reduced alpha so it reads as a distant
// silhouette against the stars rather than a summonable dragon.
const AMBIENT_DRAGON_TINT = 0xb09070;
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
  glow.scale.set(DRAGON.displayPx * 1.1 / 128);
  glow.alpha = 0.08;

  const sprite = new Sprite(Texture.EMPTY);
  sprite.anchor.set(0.5);
  sprite.tint = AMBIENT_DRAGON_TINT;
  if (dragonFlySheet) sprite.scale.set(DRAGON.displayPx / dragonFlySheet.meta.spriteSize);

  const selectionRing = new Graphics();
  selectionRing.circle(0, 0, DRAGON.displayPx * 0.5).stroke({ width: 2, color: 0xffd96b });
  selectionRing.visible = false;

  container.addChild(glow);
  container.addChild(sprite);
  container.addChild(selectionRing);
  ctx.spaceAmbientLayer.addChild(container);

  const x0 = midScene
    ? SPACE.width * (0.15 + Math.random() * 0.70)
    : (dir > 0 ? -cfg.margin : SPACE.width + cfg.margin);
  const y = SPACE.height * (0.12 + Math.random() * 0.76);
  ctx.ambientDragons.push({
    id: ctx.ambientIdSeq++,
    // When pre-filling an empty scene, start somewhere on-screen so arriving in
    // space isn't a beat of emptiness; otherwise enter from just off the edge.
    x0, y,
    dir, speed, scale,
    bobPhase: Math.random() * Math.PI * 2,
    bobAmp: cfg.bobAmpMin + Math.random() * (cfg.bobAmpMax - cfg.bobAmpMin),
    spawnAt: ctx.state.now,
    container,
    sprite,
    selectionRing,
    cx: x0,
    cy: y,
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
    // Selection is renderer-cosmetic; once the layer's gone, drop it.
    if (ctx.state.selectedAmbientDragonId !== null) ctx.state.selectedAmbientDragonId = null;
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
      if (ctx.state.selectedAmbientDragonId === a.id) ctx.state.selectedAmbientDragonId = null;
      a.container.destroy({ children: true });
      ctx.ambientDragons.splice(i, 1);
      continue;
    }
    const bob = Math.sin((now + a.bobPhase) * 2.2) * a.bobAmp;
    a.cx = x;
    a.cy = a.y + bob;
    a.container.position.set(x, a.cy);
    a.container.scale.set(a.scale);
    // Cruise direction picks the sheet row directly: east row when travelling
    // right, west when left. bobPhase doubles as a flap-phase offset so the
    // flock doesn't beat its wings in lockstep.
    const sheet = dragonFlySheet;
    if (sheet) {
      const dirRow = dirIndex(sheet.meta, a.dir > 0 ? 0 : Math.PI);
      const fpd = sheet.meta.framesPerDirection;
      const frame = Math.floor((now + a.bobPhase) * sheet.fps) % fpd;
      a.sprite.texture = sheet.frames[dirRow][frame];
    }
    a.selectionRing.visible = ctx.state.selectedAmbientDragonId === a.id;
  }
}

// Hit-test space-layer pointer coords against every ambient dragon on screen
// and return the closest one (or null). Mirrors spaceBuildingAt's contract;
// used by input.ts to let the player click the decorative dragons.
export function ambientDragonAt(ctx: RenderContext, x: number, y: number): { id: number } | null {
  let best: AmbientDragon | null = null;
  let bestD = Infinity;
  for (const a of ctx.ambientDragons) {
    // Hit radius scales with the dragon's draw size — a small distant dragon
    // takes a tighter click than a closer/larger one.
    const r = DRAGON_BLOCK * a.scale * 0.6;
    const dx = x - a.cx, dy = y - a.cy;
    if (Math.abs(dx) > r || Math.abs(dy) > r) continue;
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = a; }
  }
  return best ? { id: best.id } : null;
}

// Build a static silhouette of a killed unit at its death position. Uses the
// first frame of the matching idle/walk sheet for the row that matches the
// recorded facing — no per-frame animation, no shadow, no outline. Tinted
// dim red so the whole hell scene reads as the underworld.
function makeGhostView(g: Ghost): GhostView | null {
  const container = new Container();
  // Position is updated each render frame; here we just seed it.
  container.position.set(worldToHellX(g.x + (g.offX ?? 0)), worldToHellY(g.y + (g.offY ?? 0)));
  container.alpha = getOptions().hellGhostAlpha;

  // Selection ring lives inside the container so it follows the ghost. Sized
  // to roughly match the sprite footprint per-kind.
  const selectionRing = new Graphics();
  selectionRing.visible = false;

  if (g.kind === 'goblin') {
    const sheet = goblinIdleSheet ?? goblinWalkSheet;
    if (!sheet) return null;
    const dir = dirIndex(sheet.meta, g.facing);
    const tex = sheet.frames[dir][0];
    const sprite = new Sprite(tex);
    sprite.anchor.set(0.5);
    const px = getOptions().goblinDisplayPx;
    sprite.scale.set(px / sheet.meta.spriteSize);
    sprite.tint = g.gold ? 0xc9a85a : 0xa06868;
    selectionRing.circle(0, 0, GOBLIN.radius + 4).stroke({ width: 2, color: 0xffd96b });
    container.addChild(selectionRing);
    container.addChild(sprite);
    // Bob's hell nametag lives in hellTagLayer (see syncBobTags), not here,
    // so the demons can never cover it.
    return { container, sprite, selectionRing };
  }
  if (g.kind === 'minotaur') {
    const sheet = minotaurWalkSheet;
    if (!sheet) return null;
    const dir = dirIndex(sheet.meta, g.facing);
    const tex = sheet.frames[dir][0];
    const sprite = new Sprite(tex);
    sprite.anchor.set(0.5);
    const px = getOptions().minotaurDisplayPx * (g.tiny ? TINYTAUR.scale : 1);
    sprite.scale.set(px / sheet.meta.spriteSize);
    sprite.tint = 0x9a5050;
    selectionRing.circle(0, 0, MINOTAUR.radius + 6).stroke({ width: 2, color: 0xffd96b });
    container.addChild(selectionRing);
    container.addChild(sprite);
    return { container, sprite, selectionRing };
  }
  // Dragon ghost: first fly-sheet frame for the east/west row, dim red.
  // Dragon facing is -1 (left) / +1 (right) — map it onto the sheet's
  // east/west headings (atan2 convention: 0 = east).
  const sheet = dragonFlySheet;
  if (!sheet) return null;
  const dir = dirIndex(sheet.meta, g.facing > 0 ? 0 : Math.PI);
  const sprite = new Sprite(sheet.frames[dir][0]);
  sprite.anchor.set(0.5);
  sprite.scale.set(DRAGON.displayPx / sheet.meta.spriteSize);
  sprite.tint = 0x9a5050;
  selectionRing.circle(0, 0, DRAGON.displayPx * 0.5).stroke({ width: 2, color: 0xffd96b });
  container.addChild(selectionRing);
  container.addChild(sprite);
  return { container, sprite, selectionRing };
}

// Build the hell-side mirror of an overworld hell_portal — a darker copy of
// the building's footprint with a pulsing red interior, positioned at the
// portal's world coord mapped into hell space. Used once at creation;
// container is destroyed when the source portal is destroyed.
function makeHellPortalMirror(b: Building): Container {
  const c = new Container();
  const def = defOf(b);
  const ctr = buildingCenter(b);
  c.position.set(worldToHellX(ctr.x), worldToHellY(ctr.y));
  const half = def.size / 2;
  // Single halo ring drawn first so it sits BEHIND the body/core. A stroked
  // outline (not a filled disc) so the portal reads as an emanation in the
  // underworld. Kept to one circle, sized to sit clearly inside the sigil's
  // red inner ring (radius SOUL_SIGIL.innerRadius) now that the portal's
  // footprint is 1×1, so the scene stays uncluttered.
  const halo = new Graphics();
  const outerR = def.size * 2.2;
  halo.circle(0, 0, outerR).stroke({ width: 3, color: 0xfff4c0, alpha: 0.3 });
  const body = new Graphics();
  body.rect(-half, -half, def.size, def.size).fill({ color: 0x2a0610, alpha: 0.95 });
  body.rect(-half, -half, def.size, def.size).stroke({ width: 3, color: 0xff2030 });
  // Glowing core square pulses with state.now via container.alpha tweak in
  // the render loop; we keep the geometry static.
  const core = new Graphics();
  const inner = def.size * 0.55;
  core.rect(-inner / 2, -inner / 2, inner, inner).fill({ color: 0xff5a2a, alpha: 0.75 });
  c.addChild(halo);
  c.addChild(body);
  c.addChild(core);
  return c;
}

// Redraw the soul sigil every frame: the central inner ring, the outer candle
// ring (the placement target), the pentagram edges between placed candles, the
// candles themselves (flickering flames; ember-bound once a soul is seated),
// the place-in/seat-in bursts, and — once all five souls are bound — a wave of
// pulses chasing around the ring plus a one-shot shockwave on completion. The
// candle labels ("needs N candles" / "needs soul") and the live wattage
// readout on each mirror ("1 W" ×87 per seated soul) are driven here too.
function syncSoulSigil(ctx: RenderContext, state: GameState): void {
  const now = state.now;
  const { count, innerRadius, ringRadius, chairRadius } = SOUL_SIGIL;
  const ring = ctx.soulSigilGfx;
  const cg = ctx.soulChairGfx;
  ring.clear();
  cg.clear();

  // Group the placed candles by portal so each active portal draws one
  // self-contained sigil (rings show even before the first candle goes down).
  const groups = new Map<number, SoulChair[]>();
  for (const c of state.soulChairs) {
    const arr = groups.get(c.portalId);
    if (arr) arr.push(c); else groups.set(c.portalId, [c]);
  }

  const seenLabels = new Set<number>();
  const seenPower = new Set<number>();
  for (const portal of state.buildings.values()) {
    if (portal.kind !== 'hell_portal' || portal.state === 'constructing') continue;
    const ctr = buildingCenter(portal);
    const center = { x: worldToHellX(ctr.x), y: worldToHellY(ctr.y) };
    const group = groups.get(portal.id) ?? [];
    const completedAt = state.soulSigilCompletedAt.get(portal.id);
    const completed = completedAt !== undefined;
    const compAge = completed ? now - completedAt : 0;
    // Candles ordered by ring index (assigned by angle at placement) so the
    // pentagram edges read cleanly.
    const ordered = [...group].sort((a, b) => a.index - b.index);
    const ringDone = ordered.length >= count;

    // Central inner ring at the mirror — a single occult outline that
    // brightens once the sigil is complete.
    const ringGlow = completed ? 0.55 + 0.25 * Math.sin(now * 3) : 0.4;
    ring.circle(center.x, center.y, innerRadius).stroke({ width: 4, color: 0xff2030, alpha: ringGlow });

    // Outer ring — where candles take. Faint normally; breathes brighter
    // while the player is placing candles and the ring still has room.
    const placing = state.pendingCandle && !ringDone;
    const outerAlpha = placing ? 0.38 + 0.14 * Math.sin(now * 3) : 0.14;
    ring.circle(center.x, center.y, ringRadius).stroke({ width: placing ? 3 : 2, color: 0xff2030, alpha: outerAlpha });

    // A line links every pair of placed candles (the complete graph), so the
    // pentagram sketches itself in line by line as candles go down. Skip-one
    // pairs form the bright pentagram star; adjacent perimeter lines are
    // thinner + fainter so the star reads on top.
    for (let a = 0; a < ordered.length; a++) {
      for (let b = a + 1; b < ordered.length; b++) {
        const ca = ordered[a], cb = ordered[b];
        const gap = Math.min(Math.abs(a - b), ordered.length - Math.abs(a - b));
        const isStar = ordered.length < count || gap === 2; // skip-one pairs are the pentagram
        const alpha = isStar ? (completed ? 0.85 : 0.6) : (completed ? 0.4 : 0.26);
        ring.moveTo(ca.hx, ca.hy).lineTo(cb.hx, cb.hy)
          .stroke({ width: isStar ? 5 : 3, color: 0xff2030, alpha });
        if (completed && isStar) {
          const a2 = 0.4 + 0.35 * Math.sin(now * 4);
          ring.moveTo(ca.hx, ca.hy).lineTo(cb.hx, cb.hy).stroke({ width: 2, color: 0xffe0a0, alpha: a2 });
        }
      }
    }

    // Completed-sigil flourish: a one-shot shockwave expanding from the
    // centre the moment it completes.
    if (completed && compAge < 1.6) {
      const r = innerRadius + compAge * 900;
      ring.circle(center.x, center.y, r).stroke({ width: 7, color: 0xffd060, alpha: (1 - compAge / 1.6) * 0.9 });
    }

    // Candles + labels.
    for (const chair of ordered) {
      const { hx, hy, occupied, index } = chair;
      // Dark wax-pool disc with a rim that lights up when bound.
      cg.circle(hx, hy, chairRadius).fill({ color: 0x140306, alpha: 0.92 });
      cg.circle(hx, hy, chairRadius).stroke({
        width: 3,
        color: occupied ? 0xff4a30 : 0x6a2024,
        alpha: occupied ? 0.95 : 0.6,
      });
      // The candle itself: a pale stick rising from the pool with a
      // flickering flame (per-candle phase so the ring never flickers in
      // lockstep).
      const flicker = 0.5 + 0.5 * Math.sin(now * 7 + index * 2.1);
      cg.rect(hx - 5, hy - 26, 10, 26).fill({ color: 0xe8dcc8, alpha: 0.9 });
      cg.circle(hx, hy - 32, 13).fill({ color: 0xff8030, alpha: 0.1 + 0.08 * flicker });
      cg.ellipse(hx, hy - 33, 5, 9).fill({ color: 0xffc040, alpha: 0.55 + 0.35 * flicker });
      cg.ellipse(hx, hy - 31, 2.5, 5).fill({ color: 0xfff0b0, alpha: 0.6 + 0.3 * flicker });
      if (occupied) {
        // Glowing ember core in the pool. Once complete, the pulse phase is
        // offset per chair so a wave of brightening chases around the ring.
        const pulse = completed
          ? 0.55 + 0.45 * Math.sin(now * 4 - index * 1.4)
          : 0.5 + 0.25 * Math.sin(now * 2.5);
        cg.circle(hx, hy, chairRadius * 0.55).fill({ color: 0xff5a2a, alpha: 0.5 * pulse + 0.2 });
        cg.circle(hx, hy, chairRadius * 0.28).fill({ color: 0xffd6a0, alpha: 0.45 * pulse + 0.25 });
      }
      // Selection ring — matches the gold highlight other selected things
      // get — or, when a soul was just commanded onto this chair, the same
      // one-shot pulse other command targets flash (see applyRingFlash).
      if (chair.selected) {
        cg.circle(hx, hy, chairRadius + 8).stroke({ width: 3, color: 0xffd96b, alpha: 0.95 });
      } else if (chair.commandFlashAt !== undefined) {
        const t = (now - chair.commandFlashAt) / COMMAND_FLASH_S;
        if (t >= 0 && t < 1) {
          cg.circle(hx, hy, chairRadius + 8).stroke({
            width: 3, color: 0xffd96b, alpha: Math.sin(t * Math.PI) * COMMAND_FLASH_PEAK,
          });
        }
      }
      // Place-in flare: a small expanding ring when the candle first takes.
      if (chair.placedAt !== undefined) {
        const age = now - chair.placedAt;
        if (age >= 0 && age < 0.6) {
          cg.circle(hx, hy, chairRadius + age * 120).stroke({
            width: 2, color: 0xffc040, alpha: (1 - age / 0.6) * 0.8,
          });
        }
      }
      // Seat-in burst: a quick expanding ring when the soul lands.
      if (chair.filledAt !== undefined) {
        const age = now - chair.filledAt;
        if (age >= 0 && age < 0.9) {
          cg.circle(hx, hy, chairRadius + age * 240).stroke({
            width: 3, color: 0xff8040, alpha: (1 - age / 0.9) * 0.85,
          });
        }
      }

      // Tag above the candle: red "needs N candles" until the ring is full,
      // then "needs soul" until a soul is bound (nothing once it is — the
      // mirror's wattage readout takes over the storytelling).
      let label = ctx.soulChairLabels.get(chair.id);
      if (!label) {
        label = new Text({
          text: '',
          style: {
            fontFamily: fontFamilyById(getOptions().fonts.buildingLabel.family).css,
            fontSize: 16,
            fill: 0xff8a7a,
            fontWeight: 'bold',
          },
        });
        label.anchor.set(0.5, 1);
        ctx.soulSigilLayer.addChild(label);
        ctx.soulChairLabels.set(chair.id, label);
      }
      const remaining = count - ordered.length;
      const labelText = !ringDone
        ? `needs ${remaining} candle${remaining === 1 ? '' : 's'}`
        : !occupied ? 'needs soul' : '';
      if (label.text !== labelText) label.text = labelText;
      label.style.fill = ringDone ? 0xff8a7a : 0xff3a2a;
      label.position.set(hx, hy - chairRadius - 22);
      label.visible = labelText !== '';
      seenLabels.add(chair.id);
    }

    // Live wattage readout on the mirror: "1 W" untouched, ×87 per seated
    // soul. Sits just below the mirror body so the beam/core stay clear.
    let power = ctx.sigilPowerLabels.get(portal.id);
    if (!power) {
      power = new Text({
        text: '',
        style: {
          fontFamily: fontFamilyById(getOptions().fonts.buildingLabel.family).css,
          fontSize: 18,
          fill: 0x8acfff,
          fontWeight: 'bold',
        },
      });
      power.anchor.set(0.5, 0);
      ctx.soulSigilLayer.addChild(power);
      ctx.sigilPowerLabels.set(portal.id, power);
    }
    const seated = ordered.filter((c) => c.occupied).length;
    const watts = sigilPortalOutput(defOf(portal).powerOutput, seated);
    const powerText = formatPower(watts);
    if (power.text !== powerText) power.text = powerText;
    power.position.set(center.x, center.y + defOf(portal).size * 0.5 + 6);
    seenPower.add(portal.id);
  }

  // Candle placement preview: a ghost candle under the cursor in the same
  // blue (placeable) / red (blocked) the building placement ghost uses. Near
  // a ring it snaps onto the ring; away from any ring it rides the cursor in
  // red so there's always feedback while the mode is armed.
  let previewTag = '';
  let previewPos = { x: 0, y: 0 };
  if (state.pendingCandle && ctx.candleCursor) {
    const spot = candleSpotAt(state, ctx.candleCursor.x, ctx.candleCursor.y);
    const gx = spot ? spot.x : ctx.candleCursor.x;
    const gy = spot ? spot.y : ctx.candleCursor.y;
    const valid = spot !== null && spot.ok;
    const color = valid ? 0x6a8eb0 : 0xd96b6b;
    cg.circle(gx, gy, chairRadius).fill({ color, alpha: 0.25 });
    cg.circle(gx, gy, chairRadius).stroke({ width: 2, color });
    cg.rect(gx - 5, gy - 26, 10, 26).fill({ color, alpha: 0.45 });
    cg.ellipse(gx, gy - 33, 5, 9).fill({ color, alpha: 0.45 });
    // Say WHY a ring spot is refused, right on the ghost.
    if (spot && !spot.ok) {
      previewTag = spot.blocked === 'full' ? 'ring full' : 'too close';
      previewPos = { x: gx, y: gy - chairRadius - 22 };
    }
  }
  let tag = ctx.candlePreviewLabel;
  if (previewTag !== '' && !tag) {
    tag = new Text({
      text: '',
      style: {
        fontFamily: fontFamilyById(getOptions().fonts.buildingLabel.family).css,
        fontSize: 16,
        fill: 0xd96b6b,
        fontWeight: 'bold',
      },
    });
    tag.anchor.set(0.5, 1);
    ctx.soulSigilLayer.addChild(tag);
    ctx.candlePreviewLabel = tag;
  }
  if (tag) {
    if (tag.text !== previewTag && previewTag !== '') tag.text = previewTag;
    tag.visible = previewTag !== '';
    if (previewTag !== '') {
      tag.position.set(previewPos.x, previewPos.y);
      // Counter the hell zoom-out so the tag keeps a constant apparent size
      // instead of halving when the camera eases out to zoomedOutScale.
      tag.scale.set(ctx.renderScale / currentHellScale(ctx));
    }
  }

  // Drop labels whose candle/portal is gone.
  for (const [id, label] of ctx.soulChairLabels) {
    if (!seenLabels.has(id)) {
      label.destroy();
      ctx.soulChairLabels.delete(id);
    }
  }
  for (const [id, label] of ctx.sigilPowerLabels) {
    if (!seenPower.has(id)) {
      label.destroy();
      ctx.sigilPowerLabels.delete(id);
    }
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
  const labelText = def.short;
  const label = new Text({
    text: labelText,
    style: {
      fontFamily: fontFamilyById(labelCfg.family).css,
      fontSize: buildingLabelSize(def.cellSize, labelCfg.scale * gs),
      fill: 0xffffff,
      fontWeight: 'bold',
    },
  });
  label.anchor.set(0.5);
  label.visible = o.buildingLabelEnabled && labelText !== '';

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

// Attach/detach the shared greyscale filter on a sprite without re-assigning
// .filters every frame (each assignment rebuilds the filter pass). Used by
// the dragon's carried-sprite, which swaps between buildings and robots.
function setSpriteGreyscale(s: Sprite, want: boolean): void {
  const has = Array.isArray(s.filters) && s.filters.length > 0;
  if (want !== has) s.filters = want ? [getBuildingGreyscaleFilter()] : [];
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

// Pulsing yellow ring around every Goblin Hole (main + completed building
// holes) while state.bobPickingHole is true. Sin-wave alpha so a click target
// reads as alive; cleared on every other frame so flipping bobPickingHole off
// leaves no residue.
function drawBobPicker(ctx: RenderContext, state: GameState) {
  ctx.bobPickerGfx.clear();
  if (!state.bobPickingHole) return;
  // Picker pulses on wall-clock time so the ring keeps breathing even though
  // tick-time is frozen during hole selection.
  const t = performance.now() / 1000;
  const pulse = 0.55 + 0.35 * Math.sin(t * 4);
  const inflate = 4 + 2 * Math.sin(t * 4);
  const ring = (cx: number, cy: number, half: number) => {
    ctx.bobPickerGfx
      .rect(cx - half - inflate, cy - half - inflate, (half + inflate) * 2, (half + inflate) * 2)
      .stroke({ width: 3, color: 0xffd96b, alpha: pulse });
  };
  const main = holeCenter(state);
  ring(main.x, main.y, (CELL * HOLE_SIZE) / 2 + 2);
  for (const b of state.buildings.values()) {
    if (b.kind !== 'goblin_hole' || b.state === 'constructing') continue;
    const bc = buildingCenter(b);
    const def = defOf(b);
    ring(bc.x, bc.y, def.size / 2 + 2);
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
      // Hell-flagged splatters spawn in the underworld at the world→hell
      // mapped coordinate. The default white/normal splatters stay in the
      // overworld effect layers at their raw world coordinate.
      if (e.hell) {
        sprite.position.set(worldToHellX(e.x), worldToHellY(e.y));
      } else {
        sprite.position.set(e.x, e.y);
      }
      // Scale once on creation to ~one cell wide.
      const target = 40;
      const sc = target / Math.max(frames.textures[0].width || target, 1);
      sprite.scale.set(sc);
      sprite.cullable = true;
      // White splatters go in the force-white layer; the tint below is left
      // alone for them so the color matrix has the raw alpha to work with.
      const layer = e.hell ? ctx.hellEffectsLayer
                  : e.white ? ctx.whiteEffectsLayer
                  : ctx.effectsLayer;
      layer.addChild(sprite);
      ctx.deathViews.set(e.id, sprite);
    }
    if (e.hell) sprite.tint = getOptions().hellBloodColor;
    else if (!e.white) sprite.tint = getOptions().bloodColor;
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
          // slider that resizes UI text also resizes in-world numbers. Some
          // floaters (the soul-surge "x87") carry their own size multiplier.
          fontSize: 14 * opts.globalFontScale * (f.sizeMult ?? 1),
          fill: f.color,
          fontWeight: 'bold',
          stroke: { color: 0x000000, width: 3 },
        },
      });
      t.anchor.set(0.5, 1);
      t.cullable = true;
      // Space-building floaters live in the orbit scene (panned by the space
      // camera); hell floaters (the soul-chair power surge) ride the hell
      // transform; everything else rides the ground world layer.
      (f.hell ? ctx.hellFloatersLayer : f.space ? ctx.spaceLayer : ctx.floatersLayer).addChild(t);
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

// Cached handle to the demon-parlay speech bubble (an HTML overlay element).
// Resolved lazily and reused so we don't getElementById every frame.
let demonSpeechEl: HTMLElement | null | undefined;
let demonSpeechAnchored = false;

// Float the parlay speech bubble above the current speaker's head. `screenX`/
// `screenY` map a hell coordinate to a screen pixel using the live hell-layer
// transform; an overworld goblin speaker (Bob's barks) is mapped through the
// world layer's transform instead. Called once per frame; resets to the
// CSS-default centre position when no one is speaking.
function positionParlaySpeech(
  ctx: RenderContext,
  scale: number,
  screenX: (hx: number) => number,
  screenY: (hy: number) => number,
): void {
  if (demonSpeechEl === undefined) demonSpeechEl = document.getElementById('demon-speech');
  const el = demonSpeechEl;
  if (!el) return;
  const sp = getParlaySpeaker();
  if (!sp) {
    if (demonSpeechAnchored) {
      el.style.left = ''; el.style.top = ''; el.style.transform = '';
      demonSpeechAnchored = false;
    }
    return;
  }
  let sx: number;
  let sy: number;
  if (sp.kind === 'goblin') {
    // Bob barking in the overworld — anchor via the world layer's live
    // transform (camera pan + climb/descend slide) instead of the hell mapping.
    const g = sp.goblin;
    const rs = ctx.renderScale;
    sx = ctx.worldLayer.position.x + g.pos.x * rs;
    sy = ctx.worldLayer.position.y
      + (g.pos.y - getOptions().goblinDisplayPx * 0.5) * rs - 12 * rs;
  } else {
    let hx: number;
    let headTopHy: number;
    if (sp.kind === 'demon') {
      hx = sp.demon.hx;
      headTopHy = sp.demon.hy
        - DEMON.displayPx * 0.5 * getOptions().demonScale * demonScaleOf(sp.demon);
    } else {
      const g = sp.ghost;
      hx = g.hx ?? worldToHellX(g.x + (g.offX ?? 0));
      const hy = g.hy ?? worldToHellY(g.y + (g.offY ?? 0));
      headTopHy = hy - getOptions().goblinDisplayPx * 0.5;
    }
    sx = screenX(hx);
    sy = screenY(headTopHy) - 12 * scale;
  }
  // Bubble is anchored bottom-centre (translate(-50%,-100%)), so it grows up
  // and out from (sx, sy). Park it just above the head, then clamp against the
  // viewport so a tall/wide line (or the colossal demon whose head sits near the
  // top edge) never rides off-screen.
  const pad = 8;
  const halfW = el.offsetWidth / 2;
  const h = el.offsetHeight;
  const vw = ctx.viewport.width;
  sx = Math.max(halfW + pad, Math.min(vw - halfW - pad, sx));
  sy = Math.max(h + pad, sy);
  el.style.left = `${Math.round(sx)}px`;
  el.style.top = `${Math.round(sy)}px`;
  el.style.transform = 'translate(-50%, -100%)';
  demonSpeechAnchored = true;
}

// Duration (seconds) of the one-shot "you commanded a unit onto me" ring flash.
const COMMAND_FLASH_S = 0.6;
// Peak opacity of the command flash — kept below full so it reads as a brief
// pulse rather than a solid selection ring.
const COMMAND_FLASH_PEAK = 0.75;
// Drive a selection ring from the entity's `selected` flag plus an optional
// one-shot command flash. A selected ring stays solid; otherwise, if the entity
// was commanded onto within COMMAND_FLASH_S, the ring pulses 0→0.75→0 once so the
// player can see exactly what they targeted.
function applyRingFlash(ring: Graphics, selected: boolean, flashAt: number | undefined, now: number): void {
  if (selected) {
    ring.visible = true;
    ring.alpha = 1;
    return;
  }
  if (flashAt !== undefined) {
    const t = (now - flashAt) / COMMAND_FLASH_S;
    if (t >= 0 && t < 1) {
      ring.visible = true;
      ring.alpha = Math.sin(t * Math.PI) * COMMAND_FLASH_PEAK;
      return;
    }
  }
  ring.visible = false;
  ring.alpha = 1;
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

  // The Orbital Platform is born in space and ships no PNG — draw its grey
  // deck directly instead of relying on a sprite.
  let body: Graphics | undefined;
  if (sb.building.kind === 'orbital_platform') {
    body = new Graphics();
    drawOrbitalPlatformBody(body, def.size);
  }

  // Construction bar + "needs robot" tag, only ever shown while an Orbital
  // Platform is mid-assembly (driven from the sync loop each frame).
  const progress = new Graphics();
  const warning = new Text({
    text: 'needs robot',
    style: {
      fontFamily: fontFamilyById(o.fonts.buildingWarning.family).css,
      fontSize: buildingWarningSize(o.fonts.buildingWarning.scale * o.globalFontScale),
      fill: 0xffb0b0,
      fontWeight: 'bold',
      stroke: { color: 0x000000, width: 3 },
    },
  });
  warning.anchor.set(0.5);
  warning.position.set(0, -def.size / 2 - 12);
  warning.visible = false;

  const gs = o.globalFontScale;
  // Dragon Beacons stop being beacons the moment they're hoisted into orbit —
  // the haul-up severs whatever made them useful. Relabel to match the info
  // panel and the joke ("Useless Beacon").
  const short = sb.building.kind === 'dragon_beacon' ? 'UB' : def.short;
  const label = new Text({
    text: short,
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
  if (body) container.addChild(body);
  container.addChild(sprite);
  container.addChild(label);
  container.addChild(progress);
  container.addChild(warning);
  return { container, glow, sprite, body, progress, warning, label, selectionRing };
}

// The Orbital Platform's drawn art: one big flat rectangular deck plate
// filling the footprint. Deliberately plain — later on it'll be possible to
// set buildings down on top of it, so the platform is just floor.
function drawOrbitalPlatformBody(g: Graphics, size: number): void {
  const half = size / 2;
  g.clear();
  g.rect(-half, -half, size, size)
    .fill(0x4a505a)
    .stroke({ width: 3, color: 0xb8bec6 });
}

function makeSpaceUnitView(): SpaceUnitView {
  const container = new Container();
  const selectionRing = new Graphics();
  selectionRing.circle(0, 0, 28).stroke({ width: 2, color: 0xffd96b });
  selectionRing.visible = false;
  const sprite = new Sprite(Texture.EMPTY);
  sprite.anchor.set(0.5);
  // Robot greyscale is applied per-frame in the sync loop (live dev option).
  container.addChild(selectionRing);
  container.addChild(sprite);
  return { container, sprite, selectionRing };
}

// ─── Space scene + climb transition ─────────────────────────────────
// Gradient sampled from low to high altitude. The bottom stops are pure black
// so the sky overlay smoothly continues the black-overlay phase upward; the
// blue band sits high in the gradient (peak around h≈0.78) so it ends up in
// the middle of the screen during the sky-peak phase of the climb. Above the
// blue, the gradient sinks back into deep space.
const SKY_STOPS: [number, number][] = [
  [0.00, 0x000000], [0.35, 0x030814], [0.52, 0x0d1c44], [0.66, 0x254a82],
  [0.78, 0x3f7fd8], [0.88, 0x1c3f86], [1.00, 0x0a1640], [1.15, 0x03040f],
  [1.40, 0x000000],
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
  const maxX = Math.max(0, SPACE.width - ctx.viewport.width / ctx.renderScale);
  const maxY = Math.max(0, SPACE.height - ctx.viewport.height / ctx.renderScale);
  ctx.spaceCamera.x = Math.max(0, Math.min(maxX, ctx.spaceCamera.x));
  ctx.spaceCamera.y = Math.max(0, Math.min(maxY, ctx.spaceCamera.y));
}
export function centerSpaceCamera(ctx: RenderContext) {
  ctx.spaceCamera.x = SPACE.width / 2 - ctx.viewport.width / (2 * ctx.renderScale);
  ctx.spaceCamera.y = SPACE.height / 2 - ctx.viewport.height / (2 * ctx.renderScale);
  clampSpaceCamera(ctx);
}
// True extent the space camera can pan (so main can detect "at the bottom").
export function spaceCameraMaxY(ctx: RenderContext): number {
  return Math.max(0, SPACE.height - ctx.viewport.height / ctx.renderScale);
}

// Clamp the hell camera to HELL bounds. `scale` is the live hell-layer scale
// (changes with hellZoom), so the clamp accounts for how much world is visible.
export function clampHellCamera(ctx: RenderContext, scale: number = currentHellScale(ctx)) {
  const maxX = Math.max(0, HELL.width - ctx.viewport.width / scale);
  const maxY = Math.max(0, HELL.height - ctx.viewport.height / scale);
  ctx.hellCamera.x = Math.max(0, Math.min(maxX, ctx.hellCamera.x));
  ctx.hellCamera.y = Math.max(0, Math.min(maxY, ctx.hellCamera.y));
}
// HELL is larger than WORLD, so the overworld's play area is offset into the
// center of the hell scene. These two map between the two spaces.
export function worldToHellX(wx: number): number {
  return wx + (HELL.width - WORLD.width) / 2;
}
export function worldToHellY(wy: number): number {
  return wy + (HELL.height - WORLD.height) / 2;
}

// Current hell-coord position of a ghost — explicit hx/hy if the sim is
// tracking it (commanded / interacted), otherwise derived from spawnAt + drift
// with the per-ghost jitter. Both the renderer and input.ts need this, so it
// lives here as the single source of truth.
export function ghostHellPos(state: GameState, g: Ghost): { x: number; y: number } {
  if (g.hx !== undefined && g.hy !== undefined) return { x: g.hx, y: g.hy };
  const fall = getOptions().hellGhostFallSpeed;
  // speedMult drives drift only (per-ghost jitter); Bob has 0 here so he
  // sits where he died until a walk command moves him.
  const driftMult = g.speedMult ?? 1;
  return {
    x: worldToHellX(g.x + (g.offX ?? 0)),
    y: worldToHellY(g.y + (g.offY ?? 0)) + (state.now - g.spawnAt) * fall * driftMult,
  };
}

// Pick the topmost ghost under a hell-coord point, or null if none is within
// HELL.ghostHitRadius. Used by input.ts to resolve a tap in the hell view.
export function ghostAtHell(state: GameState, hx: number, hy: number): Ghost | null {
  let best: Ghost | null = null;
  let bestD = HELL.ghostHitRadius * HELL.ghostHitRadius;
  for (const g of state.ghosts) {
    const p = ghostHellPos(state, g);
    const dx = p.x - hx;
    const dy = p.y - hy;
    const d = dx * dx + dy * dy;
    if (d <= bestD) {
      bestD = d;
      best = g;
    }
  }
  return best;
}
// Center the hell camera over the world-position you stepped off from on the
// ground, so arrival lands you above the same play area you just left.
export function centerHellCameraOnWorld(ctx: RenderContext, wx: number, wy: number) {
  const scale = currentHellScale(ctx);
  ctx.hellCamera.x = worldToHellX(wx) - ctx.viewport.width / (2 * scale);
  ctx.hellCamera.y = worldToHellY(wy) - ctx.viewport.height / (2 * scale);
  clampHellCamera(ctx, scale);
}
export function currentHellScale(ctx: RenderContext): number {
  // hellZoom ramps 0 (overworld zoom) → 1 (fully zoomed out).
  const k = Math.max(0, Math.min(1, ctx.hellZoom));
  const factor = 1 + (HELL.zoomedOutScale - 1) * k;
  return ctx.renderScale * factor;
}

// Visual zoom for the world/space/hell layers, keyed off the smaller viewport
// dimension. Desktop/tablet keep the authored RENDER_SCALE; phone-sized
// viewports zoom out proportionally so more of the world is visible at once,
// floored so goblins/buildings stay legible and tappable.
export function computeRenderScale(viewportW: number, viewportH: number): number {
  const minDim = Math.min(viewportW, viewportH);
  const REFERENCE = 720;
  const FLOOR = 0.72;
  if (minDim >= REFERENCE) return RENDER_SCALE;
  return Math.max(FLOOR, RENDER_SCALE * (minDim / REFERENCE));
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
  const starA = smoothstep(0.55, 0.98, a);
  if (starA > 0.01) {
    for (const s of ctx.transStars) {
      const tw = 0.55 + 0.45 * Math.sin(now * 2.5 + s.phase);
      sg.circle(s.fx * W, s.fy * H, s.r).fill({ color: 0xffffff, alpha: starA * tw });
    }
  }

  // Clouds drift past as we climb through their altitude band. Cloud opacity
  // is keyed to where the cloud sits on screen (0 = top, 1 = bottom): each
  // cloud blooms as it enters from the top, peaks while crossing the middle,
  // and fades as it exits the bottom. That keeps the cloud field anchored
  // to the bright-blue band in the centre of the sky rather than popping in
  // at a fixed altitude.
  const cg = ctx.cloudGfx;
  cg.clear();
  for (const c of ctx.transClouds) {
    const yFrac = (hTop - c.h) / span;
    if (yFrac < -0.2 || yFrac > 1.2) continue;
    const fadeIn = smoothstep(-0.15, 0.30, yFrac);
    const fadeOut = 1 - smoothstep(0.70, 1.15, yFrac);
    const fade = fadeIn * fadeOut;
    if (fade <= 0.01) continue;
    const y = H * yFrac;
    const cx = c.fx * W;
    for (const [px, py, pr] of c.puffs) {
      cg.circle(cx + px * c.scale, y + py * c.scale, pr * c.scale * 0.6)
        .fill({ color: 0xf2f6ff, alpha: 0.55 * fade });
    }
  }
}

export function render(state: GameState, ctx: RenderContext) {
  // Apply camera by translating the world layer (UI overlays in DOM stay fixed).
  // Camera is in world units; multiply by ctx.renderScale to get screen pixels.
  // When the viewport is larger than the scaled world, center the world.
  const scaledW = WORLD.width * ctx.renderScale;
  const scaledH = WORLD.height * ctx.renderScale;
  const offsetX = Math.max(0, (ctx.viewport.width - scaledW) / 2);
  const offsetY = Math.max(0, (ctx.viewport.height - scaledH) / 2);
  // As the climb begins, slide the whole ground scene downward (and back up
  // on descent) so the play area visibly drops away beneath you rather than
  // just fading in place under the sky. The mirror on the descent to hell
  // slides the ground UPWARD off the top of the screen, so the player feels
  // the surface receding overhead as they descend. Synced to the ground's
  // fade-out range in both directions.
  const climbDrop = smoothstep(0.02, 0.22, ctx.altitude) * ctx.viewport.height * 0.35;
  const descendLift = -smoothstep(0.02, 0.22, ctx.depth) * ctx.viewport.height * 0.35;
  ctx.worldLayer.position.set(
    Math.round(offsetX - ctx.camera.x * ctx.renderScale),
    Math.round(offsetY - ctx.camera.y * ctx.renderScale + climbDrop + descendLift),
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
  drawBobPicker(ctx, state);

  // Floaters: rising fading text. Sim adds & expires; renderer just animates.
  drawFloaters(ctx, state);

  // Death effects: spawn a one-shot GifSprite per new entry; the sim expires
  // entries after a couple seconds and we tear the sprite down with them.
  drawDeathEffects(ctx, state);

  // Attach the force-white matrix only while there are scorch sprites to
  // recolor; an attached filter renders the layer to an offscreen texture
  // every frame even when the layer is empty (the common case).
  const wantWhiteFilter = ctx.whiteEffectsLayer.children.length > 0;
  const hasWhiteFilter = Array.isArray(ctx.whiteEffectsLayer.filters) && ctx.whiteEffectsLayer.filters.length > 0;
  if (wantWhiteFilter !== hasWhiteFilter) {
    ctx.whiteEffectsLayer.filters = wantWhiteFilter ? [ctx.whiteFilter] : [];
  }

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
    applyRingFlash(v.selectionRing, g.selected, g.commandFlashAt, state.now);
    // Robots are scaled-down goblins (a small grey chassis) — size, tint and
    // the greyscale pass are all live dev options.
    const px = g.robot ? displayPx * opts.robotScale : displayPx;
    // Shadow under the feet — anchored at sprite center, offset down to feet.
    v.shadow.visible = opts.goblinShadow;
    if (opts.goblinShadow) {
      v.shadow.position.set(0, px * 0.32);
      const sy = px / 64;
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
      const sc = px / sheet.meta.spriteSize;
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
    // Robots are always their flat grey — the chassis doesn't blush for
    // water duty or anything else.
    if (g.robot) tint = opts.robotTint;
    // Water carriers tint blue only while actually hauling water back to the
    // DC (phase to_dc). On the outbound walk to the source they look normal.
    else if (g.state.kind === 'fetching_water' && g.state.phase === 'to_dc') tint = opts.waterGoblinColor;
    else if (g.gold) tint = 0xffa800;
    else if (g.state.kind === 'building' || g.state.kind === 'going_to_build') tint = 0xfff0a8;
    else if (g.state.kind === 'maintaining' || g.state.kind === 'going_to_maintain') tint = 0xa8d8ff;
    v.sprite.tint = tint;
    setSpriteGreyscale(v.sprite, !!g.robot && opts.robotGreyscale);
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
    applyRingFlash(v.selectionRing, t.selected, t.commandFlashAt, state.now);
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

  // Dragons — fly-sheet sprites that bob, glow, and flush red while breathing
  // fire on a commanded kill. While carrying, the lifted building rides beneath.
  const seenD = new Set<number>();
  for (const d of state.dragons.values()) {
    seenD.add(d.id);
    let v = ctx.dragonViews.get(d.id);
    if (!v) {
      v = makeDragonView(d);
      v.container.cullable = true;
      ctx.dragonLayer.addChild(v.container);
      ctx.dragonViews.set(d.id, v);
    }
    v.container.position.set(d.pos.x, d.pos.y);
    // The sim only mirrors dragons left/right, so derive the 8-way heading
    // from actual movement; while hovering, hold the last real heading.
    const mvX = d.pos.x - v.lastX, mvY = d.pos.y - v.lastY;
    if (Math.abs(mvX) > 0.05 || Math.abs(mvY) > 0.05) v.heading = Math.atan2(mvY, mvX);
    v.lastX = d.pos.x;
    v.lastY = d.pos.y;
    const phase = state.now - d.spawnAt;
    const breathing = d.state.kind === 'going_to_kill' && d.state.attackAt !== undefined;
    const bob = Math.sin(phase * 2.2) * 3;
    // Live-tunable from the admin cog (Dragons section).
    const dragonPx = opts.dragonDisplayPx;
    v.sprite.y = bob + opts.dragonSpriteYOffset;
    v.sprite.tint = breathing ? 0xff5a2a : 0xffffff;
    const sheet = dragonFlySheet;
    if (sheet) {
      const dir = dirIndex(sheet.meta, v.heading);
      const fpd = sheet.meta.framesPerDirection;
      // phase (not raw now) keys the flap so each dragon beats independently.
      const frame = Math.floor(phase * sheet.fps) % fpd;
      v.sprite.texture = sheet.frames[dir][frame];
      v.sprite.scale.set(dragonPx / sheet.meta.spriteSize);
    }
    v.glow.scale.set(dragonPx * 1.3 / 128);
    v.glow.alpha = breathing ? 0.6 : 0.18 + 0.06 * Math.sin(state.now * 3);
    applyRingFlash(v.selectionRing, d.selected, d.commandFlashAt, state.now);
    if (d.carrying) {
      const def = defOf(d.carrying);
      const tex = buildingTextures[d.carrying.kind];
      if (tex && v.carried.texture !== tex) { v.carried.texture = tex; sizeBuildingSprite(v.carried, def.size * 0.8); }
      v.carried.tint = 0xffffff;
      setSpriteGreyscale(v.carried, false);
      v.carried.visible = opts.buildingSpriteEnabled;
      v.carried.position.set(0, dragonPx * 0.38);
    } else if (d.carryingUnit) {
      // A snatched unit dangles where a hauled building would — drawn from
      // its own walk/idle sheet (facing south, frame 0) with the unit's tint.
      const u = d.carryingUnit;
      const sheet = u.kind === 'minotaur' ? minotaurWalkSheet : (goblinIdleSheet ?? goblinWalkSheet);
      if (sheet) {
        const tex = sheet.frames[dirIndex(sheet.meta, Math.PI / 2)][0];
        if (v.carried.texture !== tex) v.carried.texture = tex;
        const px = u.kind === 'minotaur'
          ? (u.tiny ? opts.minotaurDisplayPx * TINYTAUR.scale : opts.minotaurDisplayPx)
          : (u.robot ? opts.goblinDisplayPx * opts.robotScale : opts.goblinDisplayPx);
        v.carried.scale.set(px / sheet.meta.spriteSize);
        v.carried.tint = u.robot ? opts.robotTint : u.gold ? 0xffa800 : 0xffffff;
        setSpriteGreyscale(v.carried, !!u.robot && opts.robotGreyscale);
        v.carried.visible = true;
        v.carried.position.set(0, dragonPx * 0.34);
      }
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
    applyRingFlash(v.selectionRing, w.selected, w.commandFlashAt, state.now);
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
    applyRingFlash(v.selectionRing, b.selected, b.commandFlashAt, state.now);
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
    const scaledW = SPACE.width * ctx.renderScale;
    const scaledH = SPACE.height * ctx.renderScale;
    const offX = Math.max(0, (ctx.viewport.width - scaledW) / 2);
    const offY = Math.max(0, (ctx.viewport.height - scaledH) / 2);
    // Mirror the ground's climb-slide: as the ground drops away beneath you on
    // ascent, the whole space scene (stars, buildings, ambient dragons) drops
    // into place from above rather than just fading in. Settles to 0 once you're
    // fully in orbit; lifts back up off the top on descent.
    const spaceSlide = -(1 - smoothstep(0.82, 1.0, ctx.altitude)) * ctx.viewport.height * 0.4;
    ctx.spaceLayer.position.set(
      Math.round(offX - ctx.spaceCamera.x * ctx.renderScale),
      Math.round(offY - ctx.spaceCamera.y * ctx.renderScale + spaceSlide),
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
    // Orbital Platform assembly state: dim scaffold + yellow build bar while
    // constructing, with a "needs robot" tag whenever no robot is on site.
    const sbDef = BUILDING_DEFS[sb.building.kind];
    v.progress.clear();
    if (sb.building.state === 'constructing') {
      if (v.body) v.body.alpha = 0.55;
      const w = sbDef.size - 10;
      const h = 5;
      const y = sbDef.size / 2 + 8;
      v.progress.rect(-w / 2, y, w, h).fill({ color: 0x000000, alpha: 0.6 }).stroke({ width: 1, color: 0x000000 });
      v.progress.rect(-w / 2, y, w * sb.building.buildProgress, h).fill(0xffd96b);
      let onSite = 0;
      for (const su of state.spaceUnits.values()) {
        if (!su.robot) continue;
        if (Math.hypot(su.pos.x - sb.pos.x, su.pos.y - sb.pos.y) <= sbDef.size / 2 + ROBOT.buildRange) onSite++;
      }
      v.warning.visible = onSite === 0;
    } else {
      if (v.body) v.body.alpha = 1;
      v.warning.visible = false;
    }
  }
  for (const [id, v] of ctx.spaceBuildingViews) {
    if (!seenSB.has(id)) {
      v.container.destroy({ children: true });
      ctx.spaceBuildingViews.delete(id);
    }
  }

  // Units adrift in the void: snatched goblins/minotaurs tumbling out their
  // last seconds, and the robots that survive (squared-up and walking while
  // they work a platform; tumbling like everyone else when idle).
  const seenSU = new Set<number>();
  for (const su of state.spaceUnits.values()) {
    seenSU.add(su.id);
    let v = ctx.spaceUnitViews.get(su.id);
    if (!v) {
      v = makeSpaceUnitView();
      v.container.cullable = true;
      ctx.spaceLayer.addChild(v.container);
      ctx.spaceUnitViews.set(su.id, v);
    }
    v.container.position.set(su.pos.x, su.pos.y);
    v.container.rotation = su.spin;
    const suSheet = su.kind === 'minotaur' ? minotaurWalkSheet : (goblinIdleSheet ?? goblinWalkSheet);
    if (suSheet) {
      const dir = dirIndex(suSheet.meta, su.facing);
      const frame = su.robot && su.workingOn !== undefined
        ? Math.floor(state.now * suSheet.fps) % suSheet.meta.framesPerDirection
        : 0;
      v.sprite.texture = suSheet.frames[dir][frame];
      const px = su.kind === 'minotaur'
        ? (su.tiny ? opts.minotaurDisplayPx * TINYTAUR.scale : opts.minotaurDisplayPx)
        : (su.robot ? opts.goblinDisplayPx * opts.robotScale : opts.goblinDisplayPx);
      v.sprite.scale.set(px / suSheet.meta.spriteSize);
    }
    v.sprite.tint = su.robot ? opts.robotTint : su.gold ? 0xffa800 : 0xffffff;
    setSpriteGreyscale(v.sprite, !!su.robot && opts.robotGreyscale);
    v.selectionRing.visible = !!su.selected;
  }
  for (const [id, v] of ctx.spaceUnitViews) {
    if (!seenSU.has(id)) {
      v.container.destroy({ children: true });
      ctx.spaceUnitViews.delete(id);
    }
  }

  // Orbital Platform placement ghost — mirrors the ground building ghost:
  // a translucent footprint rect under the cursor, blue when the deploy
  // would land (clamped into bounds, affordably) and red when Ƶ runs short.
  {
    const og = ctx.orbitalGhostGfx;
    og.clear();
    if (state.view === 'space' && state.pendingOrbital && ctx.orbitalCursor) {
      const def = BUILDING_DEFS.orbital_platform;
      // Same clamp tryPlaceOrbital applies, so the preview sits exactly where
      // the platform would actually land.
      const px = Math.max(SPACE_UNIT.margin, Math.min(SPACE.width - SPACE_UNIT.margin, ctx.orbitalCursor.x));
      const py = Math.max(SPACE_UNIT.margin, Math.min(SPACE.height - SPACE_UNIT.margin, ctx.orbitalCursor.y));
      const valid = state.money >= def.cost;
      const color = valid ? 0x6a8eb0 : 0xd96b6b;
      const half = def.size / 2;
      og.rect(px - half, py - half, def.size, def.size)
        .fill({ color, alpha: 0.25 })
        .stroke({ width: 2, color });
      // Building views are appended to spaceLayer as they're created —
      // re-append the ghost while armed so it always draws on top.
      ctx.spaceLayer.addChild(og);
    }
  }

  // Bob's nametag(s) — synced across all scenes after every host has moved.
  syncBobTags(ctx, state);

  // ─── Hell red beam ───
  // One vertical red line per Hell Portal, drawn from the portal's
  // bottom-center down toward the world's bottom edge. Animates its length
  // in over HELL.lineDrawMs after state.hellPortalPlacedAt.
  drawHellBeams(ctx, state);

  // ─── Hell scene ───
  // Position the hell layer with its own camera + dynamic scale. Scale eases
  // out (RENDER_SCALE → RENDER_SCALE * HELL.zoomedOutScale) after arrival.
  {
    const scale = currentHellScale(ctx);
    ctx.hellLayer.scale.set(scale);
    const scaledW = HELL.width * scale;
    const scaledH = HELL.height * scale;
    const offX = Math.max(0, (ctx.viewport.width - scaledW) / 2);
    const offY = Math.max(0, (ctx.viewport.height - scaledH) / 2);
    // Mirror the space slide-in but in the opposite direction: as the ground
    // drops away, hell rises into view from below.
    const hellSlide = (1 - smoothstep(0.82, 1.0, ctx.depth)) * ctx.viewport.height * 0.4;
    const hellOriginX = offX - ctx.hellCamera.x * scale;
    const hellOriginY = offY - ctx.hellCamera.y * scale + hellSlide;
    ctx.hellLayer.position.set(Math.round(hellOriginX), Math.round(hellOriginY));
    // Keep the demon-parlay speech bubble pinned over the speaker's head.
    positionParlaySpeech(
      ctx, scale,
      (hx) => hellOriginX + hx * scale,
      (hy) => hellOriginY + hy * scale,
    );
  }
  // Soul sigil: inner ring, chairs, pentagram edges + ritual VFX.
  syncSoulSigil(ctx, state);
  // Sync ghost views with state.ghosts. Each ghost drifts downward at
  // hellGhostFallSpeed (px/sec) from its hell-mapped spawn point; the sim
  // tick prunes ghosts whose y has crossed HELL.height so a view that
  // existed last frame may be gone from state.ghosts this frame.
  const seenGh = new Set<number>();
  const fall = opts.hellGhostFallSpeed;
  const ghostAlpha = opts.hellGhostAlpha;
  for (const gh of state.ghosts) {
    seenGh.add(gh.id);
    let v = ctx.ghostViews.get(gh.id);
    if (!v) {
      const made = makeGhostView(gh);
      if (!made) continue;
      made.container.cullable = true;
      ctx.hellGhostLayer.addChild(made.container);
      ctx.ghostViews.set(gh.id, made);
      v = made;
    }
    // Once a ghost has been touched by the sim (commanded to walk, or just
    // selected), its position is tracked explicitly via hx/hy. Otherwise the
    // hell-y is derived from spawnAt+drift with the per-ghost speed multiplier.
    let hx: number;
    let hy: number;
    if (gh.hx !== undefined && gh.hy !== undefined) {
      hx = gh.hx;
      hy = gh.hy;
    } else {
      // speedMult drives drift only — passive jitter so ghosts don't fall in
      // lockstep. Bob's drift mult is 0, so he stays put until commanded.
      const driftMult = gh.speedMult ?? 1;
      hx = worldToHellX(gh.x + (gh.offX ?? 0));
      hy = worldToHellY(gh.y + (gh.offY ?? 0)) + (state.now - gh.spawnAt) * fall * driftMult;
    }
    v.container.position.set(hx, hy);
    v.container.alpha = ghostAlpha;
    applyRingFlash(v.selectionRing, !!gh.selected, gh.commandFlashAt, state.now);
    // Keep the silhouette's facing frame live — pacing Bob and commanded
    // walkers turn to face their direction of travel. (The frame used to be
    // baked once at creation.) Dragon ghosts mirror via container scale instead.
    if (gh.kind === 'goblin' || gh.kind === 'minotaur') {
      const sheet = gh.kind === 'goblin' ? (goblinIdleSheet ?? goblinWalkSheet) : minotaurWalkSheet;
      if (sheet) v.sprite.texture = sheet.frames[dirIndex(sheet.meta, gh.facing)][0];
    }
  }
  for (const [id, v] of ctx.ghostViews) {
    if (!seenGh.has(id)) {
      v.container.destroy({ children: true });
      ctx.ghostViews.delete(id);
    }
  }

  // Sync demon views — the giant patrolling Minotaur. Sass-walks while pacing;
  // freezes on frame 0 while locked in a parlay.
  const seenDe = new Set<number>();
  for (const d of state.demons.values()) {
    seenDe.add(d.id);
    let v = ctx.demonViews.get(d.id);
    if (!v) {
      v = makeDemonView();
      v.container.cullable = true;
      ctx.demonLayer.addChild(v.container);
      ctx.demonViews.set(d.id, v);
    }
    v.container.position.set(d.hx, d.hy);
    // Per-demon size (the colossus is 1; Lilly rides demonLScale, Lolly
    // demonFriendScale) times the all-demons dev dial — scales the whole
    // view (sprite + shadow + ring) around the demon's hell position.
    v.container.scale.set(opts.demonScale * demonScaleOf(d));
    applyRingFlash(v.selectionRing, d.selected, d.commandFlashAt, state.now);
    // Per-demon dev dials: sprite Y nudge relative to the selection circle /
    // collision centre (the ring and body stay put; only the art moves), and
    // a per-demon tint over the shared minotaur art.
    const demonVariant = d.variant ?? 'pit';
    v.sprite.y = demonVariant === 'l' ? opts.demonLSpriteYOffset
      : demonVariant === 'friend' ? opts.demonFriendSpriteYOffset
      : opts.demonRSpriteYOffset;
    v.sprite.tint = demonVariant === 'l' ? opts.demonLTint
      : demonVariant === 'friend' ? opts.demonFriendTint
      : opts.demonRTint;
    v.shadow.visible = opts.goblinShadow;
    if (opts.goblinShadow) {
      // The demon sprite isn't raised the way Minotaurs are, so its feet sit
      // around ≈0.3 of its half-height below centre — park the shadow there
      // rather than the old 0.55, which floated it well below the hooves.
      v.shadow.position.set(0, DEMON.displayPx * 0.3);
      const sy = DEMON.displayPx / 64;
      v.shadow.scale.set(sy * 0.75, sy);
    }
    const sheet = minotaurWalkSheet;
    if (sheet) {
      const dir = dirIndex(sheet.meta, d.facing);
      const fpd = sheet.meta.framesPerDirection;
      // Freeze on the standing frame while locked in a parlay or when the
      // dev "walks" toggle has parked it.
      const standing = d.busyWith !== null || !opts.demonWalks;
      const frame = standing ? 0 : Math.floor(state.now * sheet.fps) % fpd;
      v.sprite.texture = sheet.frames[dir][frame];
      v.sprite.scale.set(DEMON.displayPx / sheet.meta.spriteSize);
    }
  }
  for (const [id, v] of ctx.demonViews) {
    if (!seenDe.has(id)) {
      v.container.destroy({ children: true });
      ctx.demonViews.delete(id);
    }
  }

  // Sync the hell-side portal mirrors with every overworld hell_portal.
  // Each mirror lives at the same world coord (mapped into hell space) as
  // its source. Pulse the core's alpha so the portal reads as alive.
  const seenMir = new Set<number>();
  for (const b of state.buildings.values()) {
    if (b.kind !== 'hell_portal') continue;
    seenMir.add(b.id);
    let m = ctx.hellPortalMirrors.get(b.id);
    if (!m) {
      m = makeHellPortalMirror(b);
      m.cullable = true;
      ctx.hellPortalMirrorLayer.addChild(m);
      ctx.hellPortalMirrors.set(b.id, m);
    }
    // Gentle red pulse on the core; whole mirror dimmer while still building.
    // Child order in makeHellPortalMirror: 0 halo, 1 body, 2 core.
    const core = m.children[2] as Graphics;
    if (core) core.alpha = b.state === 'constructing' ? 0.25 : (0.55 + 0.25 * Math.sin(state.now * 2.4));
    m.alpha = b.state === 'constructing' ? 0.5 : 1;
  }
  for (const [id, m] of ctx.hellPortalMirrors) {
    if (!seenMir.has(id)) {
      m.destroy({ children: true });
      ctx.hellPortalMirrors.delete(id);
    }
  }

  // Scene cross-fades driven by altitude (0 ground … 1 space) and depth
  // (0 ground … 1 hell). The climb runs in three overlapping phases so
  // nothing pops:
  //  • blackOverlay fades in *over* the ground first, dimming the play area
  //    toward black before any sky shows up,
  //  • once the screen is dark, the sky gradient fades in over the black
  //    (clouds drift past as we climb through the blue band),
  //  • the sky dissolves near the top while the space diorama fades up
  //    underneath it.
  // z-order: world < black < hell < space < sky.
  const a = ctx.altitude;
  const dp = ctx.depth;
  // Black overlay takes the lead during ascent or descent: it's fully opaque
  // well before the destination scene becomes visible, so the bright
  // intermediate (sky on ascent, none on descent) never punches in over a
  // partially-faded play area.
  const blackFromAscent = smoothstep(0.02, 0.20, a);
  const blackFromDescent = smoothstep(0.05, 0.55, dp) * (1 - smoothstep(0.78, 1.0, dp));
  const blackFade = Math.max(blackFromAscent, blackFromDescent);
  const groundFade = (1 - smoothstep(0.04, 0.18, a)) * (1 - smoothstep(0.04, 0.18, dp));
  // Sky waits until the screen is dark, then blooms in. Holds through the
  // middle of the climb, then fades as space takes over. Only during the
  // ascent — descent has no daylight phase.
  const skyFade = a > 0
    ? Math.min(smoothstep(0.18, 0.45, a), 1 - smoothstep(0.82, 1.0, a))
    : 0;
  const spaceFade = smoothstep(0.82, 1.0, a);
  // Hell fades up under the descent's black overlay near the bottom of the
  // descent, mirroring how space fades up under the sky on ascent.
  const hellFade = smoothstep(0.78, 1.0, dp);

  ctx.worldLayer.visible = groundFade > 0.001;
  ctx.worldLayer.alpha = groundFade;
  if (blackFade > 0.001) {
    if (!ctx.blackOverlay.visible) ctx.blackOverlay.visible = true;
    ctx.blackOverlay.clear();
    ctx.blackOverlay.rect(0, 0, ctx.viewport.width, ctx.viewport.height).fill(0x000000);
    ctx.blackOverlay.alpha = blackFade;
  } else if (ctx.blackOverlay.visible) {
    ctx.blackOverlay.visible = false;
  }
  ctx.spaceLayer.visible = spaceFade > 0.001;
  ctx.spaceLayer.alpha = spaceFade;
  ctx.hellLayer.visible = hellFade > 0.001;
  ctx.hellLayer.alpha = hellFade;
  ctx.skyLayer.visible = skyFade > 0.001;
  ctx.skyLayer.alpha = skyFade;
  if (ctx.skyLayer.visible) drawTransition(ctx, a, state.now);
}

// Paint the red beam(s) from every built Hell Portal: a downward shaft on
// the overworld (top of worldLayer) and a matching upward shaft on the
// hell-side mirror portal (top of hellLayer). Each portal's beam draws in
// over HELL.lineDrawMs starting at its construction completion. Portals
// still under construction don't show a beam yet.
function drawHellBeams(ctx: RenderContext, state: GameState): void {
  const ground = ctx.hellBeamGfx;
  const hell = ctx.hellSideBeamGfx;
  ground.clear();
  hell.clear();
  for (const b of state.buildings.values()) {
    if (b.kind !== 'hell_portal') continue;
    if (b.state === 'constructing') continue;
    if (b.activatedAt === undefined) continue;
    const elapsedMs = (state.now - b.activatedAt) * 1000;
    const drawFrac = Math.max(0, Math.min(1, elapsedMs / HELL.lineDrawMs));
    if (drawFrac <= 0) continue;
    const c = buildingCenter(b);
    const def = defOf(b);
    // Downward beam on the overworld — animates from the portal-bottom toward
    // the world bottom edge, but once the draw-in finishes we extend the line
    // well past WORLD.height. During the descent transition the world layer
    // lifts upward off-screen; without the extension the beam would terminate
    // at the world boundary mid-frame and read as a visibly cut-off red stub.
    const downStartY = c.y + def.size / 2;
    const animSpan = WORLD.height - downStartY;
    const overshoot = ctx.viewport.height / ctx.renderScale; // enough to clear any descent lift
    if (animSpan > 0) {
      const animEnd = downStartY + animSpan * drawFrac;
      // Once the line has drawn the full animSpan, extend past WORLD.height
      // into the OOB region. Off-screen in normal play; uncovered + visible
      // when the world layer lifts up during the hell-descent transition.
      const y2 = drawFrac >= 1 ? animEnd + overshoot : animEnd;
      strokeBeam(ground, c.x, downStartY, c.x, y2);
    }
    // Upward beam on the hell side — terminates at the mirror portal's
    // CENTER (not its top edge) so the line reads as plunging into the
    // beacon rather than capping above it.
    const hx = worldToHellX(c.x);
    const hyEnd = worldToHellY(c.y);
    const upSpan = hyEnd;
    if (upSpan > 0) {
      const y2 = hyEnd - upSpan * drawFrac;
      strokeBeam(hell, hx, hyEnd, hx, y2);
    }
  }
}

// Three-pass stroke (halo + glow + bright core) used by both the downward
// and upward beams. Shared so the two pillars read as one continuous shaft.
function strokeBeam(g: Graphics, x1: number, y1: number, x2: number, y2: number): void {
  g.moveTo(x1, y1).lineTo(x2, y2)
    .stroke({ width: 14, color: HELL.lineColor, alpha: 0.22 });
  g.moveTo(x1, y1).lineTo(x2, y2)
    .stroke({ width: 6, color: HELL.lineColor, alpha: 0.55 });
  g.moveTo(x1, y1).lineTo(x2, y2)
    .stroke({ width: 2, color: 0xffd0d0, alpha: 0.95 });
}
