// Captures a gameplay screenshot of Goblin Scaling.
// Run: node scripts/screenshot.mjs (vite dev server at :5173)
//
// Skips the goblin intro by stripping the intro overlay + intro-hold so the
// sidebar (Resources / Summon) and the world canvas are both visible at the
// moment the screenshot fires. Spawns a few goblins so the play area isn't
// just an empty starter cell.

import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';

const OUT = path.resolve('public/game-screenshot.png');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const context = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  deviceScaleFactor: 2,
});
const page = await context.newPage();

page.on('console', (msg) => {
  if (msg.type() === 'error') console.log('PAGE ERR:', msg.text());
});

await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });

// Wait a beat for Pixi to mount and the sidebar to render its first frame.
await sleep(1500);

// Skip the goblin intro: drop the overlay entirely and lift the intro-hold
// that hides the summon panel + first task line.
await page.evaluate(() => {
  document.body.classList.remove('intro-hold');
  document.getElementById('intro-overlay')?.remove();
  document.getElementById('task-text')?.classList.add('revealed');
});

// Let the panel/task fade-ins (1200ms) finish before clicking Spawn so the
// button is interactive, then spawn a handful of goblins so the world isn't
// empty in the shot.
await sleep(1400);
const spawn = await page.$('#btn-spawn-goblin');
if (spawn) {
  for (let i = 0; i < 4; i++) {
    await spawn.click();
    await sleep(300);
  }
}

// Brief settle so spawned goblins step out of the hole.
await sleep(1500);

await page.screenshot({ path: OUT, fullPage: false });
console.log('Saved:', OUT);

await context.close();
await browser.close();
