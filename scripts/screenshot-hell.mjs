// One-off screenshot of the hell scene with a Hell Portal in place. Pumps
// state straight via window.__game (dev-only) so we skip intro + placement.

import { chromium } from 'playwright';
import { mkdirSync } from 'fs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Optional ember-size override via env var. Persisted to localStorage so the
// dev build's mergeDefaults() pulls it in on next load.
const emberSize = process.env.EMBER_SIZE ? Number(process.env.EMBER_SIZE) : null;
const outPath = process.env.OUT || 'screenshots/hell-with-building.png';

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await context.newPage();

page.on('pageerror', (e) => console.log('PAGE ERR:', e.message));

await page.goto('http://127.0.0.1:5173', { waitUntil: 'networkidle' });

if (emberSize !== null) {
  await page.evaluate((size) => {
    const raw = localStorage.getItem('rts.options.v2');
    const opts = raw ? JSON.parse(raw) : {};
    opts.hellEmberSize = size;
    localStorage.setItem('rts.options.v2', JSON.stringify(opts));
  }, emberSize);
  await page.reload({ waitUntil: 'networkidle' });
}

await page.waitForFunction(() => !!window.__game?.state, { timeout: 15_000 });

// Dismiss the title-screen overlay if it's up — it blocks input + sits over
// the canvas. Start the game from the title's primary button.
await page.evaluate(async () => {
  const title = document.getElementById('title-screen');
  if (title && title.style.display !== 'none') {
    const startBtn = title.querySelector('button');
    if (startBtn) startBtn.click();
  }
});
await sleep(800);

// Abort the intro hold immediately if present.
await page.evaluate(() => {
  document.body.classList.remove('intro-hold');
  document.body.classList.remove('bob-cutscene-hold');
});

// Drop a constructed hell_portal in the middle of the play area and crank
// state so we're already in hell view, fully zoomed out.
await page.evaluate(() => {
  const { state, ctx } = window.__game;
  // Skip intro / cutscenes that might be in progress.
  state.bobPickingHole = false;
  state.hellUnlocked = true;

  // Place a constructed hell_portal at the center of the initial play area.
  const PA = state.playArea;
  const cx = Math.floor((PA.x0 + PA.x1) / 2);
  const cy = Math.floor((PA.y0 + PA.y1) / 2);
  const id = state.nextId++;
  const now = state.now;
  state.buildings.set(id, {
    id,
    displayNum: 1,
    kind: 'hell_portal',
    cell: { cx, cy },
    state: 'active',
    buildProgress: 1,
    activatedAt: now - 5, // beam is long since drawn
    assignedGoblins: [],
    selected: false,
  });

  // Jump straight into hell, fully zoomed out, in the middle of the map.
  state.view = 'hell';
  ctx.depth = 1;
  ctx.hellZoom = 1;
  // Center the hell camera around the portal's world coord.
  const worldX = cx * 32;
  const worldY = cy * 32;
  // worldToHell offsets are (HELL.width - WORLD.width)/2 etc, baked in render.
  const hellW = 4800, hellH = 3200;
  const worldW = 44 * 32, worldH = 44 * 32;
  const hx = worldX + (hellW - worldW) / 2;
  const hy = worldY + (hellH - worldH) / 2;
  const renderScale = 1.3;
  const hellScale = renderScale * 0.5; // zoomed-out
  ctx.hellCamera.x = hx - ctx.viewport.width / (2 * hellScale);
  ctx.hellCamera.y = hy - ctx.viewport.height / (2 * hellScale);
});

await sleep(1000);

mkdirSync('screenshots', { recursive: true });
await page.screenshot({ path: outPath, fullPage: false });
console.log(`Wrote ${outPath}`);

await browser.close();
