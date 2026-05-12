// Records the goblin intro sequence to a webm video using Playwright.
// Run: node scripts/record-intro.mjs [yes|no] (vite dev server at :5173)
//
// The optional argument picks which branch to record at the YES/NO choice
// (defaults to YES). We rely on dev-mode skipping the title screen so the
// intro fires immediately. The script:
//   1. Opens the page in a 1280x720 viewport with video recording on.
//   2. Waits for the intro overlay to become visible (goblin slides up).
//   3. For each speech line, waits until #intro-speech has the .done class
//      (typing finished), then clicks the click-wall to advance.
//   4. For the choice step, clicks YES or NO per the CLI arg.
//   5. Waits for the goblin to slide back out and the spawn panel to fade in.
//   6. Converts the recording to MP4 (H.264) so iOS Safari plays it inline.

import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const OUT_DIR = path.resolve('videos');
fs.mkdirSync(OUT_DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const context = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  recordVideo: { dir: OUT_DIR, size: { width: 1280, height: 720 } },
});
const page = await context.newPage();

page.on('console', (msg) => {
  if (msg.type() === 'error') console.log('PAGE ERR:', msg.text());
});

await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });

// Speed up the pre-intro free-click delay so the recording isn't 10s of
// nothing. We hook in by hot-patching the body class flag — actually we
// can't easily reach into the bundle's PRE_INTRO_FREE_CLICK_MS constant
// from here. Just let the 10s play out; the spec said 10s and we want a
// faithful recording.

// CLI arg: which branch to follow at the YES/NO choice. Defaults to YES.
const branch = (process.argv[2] || 'yes').toLowerCase();
if (branch !== 'yes' && branch !== 'no') {
  console.error(`Usage: node scripts/record-intro.mjs [yes|no]`);
  process.exit(1);
}
console.log(`Recording branch: ${branch.toUpperCase()}`);

console.log('Waiting for intro overlay to become visible…');
await page.waitForSelector('#intro-overlay.visible', { timeout: 30_000 });
console.log('Overlay visible — waiting for slide-up + turn-around to finish…');

// Slide-up duration is 3000ms; then a 1200ms hold; then the turn-around
// runs through TURN_SEQUENCE.length-1 = 4 frames at 220ms each = ~880ms.
// Total ≈ 5100ms before the first speak step kicks off.
await page.waitForSelector('#intro-overlay.up', { timeout: 10_000 });
await sleep(5200);

// Walk the dialog. For each "speak" step the typing finishes when
// #intro-speech gains `.done`. We then wait POST_LINE_HOLD_MS before
// clicking. For YES we click the button.
const advanceSpeak = async (label) => {
  console.log(`  speak: ${label}`);
  // Wait for the speech node to be in "speaking" state (set by intro.ts).
  await page.waitForSelector('#intro-overlay.speaking', { timeout: 30_000 });
  // Wait for typing to finish.
  await page.waitForSelector('#intro-speech.done', { timeout: 30_000 });
  await sleep(700); // breathe so the viewer can read
  await page.click('#intro-clickwall');
};

await advanceSpeak('hello');
await advanceSpeak('do you want to (...) know how to play');

console.log(`  button: ${branch.toUpperCase()}`);
await page.waitForSelector('#intro-overlay.show-buttons', { timeout: 15_000 });
await sleep(800);
await page.click(branch === 'yes' ? '#intro-yes' : '#intro-no');

await advanceSpeak(branch === 'yes' ? 'me too' : "that's good because i have no idea");

// (…) (…) pause
console.log('  pause 3s');
await sleep(3200);

await advanceSpeak('long monologue');

console.log('  pause 3s');
await sleep(3200);

await advanceSpeak('goodbye');

console.log('Waiting for goblin slide-down + panel reveal…');
// Wait for the overlay to become non-visible (intro complete).
await page.waitForFunction(() => {
  const o = document.getElementById('intro-overlay');
  return o && !o.classList.contains('visible');
}, { timeout: 15_000 });

// Let the panel + task fade in (1.2s transitions).
await sleep(2000);

console.log('Done — closing context to flush video.');
await context.close();
await browser.close();

// Playwright only writes webm. Convert to H.264 mp4 so iOS Safari (and any
// other browser without VP8 support) can play the clip inline, then delete
// the webm. Requires ffmpeg on PATH.
const files = fs.readdirSync(OUT_DIR).filter((f) => f.endsWith('.webm'));
const newest = files
  .map((f) => ({ f, t: fs.statSync(path.join(OUT_DIR, f)).mtimeMs }))
  .sort((a, b) => b.t - a.t)[0];
if (newest) {
  const webm = path.join(OUT_DIR, newest.f);
  const mp4 = path.join(OUT_DIR, `goblin-intro-${branch}.mp4`);
  console.log('Converting to mp4…');
  execFileSync('ffmpeg', [
    '-y', '-i', webm,
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '23',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    '-profile:v', 'high', '-level', '4.0',
    mp4,
  ], { stdio: 'inherit' });
  fs.unlinkSync(webm);
  console.log('Saved:', mp4);
}
