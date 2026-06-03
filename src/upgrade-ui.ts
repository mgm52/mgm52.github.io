import { playSound } from './audio';
import type { GameState } from './state';
import {
  UPGRADE_TREE, anyUpgradeAffordable, canPurchaseUpgrade, purchaseUpgrade,
  upgradeName, upgradeOwned, upgradePrereqsMet, upgradeSection,
} from './upgrade-tree';

// ─── In-game Upgrades overlay ────────────────────────────────────────
// The sidebar's "Upgrades ◉N" button opens a tech-tree screen rendering the
// upgrade DAG from upgrade-tree.json (same layout coordinates the dev editor
// arranges). Clicking an affordable node spends pips and the unlocked button
// surfaces in the Build / Summon / Ritual menus on the next refreshUI tick.

// Node footprint in layout coordinates — keep in sync with the .ut-node CSS
// and the dev editor's NODE_W/NODE_H so edges anchor to the same box.
const NODE_W = 148;
const NODE_H = 58;
const CANVAS_PAD = 48;

let setupDone = false;
let overlayOpen = false;
let gameState: GameState | null = null;
const nodeEls = new Map<string, HTMLButtonElement>();
const edgeEls: { from: string; to: string; el: SVGPathElement }[] = [];

// Upgrade-node ids only (layout also carries task:* entries for the editor).
function upgradeIds(): string[] {
  return Object.keys(UPGRADE_TREE.upgrades);
}

// The layout is shared with the dev editor, whose canvas reserves a top lane
// for task nodes the in-game overlay doesn't show. Normalise so the upgrade
// nodes hug the overlay's top-left instead of floating below an empty band.
let layoutOffset: { x: number; y: number } | null = null;

function nodePos(id: string): { x: number; y: number } {
  if (layoutOffset === null) {
    let minX = Infinity, minY = Infinity;
    for (const uid of upgradeIds()) {
      const p = UPGRADE_TREE.layout[uid];
      if (!p) continue;
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
    }
    layoutOffset = Number.isFinite(minX) ? { x: minX - 24, y: minY - 24 } : { x: 0, y: 0 };
  }
  const p = UPGRADE_TREE.layout[id] ?? { x: layoutOffset.x, y: layoutOffset.y };
  return { x: p.x - layoutOffset.x, y: p.y - layoutOffset.y };
}

