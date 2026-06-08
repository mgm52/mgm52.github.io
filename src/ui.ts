import { playSound, playMinotaurCommand } from './audio';
import {
  AUTOSPAWN_TIERS, BUILDABLE_KINDS, BUILDING_DEFS, BuildingKind, DRAG_SELECT_HINT_DELAY_SEC, MULTI_SPAWN_HINT_DELAY_SEC,
  DRAGON, GOBLIN, LIGHTNING, PAN_HINT_DELAY_SEC, ROBOT, SPAWN_HINT_NO_SPAWN_SEC,
  SPAWN_HINT_NO_TASK_SEC, SUMMON_UPGRADES, WATER_HINT_DELAY_SEC, digBloodCost, MINOTAUR, minotaurBloodCost, TINYTAUR, formatPower, SOUL_SIGIL, sigilPortalOutput,
} from './config';
import {
  Building, Cell, Demon, DragonState, GameState, Ghost, Goblin, GoblinState, SoulChair, SpaceBuilding, SpaceUnit, WaterSource,
  appendLog, buildingCenter, buildingLabel, buildingMoneyCost, cellCenter, cellKey, countHypercentres, countIdle, defOf, digDirection,
  earnDragonBone, getSpawnCapacity, holeBlockedByBuilding, isCellBlocked, isInBounds,
  maintainerCount, markBuildingsChanged, nextBuildingDisplayNum, occupyCell, waterCarrierCount,
} from './state';
import { spawnDragon, spawnMinotaur } from './sim';
import { unlockOptionsCog } from './options-ui';

// Build buttons appear in this fixed order, mostly cheapest-first. goblin_hole
// is the exception: it's an auxiliary spawn-capacity expander rendered in the
// Ritual section (see the creation loop), not the Build list — its slot here
// only governs the order refreshUI walks it in.
const SORTED_KINDS: BuildingKind[] = [
  // Wall sits at the top of the build list once unlocked — it's a quick
  // utility the player drops constantly, so keeping it within reach helps.
  'wall',
  'goblin_wheel', 'phone_farm', 'gas_engine',
  'goblin_hole', 'datacentre',
  'nuclear_reactor', 'hypercentre', 'dragon_beacon',
  'hell_portal',
];

// Inserted between adjacent build buttons that belong to different tutorial
// task groups; refreshUI hides separators for not-yet-completed tasks.
type BuildSeparator = { el: HTMLElement; afterTaskId: string };
const buildSeparators: BuildSeparator[] = [];

// Snapshot of completedTaskIds from the previous refreshUI tick — used to
// detect newly-completed tasks and trigger the celebration animation.
const previouslyCompletedTaskIds = new Set<string>();

// Tasks whose celebration overlay has finished — only then do their unlocks
// take effect, so newly-revealed buttons stay hidden behind the overlay
// instead of flashing through it.
const revealedTaskIds = new Set<string>();

// Building kinds the player has outgrown — sticky once the upgrade has gone
// active even once. Mirrors the sticky-task-progress philosophy: destroying
// the upgrade later doesn't bring the obsolete predecessor back.
const obsoletedKinds = new Set<BuildingKind>();

// Building kinds the player has ever placed — sticky. A build button only
// flashes for attention while the player has never built one of that kind.
const everBuiltKinds = new Set<BuildingKind>();

// Sticky: flips true the first time a Minotaur exists. Digging needs a Minotaur,
// so the dig buttons show a "needs Minotaur" banner until this is set — and
// it stays unlocked afterwards even if every Minotaur later dies.
let minotaurEverSummoned = false;

// Build/ritual buttons that have already been visible at least once. First
// appearance gets a soft fade-in via the .fade-in CSS animation.
const everVisibleButtonIds = new Set<string>();

// ─── Staged unlock reveal ───────────────────────────────────────────
// While a task celebration is in flight, game time is frozen (the
// 'unlock-reveal-hold' body class, checked by main.ts's frame loop) and any
// button that first shows is held invisible (.reveal-hidden) and queued here
// instead of fading in. Once the WORK COMPLETE overlay clears,
// runUnlockRevealSequence walks the queue one item at a time: the rest of
// the sidebar dims, each unlock pops in with a glow, gets smooth-scrolled
// into view, and plays a rising chime — the fresh task line lands last —
// then the dim lifts and game time resumes. Deliberately unhurried (half
// speed) so each unlock gets a beat to register.
const REVEAL_STEP_MS = 1100;
const revealQueue: string[] = [];
let celebrationsInFlight = 0;   // WORK COMPLETE overlays currently up
let revealArmed = false;        // an overlay just cleared; kick the walk at the end of this refresh
let revealSequenceActive = false;
let taskTextPendingReveal = false;
function revealHoldActive(): boolean {
  return celebrationsInFlight > 0 || revealArmed || revealSequenceActive;
}
// Buttons currently carrying the faint "new" tag (id → the tag element, a
// positioned sibling in the button's list container). The whole set retires
// the moment a later unlock wave appears (newer content supersedes the old
// call-out); individual tags also clear on first click of their button.
const newBadges = new Map<string, HTMLSpanElement>();
// Width of the gutter a badged button frees up on its left — must match the
// .has-new-badge margin/width shift in index.html.
const NEW_BADGE_GUTTER = 34;
// Buttons revealed during the current refresh pass — collected in
// applyFadeInOnFirstShow, converted to "new" tags at the end of refreshUI so
// same-wave unlocks all tag together.
let newlyShownButtonIds: string[] = [];
// The tutorial's first two unlocks — the task line already walks the player
// into these, so tagging them "new" is noise.
const NEW_BADGE_EXEMPT = new Set(['btn-build-goblin_wheel', 'btn-build-phone_farm']);
// The four compact dig buttons share one tag on their row container — four
// per-button gutters would crush the row to slivers.
function newBadgeTarget(btnId: string): string {
  return btnId.startsWith('btn-dig-') ? 'dig-row' : btnId;
}
// Flips true at the end of the first refresh. Buttons already present on load
// (a resumed save) shouldn't be flagged as "newly unlocked" — only ones that
// appear afterwards do.
let initialButtonsSeeded = false;
// Joined ids of the currently-active tasks, so a change (a fresh task surfacing
// at the bottom of the sidebar) can flag the task line as new content.
let lastActiveTaskKey = '';
// Last-written innerHTML for the power readout / task line — assigning the
// same markup again still rebuilds the DOM nodes, so both writes are gated.
let lastPowerHtml = '';
let lastTaskHtml = '';
// True while the player is dragging the custom scrollbar thumb — keeps the bar
// pinned visible and stops refreshUI from fighting the drag.
let scrollbarDragging = false;

// The build/ritual panel scrolls internally on desktop/landscape, but in phone
// portrait the panel is overflow:visible and the whole sidebar scrolls instead.
// This returns whichever element is actually the scroll container right now.
function buildScrollContainer(): HTMLElement {
  const panel = document.getElementById('panel-build')!;
  return getComputedStyle(panel).overflowY === 'visible'
    ? document.getElementById('sidebar')!
    : panel;
}
function applyFadeInOnFirstShow(btnId: string): void {
  if (everVisibleButtonIds.has(btnId)) return;
  everVisibleButtonIds.add(btnId);
  if (initialButtonsSeeded) {
    const target = newBadgeTarget(btnId);
    if (!NEW_BADGE_EXEMPT.has(btnId) && !newlyShownButtonIds.includes(target)) {
      newlyShownButtonIds.push(target);
    }
    // Newly-unlocked content always lands at the bottom of its menu — that's
    // where the player's eye already is (task line, scroll cue). Buttons
    // present on the initial seed keep their curated order. The dig buttons
    // move as their whole row (the newBadgeTarget unit).
    const moveEl = document.getElementById(target);
    moveEl?.parentElement?.appendChild(moveEl);
    // Mid-celebration: hold the item invisible and queue it for the staged
    // one-at-a-time reveal instead of the plain fade-in.
    if (revealHoldActive()) {
      if (!revealQueue.includes(target)) {
        revealQueue.push(target);
        moveEl?.classList.add('reveal-hidden');
      }
      return;
    }
  }
  const btn = document.getElementById(btnId);
  if (!btn) return;
  btn.classList.add('fade-in');
  window.setTimeout(() => btn.classList.remove('fade-in'), 700);
  // A genuine new unlock landing outside a celebration (no staged reveal to
  // chime for it) still announces itself — same sample as the staged walk,
  // a touch quieter. Buttons present on the initial seed stay silent.
  if (initialButtonsSeeded) playSound('online', 0.35);
}

// Last build-panel visibility handed to updateScrollAffordances, so the raw
// scroll listeners (wired in setupUI) can re-run the update between throttled
// refreshUI calls without recomputing task state.
let lastPanelBuildVisible = false;

// Scroll cues + custom scrollbar, measured off whichever element is the
// active scroll container. Called from refreshUI (throttled to ~10Hz in
// main.ts) and directly from scroll events, so the thumb and cues still
// track momentum scrolling smoothly between refreshes.
function updateScrollAffordances(panelVisible: boolean): void {
  lastPanelBuildVisible = panelVisible;
  const scroller = buildScrollContainer();
  const range = scroller.scrollHeight - scroller.clientHeight;
  const cueDown = panelVisible && range > 4 && scroller.scrollTop < range - 4;
  const cueUp = panelVisible && range > 4 && scroller.scrollTop > 4;
  document.getElementById('scroll-cue')!.classList.toggle('visible', cueDown);
  document.getElementById('scroll-cue-up')!.classList.toggle('visible', cueUp);
  updateCustomScrollbar(panelVisible);
}

// Draws the custom grey scrollbar over the active scroll container. Always
// visible while the area overflows (never fades like the native iOS bar);
// hidden when the panel is closed or fits. Runs every refreshUI frame, so the
// thumb tracks momentum scrolling smoothly.
function updateCustomScrollbar(panelVisible: boolean): void {
  const bar = document.getElementById('sidebar-scrollbar');
  const thumb = document.getElementById('sidebar-scrollbar-thumb');
  if (!bar || !thumb) return;
  const scroller = buildScrollContainer();
  const scrollH = scroller.scrollHeight;
  const clientH = scroller.clientHeight;
  const range = scrollH - clientH;
  if (!panelVisible || range <= 4) { bar.classList.remove('visible'); return; }

  const rect = scroller.getBoundingClientRect();
  const margin = 3;
  const barWidth = 6;
  const trackHeight = rect.height - margin * 2;
  bar.style.top = `${rect.top + margin}px`;
  bar.style.left = `${rect.right - barWidth - margin}px`;
  bar.style.height = `${trackHeight}px`;

  const thumbH = Math.max(24, (clientH / scrollH) * trackHeight);
  const usable = trackHeight - thumbH;
  const thumbTop = usable > 0 ? Math.min(usable, (scroller.scrollTop / range) * usable) : 0;
  thumb.style.height = `${thumbH}px`;
  thumb.style.top = `${Math.max(0, thumbTop)}px`;
  bar.classList.add('visible');
}

// Income/blood rate readouts ("+X/s"). Sampled on a fixed cadence and shown as
// a rolling average over the last few samples so the number doesn't jitter every
// frame. Derived from cumulative *earned* totals (income + kill rewards) rather
// than the balance, so spending on buildings/summons never drags the rate down.
// Cash rate appears once the Phone Farm task is complete (a farm has gone
// active), not merely placed; blood rate once a Minotaur has been summoned. Both
// render at 40% opacity (see .resource-rate).
const RATE_SAMPLE_SEC = 2;
const RATE_HIST_LEN = 5;
let rateInit = false;
let rateLastSampleAt = 0;
let lastMoneySample = 0;
let lastBloodSample = 0;
const moneyRateHist: number[] = [];
const bloodRateHist: number[] = [];

function pushRate(hist: number[], v: number): void {
  hist.push(v);
  if (hist.length > RATE_HIST_LEN) hist.shift();
}
function avgRate(xs: number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}
function formatRate(v: number): string {
  const a = Math.abs(v);
  const num = a < 10 ? a.toFixed(1) : Math.round(a).toLocaleString('en-US');
  const sign = v > 0.05 ? '+' : v < -0.05 ? '-' : '';
  return `${sign}${num}/s`;
}
function updateResourceRates(state: GameState): void {
  if (!rateInit) {
    rateInit = true;
    rateLastSampleAt = state.now;
    lastMoneySample = state.moneyEarned;
    lastBloodSample = state.bloodEarned;
  }
  const dt = state.now - rateLastSampleAt;
  if (dt >= RATE_SAMPLE_SEC) {
    pushRate(moneyRateHist, (state.moneyEarned - lastMoneySample) / dt);
    pushRate(bloodRateHist, (state.bloodEarned - lastBloodSample) / dt);
    lastMoneySample = state.moneyEarned;
    lastBloodSample = state.bloodEarned;
    rateLastSampleAt = state.now;
    setText('money-rate', formatRate(avgRate(moneyRateHist)));
    setText('blood-rate', formatRate(avgRate(bloodRateHist)));
  }
  const moneyRateEl = document.getElementById('money-rate');
  if (moneyRateEl) moneyRateEl.style.display = completedTaskIds.has('run_phone_farm') ? '' : 'none';
  const bloodRateEl = document.getElementById('blood-rate');
  if (bloodRateEl) bloodRateEl.style.display = minotaurEverSummoned ? '' : 'none';
}

// Brief blood-red flash on summon-button click. Reflow forces the animation
// to restart when clicking again before the previous one finishes.
function flashSummonClick(btn: HTMLElement): void {
  btn.classList.remove('click-flash');
  void btn.offsetWidth;
  btn.classList.add('click-flash');
}

// Spawns a shockwave ring at the cursor position. Element self-removes when
// the animation finishes. Pass 'white' for goblin spawn; default is red.
function emanateAtCursor(x: number, y: number, variant?: 'white'): void {
  const el = document.createElement('div');
  el.className = variant === 'white' ? 'click-emanate white' : 'click-emanate';
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  document.body.appendChild(el);
  el.addEventListener('animationend', () => el.remove(), { once: true });
}

// The "demo just stops" pair of alerts + the secret options-cog unlock. Fired
// once the Collect-5-dragon-bones task reveals (gated in refreshUI). The cog
// can also be revealed silently (no alerts) by the shift-click / long-press R
// gesture in options-ui.ts. Idempotency is handled at the call site via
// `!state.optionsUnlocked`.
export function revealSecretSettings(state: GameState): void {
  window.alert(
    "congrats the game is incomplete!!!!! It's unfinished!!!! "
    + "There should be something here next happening but it's not!!!!"
  );
  state.optionsUnlocked = true;
  unlockOptionsCog();
  window.alert(
    "BUT WAIT --- YOU HAVE UNLOCKED THE SECRET SETTINGS MENU OF JUSTICE!!!!!!!!!! "
    + "FIND IT IN THE BOTTOM RIGHT OF THE PLAY AREA. ENJOY"
  );
}

// Click-to-skip bookkeeping for the WORK COMPLETE overlay. Each in-flight
// celebration parks its timers + completion work here so a click on the
// overlay can fast-forward the whole stack straight to the unlock reveal.
// The short buffer stops a click that was already in flight as the overlay
// popped from blowing past it unseen.
const OVERLAY_SKIP_BUFFER_MS = 300;
let overlayShownAt = 0;
type PendingCelebration = { taskId: string; fadeTimer: number; armTimer: number };
const pendingCelebrations: PendingCelebration[] = [];

// Plays the "TASK COMPLETE" overlay + a short Skyrim-ish drum-then-fanfare
// tap. Idempotent in the sense that re-triggers stack the timer; the overlay
// just stays "shown" longer if multiple tasks complete in quick succession.
function playTaskCompleteAnimation(taskId: string): void {
  const overlay = document.getElementById('task-complete-overlay');
  if (!overlay) return;
  // Freeze game time for the whole ceremony: the overlay plus the staged
  // unlock reveal that follows. Released at the end of
  // runUnlockRevealSequence (main.ts checks this class in its frame loop).
  celebrationsInFlight++;
  document.body.classList.add('unlock-reveal-hold');
  // Optional side-tasks read "OPTIONAL COMPLETE" rather than "WORK COMPLETE".
  const task = TASKS.find(t => t.id === taskId);
  const isOptional = task?.optional ?? false;
  const textEl = overlay.querySelector('.task-complete-text');
  if (textEl) textEl.innerHTML = `${isOptional ? 'OPTIONAL' : 'WORK'}<br>COMPLETE`;
  // Subtitle recalls what the finished task actually was.
  const subtitleEl = overlay.querySelector('.task-complete-subtitle');
  if (subtitleEl) subtitleEl.textContent = task?.text ?? '';
  overlay.classList.add('shown');
  overlayShownAt = performance.now();
  // "Level Up/Mission Complete (Resistance)" by Dylan Kelk (freesound 672801).
  playSound('task_complete', 1);
  const entry: PendingCelebration = { taskId, fadeTimer: 0, armTimer: 0 };
  // Hold the overlay for ~2.5s, then fade out (CSS handles the 600ms fade). As it
  // starts fading we snap the build panel back to the top: the staged reveal
  // that follows smooth-scrolls down to each unlock in turn, so starting from
  // the top turns the walk into one clean downward sweep. The jump happens
  // behind the still-opaque overlay, so it isn't visible as a lurch.
  entry.fadeTimer = window.setTimeout(() => {
    overlay.classList.remove('shown');
    buildScrollContainer().scrollTo({ top: 0, behavior: 'auto' });
  }, 2700);
  // Only after the overlay clears do the task's unlocks take effect — the
  // next refreshUI pass collects every freshly-shown item into revealQueue
  // (held invisible via .reveal-hidden) and then kicks off the staged
  // one-by-one reveal at the end of that same pass.
  entry.armTimer = window.setTimeout(() => finishCelebration(entry), 3300);
  pendingCelebrations.push(entry);
}

