// Verifies the finale dev settings: the trigger-now and skip-to-confrontation
// cheats, and the speed multiplier actually pacing the cinematic.
import { chromium } from 'playwright';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => { console.log('PAGE ERR:', e.message); failures++; });

await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
await page.waitForFunction(() => !!window.__game?.state, { timeout: 15000 });
await page.evaluate(() => { document.body.classList.remove('intro-cutscene-hold', 'bob-cutscene-hold'); window.__game.skipIntro(); });

// ── 1) devTriggerFinale starts the cinematic from scratch ──
await page.evaluate(async () => {
  const sim = await import('/src/sim.ts');
  sim.devTriggerFinale(window.__game.state);
});
const afterTrigger = await page.evaluate(() => ({
  phase: window.__game.state.finale?.phase,
  spaceUnlocked: window.__game.state.spaceUnlocked,
  lolly: !!window.__game.state.lolly,
}));
check('trigger-finale starts at summon', afterTrigger.phase === 'summon', JSON.stringify(afterTrigger));
check('trigger-finale unlocks space (player can follow)', afterTrigger.spaceUnlocked === true);

// ── 2) speed multiplier paces the cinematic (6x → past summon fast) ──
await page.evaluate(async () => {
  const opt = await import('/src/options.ts');
  opt.setOption('finaleSpeedMult', 6);
});
await sleep(2500);
const fast = await page.evaluate(() => window.__game.state.finale?.phase);
check('6x speed advances well past summon in ~2.5s', fast !== 'summon' && fast !== undefined, `phase=${fast}`);

// ── 3) skip-to-confrontation lands at the modal quickly ──
await page.evaluate(async () => {
  const opt = await import('/src/options.ts');
  opt.setOption('finaleSpeedMult', 1);
  const sim = await import('/src/sim.ts');
  sim.devSkipFinaleToConfront(window.__game.state);
});
// Within a couple seconds she should land and the confrontation modal open.
let confrontSeen = false;
const t0 = Date.now();
while (Date.now() - t0 < 8000) {
  const s = await page.evaluate(() => {
    const o = document.getElementById('demon-overlay');
    return {
      phase: window.__game.state.finale?.phase,
      modal: !!o && o.classList.contains('visible') && !o.classList.contains('rebuke'),
      armed: !!o && o.classList.contains('click-armed'),
    };
  });
  if (s.modal) { confrontSeen = true; break; }
  await sleep(150);
}
check('skip-to-confrontation opens the modal within ~8s', confrontSeen);

await browser.close();
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
