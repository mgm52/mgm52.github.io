import {
  DEFAULT_OPTIONS, FONT_FAMILIES, FONT_KEYS, ensureFontLoaded,
  getOptions, resetOptions, setAllFontFamilies, setFontConfig, setOption,
  type BgPattern, type FontKey, type Options,
} from './options';

export type OptionsUICallbacks = {
  onCheatMoney: () => void;
  onTaskSkip: () => void;
  onShowTitleScreen: () => void;
};

export function setupOptionsUI(root: HTMLElement, callbacks: OptionsUICallbacks): void {
  // Pre-load any persisted custom fonts so they're ready when the user opens
  // the panel or the renderer applies them.
  for (const cfg of Object.values(getOptions().fonts)) ensureFontLoaded(cfg.family);

  // Public cog — always visible. Holds master/music volume + a flavour line.
  const publicCog = document.createElement('button');
  publicCog.id = 'options-cog-public';
  publicCog.type = 'button';
  publicCog.setAttribute('aria-label', 'Options');
  publicCog.textContent = '⚙';

  const publicPanel = document.createElement('div');
  publicPanel.id = 'options-panel-public';
  publicPanel.hidden = true;

  // Admin cog — full options. In prod hidden until the player places a Dragon
  // Beacon (unlockOptionsCog() flips it visible and persists the flag in
  // localStorage so the unlock survives reloads). Dev keeps it always-on.
  const adminCog = document.createElement('button');
  adminCog.id = 'options-cog';
  adminCog.type = 'button';
  adminCog.setAttribute('aria-label', 'Dragon admin options');
  adminCog.textContent = 'D';
  if (!import.meta.env.DEV && localStorage.getItem(SECRET_UNLOCK_KEY) !== '1') {
    adminCog.style.display = 'none';
  }

  const adminPanel = document.createElement('div');
  adminPanel.id = 'options-panel';
  adminPanel.hidden = true;

  // Each cog opens its own panel and closes the other so they don't overlap.
  publicCog.addEventListener('click', (e) => {
    e.stopPropagation();
    adminPanel.hidden = true;
    publicPanel.hidden = !publicPanel.hidden;
  });
  adminCog.addEventListener('click', (e) => {
    e.stopPropagation();
    publicPanel.hidden = true;
    adminPanel.hidden = !adminPanel.hidden;
  });
  document.addEventListener('click', (e) => {
    if (!(e.target instanceof Node)) return;
    if (!publicPanel.hidden && !publicPanel.contains(e.target) && !publicCog.contains(e.target)) {
      publicPanel.hidden = true;
    }
    if (!adminPanel.hidden && !adminPanel.contains(e.target) && !adminCog.contains(e.target)) {
      adminPanel.hidden = true;
    }
  });

  rebuildPublicPanel(publicPanel);
  rebuildPanel(adminPanel, callbacks, () => rebuildPublicPanel(publicPanel));

  root.appendChild(publicCog);
  root.appendChild(publicPanel);
  root.appendChild(adminCog);
  root.appendChild(adminPanel);
}

// Compact panel for the always-visible public cog. The admin panel mirrors
// the same audio sliders so changing one keeps the other in sync after a
// rebuild — but the public panel is intentionally minimal, plus a flavour
// line for atmosphere.
function rebuildPublicPanel(panel: HTMLElement): void {
  panel.innerHTML = '';
  const o = getOptions();
  panel.appendChild(section('Audio', [
    slider('Master volume', o.volume,         0, 1, 0.05, (v) => setOption('volume', v)),
    slider('Music volume',  o.musicVolume,    0, 1, 0.05, (v) => setOption('musicVolume', v)),
    toggle('Vinyl crackle', o.crackleEnabled,                (v) => setOption('crackleEnabled', v)),
  ]));
  const flavor = document.createElement('div');
  flavor.className = 'options-flavor';
  flavor.textContent = 'there is no war in ba sing se';
  panel.appendChild(flavor);
}

const SECRET_UNLOCK_KEY = 'gs.optionsCog.secretUnlocked';

// Reveals the options cog. Used in prod once the player places a Dragon
// Beacon — see the second alert in input.ts placeBuilding. Persists in
// localStorage so the unlock survives reloads.
export function unlockOptionsCog(): void {
  try { localStorage.setItem(SECRET_UNLOCK_KEY, '1'); } catch { /* no-op */ }
  const cog = document.getElementById('options-cog');
  if (cog) cog.style.display = '';
}

