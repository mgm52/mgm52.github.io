// End-to-end check of the pip upgrade tree: task pays pips → Upgrades button
// appears → overlay opens → buying a node unlocks its build button. Also
// exercises the dev editor: data-driven work lane, needs-line toggle, edge
// pip totals, demon-reward panel, and add/edit/delete of work blocks.
//
// Expectations are derived from src/upgrade-tree.json so the suite keeps
// passing across balance edits — it tests the MACHINERY, not the numbers.
//   node scripts/verify-upgrade-tree.mjs   (vite dev server must be running)
import { readFileSync } from 'fs';
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tree = JSON.parse(readFileSync('src/upgrade-tree.json', 'utf8'));
const taskRequires = (t) => t.requires ?? (t.after ? [t.after] : []);
const upgradeIds = Object.keys(tree.upgrades);
const nodeCount = upgradeIds.length + tree.tasks.length;
const reqEdgeCount = Object.values(tree.upgrades).reduce((n, u) => n + u.requires.length, 0);
const chainEdgeCount = tree.tasks.reduce((n, t) => n + taskRequires(t).length, 0);

// Mirror of the editor's "everything before that point" math.
const taskById = Object.fromEntries(tree.tasks.map((t) => [t.id, t]));
function earnedBefore(taskId) {
  const seen = new Set();
  const stack = [...taskRequires(taskById[taskId])];
  let sum = 0;
  while (stack.length > 0) {
    const cur = stack.pop();
    if (seen.has(cur) || !taskById[cur]) continue;
    seen.add(cur);
    sum += taskById[cur].pips;
    stack.push(...taskRequires(taskById[cur]));
  }
  return sum;
}
function spentBefore(upgradeId) {
  const seen = new Set();
  const stack = [...tree.upgrades[upgradeId].requires];
  let sum = 0;
  while (stack.length > 0) {
    const cur = stack.pop();
    if (seen.has(cur) || !tree.upgrades[cur]) continue;
    seen.add(cur);
    sum += tree.upgrades[cur].cost;
    stack.push(...tree.upgrades[cur].requires);
  }
  return sum;
}

const firstTask = tree.tasks.find((t) => taskRequires(t).length === 0);
const firstPips = firstTask.pips;
// What should be buyable right after the first payout: roots within budget.
const expectedRoots = upgradeIds
  .filter((id) => tree.upgrades[id].requires.length === 0 && tree.upgrades[id].cost <= firstPips)
  .sort();
const buyId = expectedRoots.includes('phone_farm') ? 'phone_farm' : expectedRoots[0];

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
page.on('pageerror', (e) => console.log('PAGE ERR:', e.message));
page.on('dialog', (d) => d.accept());

let failures = 0;
const check = (name, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failures++;
};

// ─── Game side ───────────────────────────────────────────────────────
await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
await page.waitForFunction(() => !!window.__game?.state, { timeout: 15000 });
await page.evaluate(() => document.getElementById('title-screen')?.querySelector('button')?.click());
await sleep(500);
await page.evaluate(() => { document.body.classList.remove('intro-hold', 'bob-cutscene-hold'); });
await sleep(200);

// Trip the first task (assumed to be the earn-money tutorial goal).
await page.evaluate((amount) => { window.__game.state.money = amount; }, (firstTask.goal.amount ?? 100) + 50);
await sleep(3500);

const afterTask = await page.evaluate(() => {
  const s = window.__game.state;
  return {
    pips: s.pips,
    kills: s.kills,
    built: s.buildingsBuilt,
    upgradeSectionShown: document.getElementById('upgrade-section')?.style.display !== 'none',
    buildSectionShown: document.getElementById('build-section')?.style.display !== 'none',
  };
});
check(`first task paid ${firstPips} pips`, afterTask.pips === firstPips);
check('kill counters present and zeroed', JSON.stringify(afterTask.kills) === '{"goblin":0,"minotaur":0,"dragon":0}');
check('buildingsBuilt counters present', afterTask.built && Object.values(afterTask.built).every((v) => v === 0));
check('Upgrades button visible', afterTask.upgradeSectionShown);
check('Build section still hidden (nothing purchased)', !afterTask.buildSectionShown);

// Open the overlay; the buyable set should be exactly the affordable roots.
await page.click('#btn-open-upgrades');
await sleep(300);
mkdirSync('screenshots', { recursive: true });
await page.screenshot({ path: 'screenshots/upgrade-overlay.png' });
const overlayState = await page.evaluate(() => {
  const nodes = [...document.querySelectorAll('.ut-node')];
  return {
    open: !document.getElementById('upgrade-overlay')?.hidden,
    nodeCount: nodes.length,
    canBuy: nodes.filter((n) => n.classList.contains('can-buy')).map((n) => n.dataset.upgradeId).sort(),
  };
});
check('overlay opens', overlayState.open);
check(`${upgradeIds.length} upgrade nodes rendered`, overlayState.nodeCount === upgradeIds.length);
check(`only affordable roots buyable (${expectedRoots.join(', ')})`, overlayState.canBuy.join(',') === expectedRoots.join(','));

