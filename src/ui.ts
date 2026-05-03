import { playSound } from './audio';
import {
  AUTOSPAWN_TIERS, BUILDABLE_KINDS, BUILDING_DEFS, BuildingKind, DIG, GOBLIN, SUMMON_UPGRADES,
  MINOTAUR, formatPower,
} from './config';
import {
  Building, Cell, GameState, Goblin, GoblinState,
  appendLog, buildingCenter, cellCenter, cellKey, countIdle, defOf, digDirection, getSpawnCapacity,
  holeBlockedByBuilding, isCellBlocked, isInBounds, maintainerCount, occupyCell,
} from './state';

// Build buttons appear in this fixed order. Mostly cheapest-first, with
// goblin_hole slotted right below datacentre (it's an auxiliary capacity
// expander introduced alongside Datacentres, not a late-game item).
const SORTED_KINDS: BuildingKind[] = [
  // Wall sits at the top of the build list once unlocked — it's a quick
  // utility the player drops constantly, so keeping it within reach helps.
  'wall',
  'goblin_wheel', 'phone_farm', 'gas_engine', 'datacentre',
  'goblin_hole', 'nuclear_reactor', 'hypercentre', 'dragon_beacon',
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
};
// Tasks are sticky: once a task's isDone has ever returned true in this session,
// we treat it as permanently complete. Stops unlocks/build buttons from
// regressing if e.g. the only Goblin Wheel gets destroyed.
const completedTaskIds = new Set<string>();
// Recomputed each refreshUI; cached so refreshInfoPanel can reuse it without
// re-running the whole task evaluation.
let currentTaskCached: Task | null = null;

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
    text: 'Build a Gas Engine',
    unlocks: ['datacentre', 'goblin_hole'],
    isDone: (s) => {
      for (const b of s.buildings.values()) {
        if (b.kind === 'gas_engine' && b.state !== 'constructing') return true;
      }
      return false;
    },
    prereq: ['run_phone_farm'],
  },
  {
    id: 'reach_6mw',
    text: 'Generate 6 MW of power',
    unlocks: [],
    isDone: (s) => s.lastPowerProduced >= 6_000_000,
    prereq: ['build_gas_engine'],
  },
  {
    id: 'run_datacentre',
    text: 'Get a datacentre running',
    unlocks: ['nuclear_reactor', 'hypercentre', 'wall'],
    isDone: (s) => {
      for (const b of s.buildings.values()) {
        if (b.kind === 'datacentre' && b.state === 'active') return true;
      }
      return false;
    },
    prereq: ['reach_6mw'],
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
];

