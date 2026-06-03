import { BUILDABLE_KINDS, BUILDING_DEFS } from './config';
import {
  BUILTIN_TASK_IDS, goalNeeds, goalText, taskRequiresOf, taskText,
  upgradeCatalogIds, upgradeName, upgradeSection,
  type CreatureKind, type DemonReward, type TaskDef, type TaskGoal, type UpgradeTreeData,
} from './upgrade-tree';

// ─── Dev balance editor for src/upgrade-tree.json ───────────────────
// Loaded by upgrade-editor.html on the vite dev server only. Fetches the
// json from the /__dev/upgrade-tree middleware (vite.config.ts), lets you
// drag nodes / edit pip numbers / rewire prerequisite edges / reorder the
// work chain / add new templated work blocks, and POSTs the whole document
// back to disk on Save.
//
// Work ("task") semantics mirror the game (taskRequiresOf): each task has
// an explicit `requires` list of other task ids — the same DAG model as
// upgrades, edited with the same link-prerequisite flow.

const NODE_W = 148;
const NODE_H = 58;
const CANVAS_PAD = 80;
const SHOW_NEEDS_KEY = 'ute.showNeedsEdges';

let doc: UpgradeTreeData;
let dirty = false;
let selected: string | null = null;     // node key: upgrade id or 'task:<id>'
let linkSource: string | null = null;   // upgrade id awaiting a prereq pick
let addingUpgrade = false;              // inspector shows the add-upgrade picker
const nodeEls = new Map<string, HTMLElement>();

const canvas = document.getElementById('canvas')!;
const statusEl = document.getElementById('status')!;
const inspectorEl = document.getElementById('inspector')!;
const demonRewardEl = document.getElementById('demon-reward')!;
const reportEl = document.getElementById('report')!;
const needsToggle = document.getElementById('toggle-needs') as HTMLInputElement;

const isTaskKey = (key: string) => key.startsWith('task:');
const taskId = (key: string) => key.slice(5);
const taskDef = (id: string): TaskDef | undefined => doc.tasks.find((t) => t.id === id);

// Display label for any node key (task or upgrade).
function nodeLabel(key: string): string {
  if (!isTaskKey(key)) return upgradeName(key);
  const d = taskDef(taskId(key));
  return d ? taskText(d) : taskId(key);
}

const CREATURES: CreatureKind[] = ['goblin', 'minotaur', 'dragon'];

function setStatus(text: string, cls: '' | 'dirty' | 'error' = ''): void {
  statusEl.textContent = text;
  statusEl.className = cls;
}

function markDirty(): void {
  dirty = true;
  setStatus('unsaved changes', 'dirty');
}

function layoutOf(key: string): { x: number; y: number } {
  let p = doc.layout[key];
  if (!p) { p = { x: 60, y: 60 }; doc.layout[key] = p; }
  return p;
}

// ─── Loading / saving ────────────────────────────────────────────────

async function load(): Promise<void> {
  const res = await fetch('/__dev/upgrade-tree');
  if (!res.ok) { setStatus(`failed to load: HTTP ${res.status} — is this the vite dev server?`, 'error'); return; }
  doc = await res.json();
  dirty = false;
  selected = null;
  linkSource = null;
  setStatus('loaded');
  render();
}

async function save(): Promise<void> {
  try {
    const res = await fetch('/__dev/upgrade-tree', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(doc),
    });
    const out = await res.json();
    if (!res.ok || !out.ok) throw new Error(out.error ?? `HTTP ${res.status}`);
    dirty = false;
    setStatus(`saved to src/upgrade-tree.json at ${new Date().toLocaleTimeString()}`);
  } catch (e) {
    setStatus(`save failed: ${e}`, 'error');
  }
}

document.getElementById('btn-save')!.addEventListener('click', () => void save());
document.getElementById('btn-revert')!.addEventListener('click', () => {
  if (!dirty || window.confirm('Discard unsaved changes and reload from disk?')) void load();
});
document.getElementById('btn-add-work')!.addEventListener('click', () => addWork());
document.getElementById('btn-add-upgrade')!.addEventListener('click', () => {
  addingUpgrade = true;
  selected = null;
  renderSide();
  refreshNodeClasses();
});
needsToggle.checked = localStorage.getItem(SHOW_NEEDS_KEY) !== '0';
needsToggle.addEventListener('change', () => {
  localStorage.setItem(SHOW_NEEDS_KEY, needsToggle.checked ? '1' : '0');
  render();
});
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); void save(); }
  if (e.key === 'Escape') { linkSource = null; selected = null; addingUpgrade = false; renderSide(); refreshNodeClasses(); }
});
window.addEventListener('beforeunload', (e) => {
  if (dirty) e.preventDefault();
});

// ─── Graph helpers ───────────────────────────────────────────────────

