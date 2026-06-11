// Screenshot tour of the trading-card realm, driven through the real app on
// the vite dev server (npm run dev -- --port 5179). Walks the goblin intro
// (clicking through typed lines), the table, a gathering, a trade view, and
// the enter/leave-world transitions, saving PNGs to screenshots/card-realm.
//
// The ?cardrealm dev param mounts the realm without playing the finale; the
// in-world beats navigate to the plain URL afterwards because the param
// would re-mount the realm OVER the card world.
import { mkdirSync, readdirSync } from 'node:fs';
import { launchChromium } from './card-realm-browser.mjs';

const PORT = process.env.PORT ?? '5179';
const REALM = `http://localhost:${PORT}/?cardrealm`;
const PLAIN = `http://localhost:${PORT}/`;
const OUT = 'screenshots/card-realm';
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await launchChromium();
// reducedMotion stills the realm's ambient drift (card levitation, auroras —
// index.html's prefers-reduced-motion block) so clicks pass playwright's
// stability check and the shots are deterministic.
const page = await browser.newPage({
  viewport: { width: 1280, height: 800 },
  reducedMotion: 'reduce',
});
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png` });
// Mid-transition frames race the page's own reload; a hung screenshot (it
// waits for the next page's fonts) must not sink the tour.
const shotQuick = (name) =>
  page.screenshot({ path: `${OUT}/${name}.png`, timeout: 5000 })
    .catch(() => console.log(`(skipped ${name} — caught mid-navigation)`));

// Fresh state.
await page.goto(REALM, { waitUntil: 'domcontentloaded' });
await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
await page.goto(REALM, { waitUntil: 'networkidle' });

// 1. The origin card dealt onto the table (realm waits 2.6s, then deals).
await page.waitForSelector('#card-realm.visible .world-card', { timeout: 15000 });
await sleep(1500); // deal transition settles
await shot('1-origin-dealt');

// 2. Reach for REENTER → "wait a moment!" → goblin descends. Wait for the
// first conversational line to arm the click wall.
await page.click('.wc-enter');
await page.waitForSelector('#card-realm.click-armed', { timeout: 30000 });
await sleep(400);
await shot('2-goblin-objects');

// 3. Click through lines until the YES/NO choice shows.
for (let i = 0; i < 20; i++) {
  if (await page.$('#card-realm.show-choice')) break;
  if (await page.$('#card-realm.click-armed')) await page.click('#card-clickwall');
  await sleep(500);
}
await page.waitForSelector('#card-realm.show-choice', { timeout: 30000 });
await sleep(800); // card dip + button fade settle
await shot('3-choice');

// 4. Answer NO, click through the taking/giving until the table view.
await page.click('#card-no');
for (let i = 0; i < 40; i++) {
  if (await page.$('#card-stage.table-view')) break;
  if (await page.$('#card-realm.click-armed')) await page.click('#card-clickwall');
  await sleep(600);
}
await page.waitForSelector('#card-hand .world-card', { timeout: 60000 });
await sleep(900);
await shot('4-table');

// 5. Enter the common gathering.
await page.click('.ct-event:not(.locked)');
await page.waitForSelector('.ct-creature', { timeout: 10000 });
await sleep(900);
await shot('5-gathering');

// 6. Talk to the first creature, pick one of ITS cards first (the new flow),
// then one of ours from the hand — verdict flips to "✓ trade", arrow lights.
await page.click('.ct-creature');
await page.waitForSelector('#card-stage.trade-view', { timeout: 10000 });
await sleep(800);
const theirs = await page.$('.ct-theirs .world-card');
if (theirs) { await theirs.click(); await sleep(700); }
await shot('6a-trade-their-pick');
const mine = await page.$('#card-hand .world-card:not(.grayed)');
if (mine) { await mine.click(); await sleep(700); }
await shot('6b-trade-balanced');

// 7. Phone-portrait table for the responsive pass.
await page.setViewportSize({ width: 390, height: 844 });
await page.goto(REALM, { waitUntil: 'networkidle' });
await page.waitForSelector('#card-hand .world-card', { timeout: 20000 });
await sleep(900);
await shot('7-table-phone');

// 8. The dive: REENTER WORLD — the card swells as the white takes over.
await page.setViewportSize({ width: 1280, height: 800 });
await page.goto(REALM, { waitUntil: 'networkidle' });
await page.waitForSelector('#card-hand .world-card', { timeout: 20000 });
await page.click('.wc-enter');
await sleep(450); // mid-dive
await shotQuick('8-dive-into-card');
await sleep(2500); // the reload lands (realm remounts over the world — ignored)

// 9. The arrival: re-arm the hop flag and boot the card world on the plain
// URL so the zoom-out-of-white plays without the realm overlay.
await page.evaluate(() => sessionStorage.setItem('rts.cardhop', '1'));
await page.goto(PLAIN, { waitUntil: 'domcontentloaded' });
await sleep(800); // mid arrival zoom
await shotQuick('9-arrive-zoom');
await sleep(3500); // settle; pixi paints
await shot('10-inside-card-world');

// 10. The pull-back: LEAVE WORLD — the world recedes to a point.
await page.click('#leave-world-btn');
await sleep(650); // mid exit zoom
await shotQuick('11-leave-zoom');
await sleep(1500); // reload to the outer world

// 11. Back on the table: the card remembers the visit.
await page.goto(REALM, { waitUntil: 'networkidle' });
await page.waitForSelector('#card-hand .world-card', { timeout: 20000 });
await sleep(900);
await shot('12-table-after-visit');

await browser.close();
console.log('done:', readdirSync(OUT).join(', '));
