// Drives the demon-parlay feature end to end via window.__game (dev only).
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync('screenshots', { recursive: true });

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('PAGE ERR:', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE ERR:', m.text()); });

// Auto-accept the two demo-end alerts (the demon's "gift").
const alerts = [];
page.on('dialog', async (d) => { alerts.push(d.message()); await d.accept(); });

await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
await page.waitForFunction(() => !!window.__game?.state, { timeout: 15000 });

// Skip the intro hold so the tick loop runs.
await page.evaluate(() => {
  document.body.classList.remove('intro-hold', 'intro-cutscene-hold', 'bob-cutscene-hold');
  const { state, ctx } = window.__game;
  state.bobPickingHole = false;
  state.view = 'hell';
  ctx.depth = 1;
  ctx.hellZoom = 1;
  const d = [...state.demons.values()][0];
  // Centre the hell camera on the demon so it's on-screen.
  const scale = 1.3 * 0.5;
  ctx.hellCamera.x = d.hx - ctx.viewport.width / (2 * scale);
  ctx.hellCamera.y = d.hy - ctx.viewport.height / (2 * scale);
});
await sleep(800);
await page.screenshot({ path: 'screenshots/demon-1-patrol.png' });

// 1) Demon exists and patrols (hy changes over time).
const patrol = await page.evaluate(async () => {
  const { state } = window.__game;
  const d = [...state.demons.values()][0];
  const y0 = d.hy;
  await new Promise((r) => setTimeout(r, 600));
  return { count: state.demons.size, moved: Math.abs(d.hy - y0) > 0.5, kind: d.kind };
});
console.log('PATROL:', JSON.stringify(patrol));

// 2) Select the demon → popup shows red "cannot command" text.
const popup = await page.evaluate(() => {
  const { state } = window.__game;
  const d = [...state.demons.values()][0];
  d.selected = true;
});
await sleep(200);
const popupText = await page.evaluate(() => {
  const extra = document.getElementById('info-extra');
  const name = document.getElementById('info-name');
  const vis = document.getElementById('info-panel').classList.contains('visible');
  return { visible: vis, name: name.textContent, extra: extra.textContent,
           extraColor: extra.firstElementChild?.getAttribute('style') };
});
console.log('POPUP:', JSON.stringify(popupText));
await page.screenshot({ path: 'screenshots/demon-2-popup.png' });

// 3) Regular goblin parlay: place a goblin ghost at the demon, expect the
//    greeting (first time) then gibberish then "i do not know this language".
await page.evaluate(() => {
  const { state } = window.__game;
  const d = [...state.demons.values()][0];
  d.selected = false;
  const id = state.nextId++;
  state.ghosts.push({
    id, kind: 'goblin', x: 0, y: 0, facing: 0, spawnAt: state.now,
    hx: d.hx, hy: d.hy - 100, selected: false, parlayDemonId: d.id,
  });
});
// Wait for the sim to detect arrival + main to open the overlay.
await page.waitForFunction(() => document.getElementById('demon-overlay').classList.contains('visible'), { timeout: 4000 });
await sleep(700); // let the first line type
const firstLine = await page.evaluate(() => ({
  speaker: document.getElementById('demon-speaker').textContent,
  line: document.getElementById('demon-line').textContent,
  speechClass: document.getElementById('demon-speech').className,
}));
console.log('GOBLIN LINE 1:', JSON.stringify(firstLine));
await page.screenshot({ path: 'screenshots/demon-3-goblin-greet.png' });

const ov = () => page.evaluate(() => {
  const o = document.getElementById('demon-overlay');
  return {
    open: o.classList.contains('visible'),
    armed: o.classList.contains('click-armed'),
    choice: o.classList.contains('show-buttons'),
    line: document.getElementById('demon-line').textContent,
  };
});
// Advance through lines until the overlay closes (returns true) or a YES/NO
// choice appears (returns 'choice'). Generous iteration budget so multi-second
// typed lines have time to finish.
const drive = async ({ stopAtChoice = false, max = 200 } = {}) => {
  let clicks = 0;
  for (let i = 0; i < max; i++) {
    const s = await ov();
    if (!s.open) return { closed: true, clicks };
    if (stopAtChoice && s.choice) return { choice: true, clicks };
    if (s.armed) { await page.click('#demon-clickwall'); clicks++; await sleep(120); }
    else await sleep(120);
  }
  return { timedOut: true, clicks };
};
const goblinRes = await drive();
console.log('GOBLIN dialogue result:', JSON.stringify(goblinRes));
const greetedAfter = await page.evaluate(() => [...window.__game.state.demons.values()][0].greeted);
console.log('demon.greeted after goblin parlay:', greetedAfter);

// 4) Bob parlay — truthful path. slewTwoDragonsInOneStrike = true → gift + alerts.
await page.evaluate(() => {
  const { state } = window.__game;
  const d = [...state.demons.values()][0];
  state.slewTwoDragonsInOneStrike = true;
  state.optionsUnlocked = false;
  const id = state.nextId++;
  state.ghosts.push({
    id, kind: 'goblin', bob: true, x: 0, y: 0, facing: 0, spawnAt: state.now,
    hx: d.hx, hy: d.hy - 100, selected: false, parlayDemonId: d.id, speedMult: 0,
  });
});
await page.waitForFunction(() => document.getElementById('demon-overlay').classList.contains('visible'), { timeout: 4000 });
await sleep(600);
// Greeting should be SKIPPED this time (demon already greeted). First line = Bob.
const bobFirst = await page.evaluate(() => ({
  speaker: document.getElementById('demon-speaker').textContent,
  line: document.getElementById('demon-line').textContent,
}));
console.log('BOB LINE 1 (greeting should be skipped → Bob):', JSON.stringify(bobFirst));

// Advance until the YES/NO choice appears, then click YES.
const bobChoice = await drive({ stopAtChoice: true });
console.log('BOB saw YES/NO choice:', JSON.stringify(bobChoice));
if (bobChoice.choice) {
  await page.screenshot({ path: 'screenshots/demon-4-bob-question.png' });
  await page.click('#demon-yes');
  await sleep(300);
}
// Click through the gift lines (auto-advancing "…" beats + the rest).
await drive();
await sleep(400);
const unlocked = await page.evaluate(() => window.__game.state.optionsUnlocked);
console.log('optionsUnlocked after truthful Bob:', unlocked);
console.log('ALERTS fired:', JSON.stringify(alerts));

// 5) Bob parlay — lying path. slew=false, YES → struck back to overworld.
await page.evaluate(() => {
  const { state } = window.__game;
  const d = [...state.demons.values()][0];
  state.slewTwoDragonsInOneStrike = false;
  const id = state.nextId++;
  state.ghosts.push({
    id, kind: 'goblin', bob: true, x: 100, y: 100, facing: 0, spawnAt: state.now,
    hx: d.hx, hy: d.hy - 100, selected: false, parlayDemonId: d.id, speedMult: 0,
  });
});
const bobBefore = await page.evaluate(() => ({
  ghostBobs: window.__game.state.ghosts.filter((g) => g.bob).length,
  liveBobs: [...window.__game.state.goblins.values()].filter((g) => g.bob).length,
}));
await page.waitForFunction(() => document.getElementById('demon-overlay').classList.contains('visible'), { timeout: 4000 });
const lieChoice = await drive({ stopAtChoice: true });
if (lieChoice.choice) { await page.click('#demon-yes'); await sleep(250); } // lie
await drive();
await sleep(500);
const bobAfter = await page.evaluate(() => ({
  ghostBobs: window.__game.state.ghosts.filter((g) => g.bob).length,
  liveBobs: [...window.__game.state.goblins.values()].filter((g) => g.bob).length,
}));
console.log('lying-bob before:', JSON.stringify(bobBefore), 'after:', JSON.stringify(bobAfter));
await browser.close();
console.log('DONE');
