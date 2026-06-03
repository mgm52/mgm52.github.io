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
  Demon, GameState, Ghost, Goblin,
  appendLog, hellToWorld, pushDeathEffect, resurrectBob,
} from './state';

type Speaker = 'demon' | 'goblin' | 'bob';
type Seg = { t: string; em: boolean };

// Who is currently speaking in the live parlay, so the renderer can float the
// speech bubble above their head. Holds the live demon/ghost object (its hell
// coordinates are read each frame) or null when no line is on screen. The
// 'goblin' kind anchors to a living overworld goblin instead (Bob's barks).
export type ParlaySpeaker =
  | { kind: 'demon'; demon: Demon }
  | { kind: 'ghost'; ghost: Ghost }
  | { kind: 'goblin'; goblin: Goblin };
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

// How long a Bob bark lingers after the last character has typed out.
const BOB_BARK_HOLD_MS = 2200;
// Monotonic token so a newer bark supersedes an in-flight one — the older
// bark's typing/hold loop bails as soon as it's no longer the latest.
let bobBarkGen = 0;

// A quick, non-modal Bob bark in the overworld — same typed-out feel as the
// hell parlay, anchored above his head, but it never freezes the world or
// captures clicks (reusing the .rebuke class for the transparent click-wall
// and dropped dimmer). No-op while a real parlay is on screen; a newer bark
// simply replaces the current one mid-type.
export async function bobOverworldBark(state: GameState, bob: Goblin, text: string): Promise<void> {
  const els = getEls();
  if (!els) return;
  const { overlay, speech, lineEl } = els;
  if (overlay.classList.contains('visible') && !overlay.classList.contains('rebuke')) return;
  if (rebukeTimer !== null) { clearTimeout(rebukeTimer); rebukeTimer = null; }
  const gen = ++bobBarkGen;
  parlaySpeaker = { kind: 'goblin', goblin: bob };
  speech.className = 'bob';
  lineEl.innerHTML = '';
  overlay.classList.add('visible', 'speaking', 'rebuke');
  const segs = parseEmphasis(text);
  const total = segs.map((s) => s.t).join('').length;
  // Bail mid-type when superseded: by a newer bark, by a demon rebuke (which
  // arms rebukeTimer), or by a real parlay (which strips the .rebuke class).
  // In those cases the new owner drives the overlay, so just abandon it.
  const superseded = () =>
    gen !== bobBarkGen || rebukeTimer !== null || !overlay.classList.contains('rebuke');
  const teardown = () => {
    overlay.classList.remove('visible', 'speaking', 'rebuke');
    speech.className = '';
    lineEl.innerHTML = '';
    if (parlaySpeaker?.kind === 'goblin' && parlaySpeaker.goblin === bob) parlaySpeaker = null;
  };
  // Bob dying mid-bark removes him from state.goblins — nobody else owns the
  // overlay then, so tear it down rather than leaving a bubble pinned over
  // his corpse (or over a stale object if he's since been resurrected anew).
  const bobGone = () => state.goblins.get(bob.id) !== bob;
  for (let c = 1; c <= total; c++) {
    lineEl.innerHTML = renderTyped(segs, c);
    await sleep(TYPE_MS_PER_CHAR);
    if (superseded()) return;
    if (bobGone()) { teardown(); return; }
  }
  speech.classList.add('done');
  await sleep(BOB_BARK_HOLD_MS);
  if (superseded()) return;
  teardown();
}

// A regular goblin can only manage one of these.
const GIBBERISH = ['gleh', 'goink', 'grah', 'groh', 'gonk'];

// Non-bob, non-demon souls punctuate their babble at random — an excited "!",
// a flat ".", or a trailing "..." (which also earns the typed-out ellipsis
// hold, so the soul audibly trails off).
const GIBBERISH_SUFFIXES = ['!', '.', '...'];
function gibberishSuffix(): string {
  return GIBBERISH_SUFFIXES[Math.floor(Math.random() * GIBBERISH_SUFFIXES.length)];
}

// Minotaur souls slur the goblin babble with every letter doubled: "ggrroohh".
const doubleLetters = (s: string): string => s.replace(/[^ ]/g, (c) => c + c);

// The demon's brush-off when a soul can't speak his tongue — most of the time
// he hints that he wants a more articulate soul (the nudge toward sending Bob).
// The trailing ". . ." beat is spoken as its own line first (see call sites).
const DEMON_NO_LANGUAGE_LINES = [
  'i need a soul of more learned vocabulary',
  'i do not know this language',
  'bring me a goblin that knows of speech',
  'not this one',
];
function demonNoLanguageLine(): string {
  return DEMON_NO_LANGUAGE_LINES[Math.floor(Math.random() * DEMON_NO_LANGUAGE_LINES.length)];
}

const TYPE_MS_PER_CHAR = 42;
const POST_LINE_BUFFER_MS = 180;
// Extra beat held after each "." is typed, so an ellipsis ("...", ". . .")
// lands with a dramatic trailing-off pause rather than scrolling straight on.
const ELLIPSIS_PAUSE_MS = 260;

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

