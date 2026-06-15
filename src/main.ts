import { fadeOutMusicForever, getAudioDebugInfo, playSound, preloadSounds, setCrackleEnabled, setGhostSendGain, setInHellView, setMasterVolume, setMusicDepth, setMusicVolume, startBackgroundCrackle, startBackgroundMusic } from './audio';
import {
  AUTODRAGON_TIERS, AUTOSPAWN_TIERS, CAMERA_SPEED, CELL, DRAGON, GOBLIN, GOLD_KILL_REWARD, HELL, KILL_REWARD, PAIN_GABBONSAW, ROBOT, SOUL_SIGIL,
  START_CELL, SUMMON_UPGRADES, TERMINATOR, TICK_MS, MINOTAUR, WORLD, digBloodCost, minotaurBloodCost,
} from './config';
import { setupInput } from './input';
import { finaleBark, runDemonDialogue, runFinaleConfrontation, runGhostChat } from './demon-dialogue';
import { playIntroSequence, runGabbonsawCutscene, setIntroPaused, skipIntro } from './intro';
import { getOptions, onOptionsChange } from './options';
import { getRestartInHell, relockOptionsCog, setupOptionsUI } from './options-ui';
import { applyDomOptions, centerCameraOn, centerHellCameraOnWorld, centerSpaceCamera, clampCamera, clampHellCamera, clampSpaceCamera, createRender, currentHellScale, preloadRenderAssets, render, spaceCameraMaxY } from './render';
import { appendLog, buildingCenter, cellCenter, countHypercentres, countSpaceCentres, createInitialState, destroyBuilding, digDirection, dragonsAtCap, earnBlood, earnDragonBone, earnMoney, getSpawnCapacity, pushDeathEffect, pushFloater, recordGhost, removeGoblin, type GameState, type Ghost } from './state';
import { autoAssignAllIdle, devSkipFinaleToConfront, devTriggerFinale, maybeDepartBobAndLolly, spawnDragon, spawnLollyRampage, spawnMinotaur, spawnRobot, spawnTinytaur, tick } from './sim';
import { ensureHellPortal, executeSkipToPreFinale, executeTaskSkip, refreshUI, setupUI } from './ui';
import { clearSave, formatRelativeTime, getLastSaveStats, loadGame, saveGame, saveGameInBackground } from './save';
import {
  abandonCardWorldBoot, captureOriginWorld, cardWorldActive, clearCardData, consumeCardHop,
  devResetCardRealm, hasCardMeta, isCardHopInProgress, maybeStartCardRealm, resetCardRealm,
  setupCardWorldChrome, spectateActive,
} from './cards';
import { designerActive, openDesignerList, setupDesignerChrome } from './designer';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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
      // The dev-cog unlock lives in its own localStorage key; clearSave only
      // touches the save itself, so wipe the unlock here too — otherwise an
      // old unlock would survive Erase Data.
      relockOptionsCog();
      // Likewise the trading-card metagame (player cards, the stolen-origin
      // snapshot, the stashed outer save) — all separate keys.
      clearCardData();
      // 900ms matches --title-fade-dur (the .fade-item opacity transition;
      // fade-out has no stagger delay). Fade out, swap to the no-save layout,
      // fade back in. Spawn's listener was attached at init so it stays live
      // across the swap.
      screen.classList.remove('shown');
      setTimeout(() => {
        renderLayout(false, null);
        requestAnimationFrame(() => screen.classList.add('shown'));
      }, 900);
    };

    renderLayout(savedAt !== null, savedAt);
    playBtn.addEventListener('click',   () => finalChoice(playBtn, playFill, 'new'),       { once: true });
    resumeBtn.addEventListener('click', () => finalChoice(resumeBtn, resumeFill, 'resume'), { once: true });
    eraseBtn.addEventListener('click', onErase, { once: true });

    requestAnimationFrame(() => screen.classList.add('shown'));
  });
}

