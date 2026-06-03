// Smoke-test for the hell candle/sigil rework: places a portal, descends to
// hell, places candles through the real input path (canvas clicks with
// pendingCandle armed), and checks labels, blood spend, the per-ring cap, and
// the ×87 power payout. Screenshots along the way. Pumps state via
// window.__game (dev-only), mirroring scripts/screenshot-hell.mjs.

import { chromium } from 'playwright';
import { mkdirSync } from 'fs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await context.newPage();

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

page.on('pageerror', (e) => { console.log('PAGE ERR:', e.message); failures++; });

await page.goto('http://127.0.0.1:5173', { waitUntil: 'networkidle' });
await page.waitForFunction(() => !!window.__game?.state, { timeout: 15_000 });

await page.evaluate(async () => {
  const title = document.getElementById('title-screen');
  if (title && title.style.display !== 'none') title.querySelector('button')?.click();
});
await sleep(800);
await page.evaluate(() => {
  document.body.classList.remove('intro-hold');
  document.body.classList.remove('bob-cutscene-hold');
});

// Place a constructed hell_portal and jump straight into hell, zoomed out.
await page.evaluate(() => {
  const { state, ctx } = window.__game;
  state.bobPickingHole = false;
  state.hellUnlocked = true;
  state.blood = 100;
  state.bloodUnlocked = true;
  // Clear the first task so the Build panel (housing the Candle button) shows.
  state.money = 1000;
  const PA = state.playArea;
  const cx = Math.floor((PA.x0 + PA.x1) / 2);
  const cy = Math.floor((PA.y0 + PA.y1) / 2);
  const id = state.nextId++;
  state.buildings.set(id, {
    id, displayNum: 1, kind: 'hell_portal',
    cell: { cx, cy }, state: 'active', buildProgress: 1,
    activatedAt: state.now - 5, assignedGoblins: [], selected: false,
  });
  window.__portalId = id;
  state.view = 'hell';
  ctx.depth = 1;
  ctx.hellZoom = 1;
  const worldX = cx * 32, worldY = cy * 32;
  const hellW = 2400, hellH = 3200;
  const worldW = 48 * 32, worldH = 44 * 32; // COLS=48, ROWS=44
  const hx = worldX + (hellW - worldW) / 2;
  const hy = worldY + (hellH - worldH) / 2;
  window.__mirror = { hx, hy };
  const hellScale = 1.3 * 0.5;
  ctx.hellCamera.x = hx - ctx.viewport.width / (2 * hellScale);
  ctx.hellCamera.y = hy - ctx.viewport.height / (2 * hellScale);
});
await sleep(600);

// The Candle button should have replaced the Build list in hell.
const buildState = await page.evaluate(() => {
  const candle = document.getElementById('btn-place-candle');
  const wheel = document.getElementById('btn-build-goblin_wheel');
  return {
    candleShown: !!candle && candle.style.display !== 'none',
    candleText: candle?.textContent ?? '',
    wheelHidden: !!wheel && wheel.classList.contains('locked'),
  };
});
check('Candle button shown in hell', buildState.candleShown);
check('Candle button shows 9 blood + x87', /9 blood/.test(buildState.candleText) && /x87/.test(buildState.candleText), buildState.candleText.trim());
check('Building buttons hidden in hell', buildState.wheelHidden);

// Arm candle mode via the real button.
await page.click('#btn-place-candle');
const armed = await page.evaluate(() => window.__game.state.pendingCandle);
check('Candle mode arms via button', armed === true);

// The new-game intro overlay fades in a few seconds after Spawn and would
// swallow canvas clicks — neutralise it (and keep it neutralised) so the
// placement clicks land on the stage.
const neutralizeOverlays = () => page.evaluate(() => {
  const intro = document.getElementById('intro-overlay');
  if (intro) {
    intro.style.pointerEvents = 'none';
    intro.style.opacity = '0';
    for (const el of intro.querySelectorAll('*')) el.style.pointerEvents = 'none';
  }
});

// Screen position of a hell coord, via the live hell-layer transform.
const screenAt = (hx, hy) => page.evaluate(([x, y]) => {
  const { ctx } = window.__game;
  const g = ctx.hellLayer.toGlobal({ x, y });
  const rect = ctx.app.canvas.getBoundingClientRect();
  return { x: rect.left + g.x, y: rect.top + g.y };
}, [hx, hy]);

