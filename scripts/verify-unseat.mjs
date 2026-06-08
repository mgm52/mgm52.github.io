// Smoke-test for the Free-soul flow: synthesizes an occupied soul chair,
// selects it, clicks the info panel's Free soul button, and asserts the chair
// empties and a matching ghost (re-)materialises selected beside it. Run with
// the vite dev server up on 5173:
//
//   node scripts/verify-unseat.mjs

import { chromium } from 'playwright';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
page.on('pageerror', (e) => console.log('PAGE ERR:', e.message));

await page.goto('http://127.0.0.1:5173', { waitUntil: 'networkidle' });
await page.waitForFunction(() => !!window.__game?.state, { timeout: 15_000 });
await page.evaluate(() => {
  const title = document.getElementById('title-screen');
  if (title && title.style.display !== 'none') title.querySelector('button')?.click();
});
await sleep(600);
await page.evaluate(() => {
  document.body.classList.remove('intro-hold', 'intro-cutscene-hold', 'bob-cutscene-hold');
});

const before = await page.evaluate(() => {
  const { state, ctx } = window.__game;
  state.bobPickingHole = false;
  state.hellUnlocked = true;
  state.view = 'hell';
  ctx.depth = 1;
  // A live Hell Portal so pruneSoulChairs doesn't sweep the chair away.
  const portal = {
    id: state.nextId++, displayNum: 1, kind: 'hell_portal',
    cell: { cx: 10, cy: 10 }, state: 'active', buildProgress: 1,
    assignedGoblins: [], selected: false,
  };
  state.buildings.set(portal.id, portal);
  // A chair bound to a gold-goblin soul, pre-selected as if tapped.
  state.soulChairs.push({
    id: state.nextId++, portalId: portal.id, index: 0,
    hx: 1200, hy: 1600, occupied: true, mult: 66,
    soul: { kind: 'goblin', gold: true },
    filledAt: state.now, selected: true,
  });
  return { ghosts: state.ghosts.length, chairs: state.soulChairs.length };
});

// Give refreshUI a few frames to surface the button, then click it.
await page.waitForFunction(
  () => document.getElementById('info-unseat')?.style.display === '',
  { timeout: 5_000 },
);
await page.click('#info-unseat');
await sleep(200);

const after = await page.evaluate(() => {
  const { state } = window.__game;
  const chair = state.soulChairs[state.soulChairs.length - 1];
  const ghost = state.ghosts[state.ghosts.length - 1];
  return {
    ghosts: state.ghosts.length,
    chairOccupied: chair.occupied,
    chairMult: chair.mult,
    chairSoul: chair.soul,
    chairSelected: chair.selected,
    ghost: ghost && { kind: ghost.kind, gold: ghost.gold, selected: ghost.selected, hx: ghost.hx, hy: ghost.hy },
    unseatHidden: document.getElementById('info-unseat').style.display === 'none',
  };
});

await browser.close();

const ok =
  after.ghosts === before.ghosts + 1 &&
  after.chairOccupied === false &&
  after.chairMult === undefined &&
  after.chairSoul === undefined &&
  after.chairSelected === false &&
  after.ghost?.kind === 'goblin' &&
  after.ghost?.gold === true &&
  after.ghost?.selected === true &&
  after.unseatHidden;

console.log(JSON.stringify({ before, after }, null, 2));
console.log(ok ? 'PASS: soul freed from chair' : 'FAIL');
process.exit(ok ? 0 : 1);
