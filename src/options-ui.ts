import { HELL } from './config';
import { getDemonSheetList, loadDemonSheetList } from './demon-sheets';
import {
  DEFAULT_OPTIONS, FONT_FAMILIES, FONT_KEYS, ensureFontLoaded,
  getOptions, resetOptions, setAllFontFamilies, setFontConfig, setOption,
  type BgPattern, type FontKey, type Options,
} from './options';

export type OptionsUICallbacks = {
  onCheatMoney: () => void;
  onCheatBlood: () => void;
  onCheatPower: () => void;
  onCheatBones: () => void;
  onTriggerBob: () => void;
  onSkipToHell: () => void;
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

  // Admin cog — full options. In prod hidden until the demo-end gag fires (the
  // demon's gift, or the secret reveal gesture) — unlockOptionsCog() flips it
  // visible and persists the flag in localStorage so the unlock survives
  // reloads. Dev keeps it always-on.
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
  // The demon-sprite dropdowns list whatever sheets the assets/demons/
  // manifest delivers; that fetch is async, so re-render the panel once it
  // lands (the panel is hidden this early — nobody sees the flash).
  void loadDemonSheetList().then(() => {
    rebuildPanel(adminPanel, callbacks, () => rebuildPublicPanel(publicPanel));
  });

  root.appendChild(publicCog);
  root.appendChild(publicPanel);
  root.appendChild(adminCog);
  root.appendChild(adminPanel);

  // Secret unlock: the leading "R" of the sidebar's Resources title reveals
  // the admin cog. On desktop it's a shift-click; on mobile (no shift key)
  // it's a long-press on the same letter. Bare taps/clicks do nothing so we
  // don't tip our hand on accidental hits.
  const resourcesSecret = document.getElementById('resources-secret');
  if (resourcesSecret) {
    resourcesSecret.addEventListener('click', (e) => {
      if (!e.shiftKey) return;
      e.stopPropagation();
      unlockOptionsCog();
    });

    // Long-press path (touch + mouse). A press held past LONG_PRESS_MS that
    // hasn't drifted into a scroll/drag fires the unlock. Suppress the iOS
    // text-selection callout on the held letter so the gesture reads cleanly.
    const LONG_PRESS_MS = 600;
    const DRAG_CANCEL_PX = 10;
    resourcesSecret.style.userSelect = 'none';
    resourcesSecret.style.webkitUserSelect = 'none';
    resourcesSecret.style.touchAction = 'manipulation';
    let pressTimer: number | null = null;
    let startX = 0, startY = 0;
    const cancelPress = () => {
      if (pressTimer !== null) { window.clearTimeout(pressTimer); pressTimer = null; }
    };
    resourcesSecret.addEventListener('pointerdown', (e) => {
      startX = e.clientX; startY = e.clientY;
      cancelPress();
      pressTimer = window.setTimeout(() => {
        pressTimer = null;
        unlockOptionsCog();
      }, LONG_PRESS_MS);
    });
    resourcesSecret.addEventListener('pointermove', (e) => {
      if (pressTimer === null) return;
      if (Math.hypot(e.clientX - startX, e.clientY - startY) > DRAG_CANCEL_PX) cancelPress();
    });
    resourcesSecret.addEventListener('pointerup', cancelPress);
    resourcesSecret.addEventListener('pointercancel', cancelPress);
    resourcesSecret.addEventListener('pointerleave', cancelPress);
    resourcesSecret.addEventListener('contextmenu', (e) => e.preventDefault());
  }
}

