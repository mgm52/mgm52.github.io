// ─── The trading-card realm ──────────────────────────────────────────
// The game's final section, picking up after the finale's screen has torn
// itself white. Every game world is now a trading card: three stacked
// preview panes (space / earth / hell), the world's resources, and a
// REENTER WORLD button. The player's own pre-Gabbonsaw save is dealt onto
// the table first — and promptly swindled away by an ethereal white goblin,
// who leaves a pitiful replacement ("now it's a trade."). From there the
// player can re-enter any card they hold (the world boots demonless, Bob-
// and Lolly-less, with a white border and a LEAVE WORLD button), and visit
// tier-gated trade gatherings to swap worlds with other ethereal creatures.
//
// Architecture: entering a card world swaps the card's serialized GameState
// into the regular save slot (the outer post-finale save is stashed verbatim)
// and reloads the page, so the entire existing boot pipeline does the heavy
// lifting. Leaving serializes the live world back onto its card and restores
// the stash. The realm itself is pure DOM, mounted above the finale's
// white-out (#finale-white) once the cinematic holds on 'shattered'.
//
// All the data rules (tiers, ascension demands, trade rules, world
// generation) live DOM-free in cards-core.ts, where the unit tests can
// reach them; this file is the presentation + persistence half.

import { playSound, type SoundName } from './audio';
import { BUILDING_DEFS, CELL, HELL, SPACE, WORLD } from './config';
import { getRawSave, saveGame, setRawSave } from './save';
import { GameState, computePlayBounds, isInPlayCell } from './state';
import { ALL_TASK_IDS } from './ui';
import {
  APPETITE_LINE, CardMeta, CardTier, Creature, TIER_ABOVE, TIER_RANK, TradeEvent,
  UpgradeReq, WorldCard, appetiteAccepts, ascendCard, breakdownGives, creatureTakesFor,
  decodeWorld, encodeWorld, generateEvents, makeCard, mulberry32, regenerateEvent,
  reqMet, rollUpgradeReq, sameTierGives,
} from './cards-core';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Every sound in the realm rides the ghostly reverb bus (audio.ts: lowpass +
// cavern convolver, the hell cries' treatment) at a slightly slowed rate —
// the in-between reads as one big, soft, far-away room.
function realmSound(name: SoundName, volume = 1, rate = 1): void {
  playSound(name, volume, rate * 0.8, true);
}

// Every generated world stamps the full task list as completed (no tutorial
// replays inside cards); bind the core's generators to ui.ts's id list once.
const newCard = (meta: CardMeta, tier: CardTier, rng: () => number, junk = false): WorldCard =>
  makeCard(meta, tier, rng, ALL_TASK_IDS, junk);

// ─── Persistence ─────────────────────────────────────────────────────
// Three keys beside the regular save slot:
//  - META_KEY:   the metagame itself (player cards, events, active card).
//  - ORIGIN_KEY: one-shot snapshot of the world taken the instant the Pain
//    Gabbonsaw was bought — becomes the first card dealt onto the table.
//  - OUTER_KEY:  verbatim stash of the post-finale save while the player is
//    inside a card world (the main slot holds the card world meanwhile).
const META_KEY = 'rts.cards.v1';
const ORIGIN_KEY = 'rts.cardorigin.v1';
const OUTER_KEY = 'rts.cardouter.v1';

function loadMeta(): CardMeta | null {
  try {
    const raw = localStorage.getItem(META_KEY);
    if (!raw) return null;
    const m = JSON.parse(raw) as CardMeta;
    if (!m || m.v !== 1 || !Array.isArray(m.cards)) return null;
    return m;
  } catch { return null; }
}

function saveMeta(meta: CardMeta): void {
  try { localStorage.setItem(META_KEY, JSON.stringify(meta)); } catch { /* storage full — skip */ }
}

export function hasCardMeta(): boolean { return loadMeta() !== null; }

// Set just before the enter-/leave-world reloads so the next boot knows it's
// an explicit transition (skip the title screen) rather than a cold load.
// The module flag guards the gap between writing the destination save and
// the reload actually landing: main.ts's pagehide/visibility flushes would
// otherwise clobber the freshly-written slot with the departing world.
const HOP_KEY = 'rts.cardhop';
let hopInProgress = false;
export function isCardHopInProgress(): boolean { return hopInProgress; }
function markCardHop(): void {
  hopInProgress = true;
  try { sessionStorage.setItem(HOP_KEY, '1'); } catch { /* no-op */ }
}
export function consumeCardHop(): boolean {
  try {
    const hop = sessionStorage.getItem(HOP_KEY) === '1';
    sessionStorage.removeItem(HOP_KEY);
    return hop;
  } catch { return false; }
}

export function cardWorldActive(): boolean {
  const m = loadMeta();
  return m !== null && m.activeCardId !== null;
}

// Wipe the whole metagame — wired into the title screen's Erase Data.
export function clearCardData(): void {
  try {
    localStorage.removeItem(META_KEY);
    localStorage.removeItem(ORIGIN_KEY);
    localStorage.removeItem(OUTER_KEY);
  } catch { /* no-op */ }
}

// One-shot snapshot taken the instant the Pain Gabbonsaw ritual is bought
// (before the bones are even spent) — "the state just before the player
// bought the pain upgrades that triggered the whole finale sequence."
// Synchronous on purpose: it's a single momentous click, and the cutscene
// that follows hides the hitch.
export function captureOriginWorld(state: GameState): void {
  try {
    const payload = {
      data: encodeWorld(state),
      resources: { money: state.money, blood: state.blood, dragonBone: state.dragonBone },
    };
    localStorage.setItem(ORIGIN_KEY, JSON.stringify(payload));
  } catch { /* storage full — the realm falls back to a generated origin */ }
}

// The player's pre-finale save as a card. Falls back to a generated rare
// world when the snapshot is missing (dev sessions that skipped the ritual).
function buildOriginCard(meta: CardMeta, rng: () => number): WorldCard {
  try {
    const raw = localStorage.getItem(ORIGIN_KEY);
    if (raw) {
      const payload = JSON.parse(raw) as { data: string; resources: WorldCard['resources'] };
      if (payload?.data && payload.resources) {
        return {
          id: meta.nextId++,
          name: 'your world',
          tier: 'rare',
          data: payload.data,
          resources: payload.resources,
          upgradeReq: null,
          origin: true,
        };
      }
    }
  } catch { /* fall through to the generated stand-in */ }
  const card = newCard(meta, 'rare', rng);
  card.name = 'your world';
  card.origin = true;
  card.upgradeReq = null;
  return card;
}

// ─── Entering / leaving a card world ─────────────────────────────────

function enterWorld(meta: CardMeta, card: WorldCard): void {
  const st = decodeWorld(card.data);
  if (!st) { realmSound('error'); return; }
  // Stash the outer post-finale save verbatim, then write the card's world
  // into the slot. Only once the slot has verifiably changed does the meta
  // mark us inside the card — if the write silently failed (storage full),
  // booting "into" the card would actually boot the outer world and the
  // next LEAVE WORLD would overwrite this card with it.
  const outer = getRawSave();
  if (outer) {
    try { localStorage.setItem(OUTER_KEY, outer); } catch { /* skip */ }
  }
  saveGame(st);
  const written = getRawSave();
  if (written === null || written === outer) { realmSound('error'); return; }
  meta.activeCardId = card.id;
  saveMeta(meta);
  realmSound('ritual', 1, 0.7);
  markCardHop();
  location.reload();
}

function leaveWorld(state: GameState): void {
  const meta = loadMeta();
  if (!meta || meta.activeCardId === null) return;
  const card = meta.cards.find((c) => c.id === meta.activeCardId);
  if (card) {
    // The card remembers everything the player just did inside it.
    card.data = encodeWorld(state);
    card.resources = { money: state.money, blood: state.blood, dragonBone: state.dragonBone };
  }
  meta.activeCardId = null;
  saveMeta(meta);
  const outer = localStorage.getItem(OUTER_KEY);
  if (outer) {
    setRawSave(outer);
    try { localStorage.removeItem(OUTER_KEY); } catch { /* no-op */ }
  }
  markCardHop();
  location.reload();
}

// Boot fallback: the metagame says we're inside a card but the save slot is
// unreadable. Restore the outer save (if stashed) and clear the active card
// so the player lands back on the table instead of a broken world.
export function abandonCardWorldBoot(): void {
  const meta = loadMeta();
  if (meta) { meta.activeCardId = null; saveMeta(meta); }
  const outer = localStorage.getItem(OUTER_KEY);
  if (outer) {
    setRawSave(outer);
    try { localStorage.removeItem(OUTER_KEY); } catch { /* no-op */ }
  }
}

// Inside a card world: the white screen border (body.card-world) and the big
// white LEAVE WORLD button pinned to the bottom of the screen.
export function setupCardWorldChrome(state: GameState): void {
  document.body.classList.add('card-world');
  const btn = document.getElementById('leave-world-btn') as HTMLButtonElement | null;
  if (!btn) return;
  btn.style.display = '';
  btn.addEventListener('click', () => {
    btn.disabled = true;
    realmSound('ritual', 1, 0.7);
    leaveWorld(state);
  }, { once: true });
}

// ─── Card previews ───────────────────────────────────────────────────
// Three stacked minimap panes painted from the card's decoded state: space
// on top, earth in the middle, hell at the bottom — the world as a column.

const decodedCache = new Map<number, { data: string; st: GameState | null }>();
function decodedWorld(card: WorldCard): GameState | null {
  const hit = decodedCache.get(card.id);
  if (hit && hit.data === card.data) return hit.st;
  const st = decodeWorld(card.data);
  decodedCache.set(card.id, { data: card.data, st });
  return st;
}

function hexColor(n: number): string { return `#${n.toString(16).padStart(6, '0')}`; }

function drawSpacePreview(cv: HTMLCanvasElement, st: GameState, seed: number): void {
  const g = cv.getContext('2d');
  if (!g) return;
  const w = cv.width, h = cv.height;
  g.fillStyle = '#05040f';
  g.fillRect(0, 0, w, h);
  const rng = mulberry32(seed);
  for (let i = 0; i < 36; i++) {
    g.globalAlpha = 0.3 + rng() * 0.7;
    g.fillStyle = '#cfd4e8';
    g.fillRect(Math.floor(rng() * w), Math.floor(rng() * h), 1, 1);
  }
  g.globalAlpha = 1;
  for (const sb of st.spaceBuildings.values()) {
    const x = (sb.pos.x / SPACE.width) * w;
    const y = (sb.pos.y / SPACE.height) * h;
    g.fillStyle = sb.building.kind === 'orbital_platform' ? '#6f7480' : hexColor(BUILDING_DEFS[sb.building.kind].colors.active);
    g.fillRect(x - 2, y - 2, 5, 4);
  }
  for (const su of st.spaceUnits.values()) {
    g.fillStyle = su.robot ? '#b9c0c9' : '#7fd183';
    g.fillRect((su.pos.x / SPACE.width) * w, (su.pos.y / SPACE.height) * h, 2, 2);
  }
}

function drawEarthPreview(cv: HTMLCanvasElement, st: GameState): void {
  const g = cv.getContext('2d');
  if (!g) return;
  const w = cv.width, h = cv.height;
  g.fillStyle = '#15130e';
  g.fillRect(0, 0, w, h);
  const b = computePlayBounds(st);
  const bw = b.x1 - b.x0, bh = b.y1 - b.y0;
  const s = Math.min(w / (bw + 2), h / (bh + 2));
  const ox = (w - bw * s) / 2, oy = (h - bh * s) / 2;
  const px = (cx: number) => ox + (cx - b.x0) * s;
  const py = (cy: number) => oy + (cy - b.y0) * s;
  // Ground cells.
  g.fillStyle = '#2e4630';
  for (let cy = b.y0; cy < b.y1; cy++) {
    for (let cx = b.x0; cx < b.x1; cx++) {
      if (isInPlayCell(st, cx, cy)) g.fillRect(px(cx), py(cy), s + 0.5, s + 0.5);
    }
  }
  // Water.
  g.fillStyle = '#2e5f8a';
  for (const ws of st.waterSources.values()) {
    g.fillRect(px(ws.x0), py(ws.y0), (ws.x1 - ws.x0) * s, (ws.y1 - ws.y0) * s);
  }
  // The spawning hole.
  if (!st.holeDestroyed) {
    g.fillStyle = '#0c0c0c';
    g.beginPath();
    g.arc(px(st.hole.cell.cx + 0.5), py(st.hole.cell.cy + 0.5), Math.max(1.2, s * 0.7), 0, Math.PI * 2);
    g.fill();
  }
  // Buildings in their def colors.
  for (const bd of st.buildings.values()) {
    const def = BUILDING_DEFS[bd.kind];
    g.fillStyle = hexColor(bd.state === 'active' ? def.colors.active : def.colors.dormant);
    g.fillRect(px(bd.cell.cx), py(bd.cell.cy), Math.max(1, def.cellSize * s), Math.max(1, def.cellSize * s));
  }
  // Units as dots.
  for (const gob of st.goblins.values()) {
    g.fillStyle = gob.robot ? '#b9c0c9' : gob.gold ? '#ffd96b' : '#7fd183';
    g.fillRect(px(gob.cell.cx), py(gob.cell.cy), Math.max(1, s * 0.6), Math.max(1, s * 0.6));
  }
}

function drawHellPreview(cv: HTMLCanvasElement, st: GameState, seed: number): void {
  const g = cv.getContext('2d');
  if (!g) return;
  const w = cv.width, h = cv.height;
  g.fillStyle = hexColor(HELL.bgColor);
  g.fillRect(0, 0, w, h);
  const grad = g.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, 'rgba(74, 10, 14, 0)');
  grad.addColorStop(1, 'rgba(74, 10, 14, 0.55)');
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
  // Portal beams, dropped at each portal's relative overworld x.
  g.fillStyle = hexColor(HELL.lineColor);
  for (const bd of st.buildings.values()) {
    if (bd.kind !== 'hell_portal' || bd.state === 'constructing') continue;
    const x = ((bd.cell.cx * CELL) / WORLD.width) * w;
    g.globalAlpha = 0.8;
    g.fillRect(x, 0, 1, h);
  }
  g.globalAlpha = 1;
  // Drifting ghosts.
  const rng = mulberry32(seed ^ 0x9e3779b9);
  for (const gh of st.ghosts) {
    const x = (gh.x / WORLD.width) * w;
    const y = 2 + rng() * (h - 4);
    g.globalAlpha = 0.55 + rng() * 0.35;
    g.fillStyle = gh.gold ? '#ffd96b' : '#cfd5e6';
    g.fillRect(x, y, gh.kind === 'dragon' ? 3 : 2, 2);
  }
  g.globalAlpha = 1;
  // Lit candles.
  g.fillStyle = '#ff9a3d';
  for (const c of st.soulChairs) {
    g.fillRect((c.hx / HELL.width) * w, (c.hy / HELL.height) * h, 2, 2);
  }
}

