// Verifies that striking Lolly mid-rampage speeds her up instead of killing
// her: lightning → one blue surge + "speed up!" floater; a reactor meltdown's
// fallout → a bigger green surge + three floaters. Both raise her speed
// multiplier and tint her sprite.
import { chromium } from 'playwright';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
page.on('pageerror', (e) => { console.log('PAGE ERR:', e.message); failures++; });

await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
await page.waitForFunction(() => !!window.__game?.state, { timeout: 15000 });
// Freeze the live game loop (this hold class makes the frame loop skip ticks)
// so the only ticks are the ones we drive by hand — otherwise the loop wipes
// the map and starts the finale out from under the test.
await page.evaluate(() => { window.__game.skipIntro(); document.body.classList.add('bob-cutscene-hold'); });

// Loose Lolly on the overworld (leave the hole standing so the finale doesn't
// start), give blood for the strike, and park her at a known spot.
await page.evaluate(() => {
  const { state } = window.__game;
  state.blood = 99999;
  state.lolly = { pos: { x: 600, y: 600 }, facing: Math.PI / 2, target: null, nextWanderAt: 0, spawnAt: state.now };
});

const floaterCount = () => page.evaluate(() =>
  window.__game.state.floaters.filter((f) => f.text === 'speed up!').length);

// ── Lightning: a single blue surge ──
const before = await floaterCount();
const lit = await page.evaluate(async () => {
  const sim = await import('/src/sim.ts');
  const st = await import('/src/state.ts');
  const { state } = window.__game;
  sim.lightningStrike(state, state.lolly.pos.x, state.lolly.pos.y);
  const b = st.lollyBoostState(state.lolly, state.now);
  return {
    alive: !!state.lolly,
    boosts: state.lolly.boosts?.map((x) => x.kind) ?? [],
    speedMult: b.speedMult,
    tint: b.tint.toString(16),
  };
});
const litFloaters = await floaterCount();
check('lightning leaves Lolly alive (not vaporised)', lit.alive);
check('lightning adds one boost, kind=lightning', lit.boosts.length === 1 && lit.boosts[0] === 'lightning', JSON.stringify(lit.boosts));
check('lightning roughly doubles her speed', lit.speedMult > 1.8, `mult=${lit.speedMult.toFixed(2)}`);
check('lightning tints her blue', lit.tint === '66bbff', `#${lit.tint}`);
check('lightning throws one "speed up!" floater', litFloaters - before === 1, `Δ=${litFloaters - before}`);

// ── Meltdown fallout: a bigger green surge, three floaters ──
const beforeN = await floaterCount();
await page.evaluate(() => {
  const { state } = window.__game;
  // Start the wave a beat in the past so its front already covers her.
  state.meltdowns.push({ id: state.nextId++, x: state.lolly.pos.x, y: state.lolly.pos.y, startAt: state.now - 1, lastRadius: 0, killed: 0, dragonsKilled: 0 });
});
// A tick processes the meltdown front over her.
await page.evaluate(async () => { (await import('/src/sim.ts')).tick(window.__game.state); });
const nuke = await page.evaluate(async () => {
  const st = await import('/src/state.ts');
  const { state } = window.__game;
  const b = st.lollyBoostState(state.lolly, state.now);
  return {
    kinds: state.lolly.boosts?.map((x) => x.kind) ?? [],
    speedMult: b.speedMult,
    tint: b.tint.toString(16),
  };
});
const nukeFloaters = await floaterCount();
check('meltdown adds a nuclear boost (stacked on lightning)', nuke.kinds.includes('nuclear'), JSON.stringify(nuke.kinds));
check('meltdown surge is the bigger one (green dominates)', nuke.tint === '6cff6c', `#${nuke.tint}`);
check('stacked surge is fast (>2x)', nuke.speedMult > 2.5, `mult=${nuke.speedMult.toFixed(2)}`);
check('meltdown throws three "speed up!" floaters', nukeFloaters - beforeN === 3, `Δ=${nukeFloaters - beforeN}`);

// ── Decay: the boost fades toward nothing ──
const decayMult = await page.evaluate(async () => {
  const st = await import('/src/state.ts');
  const { state } = window.__game;
  // Look 11s into the future: the lightning boost (10s) is gone, the nuclear
  // (30s) has decayed substantially.
  return st.lollyBoostState(state.lolly, state.now + 11).speedMult;
});
check('boost decays over time', decayMult < nuke.speedMult, `${nuke.speedMult.toFixed(2)} → ${decayMult.toFixed(2)} (+11s)`);

await browser.close();
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