// The post-overlay bookkeeping: the task's unlocks may now take effect and
// the staged reveal arms. Shared by the natural timer and the click-skip.
function finishCelebration(entry: PendingCelebration): void {
  const i = pendingCelebrations.indexOf(entry);
  if (i >= 0) pendingCelebrations.splice(i, 1);
  revealedTaskIds.add(entry.taskId);
  celebrationsInFlight = Math.max(0, celebrationsInFlight - 1);
  revealArmed = true;
}

// Click-to-skip: a click on the shown overlay (after the short buffer) drops
// it immediately and fast-forwards every stacked celebration, so the next
// refreshUI pass kicks the staged unlock reveal right away.
function skipCelebrationOverlay(): void {
  const overlay = document.getElementById('task-complete-overlay');
  if (!overlay?.classList.contains('shown')) return;
  if (performance.now() - overlayShownAt < OVERLAY_SKIP_BUFFER_MS) return;
  if (pendingCelebrations.length === 0) return;
  overlay.classList.remove('shown');
  buildScrollContainer().scrollTo({ top: 0, behavior: 'auto' });
  for (const entry of [...pendingCelebrations]) {
    window.clearTimeout(entry.fadeTimer);
    window.clearTimeout(entry.armTimer);
    finishCelebration(entry);
  }
}

// Pulls the next element due a staged reveal: queued unlocks first (in visual
// top-to-bottom order — see the sort at the kick site), the fresh task line
// last. Skips ids whose element has vanished in the meantime.
function takeNextRevealTarget(): HTMLElement | null {
  while (revealQueue.length > 0) {
    const el = document.getElementById(revealQueue.shift()!);
    if (el) return el;
  }
  if (taskTextPendingReveal) {
    taskTextPendingReveal = false;
    const el = document.getElementById('task-text');
    if (el && el.style.display !== 'none') return el;
    // No live task line after all (e.g. the run's final task just completed)
    // — don't leave it stuck invisible for whenever it next shows.
    el?.classList.remove('reveal-hidden');
  }
  return null;
}

