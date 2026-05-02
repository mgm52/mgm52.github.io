import { preloadSounds, playSound } from './audio';
import { CAMERA_SPEED, GOBLIN, START_CELL, TICK_MS } from './config';
import { setupInput } from './input';
import { setupOptionsUI } from './options-ui';
import { centerCameraOn, clampCamera, createRender, render } from './render';
import { appendLog, cellCenter, createInitialState, destroyBuilding } from './state';
import { tick } from './sim';
import { refreshUI, setupUI } from './ui';

function showTitleScreen(): void {
  const screen = document.getElementById('title-screen');
  const playBtn = document.getElementById('title-play');
  if (!screen || !playBtn) return;
  // Backdrop is already black (inline CSS). Fade the content in next frame.
  requestAnimationFrame(() => screen.classList.add('shown'));
  playBtn.addEventListener('click', () => {
    // Stage 1: fade content (text + button) out, leaving full-black backdrop.
    screen.classList.remove('shown');
    setTimeout(() => {
      // Stage 2: fade the black backdrop out, revealing the game beneath.
      screen.classList.add('fading-out');
      setTimeout(() => { screen.style.display = 'none'; }, 750);
    }, 750);
  }, { once: true });
}

async function main() {
  // Production-only title gate. Click here also satisfies the browser's
  // user-gesture requirement so audio can play immediately afterwards.
  if (import.meta.env.PROD) showTitleScreen();

  // Wait for thematic fonts to be ready so Pixi caches the right glyphs.
  if ('fonts' in document) {
    try {
      await Promise.all([
        document.fonts.load('16px VT323'),
        document.fonts.load('16px Audiowide'),
      ]);
    } catch { /* fall through to fallback fonts */ }
  }
  preloadSounds();
  const state = createInitialState();
  const ctx = await createRender(document.getElementById('game')!, state.walls);
  setupInput(state, ctx.app, ctx.uiLayer, ctx.worldLayer, ctx);
  setupOptionsUI(document.getElementById('game')!);
  setupUI(state, {
    onSpawnGoblin: () => {
      if (state.money < GOBLIN.spawnCost) { playSound('error'); return; }
      if (state.spawnQueue.length >= GOBLIN.concurrentBuildLimit) { playSound('error'); return; }
      const used = new Set(state.spawnQueue.map((s) => s.slot));
      let slot = -1;
      for (let i = 0; i < GOBLIN.concurrentBuildLimit; i++) {
        if (!used.has(i)) { slot = i; break; }
      }
      if (slot < 0) return;
      state.money -= GOBLIN.spawnCost;
      state.spawnQueue.push({ remaining: GOBLIN.spawnTime, slot });
      appendLog(state, 'Hatching a goblin...');
    },
    onBuildBuilding: (kind) => {
      state.pendingBuild = state.pendingBuild?.kind === kind ? null : { kind };
    },
    onDestroyBuilding: (id) => {
      destroyBuilding(state, id);
      playSound('destroy');
      appendLog(state, `Building #${id} destroyed.`);
    },
  });

  // Center the camera on the starting area.
  const startCenter = cellCenter(START_CELL);
  centerCameraOn(ctx, startCenter.x, startCenter.y);

  // ─── WASD camera panning ───────────────────────────────────────────
  const held = new Set<string>();
  const isPanKey = (k: string) =>
    k === 'w' || k === 'a' || k === 's' || k === 'd' ||
    k === 'arrowup' || k === 'arrowdown' || k === 'arrowleft' || k === 'arrowright';
  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (isPanKey(k)) { held.add(k); e.preventDefault(); }
  });
  window.addEventListener('keyup', (e) => {
    const k = e.key.toLowerCase();
    if (isPanKey(k)) held.delete(k);
  });
  // Drop held keys if the window loses focus (otherwise camera "drifts" forever).
  window.addEventListener('blur', () => held.clear());

  let acc = 0;
  let last = performance.now();
  function frame(now: number) {
    const dt = now - last;
    last = now;
    acc += dt;
    if (acc > TICK_MS * 10) acc = TICK_MS * 10;
    while (acc >= TICK_MS) {
      tick(state);
      acc -= TICK_MS;
    }
    // Update camera based on held pan keys
    let dx = 0, dy = 0;
    if (held.has('a') || held.has('arrowleft')) dx -= 1;
    if (held.has('d') || held.has('arrowright')) dx += 1;
    if (held.has('w') || held.has('arrowup')) dy -= 1;
    if (held.has('s') || held.has('arrowdown')) dy += 1;
    if (dx !== 0 || dy !== 0) {
      const len = Math.hypot(dx, dy);
      const move = (CAMERA_SPEED * dt) / 1000;
      ctx.camera.x += (dx / len) * move;
      ctx.camera.y += (dy / len) * move;
      clampCamera(ctx);
    }
    render(state, ctx);
    refreshUI(state);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

main().catch((e) => {
  console.error(e);
  document.body.innerHTML = `<pre style="color:#ff7777;padding:20px">${e}</pre>`;
});