// ─── Card DOM ────────────────────────────────────────────────────────

function fmtResources(r: WorldCard['resources']): string {
  const parts = [`Ƶ ${Math.floor(r.money).toLocaleString('en-US')}`];
  if (r.blood > 0) parts.push(`${Math.floor(r.blood).toLocaleString('en-US')} blood`);
  if (r.dragonBone > 0) parts.push(`${Math.floor(r.dragonBone).toLocaleString('en-US')} bones`);
  return parts.join(' · ');
}

function fmtReqAmount(r: UpgradeReq): string {
  const amt = r.amount.toLocaleString('en-US');
  return r.res === 'money' ? `Ƶ ${amt}` : r.res === 'blood' ? `${amt} blood` : `${amt} bones`;
}

type CardElOpts = {
  big?: boolean;
  enterLabel?: string;       // when set, the card carries an enter button
  onEnter?: () => void;
  onClick?: () => void;      // whole-card click (trade views)
  onAscend?: () => void;     // table view: shown once the ascension demand is met
};

function buildCardEl(card: WorldCard, opts: CardElOpts = {}): HTMLElement {
  const root = document.createElement('div');
  root.className = `world-card t-${card.tier}${opts.big ? ' big' : ''}${card.origin ? ' origin' : ''}`;
  const head = document.createElement('div');
  head.className = 'wc-head';
  head.innerHTML = `<span class="wc-name"></span><span class="wc-tier">${card.tier}</span>`;
  (head.querySelector('.wc-name') as HTMLElement).textContent = card.name;
  root.appendChild(head);

  const st = decodedWorld(card);
  const panes = document.createElement('div');
  panes.className = 'wc-prevs';
  const mkCanvas = (cls: string, hgt: number): HTMLCanvasElement => {
    const cv = document.createElement('canvas');
    cv.className = `wc-prev ${cls}`;
    cv.width = 168;
    cv.height = hgt;
    panes.appendChild(cv);
    return cv;
  };
  const cvSpace = mkCanvas('wc-space', 34);
  const cvEarth = mkCanvas('wc-earth', 84);
  const cvHell = mkCanvas('wc-hell', 34);
  if (st) {
    drawSpacePreview(cvSpace, st, card.id * 7919 + 17);
    drawEarthPreview(cvEarth, st);
    drawHellPreview(cvHell, st, card.id * 7919 + 17);
  }
  root.appendChild(panes);

  const res = document.createElement('div');
  res.className = 'wc-res';
  res.textContent = fmtResources(card.resources);
  root.appendChild(res);

  // Ascension demand, printed on every card that still has a tier above it.
  if (card.upgradeReq) {
    const met = reqMet(card);
    const req = document.createElement('div');
    req.className = `wc-req${met ? ' met' : ''}`;
    req.textContent = `ascends at ${fmtReqAmount(card.upgradeReq)}`;
    root.appendChild(req);
    if (met && opts.onAscend) {
      const up = document.createElement('button');
      up.type = 'button';
      up.className = 'wc-ascend';
      up.textContent = `ASCEND — ${TIER_ABOVE[card.tier] ?? ''}`;
      up.addEventListener('click', (e) => { e.stopPropagation(); opts.onAscend?.(); });
      root.appendChild(up);
    }
  }

  if (opts.enterLabel) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'wc-enter';
    btn.textContent = opts.enterLabel;
    btn.addEventListener('click', (e) => { e.stopPropagation(); opts.onEnter?.(); });
    root.appendChild(btn);
  }
  if (opts.onClick) {
    root.classList.add('clickable');
    root.addEventListener('click', () => opts.onClick?.());
  }
  return root;
}

