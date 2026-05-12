import { playSound, preloadSounds, setCrackleEnabled, setMasterVolume, setMusicVolume, startBackgroundCrackle, startBackgroundMusic } from './audio';
import {
  AUTOSPAWN_TIERS, CAMERA_SPEED, CELL, GOBLIN, GOLD_KILL_REWARD, KILL_REWARD, RENDER_SCALE, START_CELL,
  SUMMON_UPGRADES, TICK_MS, MINOTAUR, digBloodCost,
} from './config';
import { setupInput } from './input';
import { runIntro } from './intro';
import { getOptions, onOptionsChange } from './options';
import { setupOptionsUI } from './options-ui';
import { centerCameraOn, clampCamera, createRender, render } from './render';
import { appendLog, cellCenter, createInitialState, destroyBuilding, digDirection, getSpawnCapacity, pushDeathEffect, pushFloater, removeGoblin, type GameState } from './state';
import { autoAssignAllIdle, spawnMinotaur, tick } from './sim';
import { executeTaskSkip, refreshUI, setupUI } from './ui';
import { clearSave, formatRelativeTime, loadGame, saveGame } from './save';

// Returns the player's choice — 'resume' if they clicked the resume button,
// 'new' if they clicked the spawn button. The fade-out animation runs in
// parallel; main() can begin state setup as soon as the promise resolves.
//
// Erase Data takes a third path that doesn't resolve: it clears the save,
// fades the content out + back in, and re-renders the screen with just the
// Spawn button. The user then clicks Spawn to start fresh.
function showTitleScreen(savedAt: number | null = null): Promise<'new' | 'resume'> {
  return new Promise<'new' | 'resume'>((resolve) => {
    const screen     = document.getElementById('title-screen');
    const playBtn    = document.getElementById('title-play') as HTMLButtonElement | null;
    const playFill   = document.getElementById('title-play-fill');
    const playLabel  = document.getElementById('title-play-label');
    const resumeBtn  = document.getElementById('title-resume') as HTMLButtonElement | null;
    const resumeFill = document.getElementById('title-resume-fill');
    const resumeMeta = document.getElementById('title-resume-meta');
    const eraseBtn   = document.getElementById('title-erase') as HTMLButtonElement | null;
    const eraseFill  = document.getElementById('title-erase-fill');
    if (!screen || !playBtn || !playFill || !playLabel || !resumeBtn || !resumeFill || !resumeMeta || !eraseBtn || !eraseFill) {
      resolve('new');
      return;
    }
    // Reset state so this can be called repeatedly (debug "Show title screen"
    // button in dev mode reuses the same DOM).
    screen.style.display = 'flex';
    screen.classList.remove('fading-out', 'shown');
    document.documentElement.classList.remove('dev');

    const resetFill = (f: HTMLElement) => {
      f.style.transition = 'none';
      f.style.width = '0%';
      void f.offsetWidth;
    };

    const renderLayout = (haveSave: boolean, savedAtForMeta: number | null) => {
      resumeBtn.hidden = !haveSave;
      eraseBtn.hidden  = !haveSave;
      playBtn.hidden   = haveSave;
      if (haveSave && savedAtForMeta !== null) {
        resumeMeta.textContent = formatRelativeTime(savedAtForMeta);
      }
      playLabel.textContent = 'Spawn';
      resetFill(playFill);
      resetFill(resumeFill);
      resetFill(eraseFill);
      playBtn.disabled = false;
      resumeBtn.disabled = false;
      eraseBtn.disabled = false;
    };

    let resolved = false;
    const finalChoice = (btn: HTMLButtonElement, fill: HTMLElement, choice: 'new' | 'resume') => {
      if (resolved) return;
      resolved = true;
      playBtn.disabled = true; resumeBtn.disabled = true; eraseBtn.disabled = true;
      // Kick the looping background music + vinyl crackle off the same
      // gesture so the browser's autoplay policy lets them through. Crackle
      // starts immediately; music is delayed so the crackle settles in first.
      startBackgroundCrackle(BACKGROUND_CRACKLE_URL);
      setTimeout(() => startBackgroundMusic(BACKGROUND_MUSIC_URL), MUSIC_LEAD_IN_MS);
      const fillDuration = 2000;
      fill.style.transition = `width ${fillDuration}ms linear`;
      requestAnimationFrame(() => { fill.style.width = '100%'; });
      setTimeout(() => {
        screen.classList.remove('shown');
        setTimeout(() => {
          screen.classList.add('fading-out');
          setTimeout(() => { screen.style.display = 'none'; }, 1500);
        }, 1500);
      }, fillDuration);
      resolve(choice);
    };

    const onErase = () => {
      if (resolved) return;
      playBtn.disabled = true; resumeBtn.disabled = true; eraseBtn.disabled = true;
      clearSave();
      // 1400ms matches the .title-content opacity transition. Fade out, swap
      // to the no-save layout, fade back in. Spawn's listener was attached at
      // init so it stays live across the swap.
      screen.classList.remove('shown');
      setTimeout(() => {
        renderLayout(false, null);
        requestAnimationFrame(() => screen.classList.add('shown'));
      }, 1400);
    };

    renderLayout(savedAt !== null, savedAt);
    playBtn.addEventListener('click',   () => finalChoice(playBtn, playFill, 'new'),       { once: true });
    resumeBtn.addEventListener('click', () => finalChoice(resumeBtn, resumeFill, 'resume'), { once: true });
    eraseBtn.addEventListener('click', onErase, { once: true });

    requestAnimationFrame(() => screen.classList.add('shown'));
  });
}

