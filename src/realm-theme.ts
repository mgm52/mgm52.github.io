// ─── Trading-realm theme (dev-tunable fonts) ─────────────────────────
// The realm's text is styled through the game's font CSS variables. This
// module lets the realm dev cog give the realm its OWN typography — a family
// + scale per slot (display / mono / body / dialogue) — by overriding those
// variables on the realm root. A slot left on "inherit" removes its override
// so the realm keeps whatever the main game uses.
//
// (The realm used to also recolour the 3-D street houses; those have been
// unshipped, so the theme is now purely the realm's fonts.)
import { ensureFontLoaded, fontFamilyById } from './options';

export type RealmTheme = {
  fontDisplay: string;   fontDisplayScale: number;
  fontMono: string;      fontMonoScale: number;
  fontBody: string;      fontBodyScale: number;
  fontDialogue: string;  fontDialogueScale: number;
};

export const REALM_THEME_DEFAULTS: RealmTheme = {
  fontDisplay: '',   fontDisplayScale: 1,
  fontMono: '',      fontMonoScale: 1,
  fontBody: '',      fontBodyScale: 1,
  fontDialogue: '',  fontDialogueScale: 1,
};

export type RealmThemeKey = keyof RealmTheme;

// The realm's font slots: each maps a family key + scale key onto the CSS
// custom property the realm's text actually reads (the same vars the main
// game drives). Used by applyVars and by the dev-cog UI. The four cover every
// place the realm shows type: titles/names (display), numbers + want lines
// (mono), body copy (body), and the white goblin's dialogue (dialogue).
type FamKey = 'fontDisplay' | 'fontMono' | 'fontBody' | 'fontDialogue';
type ScaleKey = 'fontDisplayScale' | 'fontMonoScale' | 'fontBodyScale' | 'fontDialogueScale';
export type RealmFontSlot = { fam: FamKey; scale: ScaleKey; cssVar: string; label: string };
export const REALM_FONT_SLOTS: RealmFontSlot[] = [
  { fam: 'fontDisplay',  scale: 'fontDisplayScale',  cssVar: 'font-display',  label: 'Display (titles, names)' },
  { fam: 'fontMono',     scale: 'fontMonoScale',     cssVar: 'font-mono',     label: 'Mono (numbers, wants)' },
  { fam: 'fontBody',     scale: 'fontBodyScale',     cssVar: 'font-body',     label: 'Body text' },
  { fam: 'fontDialogue', scale: 'fontDialogueScale', cssVar: 'font-dialogue', label: 'Goblin dialogue' },
];

const THEME_KEY = 'gs.realm.theme';

let theme: RealmTheme = { ...REALM_THEME_DEFAULTS };
let themeRoot: HTMLElement | null = null;

function load(): void {
  try {
    const raw = localStorage.getItem(THEME_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw) as Partial<RealmTheme> & { font?: string; fontScale?: number };
    for (const k of Object.keys(REALM_THEME_DEFAULTS) as RealmThemeKey[]) {
      const v = saved[k];
      if (typeof v === typeof REALM_THEME_DEFAULTS[k]) (theme[k] as RealmTheme[typeof k]) = v as never;
    }
    // Migrate the old single display-font fields onto the display slot.
    if (typeof saved.font === 'string' && theme.fontDisplay === '') theme.fontDisplay = saved.font;
    if (typeof saved.fontScale === 'number' && theme.fontDisplayScale === 1) theme.fontDisplayScale = saved.fontScale;
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

// Drive the realm root's font CSS variables from the current theme. A slot on
// its default ('' family / scale 1) removes the override so the realm inherits
// the game's font for that slot.
function applyVars(root: HTMLElement): void {
  for (const s of REALM_FONT_SLOTS) {
    const fam = theme[s.fam];
    if (fam) {
      ensureFontLoaded(fam);
      root.style.setProperty(`--${s.cssVar}`, fontFamilyById(fam).css);
    } else {
      root.style.removeProperty(`--${s.cssVar}`);
    }
    const scl = theme[s.scale];
    if (scl !== 1) root.style.setProperty(`--${s.cssVar}-scale`, String(scl));
    else root.style.removeProperty(`--${s.cssVar}-scale`);
  }
}

// Mount the theme onto the realm root (called when the realm is shown). Any
// persisted fonts apply immediately, before the dev cog is ever opened.
export function applyRealmTheme(root: HTMLElement): void {
  themeRoot = root;
  // Pre-load persisted custom fonts so the first paint isn't a fallback flash.
  for (const s of REALM_FONT_SLOTS) if (theme[s.fam]) ensureFontLoaded(theme[s.fam]);
  applyVars(root);
}
