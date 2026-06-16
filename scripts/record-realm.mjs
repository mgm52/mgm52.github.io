// Records a guided tour of the redesigned Exchange of Spheres (the alien
// trading void) to videos/exchange-of-spheres.mp4, driven through the real
// app on the vite dev server:  node scripts/record-realm.mjs   (server :5179)
//
// The tour: the origin specimen's opening deal → the alien entity's swindle
// (dialogue paced for reading) → the void table of confluences → a confluence
// → an OFFER (select a held world, the dealer's offer-rune lights, trade) →
// a dive into a specimen world (the alien membrane border) → LEAVE WORLD →
// the void once more. Runs WITHOUT reducedMotion — the abyss drift, spore
// rise and membrane levitation are the point — so realm clicks use force:true
// to skip playwright's stability check (a levitating specimen never settles).
//
// Converts to H.264 mp4 via ffmpeg on PATH, else the ffmpeg-static package.
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
// beneath it (z 100000) recreates the finale white the void rises from.
await context.addInitScript(() => {
  if (!location.search.includes('cardrealm')) return;
  addEventListener('DOMContentLoaded', () => {
    const d = document.createElement('div');
    d.style.cssText = 'position:fixed;inset:0;background:#fff;z-index:100000;pointer-events:none;';
    document.body.appendChild(d);
  });
});

const click = (sel) => page.click(sel, { force: true });

async function talkUntil(cond, maxClicks = 60) {
  for (let i = 0; i < maxClicks; i++) {
    if (await cond()) return;
    if (await page.$('#card-realm.click-armed')) { await sleep(700); await click('#card-clickwall'); }
    await sleep(350);
  }
}

// ── Fresh state. ──
await page.goto(REALM, { waitUntil: 'domcontentloaded' });
await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
await page.goto(REALM, { waitUntil: 'networkidle' });

// ── The origin specimen deals across the void; reach for ❂ enter. ──
console.log('intro: the origin specimen');
await page.waitForSelector('#card-realm.visible .world-card', { timeout: 20000 });
await sleep(3000); // the slow slide settles + the void rises from white
await click('.wc-enter');

// ── The alien entity descends and holds court. ──
console.log('intro: the entity');
await talkUntil(() => page.$('#card-realm.show-choice'));
await sleep(1000);
await click('#card-no');
await talkUntil(() => page.$('#card-stage.table-view'), 60);
await page.waitForSelector('#card-hand .world-card', { timeout: 60000 });

// ── The void table: let the confluences and the levitation breathe. ──
console.log('table');
await sleep(2000);
await page.hover('.ct-event:not(.locked)', { force: true });
await sleep(1000);

// ── A confluence, then an offer. ──
console.log('confluence');
await click('.ct-event:not(.locked)');
await page.waitForSelector('.ct-stall', { timeout: 10000 });
await sleep(2200);

// Observe one of the dealer's specimens? Skip — keep the reloads to one
// (the dive). Go straight to the offer: select a held world, the dealer's
// offer-rune lights, take the trade.
let traded = false;
const mine = await page.$('.ct-hand-inline .world-card .wc-enter');
const mineCard = await page.$('.ct-hand-inline .world-card');
if (mineCard) {
  await mineCard.click({ force: true }); // select toward the offer
  await sleep(1300);
  const give = await page.$('.ct-give.ok');
  if (give) {
    await give.click({ force: true });
    await sleep(2600); // fly-out, swap, the dealer falls content
    traded = true;
  }
}
console.log(traded ? 'offer taken' : 'no dealer bit');
await sleep(1300);

// Back to the void table.
await click('.ct-back');
await page.waitForSelector('#card-hand .world-card', { timeout: 10000 });
await sleep(1800);

// ── The dive into a specimen world. ──
console.log('dive');
await click('#card-hand .world-card .wc-enter');
await sleep(2900); // swell + white + reload (realm remounts under ?cardrealm)

// The arrival on the plain URL with the hop flag re-armed, so the
// zoom-out-of-white plays and the alien membrane border shows.
await page.evaluate(() => sessionStorage.setItem('rts.cardhop', '1')).catch(() => {});
await page.goto(PLAIN, { waitUntil: 'domcontentloaded' });
await sleep(4200); // arrival zoom + a beat inside the bordered world

// ── The pull-back, and the void once more. ──
console.log('leave world');
const leave = await page.$('#leave-world-btn');
if (leave) { await leave.click(); await sleep(5200); }
await page.goto(REALM, { waitUntil: 'networkidle' });
await page.waitForSelector('#card-hand .world-card', { timeout: 20000 }).catch(() => {});
await sleep(5000); // hold on the settled dark void to close

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
  try { execFileSync(ffmpeg, ['-version'], { stdio: 'ignore' }); }
  catch { ffmpeg = (await import('ffmpeg-static')).default; }
  const webm = path.join(OUT_DIR, newest.f);
  const mp4 = path.join(OUT_DIR, 'exchange-of-spheres.mp4');
  console.log('Converting to mp4…');
  execFileSync(ffmpeg, [
    '-y', '-i', webm,
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '23',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    '-profile:v', 'high', '-level', '4.0', mp4,
  ], { stdio: 'inherit' });
  fs.unlinkSync(webm);
  console.log('Saved:', mp4);
}
