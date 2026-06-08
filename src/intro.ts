// First-time-only intro sequence: a goblin slides up from the bottom (back
// to the camera), turns to face the player, and delivers a short monologue
// about not knowing how to play. Each line types out one character at a time
// in yellow; the player clicks to advance.
//
// "(…)" inside speech text = mid-line 1.5s pause (the literal characters are
// not rendered). A standalone pause step in the script is a pure between-line
// pause. Choice steps surface a row of buttons (currently YES/NO) — each
// option carries its own follow-up line. "exit" is the slide-out cue: the
// goblin turns East and walks off to the right.
//
// runIntro() resolves once the goblin has slid back out, so the caller can
// chain the panel/task fade-in onto the same promise.

import { playSound } from './audio';

type IntroChoice = { label: string; nextLine: string };
type IntroStep =
  | { kind: 'speak'; text: string }
  | { kind: 'pause'; ms: number }
  | { kind: 'choice'; choices: IntroChoice[] }
  | { kind: 'face'; row: number }
  | { kind: 'exit' };

const SCRIPT: IntroStep[] = [
  { kind: 'speak', text: 'hello' },
  { kind: 'speak', text: 'do you want to (…) know how to play' },
  { kind: 'choice', choices: [
    { label: 'YES', nextLine: 'me too' },
    { label: 'NO',  nextLine: "that's good because i have no idea" },
  ]},
  { kind: 'pause', ms: 3000 },
  // Glance off toward the screen's bottom-right corner (SE = row 3) on the
  // self-doubt line, then snap back to face camera for the sign-off.
  { kind: 'face', row: 3 },
  { kind: 'speak', text: "i've been clicking around for ages but i don't know how to play i've been trying to figure it out but i think i just don't have the executive mindset for it" },
  { kind: 'pause', ms: 3000 },
  { kind: 'face', row: 4 },
  { kind: 'speak', text: 'good luck' },
  { kind: 'exit' },
];

const TYPE_MS_PER_CHAR = 45;
const MID_LINE_PAUSE_MS = 1500;
// Held after the last character of a line types out before the click wall
// arms — prevents an over-eager click from advancing the dialog the instant
// the line completes.
const POST_LINE_BUFFER_MS = 200;
// Slow rise on the way in; quicker walk-off on the way out.
const SLIDE_UP_MS = 6000;
const SLIDE_OUT_MS = 2200;
// East-facing sprite row, used to turn the goblin toward the right edge just
// before it walks off.
const EXIT_FACING_ROW = 2;
// Beat between landing at the top and starting to turn around. Gives the
// rise its own moment before the goblin pivots to address the player.
const POST_SLIDE_BEAT_MS = 1200;
// Time per frame as the goblin rotates from row 0 (back) toward row 4
// (facing camera) via rows 1, 2, 3. Five frames including the start, so
// the visible turn takes TURN_STEP_MS × 4.
const TURN_STEP_MS = 220;
// Heading row indices for the turn animation. 0=N (back), 4=S (facing
// camera). Clockwise: 0 → 1 (NE) → 2 (E) → 3 (SE) → 4 (S).
const TURN_SEQUENCE = [0, 1, 2, 3, 4] as const;

// Pausable sleep: the global pause toggle (main.ts) calls setIntroPaused()
// to freeze every outstanding sleep — the timer is cleared, its remaining
// time tracked, and re-armed on resume. Without this, dialog typing, the
// turn-around step, and the inter-line waits would all blow past the pause
// overlay because they're driven by setTimeout, not by the game's tick loop.
let introPaused = false;
type PendingSleep = {
  remaining: number;
  startedAt: number;
  timerId: number | null;
  resolve: () => void;
};
const pendingSleeps = new Set<PendingSleep>();

// True while the whole new-game intro sequence (free-click preamble →
// cutscene → staggered reveals) is running. skipIntro() is a no-op outside
// this window so a stray click on the dev button does nothing on resumed
// games.
let introActive = false;
// Flipped by skipIntro() (the dev "Work skip" button). Every pausable sleep
// and the click/choice waits resolve immediately, the cutscene tears down,
// and playIntroSequence() jumps straight to the panel reveals.
let introAborted = false;
// Resolvers parked on a user click/choice — fired by skipIntro() so the
// dialog doesn't stay stuck waiting for input that's being skipped past.
const abortListeners = new Set<() => void>();

const sleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    if (introAborted) { resolve(); return; }
    const entry: PendingSleep = {
      remaining: ms,
      startedAt: 0,
      timerId: null,
      resolve: () => {
        pendingSleeps.delete(entry);
        resolve();
      },
    };
    pendingSleeps.add(entry);
    if (!introPaused) {
      entry.startedAt = Date.now();
      entry.timerId = window.setTimeout(entry.resolve, entry.remaining);
    }
  });

export function setIntroPaused(paused: boolean): void {
  if (paused === introPaused) return;
  introPaused = paused;
  for (const entry of pendingSleeps) {
    if (paused) {
      if (entry.timerId !== null) {
        window.clearTimeout(entry.timerId);
        entry.timerId = null;
        entry.remaining = Math.max(0, entry.remaining - (Date.now() - entry.startedAt));
      }
    } else if (entry.timerId === null) {
      entry.startedAt = Date.now();
      entry.timerId = window.setTimeout(entry.resolve, entry.remaining);
    }
  }
  // Freezes the goblin idle bob, the slide-up/down animations, and the
  // speech caret blink. See body.intro-paused rules in index.html.
  document.body.classList.toggle('intro-paused', paused);
}

// Cut the intro short. Wired to the dev "Work skip" button so skipping the
// first task also skips the goblin cutscene rather than leaving the player
// stuck behind it. No-op unless the sequence is mid-flight.
export function skipIntro(): void {
  if (!introActive || introAborted) return;
  introAborted = true;
  // Resolve every outstanding pausable sleep now (typing, between-line waits,
  // the slide-up / turn animations).
  for (const entry of [...pendingSleeps]) {
    if (entry.timerId !== null) { window.clearTimeout(entry.timerId); entry.timerId = null; }
    entry.resolve();
  }
  // Release any click/choice wait the dialog is parked on.
  for (const cb of [...abortListeners]) cb();
}

// Instant, animation-free dismissal used when the intro is skipped mid-run —
// strips every overlay state class so the cutscene vanishes immediately.
function teardownIntro(
  overlay: HTMLElement, speechEl: HTMLElement,
  yesBtn: HTMLButtonElement, noBtn: HTMLButtonElement,
  clickWall: HTMLElement,
): void {
  overlay.classList.remove('visible', 'up', 'exit', 'faced', 'speaking', 'click-armed', 'show-buttons');
  document.body.classList.remove('intro-cutscene-hold');
  clickWall.style.pointerEvents = '';
  speechEl.textContent = '';
  speechEl.classList.remove('done');
  yesBtn.hidden = true;
  noBtn.hidden = true;
}

function waitForClick(target: HTMLElement): Promise<void> {
  return new Promise((resolve) => {
    if (introAborted) { resolve(); return; }
    const finish = () => {
      target.removeEventListener('click', finish);
      abortListeners.delete(finish);
      resolve();
    };
    abortListeners.add(finish);
    target.addEventListener('click', finish, { once: true });
  });
}

// Resolves with the index of the clicked button. The losing button(s) get
// their click listener pulled when one resolves so a stale click on a hidden
// button can't fire after the row has been dismissed.
function waitForChoice(buttons: HTMLButtonElement[]): Promise<number> {
  return new Promise((resolve) => {
    if (introAborted) { resolve(0); return; }
    const handlers: Array<() => void> = [];
    const cleanup = () => {
      for (let j = 0; j < buttons.length; j++) {
        buttons[j].removeEventListener('click', handlers[j]);
      }
      abortListeners.delete(onAbort);
    };
    const onAbort = () => { cleanup(); resolve(0); };
    buttons.forEach((btn, i) => {
      const handler = () => { cleanup(); resolve(i); };
      handlers.push(handler);
      btn.addEventListener('click', handler);
    });
    abortListeners.add(onAbort);
  });
}