// ─── Debug FPS overlay ───
// Enabled by adding ?fps to the URL (e.g. mgm52.github.io/?fps). Shows the
// frame rate, the average and worst frame time over each half-second window,
// a worst-case breakdown by subsystem (sim ticks / scene sync / DOM ui /
// Pixi's actual GPU submission, plus the unattributed remainder — see
// worstOther below), the active renderer backend, the cost+size
// of the most recent autosave, and the last runtime error — cheap enough to
// leave running while hunting jank on a phone, where devtools aren't handy.
type FrameTimings = { tickMs: number; renderMs: number; uiMs: number };
// Written by the renderer.render patch installed in main() (Pixi renders on
// its own ticker, outside our frame loop, so it has to be sampled here).
let pixiRenderMs = 0;
// e.g. "webgl · 2x · 880×1632" — set once createRender resolves. If this
// ever reads "canvas", Pixi fell back to CPU rasterization and the frame
// rate is doomed regardless of game-side work.
let rendererInfo = '…';
function createFpsHud(): ((now: number, dt: number, t: FrameTimings) => void) | null {
  if (!new URLSearchParams(window.location.search).has('fps')) return null;
  const el = document.createElement('div');
  el.id = 'fps-hud';
  el.style.cssText =
    'position:fixed;top:6px;left:6px;z-index:9999;background:rgba(0,0,0,0.65);'
    + 'color:#8f8;font:12px/1.4 monospace;padding:4px 8px;border-radius:4px;'
    + 'pointer-events:none;white-space:pre;max-width:95vw;overflow:hidden;';
  document.body.appendChild(el);
  // Surface uncaught errors/rejections — on a phone there's no console, and
  // a per-frame throw inside a ticker looks identical to "it's just slow".
  let lastError = '';
  window.addEventListener('error', (e) => { lastError = String(e.message ?? e).slice(0, 80); });
  window.addEventListener('unhandledrejection', (e) => { lastError = String(e.reason ?? e).slice(0, 80); });
  let frames = 0;
  let accMs = 0;
  let worst = 0;
  let worstTick = 0, worstRender = 0, worstUi = 0, worstPixi = 0;
  // Frame time NOT attributed to any instrumented section — style/layout/
  // paint, compositing, GPU stalls, or main-thread work outside the frame
  // loop. When `other` tracks `worst` (and the named sections sit near 0),
  // the bottleneck is browser-side, not game JS — e.g. a CSS filter being
  // re-rasterized — and no amount of game-loop optimization will help.
  let worstOther = 0;
  let windowStart = performance.now();
  return (now: number, dt: number, t: FrameTimings) => {
    frames++;
    accMs += dt;
    if (dt > worst) worst = dt;
    if (t.tickMs > worstTick) worstTick = t.tickMs;
    if (t.renderMs > worstRender) worstRender = t.renderMs;
    if (t.uiMs > worstUi) worstUi = t.uiMs;
    if (pixiRenderMs > worstPixi) worstPixi = pixiRenderMs;
    const other = Math.max(0, dt - t.tickMs - t.renderMs - t.uiMs - pixiRenderMs);
    if (other > worstOther) worstOther = other;
    if (now - windowStart >= 500 && frames > 0) {
      const fps = (frames * 1000) / (now - windowStart);
      const save = getLastSaveStats();
      const saveLine = save
        ? `save ${save.mode === 'worker' ? `${save.compressedKb.toFixed(0)}KB · clone ${save.cloneMs.toFixed(0)}ms · zip ${save.workMs.toFixed(0)}ms` : 'sync'} (${((now - save.at) / 1000).toFixed(0)}s ago)`
        : 'save —';
      el.textContent =
        `${fps.toFixed(0)} fps · avg ${(accMs / frames).toFixed(1)} ms · worst ${worst.toFixed(0)} ms\n`
        + `worst: tick ${worstTick.toFixed(1)} · scene ${worstRender.toFixed(1)} · ui ${worstUi.toFixed(1)} · pixi ${worstPixi.toFixed(1)} ms\n`
        + `${rendererInfo} · other ${worstOther.toFixed(0)}ms\n`
        + `${getAudioDebugInfo()}\n`
        + saveLine
        + (lastError ? `\nERR ${lastError}` : '');
      frames = 0; accMs = 0; worst = 0;
      worstTick = 0; worstRender = 0; worstUi = 0; worstPixi = 0;
      worstOther = 0;
      windowStart = now;
    }
  };
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
// Cheat power surge: a 1 GW boost with an effectively unbounded duration so it
// reads as a permanent grid bump rather than the Lightning Strike's 5s decay.
const CHEAT_POWER_WATTS = 1_000_000_000;
const CHEAT_POWER_SECONDS = 1e9;

async function main() {
  // Apply the DOM-only options (sidebar CSS vars, cut-corner button class)
  // up-front so the title screen's .build-buttons render with the correct
  // shape on first paint — otherwise they pop from rounded to cut-corner
  // only once createRender runs applyOptions after the player clicks.
  // applyOptions inside createRender re-applies these for any later changes.
  applyDomOptions(getOptions());

  // Start downloading/decoding the sprite sheets + building art right away,
  // in parallel with the title screen, so clicking Play/Resume doesn't stall
  // on them (they used to load inside createRender, after the click).
  void preloadRenderAssets();

  // The trading-card realm reaches this boot two ways: inside a card world
  // (the entered card's state sits in the save slot — boot straight into it;
  // the reload WAS the transition), or back on the outer table after leaving
  // one. Explicit enter/leave hops skip the title screen; a cold production
  // load still gets it (it's the audio gesture and the Erase Data access).
  // Once the metagame has begun, dev sessions also resume the save rather
  // than starting fresh, so the realm loop survives its reloads.
  const cardHop = consumeCardHop();
  // Spectated worlds ride the same boot path as entered cards — the slot
  // holds the visited world either way; cards.ts's chrome setup tells the
  // two apart and freezes/locks the spectated one.
  let inCardWorld = cardWorldActive() || spectateActive();
  // The dev World Designer rides the same boot shape as a card world: the
  // sandbox world it's editing sits in the save slot, so it must resume that
  // slot and skip the title — but it mounts its own chrome (setupDesignerChrome)
  // rather than the card-world chrome below.
  const inDesigner = designerActive();
  const metagameBegun = hasCardMeta();

  // Production-only title gate. Click here also satisfies the browser's
  // user-gesture requirement so audio can play immediately afterwards.
  // Saved-game lookup happens up-front so the title screen can show the
  // resume button (with relative-time meta) when one exists.
  let saved = (import.meta.env.PROD || inCardWorld || inDesigner || metagameBegun) ? loadGame() : null;
  if (inCardWorld && !saved) {
    // The card's save is unreadable — restore the outer realm and fall
    // back to a normal boot instead of a broken world.
    abandonCardWorldBoot();
    inCardWorld = false;
    saved = import.meta.env.PROD ? loadGame() : null;
  }
  const skipTitle = (cardHop || !import.meta.env.PROD)
    && (inCardWorld || inDesigner || metagameBegun) && saved !== null;
  // A skipped title must still be DISMISSED: #title-screen defaults to an
  // opaque black cover and only showTitleScreen's click path hides it, so
  // without this a prod card-world hop boots the world fine — behind black.
  if (skipTitle) {
    const titleScreen = document.getElementById('title-screen');
    if (titleScreen) titleScreen.style.display = 'none';
    // The title click was also the audio gesture; after a hop reload there
    // is none, so re-arm the vinyl crackle (the only music left after the
    // finale's fadeOutMusicForever) on the first input instead.
    if (import.meta.env.PROD) {
      window.addEventListener('pointerdown', () => {
        startBackgroundCrackle(BACKGROUND_CRACKLE_URL);
      }, { once: true });
    }
  }
  const choicePromise: Promise<'new' | 'resume'> = skipTitle
    ? Promise.resolve('resume')
    : import.meta.env.PROD
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
  setGhostSendGain(getOptions().hellCommandVolume);
  onOptionsChange((o) => {
    setMasterVolume(o.volume);
    setMusicVolume(o.musicVolume);
    setCrackleEnabled(o.crackleEnabled);
    setGhostSendGain(o.hellCommandVolume);
  });

  // Now that sounds are queued, see what the player picked. Resume swaps
  // in the saved state; new game wipes any prior save and starts fresh.
  // The dev "Restart in hell" checkbox overrides the pick: every reload is
  // a fresh run that rides straight down (devSkipToHell fires post-setup).
  // We still await the title screen first — in prod its click is what
  // satisfies the browser's audio user-gesture requirement.
  const restartInHell = getRestartInHell();
  const picked = await choicePromise;
  // Restart-in-hell never hijacks a card-world boot — the reload into a card
  // must land inside that card.
  const choice = restartInHell && !skipTitle ? 'new' : picked;
  // For brand-new games we play the goblin intro before revealing the spawn
  // panel and the first task. The intro: ~10s of free clicking, then the
  // goblin slides up, monologues, slides back out. Resumed games skip it
  // entirely (the player has presumably already met the goblin) — as do
  // restart-in-hell runs, which would cut it off mid-descent anyway.
  const introWillPlay = choice === 'new' && !restartInHell;
  if (introWillPlay) {
    // intro-hold suppresses the spawn panel + (via the existing .revealed
    // gate) the task text. Removed once the intro promise resolves. Purely
    // visual: the tick freeze is intro-cutscene-hold, set by intro.ts only
    // while the goblin is face-to-face with the player.
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
    // Once the game is fully visible, hand off to the intro sequence: a
    // free-click preamble, the goblin cutscene, then the staggered panel/task
    // reveals. The dev "Work skip" button can skip the whole thing.
    window.setTimeout(() => {
      void playIntroSequence({
        onSummonReveal: () => document.body.classList.remove('intro-hold'),
        onTaskReveal: () => document.getElementById('task-text')?.classList.add('revealed'),
      });
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
    if (state.cameraPanSeen === undefined) state.cameraPanSeen = false;
  } else {
    clearSave();
    state = createInitialState();
  }
  // Inside a card world: the white screen border + the LEAVE WORLD button
  // (which serializes the world back onto its card and returns to the table).
  // An explicit hop also plays the arrival zoom — the world swelling out of
  // the white the player just dove into.
  if (inCardWorld) setupCardWorldChrome(state, cardHop);
  // In the dev World Designer: mount the top authoring bar instead. The
  // sandbox world resumed above is already task-free + fully unlocked
  // (makeSandboxWorld), so the standard sidebar places everything.
  else if (inDesigner) setupDesignerChrome(state);
  // Dev shortcut: ?cardrealm mounts the trading-card realm immediately,
  // without playing the finale first. Flush the just-booted world into the
  // save slot first — entering a card stashes the slot as the outer world,
  // and on a fresh dev boot the slot is empty (see onSkipToCardRealm).
  if (!import.meta.env.PROD && new URLSearchParams(window.location.search).has('cardrealm')) {
    saveGame(state);
    maybeStartCardRealm();
  }
  // Dev shortcut: ?designer opens the World Designer list straight away (unless
  // we already booted into a designer session, which mounts its own chrome).
  if (new URLSearchParams(window.location.search).has('designer') && !inDesigner) {
    openDesignerList();
  }
  // Dev cheat flag: set by the options menu's "skip to hell" button,
  // consumed at the top of the frame loop (where the transition state lives).
  let requestSkipToHell = false;
  // The "skip to hell" cheat — also fired at startup by the "Restart in
  // hell" checkbox. Conjures an active Hell Portal if none exists, stocks
  // the underworld, then rides the beam straight down. Only meaningful from
  // the ground view (transitions are ground↔space / ground↔hell).
  const devSkipToHell = () => {
    // Cut the goblin intro short first so a fresh session isn't left
    // descending behind the cutscene's input hold.
    skipIntro();
    if (state.view !== 'ground') return;
    // Skip enough of the work chain that candles are usable on arrival —
    // placement needs blood unlocked and at least one candle's worth. On a
    // fresh run that's two skips (earn_100, then run_phone_farm); a run
    // that's already mid-game may need none. Then top the pool up to a full
    // sigil's worth (five candles) so the ritual is actually completable.
    for (let i = 0; i < 8 && !(state.bloodUnlocked && state.blood >= SOUL_SIGIL.candleBloodCost); i++) {
      executeTaskSkip(state);
    }
    state.blood = Math.max(state.blood, SOUL_SIGIL.candleBloodCost * SOUL_SIGIL.count);
    if (!ensureHellPortal(state)) {
      appendLog(state, 'Cheat: nowhere to fit a Hell Portal.');
      return;
    }
    // Stock the underworld so the drop-in lands somewhere lived-in. Ghost
    // hell coords are world coords shifted by the hell offset, so spawning
    // around the portal's world centre scatters them around its abyssal
    // mirror — right where the descent deposits the camera.
    const portal = [...state.buildings.values()].find((b) => b.kind === 'hell_portal' && b.state !== 'constructing');
    const pc = portal ? buildingCenter(portal) : { x: WORLD.width / 2, y: WORLD.height / 2 };
    // Bob waits below — the demons' best material is written for him. A
    // living Bob is claimed by the descent (his soul records where he
    // stood); a never-summoned Bob gets his ghost conjured by the mirror.
    // Unless he's already slipped out of hell with Lolly — then he stays gone.
    if (!state.bobLollyDeparted && !state.ghosts.some((g) => g.bob)) {
      const liveBob = [...state.goblins.values()].find((g) => g.bob);
      if (liveBob) {
        recordGhost(state, 'goblin', liveBob.pos.x, liveBob.pos.y, liveBob.facing, { bob: true });
        removeGoblin(state, liveBob.id);
      } else {
        recordGhost(state, 'goblin', pc.x + 120, pc.y + 420, Math.PI / 2, { bob: true, quiet: true });
      }
      // Bob's already below — the building-placement cutscene never re-offers.
      state.bobSpawned = true;
    }
    // A drifting crowd to parlay/seat/chat with: mostly goblins, a few
    // minotaurs, a couple of dragons. Only when hell is near-empty so
    // repeated skips don't pile up an army.
    if (state.ghosts.filter((g) => !g.bob).length < 5) {
      const crowd: Ghost['kind'][] = [
        ...Array<Ghost['kind']>(12).fill('goblin'),
        'minotaur', 'minotaur', 'minotaur',
        'dragon', 'dragon',
      ];
      for (const kind of crowd) {
        recordGhost(
          state, kind,
          pc.x + (Math.random() - 0.5) * 1400,
          pc.y - 200 - Math.random() * 900,
          Math.random() * Math.PI * 2,
          { quiet: true },
        );
      }
    }
    appendLog(state, 'Cheat: descending into hell.');
    state.devSkippedToHell = true;
    requestSkipToHell = true;
  };
  // Wire up the DOM-only UI (sidebar buttons, options cog, task text) and
  // run one refresh now so the sidebar is fully populated while the title
  // screen is still fading out. Pixi setup (createRender/setupInput) can
  // continue in the background and only blocks canvas interaction.
  setupOptionsUI(document.getElementById('game')!, {
    onCheatMoney: () => {
      state.money += 1_000_000;
      appendLog(state, 'Cheat: +Ƶ1,000,000.');
    },
    onCheatBlood: () => {
      state.blood += 1000;
      state.bloodUnlocked = true;
      appendLog(state, 'Cheat: +1,000 blood.');
    },
    onCheatPower: () => {
      state.powerBoosts.push({ startAt: state.now, peak: CHEAT_POWER_WATTS, duration: CHEAT_POWER_SECONDS });
      appendLog(state, 'Cheat: +1 GW power.');
    },
    onCheatBones: () => {
      earnDragonBone(state, 100);
      state.dragonBoneUnlocked = true;
      appendLog(state, 'Cheat: +100 dragon bones.');
    },
    onTriggerBob: () => {
      // Re-arm the cutscene for the next building placement, regardless of
      // the 10-minute playtime threshold or whether Bob has been spawned before.
      state.bobSpawned = false;
      state.bobPickingHole = false;
      state.bobCheatPending = true;
      appendLog(state, 'Cheat: Bob will appear on your next building placement.');
    },
    onSkipToHell: devSkipToHell,
    onTaskSkip: () => { skipIntro(); executeTaskSkip(state); },
    onShowTitleScreen: () => { void showTitleScreen(); },
    onSkipToPreFinale: () => {
      skipIntro();
      if (state.view !== 'ground') quickTravel('ground');
      executeSkipToPreFinale(state);
    },
    onTriggerFinale: () => {
      skipIntro();
      if (state.view !== 'ground') quickTravel('ground');
      resetFinaleGuards();
      devTriggerFinale(state);
      appendLog(state, 'Cheat: finale loosed.');
    },
    onSkipToConfront: () => {
      skipIntro();
      if (state.view !== 'ground') quickTravel('ground');
      resetFinaleGuards();
      devSkipFinaleToConfront(state);
      appendLog(state, 'Cheat: skipped to the moon confrontation.');
    },
    onSkipToCardRealm: () => {
      skipIntro();
      // The realm's first card is the world the finale would have stolen —
      // snapshot the live state to stand in for the missing ritual. Then
      // flush the live world into the save slot: entering a card stashes
      // the SLOT as the outer world, and unlike the real post-finale flow
      // the slot here may be empty (fresh run) or a stale autosave — and an
      // empty stash would let the card world replace the main game on the
      // way back out. Then mount the realm over everything (it brings its
      // own white).
      captureOriginWorld(state);
      saveGame(state);
      resetCardRealm();
      maybeStartCardRealm();
    },
    onResetCardRealm: () => { devResetCardRealm(); },
    onLaunchWorldDesigner: () => openDesignerList(),
  });
  // "Restart in hell": this run started fresh (choice forced to 'new'), so
  // ride straight down. The flag just queues requestSkipToHell — the frame
  // loop consumes it once everything below has finished setting up.
  if (restartInHell) devSkipToHell();
  // Error-beep fatigue on the spawn button: a player hammering Spawn while
  // broke (or with the queue full) hears the error for the first three
  // refusals in a row, then it goes quiet until a spawn actually succeeds.
  // Ephemeral by design — not saved, resets with the session.
  let spawnErrorStreak = 0;
  const spawnError = () => {
    spawnErrorStreak++;
    if (spawnErrorStreak <= 3) playSound('error');
  };
  setupUI(state, {
    onSpawnGoblin: () => {
      if (state.money < GOBLIN.spawnCost) { spawnError(); return; }
      const cap = getSpawnCapacity(state);
      if (state.spawnQueue.length >= cap) { spawnError(); return; }
      const used = new Set(state.spawnQueue.map((s) => s.slot));
      let slot = -1;
      for (let i = 0; i < cap; i++) {
        if (!used.has(i)) { slot = i; break; }
      }
      if (slot < 0) return;
      spawnErrorStreak = 0;
      state.money -= GOBLIN.spawnCost;
      state.spawnQueue.push({ remaining: GOBLIN.spawnTime, slot });
      appendLog(state, 'Hatching a goblin...');
    },
    onSummonMinotaur: () => {
      const cost = minotaurBloodCost(state.minotaursBought, state.minotaurFirstDiscount);
      if (state.blood < cost) { playSound('error'); return; }
      if (state.minotaurSpawnQueue.length >= MINOTAUR.spawnCapacity) { playSound('error'); return; }
      state.blood -= cost;
      state.minotaursBought++;
      state.minotaurSpawnQueue.push({ remaining: MINOTAUR.spawnTime });
      playSound('ritual');
      appendLog(state, 'Minotaur summon ritual begins...');
    },
    onSummonTinytaur: () => {
      if (!state.tinytaurUnlocked) { playSound('error'); return; }
      // Costs TINYTAUR.minotaurCost living Minotaurs, who die on spawn — the
      // sacrifice, spawn, and ritual sound all happen inside spawnTinytaur,
      // which no-ops (returning false) if there aren't enough Minotaurs.
      if (!spawnTinytaur(state)) { playSound('error'); return; }
    },
    onSummonDragon: () => {
      // The simultaneous-spawn-queue cap equals the number of currently-active
      // Dragon Beacons — like Goblin Holes for goblins, beacons gate how many
      // dragons can be mid-ritual at once. The overworld also holds at most
      // DRAGON.maxInPlayPerBeacon dragons per active Beacon (live + mid-ritual);
      // a dragon flying off to space frees a slot.
      let activeBeacons = 0;
      for (const b of state.buildings.values()) {
        if (b.kind === 'dragon_beacon' && b.state === 'active') activeBeacons++;
      }
      if (activeBeacons === 0) { playSound('error'); return; }
      if (state.blood < DRAGON.bloodCost) { playSound('error'); return; }
      if (state.dragonSpawnQueue.length >= activeBeacons) { playSound('error'); return; }
      if (dragonsAtCap(state)) { playSound('error'); return; }
      state.blood -= DRAGON.bloodCost;
      state.dragonSpawnQueue.push({ remaining: DRAGON.spawnTime });
      playSound('ritual');
      appendLog(state, 'Dragon summon ritual begins...');
    },
    onSummonRobot: () => {
      // Gated on the late-game industrial base; costs money up front and
      // assembles on a timed track like the other summons (the queue in
      // sim.ts retries if every hole exit is blocked when assembly finishes).
      if (countHypercentres(state) < ROBOT.hypercentresRequired) { playSound('error'); return; }
      if (state.money < ROBOT.moneyCost) { playSound('error'); return; }
      if (state.robotSpawnQueue.length >= ROBOT.spawnCapacity) { playSound('error'); return; }
      state.money -= ROBOT.moneyCost;
      state.robotSpawnQueue.push({ remaining: ROBOT.spawnTime });
      // Robotic sting right at queue time, à la the Minotaur's ritual sound —
      // the bar completing is silent (the assembled robot just walks out).
      playSound('online', 0.7, 1.8);
      appendLog(state, 'Robot assembly begins...');
    },
    onSummonTerminator: () => {
      // Collect-blood reward. Demands an orbital industrial base (2 Space
      // Centres) and costs serious money; assembles on its own single-slot
      // track. The chassis comes out hunting — see the terminator pass in sim.
      if (countSpaceCentres(state) < TERMINATOR.spaceCentresRequired) { playSound('error'); return; }
      if (state.money < TERMINATOR.moneyCost) { playSound('error'); return; }
      if (state.terminatorSpawnQueue.length >= TERMINATOR.spawnCapacity) { playSound('error'); return; }
      state.money -= TERMINATOR.moneyCost;
      state.terminatorSpawnQueue.push({ remaining: TERMINATOR.spawnTime });
      // The robot sting, dragged lower — something heavier is being built.
      playSound('online', 0.8, 1.2);
      appendLog(state, 'Terminator assembly begins...');
    },
    onSetAutoSpawnLevel: (multiplier: number) => {
      // Lilly's prevent-spawning reward: throttle autospawn to any owned
      // tier, or 0 (paused). Clamped so a stale slider can't outrun the
      // purchased maximum.
      state.autoSpawnLevel = Math.max(0, Math.min(state.autoSpawnMultiplier, multiplier));
    },
    onSetTerminating: (on: boolean) => {
      // The terminating slider under the Terminator button — one switch for
      // the whole chassis line. Off: terminators stand down (any in-flight
      // shot finishes, then they idle). The slider's power cues play in ui.ts.
      if (state.terminatorsTerminating === on) return;
      state.terminatorsTerminating = on;
      appendLog(state, on
        ? 'Terminators resume the hunt.'
        : 'Terminators stand down.');
    },
    onBuyAutoDragon: () => {
      // Lilly's destroy-a-robot reward, levelling through AUTODRAGON_TIERS
      // like Autospawn. Each tier demands as many active Dragon Beacons as
      // its multiplier — a beacon supports exactly one simultaneous ritual.
      // The per-spawn DRAGON.bloodCost still applies on each fire.
      const next = AUTODRAGON_TIERS.find((t) => t.multiplier > state.autoDragonMultiplier);
      if (!next) return;
      if (state.blood < next.bloodCost) { playSound('error'); return; }
      let activeBeacons = 0;
      for (const b of state.buildings.values()) {
        if (b.kind === 'dragon_beacon' && b.state === 'active') activeBeacons++;
      }
      if (next.multiplier > activeBeacons) { playSound('error'); return; }
      state.blood -= next.bloodCost;
      state.autoDragonMultiplier = next.multiplier;
      if (!state.autoDragonEnabled) {
        state.autoDragonEnabled = true;
        state.autoDragonTimer = 0;
      }
      playSound('ritual');
      const cadence = SUMMON_UPGRADES.autoDragon.intervalSeconds / next.multiplier;
      appendLog(state, next.multiplier === 1
        ? `Autodragon unlocked — a dragon ritual begins every ${cadence}s while blood and beacons allow.`
        : `Autodragon x${next.multiplier} — a ritual every ${cadence}s while blood and beacons allow.`);
    },
    onQuickTravel: (view: 'ground' | 'hell' | 'space') => quickTravel(view),
    onPlaceOrbital: () => {
      // Toggle Orbital Platform placement (space view only — the button is
      // hidden elsewhere); arming it cancels any other pending mode.
      state.pendingOrbital = !state.pendingOrbital;
      if (state.pendingOrbital) {
        state.pendingBuild = null;
        state.pendingStrike = false;
        state.pendingCandle = false;
        state.pendingSpaceCentre = false;
      }
    },
    onPlaceSpaceCentre: () => {
      // Toggle Space Centre placement (space view only — the button is hidden
      // elsewhere); arming it cancels any other pending mode. The next tap
      // must land on a completed Orbital Platform.
      state.pendingSpaceCentre = !state.pendingSpaceCentre;
      if (state.pendingSpaceCentre) {
        state.pendingBuild = null;
        state.pendingStrike = false;
        state.pendingCandle = false;
        state.pendingOrbital = false;
      }
    },
    onBuyAutoAssign: () => {
      if (state.autoAssignEnabled) return;
      const cost = SUMMON_UPGRADES.autoAssign.bloodCost;
      if (state.blood < cost) { playSound('error'); return; }
      state.blood -= cost;
      state.autoAssignEnabled = true;
      playSound('ritual');
      appendLog(state, 'Autobuild unlocked — new goblins route themselves to needy buildings.');
      autoAssignAllIdle(state);
    },
    onBuyAutoWater: () => {
      if (state.autoWaterEnabled) return;
      if (!state.autoAssignEnabled) { playSound('error'); return; }
      const cost = SUMMON_UPGRADES.autoWater.bloodCost;
      if (state.blood < cost) { playSound('error'); return; }
      state.blood -= cost;
      state.autoWaterEnabled = true;
      playSound('ritual');
      appendLog(state, 'Autowater unlocked — idle goblins route themselves onto watering duty.');
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
      // Each purchase re-pins the throttle (Lilly's prevent-spawning reward
      // slider) to the new maximum — buying a tier means wanting it running.
      state.autoSpawnLevel = next.multiplier;
      if (!wasEnabled) {
        state.autoSpawnEnabled = true;
        state.autoSpawnTimer = SUMMON_UPGRADES.autoSpawn.intervalSeconds / next.multiplier;
      }
      playSound('ritual');
      appendLog(state, next.multiplier === 1
        ? `Autospawn — a goblin hatches every ${SUMMON_UPGRADES.autoSpawn.intervalSeconds}s.`
        : `Autospawn x${next.multiplier} — staggered cadence.`);
    },
    onBuyPainGabbonsaw: () => {
      // The demo's true closing ritual. One-shot: the bones are spent and the
      // ritual channels on a summon bar like any other unit; when the bar
      // completes (sim tick) Bob slides back up for one last word (and the
      // anagram reveal), and once he's walked off screen Lolly spawns — with
      // Bob riding on top — to destroy everything. The button survives as a
      // greyed-out "owned" trophy (refreshUI). The cutscene handoff lives in
      // the game loop (gabbonsawCutscenePending).
      if (state.gabbonsawBought || state.gabbonsawRitualRemaining !== null) return;
      if (state.dragonBone < PAIN_GABBONSAW.dragonBoneCost) { playSound('error'); return; }
      // Snapshot the world as it stands — before even the bones are spent.
      // The trading-card realm (cards.ts) deals this state back to the player
      // after the finale as their own world's card.
      captureOriginWorld(state);
      state.dragonBone -= PAIN_GABBONSAW.dragonBoneCost;
      state.gabbonsawRitualRemaining = PAIN_GABBONSAW.spawnTime;
      playSound('ritual', 1, 0.4);
      appendLog(state, 'The pain gabbonsaw ritual begins...');
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
      // Robots can't die — the kill button just bounces off the chassis.
      if (g.robot) { playSound('error'); return; }
      const x = g.pos.x, y = g.pos.y;
      const reward = g.gold
        ? { money: GOLD_KILL_REWARD.money * state.goldgoblinMultiplier, blood: GOLD_KILL_REWARD.blood }
        : KILL_REWARD;
      recordGhost(state, 'goblin', x, y, g.facing, { gold: g.gold, bob: g.bob });
      removeGoblin(state, id);
      earnMoney(state, reward.money);
      earnBlood(state, reward.blood);
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
    onLightningStrike: () => {
      // Cooldown blocks re-entering aim mode; an already-armed strike can still
      // be cancelled (toggle off) so the player isn't stuck in aim if they
      // armed before realising the cooldown was active.
      if (state.lightningStrikeCooldown > 0 && !state.pendingStrike) {
        playSound('error');
        return;
      }
      // Toggle aim mode; entering it cancels any pending building placement.
      state.pendingStrike = !state.pendingStrike;
      if (state.pendingStrike) state.pendingBuild = null;
    },
    onBuildBuilding: (kind) => {
      state.pendingBuild = state.pendingBuild?.kind === kind ? null : { kind };
      if (state.pendingBuild) { state.pendingStrike = false; state.pendingCandle = false; }
    },
    onPlaceCandle: () => {
      // Toggle hell candle-placement mode; entering it cancels any pending
      // build/strike (none of which can fire in hell anyway, but stay tidy).
      state.pendingCandle = !state.pendingCandle;
      if (state.pendingCandle) { state.pendingBuild = null; state.pendingStrike = false; }
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
  const fpsHud = createFpsHud();
  // Scratch object reused every frame by the HUD instrumentation (only
  // written when the HUD is active). tickMs is left at its previous value on
  // frames where the sim is held (pause/intro) — harmless for a debug HUD.
  const frameTimings: FrameTimings = { tickMs: 0, renderMs: 0, uiMs: 0 };

  const ctx = await createRender(document.getElementById('game')!, state);
  setupInput(state, ctx.app, ctx.uiLayer, ctx.worldLayer, ctx);

  // HUD-only: report which backend Pixi actually picked (webgl / webgpu /
  // canvas — the last one is CPU rasterization and would explain a uniform
  // sub-10fps regardless of game-side work), and time the real render pass.
  // Pixi renders on its own ticker, outside our frame loop below, so none of
  // the frame-loop timings cover it; wrap renderer.render to capture it.
  if (fpsHud) {
    const renderer = ctx.app.renderer;
    rendererInfo = `${renderer.name} · ${renderer.resolution}x · ${ctx.app.canvas.width}×${ctx.app.canvas.height}`;
    const target = renderer as unknown as { render: (...args: unknown[]) => unknown };
    const orig = target.render.bind(renderer);
    target.render = (...args: unknown[]) => {
      const t0 = performance.now();
      const out = orig(...args);
      pixiRenderMs = performance.now() - t0;
      return out;
    };
  }

  // Dev-only debug handle for manual + automated testing. Stripped from
  // production builds (import.meta.env.DEV is false there). skipIntro lets
  // test scripts cut the new-game intro short — left running, it re-freezes
  // the tick loop (intro-cutscene-hold) when the goblin turns to face the
  // player, stalling any sim-driven checks in flight at that moment.
  if (import.meta.env.DEV) {
    (window as Window & { __game?: unknown }).__game = { state, ctx, spawnDragon, spawnMinotaur, spawnRobot, skipIntro };
  }

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

  // ─── Space-view climb state ─────────────────────────────────────────
  // Hold ↑ at the very top of the map (once a building has reached space) to
  // ascend; hold ↓ at the bottom of the space scene to return. The climb eases
  // through ctx.altitude (0 ground … 1 space) over SPACE_TRANS_MS.
  const SPACE_TRANS_MS = 2600;
  const SPACE_HOLD_MS = 350;
  let transitioning = false;
  let transFrom = 0, transTo = 0, transStart = 0;
  let ascendHold = 0, descendHold = 0;
  const ascendHint = document.getElementById('ascend-hint');
  const descendHint = document.getElementById('descend-hint');

  // ─── Hell-view descent state ────────────────────────────────────────
  // Mirror of the space-climb pair. Hold ↓ at the bottom of the map (once a
  // Hell Portal exists) to descend; hold ↑ at the top of hell to rise back
  // out. ctx.depth eases 0 → 1 over HELL_TRANS_MS, and on arrival ctx.hellZoom
  // eases 0 → 1 over HELL.zoomMs to reveal the larger area. Reverse on return.
  const HELL_TRANS_MS = 2600;
  let hellTransitioning = false;
  let hellTransFrom = 0, hellTransTo = 0, hellTransStart = 0;
  let hellZooming = false;
  let hellZoomFrom = 0, hellZoomTo = 0, hellZoomStart = 0;
  // Duration of the current zoom ease. The arrival zoom-out is deliberately
  // slower (50% longer) than the return zoom-in so the reveal lands gently.
  let hellZoomDuration = HELL.zoomMs;
  // World-coord focus point the zoom-out should pivot around — keeps the
  // landing spot under the camera as the scale eases out and the same spot
  // under the camera on the return zoom-in too.
  let hellZoomFocusX = 0, hellZoomFocusY = 0;
  let descendHellHold = 0, ascendHellHold = 0;
  const descendHellHint = document.getElementById('descend-hell-hint');
  const ascendHellHint = document.getElementById('ascend-hell-hint');

  // ─── Transition triggers ────────────────────────────────────────────
  // Each kicks off one of the four ground↔space / ground↔hell transitions.
  // Reached both from the hold-key logic in the frame loop and from tapping
  // the on-screen hint (the only way to navigate on a touch device with no
  // arrow keys).
  function triggerAscendToSpace(now: number) {
    centerSpaceCamera(ctx);
    ctx.spaceCamera.y = 0; clampSpaceCamera(ctx);  // arrive looking down from the top
    transitioning = true; transFrom = 0; transTo = 1; transStart = now; ascendHold = 0;
    state.view = 'space';
    state.viewTransitioning = true;
    state.pendingBuild = null; state.pendingStrike = false; state.pendingCandle = false;
    playSound('ritual', 0.7, 0.5);
    playSound('online', 0.5, 0.3);
  }
  function triggerDescendToSurface(now: number) {
    transitioning = true; transFrom = 1; transTo = 0; transStart = now; descendHold = 0;
    state.viewTransitioning = true;
    state.pendingOrbital = false;
    state.pendingSpaceCentre = false;
    playSound('ritual', 0.6, 0.6);
  }
  function triggerDescendToHell(now: number) {
    // Center hell on the overworld area (the centre of the world mapped into
    // hell space), fully zoomed in, so arrival always frames the region that
    // mirrors the surface. The zoom-out reveal pivots around this same point.
    ctx.hellZoom = 0;
    hellZoomFocusX = WORLD.width / 2;
    hellZoomFocusY = WORLD.height / 2;
    centerHellCameraOnWorld(ctx, hellZoomFocusX, hellZoomFocusY);
    hellTransitioning = true; hellTransFrom = 0; hellTransTo = 1; hellTransStart = now;
    descendHellHold = 0;
    state.view = 'hell';
    state.viewTransitioning = true;
    state.pendingBuild = null; state.pendingStrike = false; state.pendingCandle = false;
    playSound('ritual', 0.6, 0.6);
  }
  function triggerAscendFromHell(now: number) {
    // On return: pivot the zoom-in around whatever world spot is currently at
    // the centre of the hell viewport. Then reverse the descent transition.
    const scale = currentHellScale(ctx);
    const hellCenterX = ctx.hellCamera.x + ctx.viewport.width / (2 * scale);
    const hellCenterY = ctx.hellCamera.y + ctx.viewport.height / (2 * scale);
    hellZoomFocusX = hellCenterX - (HELL.width - WORLD.width) / 2;
    hellZoomFocusY = hellCenterY - (HELL.height - WORLD.height) / 2;
    hellZooming = true; hellZoomFrom = ctx.hellZoom; hellZoomTo = 0; hellZoomStart = now;
    hellZoomDuration = HELL.zoomMs;
    hellTransitioning = true; hellTransFrom = 1; hellTransTo = 0; hellTransStart = now;
    ascendHellHold = 0;
    state.viewTransitioning = true;
    state.pendingCandle = false;
    playSound('ritual', 0.7, 0.5);
  }

  // ─── Quick travel (Lilly's fully-feed reward) ───────────────────────
  // The strip of Earth / Hell / Space buttons left of the sidebar (see
  // index.html + refreshUI's gating). Unlike the held-edge transitions above,
  // travel is instant under a ~0.3s black blink: fade to black, snap every
  // transition variable to the destination's settled values, fade back.
  const quickTravelFadeEl = document.getElementById('quick-travel-fade');
  let quickTravelBusy = false;
  function quickTravel(view: 'ground' | 'hell' | 'space'): void {
    if (quickTravelBusy || state.view === view) return;
    // Respect every world-freeze: cutscenes, parlays, celebrations, Bob's
    // hole-picker. Mid-flight transitions are fine — they get snapped.
    if (document.body.classList.contains('intro-cutscene-hold')
        || document.body.classList.contains('bob-cutscene-hold')
        || document.body.classList.contains('demon-parlay-hold')
        || document.body.classList.contains('bob-spawn-hold')
        || document.body.classList.contains('unlock-reveal-hold')
        || document.body.classList.contains('finale-hold')
        || state.bobPickingHole) return;
    if (view === 'hell' && !state.hellUnlocked) { playSound('error'); return; }
    if (view === 'space' && !state.spaceUnlocked) { playSound('error'); return; }
    // First hop ever — retires the strip's fresh-unlock attention pulse.
    state.quickTravelUsed = true;
    quickTravelBusy = true;
    playSound('ritual', 0.55, view === 'hell' ? 0.6 : 0.9);
    if (quickTravelFadeEl) quickTravelFadeEl.style.opacity = '1';
    window.setTimeout(() => {
      // Cancel any in-flight climb/descent and land fully settled.
      transitioning = false;
      hellTransitioning = false;
      hellZooming = false;
      ascendHold = descendHold = descendHellHold = ascendHellHold = 0;
      state.viewTransitioning = false;
      if (view === 'space') {
        ctx.depth = 0;
        ctx.altitude = 1;
        centerSpaceCamera(ctx);
        ctx.spaceCamera.y = 0; clampSpaceCamera(ctx);  // arrive looking down from the top
      } else if (view === 'hell') {
        ctx.altitude = 0;
        ctx.depth = 1;
        // Arrive already zoomed out, centred on the region mirroring the surface.
        ctx.hellZoom = 1;
        centerHellCameraOnWorld(ctx, WORLD.width / 2, WORLD.height / 2);
      } else {
        ctx.altitude = 0;
        ctx.depth = 0;
      }
      state.view = view;
      // Placement/aim modes don't survive a change of world.
      state.pendingBuild = null; state.pendingStrike = false; state.pendingCandle = false;
      state.pendingOrbital = false; state.pendingSpaceCentre = false;
      if (quickTravelFadeEl) quickTravelFadeEl.style.opacity = '0';
      quickTravelBusy = false;
    }, 160);
  }

  // On a touch device there are no arrow keys to hold, so let a tap on the
  // (already edge-gated) hint fire the same transition. The `.visible` class is
  // toggled by the frame loop precisely when the move is allowed, so gating on
  // it keeps taps in lockstep with the hold-key path.
  const tapHint = (el: HTMLElement | null, trigger: (now: number) => void) => {
    el?.addEventListener('click', () => {
      if (!el.classList.contains('visible')) return;
      trigger(performance.now());
    });
  };
  tapHint(ascendHint, triggerAscendToSpace);
  tapHint(descendHint, triggerDescendToSurface);
  tapHint(descendHellHint, triggerDescendToHell);
  tapHint(ascendHellHint, triggerAscendFromHell);

  // ─── Finale driver ──────────────────────────────────────────────────
  // The cinematic's world-simulation lives in sim.ts (updateFinale); this
  // handles the parts that need the DOM: the scripted barks fired on phase
  // transitions, and the closing confrontation + screen-shatter, which freeze
  // the world and pull the player back to the surface to watch.
  let finaleLastPhase: string | null = null;
  let finaleBarkedStay = false;
  let finaleBarkedCheck = false;
  let finaleConfrontStarted = false;
  // The white-out, on <body> so the big #app zoom never shrinks it.
  let finaleWhiteEl: HTMLElement | null = null;
  let finaleEndApplied = false;
  const finaleWhite = (): HTMLElement => {
    if (!finaleWhiteEl) {
      finaleWhiteEl = document.createElement('div');
      finaleWhiteEl.id = 'finale-white';
      document.body.appendChild(finaleWhiteEl);
    }
    return finaleWhiteEl;
  };
  // Reset the once-per-run guards so a dev re-trigger replays the cinematic
  // cleanly (the white-out + zoom are also cleared).
  const resetFinaleGuards = () => {
    finaleLastPhase = null;
    finaleBarkedStay = finaleBarkedCheck = finaleConfrontStarted = finaleEndApplied = false;
    document.body.classList.remove('finale-hold');
    document.getElementById('app')?.classList.remove('finale-glitch', 'finale-zoom');
    if (finaleWhiteEl) { finaleWhiteEl.style.transition = 'none'; finaleWhiteEl.style.opacity = '0'; }
    // The trading-card realm mounts over the held white-out; a dev re-trigger
    // replays the cinematic, so pull the realm back down with it.
    resetCardRealm();
  };

  // The smash: Bob takes the moon, breaks it, and the world tears itself white.
  async function runFinaleShatter() {
    const F = state.finale;
    if (!F) return;
    const appEl = document.getElementById('app');
    const white = finaleWhite();
    // Bob turns to the moon resting between them and winds up his swing.
    if (F.moon) {
      F.bobFacing = Math.atan2(F.moon.pos.y - F.bobPos.y, F.moon.pos.x - F.bobPos.x);
      F.bobAttacking = true;
    }
    await sleep(440);                              // he raises a fist and brings it down
    // Impact — the moon goes, with a hard camera flash.
    if (F.moon) { F.moon.state = 'shattering'; F.moon.shatterAt = state.now; }
    playSound('destroy', 1, 0.3);
    playSound('lightning', 0.8, 0.5);
    void finaleBark(state, 'lolly', '*no no no no no no no no no no no*');
    white.style.transition = 'opacity 50ms ease-out';
    white.style.opacity = '0.85';
    await sleep(70);
    white.style.transition = 'opacity 300ms ease-in';
    white.style.opacity = '0';
    // The violent tear — the whole app shakes and splits, held for two full
    // glitch cycles so the wobble lingers.
    appEl?.classList.add('finale-glitch');
    await sleep(1460);
    appEl?.classList.remove('finale-glitch');
    // The BIG pull-back, everything receding to a point as it slowly whites
    // out (both eased longer so the ending breathes).
    playSound('ritual', 1, 0.25);
    // The glitch animation drove `transform` right up until the class was
    // removed above. A CSS transition won't start for a property an animation
    // was just controlling unless that property has settled to a stable base
    // first — add .finale-zoom in a later frame so the transform has cleared
    // to identity, otherwise the pull-back snaps to its end state instantly.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => { appEl?.classList.add('finale-zoom'); });
    });
    white.style.transition = 'opacity 3200ms ease-in';
    requestAnimationFrame(() => { white.style.opacity = '1'; });
    await sleep(3600);
    // Held on white — the next part of the game picks up from here.
    finaleEndApplied = true;
    F.phase = 'shattered';
    backgroundSave();
  }

  // Resuming a save that's already past the break: drop straight onto the held
  // white-out (no transition, no replay of the shatter).
  function applyFinaleEnded() {
    if (finaleEndApplied) return;
    finaleEndApplied = true;
    finaleConfrontStarted = true;
    document.getElementById('app')?.classList.add('finale-zoom');
    const white = finaleWhite();
    white.style.transition = 'none';
    white.style.opacity = '1';
  }

  const anyPanKeyHeld = () =>
    held.has('a') || held.has('d') || held.has('w') || held.has('s')
    || held.has('arrowleft') || held.has('arrowright') || held.has('arrowup') || held.has('arrowdown');

  // Run each frame. Fires barks on transitions and kicks off the confrontation.
  function driveFinale(now: number) {
    const F = state.finale;
    if (!F) { finaleLastPhase = null; return; }

    // Resuming a save already past the break: re-apply the held white-out.
    // Either way (live shatter or resume), the world is over — hand off to
    // the trading-card realm, which mounts itself over the white after a beat.
    if (F.phase === 'shattered') {
      applyFinaleEnded();
      maybeStartCardRealm();
      finaleLastPhase = F.phase;
      return;
    }

    // First sight of the cinematic: swing the camera onto Lolly so the player
    // sees the dragon answer her call.
    if (finaleLastPhase === null && F.scene === 'ground') {
      centerCameraOn(ctx, F.lollyPos.x, F.lollyPos.y);
    }

    // Auto-follow: ease the camera to keep Lolly framed through the autonomous
    // flight, but only in the scene the player is actually watching, and never
    // while they're panning by hand or during the held confrontation.
    if (getOptions().finaleAutoFollow && !anyPanKeyHeld()
        && F.phase !== 'confront'
        && !transitioning && !hellTransitioning) {
      if (F.scene === 'ground' && state.view === 'ground') {
        const tx = F.lollyPos.x - ctx.viewport.width / (2 * ctx.renderScale);
        const ty = F.lollyPos.y - ctx.viewport.height / (2 * ctx.renderScale);
        ctx.camera.x += (tx - ctx.camera.x) * 0.06;
        ctx.camera.y += (ty - ctx.camera.y) * 0.06;
        clampCamera(ctx);
      } else if (F.scene === 'space' && state.view === 'space') {
        const tx = F.lollyPos.x - ctx.viewport.width / (2 * ctx.renderScale);
        const ty = F.lollyPos.y - ctx.viewport.height / (2 * ctx.renderScale);
        ctx.spaceCamera.x += (tx - ctx.spaceCamera.x) * 0.06;
        ctx.spaceCamera.y += (ty - ctx.spaceCamera.y) * 0.06;
        clampSpaceCamera(ctx);
      }
    }

    // Lolly tells Bob to stay as she lifts off.
    if (F.phase === 'lolly_ascends' && !finaleBarkedStay) {
      finaleBarkedStay = true;
      void finaleBark(state, 'lolly', 'stay');
    }
    // Bob reaches the centre, turns to the player, and nudges them spaceward.
    if (F.bobAtCentre && !finaleBarkedCheck && (F.phase === 'space_rampage' || F.phase === 'grab_moon' || F.phase === 'lolly_ascends')) {
      finaleBarkedCheck = true;
      void finaleBark(state, 'bob', 'best you go and see to your things up in space, boss.');
    }
    finaleLastPhase = F.phase;

    // The closing confrontation — once Lolly has landed back on the surface.
    // `confrontReady` is the live trigger; the phase check re-arms it after a
    // reload (where confrontReady is cleared but the phase persists).
    if ((F.confrontReady || F.phase === 'confront') && !finaleConfrontStarted) {
      finaleConfrontStarted = true;
      void (async () => {
        // The quartet bows out for good as the last conversation begins —
        // only the vinyl crackle keeps riding the empty groove.
        fadeOutMusicForever();
        // Bring the player down to the surface to watch it happen.
        if (state.view !== 'ground') {
          quickTravel('ground');
          await sleep(420);
        }
        const pa = state.playArea;
        centerCameraOn(ctx, ((pa.x0 + pa.x1) / 2) * CELL, ((pa.y0 + pa.y1) / 2) * CELL);
        // Freeze the world for the (static) modal conversation.
        document.body.classList.add('finale-hold');
        await runFinaleConfrontation(state);
        // Resume time before the smash so Bob's swing and the moon's shards
        // actually animate (both key off state.now). updateFinale just holds
        // through 'confront'/'shattered', so nothing else moves.
        document.body.classList.remove('finale-hold');
        await runFinaleShatter();
      })();
    }
  }

  // Each frame-loop branch shows at most the travel hints it names here and
  // hides the rest.
  const showHints = (visible: {
    ascend?: boolean; descend?: boolean; descendHell?: boolean; ascendHell?: boolean;
  } = {}) => {
    ascendHint?.classList.toggle('visible', !!visible.ascend);
    descendHint?.classList.toggle('visible', !!visible.descend);
    descendHellHint?.classList.toggle('visible', !!visible.descendHell);
    ascendHellHint?.classList.toggle('visible', !!visible.ascendHell);
  };

  // Autosave to localStorage every SAVE_INTERVAL_MS, plus on visibilitychange
  // and pagehide so a closed tab loses at most this much progress. The
  // periodic save runs through a worker (serialize+compress off the main
  // thread — see save.ts) so a big colony doesn't hitch every 10s; the
  // event-driven flushes stay synchronous because the page may be going away.
  const SAVE_INTERVAL_MS = 10_000;
  let saveAcc = 0;
  // Card-hop guard: once cards.ts has written the destination world into the
  // save slot (entering/leaving a card world reloads the page), the departing
  // world must NOT flush over it — pagehide fires right on the reload.
  const flushSave = () => { if (isCardHopInProgress()) return; saveGame(state); saveAcc = 0; };
  const backgroundSave = () => { if (isCardHopInProgress()) return; saveGameInBackground(state); saveAcc = 0; };
  window.addEventListener('pagehide', flushSave);
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushSave();
  });

  let acc = 0;
  let last = performance.now();

  // The DOM sidebar refresh (refreshUI) forces style/layout work in the
  // browser — innerHTML, classList churn, scroll measurements — and running
  // it every animation frame was a big chunk of the per-frame budget on
  // mobile Safari. 10Hz is plenty for resource counters and button states;
  // the canvas render below still runs every frame. Seeded to fire on the
  // very first frame.
  const UI_REFRESH_MS = 100;
  let uiAcc = UI_REFRESH_MS;

  // ─── Demon parlay ──────────────────────────────────────────────────
  // When a soul reaches a demon, the sim sets demon.busyWith. We freeze the
  // world (demon-parlay-hold, folded into introActive above) and run the modal
  // conversation. parlayActive guards against launching a second overlay while
  // one is in flight.
  let parlayActive = false;

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
    // Freeze/unfreeze the intro sequence (goblin slide, dialog typing,
    // between-line waits) in lockstep with the rest of the game.
    setIntroPaused(paused);
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
      // input.ts clears any pending placement/aim mode on ESC; only an ESC
      // with nothing armed toggles pause.
      if (state.pendingBuild || state.pendingStrike || state.pendingCandle || state.pendingOrbital || state.pendingSpaceCentre) return;
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
    // Dev cheat: a queued skip-to-hell fires here, where the transition
    // machinery lives, so the options callback (wired before ctx exists)
    // never touches it directly.
    if (requestSkipToHell) {
      requestSkipToHell = false;
      if (state.view === 'ground' && !hellTransitioning && !transitioning) triggerDescendToHell(now);
    }
    // Freeze game ticks while a goblin is actually talking. Like Bob's
    // cutscene, the intro lets the world run through the free-click preamble
    // and the slide-up; intro.ts only sets intro-cutscene-hold once the
    // goblin has turned to face the player, and lifts it for the walk-off.
    // (intro-hold — the panel-visibility gate — deliberately does NOT freeze
    // time.) The spawn-hint / no-task grace timers in refreshUI lose the
    // ~15s the preamble+rise now consume, which still leaves most of their
    // 30s/90s windows.
    // Bob's hole-picker freezes the world the same way so the player can
    // line up the summon without the rest of the colony advancing; bob-spawn-hold
    // then holds it for a beat right after he emerges (set in input.ts).
    // unlock-reveal-hold freezes time for the whole task-complete ceremony:
    // the WORK COMPLETE overlay plus the staged one-by-one unlock reveal that
    // follows it (set/cleared in ui.ts).
    const introActive = document.body.classList.contains('intro-cutscene-hold')
      || document.body.classList.contains('bob-cutscene-hold')
      || document.body.classList.contains('demon-parlay-hold')
      || document.body.classList.contains('bob-spawn-hold')
      || document.body.classList.contains('unlock-reveal-hold')
      // The finale's closing confrontation + shatter freezes the world like a
      // cutscene; the autonomous beats before it (Lolly's flight) run live.
      || document.body.classList.contains('finale-hold')
      // Spectating a trader's card world: time stands still for the whole
      // visit (set by setupCardWorldChrome, cleared by the leave reload).
      || document.body.classList.contains('spectate-hold')
      || state.bobPickingHole;
    if (!paused && !introActive) {
      acc += dt;
      if (acc > TICK_MS * 10) acc = TICK_MS * 10;
      const tickStart = fpsHud ? performance.now() : 0;
      while (acc >= TICK_MS) {
        tick(state);
        acc -= TICK_MS;
      }
      // Bob & Lolly's quiet exit — once their three hell beats are done they
      // slip away the moment both are off screen. Runs here (not in tick)
      // because "off screen" needs the renderer's hell camera, and only while
      // the world is live so a frozen parlay can never vanish its speakers.
      maybeDepartBobAndLolly(
        state,
        state.view === 'hell'
          ? (() => {
              const scale = currentHellScale(ctx);
              return {
                x0: ctx.hellCamera.x,
                y0: ctx.hellCamera.y,
                x1: ctx.hellCamera.x + ctx.viewport.width / scale,
                y1: ctx.hellCamera.y + ctx.viewport.height / scale,
              };
            })()
          : null,
      );
      // Pain Gabbonsaw's summon bar just completed (sim tick): pull the
      // player back to the overworld, run Bob's cutscene, then loose Lolly.
      if (state.gabbonsawCutscenePending) {
        state.gabbonsawCutscenePending = false;
        if (state.view !== 'ground') quickTravel('ground');
        void runGabbonsawCutscene().then(() => {
          const at = spawnLollyRampage(state);
          centerCameraOn(ctx, at.x, at.y);
        });
      }
      if (fpsHud) frameTimings.tickMs = performance.now() - tickStart;
      saveAcc += dt;
      if (saveAcc >= SAVE_INTERVAL_MS) backgroundSave();
    } else {
      // Drop any pending accumulator so the post-intro/unpause frame
      // doesn't dump a burst of ticks into the world.
      acc = 0;
    }
    // Launch a demon parlay overlay the moment a soul has reached a demon.
    if (!parlayActive) {
      for (const demon of state.demons.values()) {
        if (demon.busyWith === null) continue;
        const ghost = state.ghosts.find((g) => g.id === demon.busyWith);
        if (!ghost) { demon.busyWith = null; continue; }
        parlayActive = true;
        document.body.classList.add('demon-parlay-hold');
        void runDemonDialogue(state, demon, ghost).finally(() => {
          demon.busyWith = null;
          parlayActive = false;
          document.body.classList.remove('demon-parlay-hold');
        });
        break;
      }
    }
    // Likewise for a soul-to-soul chat (one ghost commanded onto another).
    // Shares parlayActive so a chat and a parlay can't overlap on the one
    // speech bubble.
    if (!parlayActive && state.pendingGhostChat) {
      const { aId, bId } = state.pendingGhostChat;
      state.pendingGhostChat = null;
      const a = state.ghosts.find((g) => g.id === aId);
      const b = state.ghosts.find((g) => g.id === bId);
      if (a && b) {
        parlayActive = true;
        document.body.classList.add('demon-parlay-hold');
        void runGhostChat(state, a, b).finally(() => {
          parlayActive = false;
          document.body.classList.remove('demon-parlay-hold');
        });
      }
    }
    // The finale cinematic's DOM-side beats (barks, the confrontation modal).
    driveFinale(now);
    // The finale's confrontation + shatter is a held cinematic: lock the camera
    // and swallow edge-hold transitions so the player can't pan or fly away from
    // it (quick-travel is blocked separately).
    const finaleCinematic = document.body.classList.contains('finale-hold');
    // Held pan vector.
    let dx = 0, dy = 0;
    if (held.has('a') || held.has('arrowleft')) dx -= 1;
    if (held.has('d') || held.has('arrowright')) dx += 1;
    if (held.has('w') || held.has('arrowup')) dy -= 1;
    if (held.has('s') || held.has('arrowdown')) dy += 1;
    let upHeld = held.has('w') || held.has('arrowup');
    let downHeld = held.has('s') || held.has('arrowdown');
    if (finaleCinematic) { dx = 0; dy = 0; upHeld = false; downHeld = false; }
    const panMove = (CAMERA_SPEED * dt) / 1000;
    // Any held pan key counts as the player "discovering" map movement —
    // sticky, hides the never-panned nudge forever (see refreshUI).
    if (dx !== 0 || dy !== 0) state.cameraPanSeen = true;

    // Ease the hell zoom-out (or zoom-in on return) independent of the
    // descent transition. Kicked off when arriving in hell / leaving hell.
    if (hellZooming) {
      const t = Math.min(1, (now - hellZoomStart) / hellZoomDuration);
      const e = t * t * (3 - 2 * t);
      ctx.hellZoom = hellZoomFrom + (hellZoomTo - hellZoomFrom) * e;
      if (t >= 1) {
        ctx.hellZoom = hellZoomTo;
        hellZooming = false;
      }
      // Recenter the hell camera on the recorded world-focus each frame so
      // the zoom appears to pivot around the player's landing spot instead
      // of pulling toward a corner as the bounds change.
      centerHellCameraOnWorld(ctx, hellZoomFocusX, hellZoomFocusY);
    }

    if (transitioning) {
      // Mid-climb: drive altitude with an ease-in-out and ignore pan input.
      const t = Math.min(1, (now - transStart) / SPACE_TRANS_MS);
      const e = t * t * (3 - 2 * t);
      ctx.altitude = transFrom + (transTo - transFrom) * e;
      if (t >= 1) {
        ctx.altitude = transTo;
        transitioning = false;
        state.view = transTo >= 0.5 ? 'space' : 'ground';
        // Arrived — the destination view's buttons may now show (see refreshUI).
        state.viewTransitioning = false;
      }
      showHints();
    } else if (hellTransitioning) {
      // Mid-descent: drive depth with the same ease-in-out and ignore pan.
      const t = Math.min(1, (now - hellTransStart) / HELL_TRANS_MS);
      const e = t * t * (3 - 2 * t);
      ctx.depth = hellTransFrom + (hellTransTo - hellTransFrom) * e;
      if (t >= 1) {
        ctx.depth = hellTransTo;
        hellTransitioning = false;
        // Arrived — the destination view's buttons may now show (see refreshUI).
        state.viewTransitioning = false;
        if (hellTransTo >= 0.5) {
          state.view = 'hell';
          // Arrival: kick off the camera zoom-out reveal — slowed by 50% so
          // the underworld opens up gradually rather than snapping out.
          hellZooming = true; hellZoomFrom = 0; hellZoomTo = 1; hellZoomStart = now;
          hellZoomDuration = HELL.zoomMs * 1.5;
        } else {
          state.view = 'ground';
        }
      }
      showHints();
    } else if (ctx.altitude >= 0.9999) {
      // ── Space view ── pan the space camera; hold ↓ at the bottom to descend.
      state.view = 'space';
      if (dx !== 0 || dy !== 0) {
        const len = Math.hypot(dx, dy);
        ctx.spaceCamera.x += (dx / len) * panMove;
        ctx.spaceCamera.y += (dy / len) * panMove;
        clampSpaceCamera(ctx);
      }
      const atBottom = ctx.spaceCamera.y >= spaceCameraMaxY(ctx) - 1;
      if (downHeld && atBottom) {
        descendHold += dt;
        if (descendHold >= SPACE_HOLD_MS) triggerDescendToSurface(now);
      } else { descendHold = 0; }
      showHints({ descend: atBottom && !transitioning });
    } else if (ctx.depth >= 0.9999) {
      // ── Hell view ── pan the hell camera; hold ↑ at the top to rise back.
      state.view = 'hell';
      if (dx !== 0 || dy !== 0) {
        const len = Math.hypot(dx, dy);
        const scale = currentHellScale(ctx);
        // Scale pan speed by inverse of zoom so panning when zoomed out covers
        // the larger view at roughly the same on-screen pace.
        const pan = (CAMERA_SPEED * dt) / 1000 * (ctx.renderScale / scale);
        ctx.hellCamera.x += (dx / len) * pan;
        ctx.hellCamera.y += (dy / len) * pan;
        clampHellCamera(ctx);
      }
      const atTop = ctx.hellCamera.y <= 1;
      if (upHeld && atTop) {
        ascendHellHold += dt;
        if (ascendHellHold >= SPACE_HOLD_MS) triggerAscendFromHell(now);
      } else { ascendHellHold = 0; }
      showHints({ ascendHell: atTop && !hellTransitioning });
    } else {
      // ── Ground view ── pan the world; hold ↑ at the top to rise into space,
      // or hold ↓ at the bottom (Hell Portal placed) to descend into hell.
      state.view = 'ground';
      if (dx !== 0 || dy !== 0) {
        const len = Math.hypot(dx, dy);
        ctx.camera.x += (dx / len) * panMove;
        ctx.camera.y += (dy / len) * panMove;
        clampCamera(ctx);
      }
      const atTop = ctx.camera.y <= 1;
      // True "at the bottom" check: camera.y is at its max pan extent.
      const groundMaxY = Math.max(0, WORLD.height - ctx.viewport.height / ctx.renderScale);
      const atBottom = ctx.camera.y >= groundMaxY - 1;
      if (state.spaceUnlocked && upHeld && atTop) {
        ascendHold += dt;
        if (ascendHold >= SPACE_HOLD_MS) triggerAscendToSpace(now);
      } else { ascendHold = 0; }
      if (state.hellUnlocked && downHeld && atBottom) {
        descendHellHold += dt;
        if (descendHellHold >= SPACE_HOLD_MS) triggerDescendToHell(now);
      } else { descendHellHold = 0; }
      showHints({
        ascend: state.spaceUnlocked && atTop && !transitioning,
        descendHell: state.hellUnlocked && atBottom && !hellTransitioning,
      });
      // Pan-hint trigger: once any water source intersects the camera's visible
      // rect, mark `waterSeen` sticky-true. The hint flips off in refreshUI.
      if (!state.waterSeen && state.waterSources.size > 0) {
        const vx0 = ctx.camera.x;
        const vy0 = ctx.camera.y;
        const vx1 = vx0 + ctx.viewport.width / ctx.renderScale;
        const vy1 = vy0 + ctx.viewport.height / ctx.renderScale;
        for (const w of state.waterSources.values()) {
          if (w.x1 * CELL > vx0 && w.x0 * CELL < vx1 && w.y1 * CELL > vy0 && w.y0 * CELL < vy1) {
            state.waterSeen = true;
            break;
          }
        }
      }
    }
    // Dim + disable the summon/build panels in orbit. Hell only dims the
    // summon panel — its Build panel stays live, holding the Candle option.
    document.body.classList.toggle('space-view', state.view === 'space');
    document.body.classList.toggle('hell-view', state.view === 'hell');
    // The music pitches + slows down as you descend into hell (rather than
    // muting), and rises back to pitch on the return. Space stays at full pitch.
    setMusicDepth(ctx.depth);
    // Suppress goblin_spawn cries once we're actually in hell — the
    // underworld is supposed to be hushed. Death cries still play.
    setInHellView(state.view === 'hell');
    const renderStart = fpsHud ? performance.now() : 0;
    render(state, ctx);
    if (fpsHud) frameTimings.renderMs = performance.now() - renderStart;
    uiAcc += dt;
    if (uiAcc >= UI_REFRESH_MS) {
      uiAcc = 0;
      const uiStart = fpsHud ? performance.now() : 0;
      refreshUI(state);
      if (fpsHud) frameTimings.uiMs = performance.now() - uiStart;
    } else if (fpsHud) {
      frameTimings.uiMs = 0;
    }
    fpsHud?.(now, dt, frameTimings);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

main().catch((e) => {
  console.error(e);
  document.body.innerHTML = `<pre style="color:#ff7777;padding:20px">${e}</pre>`;
});
