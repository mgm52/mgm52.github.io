export type BgPattern = 'solid' | 'checker';

// ─── Fonts ──────────────────────────────────────────────────────────
// Curated families. Anything with a `url` lazy-loads on first use so the cold
// page-load only ships Audiowide + VT323 (declared in index.html).
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

export type FontKey = 'display' | 'mono' | 'body' | 'buildingLabel' | 'buildingWarning';
export const FONT_KEYS: { key: FontKey; label: string }[] = [
  { key: 'display',         label: 'Display (titles)' },
  { key: 'mono',            label: 'Mono (numbers)' },
  { key: 'body',            label: 'Body text' },
  { key: 'buildingLabel',   label: 'Building label' },
  { key: 'buildingWarning', label: 'Building warning' },
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
  // Buildings
  buildingSaturation: number;
  buildingBrightness: number;
  // Sidebar
  sidebarBg: number;
  sidebarBorder: number;
  sidebarButtonBg: number;
  sidebarButtonBorder: number;
  sidebarAccent: number;     // yellow numbers (Ƶ values, resource counters)
  sidebarTitleColor: number; // muted-gray panel titles
  // Fonts (per-category family + size scale)
  fonts: Record<FontKey, FontConfig>;
  // Audio
  volume: number;
};

export const DEFAULT_OPTIONS: Options = {
  bgPattern: 'checker',
  bgColor: 0x040404,
  bgColor2: 0x060606,
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
  buildingSaturation: 1.50,
  buildingBrightness: 1.05,
  sidebarBg: 0x000000,
  sidebarBorder: 0x2e3238,
  sidebarButtonBg: 0x121416,
  sidebarButtonBorder: 0x33373d,
  sidebarAccent: 0xffd96b,
  sidebarTitleColor: 0x8a9099,
  fonts: {
    display:         { family: 'audiowide', scale: 0.95 },
    mono:            { family: 'majorMono', scale: 0.70 },
    body:            { family: 'majorMono', scale: 0.90 },
    buildingLabel:   { family: 'majorMono', scale: 0.50 },
    buildingWarning: { family: 'majorMono', scale: 1.00 },
  },
  volume: 0.7,
};

const STORAGE_KEY = 'rts.options.v2';

let current: Options = mergeDefaults(loadFromStorage());
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
