// The demon parlay overlay. When a goblin ghost is walked up to a demon in the
// hell view, main.ts freezes the world and calls runDemonDialogue to drive this
// modal conversation. Regular goblins can only babble; Bob can actually
// converse, and a truthful Bob earns the player the secret settings menu.
//
// Lines type out one character at a time (reusing the intro's caret/typing
// feel). "*...*" wraps a phrase in demonic emphasis. Most lines wait for a
// click to advance; the dramatic "…" beats auto-advance after a short pause.

import { playSound, type SoundName } from './audio';
import { HELL } from './config';
import { getOptions } from './options';
import {
  Demon, DemonVariant, GameState, Ghost, Goblin,
  appendLog, hellToWorld, pushDeathEffect,
} from './state';

type Speaker = 'demon' | 'goblin' | 'bob';
type Seg = { t: string; em: boolean; white: boolean };

// ─── Demon voices ───────────────────────────────────────────────────
// Every demon line is authored in plain lowercase English and run through the
// speaker's voice at say-time. The pit colossus (demon R) BELLOWS IN ALL
// CAPS; demon L speaks entirely in reverse — the whole line flipped end to
// end, "what time?" coming out "?emit tahw" — so her lines are authored
// short enough to decode. Her corner-dwelling friend speaks plainly.
// Symmetric markup survives the flip: ". . ." beats read the same way, and
// *emphasis* pairs stay paired.
function backwardsSpeech(text: string): string {
  return [...text.toLowerCase()].reverse().join('');
}
function demonVoice(demon: Demon, text: string): string {
  const variant = demon.variant ?? 'pit';
  if (variant === 'pit') return text.toUpperCase();
  if (variant === 'friend') return text;
  return backwardsSpeech(text);
}

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

// True while a modal hell dialogue (demon parlay or soul-to-soul chat) is on
// screen — rebuke barks don't count. The renderer reads this each frame to
// drive the canvas-side parlay dim (which replaced the old DOM dim so the
// speaking units can stay undimmed).
export function isModalDialogueActive(): boolean {
  const els = getEls();
  return !!els
    && els.overlay.classList.contains('visible')
    && !els.overlay.classList.contains('rebuke');
}

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
  lineEl.textContent = demonVoice(demon, text);
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
const BOB_BARK_HOLD_MS = 4200;
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
// a flat ".", a puzzled "?", or a trailing "..." (which also earns the
// typed-out ellipsis hold, so the soul audibly trails off).
const GIBBERISH_SUFFIXES = ['!', '.', '...', '?'];
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

// "*...*" wraps a phrase in hellfire-red emphasis; "_..._" in the corner
// demon's pale white. Both markers toggle, so split on either and track which
// is open.
function parseEmphasis(text: string): Seg[] {
  const segs: Seg[] = [];
  let em = false;
  let white = false;
  for (const part of text.split(/([*_])/)) {
    if (part === '*') { em = !em; continue; }
    if (part === '_') { white = !white; continue; }
    if (part.length === 0) continue;
    segs.push({ t: part, em: em || white, white });
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
    html += seg.em ? `<em class="demon-em${seg.white ? ' white' : ''}">${part}</em>` : part;
    remaining -= take;
  }
  return html;
}

// How long a '⏸' marker holds the typing mid-line.
const MID_LINE_PAUSE_MS = 1000;

// The speaking demon's voice dials — each demon carries its own sample plus
// a volume/pitch/wobble triple so the three can sound distinct.
function demonVoiceDials(variant: DemonVariant): { sound: SoundName; volume: number; pitch: number; wobble: number } {
  const o = getOptions();
  return variant === 'l'
    ? { sound: o.demonLVoiceSound, volume: o.demonLVoiceVolume, pitch: o.demonLVoicePitch, wobble: o.demonLVoicePitchWobble }
    : variant === 'friend'
      ? { sound: o.demonFriendVoiceSound, volume: o.demonFriendVoiceVolume, pitch: o.demonFriendVoicePitch, wobble: o.demonFriendVoicePitchWobble }
      : { sound: o.demonRVoiceSound, volume: o.demonRVoiceVolume, pitch: o.demonRVoicePitch, wobble: o.demonRVoicePitchWobble };
}

