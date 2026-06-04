// Trace #task-text class/visibility changes through a task celebration.
import { chromium } from 'playwright';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const ctx = await browser.newContext({ viewport: { width: 430, height: 932 }, hasTouch: true });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('PAGE ERR:', e.message));
page.on('console', (m) => { if (m.text().startsWith('TRACE')) console.log(m.text()); });
await page.goto('http://127.0.0.1:5173', { waitUntil: 'networkidle' });
await page.waitForFunction(() => !!window.__game?.state, { timeout: 15000 });
await page.evaluate(() => document.getElementById('title-screen')?.querySelector('button')?.click());
await sleep(500);
await page.evaluate(() => { document.body.classList.remove('intro-hold', 'bob-cutscene-hold'); });

const which = process.env.TASK || 'gas';
if (which === 'gas') {
  await page.click('#options-cog');
  const skipBtn = page.locator('button', { hasText: 'Work skip' });
  await skipBtn.click();
  await sleep(300);
  await skipBtn.click();
  await sleep(300);
  await page.click('#options-cog');
}
await sleep(1000);

await page.evaluate((w) => { window.__which = w; }, which);
await page.evaluate(() => {
  const t0 = performance.now();
  const el = document.getElementById('task-text');
  const sidebar = document.getElementById('sidebar');
  const log = (msg) => console.log(`TRACE +${((performance.now() - t0) / 1000).toFixed(2)}s ${msg}`);
  const snap = () => {
    const cs = getComputedStyle(el);
    return `classes=[${el.className}] vis=${cs.visibility} opacity=${cs.opacity} sidebarDim=${sidebar.classList.contains('unlock-reveal-dim')} text="${el.textContent.slice(0, 60)}"`;
  };
  new MutationObserver(() => log(`task-text mutated: ${snap()}`))
    .observe(el, { attributes: true, attributeFilter: ['class', 'style'], childList: true, subtree: true, characterData: true });
  new MutationObserver(() => log(`sidebar class: [${sidebar.className}]`))
    .observe(sidebar, { attributes: true, attributeFilter: ['class'] });
  // Sample computed opacity every 100ms too (transitions don't fire mutations).
  let last = '';
  setInterval(() => {
    const s = snap();
    if (s !== last) { last = s; log(`sample: ${s}`); }
  }, 50);

  const { state } = window.__game;
  if (window.__which === 'gas') {
    const PA = state.playArea;
    const id = state.nextId++;
    state.buildings.set(id, {
      id, displayNum: 1, kind: 'gas_engine',
      cell: { cx: PA.x0 + 2, cy: PA.y0 + 2 },
      state: 'active', buildProgress: 1, activatedAt: state.now,
      assignedGoblins: [], selected: false,
    });
    log('gas engine planted');
  } else {
    state.money = 150;
    log('money set to 150');
  }
});
await sleep(12000);
await browser.close();
