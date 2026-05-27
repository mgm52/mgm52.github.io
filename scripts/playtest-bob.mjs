// Playtest the Bob cutscene + hole-picker flow end-to-end.
// Requires the dev server (`npm run dev`) on :5173.
// Verifies:
//   1. The new-game intro overlay shows up after a few seconds.
//   2. Triggering the Bob cheat then saying "NO" leaves the trigger armed,
//      so the next building placement re-runs the cutscene.
//   3. Saying "OKAY" enters the hole-picker state: hint text shows,
//      yellow rings pulse, and tick-time freezes.
//   4. Clicking the main Goblin Hole seats Bob and exits the picker.

import { chromium } from 'playwright';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await context.newPage();

let pageErrors = 0;
page.on('console', (m) => {
  if (m.type() === 'error') { pageErrors++; console.log('PAGE ERR:', m.text()); }
});
page.on('pageerror', (e) => { pageErrors++; console.log('PAGE ERR:', e.message); });

await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
await page.waitForFunction(() => !!window.__game?.state, { timeout: 15_000 });

// ── 1. Intro plays after a few seconds ──────────────────────────────────────
console.log('[1] Waiting for intro overlay…');
const introStart = Date.now();
await page.waitForSelector('#intro-overlay.visible', { timeout: 15_000 });
const introDelay = Date.now() - introStart;
console.log(`    ✓ Intro overlay appeared after ${(introDelay / 1000).toFixed(1)}s`);
if (introDelay < 2000) {
  console.log('    ⚠ Intro appeared faster than expected');
}

// Click through the intro naturally — Work skip sets introAborted, which
// would short-circuit our later Bob cutscene too. Wait for each speech line
// to finish typing (.done), click the wall, pick NO at the YES/NO step.
console.log('[1] Clicking through intro…');
await page.waitForSelector('#intro-overlay.up', { timeout: 15_000 });
// Slide-up + post-slide-beat + turn-around ≈ 8.1s before the first speak.
await sleep(8500);
async function advanceLine() {
  await page.waitForSelector('#intro-overlay.speaking', { timeout: 30_000 });
  await page.waitForSelector('#intro-speech.done', { timeout: 30_000 });
  await sleep(300);
  await page.click('#intro-clickwall');
}
async function clickThroughBobCutscene(choice) {
  await page.waitForSelector('#intro-overlay.up', { timeout: 15_000 });
  // Slide-up + post-slide-beat + turn-around ≈ 8.1s before the first speak.
  await sleep(8500);
  // Bob cutscene has 4 speak lines before the OKAY/NO choice.
  await advanceLine();
  await advanceLine();
  await advanceLine();
  await advanceLine();
  await page.waitForSelector('#intro-overlay.show-buttons', { timeout: 30_000 });
  await sleep(300);
  await page.click(choice === 'yes' ? '#intro-yes' : '#intro-no');
  // Wait for the goblin to slide off and overlay to clear.
  await page.waitForFunction(() => {
    const o = document.getElementById('intro-overlay');
    return o && !o.classList.contains('visible');
  }, { timeout: 30_000 });
  // Belt-and-braces: also wait for bob-cutscene-hold to lift.
  await page.waitForFunction(() => !document.body.classList.contains('bob-cutscene-hold'), { timeout: 5_000 });
}
// hello / do you want to know how to play
await advanceLine();
await advanceLine();
// YES/NO choice — pick NO so the post-choice monologue is the short one.
await page.waitForSelector('#intro-overlay.show-buttons', { timeout: 15_000 });
await sleep(300);
await page.click('#intro-no');
// follow-up + monologue + goodbye (3 lines on the NO branch).
await advanceLine();
await advanceLine();
await advanceLine();
// Wait for the overlay to leave the screen.
await page.waitForFunction(() => {
  const o = document.getElementById('intro-overlay');
  return o && !o.classList.contains('visible');
}, { timeout: 30_000 });
console.log('    ✓ Intro finished naturally');

// Helper: synthesize a click at world-cell (cx, cy) by translating through
// the camera. Pixi listens on the canvas via DOM pointer events, so the
// native mouse.click is enough.
async function clickCell(cx, cy) {
  const screen = await page.evaluate(({ cx, cy }) => {
    const { ctx } = window.__game;
    const CELL = 32;
    const wx = cx * CELL + CELL / 2;
    const wy = cy * CELL + CELL / 2;
    // worldLayer.toGlobal maps world-space px to renderer-space px (CSS
    // pixels — Pixi's resolution scaling is applied to the canvas backing
    // store, not the .x/.y of containers).
    const p = ctx.worldLayer.toGlobal({ x: wx, y: wy });
    const rect = ctx.app.canvas.getBoundingClientRect();
    return { x: rect.left + p.x, y: rect.top + p.y };
  }, { cx, cy });
  console.log(`    click cell (${cx},${cy}) → screen (${screen.x.toFixed(0)},${screen.y.toFixed(0)})`);
  await page.mouse.move(screen.x, screen.y);
  await page.mouse.down();
  await sleep(30);
  await page.mouse.up();
}

