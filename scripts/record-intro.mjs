// Records the goblin intro sequence to a webm video using Playwright.
// Run: node scripts/record-intro.mjs (vite dev server must be at :5173)
//
// We rely on dev-mode skipping the title screen so the intro fires
// immediately. The script:
//   1. Opens the page in a 1280x720 viewport with video recording on.
//   2. Waits for the intro overlay to become visible (goblin slides up).
//   3. For each speech line, waits until #intro-speech has the .done class
//      (typing finished), then clicks the click-wall to advance.
//   4. For the YES step, clicks #intro-yes when it appears.
//   5. Waits for the goblin to slide back out and the spawn panel to fade in.
//   6. Saves the recorded webm into the repo at videos/.

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

console.log('Waiting for intro overlay to become visible…');
await page.waitForSelector('#intro-overlay.visible', { timeout: 30_000 });
console.log('Overlay visible — waiting for slide-up to finish…');

// Slide-up duration is 3000ms in CSS; wait for the overlay to have `up`.
await page.waitForSelector('#intro-overlay.up', { timeout: 10_000 });
await sleep(3200);

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

console.log('  button: YES');
await page.waitForSelector('#intro-overlay.show-yes', { timeout: 15_000 });
await sleep(800);
await page.click('#intro-yes');

await advanceSpeak('me too');

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
  const mp4 = path.join(OUT_DIR, 'goblin-intro.mp4');
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
