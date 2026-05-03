import { playSound } from './audio';
import {
  BUILDABLE_KINDS, BUILDING_DEFS, BuildingKind, GOBLIN, SUMMON_UPGRADES, MINOTAUR, formatPower,
} from './config';
import {
  Building, Cell, GameState, Goblin, GoblinState,
  appendLog, cellCenter, cellKey, countIdle, defOf, holeBlockedByBuilding,
  isCellBlocked, isInBounds, maintainerCount, occupyCell,
} from './state';

// Buttons render in cheapest-first order regardless of declaration order.
const SORTED_KINDS: BuildingKind[] = [...BUILDABLE_KINDS].sort(
  (a, b) => BUILDING_DEFS[a].cost - BUILDING_DEFS[b].cost,
);

// Inserted between adjacent build buttons that belong to different tutorial
// task groups; refreshUI hides separators for not-yet-completed tasks.
type BuildSeparator = { el: HTMLElement; afterTaskId: string };
const buildSeparators: BuildSeparator[] = [];

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
    text: 'Make Ƶ100',
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
    id: 'build_datacentre',
    text: 'Build a Datacentre',
    unlocks: ['goblin_hole'],
    isDone: (s) => {
      for (const b of s.buildings.values()) {
        if (b.kind === 'datacentre' && b.state !== 'constructing') return true;
      }
      return false;
    },
    prereq: ['build_gas_engine'],
  },
];

