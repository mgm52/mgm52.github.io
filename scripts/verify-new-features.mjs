// Drives the new demon-roster / dragon-snatch / robot / orbital-platform
// features end to end via window.__game (dev only).
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
page.on('dialog', async (d) => d.accept());

await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
await page.waitForFunction(() => !!window.__game?.state, { timeout: 15000 });
await page.evaluate(() => {
  document.body.classList.remove('intro-hold', 'intro-cutscene-hold', 'bob-cutscene-hold');
  window.__game.state.bobPickingHole = false;
  // Stripping the classes isn't enough: the intro sequence is still running
  // in the background and re-freezes the tick loop (intro-cutscene-hold)
  // when its goblin turns to face the player. Skip it outright.
  window.__game.skipIntro();
});

// ── 1) Demon roster: three demons, standing, facings/scales/positions ──
const roster = await page.evaluate(async () => {
  const { state } = window.__game;
  const byVariant = {};
  for (const d of state.demons.values()) byVariant[d.variant ?? 'pit'] = d;
  const r = byVariant.pit, l = byVariant.l, f = byVariant.friend;
  const y0 = r ? r.hy : 0;
  await new Promise((res) => setTimeout(res, 800));
  return {
    count: state.demons.size,
    variants: Object.keys(byVariant).sort(),
    rStandsStill: r ? Math.abs(r.hy - y0) < 0.01 : false,
    rFacing: r?.facing, rScale: r?.scale,
    lFacing: l?.facing, lScale: l?.scale, lHx: l?.hx, rHx: r?.hx,
    fPos: f ? { x: f.hx, y: f.hy } : null,
  };
});
check('three demons', roster.count === 3, JSON.stringify(roster.variants));
check('demon R stands still', roster.rStandsStill);
check('demon R faces left', Math.abs(roster.rFacing - Math.PI) < 0.01, `facing=${roster.rFacing}`);
check('demon L faces right, half size', roster.lFacing === 0 && roster.lScale === 0.5);
check('demon L on the other side', roster.lHx < 1200 && roster.rHx > 1200, `l=${roster.lHx} r=${roster.rHx}`);
check('friend in corner', roster.fPos && roster.fPos.x < 500 && roster.fPos.y < 600, JSON.stringify(roster.fPos));

// Shared dialogue helpers.
const ov = () => page.evaluate(() => {
  const o = document.getElementById('demon-overlay');
  return {
    open: o.classList.contains('visible'),
    armed: o.classList.contains('click-armed'),
    choice: o.classList.contains('show-buttons'),
    line: document.getElementById('demon-line').textContent,
    speech: document.getElementById('demon-speech').className,
  };
});
const drive = async ({ stopAtChoice = false, max = 250, capture = null } = {}) => {
  for (let i = 0; i < max; i++) {
    const s = await ov();
    if (capture && s.open && s.line) capture.add(`${s.speech}|${s.line}`);
    if (!s.open) return { closed: true };
    if (stopAtChoice && s.choice) return { choice: true };
    if (s.armed) { await page.click('#demon-clickwall'); await sleep(120); }
    else await sleep(120);
  }
  return { timedOut: true };
};
const sendSoul = (variant, opts = {}) => page.evaluate(({ variant, opts }) => {
  const { state } = window.__game;
  const d = [...state.demons.values()].find((x) => (x.variant ?? 'pit') === variant);
  const id = state.nextId++;
  state.ghosts.push({
    id, kind: 'goblin', x: 0, y: 0, facing: 0, spawnAt: state.now,
    hx: d.hx, hy: d.hy - 60, selected: false, parlayDemonId: d.id, speedMult: 0,
    ...opts,
  });
}, { variant, opts });
const waitOverlay = () => page.waitForFunction(
  () => document.getElementById('demon-overlay').classList.contains('visible'), { timeout: 6000 });
const waitClosed = () => page.waitForFunction(
  () => !document.getElementById('demon-overlay').classList.contains('visible'), { timeout: 8000 });

