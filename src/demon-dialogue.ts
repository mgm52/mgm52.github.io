// The demon parlay overlay. When a goblin ghost is walked up to a demon in the
// hell view, main.ts freezes the world and calls runDemonDialogue to drive this
// modal conversation. Regular goblins can only babble; Bob can actually
// converse, and a truthful Bob earns the player the secret settings menu.
//
// Lines type out one character at a time (reusing the intro's caret/typing
// feel). "*...*" wraps a phrase in demonic emphasis. Most lines wait for a
// click to advance; the dramatic "…" beats auto-advance after a short pause.

import { playSound } from './audio';
import {
  Demon, GameState, Ghost,
  appendLog, hellToWorld, pushDeathEffect, resurrectBob,
} from './state';
import { revealSecretSettings } from './ui';

type Speaker = 'demon' | 'goblin' | 'bob';
type Seg = { t: string; em: boolean };

// Who is currently speaking in the live parlay, so the renderer can float the
// speech bubble above their head. Holds the live demon/ghost object (its hell
// coordinates are read each frame) or null when no line is on screen.
export type ParlaySpeaker =
  | { kind: 'demon'; demon: Demon }
  | { kind: 'ghost'; ghost: Ghost };
let parlaySpeaker: ParlaySpeaker | null = null;
export function getParlaySpeaker(): ParlaySpeaker | null { return parlaySpeaker; }

let rebukeTimer: number | null = null;
const REBUKE_MS = 1700;
// A quick, non-modal demon bark — used to refuse a crowd ("one at a time
// please") without opening a full parlay. Unlike runDemonDialogue it never
// freezes the world or captures clicks (the .rebuke class keeps the click-wall
// transparent and drops the dimmer); the line just flashes above the demon's
// head for a beat. No-op if a real parlay is already on screen.
export function demonRebuke(demon: Demon, text: string): void {
  const els = getEls();
  if (!els) return;
  const { overlay, speech, lineEl } = els;
  if (overlay.classList.contains('visible') && !overlay.classList.contains('rebuke')) return;
  if (rebukeTimer !== null) { clearTimeout(rebukeTimer); rebukeTimer = null; }
  parlaySpeaker = { kind: 'demon', demon };
  speech.className = 'demon';
  lineEl.textContent = text;
  speech.classList.add('done');               // no caret — it's an instant bark
  overlay.classList.add('visible', 'speaking', 'rebuke');
  rebukeTimer = window.setTimeout(() => {
    overlay.classList.remove('visible', 'speaking', 'rebuke');
    speech.className = '';
    lineEl.innerHTML = '';
    if (parlaySpeaker?.kind === 'demon' && parlaySpeaker.demon === demon) parlaySpeaker = null;
    rebukeTimer = null;
  }, REBUKE_MS);
}

// A regular goblin can only manage one of these.
const GIBBERISH = ['gleh', 'goink', 'grah', 'groh', 'gonk'];

const TYPE_MS_PER_CHAR = 42;
const POST_LINE_BUFFER_MS = 180;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Split on "*" so odd-indexed chunks render emphasised.
function parseEmphasis(text: string): Seg[] {
  const segs: Seg[] = [];
  const parts = text.split('*');
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].length === 0) continue;
    segs.push({ t: parts[i], em: i % 2 === 1 });
  }
  return segs;
}

// HTML for the first `count` characters across all segments, wrapping each
// emphasised slice in its own <em> so a phrase mid-type still styles correctly.
function renderTyped(segs: Seg[], count: number): string {
  let html = '';
  let remaining = count;
  for (const seg of segs) {
    if (remaining <= 0) break;
    const take = Math.min(seg.t.length, remaining);
    const part = escapeHtml(seg.t.slice(0, take));
    html += seg.em ? `<em class="demon-em">${part}</em>` : part;
    remaining -= take;
  }
  return html;
}

type Els = {
  overlay: HTMLElement;
  speech: HTMLElement;
  speaker: HTMLElement;
  lineEl: HTMLElement;
  yesBtn: HTMLButtonElement;
  noBtn: HTMLButtonElement;
  clickWall: HTMLElement;
};

function getEls(): Els | null {
  const overlay = document.getElementById('demon-overlay');
  const speech = document.getElementById('demon-speech');
  const speaker = document.getElementById('demon-speaker');
  const lineEl = document.getElementById('demon-line');
  const yesBtn = document.getElementById('demon-yes') as HTMLButtonElement | null;
  const noBtn = document.getElementById('demon-no') as HTMLButtonElement | null;
  const clickWall = document.getElementById('demon-clickwall');
  if (!overlay || !speech || !speaker || !lineEl || !yesBtn || !noBtn || !clickWall) return null;
  return { overlay, speech, speaker, lineEl, yesBtn, noBtn, clickWall };
}

function waitForClick(target: HTMLElement): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => { target.removeEventListener('click', finish); resolve(); };
    target.addEventListener('click', finish, { once: true });
  });
}

