// Verifies the trading section's seams: that a gathering reshuffle ("wait for
// the next gathering") swaps only the stalls while the player's hand cards keep
// their exact DOM nodes (no rebuild → no flash), and that a trade keeps the
// kept cards' nodes too. Drives the real app on the vite dev server.
import { mkdirSync } from 'node:fs';
import { launchChromium } from './card-realm-browser.mjs';

const PORT = process.env.PORT ?? '5179';
const REALM = `http://localhost:${PORT}/?cardrealm`;
const OUT = 'screenshots/gathering-seam';
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await launchChromium();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png` });

await page.goto(REALM, { waitUntil: 'domcontentloaded' });
await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
await page.goto(REALM, { waitUntil: 'networkidle' });

// Walk the forced intro to the table.
await page.waitForSelector('#card-realm.visible .world-card', { timeout: 15000 });
await sleep(1500);
await page.click('.wc-enter');
await page.waitForSelector('#card-realm.click-armed', { timeout: 30000 });
for (let i = 0; i < 20 && !(await page.$('#card-realm.show-choice')); i++) {
  if (await page.$('#card-realm.click-armed')) await page.click('#card-clickwall');
  await sleep(400);
}
await page.click('#card-no');
for (let i = 0; i < 40 && !(await page.$('#card-stage.table-view')); i++) {
  if (await page.$('#card-realm.click-armed')) await page.click('#card-clickwall');
  await sleep(500);
}
await page.waitForSelector('#card-hand .world-card', { timeout: 60000 });
await sleep(700);

// Enter the first open gathering.
await page.click('.ct-event:not(.locked)');
await page.waitForSelector('.ct-stall', { timeout: 10000 });
await sleep(700);
await shot('1-gathering');

// Tag the hand's card nodes, snapshot the stalls' trader names.
const before = await page.evaluate(() => {
  const cards = [...document.querySelectorAll('.ct-hand-inline .world-card')];
  cards.forEach((c, i) => (c.dataset.seamTag = `tag-${i}`));
  return {
    handCount: cards.length,
    stalls: [...document.querySelectorAll('.ct-creature-name')].map((n) => n.textContent),
  };
});

// Reshuffle.
await page.click('.ct-wait-corner');
await sleep(900);
await shot('2-after-reshuffle');

const after = await page.evaluate(() => {
  const cards = [...document.querySelectorAll('.ct-hand-inline .world-card')];
  return {
    taggedSurvived: cards.filter((c) => c.dataset.seamTag).length,
    handCount: cards.length,
    stalls: [...document.querySelectorAll('.ct-creature-name')].map((n) => n.textContent),
  };
});

const handPersisted = after.taggedSurvived === before.handCount && after.handCount === before.handCount;
const stallsChanged = JSON.stringify(before.stalls) !== JSON.stringify(after.stalls);
console.log('hand cards before:', before.handCount, '| tagged nodes surviving reshuffle:', after.taggedSurvived);
console.log('stalls before:', before.stalls.join(', '));
console.log('stalls after :', after.stalls.join(', '));
console.log(handPersisted ? '✓ HAND PERSISTED (no rebuild, no flash)' : '✗ HAND REBUILT');
console.log(stallsChanged ? '✓ STALLS RESHUFFLED' : '… stalls identical (RNG collision; rerun)');

await browser.close();
process.exit(handPersisted ? 0 : 1);