// ─── Realm dialogue machinery ────────────────────────────────────────
// A lighter cousin of intro.ts's typed dialogue: lines type into
// #card-speech, the click wall arms once a line completes, and YES/NO
// rides #card-choice. No pause integration — the world behind is over.

const TYPE_MS = 45;

function realmEl(id: string): HTMLElement { return document.getElementById(id)!; }

async function typeLine(text: string): Promise<void> {
  const speech = realmEl('card-speech');
  speech.classList.remove('done');
  speech.textContent = '';
  realmEl('card-realm').classList.add('speaking');
  let rendered = '';
  for (const ch of text) {
    rendered += ch;
    speech.textContent = rendered;
    await sleep(TYPE_MS);
  }
  speech.classList.add('done');
}

function waitForClick(target: HTMLElement): Promise<void> {
  return new Promise((resolve) => target.addEventListener('click', () => resolve(), { once: true }));
}

async function say(text: string): Promise<void> {
  const realm = realmEl('card-realm');
  const wall = realmEl('card-clickwall');
  await typeLine(text);
  await sleep(200);
  realm.classList.add('click-armed');
  await waitForClick(wall);
  realmSound('click', 0.29, 0.9);
  realm.classList.remove('click-armed');
}

// A beat that auto-advances (the ". . ." cadence).
async function sayBeat(text: string, holdMs = 1400): Promise<void> {
  await typeLine(text);
  await sleep(holdMs);
}