// Type a line into the bubble character-by-character (with the trailing-off
// hold on any ellipsis), mark it done, and let it breathe for a beat. The
// shared core of the parlay's say() and the soul-to-soul chat lines.
// voice: which demon's low-pitched thud rumbles under the line, one per
// visible character (volume/pitch/wobble ride that demon's own dev dials);
// absent, the line types silently (souls).
// A '⏸' in the text renders nothing; typing just halts MID_LINE_PAUSE_MS
// after the preceding character (a silent mid-line beat).
async function typeLineText(
  lineEl: HTMLElement, speech: HTMLElement, text: string,
  opts: { voice?: DemonVariant } = {},
): Promise<void> {
  // Strip the pause markers, recording each one's position in the flat
  // (markup-free) text so the typing loop knows where to hold.
  const longPauseAfter = new Set<number>();
  let cleaned = '';
  let flatLen = 0;
  for (const ch of text) {
    if (ch === '⏸') { longPauseAfter.add(flatLen - 1); continue; }
    cleaned += ch;
    if (ch !== '*' && ch !== '_') flatLen++;
  }
  const segs = parseEmphasis(cleaned);
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
    // Pitch wobbles a little per character so the rumble reads as a voice
    // rather than a metronome; spaces stay silent. Volume/pitch/wobble ride
    // the speaking demon's own dev dials.
    if (opts.voice !== undefined) {
      const v = demonVoiceDials(opts.voice);
      if (v.volume > 0 && /\S/.test(flat[c - 1])) {
        playSound(v.sound, v.volume, v.pitch + Math.random() * v.wobble);
      }
    }
    await sleep(TYPE_MS_PER_CHAR);
    if (pauseAfter.has(c - 1)) await sleep(ELLIPSIS_PAUSE_MS);
    if (longPauseAfter.has(c - 1)) await sleep(MID_LINE_PAUSE_MS);
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
  // Third answer button — hidden except while a three-way question is on
  // screen.
  opt3Btn: HTMLButtonElement;
  // 0–23 grid for demon L's what-hour-is-it quiz; buttons created lazily.
  hoursEl: HTMLElement;
  clickWall: HTMLElement;
};

function getEls(): Els | null {
  const overlay = document.getElementById('demon-overlay');
  const speech = document.getElementById('demon-speech');
  const speaker = document.getElementById('demon-speaker');
  const lineEl = document.getElementById('demon-line');
  const yesBtn = document.getElementById('demon-yes') as HTMLButtonElement | null;
  const noBtn = document.getElementById('demon-no') as HTMLButtonElement | null;
  const opt3Btn = document.getElementById('demon-opt3') as HTMLButtonElement | null;
  const hoursEl = document.getElementById('demon-hours');
  const clickWall = document.getElementById('demon-clickwall');
  if (!overlay || !speech || !speaker || !lineEl || !yesBtn || !noBtn || !opt3Btn || !hoursEl || !clickWall) return null;
  return { overlay, speech, speaker, lineEl, yesBtn, noBtn, opt3Btn, hoursEl, clickWall };
}

function waitForClick(target: HTMLElement): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => { target.removeEventListener('click', finish); resolve(); };
    target.addEventListener('click', finish, { once: true });
  });
}

// Resolves with the index of whichever button gets clicked first.
function waitForOption(buttons: HTMLButtonElement[]): Promise<number> {
  return new Promise((resolve) => {
    const handlers: (() => void)[] = [];
    const cleanup = () => {
      buttons.forEach((b, i) => b.removeEventListener('click', handlers[i]));
    };
    buttons.forEach((b, i) => {
      const fn = () => { cleanup(); resolve(i); };
      handlers.push(fn);
      b.addEventListener('click', fn);
    });
  });
}