// Reveal in visual (top-to-bottom) order rather than refreshUI's walk order,
// so the smooth-scroll sweeps down the sidebar once instead of hopping
// between the Summon / Build / Ritual sections.
function sortRevealQueueByDocumentOrder(): void {
  revealQueue.sort((a, b) => {
    const ea = document.getElementById(a);
    const eb = document.getElementById(b);
    if (!ea || !eb) return 0;
    return (ea.compareDocumentPosition(eb) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1;
  });
}

// Walks the staged reveal: each step un-hides one queued unlock, glows it,
// smooth-scrolls it into view, and plays a rising chime; the rest of the
// sidebar stays dimmed (#sidebar.unlock-reveal-dim) throughout. Items queued
// by a celebration that lands mid-walk simply extend the run. When the queue
// (and the pending task line) is exhausted, the dim lifts and the
// unlock-reveal-hold body class is dropped so game time resumes.
function runUnlockRevealSequence(step = 0): void {
  const el = takeNextRevealTarget();
  const sidebar = document.getElementById('sidebar');
  if (!el) {
    revealSequenceActive = false;
    sidebar?.classList.remove('unlock-reveal-dim');
    // Let the un-dim start before the glows retire so the handoff is soft.
    window.setTimeout(() => {
      for (const h of Array.from(document.querySelectorAll('.reveal-highlight, .reveal-lit'))) {
        h.classList.remove('reveal-highlight', 'reveal-lit');
      }
    }, 600);
    // Another task's overlay may already be up — keep time frozen for it.
    if (!revealHoldActive()) document.body.classList.remove('unlock-reveal-hold');
    return;
  }
  revealSequenceActive = true;
  sidebar?.classList.add('unlock-reveal-dim');
  el.classList.remove('reveal-hidden');
  el.classList.add('reveal-highlight');
  // The item's "new" tag (created when the walk kicked off) pops in with it —
  // .reveal-lit punches it through the sidebar dim, and the sync makes it
  // show this step rather than on the next refreshUI frame.
  newBadges.get(el.id)?.classList.add('reveal-lit');
  syncNewBadges();
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  // Rising pitch per unlock so a wave of reveals reads as a little arpeggio.
  playSound('online', 0.5, 1 + step * 0.12);
  window.setTimeout(() => runUnlockRevealSequence(step + 1), REVEAL_STEP_MS);
}

// Tutorial gating: each task unlocks one or more building kinds when complete.
// Tasks form a DAG via `prereq` — multiple tasks with the same prereqs become
// active simultaneously and are shown together.
type Task = {
  id: string;
  text: string;
  // Optional per-frame label override for tasks whose goal is computed at
  // runtime (e.g. a target that scales with live state). Falls back to `text`
  // when absent.
  dynamicText?: (s: GameState) => string;
  unlocks: BuildingKind[];
  isDone: (s: GameState) => boolean;
  prereq?: string[];
  // Optional side-tasks don't gate any other task and render as "Optional: …".
  optional?: boolean;
};

// Tasks are sticky: once a task's isDone has ever returned true in this session,
// we treat it as permanently complete. Stops unlocks/build buttons from
// regressing if e.g. the only Goblin Wheel gets destroyed.
const completedTaskIds = new Set<string>();
// Recomputed each refreshUI; cached so refreshInfoPanel can reuse it without
// re-running the whole task evaluation.
let currentTaskCached: Task | null = null;

// Abilities (summons + rituals) aren't buildings, so they aren't listed in a
// task's `unlocks` (which only takes BuildingKind). Instead each is gated in
// refreshUI on the reveal of the task that grants it:
//   run_phone_farm       → Autobuild, Autospawn
//   build_gas_engine     → Minotaur, Dig
//   summon_minotaurs     → Goldblins
//   run_datacentre       → Lightning Strike (via the sticky
//                          state.lightningUnlocked flag)
// The Dragon summon is special-cased: it has no gating task. Its button shows
// whenever at least one Dragon Beacon is `active`, and the simultaneous-dragon
// cap (live + queued) equals the active-beacon count.
const TASKS: Task[] = [
  {
    id: 'earn_100',
    text: 'Make Ƶ100 (somehow...)',
    unlocks: ['goblin_wheel', 'phone_farm'],
    isDone: (s) => s.money >= 100,
  },
  {
    id: 'run_phone_farm',
    text: 'Run a Phone Farm',
    unlocks: ['gas_engine'],
    isDone: (s) => {
      for (const b of s.buildings.values()) {
        if (b.kind === 'phone_farm' && b.state === 'active') return true;
      }
      return false;
    },
    prereq: ['earn_100'],
  },
  {
    id: 'build_gas_engine',
    text: 'Construct a Gas Turbine',
    unlocks: ['datacentre'],
    isDone: (s) => {
      for (const b of s.buildings.values()) {
        if (b.kind === 'gas_engine' && b.state !== 'constructing') return true;
      }
      return false;
    },
    prereq: ['run_phone_farm'],
  },
  {
    id: 'run_datacentre',
    // Also grants the Lightning Strike ritual (gated in refreshUI, like the
    // other non-building abilities listed above).
    text: 'Run your first datacentre',
    unlocks: ['nuclear_reactor', 'wall'],
    isDone: (s) => {
      for (const b of s.buildings.values()) {
        if (b.kind === 'datacentre' && b.state === 'active') return true;
      }
      return false;
    },
    prereq: ['build_gas_engine'],
  },
  {
    id: 'build_nuclear_reactor',
    text: 'Build a Nuclear Reactor',
    // The Hell Portal ("Bad power source?") opens up alongside the
    // Hypercentre — no longer gated behind ascending.
    unlocks: ['hypercentre', 'hell_portal'],
    isDone: (s) => {
      for (const b of s.buildings.values()) {
        if (b.kind === 'nuclear_reactor') return true;
      }
      return false;
    },
    prereq: ['run_datacentre'],
  },
  {
    id: 'build_hypercentre',
    text: 'Build a Hypercentre',
    unlocks: ['dragon_beacon'],
    isDone: (s) => {
      for (const b of s.buildings.values()) {
        if (b.kind === 'hypercentre') return true;
      }
      return false;
    },
    prereq: ['build_nuclear_reactor'],
  },
  {
    // Optional side-task: unlocks after Phase 3 (build_gas_engine). Grants the
    // Goblin Hole (a Ritual purchase) plus the Goldblins ritual (gated in
    // refreshUI). minotaursSummoned counts rituals that actually finished
    // (not purchases, so a summon mid-ritual doesn't complete this early)
    // and is cumulative for the run, so the task stays complete once reached
    // even if those Minotaurs later die.
    id: 'summon_minotaurs',
    text: 'Summon 2 Minotaurs',
    unlocks: ['goblin_hole'],
    isDone: (s) => s.minotaursSummoned >= 2,
    prereq: ['build_gas_engine'],
    optional: true,
  },
  {
    // Main closing task: amassing 9,999,999 blood fires the demo's "game's
    // incomplete" alerts and unlocks the secret settings menu (see the
    // revealSecretSettings gate in refreshUI). That figure is exactly what
    // the pit colossus grants for feeding him 5 dragon bones (see
    // demon-dialogue.ts), so the intended route runs through the Dragon
    // Beacon (build_hypercentre) and a trip to hell. Grants no building.
    id: 'collect_blood',
    text: 'Collect 9,999,999 blood (somehow…)',
    unlocks: [],
    isDone: (s) => s.blood >= 9_999_999,
    prereq: ['build_hypercentre'],
  },
];

export type UICallbacks = {
  onSpawnGoblin: () => void;
  onSummonMinotaur: () => void;
  onSummonTinytaur: () => void;
  onSummonDragon: () => void;
  onSummonRobot: () => void;
  onPlaceOrbital: () => void;
  onLightningStrike: () => void;
  onBuyAutoAssign: () => void;
  onBuyAutoWater: () => void;
  onBuyAutoSpawn: () => void;
  onBuyGoldgoblins: () => void;
  onBuyGoldgoblinsX10: () => void;
  onDig: (dir: 'n' | 'e' | 's' | 'w') => void;
  onBuildBuilding: (kind: BuildingKind) => void;
  onPlaceCandle: () => void;
  onDestroyBuilding: (id: number) => void;
  onKillGoblin: (id: number) => void;
};

export function setupUI(state: GameState, callbacks: UICallbacks) {
  const summonList = document.getElementById('summon-list')!;
  const ritualList = document.getElementById('ritual-list')!;
  const buildList = document.getElementById('build-list')!;

  // refreshUI runs throttled (main.ts), so also drive the scrollbar/cue
  // updates straight from scroll events — otherwise the custom thumb would
  // visibly lag a flick-scroll. Both possible scroll containers are wired;
  // only the active one ever fires.
  for (const id of ['panel-build', 'sidebar']) {
    document.getElementById(id)?.addEventListener(
      'scroll', () => updateScrollAffordances(lastPanelBuildVisible), { passive: true },
    );
  }

  // The WORK COMPLETE overlay is click-to-skip (after a short buffer) —
  // see skipCelebrationOverlay. While shown it also soaks up the click so
  // it can't reach the buttons underneath (CSS pointer-events in index.html).
  document.getElementById('task-complete-overlay')
    ?.addEventListener('click', skipCelebrationOverlay);

  // Tapping a scroll-cue arrow nudges the panel by most of a page in that
  // direction, so each doubles as a control, not just an indicator.
  document.getElementById('scroll-cue')!.addEventListener('click', () => {
    const sc = buildScrollContainer();
    sc.scrollBy({ top: sc.clientHeight * 0.8, behavior: 'smooth' });
  });
  document.getElementById('scroll-cue-up')!.addEventListener('click', () => {
    const sc = buildScrollContainer();
    sc.scrollBy({ top: -sc.clientHeight * 0.8, behavior: 'smooth' });
  });

  // Custom scrollbar thumb drag — map vertical thumb travel onto the active
  // container's scrollTop. Pointer events cover mouse, touch and pen in one go.
  const scrollbar = document.getElementById('sidebar-scrollbar')!;
  const scrollThumb = document.getElementById('sidebar-scrollbar-thumb')!;
  let dragStartY = 0;
  let dragStartScrollTop = 0;
  scrollThumb.addEventListener('pointerdown', (e: PointerEvent) => {
    e.preventDefault();
    scrollbarDragging = true;
    scrollbar.classList.add('dragging');
    dragStartY = e.clientY;
    dragStartScrollTop = buildScrollContainer().scrollTop;
    scrollThumb.setPointerCapture(e.pointerId);
  });
  scrollThumb.addEventListener('pointermove', (e: PointerEvent) => {
    if (!scrollbarDragging) return;
    const sc = buildScrollContainer();
    const range = sc.scrollHeight - sc.clientHeight;
    const trackHeight = sc.getBoundingClientRect().height - 6;
    const thumbH = Math.max(24, (sc.clientHeight / sc.scrollHeight) * trackHeight);
    const usable = trackHeight - thumbH;
    if (usable <= 0 || range <= 0) return;
    sc.scrollTop = dragStartScrollTop + ((e.clientY - dragStartY) / usable) * range;
  });
  const endScrollDrag = (e: PointerEvent) => {
    if (!scrollbarDragging) return;
    scrollbarDragging = false;
    scrollbar.classList.remove('dragging');
    try { scrollThumb.releasePointerCapture(e.pointerId); } catch { /* already released */ }
  };
  scrollThumb.addEventListener('pointerup', endScrollDrag);
  scrollThumb.addEventListener('pointercancel', endScrollDrag);

  // The pan hint defaults to the keyboard controls; on a touch-primary device
  // there are no arrow keys, so swap in the two-finger gesture instead.
  const panHintEl = document.getElementById('pan-hint');
  if (window.matchMedia('(pointer: coarse)').matches) {
    if (panHintEl) panHintEl.textContent = 'drag two fingers to look around';
    // Likewise spell out the touch gesture for multi-select: one finger drags
    // a selection box (two fingers pan).
    const dragSelectHintEl = document.getElementById('drag-select-hint');
    if (dragSelectHintEl) dragSelectHintEl.textContent = 'Hint: drag one finger to choose many creatures';
    // No arrow keys to hold on touch — the hints are tappable instead (wired
    // up in main.ts), so reword them from "Hold ↑/↓" to "Tap".
    const tapText: Record<string, string> = {
      'ascend-hint': 'Tap to rise into space',
      'descend-hint': 'Tap to return to the surface',
      'descend-hell-hint': 'Tap to descend into hell',
      'ascend-hell-hint': 'Tap to return to the surface',
    };
    for (const [id, text] of Object.entries(tapText)) {
      const el = document.getElementById(id);
      if (el) el.textContent = text;
    }
  }

  // Spawn Goblin button (Summon section).
  const spawnBtn = document.createElement('button');
  spawnBtn.className = 'build-button';
  spawnBtn.id = 'btn-spawn-goblin';
  spawnBtn.innerHTML = `
    ${progressTrack('spawn-goblin', GOBLIN.concurrentBuildLimit)}
    <div class="build-content">
      <div class="build-name">Goblin</div>
    </div>
    <div class="build-warning" id="warn-spawn-goblin" style="display:none">Hole blocked</div>
  `;
  spawnBtn.addEventListener('click', (e) => { playSound('click', 1, 0.75); flashSummonClick(spawnBtn); emanateAtCursor(e.clientX, e.clientY, 'white'); callbacks.onSpawnGoblin(); });
  summonList.appendChild(spawnBtn);

  // Minotaur — unlocks alongside the Datacentre (once a Gas Turbine is built).
  const minotaurBtn = document.createElement('button');
  minotaurBtn.className = 'build-button build-button-compact';
  minotaurBtn.id = 'btn-summon-minotaur';
  minotaurBtn.style.display = 'none';
  minotaurBtn.innerHTML = `
    ${progressTrack('summon-minotaur', MINOTAUR.spawnCapacity)}
    <div class="build-content">
      <div class="build-text">
        <div class="build-name">Minotaur</div>
      </div>
      <div class="build-cost-side"><span class="build-cost" id="cost-summon-minotaur">${MINOTAUR.bloodCost} blood</span></div>
    </div>
  `;
  minotaurBtn.addEventListener('click', (e) => { playSound('click', 1, 0.75); flashSummonClick(minotaurBtn); emanateAtCursor(e.clientX, e.clientY); callbacks.onSummonMinotaur(); });
  summonList.appendChild(minotaurBtn);

  // Tinytaur — secret summon, hidden until the horde gets too packed to grow.
  // Instant (no spawn track), so just a name + blood cost.
  const tinytaurBtn = document.createElement('button');
  tinytaurBtn.className = 'build-button build-button-compact';
  tinytaurBtn.id = 'btn-summon-tinytaur';
  tinytaurBtn.style.display = 'none';
  tinytaurBtn.innerHTML = `
    <div class="build-content">
      <div class="build-text">
        <div class="build-name">Tinytaur</div>
      </div>
      <div class="build-cost-side"><span class="build-cost" id="cost-summon-tinytaur">${TINYTAUR.minotaurCost} minotaurs</span></div>
    </div>
  `;
  tinytaurBtn.addEventListener('click', (e) => { playSound('click', 1, 0.75); flashSummonClick(tinytaurBtn); emanateAtCursor(e.clientX, e.clientY); callbacks.onSummonTinytaur(); });
  summonList.appendChild(tinytaurBtn);

  // Dragon — unlocked once a Dragon Beacon has finished constructing. Instant
  // summon (no track), 64 blood. By default it hauls the priciest building to
  // space; can also be commanded onto units, spots, or specific buildings.
  const dragonBtn = document.createElement('button');
  dragonBtn.className = 'build-button build-button-compact';
  dragonBtn.id = 'btn-summon-dragon';
  dragonBtn.style.display = 'none';
  dragonBtn.innerHTML = `
    ${progressTrack('summon-dragon', DRAGON.concurrentBuildLimit)}
    <div class="build-content">
      <div class="build-text">
        <div class="build-name">Dragon</div>
      </div>
      <div class="build-cost-side"><span class="build-cost" id="cost-summon-dragon">${DRAGON.bloodCost} blood</span></div>
    </div>
  `;
  dragonBtn.addEventListener('click', (e) => { playSound('click', 1, 0.75); flashSummonClick(dragonBtn); emanateAtCursor(e.clientX, e.clientY); callbacks.onSummonDragon(); });
  summonList.appendChild(dragonBtn);

  // Robot — late-game money summon, revealed with the Hypercentre era. The
  // "needs 5 hypercentres" banner sits on the button until the industrial
  // base is big enough. A robot is a small grey goblin that cannot die; its
  // real purpose is being dragon-snatched to orbit, where (unlike everything
  // else) it survives — and can assemble an Orbital Platform.
  const robotBtn = document.createElement('button');
  robotBtn.className = 'build-button build-button-compact';
  robotBtn.id = 'btn-summon-robot';
  robotBtn.style.display = 'none';
  robotBtn.innerHTML = `
    ${progressTrack('summon-robot', ROBOT.spawnCapacity)}
    <div class="build-content">
      <div class="build-text">
        <div class="build-name">Robot</div>
      </div>
      <div class="build-cost-side"><span class="build-cost" id="cost-summon-robot">Ƶ${ROBOT.moneyCost.toLocaleString('en-US')}</span></div>
    </div>
    <div class="build-warning" id="warn-summon-robot" style="display:none">needs ${ROBOT.hypercentresRequired} hypercentres</div>
  `;
  robotBtn.addEventListener('click', (e) => { playSound('click', 1, 0.75); flashSummonClick(robotBtn); emanateAtCursor(e.clientX, e.clientY, 'white'); callbacks.onSummonRobot(); });
  summonList.appendChild(robotBtn);

  // Ritual upgrades — surfaced once a Phone Farm has finished building.
  // Bought ones stay visible but go disabled.
  const autoAssignBtn = document.createElement('button');
  autoAssignBtn.className = 'build-button build-button-compact';
  autoAssignBtn.id = 'btn-buy-autoassign';
  autoAssignBtn.innerHTML = `
    <div class="build-content">
      <div class="build-text">
        <div class="build-name">Autobuild</div>
      </div>
      <div class="build-cost-side"><span class="build-cost" id="cost-buy-autoassign">${SUMMON_UPGRADES.autoAssign.bloodCost} blood</span></div>
    </div>
  `;
  autoAssignBtn.addEventListener('click', () => { playSound('click', 1, 0.75); callbacks.onBuyAutoAssign(); });
  ritualList.appendChild(autoAssignBtn);

  // Autowater — extends Autobuild onto watering duty. Surfaces once
  // Autobuild is owned and a water source has been dug.
  const autoWaterBtn = document.createElement('button');
  autoWaterBtn.className = 'build-button build-button-compact';
  autoWaterBtn.id = 'btn-buy-autowater';
  autoWaterBtn.style.display = 'none';
  autoWaterBtn.innerHTML = `
    <div class="build-content">
      <div class="build-text">
        <div class="build-name">Autowater</div>
      </div>
      <div class="build-cost-side"><span class="build-cost" id="cost-buy-autowater">${SUMMON_UPGRADES.autoWater.bloodCost} blood</span></div>
    </div>
  `;
  autoWaterBtn.addEventListener('click', () => { playSound('click', 1, 0.75); callbacks.onBuyAutoWater(); });
  ritualList.appendChild(autoWaterBtn);

  const autoSpawnBtn = document.createElement('button');
  autoSpawnBtn.className = 'build-button build-button-compact';
  autoSpawnBtn.id = 'btn-buy-autospawn';
  autoSpawnBtn.innerHTML = `
    <div class="build-content">
      <div class="build-text">
        <div class="build-name" id="label-buy-autospawn">Autospawn</div>
      </div>
      <div class="build-cost-side"><span class="build-cost" id="cost-summon-autospawn-cost">${AUTOSPAWN_TIERS[0].bloodCost} blood</span></div>
    </div>
    <div class="build-warning" id="warn-buy-autospawn" style="display:none">not enough holes</div>
  `;
  autoSpawnBtn.addEventListener('click', () => { playSound('click', 1, 0.75); callbacks.onBuyAutoSpawn(); });
  ritualList.appendChild(autoSpawnBtn);

  // Goldgoblins — appears alongside Autobuild (once a Phone Farm is
  // built). Once bought, ~10% of new goblins spawn gold-tinted and drop
  // Ƶ150 each.
  const goldGoblinsBtn = document.createElement('button');
  goldGoblinsBtn.className = 'build-button build-button-compact';
  goldGoblinsBtn.id = 'btn-buy-goldgoblins';
  goldGoblinsBtn.style.display = 'none';
  goldGoblinsBtn.innerHTML = `
    <div class="build-content">
      <div class="build-text">
        <div class="build-name">Goldblins</div>
      </div>
      <div class="build-cost-side"><span class="build-cost" id="cost-buy-goldgoblins">${SUMMON_UPGRADES.goldgoblins.bloodCost} blood</span></div>
    </div>
  `;
  goldGoblinsBtn.addEventListener('click', () => { playSound('click', 1, 0.75); callbacks.onBuyGoldgoblins(); });
  ritualList.appendChild(goldGoblinsBtn);

  // Goldgoblins x10 — appears once base Goldgoblins is owned. Multiplies the
  // gold-goblin money drop 10× (Ƶ250 → Ƶ2500).
  const goldX10Btn = document.createElement('button');
  goldX10Btn.className = 'build-button build-button-compact';
  goldX10Btn.id = 'btn-buy-goldgoblins-x10';
  goldX10Btn.style.display = 'none';
  goldX10Btn.innerHTML = `
    <div class="build-content">
      <div class="build-text">
        <div class="build-name">Goldblins x10</div>
      </div>
      <div class="build-cost-side"><span class="build-cost" id="cost-buy-goldgoblins-x10">${SUMMON_UPGRADES.goldgoblinsX10.bloodCost} blood</span></div>
    </div>
  `;
  goldX10Btn.addEventListener('click', () => { playSound('click', 1, 0.75); callbacks.onBuyGoldgoblinsX10(); });
  ritualList.appendChild(goldX10Btn);

  // Dig row — four compact buttons (NESW) on a single line, unlocked by the
  // Construct-a-Gas-Turbine task (Phase 3). Each is one-shot and costs DIG.bloodCost
  // blood. Digging still needs a Minotaur, so until one is summoned a "needs
  // Minotaur" banner sits across the row and the buttons stay disabled.
  const digRow = document.createElement('div');
  digRow.id = 'dig-row';
  digRow.style.display = 'none';
  digRow.style.position = 'relative';
  digRow.style.gap = '4px';
  digRow.style.marginBottom = '6px';
  for (const dir of ['n', 'e', 's', 'w'] as const) {
    const b = document.createElement('button');
    b.className = 'build-button build-button-compact dig-btn';
    b.id = `btn-dig-${dir}`;
    b.style.flex = '1';
    b.style.padding = '4px 2px';
    b.innerHTML = `
      <div class="build-content" style="flex-direction:column; align-items:center; gap:1px">
        <div class="build-name" style="font-size: calc(13px * var(--font-display-scale))">Dig ${dir.toUpperCase()}</div>
        <span class="build-cost" id="cost-dig-${dir}" style="font-size: calc(10px * var(--font-body-scale))"></span>
      </div>
    `;
    b.addEventListener('click', () => { playSound('click', 1, 0.75); callbacks.onDig(dir); });
    digRow.appendChild(b);
  }
  // "needs Minotaur" banner overlaid across the dig buttons; shown until a
  // Minotaur has been summoned. pointer-events:none so it's purely cosmetic —
  // the buttons underneath are independently disabled in refreshUI.
  const digOverlay = document.createElement('div');
  digOverlay.id = 'dig-overlay';
  digOverlay.textContent = 'needs Minotaur';
  digOverlay.style.position = 'absolute';
  digOverlay.style.inset = '0';
  digOverlay.style.display = 'none';
  digOverlay.style.alignItems = 'center';
  digOverlay.style.justifyContent = 'center';
  digOverlay.style.pointerEvents = 'none';
  digOverlay.style.fontSize = 'calc(12px * var(--font-display-scale))';
  digOverlay.style.fontWeight = 'bold';
  digOverlay.style.letterSpacing = '1px';
  digOverlay.style.color = '#b8bec6';
  digOverlay.style.background = 'rgba(18,14,14,0.74)';
  digOverlay.style.borderRadius = '4px';
  digOverlay.style.zIndex = '2';
  digRow.appendChild(digOverlay);
  ritualList.appendChild(digRow);

  // Lightning Strike — an aimed ritual granted by a truthful demon parlay.
  // Sits at the bottom of the Ritual list. Clicking arms it; the
  // next map click calls the bolt down, killing every unit in the blast
  // (goblins, minotaurs, dragons) for their kill rewards.
  const lightningBtn = document.createElement('button');
  lightningBtn.className = 'build-button build-button-compact';
  lightningBtn.id = 'btn-lightning-strike';
  lightningBtn.style.display = 'none';
  lightningBtn.innerHTML = `
    <div class="build-content">
      <div class="build-text">
        <div class="build-name">Lightning Strike</div>
      </div>
      <div class="build-cost-side"><span class="build-cost" id="cost-lightning-strike">${LIGHTNING.bloodCost} blood</span></div>
    </div>
  `;
  lightningBtn.addEventListener('click', (e) => { playSound('click', 1, 0.75); flashSummonClick(lightningBtn); emanateAtCursor(e.clientX, e.clientY, 'white'); callbacks.onLightningStrike(); });
  ritualList.appendChild(lightningBtn);

  // Map each buildable kind back to the task that unlocks it. Used both for
  // gating and for placing visual separators between task-unlock groups.
  const kindToTaskId: Record<string, string> = {};
  for (const t of TASKS) for (const k of t.unlocks) kindToTaskId[k] = t.id;

  // One button per building kind
  let prevTaskId: string | null = null;
  for (const kind of SORTED_KINDS) {
    const taskId = kindToTaskId[kind] ?? '';
    // The Goblin Hole renders inside the Ritual section rather than the Build
    // list, so it neither emits a build-list separator nor breaks the run of
    // build kinds around it.
    const inRitual = kind === 'goblin_hole';
    if (!inRitual) {
      if (prevTaskId !== null && taskId !== prevTaskId) {
        const sep = document.createElement('div');
        sep.className = 'build-separator';
        buildList.appendChild(sep);
        buildSeparators.push({ el: sep, afterTaskId: taskId });
      }
      prevTaskId = taskId;
    }
    const def = BUILDING_DEFS[kind];
    const btn = document.createElement('button');
    btn.className = 'build-button';
    btn.id = btnId(kind);
    const powerCostBit = def.powerOutput < 0
      ? ` · <span class="build-power-cost" id="power-cost-${kind}">${formatPower(-def.powerOutput)}</span>`
      : '';
    const bloodCostBit = def.bloodCost
      ? ` · <span class="build-cost build-blood-cost" id="blood-cost-${kind}">${def.bloodCost} blood</span>`
      : '';
    const dragonBoneCostBit = def.dragonBoneCost
      ? ` · <span class="build-cost build-bone-cost" id="bone-cost-${kind}">${def.dragonBoneCost} bone${def.dragonBoneCost === 1 ? '' : 's'}</span>`
      : '';
    const yieldBits: string[] = [];
    if (def.income) yieldBits.push(`<span class="yield-money">+Ƶ${def.income.toLocaleString('en-US')}/s</span>`);
    if (def.powerOutput > 0 || kind === 'hell_portal') {
      // Gas Turbine spells its gain out in plain watts rather than the
      // MW-rounded form, so its modest output reads precisely. The Bad
      // power source? advertises a deadpan +0 W despite its true purpose.
      const powerText = kind === 'gas_engine'
        ? `${def.powerOutput.toLocaleString('en-US')} W`
        : formatPower(def.powerOutput);
      yieldBits.push(`<span class="yield-power">+${powerText}</span>`);
    }
    const yieldHtml = yieldBits.length > 0
      ? `<div class="build-yields">${yieldBits.join('<br>')}</div>`
      : '';
    btn.innerHTML = `
      <div class="build-content">
        <div class="build-text">
          <div class="build-name">${def.name}</div>
          <div class="build-meta">
            <span class="build-cost build-gold-cost" id="cost-${kind}">Ƶ${def.cost.toLocaleString('en-US')}</span>${powerCostBit}${bloodCostBit}${dragonBoneCostBit}
          </div>
        </div>
        ${yieldHtml}
      </div>
    `;
    btn.addEventListener('click', () => { playSound('click', 1, 0.75); callbacks.onBuildBuilding(kind); });
    (inRitual ? ritualList : buildList).appendChild(btn);
  }

  // Candle — the hell view's entire Build menu. Hidden on the ground/space;
  // while in hell it replaces every building button (see refreshUI). Arms
  // candle-placement mode: each tap on a mirror's outer ring sets one down
  // for SOUL_SIGIL.candleBloodCost blood. The blue "x soul" advertises that a
  // completed ring's seated souls each multiply the portal's wattage by
  // their own strength.
  const candleBtn = document.createElement('button');
  candleBtn.className = 'build-button';
  candleBtn.id = 'btn-place-candle';
  candleBtn.style.display = 'none';
  candleBtn.innerHTML = `
    <div class="build-content">
      <div class="build-text">
        <div class="build-name">Candle</div>
        <div class="build-meta">
          <span class="build-cost build-blood-cost" id="blood-cost-candle">${SOUL_SIGIL.candleBloodCost} blood</span>
        </div>
      </div>
      <div class="build-yields"><span class="yield-power">x soul</span></div>
    </div>
  `;
  candleBtn.addEventListener('click', () => { playSound('click', 1, 0.75); callbacks.onPlaceCandle(); });
  buildList.appendChild(candleBtn);

  // Orbital Platform — the space view's entire Build menu, mirroring how the
  // Candle takes over in hell. Arms placement mode: the next tap on the void
  // deploys the scaffold. Requires 1 builder, and only a robot up in space
  // qualifies; the meta line spells that out since nothing else will.
  const orbitalDef = BUILDING_DEFS.orbital_platform;
  const orbitalBtn = document.createElement('button');
  orbitalBtn.className = 'build-button';
  orbitalBtn.id = 'btn-place-orbital';
  orbitalBtn.style.display = 'none';
  orbitalBtn.innerHTML = `
    <div class="build-content">
      <div class="build-text">
        <div class="build-name">${orbitalDef.name}</div>
        <div class="build-meta">
          <span class="build-cost build-gold-cost" id="cost-orbital">Ƶ${orbitalDef.cost.toLocaleString('en-US')}</span>
        </div>
      </div>
      <div class="build-yields"><span class="yield-power">robot-built</span></div>
    </div>
  `;
  orbitalBtn.addEventListener('click', () => { playSound('click', 1, 0.75); callbacks.onPlaceOrbital(); });
  buildList.appendChild(orbitalBtn);

  // Destroy button on the info panel — instead of instantly tearing down the
  // building, allocate the nearest minotaur to smash it. Without one, flash
  // a "needs minotaur" warning under the button.
  const destroyBtn = document.getElementById('info-destroy')!;
  let destroyDispatchTimer: number | undefined;
  destroyBtn.addEventListener('click', () => {
    const target = [...state.buildings.values()].find(b => b.selected);
    if (!target) return;
    const minotaurs = [...state.minotaurs.values()];
    const warn = document.getElementById('info-destroy-warning')!;
    if (minotaurs.length === 0) {
      warn.style.display = '';
      window.setTimeout(() => { warn.style.display = 'none'; }, 2000);
      playSound('error');
      return;
    }
    warn.style.display = 'none';
    const c = buildingCenter(target);
    let best = minotaurs[0];
    let bestD = Infinity;
    for (const m of minotaurs) {
      const dx = m.pos.x - c.x;
      const dy = m.pos.y - c.y;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = m; }
    }
    best.target = null;
    best.state = { kind: 'going_to_destroy', buildingId: target.id };
    // Same bellow the right-click command path plays — one dispatched minotaur.
    playMinotaurCommand(1);
    appendLog(state, `Minotaur #${best.id} ordered to smash ${defOf(target).name} #${target.displayNum}.`);
    // Brief confirmation: swap the label to "Minotaur dispatched…" for 2s.
    // refreshInfoPanel only toggles this button's display, never its text, so
    // the override survives the per-frame refresh until the timer restores it.
    destroyBtn.textContent = 'Minotaur dispatched…';
    if (destroyDispatchTimer !== undefined) window.clearTimeout(destroyDispatchTimer);
    destroyDispatchTimer = window.setTimeout(() => {
      destroyBtn.textContent = 'Destroy';
      destroyDispatchTimer = undefined;
    }, 2000);
  });

  // Kill button — kills every currently-selected goblin.
  document.getElementById('info-kill')!.addEventListener('click', () => {
    const ids = [...state.goblins.values()].filter(g => g.selected).map(g => g.id);
    for (const id of ids) callbacks.onKillGoblin(id);
  });
}