await page.click(`.ut-node[data-upgrade-id="${buyId}"]`);
await sleep(400);
const afterBuy = await page.evaluate(() => {
  const s = window.__game.state;
  return { pips: s.pips, owned: [...s.purchasedUpgrades] };
});
check(`purchase spent ${tree.upgrades[buyId].cost} pip(s)`, afterBuy.pips === firstPips - tree.upgrades[buyId].cost);
check(`${buyId} owned`, afterBuy.owned.includes(buyId));

await page.keyboard.press('Escape');
await sleep(600);
const sidebar = await page.evaluate((id) => ({
  overlayClosed: document.getElementById('upgrade-overlay')?.hidden,
  buildShown: document.getElementById('build-section')?.style.display !== 'none',
  btnUnlocked: !document.getElementById(`btn-build-${id}`)?.classList.contains('locked'),
}), buyId);
check('Escape closes overlay', sidebar.overlayClosed);
check('Build section now visible', sidebar.buildShown);
check(`${buyId} build button unlocked`, sidebar.btnUnlocked);

// Lightning granted as an upgrade id (demon path) surfaces the ritual button.
await page.evaluate(() => { window.__game.state.purchasedUpgrades.add('lightning'); });
await sleep(400);
const lightningShown = await page.evaluate(() =>
  document.getElementById('btn-lightning-strike')?.style.display !== 'none');
check('lightning via purchasedUpgrades shows ritual button', lightningShown);

// ─── Editor side ─────────────────────────────────────────────────────
await page.goto('http://localhost:5173/upgrade-editor.html', { waitUntil: 'networkidle' });
await sleep(800);
const editor = await page.evaluate(() => ({
  nodes: document.querySelectorAll('.node').length,
  taskNodes: document.querySelectorAll('.node.task').length,
  reqEdges: document.querySelectorAll('.edge.req').length,
  chainEdges: document.querySelectorAll('.edge.chain').length,
  needsEdges: document.querySelectorAll('.edge.needs').length,
  reportBad: document.querySelectorAll('#report .rep-bad').length,
  reportOk: document.querySelectorAll('#report .rep-ok').length,
  status: document.getElementById('status')?.textContent,
}));
check(`editor renders ${nodeCount} nodes`, editor.nodes === nodeCount);
check(`${tree.tasks.length} task nodes`, editor.taskNodes === tree.tasks.length);
check(`${reqEdgeCount} prerequisite edges`, editor.reqEdges === reqEdgeCount);
check(`${chainEdgeCount} work-chain edges`, editor.chainEdges === chainEdgeCount);
check('work→unlock lines shown by default', editor.needsEdges > 0);
check('balance report: no failures', editor.reportBad === 0);
check(`balance report: all ${tree.tasks.length} tasks complete`, editor.reportOk >= tree.tasks.length);
check('editor loaded from endpoint', editor.status === 'loaded');

// Toggle the work→unlock lines off and back on.
const needsBefore = editor.needsEdges;
await page.click('#toggle-needs');
await sleep(200);
const needsOff = await page.evaluate(() => document.querySelectorAll('.edge.needs').length);
check('needs lines hidden after toggle', needsOff === 0);
await page.click('#toggle-needs');
await sleep(200);
const needsOn = await page.evaluate(() => document.querySelectorAll('.edge.needs').length);
check('needs lines back after re-toggle', needsOn === needsBefore);

// Edge pip totals — "everything before that point", from the same math the
// editor uses but computed independently here from the json.
const sampleChainTask = tree.tasks.find((t) => taskRequires(t).length > 0);
const sampleReqUpgrade = upgradeIds.find((id) => tree.upgrades[id].requires.length > 0);
const edgeLabels = await page.evaluate(() => {
  const labels = [...document.querySelectorAll('text.edge-label')]
    .map((t) => ({ from: t.dataset.from, to: t.dataset.to, text: t.textContent }));
  return labels;
});
check(`${reqEdgeCount + chainEdgeCount} edge labels`, edgeLabels.length === reqEdgeCount + chainEdgeCount);
check(`chain edge into ${sampleChainTask.id} reads ◉ ${earnedBefore(sampleChainTask.id)}`,
  edgeLabels.find((l) => l.to === `task:${sampleChainTask.id}`)?.text === `◉ ${earnedBefore(sampleChainTask.id)}`);