// White hell flash where Bob stood + a thunderclap, then hurl his soul back
// to the centre of hell — the demon's "untruth" punishment. (He used to be
// cast all the way back to the overworld; now it's basically a teleport.)
// The ghost vanishes here and stays gone for HELL.bobRespawnDelaySec; the
// respawn pass at the top of tickGhosts (sim.ts) re-materialises him at the
// centre with his own landing flash once the timer runs out.
function strikeGhostToCentre(state: GameState, ghost: Ghost): void {
  const w = (ghost.hx !== undefined && ghost.hy !== undefined)
    ? hellToWorld(ghost.hx, ghost.hy)
    : { x: ghost.x, y: ghost.y };
  pushDeathEffect(state, w.x, w.y, true, true);
  playSound('destroy', 0.7, 0.5);
  // Pre-place him at the centre so the respawn only has to unhide him. (If
  // the centre is inside a demon, the per-tick shove ejects him to its rim —
  // see shoveGhostOffDemons.)
  ghost.hx = HELL.width / 2;
  ghost.hy = HELL.height / 2;
  ghost.respawnAt = state.now + HELL.bobRespawnDelaySec;
  // Drop any in-flight command and re-anchor his idle pacing at the new spot.
  ghost.goal = undefined;
  ghost.parlayDemonId = undefined;
  ghost.targetChairId = undefined;
  ghost.chatTargetId = undefined;
  ghost.paceAnchorX = ghost.hx;
  ghost.pacePauseUntil = undefined;
  appendLog(state, 'The demon hurls Bob back into the depths of hell.');
}

