// Smoke-test of the hall of doors (the trading realm's branching base level),
// driven through the real app on the vite dev server (npm run dev -- --port
// 5179). Seeds a fresh 'free'-phase meta (doorsUnsealed: 0), then: checks the
// hall starts fully sealed, unseals door 1 (which settles open IN PLACE — no
// walking through) while the seal re-forms one door along with its countdown
// running, checks the countdown rattles off clicks and flips back to
// 'unseal' when it runs dry, enters both chains, and checks persistence
// across a reload. Saves PNGs to screenshots/hall-of-doors.
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

// Fresh state: a minimal free-phase meta with the hall fully sealed, one
// blank-data common in hand (the panes just render empty), no salons yet —
// ensureHall seeds branch 0 on the hall's first show.
await page.goto(REALM, { waitUntil: 'domcontentloaded' });
await page.evaluate(() => {
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem('rts.cards.v1', JSON.stringify({
    v: 1, phase: 'free', seed: 12345, nextId: 500, resets: 0, doorsUnsealed: 0,
    cards: [{ id: 1, name: 'test world', tier: 'common', data: '', resources: { money: 0, blood: 0, dragonBone: 0 } }],
    events: null, activeCardId: null,
  }));
});
await page.goto(REALM, { waitUntil: 'networkidle' });

// 1. The fresh hall: no doors open, one sealed (ready — no countdown on a
// realm that has never unsealed), one ghost.
await page.waitForSelector('#card-stage.hub-view', { timeout: 20000 });
await sleep(1200);
const hall1 = await page.evaluate(() => ({
  open: document.querySelectorAll('.ct-hub-door.open').length,
  sealed: document.querySelectorAll('.ct-hub-sealed').length,
  ghost: document.querySelectorAll('.ct-hub-ghost').length,
  counter: document.querySelector('.ct-level')?.textContent,
  sealedLabel: document.querySelector('.ct-hub-sealed .ct-door-label')?.textContent,
  cooling: !!document.querySelector('.ct-hub-sealed.cooling'),
}));
console.log('hall (fresh):', JSON.stringify(hall1));
if (hall1.open !== 0 || hall1.sealed !== 1 || hall1.ghost !== 1) fail('fresh hall should show 0 open + 1 sealed + 1 ghost');
if (hall1.counter !== '0 doors unsealed') fail(`fresh counter: ${hall1.counter}`);
if (hall1.sealedLabel !== 'unseal' || hall1.cooling) fail('a never-unsealed hall should hold no countdown');
await shot('1-hall-sealed');

// 2. Unseal door 1: the ceremony plays and the door settles open IN PLACE —
// still the hall, nobody walks through — while the seal re-forms one door
// along, counting down from 90.
await page.click('.ct-hub-sealed');
await sleep(1600);
const hall2 = await page.evaluate(() => ({
  view: document.querySelector('#card-stage')?.className,
  open: document.querySelectorAll('.ct-hub-door.open').length,
  sealed: document.querySelectorAll('.ct-hub-sealed').length,
  counter: document.querySelector('.ct-level')?.textContent,
  door1: document.querySelector('.ct-hub-door.open .ct-door-label')?.textContent,
  door1Lvl: document.querySelector('.ct-hub-door.open .ct-hub-lvl')?.textContent,
  coolLabel: document.querySelector('.ct-hub-sealed.cooling .ct-door-label')?.textContent,
}));
console.log('hall (door 1 unsealed):', JSON.stringify(hall2));
if (!hall2.view?.includes('hub-view')) fail('unsealing must not walk through — still the hall');
if (hall2.open !== 1 || hall2.sealed !== 1) fail('hall should show 1 open + 1 fresh sealed');
if (hall2.counter !== '1 door unsealed') fail(`counter: ${hall2.counter}`);
if (hall2.door1 !== 'the soft border' || hall2.door1Lvl !== 'level 1') fail(`door 1: ${hall2.door1} / ${hall2.door1Lvl}`);
if (!/^\d+$/.test(hall2.coolLabel ?? '') || Number(hall2.coolLabel) > 90) fail(`fresh seal countdown: ${hall2.coolLabel}`);
await shot('2-door1-open-seal-cooling');

// 3. A cooling seal only rattles — and floats a "wait Ns" explainer.
await page.click('.ct-hub-sealed');
await sleep(250);
const coolFloat = await page.evaluate(() =>
  document.querySelector('.ct-hub-sealed .ct-door-float.hint')?.textContent ?? null);
console.log('cooling click float:', JSON.stringify(coolFloat));
if (!/^wait \d+s$/.test(coolFloat ?? '')) fail(`cooling click should float 'wait Ns', got ${coolFloat}`);
await sleep(400);
const stillOne = await page.evaluate(() => document.querySelectorAll('.ct-hub-door.open').length);
if (stillOne !== 1) fail('a cooling seal must not unseal on click');

