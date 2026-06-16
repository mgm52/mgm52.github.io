// Quick desktop screenshot tour of the trading realm: intro card, table,
// gathering. Saves to screenshots/realm. Used during the redesign to eyeball
// each view. Skips the goblin dialogue fast.
import { mkdirSync } from 'node:fs';
import { launchChromium } from './card-realm-browser.mjs';

const PORT = process.env.PORT ?? '5179';
const REALM = `http://localhost:${PORT}/?cardrealm`;
const OUT = process.env.OUT ?? 'screenshots/realm';
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await launchChromium();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png` });
const click = (sel) => page.click(sel, { force: true });

// White underlay (the realm normally rises from the finale white-out).
await page.addInitScript(() => {
  addEventListener('DOMContentLoaded', () => {
    const d = document.createElement('div');
    d.style.cssText = 'position:fixed;inset:0;background:#fff;z-index:100000;pointer-events:none;';
    document.body.appendChild(d);
  });
});

await page.goto(REALM, { waitUntil: 'domcontentloaded' });
await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
await page.goto(REALM, { waitUntil: 'networkidle' });

await page.waitForSelector('#card-realm.visible .world-card', { timeout: 20000 });
await sleep(2500);
await shot('1-intro');
await click('.wc-enter');
for (let i = 0; i < 30; i++) {
  if (await page.$('#card-realm.show-choice')) break;
  if (await page.$('#card-realm.click-armed')) { await sleep(120); await click('#card-clickwall'); }
  await sleep(300);
}
await sleep(400);
await shot('2-goblin');
await click('#card-no');
for (let i = 0; i < 160; i++) {
  if (await page.$('#card-stage.table-view')) break;
  if (await page.$('#card-realm.click-armed')) { await sleep(120); await click('#card-clickwall'); }
  await sleep(250);
}
await page.waitForSelector('#card-hand .world-card', { timeout: 60000 });
await sleep(1500);
await shot('3-table');

await click('.ct-event:not(.locked)');
await page.waitForSelector('.ct-stall', { timeout: 10000 });
await sleep(1500);
await shot('4-gathering');

// Pick a hand card to show the want/give response.
const mine = await page.$('.ct-hand-inline .world-card');
if (mine) { await mine.click({ force: true }); await sleep(900); await shot('5-picked'); }

await browser.close();
console.log('done');
