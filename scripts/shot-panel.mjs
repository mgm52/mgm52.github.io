// Screenshot the hell info panel for a given selection.
//   SEL=chair-empty | chair-full | beacon   OUT=foo.png node scripts/shot-panel.mjs
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sel = process.env.SEL || 'chair-empty';
const outPath = process.env.OUT || 'screenshots/panel.png';

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
page.on('pageerror', (e) => console.log('PAGE ERR:', e.message));
await page.goto('http://127.0.0.1:5173', { waitUntil: 'networkidle' });
await page.waitForFunction(() => !!window.__game?.state, { timeout: 15000 });
await page.evaluate(() => document.getElementById('title-screen')?.querySelector('button')?.click());
await sleep(500);
await page.evaluate(() => { document.body.classList.remove('intro-hold', 'intro-cutscene-hold','bob-cutscene-hold'); });

await page.evaluate(({ sel }) => {
  const { state, ctx } = window.__game;
  state.hellUnlocked = true; state.view = 'hell'; ctx.depth = 1; ctx.hellZoom = 1;
  const chairs = state.soulChairs;
  if (sel === 'chair-full') { chairs[0].occupied = true; chairs[0].filledAt = state.now - 2; chairs[0].selected = true; }
  else if (sel === 'chair-empty') { chairs[0].selected = true; }
  else if (sel === 'beacon') {
    const PA = state.playArea;
    const cx = Math.floor((PA.x0 + PA.x1) / 2), cy = Math.floor((PA.y0 + PA.y1) / 2);
    const id = state.nextId++;
    state.buildings.set(id, { id, displayNum: 1, kind: 'hell_portal', cell: { cx, cy }, state: 'active', buildProgress: 1, activatedAt: state.now - 5, assignedGoblins: [], selected: true });
  }
}, { sel });

await sleep(1300);
mkdirSync('screenshots', { recursive: true });
// Crop to the right-hand sidebar where the info panel lives.
await page.screenshot({ path: outPath, clip: { x: 998, y: 505, width: 282, height: 210 } });
console.log(`Wrote ${outPath}`);
await browser.close();
