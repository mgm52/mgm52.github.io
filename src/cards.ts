// ─── The trading-card realm ──────────────────────────────────────────
// The game's final section, picking up after the finale's screen has torn
// itself white. Every game world is now a trading card: stacked preview
// panes (space / earth / hell — only the scenes that world has opened),
// the world's resources, and an ENTER button. The player's own pre-Gabbonsaw save is dealt onto
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
import { BUILDING_DEFS, BuildingKind, CELL, HELL, SPACE, WORLD, formatPower } from './config';
import { clearSave, getRawSave, saveGame, setRawSave } from './save';
import { GameState, computePlayBounds, isInPlayCell } from './state';
import { ALL_TASK_IDS } from './ui';
import {
  APPETITE_LINE, CardMeta, CardResources, CardTier, Creature, FRAME_BASE, TIER_ABOVE,
  TIER_RANK, TradeEvent, UpgradeReq, WorldCard, appetiteAccepts, ascendCard,
  cardPower, decodeWorld, encodeWorld, generateEvents,
  makeCard, mulberry32, regenerateEvent, reqMet, sceneStructureCounts,
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
// Set while the player is SPECTATING a trader's card world: the world sits
// in the regular save slot like an entered card, but time is frozen, the
// build/summon chrome is hidden, and leaving never serializes back — the
// trader's card is untouched by the visit.
const SPECTATE_KEY = 'rts.cardspectate.v1';

function loadMeta(): CardMeta | null {
  try {
    const raw = localStorage.getItem(META_KEY);
    if (!raw) return null;
    const m = JSON.parse(raw) as CardMeta;
    if (!m || m.v !== 1 || !Array.isArray(m.cards)) return null;
    // Metas saved before trader frames existed: stamp the stable slot
    // patterns onto the creatures and their unclaimed decks. Cards already
    // traded into the player's hand are unattributable and stay plain.
    if (m.events) {
      for (const ev of m.events) {
        ev.creatures.forEach((c, i) => {
          if (c.frame === undefined) {
            c.frame = FRAME_BASE[ev.tier] + i;
            for (const wc of c.deck) {
              if (wc.frame === undefined && !wc.origin) wc.frame = c.frame;
            }
          }
        });
      }
    }
    // Metas saved before the per-playthrough seed existed: stamp one now so
    // future gathering rolls stop being identical across playthroughs.
    if (m.seed === undefined) {
      m.seed = (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
      saveMeta(m);
    }
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

// True while the save slot holds a world the player is only WATCHING.
export function spectateActive(): boolean {
  try { return localStorage.getItem(SPECTATE_KEY) === '1'; } catch { return false; }
}

// Dev cheat (options cog): wipe ONLY the trading-section metagame and
// reload. If the player is currently inside (or spectating) a card world,
// the stashed outer save is put back first, so the main game survives the
// wipe — the next visit to the realm starts from the goblin intro again.
export function devResetCardRealm(): void {
  const outer = localStorage.getItem(OUTER_KEY);
  if (outer) setRawSave(outer);
  clearCardData();
  location.reload();
}

// Wipe the whole metagame — wired into the title screen's Erase Data.
export function clearCardData(): void {
  try {
    localStorage.removeItem(META_KEY);
    localStorage.removeItem(ORIGIN_KEY);
    localStorage.removeItem(OUTER_KEY);
    localStorage.removeItem(SPECTATE_KEY);
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
      resources: {
        money: state.money, blood: state.blood, dragonBone: state.dragonBone,
        power: cardPower(state), goblins: state.goblins.size,
      },
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

// The white that bridges every world hop — created lazily at body level so
// it sits above both the realm (100001) and the game.
function hopWhite(): HTMLElement {
  let el = document.getElementById('card-hop-white');
  if (!el) {
    el = document.createElement('div');
    el.id = 'card-hop-white';
    document.body.appendChild(el);
  }
  return el;
}

async function enterWorld(meta: CardMeta, card: WorldCard, cardEl?: HTMLElement): Promise<void> {
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
  // The dive: the chosen card swells toward the viewer while the white
  // takes over — it bridges into the arrival zoom on the far side of the
  // reload (setupCardWorldChrome).
  const white = hopWhite();
  white.style.transition = 'opacity 900ms ease-in';
  cardEl?.classList.add('dived');
  requestAnimationFrame(() => { white.style.opacity = '1'; });
  // Hold until the white fully lands so the reload cuts on a clean frame.
  await sleep(1200);
  location.reload();
}

// Spectating: dive into a TRADER'S card without owning it. Same hop as
// enterWorld — the world goes into the save slot and the page reloads — but
// the spectate flag (not meta.activeCardId) marks the visit, so boot freezes
// time, hides the build chrome, and leaveSpectate restores the outer save
// without ever writing the visit back onto the trader's card.
async function spectateWorld(card: WorldCard, cardEl?: HTMLElement): Promise<void> {
  const st = decodeWorld(card.data);
  if (!st) { realmSound('error'); return; }
  const outer = getRawSave();
  if (outer) {
    try { localStorage.setItem(OUTER_KEY, outer); } catch { /* skip */ }
  }
  saveGame(st);
  const written = getRawSave();
  if (written === null || written === outer) { realmSound('error'); return; }
  // The flag is what makes the next boot a spectate; if it can't be stored
  // the hop must not happen — booting the trader's world unflagged would
  // adopt it as the player's own. Put the outer save back and bail.
  let flagged = false;
  try {
    localStorage.setItem(SPECTATE_KEY, '1');
    flagged = localStorage.getItem(SPECTATE_KEY) === '1';
  } catch { /* flagged stays false */ }
  if (!flagged) {
    if (outer) setRawSave(outer);
    realmSound('error');
    return;
  }
  realmSound('ritual', 1, 0.7);
  markCardHop();
  const white = hopWhite();
  white.style.transition = 'opacity 900ms ease-in';
  cardEl?.classList.add('dived');
  requestAnimationFrame(() => { white.style.opacity = '1'; });
  await sleep(1200);
  location.reload();
}

async function leaveSpectate(): Promise<void> {
  markCardHop();
  // The same pull-back as leaveWorld — but nothing is serialized: the visit
  // leaves no mark on the trader's card.
  const app = document.getElementById('app');
  const white = hopWhite();
  white.style.transition = 'opacity 1150ms ease-in';
  app?.classList.add('card-exit-zoom');
  requestAnimationFrame(() => { white.style.opacity = '1'; });
  await sleep(1250);
  try { localStorage.removeItem(SPECTATE_KEY); } catch { /* no-op */ }
  const outer = localStorage.getItem(OUTER_KEY);
  if (outer) {
    setRawSave(outer);
    try { localStorage.removeItem(OUTER_KEY); } catch { /* no-op */ }
  } else {
    // Same guard as leaveWorld: never let a visited world become the save.
    clearSave();
  }
  location.reload();
}

async function leaveWorld(state: GameState): Promise<void> {
  const meta = loadMeta();
  if (!meta || meta.activeCardId === null) return;
  markCardHop();
  // The pull-back: the whole world recedes to a point as the white takes
  // over — the finale's own exit, in miniature. The state is serialized
  // AFTER the zoom so the final second of play still makes it onto the card.
  const app = document.getElementById('app');
  const white = hopWhite();
  white.style.transition = 'opacity 1150ms ease-in';
  app?.classList.add('card-exit-zoom');
  requestAnimationFrame(() => { white.style.opacity = '1'; });
  await sleep(1250);
  const card = meta.cards.find((c) => c.id === meta.activeCardId);
  if (card) {
    // The card remembers everything the player just did inside it.
    card.data = encodeWorld(state);
    card.resources = {
      money: state.money, blood: state.blood, dragonBone: state.dragonBone,
      power: cardPower(state), goblins: state.goblins.size,
    };
  }
  meta.activeCardId = null;
  saveMeta(meta);
  const outer = localStorage.getItem(OUTER_KEY);
  if (outer) {
    setRawSave(outer);
    try { localStorage.removeItem(OUTER_KEY); } catch { /* no-op */ }
  } else {
    // No stashed outer world (a dev hop into the realm before any autosave
    // landed). The world was serialized onto its card above — clear the
    // slot so the card world can't masquerade as the main game.
    clearSave();
  }
  location.reload();
}

// Boot fallback: the metagame says we're inside a card but the save slot is
// unreadable. Restore the outer save (if stashed) and clear the active card
// so the player lands back on the table instead of a broken world.
export function abandonCardWorldBoot(): void {
  const meta = loadMeta();
  if (meta) { meta.activeCardId = null; saveMeta(meta); }
  try { localStorage.removeItem(SPECTATE_KEY); } catch { /* no-op */ }
  const outer = localStorage.getItem(OUTER_KEY);
  if (outer) {
    setRawSave(outer);
    try { localStorage.removeItem(OUTER_KEY); } catch { /* no-op */ }
  }
}

// Inside a card world: the white screen border (body.card-world) and the big
// white LEAVE WORLD button pinned to the bottom of the screen. When the boot
// was an explicit hop (ENTER → reload), the world arrives by zooming
// out of the white — the finale's pull-back, run in reverse.
export function setupCardWorldChrome(state: GameState, arriving = false): void {
  document.body.classList.add('card-world');
  // Spectating a trader's world: time stands still (main.ts's tick freeze
  // keys on the body class) and the mutating chrome — summon/build panels,
  // destroy buttons, right-click commands — is walled off in CSS/input.ts.
  const spectating = spectateActive();
  if (spectating) document.body.classList.add('spectate-hold');
  const btn = document.getElementById('leave-world-btn') as HTMLButtonElement | null;
  if (btn) {
    btn.style.display = '';
    if (spectating) btn.textContent = 'STOP SPECTATING';
    btn.addEventListener('click', () => {
      btn.disabled = true;
      realmSound('ritual', 1, 0.7);
      void (spectating ? leaveSpectate() : leaveWorld(state));
    }, { once: true });
  }
  // The card's ascension goal, pinned above the leave button and ticking
  // along live — so the reason to be in here is never out of sight. Only
  // for OWNED worlds with a demand left (spectates and rares go without).
  if (!spectating) {
    const meta = loadMeta();
    const card = meta?.cards.find((c) => c.id === meta.activeCardId) ?? null;
    const req = card?.upgradeReq ?? null;
    const goal = document.getElementById('world-goal');
    if (goal && req) {
      goal.style.display = '';
      const update = () => {
        const have = req.res === 'power' ? cardPower(state)
          : req.res === 'goblins' ? state.goblins.size
          : state[req.res];
        const met = have >= req.amount;
        goal.classList.toggle('met', met);
        goal.textContent = met
          ? `✓ ascension ready — leave world to ascend`
          : `ascends at ${fmtReqAmount(req)} · ${fmtResAmount(req.res, have)} held`;
      };
      update();
      window.setInterval(update, 500);
    }
  }
  if (arriving) {
    const app = document.getElementById('app');
    const white = hopWhite();
    white.style.transition = 'none';
    white.style.opacity = '1';
    app?.classList.add('card-enter-zoom');
    // Two frames so the scaled-down start commits before the release.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        app?.classList.add('card-enter-zoom-go');
        white.style.transition = 'opacity 1600ms ease-out';
        white.style.opacity = '0';
      });
    });
    window.setTimeout(() => {
      app?.classList.remove('card-enter-zoom', 'card-enter-zoom-go');
    }, 1750);
  }
}

// ─── Card previews ───────────────────────────────────────────────────
// Stacked minimap panes painted from the card's decoded state: space on
// top, earth in the middle, hell at the bottom — the world as a column.
// Only the scenes the world has actually opened get a pane (buildCardEl
// checks spaceUnlocked / hellUnlocked); most commons are all ground.

const decodedCache = new Map<number, { data: string; st: GameState | null }>();
function decodedWorld(card: WorldCard): GameState | null {
  const hit = decodedCache.get(card.id);
  if (hit && hit.data === card.data) return hit.st;
  const st = decodeWorld(card.data);
  decodedCache.set(card.id, { data: card.data, st });
  return st;
}

function hexColor(n: number): string { return `#${n.toString(16).padStart(6, '0')}`; }

// ── Building sprites for the earth pane ──
// The same PNGs the game renders, scaled down onto the card minimap so a
// world's skyline is recognizable at a glance. Loaded lazily and cached; a
// pane drawn before its sprites arrive paints the old colored blocks and
// repaints itself once they land. Kinds without a sheet (the hell portal,
// the space structures) keep their procedural look.
const SPRITE_KINDS = new Set<BuildingKind>([
  'datacentre', 'dragon_beacon', 'gas_engine', 'goblin_hole', 'goblin_wheel',
  'hypercentre', 'nuclear_reactor', 'phone_farm', 'wall',
]);
const spriteCache = new Map<BuildingKind, HTMLImageElement>();
function buildingSprite(kind: BuildingKind): HTMLImageElement | null {
  if (!SPRITE_KINDS.has(kind)) return null;
  let img = spriteCache.get(kind);
  if (!img) {
    img = new Image();
    img.src = `assets/buildings/${kind}.png`;
    spriteCache.set(kind, img);
  }
  return img;
}

// Any region holding more than two structures brightens — an additive glow
// blob over the cluster, so a built-up corner of a world reads as alive from
// the card alone.
function drawDensityGlow(
  g: CanvasRenderingContext2D,
  points: { x: number; y: number }[],
  blockPx: number,
  rgb: string,
): void {
  const blocks = new Map<string, { n: number; sx: number; sy: number }>();
  for (const p of points) {
    const key = `${Math.floor(p.x / blockPx)},${Math.floor(p.y / blockPx)}`;
    const b = blocks.get(key) ?? { n: 0, sx: 0, sy: 0 };
    b.n++; b.sx += p.x; b.sy += p.y;
    blocks.set(key, b);
  }
  g.save();
  g.globalCompositeOperation = 'lighter';
  for (const b of blocks.values()) {
    if (b.n <= 2) continue;
    const cx = b.sx / b.n, cy = b.sy / b.n;
    const r = blockPx * (1 + 0.15 * Math.min(b.n, 8));
    const a = Math.min(0.42, 0.12 + 0.06 * (b.n - 2));
    const grad = g.createRadialGradient(cx, cy, 0, cx, cy, r);
    grad.addColorStop(0, `rgba(${rgb}, ${a.toFixed(2)})`);
    grad.addColorStop(1, `rgba(${rgb}, 0)`);
    g.fillStyle = grad;
    g.fillRect(cx - r, cy - r, r * 2, r * 2);
  }
  g.restore();
}

function drawSpacePreview(cv: HTMLCanvasElement, st: GameState, seed: number): void {
  const g = cv.getContext('2d');
  if (!g) return;
  // The pane renders at 2× (see mkCanvas); paint in logical pixels so the
  // hand-tuned star/beam sizes below keep their look.
  g.setTransform(2, 0, 0, 2, 0, 0);
  const w = cv.width / 2, h = cv.height / 2;
  g.fillStyle = '#05040f';
  g.fillRect(0, 0, w, h);
  const rng = mulberry32(seed);
  // A faint nebula so the void has depth.
  for (let i = 0; i < 2; i++) {
    const nx = rng() * w, ny = rng() * h, nr = 20 + rng() * 40;
    const neb = g.createRadialGradient(nx, ny, 0, nx, ny, nr);
    neb.addColorStop(0, i === 0 ? 'rgba(110, 70, 160, 0.16)' : 'rgba(60, 110, 160, 0.13)');
    neb.addColorStop(1, 'rgba(0, 0, 0, 0)');
    g.fillStyle = neb;
    g.fillRect(nx - nr, ny - nr, nr * 2, nr * 2);
  }
  for (let i = 0; i < 44; i++) {
    const big = rng() < 0.12;
    g.globalAlpha = 0.35 + rng() * 0.65;
    g.fillStyle = big ? '#ffffff' : '#cfd4e8';
    g.fillRect(Math.floor(rng() * w), Math.floor(rng() * h), big ? 2 : 1, big ? 2 : 1);
  }
  g.globalAlpha = 1;
  const pts: { x: number; y: number }[] = [];
  for (const sb of st.spaceBuildings.values()) {
    const x = (sb.pos.x / SPACE.width) * w;
    const y = (sb.pos.y / SPACE.height) * h;
    pts.push({ x, y });
    if (sb.building.kind === 'orbital_platform') {
      g.fillStyle = '#565b66';
      g.fillRect(x - 4, y - 3, 9, 7);
      g.strokeStyle = '#9aa0ac';
      g.lineWidth = 1;
      g.strokeRect(x - 4.5, y - 3.5, 10, 8);
      g.fillStyle = '#8ad8ff';
      g.fillRect(x - 3, y - 2, 1, 1);
      g.fillRect(x + 3, y + 2, 1, 1);
    } else {
      const def = BUILDING_DEFS[sb.building.kind];
      g.fillStyle = hexColor(def.colors.active);
      g.fillRect(x - 2, y - 2, 5, 5);
      g.strokeStyle = hexColor(def.colors.activeBorder);
      g.lineWidth = 1;
      g.strokeRect(x - 2.5, y - 2.5, 6, 6);
    }
  }
  for (const su of st.spaceUnits.values()) {
    g.fillStyle = su.robot ? '#c9d0d9' : '#7fd183';
    g.fillRect((su.pos.x / SPACE.width) * w, (su.pos.y / SPACE.height) * h, 2, 2);
  }
  drawDensityGlow(g, pts, Math.max(24, w / 5), '170, 200, 255');
}

function drawEarthPreview(cv: HTMLCanvasElement, st: GameState): void {
  const g = cv.getContext('2d');
  if (!g) return;
  const w = cv.width, h = cv.height;
  g.fillStyle = '#11140d';
  g.fillRect(0, 0, w, h);
  const b = computePlayBounds(st);
  const bw = b.x1 - b.x0, bh = b.y1 - b.y0;
  const s = Math.min(w / (bw + 2), h / (bh + 2));
  const ox = (w - bw * s) / 2, oy = (h - bh * s) / 2;
  const px = (cx: number) => ox + (cx - b.x0) * s;
  const py = (cy: number) => oy + (cy - b.y0) * s;
  // Ground, with gentle per-cell mottling so it reads as terrain rather
  // than a flat fill.
  const greens = ['#30502f', '#2b4a2c', '#345633'];
  for (let cy = b.y0; cy < b.y1; cy++) {
    for (let cx = b.x0; cx < b.x1; cx++) {
      if (!isInPlayCell(st, cx, cy)) continue;
      g.fillStyle = greens[(cx * 7 + cy * 13) % 3];
      g.fillRect(px(cx), py(cy), s + 0.5, s + 0.5);
    }
  }
  // Water, with a light catching its upper edge.
  for (const ws of st.waterSources.values()) {
    g.fillStyle = '#2e639a';
    g.fillRect(px(ws.x0), py(ws.y0), (ws.x1 - ws.x0) * s, (ws.y1 - ws.y0) * s);
    g.fillStyle = 'rgba(140, 190, 235, 0.7)';
    g.fillRect(px(ws.x0), py(ws.y0), (ws.x1 - ws.x0) * s, 1);
  }
  // The spawning hole.
  if (!st.holeDestroyed) {
    g.fillStyle = '#0a0a0a';
    g.beginPath();
    g.arc(px(st.hole.cell.cx + 0.5), py(st.hole.cell.cy + 0.5), Math.max(1.4, s * 0.8), 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = 'rgba(0, 0, 0, 0.5)';
    g.lineWidth = 1;
    g.stroke();
  }
  // Buildings as their real in-game sprites, bottom-anchored on their
  // footprints so taller structures rise above their plots like a skyline;
  // dormant ones sit dimmed. Kinds without a sheet (and sprites that
  // haven't finished loading) fall back to the old colored blocks.
  const pts: { x: number; y: number }[] = [];
  const pending = new Set<HTMLImageElement>();
  for (const bd of st.buildings.values()) {
    const def = BUILDING_DEFS[bd.kind];
    const x = px(bd.cell.cx), y = py(bd.cell.cy);
    const size = Math.max(1.5, def.cellSize * s);
    const active = bd.state === 'active';
    const img = buildingSprite(bd.kind);
    if (img && img.complete && img.naturalWidth > 0) {
      const hgt = Math.min(size * 2, size * (img.naturalHeight / img.naturalWidth));
      if (!active) g.globalAlpha = 0.55;
      g.drawImage(img, x, y + size - hgt, size, hgt);
      g.globalAlpha = 1;
    } else {
      if (img && !img.complete) pending.add(img);
      g.fillStyle = hexColor(active ? def.colors.active : def.colors.dormant);
      g.fillRect(x, y, size, size);
      if (bd.kind !== 'wall' && size >= 3) {
        g.strokeStyle = hexColor(active ? def.colors.activeBorder : def.colors.dormantBorder);
        g.lineWidth = 1;
        g.strokeRect(x + 0.5, y + 0.5, size - 1, size - 1);
      }
    }
    if (bd.kind !== 'wall') {
      pts.push({ x: x + size / 2, y: y + size / 2 });
    }
  }
  // Units as bright dots.
  for (const gob of st.goblins.values()) {
    g.fillStyle = gob.robot ? '#c9d0d9' : gob.gold ? '#ffd96b' : '#8ee492';
    g.fillRect(px(gob.cell.cx), py(gob.cell.cy), Math.max(2.4, s * 0.7), Math.max(2.4, s * 0.7));
  }
  // Minotaurs read bigger and redder — a rampage card shows its herd.
  for (const m of st.minotaurs.values()) {
    g.fillStyle = m.tiny ? '#e0895a' : '#c4524a';
    const ms = Math.max(3, s * 1.1);
    g.fillRect(px(m.cell.cx), py(m.cell.cy), ms, ms);
  }
  // Built-up regions glow.
  drawDensityGlow(g, pts, 7 * s, '255, 236, 170');
  // Repaint once late sprites land ('error' counts too, so a missing file
  // can never strand the pane).
  if (pending.size > 0) {
    let waiting = pending.size;
    const arrived = () => { if (--waiting === 0) drawEarthPreview(cv, st); };
    for (const img of pending) {
      img.addEventListener('load', arrived, { once: true });
      img.addEventListener('error', arrived, { once: true });
    }
  }
}

function drawHellPreview(cv: HTMLCanvasElement, st: GameState, seed: number): void {
  const g = cv.getContext('2d');
  if (!g) return;
  // 2× pane, logical-pixel painting — same treatment as the space pane.
  g.setTransform(2, 0, 0, 2, 0, 0);
  const w = cv.width / 2, h = cv.height / 2;
  g.fillStyle = hexColor(HELL.bgColor);
  g.fillRect(0, 0, w, h);
  // Layers of fog rising from the floor of the pit.
  const rng = mulberry32(seed ^ 0x9e3779b9);
  for (let i = 0; i < 3; i++) {
    const fx = rng() * w, fy = h * (0.7 + rng() * 0.4), fr = 30 + rng() * 50;
    const fog = g.createRadialGradient(fx, fy, 0, fx, fy, fr);
    fog.addColorStop(0, 'rgba(96, 16, 22, 0.5)');
    fog.addColorStop(1, 'rgba(96, 16, 22, 0)');
    g.fillStyle = fog;
    g.fillRect(fx - fr, fy - fr, fr * 2, fr * 2);
  }
  // Portal beams: a soft red shaft with a hot core, grounded in a glow pool.
  for (const bd of st.buildings.values()) {
    if (bd.kind !== 'hell_portal' || bd.state === 'constructing') continue;
    const x = ((bd.cell.cx * CELL) / WORLD.width) * w;
    g.fillStyle = 'rgba(255, 32, 48, 0.22)';
    g.fillRect(x - 1.5, 0, 4, h);
    g.fillStyle = 'rgba(255, 90, 90, 0.95)';
    g.fillRect(x, 0, 1, h);
    const pool = g.createRadialGradient(x + 0.5, h, 0, x + 0.5, h, 12);
    pool.addColorStop(0, 'rgba(255, 60, 70, 0.5)');
    pool.addColorStop(1, 'rgba(255, 60, 70, 0)');
    g.fillStyle = pool;
    g.fillRect(x - 12, h - 12, 25, 12);
  }
  // Drifting ghosts — soft-glowing souls rather than bare pixels.
  g.save();
  g.globalCompositeOperation = 'lighter';
  for (const gh of st.ghosts) {
    const x = (gh.x / WORLD.width) * w;
    const y = 3 + rng() * (h - 6);
    const r = gh.kind === 'dragon' ? 3.4 : gh.kind === 'minotaur' ? 2.6 : 2;
    const tint = gh.gold ? '255, 217, 107' : gh.kind === 'dragon' ? '255, 150, 130' : '190, 200, 235';
    const glow = g.createRadialGradient(x, y, 0, x, y, r);
    glow.addColorStop(0, `rgba(${tint}, ${0.5 + rng() * 0.4})`);
    glow.addColorStop(1, `rgba(${tint}, 0)`);
    g.fillStyle = glow;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  g.restore();
  // Lit candles.
  for (const c of st.soulChairs) {
    const x = (c.hx / HELL.width) * w, y = (c.hy / HELL.height) * h;
    g.fillStyle = '#ff9a3d';
    g.fillRect(x, y, 1.5, 1.5);
  }
}

// ─── Card DOM ────────────────────────────────────────────────────────

// The card's resource line: each resource in its own color (cash yellow,
// blood red, power blue, bones grey), hidden at zero, and bold once it
// crosses its "serious" threshold (Ƶ500k / 128 blood / 1 GW / 5 bones).
function resourcesEl(r: CardResources): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'wc-res';
  const fmt = (n: number) => Math.floor(n).toLocaleString('en-US');
  const add = (cls: string, text: string, strong: boolean) => {
    const span = document.createElement('span');
    span.className = `${cls}${strong ? ' strong' : ''}`;
    span.textContent = text;
    wrap.appendChild(span);
  };
  const power = r.power ?? 0;
  const goblins = r.goblins ?? 0;
  if (r.money > 0) add('res-cash', `Ƶ ${fmt(r.money)}`, r.money >= 500_000);
  if (r.blood > 0) add('res-blood', `${fmt(r.blood)} blood`, r.blood >= 128);
  if (power > 0) add('res-power', formatPower(power), power >= 1_000_000_000);
  if (r.dragonBone > 0) add('res-bones', `${fmt(r.dragonBone)} bones`, r.dragonBone >= 5);
  if (goblins > 0) add('res-goblins', `${fmt(goblins)} goblins`, goblins >= 25);
  if (!wrap.firstChild) add('res-nothing', 'nothing', false);
  return wrap;
}

function fmtResAmount(res: UpgradeReq['res'], n: number): string {
  if (res === 'power') return formatPower(n);
  const amt = Math.floor(n).toLocaleString('en-US');
  return res === 'money' ? `Ƶ ${amt}`
    : res === 'blood' ? `${amt} blood`
    : res === 'goblins' ? `${amt} goblins`
    : `${amt} bones`;
}

function fmtReqAmount(r: UpgradeReq): string {
  return fmtResAmount(r.res, r.amount);
}

type CardElOpts = {
  big?: boolean;
  enterLabel?: string;       // when set, the card carries an enter button
  onEnter?: (cardEl: HTMLElement) => void;
  onClick?: () => void;      // whole-card click (trade views)
  onAscend?: () => void;     // table view: shown once the ascension demand is met
};

function buildCardEl(card: WorldCard, opts: CardElOpts = {}): HTMLElement {
  const root = document.createElement('div');
  root.className = `world-card t-${card.tier}${opts.big ? ' big' : ''}${card.origin ? ' origin' : ''}`;
  // The trade animations find a card's element by its id; the frame class
  // draws its minting trader's border pattern (player-minted cards: none).
  root.dataset.cardId = String(card.id);
  if (card.frame !== undefined) root.classList.add(`wcf-${card.frame}`);
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
    // 2× the on-screen size (the CSS width is 100%, so the height scales
    // with it and the displayed box is unchanged) — the building sprites
    // stay crisp instead of dissolving at minimap scale.
    cv.width = 336;
    cv.height = hgt * 2;
    panes.appendChild(cv);
    return cv;
  };
  // A card only carries the scenes its world has actually opened: no space
  // pane without space unlocked, no hell pane without the descent. The earth
  // pane grows into whatever is missing (each absent strip is 40px + 3px
  // gap), so an earth-only world reads as all ground — and a three-scene
  // column quietly marks a more developed world. Undecodable worlds (st
  // null) keep the full blank column.
  const hasSpace = !st || st.spaceUnlocked;
  const hasHell = !st || st.hellUnlocked;
  const earthH = 96 + (hasSpace ? 0 : 43) + (hasHell ? 0 : 43);
  const cvSpace = hasSpace ? mkCanvas('wc-space', 40) : null;
  const cvEarth = mkCanvas('wc-earth', earthH);
  const cvHell = hasHell ? mkCanvas('wc-hell', 40) : null;
  if (st) {
    if (cvSpace) drawSpacePreview(cvSpace, st, card.id * 7919 + 17);
    drawEarthPreview(cvEarth, st);
    if (cvHell) drawHellPreview(cvHell, st, card.id * 7919 + 17);
    // Each pane reads its scene's development at a glance: nothing built →
    // faded; three or more structures → a glowing edge.
    const counts = sceneStructureCounts(st);
    const treat = (cv: HTMLCanvasElement | null, n: number) => {
      if (!cv) return;
      if (n === 0) cv.classList.add('pane-faded');
      else if (n >= 3) cv.classList.add('pane-glow');
    };
    treat(cvSpace, counts.space);
    treat(cvEarth, counts.earth);
    treat(cvHell, counts.hell);
  }
  root.appendChild(panes);

  root.appendChild(resourcesEl(card.resources));

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
    btn.addEventListener('click', (e) => { e.stopPropagation(); opts.onEnter?.(root); });
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
    const hand = document.getElementById('card-hand');
    if (hand) hand.innerHTML = '';
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
    meta = {
      v: 1,
      phase: 'intro',
      seed: (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0,
      nextId: 1,
      cards: [],
      events: null,
      activeCardId: null,
    };
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
// ENTER, and the white goblin descends to take it.
async function runTradeIntro(meta: CardMeta): Promise<void> {
  const stage = realmEl('card-stage');
  stage.innerHTML = '';
  stage.className = 'intro-view';

  const origin = meta.cards[0];
  await sleep(500);
  const reentered = new Promise<void>((resolve) => {
    const cardEl = buildCardEl(origin, {
      big: true,
      enterLabel: 'ENTER',
      onEnter: () => resolve(),
    });
    // The opening deal: the origin card slides in slowly from off-table,
    // turning flat like a card pushed across felt. `.dealing` carries the
    // slow transition and is dropped once the slide settles, so the later
    // goblin-dip transforms run at normal speed.
    cardEl.classList.add('deal-across', 'dealing');
    stage.appendChild(cardEl);
    // Two frames so the dealt-in transform commits before it transitions out.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        cardEl.classList.remove('deal-across');
        realmSound('place', 1.2, 0.55);
      });
    });
    window.setTimeout(() => cardEl.classList.remove('dealing'), 2400);
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

// ─── The player's hand ───────────────────────────────────────────────
// Lives in #card-hand, pinned to the bottom of the realm OUTSIDE the
// swapped stage, so moving between table / gathering / trade never fades
// or re-deals the cards the player is holding. Each view re-wires it (the
// handlers differ) but the DOM it builds is identical, so nothing visibly
// changes across a swap.
type HandOpts = {
  // Trade view: whole-card clicks feed the selection basket.
  onCardClick?: (card: WorldCard) => void;
  // Fired after an ascension. The view MUST refresh anything that depends
  // on tiers (gathering locks, trade eligibility) AND re-render the hand;
  // when absent the hand re-renders itself.
  onAscended?: () => void;
  // Mounted above the hand's caption — the trade view parks its verdict
  // button here so it reads as sitting between the two rows.
  topEl?: HTMLElement;
};

function handRowEl(): HTMLElement | null {
  return document.querySelector('#card-hand .ct-cards');
}

function renderHand(meta: CardMeta, opts: HandOpts = {}): void {
  const hand = document.getElementById('card-hand');
  if (!hand) return;
  hand.innerHTML = '';
  if (opts.topEl) hand.appendChild(opts.topEl);
  if (meta.cards.length > 0) {
    hand.appendChild(div('ct-caption', meta.cards.length === 1 ? 'your world' : 'your worlds'));
    const row = div('ct-cards');
    for (const c of meta.cards) {
      const el = buildCardEl(c, {
        enterLabel: 'ENTER',
        onEnter: (cardEl) => { void enterWorld(meta, c, cardEl); },
        onClick: opts.onCardClick ? () => opts.onCardClick!(c) : undefined,
        onAscend: () => {
          ascendCard(meta, c);
          saveMeta(meta);
          realmSound('task_complete', 0.8, 1.1);
          if (opts.onAscended) opts.onAscended();
          else renderHand(meta, opts);
          // The rebuilt card flashes in its new tier's colors.
          handRowEl()?.querySelector(`[data-card-id="${c.id}"]`)?.classList.add('ascended');
        },
      });
      row.appendChild(el);
    }
    hand.appendChild(row);
  }
  // Scrolled stage content must be able to clear the hand.
  const stage = document.getElementById('card-stage');
  if (stage) stage.style.paddingBottom = hand.offsetHeight > 0 ? `${hand.offsetHeight + 8}px` : '';
}

function showTable(meta: CardMeta): void {
  const stage = realmEl('card-stage');
  clearSpeech();
  stage.innerHTML = '';
  stage.className = 'table-view';

  // Everything on the table deals in with a small stagger (--deal-i drives
  // the per-item delay; the player's hand below continues the count).
  let dealI = 0;
  const dealIn = (el: HTMLElement) => {
    el.classList.add('dealt');
    el.style.setProperty('--deal-i', String(dealI++));
  };

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
    btn.className = `ct-event t-${ev.tier}${locked ? ' locked' : ''}`;
    const n = ev.creatures.length;
    const sub = locked
      ? 'you hold nothing to trade here'
      : `trades ${ev.tier} worlds · ${n} creature${n === 1 ? '' : 's'} attending`;
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
    dealIn(btn);
    evRow.appendChild(btn);
  }
  stage.appendChild(evRow);

  // The hand (bottom of the screen, its own persistent layer): ascending a
  // card can unlock gathering doors, so the table re-renders behind it.
  renderHand(meta, { onAscended: () => showTable(meta) });
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
  stage.appendChild(div(`ct-caption ct-event-title t-${ev.tier}`, ev.name));
  const row = div('ct-creatures');
  ev.creatures.forEach((cr, i) => {
    const cel = div('ct-creature');
    cel.appendChild(creatureAvatar());
    // (The trader's frame-pattern chip used to sit beside the name; the
    // hand minis below carry the at-a-glance info now, so the name stands
    // alone and the pattern stays learnable from the dealt cards themselves.)
    cel.appendChild(div('ct-creature-name', cr.name));
    cel.appendChild(div('ct-creature-line', APPETITE_LINE[cr.appetite]));
    // The hand at a glance: one blank mini-card per held world, in its
    // tier's color (white for common, blue uncommon, gold rare); the stolen
    // origin card wears its star.
    const hand = div('ct-creature-hand');
    hand.title = `${cr.deck.length} world${cr.deck.length === 1 ? '' : 's'} in hand`;
    for (const wc of cr.deck) {
      const mini = div(`ct-hand-mini t-${wc.tier}${wc.origin ? ' origin' : ''}`);
      if (wc.origin) mini.textContent = '★';
      hand.appendChild(mini);
    }
    cel.appendChild(hand);
    cel.addEventListener('click', () => { realmSound('click', 0.8, 1); swapView(() => showTrade(meta, ev, cr)); });
    cel.classList.add('dealt');
    cel.style.setProperty('--deal-i', String(i));
    row.appendChild(cel);
  });
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

  // The hand persists at the bottom, untouched by the view swap.
  renderHand(meta, { onAscended: () => showEvent(meta, ev) });
}

function showTrade(meta: CardMeta, ev: TradeEvent, cr: Creature): void {
  const stage = realmEl('card-stage');
  clearSpeech();
  stage.innerHTML = '';
  stage.className = 'trade-view';
  stage.appendChild(backButton('← step away', () => swapView(() => showEvent(meta, ev))));

  // The trader presides over the table from the top middle: sprite, name,
  // speech line, stacked and centered (the frame chip is gone — the cards
  // themselves wear the pattern).
  const header = div('ct-trade-header');
  header.appendChild(creatureAvatar());
  const headText = div('ct-trade-headtext');
  headText.appendChild(div('ct-creature-name', cr.name));
  const speech = div('ct-trade-line', '');
  headText.appendChild(speech);
  header.appendChild(headText);
  stage.appendChild(header);

  // Trader lines type out letter-at-a-time, like every other talking
  // creature in the game. A newer line cancels whatever an older one was
  // still typing (the token check), so rapid clicking never interleaves.
  const TRADE_TYPE_MS = 24;
  let typeToken = 0;
  const sayLine = (text: string): void => {
    const tok = ++typeToken;
    speech.classList.add('typing');
    speech.textContent = '';
    void (async () => {
      let rendered = '';
      for (const ch of text) {
        if (tok !== typeToken) return;
        rendered += ch;
        speech.textContent = rendered;
        await sleep(TRADE_TYPE_MS);
      }
      if (tok === typeToken) speech.classList.remove('typing');
    })();
  };

  const theirsCap = div('ct-caption', 'their worlds');
  const theirsRow = div('ct-cards ct-theirs');
  stage.appendChild(theirsCap);
  stage.appendChild(theirsRow);

  // The verdict, floating just above your hand (between the two rows):
  // invisible until any of the trader's cards are picked, "bad trade"
  // while the basket doesn't balance, and the green "✓ trade" button — the
  // actual executor — once it does. Mounted into the hand layer by
  // wireHand below.
  const verdict = document.createElement('button');
  verdict.type = 'button';
  verdict.className = 'ct-trade-verdict';
  verdict.disabled = true;

  // ── Selection ──
  // Every card — theirs or yours — is a free toggle: clicking it moves it
  // in or out of the trade, no order and no eligibility gate. A picked card
  // wears a short thick arrow pointing where it would go (theirs: down
  // toward your hand; yours: up toward the trader). The verdict button is
  // the only judge of whether the basket balances: one of theirs for one
  // of yours of the same tier (appetite willing), or two of theirs of a
  // kind for one of yours a tier above.
  const pickedTheirs = new Set<number>();
  const pickedMine = new Set<number>();

  const theirPicked = (): WorldCard[] => cr.deck.filter((c) => pickedTheirs.has(c.id));
  const minePicked = (): WorldCard[] => meta.cards.filter((c) => pickedMine.has(c.id));

  const tradeReady = (): { mine: WorldCard; theirs: WorldCard[] } | null => {
    const mines = minePicked();
    const theirs = theirPicked();
    if (mines.length !== 1 || theirs.length === 0 || theirs.length > 2) return null;
    const mine = mines[0];
    if (theirs.length === 1) {
      return mine.tier === theirs[0].tier && appetiteAccepts(cr.appetite, mine)
        ? { mine, theirs } : null;
    }
    if (theirs[0].tier !== theirs[1].tier) return null;
    return TIER_RANK[mine.tier] === TIER_RANK[theirs[0].tier] + 1 ? { mine, theirs } : null;
  };

  // The handover, in motion: your card lifts away toward the creature while
  // theirs drop toward your row; only once both are gone does the swap
  // re-render, and the arrivals pop into their new hands (.trade-arrived).
  // The flag walls off every card click until the exchange lands.
  let tradeAnimating = false;
  const executeTrade = (mine: WorldCard, theirs: WorldCard[]) => {
    if (tradeAnimating) return;
    tradeAnimating = true;
    handRowEl()?.querySelector(`[data-card-id="${mine.id}"]`)?.classList.add('trade-given');
    for (const t of theirs) {
      theirsRow.querySelector(`[data-card-id="${t.id}"]`)?.classList.add('trade-received');
    }
    realmSound('select', 0.9, 0.8);
    window.setTimeout(() => {
      tradeAnimating = false;
      meta.cards = meta.cards.filter((c) => c.id !== mine.id);
      cr.deck = cr.deck.filter((c) => !theirs.some((t) => t.id === c.id));
      meta.cards.push(...theirs);
      cr.deck.push(mine);
      saveMeta(meta);
      pickedTheirs.clear();
      pickedMine.clear();
      wireHand();
      render();
      for (const t of theirs) {
        handRowEl()?.querySelector(`[data-card-id="${t.id}"]`)?.classList.add('trade-arrived');
      }
      theirsRow.querySelector(`[data-card-id="${mine.id}"]`)?.classList.add('trade-arrived');
      // Winning your own world back is the realm's quiet climax; losing it
      // again gets its own line too. Ordinary trades land without a chime —
      // the card motion and the trader's line are the confirmation.
      if (theirs.some((t) => t.origin)) {
        realmSound('task_complete', 0.9, 1);
        sayLine('it remembers you.');
      } else if (mine.origin) {
        sayLine('kept warm. someone grew this one.');
      } else {
        sayLine(theirs.length === 2 ? "two for one. now it's a trade." : "now it's a trade.");
      }
    }, 680);
  };

  // A picked card wears a short, super-thick arrow pointing where it would
  // go if the trade seals: theirs point down toward your hand, yours point
  // up toward the trader. Pure indication — it shows whether or not the
  // basket currently balances (the verdict button judges that).
  const markPicked = (el: HTMLElement, picked: boolean, dir: 'down' | 'up'): void => {
    el.classList.toggle('selected', picked);
    const existing = el.querySelector(':scope > .ct-move-arrow');
    if (picked && !existing) el.appendChild(div(`ct-move-arrow ${dir}`));
    else if (!picked && existing) existing.remove();
  };

  // What the trader says, recomputed after every toggle.
  const speak = () => {
    const theirs = theirPicked();
    const mines = minePicked();
    if (theirs.length === 0 && mines.length === 0) {
      sayLine(APPETITE_LINE[cr.appetite]);
      return;
    }
    if (tradeReady()) { sayLine('a fair trade. seal it.'); return; }
    if (mines.length === 0) {
      sayLine(theirs.length === 1 ? 'and what will you give for it?'
        : theirs.length === 2 ? 'two of mine — show me one of the greater kind.'
        : 'i give two at most.');
      return;
    }
    if (theirs.length === 0) { sayLine('and which of mine would you have for that?'); return; }
    if (mines.length > 1) { sayLine('one of yours at a time.'); return; }
    if (theirs.length > 2) { sayLine('i give two at most.'); return; }
    if (theirs.length === 2) {
      sayLine(theirs[0].tier !== theirs[1].tier
        ? 'two of mine must be of a kind.'
        : 'two of mine are worth one of the greater kind.');
      return;
    }
    if (mines[0].tier !== theirs[0].tier) { sayLine('those are not of a kind. it does not balance.'); return; }
    sayLine('that one does not feed me. ' + APPETITE_LINE[cr.appetite]);
  };

  // Clicks on YOUR cards arrive from the persistent hand layer — the same
  // free in/out toggle as the trader's side.
  const onMineClick = (mc: WorldCard) => {
    if (tradeAnimating) return;
    if (pickedMine.has(mc.id)) {
      pickedMine.delete(mc.id);
    } else {
      pickedMine.add(mc.id);
      realmSound('select', 0.7, 1.1);
    }
    render();
    speak();
  };

  const wireHand = () => {
    renderHand(meta, {
      topEl: verdict,
      onCardClick: onMineClick,
      onAscended: () => {
        wireHand();
        render();
        speak();
      },
    });
  };

  const render = () => {
    theirsRow.innerHTML = '';
    for (const tc of cr.deck) {
      const el = buildCardEl(tc, {
        // Any trader card can be visited without owning it: a time-frozen,
        // look-don't-touch boot of their world.
        enterLabel: 'SPECTATE',
        onEnter: (cardEl) => { if (!tradeAnimating) void spectateWorld(tc, cardEl); },
        onClick: () => {
          if (tradeAnimating) return;
          if (pickedTheirs.has(tc.id)) {
            pickedTheirs.delete(tc.id);
          } else {
            pickedTheirs.add(tc.id);
            realmSound('select', 0.7, 1.1);
          }
          render();
          speak();
        },
      });
      markPicked(el, pickedTheirs.has(tc.id), 'down');
      theirsRow.appendChild(el);
    }

    // The hand persists across renders — the trade state rides on it as
    // the selected outline + the move arrow, nothing else.
    const row = handRowEl();
    if (row) {
      for (const el of [...row.children] as HTMLElement[]) {
        const mc = meta.cards.find((c) => c.id === Number(el.dataset.cardId));
        if (!mc) continue;
        markPicked(el, pickedMine.has(mc.id), 'up');
      }
    }

    // The verdict. Offering your whole hand for nothing gets its own line —
    // the realm never lets you walk away from the table empty-handed.
    const ready = tradeReady();
    const anyPicked = pickedTheirs.size > 0 || pickedMine.size > 0;
    const allMineForNothing = pickedTheirs.size === 0
      && pickedMine.size > 0 && pickedMine.size === meta.cards.length;
    verdict.classList.toggle('show', anyPicked);
    verdict.classList.toggle('ok', ready !== null);
    verdict.disabled = ready === null;
    verdict.textContent = !anyPicked ? ''
      : ready ? '✓ trade'
      : allMineForNothing ? 'this trade would give away all your cards'
      : 'bad trade';

    // Only the view's first render deals in staggered — re-renders driven
    // by selection clicks would otherwise replay the deal on every pick.
    if (firstDeal) {
      firstDeal = false;
      [...theirsRow.children].forEach((el, i) => {
        (el as HTMLElement).classList.add('dealt');
        (el as HTMLElement).style.setProperty('--deal-i', String(i));
      });
    }
  };

  verdict.addEventListener('click', () => {
    const ready = tradeReady();
    if (!ready || tradeAnimating) return;
    realmSound('click', 0.8, 1);
    executeTrade(ready.mine, ready.theirs);
  });

  let firstDeal = true;
  wireHand();
  render();
  const anyWanted = meta.cards.some((c) => appetiteAccepts(cr.appetite, c));
  sayLine(anyWanted ? APPETITE_LINE[cr.appetite] : 'you hold nothing i want. yet.');
}
