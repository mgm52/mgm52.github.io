// Records the new trading-realm card sequence to videos/trading-realm.mp4,
// driven through the real app on the vite dev server:
//   node scripts/record-trading-realm.mjs            (server at :5179)
//
// The tour: the origin card's opening deal → the white goblin's swindle
// ("then let me be your first.") → the held big-card view (ENTER only) → the
// dive into the traded world → the LEAVE WORLD button held back 10s then
// flashing → the pull-back reveal (the card lived inside a little white house)
// → the 90° turn onto a street of gathering-houses → walking the street and
// stepping through a door into a gathering.
//
// Runs WITHOUT reducedMotion (the ambient drift is the point); realm clicks
// use force:true to skip the stability check a levitating card never passes.
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
// Capture at a smaller size: the realm's blur/aurora + the 3-D street are
// heavy under headless software-GL, and a smaller frame keeps the recorder
// from falling behind and dropping the tail. (8:5, so the tuned framing holds.)
const VW = 1024, VH = 640;
const context = await browser.newContext({
  viewport: { width: VW, height: VH },
  recordVideo: { dir: OUT_DIR, size: { width: VW, height: VH } },
  // The realm's ambient drift (four blur(60px) auroras + a turning halo +
  // rising mote sheets) pegs the headless software renderer, so the recorder
  // falls behind and drops the tail. reducedMotion parks that drift (the
  // gradients stay; they just hold still) — the camera dives and card morphs
  // are JS/inline transitions, so the cinematic itself still plays.
  reducedMotion: 'reduce',
});
const page = await context.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));

// A white underlay just beneath the realm (z 100000) recreates the white the
// realm rises from under ?cardrealm (where it mounts over the live game).
await context.addInitScript(() => {
  if (!location.search.includes('cardrealm')) return;
  addEventListener('DOMContentLoaded', () => {
    const d = document.createElement('div');
    d.style.cssText = 'position:fixed;inset:0;background:#fff;z-index:100000;pointer-events:none;';
    document.body.appendChild(d);
  });
});

const click = (sel) => page.click(sel, { force: true });

// Steer to a URL, retrying when the app's own in-flight reload interrupts us
// (LEAVE WORLD reloads to PLAIN on its own, which races a manual goto).
async function gotoStable(url) {
  for (let i = 0; i < 6; i++) {
    try { await page.goto(url, { waitUntil: 'domcontentloaded' }); return; }
    catch (e) { if (String(e).includes('interrupted')) { await sleep(700); continue; } throw e; }
  }
}

// Click through typed dialogue until a condition holds, pausing after each
// completed line so the viewer can read it.
async function talkUntil(cond, maxClicks = 40) {
  for (let i = 0; i < maxClicks; i++) {
    if (await cond()) return;
    if (await page.$('#card-realm.click-armed')) {
      await sleep(560);
      await click('#card-clickwall');
    }
    await sleep(260);
  }
}

// ── Fresh state. ──
await page.goto(REALM, { waitUntil: 'domcontentloaded' });
await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
await page.goto(REALM, { waitUntil: 'networkidle' });

// ── The opening deal, then reach for ENTER. ──
console.log('intro: the origin card');
await page.waitForSelector('#card-realm.visible .world-card', { timeout: 20000 });
await sleep(3200); // the slow slide across the felt settles
await click('.wc-enter');

// ── The goblin holds court; pick NO to hear "then let me be your first." ──
console.log('intro: the goblin');
await talkUntil(() => page.$('#card-realm.show-choice'));
await sleep(1100);
await click('#card-no');

// ── The held big-card view: nothing to do but ENTER it. ──
console.log('the traded card');
await talkUntil(() => page.$('#card-stage.firstcard-view .wc-enter'), 50);
await page.waitForSelector('#card-stage.firstcard-view .wc-enter', { timeout: 30000 });
await sleep(2600); // let the single card sit
await click('#card-stage.firstcard-view .wc-enter');
await sleep(2600); // swell + white + reload (realm remounts under ?cardrealm)

// ── Inside the traded world: the way out is held back, then flashes in. ──
console.log('inside the world; waiting out the LEAVE hold');
await page.evaluate(() => sessionStorage.setItem('rts.cardhop', '1')).catch(() => {});
await gotoStable(PLAIN);
await sleep(4200); // arrival zoom + a beat inside the bordered world
// The button is display:'' but held hidden for 10s, then fades in flashing.
await page.waitForSelector('#leave-world-btn.flash-in', { timeout: 16000 });
await sleep(2400); // let it flash a couple of times

// ── The pull-back, and the reveal onto the street. ──
console.log('leave world → reveal → street');
// LEAVE WORLD plays a ~1.25s pull-back then reloads to PLAIN on its own; wait
// for that auto-reload to fully land before steering to the realm, so the two
// navigations don't collide.
await page.click('#leave-world-btn');
await sleep(3600); // the pull-back zoom + the app's own reload to PLAIN
await gotoStable(REALM); // retries past any reload still in flight
// The reveal: inside the house → pull back → 90° turn → the street.
await page.waitForSelector('#card-stage.street-view', { timeout: 20000 });
await sleep(7800); // the whole reveal cinematic + settle
await sleep(1400); // a beat to take in the street

// ── Walk the street (forward to the next row, then back), then step in. ──
console.log('walking the street');
if (await page.$('.sv-step-fwd:not([disabled])')) {
  await click('.sv-step-fwd');
  await sleep(2400);
}
if (await page.$('.sv-step-back:not([disabled])')) {
  await click('.sv-step-back');
  await sleep(2200);
}
console.log('entering a gathering house');
// The first focused gathering is the soft border (an always-met "any one
// world" want). A dispatched click — 3-D boxes confuse force-clicks at the
// viewport edge — hits the same handler a mouse would.
await page.evaluate(() => {
  const a = document.querySelectorAll('.sv-house.sv-active');
  (a[0] || a[1])?.click();
});
await page.waitForSelector('#card-stage.gathering-view', { timeout: 12000 });
// Hold a good while on the trading view: the dive + canvas-heavy gathering
// build put the recorder behind, and it needs idle time on a settled frame to
// catch up and flush before close — otherwise the tail is dropped.
await sleep(13000);

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
  const mp4 = path.join(OUT_DIR, 'trading-realm.mp4');
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
