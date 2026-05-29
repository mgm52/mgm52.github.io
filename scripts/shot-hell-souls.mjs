// Screenshot of the *current* hell scene populated with hundreds of drifting
// souls plus a Hell Portal whose soul sigil is partway filled — i.e. what a
// mid/late-game player actually sees today. Drives state via window.__game.
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const outPath = process.env.OUT || 'screenshots/hell-current.png';

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
await sleep(700);
await page.evaluate(() => {
  document.body.classList.remove('intro-hold');
  document.body.classList.remove('bob-cutscene-hold');
});

await page.evaluate(() => {
  const { state, ctx } = window.__game;
  state.bobPickingHole = false;
  state.hellUnlocked = true;

  const PA = state.playArea;
  const cx = Math.floor((PA.x0 + PA.x1) / 2);
  const cy = Math.floor((PA.y0 + PA.y1) / 2);
  const id = state.nextId++;
  const now = state.now;
  state.buildings.set(id, {
    id, displayNum: 1, kind: 'hell_portal', cell: { cx, cy },
    state: 'active', buildProgress: 1, activatedAt: now - 5,
    assignedGoblins: [], selected: false,
  });

  // Build the sigil chairs for this portal, then seat 3 of 5 souls.
  window.__game.syncSoulChairs?.(state);
  // Fall back: if not exposed, the sim's next tick will sync; force it anyway.

  // Scatter ~170 stationary souls across the abyss (hx/hy set => no drift).
  const HELL_W = 2400, HELL_H = 3200;
  const kinds = ['goblin','goblin','goblin','goblin','minotaur'];
  for (let i = 0; i < 170; i++) {
    const k = kinds[(Math.random() * kinds.length) | 0];
    const gold = k === 'goblin' && Math.random() < 0.15;
    state.ghosts.push({
      id: state.nextId++, kind: k, x: 0, y: 0,
      facing: Math.random() < 0.5 ? -1 : 1,
      spawnAt: now, gold: gold || undefined,
      offX: 0, offY: 0, speedMult: 0,
      hx: 140 + Math.random() * (HELL_W - 280),
      hy: 320 + Math.random() * (HELL_H - 560),
    });
  }

  state.view = 'hell';
  ctx.depth = 1;
  ctx.hellZoom = 1;
  const worldX = cx * 32, worldY = cy * 32;
  const worldW = 44 * 32, worldH = 44 * 32;
  const hx = worldX + (HELL_W - worldW) / 2;
  const hy = worldY + (HELL_H - worldH) / 2;
  const hellScale = 1.3 * 0.5;
  ctx.hellCamera.x = hx - ctx.viewport.width / (2 * hellScale);
  ctx.hellCamera.y = hy - ctx.viewport.height / (2 * hellScale);
});

// Let the sim sync chairs, then seat 3 of 5 for the partial-sigil look.
await sleep(500);
await page.evaluate(() => {
  const { state } = window.__game;
  const chairs = state.soulChairs.slice(0, 3);
  for (const c of chairs) c.occupied = true;
});
await sleep(700);

mkdirSync('screenshots', { recursive: true });
await page.screenshot({ path: outPath, fullPage: false });
console.log(`Wrote ${outPath}`);
await browser.close();
