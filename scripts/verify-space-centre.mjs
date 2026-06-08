// Drives the Space Centre feature end to end via window.__game (dev only):
// sizes, void-tap refusal ("no platform" floater), platform-snap placement,
// robot assembly, the 10 GW power link, and income while powered.
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

// ── 1) Defs: sizes + costs ──
const defs = await page.evaluate(() => import('/src/config.ts').then((c) => ({
  hc: c.BUILDING_DEFS.hypercentre.cellSize,
  op: c.BUILDING_DEFS.orbital_platform.cellSize,
  sc: c.BUILDING_DEFS.space_centre.cellSize,
  power: c.BUILDING_DEFS.space_centre.powerOutput,
  cost: c.BUILDING_DEFS.space_centre.cost,
  income: c.BUILDING_DEFS.space_centre.income,
})));
check('Space Centre bigger than Hypercentre', defs.sc > defs.hc, JSON.stringify(defs));
check('Orbital Platform same size as Space Centre', defs.op === defs.sc);
check('Space Centre draws 10 GW', defs.power === -10_000_000_000);
check('Space Centre costs money and earns a lot', defs.cost > 0 && defs.income >= 100_000);

// Enter the space view directly and give the player money.
await page.evaluate(() => {
  const { state, ctx } = window.__game;
  state.view = 'space';
  state.spaceUnlocked = true;
  ctx.altitude = 1;
  state.money = 100_000_000;
});
await sleep(400);

const btnVisible = await page.evaluate(() => {
  const b = document.getElementById('btn-place-space-centre');
  return b && b.style.display !== 'none' && !b.disabled;
});
check('Space Centre button shown + enabled in space view', btnVisible);

// Screen coords of a SPACE-scene point (canvas-relative → page coords).
const screenAt = (x, y) => page.evaluate(({ x, y }) => {
  const { ctx } = window.__game;
  const g = ctx.spaceLayer.toGlobal({ x, y });
  const r = document.querySelector('canvas').getBoundingClientRect();
  return { x: r.left + g.x, y: r.top + g.y };
}, { x, y });

// ── 2) Armed tap on bare void → red "no platform" floater, no spend ──
await page.click('#btn-place-space-centre');
const armed = await page.evaluate(() => window.__game.state.pendingSpaceCentre);
check('button arms placement mode', armed);
const voidPt = await page.evaluate(() => {
  const { ctx } = window.__game;
  // Center of the current space viewport — guaranteed bare void on a fresh run.
  return {
    x: ctx.spaceCamera.x + ctx.viewport.width / (2 * ctx.renderScale),
    y: ctx.spaceCamera.y + ctx.viewport.height / (2 * ctx.renderScale),
  };
});
const p1 = await screenAt(voidPt.x, voidPt.y);
await page.mouse.click(p1.x, p1.y);
await sleep(200);
const refusal = await page.evaluate(() => ({
  floater: window.__game.state.floaters.some((f) => f.text === 'no platform' && f.space),
  centres: [...window.__game.state.spaceBuildings.values()].filter((sb) => sb.building.kind === 'space_centre').length,
  money: window.__game.state.money,
  stillArmed: window.__game.state.pendingSpaceCentre,
}));
check('void tap refuses with red "no platform" floater', refusal.floater, JSON.stringify(refusal));
check('no Centre placed / no money spent on refusal', refusal.centres === 0 && refusal.money === 100_000_000);
check('placement stays armed after refusal', refusal.stillArmed);
await page.screenshot({ path: 'screenshots/sc-1-no-platform.png' });