async function choose(labels: [string, string]): Promise<number> {
  const realm = realmEl('card-realm');
  const yes = realmEl('card-yes') as HTMLButtonElement;
  const no = realmEl('card-no') as HTMLButtonElement;
  (yes.querySelector('.build-name') as HTMLElement).textContent = labels[0];
  (no.querySelector('.build-name') as HTMLElement).textContent = labels[1];
  realm.classList.add('show-choice');
  const picked = await new Promise<number>((resolve) => {
    const h0 = () => { cleanup(); resolve(0); };
    const h1 = () => { cleanup(); resolve(1); };
    const cleanup = () => {
      yes.removeEventListener('click', h0);
      no.removeEventListener('click', h1);
    };
    yes.addEventListener('click', h0);
    no.addEventListener('click', h1);
  });
  realmSound('click', 0.8, 1);
  realm.classList.remove('show-choice');
  await sleep(200);
  return picked;
}

function clearSpeech(): void {
  realmEl('card-realm').classList.remove('speaking');
}

async function goblinIn(): Promise<void> {
  realmEl('card-realm').classList.add('goblin-in');
  await sleep(1900);
}

async function goblinOut(): Promise<void> {
  realmEl('card-realm').classList.remove('goblin-in');
  await sleep(1900);
}

// Soft cross-fade between realm views (table ↔ gathering ↔ trade). The
// builder resets #card-stage's className, which drops .waiting and lets the
// opacity transition carry the new view in.
let stageBusy = false;
function swapView(build: () => void): void {
  const stage = realmEl('card-stage');
  if (stageBusy) { build(); return; }
  stageBusy = true;
  stage.classList.add('waiting');
  window.setTimeout(() => {
    build();
    stageBusy = false;
  }, 260);
}

