// Verifies the reactor meltdown: a Lightning Strike on a completed Nuclear
// Reactor detonates it — the reactor is destroyed on the spot, and a
// green/white shockwave radiates out from the core (REACTOR_MELTDOWN.
// waveSpeed), killing every unit in the overworld as the front reaches it
// (even robots), with the grid taking the 10 GW death-surge and fallout
// splatter painted across the crater zone. Also checks the inverse: a
// reactor still under construction takes the ordinary +1 GW surge and does
// NOT explode. Drives the game via window.__game (dev only).
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

// ── 1) Strike a completed reactor → meltdown wave ──
const meltdown = await page.evaluate(async () => {
  const { state } = window.__game;
  const sim = await import('/src/sim.ts');
  // Drop a completed 2×2 reactor in the far corner of the play area, well
  // away from the units milling around the hole, so the wave's travel time
  // is observable.
  const pa = state.playArea;
  const b = {
    id: state.nextId++, displayNum: 1, kind: 'nuclear_reactor',
    cell: { cx: pa.x1 - 4, cy: pa.y1 - 4 },
    state: 'active', buildProgress: 1, assignedGoblins: [], selected: false,
  };
  state.buildings.set(b.id, b);
  const CELL = 32;
  const px = (b.cell.cx + 1) * CELL, py = (b.cell.cy + 1) * CELL;
  const boltsBefore = state.lightningBolts.length;
  const boostsBefore = state.powerBoosts.length;
  const ok = sim.lightningStrike(state, px, py);
  return {
    ok,
    reactorGone: !state.buildings.has(b.id),
    // Synchronous with the strike: the wave hasn't ticked yet, so the
    // far-away roster must still be alive — the explosion is no longer
    // instantaneous.
    aliveAtStrike: state.goblins.size + state.minotaurs.size + state.dragons.size,
    waveStarted: state.meltdowns.length === 1,
    boltsAdded: state.lightningBolts.length - boltsBefore,
    surgePeaks: state.powerBoosts.slice(boostsBefore).map((p) => p.peak),
    log: state.log.slice(-2).map((l) => l.msg),
  };
});
check('strike lands', meltdown.ok);
check('reactor is destroyed at the rupture instant', meltdown.reactorGone);
check('shockwave starts (kills are not instantaneous)',
  meltdown.waveStarted && meltdown.aliveAtStrike >= 6, `alive=${meltdown.aliveAtStrike}`);
check('10 GW death-surge hits the grid', meltdown.surgePeaks.includes(10_000_000_000),
  JSON.stringify(meltdown.surgePeaks));
check('extra bolts fan out (1 strike + 6 meltdown)', meltdown.boltsAdded === 7, `bolts=${meltdown.boltsAdded}`);
check('rupture logged', meltdown.log.some((l) => l.includes('goes critical')), JSON.stringify(meltdown.log));

// Units near the hole are ~600px from the corner reactor (≈1.3s at 450px/s):
// shortly after the strike they should still be breathing.
await sleep(300);
const midWave = await page.evaluate(() => {
  const { state } = window.__game;
  return {
    alive: state.goblins.size + state.minotaurs.size + state.dragons.size,
    waveRunning: state.meltdowns.length === 1,
  };
});
check('far units still alive mid-wave (~0.3s in)', midWave.waveRunning && midWave.alive >= 6,
  JSON.stringify(midWave));

// Screenshot the wave mid-flight — green/white rings radiating from the core.
await page.evaluate(() => {
  const { state, ctx } = window.__game;
  const m = state.meltdowns[0];
  if (m) {
    ctx.camera.x = m.x - ctx.viewport.width / (2 * ctx.renderScale);
    ctx.camera.y = m.y - ctx.viewport.height / (2 * ctx.renderScale);
  }
});
await sleep(150);
await page.screenshot({ path: 'screenshots/reactor-meltdown.png' });

// Fallout is painted as the wave crosses the crater zone and the splatter
// gifs only live ~2s of game time — so sample the moment the front clears
// the zone (polling the wave's own radius; wall-clock sleeps are unreliable
// against the headless tab's throttled game clock).
const duringWave = await page.evaluate(async () => {
  const { state } = window.__game;
  const splatterPx = (20 / 2) * 32; // REACTOR_MELTDOWN.splatterCells / 2 * CELL
  for (let i = 0; i < 200; i++) {
    const m = state.meltdowns[0];
    if (!m || m.lastRadius >= splatterPx) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  return { splatters: state.deathEffects.filter((e) => e.white).length };
});
check('fallout splatter painted as the wave crosses the crater zone',
  duringWave.splatters > 100, `splatters=${duringWave.splatters}`);

// Let the wave cross the whole world, then audit the butcher's bill.
await page.waitForFunction(() => window.__game.state.meltdowns.length === 0, { timeout: 20000 });
const after = await page.evaluate(() => {
  const { state } = window.__game;
  return {
    goblins: state.goblins.size,
    minotaurs: state.minotaurs.size,
    dragons: state.dragons.size,
    ghosts: state.ghosts.length,
    splatters: state.deathEffects.filter((e) => e.white).length,
    log: state.log.slice(-3).map((l) => l.msg),
    maxStruck: state.maxStruckAtOnce,
  };
});
check('every goblin dies (robot included)', after.goblins === 0, `left=${after.goblins}`);
check('every minotaur dies', after.minotaurs === 0);
check('every dragon dies', after.dragons === 0);
// Robot leaves no soul: ghosts gained = all units minus the robot.
const expectedGhosts = before.goblins - before.robots + before.minotaurs + before.dragons;
check('souls recorded for everything but the robot',
  after.ghosts - before.ghosts === expectedGhosts,
  `Δghosts=${after.ghosts - before.ghosts} expected=${expectedGhosts}`);
const wipeLog = after.log.find((l) => l.includes('wipes out'));
check('wipe logged when the wave completes', !!wipeLog, JSON.stringify(after.log));
// The roving minotaur may gore a goblin or two before the wave arrives, so
// the meltdown's own tally can undershoot the roster — compare the sticky
// stat against the wave's logged bill instead.
const wiped = wipeLog ? parseInt(wipeLog.match(/wipes out (\d+)/)?.[1] ?? '0', 10) : 0;
check('cull folds into the sticky strike stat',
  wiped > 0 && after.maxStruck >= wiped,
  `maxStruck=${after.maxStruck} wiped=${wiped}`);

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
  await new Promise((r) => setTimeout(r, 600));
  return {
    ok,
    bystanders,
    survivors: state.goblins.size,
    reactorIntact: state.buildings.has(b.id),
    noWave: state.meltdowns.length === 0,
    surgePeaks: state.powerBoosts.slice(boostsBefore).map((p) => p.peak),
  };
});
check('construction site survives the strike', site.ok && site.reactorIntact && site.noWave);
check('construction site takes the ordinary +1 GW surge',
  site.surgePeaks.length === 1 && site.surgePeaks[0] === 1_000_000_000,
  JSON.stringify(site.surgePeaks));
check('bystander outside the blast survives (no meltdown)',
  site.bystanders > 0 && site.survivors === site.bystanders,
  `before=${site.bystanders} after=${site.survivors}`);

await browser.close();
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
