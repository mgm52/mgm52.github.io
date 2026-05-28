import { playSound } from './audio';
import {
  AUTOSPAWN_TIERS, BUILDABLE_KINDS, BUILDING_DEFS, BuildingKind, DRAG_SELECT_HINT_DELAY_SEC,
  DRAGON, GOBLIN, LIGHTNING, SPAWN_HINT_NO_SPAWN_SEC,
  SPAWN_HINT_NO_TASK_SEC, SUMMON_UPGRADES, WATER_HINT_DELAY_SEC, digBloodCost, MINOTAUR, minotaurBloodCost, TINYTAUR, formatPower,
} from './config';
import {
  Building, Cell, Demon, DragonState, GameState, Goblin, GoblinState, SpaceBuilding, WaterSource,
  appendLog, buildingCenter, buildingLabel, cellCenter, cellKey, countIdle, defOf, digDirection,
  earnDragonBone, getSpawnCapacity, holeBlockedByBuilding, isCellBlocked, isInBounds,
  maintainerCount, nextBuildingDisplayNum, occupyCell, waterCarrierCount,
} from './state';
import { spawnMinotaur } from './sim';
import { unlockOptionsCog } from './options-ui';

// Build buttons appear in this fixed order. Mostly cheapest-first, with
// goblin_hole slotted next to the datacentre it now unlocks alongside (it's an
// auxiliary capacity expander, not a late-game item).
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
function applyFadeInOnFirstShow(btnId: string): void {
  if (everVisibleButtonIds.has(btnId)) return;
  everVisibleButtonIds.add(btnId);
  const btn = document.getElementById(btnId);
  if (!btn) return;
  btn.classList.add('fade-in');
  window.setTimeout(() => btn.classList.remove('fade-in'), 700);
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

// Demo-end gag: once the final task (collect_dragon_bone) is completed, pop a
// pair of "the game just stops here" alerts and unlock the secret options cog.
// Guarded against double-firing so re-triggers (e.g. refreshUI re-entries) stay
// idempotent.
let finalGameAlertsFired = false;
function triggerFinalGameAlerts(state: GameState): void {
  if (finalGameAlertsFired) return;
  finalGameAlertsFired = true;
  revealSecretSettings(state);
}

// The "demo just stops" pair of alerts + the secret options-cog unlock. Shared
// by the dragon-bone task payoff and the demon's gift to a truthful Bob.
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

// Plays the "TASK COMPLETE" overlay + a short Skyrim-ish drum-then-fanfare
// tap. Idempotent in the sense that re-triggers stack the timer; the overlay
// just stays "shown" longer if multiple tasks complete in quick succession.
function playTaskCompleteAnimation(taskId: string): void {
  const overlay = document.getElementById('task-complete-overlay');
  if (!overlay) return;
  overlay.classList.add('shown');
  // "Level Up/Mission Complete (Resistance)" by Dylan Kelk (freesound 672801).
  playSound('task_complete', 1);
  // Hold the overlay for ~2s, then fade out (CSS handles the 600ms fade).
  window.setTimeout(() => overlay.classList.remove('shown'), 2200);
  // Only after the overlay clears do the task's unlocks take effect — that
  // gives newly-revealed buttons a moment to be hidden and then fade in
  // properly via the .fade-in animation, rather than flashing on screen
  // behind a transparent overlay.
  window.setTimeout(() => { revealedTaskIds.add(taskId); }, 2800);
}

// Tutorial gating: each task unlocks one or more building kinds when complete.
// Tasks form a DAG via `prereq` — multiple tasks with the same prereqs become
// active simultaneously and are shown together.
type Task = {
  id: string;
  text: string;
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
//   run_phone_farm       → Autocommand, Dig
//   build_gas_engine     → Minotaur, Autospawn
//   earn_30_blood        → Goldblins
//   collect_dragon_bone  → Lightning Strike + demo-end alerts + secret options cog
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
    text: 'Run your first datacentre',
    unlocks: ['nuclear_reactor', 'hypercentre', 'wall'],
    isDone: (s) => {
      for (const b of s.buildings.values()) {
        if (b.kind === 'datacentre' && b.state === 'active') return true;
      }
      return false;
    },
    prereq: ['build_gas_engine'],
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
    prereq: ['run_datacentre'],
  },
  {
    id: 'collect_dragon_bone',
    text: 'Collect a dragon bone',
    unlocks: ['hell_portal'],
    isDone: (s) => s.dragonBoneEarned >= 1,
    prereq: ['build_hypercentre'],
  },
  {
    // Optional side-task: unlocks after Phase 3 (build_gas_engine). Grants the
    // Goblin Hole (buildable) plus the Goldblins ritual (gated in refreshUI).
    id: 'earn_30_blood',
    text: 'Earn 30 blood',
    unlocks: ['goblin_hole'],
    isDone: (s) => s.bloodEarned >= 30,
    prereq: ['build_gas_engine'],
    optional: true,
  },
];