// ─── The realm itself ────────────────────────────────────────────────

let realmStarted = false;

// Idempotent — called every frame the finale holds on 'shattered' (and by
// the dev ?cardrealm shortcut). The realm waits out its own quiet beat on
// white before the first card drops.
export function maybeStartCardRealm(): void {
  if (realmStarted) return;
  realmStarted = true;
  void runRealm();
}

// Dev re-trigger support (resetFinaleGuards): hide the realm so the replayed
// cinematic isn't covered by it.
export function resetCardRealm(): void {
  realmStarted = false;
  const realm = document.getElementById('card-realm');
  if (realm) {
    realm.classList.remove('visible', 'goblin-in', 'speaking', 'click-armed', 'show-choice');
    const stage = document.getElementById('card-stage');
    if (stage) stage.innerHTML = '';
  }
}

async function runRealm(): Promise<void> {
  const realm = document.getElementById('card-realm');
  if (!realm) return;
  let meta = loadMeta();
  // Held on white a couple of seconds before anything appears — longer for
  // the very first arrival, shorter when returning from a card world.
  await sleep(meta && meta.phase === 'free' ? 1200 : 2600);
  realm.classList.add('visible');
  if (!meta) {
    meta = { v: 1, phase: 'intro', nextId: 1, cards: [], events: null, activeCardId: null };
    const rng = mulberry32(Date.now() >>> 0);
    meta.cards = [buildOriginCard(meta, rng)];
    saveMeta(meta);
  }
  if (meta.phase === 'intro') {
    await runTradeIntro(meta);
  }
  showTable(meta);
}

