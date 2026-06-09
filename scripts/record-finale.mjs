// Records the endgame finale to an mp4: Lolly scours the overworld, calls down
// a dragon, rides it up to wreck the player's orbital holdings, tears the moon
// from the sky, and rides back down to demand Bob eat of it — Bob refuses,
// smashes it, and the world whites out. The camera follows her between scenes,
// and the closing confrontation is clicked through at a readable pace.
//
// Run against a FRESHLY-STARTED dev server: node scripts/record-finale.mjs
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const OUT_DIR = path.resolve('videos');
fs.mkdirSync(OUT_DIR, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const context = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  recordVideo: { dir: OUT_DIR, size: { width: 1280, height: 720 } },
});
const page = await context.newPage();
page.on('pageerror', (e) => console.log('PAGE ERR:', e.message));
page.on('dialog', (d) => d.accept());

await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
await page.waitForFunction(() => !!window.__game?.state, { timeout: 15000 });

// Scour the overworld bare, stock space with a few buildings + units for Lolly
// to wreck, and loose her — which trips the finale on the next tick.
await page.evaluate(async () => {
  document.body.classList.remove('intro-hold', 'intro-cutscene-hold', 'bob-cutscene-hold');
  window.__game.skipIntro();
  const cfg = await import('/src/config.ts');
  const { state } = window.__game;
  state.buildings.clear();
  state.goblins.clear();
  state.minotaurs.clear();
  state.holeDestroyed = true;
  state.spaceUnlocked = true;
  // A scattering of doomed possessions up in orbit.
  for (let i = 0; i < 5; i++) {
    const id = state.nextId++;
    state.spaceUnits.set(id, {
      id, kind: i % 2 ? 'minotaur' : 'goblin',
      pos: { x: 540 + (i % 3) * 320, y: 360 + Math.floor(i / 3) * 300 },
      vel: { x: 0, y: 0 }, facing: Math.PI / 2, spin: 0, spinRate: 0,
      selected: false, diesAt: state.now + 99999, tiny: i === 3,
    });
  }
  const c = { x: cfg.WORLD.width * 0.5, y: cfg.WORLD.height * 0.5 };
  state.lolly = { pos: { x: c.x, y: c.y }, facing: Math.PI / 2, target: null, nextWanderAt: 0, spawnAt: state.now };
});

// Follow Lolly across the scenes; click the confrontation modal at a readable
// pace. Runs until the world has gone white.
const t0 = Date.now();
const DEADLINE = 160_000;
let lastView = 'ground';
let lastArmedHandledAt = 0;

while (Date.now() - t0 < DEADLINE) {
  const snap = await page.evaluate(() => {
    const { state, ctx } = window.__game;
    const F = state.finale;
    if (F) {
      // Keep the player's view in the scene Lolly is acting in (until the
      // confrontation, which main.ts pulls back to the ground itself).
      if (F.phase !== 'confront' && F.phase !== 'shattered') {
        if (F.scene === 'space' && state.view !== 'space') { state.view = 'space'; ctx.altitude = 1; }
        if (F.scene === 'ground' && state.view !== 'ground') { state.view = 'ground'; ctx.altitude = 0; }
      }
      // Ease the right camera toward her like a camera operator.
      const follow = (cam, x, y) => {
        const tx = x - ctx.viewport.width / (2 * ctx.renderScale);
        const ty = y - ctx.viewport.height / (2 * ctx.renderScale);
        cam.x += (tx - cam.x) * 0.1;
        cam.y += (ty - cam.y) * 0.1;
      };
      if (F.phase === 'confront' || F.phase === 'shattered') {
        const pa = state.playArea, CELL = 32;
        follow(ctx.camera, ((pa.x0 + pa.x1) / 2) * CELL, ((pa.y0 + pa.y1) / 2) * CELL);
      } else if (F.scene === 'space') {
        follow(ctx.spaceCamera, F.lollyPos.x, F.lollyPos.y);
      } else {
        follow(ctx.camera, F.lollyPos.x, F.lollyPos.y);
      }
    }
    const overlay = document.getElementById('demon-overlay');
    const modalOpen = !!overlay && overlay.classList.contains('visible') && !overlay.classList.contains('rebuke');
    return {
      phase: F ? F.phase : null,
      modalArmed: modalOpen && overlay.classList.contains('click-armed'),
      whiteOpacity: Number(document.getElementById('finale-white')?.style.opacity || '0'),
    };
  });

  // Click the modal lines through with a beat of reading time.
  if (snap.modalArmed && Date.now() - lastArmedHandledAt > 850) {
    lastArmedHandledAt = Date.now();
    await sleep(850);
    await page.evaluate(() => document.getElementById('demon-clickwall').click());
  }

  if (snap.phase === 'shattered' && snap.whiteOpacity >= 1) {
    await sleep(1800);  // hold on the white
    break;
  }
  await sleep(70);
}

await sleep(800);
console.log('Done — flushing video.');
await context.close();
await browser.close();

// Convert the webm capture to a shareable H.264 mp4.
const files = fs.readdirSync(OUT_DIR).filter((f) => f.endsWith('.webm'));
const newest = files
  .map((f) => ({ f, t: fs.statSync(path.join(OUT_DIR, f)).mtimeMs }))
  .sort((a, b) => b.t - a.t)[0];
if (newest) {
  const webm = path.join(OUT_DIR, newest.f);
  const mp4 = path.join(OUT_DIR, 'finale.mp4');
  let ffmpeg = 'ffmpeg';
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); }
  catch { ffmpeg = path.resolve('node_modules/ffmpeg-static/ffmpeg'); }
  execFileSync(ffmpeg, [
    '-y', '-i', webm,
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '23',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    '-profile:v', 'high', '-level', '4.0', mp4,
  ], { stdio: 'inherit' });
  fs.unlinkSync(webm);
  console.log('Saved:', mp4);
}