// ─── Panel construction ─────────────────────────────────────────────
function rebuildPanel(panel: HTMLElement, callbacks: OptionsUICallbacks, refreshPublic?: () => void): void {
  panel.innerHTML = '';
  const o = getOptions();

  panel.appendChild(section('Background', [
    select('Pattern', o.bgPattern, [
      { value: 'solid', label: 'Solid' },
      { value: 'checker', label: 'Checker' },
    ], (v) => setOption('bgPattern', v as BgPattern)),
    color('Primary', o.bgColor, (v) => setOption('bgColor', v)),
    color('Checker alt', o.bgColor2, (v) => setOption('bgColor2', v)),
    color('Out-of-bounds', o.oobColor, (v) => setOption('oobColor', v)),
  ]));

  panel.appendChild(section('Grid & walls', [
    toggle('Grid visible', o.gridVisible, (v) => setOption('gridVisible', v)),
    color('Grid color', o.gridColor, (v) => setOption('gridColor', v)),
    slider('Grid alpha', o.gridAlpha, 0, 1, 0.05, (v) => setOption('gridAlpha', v)),
    color('Wall color', o.wallColor, (v) => setOption('wallColor', v)),
  ]));

  panel.appendChild(section('Goblins', [
    slider('Saturation', o.goblinSaturation, 0, 2, 0.05, (v) => setOption('goblinSaturation', v)),
    slider('Brightness', o.goblinBrightness, 0.2, 2, 0.05, (v) => setOption('goblinBrightness', v)),
    slider('Sprite size', o.goblinDisplayPx, 24, 96, 1, (v) => setOption('goblinDisplayPx', v)),
    slider('Sprite Y offset', o.goblinSpriteYOffset, -32, 32, 1, (v) => setOption('goblinSpriteYOffset', v)),
    toggle('Foot shadow',   o.goblinShadow,  (v) => setOption('goblinShadow', v)),
    toggle('Black outline', o.goblinOutline, (v) => setOption('goblinOutline', v)),
    color('Water-goblin color', o.waterGoblinColor, (v) => setOption('waterGoblinColor', v)),
    color('Blood color', o.bloodColor, (v) => setOption('bloodColor', v)),
  ]));

  panel.appendChild(section('Minotaurs', [
    slider('Saturation', o.minotaurSaturation, 0, 2, 0.05, (v) => setOption('minotaurSaturation', v)),
    slider('Brightness', o.minotaurBrightness, 0.2, 2, 0.05, (v) => setOption('minotaurBrightness', v)),
    slider('Sprite size', o.minotaurDisplayPx, 40, 200, 1, (v) => setOption('minotaurDisplayPx', v)),
    slider('Sprite Y offset', o.minotaurSpriteYOffset, -64, 64, 1, (v) => setOption('minotaurSpriteYOffset', v)),
  ]));

  panel.appendChild(section('Buildings', [
    slider('Saturation', o.buildingSaturation, 0, 2, 0.05, (v) => setOption('buildingSaturation', v)),
    slider('Brightness', o.buildingBrightness, 0.2, 2, 0.05, (v) => setOption('buildingBrightness', v)),
    toggle('Show sprite',      o.buildingSpriteEnabled, (v) => setOption('buildingSpriteEnabled', v)),
    toggle('Show color fill',  o.buildingFillEnabled,   (v) => setOption('buildingFillEnabled', v)),
    slider('Fill alpha',       o.buildingFillAlpha, 0, 1, 0.05, (v) => setOption('buildingFillAlpha', v)),
    toggle('Show border',      o.buildingBorderEnabled, (v) => setOption('buildingBorderEnabled', v)),
    toggle('Show short label', o.buildingLabelEnabled,  (v) => setOption('buildingLabelEnabled', v)),
  ]));

  panel.appendChild(section('Sidebar colors', [
    color('Background',     o.sidebarBg,           (v) => setOption('sidebarBg', v)),
    color('Border',         o.sidebarBorder,       (v) => setOption('sidebarBorder', v)),
    color('Button bg',      o.sidebarButtonBg,     (v) => setOption('sidebarButtonBg', v)),
    color('Button border',  o.sidebarButtonBorder, (v) => setOption('sidebarButtonBorder', v)),
    color('Accent (Ƶ)',     o.sidebarAccent,       (v) => setOption('sidebarAccent', v)),
    color('Title text',     o.sidebarTitleColor,   (v) => setOption('sidebarTitleColor', v)),
    color('Button hover border', o.sidebarButtonHoverBorder, (v) => setOption('sidebarButtonHoverBorder', v)),
    toggle('Rounded buttons', o.buttonsRounded,    (v) => setOption('buttonsRounded', v)),
  ]));

  panel.appendChild(section('Audio', [
    slider('Master volume', o.volume,         0, 1, 0.05, (v) => { setOption('volume', v);         refreshPublic?.(); }),
    slider('Music volume',  o.musicVolume,    0, 1, 0.05, (v) => { setOption('musicVolume', v);    refreshPublic?.(); }),
    toggle('Vinyl crackle', o.crackleEnabled,                (v) => { setOption('crackleEnabled', v); refreshPublic?.(); }),
  ]));

  panel.appendChild(fontsSection(o));

  const cheat = document.createElement('button');
  cheat.type = 'button';
  cheat.className = 'options-reset';
  cheat.textContent = 'Cheat +Ƶ100,000';
  cheat.addEventListener('click', () => callbacks.onCheatMoney());
  panel.appendChild(cheat);

  const taskSkip = document.createElement('button');
  taskSkip.type = 'button';
  taskSkip.className = 'options-reset';
  taskSkip.textContent = 'Task skip';
  taskSkip.addEventListener('click', () => callbacks.onTaskSkip());
  panel.appendChild(taskSkip);

  const showTitle = document.createElement('button');
  showTitle.type = 'button';
  showTitle.className = 'options-reset';
  showTitle.textContent = 'Show title screen';
  showTitle.addEventListener('click', () => callbacks.onShowTitleScreen());
  panel.appendChild(showTitle);

  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'options-reset';
  reset.textContent = 'Reset to defaults';
  reset.addEventListener('click', () => {
    resetOptions();
    rebuildPanel(panel, callbacks, refreshPublic);
    refreshPublic?.();
  });
  panel.appendChild(reset);
}

