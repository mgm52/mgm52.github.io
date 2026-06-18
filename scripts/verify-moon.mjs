// Pre-finale moon check (dev only, via window.__game): on a fresh game the
// moon already hangs in space, renders behind the building/unit layers, takes
// a tap (selection ring + "The Moon" info panel), and deselects on a void tap.
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync('screenshots', { recursive: true });

let failures = 0;
const errors = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await ctx.newPage();
const ENV_NOISE = /ERR_CERT|Failed to load resource|favicon/i;
page.on('pageerror', (e) => { console.log('PAGE ERR:', e.message); errors.push(e.message); });
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const t = m.text();
  if (ENV_NOISE.test(t)) return;
  console.log('CONSOLE ERR:', t);
  errors.push(t);
});

await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
await page.waitForFunction(() => !!window.__game?.state, { timeout: 15000 });

// Fresh game, long before any finale: skip the intro (its overlay would
// swallow the clicks below) and hop straight up to the space view.
const setup = await page.evaluate(() => {
  document.body.classList.remove('intro-hold', 'intro-cutscene-hold', 'bob-cutscene-hold');
  window.__game.skipIntro();
  const { state, ctx } = window.__game;
  state.spaceUnlocked = true;
  state.view = 'space';
  ctx.altitude = 1;
  return {
    moonExists: !!state.moon,
    moonScene: state.moon?.scene,
    moonState: state.moon?.state,
    noFinale: !state.finale,
    // The moon's disc must live below the building/unit layers in the scene.
    layerOrderOk:
      ctx.spaceLayer.getChildIndex(ctx.spaceAmbientLayer) < ctx.spaceLayer.getChildIndex(ctx.spaceMiscLayer) &&
      ctx.spaceLayer.getChildIndex(ctx.spaceAmbientLayer) < ctx.spaceLayer.getChildIndex(ctx.spaceUnitLayer) &&
      ctx.spaceAmbientLayer.getChildIndex(ctx.spaceMoonGfx) === 0,
  };
});
check('moon exists on a fresh game (no finale)', setup.moonExists && setup.noFinale);
check('moon floats in space', setup.moonScene === 'space' && setup.moonState === 'floating');
check('moon layer sits beneath buildings and units', setup.layerOrderOk);

// Pan the space camera onto the moon (it hangs mid-scene, off the default
// camera's right edge), then find where its disc lands on screen (stage
// coords + the canvas's page offset) and really click it.
await page.evaluate(() => {
  const { state, ctx } = window.__game;
  ctx.spaceCamera.x = state.moon.pos.x - ctx.viewport.width / (2 * ctx.renderScale);
  ctx.spaceCamera.y = state.moon.pos.y - ctx.viewport.height / (2 * ctx.renderScale);
});
await sleep(600);
const p = await page.evaluate(() => {
  const { ctx } = window.__game;
  const g = ctx.spaceMoonGfx.toGlobal({ x: 0, y: 0 });
  const r = ctx.app.canvas.getBoundingClientRect();
  return { x: r.left + g.x, y: r.top + g.y, visible: ctx.spaceMoonGfx.visible };
});
check('moon disc is rendered', p.visible);
await page.mouse.click(p.x, p.y);
await sleep(400);
const afterClick = await page.evaluate(() => ({
  selected: !!window.__game.state.moon.selected,
  panelName: document.getElementById('info-name')?.textContent ?? '',
  panelVisible: !!document.getElementById('info-panel')?.classList.contains('visible'),
}));
check('tap selects the moon', afterClick.selected);
check('info panel shows The Moon', afterClick.panelVisible && afterClick.panelName === 'The Moon', afterClick.panelName);
await page.screenshot({ path: 'screenshots/moon-selected.png' });

// A tap on bare void clears it again.
await page.mouse.click(p.x, Math.max(10, p.y - 300));
await sleep(300);
const afterVoid = await page.evaluate(() => !!window.__game.state.moon.selected);
check('void tap deselects the moon', !afterVoid);

check('no page/console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