// Would adding `req` as a prerequisite of `id` create a cycle? True when
// `id` is already reachable from `req` through requires edges.
function wouldCycle(id: string, req: string): boolean {
  const stack = [req];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (cur === id) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const r of doc.upgrades[cur]?.requires ?? []) stack.push(r);
  }
  return false;
}

// Same, across the work DAG.
function taskWouldCycle(id: string, req: string): boolean {
  const stack = [req];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (cur === id) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const d = taskDef(cur);
    if (d) for (const r of taskRequiresOf(d)) stack.push(r);
  }
  return false;
}

// Cost of buying every not-yet-owned upgrade in the prerequisite closure of
// `wanted`. Returns null if the closure references an unknown id.
function closureCost(wanted: string[], owned: Set<string>): { cost: number; toBuy: string[] } | null {
  const toBuy: string[] = [];
  const stack = [...wanted];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (owned.has(id) || seen.has(id)) continue;
    seen.add(id);
    const def = doc.upgrades[id];
    if (!def) return null;
    toBuy.push(id);
    for (const r of def.requires) stack.push(r);
  }
  let cost = 0;
  for (const id of toBuy) cost += doc.upgrades[id].cost;
  return { cost, toBuy };
}

// ─── Upgrade node add / delete ───────────────────────────────────────

// Known ids that could exist as tree nodes but currently don't (e.g.
// lightning, or a building the designer removed).
function missingCatalogIds(): string[] {
  return upgradeCatalogIds().filter((id) => !(id in doc.upgrades));
}

function addUpgradeNode(id: string): void {
  doc.upgrades[id] = { cost: 1, requires: [] };
  // Drop the node below the current lowest upgrade node.
  let maxY = 40;
  for (const key of Object.keys(doc.upgrades)) {
    const p = doc.layout[key];
    if (p && p.y > maxY) maxY = p.y;
  }
  doc.layout[id] = { x: 40, y: maxY + NODE_H + 40 };
  addingUpgrade = false;
  selected = id;
  markDirty();
  render();
}

function deleteUpgrade(id: string): void {
  const dependents = Object.entries(doc.upgrades)
    .filter(([, d]) => d.requires.includes(id))
    .map(([k]) => upgradeName(k));
  const needingTasks = doc.tasks.filter((t) => goalNeeds(t.goal).includes(id)).map((t) => taskText(t));
  const warnings = [
    dependents.length > 0 ? `Prerequisite of: ${dependents.join(', ')} (those links will be removed).` : '',
    needingTasks.length > 0 ? `Needed by work: ${needingTasks.join(', ')} (those become uncompletable).` : '',
  ].filter(Boolean).join('\n');
  if (!window.confirm(`Remove "${upgradeName(id)}" from the tree? It will no longer be purchasable.${warnings ? `\n\n${warnings}` : ''}`)) return;
  delete doc.upgrades[id];
  delete doc.layout[id];
  for (const d of Object.values(doc.upgrades)) {
    d.requires = d.requires.filter((r) => r !== id);
  }
  if (selected === id) selected = null;
  markDirty();
  render();
}

// ─── Work (task) editing ─────────────────────────────────────────────

function addWork(): void {
  // Unique id: work_1, work_2, …
  let n = 1;
  while (doc.tasks.some((t) => t.id === `work_${n}`)) n++;
  const id = `work_${n}`;
  // No prerequisites — active from the start until linked into the DAG.
  const def: TaskDef = { id, pips: 1, requires: [], goal: { type: 'build', building: 'wall', count: 1 } };
  doc.tasks.push(def);
  // Drop the node just right of the current right-most task.
  let maxX = 40, y = 40;
  for (const t of doc.tasks) {
    const p = doc.layout[`task:${t.id}`];
    if (p && p.x > maxX) { maxX = p.x; y = p.y; }
  }
  doc.layout[`task:${id}`] = { x: maxX + NODE_W + 40, y };
  selected = `task:${id}`;
  markDirty();
  render();
}

function deleteWork(id: string): void {
  const builtinBit = BUILTIN_TASK_IDS.has(id)
    ? '\n\nThis is a built-in task — game code references it (work-skip rigs, onboarding gates) and will fall back to defaults without it.'
    : '';
  if (!window.confirm(`Delete work "${taskText(taskDef(id)!)}"? Its pips will no longer be earnable.${builtinBit}`)) return;
  doc.tasks = doc.tasks.filter((t) => t.id !== id);
  delete doc.layout[`task:${id}`];
  // Strip the deleted task from every other task's prerequisites.
  for (const t of doc.tasks) {
    if (t.requires) t.requires = t.requires.filter((r) => r !== id);
    if (t.after === id) delete t.after;
  }
  if (selected === `task:${id}`) selected = null;
  markDirty();
  render();
}