// 4. Entering is its own deliberate click: door 1 leads to the hand-authored
// soft border (pre-reset).
await page.click('.ct-hub-door.open');
await page.waitForSelector('.ct-stall', { timeout: 15000 });
await sleep(1500);
const salon1 = await page.evaluate(() => ({
  level: document.querySelector('.ct-level')?.textContent,
  title: document.querySelector('.ct-event-title')?.textContent,
  names: [...document.querySelectorAll('.ct-creature-name')].map((el) => el.textContent),
  backLabel: document.querySelector('.ct-door-back .ct-door-label')?.textContent,
}));
console.log('door 1 threshold:', JSON.stringify(salon1));
if (salon1.level !== 'door 1 · level 1') fail(`soft border head: ${salon1.level}`);
if (salon1.title !== 'gathering at the soft border') fail(`soft border title: ${salon1.title}`);
if (!salon1.names?.includes('the pale one')) fail('door 1 pre-reset should seat the pale one');
if (salon1.backLabel !== '← the hall of doors') fail(`back door label: ${salon1.backLabel}`);
// The keyless forward door floats its own explainer instead of a bare
// "locked".
await page.click('.ct-door-fwd');
await sleep(250);
const keyFloat = await page.evaluate(() =>
  document.querySelector('.ct-door-fwd .ct-door-float.hint')?.textContent ?? null);
console.log('locked door float:', JSON.stringify(keyFloat));
if (keyFloat !== 'the gatekeeper holds the key') fail(`locked door float: ${keyFloat}`);
await shot('3-soft-border');

// 5. The countdown flips back to 'unseal' when it runs dry: rewind the stamp
// so ~20s remain (a slow headless boot can drain several seconds before the
// hall renders), reload, confirm it's still counting, then watch it settle.
await page.evaluate(() => {
  const m = JSON.parse(localStorage.getItem('rts.cards.v1'));
  m.lastUnsealAt = Date.now() - 70_000;
  localStorage.setItem('rts.cards.v1', JSON.stringify(m));
});
await page.goto(REALM, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#card-stage.hub-view', { timeout: 20000 });
const sealState = () => page.evaluate(() => ({
  cooling: !!document.querySelector('.ct-hub-sealed.cooling'),
  label: document.querySelector('.ct-hub-sealed .ct-door-label')?.textContent,
}));
const nearDone = await sealState();
console.log('seal (~20s left):', JSON.stringify(nearDone));
if (!nearDone.cooling || !/^\d+$/.test(nearDone.label ?? '') || Number(nearDone.label) > 20) fail(`expected a short countdown, got ${JSON.stringify(nearDone)}`);
let ready = nearDone;
for (let i = 0; i < 25 && (ready.cooling || ready.label !== 'unseal'); i++) {
  await sleep(1000);
  ready = await sealState();
}
console.log('seal (run dry):', JSON.stringify(ready));
if (ready.cooling || ready.label !== 'unseal') fail(`countdown should settle to 'unseal', got ${JSON.stringify(ready)}`);
await shot('4-seal-ready-again');

// 6. Unseal door 2, then enter its procedural threshold.
await page.click('.ct-hub-sealed');
await sleep(1600);
const hall3 = await page.evaluate(() => ({
  open: document.querySelectorAll('.ct-hub-door.open').length,
  counter: document.querySelector('.ct-level')?.textContent,
}));
console.log('hall (2 doors):', JSON.stringify(hall3));
if (hall3.open !== 2 || hall3.counter !== '2 doors unsealed') fail(`hall after door 2: ${JSON.stringify(hall3)}`);
await shot('5-hall-two-doors');
await page.evaluate(() => {
  const doors = document.querySelectorAll('.ct-hub-door.open');
  doors[doors.length - 1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
});
await page.waitForSelector('.ct-stall', { timeout: 15000 });
await sleep(1500);
const salon2 = await page.evaluate(() => ({
  level: document.querySelector('.ct-level')?.textContent,
  title: document.querySelector('.ct-event-title')?.textContent,
}));
console.log('door 2 threshold:', JSON.stringify(salon2));
if (salon2.level !== 'door 2 · level 1') fail(`threshold head: ${salon2.level}`);
if (!/^gathering at the [a-z]+ threshold$/.test(salon2.title ?? '')) fail(`threshold title: ${salon2.title}`);
await shot('6-door2-threshold');

// 7. Back out; a reload keeps both doors and the running countdown.
await page.click('.ct-door-back');
await page.waitForSelector('#card-stage.hub-view', { timeout: 15000 });
await page.goto(REALM, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#card-stage.hub-view', { timeout: 20000 });
await sleep(1200);
const hall4 = await page.evaluate(() => ({
  open: document.querySelectorAll('.ct-hub-door.open').length,
  cooling: !!document.querySelector('.ct-hub-sealed.cooling'),
}));
console.log('hall (reloaded):', JSON.stringify(hall4));
if (hall4.open !== 2) fail('reload should keep both unsealed doors');
if (!hall4.cooling) fail('reload should keep the fresh seal counting down');

// 8. Phone-portrait hall for the responsive pass.
await page.setViewportSize({ width: 390, height: 844 });
await sleep(600);
await shot('7-hall-phone');

await browser.close();
console.log(process.exitCode ? 'FAILED' : 'ok:', readdirSync(OUT).join(', '));
