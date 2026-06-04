// Rapid-fire clipped screenshots of the sidebar through a task celebration.
//   TASK=earn_100|gas OUT=screenshots/frames node scripts/repro-frames.mjs
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const which = process.env.TASK || 'gas';
const outDir = process.env.OUT || `screenshots/frames-${which}`;
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const ctx = await browser.newContext({ viewport: { width: 430, height: 932 }, hasTouch: true });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('PAGE ERR:', e.message));
await page.goto('http://127.0.0.1:5173', { waitUntil: 'networkidle' });
await page.waitForFunction(() => !!window.__game?.state, { timeout: 15000 });
await page.evaluate(() => document.getElementById('title-screen')?.querySelector('button')?.click());
await sleep(500);
await page.evaluate(() => { document.body.classList.remove('intro-hold', 'bob-cutscene-hold'); });

if (which === 'gas') {
  await page.click('#options-cog');
  const skipBtn = page.locator('button', { hasText: 'Work skip' });
  await skipBtn.click();
  await sleep(300);
  await skipBtn.click();
  await sleep(300);
  await page.click('#options-cog');
  await sleep(1000);
  await page.evaluate(() => {
    const { state } = window.__game;
    const PA = state.playArea;
    const id = state.nextId++;
    state.buildings.set(id, {
      id, displayNum: 1, kind: 'gas_engine',
      cell: { cx: PA.x0 + 2, cy: PA.y0 + 2 },
      state: 'active', buildProgress: 1, activatedAt: state.now,
      assignedGoblins: [], selected: false,
    });
  });
} else {
  await sleep(1500);
  await page.evaluate(() => { window.__game.state.money = 150; });
}

// Sidebar occupies the lower part of the portrait layout.
const clip = { x: 0, y: 500, width: 430, height: 432 };
const t0 = Date.now();
while (Date.now() - t0 < 12000) {
  const t = ((Date.now() - t0) / 1000).toFixed(2);
  await page.screenshot({ path: `${outDir}/t${t.padStart(5, '0')}.png`, clip });
}
console.log(`Wrote frames to ${outDir}`);
await browser.close();