// Default goal when switching template type in the inspector, carrying the
// old count across where it makes sense.
function defaultGoal(type: TaskGoal['type'], prev: TaskGoal): TaskGoal {
  const count = 'count' in prev ? prev.count : 1;
  const amount = 'amount' in prev ? prev.amount : 100;
  switch (type) {
    case 'earn_money': return { type, amount };
    case 'place': return { type, building: 'wall', count };
    case 'build': return { type, building: 'wall', count };
    case 'run': return { type, building: 'phone_farm', count };
    case 'kill': return { type, creature: 'goblin', count };
    case 'summon_minotaurs': return { type, count };
    case 'collect_bones': return { type, amount: 5 };
  }
}

// ─── Rendering ───────────────────────────────────────────────────────

type Edge = { from: string; to: string; kind: 'req' | 'chain' | 'needs' };

function allEdges(): Edge[] {
  const edges: Edge[] = [];
  for (const [id, def] of Object.entries(doc.upgrades)) {
    for (const req of def.requires) edges.push({ from: req, to: id, kind: 'req' });
  }
  for (const t of doc.tasks) {
    for (const p of taskRequiresOf(t)) edges.push({ from: `task:${p}`, to: `task:${t.id}`, kind: 'chain' });
    if (needsToggle.checked) {
      for (const n of goalNeeds(t.goal)) edges.push({ from: n, to: `task:${t.id}`, kind: 'needs' });
    }
  }
  return edges;
}

function edgePath(e: { from: string; to: string }): string {
  const a = layoutOf(e.from);
  const b = layoutOf(e.to);
  const x1 = a.x + NODE_W, y1 = a.y + NODE_H / 2;
  const x2 = b.x, y2 = b.y + NODE_H / 2;
  const mid = (x1 + x2) / 2;
  return `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`;
}

// With the control points edgePath uses, the cubic's t=0.5 point lands on the
// plain midpoint of the endpoints — where the running-total label sits.
function edgeMidpoint(e: { from: string; to: string }): { x: number; y: number } {
  const a = layoutOf(e.from);
  const b = layoutOf(e.to);
  return { x: (a.x + NODE_W + b.x) / 2, y: (a.y + b.y) / 2 + NODE_H / 2 };
}

// Pips guaranteed earned before task `id` unlocks: the payouts of its whole
// prerequisite closure (ancestors only, not `id` itself).
function earnedBefore(id: string): number {
  const seen = new Set<string>();
  const root = taskDef(id);
  const stack = root ? [...taskRequiresOf(root)] : [];
  let sum = 0;
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const d = taskDef(cur);
    if (!d) continue;
    sum += d.pips;
    stack.push(...taskRequiresOf(d));
  }
  return sum;
}

// Total pips sunk before `id` can be bought — its prerequisite closure, NOT
// counting `id` itself. The number shown on edges arriving at `id`.
function spentBefore(id: string): number {
  return closureCost(doc.upgrades[id]?.requires ?? [], new Set())?.cost ?? 0;
}

// The running-total label for an edge, or null for unlabelled kinds (needs).
// Both flavours show "everything before that point": chain edges the pips
// earned from everything leading up to (excluding) the target work, req
// edges the pips spent on everything leading up to (excluding) the target
// node.
function edgeLabelText(e: Edge): string | null {
  if (e.kind === 'req') return `◉ ${spentBefore(e.to)}`;
  if (e.kind === 'chain') return `◉ ${earnedBefore(taskId(e.to))}`;
  return null;
}

function canvasSize(): { w: number; h: number } {
  let w = 0, h = 0;
  for (const key of Object.keys(doc.layout)) {
    const p = doc.layout[key];
    w = Math.max(w, p.x + NODE_W);
    h = Math.max(h, p.y + NODE_H);
  }
  return { w: w + CANVAS_PAD, h: h + CANVAS_PAD };
}

