// Quick street-view screenshots: seed a 'free'-phase meta so the realm lands
// straight on the 3-D street (no goblin intro), then shoot it. Used to eyeball
// the dev-tuned defaults + home facing.
import { mkdirSync } from 'node:fs';
import { launchChromium } from './card-realm-browser.mjs';

const PORT = process.env.PORT ?? '5179';
const REALM = `http://localhost:${PORT}/?cardrealm`;
const OUT = 'screenshots/street';
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await launchChromium();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));

await page.goto(REALM, { waitUntil: 'domcontentloaded' });
await page.evaluate(() => {
  localStorage.clear(); sessionStorage.clear();
  localStorage.setItem('rts.cards.v1', JSON.stringify({
    v: 1, phase: 'free', seed: 1234, nextId: 1, cards: [], events: null, activeCardId: null,
  }));
});
await page.goto(REALM, { waitUntil: 'networkidle' });
await page.waitForSelector('#card-stage.street-view .sv-scene', { timeout: 20000 });
await sleep(2500);
await page.screenshot({ path: `${OUT}/street.png` });

// Step further down the street if there's more than one row.
const fwd = await page.$('.sv-step-fwd:not([disabled])');
if (fwd) { await fwd.click(); await sleep(1400); await page.screenshot({ path: `${OUT}/street-row2.png` }); }

await browser.close();
console.log('done');
