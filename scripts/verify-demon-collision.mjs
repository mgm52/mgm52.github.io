// One-off verification for:
//   1. demon↔ghost collision (souls shoved to the rim, drifters materialised),
//   2. the demon's "try another" line on the first failed parlay only,
//   3. ghost Bob idle-pacing until his first command.
// Requires the dev server (`npm run dev`) on :5173.
import { chromium } from 'playwright';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('PAGE ERR:', e.message));

await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
await page.waitForFunction(() => !!window.__game?.state, { timeout: 15000 });
await page.evaluate(() => {
  document.body.classList.remove('intro-hold', 'bob-cutscene-hold');
  const { state, ctx } = window.__game;
  state.bobPickingHole = false;
  state.view = 'hell';
  ctx.depth = 1;
  ctx.hellZoom = 1;
});
await sleep(400);

// ── A. Tracked ghost dropped inside the demon is shoved to the rim ─────────
const shove = await page.evaluate(async () => {
  const { state } = window.__game;
  const d = [...state.demons.values()][0];
  const g = { id: state.nextId++, kind: 'goblin', x: 0, y: 0, facing: 0, spawnAt: state.now,
              hx: d.hx + 5, hy: d.hy + 5, selected: false };
  state.ghosts.push(g);
  await new Promise((r) => setTimeout(r, 400));
  const dist = Math.hypot(g.hx - d.hx, g.hy - d.hy);
  state.ghosts.splice(state.ghosts.indexOf(g), 1);
  return dist;
});
check('tracked ghost shoved to rim', shove >= 239, `dist=${shove.toFixed(1)} (bodyRadius 240)`);

// ── B. Walk goal under the demon → walker rests at rim, goal dropped ───────
const walk = await page.evaluate(async () => {
  const { state } = window.__game;
  const d = [...state.demons.values()][0];
  const g = { id: state.nextId++, kind: 'goblin', x: 0, y: 0, facing: 0, spawnAt: state.now,
              hx: d.hx - 600, hy: d.hy, selected: false, goal: { x: d.hx, y: d.hy } };
  state.ghosts.push(g);
  // ghostWalkSpeed 40 * 2 (commanded) = 80 px/s → ~5s to cover 600-240px,
  // plus slide time at the rim. Poll until the goal is dropped or 15s.
  const t0 = Date.now();
  while (g.goal && Date.now() - t0 < 15000) await new Promise((r) => setTimeout(r, 200));
  const dist = Math.hypot(g.hx - d.hx, g.hy - d.hy);
  const res = { dist, goalDropped: g.goal === undefined };
  state.ghosts.splice(state.ghosts.indexOf(g), 1);
  return res;
});
check('unreachable goal dropped', walk.goalDropped);
check('walker rests at rim', walk.dist >= 239, `dist=${walk.dist.toFixed(1)}`);

// ── C. Patrolling demon plows into a ghost in its path → ghost pushed ──────
const plow = await page.evaluate(async () => {
  const { state } = window.__game;
  const d = [...state.demons.values()][0];
  d.busyWith = null;
  d.hy = (d.y0 + d.y1) / 2;
  d.dir = 1; // pacing down…
  const g = { id: state.nextId++, kind: 'goblin', x: 0, y: 0, facing: 0, spawnAt: state.now,
              hx: d.hx + 20, hy: d.hy + 250, selected: false }; // …into this ghost
  state.ghosts.push(g);
  const start = { hx: g.hx, hy: g.hy };
  let minDist = Infinity;
  const t0 = Date.now();
  while (Date.now() - t0 < 6000) {
    await new Promise((r) => setTimeout(r, 100));
    minDist = Math.min(minDist, Math.hypot(g.hx - d.hx, g.hy - d.hy));
  }
  const moved = Math.hypot(g.hx - start.hx, g.hy - start.hy);
  state.ghosts.splice(state.ghosts.indexOf(g), 1);
  return { minDist, moved };
});
check('plowed ghost never enters body', plow.minDist >= 239, `minDist=${plow.minDist.toFixed(1)}`);
check('plowed ghost displaced', plow.moved > 10, `moved=${plow.moved.toFixed(1)}px`);