function render(): void {
  canvas.innerHTML = '';
  nodeEls.clear();
  const { w, h } = canvasSize();
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.id = 'edges';
  svg.setAttribute('width', String(w));
  svg.setAttribute('height', String(h));
  canvas.appendChild(svg);

  const labels: SVGTextElement[] = [];
  for (const e of allEdges()) {
    const removable = e.kind === 'req' || e.kind === 'chain';
    // Fat invisible twin first so the visible line draws on top of it.
    if (removable) {
      const hit = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      hit.setAttribute('d', edgePath(e));
      hit.classList.add('edge-hit');
      hit.addEventListener('click', () => removeEdge(e));
      svg.appendChild(hit);
    }
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', edgePath(e));
    path.classList.add('edge', e.kind);
    path.dataset.from = e.from;
    path.dataset.to = e.to;
    if (removable) {
      path.addEventListener('click', () => removeEdge(e));
      const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      title.textContent = e.kind === 'req'
        ? `${upgradeName(e.from)} → ${upgradeName(e.to)} (click to remove) · ◉ ${spentBefore(e.to)} spent before ${upgradeName(e.to)} (its cost: ◉ ${doc.upgrades[e.to].cost})`
        : `${nodeLabel(e.from)} → ${nodeLabel(e.to)} (click to remove) · ◉ ${earnedBefore(taskId(e.to))} earned before it`;
      path.appendChild(title);
    }
    svg.appendChild(path);

    // Running pip total at the edge midpoint: everything before the target —
    // ◉ spent on its prereq closure (req) / ◉ earned from its ancestor work
    // (chain).
    const text = edgeLabelText(e);
    if (text !== null) {
      const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      const mid = edgeMidpoint(e);
      label.setAttribute('x', String(mid.x));
      label.setAttribute('y', String(mid.y - 5));
      label.setAttribute('text-anchor', 'middle');
      label.classList.add('edge-label', e.kind);
      label.dataset.from = e.from;
      label.dataset.to = e.to;
      label.textContent = text;
      labels.push(label);
    }
  }
  // Labels go in last so they draw above every line.
  for (const l of labels) svg.appendChild(l);

  for (const [id, def] of Object.entries(doc.upgrades)) {
    addNode(id, upgradeSection(id), upgradeName(id), `◉ ${def.cost}`, false);
  }
  for (const t of doc.tasks) {
    addNode(`task:${t.id}`, t.optional ? 'optional work' : 'work', taskText(t), `pays ◉ ${t.pips}`, t.optional ?? false);
  }
  refreshNodeClasses();
  renderSide();
}

function addNode(key: string, sec: string, name: string, cost: string, optional: boolean): void {
  const p = layoutOf(key);
  const el = document.createElement('div');
  el.className = 'node';
  if (isTaskKey(key)) el.classList.add('task');
  if (optional) el.classList.add('optional');
  el.style.left = `${p.x}px`;
  el.style.top = `${p.y}px`;
  el.innerHTML = `<span class="sec"></span><span class="name"></span><span class="cost"></span>`;
  (el.querySelector('.sec') as HTMLElement).textContent = sec;
  (el.querySelector('.name') as HTMLElement).textContent = name;
  (el.querySelector('.cost') as HTMLElement).textContent = cost;
  attachDrag(el, key);
  canvas.appendChild(el);
  nodeEls.set(key, el);
}

// Re-aim every edge at its endpoints' current positions — cheap enough to
// run on every drag move with this node count.
function redrawEdges(): void {
  const svg = document.getElementById('edges');
  if (!svg) return;
  for (const path of svg.querySelectorAll<SVGPathElement>('path')) {
    const from = path.dataset.from;
    const to = path.dataset.to;
    if (from && to) path.setAttribute('d', edgePath({ from, to }));
  }
  for (const label of svg.querySelectorAll<SVGTextElement>('text.edge-label')) {
    const from = label.dataset.from;
    const to = label.dataset.to;
    if (!from || !to) continue;
    const mid = edgeMidpoint({ from, to });
    label.setAttribute('x', String(mid.x));
    label.setAttribute('y', String(mid.y - 5));
  }
  // The hit twins carry no dataset; rebuild is only needed on structural
  // change, and their stale d only affects click targets mid-drag. Re-render
  // on pointerup fixes them (see attachDrag).
}

function attachDrag(el: HTMLElement, key: string): void {
  el.addEventListener('pointerdown', (e: PointerEvent) => {
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    const startX = e.clientX, startY = e.clientY;
    const orig = { ...layoutOf(key) };
    let moved = false;
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (Math.hypot(dx, dy) > 3) moved = true;
      if (!moved) return;
      const p = layoutOf(key);
      p.x = Math.max(0, Math.round(orig.x + dx));
      p.y = Math.max(0, Math.round(orig.y + dy));
      el.style.left = `${p.x}px`;
      el.style.top = `${p.y}px`;
      redrawEdges();
    };
    const onUp = () => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      if (moved) { markDirty(); render(); }
      else handleNodeClick(key);
    };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
  });
}

function handleNodeClick(key: string): void {
  if (linkSource !== null) {
    // Link mode: a work node links to other work, an upgrade to other
    // upgrades — both with the same click-the-prerequisite flow.
    if (isTaskKey(linkSource)) {
      const srcId = taskId(linkSource);
      const src = taskDef(srcId)!;
      if (!isTaskKey(key) || key === linkSource) {
        setStatus('link cancelled — work prerequisites must be other work nodes', 'dirty');
      } else {
        const targetId = taskId(key);
        if (taskRequiresOf(src).includes(targetId)) {
          setStatus('already a prerequisite', 'dirty');
        } else if (taskWouldCycle(srcId, targetId)) {
          setStatus(`refused: ${nodeLabel(key)} → ${nodeLabel(linkSource)} would create a cycle`, 'error');
        } else {
          src.requires = [...taskRequiresOf(src), targetId];
          delete src.after;
          markDirty();
        }
      }
    } else if (isTaskKey(key) || key === linkSource) {
      setStatus('link cancelled — upgrade prerequisites must be other upgrade nodes', 'dirty');
    } else if (doc.upgrades[linkSource].requires.includes(key)) {
      setStatus('already a prerequisite', 'dirty');
    } else if (wouldCycle(linkSource, key)) {
      setStatus(`refused: ${upgradeName(key)} → ${upgradeName(linkSource)} would create a cycle`, 'error');
    } else {
      doc.upgrades[linkSource].requires.push(key);
      markDirty();
    }
    linkSource = null;
    render();
    return;
  }
  addingUpgrade = false;
  selected = selected === key ? null : key;
  refreshNodeClasses();
  renderSide();
}