function btnId(kind: BuildingKind): string { return `btn-build-${kind}`; }

function anyDatacentreBuilt(state: GameState): boolean {
  for (const b of state.buildings.values()) {
    if (b.kind === 'datacentre' && b.state !== 'constructing') return true;
  }
  return false;
}

// Toggles the gentle attention-flash on a build/ritual button. Surfaces only
// for purchasables the player has never bought before that they can afford
// right now — see refreshUI for the per-button predicates.
function setBuyFlash(btnId: string, on: boolean): void {
  document.getElementById(btnId)?.classList.toggle('buy-flash', on);
}

// Faint "new" tag in the gutter left of a freshly-unlocked button. The tag is
// a positioned sibling (the buttons clip their own children via overflow /
// the cut-corner clip-path), and the button shifts right via .has-new-badge
// to clear the gutter. Cleared on the button's first click, or wholesale when
// a later unlock wave lands (see the newlyShownButtonIds processing in
// refreshUI). syncNewBadges keeps each tag glued to its button across reflows.
function addNewBadge(id: string): void {
  const btn = document.getElementById(id);
  if (!btn || newBadges.has(id)) return;
  const parent = btn.parentElement!;
  if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
  const tag = document.createElement('span');
  tag.className = 'new-badge';
  tag.textContent = 'new';
  parent.insertBefore(tag, btn);
  btn.classList.add('has-new-badge');
  newBadges.set(id, tag);
  btn.addEventListener('click', () => removeNewBadge(id), { once: true });
}

function removeNewBadge(id: string): void {
  newBadges.get(id)?.remove();
  newBadges.delete(id);
  document.getElementById(id)?.classList.remove('has-new-badge');
}

// Repositions every live tag against its button's current offset box — runs
// each refreshUI frame so the tags track buttons that move as neighbours
// appear/hide, and vanish while their button is hidden.
function syncNewBadges(): void {
  for (const [id, tag] of newBadges) {
    const btn = document.getElementById(id);
    // A button held invisible for the staged reveal (.reveal-hidden keeps its
    // layout slot, so offsetParent is still set) hides its tag too — both pop
    // in together when the walk reaches it.
    if (!btn || btn.offsetParent === null || btn.classList.contains('reveal-hidden')) {
      tag.style.display = 'none';
      continue;
    }
    tag.style.display = '';
    // offsetLeft includes the .has-new-badge margin, so this lands the tag
    // in the freed gutter.
    tag.style.left = `${btn.offsetLeft - NEW_BADGE_GUTTER}px`;
    tag.style.top = `${btn.offsetTop + btn.offsetHeight / 2}px`;
  }
}

function refreshRitualButton(
  btnId: string, costId: string,
  visible: boolean, owned: boolean, canAfford: boolean,
  costText: string,
) {
  const btn = document.getElementById(btnId) as HTMLButtonElement;
  const cost = document.getElementById(costId)!;
  btn.style.display = visible ? '' : 'none';
  if (!visible) { setBuyFlash(btnId, false); return; }
  if (owned) {
    btn.disabled = true;
    cost.textContent = 'owned';
    cost.classList.remove('met');
    cost.classList.add('owned');
  } else {
    btn.disabled = !canAfford;
    cost.textContent = costText;
    cost.classList.toggle('met', canAfford);
    cost.classList.remove('owned');
  }
  // Set disabled BEFORE applying the fade-in so the right keyframes pick.
  applyFadeInOnFirstShow(btnId);
  // Never-bought one-shot rituals flash while affordable.
  setBuyFlash(btnId, !owned && canAfford);
}

// Single Autospawn button that levels up through AUTOSPAWN_TIERS. The same
// button morphs from "Autospawn" → "Autospawn x2" → "Autospawn x4" → … → x32,
// each purchase replacing the prior in the menu. Once the player owns x32,
// the button is hidden. Shows "needs more holes" when the next-tier multiplier
// would exceed total spawn capacity.
function refreshAutospawnButton(state: GameState, unlocked: boolean): void {
  const btn = document.getElementById('btn-buy-autospawn') as HTMLButtonElement;
  const cost = document.getElementById('cost-summon-autospawn-cost')!;
  const label = document.getElementById('label-buy-autospawn')!;
  const warn = document.getElementById('warn-buy-autospawn')!;
  if (!unlocked) {
    btn.style.display = 'none';
    setBuyFlash('btn-buy-autospawn', false);
    return;
  }
  const current = state.autoSpawnMultiplier;
  // Find the next tier the player can buy.
  const next = AUTOSPAWN_TIERS.find(t => t.multiplier > current);
  if (!next) {
    // Already at max — hide the button.
    btn.style.display = 'none';
    setBuyFlash('btn-buy-autospawn', false);
    return;
  }
  btn.style.display = '';
  label.textContent = next.multiplier === 1 ? 'Autospawn' : `Autospawn x${next.multiplier}`;
  cost.textContent = `${next.bloodCost} blood`;
  const canAfford = state.blood >= next.bloodCost;
  cost.classList.toggle('met', canAfford);
  cost.classList.remove('owned');
  // Block the buy if the next tier would outpace the current spawn cap;
  // the warning explains why the button is greyed out.
  const cap = getSpawnCapacity(state);
  const willOverflow = next.multiplier > cap;
  warn.style.display = willOverflow ? '' : 'none';
  btn.disabled = !canAfford || willOverflow;
  // First reveal: fade in + "new" tag, like every other unlockable button.
  // (Set disabled above first so the fade picks the right keyframes.)
  applyFadeInOnFirstShow('btn-buy-autospawn');
  // Flash only the very first purchase — once Autospawn has ever been bought
  // the player knows the upgrade exists, so later tiers don't flash.
  setBuyFlash('btn-buy-autospawn', current === 0 && canAfford && !willOverflow);
}

function progressTrack(id: string, slots: number): string {
  const segs = Array.from({ length: slots }, (_, i) =>
    `<div class="seg" id="seg-${id}-${i}"><div class="fill" id="fill-${id}-${i}"></div></div>`,
  ).join('');
  return `<div class="build-progress-track">${segs}</div>`;
}

// One-shot init: when refreshUI is first called against a state, mark every
// already-done task as both completed and revealed. Resuming a saved game
// would otherwise replay every TASK COMPLETE celebration on the first frame.
let firstRefreshDone = false;