export type UICallbacks = {
  onSpawnGoblin: () => void;
  onSummonMinotaur: () => void;
  onBuyAutoAssign: () => void;
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
  spawnBtn.addEventListener('click', () => { playSound('click', 1, 0.75); callbacks.onSpawnGoblin(); });
  summonList.appendChild(spawnBtn);

  // Minotaur — unlocks alongside the Datacentre (once a Gas Engine is built).
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
  minotaurBtn.addEventListener('click', () => { playSound('click', 1, 0.75); callbacks.onSummonMinotaur(); });
  summonList.appendChild(minotaurBtn);

  // Ritual upgrades — surfaced once a Phone Farm has finished building.
  // Bought ones stay visible but go disabled.
  const autoAssignBtn = document.createElement('button');
  autoAssignBtn.className = 'build-button build-button-compact';
  autoAssignBtn.id = 'btn-buy-autoassign';
  autoAssignBtn.innerHTML = `
    <div class="build-content">
      <div class="build-text">
        <div class="build-name">Autotask</div>
      </div>
      <div class="build-cost-side"><span class="build-cost" id="cost-buy-autoassign">${SUMMON_UPGRADES.autoAssign.bloodCost} blood</span></div>
    </div>
  `;
  autoAssignBtn.addEventListener('click', () => { playSound('click', 1, 0.75); callbacks.onBuyAutoAssign(); });
  ritualList.appendChild(autoAssignBtn);

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

  // Goldgoblins — appears alongside Goblin Hole (post-Gas Engine). Once
  // bought, ~10% of new goblins spawn gold-tinted and drop Ƶ150 each.
  const goldGoblinsBtn = document.createElement('button');
  goldGoblinsBtn.className = 'build-button build-button-compact';
  goldGoblinsBtn.id = 'btn-buy-goldgoblins';
  goldGoblinsBtn.style.display = 'none';
  goldGoblinsBtn.innerHTML = `
    <div class="build-content">
      <div class="build-text">
        <div class="build-name">Goldgoblins</div>
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
        <div class="build-name">Goldgoblins x10</div>
      </div>
      <div class="build-cost-side"><span class="build-cost" id="cost-buy-goldgoblins-x10">${SUMMON_UPGRADES.goldgoblinsX10.bloodCost} blood</span></div>
    </div>
  `;
  goldX10Btn.addEventListener('click', () => { playSound('click', 1, 0.75); callbacks.onBuyGoldgoblinsX10(); });
  ritualList.appendChild(goldX10Btn);

  // Dig row — four compact buttons (NESW) on a single line, gated on a
  // Datacentre being built. Each is one-shot and costs DIG.bloodCost blood.
  const digRow = document.createElement('div');
  digRow.id = 'dig-row';
  digRow.style.display = 'none';
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
        <span class="build-cost" id="cost-dig-${dir}" style="font-size: calc(10px * var(--font-body-scale))">${DIG.bloodCost}</span>
      </div>
    `;
    b.addEventListener('click', () => { playSound('click', 1, 0.75); callbacks.onDig(dir); });
    digRow.appendChild(b);
  }
  ritualList.appendChild(digRow);

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
    const yieldBits: string[] = [];
    if (def.income) yieldBits.push(`<span class="yield-money">+Ƶ${def.income.toLocaleString('en-US')}/s</span>`);
    if (def.powerOutput > 0) yieldBits.push(`<span class="yield-power">+${formatPower(def.powerOutput)}</span>`);
    const yieldHtml = yieldBits.length > 0
      ? `<div class="build-yields">${yieldBits.join('<br>')}</div>`
      : '';
    btn.innerHTML = `
      <div class="build-content">
        <div class="build-text">
          <div class="build-name">${def.name}</div>
          <div class="build-meta">
            <span class="build-cost" id="cost-${kind}">Ƶ${def.cost.toLocaleString('en-US')}</span>${powerCostBit}${bloodCostBit}
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
  document.getElementById('info-destroy')!.addEventListener('click', () => {
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
    appendLog(state, `Minotaur #${best.id} ordered to smash ${defOf(target).name} #${target.id}.`);
  });

  // Kill button — kills every currently-selected goblin.
  document.getElementById('info-kill')!.addEventListener('click', () => {
    const ids = [...state.goblins.values()].filter(g => g.selected).map(g => g.id);
    for (const id of ids) callbacks.onKillGoblin(id);
  });
}

function btnId(kind: BuildingKind): string { return `btn-build-${kind}`; }

function anyPhoneFarmBuilt(state: GameState): boolean {
  for (const b of state.buildings.values()) {
    if (b.kind === 'phone_farm' && b.state !== 'constructing') return true;
  }
  return false;
}

function anyGasEngineBuilt(state: GameState): boolean {
  for (const b of state.buildings.values()) {
    if (b.kind === 'gas_engine' && b.state !== 'constructing') return true;
  }
  return false;
}

function anyDatacentreBuilt(state: GameState): boolean {
  for (const b of state.buildings.values()) {
    if (b.kind === 'datacentre' && b.state !== 'constructing') return true;
  }
  return false;
}

