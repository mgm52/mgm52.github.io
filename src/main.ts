import { preloadSounds, playSound, setMasterVolume } from './audio';
import {
  AUTOSPAWN_TIERS, CAMERA_SPEED, CELL, DIG, GOBLIN, GOLD_KILL_REWARD, KILL_REWARD, START_CELL,
  SUMMON_UPGRADES, TICK_MS, MINOTAUR,
} from './config';
import { setupInput } from './input';
import { getOptions, onOptionsChange } from './options';
import { setupOptionsUI } from './options-ui';
import { centerCameraOn, clampCamera, createRender, render } from './render';
import { appendLog, cellCenter, createInitialState, destroyBuilding, digDirection, getSpawnCapacity, pushDeathEffect, pushFloater, removeGoblin } from './state';
import { autoAssignAllIdle, spawnMinotaur, tick } from './sim';
import { executeTaskSkip, refreshUI, setupUI } from './ui';

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
        document.fonts.load('16px "Major Mono Display"'),
      ]);
    } catch { /* fall through to fallback fonts */ }
  }
  preloadSounds();
  setMasterVolume(getOptions().volume);
  onOptionsChange((o) => setMasterVolume(o.volume));
  const state = createInitialState();
  const ctx = await createRender(document.getElementById('game')!, state.walls);
  setupInput(state, ctx.app, ctx.uiLayer, ctx.worldLayer, ctx);
  setupOptionsUI(document.getElementById('game')!, {
    onCheatMoney: () => {
      state.money += 100_000;
      appendLog(state, 'Cheat: +Ƶ100,000.');
    },
    onTaskSkip: () => executeTaskSkip(state),
  });
  setupUI(state, {
    onSpawnGoblin: () => {
      if (state.money < GOBLIN.spawnCost) { playSound('error'); return; }
      const cap = getSpawnCapacity(state);
      if (state.spawnQueue.length >= cap) { playSound('error'); return; }
      const used = new Set(state.spawnQueue.map((s) => s.slot));
      let slot = -1;
      for (let i = 0; i < cap; i++) {
        if (!used.has(i)) { slot = i; break; }
      }
      if (slot < 0) return;
      state.money -= GOBLIN.spawnCost;
      state.spawnQueue.push({ remaining: GOBLIN.spawnTime, slot });
      appendLog(state, 'Hatching a goblin...');
    },
    onSummonMinotaur: () => {
      if (state.blood < MINOTAUR.bloodCost) { playSound('error'); return; }
      if (state.minotaurSpawnQueue.length >= MINOTAUR.spawnCapacity) { playSound('error'); return; }
      state.blood -= MINOTAUR.bloodCost;
      state.minotaurSpawnQueue.push({ remaining: MINOTAUR.spawnTime });
      playSound('ritual');
      appendLog(state, 'Minotaur summon ritual begins...');
    },
    onBuyAutoAssign: () => {
      if (state.autoAssignEnabled) return;
      const cost = SUMMON_UPGRADES.autoAssign.bloodCost;
      if (state.blood < cost) { playSound('error'); return; }
      state.blood -= cost;
      state.autoAssignEnabled = true;
      playSound('ritual');
      appendLog(state, 'Autotask unlocked — new goblins route themselves to needy buildings.');
      autoAssignAllIdle(state);
    },
    onBuyAutoSpawn: () => {
      // Buy the next tier in AUTOSPAWN_TIERS. Each click promotes the
      // multiplier 1 → 2 → 4 → 8 → 16 → 32, replacing the previous button.
      const next = AUTOSPAWN_TIERS.find(t => t.multiplier > state.autoSpawnMultiplier);
      if (!next) return;
      if (state.blood < next.bloodCost) { playSound('error'); return; }
      state.blood -= next.bloodCost;
      const wasEnabled = state.autoSpawnEnabled;
      state.autoSpawnMultiplier = next.multiplier;
      if (!wasEnabled) {
        state.autoSpawnEnabled = true;
        state.autoSpawnTimer = SUMMON_UPGRADES.autoSpawn.intervalSeconds / next.multiplier;
      }
      playSound('ritual');
      appendLog(state, next.multiplier === 1
        ? `Autospawn — a goblin hatches every ${SUMMON_UPGRADES.autoSpawn.intervalSeconds}s.`
        : `Autospawn x${next.multiplier} — staggered cadence.`);
    },
    onBuyGoldgoblins: () => {
      if (state.goldgoblinsEnabled) return;
      const cost = SUMMON_UPGRADES.goldgoblins.bloodCost;
      if (state.blood < cost) { playSound('error'); return; }
      state.blood -= cost;
      state.goldgoblinsEnabled = true;
      playSound('ritual');
      appendLog(state, 'Goldgoblins — gold-tinted spawns drop Ƶ250.');
    },
    onBuyGoldgoblinsX10: () => {
      if (!state.goldgoblinsEnabled) return;
      if (state.goldgoblinMultiplier >= SUMMON_UPGRADES.goldgoblinsX10.multiplier) return;
      const cost = SUMMON_UPGRADES.goldgoblinsX10.bloodCost;
      if (state.blood < cost) { playSound('error'); return; }
      state.blood -= cost;
      state.goldgoblinMultiplier = SUMMON_UPGRADES.goldgoblinsX10.multiplier;
      playSound('ritual');
      appendLog(state, 'Goldgoblins x10 — gold drops jump to Ƶ2500.');
    },
    onDig: (dir) => {
      if (state.dugDirections.has(dir)) return;
      if (state.blood < DIG.bloodCost) { playSound('error'); return; }
      const result = digDirection(state, dir);
      if (!result.ok) {
        playSound('error');
        appendLog(state, `Dig ${dir.toUpperCase()} failed: ${result.reason}.`);
        return;
      }
      state.blood -= DIG.bloodCost;
      playSound('ritual');
      appendLog(state, `Dug ${dir.toUpperCase()} — water found.`);
    },
    onKillGoblin: (id: number) => {
      const g = state.goblins.get(id);
      if (!g) return;
      const x = g.pos.x, y = g.pos.y;
      const reward = g.gold
        ? { money: GOLD_KILL_REWARD.money * state.goldgoblinMultiplier, blood: GOLD_KILL_REWARD.blood }
        : KILL_REWARD;
      removeGoblin(state, id);
      state.money += reward.money;
      state.blood += reward.blood;
      state.bloodUnlocked = true;
      // Two stacked floaters so each value gets its own color.
      pushFloater(state, x, y, `+Ƶ${reward.money}`, 0xffd96b, 1.6);
      pushFloater(state, x, y - 14, `+${reward.blood} blood`, 0xff8a8a, 1.6);
      pushDeathEffect(state, x, y);
      playSound('goblin_death', 0.7);
      appendLog(state, `Goblin #${id} killed — +Ƶ${reward.money}, +${reward.blood} blood.`);
    },
    onBuildBuilding: (kind) => {
      state.pendingBuild = state.pendingBuild?.kind === kind ? null : { kind };
    },
    onDestroyBuilding: (id) => {
      destroyBuilding(state, id);
      playSound('destroy', 0.5);
      appendLog(state, `Building #${id} destroyed.`);
    },
  });

  // Center the camera on the middle of the initial play area, not on the
  // hole — the world is now much larger than the playable region.
  const pa = state.playArea;
  centerCameraOn(ctx, ((pa.x0 + pa.x1) / 2) * CELL, ((pa.y0 + pa.y1) / 2) * CELL);

  // ─── WASD camera panning ───────────────────────────────────────────
  const held = new Set<string>();
  const isPanKey = (k: string) =>
    k === 'w' || k === 'a' || k === 's' || k === 'd' ||
    k === 'arrowup' || k === 'arrowdown' || k === 'arrowleft' || k === 'arrowright';
  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (isPanKey(k)) {
      held.add(k);
      // First pan input clears the on-screen hint.
      state.panHintDismissed = true;
      e.preventDefault();
    }
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