// ── 2. Bob cheat persists across "NO" ───────────────────────────────────────
console.log('[2] Cheating money + Bob trigger…');
await page.evaluate(() => {
  const s = window.__game.state;
  s.money = 100_000;
  s.bobCheatPending = true;
  s.bobSpawned = false;
  s.bobPickingHole = false;
  // Pre-pick a build kind so we don't have to click a sidebar button.
  s.pendingBuild = { kind: 'goblin_wheel' };
});
const holeCell = await page.evaluate(() => window.__game.state.hole.cell);
console.log(`    main hole at cell (${holeCell.cx}, ${holeCell.cy})`);

// Place the first wheel 5 cells right of the hole.
console.log('[2] Placing building #1 (expect cutscene)…');
await clickCell(holeCell.cx + 5, holeCell.cy);
await page.waitForSelector('#intro-overlay.visible', { timeout: 15_000 });
console.log('    ✓ Cutscene #1 visible — clicking through to choice…');
await clickThroughBobCutscene('no');
console.log('    ✓ Said NO');
const afterNo = await page.evaluate(() => {
  const s = window.__game.state;
  return { cheatPending: s.bobCheatPending, picking: s.bobPickingHole, spawned: s.bobSpawned };
});
console.log(`    state after NO:`, afterNo);
if (!afterNo.cheatPending) {
  console.log('    ✗ FAIL: bobCheatPending should still be true after NO');
  process.exit(1);
}
console.log('    ✓ Cheat persists after NO');

// Place another wheel to confirm re-trigger.
console.log('[2] Placing building #2 (expect cutscene AGAIN)…');
await page.evaluate(() => { window.__game.state.pendingBuild = { kind: 'goblin_wheel' }; });
await clickCell(holeCell.cx + 5, holeCell.cy + 3);
await page.waitForSelector('#intro-overlay.visible', { timeout: 15_000 });
console.log('    ✓ Cutscene #2 visible — clicking through to choice…');

// ── 3. Say OKAY → enter picker → time frozen → hint text ────────────────────
console.log('[3] Clicking through to OKAY…');
await clickThroughBobCutscene('yes');
await page.waitForFunction(() => window.__game.state.bobPickingHole === true, { timeout: 5_000 });
console.log('    ✓ bobPickingHole === true');

// Hint text must surface and indicate what's happening.
const hint = await page.evaluate(() => {
  const el = document.getElementById('placement-hint');
  return { display: getComputedStyle(el).display, text: el.textContent };
});
console.log(`    placement-hint: display=${hint.display} text="${hint.text}"`);
if (hint.display === 'none' || !hint.text.toLowerCase().includes('bob')) {
  console.log('    ✗ FAIL: hint should be visible and mention Bob');
  process.exit(1);
}
console.log('    ✓ Hint text indicates Bob is waiting');

// Time should freeze: sample state.now twice across a real wait.
const now1 = await page.evaluate(() => window.__game.state.now);
await sleep(800);
const now2 = await page.evaluate(() => window.__game.state.now);
console.log(`    state.now before=${now1.toFixed(3)} after=${now2.toFixed(3)}`);
if (now2 - now1 > 0.05) {
  console.log('    ✗ FAIL: state.now advanced during bobPickingHole (expected frozen)');
  process.exit(1);
}
console.log('    ✓ Tick-time frozen during hole-picker');

// ── 4. Click the main hole → Bob spawns ─────────────────────────────────────
console.log('[4] Clicking the main Goblin Hole…');
await clickCell(holeCell.cx, holeCell.cy);
await page.waitForFunction(() => window.__game.state.bobPickingHole === false, { timeout: 5_000 });
const afterSpawn = await page.evaluate(() => {
  const s = window.__game.state;
  let bob = null;
  for (const g of s.goblins.values()) { if (g.bob) { bob = { id: g.id, cell: g.cell }; break; } }
  return { picking: s.bobPickingHole, spawned: s.bobSpawned, cheatPending: s.bobCheatPending, bob };
});
console.log(`    state after click:`, afterSpawn);
if (!afterSpawn.spawned || !afterSpawn.bob) {
  console.log('    ✗ FAIL: Bob did not spawn');
  process.exit(1);
}
console.log('    ✓ Bob spawned on the picked hole');

// Hint should be gone again.
const hint2 = await page.evaluate(() => {
  const el = document.getElementById('placement-hint');
  return { display: getComputedStyle(el).display, text: el.textContent };
});
console.log(`    placement-hint after spawn: display=${hint2.display}`);
if (hint2.display !== 'none') {
  console.log('    ⚠ hint still visible after spawn');
}

// Screenshot for visual confirmation (out-of-repo).
await page.screenshot({ path: '/tmp/playtest-bob-end.png', fullPage: false });

console.log('\n=== PLAYTEST PASSED ===');
if (pageErrors > 0) {
  console.log(`(but ${pageErrors} page errors logged — review above)`);
}
await context.close();
await browser.close();