check(`req edge into ${sampleReqUpgrade} reads ◉ ${spentBefore(sampleReqUpgrade)}`,
  edgeLabels.find((l) => l.to === sampleReqUpgrade)?.text === `◉ ${spentBefore(sampleReqUpgrade)}`);

// Demon reward panel mirrors the json.
const reward = tree.demonReward ?? { type: 'upgrade', id: 'lightning' };
const demonPanel = await page.evaluate(() => {
  const sels = [...document.querySelectorAll('#demon-reward select')];
  return {
    gift: sels[0]?.value,
    upgradePick: sels[1]?.value ?? null,
    amountInputs: document.querySelectorAll('#demon-reward input[type="number"]').length,
  };
});
check(`demon gift type is "${reward.type}"`, demonPanel.gift === reward.type);
if (reward.type === 'upgrade') {
  check(`demon gift upgrade is "${reward.id}"`, demonPanel.upgradePick === reward.id);
} else {
  check('demon gift shows amount input', demonPanel.amountInputs === 1);
}

// "+ Add upgrade": offers catalog ids missing from the tree, or reports a
// full tree. (Catalog = 10 building kinds + 6 ability ids.)
const CATALOG = ['goblin_wheel', 'phone_farm', 'gas_engine', 'datacentre', 'nuclear_reactor', 'hypercentre', 'dragon_beacon', 'hell_portal', 'goblin_hole', 'wall', 'minotaur', 'dig', 'autobuild', 'autospawn', 'goldblins', 'lightning'];
const missing = CATALOG.filter((id) => !(id in tree.upgrades));
await page.click('#btn-add-upgrade');
await sleep(200);
if (missing.length === 0) {
  const fullMsg = await page.evaluate(() => document.getElementById('inspector')?.textContent ?? '');
  check('add-upgrade reports a full tree', fullMsg.includes('already in the tree'));
  await page.keyboard.press('Escape');
} else {
  await page.selectOption('#inspector select', missing[0]);
  await page.click('#inspector .btn-row button.primary');
  await sleep(200);
  const added = await page.evaluate(() => document.querySelectorAll('.node').length);
  check(`add-upgrade adds ${missing[0]}`, added === nodeCount + 1);
  await page.click('#inspector .btn-row button.danger'); // remove it again
  await sleep(200);
}

// Add a work block, retype its goal to "kill a dragon", link a prereq the
// upgrade way, then delete it.
await page.click('#btn-add-work');
await sleep(200);
const added = await page.evaluate(() => ({
  nodes: document.querySelectorAll('.node').length,
  selectedLabel: document.querySelector('.node.selected .name')?.textContent,
  dirty: document.getElementById('status')?.textContent,
}));
check('add-work creates a new node', added.nodes === nodeCount + 1);
check('new work defaults to "Build a Wall"', added.selectedLabel === 'Build a Wall');
check('editor marked dirty', added.dirty === 'unsaved changes');

await page.selectOption('#inspector select', 'kill');
await sleep(200);
await page.selectOption('#inspector select:has(option[value="dragon"])', 'dragon');
await sleep(200);
const retyped = await page.evaluate(() => ({
  label: document.querySelector('.node.selected .name')?.textContent,
  rootNote: document.getElementById('inspector')?.textContent.includes('active from the start'),
}));
check('goal retyped to "Kill a Dragon"', retyped.label === 'Kill a Dragon');
check('new work starts with no prerequisites', retyped.rootNote === true);

await page.click('#inspector .btn-row button:nth-child(1)'); // + link prerequisite…
await sleep(200);
await page.click('.node.task'); // first task node in DOM order = first in the json
await sleep(200);
const linked = await page.evaluate(() => ({
  chainEdges: document.querySelectorAll('.edge.chain').length,
  chips: document.querySelectorAll('#inspector .chip').length,
}));
check('work prereq link adds a chain edge', linked.chainEdges === chainEdgeCount + 1);
check('inspector shows the prereq chip', linked.chips === 1);

await page.screenshot({ path: 'screenshots/upgrade-editor.png' });

await page.click('#inspector .btn-row button.danger');
await sleep(200);
const afterDelete = await page.evaluate(() => ({
  nodes: document.querySelectorAll('.node').length,
  chainEdges: document.querySelectorAll('.edge.chain').length,
  reportBad: document.querySelectorAll('#report .rep-bad').length,
}));
check('delete restores node count', afterDelete.nodes === nodeCount);
check('its chain edge went with it', afterDelete.chainEdges === chainEdgeCount);
check('report still clean after delete', afterDelete.reportBad === 0);

await browser.close();
console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
