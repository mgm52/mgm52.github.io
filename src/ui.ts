import { BUILDABLE_KINDS, BUILDING_DEFS, BuildingKind, GOBLIN, formatPower } from './config';
import { Building, GameState, Goblin, GoblinState, countIdle, defOf, maintainerCount } from './state';

// Buttons render in cheapest-first order regardless of declaration order.
const SORTED_KINDS: BuildingKind[] = [...BUILDABLE_KINDS].sort(
  (a, b) => BUILDING_DEFS[a].cost - BUILDING_DEFS[b].cost,
);

// Tutorial gating: each task unlocks one or more building kinds when complete.
type Task = {
  id: string;
  text: string;
  unlocks: BuildingKind[];
  isDone: (s: GameState) => boolean;
};
const TASKS: Task[] = [
  {
    id: 'wheel_turning',
    text: 'Get the Goblin Wheel turning',
    unlocks: ['goblin_wheel', 'phone_farm'],
    isDone: (s) => {
      for (const b of s.buildings.values()) {
        if (b.kind === 'goblin_wheel' && b.state === 'active') return true;
      }
      return false;
    },
  },
  {
    id: 'run_phone_farm',
    text: 'Run a Phone Farm',
    unlocks: ['gas_genset', 'datacentre'],
    isDone: (s) => {
      for (const b of s.buildings.values()) {
        if (b.kind === 'phone_farm' && b.state === 'active') return true;
      }
      return false;
    },
  },
];

export type UICallbacks = {
  onSpawnGoblin: () => void;
  onBuildBuilding: (kind: BuildingKind) => void;
  onDestroyBuilding: (id: number) => void;
};

export function setupUI(state: GameState, callbacks: UICallbacks) {
  const summonList = document.getElementById('summon-list')!;
  const buildList = document.getElementById('build-list')!;

  // Spawn Goblin button (Summon section)
  const spawnBtn = document.createElement('button');
  spawnBtn.className = 'build-button';
  spawnBtn.id = 'btn-spawn-goblin';
  spawnBtn.innerHTML = `
    ${progressTrack('spawn-goblin', GOBLIN.concurrentBuildLimit)}
    <div class="build-content">
      <div class="build-name">Spawn Goblin</div>
      <div class="build-meta">
        <span class="build-cost" id="cost-spawn-goblin">Ƶ${GOBLIN.spawnCost}</span>
      </div>
    </div>
  `;
  spawnBtn.addEventListener('click', callbacks.onSpawnGoblin);
  summonList.appendChild(spawnBtn);

  // One button per building kind
  for (const kind of SORTED_KINDS) {
    const def = BUILDING_DEFS[kind];
    const btn = document.createElement('button');
    btn.className = 'build-button';
    btn.id = btnId(kind);
    const powerCostBit = def.powerOutput < 0
      ? ` · <span class="build-power-cost" id="power-cost-${kind}">${formatPower(-def.powerOutput)}</span>`
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
            <span class="build-cost" id="cost-${kind}">Ƶ${def.cost}</span>${powerCostBit}
          </div>
        </div>
        ${yieldHtml}
      </div>
    `;
    btn.addEventListener('click', () => callbacks.onBuildBuilding(kind));
    buildList.appendChild(btn);
  }

  // Destroy button on the info panel — uses currently-selected building from state.
  document.getElementById('info-destroy')!.addEventListener('click', () => {
    for (const b of state.buildings.values()) {
      if (b.selected) { callbacks.onDestroyBuilding(b.id); break; }
    }
  });
}

function btnId(kind: BuildingKind): string { return `btn-build-${kind}`; }

function progressTrack(id: string, slots: number): string {
  const segs = Array.from({ length: slots }, (_, i) =>
    `<div class="seg"><div class="fill" id="fill-${id}-${i}"></div></div>`,
  ).join('');
  return `<div class="build-progress-track">${segs}</div>`;
}

export function refreshUI(state: GameState) {
  const idle = countIdle(state);

  setText('money', Math.floor(state.money).toString());

  // Power: show consumed / produced. Tinted red on deficit.
  const produced = state.lastPowerProduced;
  const consumed = state.lastPowerConsumed;
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

  // Spawn Goblin
  const spawnInProgress = state.spawnQueue.length;
  const spawnBtn = document.getElementById('btn-spawn-goblin') as HTMLButtonElement;
  const canAffordGoblin = state.money >= GOBLIN.spawnCost;
  spawnBtn.disabled = !canAffordGoblin || spawnInProgress >= GOBLIN.concurrentBuildLimit;
  spawnBtn.classList.toggle('in-progress', spawnInProgress > 0);
  document.getElementById('cost-spawn-goblin')!.classList.toggle('met', canAffordGoblin);
  const spawnBySlot: Record<number, number> = {};
  for (const item of state.spawnQueue) {
    spawnBySlot[item.slot] = 1 - item.remaining / GOBLIN.spawnTime;
  }
  for (let i = 0; i < GOBLIN.concurrentBuildLimit; i++) {
    setFillWidth(`fill-spawn-goblin-${i}`, spawnBySlot[i] ?? 0);
  }

  // Tutorial: figure out which kinds are unlocked and what the current task is.
  const unlocked = new Set<BuildingKind>();
  let currentTask: Task | null = null;
  let firstTaskDone = false;
  for (let i = 0; i < TASKS.length; i++) {
    const t = TASKS[i];
    if (t.isDone(state)) {
      for (const k of t.unlocks) unlocked.add(k);
      if (i === 0) firstTaskDone = true;
    } else if (!currentTask) {
      currentTask = t;
    }
  }
  // Build panel only appears once the first tutorial task is done.
  const buildPanel = document.getElementById('panel-build')!;
  buildPanel.style.display = firstTaskDone ? '' : 'none';

  const taskEl = document.getElementById('task-text')!;
  if (currentTask) {
    taskEl.style.display = '';
    taskEl.innerHTML = `<strong>Task:</strong> ${currentTask.text}`;
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
    const canAfford = state.money >= def.cost;
    const draw = def.powerOutput < 0 ? -def.powerOutput : 0;
    const enoughPower = draw === 0 || draw <= availablePower;
    btn.disabled = !canAfford || !enoughPower;
    btn.classList.toggle('active', state.pendingBuild?.kind === kind);
    document.getElementById(`cost-${kind}`)!.classList.toggle('met', canAfford);
    const powerCostEl = document.getElementById(`power-cost-${kind}`);
    if (powerCostEl) powerCostEl.classList.toggle('met', enoughPower);
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
  destroyBtn.style.display = 'none';
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
    extra.innerHTML = `<span style="color:#6a7080">Right-click or long-press to command</span>`;
  } else {
    panel.classList.remove('visible');
  }
}

function showGoblin(g: Goblin, panel: HTMLElement, portrait: HTMLElement,
                    name: HTMLElement, stateEl: HTMLElement, extra: HTMLElement) {
  panel.classList.add('visible');
  portrait.innerHTML = `<div class="portrait-goblin">G</div>`;
  name.textContent = `Goblin #${g.id}`;
  stateEl.textContent = describeGoblinState(g.state);
  extra.innerHTML = `<span style="color:#6a7080">Right-click or long-press to command</span>`;
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
  }
}