// The forced first trade: the origin card is dealt, the player reaches for
// REENTER WORLD, and the white goblin descends to take it.
async function runTradeIntro(meta: CardMeta): Promise<void> {
  const stage = realmEl('card-stage');
  stage.innerHTML = '';
  stage.className = 'intro-view';

  const origin = meta.cards[0];
  await sleep(500);
  const reentered = new Promise<void>((resolve) => {
    const cardEl = buildCardEl(origin, {
      big: true,
      enterLabel: 'REENTER WORLD',
      onEnter: () => resolve(),
    });
    cardEl.classList.add('deal-from-top');
    stage.appendChild(cardEl);
    // Two frames so the dealt-in transform commits before it transitions out.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        cardEl.classList.remove('deal-from-top');
        realmSound('place', 1.2, 0.9);
      });
    });
  });
  await reentered;

  // The player went for the button — the goblin objects.
  realmSound('online', 0.5, 0.6);
  await typeLine('wait a moment!');
  await goblinIn();
  await say('nice world.');
  await say('i like your world.');
  await sayBeat('. . .');
  await typeLine('have you traded a world before?');
  const picked = await choose(['YES', 'NO']);
  if (picked === 0) {
    await say('no you have not.');
    await say('that makes you a liar.');
    await say('and liars cannot own things. everyone knows this.');
  } else {
    await say('good.');
    await say('then you would not know how to stop me from doing this.');
  }

  // The taking: the origin card flies up into the goblin.
  clearSpeech();
  const cardEl = stage.querySelector('.world-card');
  cardEl?.classList.add('taken');
  realmSound('select', 0.9, 0.6);
  await sleep(1000);
  cardEl?.remove();

  // The giving: a pitiful replacement drops onto the table (its ascension
  // demand is pinned to plain cash — see makeCard's junk path).
  const rng = mulberry32((Date.now() ^ 0x5f356495) >>> 0);
  const junk = newCard(meta, 'common', rng, true);
  const junkEl = buildCardEl(junk, { big: true });
  junkEl.classList.add('deal-from-top');
  stage.appendChild(junkEl);
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      junkEl.classList.remove('deal-from-top');
      realmSound('place', 1.2, 0.7);
    });
  });
  await sleep(900);
  await say("now it's a trade.");
  clearSpeech();
  await goblinOut();

  // The books: origin gone (seeded into gathering III), junk card in hand.
  meta.cards = [junk];
  meta.events = generateEvents(meta, origin, ALL_TASK_IDS);
  meta.phase = 'free';
  saveMeta(meta);
  await sleep(400);
}

// ─── Table / gathering / trade views ─────────────────────────────────

function div(cls: string, text?: string): HTMLElement {
  const d = document.createElement('div');
  d.className = cls;
  if (text !== undefined) d.textContent = text;
  return d;
}

function showTable(meta: CardMeta): void {
  const stage = realmEl('card-stage');
  clearSpeech();
  stage.innerHTML = '';
  stage.className = 'table-view';

  stage.appendChild(div('ct-caption', meta.cards.length === 1 ? 'your world' : 'your worlds'));
  const row = div('ct-cards');
  for (const c of meta.cards) {
    row.appendChild(buildCardEl(c, {
      enterLabel: 'REENTER WORLD',
      onEnter: () => enterWorld(meta, c),
      onAscend: () => {
        ascendCard(meta, c);
        saveMeta(meta);
        realmSound('task_complete', 0.8, 1.1);
        showTable(meta);
        // Re-rendered fresh — flash the ascended card in its new colors.
        const cards = [...stage.querySelectorAll('.ct-cards .world-card')];
        const idx = meta.cards.indexOf(c);
        cards[idx]?.classList.add('ascended');
      },
    }));
  }
  stage.appendChild(row);

  if (!meta.events) {
    meta.events = generateEvents(meta, null, ALL_TASK_IDS);
    saveMeta(meta);
  }
  stage.appendChild(div('ct-caption', 'gatherings'));
  const evRow = div('ct-events');
  for (const ev of meta.events) {
    // A gathering opens its doors to someone holding a card of its tier
    // (1:1 trades) — or one tier above it (breakable into two of the tier).
    const locked = !meta.cards.some((c) =>
      c.tier === ev.tier || TIER_RANK[c.tier] === TIER_RANK[ev.tier] + 1);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `ct-event${locked ? ' locked' : ''}`;
    const sub = locked
      ? 'you hold nothing to trade here'
      : `trades ${ev.tier} worlds · ${ev.creatures.length} creatures attending`;
    btn.innerHTML = `<span class="ct-event-name"></span><span class="ct-event-sub">${sub}</span>`;
    (btn.querySelector('.ct-event-name') as HTMLElement).textContent = ev.name;
    btn.addEventListener('click', () => {
      if (locked) {
        realmSound('error', 0.7);
        btn.classList.remove('shake');
        void btn.offsetWidth;
        btn.classList.add('shake');
        return;
      }
      realmSound('click', 0.8, 1);
      swapView(() => showEvent(meta, ev));
    });
    evRow.appendChild(btn);
  }
  stage.appendChild(evRow);
}