function refreshNodeClasses(): void {
  const linkingTasks = linkSource !== null && isTaskKey(linkSource);
  for (const [key, el] of nodeEls) {
    el.classList.toggle('selected', key === selected);
    el.classList.toggle('link-target-ok',
      linkSource !== null && key !== linkSource && (isTaskKey(key) === linkingTasks));
  }
}

function removeEdge(e: Edge): void {
  if (!window.confirm(`Remove prerequisite "${nodeLabel(e.from)}" from "${nodeLabel(e.to)}"?`)) return;
  if (e.kind === 'chain') {
    const d = taskDef(taskId(e.to));
    if (d) d.requires = taskRequiresOf(d).filter((r) => r !== taskId(e.from));
    if (d) delete d.after;
  } else {
    const def = doc.upgrades[e.to];
    def.requires = def.requires.filter((r) => r !== e.from);
  }
  markDirty();
  render();
}

// ─── Inspector ───────────────────────────────────────────────────────

function renderSide(): void {
  renderInspector();
  renderDemonReward();
  renderReport();
}

function inspRow(label: string, control: HTMLElement): HTMLElement {
  const row = document.createElement('div');
  row.className = 'insp-row';
  const lab = document.createElement('label');
  lab.textContent = label;
  row.append(lab, control);
  return row;
}

function numberInput(value: number, min: number, onChange: (v: number) => void): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'number';
  input.min = String(min);
  input.value = String(value);
  input.addEventListener('change', () => onChange(Math.max(min, Math.floor(Number(input.value) || min))));
  return input;
}

function selectInput(value: string, options: { value: string; label: string }[], onChange: (v: string) => void): HTMLSelectElement {
  const sel = document.createElement('select');
  for (const o of options) {
    const opt = document.createElement('option');
    opt.value = o.value;
    opt.textContent = o.label;
    sel.appendChild(opt);
  }
  sel.value = value;
  sel.addEventListener('change', () => onChange(sel.value));
  return sel;
}

function renderInspector(): void {
  inspectorEl.innerHTML = '';
  if (addingUpgrade) {
    inspectorEl.classList.remove('muted');
    renderAddUpgradeForm();
    return;
  }
  inspectorEl.classList.toggle('muted', selected === null);
  if (selected === null) {
    inspectorEl.innerHTML = 'Click a node to edit it. Drag nodes to rearrange. Click a solid edge to delete it. <kbd>Ctrl+S</kbd> saves.';
    return;
  }
  if (isTaskKey(selected)) renderTaskInspector(taskId(selected));
  else renderUpgradeInspector(selected);
}

// "+ Add upgrade" picker: known ids (buildings + abilities) not yet in the
// tree — e.g. lightning, or anything previously deleted.
function renderAddUpgradeForm(): void {
  const missing = missingCatalogIds();
  if (missing.length === 0) {
    inspectorEl.className = 'muted';
    inspectorEl.textContent = 'Every known upgrade is already in the tree.';
    return;
  }
  const head = document.createElement('div');
  head.innerHTML = `<strong>Add upgrade node</strong><div class="muted" style="margin:4px 0 8px">Known upgrades not currently purchasable in the tree:</div>`;
  inspectorEl.appendChild(head);
  const sel = selectInput(missing[0], missing.map((id) => ({ value: id, label: upgradeName(id) })), () => { /* read on Add */ });
  inspectorEl.appendChild(inspRow('upgrade', sel));
  const btns = document.createElement('div');
  btns.className = 'btn-row';
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'primary';
  add.textContent = 'Add to tree';
  add.addEventListener('click', () => addUpgradeNode(sel.value));
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = 'cancel';
  cancel.addEventListener('click', () => { addingUpgrade = false; renderSide(); });
  btns.append(add, cancel);
  inspectorEl.appendChild(btns);
}