// Place 5 candles around the ring through real canvas clicks.
const RING = 290;
const angles = [-90, -18, 54, 126, 198].map((d) => (d * Math.PI) / 180);
for (let i = 0; i < angles.length; i++) {
  await neutralizeOverlays();
  const m = await page.evaluate(() => window.__mirror);
  const p = await screenAt(m.hx + Math.cos(angles[i]) * RING, m.hy + Math.sin(angles[i]) * RING);
  await page.mouse.click(p.x, p.y);
  await sleep(250);
  const s = await page.evaluate(() => ({
    candles: window.__game.state.soulChairs.length,
    blood: window.__game.state.blood,
  }));
  check(`Candle ${i + 1} placed`, s.candles === i + 1, `candles=${s.candles} blood=${s.blood}`);
  if (i === 0) {
    check('Blood spent (9)', s.blood === 91, `blood=${s.blood}`);
    const label = await page.evaluate(() => {
      const labels = [...window.__game.ctx.soulChairLabels.values()];
      return labels.map((l) => l.text).join('|');
    });
    check('First candle reads "needs 4 candles"', label === 'needs 4 candles', label);
    mkdirSync('screenshots', { recursive: true });
    await page.screenshot({ path: 'screenshots/candles-1.png' });
  }
  if (i === 2) await page.screenshot({ path: 'screenshots/candles-3.png' });
}

// All five placed → labels flip to "needs soul".
const fullLabels = await page.evaluate(() =>
  [...window.__game.ctx.soulChairLabels.values()].map((l) => l.text));
check('All five read "needs soul"', fullLabels.length === 5 && fullLabels.every((t) => t === 'needs soul'), fullLabels.join('|'));

// Sixth placement on the same ring must be refused.
{
  await neutralizeOverlays();
  const m = await page.evaluate(() => window.__mirror);
  const p = await screenAt(m.hx + Math.cos(0.6) * RING, m.hy + Math.sin(0.6) * RING);
  await page.mouse.click(p.x, p.y);
  await sleep(250);
  const s = await page.evaluate(() => ({
    candles: window.__game.state.soulChairs.length,
    blood: window.__game.state.blood,
  }));
  check('Sixth candle refused (cap 5)', s.candles === 5 && s.blood === 55, `candles=${s.candles} blood=${s.blood}`);
}
await page.screenshot({ path: 'screenshots/candles-5.png' });

// Mirror wattage label reads 1 W with no souls seated.
const wattsBefore = await page.evaluate(() =>
  [...window.__game.ctx.sigilPowerLabels.values()].map((l) => l.text).join('|'));
check('Mirror reads 1 W before souls', wattsBefore === '1 W', wattsBefore);

// Seat souls one by one (direct occupy — the sim walk is exercised elsewhere)
// and confirm the power pass multiplies by 87 each time.
const powers = await page.evaluate(async () => {
  const { state } = window.__game;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = [];
  for (const c of state.soulChairs) {
    c.occupied = true;
    c.filledAt = state.now;
    await sleep(200); // let a few ticks run the power pass
    out.push({
      produced: state.lastPowerProduced,
      label: [...window.__game.ctx.sigilPowerLabels.values()].map((l) => l.text).join('|'),
    });
  }
  return out;
});
const expected = [87, 87 ** 2, 87 ** 3, 87 ** 4, 87 ** 5];
powers.forEach((p, i) => {
  check(`Power after ${i + 1} soul(s) ≈ 87^${i + 1} W`, Math.abs(p.produced - expected[i]) < 1, `produced=${p.produced} label=${p.label}`);
});
check('Mirror label after 5 souls ≈ 4.98 GW', /GW/.test(powers[4].label), powers[4].label);
await page.screenshot({ path: 'screenshots/candles-seated.png' });

// Portal footprint is now 1×1.
const cellSize = await page.evaluate(() => {
  const b = window.__game.state.buildings.get(window.__portalId);
  return b ? window.__game.state.buildings.size && 1 : 0;
});
void cellSize;

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
