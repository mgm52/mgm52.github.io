// Mobile-focused screenshot tour of the trading-card realm: walks to the
// gathering + trade views at phone-portrait size, where the two-card-row
// trade layout is tightest. Saves to screenshots/mobile-trade.
import { mkdirSync, readdirSync } from 'node:fs';
import { launchChromium } from './card-realm-browser.mjs';

const PORT = process.env.PORT ?? '5179';
const REALM = `http://localhost:${PORT}/?cardrealm`;
const OUT = process.env.OUT ?? 'screenshots/mobile-trade';
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await launchChromium();
const page = await browser.newPage({
  viewport: { width: 390, height: 844 },
  reducedMotion: 'reduce',
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
});
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png` });

await page.goto(REALM, { waitUntil: 'domcontentloaded' });
await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
await page.goto(REALM, { waitUntil: 'networkidle' });

// Skip the goblin intro: just get to the table. The realm deals the origin
// card; click ENTER then walk the dialogue to NO → table.
await page.waitForSelector('#card-realm.visible .world-card', { timeout: 15000 });
await sleep(1200);
await shot('1-intro-card');

await page.click('.wc-enter');
await page.waitForSelector('#card-realm.click-armed', { timeout: 30000 });
for (let i = 0; i < 20; i++) {
  if (await page.$('#card-realm.show-choice')) break;
  if (await page.$('#card-realm.click-armed')) await page.click('#card-clickwall');
  await sleep(450);
}
await page.waitForSelector('#card-realm.show-choice', { timeout: 30000 });
await sleep(600);
await shot('2-choice');
await page.click('#card-no');
for (let i = 0; i < 40; i++) {
  if (await page.$('#card-stage.table-view')) break;
  if (await page.$('#card-realm.click-armed')) await page.click('#card-clickwall');
  await sleep(500);
}
await page.waitForSelector('#card-hand .world-card', { timeout: 60000 });
await sleep(800);
await shot('3-table');

// Gathering.
await page.click('.ct-event:not(.locked)');
await page.waitForSelector('.ct-creature', { timeout: 10000 });
await sleep(700);
await shot('4-gathering');

// Trade view.
await page.click('.ct-creature');
await page.waitForSelector('#card-stage.trade-view', { timeout: 10000 });
await sleep(700);
await shot('5-trade-empty');
const theirs = await page.$('.ct-theirs .world-card');
if (theirs) { await theirs.click(); await sleep(600); }
await shot('6-trade-their-pick');
const mine = await page.$('#card-hand .world-card:not(.grayed)');
if (mine) { await mine.click(); await sleep(600); }
await shot('7-trade-balanced');

await browser.close();
console.log('done:', readdirSync(OUT).join(', '));