export type UICallbacks = {
  onSpawnGoblin: () => void;
  onSummonMinotaur: () => void;
  onSummonTinytaur: () => void;
  onSummonDragon: () => void;
  onLightningStrike: () => void;
  onBuyAutoAssign: () => void;
  onBuyAutoWater: () => void;
  onBuyAutoSpawn: () => void;
  onBuyGoldgoblins: () => void;
  onBuyGoldgoblinsX10: () => void;
  onDig: (dir: 'n' | 'e' | 's' | 'w') => void;
  onBuildBuilding: (kind: BuildingKind) => void;
  onDestroyBuilding: (id: number) => void;
  onKillGoblin: (id: number) => void;
};

export function setupUI(state: GameState, callbacks: UICallbacks) {
  const summonList = document.getElementById('summon-list')!;
  const ritualList = document.getElementById('ritual-list')!;
  const buildList = document.getElementById('build-list')!;

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

  // Ritual upgrades — surfaced once a Phone Farm has finished building.
  // Bought ones stay visible but go disabled.
  const autoAssignBtn = document.createElement('button');
  autoAssignBtn.className = 'build-button build-button-compact';
  autoAssignBtn.id = 'btn-buy-autoassign';
  autoAssignBtn.innerHTML = `
    <div class="build-content">
      <div class="build-text">
        <div class="build-name">Autocommand</div>
      </div>
      <div class="build-cost-side"><span class="build-cost" id="cost-buy-autoassign">${SUMMON_UPGRADES.autoAssign.bloodCost} blood</span></div>
    </div>
  `;
  autoAssignBtn.addEventListener('click', () => { playSound('click', 1, 0.75); callbacks.onBuyAutoAssign(); });
  ritualList.appendChild(autoAssignBtn);

  // Autowater — extends Autocommand onto watering duty. Surfaces once
  // Autocommand is owned and a water source has been dug.
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

  // Goldgoblins — appears alongside Autocommand (once a Phone Farm is
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
  // Run-a-Phone-Farm task (Phase 2). Each is one-shot and costs DIG.bloodCost
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

  // Lightning Strike — an aimed ritual unlocked once the Collect-a-Dragon-Bone
  // task is done. Sits at the bottom of the Ritual list. Clicking arms it; the
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
    if (prevTaskId !== null && taskId !== prevTaskId) {
      const sep = document.createElement('div');
      sep.className = 'build-separator';
      buildList.appendChild(sep);
      buildSeparators.push({ el: sep, afterTaskId: taskId });
    }
    prevTaskId = taskId;
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
    if (def.powerOutput > 0) {
      // Gas Turbine spells its gain out in plain watts rather than the
      // MW-rounded form, so its modest output reads precisely.
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
            <span class="build-cost" id="cost-${kind}">Ƶ${def.cost.toLocaleString('en-US')}</span>${powerCostBit}${bloodCostBit}${dragonBoneCostBit}
          </div>
        </div>
        ${yieldHtml}
      </div>
    `;
    btn.addEventListener('click', () => { playSound('click', 1, 0.75); callbacks.onBuildBuilding(kind); });
    buildList.appendChild(btn);
  }

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
      if (t.isDone(state)) {
        completedTaskIds.add(t.id);
        previouslyCompletedTaskIds.add(t.id);
        revealedTaskIds.add(t.id);
      }
    }
    // Hydrate persisted unlocks (sticky progress that may no longer be derivable
    // from isDone — e.g. the building that completed a task was since destroyed).
    const u = state.unlocks;
    if (u) {
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
  if (consumed > 0) {
    powerEl.innerHTML = `${formatPower(produced - consumed)}<span class="power-total"> / ${formatPower(produced)}</span>`;
  } else {
    powerEl.textContent = formatPower(produced);
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
    const queued = state.minotaurSpawnQueue.length;
    const minoCost = minotaurBloodCost(state.minotaursBought);
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

  // Tutorial: build the completed set first, then collect any tasks whose
  // prereqs are all done but which are themselves not done yet — those are
  // the *active* tasks (multiple can be active at once). A completed task's
  // unlocks only kick in once its celebration overlay has finished
  // (revealedTaskIds), so newly-revealed buttons stay hidden during the
  // black-out and then fade in.
  const unlocked = new Set<BuildingKind>();
  for (const t of TASKS) {
    if (completedTaskIds.has(t.id) || t.isDone(state)) {
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
      // Final task: hold for the celebration overlay (~2.8s), then pop the
      // demo-end alerts and unlock the secret options cog.
      if (id === 'collect_dragon_bone') {
        window.setTimeout(() => triggerFinalGameAlerts(state), 2800);
      }
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
  //   run_phone_farm       → Autocommand, Dig
  //   build_gas_engine     → Autospawn (+ Minotaur, handled above)
  //   earn_30_blood        → Goldblins
  //   collect_dragon_bone  → Lightning Strike
  const phaseRunPhoneFarm = revealedTaskIds.has('run_phone_farm');
  const phaseGasTurbine = revealedTaskIds.has('build_gas_engine');
  const blood30Done = revealedTaskIds.has('earn_30_blood');
  const dragonBoneDone = revealedTaskIds.has('collect_dragon_bone');

  // Lightning Strike — a ritual unlocked once the Collect-a-Dragon-Bone task is
  // done. Disabled when the player can't cover the blood cost; lit while armed.
  const lightningBtn = document.getElementById('btn-lightning-strike') as HTMLButtonElement;
  if (dragonBoneDone) {
    lightningBtn.style.display = '';
    applyFadeInOnFirstShow('btn-lightning-strike');
    const canAffordLightning = state.blood >= LIGHTNING.bloodCost;
    const onCooldown = state.lightningStrikeCooldown > 0;
    lightningBtn.disabled = !canAffordLightning || onCooldown;
    lightningBtn.classList.toggle('active', state.pendingStrike);
    document.getElementById('cost-lightning-strike')!.classList.toggle('met', canAffordLightning && !onCooldown);
  } else {
    lightningBtn.style.display = 'none';
  }

  // Dig rewards run_phone_farm (Phase 2). Digging itself still needs a Minotaur
  // (rewarded later, at Phase 3), so a "needs Minotaur" banner covers the row
  // until one is summoned; see the dig-overlay below.
  const digUnlocked = phaseRunPhoneFarm;
  const ritualVisible = phaseRunPhoneFarm || phaseGasTurbine || blood30Done || dragonBoneDone;
  const ritualSection = document.getElementById('ritual-section')!;
  ritualSection.style.display = ritualVisible ? '' : 'none';
  // Now that the panel renders as a bordered card, an empty container shows
  // up as a thin empty bar — hide the outer panel until either subsection
  // unlocks.
  const panelBuild = document.getElementById('panel-build')!;
  panelBuild.style.display = (firstTaskDone || ritualVisible) ? '' : 'none';

  // Autocommand → Autowater replace chain: Autowater needs Autocommand owned
  // AND a water source dug (so the upgrade has something to act on). The
  // Autocommand button hides ONLY once Autowater is actually visible — until
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
  // Autospawn — unlocked by the Construct-a-Gas-Turbine task (Phase 3).
  refreshAutospawnButton(state, phaseGasTurbine);
  // Goldblins → Goldblins x10 form a replace chain (like Autospawn): base
  // button hides once owned, x10 takes its place; x10 hides once owned.
  // Base Goldblins unlocks via the optional Earn-30-blood side-task; x10
  // follows once base Goldblins is owned.
  refreshRitualButton(
    'btn-buy-goldgoblins', 'cost-buy-goldgoblins',
    blood30Done && !state.goldgoblinsEnabled, false,
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

  // Dig row: unlocked by the Run-a-Phone-Farm task (Phase 2). Each direction
  // is one-shot. First time the row appears, each button fades in. Until a
  // Minotaur has been summoned (Phase 3 reward), a "needs Minotaur" banner
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
    taskEl.innerHTML = activeTasks
      .map(t => {
        const label = t.optional ? 'Optional' : 'Work';
        return `<div><strong>${label}:</strong> ${t.text}</div>`;
      })
      .join('');
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

  // Each building kind
  const availablePower = state.lastPowerProduced - state.lastPowerConsumed;
  for (const kind of SORTED_KINDS) {
    const def = BUILDING_DEFS[kind];
    const btn = document.getElementById(btnId(kind)) as HTMLButtonElement;
    const visible = unlocked.has(kind) && !obsoletedKinds.has(kind);
    btn.classList.toggle('locked', !visible);
    if (!visible) { setBuyFlash(btnId(kind), false); continue; }
    const canAffordMoney = state.money >= def.cost;
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
    document.getElementById(`cost-${kind}`)!.classList.toggle('met', canAffordMoney);
    const powerCostEl = document.getElementById(`power-cost-${kind}`);
    if (powerCostEl) powerCostEl.classList.toggle('met', enoughPower);
    const bloodCostEl = document.getElementById(`blood-cost-${kind}`);
    if (bloodCostEl) bloodCostEl.classList.toggle('met', canAffordBlood);
    const boneCostEl = document.getElementById(`bone-cost-${kind}`);
    if (boneCostEl) boneCostEl.classList.toggle('met', canAffordBone);
  }

  // Hide separators that mark a task boundary the player hasn't crossed yet.
  // Hide separators that don't actually sit between two visible buttons.
  // Walks the live DOM so this stays correct regardless of how visibility
  // is computed (locked, obsoleted, etc.) — a separator only shows when
  // there's at least one non-locked .build-button on each side of it.
  const buildListEl = document.getElementById('build-list')!;
  const children = Array.from(buildListEl.children) as HTMLElement[];
  const isVisibleButton = (el: HTMLElement) =>
    el.classList.contains('build-button') && !el.classList.contains('locked');
  for (let i = 0; i < children.length; i++) {
    const c = children[i];
    if (!c.classList.contains('build-separator')) continue;
    let hasBefore = false;
    for (let j = i - 1; j >= 0; j--) {
      if (isVisibleButton(children[j])) { hasBefore = true; break; }
    }
    let hasAfter = false;
    for (let j = i + 1; j < children.length; j++) {
      if (isVisibleButton(children[j])) { hasAfter = true; break; }
    }
    c.style.display = (hasBefore && hasAfter) ? '' : 'none';
  }

  // Placement hint
  const hint = document.getElementById('placement-hint')!;
  if (state.bobPickingHole) {
    hint.style.display = 'block';
    hint.textContent = 'Bob is waiting — click any Goblin Hole to summon him · time is frozen';
  } else if (state.pendingStrike) {
    hint.style.display = 'block';
    hint.textContent = 'Tap to call down lightning · tap the button again or press ESC to cancel';
  } else if (state.pendingBuild) {
    const name = BUILDING_DEFS[state.pendingBuild.kind].name;
    hint.style.display = 'block';
    hint.textContent = `Tap to place ${name} · tap the button again or press ESC to cancel`;
  } else {
    hint.style.display = 'none';
  }

  // Pan-key hint — surfaces a few seconds after the first dig if the player
  // still hasn't brought any water source into the viewport. Hides forever
  // (sticky `waterSeen`) the first frame water appears on screen.
  const panHint = document.getElementById('pan-hint')!;
  const dugDelayElapsed = state.firstDugAt != null && (state.now - state.firstDugAt) >= WATER_HINT_DELAY_SEC;
  panHint.style.display = (dugDelayElapsed && !state.waterSeen) ? 'block' : 'none';

  // Spawn-hint — onboarding nudge that fades in once either timeout trips.
  // First task is `earn_100`; check sticky completion as well as live state
  // so a save resumed mid-game doesn't pop the hint back up.
  const spawnHint = document.getElementById('spawn-hint')!;
  const earn100Done = completedTaskIds.has('earn_100') || TASKS[0].isDone(state);
  const noSpawnTrip = state.spawnsCompleted === 0 && state.now >= SPAWN_HINT_NO_SPAWN_SEC;
  const noTaskTrip = !earn100Done && state.now >= SPAWN_HINT_NO_TASK_SEC;
  spawnHint.classList.toggle('visible', noSpawnTrip || noTaskTrip);

  // Drag-select hint — once past the first task, surface after DRAG_SELECT_HINT_DELAY_SEC
  // of play if the player still hasn't done a 2+ multi-select. Sticky-hidden
  // forever after the first successful multi-drag.
  const dragSelectHint = document.getElementById('drag-select-hint')!;
  const dragSelectTrip = earn100Done
    && !state.multiSelectSeen
    && state.now >= DRAG_SELECT_HINT_DELAY_SEC;
  dragSelectHint.classList.toggle('visible', dragSelectTrip);

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

  const destroyBtn = document.getElementById('info-destroy')!;
  const killBtn = document.getElementById('info-kill')!;
  destroyBtn.style.display = 'none';
  killBtn.style.display = 'none';
  const selectedDemon = [...state.demons.values()].find((d) => d.selected) ?? null;
  if (selectedDemon) {
    showDemon(state, selectedDemon, panel, portrait, name, stateEl, extra);
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
    extra.innerHTML = `<span style="color:#6a7080">Right click a building, unit, or spot to command (or space)</span>`;
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
      extra.innerHTML = `<span style="color:#6a7080">Right click anywhere to command (or space)</span>`;
    } else if (selectedMinotaurs.length > 1) {
      panel.classList.add('visible');
      portrait.innerHTML = `<div class="portrait-goblin" style="background:#6a1a1a;border-color:#a06aff;color:#ffe0a0">M</div>`;
      name.textContent = `${selectedMinotaurs.length} minotaurs`;
      stateEl.textContent = '';
      extra.innerHTML = `<span style="color:#6a7080">Right click anywhere to command (or space)</span>`;
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
    case 'delivering': return 'Carrying a building to a drop-off';
    case 'moving_to': return 'On the wing';
    case 'going_to_building': return `Going to lift ${buildingLabel(state, s.buildingId)}`;
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
  name.textContent = 'Minotaur of the Pit';
  stateEl.textContent = d.busyWith !== null ? 'Locked in parlay' : 'Pacing the abyss';
  extra.innerHTML = `<span style="color:#ff4a4a">You cannot command this creature, only parlay</span>`;
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
  portrait.innerHTML = `<div class="portrait-goblin">G</div>`;
  name.textContent = `Goblin #${g.id}`;
  stateEl.textContent = describeGoblinState(state, g.state);
  setCommandHint(extra, state);
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
    span.textContent = 'Right click anywhere to command (or space)';
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
  el.style.width = `${pct}%`;
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
    case 'collect_dragon_bone': {
      // A real player would have built a Beacon to get here, so place one too
      // — the Dragon summon button surfaces the moment any beacon goes active,
      // which makes the post-skip world look like a normal playthrough rather
      // than just handing over the bone. Then hand the bone outright so
      // dragonBoneEarned satisfies isDone and the unlock side-effects
      // (Lightning Strike + final-game gag) fire.
      ensureBuildingCount(state, 'dragon_beacon', 1);
      earnDragonBone(state, 1);
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
  // Final task carries the demo-end gag; fire the alerts immediately on skip
  // (no celebration overlay was played, so no need to wait).
  if (skipped.id === 'collect_dragon_bone') triggerFinalGameAlerts(state);
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