function backButton(label: string, onBack: () => void): HTMLElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ct-back';
  btn.textContent = label;
  btn.addEventListener('click', () => { realmSound('click', 0.8, 1); onBack(); });
  return btn;
}

function creatureAvatar(): HTMLElement {
  return div('ct-creature-sprite');
}

function showEvent(meta: CardMeta, ev: TradeEvent): void {
  const stage = realmEl('card-stage');
  clearSpeech();
  stage.innerHTML = '';
  stage.className = 'event-view';
  stage.appendChild(backButton('← leave gathering', () => swapView(() => showTable(meta))));
  stage.appendChild(div('ct-caption ct-event-title', ev.name));
  const row = div('ct-creatures');
  for (const cr of ev.creatures) {
    const cel = div('ct-creature');
    cel.appendChild(creatureAvatar());
    cel.appendChild(div('ct-creature-name', cr.name));
    cel.appendChild(div('ct-creature-line', APPETITE_LINE[cr.appetite]));
    cel.appendChild(div('ct-creature-deck', `${cr.deck.length} worlds in hand`));
    cel.addEventListener('click', () => { realmSound('click', 0.8, 1); swapView(() => showTrade(meta, ev, cr)); });
    row.appendChild(cel);
  }
  stage.appendChild(row);

  // The reshuffle: let this gathering end and meet the next one — fresh
  // creatures, fresh decks, in case nothing on this table suits.
  const wait = document.createElement('button');
  wait.type = 'button';
  wait.className = 'ct-wait';
  wait.textContent = 'wait for the next gathering';
  wait.addEventListener('click', async () => {
    wait.disabled = true;
    realmSound('online', 0.4, 0.7);
    stage.classList.add('waiting');
    await sleep(700);
    regenerateEvent(meta, ev, ALL_TASK_IDS);
    saveMeta(meta);
    showEvent(meta, ev);
  });
  stage.appendChild(wait);
}

