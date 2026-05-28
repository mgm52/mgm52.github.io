// Flexible hell screenshot. Centres the camera on a hell-coord (default the
// soul-sigil centre), at a given zoom, and can pre-seat N soul chairs and drop
// a few ghosts near the sigil for visual checks.
//
//   OUT=foo.png CENTER=sigil ZOOM=0.6 SEAT=3 GHOSTS=4 node scripts/shot-hell.mjs
//
// CENTER: "sigil" (default), "demon", or "x,y" hell coords.

import { chromium } from 'playwright';
import { mkdirSync } from 'fs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const outPath = process.env.OUT || 'screenshots/hell.png';
const zoom = process.env.ZOOM ? Number(process.env.ZOOM) : 0.55;
const seat = process.env.SEAT ? Number(process.env.SEAT) : 0;
const ghosts = process.env.GHOSTS ? Number(process.env.GHOSTS) : 0;
const center = process.env.CENTER || 'sigil';
const completeFx = process.env.FX === '1';

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await context.newPage();
page.on('pageerror', (e) => console.log('PAGE ERR:', e.message));

await page.goto('http://127.0.0.1:5173', { waitUntil: 'networkidle' });
await page.waitForFunction(() => !!window.__game?.state, { timeout: 15_000 });

await page.evaluate(async () => {
  const title = document.getElementById('title-screen');
  if (title && title.style.display !== 'none') title.querySelector('button')?.click();
});
await sleep(600);
await page.evaluate(() => {
  document.body.classList.remove('intro-hold');
  document.body.classList.remove('bob-cutscene-hold');
});

await page.evaluate(({ zoom, seat, ghosts, center, completeFx }) => {
  const { state, ctx } = window.__game;
  state.bobPickingHole = false;
  state.hellUnlocked = true;

  // Seat the requested number of chairs.
  for (let i = 0; i < state.soulChairs.length; i++) {
    if (i < seat) { state.soulChairs[i].occupied = true; state.soulChairs[i].filledAt = state.now - 2; }
  }
  if (completeFx && state.soulChairs.every((c) => c.occupied)) {
    state.soulSigilCompletedAt = state.now - 0.3;
  }

  // Drop a few drifting ghosts near the sigil so the scene isn't empty.
  const SC = state.soulChairs[0];
  const cx = 2400 / 2, cy = 3200 / 2;
  for (let i = 0; i < ghosts; i++) {
    const id = state.nextId++;
    state.ghosts.push({
      id, kind: 'goblin', x: 0, y: 0, facing: Math.PI / 2,
      spawnAt: state.now, hx: cx - 300 + i * 120, hy: cy + 500, selected: false,
    });
  }

  state.view = 'hell';
  ctx.depth = 1;
  ctx.hellZoom = 1;

  let tx = cx, ty = cy;
  if (center === 'demon') { const d = [...state.demons.values()][0]; tx = d.hx; ty = d.hy; }
  else if (center !== 'sigil') { const [a, b] = center.split(',').map(Number); tx = a; ty = b; }

  const renderScale = 1.3;
  const hellScale = renderScale * zoom;
  ctx.hellCamera.x = tx - ctx.viewport.width / (2 * hellScale);
  ctx.hellCamera.y = ty - ctx.viewport.height / (2 * hellScale);
}, { zoom, seat, ghosts, center, completeFx });

await sleep(1200);
mkdirSync('screenshots', { recursive: true });
await page.screenshot({ path: outPath, fullPage: false });
console.log(`Wrote ${outPath}`);
await browser.close();