// ── D. Untracked drifting ghost inside the demon gets materialised ─────────
// hellXOffset = (HELL.width - WORLD.width)/2 = (2400 - 48*32)/2 = 432;
// hellYOffset = (3200 - 44*32)/2 = 896 (see config.ts).
const mat = await page.evaluate(async () => {
  const { state } = window.__game;
  const d = [...state.demons.values()][0];
  const g = { id: state.nextId++, kind: 'goblin', facing: 0, spawnAt: state.now,
              selected: false, x: d.hx - 432, y: d.hy - 896, offX: 0, offY: 0, speedMult: 0 };
  state.ghosts.push(g);
  await new Promise((r) => setTimeout(r, 500));
  const res = {
    materialised: g.hx !== undefined && g.hy !== undefined,
    dist: g.hx !== undefined ? Math.hypot(g.hx - d.hx, g.hy - d.hy) : NaN,
  };
  state.ghosts.splice(state.ghosts.indexOf(g), 1);
  return res;
});
check('drifter inside demon materialised + shoved', mat.materialised && mat.dist >= 239,
  `dist=${(mat.dist ?? NaN).toFixed(1)}`);

// ── E. Bob's ghost paces until commanded ────────────────────────────────────
const pace = await page.evaluate(async () => {
  const { state } = window.__game;
  const d = [...state.demons.values()][0];
  const g = { id: state.nextId++, kind: 'goblin', x: 100, y: 100, facing: 0, spawnAt: state.now,
              selected: false, bob: true, speedMult: 0 };
  state.ghosts.push(g);
  const samples = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 16000) {
    await new Promise((r) => setTimeout(r, 250));
    if (g.hx !== undefined) samples.push({ t: Date.now(), x: g.hx });
  }
  const xs = samples.map((s) => s.x);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  // Pause detection: longest wall-clock span with no movement.
  let longestStill = 0; let stillStart = null;
  for (let i = 1; i < samples.length; i++) {
    if (Math.abs(samples[i].x - samples[i - 1].x) < 0.01) {
      stillStart ??= samples[i - 1].t;
      longestStill = Math.max(longestStill, samples[i].t - stillStart);
    } else stillStart = null;
  }
  // Direction reversals.
  let reversals = 0; let lastSign = 0;
  for (let i = 1; i < xs.length; i++) {
    const s = Math.sign(xs[i] - xs[i - 1]);
    if (s !== 0) { if (lastSign !== 0 && s !== lastSign) reversals++; lastSign = s; }
  }
  // Now command him: pacing must stop for good.
  g.commanded = true;
  g.goal = { x: g.hx + 200, y: g.hy };
  while (g.goal) await new Promise((r) => setTimeout(r, 100));
  const afterGoal = g.hx;
  await new Promise((r) => setTimeout(r, 3000));
  const stillAfter = Math.abs(g.hx - afterGoal) < 0.01;
  state.ghosts.splice(state.ghosts.indexOf(g), 1);
  return { range: maxX - minX, longestStillMs: longestStill, reversals, stillAfter };
});
check('bob paces (range ≈ 2×90px)', pace.range > 120 && pace.range <= 185, `range=${pace.range.toFixed(1)}px`);
check('bob pauses a few seconds at each end', pace.longestStillMs >= 2000, `${pace.longestStillMs}ms`);
check('bob reverses direction', pace.reversals >= 1, `${pace.reversals} reversal(s)`);
check('bob stays put after a command completes', pace.stillAfter);

// ── F/G. Parlay #1 ends with "try another"; parlay #2 doesn't repeat it ────
async function runParlay() {
  // In-page auto-clicker: record each click-armed line, then click through it.
  await page.evaluate(() => {
    const overlay = document.getElementById('demon-overlay');
    const lineEl = document.getElementById('demon-line');
    window.__lines = [];
    window.__clicker = setInterval(() => {
      if (overlay.classList.contains('click-armed')) {
        const t = lineEl.textContent;
        if (window.__lines[window.__lines.length - 1] !== t) window.__lines.push(t);
        document.getElementById('demon-clickwall').click();
      }
    }, 100);
    const { state } = window.__game;
    const d = [...state.demons.values()][0];
    state.ghosts.push({ id: state.nextId++, kind: 'goblin', x: 0, y: 0, facing: 0,
                        spawnAt: state.now, hx: d.hx - 350, hy: d.hy, selected: false,
                        parlayDemonId: d.id });
  });
  await page.waitForFunction(() => document.getElementById('demon-overlay').classList.contains('visible'), { timeout: 8000 });
  await page.waitForFunction(() => !document.getElementById('demon-overlay').classList.contains('visible'), { timeout: 60000 });
  return page.evaluate(() => { clearInterval(window.__clicker); return window.__lines; });
}
const first = await runParlay();
console.log('  parlay #1 lines:', JSON.stringify(first));
// The pit demon bellows in ALL CAPS now — compare case-insensitively.
const lower = (xs) => xs.map((l) => l.toLowerCase());
check('first parlay ends with "try another"', lower(first)[first.length - 1] === 'try another');
await sleep(1000);
const second = await runParlay();
console.log('  parlay #2 lines:', JSON.stringify(second));
check('second parlay has no "try another"', second.length > 0 && !lower(second).includes('try another'));

await browser.close();
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
