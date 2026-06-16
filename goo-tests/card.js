/* Shared card-texture drawer for the gooey-shader isolation tests.
 *
 * Draws one representative "RARE world card" — modelled on the real
 * trading-realm card (src/cards.ts buildCardEl + the preview painters):
 * a frosted gold-framed stock with a name/tier head, a stacked
 * space/earth/hell preview column, a colored resource line and an
 * ENTER WORLD button.
 *
 * The card is centred on a transparent margin so the goo shaders have
 * room to crawl around / under / over it. Classic <script> (no module)
 * so it loads over file:// without CORS.  Exposes window.drawGooCard.
 */
(function () {
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function roundRect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  // ── Preview panes (compressed echoes of the real painters) ──
  function drawSpace(g, x, y, w, h, rng) {
    g.save();
    roundRect(g, x, y, w, h, 6); g.clip();
    g.fillStyle = '#05040f'; g.fillRect(x, y, w, h);
    for (let i = 0; i < 2; i++) {
      const nx = x + rng() * w, ny = y + rng() * h, nr = 14 + rng() * 30;
      const neb = g.createRadialGradient(nx, ny, 0, nx, ny, nr);
      neb.addColorStop(0, i ? 'rgba(60,110,160,0.30)' : 'rgba(110,70,160,0.34)');
      neb.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = neb; g.fillRect(nx - nr, ny - nr, nr * 2, nr * 2);
    }
    for (let i = 0; i < 60; i++) {
      const big = rng() < 0.12;
      g.globalAlpha = 0.35 + rng() * 0.65;
      g.fillStyle = big ? '#fff' : '#cfd4e8';
      g.fillRect(x + rng() * w, y + rng() * h, big ? 3 : 2, big ? 3 : 2);
    }
    g.globalAlpha = 1;
    // an orbital platform
    g.fillStyle = '#565b66'; g.fillRect(x + w * 0.62, y + h * 0.4, 12, 9);
    g.strokeStyle = '#9aa0ac'; g.lineWidth = 1.5; g.strokeRect(x + w * 0.62, y + h * 0.4, 12, 9);
    g.fillStyle = '#8ad8ff'; g.fillRect(x + w * 0.62 + 2, y + h * 0.4 + 2, 2, 2);
    g.restore();
  }

  function drawEarth(g, x, y, w, h, rng) {
    g.save();
    roundRect(g, x, y, w, h, 6); g.clip();
    // sky → ground
    const sky = g.createLinearGradient(0, y, 0, y + h);
    sky.addColorStop(0, '#10131a'); sky.addColorStop(0.45, '#1a2330'); sky.addColorStop(1, '#26331f');
    g.fillStyle = sky; g.fillRect(x, y, w, h);
    // ground mottle
    const tones = ['#3a4a32', '#43543a', '#4d5e40'];
    const cell = 9, gy = y + h * 0.5;
    for (let cy = gy; cy < y + h; cy += cell) {
      for (let cx = x; cx < x + w; cx += cell) {
        g.fillStyle = tones[(((cx | 0) * 7 + (cy | 0) * 13) % 3 + 3) % 3];
        g.fillRect(cx, cy, cell + 0.5, cell + 0.5);
      }
    }
    // water
    g.fillStyle = '#2e639a'; g.fillRect(x + w * 0.08, y + h * 0.62, w * 0.3, h * 0.12);
    g.fillStyle = 'rgba(140,190,235,0.7)'; g.fillRect(x + w * 0.08, y + h * 0.62, w * 0.3, 2);
    // a little skyline of buildings, bottom-anchored
    const cols = ['#7a5cff', '#ff9a3d', '#5ad1c4', '#d85a7a', '#cfcf6b'];
    let bx = x + w * 0.46;
    for (let i = 0; i < 5; i++) {
      const bw = 7 + rng() * 6, bh = 10 + rng() * 30;
      g.fillStyle = cols[i % cols.length];
      g.fillRect(bx, y + h - bh, bw, bh);
      g.strokeStyle = 'rgba(255,255,255,0.4)'; g.lineWidth = 1;
      g.strokeRect(bx + 0.5, y + h - bh + 0.5, bw - 1, bh - 1);
      bx += bw + 3 + rng() * 4;
    }
    // a spawning hole
    g.fillStyle = '#0a0a0a';
    g.beginPath(); g.arc(x + w * 0.2, y + h * 0.85, 4, 0, Math.PI * 2); g.fill();
    // bright unit dots
    g.fillStyle = '#8ee492';
    for (let i = 0; i < 6; i++) g.fillRect(x + w * (0.3 + rng() * 0.6), y + h * (0.6 + rng() * 0.35), 3, 3);
    g.fillStyle = '#ffd96b'; g.fillRect(x + w * 0.55, y + h * 0.7, 3, 3);
    // built-up glow
    const glow = g.createRadialGradient(x + w * 0.6, y + h * 0.8, 0, x + w * 0.6, y + h * 0.8, w * 0.4);
    glow.addColorStop(0, 'rgba(255,236,170,0.28)'); glow.addColorStop(1, 'rgba(255,236,170,0)');
    g.fillStyle = glow; g.fillRect(x, y, w, h);
    g.restore();
  }

  function drawHell(g, x, y, w, h, rng) {
    g.save();
    roundRect(g, x, y, w, h, 6); g.clip();
    g.fillStyle = '#1a0608'; g.fillRect(x, y, w, h);
    for (let i = 0; i < 3; i++) {
      const fx = x + rng() * w, fy = y + h * (0.7 + rng() * 0.4), fr = 20 + rng() * 36;
      const fog = g.createRadialGradient(fx, fy, 0, fx, fy, fr);
      fog.addColorStop(0, 'rgba(150,20,28,0.55)'); fog.addColorStop(1, 'rgba(150,20,28,0)');
      g.fillStyle = fog; g.fillRect(fx - fr, fy - fr, fr * 2, fr * 2);
    }
    // portal beam
    const px = x + w * 0.5;
    g.fillStyle = 'rgba(255,32,48,0.22)'; g.fillRect(px - 2, y, 5, h);
    g.fillStyle = 'rgba(255,90,90,0.95)'; g.fillRect(px, y, 1.5, h);
    const pool = g.createRadialGradient(px, y + h, 0, px, y + h, 18);
    pool.addColorStop(0, 'rgba(255,60,70,0.55)'); pool.addColorStop(1, 'rgba(255,60,70,0)');
    g.fillStyle = pool; g.fillRect(px - 18, y + h - 18, 36, 18);
    // drifting souls
    g.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 7; i++) {
      const sx = x + rng() * w, sy = y + 4 + rng() * (h - 8), r = 2 + rng() * 2;
      const gl = g.createRadialGradient(sx, sy, 0, sx, sy, r);
      gl.addColorStop(0, 'rgba(200,210,245,0.8)'); gl.addColorStop(1, 'rgba(200,210,245,0)');
      g.fillStyle = gl; g.fillRect(sx - r, sy - r, r * 2, r * 2);
    }
    g.restore();
  }

  // Draw the card into `canvas`, centred, transparent margin around it.
  // Returns { x, y, w, h, r } of the card rect in canvas pixels.
  window.drawGooCard = function drawGooCard(canvas, opts) {
    opts = opts || {};
    const W = canvas.width, H = canvas.height;
    const g = canvas.getContext('2d');
    g.clearRect(0, 0, W, H);
    const rng = mulberry32(opts.seed || 12345);

    // Card rect: leave generous margin so goo can surround it.
    const cw = Math.round(W * (opts.cardFrac || 0.62));
    const ch = Math.round(cw * 1.4);
    const cx = Math.round((W - cw) / 2);
    const cy = Math.round((H - ch) / 2);
    const r = Math.round(cw * 0.07);
    const pad = Math.round(cw * 0.06);

    // Tier palette: RARE gold.
    const tierC = '#d8b54a', tierB = 'rgba(226,192,100,0.95)';

    // ── frosted glass body ──
    g.save();
    roundRect(g, cx, cy, cw, ch, r);
    const body = g.createLinearGradient(cx, cy, cx + cw, cy + ch);
    body.addColorStop(0, 'rgba(250,250,255,0.93)');
    body.addColorStop(0.5, 'rgba(232,234,246,0.90)');
    body.addColorStop(1, 'rgba(244,240,250,0.93)');
    g.fillStyle = body; g.fill();
    // diagonal glass sheen
    const sheen = g.createLinearGradient(cx, cy, cx + cw, cy + ch);
    sheen.addColorStop(0, 'rgba(255,255,255,0.5)');
    sheen.addColorStop(0.36, 'rgba(255,255,255,0.06)');
    sheen.addColorStop(0.52, 'rgba(255,255,255,0.0)');
    sheen.addColorStop(1, 'rgba(255,255,255,0.22)');
    g.fillStyle = sheen; g.fill();
    g.restore();

    // gold frame
    g.save();
    roundRect(g, cx + 1, cy + 1, cw - 2, ch - 2, r - 1);
    g.lineWidth = Math.max(2, cw * 0.012);
    g.strokeStyle = tierB; g.stroke();
    // inner hairline
    roundRect(g, cx + pad * 0.5, cy + pad * 0.5, cw - pad, ch - pad, r * 0.7);
    g.lineWidth = 1; g.strokeStyle = 'rgba(216,181,74,0.5)'; g.stroke();
    g.restore();

    // ── head: name + tier ──
    const ix = cx + pad, iw = cw - pad * 2;
    let yy = cy + pad + cw * 0.05;
    g.textBaseline = 'alphabetic';
    g.fillStyle = '#3a3320';
    g.font = `600 ${Math.round(cw * 0.082)}px Georgia, "Times New Roman", serif`;
    g.fillText('★ Verdant Hollow', ix, yy);
    g.fillStyle = tierC;
    g.font = `${Math.round(cw * 0.052)}px "Courier New", monospace`;
    g.textAlign = 'right';
    g.fillText('RARE', ix + iw, yy);
    g.textAlign = 'left';
    yy += cw * 0.05;

    // ── preview column ──
    const paneX = ix, paneW = iw;
    const spaceH = cw * 0.16, earthH = cw * 0.46, hellH = cw * 0.16, gap = cw * 0.03;
    drawSpace(g, paneX, yy, paneW, spaceH, rng); yy += spaceH + gap;
    drawEarth(g, paneX, yy, paneW, earthH, rng); yy += earthH + gap;
    drawHell(g, paneX, yy, paneW, hellH, rng); yy += hellH + gap;
    // pane borders
    g.strokeStyle = 'rgba(255,255,255,0.55)'; g.lineWidth = 1;
    // (panes already rounded-clipped; a soft outer edge)

    // ── resource line ──
    yy += cw * 0.06;
    g.font = `${Math.round(cw * 0.058)}px "Courier New", monospace`;
    g.textAlign = 'center';
    const mid = ix + iw / 2;
    const parts = [['Ƶ 1,240,000', '#a8861d'], ['84 blood', '#b8504d'], ['3 bones', '#84848c']];
    // measure to spread them
    let total = 0; const ws = parts.map(p => { const m = g.measureText(p[0]).width; total += m + cw * 0.05; return m; });
    let bx = mid - total / 2;
    g.textAlign = 'left';
    for (let i = 0; i < parts.length; i++) {
      g.fillStyle = parts[i][1];
      g.fillText(parts[i][0], bx, yy);
      bx += ws[i] + cw * 0.05;
    }
    g.textAlign = 'left';

    // ── ENTER WORLD button ──
    yy += cw * 0.05;
    const btnH = cw * 0.14, btnY = cy + ch - pad - btnH;
    g.save();
    roundRect(g, ix, btnY, iw, btnH, btnH * 0.32);
    g.fillStyle = 'rgba(255,255,255,0.55)'; g.fill();
    g.lineWidth = 1.5; g.strokeStyle = 'rgba(255,255,255,0.9)'; g.stroke();
    g.fillStyle = '#45455a';
    g.font = `600 ${Math.round(cw * 0.055)}px Georgia, serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('E N T E R   W O R L D', ix + iw / 2, btnY + btnH / 2 + 1);
    g.restore();
    g.textAlign = 'left'; g.textBaseline = 'alphabetic';

    return { x: cx, y: cy, w: cw, h: ch, r: r };
  };
})();