export function refreshUI(state: GameState) {
  if (!firstRefreshDone) {
    firstRefreshDone = true;
    for (const t of TASKS) {
      // Same DAG guard as the live loop below: don't auto-complete a task from
      // isDone alone unless its prereqs are too, so an early-satisfiable task
      // (the optional Summon-2-Minotaurs side-task) can't reveal its unlock out
      // of order on load. Genuinely
      // persisted progress is restored separately by the hydration step below.
      const prereqsDone = !t.prereq || t.prereq.every(id => completedTaskIds.has(id));
      if (prereqsDone && t.isDone(state)) {
        completedTaskIds.add(t.id);
        previouslyCompletedTaskIds.add(t.id);
        revealedTaskIds.add(t.id);
      }
    }
    // Hydrate persisted unlocks (sticky progress that may no longer be derivable
    // from isDone — e.g. the building that completed a task was since destroyed).
    const u = state.unlocks;
    if (u) {
      // Migrate the legacy task id: 'earn_30_blood' was renamed to
      // 'summon_minotaurs' (it always tracked summoning 2 Minotaurs). Map the
      // old id onto the new one so an in-progress save keeps Goldblins unlocked.
      if (u.completed.has('earn_30_blood')) u.completed.add('summon_minotaurs');
      if (u.revealed.has('earn_30_blood')) u.revealed.add('summon_minotaurs');
      // Same for 'collect_dragon_bones' → 'collect_blood' (the closing task's
      // goal changed; a save that finished the demo stays finished).
      if (u.completed.has('collect_dragon_bones')) u.completed.add('collect_blood');
      if (u.revealed.has('collect_dragon_bones')) u.revealed.add('collect_blood');
      for (const id of u.completed) { completedTaskIds.add(id); previouslyCompletedTaskIds.add(id); }
      for (const id of u.revealed) revealedTaskIds.add(id);
      for (const k of u.obsoleted) obsoletedKinds.add(k);
      for (const k of u.everBuilt) everBuiltKinds.add(k);
      if (u.minotaurEverSummoned) minotaurEverSummoned = true;
    }
  }
  const idle = countIdle(state);

  setText('money', Math.floor(state.money).toLocaleString('en-US'));

  // Blood resource — hidden until the player kills their first goblin.
  setText('blood', state.blood.toString());

  // Dragon Bones — row stays hidden until the first one is collected, then
  // sticks around (the unlock flag persists even if the count returns to 0).
  const dragonBoneRow = document.getElementById('row-dragonbone');
  if (dragonBoneRow) {
    dragonBoneRow.style.display = state.dragonBoneUnlocked ? '' : 'none';
    if (state.dragonBoneUnlocked) setText('dragonbone', state.dragonBone.toString());
  }

  // Faint "+X/s" rate readouts beside cash + blood.
  updateResourceRates(state);

  // Power: hide entirely until any production exists, then show consumed /
  // produced. Always blue — the deficit signal lives on individual buildings
  // (their dormant state + warning), not on the resource line.
  const produced = state.lastPowerProduced;
  const consumed = state.lastPowerConsumed;
  const powerRow = document.getElementById('row-power')!;
  powerRow.style.display = produced > 0 ? '' : 'none';
  const powerEl = document.getElementById('power')!;
  // innerHTML assignment rebuilds child nodes even when the markup is
  // unchanged, so gate it on a cached copy of the last-written string.
  const powerHtml = consumed > 0
    ? `${formatPower(produced - consumed)}<span class="power-total"> / ${formatPower(produced)}</span>`
    : formatPower(produced);
  if (powerHtml !== lastPowerHtml) {
    lastPowerHtml = powerHtml;
    powerEl.innerHTML = powerHtml;
  }
  powerEl.style.color = '#8acfff';

  // Spawn Goblin button — sidebar, always visible. Surfaces a "Hole blocked"
  // warning when a building is on the hole.
  const spawnInProgress = state.spawnQueue.length;
  const spawnBtn = document.getElementById('btn-spawn-goblin') as HTMLButtonElement;
  const canAffordGoblin = state.money >= GOBLIN.spawnCost;
  const holeBlocked = holeBlockedByBuilding(state);
  const cap = getSpawnCapacity(state);
  spawnBtn.disabled = !canAffordGoblin || holeBlocked || spawnInProgress >= cap;
  spawnBtn.classList.toggle('in-progress', spawnInProgress > 0);
  const warnEl = document.getElementById('warn-spawn-goblin')!;
  warnEl.style.display = holeBlocked ? '' : 'none';
  const spawnBySlot: Record<number, number> = {};
  for (const item of state.spawnQueue) {
    spawnBySlot[item.slot] = 1 - item.remaining / GOBLIN.spawnTime;
  }
  for (let i = 0; i < GOBLIN.concurrentBuildLimit; i++) {
    const seg = document.getElementById(`seg-spawn-goblin-${i}`);
    if (seg) seg.style.display = i < cap ? '' : 'none';
    setFillWidth(`fill-spawn-goblin-${i}`, spawnBySlot[i] ?? 0);
  }

  // Minotaur button — unlocked by the Construct-a-Gas-Turbine task (Phase 3).
  // Gated on revealedTaskIds so it fades in after the TASK COMPLETE overlay
  // clears. Cost doubles per summon (8→16→32→64). Disabled while a summon is in
  // progress; the segment bar fills like the Goblin button's spawn track.
  const minotaurBtn = document.getElementById('btn-summon-minotaur') as HTMLButtonElement;
  const minotaurCostEl = document.getElementById('cost-summon-minotaur')!;
  if (revealedTaskIds.has('build_gas_engine')) {
    minotaurBtn.style.display = '';
    applyFadeInOnFirstShow('btn-summon-minotaur');
    // First frame the summon is unlocked: lock in the one-time mercy
    // discount if the player's blood is below the discounted price.
    if (state.minotaurFirstDiscount === null) {
      state.minotaurFirstDiscount = state.blood < MINOTAUR.firstBloodCost;
    }
    const queued = state.minotaurSpawnQueue.length;
    const minoCost = minotaurBloodCost(state.minotaursBought, state.minotaurFirstDiscount);
    const canAffordMinotaur = state.blood >= minoCost;
    minotaurBtn.disabled = queued > 0 || !canAffordMinotaur;
    minotaurCostEl.textContent = `${minoCost} blood`;
    minotaurCostEl.classList.toggle('met', canAffordMinotaur && queued === 0);
    minotaurBtn.classList.toggle('in-progress', queued > 0);
    const remaining = queued > 0 ? state.minotaurSpawnQueue[0].remaining : MINOTAUR.spawnTime;
    const fill = queued > 0 ? 1 - remaining / MINOTAUR.spawnTime : 0;
    setFillWidth('fill-summon-minotaur-0', Math.max(0, Math.min(1, fill)));
  } else {
    minotaurBtn.style.display = 'none';
  }

  // Tinytaur button — secret summon, revealed (sticky, set in the sim tick)
  // once the player has fielded enough Minotaurs to pay its sacrifice cost.
  // Costs TINYTAUR.minotaurCost living Minotaurs, who die on spawn.
  const tinytaurBtn = document.getElementById('btn-summon-tinytaur') as HTMLButtonElement;
  if (state.tinytaurUnlocked) {
    tinytaurBtn.style.display = '';
    applyFadeInOnFirstShow('btn-summon-tinytaur');
    let realMinotaurs = 0;
    for (const m of state.minotaurs.values()) if (!m.tiny) realMinotaurs++;
    const canAffordTinytaur = realMinotaurs >= TINYTAUR.minotaurCost;
    tinytaurBtn.disabled = !canAffordTinytaur;
    const tinytaurCost = document.getElementById('cost-summon-tinytaur')!;
    tinytaurCost.classList.toggle('met', canAffordTinytaur);
  } else {
    tinytaurBtn.style.display = 'none';
  }

  // Dragon button — shows whenever at least one Dragon Beacon is `active`. The
  // spawn-queue cap equals the active-beacon count (live dragons are uncapped,
  // mirroring how Goblin Holes cap the spawn queue but not live goblins).
  const dragonBtn = document.getElementById('btn-summon-dragon') as HTMLButtonElement;
  let activeBeaconCount = 0;
  for (const b of state.buildings.values()) {
    if (b.kind === 'dragon_beacon' && b.state === 'active') activeBeaconCount++;
  }
  if (activeBeaconCount > 0) {
    dragonBtn.style.display = '';
    applyFadeInOnFirstShow('btn-summon-dragon');
    const queued = state.dragonSpawnQueue.length;
    const live = state.dragons.size;
    const atCap = queued >= activeBeaconCount;
    const canAffordDragon = state.blood >= DRAGON.bloodCost;
    dragonBtn.disabled = atCap || !canAffordDragon;
    const dragonCost = document.getElementById('cost-summon-dragon')!;
    dragonCost.classList.toggle('met', canAffordDragon && !atCap);
    dragonBtn.classList.toggle('in-progress', queued > 0);
    // One progress line per beacon (with at least enough lines to keep showing
    // any over-cap leftovers if a beacon was just hoisted into orbit while
    // dragons were mid-ritual). Each queued dragon fills its corresponding
    // line top-down.
    const visibleSegs = Math.min(DRAGON.concurrentBuildLimit, Math.max(activeBeaconCount, queued));
    for (let i = 0; i < DRAGON.concurrentBuildLimit; i++) {
      const seg = document.getElementById(`seg-summon-dragon-${i}`);
      if (seg) seg.style.display = i < visibleSegs ? '' : 'none';
      const entry = state.dragonSpawnQueue[i];
      const fill = entry ? 1 - entry.remaining / DRAGON.spawnTime : 0;
      setFillWidth(`fill-summon-dragon-${i}`, Math.max(0, Math.min(1, fill)));
    }
    setBuyFlash('btn-summon-dragon', canAffordDragon && !atCap && live === 0 && state.spaceBuildings.size === 0 && queued === 0);
  } else {
    dragonBtn.style.display = 'none';
    setBuyFlash('btn-summon-dragon', false);
  }

  // Robot button — revealed by the Build-a-Hypercentre task, but stays banner-
  // gated ("needs 5 hypercentres") until the industrial base reaches
  // ROBOT.hypercentresRequired (ground + orbit combined). Costs money.
  const robotBtn = document.getElementById('btn-summon-robot') as HTMLButtonElement;
  if (revealedTaskIds.has('build_hypercentre')) {
    robotBtn.style.display = '';
    applyFadeInOnFirstShow('btn-summon-robot');
    const hcs = countHypercentres(state);
    const enoughHCs = hcs >= ROBOT.hypercentresRequired;
    const canAffordRobot = state.money >= ROBOT.moneyCost;
    // Assembly runs on a timed track like the other summons — one at a time.
    const robotQueued = state.robotSpawnQueue.length;
    robotBtn.disabled = !enoughHCs || !canAffordRobot || robotQueued >= ROBOT.spawnCapacity;
    robotBtn.classList.toggle('in-progress', robotQueued > 0);
    const robotRemaining = robotQueued > 0 ? state.robotSpawnQueue[0].remaining : ROBOT.spawnTime;
    const robotFill = robotQueued > 0 ? 1 - robotRemaining / ROBOT.spawnTime : 0;
    setFillWidth('fill-summon-robot-0', Math.max(0, Math.min(1, robotFill)));
    document.getElementById('warn-summon-robot')!.style.display = enoughHCs ? 'none' : '';
    const robotCost = document.getElementById('cost-summon-robot')!;
    robotCost.classList.toggle('met', canAffordRobot && enoughHCs && robotQueued === 0);
    // Nudge once the gate finally opens and the player has never built one.
    setBuyFlash('btn-summon-robot', enoughHCs && canAffordRobot && robotQueued === 0 && ![...state.goblins.values()].some((g) => g.robot) && state.spaceUnits.size === 0);
  } else {
    robotBtn.style.display = 'none';
    setBuyFlash('btn-summon-robot', false);
  }

  // Tutorial: build the completed set first, then collect any tasks whose
  // prereqs are all done but which are themselves not done yet — those are
  // the *active* tasks (multiple can be active at once). A completed task's
  // unlocks only kick in once its celebration overlay has finished
  // (revealedTaskIds), so newly-revealed buttons stay hidden during the
  // black-out and then fade in.
  const unlocked = new Set<BuildingKind>();
  for (const t of TASKS) {
    // A task can only complete once its prereqs have, so an isDone satisfiable
    // out of DAG order can't fire its unlock early (the Goblin Hole's
    // Summon-2-Minotaurs task, gated behind build_gas_engine, would otherwise
    // pop the instant a Minotaur count crossed 2). Safe as a single forward pass: prereqs
    // precede their dependents in TASKS, so they're added to completedTaskIds
    // earlier in this same loop.
    const prereqsDone = !t.prereq || t.prereq.every(id => completedTaskIds.has(id));
    if (completedTaskIds.has(t.id) || (prereqsDone && t.isDone(state))) {
      completedTaskIds.add(t.id);
      if (revealedTaskIds.has(t.id)) {
        for (const k of t.unlocks) unlocked.add(k);
      }
    }
  }
  // Fire the celebration animation for any task that crossed the threshold
  // since the last frame.
  for (const id of completedTaskIds) {
    if (!previouslyCompletedTaskIds.has(id)) {
      previouslyCompletedTaskIds.add(id);
      playTaskCompleteAnimation(id);
    }
  }
  const activeTasks: Task[] = [];
  for (const t of TASKS) {
    if (completedTaskIds.has(t.id)) continue;
    const ready = !t.prereq || t.prereq.every(id => completedTaskIds.has(id));
    if (ready) activeTasks.push(t);
  }
  // Mandatory tasks first, optional side-tasks after (stable within each group).
  activeTasks.sort((a, b) => Number(a.optional ?? false) - Number(b.optional ?? false));
  const firstTaskDone = completedTaskIds.has('earn_100');
  currentTaskCached = activeTasks[0] ?? null;
  const buildSection = document.getElementById('build-section')!;
  buildSection.style.display = firstTaskDone ? '' : 'none';

  // Reveal flags for the task-gated abilities. Gated on revealedTaskIds (not
  // completedTaskIds) so each button emerges AFTER its TASK COMPLETE overlay
  // fades, letting the fade-in animation play.
  //   run_phone_farm       → Autobuild, Autospawn
  //   build_gas_engine     → Dig (+ Minotaur, handled above)
  //   summon_minotaurs     → Goldblins
  // (Lightning Strike is granted by the demon parlay, not a task.)
  const phaseRunPhoneFarm = revealedTaskIds.has('run_phone_farm');
  const phaseGasTurbine = revealedTaskIds.has('build_gas_engine');
  const minotaurTaskDone = revealedTaskIds.has('summon_minotaurs');

  // Amassing 9,999,999 blood is the demo's closing easter egg: once that task
  // reveals, fire the "game's incomplete" alerts and unlock the secret settings
  // menu. revealSecretSettings is guarded so it only runs once. (Old saves may
  // carry the legacy 'collect_dragon_bones' id — migrated on load above.)
  if (revealedTaskIds.has('collect_blood') && !state.optionsUnlocked) {
    revealSecretSettings(state);
  }

  // Lightning Strike — part of the run_datacentre reward. Granted via the
  // sticky lightningUnlocked flag so the save plumbing stays unchanged.
  // Disabled when the player can't cover the blood cost; lit while armed.
  if (revealedTaskIds.has('run_datacentre')) state.lightningUnlocked = true;
  const lightningBtn = document.getElementById('btn-lightning-strike') as HTMLButtonElement;
  if (state.lightningUnlocked) {
    lightningBtn.style.display = '';
    applyFadeInOnFirstShow('btn-lightning-strike');
    const canAffordLightning = state.blood >= LIGHTNING.bloodCost;
    const onCooldown = state.lightningStrikeCooldown > 0;
    // Unlike the other rituals (which act on the overworld from anywhere),
    // the strike has to be AIMED at the ground — disable it off-ground.
    const offGround = state.view !== 'ground';
    lightningBtn.disabled = !canAffordLightning || onCooldown || offGround;
    lightningBtn.classList.toggle('active', state.pendingStrike);
    document.getElementById('cost-lightning-strike')!.classList.toggle('met', canAffordLightning && !onCooldown && !offGround);
    // Mid-aim bankruptcy (mirrors the candle): if the player can no longer
    // cover the strike while aiming it, drop out of aim mode rather than
    // letting every map click error-beep.
    if (state.pendingStrike && !canAffordLightning) state.pendingStrike = false;
  } else {
    lightningBtn.style.display = 'none';
  }

  // Dig rewards build_gas_engine (Phase 3). Digging itself still needs a
  // Minotaur (also rewarded around Phase 3), so a "needs Minotaur" banner covers
  // the row until one is summoned; see the dig-overlay below.
  const digUnlocked = phaseGasTurbine;
  const ritualVisible = phaseRunPhoneFarm || phaseGasTurbine || minotaurTaskDone || state.lightningUnlocked;
  const ritualSection = document.getElementById('ritual-section')!;
  ritualSection.style.display = ritualVisible ? '' : 'none';
  // Now that the panel renders as a bordered card, an empty container shows
  // up as a thin empty bar — hide the outer panel until either subsection
  // unlocks.
  const panelBuild = document.getElementById('panel-build')!;
  const panelBuildVisible = firstTaskDone || ritualVisible;
  panelBuild.style.display = panelBuildVisible ? '' : 'none';

  // A fresh task surfacing at the bottom of the sidebar is part of the unlock
  // wave: hold its line invisible so the staged reveal can land it last.
  const activeTaskKey = activeTasks.map(t => t.id).join('|');
  if (initialButtonsSeeded && activeTaskKey && activeTaskKey !== lastActiveTaskKey && revealHoldActive()) {
    taskTextPendingReveal = true;
    document.getElementById('task-text')?.classList.add('reveal-hidden');
  }
  lastActiveTaskKey = activeTaskKey;

  // Scroll cues — muted chevrons at the top/bottom of the build panel whenever
  // any content sits off-screen in that direction (iOS/macOS hide overlay
  // scrollbars, so without these the area doesn't read as scrollable). We also
  // keep the custom grey scrollbar in sync here. All measure whichever element
  // is the scroll container right now (build panel vs whole sidebar; see media
  // query).
  updateScrollAffordances(panelBuildVisible);

  // Autobuild → Autowater replace chain: Autowater needs Autobuild owned
  // AND a water source dug (so the upgrade has something to act on). The
  // Autobuild button hides ONLY once Autowater is actually visible — until
  // then it lingers (as "owned") so the slot isn't left empty.
  const autoWaterVisible = state.autoAssignEnabled && state.waterSources.size > 0;
  refreshRitualButton(
    'btn-buy-autoassign', 'cost-buy-autoassign',
    phaseRunPhoneFarm && !autoWaterVisible,
    state.autoAssignEnabled, state.blood >= SUMMON_UPGRADES.autoAssign.bloodCost,
    `${SUMMON_UPGRADES.autoAssign.bloodCost} blood`,
  );
  refreshRitualButton(
    'btn-buy-autowater', 'cost-buy-autowater',
    autoWaterVisible,
    state.autoWaterEnabled, state.blood >= SUMMON_UPGRADES.autoWater.bloodCost,
    `${SUMMON_UPGRADES.autoWater.bloodCost} blood`,
  );
  // Autospawn — unlocked by the Run-a-Phone-Farm task (Phase 2).
  refreshAutospawnButton(state, phaseRunPhoneFarm);
  // Goldblins → Goldblins x10 form a replace chain (like Autospawn): base
  // button hides once owned, x10 takes its place; x10 hides once owned.
  // Base Goldblins unlocks via the optional Summon-2-Minotaurs side-task; x10
  // follows once base Goldblins is owned.
  refreshRitualButton(
    'btn-buy-goldgoblins', 'cost-buy-goldgoblins',
    minotaurTaskDone && !state.goldgoblinsEnabled, false,
    state.blood >= SUMMON_UPGRADES.goldgoblins.bloodCost,
    `${SUMMON_UPGRADES.goldgoblins.bloodCost} blood`,
  );
  refreshRitualButton(
    'btn-buy-goldgoblins-x10', 'cost-buy-goldgoblins-x10',
    state.goldgoblinsEnabled && state.goldgoblinMultiplier < SUMMON_UPGRADES.goldgoblinsX10.multiplier,
    false,
    state.blood >= SUMMON_UPGRADES.goldgoblinsX10.bloodCost,
    `${SUMMON_UPGRADES.goldgoblinsX10.bloodCost} blood`,
  );

  // Dig row: unlocked by the Construct-a-Gas-Turbine task (Phase 3). Each
  // direction is one-shot. First time the row appears, each button fades in.
  // Until a Minotaur has been summoned (also Phase 3), a "needs Minotaur" banner
  // covers the row and the buttons are disabled.
  if (state.minotaurs.size > 0) minotaurEverSummoned = true;
  const needsMinotaur = !minotaurEverSummoned;
  const digRow = document.getElementById('dig-row')!;
  digRow.style.display = digUnlocked ? 'flex' : 'none';
  const digOverlay = document.getElementById('dig-overlay');
  if (digOverlay) digOverlay.style.display = (digUnlocked && needsMinotaur) ? 'flex' : 'none';
  for (const dir of ['n', 'e', 's', 'w'] as const) {
    const btn = document.getElementById(`btn-dig-${dir}`) as HTMLButtonElement;
    if (!btn) continue;
    if (digUnlocked) applyFadeInOnFirstShow(`btn-dig-${dir}`);
    const dug = state.dugDirections.has(dir);
    const nextCost = digBloodCost(state.dugDirections.size);
    const canAfford = state.blood >= nextCost;
    btn.disabled = dug || !canAfford || needsMinotaur;
    setBuyFlash(`btn-dig-${dir}`, digUnlocked && !needsMinotaur && !dug && canAfford);
    const label = btn.querySelector('.build-name') as HTMLElement | null;
    if (label) label.textContent = dug ? `${dir.toUpperCase()} ✓` : `Dig ${dir.toUpperCase()}`;
    const cost = document.getElementById(`cost-dig-${dir}`);
    if (cost) {
      cost.textContent = dug ? '' : `${nextCost} blood`;
      cost.classList.toggle('met', !dug && canAfford);
    }
  }

  const taskEl = document.getElementById('task-text')!;
  if (activeTasks.length > 0) {
    taskEl.style.display = '';
    // Same caching as the power line: re-assigning identical innerHTML still
    // tears down and rebuilds the child nodes (and re-layouts the sidebar),
    // which added up when this ran every refresh.
    const taskHtml = activeTasks
      .map(t => {
        const label = t.optional ? 'Optional' : 'Work';
        const text = t.dynamicText ? t.dynamicText(state) : t.text;
        return `<div><strong>${label}:</strong> ${text}</div>`;
      })
      .join('');
    if (taskHtml !== lastTaskHtml) {
      lastTaskHtml = taskHtml;
      taskEl.innerHTML = taskHtml;
    }
  } else {
    taskEl.style.display = 'none';
  }

  // Buildings the player has outgrown — once a Gas Turbine has gone active
  // even once, the Goblin Wheel disappears for the rest of the session.
  // Sticky: destroying the upgrade later doesn't unhide the predecessor
  // (matches the sticky-task-progress philosophy).
  for (const b of state.buildings.values()) {
    everBuiltKinds.add(b.kind);
    if (b.state !== 'active') continue;
    if (b.kind === 'gas_engine') obsoletedKinds.add('goblin_wheel');
    if (b.kind === 'datacentre') obsoletedKinds.add('phone_farm');
    if (b.kind === 'nuclear_reactor') obsoletedKinds.add('gas_engine');
    if (b.kind === 'hypercentre') obsoletedKinds.add('datacentre');
  }

  // Each building kind. In hell the whole Build menu is replaced by the
  // Candle option, and in orbit by the Orbital Platform option, so every
  // ground building button hides while the view is away from the surface.
  const inHell = state.view === 'hell';
  const inSpace = state.view === 'space';
  // The destination view's replacement buttons (Candle / Orbital Platform)
  // only show once the travel animation has actually landed — mid-transition
  // neither the old nor the new set is offered.
  const viewArrived = !state.viewTransitioning;
  const availablePower = state.lastPowerProduced - state.lastPowerConsumed;
  for (const kind of SORTED_KINDS) {
    const def = BUILDING_DEFS[kind];
    const btn = document.getElementById(btnId(kind)) as HTMLButtonElement;
    const visible = unlocked.has(kind) && !obsoletedKinds.has(kind) && !inHell && !inSpace;
    btn.classList.toggle('locked', !visible);
    if (!visible) { setBuyFlash(btnId(kind), false); continue; }
    // Goblin Hole's price doubles per hole in play, so its cost is dynamic —
    // refresh both the displayed figure and the affordability check each frame.
    const moneyCost = buildingMoneyCost(state, kind);
    const canAffordMoney = state.money >= moneyCost;
    const canAffordBlood = !def.bloodCost || state.blood >= def.bloodCost;
    const canAffordBone = !def.dragonBoneCost || state.dragonBone >= def.dragonBoneCost;
    const draw = def.powerOutput < 0 ? -def.powerOutput : 0;
    const enoughPower = draw === 0 || draw <= availablePower;
    // Set the disabled state BEFORE kicking off the fade-in so the right
    // keyframes (full vs disabled-target opacity) get picked.
    btn.disabled = !canAffordMoney || !canAffordBlood || !canAffordBone || !enoughPower;
    applyFadeInOnFirstShow(btnId(kind));
    // Flash for attention while affordable and never built before.
    setBuyFlash(btnId(kind), !btn.disabled && !everBuiltKinds.has(kind));
    btn.classList.toggle('active', state.pendingBuild?.kind === kind);
    const costEl = document.getElementById(`cost-${kind}`)!;
    costEl.textContent = `Ƶ${moneyCost.toLocaleString('en-US')}`;
    costEl.classList.toggle('met', canAffordMoney);
    const powerCostEl = document.getElementById(`power-cost-${kind}`);
    if (powerCostEl) powerCostEl.classList.toggle('met', enoughPower);
    const bloodCostEl = document.getElementById(`blood-cost-${kind}`);
    if (bloodCostEl) bloodCostEl.classList.toggle('met', canAffordBlood);
    const boneCostEl = document.getElementById(`bone-cost-${kind}`);
    if (boneCostEl) boneCostEl.classList.toggle('met', canAffordBone);
  }

  // Mid-placement bankruptcy for ground buildings (mirrors the candle): if
  // the armed kind can no longer be paid for — its price can even move under
  // you (the Goblin Hole doubles per hole placed) — drop out of placement
  // mode rather than letting every map click error-beep. Power headroom is
  // deliberately NOT checked here: it fluctuates every tick (surges, water
  // meters) and placement re-validates it anyway.
  if (state.pendingBuild) {
    const def = BUILDING_DEFS[state.pendingBuild.kind];
    const canPay = state.money >= buildingMoneyCost(state, state.pendingBuild.kind)
      && (!def.bloodCost || state.blood >= def.bloodCost)
      && (!def.dragonBoneCost || state.dragonBone >= def.dragonBoneCost);
    if (!canPay) state.pendingBuild = null;
  }

  // Candle — the hell-view replacement for the Build list. 9 blood a piece;
  // lit (active) while placement mode is armed. First hell entry surfaces it
  // with the fade-in + "new" tag, and it attention-flashes while affordable
  // until the player has set their first candle down (mirroring the
  // never-built-before flash on building buttons).
  const candleBtn = document.getElementById('btn-place-candle') as HTMLButtonElement;
  candleBtn.style.display = (inHell && viewArrived) ? '' : 'none';
  if (inHell && viewArrived) {
    applyFadeInOnFirstShow('btn-place-candle');
    const canAffordCandle = state.blood >= SOUL_SIGIL.candleBloodCost;
    candleBtn.disabled = !canAffordCandle;
    candleBtn.classList.toggle('active', state.pendingCandle);
    document.getElementById('blood-cost-candle')!.classList.toggle('met', canAffordCandle);
    setBuyFlash('btn-place-candle', canAffordCandle && state.soulChairs.length === 0);
    // Mid-placement bankruptcy: if the player can no longer cover the next
    // candle, drop out of placement mode rather than letting taps error-beep.
    if (state.pendingCandle && !canAffordCandle) state.pendingCandle = false;
  } else {
    setBuyFlash('btn-place-candle', false);
    // Left hell with placement still armed — disarm it.
    if (state.pendingCandle) state.pendingCandle = false;
  }

  // Orbital Platform — the space-view replacement for the Build list. Lit
  // (active) while placement is armed; flashes for attention until the first
  // platform exists. Like the candle, leaving the view disarms placement.
  const orbitalBtn = document.getElementById('btn-place-orbital') as HTMLButtonElement;
  orbitalBtn.style.display = (inSpace && viewArrived) ? '' : 'none';
  if (inSpace && viewArrived) {
    applyFadeInOnFirstShow('btn-place-orbital');
    const orbitalCost = BUILDING_DEFS.orbital_platform.cost;
    const canAffordOrbital = state.money >= orbitalCost;
    orbitalBtn.disabled = !canAffordOrbital;
    orbitalBtn.classList.toggle('active', state.pendingOrbital);
    document.getElementById('cost-orbital')!.classList.toggle('met', canAffordOrbital);
    // Mid-placement bankruptcy (mirrors the candle): can't pay any more →
    // leave placement mode.
    if (state.pendingOrbital && !canAffordOrbital) state.pendingOrbital = false;
    let anyPlatform = false;
    for (const sb of state.spaceBuildings.values()) {
      if (sb.building.kind === 'orbital_platform') { anyPlatform = true; break; }
    }
    setBuyFlash('btn-place-orbital', canAffordOrbital && !anyPlatform);
  } else {
    setBuyFlash('btn-place-orbital', false);
    // Left orbit with placement still armed — disarm it.
    if (state.pendingOrbital) state.pendingOrbital = false;
  }

  // Hide separators that mark a task boundary the player hasn't crossed yet.
  // Hide separators that don't actually sit between two visible buttons.
  // Walks the live DOM so this stays correct regardless of how visibility
  // is computed (locked, obsoleted, etc.) — a separator only shows when at
  // least one non-locked .build-button sits between it and the previous
  // SHOWN separator (so runs of separators around all-hidden groups collapse
  // to nothing instead of stacking), plus at least one more below it.
  const buildListEl = document.getElementById('build-list')!;
  const children = Array.from(buildListEl.children) as HTMLElement[];
  const isVisibleButton = (el: HTMLElement) =>
    el.classList.contains('build-button') && !el.classList.contains('locked');
  let buttonSinceShownSeparator = false;
  for (let i = 0; i < children.length; i++) {
    const c = children[i];
    if (isVisibleButton(c)) { buttonSinceShownSeparator = true; continue; }
    if (!c.classList.contains('build-separator')) continue;
    let hasAfter = false;
    for (let j = i + 1; j < children.length; j++) {
      if (isVisibleButton(children[j])) { hasAfter = true; break; }
    }
    const show = buttonSinceShownSeparator && hasAfter;
    c.style.display = show ? '' : 'none';
    if (show) buttonSinceShownSeparator = false;
  }

  // Placement hint
  const hint = document.getElementById('placement-hint')!;
  // The Bob summon prompt gets a larger, centred treatment (.bob-summon); the
  // build/strike prompts keep the small top-left corner style.
  hint.classList.toggle('bob-summon', state.bobPickingHole);
  if (state.bobPickingHole) {
    hint.style.display = 'block';
    hint.textContent = 'choose a spawning hole';
  } else if (state.pendingStrike) {
    hint.style.display = 'block';
    hint.textContent = 'Tap to call down lightning · tap the button again or press ESC to cancel';
  } else if (state.pendingBuild) {
    const name = BUILDING_DEFS[state.pendingBuild.kind].name;
    hint.style.display = 'block';
    hint.textContent = `Tap to place ${name} · tap the button again or press ESC to cancel`;
  } else if (state.pendingCandle) {
    hint.style.display = 'block';
    hint.textContent = 'Tap to place Candle · tap the button again or press ESC to cancel';
  } else if (state.pendingOrbital) {
    hint.style.display = 'block';
    hint.textContent = 'Tap the void to deploy an Orbital Platform · tap the button again or press ESC to cancel';
  } else {
    hint.style.display = 'none';
  }

  // Pan-key hint — two triggers share the element. (a) Water onboarding:
  // surfaces a few seconds after the first dig if the player still hasn't
  // brought any water source into the viewport; hides forever (sticky
  // `waterSeen`) the first frame water appears on screen. (b) Never-panned
  // nudge: after PAN_HINT_DELAY_SEC of total play if the player has never
  // moved the camera at all; hides forever (sticky `cameraPanSeen`) on the
  // first pan — keyboard or two-finger drag.
  // A run that dev-skipped to hell jumped past the early game entirely —
  // every onboarding nudge below (pan, spawn, drag-select, multi-spawn) is
  // stale noise there, so they all stay suppressed for the rest of the run.
  const skippedToHell = !!state.devSkippedToHell;
  const panHint = document.getElementById('pan-hint')!;
  const dugDelayElapsed = state.firstDugAt != null && (state.now - state.firstDugAt) >= WATER_HINT_DELAY_SEC;
  const waterNudge = dugDelayElapsed && !state.waterSeen;
  const neverPannedNudge = !state.cameraPanSeen && state.now >= PAN_HINT_DELAY_SEC;
  panHint.style.display = !skippedToHell && (waterNudge || neverPannedNudge) ? 'block' : 'none';

  // Spawn-hint — onboarding nudge that fades in once either timeout trips.
  // First task is `earn_100`; check sticky completion as well as live state
  // so a save resumed mid-game doesn't pop the hint back up. Earning any
  // blood (sticky bloodUnlocked) means the player has already commanded
  // violence, so the hint would be stale noise — never show it again.
  const spawnHint = document.getElementById('spawn-hint')!;
  const earn100Done = completedTaskIds.has('earn_100') || TASKS[0].isDone(state);
  const noSpawnTrip = state.spawnsCompleted === 0 && state.now >= SPAWN_HINT_NO_SPAWN_SEC;
  const noTaskTrip = !earn100Done && state.now >= SPAWN_HINT_NO_TASK_SEC;
  spawnHint.classList.toggle('visible',
    !state.bloodUnlocked && !skippedToHell && (noSpawnTrip || noTaskTrip));

  // Drag-select hint — once past the first task, surface after DRAG_SELECT_HINT_DELAY_SEC
  // of play if the player still hasn't done a 2+ multi-select. Sticky-hidden
  // forever after the first successful multi-drag.
  const dragSelectHint = document.getElementById('drag-select-hint')!;
  const dragSelectTrip = earn100Done
    && !skippedToHell
    && !state.multiSelectSeen
    && state.now >= DRAG_SELECT_HINT_DELAY_SEC;
  dragSelectHint.classList.toggle('visible', dragSelectTrip);

  // Multi-spawn hint — once the player has spawned at least one goblin, surface
  // after MULTI_SPAWN_HINT_DELAY_SEC if they've still only ever had a single
  // goblin in the spawn queue at a time. Sticky-hidden once they queue 2+.
  const multiSpawnHint = document.getElementById('multi-spawn-hint')!;
  const multiSpawnTrip = state.spawnsCompleted > 0
    && !skippedToHell
    && !state.multiSpawnSeen
    && state.now >= MULTI_SPAWN_HINT_DELAY_SEC;
  multiSpawnHint.classList.toggle('visible', multiSpawnTrip);

  // Mirror the sticky unlock sets onto state so they're captured by the next
  // save. Holds live references to the module sets (+ the current boolean), so
  // this is a tiny per-frame object with no set copying.
  state.unlocks = {
    completed: completedTaskIds,
    revealed: revealedTaskIds,
    obsoleted: obsoletedKinds,
    everBuilt: everBuiltKinds,
    minotaurEverSummoned,
  };

  refreshInfoPanel(state);

  // A fresh unlock wave retires every older "new" tag before raising its own —
  // once newer content exists, the old call-outs have done their job. For a
  // staged reveal the tags land as the walk kicks off: each tag stays hidden
  // with its button (see the .reveal-hidden check in syncNewBadges) and pops
  // in alongside it, already in place rather than appearing after the
  // sequence. The wave's ids keep accumulating until the hold fully clears,
  // so a celebration landing mid-walk extends the wave instead of retiring it.
  const revealKickDue = revealArmed && celebrationsInFlight === 0 && !revealSequenceActive;
  if (newlyShownButtonIds.length > 0 && (!revealHoldActive() || revealKickDue)) {
    for (const id of [...newBadges.keys()]) {
      if (!newlyShownButtonIds.includes(id)) removeNewBadge(id);
    }
    for (const id of newlyShownButtonIds) addNewBadge(id);
    if (!revealHoldActive()) newlyShownButtonIds = [];
  }
  syncNewBadges();

  // A WORK COMPLETE overlay finished clearing this frame and the pass above
  // has collected its unlocks — walk the staged one-by-one reveal.
  if (revealKickDue) {
    revealArmed = false;
    sortRevealQueueByDocumentOrder();
    runUnlockRevealSequence();
  }

  // Every button/task shown this first frame is the baseline (a resumed save
  // shouldn't nag about content the player already had). From the next frame on,
  // a first-show is a genuine new unlock the scroll cue can point at.
  initialButtonsSeeded = true;
}