// ── 2) Demon R: plain goblin parlay — demon lines in ALL CAPS ──
await sendSoul('pit');
await waitOverlay();
const rLines = new Set();
await drive({ capture: rLines });
const rDemonLines = [...rLines].filter((l) => l.startsWith('demon|')).map((l) => l.slice(6));
const rHasCaps = rDemonLines.some((l) => /[A-Z]{3,}/.test(l)) && rDemonLines.every((l) => l === l.toUpperCase());
check('demon R speaks ALL CAPS', rHasCaps, JSON.stringify(rDemonLines));

// ── 3) Demon L with Bob: gnilrad opener + time quiz (3 options incl. real time) ──
await sendSoul('l', { bob: true });
await waitOverlay();
const lLines = new Set();
const lRes = await drive({ stopAtChoice: true, capture: lLines });
check('demon L reaches the time quiz', !!lRes.choice);
const sawGnilrad = [...lLines].some((l) => l.includes('gnilrad'));
check('demon L opens with gnilrad', sawGnilrad, JSON.stringify([...lLines]));
const quiz = await page.evaluate(() => {
  const labels = [...document.querySelectorAll('#demon-buttons .build-button')]
    .filter((b) => b.style.display !== 'none')
    .map((b) => ({ id: b.id, label: b.querySelector('.build-name').textContent }));
  const now = new Date();
  let h = now.getHours() % 12; if (h === 0) h = 12;
  const actual = `${h}:${String(now.getMinutes()).padStart(2, '0')} ${now.getHours() < 12 ? 'am' : 'pm'}`;
  return { labels, actual };
});
check('time quiz shows 3 options', quiz.labels.length === 3, JSON.stringify(quiz));
const correctBtn = quiz.labels.find((l) => l.label === quiz.actual);
check('one option is the real time', !!correctBtn, `actual=${quiz.actual}`);
await page.screenshot({ path: 'screenshots/new-1-time-quiz.png' });

// Answer correctly → friend question. Lie (YES, friend not greeted) → punished.
const bobsBefore = await page.evaluate(() => ({
  ghosts: window.__game.state.ghosts.filter((g) => g.bob).length,
  live: [...window.__game.state.goblins.values()].filter((g) => g.bob).length,
}));
await page.click(`#${correctBtn.id}`);
const friendQ = await drive({ stopAtChoice: true, capture: lLines });
check('correct time leads to friend question', !!friendQ.choice,
  [...lLines].slice(-3).join(' / '));
const sawFriendQ = [...lLines].some((l) => l.includes('dneirf'));
check('friend question is backwards', sawFriendQ);
await page.click('#demon-yes'); // lie — friend never visited
await drive();
await waitClosed();
await sleep(600);
const bobsAfter = await page.evaluate(() => ({
  ghosts: window.__game.state.ghosts.filter((g) => g.bob).length,
  live: [...window.__game.state.goblins.values()].filter((g) => g.bob).length,
}));
check('lying about friend punishes (ghost struck back, Bob resurrected)',
  bobsAfter.ghosts === bobsBefore.ghosts - 1 && bobsAfter.live === bobsBefore.live + 1,
  JSON.stringify({ bobsBefore, bobsAfter }));

// ── 4) Visit the friend, then answer truthfully → reward ──
// Her Bob parlay has two choice points (I DO / I DON'T, then ". . ." twice);
// both answers are equivalent, so just click the first button through each.
await sendSoul('friend', { bob: true });
await waitOverlay();
const fLines = new Set();
let fRes = await drive({ stopAtChoice: true, capture: fLines });
while (fRes.choice) {
  await page.click('#demon-yes');
  fRes = await drive({ stopAtChoice: true, capture: fLines });
}
const friendGreeted = await page.evaluate(() =>
  [...window.__game.state.demons.values()].find((d) => d.variant === 'friend').greeted);
check('friend marks greeted after visit', friendGreeted, [...fLines].join(' / '));
check('friend talks of golf (plain speech)', [...fLines].some((l) => l.includes('talked of golf')),
  [...fLines].join(' / '));