// Compact panel for the always-visible public cog. The admin panel mirrors
// the same audio sliders so changing one keeps the other in sync after a
// rebuild — but the public panel is intentionally minimal, plus a flavour
// line for atmosphere.
function rebuildPublicPanel(panel: HTMLElement): void {
  panel.innerHTML = '';
  const o = getOptions();
  // Static (non-collapsible) section — the public panel is three rows; hiding
  // them behind a fold would just add a click.
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

// Dev convenience flag (plain localStorage, not part of Options or the save):
// when on, every page reload wipes the run and rides straight down to hell.
// Read by main.ts at startup; toggled from the Cheats section. Off by default.
const RESTART_IN_HELL_KEY = 'gs.restartInHell';
export function getRestartInHell(): boolean {
  try { return localStorage.getItem(RESTART_IN_HELL_KEY) === '1'; } catch { return false; }
}
function setRestartInHell(v: boolean): void {
  try { localStorage.setItem(RESTART_IN_HELL_KEY, v ? '1' : '0'); } catch { /* no-op */ }
}

// Reveals the options cog. In prod it's revealed by the demon's gift to a
// truthful Bob (revealSecretSettings in ui.ts) or the secret shift-click /
// long-press R gesture below. Persists in localStorage so it survives reloads.
export function unlockOptionsCog(): void {
  try { localStorage.setItem(SECRET_UNLOCK_KEY, '1'); } catch { /* no-op */ }
  const cog = document.getElementById('options-cog');
  if (cog) cog.style.display = '';
}

// Wipe the persisted unlock and re-hide the cog. Called from the title
// screen's Erase Data path so a fresh start is genuinely fresh — without
// this, an old unlock from a prior playthrough would persist past the
// reset. No-op in dev where the cog is always visible by design.
export function relockOptionsCog(): void {
  try { localStorage.removeItem(SECRET_UNLOCK_KEY); } catch { /* no-op */ }
  if (import.meta.env.DEV) return;
  const cog = document.getElementById('options-cog');
  if (cog) cog.style.display = 'none';
}

// ─── Panel construction ─────────────────────────────────────────────
// Reminder of the unlock gesture in case the player hides the cog (via Erase
// Data) and forgets how to get it back. Shown at both the top and bottom of the
// admin panel so it's visible without scrolling either way.
function unlockHint(): HTMLElement {
  const hint = document.createElement('div');
  hint.className = 'options-flavor';
  hint.textContent = 'shift-click (or long-press) the R in Resources to re-unlock';
  return hint;
}

// Shared facing choices for the per-demon standing-direction pickers.
const FACING_OPTS = [
  { value: 'down',      label: 'Down' },
  { value: 'up',        label: 'Up' },
  { value: 'left',      label: 'Left' },
  { value: 'right',     label: 'Right' },
  { value: 'upleft',    label: 'Up-left' },
  { value: 'upright',   label: 'Up-right' },
  { value: 'downleft',  label: 'Down-left' },
  { value: 'downright', label: 'Down-right' },
];

// Per-demon art: every turntable sheet auto-discovered in assets/demons/
// (drop a .json+.png pair in the folder and it shows up here), plus the old
// minotaur walk cycle. Built per-rebuild — the panel re-renders once the
// manifest fetch lands, so the list is complete by the time anyone opens it.
function demonSpriteOpts(): { value: string; label: string }[] {
  return [
    ...getDemonSheetList().map(({ id, label }) => ({ value: id, label })),
    { value: 'minotaur', label: 'Minotaur (classic)' },
  ];
}

function rebuildPanel(panel: HTMLElement, callbacks: OptionsUICallbacks, refreshPublic?: () => void): void {
  panel.innerHTML = '';
  const o = getOptions();

  panel.appendChild(unlockHint());

  panel.appendChild(collapsibleSection('Background', [
    select('Pattern', o.bgPattern, [
      { value: 'solid', label: 'Solid' },
      { value: 'checker', label: 'Checker' },
    ], (v) => setOption('bgPattern', v as BgPattern)),
    color('Primary', o.bgColor, (v) => setOption('bgColor', v)),
    color('Checker alt', o.bgColor2, (v) => setOption('bgColor2', v)),
    color('Out-of-bounds', o.oobColor, (v) => setOption('oobColor', v)),
  ]));

  panel.appendChild(collapsibleSection('Grid & walls', [
    toggle('Grid visible', o.gridVisible, (v) => setOption('gridVisible', v)),
    color('Grid color', o.gridColor, (v) => setOption('gridColor', v)),
    slider('Grid alpha', o.gridAlpha, 0, 1, 0.05, (v) => setOption('gridAlpha', v)),
    color('Wall color', o.wallColor, (v) => setOption('wallColor', v)),
  ]));

  panel.appendChild(collapsibleSection('Goblins', [
    slider('Saturation', o.goblinSaturation, 0, 2, 0.05, (v) => setOption('goblinSaturation', v)),
    slider('Brightness', o.goblinBrightness, 0.2, 2, 0.05, (v) => setOption('goblinBrightness', v)),
    slider('Sprite size', o.goblinDisplayPx, 24, 96, 1, (v) => setOption('goblinDisplayPx', v)),
    slider('Sprite Y offset', o.goblinSpriteYOffset, -32, 32, 1, (v) => setOption('goblinSpriteYOffset', v)),
    toggle('Foot shadow',   o.goblinShadow,  (v) => setOption('goblinShadow', v)),
    toggle('Black outline', o.goblinOutline, (v) => setOption('goblinOutline', v)),
    color('Water-goblin color', o.waterGoblinColor, (v) => setOption('waterGoblinColor', v)),
    color('Blood color', o.bloodColor, (v) => setOption('bloodColor', v)),
  ]));

  panel.appendChild(collapsibleSection('Minotaurs', [
    slider('Saturation', o.minotaurSaturation, 0, 2, 0.05, (v) => setOption('minotaurSaturation', v)),
    slider('Brightness', o.minotaurBrightness, 0.2, 2, 0.05, (v) => setOption('minotaurBrightness', v)),
    slider('Sprite size', o.minotaurDisplayPx, 40, 200, 1, (v) => setOption('minotaurDisplayPx', v)),
    slider('Sprite Y offset', o.minotaurSpriteYOffset, -64, 64, 1, (v) => setOption('minotaurSpriteYOffset', v)),
  ]));

  panel.appendChild(collapsibleSection('Dragons', [
    slider('Saturation', o.dragonSaturation, 0, 2, 0.05, (v) => setOption('dragonSaturation', v)),
    slider('Brightness', o.dragonBrightness, 0.2, 2, 0.05, (v) => setOption('dragonBrightness', v)),
    slider('Sprite size', o.dragonDisplayPx, 48, 320, 1, (v) => setOption('dragonDisplayPx', v)),
    slider('Sprite Y offset', o.dragonSpriteYOffset, -64, 64, 1, (v) => setOption('dragonSpriteYOffset', v)),
  ]));

  panel.appendChild(collapsibleSection('Buildings', [
    slider('Saturation', o.buildingSaturation, 0, 2, 0.05, (v) => setOption('buildingSaturation', v)),
    slider('Brightness', o.buildingBrightness, 0.2, 2, 0.05, (v) => setOption('buildingBrightness', v)),
    toggle('Show sprite',      o.buildingSpriteEnabled, (v) => setOption('buildingSpriteEnabled', v)),
    toggle('Show color fill',  o.buildingFillEnabled,   (v) => setOption('buildingFillEnabled', v)),
    slider('Fill alpha',       o.buildingFillAlpha, 0, 1, 0.05, (v) => setOption('buildingFillAlpha', v)),
    toggle('Show border',      o.buildingBorderEnabled, (v) => setOption('buildingBorderEnabled', v)),
    toggle('Show short label', o.buildingLabelEnabled,  (v) => setOption('buildingLabelEnabled', v)),
  ]));

  panel.appendChild(collapsibleSection('Sidebar colors', [
    color('Background',     o.sidebarBg,           (v) => setOption('sidebarBg', v)),
    color('Border',         o.sidebarBorder,       (v) => setOption('sidebarBorder', v)),
    color('Button bg',      o.sidebarButtonBg,     (v) => setOption('sidebarButtonBg', v)),
    color('Button border',  o.sidebarButtonBorder, (v) => setOption('sidebarButtonBorder', v)),
    color('Accent (Ƶ)',     o.sidebarAccent,       (v) => setOption('sidebarAccent', v)),
    color('Title text',     o.sidebarTitleColor,   (v) => setOption('sidebarTitleColor', v)),
    color('Button hover border', o.sidebarButtonHoverBorder, (v) => setOption('sidebarButtonHoverBorder', v)),
    toggle('Rounded buttons', o.buttonsRounded,    (v) => setOption('buttonsRounded', v)),
    toggle('Cut corner buttons', o.buttonsCutCorners, (v) => setOption('buttonsCutCorners', v)),
    slider('Corner cut size', o.buttonCutSize, 0, 24, 1, (v) => setOption('buttonCutSize', v)),
    color('Cut corner border', o.buttonCutBorderColor, (v) => setOption('buttonCutBorderColor', v)),
  ]));

  panel.appendChild(collapsibleSection('Audio', [
    slider('Master volume', o.volume,         0, 1, 0.05, (v) => { setOption('volume', v);         refreshPublic?.(); }),
    slider('Music volume',  o.musicVolume,    0, 1, 0.05, (v) => { setOption('musicVolume', v);    refreshPublic?.(); }),
    toggle('Vinyl crackle', o.crackleEnabled,                (v) => { setOption('crackleEnabled', v); refreshPublic?.(); }),
  ]));

  panel.appendChild(collapsibleSection('Hell', [
    color('BG top',          o.hellBgTop,           (v) => setOption('hellBgTop', v)),
    color('BG bottom',       o.hellBgBottom,        (v) => setOption('hellBgBottom', v)),
    color('Glow color',      o.hellGlowColor,       (v) => setOption('hellGlowColor', v)),
    slider('Glow intensity', o.hellGlowIntensity, 0, 3, 0.05, (v) => setOption('hellGlowIntensity', v)),
    slider('Glow granularity', o.hellGlowSteps, 1, 40, 1, (v) => setOption('hellGlowSteps', v)),
    slider('Ember count',    o.hellEmberCount, 0, 2500, 25, (v) => setOption('hellEmberCount', v)),
    slider('Ember brightness', o.hellEmberBrightness, 0, 1.5, 0.05, (v) => setOption('hellEmberBrightness', v)),
    slider('Ember size',     o.hellEmberSize, 0.1, 5, 0.1, (v) => setOption('hellEmberSize', v)),
    slider('Ghost alpha',    o.hellGhostAlpha, 0, 1, 0.02, (v) => setOption('hellGhostAlpha', v)),
    slider('Ghost brightness', o.hellGhostBrightness, 0, 8, 0.05, (v) => setOption('hellGhostBrightness', v)),
    color('Ghost tint',      o.hellGhostTint,       (v) => setOption('hellGhostTint', v)),
    slider('Ghost fall (px/s)', o.hellGhostFallSpeed, 0, 60, 1, (v) => setOption('hellGhostFallSpeed', v)),
    color('Blood splatter',  o.hellBloodColor,      (v) => setOption('hellBloodColor', v)),
    // The halo rings around each portal's hell-side mirror.
    subheader('Portal mirror rings'),
    slider('Ring count',   o.hellPortalRingCount, 0, 8, 1, (v) => setOption('hellPortalRingCount', v)),
    slider('Ring radius',  o.hellPortalRingRadius, 0.5, 6, 0.1, (v) => setOption('hellPortalRingRadius', v)),
    slider('Ring spacing', o.hellPortalRingSpacing, 5, 200, 5, (v) => setOption('hellPortalRingSpacing', v)),
    slider('Ring width',   o.hellPortalRingWidth, 1, 16, 0.5, (v) => setOption('hellPortalRingWidth', v)),
    color('Ring color',    o.hellPortalRingColor, (v) => setOption('hellPortalRingColor', v)),
    slider('Ring alpha',   o.hellPortalRingAlpha, 0, 1, 0.02, (v) => setOption('hellPortalRingAlpha', v)),
    // The soul sigil's red inner ring at the mirror's centre.
    subheader('Sigil inner ring'),
    slider('Radius',     o.hellSigilRingRadius, 20, 400, 5, (v) => setOption('hellSigilRingRadius', v)),
    slider('Width',      o.hellSigilRingWidth, 1, 16, 0.5, (v) => setOption('hellSigilRingWidth', v)),
    color('Color',       o.hellSigilRingColor, (v) => setOption('hellSigilRingColor', v)),
    slider('Idle alpha', o.hellSigilRingAlpha, 0, 1, 0.02, (v) => setOption('hellSigilRingAlpha', v)),
    // "Lights out" hell: dark veil with fuzzy visibility pools around the
    // mirrors and demons.
    subheader('Darkness veil'),
    toggle('Enabled',          o.hellDarknessEnabled, (v) => setOption('hellDarknessEnabled', v)),
    slider('Veil alpha',       o.hellDarknessAlpha, 0, 1, 0.02, (v) => setOption('hellDarknessAlpha', v)),
    color('Veil color',        o.hellDarknessColor, (v) => setOption('hellDarknessColor', v)),
    slider('Mirror light radius', o.hellDarknessMirrorRadius, 50, 1500, 10, (v) => setOption('hellDarknessMirrorRadius', v)),
    slider('Demon light radius',  o.hellDarknessDemonRadius, 50, 1500, 10, (v) => setOption('hellDarknessDemonRadius', v)),
    slider('Parlay light radius', o.hellDarknessParlayRadius, 50, 1500, 10, (v) => setOption('hellDarknessParlayRadius', v)),
    slider('Light strength',   o.hellDarknessLightAlpha, 0, 1, 0.02, (v) => setOption('hellDarknessLightAlpha', v)),
    // The canvas-side darkening during a parlay / soul chat (speakers exempt).
    slider('Parlay dim alpha', o.hellParlayDimAlpha, 0, 1, 0.02, (v) => setOption('hellParlayDimAlpha', v)),
  ]));

  // The Demons section grew enough dials that it reads as four mini-panels:
  // shared look/behaviour first, then one block per demon.
  panel.appendChild(collapsibleSection('Demons', [
    subheader('All demons'),
    slider('Size', o.demonScale, 0.2, 3, 0.05, (v) => setOption('demonScale', v)),
    slider('Hue', o.demonHue, -180, 180, 1, (v) => setOption('demonHue', v)),
    slider('Saturation', o.demonSaturation, 0, 3, 0.05, (v) => setOption('demonSaturation', v)),
    slider('Brightness', o.demonBrightness, 0, 3, 0.05, (v) => setOption('demonBrightness', v)),
    // The per-letter speech rumble (0 volume silences it).
    slider('Voice volume', o.demonVoiceVolume, 0, 1, 0.02, (v) => setOption('demonVoiceVolume', v)),
    slider('Voice pitch', o.demonVoicePitch, 0.05, 2, 0.01, (v) => setOption('demonVoicePitch', v)),
    slider('Voice pitch wobble', o.demonVoicePitchWobble, 0, 0.5, 0.01, (v) => setOption('demonVoicePitchWobble', v)),
    toggle('Walk (patrol)', o.demonWalks, (v) => setOption('demonWalks', v)),
    slider('Walk speed', o.demonWalkSpeed, 0.1, 5, 0.1, (v) => setOption('demonWalkSpeed', v)),
    slider('Anim speed', o.demonAnimSpeed, 0, 4, 0.1, (v) => setOption('demonAnimSpeed', v)),
    toggle('Foot shadow', o.demonShadow, (v) => setOption('demonShadow', v)),
    slider('Shadow Y', o.demonShadowY, 0, 500, 5, (v) => setOption('demonShadowY', v)),
    // R — the pit colossus (Third Prince of Dark Enjoyment). Stand X/Y is the
    // absolute hell position he holds while standing; the sprite offset
    // nudges only the art (and its shadow) relative to his selection circle /
    // collision centre.
    subheader('R — the colossus'),
    select('Sprite', o.demonRSprite, demonSpriteOpts(), (v) => setOption('demonRSprite', v)),
    select('Facing (standing)', o.demonFacing, FACING_OPTS, (v) => setOption('demonFacing', v as Options['demonFacing'])),
    slider('Stand X', o.demonRX, 0, HELL.width, 10, (v) => setOption('demonRX', v)),
    slider('Stand Y', o.demonRY, 0, HELL.height, 10, (v) => setOption('demonRY', v)),
    slider('Sprite Y offset', o.demonRSpriteYOffset, -400, 400, 5, (v) => setOption('demonRSpriteYOffset', v)),
    color('Tint', o.demonRTint, (v) => setOption('demonRTint', v)),
    // Lilly (demon L) — size also rescales her parlay / click / body radii
    // (demonScaleOf reads this live).
    subheader('Lilly (demon L)'),
    select('Sprite', o.demonLSprite, demonSpriteOpts(), (v) => setOption('demonLSprite', v)),
    slider('Size', o.demonLScale, 0.1, 2, 0.05, (v) => setOption('demonLScale', v)),
    select('Facing (standing)', o.demonLFacing, FACING_OPTS, (v) => setOption('demonLFacing', v as Options['demonLFacing'])),
    slider('Stand X', o.demonLX, 0, HELL.width, 10, (v) => setOption('demonLX', v)),
    slider('Stand Y', o.demonLY, 0, HELL.height, 10, (v) => setOption('demonLY', v)),
    slider('Sprite Y offset', o.demonLSpriteYOffset, -400, 400, 5, (v) => setOption('demonLSpriteYOffset', v)),
    color('Tint', o.demonLTint, (v) => setOption('demonLTint', v)),
    // Lolly (Lilly's corner-dwelling friend) — her own independent dials.
    subheader("Lolly (Lilly's friend)"),
    select('Sprite', o.demonFriendSprite, demonSpriteOpts(), (v) => setOption('demonFriendSprite', v)),
    slider('Size', o.demonFriendScale, 0.1, 2, 0.05, (v) => setOption('demonFriendScale', v)),
    select('Facing (standing)', o.demonFriendFacing, FACING_OPTS, (v) => setOption('demonFriendFacing', v as Options['demonFriendFacing'])),
    slider('Stand X', o.demonFriendX, 0, HELL.width, 10, (v) => setOption('demonFriendX', v)),
    slider('Stand Y', o.demonFriendY, 0, HELL.height, 10, (v) => setOption('demonFriendY', v)),
    slider('Sprite Y offset', o.demonFriendSpriteYOffset, -400, 400, 5, (v) => setOption('demonFriendSpriteYOffset', v)),
    color('Tint', o.demonFriendTint, (v) => setOption('demonFriendTint', v)),
  ]));

  panel.appendChild(collapsibleSection('Robots', [
    slider('Sprite scale', o.robotScale, 0.3, 1.5, 0.02, (v) => setOption('robotScale', v)),
    color('Chassis tint', o.robotTint, (v) => setOption('robotTint', v)),
    toggle('Greyscale art', o.robotGreyscale, (v) => setOption('robotGreyscale', v)),
    slider('Orbital walk speed', o.robotSpaceSpeed, 10, 200, 5, (v) => setOption('robotSpaceSpeed', v)),
  ]));

  panel.appendChild(fontsSection(o));

  // Cheats + debug shortcuts, folded into their own section like everything
  // else so the panel's tail doesn't sprawl.
  const cheatButton = (label: string, onClick: () => void): HTMLElement => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'options-reset';
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  };
  panel.appendChild(collapsibleSection('Cheats', [
    cheatButton('Cheat +Ƶ1,000,000', callbacks.onCheatMoney),
    cheatButton('Cheat +1,000 blood', callbacks.onCheatBlood),
    cheatButton('Cheat +1 GW power', callbacks.onCheatPower),
    cheatButton('Cheat +100 dragon bones', callbacks.onCheatBones),
    cheatButton('Cheat: trigger Bob on next building', callbacks.onTriggerBob),
    cheatButton('Cheat: skip to hell', callbacks.onSkipToHell),
    toggle('Restart in hell (every reload)', getRestartInHell(), setRestartInHell),
    cheatButton('Work skip', callbacks.onTaskSkip),
    cheatButton('Show title screen', callbacks.onShowTitleScreen),
  ]));

  // Copy the current settings (only the keys that differ from defaults) as
  // JSON-ish text — handy for pasting a tuned look into a bug report or chat
  // so the values can be baked back into DEFAULT_OPTIONS.
  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'options-reset';
  copyBtn.textContent = 'Copy settings to clipboard';
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(formatOptionsDiff(getOptions()));
      copyBtn.textContent = 'Copied!';
    } catch {
      copyBtn.textContent = 'Copy failed (clipboard blocked)';
    }
    setTimeout(() => { copyBtn.textContent = 'Copy settings to clipboard'; }, 1500);
  });
  panel.appendChild(copyBtn);

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

  panel.appendChild(unlockHint());
}

