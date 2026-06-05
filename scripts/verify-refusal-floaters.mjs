// Mobile-emulation smoke-test for placement-refusal floaters: emulates a
// phone (touch, pointer:coarse), then exercises every refusal path that's
// reachable in real play — wall/building on a blocked cell, building without
// power headroom, candle off-ring / too-close — and asserts the red "why"
// floater appears. Also asserts the designed pre-emption: running out of
// money/blood auto-disarms placement mode before a tap can land. Drives the
// real input path (touchscreen taps on the canvas) and pumps state via
// window.__game (dev-only), mirroring scripts/verify-candles.mjs.
//
// Run a dev server first: npx vite --port 5173
import { chromium } from 'playwright';

const EXEC = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const URL = 'http://localhost:5173/';
const shots = [];
let failures = 0;

function ok(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
}

const browser = await chromium.launch({ executablePath: EXEC });
const page = await browser.newPage({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});
page.on('pageerror', (e) => console.log('PAGE ERROR:', e.message));

await page.goto(URL);
ok('pointer:coarse emulated', await page.evaluate(() => matchMedia('(pointer: coarse)').matches));

// Dev mode skips the title screen — the game boots straight into the intro.
await page.waitForFunction(() => !!window.__game, null, { timeout: 20000 });

// Skip the new-game intro via the dev cog's "Work skip" cheat.
await page.waitForSelector('#options-cog', { state: 'attached' });
await page.evaluate(() => document.getElementById('options-cog').click());
await page.evaluate(() => {
  const btn = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Work skip');
  if (!btn) throw new Error('Work skip button not found');
  btn.click();
});
// Close the admin panel so it doesn't cover the canvas.
await page.evaluate(() => document.getElementById('options-cog').click());
await page.waitForTimeout(1500);

// Map a world-layer point to client coords for touchscreen.tap.
async function tapWorld(x, y, layer = 'worldLayer') {
  const pt = await page.evaluate(([x, y, layer]) => {
    const { ctx } = window.__game;
    const g = ctx[layer].toGlobal({ x, y });
    const r = ctx.app.canvas.getBoundingClientRect();
    const res = ctx.app.renderer.resolution;
    const sx = r.width / (ctx.app.canvas.width / res);
    const sy = r.height / (ctx.app.canvas.height / res);
    return { x: r.left + g.x * sx, y: r.top + g.y * sy };
  }, [x, y, layer]);
  await page.touchscreen.tap(Math.round(pt.x), Math.round(pt.y));
  return pt;
}

const floaters = () => page.evaluate(() => window.__game.state.floaters.map((f) => f.text));
const clearFloaters = () => page.evaluate(() => { window.__game.state.floaters.length = 0; });
async function snap(name) {
  const p = `/tmp/shot-${name}.png`;
  await page.screenshot({ path: p });
  shots.push(p);
}

// ── Setup: probe for an empty on-screen cell with wall placements.
// Camera starts centred on the play area.
await page.evaluate(() => {
  const { state } = window.__game;
  state.money = 1_000_000;
  state.pendingBuild = { kind: 'wall' };
});
const probeTargets = await page.evaluate(() => {
  const { ctx } = window.__game;
  const res = ctx.app.renderer.resolution;
  const w = ctx.app.canvas.width / res / ctx.renderScale;
  const h = ctx.app.canvas.height / res / ctx.renderScale;
  const out = [];
  for (const [fx, fy] of [[0.3, 0.3], [0.7, 0.3], [0.3, 0.6], [0.7, 0.6], [0.5, 0.45]]) {
    out.push({ x: ctx.camera.x + w * fx, y: ctx.camera.y + h * fy });
  }
  return out;
});
let wallAt = null;
for (const t of probeTargets) {
  const before = await page.evaluate(() => window.__game.state.buildings.size);
  await tapWorld(t.x, t.y);
  const after = await page.evaluate(() => window.__game.state.buildings.size);
  if (after > before) { wallAt = t; break; }
}
ok('probe placed a wall on empty ground', wallAt !== null);

// ── Test 1: wall tap on a blocked cell (the wall just placed) ──
await clearFloaters();
await tapWorld(wallAt.x, wallAt.y);
await page.waitForTimeout(150);
let f = await floaters();
ok('wall blocked -> "blocked" floater', f.includes('blocked'), JSON.stringify(f));
await snap('1-wall-blocked');

// ── Test 2: ground building on a blocked cell ──
await page.evaluate(() => { window.__game.state.pendingBuild = { kind: 'goblin_hole' }; });
await clearFloaters();
await tapWorld(wallAt.x, wallAt.y);
await page.waitForTimeout(150);
f = await floaters();
ok('building blocked -> "blocked" floater', f.includes('blocked'), JSON.stringify(f));
await snap('2-building-blocked');

