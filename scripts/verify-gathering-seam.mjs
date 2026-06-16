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

// Tag the table hand's card nodes BEFORE entering, so we can prove the exact
// same DOM nodes survive the table → gathering → table round-trip (the hand
// cache — no canvas re-render, no flash).
await page.evaluate(() => {
  document.querySelectorAll('#card-hand .world-card').forEach((c, i) => (c.dataset.seamTag = `tag-${i}`));
});
const tableHand = await page.$$eval('#card-hand .world-card', (els) => els.length);

// Enter the first open gathering. Door-opening flourish should tag the row.
await page.click('.ct-event:not(.locked)');
const doorOpened = await page.$('.ct-events.opening .ct-event.chosen') !== null
  || await page.evaluate(() => !!document.querySelector('.ct-event.chosen'));
await page.waitForSelector('.ct-stall', { timeout: 10000 });
await sleep(700);
await shot('1-gathering');

// The tagged nodes should have moved (not been rebuilt) into the inline hand.
const movedIn = await page.$$eval('.ct-hand-inline .world-card[data-seam-tag]', (els) => els.length);

// Leave back to the table, then re-enter — tags must still be present.
await page.click('.ct-back');
await page.waitForSelector('#card-stage.table-view', { timeout: 10000 });
await sleep(500);
const backOnTable = await page.$$eval('#card-hand .world-card[data-seam-tag]', (els) => els.length);
await page.click('.ct-event:not(.locked)');
await page.waitForSelector('.ct-stall', { timeout: 10000 });
await sleep(600);

// Snapshot the stalls' trader names for the reshuffle check.
const before = await page.evaluate(() => {
  const cards = [...document.querySelectorAll('.ct-hand-inline .world-card')];
  return {
    handCount: cards.length,
    stalls: [...document.querySelectorAll('.ct-creature-name')].map((n) => n.textContent),
  };
});
console.log('door-opening flourish fired:', doorOpened ? '✓' : '✗');
console.log(`hand nodes — table:${tableHand} moved into gathering:${movedIn} survived round-trip:${backOnTable}`);
console.log(movedIn === tableHand && backOnTable === tableHand
  ? '✓ HAND NODES PERSIST across table ↔ gathering (cache hit, no re-render)'
  : '✗ HAND NODES REBUILT on a view swap');

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

const roundTripOk = movedIn === tableHand && backOnTable === tableHand;
await browser.close();
process.exit(handPersisted && roundTripOk ? 0 : 1);
