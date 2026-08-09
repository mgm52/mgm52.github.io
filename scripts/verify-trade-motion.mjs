// Smoke-test of the trade animation (cards.ts executeTrade): seeds a
// free-phase meta, walks into the soft border, trades the lone held world to
// the pale one, and checks the motion lifecycle — cards lift into fixed
// flight, placeholders hold the arrivals' spots, and after the dust settles
// the hand holds exactly the received cards with no stray flying nodes, no
// leftover placeholders, and the stall folded to spent. PNGs land in
// screenshots/trade-motion.
import { mkdirSync, readdirSync } from 'node:fs';
import { launchChromium } from './card-realm-browser.mjs';

const PORT = process.env.PORT ?? '5179';
const REALM = `http://localhost:${PORT}/?cardrealm`;
const OUT = 'screenshots/trade-motion';
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (msg) => { console.error('FAIL:', msg); process.exitCode = 1; };

const browser = await launchChromium();
// reducedMotion stills the ambient levitation so playwright's stability
// check can hover/click; the trade flights themselves are inline transitions
// and still run under it.
const page = await browser.newPage({
  viewport: { width: 1280, height: 800 },
  reducedMotion: 'reduce',
});
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png` });

await page.goto(REALM, { waitUntil: 'domcontentloaded' });
await page.evaluate(() => {
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem('rts.cards.v1', JSON.stringify({
    v: 1, phase: 'free', seed: 12345, nextId: 500, resets: 0,
    cards: [
      { id: 1, name: 'test world', tier: 'common', data: '', resources: { money: 0, blood: 0, dragonBone: 0 } },
      { id: 2, name: 'the gilded charm', tier: 'common', data: '', resources: { money: 0, blood: 0, dragonBone: 0 }, charm: 'gold' },
    ],
    events: null, activeCardId: null,
  }));
});
await page.goto(REALM, { waitUntil: 'networkidle' });

// Into door 1: the soft border (the pale one wants any 1 world, holds 2).
await page.waitForSelector('#card-stage.hub-view', { timeout: 20000 });
await sleep(1000);
await page.click('.ct-hub-door.open');
await page.waitForSelector('.ct-stall', { timeout: 15000 });
await sleep(1500);

// The charm rides in the hand beside the world: its READ button holds the
// full reading up on a plaque, and a click puts it down.
await page.hover('.ct-hand-inline .wc-charmcard');
await page.click('.ct-hand-inline .wc-charmcard .wc-enter');
await sleep(500);
const reading = await page.evaluate(() => ({
  visible: !!document.querySelector('#charm-read.visible'),
  name: document.querySelector('.charm-read-name')?.textContent,
  desc: document.querySelector('.charm-read-desc')?.textContent ?? '',
}));
console.log('charm read:', JSON.stringify({ ...reading, desc: `${reading.desc.slice(0, 40)}…` }));
if (!reading.visible) fail('READ should hold the charm plaque up');
if (reading.name !== 'the gilded charm') fail(`plaque name: ${reading.name}`);
if (!reading.desc.includes('golden goblin')) fail('plaque should carry the full description');
await shot('0-charm-read');
await page.click('#charm-read');
await sleep(400);
if (await page.$('#charm-read')) fail('a click should put the reading down');

// Select the held world (its SELECT button reveals on hover), confirm with
// the pale one.
await page.hover('.ct-hand-inline .world-card[data-card-id="1"]');
await page.click('.ct-hand-inline .world-card[data-card-id="1"] .wc-select');
await sleep(400);
await shot('1-selected');
const confirm = await page.$('.ct-stall .ct-confirm.ok');
if (!confirm) { fail('no lit confirm button after selecting a matching card'); process.exit(1); }
await confirm.click();

// Mid-flight: lifted cards ride fixed on <body>, a placeholder holds each
// arrival's spot, and the stall is easing toward spent.
await sleep(320);
const mid = await page.evaluate(() => ({
  flying: [...document.body.children].filter((el) => el.classList?.contains('world-card')).length,
  slots: document.querySelectorAll('.ct-hand-inline .world-card.trade-slot').length,
  spending: !!document.querySelector('.ct-stall.spending'),
}));
console.log('mid-flight:', JSON.stringify(mid));
if (mid.flying < 3) fail(`expected 3 cards in flight (1 given + 2 received), got ${mid.flying}`);
if (mid.slots !== 2) fail(`expected 2 placeholders holding arrival spots, got ${mid.slots}`);
if (!mid.spending) fail('stall should be easing toward spent during the flight');
await shot('2-mid-flight');

// Settled: the hand holds exactly the 2 received cards, everything transient
// is gone, and the stall reads spent with its box folded away.
await sleep(1800);
const after = await page.evaluate(() => ({
  hand: document.querySelectorAll('.ct-hand-inline .world-card').length,
  slots: document.querySelectorAll('.world-card.trade-slot').length,
  landed: document.querySelectorAll('.ct-hand-inline .world-card.trade-landed').length,
  strays: [...document.body.children].filter((el) => el.classList?.contains('world-card')).length,
  spent: !!document.querySelector('.ct-stall.spent'),
  spending: !!document.querySelector('.ct-stall.spending'),
  line: document.querySelector('.ct-stall.spent .ct-creature-line')?.textContent,
  held: JSON.parse(localStorage.getItem('rts.cards.v1')).cards.length,
}));
console.log('settled:', JSON.stringify(after));
if (after.hand !== 3) fail(`hand should hold the charm + 2 received cards, got ${after.hand}`);
if (after.slots !== 0) fail('no placeholder should survive the landing');
if (after.landed !== 2) fail(`both arrivals should wear the landing flash, got ${after.landed}`);
if (after.strays !== 0) fail(`no flown card should be left on <body>, got ${after.strays}`);
if (!after.spent || after.spending) fail('stall should have settled from spending into spent');
if (after.held !== 3) fail(`meta should hold 3 cards, got ${after.held}`);
await shot('3-settled');

await browser.close();
console.log(process.exitCode ? 'FAILED' : 'ok:', readdirSync(OUT).join(', '));
