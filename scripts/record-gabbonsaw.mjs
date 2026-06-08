// Records (and verifies) the Pain Gabbonsaw ritual end to end: task-skips a
// fresh run through to the final Collect-9,999,999-blood task, grants the
// dragon bones, buys the ritual, clicks through Bob's return cutscene (with
// the "pain gabbonsaw" → "spawn bob again" anagram reveal), then follows
// Lolly's rampage — buildings, holes, goblins, the original spawning hole —
// with the camera for a while. Converts the capture to H.264 mp4.
//
// Run against a FRESHLY-STARTED dev server (see the HMR caveat in
// verify-lilly-rewards.mjs): node scripts/record-gabbonsaw.mjs
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const OUT_DIR = path.resolve('videos');
fs.mkdirSync(OUT_DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const context = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  recordVideo: { dir: OUT_DIR, size: { width: 1280, height: 720 } },
});
const page = await context.newPage();
page.on('pageerror', (e) => console.log('PAGE ERR:', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE ERR:', m.text()); });
// The collect_blood reveal fires the demo's "game is incomplete" alerts.
page.on('dialog', (d) => d.accept());

await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
await page.waitForFunction(() => !!window.__game?.state, { timeout: 15000 });
await page.evaluate(() => {
  document.body.classList.remove('intro-hold', 'intro-cutscene-hold', 'bob-cutscene-hold');
  window.__game.skipIntro();
});
// Wait for the sim clock to actually advance (intro teardown holds a beat).
await page.waitForFunction(() => {
  const w = window;
  if (w.__t0 === undefined) { w.__t0 = w.__game.state.now; return false; }
  return w.__game.state.now > w.__t0 + 0.5;
}, { timeout: 20000 });

// ── Task-skip through to the final task + grant the bones ──
await page.evaluate(async () => {
  const ui = await import('/src/ui.ts');
  const { state } = window.__game;
  for (let i = 0; i < 8; i++) ui.executeTaskSkip(state);
  state.dragonBone = 120;
  state.dragonBoneUnlocked = true;
});
await sleep(800); // let refreshUI run (and the secret-settings alerts fire)

check('Pain Gabbonsaw button surfaces after the final task',
  await page.waitForSelector('#btn-buy-gabbonsaw', { state: 'visible', timeout: 5000 })
    .then(() => true).catch(() => false));
check('Pain Gabbonsaw button enabled with 120 bones',
  await page.evaluate(() => !document.getElementById('btn-buy-gabbonsaw').disabled));

// Frame the colony before the buy so the video shows the world that's about
// to be destroyed.
await page.evaluate(() => {
  const { state, ctx } = window.__game;
  const pa = state.playArea;
  ctx.camera.x = ((pa.x0 + pa.x1) / 2) * 32 - ctx.viewport.width / (2 * ctx.renderScale);
  ctx.camera.y = ((pa.y0 + pa.y1) / 2) * 32 - ctx.viewport.height / (2 * ctx.renderScale);
});
await sleep(1500);

console.log('Buying Pain Gabbonsaw…');
await page.click('#btn-buy-gabbonsaw');
check('99 bones deducted + ritual marked bought', await page.evaluate(() => {
  const { state } = window.__game;
  return state.gabbonsawBought && state.dragonBone === 21;
}));
check('button retired after purchase', await page.waitForFunction(
  () => document.getElementById('btn-buy-gabbonsaw').style.display === 'none',
  undefined, { timeout: 3000 }).then(() => true).catch(() => false));

// ── Bob's return cutscene ──
console.log('Waiting for Bob to slide up…');
await page.waitForSelector('#intro-overlay.up', { timeout: 15000 });
await sleep(8200); // slide-up 6000 + beat 1200 + turn ~880

const advanceSpeak = async (label) => {
  console.log(`  speak: ${label}`);
  await page.waitForSelector('#intro-overlay.click-armed', { timeout: 30000 });
  await sleep(700);
  await page.click('#intro-clickwall');
};
await advanceSpeak('oh');
await advanceSpeak('oh no…');
await advanceSpeak('lolly was right.');

console.log('  anagram reveal…');
// state:'attached' — the wrapper is a zero-width anchor (its letter spans
// overflow it), so Playwright's bounding-box visibility test never passes.
check('anagram overlay appears', await page.waitForSelector('#anagram-overlay', { state: 'attached', timeout: 15000 })
  .then(() => true).catch(() => false));
await advanceSpeak('you really would click it.');
await advanceSpeak('now i know what must be done');

console.log('Waiting for Bob to walk off…');
await page.waitForFunction(() => {
  const o = document.getElementById('intro-overlay');
  return o && !o.classList.contains('visible');
}, { timeout: 20000 });

// ── Lolly spawns + rampage ──
check('Lolly spawns after the cutscene', await page.waitForFunction(
  () => !!window.__game.state.lolly, undefined, { timeout: 5000 })
  .then(() => true).catch(() => false));
check("Bob's nametag rides Lolly (no live Bob goblin)", await page.evaluate(() => {
  const { state } = window.__game;
  return ![...state.goblins.values()].some((g) => g.bob)
    && !state.ghosts.some((g) => g.bob);
}));

const before = await page.evaluate(() => ({
  buildings: window.__game.state.buildings.size,
  goblins: window.__game.state.goblins.size,
}));
console.log(`Rampage begins: ${before.buildings} buildings, ${before.goblins} goblins.`);

// Follow her with the camera for ~75s of destruction.
const FOLLOW_MS = 75000;
const t0 = Date.now();
while (Date.now() - t0 < FOLLOW_MS) {
  await page.evaluate(() => {
    const { state, ctx } = window.__game;
    if (!state.lolly) return;
    const targetX = state.lolly.pos.x - ctx.viewport.width / (2 * ctx.renderScale);
    const targetY = state.lolly.pos.y - ctx.viewport.height / (2 * ctx.renderScale);
    // Ease toward her so the follow reads as a camera operator, not a lock.
    ctx.camera.x += (targetX - ctx.camera.x) * 0.08;
    ctx.camera.y += (targetY - ctx.camera.y) * 0.08;
  });
  await sleep(90);
}

const after = await page.evaluate(() => ({
  buildings: window.__game.state.buildings.size,
  goblins: window.__game.state.goblins.size,
  holeDestroyed: window.__game.state.holeDestroyed,
}));
check('Lolly destroys buildings', after.buildings < before.buildings,
  `${before.buildings} → ${after.buildings}`);
check('Lolly destroys the original Goblin Hole', after.holeDestroyed);
console.log(`Goblins: ${before.goblins} → ${after.goblins}`);

await sleep(1500);
console.log('Done — closing context to flush video.');
await context.close();
await browser.close();

// Convert to H.264 mp4 (same pipeline as record-intro.mjs).
const files = fs.readdirSync(OUT_DIR).filter((f) => f.endsWith('.webm'));
const newest = files
  .map((f) => ({ f, t: fs.statSync(path.join(OUT_DIR, f)).mtimeMs }))
  .sort((a, b) => b.t - a.t)[0];
if (newest) {
  const webm = path.join(OUT_DIR, newest.f);
  const mp4 = path.join(OUT_DIR, 'pain-gabbonsaw.mp4');
  console.log('Converting to mp4…');
  // System PATH may not carry ffmpeg, and Playwright's bundled build has no
  // libx264 — prefer a real one, then ffmpeg-static (npm i --no-save
  // ffmpeg-static) as the fallback.
  let ffmpeg = 'ffmpeg';
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); }
  catch { ffmpeg = path.resolve('node_modules/ffmpeg-static/ffmpeg'); }
  execFileSync(ffmpeg, [
    '-y', '-i', webm,
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '23',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    '-profile:v', 'high', '-level', '4.0',
    mp4,
  ], { stdio: 'inherit' });
  fs.unlinkSync(webm);
  console.log('Saved:', mp4);
}

process.exit(failures > 0 ? 1 : 0);
