// One-off: drive Bob to the corner demon and verify the _leave_ word renders
// in the white emphasis style, with a screenshot at that beat.
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync('screenshots', { recursive: true });

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
await page.waitForFunction(() => !!window.__game?.state, { timeout: 15000 });
await page.evaluate(() => {
  document.body.classList.remove('intro-hold', 'intro-cutscene-hold', 'bob-cutscene-hold');
  window.__game.state.bobPickingHole = false;
  window.__game.skipIntro();
  // Hell view, camera on the corner demon so the screenshot shows the scene.
  const { state, ctx } = window.__game;
  state.view = 'hell';
  ctx.depth = 1;
  ctx.hellZoom = 1;
  const f = [...state.demons.values()].find((d) => d.variant === 'friend');
  const scale = 1.3 * 0.5;
  ctx.hellCamera.x = f.hx - ctx.viewport.width / (2 * scale);
  ctx.hellCamera.y = f.hy - ctx.viewport.height / (2 * scale);
  const id = state.nextId++;
  state.ghosts.push({
    id, kind: 'goblin', x: 0, y: 0, facing: 0, spawnAt: state.now,
    hx: f.hx, hy: f.hy - 60, selected: false, parlayDemonId: f.id, speedMult: 0, bob: true,
  });
});

let sawWhiteEm = false;
let shot = false;
for (let i = 0; i < 400; i++) {
  const s = await page.evaluate(() => {
    const o = document.getElementById('demon-overlay');
    const em = document.querySelector('#demon-line em.demon-em.white');
    return {
      open: o.classList.contains('visible'),
      armed: o.classList.contains('click-armed'),
      choice: o.classList.contains('show-buttons'),
      whiteEm: em ? em.textContent : null,
      line: document.getElementById('demon-line').textContent,
    };
  });
  if (s.whiteEm) {
    sawWhiteEm = true;
    if (!shot && s.line.includes('ecalp')) { // full line typed
      await page.screenshot({ path: 'screenshots/corner-demon-leave.png' });
      shot = true;
      console.log('white em content:', JSON.stringify(s.whiteEm));
    }
  }
  if (i > 2 && !s.open) break;
  if (s.choice) { await page.click('#demon-yes'); await sleep(150); continue; }
  if (s.armed) { await page.click('#demon-clickwall'); await sleep(120); }
  else await sleep(120);
}
console.log(sawWhiteEm && shot ? 'PASS  _leave_ renders as em.demon-em.white' : 'FAIL  white emphasis not seen');
await browser.close();
process.exit(sawWhiteEm && shot ? 0 : 1);