const BACKGROUND_MUSIC_URL = encodeURI('assets/Dmitri Shostakovich String Quartet No. 4 in D major Op.83 1949.mp3');
const BACKGROUND_CRACKLE_URL = 'assets/vinyl_crackle.mp3';
// Crackle gets a head-start so the room "settles" before the quartet enters.
const MUSIC_LEAD_IN_MS = 2000;

// Total time from the title Play/Resume click until the title overlay's
// opacity reaches 0 (game fully faded in). Mirrors the setTimeout chain in
// showTitleScreen — fill (2000) + hold (1500) + screen opacity transition (1400).
const TITLE_FADE_OUT_TOTAL_MS = 2000 + 1500 + 1400;
// Extra beat after the game appears before the first task fades in.
const TASK_REVEAL_AFTER_GAME_VISIBLE_MS = 1000;
// For new games only: how long the player gets to wander and click the empty
// world before the goblin slides up and starts talking.
const PRE_INTRO_FREE_CLICK_MS = 10_000;

const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

async function main() {
  // Production-only title gate. Click here also satisfies the browser's
  // user-gesture requirement so audio can play immediately afterwards.
  // Saved-game lookup happens up-front so the title screen can show the
  // resume button (with relative-time meta) when one exists.
  const saved = import.meta.env.PROD ? loadGame() : null;
  const choicePromise: Promise<'new' | 'resume'> = import.meta.env.PROD
    ? showTitleScreen(saved?.savedAt ?? null)
    : Promise.resolve('new');

  // Kick off font loading in parallel — Pixi (createRender) is the only
  // consumer that needs the glyphs cached before first draw, so we just
  // need this resolved before createRender. DOM text gets display:swap
  // fallback from the @font-face declaration in the meantime, so the
  // sidebar can render immediately without blocking on mobile networks.
  const fontsReady: Promise<unknown> = 'fonts' in document
    ? Promise.all([
        document.fonts.load('16px "New Rocker"'),
        document.fonts.load('16px VT323'),
        document.fonts.load('16px Audiowide'),
        document.fonts.load('16px "Major Mono Display"'),
      ]).catch(() => undefined)
    : Promise.resolve();

  preloadSounds();
  setMasterVolume(getOptions().volume);
  setMusicVolume(getOptions().musicVolume);
  setCrackleEnabled(getOptions().crackleEnabled);
  onOptionsChange((o) => {
    setMasterVolume(o.volume);
    setMusicVolume(o.musicVolume);
    setCrackleEnabled(o.crackleEnabled);
  });

  // Now that sounds are queued, see what the player picked. Resume swaps
  // in the saved state; new game wipes any prior save and starts fresh.
  const choice = await choicePromise;
  // For brand-new games we play the goblin intro before revealing the spawn
  // panel and the first task. The intro: ~10s of free clicking, then the
  // goblin slides up, monologues, slides back out. Resumed games skip it
  // entirely (the player has presumably already met the goblin).
  const introWillPlay = choice === 'new';
  if (introWillPlay) {
    // intro-hold suppresses the spawn panel + (via the existing .revealed
    // gate) the task text. Removed once the intro promise resolves.
    document.body.classList.add('intro-hold');
  }
  // Reveal the first task a beat after the game has faded in (or after the
  // intro for new games). In prod the title overlay is still fading out for
  // ~5s after the click; in dev the game is visible immediately so we only
  // wait the 1s beat.
  const gameVisibleDelayMs = import.meta.env.PROD
    ? TITLE_FADE_OUT_TOTAL_MS
    : 0;
  const revealPanelsAndTask = () => {
    document.body.classList.remove('intro-hold');
    document.getElementById('task-text')?.classList.add('revealed');
  };
  if (introWillPlay) {
    // Wait for the game to be fully visible, then PRE_INTRO_FREE_CLICK_MS of
    // free-click time before the goblin emerges. After the intro resolves
    // we fade in the spawn panel + task on the same beat the intro releases.
    window.setTimeout(async () => {
      await sleep(PRE_INTRO_FREE_CLICK_MS);
      await runIntro();
      revealPanelsAndTask();
    }, gameVisibleDelayMs);
  } else {
    window.setTimeout(revealPanelsAndTask, gameVisibleDelayMs + TASK_REVEAL_AFTER_GAME_VISIBLE_MS);
  }
  let state: GameState;
  if (choice === 'resume' && saved) {
    state = saved.state;
    // Migrate older saves that pre-date firstDugAt/waterSeen. If the player
    // had already dug we kick off the hint timer from "now" so we don't
    // surface the hint forever for a session that never panned.
    if (state.firstDugAt === undefined) {
      state.firstDugAt = state.dugDirections.size > 0 ? state.now : null;
    }
    if (state.waterSeen === undefined) state.waterSeen = false;
  } else {
    clearSave();
    state = createInitialState();
  }
  // Wire up the DOM-only UI (sidebar buttons, options cog, task text) and
  // run one refresh now so the sidebar is fully populated while the title
  // screen is still fading out. Pixi setup (createRender/setupInput) can
  // continue in the background and only blocks canvas interaction.
  setupOptionsUI(document.getElementById('game')!, {
    onCheatMoney: () => {
      state.money += 100_000;
      appendLog(state, 'Cheat: +Ƶ100,000.');
    },
    onTaskSkip: () => executeTaskSkip(state),
    onShowTitleScreen: () => { void showTitleScreen(); },
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
      // Don't allow the multiplier to outrun spawn capacity — the UI
      // already disables the button, but block here too in case it's
      // triggered programmatically.
      if (next.multiplier > getSpawnCapacity(state)) { playSound('error'); return; }
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
      appendLog(state, 'Goldblins — gold-tinted spawns drop Ƶ250.');
    },
    onBuyGoldgoblinsX10: () => {
      if (!state.goldgoblinsEnabled) return;
      if (state.goldgoblinMultiplier >= SUMMON_UPGRADES.goldgoblinsX10.multiplier) return;
      const cost = SUMMON_UPGRADES.goldgoblinsX10.bloodCost;
      if (state.blood < cost) { playSound('error'); return; }
      state.blood -= cost;
      state.goldgoblinMultiplier = SUMMON_UPGRADES.goldgoblinsX10.multiplier;
      playSound('ritual');
      appendLog(state, 'Goldblins x10 — gold drops jump to Ƶ2500.');
    },
    onDig: (dir) => {
      if (state.dugDirections.has(dir)) return;
      const cost = digBloodCost(state.dugDirections.size);
      if (state.blood < cost) { playSound('error'); return; }
      const result = digDirection(state, dir);
      if (!result.ok) {
        playSound('error');
        appendLog(state, `Dig ${dir.toUpperCase()} failed: ${result.reason}.`);
        return;
      }
      state.blood -= cost;
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
      pushFloater(state, x, y, `+Ƶ${reward.money.toLocaleString('en-US')}`, 0xffd96b, 1.6);
      pushFloater(state, x, y - 14, `+${reward.blood} blood`, 0xff8a8a, 1.6);
      pushDeathEffect(state, x, y);
      playSound('goblin_death', 0.56);
      // Bonus cha-ching when the slain goblin was gold-tinted.
      if (g.gold) playSound('cash', 0.7);
      appendLog(state, `Goblin #${id} killed — +Ƶ${reward.money.toLocaleString('en-US')}, +${reward.blood} blood.`);
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
  // Populate task text + show/hide panels now so the sidebar isn't blank
  // under the (still-fading) title screen on slow mobile loads.
  refreshUI(state);

  // Pixi caches glyphs at first text render, so we have to have the fonts
  // loaded before createRender. Until now they've been loading in parallel
  // with the title screen + the sidebar setup above.
  await fontsReady;
  const ctx = await createRender(document.getElementById('game')!, state);
  setupInput(state, ctx.app, ctx.uiLayer, ctx.worldLayer, ctx);

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
      e.preventDefault();
    }
  });
  window.addEventListener('keyup', (e) => {
    const k = e.key.toLowerCase();
    if (isPanKey(k)) held.delete(k);
  });
  // Drop held keys if the window loses focus (otherwise camera "drifts" forever).
  window.addEventListener('blur', () => held.clear());

  // Autosave to localStorage every SAVE_INTERVAL_MS, plus on visibilitychange
  // and pagehide so a closed tab loses at most this much progress.
  const SAVE_INTERVAL_MS = 10_000;
  let saveAcc = 0;
  const flushSave = () => { saveGame(state); saveAcc = 0; };
  window.addEventListener('pagehide', flushSave);
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushSave();
  });

  let acc = 0;
  let last = performance.now();

  // ─── Pause ────────────────────────────────────────────────────────
  // Paused state freezes the tick loop (state.now stops advancing, so all
  // sprite animations also freeze). Render keeps running so the overlay can
  // still be drawn. Pausing flushes a save and surfaces a transient
  // "Game saved" line on the overlay.
  let paused = false;
  const pauseBtn = document.getElementById('pause-btn');
  const pauseOverlay = document.getElementById('pause-overlay');
  const pauseSaved = document.getElementById('pause-saved');
  let savedFadeTimer: number | null = null;
  const setPaused = (p: boolean) => {
    if (p === paused) return;
    paused = p;
    if (paused) {
      flushSave();
      pauseOverlay?.classList.add('visible');
      pauseBtn?.classList.add('paused');
      pauseBtn?.setAttribute('aria-label', 'Resume');
      if (pauseSaved) {
        pauseSaved.classList.add('shown');
        if (savedFadeTimer !== null) window.clearTimeout(savedFadeTimer);
        savedFadeTimer = window.setTimeout(() => pauseSaved.classList.remove('shown'), 2000);
      }
    } else {
      pauseOverlay?.classList.remove('visible');
      pauseBtn?.classList.remove('paused');
      pauseBtn?.setAttribute('aria-label', 'Pause');
      // Reset the rAF accumulator so unpausing doesn't dump a giant dt
      // into the tick loop.
      last = performance.now();
      acc = 0;
    }
  };
  const togglePause = () => setPaused(!paused);
  pauseBtn?.addEventListener('click', (e) => { e.stopPropagation(); togglePause(); });
  pauseOverlay?.addEventListener('click', () => setPaused(false));
  // Capture-phase so we run before input.ts's bubble-phase ESC handler — that
  // way we can tell whether ESC was used to cancel a pending build (input.ts
  // handles it) or to toggle pause (no pending build, we handle it).
  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (e.key === 'Escape') {
      if (state.pendingBuild) return; // input.ts clears the ghost
      togglePause();
    } else if (k === 'p') {
      // Ignore P while typing in an input/select (options panel sliders, etc.)
      const tgt = e.target as HTMLElement | null;
      if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'SELECT' || tgt.tagName === 'TEXTAREA')) return;
      togglePause();
    }
  }, { capture: true });
  function frame(now: number) {
    const dt = now - last;
    last = now;
    if (!paused) {
      acc += dt;
      if (acc > TICK_MS * 10) acc = TICK_MS * 10;
      while (acc >= TICK_MS) {
        tick(state);
        acc -= TICK_MS;
      }
      saveAcc += dt;
      if (saveAcc >= SAVE_INTERVAL_MS) flushSave();
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
    // Pan-hint trigger: once any water source intersects the camera's visible
    // rect, mark `waterSeen` sticky-true. The hint flips off in refreshUI.
    if (!state.waterSeen && state.waterSources.size > 0) {
      const vx0 = ctx.camera.x;
      const vy0 = ctx.camera.y;
      const vx1 = vx0 + ctx.viewport.width / RENDER_SCALE;
      const vy1 = vy0 + ctx.viewport.height / RENDER_SCALE;
      for (const w of state.waterSources.values()) {
        if (w.x1 * CELL > vx0 && w.x0 * CELL < vx1 && w.y1 * CELL > vy0 && w.y0 * CELL < vy1) {
          state.waterSeen = true;
          break;
        }
      }
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