// She only says her piece once — a repeat caller just gets "go quietly".
await sendSoul('friend', { bob: true });
await waitOverlay();
const f2Lines = new Set();
await drive({ capture: f2Lines });
check('repeat friend visit gets "go quietly"',
  [...f2Lines].some((l) => l.includes('go quietly')) && ![...f2Lines].some((l) => l.includes('golf')),
  [...f2Lines].join(' / '));

await sendSoul('l', { bob: true });
await waitOverlay();
const l2 = await drive({ stopAtChoice: true });
const quiz2 = await page.evaluate(() => {
  const labels = [...document.querySelectorAll('#demon-buttons .build-button')]
    .filter((b) => b.style.display !== 'none')
    .map((b) => ({ id: b.id, label: b.querySelector('.build-name').textContent }));
  const now = new Date();
  let h = now.getHours() % 12; if (h === 0) h = 12;
  const actual = `${h}:${String(now.getMinutes()).padStart(2, '0')} ${now.getHours() < 12 ? 'am' : 'pm'}`;
  return { btn: labels.find((l) => l.label === actual) };
});
const bloodBefore = await page.evaluate(() => window.__game.state.blood);
if (l2.choice && quiz2.btn) {
  await page.click(`#${quiz2.btn.id}`);
  const fq = await drive({ stopAtChoice: true });
  if (fq.choice) await page.click('#demon-yes'); // truth this time
  await drive();
}
await sleep(400);
const bloodAfter = await page.evaluate(() => window.__game.state.blood);
check('truthful friend answer pays 4,999 blood', bloodAfter - bloodBefore === 4999,
  `Δblood=${bloodAfter - bloodBefore}`);

// ── 5) Dragon snatch: goblin to space, dies after ~5s with rewards ──
const snatch = await page.evaluate(() => {
  const { state, spawnDragon } = window.__game;
  state.view = 'ground';
  // A goblin somewhere walkable.
  const gid = [...state.goblins.values()][0]?.id;
  spawnDragon(state);
  const d = [...state.dragons.values()].at(-1);
  d.state = { kind: 'going_to_unit', targetKind: 'goblin', targetId: gid };
  return { gid, did: d.id };
});
// No goblins exist on a fresh dev boot — spawn one first if needed.
const hadGoblin = await page.evaluate(() => window.__game.state.goblins.size > 0);
if (!snatch.gid) {
  await page.evaluate(() => {
    const { state } = window.__game;
    state.spawnQueue.push({ remaining: 0.01, slot: 0 });
  });
  await sleep(500);
  await page.evaluate(({ did }) => {
    const { state } = window.__game;
    const gid = [...state.goblins.values()][0].id;
    const d = state.dragons.get(did);
    d.state = { kind: 'going_to_unit', targetKind: 'goblin', targetId: gid };
  }, snatch);
}
await page.waitForFunction(() => window.__game.state.spaceUnits.size > 0, { timeout: 30000 });
const su1 = await page.evaluate(() => {
  const { state } = window.__game;
  const su = [...state.spaceUnits.values()][0];
  return { kind: su.kind, robot: !!su.robot, diesAt: su.diesAt, now: state.now, money: state.money };
});
check('snatched goblin reaches space with a 5s clock', su1.kind === 'goblin' && !su1.robot
  && su1.diesAt !== undefined && Math.abs(su1.diesAt - su1.now - 5) < 0.6, JSON.stringify(su1));
await page.waitForFunction(() => window.__game.state.spaceUnits.size === 0, { timeout: 12000 });
const afterPerish = await page.evaluate(() => ({
  money: window.__game.state.money,
  log: window.__game.state.log.at(-1)?.msg,
}));
check('unit perishes in the vacuum (with reward)', afterPerish.money > su1.money,
  afterPerish.log);