// Splits a speak line into segments separated by literal "(…)" markers. The
// dialog typer renders each segment in order, with MID_LINE_PAUSE_MS between
// them. Whitespace flanking the marker is trimmed so "to (…) know" reads as
// "to know" with a clean pause in the middle.
function splitOnPauseMarkers(text: string): string[] {
  return text
    .split(/\s*\(…\)\s*/g)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function typeLine(speechEl: HTMLElement, text: string) {
  speechEl.classList.remove('done');
  const segments = splitOnPauseMarkers(text);
  let rendered = '';
  for (let s = 0; s < segments.length; s++) {
    if (s > 0) {
      rendered += ' ';
      speechEl.textContent = rendered;
      await sleep(MID_LINE_PAUSE_MS);
    }
    const seg = segments[s];
    for (let i = 0; i < seg.length; i++) {
      rendered += seg[i];
      speechEl.textContent = rendered;
      await sleep(TYPE_MS_PER_CHAR);
    }
  }
  speechEl.classList.add('done');
}

async function runSpeak(
  overlay: HTMLElement,
  speechEl: HTMLElement,
  clickWall: HTMLElement,
  text: string,
) {
  speechEl.textContent = '';
  overlay.classList.add('speaking');
  // No click-arming while the line is typing: clicks on the wall are
  // absorbed (so they don't leak through to the canvas) but neither skip
  // the typing nor advance the dialog. The cursor stays as the default
  // arrow until the line completes — only THEN does click-armed flip on,
  // surfacing the glove cursor and arming the wall's "advance" listener
  // in the same beat so the prompt is never live without a live target.
  await typeLine(speechEl, text);
  // Small buffer after the last character so the player can't immediately
  // click through — gives the eye a beat to register the completed line.
  await sleep(POST_LINE_BUFFER_MS);
  overlay.classList.add('click-armed');
  await waitForClick(clickWall);
  playSound('click', 0.29, 0.9);
  overlay.classList.remove('click-armed');
  overlay.classList.remove('speaking');
  // Leave the .done class on — the next typeLine() will clear it when it
  // starts the next line. Removing it here would un-hide the blinking caret
  // during the 200ms speech fade-out and read as a glitchy reappearance.
}

async function turnGoblinAround(goblinEl: HTMLElement) {
  // The first entry (0) is the starting pose, so skip it.
  for (let i = 1; i < TURN_SEQUENCE.length; i++) {
    goblinEl.style.setProperty('--row', String(TURN_SEQUENCE[i]));
    await sleep(TURN_STEP_MS);
  }
}

// Animate from the current sprite row to `target`, stepping one row at a time
// at TURN_STEP_MS each. Used by 'face' steps so a mid-dialogue glance reads
// as a turn rather than an instant pose swap.
async function faceRow(goblinEl: HTMLElement, target: number) {
  const current = Number(goblinEl.style.getPropertyValue('--row') || '0');
  if (current === target) return;
  const step = current < target ? 1 : -1;
  for (let r = current + step; step > 0 ? r <= target : r >= target; r += step) {
    goblinEl.style.setProperty('--row', String(r));
    await sleep(TURN_STEP_MS);
  }
}

export async function runIntro(): Promise<void> {
  const overlay = document.getElementById('intro-overlay');
  const goblinEl = document.getElementById('intro-goblin');
  const speechEl = document.getElementById('intro-speech');
  const yesBtn = document.getElementById('intro-yes') as HTMLButtonElement | null;
  const noBtn  = document.getElementById('intro-no')  as HTMLButtonElement | null;
  const clickWall = document.getElementById('intro-clickwall');
  if (!overlay || !goblinEl || !speechEl || !yesBtn || !noBtn || !clickWall) return;

  // Reset the goblin's facing each run (so dev reloads play out the full
  // turn-around rather than starting already facing camera).
  goblinEl.style.setProperty('--row', '0');
  overlay.classList.remove('faced');

  // Mirror runBobCutscene: the world keeps running (and the player keeps
  // full input — the inline style keeps the click wall transparent despite
  // `.visible`) through the slide-up. Only once the goblin has turned to
  // face the player does the cutscene freeze game time and absorb clicks.
  clickWall.style.pointerEvents = 'none';

  overlay.classList.add('visible');
  await sleep(50);
  overlay.classList.add('up');
  await sleep(SLIDE_UP_MS + 100);
  // Hold at the top, then pivot to face the player. The .faced class triggers
  // a smooth rise from the slide-in resting position (-22vh) to the
  // post-turn-around position (-14vh) — see #intro-goblin CSS for the
  // motivation (row 0 vs row 4 sprite geometry).
  await sleep(POST_SLIDE_BEAT_MS);
  if (introAborted) { teardownIntro(overlay, speechEl, yesBtn, noBtn, clickWall); return; }
  overlay.classList.add('faced');
  await turnGoblinAround(goblinEl);

  // The goblin is now addressing the player: freeze the tick loop for the
  // dialogue (intro-cutscene-hold, see main.ts) and restore the click wall
  // so the `.visible` rule absorbs clicks again.
  document.body.classList.add('intro-cutscene-hold');
  clickWall.style.pointerEvents = '';

  for (const step of SCRIPT) {
    if (introAborted) break;
    if (step.kind === 'speak') {
      await runSpeak(overlay, speechEl, clickWall, step.text);
    } else if (step.kind === 'pause') {
      await sleep(step.ms);
    } else if (step.kind === 'choice') {
      // Configure the visible buttons + their labels for this step. Steps
      // currently always provide 2 choices, but the loop handles 1..N.
      const allButtons = [yesBtn, noBtn];
      for (let i = 0; i < allButtons.length; i++) {
        const btn = allButtons[i];
        const choice = step.choices[i];
        if (choice) {
          btn.hidden = false;
          btn.querySelector('.build-name')!.textContent = choice.label;
        } else {
          btn.hidden = true;
        }
      }
      overlay.classList.add('show-buttons');
      const picked = await waitForChoice(
        step.choices.map((_, i) => allButtons[i]).filter(Boolean),
      );
      playSound('click', 0.8, 1);
      overlay.classList.remove('show-buttons');
      await sleep(200);
      // Play the follow-up line the chosen branch carries.
      await runSpeak(overlay, speechEl, clickWall, step.choices[picked].nextLine);
    } else if (step.kind === 'face') {
      await faceRow(goblinEl, step.row);
    } else if (step.kind === 'exit') {
      // Dialogue over — release the time freeze before the walk-off so the
      // world resumes behind the departing goblin (same as Bob's exit).
      document.body.classList.remove('intro-cutscene-hold');
      // Pivot to face East so the walk-off reads as the goblin leaving to the
      // right rather than being dragged sideways while still facing camera.
      await faceRow(goblinEl, EXIT_FACING_ROW);
      overlay.classList.remove('up');
      overlay.classList.add('exit');
      await sleep(SLIDE_OUT_MS + 100);
      overlay.classList.remove('visible');
      await sleep(700);
    }
  }
  // Abort can break out of the loop with the hold still on; teardown also
  // strips it, but belt-and-braces for any future early exit.
  document.body.classList.remove('intro-cutscene-hold');
  if (introAborted) teardownIntro(overlay, speechEl, yesBtn, noBtn, clickWall);
}

// Mid-game cutscene: same goblin, slides back up after the player places their
// 20th building. Reuses the entire intro DOM and animation, but with a Bob-
// specific script that names the building ordinal/type and surfaces an
// Okay/No choice. Returns 'yes' when the player accepts (caller seats Bob via
// the hole picker), 'no' when they decline. Designed to be called outside of
// playIntroSequence: it doesn't touch introActive/introAborted, so skipIntro()
// stays a no-op while this runs. The pausable sleep + intro-paused class still
// apply, so pressing P during the Bob cutscene freezes it correctly.
//
// The world keeps running (and the player keeps full input) through the
// slide-up — only once the goblin has turned around to address the player
// does the cutscene freeze the tick loop and arm the click wall. `onHold`
// fires at that moment so the caller can clear any in-flight cursor state.
export async function runBobCutscene(ordinal: string, kindName: string, onHold?: () => void): Promise<'yes' | 'no'> {
  const overlay = document.getElementById('intro-overlay');
  const goblinEl = document.getElementById('intro-goblin');
  const speechEl = document.getElementById('intro-speech');
  const yesBtn = document.getElementById('intro-yes') as HTMLButtonElement | null;
  const noBtn  = document.getElementById('intro-no')  as HTMLButtonElement | null;
  const clickWall = document.getElementById('intro-clickwall');
  if (!overlay || !goblinEl || !speechEl || !yesBtn || !noBtn || !clickWall) return 'no';

  // Reset the goblin to back-facing so the slide-up + turn-around plays from
  // the same starting pose as the original intro.
  goblinEl.style.setProperty('--row', '0');
  overlay.classList.remove('faced', 'exit', 'speaking', 'click-armed', 'show-buttons');
  speechEl.textContent = '';
  speechEl.classList.remove('done');

  // Keep the click wall transparent while the goblin rises — the inline
  // style overrides the `.visible` CSS rule that would otherwise absorb
  // every click the moment the overlay shows.
  clickWall.style.pointerEvents = 'none';

  overlay.classList.add('visible');
  await sleep(50);
  overlay.classList.add('up');
  await sleep(SLIDE_UP_MS + 100);
  await sleep(POST_SLIDE_BEAT_MS);
  overlay.classList.add('faced');
  await turnGoblinAround(goblinEl);

  // The goblin is now facing the player: freeze the world and start blocking
  // input. bob-cutscene-hold suspends the tick loop (see main.ts) without
  // surfacing the regular pause overlay; restoring the click wall's
  // pointer-events lets the `.visible` rule absorb clicks again.
  document.body.classList.add('bob-cutscene-hold');
  clickWall.style.pointerEvents = '';
  onHold?.();

  await runSpeak(overlay, speechEl, clickWall, 'oh my!');
  await runSpeak(overlay, speechEl, clickWall, 'oh my word!');
  await runSpeak(overlay, speechEl, clickWall, `you've come so far! you're placing your ${ordinal} ${kindName}!`);
  await runSpeak(overlay, speechEl, clickWall, 'tag me in, boss?');

  yesBtn.querySelector('.build-name')!.textContent = 'OKAY';
  noBtn.querySelector('.build-name')!.textContent = 'NO';
  yesBtn.hidden = false;
  noBtn.hidden = false;
  overlay.classList.add('show-buttons');
  const picked = await waitForChoice([yesBtn, noBtn]);
  playSound('click', 0.8, 1);
  overlay.classList.remove('show-buttons');
  yesBtn.hidden = true;
  noBtn.hidden = true;

  // Resolve the moment the choice lands: the hold lifts and (on "okay") the
  // hole picker starts right away, while the goblin's walk-off plays out in
  // the background. The click wall goes transparent again first so the
  // departing goblin can't absorb the player's hole-pick clicks.
  document.body.classList.remove('bob-cutscene-hold');
  clickWall.style.pointerEvents = 'none';
  const exitAnim = async () => {
    await sleep(200);
    // Walk off the same way the original intro does. Pivot East, swap
    // .up → .exit to play the slide-right animation, then drop .visible.
    await faceRow(goblinEl, EXIT_FACING_ROW);
    overlay.classList.remove('up');
    overlay.classList.add('exit');
    await sleep(SLIDE_OUT_MS + 100);
    overlay.classList.remove('visible');
    await sleep(700);
    overlay.classList.remove('exit', 'faced');
    // Restore the YES/NO labels so the original intro DOM is left exactly as
    // we found it. Belt-and-braces: the new-game intro never runs after Bob
    // since it's once-only, but a dev reload + Bob cutscene loop shouldn't
    // leave OKAY/NO sticking to the buttons.
    yesBtn.querySelector('.build-name')!.textContent = 'YES';
    noBtn.querySelector('.build-name')!.textContent = 'NO';
    clickWall.style.pointerEvents = '';
  };
  void exitAnim();
  return picked === 0 ? 'yes' : 'no';
}

// ─── The Pain Gabbonsaw cutscene ─────────────────────────────────────
// Fires when the player buys the 99-dragon-bone "Pain Gabbonsaw" ritual:
// Bob slides back up one last time, realises what the player has done, and
// an anagram reveal rearranges "pain gabbonsaw" into "spawn bob again"
// letter by letter. Resolves only after he has fully walked off screen —
// the caller spawns Lolly (with Bob riding on top) the moment he's gone.

const ANAGRAM_FROM = 'pain gabbonsaw';
const ANAGRAM_TO = 'spawn bob again';

// Map each letter of the source phrase onto a slot in the target phrase
// (greedy first-match — the two are exact anagrams, so every letter pairs).
function buildAnagramMapping(): { ch: string; from: number; to: number }[] {
  const used = new Set<number>();
  const out: { ch: string; from: number; to: number }[] = [];
  for (let to = 0; to < ANAGRAM_TO.length; to++) {
    const ch = ANAGRAM_TO[to];
    if (ch === ' ') continue;
    for (let from = 0; from < ANAGRAM_FROM.length; from++) {
      if (used.has(from) || ANAGRAM_FROM[from] !== ch) continue;
      used.add(from);
      out.push({ ch, from, to });
      break;
    }
  }
  return out;
}

// The reveal itself: the ritual's name fades in, holds, then every letter
// glides to its position in "spawn bob again" (monospace, so the slots line
// up cleanly), holds again, and fades out. Self-contained DOM — built inside
// the intro overlay and removed afterwards. Uses the pausable sleep, so P
// freezes the beats (the in-flight CSS glide itself keeps easing — fine).
async function playAnagramReveal(overlay: HTMLElement): Promise<void> {
  const wrap = document.createElement('div');
  wrap.id = 'anagram-overlay';
  wrap.style.cssText =
    'position:absolute; left:50%; top:32%; width:0; height:1.4em; overflow:visible; '
    + "font-family:'VT323', monospace; font-size:clamp(28px, 7vmin, 72px); color:#ffd96b; "
    + 'text-shadow:0 0 14px rgba(255,90,40,0.85), 0 2px 2px #000; '
    + 'opacity:0; transition:opacity 600ms ease; pointer-events:none;';
  overlay.appendChild(wrap);
  // Measure the monospace advance width so slot positions are exact.
  const probe = document.createElement('span');
  probe.textContent = 'm';
  probe.style.visibility = 'hidden';
  wrap.appendChild(probe);
  const chW = probe.getBoundingClientRect().width || 28;
  probe.remove();
  const srcCenter = (ANAGRAM_FROM.length - 1) / 2;
  const dstCenter = (ANAGRAM_TO.length - 1) / 2;
  const letters = buildAnagramMapping().map((m) => {
    const el = document.createElement('span');
    el.textContent = m.ch;
    el.style.cssText =
      'position:absolute; top:0; left:0; '
      + 'transition:transform 1700ms cubic-bezier(0.65, 0, 0.35, 1), color 1700ms ease; '
      + `transform:translateX(${((m.from - srcCenter) * chW - chW / 2).toFixed(1)}px);`;
    wrap.appendChild(el);
    return { el, m };
  });
  await sleep(80);                 // let the initial transforms commit
  wrap.style.opacity = '1';
  playSound('online', 0.5, 0.8);
  await sleep(1700);               // "pain gabbonsaw" registers
  playSound('ritual', 0.7, 0.8);   // the letters begin to crawl
  for (const { el, m } of letters) {
    el.style.transform = `translateX(${((m.to - dstCenter) * chW - chW / 2).toFixed(1)}px)`;
    el.style.color = '#ff5a4a';
  }
  await sleep(1900);               // glide completes
  playSound('online', 0.6, 1.3);
  await sleep(1800);               // "spawn bob again" lands
  wrap.style.opacity = '0';
  await sleep(650);
  wrap.remove();
}

// A spoken beat that auto-advances (no click) — Bob trailing off, the same
// ". . ." cadence the demons use.
async function speakBeat(overlay: HTMLElement, speechEl: HTMLElement, text: string): Promise<void> {
  speechEl.textContent = '';
  overlay.classList.add('speaking');
  await typeLine(speechEl, text);
  await sleep(1300);
  overlay.classList.remove('speaking');
  await sleep(400);
}

export async function runGabbonsawCutscene(): Promise<void> {
  const overlay = document.getElementById('intro-overlay');
  const goblinEl = document.getElementById('intro-goblin');
  const speechEl = document.getElementById('intro-speech');
  const yesBtn = document.getElementById('intro-yes') as HTMLButtonElement | null;
  const noBtn  = document.getElementById('intro-no')  as HTMLButtonElement | null;
  const clickWall = document.getElementById('intro-clickwall');
  if (!overlay || !goblinEl || !speechEl || !yesBtn || !noBtn || !clickWall) return;

  // Same staging as runBobCutscene: reset to back-facing, keep the click
  // wall transparent (and the world live) through the slide-up.
  goblinEl.style.setProperty('--row', '0');
  overlay.classList.remove('faced', 'exit', 'speaking', 'click-armed', 'show-buttons');
  speechEl.textContent = '';
  speechEl.classList.remove('done');
  clickWall.style.pointerEvents = 'none';

  overlay.classList.add('visible');
  await sleep(50);
  overlay.classList.add('up');
  await sleep(SLIDE_UP_MS + 100);
  await sleep(POST_SLIDE_BEAT_MS);
  overlay.classList.add('faced');
  await turnGoblinAround(goblinEl);

  // Facing the player: freeze the world and absorb clicks for the dialogue.
  document.body.classList.add('bob-cutscene-hold');
  clickWall.style.pointerEvents = '';

  await runSpeak(overlay, speechEl, clickWall, 'oh');
  await runSpeak(overlay, speechEl, clickWall, 'oh no…');
  await runSpeak(overlay, speechEl, clickWall, 'lolly was right.');
  await speakBeat(overlay, speechEl, '. . .');
  await playAnagramReveal(overlay);
  await runSpeak(overlay, speechEl, clickWall, 'you really would click it.');
  // A glance off to the side, a beat of silence, then back to the player.
  await faceRow(goblinEl, 3);
  await speakBeat(overlay, speechEl, '. . .');
  await faceRow(goblinEl, 4);
  await runSpeak(overlay, speechEl, clickWall, 'now i know what must be done');

  // Walk-off — the world resumes behind him, and unlike runBobCutscene we
  // AWAIT the exit: Lolly only spawns once Bob is fully off screen.
  document.body.classList.remove('bob-cutscene-hold');
  clickWall.style.pointerEvents = 'none';
  await sleep(200);
  await faceRow(goblinEl, EXIT_FACING_ROW);
  overlay.classList.remove('up');
  overlay.classList.add('exit');
  await sleep(SLIDE_OUT_MS + 100);
  overlay.classList.remove('visible');
  await sleep(700);
  overlay.classList.remove('exit', 'faced');
  clickWall.style.pointerEvents = '';
}

// For new games only: how long the player gets to wander and click the empty
// world before the goblin slides up and starts talking.
const PRE_INTRO_FREE_CLICK_MS = 6_500;
// Staggered fade-in after the cutscene resolves: the summon panel comes in
// first, then the task line trails behind so the eye doesn't see both reveal
// at once.
const POST_INTRO_SUMMON_DELAY_MS = 1_000;
const POST_INTRO_TASK_DELAY_MS = 2_000;

export type IntroReveal = {
  // Drop the intro-hold so the summon panel fades in.
  onSummonReveal: () => void;
  // Reveal the first task line.
  onTaskReveal: () => void;
};

// Drives the full new-game intro: the free-click preamble, the goblin
// cutscene, then the staggered panel/task reveals. skipIntro() can cut it
// short at any point — when skipped, the cutscene tears down and both reveals
// fire immediately so the player lands straight in the game.
export async function playIntroSequence(reveal: IntroReveal): Promise<void> {
  introActive = true;
  introAborted = false;
  try {
    await sleep(PRE_INTRO_FREE_CLICK_MS);
    if (!introAborted) await runIntro();
    if (introAborted) {
      reveal.onSummonReveal();
      reveal.onTaskReveal();
      return;
    }
    await sleep(POST_INTRO_SUMMON_DELAY_MS);
    reveal.onSummonReveal();
    await sleep(POST_INTRO_TASK_DELAY_MS - POST_INTRO_SUMMON_DELAY_MS);
    reveal.onTaskReveal();
  } finally {
    introActive = false;
    // Clear the abort flag once the sequence is over — it's only meaningful
    // mid-intro, and leaving it set would make every pausable sleep in the
    // LATER cutscenes (Bob's tag-in, the Pain Gabbonsaw reveal) resolve
    // instantly after a dev-skipped intro.
    introAborted = false;
  }
}