// The demon's parlay gift — swap lightning out for pips/resources/any
// upgrade (and optionally add lightning to the tree as a normal node).
function renderDemonReward(): void {
  demonRewardEl.innerHTML = '';
  const reward: DemonReward = doc.demonReward ?? { type: 'upgrade', id: 'lightning' };
  const set = (r: DemonReward) => { doc.demonReward = r; markDirty(); renderSide(); };

  const blurb = document.createElement('div');
  blurb.className = 'muted';
  blurb.style.marginBottom = '6px';
  blurb.textContent = 'What a truthful parlay (Bob + a dragon bone) grants:';
  demonRewardEl.appendChild(blurb);

  demonRewardEl.appendChild(inspRow('gift', selectInput(reward.type, [
    { value: 'upgrade', label: 'free upgrade' },
    { value: 'pips', label: 'pips ◉' },
    { value: 'money', label: 'money Ƶ' },
    { value: 'blood', label: 'blood' },
    { value: 'bones', label: 'dragon bones' },
  ], (v) => {
    if (v === 'upgrade') set({ type: 'upgrade', id: 'lightning' });
    else if (v === 'pips') set({ type: 'pips', amount: 3 });
    else if (v === 'money') set({ type: 'money', amount: 100000 });
    else if (v === 'blood') set({ type: 'blood', amount: 500 });
    else set({ type: 'bones', amount: 3 });
  })));

  if (reward.type === 'upgrade') {
    // Offer the full catalog plus any custom ids already in the tree; flag
    // the ones the player could otherwise buy with pips.
    const ids = [...new Set([...upgradeCatalogIds(), ...Object.keys(doc.upgrades)])];
    demonRewardEl.appendChild(inspRow('upgrade', selectInput(reward.id, ids.map((id) => ({
      value: id,
      label: upgradeName(id) + (id in doc.upgrades ? ' (in tree)' : ''),
    })), (v) => set({ type: 'upgrade', id: v }))));
    if (reward.id in doc.upgrades) {
      const warn = document.createElement('div');
      warn.className = 'rep-warn';
      warn.textContent = `"${upgradeName(reward.id)}" is also pip-purchasable — the gift is wasted on a player who already bought it.`;
      demonRewardEl.appendChild(warn);
    }
  } else {
    demonRewardEl.appendChild(inspRow('amount', numberInput(reward.amount, 1, (v) => set({ ...reward, amount: v }))));
  }
}

function renderTaskInspector(id: string): void {
  const d = taskDef(id);
  if (!d) { selected = null; renderInspector(); return; }
  const commit = () => { markDirty(); render(); };

  const head = document.createElement('div');
  head.innerHTML = `<strong></strong><div class="muted" style="margin:4px 0 8px"></div>`;
  (head.querySelector('strong') as HTMLElement).textContent = taskText(d);
  (head.querySelector('div') as HTMLElement).textContent =
    `${id} · ${d.optional ? 'optional work' : 'work'}${BUILTIN_TASK_IDS.has(id) ? ' · built-in' : ''}`;
  inspectorEl.appendChild(head);

  // Goal template: type + per-type params.
  inspectorEl.appendChild(inspRow('goal', selectInput(d.goal.type, [
    { value: 'place', label: 'place X buildings' },
    { value: 'build', label: 'build X buildings' },
    { value: 'run', label: 'run X buildings' },
    { value: 'kill', label: 'kill X creatures' },
    { value: 'earn_money', label: 'earn Ƶ amount' },
    { value: 'collect_bones', label: 'collect dragon bones' },
    { value: 'summon_minotaurs', label: 'summon minotaurs' },
  ], (v) => { d.goal = defaultGoal(v as TaskGoal['type'], d.goal); commit(); })));

  const g = d.goal;
  if (g.type === 'place' || g.type === 'build' || g.type === 'run') {
    inspectorEl.appendChild(inspRow('building', selectInput(g.building,
      BUILDABLE_KINDS.map((k) => ({ value: k, label: BUILDING_DEFS[k].name })),
      (v) => { g.building = v; commit(); })));
    inspectorEl.appendChild(inspRow('count', numberInput(g.count, 1, (v) => { g.count = v; commit(); })));
  } else if (g.type === 'kill') {
    inspectorEl.appendChild(inspRow('creature', selectInput(g.creature,
      CREATURES.map((c) => ({ value: c, label: c })),
      (v) => { g.creature = v as CreatureKind; commit(); })));
    inspectorEl.appendChild(inspRow('count', numberInput(g.count, 1, (v) => { g.count = v; commit(); })));
  } else if (g.type === 'earn_money' || g.type === 'collect_bones') {
    inspectorEl.appendChild(inspRow('amount', numberInput(g.amount, 1, (v) => { g.amount = v; commit(); })));
  } else {
    inspectorEl.appendChild(inspRow('count', numberInput(g.count, 1, (v) => { g.count = v; commit(); })));
  }

  // Custom label — blank uses the auto-generated goal text.
  const textInput = document.createElement('input');
  textInput.type = 'text';
  textInput.placeholder = goalText(d.goal);
  textInput.value = d.text ?? '';
  textInput.addEventListener('change', () => {
    if (textInput.value.trim() === '') delete d.text;
    else d.text = textInput.value;
    commit();
  });
  inspectorEl.appendChild(inspRow('label', textInput));

  inspectorEl.appendChild(inspRow('pays ◉', numberInput(d.pips, 0, (v) => { d.pips = v; commit(); })));

  // Optional flag — affects only how the task line renders, not gating.
  const optBox = document.createElement('input');
  optBox.type = 'checkbox';
  optBox.checked = d.optional ?? false;
  optBox.addEventListener('change', () => {
    if (optBox.checked) d.optional = true;
    else delete d.optional;
    commit();
  });
  inspectorEl.appendChild(inspRow('optional', optBox));

  // Prerequisite work — same chips + link flow as an upgrade's requires.
  const reqLabel = document.createElement('div');
  reqLabel.className = 'muted';
  reqLabel.style.margin = '8px 0 4px';
  reqLabel.textContent = 'requires work:';
  inspectorEl.appendChild(reqLabel);
  const reqs = taskRequiresOf(d);
  if (reqs.length === 0) {
    const none = document.createElement('span');
    none.className = 'muted';
    none.textContent = '(none — active from the start)';
    inspectorEl.appendChild(none);
  }
  for (const req of reqs) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    const nameSpan = document.createElement('span');
    nameSpan.textContent = nodeLabel(`task:${req}`);
    const x = document.createElement('button');
    x.type = 'button';
    x.textContent = '✕';
    x.title = 'remove prerequisite';
    x.addEventListener('click', () => {
      d.requires = taskRequiresOf(d).filter((r) => r !== req);
      delete d.after;
      commit();
    });
    chip.append(nameSpan, x);
    inspectorEl.appendChild(chip);
  }

  const btns = document.createElement('div');
  btns.className = 'btn-row';
  const linkBtn = document.createElement('button');
  linkBtn.type = 'button';
  linkBtn.textContent = '+ link prerequisite…';
  linkBtn.addEventListener('click', () => {
    linkSource = `task:${id}`;
    setStatus(`click the work that "${taskText(d)}" should require (Esc cancels)`, 'dirty');
    refreshNodeClasses();
  });
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'danger';
  del.textContent = 'delete';
  del.addEventListener('click', () => deleteWork(id));
  btns.append(linkBtn, del);
  inspectorEl.appendChild(btns);
}