function refreshRitualButton(
  btnId: string, costId: string,
  visible: boolean, owned: boolean, canAfford: boolean,
  costText: string,
) {
  const btn = document.getElementById(btnId) as HTMLButtonElement;
  const cost = document.getElementById(costId)!;
  btn.style.display = visible ? '' : 'none';
  if (!visible) return;
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
}

// Single Autospawn button that levels up through AUTOSPAWN_TIERS. The same
// button morphs from "Autospawn" → "Autospawn x2" → "Autospawn x4" → … → x32,
// each purchase replacing the prior in the menu. Once the player owns x32,
// the button is hidden. Shows "needs more holes" when the next-tier multiplier
// would exceed total spawn capacity.
function refreshAutospawnButton(state: GameState, gasEngineBuilt: boolean): void {
  const btn = document.getElementById('btn-buy-autospawn') as HTMLButtonElement;
  const cost = document.getElementById('cost-summon-autospawn-cost')!;
  const label = document.getElementById('label-buy-autospawn')!;
  const warn = document.getElementById('warn-buy-autospawn')!;
  if (!gasEngineBuilt) {
    btn.style.display = 'none';
    return;
  }
  const current = state.autoSpawnMultiplier;
  // Find the next tier the player can buy.
  const next = AUTOSPAWN_TIERS.find(t => t.multiplier > current);
  if (!next) {
    // Already at max — hide the button.
    btn.style.display = 'none';
    return;
  }
  btn.style.display = '';
  label.textContent = next.multiplier === 1 ? 'Autospawn' : `Autospawn x${next.multiplier}`;
  cost.textContent = `${next.bloodCost} blood`;
  const canAfford = state.blood >= next.bloodCost;
  cost.classList.toggle('met', canAfford);
  cost.classList.remove('owned');
  btn.disabled = !canAfford;

  const cap = getSpawnCapacity(state);
  const willOverflow = next.multiplier > cap;
  warn.style.display = willOverflow ? '' : 'none';
}

function progressTrack(id: string, slots: number): string {
  const segs = Array.from({ length: slots }, (_, i) =>
    `<div class="seg" id="seg-${id}-${i}"><div class="fill" id="fill-${id}-${i}"></div></div>`,
  ).join('');
  return `<div class="build-progress-track">${segs}</div>`;
}

