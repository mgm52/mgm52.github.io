// Verifies the trading-card realm's enter/leave-world transitions end to end
// on the vite dev server (npm run dev -- --port 5179):
//  - the dive (REENTER WORLD): card swells, the bridging white rises;
//  - the arrival: #app zooms out of the white (scale < 1 mid-flight, 1 after);
//  - the world is the card's world (cardWorld flag, LEAVE WORLD chrome);
//  - the pull-back (LEAVE WORLD): #app recedes, white rises;
//  - the round trip: the card's data string changed (the visit was recorded)
//    and the metagame is back on the table.
import { mkdirSync } from 'node:fs';
import { launchChromium } from './card-realm-browser.mjs';

const PORT = process.env.PORT ?? '5179';
const REALM = `http://localhost:${PORT}/?cardrealm`;
const PLAIN = `http://localhost:${PORT}/`;
const OUT = 'screenshots/card-realm';
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

const browser = await launchChromium();
// reducedMotion stills the realm's ambient drift (card levitation, auroras —
// index.html's prefers-reduced-motion block) so clicks pass playwright's
// stability check.
const page = await browser.newPage({
  viewport: { width: 1280, height: 800 },
  reducedMotion: 'reduce',
});
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));

const appScale = () => page.evaluate(() => {
  const t = getComputedStyle(document.getElementById('app')).transform;
  if (!t || t === 'none') return 1;
  return Number(t.match(/matrix\(([-\d.]+)/)?.[1] ?? 1);
});
const whiteOpacity = () => page.evaluate(() => {
  const el = document.getElementById('card-hop-white');
  return el ? Number(getComputedStyle(el).opacity) : 0;
});

// Transitions follow easing curves, so single-instant samples are flaky:
// poll across the whole window and keep the extremes. Evaluation errors
// (the page's own reload landing) just end the poll.
async function pollTransition(ms) {
  const out = { minScale: 1, maxWhite: 0 };
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const [scale, white] = await Promise.all([appScale(), whiteOpacity()]);
      out.minScale = Math.min(out.minScale, scale);
      out.maxWhite = Math.max(out.maxWhite, white);
    } catch { break; }
    await sleep(50);
  }
  return out;
}

// ── Fresh run: click through the goblin intro to reach the table. ──
await page.goto(REALM, { waitUntil: 'domcontentloaded' });
await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
await page.goto(REALM, { waitUntil: 'networkidle' });
await page.waitForSelector('#card-realm.visible .world-card', { timeout: 15000 });
await sleep(800);
await page.click('.wc-enter');
for (let i = 0; i < 60; i++) {
  if (await page.$('#card-stage.table-view')) break;
  if (await page.$('#card-realm.show-choice')) { await page.click('#card-no'); continue; }
  if (await page.$('#card-realm.click-armed')) await page.click('#card-clickwall');
  await sleep(500);
}
await page.waitForSelector('#card-stage.table-view .world-card', { timeout: 60000 });
check('intro completes to the table', true);

const dataBefore = await page.evaluate(() =>
  JSON.parse(localStorage.getItem('rts.cards.v1')).cards[0].data.length);

// ── The dive. ──
await page.click('.wc-enter');
await sleep(300);
const dived = await page.$('.world-card.dived');
check('dive: card swells (.dived)', dived !== null);
const dive = await pollTransition(1300);
// Polling near the page's own reload is lossy — any clear rise counts.
check('dive: bridging white rises', dive.maxWhite > 0.15, `white peak ${dive.maxWhite.toFixed(2)}`);
await sleep(2600); // reload lands (realm remounts over the world under ?cardrealm)

// ── The arrival, on the plain URL with the hop flag re-armed. ──
await page.evaluate(() => sessionStorage.setItem('rts.cardhop', '1'));
await page.goto(PLAIN, { waitUntil: 'domcontentloaded' });
const arrive = await pollTransition(2400);
check('arrival: app zooms out of the white', arrive.minScale < 0.9, `scale dipped to ${arrive.minScale.toFixed(3)}`);
check('arrival: bridging white seen', arrive.maxWhite > 0.3, `white peak ${arrive.maxWhite.toFixed(2)}`);
await sleep(600);
const scaleEnd = await appScale();
check('arrival: zoom settles at 1', Math.abs(scaleEnd - 1) < 0.01, `scale ${scaleEnd}`);
const inWorld = await page.evaluate(() => ({
  cardWorld: window.__game?.state?.cardWorld === true,
  chrome: document.body.classList.contains('card-world'),
  leaveVisible: document.getElementById('leave-world-btn')?.style.display !== 'none',
  demons: window.__game?.state?.demons?.size ?? -1,
}));
check('in-world: state is the card world', inWorld.cardWorld);
check('in-world: white border chrome', inWorld.chrome);
check('in-world: LEAVE WORLD shown', inWorld.leaveVisible);
check('in-world: no demons', inWorld.demons === 0, `demons ${inWorld.demons}`);
await sleep(1200);

// ── The pull-back. ──
await page.click('#leave-world-btn');
const exit = await pollTransition(1300);
check('leave: app recedes to a point', exit.minScale < 0.9, `scale dipped to ${exit.minScale.toFixed(3)}`);
check('leave: white rises', exit.maxWhite > 0.3, `white peak ${exit.maxWhite.toFixed(2)}`);
await sleep(2000); // serialize + reload

// ── The round trip. ──
const after = await page.evaluate(() => {
  const meta = JSON.parse(localStorage.getItem('rts.cards.v1'));
  return { active: meta.activeCardId, dataLen: meta.cards[0].data.length, res: meta.cards[0].resources };
});
check('round trip: back on the table (no active card)', after.active === null);
check('round trip: the visit was recorded onto the card', after.dataLen !== dataBefore,
  `data ${dataBefore} → ${after.dataLen}`);
check('round trip: resources carry power field', 'power' in after.res);

await browser.close();
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