// ── 3) Tap on a completed platform → Centre snaps onto it, money spent ──
const platPos = await page.evaluate(({ voidPt }) => {
  const { state } = window.__game;
  const b = {
    id: state.nextId++, displayNum: 1, kind: 'orbital_platform',
    cell: { cx: 0, cy: 0 }, state: 'active', buildProgress: 1,
    assignedGoblins: [], selected: false,
  };
  state.spaceBuildings.set(b.id, {
    id: b.id, building: b,
    pos: { x: voidPt.x, y: voidPt.y },
    vel: { x: 0, y: 0 }, spin: 0, spinRate: 0, selected: false,
  });
  return { id: b.id, x: voidPt.x, y: voidPt.y };
}, { voidPt });
// Tap off-center but still on the deck — the Centre must snap to its center.
const p2 = await screenAt(platPos.x + 70, platPos.y - 50);
await page.mouse.click(p2.x, p2.y);
await sleep(200);
const placed = await page.evaluate(({ platId }) => {
  const { state } = window.__game;
  const sc = [...state.spaceBuildings.values()].find((sb) => sb.building.kind === 'space_centre');
  return sc && {
    state: sc.building.state, pos: sc.pos, platformId: sc.platformId,
    money: state.money, disarmed: !state.pendingSpaceCentre,
    platPos: state.spaceBuildings.get(platId).pos,
  };
}, { platId: platPos.id });
check('platform tap places a constructing Centre', !!placed && placed.state === 'constructing', JSON.stringify(placed));
check('Centre snaps flush onto the platform', placed && placed.pos.x === placed.platPos.x && placed.pos.y === placed.platPos.y);
check('Centre records its host platform', placed && placed.platformId === platPos.id);
check('cost deducted, placement disarmed', placed && placed.money === 100_000_000 - 25_000_000 && placed.disarmed);

// One Centre per platform: re-arm and tap the same platform again → refusal.
await page.click('#btn-place-space-centre');
await page.mouse.click(p2.x, p2.y);
await sleep(200);
const second = await page.evaluate(() => ({
  centres: [...window.__game.state.spaceBuildings.values()].filter((sb) => sb.building.kind === 'space_centre').length,
  floaters: window.__game.state.floaters.filter((f) => f.text === 'no platform').length,
}));
check('occupied platform refuses a second Centre', second.centres === 1 && second.floaters >= 1, JSON.stringify(second));
await page.keyboard.press('Escape'); // disarm

// ── 4) Robot assembles it ──
await page.evaluate(({ platPos }) => {
  const { state } = window.__game;
  state.spaceUnits.set(state.nextId++, {
    id: state.nextId - 1, kind: 'goblin', robot: true,
    pos: { x: platPos.x + 400, y: platPos.y }, vel: { x: 0, y: 0 },
    facing: 0, spin: 0, spinRate: 0, selected: false,
  });
}, { platPos });
await page.waitForFunction(() => {
  for (const sb of window.__game.state.spaceBuildings.values()) {
    if (sb.building.kind === 'space_centre' && sb.building.state !== 'constructing') return true;
  }
  return false;
}, undefined, { timeout: 90000 });
const built = await page.evaluate(() => {
  const sc = [...window.__game.state.spaceBuildings.values()].find((sb) => sb.building.kind === 'space_centre');
  return { state: sc.building.state, log: window.__game.state.log.at(-1)?.msg };
});
check('robot assembles the Centre (finishes dormant, no grid power yet)', built.state === 'dormant', JSON.stringify(built));

// ── 5) 10 GW link: powered → active + earning; unpowered → dormant ──
const moneyBefore = await page.evaluate(() => {
  const { state } = window.__game;
  // A long flat-ish 30 GW surge comfortably covers the Centre's 10 GW draw.
  state.powerBoosts.push({ startAt: state.now, peak: 30_000_000_000, duration: 60 });
  return state.money;
});
await page.waitForFunction(() => {
  const sc = [...window.__game.state.spaceBuildings.values()].find((sb) => sb.building.kind === 'space_centre');
  return sc.building.state === 'active';
}, undefined, { timeout: 10000 });
check('Centre goes active once the grid can spare 10 GW', true);
await sleep(2500);
const moneyAfter = await page.evaluate(() => window.__game.state.money);
check('active Centre earns Ƶ500,000/s', moneyAfter >= moneyBefore + 1_000_000, `Δ=${moneyAfter - moneyBefore}`);
await page.screenshot({ path: 'screenshots/sc-2-active-centre.png' });

await page.evaluate(() => { window.__game.state.powerBoosts.length = 0; });
await page.waitForFunction(() => {
  const sc = [...window.__game.state.spaceBuildings.values()].find((sb) => sb.building.kind === 'space_centre');
  return sc.building.state === 'dormant';
}, undefined, { timeout: 10000 });
check('Centre goes dormant when the 10 GW link is severed', true);

await browser.close();
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
