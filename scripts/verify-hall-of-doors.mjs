// Smoke-test of the hall of doors (the trading realm's branching base level),
// driven through the real app on the vite dev server (npm run dev -- --port
// 5179). Seeds a 'free'-phase meta so the realm lands straight on the hall,
// then: checks the hall renders its doors + the sealed next door, unseals a
// second door (landing in its common threshold), walks back out to the hall,
// and enters branch 0's soft border. Saves PNGs to screenshots/hall-of-doors.
import { mkdirSync, readdirSync } from 'node:fs';
import { launchChromium } from './card-realm-browser.mjs';

const PORT = process.env.PORT ?? '5179';
const REALM = `http://localhost:${PORT}/?cardrealm`;
const OUT = 'screenshots/hall-of-doors';
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (msg) => { console.error('FAIL:', msg); process.exitCode = 1; };

const browser = await launchChromium();
const page = await browser.newPage({
  viewport: { width: 1280, height: 800 },
  reducedMotion: 'reduce',
});
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png` });

// Fresh state, then a minimal free-phase meta: one blank-data common in hand
// (the panes just render empty), no salons yet — ensureHall seeds branch 0 on
// the hall's first show.
await page.goto(REALM, { waitUntil: 'domcontentloaded' });
await page.evaluate(() => {
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem('rts.cards.v1', JSON.stringify({
    v: 1, phase: 'free', seed: 12345, nextId: 500, resets: 0,
    cards: [{ id: 1, name: 'test world', tier: 'common', data: '', resources: { money: 0, blood: 0, dragonBone: 0 } }],
    events: null, activeCardId: null,
  }));
});
await page.goto(REALM, { waitUntil: 'networkidle' });

// 1. The hall: one open door (the soft border), the sealed next, the ghost.
await page.waitForSelector('#card-stage.hub-view', { timeout: 20000 });
await sleep(1200);
const hall1 = await page.evaluate(() => ({
  open: document.querySelectorAll('.ct-hub-door.open').length,
  sealed: document.querySelectorAll('.ct-hub-sealed').length,
  ghost: document.querySelectorAll('.ct-hub-ghost').length,
  title: document.querySelector('.ct-event-title')?.textContent,
  firstLabel: document.querySelector('.ct-hub-door.open .ct-door-label')?.textContent,
  pips: document.querySelectorAll('.ct-hub-door.open .ct-pip').length,
}));
console.log('hall (fresh):', JSON.stringify(hall1));
if (hall1.open !== 1 || hall1.sealed !== 1 || hall1.ghost !== 1) fail('fresh hall should show 1 open + 1 sealed + 1 ghost door');
if (hall1.firstLabel !== 'the soft border') fail(`door 1 label: ${hall1.firstLabel}`);
if (hall1.pips !== 1) fail(`fresh door should wear exactly 1 pip, got ${hall1.pips}`);
await shot('1-hall-fresh');

// 2. Unseal the next door — the ceremony plays, then its threshold salon.
await page.click('.ct-hub-sealed');
await sleep(600);
await shot('2-unsealing');
await page.waitForSelector('#card-stage.gathering-view:not(.hub-view)', { timeout: 15000 });
await sleep(1500);
const salon2 = await page.evaluate(() => ({
  level: document.querySelector('.ct-level')?.textContent,
  title: document.querySelector('.ct-event-title')?.textContent,
  stalls: document.querySelectorAll('.ct-stall').length,
  backLabel: document.querySelector('.ct-door-back .ct-door-label')?.textContent,
}));
console.log('door 2 threshold:', JSON.stringify(salon2));
if (salon2.level !== 'door 2 · level 1') fail(`threshold head: ${salon2.level}`);
if (!/^gathering at the [a-z]+ threshold$/.test(salon2.title ?? '')) fail(`threshold title: ${salon2.title}`);
if (salon2.backLabel !== '← the hall of doors') fail(`back door label: ${salon2.backLabel}`);
await shot('3-door2-threshold');

// 3. Back out into the hall: two open doors now, still one sealed + ghost.
await page.click('.ct-door-back');
await page.waitForSelector('#card-stage.hub-view', { timeout: 15000 });
await sleep(1200);
const hall2 = await page.evaluate(() => ({
  open: document.querySelectorAll('.ct-hub-door.open').length,
  sealed: document.querySelectorAll('.ct-hub-sealed').length,
  counter: document.querySelector('.ct-level')?.textContent,
  labels: [...document.querySelectorAll('.ct-hub-door.open .ct-door-label')].map((el) => el.textContent),
  coolLabel: document.querySelector('.ct-hub-sealed.cooling .ct-door-label')?.textContent,
}));
console.log('hall (2 doors):', JSON.stringify(hall2));
if (hall2.open !== 2 || hall2.sealed !== 1) fail('hall should now show 2 open doors + 1 sealed');
if (hall2.counter !== '2 doors unsealed') fail(`hall counter: ${hall2.counter}`);
// The seal we just broke restarts the clock: the next door counts down from
// 90 and only rattles when clicked.
if (!/^\d+$/.test(hall2.coolLabel ?? '') || Number(hall2.coolLabel) > 90) fail(`cooldown label: ${hall2.coolLabel}`);
const openBefore = hall2.open;
await page.click('.ct-hub-sealed');
await sleep(600);
const openAfter = await page.evaluate(() => document.querySelectorAll('.ct-hub-door.open').length);
if (openAfter !== openBefore) fail('a cooling seal should not unseal on click');
await shot('4-hall-two-doors');

// 4. Door 1 still leads to the hand-authored soft border (pre-reset).
await page.click('.ct-hub-door.open');
await page.waitForSelector('#card-stage.gathering-view:not(.hub-view)', { timeout: 15000 });
await sleep(1500);
const salon1 = await page.evaluate(() => ({
  level: document.querySelector('.ct-level')?.textContent,
  title: document.querySelector('.ct-event-title')?.textContent,
  names: [...document.querySelectorAll('.ct-creature-name')].map((el) => el.textContent),
}));
console.log('door 1 threshold:', JSON.stringify(salon1));
if (salon1.level !== 'door 1 · level 1') fail(`soft border head: ${salon1.level}`);
if (salon1.title !== 'gathering at the soft border') fail(`soft border title: ${salon1.title}`);
if (!salon1.names?.includes('the pale one')) fail('door 1 pre-reset should seat the pale one');
await shot('5-soft-border');

// 5. Reload lands back on the hall with both doors remembered (persistence).
// (domcontentloaded — a booted game can hold the network busy past idle.)
await page.goto(REALM, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#card-stage.hub-view', { timeout: 20000 });
await sleep(1200);
const hall3 = await page.evaluate(() => ({
  open: document.querySelectorAll('.ct-hub-door.open').length,
}));
console.log('hall (reloaded):', JSON.stringify(hall3));
if (hall3.open !== 2) fail('reload should keep both unsealed doors');

// 6. Phone-portrait hall for the responsive pass.
await page.setViewportSize({ width: 390, height: 844 });
await sleep(600);
await shot('6-hall-phone');

await browser.close();
console.log(process.exitCode ? 'FAILED' : 'ok:', readdirSync(OUT).join(', '));
