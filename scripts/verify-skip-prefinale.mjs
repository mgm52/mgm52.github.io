// Verifies the "skip to pre-finale state" cheat: every task done, two crewed
// Space Centres running in orbit, the Terminator button armed, and spawning
// still possible (a fresh hole survives the prevent-spawning wall-off).
import { chromium } from 'playwright';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => { console.log('PAGE ERR:', e.message); failures++; });

await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
await page.waitForFunction(() => !!window.__game?.state, { timeout: 15000 });
await page.evaluate(() => { document.body.classList.remove('intro-cutscene-hold', 'bob-cutscene-hold'); window.__game.skipIntro(); });

// Fire the skip exactly the way the button does.
await page.evaluate(async () => {
  const ui = await import('/src/ui.ts');
  ui.executeSkipToPreFinale(window.__game.state);
});

// Give the sim a couple seconds of ticks so robots settle, power resolves and
// any dormant centres flip active.
await sleep(2500);

const s = await page.evaluate(() => {
  const { state } = window.__game;
  let reactors = 0, centres = 0, activeCentres = 0, hyper = 0, beacons = 0;
  let spaceHyper = 0, activeSpaceHyper = 0;
  for (const b of state.buildings.values()) {
    if (b.kind === 'nuclear_reactor' && b.state !== 'constructing') reactors++;
    if (b.kind === 'hypercentre' && b.state === 'active') hyper++;
    if (b.kind === 'dragon_beacon' && b.state !== 'constructing') beacons++;
  }
  for (const sb of state.spaceBuildings.values()) {
    if (sb.building.kind === 'space_centre') {
      centres++;
      if (sb.building.state === 'active') activeCentres++;
    }
    if (sb.building.kind === 'hypercentre') {
      spaceHyper++;
      if (sb.building.state === 'active') activeSpaceHyper++;
    }
  }
  const robots = [...state.spaceUnits.values()].filter((u) => u.robot).length;
  const groundRobots = [...state.goblins.values()].filter((g) => g.robot).length;
  return {
    money: state.money,
    blood: state.blood,
    dragonBone: state.dragonBone,
    reactors, centres, activeCentres, hyper, beacons, robots, groundRobots,
    spaceHyper, activeSpaceHyper,
    lillyTasksGiven: state.lillyTasksGiven,
    robotsDestroyed: state.robotsDestroyed,
    spaceUnlocked: state.spaceUnlocked,
    hellUnlocked: state.hellUnlocked,
    powerProduced: state.lastPowerProduced,
    powerConsumed: state.lastPowerConsumed,
    spawnBlocked: (() => {
      // mirror goblinSpawningBlocked roughly via the exposed anySpawnHole proxy
      return null;
    })(),
  };
});
console.log('state:', JSON.stringify(s, null, 2));

check('two Space Centres exist', s.centres === 2, `centres=${s.centres}`);
check('both Space Centres are active', s.activeCentres === 2, `active=${s.activeCentres}`);
check('a few Hypercentres in orbit', s.spaceHyper >= 3, `spaceHyper=${s.spaceHyper}`);
check('orbital Hypercentres are powered/active', s.activeSpaceHyper === s.spaceHyper, `active=${s.activeSpaceHyper}/${s.spaceHyper}`);
check('robots adrift in space (crew + spares)', s.robots >= 2 + 4, `robots=${s.robots}`);
check('robots on the ground', s.groundRobots >= 4, `groundRobots=${s.groundRobots}`);
check('100 dragon bones for the Gabbonsaw ritual', s.dragonBone >= 100, `bones=${s.dragonBone}`);
check('grid produces more than it consumes', s.powerProduced > s.powerConsumed,
  `prod=${s.powerProduced} cons=${s.powerConsumed}`);
check('Lilly optional Work granted', s.lillyTasksGiven === true);
check('robot-destroyed optional task satisfied', s.robotsDestroyed > 0, `n=${s.robotsDestroyed}`);
check('blood at the 9,999,999 close-out', s.blood >= 9_999_999, `blood=${s.blood}`);
check('war chest for terminators', s.money >= 2_500_000, `money=${s.money}`);
check('space + hell unlocked', s.spaceUnlocked && s.hellUnlocked);

// The Terminator button should be visible AND enabled now. refreshUI repaints
// on a throttle, so poll for the reveal rather than sampling a single frame.
let term = { exists: false, visible: false, disabled: true };
const t0btn = Date.now();
while (Date.now() - t0btn < 5000) {
  term = await page.evaluate(() => {
    const b = document.getElementById('btn-summon-terminator');
    if (!b) return { exists: false, visible: false, disabled: true };
    const cs = getComputedStyle(b);
    return { exists: true, visible: cs.display !== 'none', disabled: b.disabled };
  });
  if (term.exists && term.visible && !term.disabled) break;
  await sleep(150);
}
check('Terminator button visible', term.exists && term.visible, JSON.stringify(term));
check('Terminator button enabled (gate met)', term.exists && !term.disabled, JSON.stringify(term));

// The pre-finale state must contain NO placed walls, and spawning must still
// work (the original hole is never walled, so a terminator can hatch from it).
const spawned = await page.evaluate(() => {
  const { state, spawnRobot } = window.__game;
  const walls = [...state.buildings.values()].filter((b) => b.kind === 'wall').length;
  const ok = spawnRobot(state, true); // spawnRobot(state, terminator=true)
  return { ok, walls };
});
check('no placed walls in the pre-finale state', spawned.walls === 0, JSON.stringify(spawned));
check('a terminator can hatch from the unwalled hole', spawned.ok === true, JSON.stringify(spawned));

await browser.close();
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
