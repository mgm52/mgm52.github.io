// Quick visual check for the dragon fly sheet: spawn a dragon via the dev
// __game handle, keep the camera glued to it, and grab screenshots during the
// swoop-in (steep heading) and the settled hover (held heading).
//
//   node scripts/shot-dragon.mjs

import { chromium } from 'playwright';
import { mkdirSync } from 'fs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await context.newPage();
page.on('pageerror', (e) => console.log('PAGE ERR:', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE ERR:', m.text()); });

await page.goto('http://127.0.0.1:5173', { waitUntil: 'networkidle' });
await page.waitForFunction(() => !!window.__game?.state, { timeout: 15_000 });

await page.evaluate(() => {
  const title = document.getElementById('title-screen');
  if (title && title.style.display !== 'none') title.querySelector('button')?.click();
});
await sleep(600);
await page.evaluate(() => {
  document.body.classList.remove('intro-hold');
  document.body.classList.remove('bob-cutscene-hold');
});

mkdirSync('screenshots', { recursive: true });

const followDragon = () => page.evaluate(() => {
  const { state, ctx } = window.__game;
  const d = [...state.dragons.values()][0];
  if (!d) return;
  ctx.camera.x = d.pos.x - ctx.viewport.width / (2 * ctx.renderScale);
  ctx.camera.y = d.pos.y - ctx.viewport.height / (2 * ctx.renderScale);
});

await page.evaluate(() => {
  const { state, spawnDragon } = window.__game;
  spawnDragon(state);
});

// Mid-swoop: flying steeply downward, so a south-ish row should show.
await sleep(300);
await followDragon();
await sleep(80);
await page.screenshot({ path: 'screenshots/dragon-swoop.png' });

// Settled: hovering, holding the last real heading.
await sleep(3000);
await followDragon();
await sleep(80);
await page.screenshot({ path: 'screenshots/dragon-hover.png' });

// Nudge it east by retargeting the swoop goal — east row should show.
await page.evaluate(() => {
  const { state } = window.__game;
  const d = [...state.dragons.values()][0];
  d.state = { kind: 'swooping_in', goal: { x: d.pos.x + 1200, y: d.pos.y } };
});
await sleep(350);
await followDragon();
await sleep(80);
await page.screenshot({ path: 'screenshots/dragon-east.png' });

await browser.close();
console.log('done');