function refreshInfoPanel(state: GameState) {
  const panel = document.getElementById('info-panel')!;
  const portrait = document.getElementById('info-portrait')!;
  const name = document.getElementById('info-name')!;
  const stateEl = document.getElementById('info-state')!;
  const extra = document.getElementById('info-extra')!;

  const selectedGoblins = [...state.goblins.values()].filter((g) => g.selected);
  const selectedBuildings = [...state.buildings.values()].filter((b) => b.selected);
  const selectedWater = [...state.waterSources.values()].find((w) => w.selected) ?? null;
  const selectedSpace = [...state.spaceBuildings.values()].filter((sb) => sb.selected);
  const selectedSpaceUnits = [...state.spaceUnits.values()].filter((su) => su.selected);
  const selectedGhosts = state.ghosts.filter((g) => g.selected);
  // In hell a tap on the portal mirror selects the underlying Hell Portal
  // building. Show it its own beacon panel (no ground-only Destroy/commands)
  // rather than the regular building card.
  const selectedHellPortal = state.view === 'hell'
    ? (selectedBuildings.find((b) => b.kind === 'hell_portal') ?? null)
    : null;

  const destroyBtn = document.getElementById('info-destroy')!;
  const killBtn = document.getElementById('info-kill')!;
  destroyBtn.style.display = 'none';
  killBtn.style.display = 'none';
  const selectedDemon = [...state.demons.values()].find((d) => d.selected) ?? null;
  const selectedChair = state.soulChairs.find((c) => c.selected) ?? null;
  if (selectedDemon) {
    showDemon(state, selectedDemon, panel, portrait, name, stateEl, extra);
  } else if (selectedHellPortal) {
    showHellPortal(state, selectedHellPortal, panel, portrait, name, stateEl, extra);
  } else if (selectedChair) {
    showSoulChair(state, selectedChair, panel, portrait, name, stateEl, extra);
  } else if (selectedGhosts.length === 1) {
    showGhost(selectedGhosts[0], panel, portrait, name, stateEl, extra);
  } else if (selectedGhosts.length > 1) {
    panel.classList.add('visible');
    portrait.innerHTML = `<div class="portrait-goblin" style="background:#0c1018;border-color:#8fa6cc;color:#c6d4ee">☁</div>`;
    name.textContent = `${selectedGhosts.length} souls`;
    stateEl.textContent = '';
    extra.innerHTML = `<span style="color:#6a7080">${hellCommandHint()}</span>`;
  } else if (selectedSpaceUnits.length === 1) {
    showSpaceUnit(state, selectedSpaceUnits[0], panel, portrait, name, stateEl, extra);
  } else if (selectedSpaceUnits.length > 1) {
    panel.classList.add('visible');
    portrait.innerHTML = `<div class="portrait-goblin" style="background:#101830;border-color:#9fd0ff;color:#dbecff">✦</div>`;
    name.textContent = `${selectedSpaceUnits.length} castaways in orbit`;
    stateEl.textContent = '';
    extra.innerHTML = `<span style="color:#6a7080">Adrift among the stars</span>`;
  } else if (selectedSpace.length === 1) {
    showSpaceBuilding(state, selectedSpace[0], panel, portrait, name, stateEl, extra);
  } else if (selectedSpace.length > 1) {
    panel.classList.add('visible');
    portrait.innerHTML = `<div class="portrait-goblin" style="background:#101830;border-color:#9fd0ff;color:#dbecff">★</div>`;
    name.textContent = `${selectedSpace.length} buildings in orbit`;
    stateEl.textContent = '';
    extra.innerHTML = `<span style="color:#6a7080">Adrift among the stars, earning freely</span>`;
  } else if (state.selectedAmbientDragonId !== null) {
    // Background dragons are decorative-only: clicking one just identifies it.
    // No state, no commands — the panel is intentionally bare.
    panel.classList.add('visible');
    portrait.innerHTML = `<div class="portrait-goblin" style="background:#3a2410;border-color:#a06a3a;color:#e0c098">d</div>`;
    name.textContent = 'Distant dragon';
    stateEl.textContent = '';
    extra.innerHTML = '';
  } else if (selectedBuildings.length === 1 && selectedGoblins.length === 0) {
    showBuilding(state, selectedBuildings[0], panel, portrait, name, stateEl, extra);
    destroyBtn.style.display = '';
  } else if (selectedGoblins.length === 1 && selectedBuildings.length === 0) {
    showGoblin(state, selectedGoblins[0], panel, portrait, name, stateEl, extra);
  } else if (selectedGoblins.length > 1) {
    panel.classList.add('visible');
    portrait.innerHTML = `<div class="portrait-goblin">G</div>`;
    name.textContent = `${selectedGoblins.length} goblins`;
    stateEl.textContent = '';
    setCommandHint(extra, state);
  } else if (state.hole.selected) {
    showHole(state, panel, portrait, name, stateEl, extra);
  } else if (selectedWater) {
    showWaterSource(state, selectedWater, panel, portrait, name, stateEl, extra);
  } else if ([...state.dragons.values()].some((d) => d.selected)) {
    const selectedDragons = [...state.dragons.values()].filter((d) => d.selected);
    panel.classList.add('visible');
    portrait.innerHTML = `<div class="portrait-goblin" style="background:#5a1d10;border-color:#ffb24a;color:#ffe0a0">D</div>`;
    if (selectedDragons.length === 1) {
      name.textContent = `Dragon #${selectedDragons[0].id}`;
      stateEl.textContent = describeDragonState(state, selectedDragons[0].state);
    } else {
      name.textContent = `${selectedDragons.length} dragons`;
      stateEl.textContent = '';
    }
    extra.innerHTML = `<span style="color:#6a7080">${commandHintText('target')}</span>`;
  } else {
    const selectedMinotaurs = [...state.minotaurs.values()].filter((m) => m.selected);
    if (selectedMinotaurs.length === 1 && selectedGoblins.length === 0 && selectedBuildings.length === 0) {
      const m = selectedMinotaurs[0];
      panel.classList.add('visible');
      portrait.innerHTML = m.tiny
        ? `<div class="portrait-goblin" style="background:#3a1a4a;border-color:#a06aff;color:#ffe0a0;font-size:0.7em">t</div>`
        : `<div class="portrait-goblin" style="background:#6a1a1a;border-color:#a06aff;color:#ffe0a0">M</div>`;
      name.textContent = m.tiny ? `Tinytaur #${m.id}` : `Minotaur #${m.id}`;
      stateEl.textContent = describeMinotaurState(state, m.state);
      extra.innerHTML = `<span style="color:#6a7080">${commandHintText('anywhere')}</span>`;
    } else if (selectedMinotaurs.length > 1) {
      panel.classList.add('visible');
      portrait.innerHTML = `<div class="portrait-goblin" style="background:#6a1a1a;border-color:#a06aff;color:#ffe0a0">M</div>`;
      name.textContent = `${selectedMinotaurs.length} minotaurs`;
      stateEl.textContent = '';
      extra.innerHTML = `<span style="color:#6a7080">${commandHintText('anywhere')}</span>`;
    } else {
      panel.classList.remove('visible');
    }
  }
}

