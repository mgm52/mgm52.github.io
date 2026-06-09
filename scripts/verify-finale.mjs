// Drives the endgame finale end to end via window.__game (dev only): clears the
// overworld so Lolly's rampage runs dry, which kicks off the cinematic — the
// dragon summon, the climb to space, the orbital rampage, the moon grab, the
// descent, the confrontation modal, and the world-shattering white-out. Asserts
// the phase machine advances all the way to 'shattered' with no page errors,
// and screenshots the key beats.
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
// Environmental noise we don't own (self-signed cert on the og-image host, a
// missing favicon) — not JS errors, so they don't count against the run.
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

// Skip the intro, scour the overworld bare, give the player a couple of space
// possessions for Lolly to smash, and loose her — which immediately triggers
// the finale (updateLolly finds nothing left to destroy).
await page.evaluate(() => {
  document.body.classList.remove('intro-hold', 'intro-cutscene-hold', 'bob-cutscene-hold');
  window.__game.skipIntro();
  const { state } = window.__game;
  state.buildings.clear();
  state.goblins.clear();
  state.minotaurs.clear();
  state.holeDestroyed = true;
  state.spaceUnlocked = true;
  // A couple of units adrift in space for the orbital rampage to find.
  for (let i = 0; i < 3; i++) {
    const id = state.nextId++;
    state.spaceUnits.set(id, {
      id, kind: 'goblin', pos: { x: 700 + i * 220, y: 360 + i * 90 },
      vel: { x: 0, y: 0 }, facing: Math.PI / 2, spin: 0, spinRate: 0,
      selected: false, diesAt: state.now + 9999,
    });
  }
  const c = { x: 600, y: 500 };
  state.lolly = { pos: { x: c.x, y: c.y }, facing: Math.PI / 2, target: null, nextWanderAt: 0, spawnAt: state.now };
});

// Watch the phase machine, screenshotting the first time we see each phase.
const seen = new Set();
const order = [];
let confrontModalSeen = false;
let glitchSeen = false;
const deadline = Date.now() + 150_000;
let lastLine = '';

while (Date.now() < deadline) {
  const snap = await page.evaluate(() => {
    const { state, ctx } = window.__game;
    const F = state.finale;
    // Keep the space camera roughly on Lolly so a space screenshot frames her.
    if (F && F.scene === 'space') {
      ctx.spaceCamera.x = F.lollyPos.x - ctx.viewport.width / (2 * ctx.renderScale);
      ctx.spaceCamera.y = F.lollyPos.y - ctx.viewport.height / (2 * ctx.renderScale);
    }
    const overlay = document.getElementById('demon-overlay');
    const game = document.getElementById('app');
    const white = document.getElementById('finale-white');
    // The real confrontation modal is a non-rebuke overlay (barks use .rebuke).
    const modalOpen = !!overlay && overlay.classList.contains('visible') && !overlay.classList.contains('rebuke');
    return {
      phase: F ? F.phase : null,
      scene: F ? F.scene : null,
      moonState: F && F.moon ? F.moon.state : null,
      spaceUnits: state.spaceUnits.size,
      view: state.view,
      modalOpen,
      modalArmed: modalOpen && overlay.classList.contains('click-armed'),
      line: document.getElementById('demon-line')?.textContent || '',
      glitch: !!game && game.classList.contains('finale-glitch'),
      zoom: !!game && game.classList.contains('finale-zoom'),
      whiteOpacity: white ? Number(white.style.opacity || '0') : -1,
    };
  });

  if (snap.phase && !seen.has(snap.phase)) {
    seen.add(snap.phase);
    order.push(snap.phase);
    console.log(`→ phase: ${snap.phase} (scene=${snap.scene}, spaceUnits=${snap.spaceUnits})`);
    // When she reaches space, hop the player up to watch the rampage.
    if (snap.phase === 'space_rampage') {
      await page.evaluate(() => { const { state, ctx } = window.__game; state.view = 'space'; ctx.altitude = 1; });
    }
    await sleep(150);
    await page.screenshot({ path: `screenshots/finale-${order.length}-${snap.phase}.png` });
  }
  if (snap.glitch) glitchSeen = true;

  // Auto-click through the confrontation modal.
  if (snap.modalOpen) {
    if (!confrontModalSeen) {
      confrontModalSeen = true;
      await sleep(400);
      await page.screenshot({ path: 'screenshots/finale-confront.png' });
    }
    if (snap.line && snap.line !== lastLine) { lastLine = snap.line; console.log(`   line: "${snap.line}"`); }
    if (snap.modalArmed) {
      await page.evaluate(() => document.getElementById('demon-clickwall').click());
    }
    await sleep(120);
    continue;
  }

  if (snap.phase === 'shattered') {
    await sleep(2200);  // let the white-out finish
    await page.screenshot({ path: 'screenshots/finale-shattered.png' });
    break;
  }
  await sleep(250);
}

const final = await page.evaluate(() => {
  const { state } = window.__game;
  const game = document.getElementById('app');
  const white = document.getElementById('finale-white');
  return {
    phase: state.finale ? state.finale.phase : null,
    moonState: state.finale && state.finale.moon ? state.finale.moon.state : null,
    zoom: !!game && game.classList.contains('finale-zoom'),
    whiteOpacity: white ? Number(white.style.opacity || '0') : -1,
  };
});

console.log('phases seen:', order.join(' → '));
check('reached the summon', order.includes('summon'));
check('climbed to space', order.includes('space_rampage'));
check('grabbed the moon', order.includes('grab_moon') || final.moonState === 'grabbed' || final.moonState === 'shattering');
check('rode back down', order.includes('lolly_descends'));
check('ran the confrontation modal', confrontModalSeen);
check('the screen glitched', glitchSeen);
check('reached the shattered end', final.phase === 'shattered', JSON.stringify(final));
check('zoomed out + faded to white', final.zoom && final.whiteOpacity > 0.9, JSON.stringify(final));
check('no page/console errors', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