function renderUpgradeInspector(id: string): void {
  const def = doc.upgrades[id];
  const head = document.createElement('div');
  head.innerHTML = `<strong></strong><div class="muted" style="margin:4px 0 8px"></div>`;
  (head.querySelector('strong') as HTMLElement).textContent = upgradeName(id);
  (head.querySelector('div') as HTMLElement).textContent = `${id} · ${upgradeSection(id)} menu`;
  inspectorEl.appendChild(head);

  inspectorEl.appendChild(inspRow('cost ◉', numberInput(def.cost, 0, (v) => {
    def.cost = v;
    markDirty();
    render();
  })));

  const reqLabel = document.createElement('div');
  reqLabel.className = 'muted';
  reqLabel.style.margin = '8px 0 4px';
  reqLabel.textContent = 'requires:';
  inspectorEl.appendChild(reqLabel);
  if (def.requires.length === 0) {
    const none = document.createElement('span');
    none.className = 'muted';
    none.textContent = '(root — always offered)';
    inspectorEl.appendChild(none);
  }
  for (const req of def.requires) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    const nameSpan = document.createElement('span');
    nameSpan.textContent = upgradeName(req);
    const x = document.createElement('button');
    x.type = 'button';
    x.textContent = '✕';
    x.title = 'remove prerequisite';
    x.addEventListener('click', () => {
      def.requires = def.requires.filter((r) => r !== req);
      markDirty();
      render();
    });
    chip.append(nameSpan, x);
    inspectorEl.appendChild(chip);
  }

  const btns = document.createElement('div');
  btns.className = 'btn-row';
  const linkBtn = document.createElement('button');
  linkBtn.type = 'button';
  linkBtn.textContent = '+ link prerequisite…';
  linkBtn.addEventListener('click', () => {
    linkSource = id;
    setStatus(`click the upgrade that "${upgradeName(id)}" should require (Esc cancels)`, 'dirty');
    refreshNodeClasses();
  });
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'danger';
  del.textContent = 'remove from tree';
  del.addEventListener('click', () => deleteUpgrade(id));
  btns.append(linkBtn, del);
  inspectorEl.appendChild(btns);
}

