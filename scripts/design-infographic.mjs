// Renders the hell-design infographic (pure HTML/canvas, no game needed) and
// screenshots it to a PNG for the brainstorm deliverable.
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  :root{--red:#ff2030;--dim:#8a2030;--ink:#f3e0e0;--mut:#c79aa0;--bg0:#160406;--bg1:#0a0203;}
  *{box-sizing:border-box;margin:0;font-family:'Segoe UI',system-ui,sans-serif}
  body{background:radial-gradient(120% 90% at 50% 0%,#2a0608,#0a0203);color:var(--ink);padding:34px 40px 44px;width:1180px}
  h1{font-size:30px;letter-spacing:.5px;color:#ffb0b0;text-shadow:0 0 18px #ff203066}
  h1 small{display:block;font-size:14px;font-weight:400;color:var(--mut);margin-top:4px;letter-spacing:0}
  .card{background:linear-gradient(180deg,#1c0709,#120406);border:1px solid #5a151c;border-radius:14px;padding:22px 24px;margin-top:22px;box-shadow:0 8px 30px #0008, inset 0 0 60px #ff20300c}
  h2{font-size:18px;color:#ff8a8a;margin-bottom:14px;letter-spacing:.5px}
  .row{display:flex;align-items:center;gap:14px;margin:9px 0}
  .lbl{width:150px;font-size:13px;color:var(--mut);text-align:right}
  .bar{height:22px;border-radius:5px;display:flex;align-items:center;padding:0 9px;font-size:12px;font-weight:600;color:#fff;white-space:nowrap}
  .val{font-size:12px;color:var(--mut)}
  .gen{background:linear-gradient(90deg,#ff2030,#ff6a4a)}
  .con{background:linear-gradient(90deg,#3a6a8a,#6ab0d0)}
  .gap-note{margin-top:12px;font-size:13px;color:#ffd0a0;background:#3a160a;border-left:3px solid #ffa040;padding:9px 12px;border-radius:0 6px 6px 0}
  table{width:100%;border-collapse:collapse;margin-top:6px;font-size:13px}
  td,th{padding:7px 10px;text-align:left;border-bottom:1px solid #3a1015}
  th{color:#ff8a8a;font-size:12px;text-transform:uppercase;letter-spacing:.5px}
  .src{color:#ff9a6a}.snk{color:#7ac0e0}
  .flow{display:flex;flex-wrap:wrap;gap:10px;align-items:stretch;margin-top:6px}
  .node{flex:1;min-width:150px;background:#1f0a0c;border:1px solid #5a151c;border-radius:10px;padding:12px 13px}
  .node h3{font-size:13px;color:#ffb0b0;margin-bottom:5px}
  .node p{font-size:11.5px;color:var(--mut);line-height:1.45}
  .tag{display:inline-block;font-size:10px;padding:1px 7px;border-radius:10px;margin-bottom:6px;font-weight:600}
  .t-now{background:#3a1015;color:#ff8a8a}.t-new{background:#0a2a1a;color:#6affb0}
  .arrow{align-self:center;color:#ff6a4a;font-size:22px}
  canvas{width:100%;height:230px}
  .leg{font-size:12px;color:var(--mut);margin-top:8px}
  .leg b{color:#ff8a8a}
  .foot{margin-top:10px;font-size:11px;color:#7a5a5e}
</style></head><body>
  <h1>⛧ Hell Economy — Assessment &amp; Redesign
    <small>goblin-datacentres · the soul surplus is the central untapped lever</small></h1>

  <div class="card">
    <h2>1 · The Soul Gap — generation vastly outruns consumption</h2>
    <div id="souls"></div>
    <div class="gap-note"><b>~99% of souls are wasted.</b> Autospawn + minotaur culling mints souls
      continuously; hell consumes just 5 per portal (one sigil). Hundreds drift down and are pruned off-screen.
      Every "100-soul" idea is the right instinct: <b>souls need a real sink.</b></div>
  </div>

  <div class="card">
    <h2>2 · Power ladder (log scale) — the sigil already trivialises power</h2>
    <canvas id="ladder" width="2264" height="460"></canvas>
    <div class="leg"><b>Insight:</b> one completed sigil (+25&nbsp;GW, paid in 5 free souls) already dwarfs
      24× the biggest sink. So power isn't the late constraint — <b>what you do with abundant souls + power is.</b>
      That's the design space hell should own.</div>
  </div>

  <div class="card">
    <h2>3 · Where each idea fits — sources &amp; sinks for the surplus</h2>
    <table>
      <tr><th>Idea</th><th>Role</th><th>Soul leverage</th><th>Cost</th><th>Verdict</th></tr>
      <tr><td>Soul-trap beacon (auto-eat drifting souls)</td><td class="snk">passive sink</td><td>★★★★★ bulk</td><td>med</td><td>Core — fixes waste <i>and</i> tedium</td></tr>
      <tr><td>Candle sigils (player-placed pattern)</td><td class="snk">set-piece sink</td><td>★★★ scalable</td><td>med</td><td>Generalises today's sigil</td></tr>
      <tr><td>Megastructure (100+ souls)</td><td class="snk">capstone sink</td><td>★★★★★ one-shot</td><td>high</td><td>The goal souls feed toward</td></tr>
      <tr><td>Autodragon unlock</td><td class="src">capstone reward</td><td>—</td><td>med</td><td>Payoff for the megastructure</td></tr>
      <tr><td>Settings-demon (volume etc.)</td><td>flavour gate</td><td>—</td><td>low</td><td>Quick win — fits secret-menu lore</td></tr>
      <tr><td>Demon invasion of overworld (wall it in)</td><td class="src">risk/reward faucet</td><td>★★★★ feeds loop</td><td>high</td><td>Big, late — uses idle Walls</td></tr>
    </table>
  </div>

  <div class="card">
    <h2>4 · Proposed flywheel — every existing system reinforced</h2>
    <div class="flow">
      <div class="node"><span class="tag t-now">exists</span><h3>Minotaur farm</h3><p>Autospawn floods goblins; minotaurs cull → blood + a soul per kill, born at the kill's world-x.</p></div>
      <div class="arrow">→</div>
      <div class="node"><span class="tag t-new">new</span><h3>Soul traps</h3><p>Placed in the drift lane below the farm. Each passing soul → small permanent +power. Position matters.</p></div>
      <div class="arrow">→</div>
      <div class="node"><span class="tag t-new">new</span><h3>Megastructure</h3><p>100+ souls + blood + builders. Outputs TW-scale energy and unlocks the Autodragon.</p></div>
      <div class="arrow">→</div>
      <div class="node"><span class="tag t-new">new</span><h3>Demon invasion</h3><p>Unleash a demon up top: it slaughters everything (huge soul/blood spike) — wall it into a kill-pen to feed the traps.</p></div>
    </div>
    <div class="leg" style="margin-top:14px">Loop closes: invasion kills → souls fall → traps + sigils → power →
      bigger structures &amp; more invasions. Walls (today nearly unused) become essential containment.</div>
  </div>

  <p class="foot">Numbers from src/config.ts (KILL_REWARD, AUTOSPAWN_TIERS, SOUL_SIGIL, BUILDING_DEFS). Log ladder in watts.</p>

<script>
  // ---- Soul gap bars ----
  const cull = 10.7; // goblins/sec at max autospawn tier (×32 over 3s)
  const data = [
    ['Souls minted /min','gen', cull*60, (cull*60|0)+' souls/min'],
    ['Sink: 1 sigil','con', 5, '5 souls (one-time)'],
    ['Sink: 10 portals','con', 50, '50 souls (one-time)'],
  ];
  const max = Math.max(...data.map(d=>d[2]));
  const host = document.getElementById('souls');
  for(const [lbl,cls,v,txt] of data){
    const w = Math.max(8, v/max*640);
    host.insertAdjacentHTML('beforeend',
      '<div class="row"><div class="lbl">'+lbl+'</div>'+
      '<div class="bar '+cls+'" style="width:'+w+'px">'+(v>=40?txt:'')+'</div>'+
      (v<40?'<div class="val">'+txt+'</div>':'')+'</div>');
  }

  // ---- Power ladder (log) ----
  const c = document.getElementById('ladder'), x = c.getContext('2d');
  x.scale(2,2); const W=1132,H=230;
  const items=[
    ['Goblin Wheel',100,'src'],['Phone Farm',200,'snk'],['Gas Turbine',2.5e6,'src'],
    ['Datacentre',6e6,'snk'],['Nuclear',1e9,'src'],['Hypercentre',1e9,'snk'],
    ['Dragon Beacon',5e9,'snk'],['Soul Sigil',25e9,'src'],['Megastructure?',1e12,'src'],
  ];
  const lo=Math.log10(50), hi=Math.log10(2e12);
  const px=v=>40+(Math.log10(v)-lo)/(hi-lo)*(W-90);
  // axis
  x.strokeStyle='#5a151c'; x.lineWidth=1; x.beginPath(); x.moveTo(40,H-26); x.lineTo(W-20,H-26); x.stroke();
  x.fillStyle='#7a5a5e'; x.font='11px Segoe UI';
  for(const p of [[100,'100 W'],[1e6,'1 MW'],[1e9,'1 GW'],[1e12,'1 TW']]){
    const xx=px(p[0]); x.strokeStyle='#2a0a0e'; x.beginPath(); x.moveTo(xx,18); x.lineTo(xx,H-26); x.stroke();
    x.fillText(p[1],xx-12,H-12);
  }
  items.forEach((it,i)=>{
    const xx=px(it[1]); const yy=30+i*0; const r=6;
    const yrow=34+ (i%2? 0:0);
  });
  // plot as a vertical strip of dots with labels alternating
  items.forEach((it,i)=>{
    const xx=px(it[1]);
    const yy=30 + (i* ((H-70)/(items.length-1)));
    x.fillStyle = it[2]==='src' ? '#ff6a4a' : '#6ab0d0';
    x.beginPath(); x.arc(xx,yy,6,0,7); x.fill();
    x.fillStyle = it[2]==='src' ? '#ffb090':'#a8d8ec'; x.font='12px Segoe UI';
    const label=it[0];
    if(xx>W-260){ x.textAlign='right'; x.fillText(label, xx-12, yy+4); }
    else { x.textAlign='left'; x.fillText(label, xx+12, yy+4); }
    x.textAlign='left';
  });
</script></body></html>`;

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const page = await browser.newContext({ deviceScaleFactor: 2 }).then(c=>c.newPage());
await page.setContent(html, { waitUntil: 'networkidle' });
await page.waitForTimeout(300);
mkdirSync('screenshots', { recursive: true });
const el = await page.$('body');
await el.screenshot({ path: 'screenshots/hell-design.png' });
console.log('Wrote screenshots/hell-design.png');
await browser.close();
