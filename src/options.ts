import type { SoundName } from './audio';
import { DEMON, HELL, SOUL_SIGIL } from './config';

export type BgPattern = 'solid' | 'checker';

// ─── Fonts ──────────────────────────────────────────────────────────
// Curated families. Anything with a `url` lazy-loads on first use so the cold
// page-load only ships the bundled fonts (New Rocker + Audiowide + VT323 +
// Major Mono Display, declared in index.html).
export type FontFamily = {
  id: string;
  label: string;
  css: string;     // CSS font-family stack
  url?: string;    // Google Fonts CSS URL; undefined = bundled in index.html
};

export const FONT_FAMILIES: FontFamily[] = [
  { id: 'system',      label: 'System',          css: 'system-ui, -apple-system, "Segoe UI", sans-serif' },
  { id: 'audiowide',   label: 'Audiowide',       css: '"Audiowide", system-ui, sans-serif' },
  { id: 'vt323',       label: 'VT323',           css: '"VT323", "Consolas", monospace' },
  { id: 'orbitron',    label: 'Orbitron',        css: '"Orbitron", system-ui, sans-serif',
    url: 'https://fonts.googleapis.com/css2?family=Orbitron:wght@500;700&display=swap' },
  { id: 'shareTech',   label: 'Share Tech Mono', css: '"Share Tech Mono", "Consolas", monospace',
    url: 'https://fonts.googleapis.com/css2?family=Share+Tech+Mono&display=swap' },
  { id: 'pressStart',  label: 'Press Start 2P',  css: '"Press Start 2P", "Consolas", monospace',
    url: 'https://fonts.googleapis.com/css2?family=Press+Start+2P&display=swap' },
  { id: 'majorMono',   label: 'Major Mono',      css: '"Major Mono Display", "Consolas", monospace',
    url: 'https://fonts.googleapis.com/css2?family=Major+Mono+Display&display=swap' },
  { id: 'bebas',       label: 'Bebas Neue',      css: '"Bebas Neue", sans-serif',
    url: 'https://fonts.googleapis.com/css2?family=Bebas+Neue&display=swap' },
  { id: 'jetbrains',   label: 'JetBrains Mono',  css: '"JetBrains Mono", "Consolas", monospace',
    url: 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&display=swap' },
  { id: 'inter',       label: 'Inter',           css: '"Inter", system-ui, sans-serif',
    url: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;600&display=swap' },
  // Local-only fallbacks: rely on the OS having these installed (no Google
  // Fonts URL). If the user's system lacks them they fall back to the listed
  // generics, which is fine.
  { id: 'russoOne',    label: 'Russo One',       css: '"Russo One", system-ui, sans-serif',
    url: 'https://fonts.googleapis.com/css2?family=Russo+One&display=swap' },
  { id: 'spaceGrotesk', label: 'Space Grotesk',  css: '"Space Grotesk", system-ui, sans-serif',
    url: 'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;600&display=swap' },
  { id: 'robotoMono',  label: 'Roboto Mono',     css: '"Roboto Mono", "Consolas", monospace',
    url: 'https://fonts.googleapis.com/css2?family=Roboto+Mono:wght@400;500&display=swap' },
  { id: 'ibmPlexMono', label: 'IBM Plex Mono',   css: '"IBM Plex Mono", "Consolas", monospace',
    url: 'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&display=swap' },
  { id: 'anton',       label: 'Anton',           css: '"Anton", system-ui, sans-serif',
    url: 'https://fonts.googleapis.com/css2?family=Anton&display=swap' },
  { id: 'cinzel',      label: 'Cinzel',          css: '"Cinzel", serif',
    url: 'https://fonts.googleapis.com/css2?family=Cinzel:wght@400;700&display=swap' },
  { id: 'playfair',    label: 'Playfair Display', css: '"Playfair Display", serif',
    url: 'https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;700&display=swap' },
  { id: 'merriweather', label: 'Merriweather',   css: '"Merriweather", serif',
    url: 'https://fonts.googleapis.com/css2?family=Merriweather:wght@400;700&display=swap' },
  { id: 'lora',        label: 'Lora',            css: '"Lora", serif',
    url: 'https://fonts.googleapis.com/css2?family=Lora:wght@400;600&display=swap' },
  { id: 'ebGaramond',  label: 'EB Garamond',     css: '"EB Garamond", serif',
    url: 'https://fonts.googleapis.com/css2?family=EB+Garamond:wght@400;600&display=swap' },
  { id: 'cormorant',   label: 'Cormorant Garamond', css: '"Cormorant Garamond", serif',
    url: 'https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;600&display=swap' },
  { id: 'crimsonPro',  label: 'Crimson Pro',     css: '"Crimson Pro", serif',
    url: 'https://fonts.googleapis.com/css2?family=Crimson+Pro:wght@400;600&display=swap' },
  { id: 'libreBaskerville', label: 'Libre Baskerville', css: '"Libre Baskerville", serif',
    url: 'https://fonts.googleapis.com/css2?family=Libre+Baskerville:wght@400;700&display=swap' },
  { id: 'dmSerif',     label: 'DM Serif Display', css: '"DM Serif Display", serif',
    url: 'https://fonts.googleapis.com/css2?family=DM+Serif+Display&display=swap' },
  { id: 'spectral',    label: 'Spectral',        css: '"Spectral", serif',
    url: 'https://fonts.googleapis.com/css2?family=Spectral:wght@400;600&display=swap' },
  { id: 'breeSerif',   label: 'Bree Serif',      css: '"Bree Serif", serif',
    url: 'https://fonts.googleapis.com/css2?family=Bree+Serif&display=swap' },
  { id: 'oldStandard', label: 'Old Standard TT', css: '"Old Standard TT", serif',
    url: 'https://fonts.googleapis.com/css2?family=Old+Standard+TT:wght@400;700&display=swap' },
  { id: 'unifrakturMaguntia', label: 'UnifrakturMaguntia', css: '"UnifrakturMaguntia", serif',
    url: 'https://fonts.googleapis.com/css2?family=UnifrakturMaguntia&display=swap' },
  { id: 'unifrakturCook', label: 'UnifrakturCook',  css: '"UnifrakturCook", serif',
    url: 'https://fonts.googleapis.com/css2?family=UnifrakturCook:wght@700&display=swap' },
  { id: 'pirataOne',   label: 'Pirata One',      css: '"Pirata One", serif',
    url: 'https://fonts.googleapis.com/css2?family=Pirata+One&display=swap' },
  { id: 'medievalSharp', label: 'MedievalSharp', css: '"MedievalSharp", cursive',
    url: 'https://fonts.googleapis.com/css2?family=MedievalSharp&display=swap' },
  { id: 'newRocker',   label: 'New Rocker',      css: '"New Rocker", system-ui, serif',
    url: 'https://fonts.googleapis.com/css2?family=New+Rocker&display=swap' },
  { id: 'macondo',     label: 'Macondo',         css: '"Macondo", system-ui, cursive',
    url: 'https://fonts.googleapis.com/css2?family=Macondo&display=swap' },
  { id: 'imFellEnglish', label: 'IM Fell English', css: '"IM Fell English", serif',
    url: 'https://fonts.googleapis.com/css2?family=IM+Fell+English:ital@0;1&display=swap' },
  { id: 'imFellDWPica', label: 'IM Fell DW Pica', css: '"IM Fell DW Pica", serif',
    url: 'https://fonts.googleapis.com/css2?family=IM+Fell+DW+Pica&display=swap' },
  { id: 'cinzelDecor', label: 'Cinzel Decorative', css: '"Cinzel Decorative", serif',
    url: 'https://fonts.googleapis.com/css2?family=Cinzel+Decorative:wght@400;700;900&display=swap' },
  { id: 'almendraSC',  label: 'Almendra SC',     css: '"Almendra SC", serif',
    url: 'https://fonts.googleapis.com/css2?family=Almendra+SC&display=swap' },
  { id: 'caudex',      label: 'Caudex',          css: '"Caudex", serif',
    url: 'https://fonts.googleapis.com/css2?family=Caudex:wght@400;700&display=swap' },
  { id: 'henny',       label: 'Henny Penny',     css: '"Henny Penny", system-ui, cursive',
    url: 'https://fonts.googleapis.com/css2?family=Henny+Penny&display=swap' },
  { id: 'nosifer',     label: 'Nosifer',         css: '"Nosifer", cursive',
    url: 'https://fonts.googleapis.com/css2?family=Nosifer&display=swap' },
  { id: 'butcherman',  label: 'Butcherman',      css: '"Butcherman", cursive',
    url: 'https://fonts.googleapis.com/css2?family=Butcherman&display=swap' },
  { id: 'eater',       label: 'Eater',           css: '"Eater", cursive',
    url: 'https://fonts.googleapis.com/css2?family=Eater&display=swap' },
  { id: 'rye',         label: 'Rye',             css: '"Rye", serif',
    url: 'https://fonts.googleapis.com/css2?family=Rye&display=swap' },
  { id: 'astloch',     label: 'Astloch',         css: '"Astloch", cursive',
    url: 'https://fonts.googleapis.com/css2?family=Astloch:wght@400;700&display=swap' },
  { id: 'quicksand',   label: 'Quicksand',       css: '"Quicksand", system-ui, sans-serif',
    url: 'https://fonts.googleapis.com/css2?family=Quicksand:wght@400;600&display=swap' },
  { id: 'lobster',     label: 'Lobster',         css: '"Lobster", cursive',
    url: 'https://fonts.googleapis.com/css2?family=Lobster&display=swap' },
  { id: 'creepster',   label: 'Creepster',       css: '"Creepster", cursive',
    url: 'https://fonts.googleapis.com/css2?family=Creepster&display=swap' },
  { id: 'metalMania',  label: 'Metal Mania',     css: '"Metal Mania", cursive',
    url: 'https://fonts.googleapis.com/css2?family=Metal+Mania&display=swap' },
  { id: 'comicSans',   label: 'Comic Sans',      css: '"Comic Sans MS", "Comic Sans", cursive, sans-serif' },
  { id: 'timesNewRoman', label: 'Times New Roman', css: '"Times New Roman", Times, serif' },
];

export function fontFamilyById(id: string): FontFamily {
  return FONT_FAMILIES.find(f => f.id === id) ?? FONT_FAMILIES[0];
}

const loadedFontIds = new Set<string>();
export function ensureFontLoaded(id: string): void {
  if (loadedFontIds.has(id)) return;
  loadedFontIds.add(id);
  const f = fontFamilyById(id);
  if (!f.url) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = f.url;
  document.head.appendChild(link);
}

export type FontKey = 'display' | 'mono' | 'body' | 'buildingLabel' | 'buildingWarning' | 'dialogue';
export const FONT_KEYS: { key: FontKey; label: string }[] = [
  { key: 'display',         label: 'Display (titles)' },
  { key: 'mono',            label: 'Mono (numbers)' },
  { key: 'body',            label: 'Body text' },
  { key: 'buildingLabel',   label: 'Building label' },
  { key: 'buildingWarning', label: 'Building warning' },
  { key: 'dialogue',        label: 'Talky dialogue' },
];

export type FontConfig = { family: string; scale: number };

// ─── Options shape ──────────────────────────────────────────────────
export type Options = {
  // Background
  bgPattern: BgPattern;
  bgColor: number;
  bgColor2: number;
  oobColor: number;
  // Grid
  gridVisible: boolean;
  gridColor: number;
  gridAlpha: number;
  // Walls
  wallColor: number;
  // Goblin sprites
  goblinSaturation: number;
  goblinBrightness: number;
  goblinDisplayPx: number;
  goblinShadow: boolean;
  goblinOutline: boolean;
  goblinSpriteYOffset: number;   // pixels to nudge the sprite vertically inside its cell
  // Tint applied to a goblin while it's hauling water back to a Datacentre
  // (state.kind === 'fetching_water', phase === 'to_dc').
  waterGoblinColor: number;
  // Tint applied to the blood-explosion GIF when a goblin/minotaur dies.
  bloodColor: number;
  // Minotaur sprites
  minotaurSaturation: number;
  minotaurBrightness: number;
  minotaurDisplayPx: number;
  minotaurSpriteYOffset: number;
  // Dragon sprites (summoned carriers — ambient space dragons keep config sizing)
  dragonSaturation: number;
  dragonBrightness: number;
  dragonDisplayPx: number;
  dragonSpriteYOffset: number;
  // Buildings
  buildingSaturation: number;
  buildingBrightness: number;
  // Visual layers — independently toggleable so a player who swaps in custom
  // sprites can hide the old colored body / border / short-label overlay.
  buildingSpriteEnabled: boolean;
  buildingFillEnabled: boolean;
  buildingFillAlpha: number;       // 0..1, multiplier on the body's translucent fill
  buildingBorderEnabled: boolean;
  buildingLabelEnabled: boolean;
  // Sidebar
  sidebarBg: number;
  sidebarBorder: number;
  sidebarButtonBg: number;
  sidebarButtonBorder: number;
  sidebarAccent: number;     // yellow numbers (Ƶ values, resource counters)
  sidebarTitleColor: number; // muted-gray panel titles
  sidebarButtonHoverBorder: number; // border colour on .build-button:hover
  buttonsRounded: boolean;   // build/ritual button corner rounding
  buttonsCutCorners: boolean; // clip-path octagon shape on build/ritual buttons
  buttonCutSize: number;     // cut size in px when buttonsCutCorners is on
  buttonCutBorderColor: number; // outline drawn around the octagon (drop-shadow)
  // Fonts (per-category family + size scale)
  fonts: Record<FontKey, FontConfig>;
  // Multiplier applied to every font's per-key scale. Lets the player blow
  // every label up at once without touching the individual scale sliders.
  globalFontScale: number;
  // Audio
  volume: number;        // master — applied to both SFX and music
  musicVolume: number;   // additional multiplier on background music + crackle
  crackleEnabled: boolean; // toggle the vinyl-crackle ambience layer
  // Hell visuals — live-tunable from the admin cog so the underworld's
  // contrast can be dialled in. drawHellBackground re-runs on any change.
  hellBgTop: number;          // top of the vertical gradient (dim by default)
  hellBgBottom: number;       // bottom of the vertical gradient
  hellGlowColor: number;      // tint of the soft fog blooms
  hellGlowIntensity: number;  // multiplier on every glow ring's alpha
  hellGlowSteps: number;      // concentric rings per fog bloom (more = smoother gradient)
  hellEmberCount: number;     // number of ember specks scattered across the bg
  hellEmberBrightness: number; // multiplier on every ember's alpha
  hellEmberSize: number;      // multiplier on every ember's radius (1 = native size)
  hellGhostAlpha: number;     // overall alpha applied to ghost containers
  hellGhostBrightness: number; // multiplier on ghost-layer brightness (1 = no change)
  hellGhostTint: number;      // silhouette tint (gold goblins keep their gold)
  hellGhostFallSpeed: number; // px/sec the ghosts drift downward in hell
  hellBloodColor: number;     // tint applied to the hell-side death splatters
  // The halo ring(s) around each hell-side portal mirror — the stroked
  // circles that make the portal read as an emanation in the underworld.
  hellPortalRingCount: number;   // 0 hides them entirely
  hellPortalRingRadius: number;  // innermost ring radius, as a multiple of the portal's size
  hellPortalRingSpacing: number; // px between successive rings
  hellPortalRingWidth: number;   // stroke width, px
  hellPortalRingColor: number;
  hellPortalRingAlpha: number;
  // The soul sigil's red inner ring — the occult circle drawn at the mirror,
  // inside the candle ring. Alpha is the idle level; sigil completion still
  // layers its brightening pulse on top.
  hellSigilRingRadius: number;   // hell-px (config SOUL_SIGIL.innerRadius was 110)
  hellSigilRingWidth: number;    // stroke width, px
  hellSigilRingColor: number;
  hellSigilRingAlpha: number;
  // Darkness veil — optional "lights out" pass over the hell scene: the whole
  // underworld dims toward the veil colour except fuzzy pools of visibility
  // around each portal mirror and each demon. Off by default (no veil at all).
  hellDarknessEnabled: boolean;
  hellDarknessAlpha: number;        // veil opacity (1 = pitch black outside the pools)
  hellDarknessColor: number;
  hellDarknessMirrorRadius: number; // light-pool radius around portal mirrors, hell-px
  hellDarknessDemonRadius: number;  // light-pool radius around demons (rides demon size)
  hellDarknessParlayRadius: number; // light-pool radius around a soul mid-dialogue, hell-px
  hellDarknessLightAlpha: number;   // how fully a pool cuts the veil (1 = fully clear)
  // The dialogue dim — the darkening that drops over hell while a parlay or
  // soul chat is on screen (canvas-side, so the two speakers stay lit via
  // the same fuzzy pools as the veil). Replaces the old DOM overlay dim.
  hellParlayDimAlpha: number;       // 0 disables the dim entirely
  // Arrival vignette — a tight dark ring around the landing spot when you
  // descend into hell, expanding off-screen as the camera zooms out (rides
  // hellZoom). Radii are fractions of the smaller viewport dimension.
  hellVignetteEnabled: boolean;
  hellVignetteAlpha: number;        // strength of the dark ring (1 = opaque)
  hellVignetteColor: number;
  hellVignetteStartRadius: number;  // hole radius at arrival (zoomed in)
  hellVignetteEndRadius: number;    // hole radius once fully zoomed out (>1.1 clears the corners)
  // Sprite shadows — each ghost's / demon's own art flipped vertically,
  // tinted dark, and mirrored about its feet like a reflection in the abyss.
  hellSpriteShadowGhosts: boolean;  // flipped-copy shadows under the souls
  hellSpriteShadowDemons: boolean;  // flipped-copy shadows under the demons
  hellSpriteShadowAlpha: number;    // opacity of the mirrored copy
  hellSpriteShadowTint: number;     // tint over the flipped art (black = pure silhouette)
  hellSpriteShadowSquash: number;   // vertical scale of the mirror (1 = full-height reflection)
  hellSpriteShadowGap: number;      // px between the feet and the shadow (negative overlaps)
  // Demon (the giant hell denizens) dev controls: render scale, whether they
  // patrol their band or stand frozen, plus their own saturation/brightness
  // colour filter. Sprite sheet and facing are per-demon: the colossus (R),
  // demon L, and L's friend each get their own art and standing direction.
  demonScale: number;         // multiplier on DEMON.displayPx (1 = native size)
  demonWalks: boolean;        // false = stands still at its current spot
  demonWalkSpeed: number;     // multiplier on DEMON.speed while patrolling
  demonAnimSpeed: number;     // multiplier on the sheet's natural fps (minotaur only — the statue is static)
  demonShadow: boolean;       // demons' own foot-shadow toggle
  demonShadowY: number;       // shadow centre below the demon centre (px, pre-demonScale)
  demonFacing: DemonFacing;   // demon R's standing facing (walking overrides it)
  demonSaturation: number;
  demonBrightness: number;
  demonHue: number;           // hue rotation in degrees (-180..180, 0 = natural)
  // Per-demon standing position (absolute hell coords, applied each tick
  // while the demon stands; the walk toggle overrides Y) and per-demon sprite
  // Y nudge relative to the selection circle / collision centre (the ring and
  // body radius stay put; only the art moves).
  demonRX: number;
  demonRY: number;
  demonRSprite: DemonSprite;  // which sheet the colossus draws from
  demonRSpriteYOffset: number;
  demonRTint: number;         // sprite tint over the demon art
  demonRHue: number;          // per-demon hue rotation (degrees), on top of the all-demons hue
  // The colossus's speaking voice — a low per-letter thud under his typed
  // dialogue (a registry sample, pitched down). Volume 0 silences it. Each
  // demon carries its own sample + triple so the three can sound distinct.
  demonRVoiceSound: SoundName;    // which registry sample the per-letter thud plays
  demonRVoiceVolume: number;
  demonRVoicePitch: number;       // playbackRate floor (1 = the sample's native pitch)
  demonRVoicePitchWobble: number; // random extra rate per letter, 0 = monotone
  // Demon L (Lilly) — live size (fraction of the colossus; also scales her
  // parlay/hit/body radii), standing facing, stand position, and sprite nudge.
  demonLScale: number;
  demonLFacing: DemonFacing;
  demonLX: number;
  demonLY: number;
  demonLSprite: DemonSprite;
  demonLSpriteYOffset: number;
  demonLTint: number;
  demonLHue: number;
  demonLVoiceSound: SoundName;
  demonLVoiceVolume: number;
  demonLVoicePitch: number;
  demonLVoicePitchWobble: number;
  // Lolly (L's friend) — her own live size plus the same per-demon dials.
  demonFriendScale: number;
  demonFriendFacing: DemonFacing;
  demonFriendX: number;
  demonFriendY: number;
  demonFriendSprite: DemonSprite;
  demonFriendSpriteYOffset: number;
  demonFriendTint: number;
  demonFriendHue: number;
  demonFriendVoiceSound: SoundName;
  demonFriendVoiceVolume: number;
  demonFriendVoicePitch: number;
  demonFriendVoicePitchWobble: number;
  // Robots — the late-game grey summons. Live-tunable look + orbital speed.
  robotScale: number;       // sprite size multiplier vs a regular goblin
  robotTint: number;        // chassis tint, applied over the (greyscaled) art
  robotGreyscale: boolean;  // desaturate the goblin art (off = tint over green)
  robotSpaceSpeed: number;  // space-px/sec a robot paddles toward a platform
};

// A sheet base-name from assets/demons/ (auto-discovered via the manifest —
// see demon-sheets.ts), or 'minotaur' for the classic walk-cycle art.
export type DemonSprite = string;

export type DemonFacing =
  | 'down' | 'up' | 'left' | 'right'
  | 'upleft' | 'upright' | 'downleft' | 'downright';
// Facing option → sprite heading angle (atan2 convention, 0 = east).
export const DEMON_FACING_ANGLE: Record<DemonFacing, number> = {
  right: 0,
  downright: Math.PI / 4,
  down: Math.PI / 2,
  downleft: (3 * Math.PI) / 4,
  left: Math.PI,
  upleft: -(3 * Math.PI) / 4,
  up: -Math.PI / 2,
  upright: -Math.PI / 4,
};

export const DEFAULT_OPTIONS: Options = {
  bgPattern: 'checker',
  bgColor: 0x060606,
  bgColor2: 0x0a0a0a,
  oobColor: 0x040404,
  gridVisible: false,
  gridColor: 0x000000,
  gridAlpha: 0.40,
  wallColor: 0x191919,
  goblinSaturation: 1.7,
  goblinBrightness: 1.8,
  goblinDisplayPx: 50,
  goblinShadow: true,
  goblinOutline: false,
  goblinSpriteYOffset: -7,
  waterGoblinColor: 0x7aa0ff,
  bloodColor: 0xffffff,
  // Minotaur defaults — independently tunable saturation / brightness /
  // size / Y-offset so the player can dial in the look.
  minotaurSaturation: 1.8,
  minotaurBrightness: 1.95,
  minotaurDisplayPx: 96,
  minotaurSpriteYOffset: -22,
  // Dragon defaults dialled in via the admin sliders — notably larger than
  // the old DRAGON.displayPx = 132 constant, nudged up so the body sits
  // above the carried building.
  dragonSaturation: 1,
  dragonBrightness: 1,
  dragonDisplayPx: 244,
  dragonSpriteYOffset: -39,
  buildingSaturation: 1.50,
  buildingBrightness: 1.05,
  buildingSpriteEnabled: true,
  buildingFillEnabled: true,
  buildingFillAlpha: 1.0,
  buildingBorderEnabled: true,
  buildingLabelEnabled: false,
  sidebarBg: 0x040404,
  sidebarBorder: 0x2e3238,
  sidebarButtonBg: 0x151b1e,
  sidebarButtonBorder: 0x060606,
  sidebarAccent: 0xffd96b,
  sidebarTitleColor: 0x8a9099,
  sidebarButtonHoverBorder: 0x5a6470,
  buttonsRounded: true,
  buttonsCutCorners: true,
  buttonCutSize: 8,
  buttonCutBorderColor: 0x5a6470,
  // Default font is New Rocker across the board — gives the UI a gothic
  // medieval-rocker tone that matches the goblin/minotaur theme.
  fonts: {
    display:         { family: 'newRocker', scale: 1.05 },
    mono:            { family: 'newRocker', scale: 0.80 },
    body:            { family: 'newRocker', scale: 1.00 },
    buildingLabel:   { family: 'newRocker', scale: 0.50 },
    buildingWarning: { family: 'newRocker', scale: 1.10 },
    dialogue:        { family: 'vt323', scale: 1.20 },
  },
  globalFontScale: 1.05,
  volume: 0.7,
  // 0.7 master × 0.7 music = 0.49 effective — about 30% softer than the
  // earlier music-at-master-volume default.
  musicVolume: 0.7,
  crackleEnabled: true,
  // Hell defaults — pulled down from the earlier "way too light" pass so the
  // underworld reads as oppressive: a near-black maroon gradient with a few
  // dim red blooms and a sparse ember dust. Tunable from the admin cog.
  hellBgTop: 0x8b0404,
  hellBgBottom: 0x1f0506,
  hellGlowColor: 0xff3010,
  hellGlowIntensity: 0.8,
  hellGlowSteps: 20,
  hellEmberCount: 525,
  hellEmberBrightness: 1.5,
  hellEmberSize: 1.1,
  hellGhostAlpha: 0.76,
  hellGhostBrightness: 0.7,
  hellGhostTint: 0x775037,
  hellGhostFallSpeed: 7,
  hellBloodColor: 0x4a8acf,
  // Mirror halo defaults mirror the old hardcoded look: one pale ring at
  // 2.2× the portal's footprint.
  hellPortalRingCount: 6,
  hellPortalRingRadius: 2.2,
  hellPortalRingSpacing: 40,
  hellPortalRingWidth: 3,
  hellPortalRingColor: 0xfff4c0,
  hellPortalRingAlpha: 0.06,
  // Sigil inner-ring defaults mirror the old hardcoded look.
  hellSigilRingRadius: 280,
  hellSigilRingWidth: 4,
  hellSigilRingColor: 0x000000,
  hellSigilRingAlpha: 0.56,
  hellDarknessEnabled: true,
  hellDarknessAlpha: 0.34,
  hellDarknessColor: 0x000000,
  hellDarknessMirrorRadius: 140,
  hellDarknessDemonRadius: 1070,
  hellDarknessParlayRadius: 320,
  hellDarknessLightAlpha: 1,
  hellParlayDimAlpha: 0.75,
  hellVignetteEnabled: true,
  hellVignetteAlpha: 1,
  hellVignetteColor: 0x000000,
  hellVignetteStartRadius: 0.22,
  hellVignetteEndRadius: 1.35,
  hellSpriteShadowGhosts: true,
  hellSpriteShadowDemons: true,
  hellSpriteShadowAlpha: 0.28,
  hellSpriteShadowTint: 0x000000,
  hellSpriteShadowSquash: 0.75,
  hellSpriteShadowGap: -36,
  demonScale: 1,
  // Demons stand still by default now, each facing its own direction: R
  // faces down toward the viewer, L down-right, Lolly up-right from her
  // corner. The walk toggle resumes the old patrol for all of them. Stand
  // X/Y defaults mirror where createDemons seeds them. R and L wear the
  // young-mask art under muted grey tints; Lolly wears its dark variant
  // untinted.
  demonWalks: false,
  demonWalkSpeed: 1,
  demonAnimSpeed: 1,
  demonShadow: true,
  demonShadowY: 320,
  demonFacing: 'down',
  demonSaturation: 3,
  demonBrightness: 1.4,
  demonHue: -17,
  demonRX: HELL.width / 2 + DEMON.spawnOffsetX,
  demonRY: HELL.height / 2,
  demonRSprite: 'young_mask_imitate_idle_b',
  demonRSpriteYOffset: -105,
  demonRTint: 0x8c8c8c,
  demonRHue: 0,
  demonRVoiceSound: 'task_complete',
  demonRVoiceVolume: 0.22,
  demonRVoicePitch: 0.05,
  demonRVoicePitchWobble: 0.05,
  demonLScale: 0.5,           // mirrors DEMON.smallScale
  demonLFacing: 'downright',
  demonLX: HELL.width / 2 - DEMON.spawnOffsetX,
  demonLY: HELL.height / 2,
  demonLSprite: 'young_mask_imitate_idle_b',
  demonLSpriteYOffset: -130,
  demonLTint: 0x4f4f4f,
  demonLHue: 93,
  demonLVoiceSound: 'click',
  demonLVoiceVolume: 0.22,
  demonLVoicePitch: 0.22,
  demonLVoicePitchWobble: 0.08,
  demonFriendScale: 0.35,     // mirrors DEMON.friendScale
  demonFriendFacing: 'upright',
  demonFriendX: 2230,
  demonFriendY: 290,
  demonFriendSprite: 'young_mask_imitate_idle_b_dark',
  demonFriendSpriteYOffset: -115,
  demonFriendTint: 0xffffff,
  demonFriendHue: 0,
  demonFriendVoiceSound: 'ritual',
  demonFriendVoiceVolume: 0.22,
  demonFriendVoicePitch: 0.22,
  demonFriendVoicePitchWobble: 0.08,
  // Robot defaults — a small white chassis. The greyscale filter is what makes
  // the green goblin art read as metal; the tint then shades the grey.
  robotScale: 0.72,
  robotTint: 0xffffff,
  robotGreyscale: true,
  robotSpaceSpeed: 55,
};

// Set every font key to the same family at once. Convenience for the options
// panel's "set all fonts to" picker.
export function setAllFontFamilies(family: string): void {
  for (const { key } of FONT_KEYS) {
    setFontConfig(key, { family });
  }
}

const STORAGE_KEY = 'rts.options.v2';

// Production starts every session with default options — so visitors get a
// consistent first experience and can't accidentally lock themselves out
// with a bad colour/font choice. Dev keeps persisted settings for iteration.
let current: Options = import.meta.env.DEV
  ? mergeDefaults(loadFromStorage())
  : { ...DEFAULT_OPTIONS, fonts: { ...DEFAULT_OPTIONS.fonts } };
const listeners = new Set<(o: Options) => void>();

export function getOptions(): Options { return current; }

export function setOption<K extends keyof Options>(key: K, value: Options[K]): void {
  current = { ...current, [key]: value };
  saveToStorage(current);
  for (const fn of listeners) fn(current);
}

export function setFontConfig(key: FontKey, patch: Partial<FontConfig>): void {
  current = {
    ...current,
    fonts: { ...current.fonts, [key]: { ...current.fonts[key], ...patch } },
  };
  saveToStorage(current);
  for (const fn of listeners) fn(current);
}

export function resetOptions(): void {
  current = { ...DEFAULT_OPTIONS, fonts: { ...DEFAULT_OPTIONS.fonts } };
  saveToStorage(current);
  for (const fn of listeners) fn(current);
}

export function onOptionsChange(fn: (o: Options) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

// ─── Persistence ────────────────────────────────────────────────────
function loadFromStorage(): Partial<Options> | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
}

function saveToStorage(o: Options) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(o)); } catch { /* quota / sandbox */ }
}

// Deep-merge defaults with persisted state so newly-added options/font slots
// get sane values even when the saved blob predates them.
function mergeDefaults(parsed: Partial<Options> | null): Options {
  if (!parsed) return { ...DEFAULT_OPTIONS, fonts: { ...DEFAULT_OPTIONS.fonts } };
  const fonts = { ...DEFAULT_OPTIONS.fonts };
  if (parsed.fonts) {
    for (const k of Object.keys(fonts) as FontKey[]) {
      const incoming = parsed.fonts[k];
      if (incoming) fonts[k] = { ...fonts[k], ...incoming };
    }
  }
  return { ...DEFAULT_OPTIONS, ...parsed, fonts };
}
