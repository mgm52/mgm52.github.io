// First-time-only intro sequence: a goblin slides up from the bottom and
// delivers a short monologue about not knowing how to play. Each line types
// out one character at a time in yellow; the player clicks to advance.
//
// "(…)" inside speech text = mid-line 1.5s pause (the literal characters are
// not rendered). A standalone "(…)" or "(…) (…)" step in the script is a
// pure pause between lines. "(YES)" is a button the player must click. "down"
// is the slide-out cue at the end.
//
// runIntro() resolves once the goblin has slid back out, so the caller can
// chain the panel/task fade-in onto the same promise.

import { playSound } from './audio';

type IntroStep =
  | { kind: 'speak'; text: string }
  | { kind: 'pause'; ms: number }
  | { kind: 'button'; label: string }
  | { kind: 'down' };

const SCRIPT: IntroStep[] = [
  { kind: 'speak', text: 'hello' },
  { kind: 'speak', text: 'do you want to (…) know how to play' },
  { kind: 'button', label: 'YES' },
  { kind: 'speak', text: 'me too' },
  { kind: 'pause', ms: 3000 },
  { kind: 'speak', text: "i've been clicking for years trying to figure out how to play but i don't know how to play i don't have the executive mindset for it" },
  { kind: 'pause', ms: 3000 },
  { kind: 'speak', text: 'goodbye' },
  { kind: 'down' },
];

const TYPE_MS_PER_CHAR = 45;
const MID_LINE_PAUSE_MS = 1500;
const SLIDE_UP_MS = 3000;
const SLIDE_DOWN_MS = 2200;
const POST_LINE_HOLD_MS = 300; // brief beat before click-to-advance arms

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

async function typeLine(speechEl: HTMLElement, text: string, skipRef: { skip: boolean }) {
  speechEl.classList.remove('done');
  const segments = splitOnPauseMarkers(text);
  let rendered = '';
  for (let s = 0; s < segments.length; s++) {
    if (s > 0) {
      rendered += ' ';
      speechEl.textContent = rendered;
      // Pause between segments inside a single line.
      const pauseUntil = performance.now() + MID_LINE_PAUSE_MS;
      while (performance.now() < pauseUntil && !skipRef.skip) await sleep(40);
    }
    const seg = segments[s];
    for (let i = 0; i < seg.length; i++) {
      if (skipRef.skip) {
        // Finish the remaining segments instantly.
        const tail = segments.slice(s + 1).join(' ');
        speechEl.textContent = rendered + seg + (tail ? ' ' + tail : '');
        rendered = speechEl.textContent;
        // Mark for outer loop to know everything is rendered.
        speechEl.classList.add('done');
        return;
      }
      rendered += seg[i];
      speechEl.textContent = rendered;
      await sleep(TYPE_MS_PER_CHAR);
    }
  }
  speechEl.classList.add('done');
}

export async function runIntro(): Promise<void> {
  const overlay = document.getElementById('intro-overlay');
  const speechEl = document.getElementById('intro-speech');
  const yesBtn = document.getElementById('intro-yes') as HTMLButtonElement | null;
  const clickWall = document.getElementById('intro-clickwall');
  if (!overlay || !speechEl || !yesBtn || !clickWall) return;

  // Fade the overlay in (goblin still off-screen) before sliding up — that
  // way the slide animation isn't hidden behind a still-fading element.
  overlay.classList.add('visible');
  await sleep(50); // let the opacity transition kick off
  overlay.classList.add('up');
  // Wait for the slide to finish before kicking off dialog. The CSS
  // transition is SLIDE_UP_MS; we add a small buffer for the curve's ease-out
  // tail and the leading 50ms opacity fade.
  await sleep(SLIDE_UP_MS + 100);

  for (const step of SCRIPT) {
    if (step.kind === 'speak') {
      speechEl.textContent = '';
      overlay.classList.add('speaking');
      const skipRef = { skip: false };
      // While the typer runs, a click on the wall snaps to the end of the
      // line. After typing finishes the same wall click advances. We arm the
      // wall only after speaking is showing so a stray click isn't gobbled.
      overlay.classList.add('click-armed');
      const onSkip = () => { skipRef.skip = true; };
      clickWall.addEventListener('click', onSkip);
      await typeLine(speechEl, step.text, skipRef);
      clickWall.removeEventListener('click', onSkip);
      // If we got here via skip, the next click should advance — but the
      // skip-click itself may already have fired. So we always wait for a
      // *new* click here. Add a short hold to make the "fully typed" state
      // visible before the wall consumes the next click.
      await sleep(POST_LINE_HOLD_MS);
      await waitForClick(clickWall);
      playSound('click', 0.6, 0.9);
      overlay.classList.remove('click-armed');
      overlay.classList.remove('speaking');
      speechEl.classList.remove('done');
    } else if (step.kind === 'pause') {
      await sleep(step.ms);
    } else if (step.kind === 'button') {
      // The button steals focus from the speech bubble — we hide the bubble
      // so the YES button is the only thing demanding attention.
      yesBtn.querySelector('.build-name')!.textContent = step.label;
      overlay.classList.add('show-yes');
      await waitForClick(yesBtn);
      playSound('click', 0.8, 1);
      overlay.classList.remove('show-yes');
      // Brief beat before the next line so the click impact lands.
      await sleep(200);
    } else if (step.kind === 'down') {
      overlay.classList.remove('up');
      overlay.classList.add('down');
      await sleep(SLIDE_DOWN_MS + 100);
      overlay.classList.remove('visible');
      // Hold until the opacity fade finishes so a click-through doesn't hit
      // the (now invisible) overlay before it's pointer-events:none again.
      await sleep(700);
    }
  }
}