function fontsSection(o: Options): HTMLElement {
  const familyOpts = FONT_FAMILIES.map(f => ({ value: f.id, label: f.label }));
  const rows: HTMLElement[] = [];
  // Convenience controls at the top: a single "set all to" picker that
  // syncs every font key, and a global scale multiplier.
  rows.push(select('Set all fonts to', '', [{ value: '', label: '— pick —' }, ...familyOpts], (v) => {
    if (!v) return;
    ensureFontLoaded(v);
    setAllFontFamilies(v);
  }));
  rows.push(slider('Global scale', o.globalFontScale, 0.4, 2.5, 0.05, (v) => setOption('globalFontScale', v)));
  for (const { key, label } of FONT_KEYS) {
    const cfg = o.fonts[key];
    rows.push(fontRow(label, key, cfg.family, cfg.scale, familyOpts));
  }
  return section('Fonts', rows);
}

function fontRow(
  label: string, key: FontKey, family: string, scale: number,
  familyOpts: { value: string; label: string }[],
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'options-fontrow';

  const head = document.createElement('div');
  head.className = 'options-fontrow-label';
  head.textContent = label;

  const controls = document.createElement('div');
  controls.className = 'options-fontrow-controls';

  const sel = document.createElement('select');
  for (const o of familyOpts) {
    const opt = document.createElement('option');
    opt.value = o.value; opt.textContent = o.label;
    if (o.value === family) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.addEventListener('change', () => {
    ensureFontLoaded(sel.value);
    setFontConfig(key, { family: sel.value });
  });

  const scaleWrap = document.createElement('span');
  scaleWrap.className = 'options-slider';
  const scaleInput = document.createElement('input');
  scaleInput.type = 'range';
  scaleInput.min = '0.5'; scaleInput.max = '2'; scaleInput.step = '0.05';
  scaleInput.value = String(scale);
  const out = document.createElement('span');
  out.className = 'options-slider-value';
  out.textContent = scale.toFixed(2);
  scaleInput.addEventListener('input', () => {
    const v = Number(scaleInput.value);
    out.textContent = v.toFixed(2);
    setFontConfig(key, { scale: v });
  });
  scaleWrap.appendChild(scaleInput);
  scaleWrap.appendChild(out);

  controls.appendChild(sel);
  controls.appendChild(scaleWrap);

  row.appendChild(head);
  row.appendChild(controls);
  return row;
}

function section(title: string, rows: HTMLElement[]): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'options-section';
  const h = document.createElement('div');
  h.className = 'options-section-title';
  h.textContent = title;
  wrap.appendChild(h);
  for (const r of rows) wrap.appendChild(r);
  return wrap;
}

function row(label: string, control: HTMLElement): HTMLElement {
  const r = document.createElement('label');
  r.className = 'options-row';
  const l = document.createElement('span');
  l.className = 'options-label';
  l.textContent = label;
  r.appendChild(l);
  r.appendChild(control);
  return r;
}

function toggle(label: string, value: boolean, on: (v: boolean) => void): HTMLElement {
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = value;
  input.addEventListener('change', () => on(input.checked));
  return row(label, input);
}

function slider(
  label: string, value: number, min: number, max: number, step: number,
  on: (v: number) => void,
): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = 'options-slider';
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(min); input.max = String(max); input.step = String(step);
  input.value = String(value);
  const out = document.createElement('span');
  out.className = 'options-slider-value';
  out.textContent = format(value);
  input.addEventListener('input', () => {
    const v = Number(input.value);
    out.textContent = format(v);
    on(v);
  });
  wrap.appendChild(input);
  wrap.appendChild(out);
  return row(label, wrap);
}

function color(label: string, value: number, on: (v: number) => void): HTMLElement {
  const input = document.createElement('input');
  input.type = 'color';
  input.value = numToHex(value);
  input.addEventListener('input', () => on(hexToNum(input.value)));
  return row(label, input);
}

function select(
  label: string, value: string,
  opts: { value: string; label: string }[],
  on: (v: string) => void,
): HTMLElement {
  const sel = document.createElement('select');
  for (const o of opts) {
    const opt = document.createElement('option');
    opt.value = o.value; opt.textContent = o.label;
    if (o.value === value) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.addEventListener('change', () => on(sel.value));
  return row(label, sel);
}

function format(v: number): string {
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(2);
}

function numToHex(n: number): string {
  return '#' + n.toString(16).padStart(6, '0');
}

function hexToNum(h: string): number {
  return parseInt(h.replace('#', ''), 16);
}

export type { Options };
export { DEFAULT_OPTIONS };