// ─── Balance report ──────────────────────────────────────────────────
// Best-case economy walk: tasks in array order (mandatory chain semantics),
// buying only each task's needs-closure as cheaply as possible. Optional
// tasks are taken when affordable. Shows where the chain goes pip-broke.
function renderReport(): void {
  reportEl.innerHTML = '';
  const lines: { cls: string; text: string }[] = [];

  // Cycle check across the requires graph: a node sits in a cycle when it's
  // reachable from one of its own prerequisites.
  for (const [id, def] of Object.entries(doc.upgrades)) {
    if (def.requires.some((r) => r in doc.upgrades && wouldCycle(id, r))) {
      lines.push({ cls: 'rep-bad', text: `cycle through "${upgradeName(id)}"` });
    }
  }
  // Dangling requires.
  for (const [id, def] of Object.entries(doc.upgrades)) {
    for (const r of def.requires) {
      if (!(r in doc.upgrades)) lines.push({ cls: 'rep-bad', text: `"${id}" requires unknown id "${r}"` });
    }
  }
  // Cycle check across the work DAG.
  for (const t of doc.tasks) {
    if (taskRequiresOf(t).some((r) => taskWouldCycle(t.id, r))) {
      lines.push({ cls: 'rep-bad', text: `work cycle through "${taskText(t)}"` });
    }
  }
  // Demon reward referencing an id the game doesn't know grants nothing.
  const reward = doc.demonReward ?? { type: 'upgrade', id: 'lightning' };
  if (reward.type === 'upgrade' && !upgradeCatalogIds().includes(reward.id) && !(reward.id in doc.upgrades)) {
    lines.push({ cls: 'rep-bad', text: `demon reward references unknown upgrade "${reward.id}"` });
  }
  // Duplicate task ids would make completion tracking ambiguous.
  const seenIds = new Set<string>();
  for (const t of doc.tasks) {
    if (seenIds.has(t.id)) lines.push({ cls: 'rep-bad', text: `duplicate task id "${t.id}"` });
    seenIds.add(t.id);
  }
  // Build/run goals targeting a building with no upgrade node are
  // uncompletable (the player can never unlock that building).
  for (const t of doc.tasks) {
    const g = t.goal;
    if ((g.type === 'place' || g.type === 'build' || g.type === 'run') && !(g.building in doc.upgrades)) {
      lines.push({ cls: 'rep-warn', text: `"${t.id}" targets "${g.building}", which has no upgrade node` });
    }
  }

  // Unknown work prerequisites can never complete.
  const knownTaskIds = new Set(doc.tasks.map((t) => t.id));
  for (const t of doc.tasks) {
    for (const r of taskRequiresOf(t)) {
      if (!knownTaskIds.has(r)) lines.push({ cls: 'rep-bad', text: `"${taskText(t)}" requires unknown work id "${r}"` });
    }
  }

  // Economy walk over the explicit work DAG: repeatedly complete any task
  // whose prereqs are done and whose needs-closure is affordable (so a task
  // short on pips can succeed later, after other branches pay out). Whatever
  // never completes gets reported with the reason.
  let pips = 0;
  const owned = new Set<string>();
  const done = new Set<string>();
  let progress = true;
  while (progress) {
    progress = false;
    for (const t of doc.tasks) {
      if (done.has(t.id)) continue;
      if (!taskRequiresOf(t).every((r) => done.has(r))) continue;
      const closure = closureCost(goalNeeds(t.goal), owned);
      if (closure === null || closure.cost > pips) continue; // may resolve later
      for (const b of closure.toBuy) owned.add(b);
      pips -= closure.cost;
      pips += t.pips;
      done.add(t.id);
      progress = true;
      const buyBit = closure.toBuy.length > 0 ? ` (buys ${closure.toBuy.map(upgradeName).join(', ')} for ${closure.cost} ◉)` : '';
      lines.push({ cls: 'rep-ok', text: `${taskText(t)}${buyBit} → +${t.pips} ◉, balance ${pips}` });
    }
  }
  for (const t of doc.tasks) {
    if (done.has(t.id)) continue;
    const label = taskText(t);
    if (!taskRequiresOf(t).every((r) => done.has(r))) {
      lines.push({ cls: t.optional ? 'rep-warn' : 'rep-bad', text: `"${label}" blocked: prerequisite work never completes` });
      continue;
    }
    const closure = closureCost(goalNeeds(t.goal), owned);
    if (closure === null) {
      lines.push({ cls: 'rep-bad', text: `"${label}" needs an unknown upgrade id` });
    } else {
      lines.push({
        cls: t.optional ? 'rep-warn' : 'rep-bad',
        text: `"${label}": short ${closure.cost - pips} ◉ for ${closure.toBuy.map(upgradeName).join(' + ')}`,
      });
    }
  }

  let totalCost = 0;
  for (const def of Object.values(doc.upgrades)) totalCost += def.cost;
  let totalPips = 0;
  for (const t of doc.tasks) totalPips += t.pips;
  lines.push({
    cls: totalPips >= totalCost ? 'rep-ok' : 'rep-warn',
    text: `totals: ${totalPips} ◉ earned vs ${totalCost} ◉ to buy everything (${totalPips - totalCost >= 0 ? '+' : ''}${totalPips - totalCost})`,
  });

  for (const l of lines) {
    const div = document.createElement('div');
    div.className = l.cls;
    div.textContent = l.text;
    reportEl.appendChild(div);
  }
}

void load();