function showTrade(meta: CardMeta, ev: TradeEvent, cr: Creature): void {
  const stage = realmEl('card-stage');
  clearSpeech();
  stage.innerHTML = '';
  stage.className = 'trade-view';
  stage.appendChild(backButton('← step away', () => swapView(() => showEvent(meta, ev))));

  const header = div('ct-trade-header');
  header.appendChild(creatureAvatar());
  const headText = div('ct-trade-headtext');
  headText.appendChild(div('ct-creature-name', cr.name));
  const speech = div('ct-trade-line', '');
  headText.appendChild(speech);
  header.appendChild(headText);
  stage.appendChild(header);

  const theirsCap = div('ct-caption', 'their worlds');
  const theirsRow = div('ct-cards ct-theirs');
  const yoursCap = div('ct-caption', 'your worlds');
  const yoursRow = div('ct-cards ct-yours');
  stage.appendChild(theirsCap);
  stage.appendChild(theirsRow);
  stage.appendChild(yoursCap);
  stage.appendChild(yoursRow);

  // Selection state: 'idle' (nothing picked), 'offer' (one of YOUR eligible
  // cards picked — they show what they'd give), or 'request' (one of THEIR
  // cards picked — they show what they'd take). In offer mode, `staged`
  // holds the first pick of a two-for-one breakdown (the second pick seals
  // it; a same-tier pick seals immediately).
  let mode: 'idle' | 'offer' | 'request' = 'idle';
  let selectedId: number | null = null;
  let staged: number[] = [];

  const offerSpeech = (mine: WorldCard): string => {
    const same = sameTierGives(cr, mine).length > 0;
    const down = breakdownGives(cr, mine).length > 0;
    if (same && down) return 'for that: one of its kind, or two of the lesser.';
    if (same) return 'for that, i would give one of these.';
    if (down) return 'for that, i would give two of these.';
    return 'i hold nothing to give for that. wait for the next gathering.';
  };

  const executeTrade = (mine: WorldCard, theirs: WorldCard[]) => {
    meta.cards = meta.cards.filter((c) => c.id !== mine.id);
    cr.deck = cr.deck.filter((c) => !theirs.some((t) => t.id === c.id));
    meta.cards.push(...theirs);
    cr.deck.push(mine);
    saveMeta(meta);
    mode = 'idle';
    selectedId = null;
    staged = [];
    render();
    // Winning your own world back is the realm's quiet climax; losing it
    // again gets its own line too.
    if (theirs.some((t) => t.origin)) {
      realmSound('task_complete', 0.9, 1);
      speech.textContent = 'it remembers you.';
    } else if (mine.origin) {
      realmSound('ritual', 1, 0.9);
      speech.textContent = 'kept warm. someone grew this one.';
    } else {
      realmSound('ritual', 1, 0.9);
      speech.textContent = theirs.length === 2 ? "two for one. now it's a trade." : "now it's a trade.";
    }
  };

  const render = () => {
    theirsRow.innerHTML = '';
    yoursRow.innerHTML = '';
    // Cards of yours the creature is open to trading for: appetite match,
    // plus it must hold something to give back (a same-tier card, or a
    // two-for-one's worth of the tier below).
    const wanted = meta.cards.filter((c) =>
      appetiteAccepts(cr.appetite, c)
      && (sameTierGives(cr, c).length > 0 || breakdownGives(cr, c).length > 0));
    const selMine = meta.cards.find((c) => c.id === selectedId) ?? null;
    const selTheirs = cr.deck.find((c) => c.id === selectedId) ?? null;

    for (const tc of cr.deck) {
      const isStaged = staged.includes(tc.id);
      let eligible: boolean;
      if (mode === 'idle') {
        eligible = true;
      } else if (mode === 'request') {
        eligible = tc.id === selectedId;
      } else if (selMine === null) {
        eligible = false;
      } else if (staged.length > 0) {
        // Mid-breakdown: only the staged card (to unpick) and its remaining
        // lesser-tier companions are live.
        eligible = isStaged || breakdownGives(cr, selMine).includes(tc);
      } else {
        eligible = sameTierGives(cr, selMine).includes(tc) || breakdownGives(cr, selMine).includes(tc);
      }
      const el = buildCardEl(tc, {
        onClick: () => {
          if (mode === 'offer' && selMine) {
            if (isStaged) {
              // Unpick the first half of a breakdown.
              staged = [];
              render();
              speech.textContent = offerSpeech(selMine);
              return;
            }
            if (staged.length === 0 && sameTierGives(cr, selMine).includes(tc)) {
              executeTrade(selMine, [tc]);
              return;
            }
            if (breakdownGives(cr, selMine).includes(tc)) {
              const first = cr.deck.find((c) => c.id === staged[0]);
              if (first) {
                executeTrade(selMine, [first, tc]);
              } else {
                staged = [tc.id];
                render();
                speech.textContent = 'and one more.';
                realmSound('select', 0.7, 1.2);
              }
              return;
            }
            return;
          }
          if (mode === 'request' && tc.id === selectedId) {
            mode = 'idle'; selectedId = null; render();
            speech.textContent = APPETITE_LINE[cr.appetite];
            return;
          }
          if (mode !== 'offer') {
            const takers = creatureTakesFor(cr, tc, meta.cards);
            mode = 'request'; selectedId = tc.id; render();
            speech.textContent = takers.length > 0
              ? 'for this, i would take one of those.'
              : 'you hold nothing i would take for this.';
            realmSound('select', 0.7, 1.1);
          }
        },
      });
      el.classList.toggle('grayed', !eligible);
      el.classList.toggle('selected', (mode === 'request' && tc.id === selectedId) || isStaged);
      theirsRow.appendChild(el);
    }

    for (const mc of meta.cards) {
      const matches = wanted.includes(mc);
      const eligible = (mode === 'idle' && matches)
        || (mode === 'offer' && mc.id === selectedId)
        || (mode === 'request' && selTheirs !== null && creatureTakesFor(cr, selTheirs, meta.cards).includes(mc));
      const el = buildCardEl(mc, {
        onClick: () => {
          if (mode === 'request' && selTheirs && creatureTakesFor(cr, selTheirs, meta.cards).includes(mc)) {
            executeTrade(mc, [selTheirs]);
            return;
          }
          if (mode === 'offer' && mc.id === selectedId) {
            mode = 'idle'; selectedId = null; staged = []; render();
            speech.textContent = APPETITE_LINE[cr.appetite];
            return;
          }
          if (mode !== 'request' && matches) {
            mode = 'offer'; selectedId = mc.id; staged = []; render();
            speech.textContent = offerSpeech(mc);
            realmSound('select', 0.7, 1.1);
          } else if (mode === 'idle' && !matches) {
            realmSound('error', 0.5);
            speech.textContent = 'that one does not interest me.';
          }
        },
      });
      el.classList.toggle('grayed', !eligible);
      el.classList.toggle('selected', mode === 'offer' && mc.id === selectedId);
      yoursRow.appendChild(el);
    }
  };

  render();
  const anyWanted = meta.cards.some((c) => appetiteAccepts(cr.appetite, c));
  speech.textContent = anyWanted ? APPETITE_LINE[cr.appetite] : 'you hold nothing i want. yet.';
}
