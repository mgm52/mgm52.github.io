// Drives the Lilly-task-reward features end to end via window.__game (dev
// only): the autospawn throttle (sim cadence at the selected level), the
// Autodragon ritual, the Terminator's auto-hunt, the UI gating of each
// reward (slider / Autodragon button / quick-travel strip / Terminator
// button) once the matching task reveals, and the quick-travel blink.
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync('screenshots', { recursive: true });

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('PAGE ERR:', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE ERR:', m.text()); });

await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
await page.waitForFunction(() => !!window.__game?.state, { timeout: 15000 });
await page.evaluate(() => {
  document.body.classList.remove('intro-hold', 'intro-cutscene-hold', 'bob-cutscene-hold');
  window.__game.skipIntro();
});
// The intro/title plumbing can hold game time for a beat after skipIntro —
// wait until the sim clock is actually advancing before testing cadences.
await page.waitForFunction(() => {
  const w = window;
  if (w.__t0 === undefined) { w.__t0 = w.__game.state.now; return false; }
  return w.__game.state.now > w.__t0 + 0.5;
}, { timeout: 20000 });

// ── 1) Autospawn throttle (sim level) ──
// Level 0 pauses the cadence outright; a positive level runs interval/level.
// NOTE: keep money under 100 here — crossing it completes earn_100 for real,
// and its WORK COMPLETE celebration freezes game time mid-test.
await page.evaluate(() => {
  const { state } = window.__game;
  state.autoSpawnEnabled = true;
  state.autoSpawnMultiplier = 4;
  state.autoSpawnLevel = 0;
  state.spawnQueue.length = 0;
});
await sleep(3600);
check('autoSpawnLevel 0 pauses autospawn', await page.evaluate(
  () => window.__game.state.spawnQueue.length === 0));
const baselineUnits = await page.evaluate(
  () => window.__game.state.spawnQueue.length + window.__game.state.goblins.size);
await page.evaluate(() => { window.__game.state.autoSpawnLevel = 4; });
await sleep(2600);  // x4 ⇒ a fire every 0.75s — several spawns queue/hatch
const afterResume = await page.evaluate(
  () => window.__game.state.spawnQueue.length + window.__game.state.goblins.size);
check('autoSpawnLevel 4 resumes the cadence', afterResume > baselineUnits,
  `${baselineUnits} → ${afterResume}`);

// ── 2) (Autodragon is tested after the task-skip chain, which rigs a
// genuinely powered Dragon Beacon — a hand-planted one goes dormant on the
// next power tick, correctly closing the ritual gate.)
await page.evaluate(() => {
  const { state } = window.__game;
  state.autoSpawnLevel = 0;          // quiet the colony for the hunt test
  state.spawnQueue.length = 0;
});

// ── 3) Terminator hunt ──
// Hatch a handful of flesh goblins through the spawn queue, then release
// the hunter among them.
await page.evaluate(() => {
  const { state } = window.__game;
  for (let slot = 0; slot < 4; slot++) state.spawnQueue.push({ remaining: 0.05, slot });
});
await sleep(800);
const huntStart = await page.evaluate(() => {
  const { state, spawnRobot } = window.__game;
  spawnRobot(state, true);
  let term = null;
  for (const g of state.goblins.values()) if (g.terminator) term = g;
  return {
    spawned: !!term,
    robotFlag: !!term?.robot,
    flesh: [...state.goblins.values()].filter((g) => !g.robot).length,
  };
});
check('Terminator spawns with robot+terminator flags', huntStart.spawned && huntStart.robotFlag);
check('there is flesh to hunt', huntStart.flesh > 0, `${huntStart.flesh} goblins`);
await sleep(6000);  // ~0.5s windup per kill + travel-free hitscan
const huntEnd = await page.evaluate(() => {
  const { state } = window.__game;
  const term = [...state.goblins.values()].find((g) => g.terminator);
  return {
    termAlive: !!term,
    flesh: [...state.goblins.values()].filter((g) => !g.robot).length,
    assigned: [...state.buildings.values()].some((b) => b.assignedGoblins.includes(term?.id)),
  };
});
check('Terminator survives and culls the flesh', huntEnd.termAlive && huntEnd.flesh < huntStart.flesh,
  `${huntStart.flesh} → ${huntEnd.flesh}`);
check('Terminator never drafted onto a building', !huntEnd.assigned);
await page.screenshot({ path: 'screenshots/terminator-hunt.png' });

// ── 4) UI gating via the debug task-skip chain ──
// Skip through the mandatory chain (+ the optional minotaur task) up to
// collect_blood; its reveal should surface the Terminator button.
const skipUntil = async (taskId) => {
  for (let i = 0; i < 12; i++) {
    const done = await page.evaluate((id) => import('/src/ui.ts').then((m) => {
      m.executeTaskSkip(window.__game.state);
      return window.__game.state.unlocks?.completed?.has(id) ?? false;
    }), taskId);
    await sleep(150);
    if (done) return true;
  }
  return false;
};
check('task-skip chain reaches collect_blood', await skipUntil('collect_blood'));
await sleep(400);
const termBtn = await page.evaluate(() => {
  const b = document.getElementById('btn-summon-terminator');
  const warn = document.getElementById('warn-summon-terminator');
  return { shown: b && b.style.display !== 'none', warned: warn && warn.style.display !== 'none' };
});
check('Terminator button revealed by collect_blood, SC-gated',
  termBtn.shown && termBtn.warned, JSON.stringify(termBtn));

// ── 5) Lilly's handout — the one-by-one staged reveal ──
// Flag flips mid-game (no parlay overlay in a test run, so the walk arms
// immediately — 3 lines × 1.1s + the trailing un-dim).
await page.evaluate(() => { window.__game.state.lillyTasksGiven = true; });
// In the rigged colony prevent_spawning can complete the instant it's
// granted, so a WORK COMPLETE celebration may interleave with the handout
// walk — wait for the whole ceremony to clear rather than a fixed beat.
await sleep(1500);
await page.waitForFunction(
  () => !document.body.classList.contains('unlock-reveal-hold'), { timeout: 30000 });
await sleep(300);
const taskLines = await page.evaluate(() => {
  const ids = ['destroy_robot', 'feed_hell_core', 'prevent_spawning'];
  const done = window.__game.state.unlocks?.completed;
  return ids.map((id) => {
    const el = document.getElementById(`task-line-${id}`);
    if (el && !el.classList.contains('reveal-hidden')) return el.textContent;
    return done?.has(id) ? '(completed instantly)' : null;
  });
});
check("Lilly's three lines land (or complete), in destroy/feed/prevent order",
  taskLines.every((t) => t !== null)
  && (taskLines[0].includes('Destroy a robot') || taskLines[0].includes('completed')),
  JSON.stringify(taskLines));
check('walk released the time freeze', await page.evaluate(
  () => !document.body.classList.contains('unlock-reveal-hold')));
await page.screenshot({ path: 'screenshots/lilly-tasks-revealed.png' });

// ── 6) Reward UI after each optional reveals ──
check('task-skip completes destroy_robot', await skipUntil('destroy_robot'));
check('task-skip completes feed_hell_core', await skipUntil('feed_hell_core'));
check('task-skip completes prevent_spawning', await skipUntil('prevent_spawning'));
await sleep(400);
const rewards = await page.evaluate(() => {
  const slider = document.getElementById('autospawn-level-row');
  const auto = document.getElementById('btn-buy-autodragon');
  const strip = document.getElementById('quick-travel');
  const range = document.getElementById('autospawn-level');
  return {
    sliderShown: slider && slider.style.display !== 'none',
    sliderMax: range?.max,
    autoShown: auto && auto.style.display !== 'none',
    stripVisible: strip?.classList.contains('visible'),
  };
});
check('throttle slider shown with one notch per owned tier (x4 ⇒ max 3)',
  rewards.sliderShown && rewards.sliderMax === '3', JSON.stringify(rewards));
check('Autodragon ritual button shown', !!rewards.autoShown);
check('quick-travel strip visible via its task', !!rewards.stripVisible);

// Slider drag → state follows (0 ⇒ off, i ⇒ tier multiplier).
await page.evaluate(() => {
  const range = document.getElementById('autospawn-level');
  range.value = '2';
  range.dispatchEvent(new Event('input', { bubbles: true }));
});
await sleep(300);
const levelAfter = await page.evaluate(() => ({
  level: window.__game.state.autoSpawnLevel,
  label: document.getElementById('autospawn-level-label')?.textContent,
}));
check('slider notch 2 selects tier 2 (x2)', levelAfter.level === 2 && levelAfter.label === 'x2',
  JSON.stringify(levelAfter));
await page.screenshot({ path: 'screenshots/lilly-rewards-ui.png' });

// ── 6b) Autodragon (sim) — the skip rig built a genuinely powered beacon ──
const dragonStart = await page.evaluate(() => {
  const { state } = window.__game;
  state.dragonSpawnQueue.length = 0;
  state.autoDragonEnabled = true;
  state.autoDragonTimer = 0.1;
  return {
    blood: state.blood,
    activeBeacons: [...state.buildings.values()]
      .filter((b) => b.kind === 'dragon_beacon' && b.state === 'active').length,
  };
});
check('skip rig left an active beacon', dragonStart.activeBeacons >= 1,
  JSON.stringify(dragonStart));
await sleep(1500);
const afterDragon = await page.evaluate(() => ({
  queued: window.__game.state.dragonSpawnQueue.length,
  dragons: window.__game.state.dragons.size,
  blood: window.__game.state.blood,
}));
check('Autodragon queues a ritual and pays blood',
  (afterDragon.queued >= 1 || afterDragon.dragons > 0) && afterDragon.blood < dragonStart.blood,
  JSON.stringify({ ...afterDragon, before: dragonStart.blood }));
await page.evaluate(() => { window.__game.state.autoDragonEnabled = false; });

// ── 7) Quick travel — the strip is now legitimately visible ──
await page.waitForFunction(
  () => !document.body.classList.contains('unlock-reveal-hold'), { timeout: 30000 });
await page.evaluate(() => {
  const { state } = window.__game;
  state.hellUnlocked = true;
  state.spaceUnlocked = true;
});
await sleep(300);
await page.click('#qt-hell');
await sleep(600);
const inHell = await page.evaluate(() => ({
  view: window.__game.state.view,
  depth: window.__game.ctx.depth,
  zoom: window.__game.ctx.hellZoom,
}));
check('quick travel → hell snaps view/depth/zoom',
  inHell.view === 'hell' && inHell.depth === 1 && inHell.zoom === 1, JSON.stringify(inHell));
await page.screenshot({ path: 'screenshots/quick-travel-hell.png' });
await page.click('#qt-ground');
await sleep(600);
const onGround = await page.evaluate(() => ({
  view: window.__game.state.view, depth: window.__game.ctx.depth, alt: window.__game.ctx.altitude,
}));
check('quick travel → earth returns clean',
  onGround.view === 'ground' && onGround.depth === 0 && onGround.alt === 0, JSON.stringify(onGround));
await page.click('#qt-space');
await sleep(600);
const inSpace = await page.evaluate(() => ({
  view: window.__game.state.view, alt: window.__game.ctx.altitude,
}));
check('quick travel → space climbs instantly',
  inSpace.view === 'space' && inSpace.alt === 1, JSON.stringify(inSpace));
await page.screenshot({ path: 'screenshots/quick-travel-space.png' });

await browser.close();
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
