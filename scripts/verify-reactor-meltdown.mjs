// Verifies the reactor meltdown: a Lightning Strike on a completed Nuclear
// Reactor detonates it — the reactor is destroyed, every unit in the
// overworld dies (even robots), the grid takes the 10 GW death-surge, and
// the map gets its fallout splatter + extra bolts. Also checks the inverse:
// a reactor still under construction takes the ordinary +1 GW surge and
// does NOT explode. Drives the game via window.__game (dev only).
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync('screenshots', { recursive: true });

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('PAGE ERR:', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE ERR:', m.text()); });
page.on('dialog', async (d) => d.accept());

await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
await page.waitForFunction(() => !!window.__game?.state, { timeout: 15000 });
await page.evaluate(() => {
  document.body.classList.remove('intro-hold', 'intro-cutscene-hold', 'bob-cutscene-hold');
  window.__game.state.bobPickingHole = false;
  window.__game.skipIntro();
});

// ── Setup: one of every overworld unit kind, including a robot ──
await page.evaluate(() => {
  const { state, spawnMinotaur, spawnDragon, spawnRobot } = window.__game;
  state.money = 100_000_000;
  state.blood = 100_000;
  state.spawnQueue.push({ remaining: 0.01, slot: 0 }, { remaining: 0.01, slot: 1 }, { remaining: 0.01, slot: 2 });
  spawnMinotaur(state);
  spawnDragon(state);
  spawnRobot(state);
});
await page.waitForFunction(() => window.__game.state.goblins.size >= 4, { timeout: 15000 });
const before = await page.evaluate(() => {
  const { state } = window.__game;
  return {
    goblins: state.goblins.size,
    robots: [...state.goblins.values()].filter((g) => g.robot).length,
    minotaurs: state.minotaurs.size,
    dragons: state.dragons.size,
    ghosts: state.ghosts.length,
  };
});
check('roster assembled (goblins incl. robot, minotaur, dragon)',
  before.goblins >= 4 && before.robots === 1 && before.minotaurs === 1 && before.dragons === 1,
  JSON.stringify(before));

// ── 1) Strike a completed reactor → meltdown ──
const meltdown = await page.evaluate(async () => {
  const { state } = window.__game;
  const sim = await import('/src/sim.ts');
  // Drop a completed 2×2 reactor in a corner of the play area, away from
  // the units milling around the hole — distance must not matter.
  const pa = state.playArea;
  const b = {
    id: state.nextId++, displayNum: 1, kind: 'nuclear_reactor',
    cell: { cx: pa.x0 + 2, cy: pa.y0 + 2 },
    state: 'active', buildProgress: 1, assignedGoblins: [], selected: false,
  };
  state.buildings.set(b.id, b);
  // Strike the reactor's center (cell size 2 → center sits on the shared
  // corner of its four cells).
  const CELL = 32;
  const px = (b.cell.cx + 1) * CELL, py = (b.cell.cy + 1) * CELL;
  const boltsBefore = state.lightningBolts.length;
  const boostsBefore = state.powerBoosts.length;
  const ok = sim.lightningStrike(state, px, py);
  return {
    ok,
    reactorGone: !state.buildings.has(b.id),
    goblins: state.goblins.size,
    minotaurs: state.minotaurs.size,
    dragons: state.dragons.size,
    ghosts: state.ghosts.length,
    boltsAdded: state.lightningBolts.length - boltsBefore,
    surgePeaks: state.powerBoosts.slice(boostsBefore).map((p) => p.peak),
    splatters: state.deathEffects.filter((e) => e.white).length,
    log: state.log.slice(-3).map((l) => l.msg),
    maxStruck: state.maxStruckAtOnce,
  };
});
check('strike lands', meltdown.ok);
check('reactor is destroyed', meltdown.reactorGone);
check('every goblin dies (robot included)', meltdown.goblins === 0, `left=${meltdown.goblins}`);
check('every minotaur dies', meltdown.minotaurs === 0);
check('every dragon dies', meltdown.dragons === 0);
// Robot leaves no soul: ghosts gained = all units minus the robot.
const expectedGhosts = before.goblins - before.robots + before.minotaurs + before.dragons;
check('souls recorded for everything but the robot',
  meltdown.ghosts - before.ghosts === expectedGhosts,
  `Δghosts=${meltdown.ghosts - before.ghosts} expected=${expectedGhosts}`);
check('10 GW death-surge hits the grid', meltdown.surgePeaks.includes(10_000_000_000),
  JSON.stringify(meltdown.surgePeaks));
check('extra bolts fan out (1 strike + 6 meltdown)', meltdown.boltsAdded === 7, `bolts=${meltdown.boltsAdded}`);
check('wide fallout splatter painted', meltdown.splatters > 100, `splatters=${meltdown.splatters}`);
check('meltdown logged', meltdown.log.some((l) => l.includes('goes critical')), JSON.stringify(meltdown.log));
check('cull folds into the sticky strike stat',
  meltdown.maxStruck >= before.goblins - before.robots + before.minotaurs + before.dragons,
  `maxStruck=${meltdown.maxStruck}`);

// Screenshot the aftermath while the bolts/splatter are still on screen.
await page.evaluate(() => {
  const { state, ctx } = window.__game;
  const pa = state.playArea;
  const CELL = 32;
  ctx.camera.x = (pa.x0 + 3) * CELL - ctx.viewport.width / (2 * ctx.renderScale);
  ctx.camera.y = (pa.y0 + 3) * CELL - ctx.viewport.height / (2 * ctx.renderScale);
});
await sleep(150);
await page.screenshot({ path: 'screenshots/reactor-meltdown.png' });

// ── 2) Strike a constructing reactor → ordinary surge, no meltdown ──
const site = await page.evaluate(async () => {
  const { state } = window.__game;
  const sim = await import('/src/sim.ts');
  const pa = state.playArea;
  const b = {
    id: state.nextId++, displayNum: 2, kind: 'nuclear_reactor',
    cell: { cx: pa.x0 + 12, cy: pa.y0 + 2 },
    state: 'constructing', buildProgress: 0.5, assignedGoblins: [], selected: false,
  };
  state.buildings.set(b.id, b);
  // A bystander goblin well outside the blast must survive this one.
  state.spawnQueue.push({ remaining: 0.01, slot: 0 });
  for (let i = 0; i < 50 && state.goblins.size === 0; i++) {
    await new Promise((r) => setTimeout(r, 200));
  }
  const bystanders = state.goblins.size;
  const boostsBefore = state.powerBoosts.length;
  state.lightningStrikeCooldown = 0;
  const CELL = 32;
  const ok = sim.lightningStrike(state, (b.cell.cx + 1) * CELL, (b.cell.cy + 1) * CELL);
  return {
    ok,
    bystanders,
    survivors: state.goblins.size,
    reactorIntact: state.buildings.has(b.id),
    surgePeaks: state.powerBoosts.slice(boostsBefore).map((p) => p.peak),
  };
});
check('construction site survives the strike', site.ok && site.reactorIntact);
check('construction site takes the ordinary +1 GW surge',
  site.surgePeaks.length === 1 && site.surgePeaks[0] === 1_000_000_000,
  JSON.stringify(site.surgePeaks));
check('bystander outside the blast survives (no meltdown)',
  site.bystanders > 0 && site.survivors === site.bystanders,
  `before=${site.bystanders} after=${site.survivors}`);

await browser.close();
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
