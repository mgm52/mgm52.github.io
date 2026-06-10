// Records a guided tour of the trading-card realm to videos/card-realm.mp4,
// driven through the real app on the vite dev server:
//   node scripts/record-card-realm.mjs            (server at :5179)
//
// The tour: the origin card's opening deal → the white goblin's swindle
// (dialogue paced for reading) → the table → a gathering → a trade (executed
// when the creature's appetite allows) → the dive into a card world → LEAVE
// WORLD → the table again. Unlike the screenshot/verify scripts this runs
// WITHOUT reducedMotion — the realm's ambient drift (auroras, motes, card
// levitation) is the point — so realm clicks use force: true to skip
// playwright's stability check, which a levitating card never passes.
//
// Converts to H.264 mp4 via ffmpeg on PATH, else the ffmpeg-static package
// (npm i --no-save ffmpeg-static) when present.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { launchChromium } from './card-realm-browser.mjs';

const PORT = process.env.PORT ?? '5179';
const REALM = `http://localhost:${PORT}/?cardrealm`;
const PLAIN = `http://localhost:${PORT}/`;
const OUT_DIR = path.resolve('videos');
fs.mkdirSync(OUT_DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await launchChromium();
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  recordVideo: { dir: OUT_DIR, size: { width: 1280, height: 800 } },
});
const page = await context.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));

// Under ?cardrealm the realm mounts over the live game rather than the
// finale's white-out, so the recording would open on several seconds of raw
// game. A white underlay just beneath the realm (z 100001) recreates the
// white the realm actually rises from.
await context.addInitScript(() => {
  if (!location.search.includes('cardrealm')) return;
  addEventListener('DOMContentLoaded', () => {
    const d = document.createElement('div');
    d.style.cssText = 'position:fixed;inset:0;background:#fff;z-index:100000;pointer-events:none;';
    document.body.appendChild(d);
  });
});

const click = (sel) => page.click(sel, { force: true });

// Click through typed dialogue until a condition holds, pausing after each
// completed line so the viewer can read it.
async function talkUntil(cond, maxClicks = 30) {
  for (let i = 0; i < maxClicks; i++) {
    if (await cond()) return;
    if (await page.$('#card-realm.click-armed')) {
      await sleep(750);
      await click('#card-clickwall');
    }
    await sleep(400);
  }
}

// Fresh state.
await page.goto(REALM, { waitUntil: 'domcontentloaded' });
await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
await page.goto(REALM, { waitUntil: 'networkidle' });

// ── The opening deal, then reach for REENTER WORLD. ──
console.log('intro: the origin card');
await page.waitForSelector('#card-realm.visible .world-card', { timeout: 20000 });
await sleep(3200); // the slow slide across the felt settles
await click('.wc-enter');

// ── The goblin holds court. ──
console.log('intro: the goblin');
await talkUntil(() => page.$('#card-realm.show-choice'));
await sleep(1100);
await click('#card-no');
await talkUntil(() => page.$('#card-stage.table-view'), 40);
await page.waitForSelector('#card-stage.table-view .world-card', { timeout: 60000 });

// ── The table: let the levitation breathe, show the hover sheen. ──
console.log('table');
await sleep(2600);
await page.hover('.ct-event:not(.locked)', { force: true });
await sleep(1200);

// ── A gathering, and a trade if any creature bites. ──
console.log('gathering');
await click('.ct-event:not(.locked)');
await page.waitForSelector('.ct-creature', { timeout: 10000 });
await sleep(2200);
let traded = false;
const creatures = await page.$$('.ct-creature');
for (let i = 0; i < creatures.length && !traded; i++) {
  await click(`.ct-creatures .ct-creature:nth-child(${i + 1})`);
  await page.waitForSelector('#card-stage.trade-view', { timeout: 10000 });
  await sleep(1800);
  const mine = await page.$('.ct-yours .world-card:not(.grayed)');
  if (mine) {
    await mine.click({ force: true });
    await sleep(1400);
    const theirs = await page.$('.ct-theirs .world-card:not(.grayed)');
    if (theirs) {
      await theirs.click({ force: true });
      await sleep(2600); // fly-out, swap, arrival flash, the creature's line
      traded = true;
      break;
    }
    await mine.click({ force: true }); // deselect
    await sleep(600);
  }
  await click('.ct-back'); // step away to the gathering
  await page.waitForSelector('.ct-creature', { timeout: 10000 });
  await sleep(1500);
}
console.log(traded ? 'trade executed' : 'no creature would trade — moving on');
await sleep(1200);

// Back to the table — pausing in the gathering so its deal-in plays out.
if (await page.$('#card-stage.trade-view')) {
  await click('.ct-back');
  await page.waitForSelector('.ct-creature', { timeout: 10000 });
  await sleep(2200);
}
await click('.ct-back');
await page.waitForSelector('#card-stage.table-view .world-card', { timeout: 10000 });
await sleep(2000);

// ── The dive into a card world. ──
console.log('dive');
await click('.wc-enter');
await sleep(2800); // swell + white + reload (realm remounts under ?cardrealm)

// The arrival, on the plain URL with the hop flag re-armed so the
// zoom-out-of-white plays without the realm overlay.
await page.evaluate(() => sessionStorage.setItem('rts.cardhop', '1')).catch(() => {});
await page.goto(PLAIN, { waitUntil: 'domcontentloaded' });
await sleep(4500); // arrival zoom + a beat inside the bordered world

// ── The pull-back, and the table once more. ──
console.log('leave world');
await page.click('#leave-world-btn');
await sleep(5500); // exit zoom + the page's own reload fully landing
await page.goto(REALM, { waitUntil: 'networkidle' });
await page.waitForSelector('#card-stage.table-view .world-card', { timeout: 20000 });
await sleep(7000);

console.log('closing — flushing video');
await context.close();
await browser.close();

// Convert the newest webm to H.264 mp4 (iOS-safe), then drop the webm.
const files = fs.readdirSync(OUT_DIR).filter((f) => f.endsWith('.webm'));
const newest = files
  .map((f) => ({ f, t: fs.statSync(path.join(OUT_DIR, f)).mtimeMs }))
  .sort((a, b) => b.t - a.t)[0];
if (newest) {
  let ffmpeg = 'ffmpeg';
  try {
    execFileSync(ffmpeg, ['-version'], { stdio: 'ignore' });
  } catch {
    ffmpeg = (await import('ffmpeg-static')).default;
  }
  const webm = path.join(OUT_DIR, newest.f);
  const mp4 = path.join(OUT_DIR, 'card-realm.mp4');
  console.log('Converting to mp4…');
  execFileSync(ffmpeg, [
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
