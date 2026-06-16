// Records a guided tour of the redesigned trading realm — "the Confluence" —
// to videos/confluence.mp4, driven through the real app on the vite dev
// server:
//   node scripts/record-confluence.mjs            (server at :5179)
//
// The tour: the origin card's opening deal → the swindler-blob's descent and
// the forced first trade → the table of gatherings → a gathering of living
// iridescent trader-blobs → a creature yearning as its want is met → the
// confluence (cards liquefying into the trader, its worlds beading back into
// the hand) → inspecting a trader's world → diving into a held world and
// LEAVE WORLD → the table once more.
//
// Runs WITHOUT reducedMotion — the realm's living goo field, the traders'
// breathing blobs, and the liquid trade are the whole point — so realm clicks
// use force: true to skip playwright's stability check, which a levitating
// card / drifting blob never passes.
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

// Under ?cardrealm the realm mounts over the live game; a white underlay just
// beneath it (z 100000) recreates the white the realm actually rises from.
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

// ── The opening deal: the origin card slides across the living field. ──
console.log('intro: the origin card');
await page.waitForSelector('#card-realm.visible .world-card', { timeout: 20000 });
await sleep(3400); // the slow slide settles; the goo drifts behind it
await click('.wc-enter');

// ── The swindler blob descends and holds court. ──
console.log('intro: the swindler');
await talkUntil(() => page.$('#card-realm.show-choice'));
await sleep(1200);
await click('#card-no');
await talkUntil(() => page.$('#card-stage.table-view'), 40);
await page.waitForSelector('#card-stage.table-view', { timeout: 60000 });

// ── The table: let the gathering-doors deal in, sweep one hover. ──
console.log('table');
await sleep(2200);
await page.hover('.ct-event:not(.locked)', { force: true });
await sleep(1200);

// ── A gathering: living trader-blobs, each yearning its want. ──
console.log('gathering');
await click('.ct-event:not(.locked)');
await page.waitForSelector('.ct-stall', { timeout: 10000 });
await sleep(2600); // the blobs breathe; the wants type out

// ── The confluence. Pick a held world; a trader's want is met and it leans
//    in (eager); then trade — cards liquefy into it, its worlds bead back. ──
console.log('confluence: select');
const mine = await page.$('.ct-hand-inline .world-card:not(.grayed)');
if (mine) {
  await mine.click({ force: true });
  await sleep(1500); // a trader goes eager — the blob surges toward the cards
  // Frame the yearning trader before the exchange.
  const give = await page.$('.ct-give.ok');
  if (give) {
    const stall = await give.evaluateHandle((b) => b.closest('.ct-stall'));
    await stall.asElement()?.scrollIntoViewIfNeeded().catch(() => {});
    await sleep(1100);
    console.log('confluence: trade');
    await page.click('.ct-give.ok', { force: true });
    await sleep(2600); // liquefy → absorb → condense → the arrivals bloom
  } else {
    console.log('no creature would trade for this card — skipping the exchange');
  }
}
await sleep(1400);

// ── Inspect a trader's world: dive in frozen, then step back out. ──
console.log('inspect a world');
// Hop to a fresh gathering with a stall still holding cards to inspect.
let inspected = false;
const stallCard = await page.$('.ct-stall:not(.spent) .ct-stall-cards .world-card .wc-enter');
if (stallCard) {
  await stallCard.scrollIntoViewIfNeeded().catch(() => {});
  await sleep(700);
  await stallCard.click({ force: true }); // INSPECT → spectate dive (reloads)
  await sleep(2600);
  await page.evaluate(() => sessionStorage.setItem('rts.cardhop', '1')).catch(() => {});
  await page.goto(PLAIN, { waitUntil: 'domcontentloaded' });
  await sleep(4200); // arrival zoom into the frozen world
  const stop = await page.$('#leave-world-btn');
  if (stop) { await stop.click({ force: true }); inspected = true; await sleep(4800); }
}
if (inspected) {
  await page.goto(REALM, { waitUntil: 'networkidle' });
  await page.waitForSelector('#card-stage', { timeout: 20000 });
  await sleep(2000);
}

// ── Dive into a held world, then LEAVE WORLD. ──
console.log('dive into a held world');
await page.waitForSelector('#card-stage.table-view', { timeout: 20000 }).catch(() => {});
const ownEnter = await page.$('#card-hand .wc-enter, .ct-hand-inline .wc-enter');
if (ownEnter) {
  await ownEnter.scrollIntoViewIfNeeded().catch(() => {});
  await sleep(700);
  await ownEnter.click({ force: true });
  await sleep(2800); // swell + white + reload
  await page.evaluate(() => sessionStorage.setItem('rts.cardhop', '1')).catch(() => {});
  await page.goto(PLAIN, { waitUntil: 'domcontentloaded' });
  await sleep(4500); // arrival zoom into the bordered world
  console.log('leave world');
  await page.click('#leave-world-btn', { force: true }).catch(() => {});
  await sleep(5200); // exit zoom + reload landing
}

// ── The table once more, on the living field. ──
await page.goto(REALM, { waitUntil: 'networkidle' });
await page.waitForSelector('#card-stage', { timeout: 20000 });
await sleep(6000);

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
  const mp4 = path.join(OUT_DIR, 'confluence.mp4');
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