export function setupUpgradeUI(state: GameState): void {
  if (setupDone) return;
  setupDone = true;
  gameState = state;

  const overlay = document.createElement('div');
  overlay.id = 'upgrade-overlay';
  overlay.hidden = true;
  overlay.innerHTML = `
    <div id="upgrade-card">
      <div id="upgrade-card-header">
        <span id="upgrade-card-title">Upgrades</span>
        <span id="upgrade-overlay-pips">◉ 0</span>
        <button id="upgrade-close" type="button" aria-label="Close">✕</button>
      </div>
      <div id="upgrade-hint">Complete <strong>Work</strong> to earn pips ◉ — spend them to unlock buildings, summons &amp; rituals.</div>
      <div id="upgrade-viewport"><div id="upgrade-canvas"></div></div>
    </div>
  `;
  document.body.appendChild(overlay);

  // Backdrop click closes; clicks inside the card don't bubble out to it.
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeUpgradeOverlay();
  });
  overlay.querySelector('#upgrade-close')!.addEventListener('click', () => closeUpgradeOverlay());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlayOpen) closeUpgradeOverlay();
  });

  // Build the canvas: sized to the layout's bounding box, SVG edge layer
  // underneath, one button per upgrade node on top.
  const canvas = overlay.querySelector('#upgrade-canvas') as HTMLElement;
  let maxX = 0, maxY = 0;
  for (const id of upgradeIds()) {
    const p = nodePos(id);
    maxX = Math.max(maxX, p.x + NODE_W);
    maxY = Math.max(maxY, p.y + NODE_H);
  }
  const w = maxX + CANVAS_PAD;
  const h = maxY + CANVAS_PAD;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.id = 'upgrade-edges';
  svg.setAttribute('width', String(w));
  svg.setAttribute('height', String(h));
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  canvas.appendChild(svg);

  for (const id of upgradeIds()) {
    for (const req of UPGRADE_TREE.upgrades[id].requires) {
      if (!(req in UPGRADE_TREE.upgrades)) continue;
      const a = nodePos(req);
      const b = nodePos(id);
      const x1 = a.x + NODE_W, y1 = a.y + NODE_H / 2;
      const x2 = b.x, y2 = b.y + NODE_H / 2;
      const mid = (x1 + x2) / 2;
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`);
      path.classList.add('ut-edge');
      svg.appendChild(path);
      edgeEls.push({ from: req, to: id, el: path });
    }
  }

  const sectionLabel: Record<string, string> = { build: 'Build', summon: 'Summon', ritual: 'Ritual' };
  for (const id of upgradeIds()) {
    const p = nodePos(id);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ut-node';
    btn.dataset.upgradeId = id;
    btn.style.left = `${p.x}px`;
    btn.style.top = `${p.y}px`;
    btn.innerHTML = `
      <span class="ut-node-section">${sectionLabel[upgradeSection(id)]}</span>
      <span class="ut-node-name">${upgradeName(id)}</span>
      <span class="ut-node-cost"></span>
    `;
    btn.addEventListener('click', () => onNodeClick(id));
    canvas.appendChild(btn);
    nodeEls.set(id, btn);
  }

  document.getElementById('btn-open-upgrades')?.addEventListener('click', () => {
    playSound('click', 1, 0.75);
    openUpgradeOverlay();
  });
}

function onNodeClick(id: string): void {
  const state = gameState;
  if (!state) return;
  if (!purchaseUpgrade(state, id)) {
    playSound('error');
    return;
  }
  playSound('ritual', 0.9, 0.7);
  const btn = nodeEls.get(id);
  if (btn) {
    btn.classList.remove('ut-just-bought');
    void btn.offsetWidth; // restart the pop animation on rapid re-buys
    btn.classList.add('ut-just-bought');
  }
  refreshOverlay(state);
}

function openUpgradeOverlay(): void {
  const overlay = document.getElementById('upgrade-overlay');
  if (!overlay || !gameState) return;
  overlayOpen = true;
  overlay.hidden = false;
  refreshOverlay(gameState);
  // Centre the viewport on the cheapest currently-buyable node (or the first
  // owned one) so the player lands looking at something actionable.
  const viewport = document.getElementById('upgrade-viewport')!;
  let focus: string | null = null;
  let focusCost = Infinity;
  for (const id of upgradeIds()) {
    if (canPurchaseUpgrade(gameState, id) && UPGRADE_TREE.upgrades[id].cost < focusCost) {
      focus = id;
      focusCost = UPGRADE_TREE.upgrades[id].cost;
    }
  }
  const p = focus ? nodePos(focus) : { x: 0, y: 0 };
  viewport.scrollLeft = Math.max(0, p.x + NODE_W / 2 - viewport.clientWidth / 2);
  viewport.scrollTop = Math.max(0, p.y + NODE_H / 2 - viewport.clientHeight / 2);
}

function closeUpgradeOverlay(): void {
  overlayOpen = false;
  const overlay = document.getElementById('upgrade-overlay');
  if (overlay) overlay.hidden = true;
}

function refreshOverlay(state: GameState): void {
  const pipsEl = document.getElementById('upgrade-overlay-pips');
  if (pipsEl) pipsEl.textContent = `◉ ${state.pips}`;
  for (const [id, btn] of nodeEls) {
    const owned = upgradeOwned(state, id);
    const reachable = upgradePrereqsMet(state, id);
    const affordable = canPurchaseUpgrade(state, id);
    btn.classList.toggle('owned', owned);
    btn.classList.toggle('can-buy', affordable);
    btn.classList.toggle('locked', !owned && !reachable);
    btn.disabled = !affordable;
    const costEl = btn.querySelector('.ut-node-cost')!;
    costEl.textContent = owned ? '✓ owned' : `◉ ${UPGRADE_TREE.upgrades[id].cost}`;
  }
  for (const { from, el } of edgeEls) {
    el.classList.toggle('lit', upgradeOwned(state, from));
  }
}

// Called from refreshUI every frame: keeps the sidebar button's pip count,
// attention-flash and (when open) the overlay itself in sync.
export function refreshUpgradeUI(state: GameState): void {
  if (!setupDone) return;
  gameState = state;
  const countEl = document.getElementById('upgrade-pip-count');
  if (countEl) {
    countEl.textContent = `◉ ${state.pips}`;
    countEl.classList.toggle('met', state.pips > 0);
  }
  const openBtn = document.getElementById('btn-open-upgrades');
  // Flash for attention while something in the tree is buyable (mirrors the
  // build buttons' "affordable and never bought" flash).
  openBtn?.classList.toggle('buy-flash', !overlayOpen && anyUpgradeAffordable(state));
  if (overlayOpen) refreshOverlay(state);
}