function describeDragonState(state: GameState, s: DragonState): string {
  switch (s.kind) {
    case 'swooping_in': return 'Swooping in from above';
    case 'seeking': return 'Seeking the choicest building';
    case 'hovering_to_lift': return `Looming over ${buildingLabel(state, s.buildingId)}`;
    case 'carrying': return 'Hauling a building to space';
    case 'carrying_unit': return 'Hauling a snatched unit to space';
    case 'delivering': return 'Carrying a building to a drop-off';
    case 'moving_to': return 'On the wing';
    case 'going_to_building': return `Going to lift ${buildingLabel(state, s.buildingId)}`;
    case 'going_to_unit':
      return s.targetKind === 'goblin'
        ? `Diving to snatch goblin #${s.targetId}`
        : `Diving to snatch Minotaur #${s.targetId}`;
    case 'going_to_kill':
      return s.targetKind === 'goblin'
        ? `Diving on goblin #${s.targetId}`
        : s.targetKind === 'minotaur'
          ? `Diving on Minotaur #${s.targetId}`
          : `Diving on Dragon #${s.targetId}`;
  }
}

function describeMinotaurState(state: GameState, s: import('./state').MinotaurState): string {
  switch (s.kind) {
    case 'wander': return 'Wandering';
    case 'moving_to': return 'Moving';
    case 'going_to_kill': return `Hunting goblin #${s.targetId}`;
    case 'going_to_kill_minotaur': return `Charging Minotaur #${s.targetId}`;
    case 'going_to_destroy': return `Smashing ${buildingLabel(state, s.buildingId)}`;
  }
}

function showDemon(_state: GameState, d: Demon, panel: HTMLElement, portrait: HTMLElement,
                   name: HTMLElement, stateEl: HTMLElement, extra: HTMLElement) {
  panel.classList.add('visible');
  portrait.innerHTML = `<div class="portrait-goblin" style="background:#2a0606;border-color:#ff5a4a;color:#ff8a6a">☠</div>`;
  // Each demon carries its own name now: the colossus is Hungry; demon L is
  // Lilly; her smaller corner-dwelling friend is Lolly.
  const variant = d.variant ?? 'pit';
  name.textContent = variant === 'pit' ? 'Hungry'
    : variant === 'l' ? 'Lilly'
    : 'Lolly';
  stateEl.textContent = d.busyWith !== null ? 'Locked in parlay'
    : variant === 'pit' ? 'Watching the abyss'
    : variant === 'l' ? 'Circumallocating work'
    : 'Longing';
  extra.innerHTML = `<span style="color:#ff4a4a">You cannot command this creature, only parlay</span>`;
}

// A unit a dragon dropped off in orbit. Robots thrive (and build); anything
// else is on a short vacuum clock, counted down live on the card.
function showSpaceUnit(state: GameState, su: SpaceUnit, panel: HTMLElement, portrait: HTMLElement,
                       name: HTMLElement, stateEl: HTMLElement, extra: HTMLElement) {
  panel.classList.add('visible');
  const glyph = su.robot ? 'R' : su.bob ? 'B' : su.kind === 'minotaur' ? 'M' : 'G';
  const border = su.robot ? '#9aa3ad' : '#9fd0ff';
  portrait.innerHTML = `<div class="portrait-goblin" style="background:#101830;border-color:${border};color:#dbecff">${glyph}</div>`;
  const kindLabel = su.robot ? 'Robot'
    : su.bob ? 'Bob'
    : su.kind === 'minotaur' ? (su.tiny ? 'Tinytaur' : 'Minotaur')
    : su.gold ? 'Gold Goblin' : 'Goblin';
  name.textContent = `${kindLabel} in orbit`;
  if (su.robot) {
    stateEl.textContent = su.workingOn !== undefined
      ? 'Assembling an Orbital Platform'
      : 'Functioning normally in the vacuum';
    extra.innerHTML = `<span style="color:#6a7080">${su.workingOn !== undefined ? 'The only hands that work up here' : 'Awaiting an Orbital Platform to build'}</span>`;
  } else {
    const left = su.diesAt !== undefined ? Math.max(0, su.diesAt - state.now) : 0;
    stateEl.textContent = `Perishing — ${left.toFixed(1)}s of air left`;
    extra.innerHTML = `<span style="color:#ff8a8a">No one can hear it scream.</span>`;
  }
}

// A drifting soul in the hell view. No commands list — the hint covers how to
// steer it (walk, or onto the demon to parlay).
function showGhost(g: Ghost, panel: HTMLElement, portrait: HTMLElement,
                   name: HTMLElement, stateEl: HTMLElement, extra: HTMLElement) {
  panel.classList.add('visible');
  const glyph = g.bob ? 'B' : g.kind === 'minotaur' ? 'M' : g.kind === 'dragon' ? 'D' : 'G';
  portrait.innerHTML = `<div class="portrait-goblin" style="background:#0c1018;border-color:#8fa6cc;color:#c6d4ee">${glyph}</div>`;
  const kindLabel = g.kind === 'minotaur' ? 'Minotaur' : g.kind === 'dragon' ? 'Dragon' : 'Goblin';
  name.textContent = g.bob ? "Bob's soul" : `${kindLabel} soul`;
  stateEl.textContent = g.parlayDemonId !== undefined
    ? 'Drawn toward the demon'
    : g.goal ? 'Trudging through the abyss' : 'Adrift in the abyss';
  extra.innerHTML = `<span style="color:#6a7080">${hellCommandHint()}</span>`;
}

// The Hell Portal seen from below — its hell-side mirror. Named for what it is
// down here; the portrait keeps an ominous "???" glyph. Mirrors a building info
// card: a state line plus a couple of stat lines (its own output + the upkeep
// it asks of the player).
function showHellPortal(state: GameState, b: Building, panel: HTMLElement, portrait: HTMLElement,
                        name: HTMLElement, stateEl: HTMLElement, extra: HTMLElement) {
  panel.classList.add('visible');
  const cls = b.state === 'constructing' ? 'constructing' : 'active';
  portrait.innerHTML = `<div class="portrait-building hell_portal ${cls}">???</div>`;
  const def = defOf(b);
  name.textContent = `${def.name} #${b.displayNum}`;
  stateEl.textContent = b.state === 'constructing'
    ? 'A rift tearing open above'
    : 'A rift torn between worlds';
  // The portal puts out a deadpan 1 W on its own — its real output is the
  // soul sigil ringed around its mirror: every seated soul multiplies the
  // wattage by its own strength (x66 weak / x100 strong / x144 very strong).
  const ring = state.soulChairs.filter((c) => c.portalId === b.id);
  const seated = ring.filter((c) => c.occupied).length;
  const power = `Power output: ${formatPower(sigilPortalOutput(def.powerOutput, ring))}`;
  const lines = [
    `<span style="color:#ff8a6a">Its light pierces down into the abyss</span>`,
    `<span style="color:#8acfff">${power}</span>`,
  ];
  if (b.state !== 'constructing' && ring.length < SOUL_SIGIL.count) {
    lines.push(`<span style="color:#ff8a6a">${ring.length}/${SOUL_SIGIL.count} candles on its outer ring</span>`);
  } else if (seated > 0) {
    lines.push(`<span style="color:#8acfff">x${SOUL_SIGIL.soulMultipliers.weak}–x${SOUL_SIGIL.soulMultipliers.veryStrong} per bound soul (${seated}/${SOUL_SIGIL.count})</span>`);
  }
  extra.innerHTML = lines.join('<br>');
}

// A candle (→ soul chair) in the abyssal sigil — a deliberately minimal info
// card. Until the ring carries all five candles it's just a waiting candle;
// after that it's a soul chair, with a one-line command hint while empty.
function showSoulChair(state: GameState, c: SoulChair, panel: HTMLElement, portrait: HTMLElement,
                       name: HTMLElement, stateEl: HTMLElement, extra: HTMLElement) {
  panel.classList.add('visible');
  const cls = c.occupied ? 'active' : 'constructing';
  portrait.innerHTML = `<div class="portrait-building hell_portal ${cls}">${c.occupied ? '✦' : '○'}</div>`;
  const ring = state.soulChairs.filter((sc) => sc.portalId === c.portalId);
  const ringDone = ring.length >= SOUL_SIGIL.count;
  const filled = ring.filter((sc) => sc.occupied).length;
  name.textContent = ringDone ? 'Soul Chair' : 'Candle';
  stateEl.textContent = c.occupied ? 'Bound' : ringDone ? 'Hungry for a soul' : 'Waiting on the ring';
  // An occupied chair reports its own soul's multiplier; an empty one
  // advertises the range so the player knows stronger souls bind bigger.
  const lines = ringDone
    ? [`<span style="color:#ff8a6a">${filled}/${SOUL_SIGIL.count} bound${c.occupied
        ? ` · this soul: x${c.mult ?? SOUL_SIGIL.soulMultipliers.strong}`
        : ` · x${SOUL_SIGIL.soulMultipliers.weak}–x${SOUL_SIGIL.soulMultipliers.veryStrong} by soul strength`}</span>`]
    : [`<span style="color:#ff4a3a">needs ${SOUL_SIGIL.count - ring.length} more candle${SOUL_SIGIL.count - ring.length === 1 ? '' : 's'}</span>`];
  if (ringDone && !c.occupied) {
    lines.push(`<span style="color:#6a7080">${TOUCH_PRIMARY ? 'Long tap' : 'Right click'} to bind a soul</span>`);
  }
  extra.innerHTML = lines.join('<br>');
}

// Hint for steering souls in the hell view — the usual command line, just like
// the ground view (long-tap on touch, right-click or space otherwise).
function hellCommandHint(): string {
  return commandHintText('anywhere');
}

function showHole(state: GameState, panel: HTMLElement, portrait: HTMLElement,
                  name: HTMLElement, stateEl: HTMLElement, extra: HTMLElement) {
  panel.classList.add('visible');
  portrait.innerHTML = `<div class="portrait-hole"></div>`;
  name.textContent = 'Goblin Hole';
  if (holeBlockedByBuilding(state)) {
    stateEl.textContent = 'Blocked — clear the building on top to spawn.';
  } else {
    stateEl.textContent = '';
  }
  extra.textContent = '';
}

function showWaterSource(state: GameState, w: WaterSource, panel: HTMLElement,
                         portrait: HTMLElement, name: HTMLElement,
                         stateEl: HTMLElement, extra: HTMLElement) {
  panel.classList.add('visible');
  portrait.innerHTML = `<div class="portrait-water"></div>`;
  name.textContent = 'Water';
  let attending = 0;
  for (const g of state.goblins.values()) {
    if (g.state.kind === 'fetching_water' && g.state.sourceId === w.id) attending++;
  }
  stateEl.textContent = attending === 1 ? '1 goblin collecting' : `${attending} goblins collecting`;
  extra.textContent = '';
}

function showGoblin(state: GameState, g: Goblin, panel: HTMLElement, portrait: HTMLElement,
                    name: HTMLElement, stateEl: HTMLElement, extra: HTMLElement) {
  panel.classList.add('visible');
  portrait.innerHTML = g.robot
    ? `<div class="portrait-goblin" style="background:#1c2026;border-color:#9aa3ad;color:#cfd5dc">R</div>`
    : `<div class="portrait-goblin">G</div>`;
  name.textContent = g.robot ? `Robot #${g.id}` : `Goblin #${g.id}`;
  stateEl.textContent = describeGoblinState(state, g.state) || (g.robot ? 'Cannot die' : '');
  setCommandHint(extra, state);
}

// On a touch-primary device a long-press stands in for a right-click (see the
// long-press handler in input.ts) and there's no spacebar, so reword the
// command hints from "Right click … (or space)" to "Long tap …".
const TOUCH_PRIMARY = window.matchMedia('(pointer: coarse)').matches;

function commandHintText(scope: 'anywhere' | 'target'): string {
  const where = scope === 'anywhere' ? 'anywhere' : 'a building, unit, or spot';
  return TOUCH_PRIMARY
    ? `Long tap ${where} to command`
    : `Right click ${where} to command (or space)`;
}

// Persist the hint span across frames so its pulse animation keeps running —
// refreshInfoPanel ticks every rAF, and replacing innerHTML each time would
// reset the animation to 0% and freeze the colour at the base hue.
function setCommandHint(extra: HTMLElement, state: GameState): void {
  let span = extra.firstElementChild as HTMLElement | null;
  if (!span || !span.classList.contains('command-hint') || extra.childNodes.length !== 1) {
    extra.textContent = '';
    span = document.createElement('span');
    span.className = 'command-hint';
    span.textContent = commandHintText('anywhere');
    extra.appendChild(span);
  }
  span.classList.toggle('command-hint-pulse', !state.bloodUnlocked);
}

function showBuilding(state: GameState, b: Building, panel: HTMLElement, portrait: HTMLElement,
                      name: HTMLElement, stateEl: HTMLElement, extra: HTMLElement) {
  panel.classList.add('visible');
  const def = defOf(b);
  const cls = b.state === 'constructing' ? 'constructing' :
              b.state === 'dormant' ? 'dormant' : 'active';
  portrait.innerHTML = `<div class="portrait-building ${b.kind} ${cls}">${def.short}</div>`;
  name.textContent = `${def.name} #${b.displayNum}`;

  if (b.state === 'constructing') {
    const pct = Math.round(b.buildProgress * 100);
    stateEl.textContent = `Constructing — ${pct}%`;
    let workers = 0;
    for (const id of b.assignedGoblins) {
      const g = state.goblins.get(id);
      if (g && g.state.kind === 'building' && g.state.buildingId === b.id) workers++;
    }
    extra.textContent = `Builders on site: ${workers} / ${def.buildersRequired}`;
  } else {
    const have = maintainerCount(state, b);
    const need = def.maintainersRequired;
    const lines: string[] = [];
    if (b.state === 'active') {
      const bits: string[] = [];
      if (def.income) bits.push(`earning Ƶ${def.income.toLocaleString('en-US')}/s`);
      if (def.powerOutput > 0) bits.push(`producing ${formatPower(def.powerOutput)}`);
      else if (def.powerOutput < 0) bits.push(`drawing ${formatPower(-def.powerOutput)}`);
      stateEl.textContent = `Active — ${bits.join(', ')}`;
    } else {
      const why = have < need
        ? `needs ${need - have} more goblin${need - have === 1 ? '' : 's'}`
        : `underpowered`;
      stateEl.textContent = `Dormant — ${why}`;
    }
    lines.push(`Maintained by ${have} / ${need} goblins`);
    if (def.powerOutput !== 0) {
      lines.push(def.powerOutput > 0
        ? `Power output: ${formatPower(def.powerOutput)}`
        : `Power draw: ${formatPower(-def.powerOutput)}`);
    }
    if (def.waterDeliveryAmount) {
      const carriers = waterCarrierCount(state, b);
      lines.push(`Watered by ${carriers} goblin${carriers === 1 ? '' : 's'}`);
    }
    extra.innerHTML = lines.join('<br>');
  }
}