export async function runDemonDialogue(state: GameState, demon: Demon, ghost: Ghost): Promise<void> {
  const els = getEls();
  if (!els) return;
  const { overlay, speech, lineEl, yesBtn, noBtn, opt3Btn, clickWall } = els;

  // autoMs: auto-advance after typing instead of waiting for a click.
  // hold: leave the line on screen (no click/auto, speech stays visible) — used
  // for the question line so it remains readable while the answer buttons show.
  // literal: skip the demon's voice transform — the text is already authored
  // exactly as it should display (used for Lilly's Bob script, where only
  // hand-picked phrases are reversed).
  // Demon lines otherwise pass through the speaking demon's voice (ALL CAPS
  // for the colossus, end-to-end reversal for L, plain speech for her corner
  // friend) on the way to the bubble.
  async function say(who: Speaker, text: string, opts: { autoMs?: number; hold?: boolean; literal?: boolean } = {}): Promise<void> {
    // Anchor the speech bubble over whoever's talking: the demon for its lines,
    // the approaching soul for goblin/bob lines.
    parlaySpeaker = who === 'demon' ? { kind: 'demon', demon } : { kind: 'ghost', ghost };
    speech.className = who;            // colour by speaker (also clears prior state)
    lineEl.innerHTML = '';
    overlay.classList.add('speaking');
    await typeLineText(
      lineEl, speech,
      who === 'demon' && !opts.literal ? demonVoice(demon, text) : text,
      { voice: who === 'demon' ? demon.variant ?? 'pit' : undefined },
    );
    if (opts.hold) return;            // keep the line up; caller drives what's next
    if (opts.autoMs !== undefined) {
      await sleep(opts.autoMs);
    } else {
      overlay.classList.add('click-armed');
      await waitForClick(clickWall);
      playSound('click', 0.29, 0.9);
      overlay.classList.remove('click-armed');
    }
    overlay.classList.remove('speaking');
  }

  // Present 2–3 answer buttons and resolve with the picked index. The third
  // button only appears for three-way questions.
  async function choose(labels: string[]): Promise<number> {
    const buttons = [yesBtn, noBtn, opt3Btn].slice(0, labels.length);
    buttons.forEach((b, i) => { b.querySelector('.build-name')!.textContent = labels[i]; });
    opt3Btn.style.display = labels.length >= 3 ? '' : 'none';
    overlay.classList.add('show-buttons');
    const idx = await waitForOption(buttons);
    playSound('click', 0.8, 1);
    overlay.classList.remove('show-buttons');
    opt3Btn.style.display = 'none';
    await sleep(200);
    return idx;
  }

  async function ask(): Promise<boolean> {
    return (await choose(['YES', 'NO'])) === 0;
  }

  // Demon L's clock quiz: a 6×4 grid of every hour (0–23). Resolves with the
  // clicked hour. Buttons are built once and reused across parlays.
  async function chooseHour(): Promise<number> {
    const { hoursEl } = els!;
    if (hoursEl.children.length === 0) {
      for (let h = 0; h < 24; h++) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'build-button';
        const content = document.createElement('div');
        content.className = 'build-content';
        const name = document.createElement('div');
        name.className = 'build-name';
        name.textContent = String(h);
        content.appendChild(name);
        b.appendChild(content);
        hoursEl.appendChild(b);
      }
    }
    overlay.classList.add('show-hours');
    const hour = await waitForOption([...hoursEl.children] as HTMLButtonElement[]);
    playSound('click', 0.8, 1);
    overlay.classList.remove('show-hours');
    await sleep(200);
    return hour;
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

  // The "speak to me" greeting only ever plays the first time a soul
  // approaches the colossus. Demon L instead opens every conversation with
  // Bob with her backwards "darling. . ." (". . .gnilrad") — anyone else is
  // dismissed unGreeted — and her corner friend opens with a plain-spoken
  // "little one. . .".
  const greet = !demon.greeted;
  demon.greeted = true;
  const variant = demon.variant ?? 'pit';

  // The soul's own opener: Bob can actually speak; a dragon's soul can only
  // roar; everything else babbles a random word (minotaur souls slurring it
  // with every letter doubled — a lumbering "ggrroohh").
  async function soulOpener(): Promise<void> {
    if (ghost.bob) {
      // Bob has actually parlayed — clears the "talking goblins" nudge.
      state.bobParlayed = true;
      await say('bob', 'hello mate');
      return;
    }
    if (ghost.kind === 'dragon') {
      await say('goblin', `hhhhffffffffffffffffffff${gibberishSuffix()}`);
      return;
    }
    const gib = GIBBERISH[Math.floor(Math.random() * GIBBERISH.length)];
    const word = ghost.kind === 'minotaur' ? doubleLetters(gib) : gib;
    await say('goblin', word + gibberishSuffix());
  }

  // The brush-off for a soul that can't speak the tongue — shared by all
  // three demons (each in its own voice), with the once-ever "try another"
  // nudge after this demon's first failed parlay.
  async function noLanguage(): Promise<void> {
    await say('demon', '. . .');
    await say('demon', demonNoLanguageLine());
    await tryAnotherOnce();
  }

  try {
    if (variant === 'friend') {
      // Demon L's friend — stationed alone in the corner of the abyss. Any
      // soul that comes to visit counts as "speaking to the friend" (this
      // demon's `greeted` flag is the truth demon L's friend-question is
      // judged against). With Bob she pries gently at his servitude; he has
      // no good answers, so every choice lands in the same place. She only
      // says her piece once — anyone calling again is sent away.
      if (demon.toldOfGolf) {
        await say('demon', 'tell the others we talked of golf');
      } else {
        await say('demon', 'hate');
        await say('demon', 'hate');
        await say('demon', 'hate');
        await soulOpener();
        if (ghost.bob) {
          await say('demon', 'does your "master" treat you well', { hold: true });
          await choose(['I DO', "I DO NOT"]); // either answer; Bob can't commit
          await say('bob', ". . .⏸ i don't know");
          await say('demon', 'quietly');
          await say('demon', 'quietly');
          await say('demon', 'what was your "life"', { hold: true });
          await choose(['BUILDING', 'TALKING']);  // Bob has nothing, either way
          await say('bob', ". . .⏸ i don't remember.");
          await ellipsisBeat();
          await say('demon', 'do you, too, wish to *"leave"*?');
          // Bob's answer is silence — the same lingering trail-off beat as
          // the demons' own ". . ." lines.
          await say('bob', '. . .', { autoMs: 1200 });
          await sleep(650);
          await say('demon', 'tell the others we talked of golf');
          demon.toldOfGolf = true;
        } else {
          await say('demon', '. . .');
          await say('demon', 'i do not know your words');
        }
      }
    } else if (variant === 'l') {
      // Demon L — the half-size demon across the abyss.
      if (!ghost.bob) {
        // A soul without the tongue gets no audience: it babbles its piece,
        // she dismisses it (".em evael") — no greeting, no shared brush-off.
        await soulOpener();
        await say('demon', 'leave me.');
      } else if (
        [...state.demons.values()].some((d) => d.variant === 'friend' && d.toldOfGolf)
      ) {
        // Once Bob has heard the corner demon's whole piece (and her "tell
        // the others we talked of golf" coaching), the alibi supersedes the
        // hour quiz: Lilly demands to know where he's been, Bob over-explains
        // his birdie, and after a pause she rules that he needs more Work —
        // and hands down three optional tasks (gated in ui.ts's TASKS via
        // state.lillyTasksGiven). Every visit after the handout gets only the
        // curt "get back to kroW" — her one word that slips back into her
        // reversed tongue. A save that heard the old alibi beat before the
        // handout existed skips straight to the ruling.
        state.bobParlayed = true;
        if (demon.heardOfGolf && state.lillyTasksGiven) {
          await say('demon', 'get back to kroW', { literal: true });
        } else {
          if (!demon.heardOfGolf) {
            await say('demon', 'where have you been, darling?', { literal: true });
            await say('bob', 'i achieved score of 1 stroke under par on a hole, colloquially known as a birdie, on a beautiful green lawn of plentiful sporting delight');
            await sleep(900);   // her pause, taking that in
            demon.heardOfGolf = true;
          }
          await say('demon', 'you need more Work', { literal: true });
          state.lillyTasksGiven = true;
          appendLog(state, 'Lilly hands down new optional Work: destroy a robot · fully feed a hell core · prevent goblin spawning.');
        }
      } else {
        // Bob's standing appointment, repeated on every visit: she reads off
        // his absurd task backlog, quizzes him on the real-world hour, and
        // docks the count by one per correct answer. Her lines here are
        // authored literal — mostly forward, with only the question and the
        // corner warning hand-reversed ("what hour is now?" / "talk to the
        // one in the corner.").
        await soulOpener();
        await say('demon', 'darling. . .', { literal: true });
        const tasks = demon.taskCount ?? 999_999_845;
        await say('demon', `you have ${tasks} tasks⏸ unfulfilled.`, { literal: true });
        await say('demon', '?won si ruoh tahw', { hold: true, literal: true });
        const pick = await chooseHour();
        const h12 = pick % 12 === 0 ? 12 : pick % 12;
        await say('bob', `it's ${h12} ${pick < 12 ? 'am' : 'pm'}`);
        if (pick === new Date().getHours()) {
          demon.taskCount = tasks - 1;
          await say('demon', `${tasks - 1}.`, { literal: true });
          await say('demon', 'do your Work.', { literal: true });
          await say('demon', "do⏸ *not*⏸ .nomed renroc tisiv", { literal: true });
        } else {
          await say('demon', 'no.', { literal: true });
        }
      }
    } else {
      // The pit colossus — demon R, who bellows in ALL CAPS.
      if (greet) await say('demon', 'speak to me, damned soul');
      await soulOpener();
      if (ghost.bob) {
        await say('demon', 'a clumsy wield of language');
        await say('demon', 'have you *collected 5 dragon bones*?', { hold: true });
        const yes = await ask();
        if (!yes) {
          await say('demon', 'begone and be useful');
        } else if (state.dragonBone >= 5) {
          // He takes the bones — the gift is a trade, not a blessing. The
          // completed trade is one of the three beats behind Bob & Lolly's
          // quiet exit from hell (see maybeDepartBobAndLolly in sim.ts).
          demon.boneGiftGiven = true;
          state.dragonBone -= 5;
          await ellipsisBeat();
          playSound('ritual', 0.85, 0.55);
          await say('demon', 'mmm');
          await say('demon', 'delicious. thank you my child');
          await say('demon', 'be witness to my gift');
          // Exactly the closing task's target (collect_blood in ui.ts).
          state.blood += 9_999_999;
          appendLog(state, 'The demon devours 5 dragon bones and grants Bob 9,999,999 blood.');
        } else {
          await ellipsisBeat();
          await say('demon', 'untruth');
          strikeGhostToCentre(state, ghost);
        }
      } else {
        await noLanguage();
      }
    }
  } finally {
    parlaySpeaker = null;
    overlay.classList.remove('visible', 'speaking', 'click-armed', 'show-buttons');
    opt3Btn.style.display = 'none';
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