// ── Test 3: ground building, not enough free power (money is fine — the UI
// only pre-empts unaffordable money/blood/bone costs, not power headroom) ──
await page.evaluate(() => {
  const { state } = window.__game;
  state.money = 1000;
  state.pendingBuild = { kind: 'phone_farm' }; // Ƶ50, draws 200 W
});
await clearFloaters();
await tapWorld(wallAt.x + 96, wallAt.y + 48);
await page.waitForTimeout(150);
f = await floaters();
ok('building no power -> "need … free power" floater', f.some((t) => /^need .* free power$/.test(t)), JSON.stringify(f));
await snap('3-building-no-power');

// ── Test 3b: not enough money — the UI's mid-placement bankruptcy disarms
// placement mode before a tap can even land (designed behaviour; the in-code
// floater is a defensive fallback) ──
await page.evaluate(() => {
  const { state } = window.__game;
  state.money = 0;
  state.pendingBuild = { kind: 'phone_farm' };
});
await page.waitForTimeout(300); // a UI tick
ok('no money -> placement mode auto-disarmed by UI',
  await page.evaluate(() => window.__game.state.pendingBuild === null));
await page.evaluate(() => { window.__game.state.pendingBuild = null; });

// ── Test 4: hell candle — skip to hell via cheat ──
await page.evaluate(() => document.getElementById('options-cog').click());
await page.evaluate(() => {
  const btn = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Cheat: skip to hell');
  if (!btn) throw new Error('skip-to-hell button not found');
  btn.click();
});
await page.evaluate(() => document.getElementById('options-cog').click());
await page.waitForFunction(() => window.__game.state.view === 'hell', null, { timeout: 30000 });
await page.waitForTimeout(3000); // let the descent transition settle

// Tap the canvas at a fractional position; returns client coords used.
async function tapCanvas(fx, fy) {
  const pt = await page.evaluate(([fx, fy]) => {
    const r = window.__game.ctx.app.canvas.getBoundingClientRect();
    return { x: r.left + r.width * fx, y: r.top + r.height * fy };
  }, [fx, fy]);
  await page.touchscreen.tap(Math.round(pt.x), Math.round(pt.y));
  return pt;
}
const chairs = () => page.evaluate(() => window.__game.state.soulChairs.length);

await page.evaluate(() => {
  const { state } = window.__game;
  state.pendingCandle = true;
  state.blood = 1000;
});

// 4a: probe canvas corners until a tap misses every mirror ring.
let offRing = false;
for (const [fx, fy] of [[0.95, 0.95], [0.95, 0.08], [0.06, 0.95], [0.5, 0.97]]) {
  await clearFloaters();
  await tapCanvas(fx, fy);
  await page.waitForTimeout(120);
  f = await floaters();
  if (f.includes('needs a mirror ring')) { offRing = true; break; }
}
ok('candle off-ring -> "needs a mirror ring" floater', offRing, JSON.stringify(f));
await snap('4a-candle-off-ring');

// 4b: probe a canvas grid until a candle lands, then re-tap the same point.
let placedPt = null;
outer:
for (let fy = 0.2; fy <= 0.8; fy += 0.15) {
  for (let fx = 0.2; fx <= 0.8; fx += 0.15) {
    const before = await chairs();
    const pt = await tapCanvas(fx, fy);
    await page.waitForTimeout(60);
    if ((await chairs()) > before) { placedPt = pt; break outer; }
  }
}
ok('probe placed a candle on a ring', placedPt !== null);
if (placedPt) {
  await clearFloaters();
  await page.touchscreen.tap(Math.round(placedPt.x), Math.round(placedPt.y));
  await page.waitForTimeout(150);
  f = await floaters();
  ok('candle too close -> "too close" floater', f.includes('too close'), JSON.stringify(f));
  await snap('4b-candle-too-close');

  // 4c: blood shortage — as on the ground, the UI's mid-placement bankruptcy
  // disarms candle mode before a tap can land (the in-code floater is a
  // defensive fallback).
  await page.evaluate(() => { window.__game.state.blood = 0; });
  await page.waitForTimeout(300); // a UI tick
  ok('no blood -> candle mode auto-disarmed by UI',
    await page.evaluate(() => window.__game.state.pendingCandle === false));
}

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} FAILURE(S)`);
console.log('shots:', shots.join(' '));
await browser.close();
process.exit(failures === 0 ? 0 : 1);