// Info panel for a building that's been hauled into space. Unlike its
// ground self it has no maintainers, water, or power upkeep — it just floats
// and keeps earning (and feeding any power generation back to the grid).
function showSpaceBuilding(_state: GameState, sb: SpaceBuilding, panel: HTMLElement, portrait: HTMLElement,
                           name: HTMLElement, stateEl: HTMLElement, extra: HTMLElement) {
  panel.classList.add('visible');
  const b = sb.building;
  const def = defOf(b);
  const isActive = b.state === 'active';
  const cls = isActive ? 'active' : 'dormant';
  // A Dragon Beacon in orbit can't summon anything — its tether to the ground
  // is broken — so it's relabelled to make its uselessness obvious.
  const isOrbitalBeacon = b.kind === 'dragon_beacon';
  const displayName = isOrbitalBeacon ? 'Useless Beacon' : def.name;
  const displayShort = isOrbitalBeacon ? 'UB' : def.short;
  portrait.innerHTML = `<div class="portrait-building ${b.kind} ${cls}">${displayShort}</div>`;
  name.textContent = `${displayName} #${b.displayNum}`;
  if (isOrbitalBeacon) {
    stateEl.textContent = 'Dormant — uselessly orbiting';
    extra.innerHTML = 'I love pollution';
    return;
  }
  // Consumers in orbit still need the ground grid — `state` reflects whether
  // resolvePowerAndState could spare the draw this tick. Generators stay
  // active in orbit (no upkeep).
  if (def.powerOutput < 0) {
    stateEl.textContent = isActive ? 'Active — powered from below' : 'Dormant — power link severed';
  } else if (def.powerOutput > 0) {
    stateEl.textContent = 'Active — beaming power down';
  } else {
    stateEl.textContent = isActive ? 'Active' : 'Dormant';
  }
  const lines: string[] = [];
  if (def.powerOutput > 0) lines.push(`Power output: ${formatPower(def.powerOutput)}`);
  else if (def.powerOutput < 0) lines.push(`Power draw: ${formatPower(-def.powerOutput)}`);
  lines.push('No one can hear it scream.');
  extra.innerHTML = lines.join('<br>');
}

function setText(id: string, t: string) {
  const el = document.getElementById(id);
  if (el && el.textContent !== t) el.textContent = t;
}

function setFillWidth(id: string, progress: number) {
  const el = document.getElementById(id) as HTMLElement | null;
  if (!el) return;
  const pct = Math.max(0, Math.min(1, progress)) * 100;
  const w = `${pct}%`;
  // Skip the no-op write — these run for every fill bar on every refresh,
  // and unguarded style writes still dirty the element's style.
  if (el.style.width !== w) el.style.width = w;
}

function describeGoblinState(state: GameState, s: GoblinState): string {
  switch (s.kind) {
    case 'idle': return '';
    case 'moving': return 'Moving';
    case 'going_to_build': return `Walking to build site ${buildingLabel(state, s.buildingId)}`;
    case 'going_to_maintain': return `Walking to maintain ${buildingLabel(state, s.buildingId)}`;
    case 'building': return `Constructing ${buildingLabel(state, s.buildingId)}`;
    case 'maintaining': return `Maintaining ${buildingLabel(state, s.buildingId)}`;
    case 'fetching_water':
      return s.phase === 'to_source'
        ? `Fetching water for ${buildingLabel(state, s.buildingId)}`
        : `Delivering water to ${buildingLabel(state, s.buildingId)}`;
    case 'going_to_kill': return `Hunting goblin #${s.targetId}`;
    case 'firing_laser': {
      const noun = s.targetKind === 'goblin' ? 'goblin' : s.targetKind === 'minotaur' ? 'Minotaur' : 'Dragon';
      return `Firing laser at ${noun} #${s.targetId}`;
    }
  }
}

// ─── Task skip (debug aid) ──────────────────────────────────────────
// Completes the next pending task and nudges resources / structures into
// roughly the state a real player would be in at that point. Sticky: the
// task gets added to `completedTaskIds` so the unlock side-effects fire.
export function executeTaskSkip(state: GameState): void {
  const order: Task[] = TASKS;
  let next: Task | null = null;
  for (const t of order) {
    if (completedTaskIds.has(t.id)) continue;
    if (t.isDone(state)) { completedTaskIds.add(t.id); continue; }
    const prereqs = t.prereq ?? [];
    const prereqsDone = prereqs.every(id => completedTaskIds.has(id));
    if (prereqsDone) { next = t; break; }
  }
  if (!next) {
    appendLog(state, 'Work skip: nothing to skip.');
    return;
  }

  switch (next.id) {
    case 'earn_100': {
      ensureGoblins(state, 3);
      state.money = Math.max(state.money, 150);
      break;
    }
    case 'run_phone_farm': {
      // 1 PF (3 maintainers, 200W) needs at least 2 wheels (each 100W,
      // 1 maintainer). Three wheels gives a little headroom; total 6
      // maintainers + a couple idle.
      ensureGoblins(state, 9);
      ensureBuildingCount(state, 'goblin_wheel', 3);
      ensureBuildingCount(state, 'phone_farm', 1);
      state.money = Math.max(state.money, 250);
      // The player has been killing the odd goblin to test the mechanic, so
      // they likely have enough blood for one ritual purchase by now.
      state.blood = Math.max(state.blood, 15);
      state.bloodUnlocked = true;
      break;
    }
    case 'build_gas_engine': {
      // GT produces 2.5 MW (covers PF). Keep the 2 wheels from before so the
      // map looks "lived in" but they're optional for power.
      ensureGoblins(state, 14);
      ensureBuildingCount(state, 'goblin_wheel', 2);
      ensureBuildingCount(state, 'phone_farm', 1);
      ensureBuildingCount(state, 'gas_engine', 1);
      state.money = Math.max(state.money, 1200);
      // Enough for a couple ritual upgrades by this point.
      state.blood = Math.max(state.blood, 75);
      state.bloodUnlocked = true;
      break;
    }
    case 'run_datacentre': {
      // Full DC setup: dig water + maintainers + carriers so the DC powers up.
      // Digging needs a Minotaur, so plant one before the dig.
      ensureGoblins(state, 40);
      if (state.minotaurs.size === 0) spawnMinotaur(state);
      if (!state.dugDirections.has('n')) digDirection(state, 'n');
      ensureBuildingCount(state, 'goblin_wheel', 2);
      ensureBuildingCount(state, 'phone_farm', 1);
      ensureBuildingCount(state, 'gas_engine', 3);
      ensureBuildingCount(state, 'datacentre', 1);
      state.money = Math.max(state.money, 8000);
      state.blood = Math.max(state.blood, 500);
      state.bloodUnlocked = true;
      break;
    }
    case 'build_hypercentre': {
      // Hypercentre needs 1 GW + 30 maintainers + 4 carriers. The Reactor
      // (1 GW) does the heavy lifting; the gas turbines stay around for
      // redundancy and to power the DC + PF independently. Reactor placed
      // before the bigger footprints so findFreeFootprint doesn't run out
      // of space for its 2×2.
      ensureGoblins(state, 90);
      if (!state.dugDirections.has('n')) digDirection(state, 'n');
      ensureBuildingCount(state, 'goblin_wheel', 2);
      ensureBuildingCount(state, 'phone_farm', 1);
      ensureBuildingCount(state, 'nuclear_reactor', 1);
      ensureBuildingCount(state, 'gas_engine', 3);
      ensureBuildingCount(state, 'datacentre', 1);
      ensureBuildingCount(state, 'hypercentre', 1);
      state.money = Math.max(state.money, 2_000_000);
      state.blood = Math.max(state.blood, 1500);
      state.bloodUnlocked = true;
      break;
    }
    case 'collect_blood': {
      // The intended route to 9,999,999 blood runs through dragon bones (the
      // pit colossus trades 5 of them for exactly that figure), so a real
      // player has a powered Beacon and at least two live dragons circling by
      // now. A single Beacon draws 5 GW, so the Hypercentre's lone reactor is
      // nowhere near enough — the rig adds the nuclear plants needed to
      // actually keep the Beacon lit. By this point a real player would also
      // have flown a building to space, so unlock the ascent affordance too.
      // Then grant the blood itself so the count matches the completed task;
      // revealing it fires the secret-menu alerts in refreshUI.
      ensureDragonRig(state, 1, 2);
      state.money = Math.max(state.money, 50_000_000);
      state.blood = Math.max(state.blood, 9_999_999);
      state.bloodUnlocked = true;
      state.spaceUnlocked = true;
      if (state.dragonBoneEarned < 5) earnDragonBone(state, 5 - state.dragonBoneEarned);
      state.dragonBoneUnlocked = true;
      break;
    }
  }

  const skipped = next;
  completedTaskIds.add(skipped.id);
  // Task-skip is a debug shortcut — don't fire the celebration animation
  // and reveal the unlocks immediately rather than waiting on the overlay.
  previouslyCompletedTaskIds.add(skipped.id);
  revealedTaskIds.add(skipped.id);
  appendLog(state, `Work skip: "${skipped.text}" marked complete.`);
}

function ensureGoblins(state: GameState, count: number): void {
  while (state.goblins.size < count) {
    if (!spawnIdleGoblinNearHole(state)) break;
  }
}

function spawnIdleGoblinNearHole(state: GameState): boolean {
  const h = state.hole.cell;
  // Scan outward from the hole for a free cell.
  for (let r = 1; r < 30; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const cx = h.cx + dx, cy = h.cy + dy;
        if (!isInBounds(cx, cy)) continue;
        if (isCellBlocked(state, cx, cy)) continue;
        const id = state.nextId++;
        const g: Goblin = {
          id,
          pos: cellCenter({ cx, cy }),
          cell: { cx, cy },
          target: null, goal: null, path: [],
          facing: Math.PI / 2,
          state: { kind: 'idle' }, selected: false, idleSince: null, lastCellChangedAt: state.now,
        };
        state.goblins.set(id, g);
        occupyCell(state, cx, cy, id);
        state.spawnsCompleted++;
        return true;
      }
    }
  }
  return false;
}

// Place a single building of `kind` and snap maintainers + water carrier
// (for DCs) directly inside the footprint so the post-skip state powers up
// instantly instead of waiting for goblins to walk over. Pass
// `waterCarriers: false` to leave the building thirsty (used by the
// build_datacentre task-skip so the player still has to dig + assign water).
type PlaceOpts = { waterCarriers?: boolean };
function placeOneBuilding(state: GameState, kind: BuildingKind, opts: PlaceOpts = {}): Building | null {
  const def = BUILDING_DEFS[kind];
  const tl = findFreeFootprint(state, def.cellSize);
  if (!tl) return null;
  const b: Building = {
    id: state.nextId++,
    displayNum: nextBuildingDisplayNum(state, kind),
    kind,
    cell: tl,
    state: 'dormant',
    buildProgress: 1,
    assignedGoblins: [],
    selected: false,
  };
  state.buildings.set(b.id, b);
  markBuildingsChanged(state);

  // Snap idle goblins straight into 'maintaining' inside the footprint so
  // resolvePowerAndState marks the building active on the very next tick.
  const footprintCells = buildingFootprintCells(b, def.cellSize);
  let placed = 0;
  for (const g of state.goblins.values()) {
    if (placed >= def.maintainersRequired) break;
    if (g.state.kind !== 'idle') continue;
    const slot = footprintCells.find(c => !state.occupancy.has(cellKey(c.cx, c.cy)));
    if (!slot) break;
    teleportGoblinTo(state, g, slot);
    b.assignedGoblins.push(g.id);
    g.state = { kind: 'maintaining', buildingId: b.id, nextWanderAt: state.now + 1 };
    placed++;
  }
  // Buildings that drink (Datacentre, Hypercentre) get their auto-assign
  // target of carriers snapped on, plus a full water meter so the post-skip
  // state is operational. Caller can opt out (run_datacentre skip stops
  // here for the build_foundations phase, leaving the DC thirsty).
  const drinks = (def.waterDeliveryAmount ?? 0) > 0;
  const target = def.waterAutoAssignTarget ?? 0;
  if (opts.waterCarriers !== false && drinks && state.waterSources.size > 0) {
    b.waterMeter = 100;
    const sourceId = [...state.waterSources.values()][0].id;
    let assigned = 0;
    for (const g of state.goblins.values()) {
      if (assigned >= target) break;
      if (g.state.kind !== 'idle') continue;
      b.assignedGoblins.push(g.id);
      g.state = { kind: 'fetching_water', buildingId: b.id, sourceId, phase: 'to_source', firstLoopDone: true };
      g.goal = null;
      g.path = [];
      assigned++;
    }
  }
  // Goblin Hole is its own thing — finished construction goes straight to
  // active in the regular path; mirror that here.
  if (kind === 'goblin_hole') b.state = 'active';
  return b;
}

function buildingFootprintCells(b: Building, n: number): Cell[] {
  const out: Cell[] = [];
  for (let dx = 0; dx < n; dx++) {
    for (let dy = 0; dy < n; dy++) {
      out.push({ cx: b.cell.cx + dx, cy: b.cell.cy + dy });
    }
  }
  return out;
}

// Dev cheat (options menu): guarantee an active Hell Portal exists so the
// skip-to-hell descent has a beacon waiting in the abyss. Reuses the
// task-skip placement machinery; returns false when no free spot exists
// (vanishingly unlikely for a 1×1). The skip-built portal gets activatedAt
// stamped so its beam draws in as if construction just finished.
export function ensureHellPortal(state: GameState): boolean {
  for (const b of state.buildings.values()) {
    if (b.kind === 'hell_portal' && b.state !== 'constructing') return true;
  }
  const b = placeOneBuilding(state, 'hell_portal');
  if (!b) return false;
  b.activatedAt = state.now;
  state.hellUnlocked = true;
  return true;
}

function teleportGoblinTo(state: GameState, g: Goblin, c: Cell): void {
  if (state.occupancy.get(cellKey(g.cell.cx, g.cell.cy)) === g.id) {
    state.occupancy.delete(cellKey(g.cell.cx, g.cell.cy));
  }
  if (g.target) {
    state.occupancy.delete(cellKey(g.target.cx, g.target.cy));
    g.target = null;
  }
  g.cell = c;
  g.pos = cellCenter(c);
  g.lastCellChangedAt = state.now;
  g.goal = null;
  g.path = [];
  occupyCell(state, c.cx, c.cy, g.id);
}

// Place enough buildings of `kind` so the world has at least `count` of them
// past construction. Returns the actual count after placement.
function ensureBuildingCount(state: GameState, kind: BuildingKind, count: number, opts: PlaceOpts = {}): number {
  let have = 0;
  for (const b of state.buildings.values()) {
    if (b.kind === kind && b.state !== 'constructing') have++;
  }
  while (have < count) {
    const placed = placeOneBuilding(state, kind, opts);
    if (!placed) break;
    have++;
  }
  return have;
}

// Stand up a working dragon-summoning rig for the task-skip: `beacons` Dragon
// Beacons backed by enough Nuclear Reactors to keep them lit, plus `dragons`
// live dragons. Each Beacon draws 5 GW and the Hypercentre another 1 GW (a
// reactor yields 1 GW), so without the matching plants the Beacons sit dormant
// and never summon — exactly the unrealistic state we're avoiding. Two reactors
// of headroom cover the Datacentre/Phone Farm and a little slack, like a real
// player would over-provision. Goblins are topped up first so the reactors can
// grab maintainers (4 each) the instant they're placed.
function ensureDragonRig(state: GameState, beacons: number, dragons: number): void {
  const reactors = beacons * 5 + 2; // 5 GW/beacon + 1 GW Hypercentre + headroom
  ensureGoblins(state, 100 + reactors * 4);
  ensureBuildingCount(state, 'nuclear_reactor', reactors);
  ensureBuildingCount(state, 'dragon_beacon', beacons);
  while (state.dragons.size < dragons) {
    if (!spawnDragon(state)) break;
  }
}

function findFreeFootprint(state: GameState, cellSize: number): Cell | null {
  const h = state.hole.cell;
  // Spiral outward looking for a top-left where the whole footprint is unblocked.
  for (let r = 2; r < 30; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const tl: Cell = { cx: h.cx + dx, cy: h.cy + dy };
        if (footprintOpen(state, tl, cellSize)) return tl;
      }
    }
  }
  return null;
}

function footprintOpen(state: GameState, tl: Cell, n: number): boolean {
  for (let dx = 0; dx < n; dx++) {
    for (let dy = 0; dy < n; dy++) {
      const cx = tl.cx + dx, cy = tl.cy + dy;
      if (!isInBounds(cx, cy)) return false;
      if (isCellBlocked(state, cx, cy)) return false;
    }
  }
  return true;
}
