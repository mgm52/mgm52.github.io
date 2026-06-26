// ─── Trading-realm theme (dev-tunable look) ─────────────────────────
// The street's houses, doors, roofs and name-labels are styled in CSS with a
// fixed pastel palette. This module lets the realm dev cog recolour them (and
// restyle the labels + pick a realm font) live, by driving a handful of CSS
// custom properties on the realm root. Each property carries the shipped
// value as its CSS fallback, so a theme left at its defaults removes the
// property entirely and the scene looks exactly as authored.
//
// Colours are stored as 0xRRGGBB numbers (matching the options panel's colour
// control); the per-face 3-D shading is derived here so one "house colour"
// still reads as a solid volume (front bright, sides stepped darker).
import { ensureFontLoaded, fontFamilyById } from './options';

export type RealmTheme = {
  house: number;      // wall / front base colour
  roof: number;       // roof + gable base colour
  door: number;       // door base colour
  signBg: number;     // name-label background
  signColor: number;  // name-label text colour
  signSize: number;   // name-label font size (px)
  font: string;       // realm font family id ('' = inherit the game's)
  fontScale: number;  // realm display-font scale multiplier
};

export const REALM_THEME_DEFAULTS: RealmTheme = {
  house: 0xffffff,
  roof: 0xfbfbfb,
  door: 0xffffff,
  signBg: 0xffffff,
  signColor: 0x4a4658,
  signSize: 12,
  font: '',
  fontScale: 1,
};

export type RealmThemeKey = keyof RealmTheme;

const THEME_KEY = 'gs.realm.theme';

let theme: RealmTheme = { ...REALM_THEME_DEFAULTS };
let themeRoot: HTMLElement | null = null;

function load(): void {
  try {
    const raw = localStorage.getItem(THEME_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw) as Partial<RealmTheme>;
    for (const k of Object.keys(REALM_THEME_DEFAULTS) as RealmThemeKey[]) {
      const v = saved[k];
      if (typeof v === typeof REALM_THEME_DEFAULTS[k]) (theme[k] as RealmTheme[typeof k]) = v as never;
    }
  } catch { /* malformed — keep defaults */ }
}
load();

function persist(): void {
  try {
    const out: Partial<RealmTheme> = {};
    for (const k of Object.keys(REALM_THEME_DEFAULTS) as RealmThemeKey[]) {
      if (theme[k] !== REALM_THEME_DEFAULTS[k]) (out[k] as RealmTheme[typeof k]) = theme[k] as never;
    }
    if (Object.keys(out).length) localStorage.setItem(THEME_KEY, JSON.stringify(out));
    else localStorage.removeItem(THEME_KEY);
  } catch { /* storage blocked — theme just won't persist */ }
}

export function getRealmTheme(): RealmTheme { return { ...theme }; }

export function setRealmThemeValue<K extends RealmThemeKey>(key: K, value: RealmTheme[K]): void {
  theme[key] = value;
  persist();
  if (themeRoot) applyVars(themeRoot);
}

export function resetRealmTheme(): void {
  theme = { ...REALM_THEME_DEFAULTS };
  persist();
  if (themeRoot) applyVars(themeRoot);
}

// ─── Colour helpers ─────────────────────────────────────────────────
const SHADOW = 0x6a6a6a;   // neutral grey the faces are shaded toward
const rgb = (n: number): [number, number, number] => [(n >> 16) & 255, (n >> 8) & 255, n & 255];
const hex = ([r, g, b]: [number, number, number]): string =>
  '#' + [r, g, b].map((x) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, '0')).join('');
// Mix `a` toward `b` by t (0..1).
function mix(a: number, b: number, t: number): string {
  const A = rgb(a), B = rgb(b);
  return hex([A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t]);
}
// Scale every channel by f (darken/brighten while keeping hue).
function scale(n: number, f: number): string {
  const A = rgb(n);
  return hex([A[0] * f, A[1] * f, A[2] * f]);
}

// Drive the realm root's CSS custom properties from the current theme. A value
// left at its default removes the property so the CSS fallback (= the shipped
// look) takes over untouched.
function applyVars(root: HTMLElement): void {
  const set = (prop: string, isDefault: boolean, value: string): void => {
    if (isDefault) root.style.removeProperty(prop);
    else root.style.setProperty(prop, value);
  };
  const houseDef = theme.house === REALM_THEME_DEFAULTS.house;
  set('--sv-front-bg', houseDef, `linear-gradient(180deg, ${hex(rgb(theme.house))} 0%, ${mix(theme.house, SHADOW, 0.05)} 100%)`);
  set('--sv-wall-bg',  houseDef, `linear-gradient(180deg, ${hex(rgb(theme.house))} 0%, ${mix(theme.house, SHADOW, 0.11)} 100%)`);
  set('--sv-back-bg',  houseDef, mix(theme.house, SHADOW, 0.15));
  set('--sv-left-bg',  houseDef, `linear-gradient(90deg, ${mix(theme.house, SHADOW, 0.22)} 0%, ${mix(theme.house, SHADOW, 0.10)} 100%)`);
  set('--sv-right-bg', houseDef, `linear-gradient(90deg, ${mix(theme.house, SHADOW, 0.10)} 0%, ${mix(theme.house, SHADOW, 0.22)} 100%)`);

  const roofDef = theme.roof === REALM_THEME_DEFAULTS.roof;
  set('--sv-roof-bg',  roofDef, `linear-gradient(180deg, ${hex(rgb(theme.roof))} 0%, ${mix(theme.roof, SHADOW, 0.10)} 100%)`);
  set('--sv-gable-bg', roofDef, `linear-gradient(180deg, ${mix(theme.roof, SHADOW, 0.04)} 0%, ${mix(theme.roof, SHADOW, 0.14)} 100%)`);

  set('--sv-door-bg', theme.door === REALM_THEME_DEFAULTS.door,
    `linear-gradient(180deg, ${hex(rgb(theme.door))} 0%, ${scale(theme.door, 0.78)} 100%)`);

  set('--sv-sign-bg', theme.signBg === REALM_THEME_DEFAULTS.signBg, hex(rgb(theme.signBg)));
  set('--sv-sign-color', theme.signColor === REALM_THEME_DEFAULTS.signColor, hex(rgb(theme.signColor)));
  set('--sv-sign-size', theme.signSize === REALM_THEME_DEFAULTS.signSize, `${theme.signSize}px`);

  // Font: override the realm's --font-display (the labels + most realm text use
  // it) and its scale. Left on "inherit", the realm keeps the game's font.
  if (theme.font) {
    ensureFontLoaded(theme.font);
    root.style.setProperty('--font-display', fontFamilyById(theme.font).css);
  } else {
    root.style.removeProperty('--font-display');
  }
  set('--font-display-scale', theme.fontScale === REALM_THEME_DEFAULTS.fontScale, String(theme.fontScale));
}

// Mount the theme onto the realm root (called when the realm is shown). Any
// persisted theme applies immediately, before the dev cog is ever opened.
export function applyRealmTheme(root: HTMLElement): void {
  themeRoot = root;
  // Pre-load a persisted custom font so the first paint isn't a fallback flash.
  if (theme.font) ensureFontLoaded(theme.font);
  applyVars(root);
}