// Serialize only the options that differ from DEFAULT_OPTIONS, one `key: value`
// line each. Colour-ish numeric keys print as 0xRRGGBB so they read like the
// literals in options.ts rather than opaque decimals.
const COLOR_KEY_RE = /color|tint|bg|border|accent/i;
function formatOptionsDiff(o: Options): string {
  const lines: string[] = [];
  const fmt = (key: string, v: unknown): string =>
    typeof v === 'number' && COLOR_KEY_RE.test(key)
      ? `0x${v.toString(16).padStart(6, '0')}`
      : JSON.stringify(v);
  for (const key of Object.keys(DEFAULT_OPTIONS) as (keyof Options)[]) {
    if (key === 'fonts') {
      for (const { key: fk } of FONT_KEYS) {
        const cur = o.fonts[fk];
        const def = DEFAULT_OPTIONS.fonts[fk];
        if (cur.family !== def.family || cur.scale !== def.scale) {
          lines.push(`fonts.${fk}: ${JSON.stringify(cur)}`);
        }
      }
      continue;
    }
    if (o[key] !== DEFAULT_OPTIONS[key]) lines.push(`${key}: ${fmt(key, o[key])}`);
  }
  return lines.length ? lines.join('\n') : '(all options at defaults)';
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
  return collapsibleSection('Fonts', rows);
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

// ─── Collapsible sections ───────────────────────────────────────────
// The admin panel grew far past one screenful, so every section folds into a
// native <details> with the title as its <summary>. Which sections are open
// persists in localStorage (collapsed by default), surviving panel rebuilds
// (Reset to defaults) and reloads alike.
const OPEN_SECTIONS_KEY = 'gs.optionsPanel.openSections';
let openSections: Set<string> | null = null;
function getOpenSections(): Set<string> {
  if (openSections) return openSections;
  try {
    openSections = new Set(JSON.parse(localStorage.getItem(OPEN_SECTIONS_KEY) ?? '[]') as string[]);
  } catch {
    openSections = new Set();
  }
  return openSections;
}
function collapsibleSection(title: string, rows: HTMLElement[]): HTMLElement {
  const open = getOpenSections();
  const wrap = document.createElement('details');
  wrap.className = 'options-section';
  wrap.open = open.has(title);
  const summary = document.createElement('summary');
  summary.className = 'options-section-title';
  summary.textContent = title;
  wrap.appendChild(summary);
  for (const r of rows) wrap.appendChild(r);
  wrap.addEventListener('toggle', () => {
    if (wrap.open) open.add(title);
    else open.delete(title);
    try { localStorage.setItem(OPEN_SECTIONS_KEY, JSON.stringify([...open])); } catch { /* no-op */ }
  });
  return wrap;
}

// Thin in-section divider — groups related rows inside a long section (the
// Demons section uses one per demon).
function subheader(text: string): HTMLElement {
  const h = document.createElement('div');
  h.className = 'options-subheader';
  h.textContent = text;
  return h;
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