// Type a line into the bubble character-by-character (with the trailing-off
// hold on any ellipsis), mark it done, and let it breathe for a beat. The
// shared core of the parlay's say() and the soul-to-soul chat lines.
async function typeLineText(lineEl: HTMLElement, speech: HTMLElement, text: string): Promise<void> {
  const segs = parseEmphasis(text);
  const flat = segs.map((s) => s.t).join('');
  const total = flat.length;
  // Indices of the final dot of each ellipsis (a run of 2+ dots, allowing the
  // single spaces of ". . ."). We hold an extra beat there so the speaker
  // trails off before the line continues — the dots still patter out at
  // normal speed.
  const pauseAfter = new Set<number>();
  const ell = /\.(?: ?\.)+/g;
  for (let m = ell.exec(flat); m !== null; m = ell.exec(flat)) {
    pauseAfter.add(m.index + m[0].length - 1);
  }
  for (let c = 1; c <= total; c++) {
    lineEl.innerHTML = renderTyped(segs, c);
    await sleep(TYPE_MS_PER_CHAR);
    if (pauseAfter.has(c - 1)) await sleep(ELLIPSIS_PAUSE_MS);
  }
  speech.classList.add('done');
  await sleep(POST_LINE_BUFFER_MS);
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
    await typeLineText(lineEl, speech, text);
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

  // The demon trailing off in thought: spaced-out dots that linger, then a
  // beat of real silence (empty bubble) before he speaks again.
  async function ellipsisBeat(): Promise<void> {
    await say('demon', '. . .', { autoMs: 1200 });
    await sleep(650);
  }

  // The very first failed parlay ends with one extra nudge toward sending a
  // soul that can actually speak. Once per demon, ever (persisted).
  async function tryAnotherOnce(): Promise<void> {
    if (demon.hintedTryAnother) return;
    demon.hintedTryAnother = true;
    await say('demon', 'try another');
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
      // Bob has actually parlayed — clears the "talking goblins" nudge.
      state.bobParlayed = true;
      await say('bob', 'hello mate');
      await say('demon', 'a clumsy wield of language');
      await say('demon', 'have you *collected a dragon bone*?', { hold: true });
      const yes = await ask();
      if (!yes) {
        await say('demon', 'begone and be useful');
      } else if (state.dragonBone >= 1) {
        await ellipsisBeat();
        playSound('ritual', 0.85, 0.55);
        await say('demon', 'mmm');
        await say('demon', 'delicious. thank you my child');
        await say('demon', 'be witness to my gift');
        state.blood += 9999;
        appendLog(state, 'The demon grants Bob 9,999 blood.');
      } else {
        await ellipsisBeat();
        await say('demon', 'untruth');
        strikeGhostBack(state, ghost);
        resurrectBob(state);
      }
    } else if (ghost.kind === 'dragon') {
      // A dragon's soul can only roar at the demon.
      await say('goblin', `hhhhffffffffffffffffffff${gibberishSuffix()}`);
      await say('demon', '. . .');
      await say('demon', demonNoLanguageLine());
      await tryAnotherOnce();
    } else {
      // Goblins babble a random word; a minotaur (or tinytaur) soul mangles the
      // same word with every letter doubled — a lumbering "ggrroohh".
      const gib = GIBBERISH[Math.floor(Math.random() * GIBBERISH.length)];
      const word = ghost.kind === 'minotaur' ? doubleLetters(gib) : gib;
      await say('goblin', word + gibberishSuffix());
      await say('demon', '. . .');
      await say('demon', demonNoLanguageLine());
      await tryAnotherOnce();
    }
  } finally {
    parlaySpeaker = null;
    overlay.classList.remove('visible', 'speaking', 'click-armed', 'show-buttons');
    speech.className = '';
    lineEl.innerHTML = '';
  }
}

// Pause held on each chat line after it finishes typing, before the other
// soul replies. Lines auto-advance — the player is a spectator here, not a
// participant, so there's nothing to click through.
const CHAT_LINE_HOLD_MS = 650;

// Two souls commanded together for a chat (walk any ghost onto any other in
// the hell view). Neither can really talk, so they trade gibberish with the
// usual per-kind accents — minotaur souls slur, dragon souls roar — except
// Bob, ever articulate, who just says hello. Same frozen-world overlay
// machinery as the demon parlay; `a` is the walker and opens the exchange.
export async function runGhostChat(state: GameState, a: Ghost, b: Ghost): Promise<void> {
  const els = getEls();
  if (!els) return;
  const { overlay, speech, lineEl } = els;

  const lineFor = (g: Ghost): string => {
    if (g.bob) return 'hello';
    if (g.kind === 'dragon') return `hhhhffffffff${gibberishSuffix()}`;
    const gib = GIBBERISH[Math.floor(Math.random() * GIBBERISH.length)];
    return (g.kind === 'minotaur' ? doubleLetters(gib) : gib) + gibberishSuffix();
  };

  async function chatLine(g: Ghost): Promise<void> {
    parlaySpeaker = { kind: 'ghost', ghost: g };
    speech.className = g.bob ? 'bob' : 'goblin';
    lineEl.innerHTML = '';
    overlay.classList.add('speaking');
    await typeLineText(lineEl, speech, lineFor(g));
    await sleep(CHAT_LINE_HOLD_MS);
    overlay.classList.remove('speaking');
  }

  // Reset any leftover state and reveal the overlay. Cancel a lingering rebuke
  // bark so its timer can't tear down this chat's overlay mid-conversation.
  if (rebukeTimer !== null) { clearTimeout(rebukeTimer); rebukeTimer = null; }
  overlay.classList.remove('speaking', 'click-armed', 'show-buttons', 'rebuke');
  speech.className = '';
  lineEl.innerHTML = '';
  overlay.classList.add('visible');
  await sleep(60);

  appendLog(state, 'Two souls exchange pleasantries.');
  try {
    // One line each, the walker opening.
    await chatLine(a);
    await chatLine(b);
  } finally {
    parlaySpeaker = null;
    overlay.classList.remove('visible', 'speaking', 'click-armed', 'show-buttons');
    speech.className = '';
    lineEl.innerHTML = '';
  }
}