export type UICallbacks = {
  onSpawnGoblin: () => void;
  onSummonMinotaur: () => void;
  onBuyAutoAssign: () => void;
  onBuyAutoSpawn: () => void;
  onBuyWiderHole: () => void;
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
  spawnBtn.addEventListener('click', () => { playSound('click'); callbacks.onSpawnGoblin(); });
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
  minotaurBtn.addEventListener('click', () => { playSound('click'); callbacks.onSummonMinotaur(); });
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
  autoAssignBtn.addEventListener('click', () => { playSound('click'); callbacks.onBuyAutoAssign(); });
  ritualList.appendChild(autoAssignBtn);

  const widerHoleBtn = document.createElement('button');
  widerHoleBtn.className = 'build-button build-button-compact';
  widerHoleBtn.id = 'btn-buy-widerhole';
  widerHoleBtn.innerHTML = `
    <div class="build-content">
      <div class="build-text">
        <div class="build-name">Goblinsixstack</div>
      </div>
      <div class="build-cost-side"><span class="build-cost" id="cost-buy-widerhole">${SUMMON_UPGRADES.widerHole.bloodCost} blood</span></div>
    </div>
  `;
  widerHoleBtn.addEventListener('click', () => { playSound('click'); callbacks.onBuyWiderHole(); });
  ritualList.appendChild(widerHoleBtn);

  const autoSpawnBtn = document.createElement('button');
  autoSpawnBtn.className = 'build-button build-button-compact';
  autoSpawnBtn.id = 'btn-buy-autospawn';
  autoSpawnBtn.innerHTML = `
    <div class="build-content">
      <div class="build-text">
        <div class="build-name">Autospawn</div>
      </div>
      <div class="build-cost-side"><span class="build-cost" id="cost-buy-autospawn">${SUMMON_UPGRADES.autoSpawn.bloodCost} blood</span></div>
    </div>
  `;
  autoSpawnBtn.addEventListener('click', () => { playSound('click'); callbacks.onBuyAutoSpawn(); });
  ritualList.appendChild(autoSpawnBtn);

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
    if (def.income) yieldBits.push(`<span class="yield-money">+Ƶ${def.income}/s</span>`);
    if (def.powerOutput > 0) yieldBits.push(`<span class="yield-power">+${formatPower(def.powerOutput)}</span>`);
    const yieldHtml = yieldBits.length > 0
      ? `<div class="build-yields">${yieldBits.join('<br>')}</div>`
      : '';
    btn.innerHTML = `
      <div class="build-content">
        <div class="build-text">
          <div class="build-name">${def.name}</div>
          <div class="build-meta">
            <span class="build-cost" id="cost-${kind}">Ƶ${def.cost}</span>${powerCostBit}${bloodCostBit}
          </div>
        </div>
        ${yieldHtml}
      </div>
    `;
    btn.addEventListener('click', () => { playSound('click'); callbacks.onBuildBuilding(kind); });
    buildList.appendChild(btn);
  }

  // Destroy button on the info panel — uses currently-selected building from state.
  document.getElementById('info-destroy')!.addEventListener('click', () => {
    for (const b of state.buildings.values()) {
      if (b.selected) { callbacks.onDestroyBuilding(b.id); break; }
    }
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
}

function progressTrack(id: string, slots: number): string {
  const segs = Array.from({ length: slots }, (_, i) =>
    `<div class="seg" id="seg-${id}-${i}"><div class="fill" id="fill-${id}-${i}"></div></div>`,
  ).join('');
  return `<div class="build-progress-track">${segs}</div>`;
}

export function refreshUI(state: GameState) {
  const idle = countIdle(state);

  setText('money', Math.floor(state.money).toString());

  // Blood resource — hidden until the player kills their first goblin.
  const bloodRow = document.getElementById('row-blood')!;
  bloodRow.style.display = state.bloodUnlocked ? '' : 'none';
  if (state.bloodUnlocked) setText('blood', state.blood.toString());

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
  const cap = state.hole.spawnCapacity;
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
  // the *active* tasks (multiple can be active at once).
  const unlocked = new Set<BuildingKind>();
  for (const t of TASKS) {
    if (completedTaskIds.has(t.id) || t.isDone(state)) {
      completedTaskIds.add(t.id);
      for (const k of t.unlocks) unlocked.add(k);
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
  // Build panel only appears once the first tutorial task is done.
  const buildPanel = document.getElementById('panel-build')!;
  buildPanel.style.display = firstTaskDone ? '' : 'none';

  // Ritual upgrades — Autotask and Goblinsixstack appear once a Phone Farm is
  // built; Autospawn appears once a Gas Engine is built. Bought ones stay
  // visible but go disabled.
  const phoneFarmBuilt = anyPhoneFarmBuilt(state);
  const gasEngineBuilt = anyGasEngineBuilt(state);
  const ritualPanel = document.getElementById('panel-ritual')!;
  ritualPanel.style.display = (phoneFarmBuilt || gasEngineBuilt) ? '' : 'none';

  refreshRitualButton(
    'btn-buy-autoassign', 'cost-buy-autoassign',
    phoneFarmBuilt, state.autoAssignEnabled, state.blood >= SUMMON_UPGRADES.autoAssign.bloodCost,
    `${SUMMON_UPGRADES.autoAssign.bloodCost} blood`,
  );
  refreshRitualButton(
    'btn-buy-widerhole', 'cost-buy-widerhole',
    phoneFarmBuilt, state.widerHoleEnabled, state.blood >= SUMMON_UPGRADES.widerHole.bloodCost,
    `${SUMMON_UPGRADES.widerHole.bloodCost} blood`,
  );
  refreshRitualButton(
    'btn-buy-autospawn', 'cost-buy-autospawn',
    gasEngineBuilt, state.autoSpawnEnabled, state.blood >= SUMMON_UPGRADES.autoSpawn.bloodCost,
    `${SUMMON_UPGRADES.autoSpawn.bloodCost} blood`,
  );

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

  // Each building kind
  const availablePower = state.lastPowerProduced - state.lastPowerConsumed;
  for (const kind of SORTED_KINDS) {
    const def = BUILDING_DEFS[kind];
    const btn = document.getElementById(btnId(kind)) as HTMLButtonElement;
    btn.classList.toggle('locked', !unlocked.has(kind));
    if (!unlocked.has(kind)) continue;
    const canAffordMoney = state.money >= def.cost;
    const canAffordBlood = !def.bloodCost || state.blood >= def.bloodCost;
    const draw = def.powerOutput < 0 ? -def.powerOutput : 0;
    const enoughPower = draw === 0 || draw <= availablePower;
    btn.disabled = !canAffordMoney || !canAffordBlood || !enoughPower;
    btn.classList.toggle('active', state.pendingBuild?.kind === kind);
    document.getElementById(`cost-${kind}`)!.classList.toggle('met', canAffordMoney);
    const powerCostEl = document.getElementById(`power-cost-${kind}`);
    if (powerCostEl) powerCostEl.classList.toggle('met', enoughPower);
    const bloodCostEl = document.getElementById(`blood-cost-${kind}`);
    if (bloodCostEl) bloodCostEl.classList.toggle('met', canAffordBlood);
  }

  // Hide separators that mark a task boundary the player hasn't crossed yet.
  for (const sep of buildSeparators) {
    sep.el.style.display = completedTaskIds.has(sep.afterTaskId) ? '' : 'none';
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
      extra.innerHTML = `<span style="color:#6a7080">Right-click a building to smash it, or another minotaur to gore it</span>`;
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
      if (def.income) bits.push(`earning Ƶ${def.income}/s`);
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
    case 'idle': return 'Idle';
    case 'moving': return 'Moving';
    case 'going_to_build': return `Walking to build site #${s.buildingId}`;
    case 'going_to_maintain': return `Walking to maintain #${s.buildingId}`;
    case 'building': return `Constructing #${s.buildingId}`;
    case 'maintaining': return `Maintaining #${s.buildingId}`;
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
      ensureGoblins(state, 7);
      ensureBuilding(state, 'goblin_wheel');
      ensureBuilding(state, 'goblin_wheel');
      ensureBuilding(state, 'phone_farm');
      state.money = Math.max(state.money, 250);
      break;
    }
    case 'build_gas_engine': {
      ensureGoblins(state, 12);
      ensureBuilding(state, 'goblin_wheel');
      ensureBuilding(state, 'goblin_wheel');
      ensureBuilding(state, 'phone_farm');
      ensureBuilding(state, 'gas_engine');
      state.money = Math.max(state.money, 1200);
      // A few kills' worth of blood — enough to summon a Minotaur once.
      state.blood = Math.max(state.blood, 8);
      state.bloodUnlocked = true;
      break;
    }
    case 'build_datacentre': {
      ensureGoblins(state, 30);
      ensureBuilding(state, 'goblin_wheel');
      ensureBuilding(state, 'goblin_wheel');
      ensureBuilding(state, 'phone_farm');
      ensureBuilding(state, 'gas_engine');
      ensureBuilding(state, 'gas_engine');
      ensureBuilding(state, 'gas_engine');
      ensureBuilding(state, 'datacentre');
      state.money = Math.max(state.money, 5000);
      state.blood = Math.max(state.blood, 25);
      state.bloodUnlocked = true;
      break;
    }
  }

  completedTaskIds.add(next.id);
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
          state: { kind: 'idle' }, selected: false, idleSince: null,
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

function ensureBuilding(state: GameState, kind: BuildingKind): boolean {
  // If one already exists past construction, leave it alone.
  for (const b of state.buildings.values()) {
    if (b.kind === kind && b.state !== 'constructing') return true;
  }
  const def = BUILDING_DEFS[kind];
  const tl = findFreeFootprint(state, def.cellSize);
  if (!tl) return false;
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
  // Pull idle goblins as maintainers so the building can power up.
  let need = def.maintainersRequired;
  for (const g of state.goblins.values()) {
    if (need <= 0) break;
    if (g.state.kind !== 'idle') continue;
    b.assignedGoblins.push(g.id);
    g.state = { kind: 'going_to_maintain', buildingId: b.id };
    g.goal = null;
    g.path = [];
    need--;
  }
  return true;
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