// Resolves true for YES, false for NO.
function waitForChoice(yesBtn: HTMLButtonElement, noBtn: HTMLButtonElement): Promise<boolean> {
  return new Promise((resolve) => {
    const onYes = () => { cleanup(); resolve(true); };
    const onNo = () => { cleanup(); resolve(false); };
    const cleanup = () => {
      yesBtn.removeEventListener('click', onYes);
      noBtn.removeEventListener('click', onNo);
    };
    yesBtn.addEventListener('click', onYes);
    noBtn.addEventListener('click', onNo);
  });
}

// White hell flash where Bob stood + a thunderclap, then yank his ghost out of
// the underworld (he's cast back to the overworld by resurrectBob).
function strikeGhostBack(state: GameState, ghost: Ghost): void {
  const w = (ghost.hx !== undefined && ghost.hy !== undefined)
    ? hellToWorld(ghost.hx, ghost.hy)
    : { x: ghost.x, y: ghost.y };
  pushDeathEffect(state, w.x, w.y, true, true);
  playSound('destroy', 0.7, 0.5);
  const i = state.ghosts.findIndex((g) => g.id === ghost.id);
  if (i >= 0) state.ghosts.splice(i, 1);
}

export async function runDemonDialogue(state: GameState, demon: Demon, ghost: Ghost): Promise<void> {
  const els = getEls();
  if (!els) return;
  const { overlay, speech, lineEl, yesBtn, noBtn, clickWall } = els;

  // autoMs: auto-advance after typing instead of waiting for a click.
  // hold: leave the line on screen (no click/auto, speech stays visible) — used
  // for the question line so it remains readable while the YES/NO buttons show.
  async function say(who: Speaker, text: string, opts: { autoMs?: number; hold?: boolean } = {}): Promise<void> {
    // Anchor the speech bubble over whoever's talking: the demon for its lines,
    // the approaching soul for goblin/bob lines.
    parlaySpeaker = who === 'demon' ? { kind: 'demon', demon } : { kind: 'ghost', ghost };
    speech.className = who;            // colour by speaker (also clears prior state)
    lineEl.innerHTML = '';
    overlay.classList.add('speaking');
    const segs = parseEmphasis(text);
    const total = segs.reduce((n, s) => n + s.t.length, 0);
    for (let c = 1; c <= total; c++) {
      lineEl.innerHTML = renderTyped(segs, c);
      await sleep(TYPE_MS_PER_CHAR);
    }
    speech.classList.add('done');
    await sleep(POST_LINE_BUFFER_MS);
    if (opts.hold) return;            // keep the line up; caller drives what's next
    if (opts.autoMs !== undefined) {
      await sleep(opts.autoMs);
    } else {
      overlay.classList.add('click-armed');
      await waitForClick(clickWall);
      playSound('click', 0.6, 0.9);
      overlay.classList.remove('click-armed');
    }
    overlay.classList.remove('speaking');
  }

  async function ask(): Promise<boolean> {
    yesBtn.querySelector('.build-name')!.textContent = 'YES';
    noBtn.querySelector('.build-name')!.textContent = 'NO';
    overlay.classList.add('show-buttons');
    const yes = await waitForChoice(yesBtn, noBtn);
    playSound('click', 0.8, 1);
    overlay.classList.remove('show-buttons');
    await sleep(200);
    return yes;
  }

  // Reset any leftover state and reveal the overlay. Cancel a lingering rebuke
  // bark so its timer can't tear down this parlay's overlay mid-conversation.
  if (rebukeTimer !== null) { clearTimeout(rebukeTimer); rebukeTimer = null; }
  overlay.classList.remove('speaking', 'click-armed', 'show-buttons', 'rebuke');
  speech.className = '';
  lineEl.innerHTML = '';
  overlay.classList.add('visible');
  await sleep(60);

  // The greeting only ever plays the first time a soul approaches this demon.
  const greet = !demon.greeted;
  demon.greeted = true;

  try {
    if (greet) await say('demon', 'speak to me, damned soul');

    if (ghost.bob) {
      await say('bob', 'hello mate');
      await say('demon', 'a clumsy wield of language');
      await say('demon', 'have you *slain two dragons in one strike*?', { hold: true });
      const yes = await ask();
      if (!yes) {
        await say('demon', 'begone and be useful');
      } else if (state.slewTwoDragonsInOneStrike) {
        await say('demon', '…', { autoMs: 900 });
        await say('demon', '…', { autoMs: 900 });
        playSound('ritual', 0.85, 0.55);
        await say('demon', 'mmm');
        await say('demon', 'delicious. thank you my child');
        await say('demon', 'be witness to my gift');
        appendLog(state, 'The demon bestows a gift upon Bob.');
        if (!state.optionsUnlocked) revealSecretSettings(state);
      } else {
        await say('demon', '…', { autoMs: 900 });
        await say('demon', '…', { autoMs: 900 });
        await say('demon', 'untruth');
        strikeGhostBack(state, ghost);
        resurrectBob(state);
      }
    } else {
      const gib = GIBBERISH[Math.floor(Math.random() * GIBBERISH.length)];
      await say('goblin', gib);
      await say('demon', '… i do not know this language');
    }
  } finally {
    parlaySpeaker = null;
    overlay.classList.remove('visible', 'speaking', 'click-armed', 'show-buttons');
    speech.className = '';
    lineEl.innerHTML = '';
  }
}
