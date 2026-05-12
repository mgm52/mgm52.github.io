// First-time-only intro sequence: a goblin slides up from the bottom (back
// to the camera), turns to face the player, and delivers a short monologue
// about not knowing how to play. Each line types out one character at a time
// in yellow; the player clicks to advance.
//
// "(…)" inside speech text = mid-line 1.5s pause (the literal characters are
// not rendered). A standalone pause step in the script is a pure between-line
// pause. Choice steps surface a row of buttons (currently YES/NO) — each
// option carries its own follow-up line. "down" is the slide-out cue.
//
// runIntro() resolves once the goblin has slid back out, so the caller can
// chain the panel/task fade-in onto the same promise.

import { playSound } from './audio';

type IntroChoice = { label: string; nextLine: string };
type IntroStep =
  | { kind: 'speak'; text: string }
  | { kind: 'pause'; ms: number }
  | { kind: 'choice'; choices: IntroChoice[] }
  | { kind: 'down' };

const SCRIPT: IntroStep[] = [
  { kind: 'speak', text: 'hello' },
  { kind: 'speak', text: 'do you want to (…) know how to play' },
  { kind: 'choice', choices: [
    { label: 'YES', nextLine: 'me too' },
    { label: 'NO',  nextLine: "that's good because i have no idea" },
  ]},
  { kind: 'pause', ms: 3000 },
  { kind: 'speak', text: "i've been clicking around for ages but i don't know how to play i've been trying to figure it out but i think i just don't have the executive mindset for it" },
  { kind: 'pause', ms: 3000 },
  { kind: 'speak', text: 'goodbye' },
  { kind: 'down' },
];

const TYPE_MS_PER_CHAR = 45;
const MID_LINE_PAUSE_MS = 1500;
// Held after the last character of a line types out before the click wall
// arms — prevents an over-eager click from advancing the dialog the instant
// the line completes.
const POST_LINE_BUFFER_MS = 200;
// Slow rise on the way in; quicker exit on the way out.
const SLIDE_UP_MS = 6000;
const SLIDE_DOWN_MS = 2200;
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

const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

function waitForClick(target: HTMLElement): Promise<void> {
  return new Promise((resolve) => {
    const handler = () => {
      target.removeEventListener('click', handler);
      resolve();
    };
    target.addEventListener('click', handler, { once: true });
  });
}

// Resolves with the index of the clicked button. The losing button(s) get
// their click listener pulled when one resolves so a stale click on a hidden
// button can't fire after the row has been dismissed.
function waitForChoice(buttons: HTMLButtonElement[]): Promise<number> {
  return new Promise((resolve) => {
    const handlers: Array<() => void> = [];
    buttons.forEach((btn, i) => {
      const handler = () => {
        for (let j = 0; j < buttons.length; j++) {
          buttons[j].removeEventListener('click', handlers[j]);
        }
        resolve(i);
      };
      handlers.push(handler);
      btn.addEventListener('click', handler);
    });
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
  playSound('click', 0.6, 0.9);
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

  overlay.classList.add('visible');
  await sleep(50);
  overlay.classList.add('up');
  await sleep(SLIDE_UP_MS + 100);
  // Hold at the top, then pivot to face the player.
  await sleep(POST_SLIDE_BEAT_MS);
  await turnGoblinAround(goblinEl);

  for (const step of SCRIPT) {
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
    } else if (step.kind === 'down') {
      overlay.classList.remove('up');
      overlay.classList.add('down');
      await sleep(SLIDE_DOWN_MS + 100);
      overlay.classList.remove('visible');
      await sleep(700);
    }
  }
}