export function refreshUI(state: GameState) {
  const idle = countIdle(state);

  setText('money', Math.floor(state.money).toLocaleString('en-US'));

  // Blood resource — hidden until the player kills their first goblin.
  setText('blood', state.blood.toString());

  // Power: hide entirely until any production exists, then show consumed /
  // produced. Tinted red on deficit.
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
  // Determine if any consumer is unpowered (heuristic: dormant + staffed)
  let unpowered = false;
  for (const b of state.buildings.values()) {
    if (b.state !== 'dormant') continue;
    const def = defOf(b);
    if (def.powerOutput >= 0) continue;
    if (maintainerCount(state, b) >= def.maintainersRequired) { unpowered = true; break; }
  }
  powerEl.style.color = unpowered ? '#d96b6b' : '#8acfff';

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

  // Minotaur button — unlocks alongside the Datacentre (once a Gas Engine is built).
  // Disabled while a summon is in progress; the segment bar fills like the
  // Goblin button's spawn track.
  const minotaurBtn = document.getElementById('btn-summon-minotaur') as HTMLButtonElement;
  const minotaurCost = document.getElementById('cost-summon-minotaur')!;
  if (anyGasEngineBuilt(state)) {
    minotaurBtn.style.display = '';
    const queued = state.minotaurSpawnQueue.length;
    const canAffordMinotaur = state.blood >= MINOTAUR.bloodCost;
    minotaurBtn.disabled = queued > 0 || !canAffordMinotaur;
    minotaurCost.textContent = `${MINOTAUR.bloodCost} blood`;
    minotaurCost.classList.toggle('met', canAffordMinotaur && queued === 0);
    minotaurBtn.classList.toggle('in-progress', queued > 0);
    const remaining = queued > 0 ? state.minotaurSpawnQueue[0].remaining : MINOTAUR.spawnTime;
    const fill = queued > 0 ? 1 - remaining / MINOTAUR.spawnTime : 0;
    setFillWidth('fill-summon-minotaur-0', Math.max(0, Math.min(1, fill)));
  } else {
    minotaurBtn.style.display = 'none';
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
    }
  }
  const activeTasks: Task[] = [];
  for (const t of TASKS) {
    if (completedTaskIds.has(t.id)) continue;
    const ready = !t.prereq || t.prereq.every(id => completedTaskIds.has(id));
    if (ready) activeTasks.push(t);
  }
  const firstTaskDone = completedTaskIds.has('earn_100');
  currentTaskCached = activeTasks[0] ?? null;
  // Build subsection only appears once the first tutorial task is done.
  // We hide the inner #build-section, NOT the outer #panel-build, so the
  // task-text stays visible (it lives inside the same scroll container).
  const buildSection = document.getElementById('build-section')!;
  buildSection.style.display = firstTaskDone ? '' : 'none';

  // Ritual upgrades — Autotask and Goblinsixstack appear once a Phone Farm is
  // built; Autospawn appears once a Gas Engine is built. Bought ones stay
  // visible but go disabled.
  const phoneFarmBuilt = anyPhoneFarmBuilt(state);
  const gasEngineBuilt = anyGasEngineBuilt(state);
  // Dig becomes available once the player reaches 6 MW — that way they can
  // dig + find water before placing a Datacentre, instead of being blocked by
  // a thirsty DC.
  const digUnlocked = completedTaskIds.has('reach_6mw');
  const ritualSection = document.getElementById('ritual-section')!;
  ritualSection.style.display = (phoneFarmBuilt || gasEngineBuilt || digUnlocked) ? '' : 'none';

  refreshRitualButton(
    'btn-buy-autoassign', 'cost-buy-autoassign',
    phoneFarmBuilt, state.autoAssignEnabled, state.blood >= SUMMON_UPGRADES.autoAssign.bloodCost,
    `${SUMMON_UPGRADES.autoAssign.bloodCost} blood`,
  );
  refreshAutospawnButton(state, gasEngineBuilt);
  // Goldgoblins → Goldgoblins x10 form a replace chain (like Autospawn):
  // base button hides once owned, x10 takes its place; x10 hides once owned.
  refreshRitualButton(
    'btn-buy-goldgoblins', 'cost-buy-goldgoblins',
    gasEngineBuilt && !state.goldgoblinsEnabled, false,
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

  // Dig row: visible once a Datacentre is built. Each direction is one-shot.
  const digRow = document.getElementById('dig-row')!;
  digRow.style.display = digUnlocked ? 'flex' : 'none';
  for (const dir of ['n', 'e', 's', 'w'] as const) {
    const btn = document.getElementById(`btn-dig-${dir}`) as HTMLButtonElement;
    if (!btn) continue;
    const dug = state.dugDirections.has(dir);
    const canAfford = state.blood >= DIG.bloodCost;
    btn.disabled = dug || !canAfford;
    const label = btn.querySelector('.build-name') as HTMLElement | null;
    if (label) label.textContent = dug ? `${dir.toUpperCase()} ✓` : `Dig ${dir.toUpperCase()}`;
    const cost = document.getElementById(`cost-dig-${dir}`);
    if (cost) {
      cost.textContent = dug ? '' : `${DIG.bloodCost} blood`;
      cost.classList.toggle('met', !dug && canAfford);
    }
  }

  const taskEl = document.getElementById('task-text')!;
  if (activeTasks.length > 0) {
    taskEl.style.display = '';
    taskEl.innerHTML = activeTasks
      .map(t => {
        let progress = '';
        return `<div><strong>Task:</strong> ${t.text}${progress}</div>`;
      })
      .join('');
  } else {
    taskEl.style.display = 'none';
  }

  // Buildings the player has outgrown — once a Gas Engine is running, the
  // Goblin Wheel disappears; once a Datacentre is running, the Phone Farm
  // disappears. The replacement just produces / earns more for the same role.
  const obsoletedKinds = new Set<BuildingKind>();
  for (const b of state.buildings.values()) {
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
    if (!visible) continue;
    const canAffordMoney = state.money >= def.cost;
    const canAffordBlood = !def.bloodCost || state.blood >= def.bloodCost;
    const draw = def.powerOutput < 0 ? -def.powerOutput : 0;
    const enoughPower = draw === 0 || draw <= availablePower;
    // Set the disabled state BEFORE kicking off the fade-in so the right
    // keyframes (full vs disabled-target opacity) get picked.
    btn.disabled = !canAffordMoney || !canAffordBlood || !enoughPower;
    applyFadeInOnFirstShow(btnId(kind));
    btn.classList.toggle('active', state.pendingBuild?.kind === kind);
    document.getElementById(`cost-${kind}`)!.classList.toggle('met', canAffordMoney);
    const powerCostEl = document.getElementById(`power-cost-${kind}`);
    if (powerCostEl) powerCostEl.classList.toggle('met', enoughPower);
    const bloodCostEl = document.getElementById(`blood-cost-${kind}`);
    if (bloodCostEl) bloodCostEl.classList.toggle('met', canAffordBlood);
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
  if (state.pendingBuild) {
    const name = BUILDING_DEFS[state.pendingBuild.kind].name;
    hint.style.display = 'block';
    hint.textContent = `Tap to place ${name} · tap the button again or press ESC to cancel`;
  } else {
    hint.style.display = 'none';
  }

  // Pan-key hint — surfaces once the player has dug at least once, hides
  // on first WASD/arrow press (panHintDismissed).
  const panHint = document.getElementById('pan-hint')!;
  panHint.style.display = (state.dugDirections.size > 0 && !state.panHintDismissed) ? 'block' : 'none';

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

  const destroyBtn = document.getElementById('info-destroy')!;
  const killBtn = document.getElementById('info-kill')!;
  destroyBtn.style.display = 'none';
  killBtn.style.display = 'none';
  if (selectedBuildings.length === 1 && selectedGoblins.length === 0) {
    showBuilding(state, selectedBuildings[0], panel, portrait, name, stateEl, extra);
    destroyBtn.style.display = '';
  } else if (selectedGoblins.length === 1 && selectedBuildings.length === 0) {
    showGoblin(selectedGoblins[0], panel, portrait, name, stateEl, extra);
  } else if (selectedGoblins.length > 1) {
    panel.classList.add('visible');
    portrait.innerHTML = `<div class="portrait-goblin">G</div>`;
    name.textContent = `${selectedGoblins.length} goblins`;
    stateEl.textContent = '';
    extra.innerHTML = `<span style="color:#6a7080">Right-click to command</span>`;
  } else if (state.hole.selected) {
    showHole(state, panel, portrait, name, stateEl, extra);
  } else {
    const selectedMinotaurs = [...state.minotaurs.values()].filter((m) => m.selected);
    if (selectedMinotaurs.length === 1 && selectedGoblins.length === 0 && selectedBuildings.length === 0) {
      const m = selectedMinotaurs[0];
      panel.classList.add('visible');
      portrait.innerHTML = `<div class="portrait-goblin" style="background:#6a1a1a;border-color:#a06aff;color:#ffe0a0">M</div>`;
      name.textContent = `Minotaur #${m.id}`;
      stateEl.textContent = describeMinotaurState(m.state);
      extra.innerHTML = `<span style="color:#6a7080">Right-click to command</span>`;
    } else if (selectedMinotaurs.length > 1) {
      panel.classList.add('visible');
      portrait.innerHTML = `<div class="portrait-goblin" style="background:#6a1a1a;border-color:#a06aff;color:#ffe0a0">M</div>`;
      name.textContent = `${selectedMinotaurs.length} minotaurs`;
      stateEl.textContent = '';
      extra.innerHTML = `<span style="color:#6a7080">Right-click to command</span>`;
    } else {
      panel.classList.remove('visible');
    }
  }
}

function describeMinotaurState(s: import('./state').MinotaurState): string {
  switch (s.kind) {
    case 'wander': return 'Wandering';
    case 'moving_to': return 'Moving';
    case 'going_to_kill': return `Hunting goblin #${s.targetId}`;
    case 'going_to_kill_minotaur': return `Charging Minotaur #${s.targetId}`;
    case 'going_to_destroy': return `Smashing building #${s.buildingId}`;
  }
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

function showGoblin(g: Goblin, panel: HTMLElement, portrait: HTMLElement,
                    name: HTMLElement, stateEl: HTMLElement, extra: HTMLElement) {
  panel.classList.add('visible');
  portrait.innerHTML = `<div class="portrait-goblin">G</div>`;
  name.textContent = `Goblin #${g.id}`;
  stateEl.textContent = describeGoblinState(g.state);
  extra.innerHTML = `<span style="color:#6a7080">Right-click to command</span>`;
}

function showBuilding(state: GameState, b: Building, panel: HTMLElement, portrait: HTMLElement,
                      name: HTMLElement, stateEl: HTMLElement, extra: HTMLElement) {
  panel.classList.add('visible');
  const def = defOf(b);
  const cls = b.state === 'constructing' ? 'constructing' :
              b.state === 'dormant' ? 'dormant' : 'active';
  portrait.innerHTML = `<div class="portrait-building ${b.kind} ${cls}">${def.short}</div>`;
  name.textContent = `${def.name} #${b.id}`;

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
    extra.innerHTML = lines.join('<br>');
  }
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

function describeGoblinState(s: GoblinState): string {
  switch (s.kind) {
    case 'idle': return '';
    case 'moving': return 'Moving';
    case 'going_to_build': return `Walking to build site #${s.buildingId}`;
    case 'going_to_maintain': return `Walking to maintain #${s.buildingId}`;
    case 'building': return `Constructing #${s.buildingId}`;
    case 'maintaining': return `Maintaining #${s.buildingId}`;
    case 'fetching_water':
      return s.phase === 'to_source'
        ? `Fetching water for #${s.buildingId}`
        : `Delivering water to #${s.buildingId}`;
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
    appendLog(state, 'Task skip: nothing to skip.');
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
      // GE produces 2.5 MW (covers PF). Keep the 2 wheels from before so the
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
    case 'reach_6mw': {
      // Reach 6 MW production. Three Gas Engines (2.5 MW each) cover it
      // with headroom. No Datacentre placed yet — the next task is to run
      // one, which involves digging, placing the DC, and watering it.
      ensureGoblins(state, 24);
      ensureBuildingCount(state, 'goblin_wheel', 2);
      ensureBuildingCount(state, 'phone_farm', 1);
      ensureBuildingCount(state, 'gas_engine', 3);
      state.money = Math.max(state.money, 3000);
      state.blood = Math.max(state.blood, 150);
      state.bloodUnlocked = true;
      break;
    }
    case 'run_datacentre': {
      // Full DC setup: dig water + maintainers + carriers so the DC powers
      // up. The previous tier's reach_6mw skip already provided gas engines.
      ensureGoblins(state, 40);
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
      // (1 GW) does the heavy lifting; the gas engines stay around for
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
  }

  completedTaskIds.add(next.id);
  // Task-skip is a debug shortcut — don't fire the celebration animation
  // and reveal the unlocks immediately rather than waiting on the overlay.
  previouslyCompletedTaskIds.add(next.id);
  revealedTaskIds.add(next.id);
  appendLog(state, `Task skip: "${next.text}" marked complete.`);
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
