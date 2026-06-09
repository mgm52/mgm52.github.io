// Records the "striking Lolly speeds her up" mechanic: she rampages the start
// area; a lightning bolt to the face turns her blue and faster ("speed up!"),
// then a reactor meltdown's fallout turns her green and faster still (three
// "speed up!"s). Converts the capture to mp4.
//
// Run against a FRESHLY-STARTED dev server: node scripts/record-lolly-boost.mjs
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const OUT_DIR = path.resolve('videos');
fs.mkdirSync(OUT_DIR, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const context = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  recordVideo: { dir: OUT_DIR, size: { width: 1280, height: 720 } },
});
const page = await context.newPage();
page.on('pageerror', (e) => console.log('PAGE ERR:', e.message));

await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
await page.waitForFunction(() => !!window.__game?.state, { timeout: 15000 });
await page.evaluate(() => { window.__game.skipIntro(); });

// Loose Lolly into the start area (its goblins + hole are her prey), give blood
// for the strikes, and frame her.
await page.evaluate(() => {
  const { state, ctx } = window.__game;
  state.blood = 99999;
  const c = { x: ctx.camera.x + 640 / ctx.renderScale, y: ctx.camera.y + 320 / ctx.renderScale };
  state.lolly = { pos: { x: c.x + 300, y: c.y }, facing: Math.PI, target: null, nextWanderAt: 0, spawnAt: state.now };
});

// Camera follow — snappy, so a boosted (fast) Lolly stays centred.
let follow = true;
(async () => {
  while (follow) {
    await page.evaluate(() => {
      const { state, ctx } = window.__game;
      if (!state.lolly) return;
      ctx.camera.x = state.lolly.pos.x - ctx.viewport.width / (2 * ctx.renderScale);
      ctx.camera.y = state.lolly.pos.y - ctx.viewport.height / (2 * ctx.renderScale);
    }).catch(() => {});
    await sleep(40);
  }
})();

await sleep(2600);
// ── Lightning to the face: blue surge ──
console.log('Lightning strike on Lolly…');
await page.evaluate(async () => {
  const { state } = window.__game;
  (await import('/src/sim.ts')).lightningStrike(state, state.lolly.pos.x, state.lolly.pos.y);
});
await sleep(4200);
// ── Meltdown fallout: green surge ──
console.log('Meltdown fallout over Lolly…');
await page.evaluate(() => {
  const { state } = window.__game;
  state.meltdowns.push({ id: state.nextId++, x: state.lolly.pos.x, y: state.lolly.pos.y, startAt: state.now - 0.8, lastRadius: 0, killed: 0, dragonsKilled: 0 });
});
await sleep(6000);

follow = false;
await sleep(300);
console.log('Done — flushing video.');
await context.close();
await browser.close();

const files = fs.readdirSync(OUT_DIR).filter((f) => f.endsWith('.webm'));
const newest = files.map((f) => ({ f, t: fs.statSync(path.join(OUT_DIR, f)).mtimeMs })).sort((a, b) => b.t - a.t)[0];
if (newest) {
  const webm = path.join(OUT_DIR, newest.f);
  const mp4 = path.join(OUT_DIR, 'lolly-boost.mp4');
  let ffmpeg = 'ffmpeg';
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); }
  catch { ffmpeg = path.resolve('node_modules/ffmpeg-static/ffmpeg'); }
  execFileSync(ffmpeg, ['-y', '-i', webm, '-c:v', 'libx264', '-preset', 'slow', '-crf', '23', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-profile:v', 'high', '-level', '4.0', mp4], { stdio: 'inherit' });
  fs.unlinkSync(webm);
  console.log('Saved:', mp4);
}