// ── 6) Robot: summon, unkillable, survives space, builds the platform ──
const robot = await page.evaluate(() => {
  const { state, spawnRobot } = window.__game;
  state.money = 10_000_000;
  spawnRobot(state);
  const r = [...state.goblins.values()].find((g) => g.robot);
  return r ? { id: r.id } : null;
});
check('robot spawns', !!robot);
const lightningSurvive = await page.evaluate(({ id }) => {
  const { state } = window.__game;
  state.blood = 1000;
  const r = state.goblins.get(id);
  // strike directly on the robot
  return import('/src/sim.ts').then((sim) => {
    sim.lightningStrike(state, r.pos.x, r.pos.y);
    return state.goblins.has(id);
  });
}, robot);
check('robot survives a lightning strike', lightningSurvive);

// Snatch the robot to space; it must NOT die, and must build the platform.
await page.evaluate(({ id }) => {
  const { state, spawnDragon } = window.__game;
  spawnDragon(state);
  const d = [...state.dragons.values()].at(-1);
  d.state = { kind: 'going_to_unit', targetKind: 'goblin', targetId: id };
}, robot);
await page.waitForFunction(() => window.__game.state.spaceUnits.size > 0, { timeout: 30000 });
const su2 = await page.evaluate(() => {
  const su = [...window.__game.state.spaceUnits.values()][0];
  return { robot: !!su.robot, diesAt: su.diesAt };
});
check('robot reaches space with no death clock', su2.robot && su2.diesAt === undefined, JSON.stringify(su2));
await sleep(6500);
const robotStillThere = await page.evaluate(() => window.__game.state.spaceUnits.size === 1);
check('robot survives the vacuum (>6s)', robotStillThere);

// Deploy an orbital platform near the robot; the robot should assemble it.
await page.evaluate(() => {
  const { state } = window.__game;
  const su = [...state.spaceUnits.values()][0];
  const b = {
    id: state.nextId++,
    displayNum: 1,
    kind: 'orbital_platform',
    cell: { cx: 0, cy: 0 },
    state: 'constructing',
    buildProgress: 0,
    assignedGoblins: [],
    selected: false,
  };
  state.spaceBuildings.set(b.id, {
    id: b.id, building: b,
    pos: { x: Math.min(1700, su.pos.x + 300), y: su.pos.y },
    vel: { x: 0, y: 0 }, spin: 0, spinRate: 0, selected: false,
  });
});
await page.waitForFunction(() => {
  for (const sb of window.__game.state.spaceBuildings.values()) {
    if (sb.building.kind === 'orbital_platform' && sb.building.state === 'active') return true;
  }
  return false;
}, { timeout: 60000 });
check('robot assembles the orbital platform', true);

// Screenshot the space scene with robot + platform.
await page.evaluate(() => {
  const { state, ctx } = window.__game;
  state.view = 'space';
  ctx.altitude = 1;
  const sb = [...state.spaceBuildings.values()].find((s) => s.building.kind === 'orbital_platform');
  ctx.spaceCamera.x = sb.pos.x - ctx.viewport.width / (2 * ctx.renderScale);
  ctx.spaceCamera.y = sb.pos.y - ctx.viewport.height / (2 * ctx.renderScale);
});
await sleep(600);
await page.screenshot({ path: 'screenshots/new-2-orbital-platform.png' });

// ── 7) UI: robot summon + orbital buttons exist; warning text correct ──
const uiBits = await page.evaluate(() => {
  const robotBtn = document.getElementById('btn-summon-robot');
  const warn = document.getElementById('warn-summon-robot');
  const orbitalBtn = document.getElementById('btn-place-orbital');
  return {
    robotBtnExists: !!robotBtn,
    warnText: warn?.textContent,
    orbitalExists: !!orbitalBtn,
    orbitalVisibleInSpace: orbitalBtn && orbitalBtn.style.display !== 'none',
  };
});
// The banner renders ROBOT.hypercentresRequired — don't pin the number here.
check('robot button + "needs N hypercentres" banner', uiBits.robotBtnExists && /^needs \d+ hypercentres$/.test(uiBits.warnText ?? ''), JSON.stringify(uiBits));
check('orbital platform button shows in space view', uiBits.orbitalExists && uiBits.orbitalVisibleInSpace);

await browser.close();
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
