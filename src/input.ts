import { Application, Container, FederatedPointerEvent, Graphics } from 'pixi.js';
import { playSound, playGhostCommand, playMinotaurCommand } from './audio';
import { flashCursor } from './cursor-fx';
import { bobOverworldBark, demonRebuke, finaleBark } from './demon-dialogue';
import { BUILDABLE_KINDS, BUILDING_DEFS, BuildingKind, CELL, DRAGON, GOBLIN, HELL, LIGHTNING, LOLLY, MAX_SELECTED_UNITS, MINOTAUR, SOUL_SIGIL, SPACE, SPACE_UNIT, WORLD, formatPower } from './config';
import { runBobCutscene } from './intro';
import { RenderContext, ambientDragonAt, clampCamera, clampHellCamera, clampSpaceCamera, currentHellScale, ghostAtHell, ghostHellPos } from './render';
import { autoAssignAllIdle, lightningStrike, spawnBob, unseatSoulFromChair } from './sim';
import {
  Building, Cell, Dragon, GameState, Ghost, Goblin, Minotaur, SpaceUnit, WaterSource,
  appendLog, buildingAtCell, buildingMoneyCost, candleSpotAt, cellKey, defOf, demonAtHell, findFreeCellNear,
  hellPortalAt, holeAtCell, isInBounds, markBuildingsChanged, nextBuildingDisplayNum, pixelToCell, placeCandle, pushFloater,
  soulChairAt, spaceBuildingAt, spaceStructureOverlapAt, spaceUnitAt, waterCarrierCount, waterSourceAtCell,
  freePlatformAt,
} from './state';

// Bob's brush-off when the player tries to strike during the finale — he's
// already dead, and nothing of theirs is left to hit. Varied so a mashing
// player doesn't hear the same line twice running.
const FINALE_REFUSAL_LINES = [
  "you can't kill that which is already dead.",
  "i'm already dead, boss. ⏸ save your lightning.",
  'nothing left down here to kill.',
];
function finaleRefusalLine(): string {
  return FINALE_REFUSAL_LINES[Math.floor(Math.random() * FINALE_REFUSAL_LINES.length)];
}

// Spectating a trader's card world (cards.ts sets the class for the whole
// visit): looking and selecting are fine, but the world takes no orders.
function spectatingNow(): boolean {
  return document.body.classList.contains('spectate-hold');
}

// In the dev World Designer (setupDesignerChrome tags the body): every building
// is free, placed straight to active, and drag-paintable like a wall — so the
// dev can lay out a world fast. Outside the designer this is always false and
// the normal cost/construction path runs.
function designerNow(): boolean {
  return document.body.classList.contains('world-designer-active');
}

type ActivePointer = {
  startX: number; startY: number;
  x: number; y: number;
  worldStartX: number; worldStartY: number;
  // True for touch pointers — only these are reconciled against the browser's
  // TouchEvent.touches list (see reconcileTouchPointers in setupInput).
  touch: boolean;
};

type InputState = {
  isDragging: boolean;
  dragStart: { x: number; y: number };
  selectionGfx: Graphics;
  placementGhost: Graphics;
  // Multi-touch / long-press tracking
  pointers: Map<number, ActivePointer>;
  panLast: { x: number; y: number } | null;
  longPressTimer: number | null;
  longPressPointerId: number | null;
  longPressFired: boolean;
  // Latest pointer position, updated on every hover/move, so the keyboard
  // "command" shortcut (Space) can act at the cursor without a pointer event.
  lastPointer: { global: { x: number; y: number }; client: { x: number; y: number } } | null;
  // Screen-space origin of a potential tap-or-drag-select while in the space
  // view. Set on pointerdown in orbit, consumed on pointerup. Null on the ground.
  spaceTapStart: { x: number; y: number } | null;
  // Rubber-band selection rectangle for the space view, drawn in screen space
  // (a direct child of the stage, so it stays on top and ignores camera pans).
  spaceSelectionGfx: Graphics;
};

const LONG_PRESS_MS = 450;
const LONG_PRESS_MOVE_TOL = 10; // screen-space px
// Screen-space px a space-view pointer must travel before a tap becomes a
// rubber-band drag-select (also the tap-vs-drag cutoff resolved on pointerup).
const SPACE_DRAG_TOL = 6;
// Hit-radius multiplier for souls/chairs when the click also lands inside a
// demon's hit halo. The demon's halo (DEMON.hitRadius, 390 hell-px) dwarfs a
// soul's (24) or candle's (28), so without this forgiveness the demon swallows
// every near-miss and things under him are effectively unclickable. He only
// claims the click when nothing else is within the widened radii.
const UNDER_DEMON_RADIUS_MULT = 3;

export function setupInput(
  state: GameState,
  app: Application,
  uiLayer: Container,
  worldLayer: Container,
  ctx: RenderContext,
) {
  const selectionGfx = new Graphics();
  const placementGhost = new Graphics();
  uiLayer.addChild(selectionGfx);
  uiLayer.addChild(placementGhost);
  // Lives on the stage (not the space layer) so it renders in screen space and
  // always sits above the floating buildings during a drag-select.
  const spaceSelectionGfx = new Graphics();
  app.stage.addChild(spaceSelectionGfx);

  const input: InputState = {
    isDragging: false,
    dragStart: { x: 0, y: 0 },
    selectionGfx, placementGhost,
    pointers: new Map(),
    panLast: null,
    longPressTimer: null,
    longPressPointerId: null,
    longPressFired: false,
    lastPointer: null,
    spaceTapStart: null,
    spaceSelectionGfx,
  };

  app.stage.eventMode = 'static';
  // Receive pointer events anywhere on the canvas (regardless of camera position).
  app.stage.hitArea = { contains: () => true };
  // Every pointer listener in the game lives on the stage itself, so skip
  // Pixi's recursive hit-test into the scene graph entirely. Without this,
  // each pointermove walks every goblin/building/ghost view doing bounds
  // checks — on touch devices, which deliver a dense stream of coalesced
  // move events while dragging, that starved the frame loop badly.
  app.stage.interactiveChildren = false;
  app.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  app.stage.on('pointerdown', (e: FederatedPointerEvent) => {
    const local = e.getLocalPosition(worldLayer);
    input.lastPointer = {
      global: { x: e.global.x, y: e.global.y },
      client: { x: e.clientX, y: e.clientY },
    };
    input.pointers.set(e.pointerId, {
      startX: e.global.x, startY: e.global.y,
      x: e.global.x, y: e.global.y,
      worldStartX: local.x, worldStartY: local.y,
      touch: e.pointerType === 'touch',
    });

    // No world building/commanding while looking at space — but a single
    // pointer can tap to select a floating building or drag a rubber-band box
    // to select several, mirroring the ground view. Two pointers pan the orbit
    // camera (on top of the keyboard panning from main.ts). Record the origin
    // and resolve tap-vs-drag on pointerup.
    if (state.view !== 'ground') {
      input.isDragging = false;
      input.selectionGfx.clear();
      cancelLongPress(input);
      const singlePrimary = e.button === 0 && input.pointers.size < 2;
      if (singlePrimary) {
        input.spaceTapStart = { x: e.global.x, y: e.global.y };
        // Touch has no right-click. In hell and space, a long-press is the
        // command gesture (mirroring the ground view) — without this, touch
        // players can select souls/robots but have no way to order them around.
        if (e.pointerType === 'touch') {
          scheduleLongPress(input, e.pointerId, state, ctx, worldLayer);
        }
      } else {
        // A non-primary press (right-click) or a second finger cancels any
        // pending select; a genuine second finger also starts a two-finger pan.
        input.spaceTapStart = null;
        input.spaceSelectionGfx.clear();
        if (input.pointers.size >= 2) {
          const pts = [...input.pointers.values()];
          input.panLast = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
        }
        // Hell view: right-click is a "walk here" command for any selected
        // ghosts (the space view mirrors this for robots below). While candle
        // placement is armed, right-click cancels it instead (mirroring how a
        // pending strike is cancelled on the ground).
        if (e.button === 2 && state.view === 'hell' && input.pointers.size < 2) {
          flashCursor(e.clientX, e.clientY);
          if (state.pendingCandle) { state.pendingCandle = false; return; }
          const hp = e.getLocalPosition(ctx.hellLayer);
          handleHellRightClick(state, hp.x, hp.y);
        }
        // Space view: right-click cancels a pending Orbital Platform / Space
        // Centre placement (mirroring how a pending candle/strike is
        // cancelled elsewhere); with nothing armed it's a "walk here" command
        // for any selected robots, just like the ground view.
        if (e.button === 2 && state.view === 'space' && input.pointers.size < 2) {
          flashCursor(e.clientX, e.clientY);
          if (state.pendingOrbital || state.pendingSpaceCentre) {
            state.pendingOrbital = false;
            state.pendingSpaceCentre = false;
            return;
          }
          const sp = e.getLocalPosition(ctx.spaceLayer);
          handleSpaceRightClick(state, sp.x, sp.y);
        }
      }
      return;
    }
    input.spaceTapStart = null;

    // Two or more pointers → enter pan mode and abandon any single-pointer interaction.
    if (input.pointers.size >= 2) {
      cancelLongPress(input);
      input.isDragging = false;
      input.selectionGfx.clear();
      const pts = [...input.pointers.values()];
      input.panLast = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
      return;
    }

    // Bob picker: after the cutscene accepts, the next ground tap must land on
    // a Goblin Hole (main hole or any completed goblin_hole building). A click
    // anywhere else just beeps; right-click does nothing. No selection, no
    // build, no strike fires while the picker is active.
    if (state.bobPickingHole && e.button === 0) {
      input.isDragging = false;
      input.selectionGfx.clear();
      const c = pixelToCell(local.x, local.y);
      const onMain = !state.holeDestroyed && holeAtCell(state, c.cx, c.cy);
      const b = onMain ? null : buildingAtCell(state, c.cx, c.cy);
      const onBuildingHole = b !== null && b.kind === 'goblin_hole' && b.state !== 'constructing';
      const target: Cell | null = onMain
        ? state.hole.cell
        : (onBuildingHole && b ? b.cell : null);
      if (target) {
        if (spawnBob(state, target)) {
          state.bobPickingHole = false;
          state.bobSpawned = true;
          // Beat of stillness so Bob's arrival registers before the colony
          // resumes. The frame loop honours bob-spawn-hold the same way as the
          // other holds; setTimeout clears it after ~1s of wall-clock time.
          document.body.classList.add('bob-spawn-hold');
          window.setTimeout(() => document.body.classList.remove('bob-spawn-hold'), 1000);
        }
      } else {
        playSound('error');
      }
      return;
    }
    if (state.bobPickingHole) return;

    if (e.button === 2) {
      flashCursor(e.clientX, e.clientY);
      // Right-click cancels a pending strike rather than issuing a unit order.
      if (state.pendingStrike) { state.pendingStrike = false; input.placementGhost.clear(); return; }
      handleRightClick(state, local.x, local.y);
      return;
    }
    if (state.pendingStrike) {
      // During the finale the bolt finds nothing it can kill — Bob is already
      // dead and everything else is gone — so he just waves it off.
      if (state.finale && state.finale.phase !== 'shattered') {
        state.pendingStrike = false;
        input.placementGhost.clear();
        void finaleBark(state, 'bob', finaleRefusalLine());
        return;
      }
      // Stays armed if the player can't afford it (lightningStrike beeps).
      if (lightningStrike(state, local.x, local.y)) {
        state.pendingStrike = false;
        input.placementGhost.clear();
      }
      return;
    }
    // Designer-only: (re)place the original Goblin Hole at the clicked cell.
    if (state.pendingOriginalHole) {
      const c = pixelToCell(local.x, local.y);
      if (isInBounds(c.cx, c.cy)) {
        state.hole.cell = { cx: c.cx, cy: c.cy };
        state.holeDestroyed = false;
        playSound('place', 1.6);
      } else {
        playSound('error');
      }
      state.pendingOriginalHole = false;
      input.placementGhost.clear();
      return;
    }
    if (state.pendingBuild) {
      placeBuilding(state, local.x, local.y);
      drawGhost(input, local.x, local.y, state);
      return;
    }
    // Schedule long-press → "right-click" on touch.
    if (e.pointerType === 'touch') {
      scheduleLongPress(input, e.pointerId, state, ctx, worldLayer);
    }
    input.isDragging = true;
    input.dragStart = { x: local.x, y: local.y };
    input.selectionGfx.clear();
  });

  app.stage.on('pointermove', (e: FederatedPointerEvent) => {
    input.lastPointer = {
      global: { x: e.global.x, y: e.global.y },
      client: { x: e.clientX, y: e.clientY },
    };
    const tracked = input.pointers.get(e.pointerId);
    if (tracked) {
      tracked.x = e.global.x;
      tracked.y = e.global.y;
    }

    // Two-finger pan: compute midpoint delta in screen-space, apply to whichever
    // camera the current view uses, in world units.
    if (input.pointers.size >= 2 && input.panLast) {
      // The player has "discovered" map movement — sticky, hides the
      // never-panned nudge forever (see refreshUI).
      state.cameraPanSeen = true;
      const pts = [...input.pointers.values()];
      const midX = (pts[0].x + pts[1].x) / 2;
      const midY = (pts[0].y + pts[1].y) / 2;
      const dx = midX - input.panLast.x;
      const dy = midY - input.panLast.y;
      if (state.view === 'ground') {
        ctx.camera.x -= dx / ctx.renderScale;
        ctx.camera.y -= dy / ctx.renderScale;
        clampCamera(ctx);
      } else if (state.view === 'space') {
        ctx.spaceCamera.x -= dx / ctx.renderScale;
        ctx.spaceCamera.y -= dy / ctx.renderScale;
        clampSpaceCamera(ctx);
      } else {
        const scale = currentHellScale(ctx);
        ctx.hellCamera.x -= dx / scale;
        ctx.hellCamera.y -= dy / scale;
        clampHellCamera(ctx);
      }
      input.panLast = { x: midX, y: midY };
      return;
    }

    // Space view: a single-pointer drag draws a rubber-band selection box once
    // it travels past the tap threshold. Resolved into a selection on pointerup.
    if (state.view !== 'ground') {
      // Candle placement preview: track the cursor in hell coords so the
      // renderer can draw the snapped candle ghost on the mirror's outer ring.
      if (state.view === 'hell' && state.pendingCandle) {
        const hp = e.getLocalPosition(ctx.hellLayer);
        ctx.candleCursor = { x: hp.x, y: hp.y };
      }
      // Orbital Platform / Space Centre placement preview: track the cursor
      // in space coords so the renderer can draw the footprint ghost under it
      // (mirroring the ground-building placement ghost).
      if (state.view === 'space' && (state.pendingOrbital || state.pendingSpaceCentre)) {
        const sp = e.getLocalPosition(ctx.spaceLayer);
        ctx.orbitalCursor = { x: sp.x, y: sp.y };
      }
      // Dragging far enough to start a selection box cancels the pending hell
      // command long-press (it's a drag, not a press-and-hold).
      if (input.longPressPointerId === e.pointerId && tracked) {
        const moved = Math.hypot(tracked.x - tracked.startX, tracked.y - tracked.startY);
        if (moved > LONG_PRESS_MOVE_TOL) cancelLongPress(input);
      }
      if (input.spaceTapStart && input.pointers.has(e.pointerId)) {
        const moved = Math.hypot(e.global.x - input.spaceTapStart.x, e.global.y - input.spaceTapStart.y);
        if (moved >= SPACE_DRAG_TOL) {
          drawSpaceSelectionRect(input, input.spaceTapStart.x, input.spaceTapStart.y, e.global.x, e.global.y);
        }
      }
      return;
    }

    // Cancel long-press if the finger moved too far.
    if (input.longPressPointerId === e.pointerId && tracked) {
      const moved = Math.hypot(tracked.x - tracked.startX, tracked.y - tracked.startY);
      if (moved > LONG_PRESS_MOVE_TOL) cancelLongPress(input);
    }

    const local = e.getLocalPosition(worldLayer);
    if (state.pendingStrike) drawStrikeGhost(input, local.x, local.y);
    else if (state.pendingBuild) drawGhost(input, local.x, local.y, state);
    else input.placementGhost.clear();
    // Drag-paint — pointer is held (still in input.pointers) with a pending
    // build. Walls always drag-paint; in the designer EVERY kind does too.
    // Silently skips duplicate/blocked cells so a sweep doesn't beep.
    if (state.pendingBuild && input.pointers.has(e.pointerId)) {
      if (state.pendingBuild.kind === 'wall') {
        const c = pixelToCell(local.x, local.y);
        tryPlaceWallAt(state, c.cx, c.cy, true);
      } else if (designerNow()) {
        tryPlaceBuildingInstant(state, local.x, local.y, state.pendingBuild.kind, true);
      }
    }
    if (!input.isDragging) return;
    input.selectionGfx.clear();
    const x = Math.min(input.dragStart.x, local.x);
    const y = Math.min(input.dragStart.y, local.y);
    const w = Math.abs(local.x - input.dragStart.x);
    const h = Math.abs(local.y - input.dragStart.y);
    input.selectionGfx
      .rect(x, y, w, h)
      .fill({ color: 0xffd96b, alpha: 0.1 })
      .stroke({ width: 1, color: 0xffd96b });
  });

  const onPointerUp = (e: FederatedPointerEvent) => {
    const wasPanning = input.pointers.size >= 2;
    input.pointers.delete(e.pointerId);
    if (wasPanning) {
      // Drop pan reference — don't resume a pending drag-select with the leftover finger.
      input.panLast = null;
      input.isDragging = false;
      input.selectionGfx.clear();
      input.spaceSelectionGfx.clear();
      return;
    }
    // Space view: a short tap selects the floating building under it; a longer
    // drag rubber-band selects every building inside the box. Shift adds to the
    // current selection; otherwise a tap/drag on empty void clears it.
    if (state.view !== 'ground') {
      // A hell command long-press already fired on this pointer — swallow the
      // release so it doesn't double as a tap-select on top of the command.
      if (input.longPressPointerId === e.pointerId) cancelLongPress(input);
      if (input.longPressFired) {
        input.longPressFired = false;
        input.spaceTapStart = null;
        input.spaceSelectionGfx.clear();
        return;
      }
      const start = input.spaceTapStart;
      input.spaceTapStart = null;
      input.spaceSelectionGfx.clear();
      if (start) {
        const moved = Math.hypot(e.global.x - start.x, e.global.y - start.y);
        if (state.view === 'hell') {
          if (moved < SPACE_DRAG_TOL) {
            const hp = e.getLocalPosition(ctx.hellLayer);
            // Candle placement armed: the tap places a candle on a mirror's
            // outer ring (or beeps) instead of selecting anything. Stays armed
            // so several candles can be placed in a row; ESC / right-click /
            // the button toggle it off.
            if (state.pendingCandle) {
              tryPlaceCandle(state, ctx, hp.x, hp.y);
              return;
            }
            // A small precise ghost wins over the giant demon hit box behind it,
            // so a soul standing on the demon can still be picked. The Hell
            // Beacon (portal mirror) is likewise a small target that beats the
            // demon, but a soul on top of it still takes priority. Inside the
            // demon's vast halo the small targets also get widened hit radii
            // (see underDemonMult) — without that, anything but a pixel-perfect
            // click on a soul/chair sharing his footprint resolves to him.
            const dmHit = demonAtHell(state, hp.x, hp.y);
            const mult = dmHit ? UNDER_DEMON_RADIUS_MULT : 1;
            const gh = ghostAtHell(state, hp.x, hp.y, HELL.ghostHitRadius * mult);
            const portal = gh ? null : hellPortalAt(state, hp.x, hp.y);
            // Soul chairs beat the giant demon behind them but yield to a soul
            // or the beacon sitting on top.
            const chair = (gh || portal) ? null : soulChairAt(state, hp.x, hp.y, SOUL_SIGIL.chairRadius * mult);
            const dm = (gh || portal || chair) ? null : dmHit;
            if (!e.shiftKey) clearSelection(state);
            // Souls count against the unit-selection cap (see the ground view).
            if (gh && selectedUnitCount(state) >= MAX_SELECTED_UNITS) {
              playSound('error');
              refuseOverCap(state, hp.x, hp.y, 'hell', ctx.renderScale / currentHellScale(ctx));
            }
            else if (gh) { selectGhost(state, gh); playSound('select', 0.33); }
            else if (portal) { portal.selected = true; playSound('select', 0.33); }
            else if (chair) { chair.selected = true; playSound('select', 0.33); }
            else if (dm) { dm.selected = true; playSound('select', 0.33); }
          } else {
            const a = e.getLocalPosition(ctx.hellLayer);
            const b = ctx.hellLayer.toLocal({ x: start.x, y: start.y });
            const x1 = Math.min(a.x, b.x), y1 = Math.min(a.y, b.y);
            const x2 = Math.max(a.x, b.x), y2 = Math.max(a.y, b.y);
            if (!e.shiftKey) clearSelection(state);
            // Same cap dance as the ground box: gather, then take up to the
            // MAX_SELECTED_UNITS room left (shift keeps what's already held).
            const grabbed: Ghost[] = [];
            for (const g of state.ghosts) {
              const p = ghostHellPos(state, g);
              if (p.x >= x1 && p.x <= x2 && p.y >= y1 && p.y <= y2) grabbed.push(g);
            }
            const room = Math.max(0, MAX_SELECTED_UNITS - selectedUnitCount(state));
            const taken = grabbed.slice(0, room);
            for (const g of taken) selectGhost(state, g);
            const count = taken.length;
            if (count > 0) playSound('select', 0.33);
            if (grabbed.length > room) {
              if (count === 0) playSound('error');
              refuseOverCap(state, a.x, a.y, 'hell', ctx.renderScale / currentHellScale(ctx));
            }
            if (count >= 2) state.multiSelectSeen = true;
          }
        } else if (moved < SPACE_DRAG_TOL) {
          const lp = e.getLocalPosition(ctx.spaceLayer);
          // Orbital Platform placement armed: the tap deploys the scaffold
          // instead of selecting anything (or beeps if Ƶ runs short).
          if (state.pendingOrbital) {
            tryPlaceOrbital(state, lp.x, lp.y);
            return;
          }
          // Space Centre placement armed: the tap sets one down on the
          // platform under it — bare void refuses with a "no platform" floater.
          if (state.pendingSpaceCentre) {
            tryPlaceSpaceCentre(state, lp.x, lp.y);
            return;
          }
          // A small drifting unit wins over the building it may be passing in
          // front of; ambient dragons sit behind everything, so they only get
          // a hit when nothing higher-priority is under the pointer.
          const su = spaceUnitAt(state, lp.x, lp.y);
          const sb = su ? null : spaceBuildingAt(state, lp.x, lp.y);
          const ad = (su || sb) ? null : ambientDragonAt(ctx, lp.x, lp.y);
          if (!e.shiftKey) clearSelection(state);
          // Drifting units count against the unit-selection cap; buildings don't.
          if (su && selectedUnitCount(state) >= MAX_SELECTED_UNITS) {
            playSound('error');
            refuseOverCap(state, lp.x, lp.y, 'space');
          }
          else if (su) { su.selected = true; playSound('select', 0.33); }
          else if (sb) { sb.selected = true; playSound('select', 0.33); }
          else if (ad) { state.selectedAmbientDragonId = ad.id; playSound('select', 0.33); }
        } else {
          // Box corners: drag origin + release point, both mapped to space-layer
          // coords (where the floating buildings live).
          const a = e.getLocalPosition(ctx.spaceLayer);
          const b = ctx.spaceLayer.toLocal({ x: start.x, y: start.y });
          const x1 = Math.min(a.x, b.x), y1 = Math.min(a.y, b.y);
          const x2 = Math.max(a.x, b.x), y2 = Math.max(a.y, b.y);
          if (!e.shiftKey) clearSelection(state);
          // Buildings select freely; only the drifting units are capped.
          let count = 0;
          for (const sb of state.spaceBuildings.values()) {
            if (sb.pos.x >= x1 && sb.pos.x <= x2 && sb.pos.y >= y1 && sb.pos.y <= y2) {
              sb.selected = true;
              count++;
            }
          }
          const grabbed: SpaceUnit[] = [];
          for (const su of state.spaceUnits.values()) {
            if (su.pos.x >= x1 && su.pos.x <= x2 && su.pos.y >= y1 && su.pos.y <= y2) grabbed.push(su);
          }
          const room = Math.max(0, MAX_SELECTED_UNITS - selectedUnitCount(state));
          const taken = grabbed.slice(0, room);
          for (const su of taken) su.selected = true;
          count += taken.length;
          if (count > 0) playSound('select', 0.33);
          if (grabbed.length > room) {
            if (count === 0) playSound('error');
            refuseOverCap(state, a.x, a.y, 'space');
          }
          if (count >= 2) state.multiSelectSeen = true;
        }
      }
      return;
    }
    if (input.longPressPointerId === e.pointerId) cancelLongPress(input);
    if (input.longPressFired) {
      input.longPressFired = false;
      input.isDragging = false;
      input.selectionGfx.clear();
      return;
    }
    if (!input.isDragging) return;
    input.isDragging = false;
    const local = e.getLocalPosition(worldLayer);
    const dist = Math.hypot(local.x - input.dragStart.x, local.y - input.dragStart.y);
    const additive = e.shiftKey;
    if (dist < 4) {
      const g = goblinAt(state, local.x, local.y);
      const d = g ? null : dragonAt(state, local.x, local.y);
      const m = (g || d) ? null : minotaurAt(state, local.x, local.y);
      // The rampaging duo are selectable like any other unit (small units
      // near her bulk stay pickable — they're checked first).
      const lolly = (g || d || m) ? false : lollyAt(state, local.x, local.y);
      let b: Building | null = null;
      let onHole = false;
      let w: WaterSource | null = null;
      if (!g && !d && !m && !lolly) {
        const c = pixelToCell(local.x, local.y);
        b = buildingAtCell(state, c.cx, c.cy);
        // A hole Lolly has destroyed no longer renders, so it shouldn't take
        // a click either.
        if (!b) onHole = !state.holeDestroyed && holeAtCell(state, c.cx, c.cy);
        if (!b && !onHole) w = waterSourceAtCell(state, c);
      }
      if (!additive) clearSelection(state);
      // Shift-clicking one more unit onto a full selection refuses outright —
      // buildings, the hole, and water aren't units, so they still take.
      if ((g || d || m) && selectedUnitCount(state) >= MAX_SELECTED_UNITS) {
        playSound('error');
        refuseOverCap(state, local.x, local.y);
      }
      else if (g) { g.selected = true; playSound('select', 0.33); }
      else if (d) { d.selected = true; playSound('select', 0.33); }
      else if (m) { m.selected = true; playSound('select', 0.33); }
      else if (lolly) { state.lolly!.selected = true; playSound('select', 0.33); }
      else if (b) { b.selected = true; playSound('select', 0.33); }
      else if (onHole) { state.hole.selected = true; playSound('select', 0.33); }
      else if (w) { w.selected = true; playSound('select', 0.33); }
    } else {
      const x1 = Math.min(input.dragStart.x, local.x);
      const y1 = Math.min(input.dragStart.y, local.y);
      const x2 = Math.max(input.dragStart.x, local.x);
      const y2 = Math.max(input.dragStart.y, local.y);
      if (!additive) clearSelection(state);
      // Gather everything inside the box first so MAX_SELECTED_UNITS can
      // truncate the grab deterministically (goblins, then minotaurs, then
      // dragons). With shift held, what's already selected eats into the cap.
      const grabbed: Array<Goblin | Minotaur | Dragon> = [];
      for (const g of state.goblins.values()) {
        if (g.pos.x >= x1 && g.pos.x <= x2 && g.pos.y >= y1 && g.pos.y <= y2) grabbed.push(g);
      }
      for (const m of state.minotaurs.values()) {
        if (m.pos.x >= x1 && m.pos.x <= x2 && m.pos.y >= y1 && m.pos.y <= y2) grabbed.push(m);
      }
      for (const d of state.dragons.values()) {
        if (d.pos.x >= x1 && d.pos.x <= x2 && d.pos.y >= y1 && d.pos.y <= y2) grabbed.push(d);
      }
      const room = Math.max(0, MAX_SELECTED_UNITS - selectedUnitCount(state));
      const taken = grabbed.slice(0, room);
      for (const u of taken) u.selected = true;
      let count = taken.length;
      // Designer mode: a drag-box also rubber-band-selects every building whose
      // footprint overlaps it (no cap — they aren't units), so a group can be
      // deleted at once from the info panel. Outside the designer, buildings are
      // single-click only, exactly as before.
      if (designerNow()) {
        for (const b of state.buildings.values()) {
          const def = BUILDING_DEFS[b.kind];
          const bx1 = b.cell.cx * CELL;
          const by1 = b.cell.cy * CELL;
          const bx2 = bx1 + def.cellSize * CELL;
          const by2 = by1 + def.cellSize * CELL;
          if (bx1 < x2 && bx2 > x1 && by1 < y2 && by2 > y1) {
            b.selected = true;
            count++;
          }
        }
      }
      if (count > 0) playSound('select', 0.33);
      if (grabbed.length > room) {
        if (count === 0) playSound('error');
        refuseOverCap(state, local.x, local.y);
      }
      // Onboarding gate: any drag that grabbed 2+ creatures counts as the
      // player "discovering" multi-select, hiding the drag-select hint forever.
      if (count >= 2) state.multiSelectSeen = true;
    }
    input.selectionGfx.clear();
  };
  app.stage.on('pointerup', onPointerUp);
  app.stage.on('pointerupoutside', onPointerUp);
  app.stage.on('pointercancel', onPointerUp);

  // ── Stale-pointer reconciliation ────────────────────────────────────────
  // iOS Safari can swallow a touch's pointerup/pointercancel entirely when a
  // system gesture takes over mid-press (revealing the bottom toolbar with an
  // edge swipe, app switch, notification pull). The orphaned entry then sits
  // in input.pointers forever, after which every one-finger tap counts as a
  // "second finger": pointerdown takes the two-finger-pan branch and
  // pointerup hits the wasPanning early-return — and the wasPanning path only
  // deletes the NEW pointer, so the canvas stays dead until a reload. The
  // browser's TouchEvent.touches list is authoritative, so on every touch
  // transition drop the oldest tracked touches until the map matches it.
  // (A finger's pointer events fire before its compatibility touch events,
  // so by touchstart the new finger is already in the map and never pruned.)
  const reconcileTouchPointers = (e: TouchEvent) => {
    const live = e.touches.length;
    let tracked = 0;
    for (const p of input.pointers.values()) if (p.touch) tracked++;
    if (tracked <= live) return;
    // Map iteration follows insertion order — the oldest entries are the
    // stale ones. Mouse/pen pointers get reliable up events; skip them.
    for (const [id, p] of input.pointers) {
      if (tracked <= live) break;
      if (!p.touch) continue;
      input.pointers.delete(id);
      tracked--;
    }
    if (input.pointers.size < 2) input.panLast = null;
    if (input.pointers.size === 0) resetGestureState(input);
  };
  window.addEventListener('touchstart', reconcileTouchPointers, { capture: true, passive: true });
  window.addEventListener('touchend', reconcileTouchPointers, { capture: true, passive: true });
  window.addEventListener('touchcancel', reconcileTouchPointers, { capture: true, passive: true });

  // No touch survives the page going to the background — drop every tracked
  // pointer outright so a gesture interrupted by an app/tab switch can't
  // leave the map poisoned even if the touch listeners above never fire.
  const dropAllPointers = () => {
    input.pointers.clear();
    input.panLast = null;
    resetGestureState(input);
  };
  window.addEventListener('blur', dropAllPointers);
  window.addEventListener('pagehide', dropAllPointers);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') dropAllPointers();
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      state.pendingBuild = null;
      state.pendingStrike = false;
      state.pendingCandle = false;
      state.pendingOrbital = false;
      state.pendingSpaceCentre = false;
      state.pendingOriginalHole = false;
      input.placementGhost.clear();
      return;
    }
    // Space = "give a command" at the cursor, mirroring a desktop right-click.
    // Works in the ground view (unit orders), the hell view (steering souls),
    // and the space view (steering robots).
    if (e.code === 'Space') {
      const ae = document.activeElement as HTMLElement | null;
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;
      e.preventDefault();
      const lp = input.lastPointer;
      if (!lp) return;
      flashCursor(lp.client.x, lp.client.y);
      if (state.view === 'hell') {
        const hp = ctx.hellLayer.toLocal({ x: lp.global.x, y: lp.global.y });
        handleHellRightClick(state, hp.x, hp.y);
      } else if (state.view === 'space') {
        const sp = ctx.spaceLayer.toLocal({ x: lp.global.x, y: lp.global.y });
        handleSpaceRightClick(state, sp.x, sp.y);
      } else if (state.view === 'ground') {
        const world = worldLayer.toLocal({ x: lp.global.x, y: lp.global.y });
        handleRightClick(state, world.x, world.y);
      }
    }
  });

  setupBuildButtonDrag(state, app, worldLayer, input);

  return input;
}

// Drag-and-drop placement: pressing a sidebar build button and dragging onto
// the play area places that building where the pointer is released — an
// alternative to the click-then-tap-to-place flow. A press that doesn't move
// past the threshold falls through to the button's own click handler.
function setupBuildButtonDrag(
  state: GameState,
  app: Application,
  worldLayer: Container,
  input: InputState,
) {
  const DRAG_THRESHOLD = 8; // screen-space px before a press becomes a drag
  let dragKind: BuildingKind | null = null;
  let dragBtn: HTMLElement | null = null;
  let startX = 0, startY = 0;
  let dragging = false;

  // Screen → world: returns world coords when the pointer is over the canvas,
  // or null when it's outside the play area (sidebar, off-window, etc.).
  const worldAt = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const rect = app.canvas.getBoundingClientRect();
    if (clientX < rect.left || clientX > rect.right ||
        clientY < rect.top || clientY > rect.bottom) return null;
    return worldLayer.toLocal({ x: clientX - rect.left, y: clientY - rect.top });
  };

  for (const kind of BUILDABLE_KINDS) {
    const btn = document.getElementById(`btn-build-${kind}`);
    if (!btn) continue;
    btn.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if ((btn as HTMLButtonElement).disabled) return;
      dragKind = kind;
      dragBtn = btn;
      startX = e.clientX;
      startY = e.clientY;
      dragging = false;
    });
  }

  window.addEventListener('pointermove', (e) => {
    if (!dragKind) return;
    if (!dragging) {
      if (Math.hypot(e.clientX - startX, e.clientY - startY) < DRAG_THRESHOLD) return;
      dragging = true;
      // Enter placement mode so the ghost + existing canvas handlers engage.
      state.pendingBuild = { kind: dragKind };
    }
    const world = worldAt(e.clientX, e.clientY);
    if (world) drawGhost(input, world.x, world.y, state);
    else input.placementGhost.clear();
  });

  window.addEventListener('pointerup', (e) => {
    if (!dragKind) return;
    const wasDragging = dragging;
    const btn = dragBtn;
    dragKind = null;
    dragBtn = null;
    dragging = false;
    // A press that never crossed the threshold is a plain click — leave it
    // to the button's own click handler.
    if (!wasDragging) return;
    const world = worldAt(e.clientX, e.clientY);
    if (world) placeBuilding(state, world.x, world.y);
    // The drag gesture is self-contained: clear any pending placement so a
    // failed/edge drop doesn't leave a sticky ghost (placeBuilding already
    // clears it on a successful non-wall placement).
    state.pendingBuild = null;
    input.placementGhost.clear();
    // Swallow the click the browser dispatches after this pointerup so it
    // doesn't re-toggle pendingBuild via the button's click handler.
    if (btn) {
      const swallow = (ev: Event) => { ev.stopImmediatePropagation(); ev.preventDefault(); };
      btn.addEventListener('click', swallow, { capture: true, once: true });
      window.setTimeout(() => btn.removeEventListener('click', swallow, true), 0);
    }
  });

  window.addEventListener('pointercancel', () => {
    if (dragKind && dragging) {
      state.pendingBuild = null;
      input.placementGhost.clear();
    }
    dragKind = null;
    dragBtn = null;
    dragging = false;
  });
}

function scheduleLongPress(
  input: InputState,
  pointerId: number,
  state: GameState,
  ctx: RenderContext,
  worldLayer: Container,
) {
  cancelLongPress(input);
  input.longPressPointerId = pointerId;
  input.longPressFired = false;
  input.longPressTimer = window.setTimeout(() => {
    const tracked = input.pointers.get(pointerId);
    if (!tracked) return;
    if (input.pointers.size !== 1) return;
    const moved = Math.hypot(tracked.x - tracked.startX, tracked.y - tracked.startY);
    if (moved > LONG_PRESS_MOVE_TOL) return;
    input.longPressFired = true;
    // Cancel any in-progress drag-select; long-press has taken over. Also drop
    // the pending tap-select so the upcoming pointerup doesn't re-select on top
    // of the command (hell view resolves taps from spaceTapStart on pointerup).
    input.isDragging = false;
    input.selectionGfx.clear();
    input.spaceTapStart = null;
    if (state.pendingBuild || state.pendingCandle || state.pendingOrbital || state.pendingSpaceCentre) {
      // No keyboard ESC on touch — long-press cancels pending placement.
      state.pendingBuild = null;
      state.pendingCandle = false;
      state.pendingOrbital = false;
      state.pendingSpaceCentre = false;
      input.placementGhost.clear();
      return;
    }
    flashCursor(tracked.x, tracked.y);
    // Touch has no right-click, so long-press is the "command" gesture. In hell
    // the command target lives in hell-layer space (souls, the demon, soul
    // chairs); in orbit it's the space layer (robots); on the ground it's the
    // world layer.
    if (state.view === 'hell') {
      const hp = ctx.hellLayer.toLocal({ x: tracked.x, y: tracked.y });
      handleHellRightClick(state, hp.x, hp.y);
    } else if (state.view === 'space') {
      const sp = ctx.spaceLayer.toLocal({ x: tracked.x, y: tracked.y });
      handleSpaceRightClick(state, sp.x, sp.y);
    } else {
      const world = worldLayer.toLocal({ x: tracked.x, y: tracked.y });
      handleRightClick(state, world.x, world.y);
    }
  }, LONG_PRESS_MS);
}

// Abandon any in-flight single-pointer gesture (drag-select, pending tap,
// long-press) without touching the pointers map itself. Used when pointer
// tracking is reset wholesale (stale-pointer reconciliation, tab hidden).
function resetGestureState(input: InputState) {
  cancelLongPress(input);
  input.longPressFired = false;
  input.isDragging = false;
  input.spaceTapStart = null;
  input.selectionGfx.clear();
  input.spaceSelectionGfx.clear();
}

function cancelLongPress(input: InputState) {
  if (input.longPressTimer !== null) {
    clearTimeout(input.longPressTimer);
    input.longPressTimer = null;
  }
  input.longPressPointerId = null;
}

// One grunt per goblin, staggered ~90ms apart with a touch of jitter so a group
// command sounds like a chorus instead of a single overlapped blob. Robots
// answer with the same sample resampled well above the goblin range
// (1.6–2.4× vs 0.5–1.5×), so the chrome chirps read distinctly against the
// flesh-and-blood grunts in a mixed selection.
function playGruntBurst(count: number, robot = false) {
  for (let i = 0; i < count; i++) {
    const delay = i * 100;
    setTimeout(() => {
      const rate = robot ? 1.6 + Math.random() * 0.8 : 0.5 + Math.random();
      playSound('command_3', 1, rate);
    }, delay);
  }
}

// New player command — give the minotaur a fresh stuck-detection window so a
// stale streak from the previous order doesn't immediately bail this one out.
function resetMinotaurStuck(m: Minotaur, now: number) {
  m.stuckSampleCell = m.cell;
  m.stuckSampleAt = now;
  m.stuckStreak = 0;
}

// A guttural roar per commanded dragon — the 'ritual' sample pitched right
// down so it reads as a beastly bellow, staggered so several dragons chorus.
function playDragonRoarBurst(count: number) {
  for (let i = 0; i < count; i++) {
    const delay = i * 160;
    setTimeout(() => {
      playSound('ritual', 0.6, 0.4 + Math.random() * 0.1);
    }, delay);
  }
}

// Draw the space-view rubber-band box. Coords are screen-space (the graphic is
// a direct child of the stage), so x0/y0/x1/y1 are raw pointer globals.
function drawSpaceSelectionRect(input: InputState, x0: number, y0: number, x1: number, y1: number) {
  const x = Math.min(x0, x1), y = Math.min(y0, y1);
  const w = Math.abs(x1 - x0), h = Math.abs(y1 - y0);
  input.spaceSelectionGfx
    .clear()
    .rect(x, y, w, h)
    .fill({ color: 0xffd96b, alpha: 0.1 })
    .stroke({ width: 1, color: 0xffd96b });
}

// Rampaging Lolly under the cursor (a generous radius on her colossal
// sprite). Only while the rampage is live — the finale's scripted Lolly
// takes no taps.
function lollyAt(state: GameState, x: number, y: number): boolean {
  const L = state.lolly;
  if (!L || state.finale) return false;
  return Math.hypot(L.pos.x - x, L.pos.y - y) <= LOLLY.displayPx * 0.35;
}

function clearSelection(state: GameState) {
  if (state.lolly) state.lolly.selected = false;
  for (const g of state.goblins.values()) g.selected = false;
  for (const m of state.minotaurs.values()) m.selected = false;
  for (const d of state.dragons.values()) d.selected = false;
  for (const b of state.buildings.values()) b.selected = false;
  for (const w of state.waterSources.values()) w.selected = false;
  for (const sb of state.spaceBuildings.values()) sb.selected = false;
  for (const su of state.spaceUnits.values()) su.selected = false;
  for (const gh of state.ghosts) gh.selected = false;
  for (const d of state.demons.values()) d.selected = false;
  for (const c of state.soulChairs) c.selected = false;
  state.hole.selected = false;
  state.selectedAmbientDragonId = null;
}

// How many units are currently selected, across every scene — ground
// creatures, hell souls, space drifters. Buildings, chairs, demons, the
// hole, etc. don't count: MAX_SELECTED_UNITS only guards units.
function selectedUnitCount(state: GameState): number {
  let n = 0;
  for (const g of state.goblins.values()) if (g.selected) n++;
  for (const m of state.minotaurs.values()) if (m.selected) n++;
  for (const d of state.dragons.values()) if (d.selected) n++;
  for (const gh of state.ghosts) if (gh.selected) n++;
  for (const su of state.spaceUnits.values()) if (su.selected) n++;
  return n;
}

// A selection that ran into MAX_SELECTED_UNITS: short red floater at the
// click/release point so the player knows why the rest didn't take. The
// caller decides whether an error beep goes with it (only when nothing new
// was selected at all — a truncated box still plays its select chirp).
function refuseOverCap(state: GameState, x: number, y: number, scene?: 'space' | 'hell', sizeMult?: number) {
  pushFloater(state, x, y - 24, `max ${MAX_SELECTED_UNITS} units`, 0xd96b6b, 1.6, undefined, scene === 'space', scene === 'hell', sizeMult);
}

// Mark a ghost as selected. The sim only tracks an explicit hx/hy once a ghost
// has been "touched"; seed them from its current drift-derived position here so
// the next walk command starts from where it actually is on screen.
function selectGhost(state: GameState, g: Ghost) {
  g.selected = true;
  if (g.hx === undefined || g.hy === undefined) {
    const p = ghostHellPos(state, g);
    g.hx = p.x;
    g.hy = p.y;
  }
}

// A refused placement: error beep, a short red floater right at the attempted
// spot saying WHY, and the full sentence in the log. On touch there's no hover
// (so desktop-only ghost tags never show) and the log is typically off-screen,
// making the floater the only on-canvas explanation. `scene` picks which
// transform the floater rides — ground world layer when omitted.
function refusePlacement(
  state: GameState,
  x: number, y: number,
  why: string, log: string,
  scene?: 'space' | 'hell',
  sizeMult?: number,
) {
  playSound('error');
  pushFloater(state, x, y - 24, why, 0xd96b6b, 1.6, undefined, scene === 'space', scene === 'hell', sizeMult);
  appendLog(state, log);
}

// Place a candle at a tapped hell coord while candle mode is armed. Snaps to
// the nearest mirror's outer ring (candleSpotAt); refuses (beep + floater +
// log line) when the tap misses every ring, the ring is full/crowded, or
// blood runs short.
// Placement mode stays armed afterwards so a run of candles goes down fast.
function tryPlaceCandle(state: GameState, ctx: RenderContext, hx: number, hy: number) {
  // Hell floaters ride the hell transform, which is zoomed out relative to
  // the ground (down to HELL.zoomedOutScale) — scale the text back up so the
  // refusal reads the same size as its overworld counterparts.
  const sizeMult = ctx.renderScale / currentHellScale(ctx);
  const spot = candleSpotAt(state, hx, hy);
  if (!spot) {
    refusePlacement(state, hx, hy, 'needs a mirror ring',
      "Candles only take on a mirror's outer ring.", 'hell', sizeMult);
    return;
  }
  if (!spot.ok) {
    refusePlacement(state, spot.x, spot.y,
      spot.blocked === 'full' ? 'ring full' : 'too close',
      spot.blocked === 'full'
        ? 'That ring already bears its five candles.'
        : 'Too close to another candle.', 'hell', sizeMult);
    return;
  }
  if (state.blood < SOUL_SIGIL.candleBloodCost) {
    refusePlacement(state, hx, hy, `need ${SOUL_SIGIL.candleBloodCost} blood`,
      `Need ${SOUL_SIGIL.candleBloodCost} blood to place a candle.`, 'hell', sizeMult);
    return;
  }
  state.blood -= SOUL_SIGIL.candleBloodCost;
  placeCandle(state, spot);
  playSound('place', 1.3);
  const placed = state.soulChairs.filter((c) => c.portalId === spot.portal.id).length;
  if (placed >= SOUL_SIGIL.count) {
    playSound('ritual', 0.7, 0.7);
    appendLog(state, 'The fifth candle takes — the pentagram is drawn, and the chairs hunger for souls.');
  } else {
    appendLog(state, `A candle gutters to life on the ring (${placed}/${SOUL_SIGIL.count}).`);
  }
}

// Deploy an Orbital Platform scaffold at a tapped SPACE coord while placement
// is armed. Costs money up front; arrives as a constructing building that only
// a robot (snatched to space by a dragon) can assemble. Unlike the candle,
// placement disarms after one drop — platforms are a considered purchase.
function tryPlaceOrbital(state: GameState, x: number, y: number) {
  const def = BUILDING_DEFS.orbital_platform;
  if (state.money < def.cost) {
    refusePlacement(state, x, y, `need Ƶ${def.cost.toLocaleString('en-US')}`, 'Not enough Ƶ.', 'space');
    return;
  }
  // Clamp inside the void's bounds so the scaffold can't hide off-scene —
  // by half the footprint, since the deck is now wide enough that the old
  // unit-margin clamp would let its edges poke out of the scene.
  const halfClamp = Math.max(SPACE_UNIT.margin, def.size / 2);
  const px = Math.max(halfClamp, Math.min(SPACE.width - halfClamp, x));
  const py = Math.max(halfClamp, Math.min(SPACE.height - halfClamp, y));
  // Platforms are anchored — two may never share deck space.
  if (spaceStructureOverlapAt(state, 'orbital_platform', px, py)) {
    refusePlacement(state, px, py, 'overlaps a platform',
      'Orbital Platforms cannot overlap each other.', 'space');
    return;
  }
  state.money -= def.cost;
  const b: Building = {
    id: state.nextId++,
    displayNum: nextBuildingDisplayNum(state, 'orbital_platform'),
    kind: 'orbital_platform',
    cell: { cx: 0, cy: 0 },   // never on the grid — placeholder only
    state: 'constructing',
    buildProgress: 0,
    assignedGoblins: [],
    selected: false,
  };
  state.spaceBuildings.set(b.id, {
    id: b.id,
    building: b,
    pos: { x: px, y: py },
    vel: { x: 0, y: 0 },      // platforms hold station
    spin: 0,
    spinRate: 0,
    selected: false,
  });
  state.pendingOrbital = false;
  playSound('place', 1.4);
  appendLog(state, `${def.name} #${b.displayNum} scaffold deployed — only a robot can assemble it.`);
}

// Deploy a Space Centre at a tapped SPACE coord while placement is armed.
// Unlike the platform it can't sit in bare void: the tap must land on a
// completed Orbital Platform with no Centre already on it — anywhere else
// refuses with a red "no platform" floater. The Centre snaps to the
// platform's center (their footprints match exactly) and arrives as a
// constructing building only a robot can assemble. Disarms after one drop.
function tryPlaceSpaceCentre(state: GameState, x: number, y: number) {
  const def = BUILDING_DEFS.space_centre;
  const platform = freePlatformAt(state, x, y);
  if (!platform) {
    refusePlacement(state, x, y, 'no platform',
      'A Space Centre can only be built on a free, completed Orbital Platform.', 'space');
    return;
  }
  // Centres snap to their platform's center, so with non-overlapping
  // platforms this can't trip — but platforms placed before the overlap rule
  // existed may still share deck space, and two Centres must never overlap.
  if (spaceStructureOverlapAt(state, 'space_centre', platform.pos.x, platform.pos.y)) {
    refusePlacement(state, x, y, 'overlaps a centre',
      'Space Centres cannot overlap each other.', 'space');
    return;
  }
  if (state.money < def.cost) {
    refusePlacement(state, x, y, `need Ƶ${def.cost.toLocaleString('en-US')}`, 'Not enough Ƶ.', 'space');
    return;
  }
  state.money -= def.cost;
  const b: Building = {
    id: state.nextId++,
    displayNum: nextBuildingDisplayNum(state, 'space_centre'),
    kind: 'space_centre',
    cell: { cx: 0, cy: 0 },   // never on the grid — placeholder only
    state: 'constructing',
    buildProgress: 0,
    assignedGoblins: [],
    selected: false,
  };
  state.spaceBuildings.set(b.id, {
    id: b.id,
    building: b,
    pos: { x: platform.pos.x, y: platform.pos.y },  // flush on the deck
    vel: { x: 0, y: 0 },      // anchored to its platform
    spin: 0,
    spinRate: 0,
    selected: false,
    platformId: platform.id,
  });
  state.pendingSpaceCentre = false;
  playSound('place', 1.4);
  appendLog(state, `${def.name} #${b.displayNum} scaffold set down on ${BUILDING_DEFS.orbital_platform.name} #${platform.building.displayNum} — only a robot can assemble it.`);
}

// Right-click (or long-press / spacebar) in the space view: walk every
// selected robot to the clicked space-coord, just like commanding goblins on
// the ground. Multiple robots fan out around the point so they don't pile up.
// Non-robot castaways can't be steered (they're busy suffocating); a selection
// with no robots in it just error-beeps.
function handleSpaceRightClick(state: GameState, x: number, y: number) {
  if (spectatingNow()) return; // a spectated world takes no orders
  const robots = [...state.spaceUnits.values()].filter((su) => su.selected && su.robot);
  if (robots.length === 0) { playSound('error'); return; }
  const m = SPACE_UNIT.margin;
  robots.forEach((su, i) => {
    // First robot lands exactly on the click; the rest take jittered spots
    // around it (mirroring the hell ghost fan-out).
    const dx = i === 0 ? 0 : (Math.random() - 0.5) * 70;
    const dy = i === 0 ? 0 : (Math.random() - 0.5) * 70;
    su.goal = {
      x: Math.max(m, Math.min(SPACE.width - m, x + dx)),
      y: Math.max(m, Math.min(SPACE.height - m, y + dy)),
    };
  });
  // Robots are goblins under the chrome — same command sample, one per unit,
  // chirped up into the robot register.
  playGruntBurst(robots.length, true);
  appendLog(state, `${robots.length} robot${robots.length === 1 ? '' : 's'} ordered across the void.`);
}

// Commanded souls answer with their living cry made distant — the same per-kind
// command bursts as surface units, sent through the ghostly reverb (see
// playGhostCommand in audio.ts). One burst per kind present in the group.
function playGhostCommandBurst(ghosts: Ghost[]) {
  const tally: Record<Ghost['kind'], number> = { goblin: 0, minotaur: 0, dragon: 0 };
  for (const g of ghosts) tally[g.kind]++;
  for (const kind of ['goblin', 'minotaur', 'dragon'] as const) {
    if (tally[kind] > 0) playGhostCommand(kind, tally[kind]);
  }
}

// Right-click in hell view: walk every selected ghost to the clicked hell-coord.
// Multiple ghosts get a small per-ghost offset so they don't pile up exactly on
// the same point. No-op (with an error beep) if nothing is selected.
function handleHellRightClick(state: GameState, hx: number, hy: number) {
  if (spectatingNow()) return; // a spectated world takes no orders
  // Commanding a bound chair away from its candle frees the soul: any
  // selected occupied chair unseats its occupant on the spot, and the freed
  // ghost inherits the selection so it takes the walk order (and the info
  // panel) like any other soul. A command onto the chair itself isn't
  // "away" — the soul stays bound.
  for (const chair of state.soulChairs) {
    if (!chair.selected || !chair.occupied) continue;
    if (Math.hypot(hx - chair.hx, hy - chair.hy) <= SOUL_SIGIL.chairRadius) continue;
    const freed = unseatSoulFromChair(state, chair);
    if (freed) {
      chair.selected = false;
      freed.selected = true;
    }
  }

  const selected = state.ghosts.filter((g) => g.selected);
  if (selected.length === 0) { playSound('error'); return; }

  // Resolve the demon up front purely to widen the chair/soul hit radii when
  // the click lands inside his vast halo (see UNDER_DEMON_RADIUS_MULT) — he
  // stays the lowest-priority target, claiming the command only when no chair
  // or soul is anywhere near the click.
  const demonUnderClick = demonAtHell(state, hx, hy);
  const radiusMult = demonUnderClick ? UNDER_DEMON_RADIUS_MULT : 1;

  // Right-clicking a soul chair seats a single soul in it. Sending a whole
  // selection at one chair would just pile them up, so only the NEAREST
  // eligible soul of the group actually walks over; the rest keep their orders.
  // Bob is exempt — he's no fuel for the sigil. Until all five candles stand
  // on the ring there are no chairs to bind — only waiting candles.
  const chair = soulChairAt(state, hx, hy, SOUL_SIGIL.chairRadius * radiusMult);
  if (chair) {
    const ringSize = state.soulChairs.filter((c) => c.portalId === chair.portalId).length;
    if (ringSize < SOUL_SIGIL.count) {
      playSound('error');
      const left = SOUL_SIGIL.count - ringSize;
      appendLog(state, `The pentagram is unfinished — it needs ${left} more candle${left === 1 ? '' : 's'} before souls can be bound.`);
      return;
    }
    if (chair.occupied) {
      playSound('error');
      appendLog(state, 'That chair is already bound to a soul.');
      return;
    }
    let nearest: Ghost | null = null;
    let nearestD = Infinity;
    for (const g of selected) {
      if (g.bob) continue;
      if (g.hx === undefined || g.hy === undefined) {
        const p = ghostHellPos(state, g);
        g.hx = p.x; g.hy = p.y;
      }
      const d = Math.hypot(g.hx - chair.hx, g.hy - chair.hy);
      if (d < nearestD) { nearestD = d; nearest = g; }
    }
    if (!nearest) {
      playSound('error');
      appendLog(state, 'No soul here will take the chair.');
      return;
    }
    // Release any prior chair this soul was claiming, then bind it to this one.
    for (const c of state.soulChairs) if (c.claimedBy === nearest.id) c.claimedBy = undefined;
    nearest.goal = { x: chair.hx, y: chair.hy };
    nearest.parlayDemonId = undefined;
    nearest.chatTargetId = undefined;
    nearest.targetChairId = chair.id;
    nearest.commanded = true;
    chair.claimedBy = nearest.id;
    chair.commandFlashAt = state.now;
    playGhostCommandBurst([nearest]);
    appendLog(state, 'A soul shuffles toward the sigil.');
    return;
  }

  // Right-clicking another soul sends one of the selection over for a chat —
  // two souls meeting can only trade gibberish (see runGhostChat in
  // demon-dialogue.ts; Bob, ever articulate, says hello). Only the NEAREST
  // selected soul walks over, like the chair command; the rest keep their
  // orders. A click on a soul that's part of the selection falls through to
  // a plain move instead. Checked before the demon so a soul standing inside
  // the demon's generous hit radius is still chattable.
  const target = ghostAtHell(state, hx, hy, HELL.ghostHitRadius * radiusMult);
  if (target && !target.selected) {
    if (target.hx === undefined || target.hy === undefined) {
      const p = ghostHellPos(state, target);
      target.hx = p.x; target.hy = p.y;
    }
    let nearest: Ghost | null = null;
    let nearestD = Infinity;
    for (const g of selected) {
      if (g.hx === undefined || g.hy === undefined) {
        const p = ghostHellPos(state, g);
        g.hx = p.x; g.hy = p.y;
      }
      const d = Math.hypot(g.hx - target.hx, g.hy - target.hy);
      if (d < nearestD) { nearestD = d; nearest = g; }
    }
    if (!nearest) { playSound('error'); return; }
    // Walking over for a chat cancels any chair/parlay the soul was bound for.
    for (const c of state.soulChairs) if (c.claimedBy === nearest.id) c.claimedBy = undefined;
    nearest.targetChairId = undefined;
    nearest.parlayDemonId = undefined;
    nearest.chatTargetId = target.id;
    nearest.goal = { x: target.hx, y: target.hy };
    nearest.commanded = true;
    target.commandFlashAt = state.now;
    playGhostCommandBurst([nearest]);
    appendLog(state, 'A soul shuffles over for a chat.');
    return;
  }

  // Right-clicking on (or near) a demon sends the group to it, but only the
  // first soul that can actually speak — a goblin/Bob ghost — parlays. The
  // rest just gather nearby. The demon also has to be free (one soul at a time).
  const demon = demonUnderClick;
  if (demon) {
    // Only one soul may approach the demon at a time. Sending a crowd is
    // refused outright — nobody is commanded and the demon barks them back.
    if (selected.length > 1) {
      playSound('error');
      demonRebuke(demon, 'one at a time please');
      appendLog(state, 'The demon rumbles: one soul at a time.');
      return;
    }
    demon.commandFlashAt = state.now;
    const g = selected[0];
    // Any soul may now approach to parlay — goblins, minotaurs and dragons all
    // get their say (most just babble). The demon still only frees up one at a
    // time.
    const canSpeak = demon.busyWith === null;
    const dx = (Math.random() - 0.5) * HELL.ghostHitRadius;
    const dy = (Math.random() - 0.5) * HELL.ghostHitRadius;
    g.goal = { x: demon.hx + dx, y: demon.hy + dy };
    if (g.hx === undefined || g.hy === undefined) {
      const p = ghostHellPos(state, g);
      g.hx = p.x;
      g.hy = p.y;
    }
    // Approaching the demon cancels any chair/chat the soul was bound for.
    g.targetChairId = undefined;
    g.chatTargetId = undefined;
    for (const c of state.soulChairs) if (c.claimedBy === g.id) c.claimedBy = undefined;
    g.parlayDemonId = canSpeak ? demon.id : undefined;
    g.commanded = true;
    playGhostCommandBurst([g]);
    if (canSpeak) appendLog(state, 'A soul shuffles forth to parlay with the demon.');
    else appendLog(state, 'The demon is already locked in parlay.');
    return;
  }

  for (const g of selected) {
    const dx = (Math.random() - 0.5) * HELL.ghostHitRadius;
    const dy = (Math.random() - 0.5) * HELL.ghostHitRadius;
    g.goal = { x: hx + dx, y: hy + dy };
    g.parlayDemonId = undefined; // redirecting cancels any pending parlay
    g.chatTargetId = undefined;  // …and any pending soul-to-soul chat
    // …and any pending chair binding, so the soul actually heads for the cursor
    // instead of being yanked back to its chair each tick.
    if (g.targetChairId !== undefined) {
      for (const c of state.soulChairs) if (c.claimedBy === g.id) c.claimedBy = undefined;
      g.targetChairId = undefined;
    }
    if (g.hx === undefined || g.hy === undefined) {
      const p = ghostHellPos(state, g);
      g.hx = p.x;
      g.hy = p.y;
    }
    g.commanded = true;
  }
  playGhostCommandBurst(selected);
  appendLog(state, `${selected.length} ghost(s) drift toward the cursor.`);
}

function goblinAt(state: GameState, x: number, y: number): Goblin | null {
  for (const g of state.goblins.values()) {
    if (Math.hypot(g.pos.x - x, g.pos.y - y) <= GOBLIN.radius + 2) return g;
  }
  return null;
}

function dragonAt(state: GameState, x: number, y: number): Dragon | null {
  // Generous hit radius — dragons are large and fly overhead.
  for (const d of state.dragons.values()) {
    if (Math.hypot(d.pos.x - x, d.pos.y - y) <= DRAGON.displayPx * 0.42) return d;
  }
  return null;
}

function waterSourceAt(state: GameState, cell: Cell): WaterSource | null {
  return waterSourceAtCell(state, cell);
}

// Pick a building that drinks water (DC, HC). `waterCarrierMax` is a soft
// preference rather than a hard cap: drinkers below the cap are picked
// first; only when every drinker is at/above its cap do we fall back to
// the at-cap pool. Within each tier we still favour the lowest water meter
// so the thirstiest target wins.
function nearestThirstyDatacentre(state: GameState): Building | null {
  let bestBelow: Building | null = null;
  let bestBelowMeter = Infinity;
  let bestAbove: Building | null = null;
  let bestAboveMeter = Infinity;
  for (const b of state.buildings.values()) {
    const def = defOf(b);
    const drinks = (def.waterDeliveryAmount ?? 0) > 0;
    if (!drinks) continue;
    if (b.state === 'constructing') continue;
    const max = def.waterCarrierMax ?? Infinity;
    const m = b.waterMeter ?? 0;
    if (waterCarrierCount(state, b) < max) {
      if (m < bestBelowMeter) { bestBelowMeter = m; bestBelow = b; }
    } else {
      if (m < bestAboveMeter) { bestAboveMeter = m; bestAbove = b; }
    }
  }
  return bestBelow ?? bestAbove;
}

function minotaurAt(state: GameState, x: number, y: number): Minotaur | null {
  // Larger hit-radius than the body collider since the minotaur's sprite is
  // significantly bigger than the goblin's.
  for (const m of state.minotaurs.values()) {
    if (Math.hypot(m.pos.x - x, m.pos.y - y) <= MINOTAUR.radius * 1.4) return m;
  }
  return null;
}

function handleRightClick(state: GameState, x: number, y: number) {
  if (state.view !== 'ground') return; // no commanding from orbit
  if (spectatingNow()) return; // a spectated world takes no orders
  const selectedGoblins = [...state.goblins.values()].filter((g) => g.selected);
  const selectedMinotaurs = [...state.minotaurs.values()].filter((m) => m.selected);
  const selectedDragons = [...state.dragons.values()].filter((d) => d.selected);
  if (selectedGoblins.length === 0 && selectedMinotaurs.length === 0 && selectedDragons.length === 0) return;
  // Robots chirp above the goblin grunts — split the burst by class.
  // (selectedRobots itself is declared below for the laser-target scan.)
  const robotCount = selectedGoblins.reduce((n, g) => n + (g.robot ? 1 : 0), 0);
  if (selectedGoblins.length - robotCount > 0) playGruntBurst(selectedGoblins.length - robotCount);
  if (robotCount > 0) playGruntBurst(robotCount, true);
  if (selectedMinotaurs.length > 0) playMinotaurCommand(selectedMinotaurs.length);
  if (selectedDragons.length > 0) playDragonRoarBurst(selectedDragons.length);

  let targetGoblin = goblinAt(state, x, y);
  // A goblin standing inside a building footprint (a worker/maintainer) shouldn't
  // shadow the building it's in — a command aimed at such a goblin targets the
  // building underneath instead.
  const goblinHostBuilding = targetGoblin
    ? buildingAtCell(state, targetGoblin.cell.cx, targetGoblin.cell.cy)
    : null;
  if (goblinHostBuilding) targetGoblin = null;
  const targetMinotaur = (targetGoblin || goblinHostBuilding) ? null : minotaurAt(state, x, y);
  // Robots fire lasers at any unit they're commanded onto — including
  // dragons — so the dragon-under-cursor scan also runs for them.
  const selectedRobots = selectedGoblins.filter((g) => g.robot);
  // A dragon target for fratricide (or a robot's laser): any non-selected
  // dragon under the cursor. Only meaningful when dragons or robots are
  // selected; skip the scan otherwise.
  let targetDragon: Dragon | null = null;
  if (!targetGoblin && !targetMinotaur && !goblinHostBuilding
    && (selectedDragons.length > 0 || selectedRobots.length > 0)) {
    const selIds = new Set(selectedDragons.map((d) => d.id));
    for (const d of state.dragons.values()) {
      if (selIds.has(d.id)) continue;
      if (Math.hypot(d.pos.x - x, d.pos.y - y) <= DRAGON.displayPx * 0.42) { targetDragon = d; break; }
    }
  }
  // Rampaging Lolly under the cursor — an attack order for whatever's
  // selected (futile, but allowed). Real units near her bulk win the tap.
  const targetLolly = !targetGoblin && !targetMinotaur && !targetDragon
    && !goblinHostBuilding && lollyAt(state, x, y);
  const targetCell = pixelToCell(x, y);
  const targetBuilding = (targetGoblin || targetMinotaur || targetDragon || targetLolly)
    ? null
    : (goblinHostBuilding ?? buildingAtCell(state, targetCell.cx, targetCell.cy));
  const targetWater = (!targetGoblin && !targetMinotaur && !targetDragon && !targetLolly && !targetBuilding)
    ? waterSourceAt(state, targetCell)
    : null;

  // Dragon commands. A dragon flies free of the grid: it can incinerate a unit,
  // lift a specific building toward space, or fly to a point (then resume its
  // default building-hauling behaviour).
  if (selectedDragons.length > 0) {
    // A dragon already hauling a building can't pick up or attack anything —
    // any command instead tells it where to set its load back down (it drops
    // there if there's room, else carries on up to space). Dragons with empty
    // claws take the usual kill / lift / move orders.
    const carryingDragons = selectedDragons.filter((d) => d.carrying);
    // Dragons hauling a snatched unit are committed: space is the only place
    // they can set it down, so they ignore fresh orders entirely.
    const freeDragons = selectedDragons.filter((d) => !d.carrying && !d.carryingUnit);

    for (const d of carryingDragons) {
      d.state = { kind: 'delivering', goal: { x, y } };
    }
    if (carryingDragons.length > 0) {
      appendLog(state, `${carryingDragons.length} dragon(s) hauling a building to a drop-off.`);
    }

    if (freeDragons.length > 0) {
      // A non-dragon unit under the cursor is a snatch order: the dragon
      // grabs it and hauls it up to space, where it dies after a few seconds
      // adrift (robots survive the vacuum). Only dragon-on-dragon remains a
      // kill — fratricide for the bone.
      if (targetGoblin) {
        targetGoblin.commandFlashAt = state.now;
        for (const d of freeDragons) {
          d.state = { kind: 'going_to_unit', targetKind: 'goblin', targetId: targetGoblin.id };
        }
        const label = targetGoblin.robot ? 'Robot' : targetGoblin.bob ? 'Bob' : 'goblin';
        appendLog(state, `${freeDragons.length} dragon(s) diving to snatch ${label} #${targetGoblin.id} into space.`);
      } else if (targetMinotaur) {
        targetMinotaur.commandFlashAt = state.now;
        for (const d of freeDragons) {
          d.state = { kind: 'going_to_unit', targetKind: 'minotaur', targetId: targetMinotaur.id };
        }
        appendLog(state, `${freeDragons.length} dragon(s) diving to snatch Minotaur #${targetMinotaur.id} into space.`);
      } else if (targetDragon) {
        targetDragon.commandFlashAt = state.now;
        for (const d of freeDragons) {
          if (d.id === targetDragon.id) continue;
          d.state = { kind: 'going_to_kill', targetKind: 'dragon', targetId: targetDragon.id };
        }
        appendLog(state, `${freeDragons.length} dragon(s) turning on Dragon #${targetDragon.id}.`);
      } else if (targetBuilding) {
        // Hell Portals are anchored to the abyss — no dragon can lift them.
        if (targetBuilding.kind === 'hell_portal') {
          playSound('error');
          appendLog(state, `${defOf(targetBuilding).name} is rooted to the abyss — dragons cannot move it.`);
        } else {
          targetBuilding.commandFlashAt = state.now;
          for (const d of freeDragons) {
            d.state = { kind: 'going_to_building', buildingId: targetBuilding.id };
          }
          appendLog(state, `${freeDragons.length} dragon(s) sent to haul ${defOf(targetBuilding).name} #${targetBuilding.displayNum} to space.`);
        }
      } else {
        for (const d of freeDragons) {
          d.state = { kind: 'moving_to', goal: { x, y } };
        }
        appendLog(state, `${freeDragons.length} dragon(s) on the wing.`);
      }
    }
  }

  // Water duty: right-click a water source with goblins selected to put them
  // on the loop for the closest under-watered Datacentre.
  if (targetWater && selectedGoblins.length > 0) {
    let assigned = 0;
    for (const g of selectedGoblins) {
      const dc = nearestThirstyDatacentre(state);
      if (!dc) break;
      releaseFromBuilding(state, g);
      dc.assignedGoblins.push(g.id);
      g.goal = null;
      g.path = [];
      g.state = {
        kind: 'fetching_water',
        buildingId: dc.id,
        sourceId: targetWater.id,
        phase: 'to_source',
        initialTarget: { cx: targetCell.cx, cy: targetCell.cy },
      };
      // Reset stuck timer so the new role gets a clean 3s grace window.
      g.lastCellChangedAt = state.now;
      assigned++;
    }
    if (assigned > 0) {
      targetWater.commandFlashAt = state.now;
      appendLog(state, `${assigned} goblin(s) on water duty.`);
      return;
    }
    playSound('error');
    appendLog(state, 'Nothing to water.');
    return;
  }

  // Minotaur commands.
  if (selectedMinotaurs.length > 0) {
    if (targetGoblin) {
      // Manual kill order — flagged `manual` so the auto-targeter doesn't
      // immediately re-assign each minotaur to its own nearest prey. The
      // target's ring flashes like every other command target. Robots are
      // fair game to ORDER onto — the minotaur swings, an "immune" floater
      // pops over the chassis, and nothing dies (see updateMinotaur).
      targetGoblin.commandFlashAt = state.now;
      for (const m of selectedMinotaurs) {
        m.target = null;
        m.state = { kind: 'going_to_kill', targetId: targetGoblin.id, manual: true };
        resetMinotaurStuck(m, state.now);
      }
      appendLog(state, `${selectedMinotaurs.length} minotaur(s) ordered to kill ${targetGoblin.robot ? 'Robot' : 'goblin'} #${targetGoblin.id}.`);
    } else if (targetMinotaur) {
      // Minotaur-on-minotaur — the target itself is excluded.
      const attackers = selectedMinotaurs.filter(m => m.id !== targetMinotaur.id);
      for (const m of attackers) {
        m.target = null;
        m.state = { kind: 'going_to_kill_minotaur', targetId: targetMinotaur.id };
        resetMinotaurStuck(m, state.now);
      }
      if (attackers.length > 0) {
        targetMinotaur.commandFlashAt = state.now;
        appendLog(state, `${attackers.length} minotaur(s) ordered to gore Minotaur #${targetMinotaur.id}.`);
      }
    } else if (targetLolly) {
      // Goring Lolly achieves nothing — but they're allowed to try.
      if (state.lolly) state.lolly.commandFlashAt = state.now;
      for (const m of selectedMinotaurs) {
        m.target = null;
        m.state = { kind: 'going_to_kill_lolly' };
        resetMinotaurStuck(m, state.now);
      }
      appendLog(state, `${selectedMinotaurs.length} minotaur(s) hurl themselves at Lolly.`);
    } else if (targetBuilding) {
      targetBuilding.commandFlashAt = state.now;
      for (const m of selectedMinotaurs) {
        m.target = null;
        m.state = { kind: 'going_to_destroy', buildingId: targetBuilding.id };
        resetMinotaurStuck(m, state.now);
      }
      appendLog(state, `${selectedMinotaurs.length} minotaur(s) ordered to smash ${defOf(targetBuilding).name} #${targetBuilding.displayNum}.`);
    } else {
      // Empty cell — walk there, then resume the usual hunt/wander.
      for (const m of selectedMinotaurs) {
        m.target = null;
        m.state = { kind: 'moving_to', goal: { cx: targetCell.cx, cy: targetCell.cy } };
        resetMinotaurStuck(m, state.now);
      }
      appendLog(state, `${selectedMinotaurs.length} minotaur(s) on the move.`);
    }
  }

  if (selectedGoblins.length === 0) return;

  // Attack orders on Lolly: robots stand fast and laser her, everyone else
  // charges in swinging. None of it works — she answers every hit with a
  // 'no effect' floater — but morale matters.
  if (targetLolly) {
    if (state.lolly) state.lolly.commandFlashAt = state.now;
    const selectedRobotsForLolly = selectedGoblins.filter((g) => g.robot);
    for (const r of selectedRobotsForLolly) {
      releaseFromBuilding(state, r);
      r.goal = null;
      r.path = [];
      r.state = { kind: 'firing_laser', targetKind: 'lolly', targetId: 0 };
    }
    if (selectedRobotsForLolly.length > 0) {
      appendLog(state, `${selectedRobotsForLolly.length} robot(s) lock lasers on Lolly.`);
    }
    const melee = selectedGoblins.filter((g) => !g.robot);
    for (const g of melee) {
      releaseFromBuilding(state, g);
      g.goal = null;
      g.path = [];
      g.state = { kind: 'attacking_lolly' };
    }
    if (melee.length > 0) appendLog(state, `${melee.length} goblin(s) hurl themselves at Lolly.`);
    return;
  }

  // Robot laser order: commanding a robot onto any unit — goblin, minotaur,
  // a dragon, or even another robot — has it stand fast and shoot a laser
  // instead of the melee chase. A robot target soaks the beam with an
  // "immune" floater (nothing kills a robot); the shooter itself is excluded
  // so the order never resolves to "shoot yourself".
  const laserTarget =
    targetGoblin ? { kind: 'goblin' as const, unit: targetGoblin, label: `${targetGoblin.robot ? 'Robot' : 'goblin'} #${targetGoblin.id}` }
    : targetMinotaur ? { kind: 'minotaur' as const, unit: targetMinotaur, label: `Minotaur #${targetMinotaur.id}` }
    : targetDragon ? { kind: 'dragon' as const, unit: targetDragon, label: `Dragon #${targetDragon.id}` }
    : null;
  const laserers = laserTarget === null ? []
    : selectedRobots.filter((r) => !(laserTarget.kind === 'goblin' && r.id === laserTarget.unit.id));
  const lasering = laserers.length > 0;
  if (lasering && laserTarget) {
    laserTarget.unit.commandFlashAt = state.now;
    for (const r of laserers) {
      releaseFromBuilding(state, r);
      r.goal = null;
      r.path = [];
      r.state = { kind: 'firing_laser', targetKind: laserTarget.kind, targetId: laserTarget.unit.id };
    }
    appendLog(state, `${laserers.length} robot(s) lock lasers on ${laserTarget.label}.`);
  }
  // Robots with a firing order are spoken for; the rest of the click applies
  // to the remaining selection.
  const commandables = lasering ? selectedGoblins.filter((g) => !g.robot) : selectedGoblins;
  if (commandables.length === 0) return;

  // Kill order: right-click on another goblin sends every selected attacker
  // toward it. The target itself, even if selected, is excluded so the order
  // never resolves to "kill yourself". A robot target takes the swings with
  // an "immune" floater and survives (see updateGoblin's going_to_kill).
  if (targetGoblin) {
    const attackers = commandables.filter(g => g.id !== targetGoblin.id);
    if (attackers.length > 0) {
      targetGoblin.commandFlashAt = state.now;
      for (const g of attackers) {
        releaseFromBuilding(state, g);
        g.goal = null;
        g.path = [];
        g.state = { kind: 'going_to_kill', targetId: targetGoblin.id };
      }
      appendLog(state, `${attackers.length} goblin(s) ordered to kill #${targetGoblin.id}.`);
      return;
    }
  }

  if (targetBuilding) {
    targetBuilding.commandFlashAt = state.now;
    assignToBuilding(state, commandables, targetBuilding);
  } else {
    const reserved = new Set<string>();
    for (const g of commandables) {
      releaseFromBuilding(state, g);
      const cell = findFreeCellNear(state, targetCell.cx, targetCell.cy, g.id, reserved, 600);
      if (cell) {
        reserved.add(cellKey(cell.cx, cell.cy));
        g.goal = cell;
        g.path = [];
        g.state = { kind: 'moving' };
      } else {
        appendLog(state, `Goblin #${g.id} can't find a path.`);
      }
    }
  }
}

function releaseFromBuilding(state: GameState, g: Goblin) {
  const s = g.state;
  // Every state that carries a buildingId must scrub from that building's
  // assignedGoblins. Missing fetching_water here was the source of the
  // "duplicate IDs on Hypercentre" save bloat — a water carrier reassigned to
  // a new role left a permanent reference behind on its old DC.
  if (s.kind === 'building' || s.kind === 'maintaining' ||
      s.kind === 'going_to_build' || s.kind === 'going_to_maintain' ||
      s.kind === 'fetching_water') {
    const b = state.buildings.get(s.buildingId);
    if (b) {
      const i = b.assignedGoblins.indexOf(g.id);
      if (i >= 0) b.assignedGoblins.splice(i, 1);
    }
  }
}

function assignToBuilding(state: GameState, goblins: Goblin[], b: Building) {
  const def = defOf(b);
  const isBuilding = b.state === 'constructing';
  const role = isBuilding ? 'construct' : 'maintain';

  // Over-assignment is allowed: every selected goblin gets assigned. Extras
  // beyond the required count just enter as additional workers (they'll fan out
  // inside the footprint, or queue at the perimeter if it's full).
  let added = 0;
  for (const g of goblins) {
    if (b.assignedGoblins.includes(g.id)) continue;
    releaseFromBuilding(state, g);
    b.assignedGoblins.push(g.id);
    g.goal = null;
    g.path = [];
    g.state = isBuilding
      ? { kind: 'going_to_build', buildingId: b.id }
      : { kind: 'going_to_maintain', buildingId: b.id };
    added++;
  }
  if (added > 0) {
    appendLog(state, `${added} goblin(s) assigned to ${role} ${def.name} #${b.displayNum}.`);
  }
}

function topLeftFromClick(x: number, y: number, kind: BuildingKind): Cell {
  const center = pixelToCell(x, y);
  const half = Math.floor((BUILDING_DEFS[kind].cellSize - 1) / 2);
  return { cx: center.cx - half, cy: center.cy - half };
}

// Like isCellBlocked, but Goblin Holes (the original and man-made ones) don't
// block — buildings, including Walls, can be placed on top of them.
function cellBlocksPlacement(state: GameState, cx: number, cy: number): boolean {
  if (!isInBounds(cx, cy)) return true;
  if (state.walls.has(cellKey(cx, cy))) return true;
  const b = buildingAtCell(state, cx, cy);
  if (b && b.kind !== 'goblin_hole') return true;
  if (state.occupancy.has(cellKey(cx, cy))) return true;
  if (waterSourceAtCell(state, { cx, cy })) return true;
  return false;
}

function canPlaceBuilding(state: GameState, topLeft: Cell, kind: BuildingKind): boolean {
  const n = BUILDING_DEFS[kind].cellSize;
  for (let dx = 0; dx < n; dx++) {
    for (let dy = 0; dy < n; dy++) {
      const cx = topLeft.cx + dx;
      const cy = topLeft.cy + dy;
      if (cellBlocksPlacement(state, cx, cy)) return false;
    }
  }
  return true;
}

function placeBuilding(state: GameState, x: number, y: number) {
  if (!state.pendingBuild) return;
  if (state.view !== 'ground') { playSound('error'); appendLog(state, 'You cannot build in space.'); return; }
  const kind = state.pendingBuild.kind;
  // Wall is a special case: no Building entity, just a wall cell. Stays in
  // pending mode after placement so the player can drag-paint more.
  if (kind === 'wall') {
    const c = pixelToCell(x, y);
    tryPlaceWallAt(state, c.cx, c.cy, false);
    return;
  }
  // Designer mode: every building behaves like a wall — free, instant, and
  // left pending so it can be drag-painted across the world.
  if (designerNow()) {
    tryPlaceBuildingInstant(state, x, y, kind, false);
    return;
  }
  const def = BUILDING_DEFS[kind];
  const moneyCost = buildingMoneyCost(state, kind);
  if (state.money < moneyCost) {
    refusePlacement(state, x, y, `need Ƶ${moneyCost.toLocaleString('en-US')}`, 'Not enough Ƶ.');
    return;
  }
  if (def.bloodCost && state.blood < def.bloodCost) {
    refusePlacement(state, x, y, `need ${def.bloodCost} blood`,
      `Need ${def.bloodCost} blood to build ${def.name}.`);
    return;
  }
  if (def.dragonBoneCost && state.dragonBone < def.dragonBoneCost) {
    refusePlacement(state, x, y,
      `need ${def.dragonBoneCost} dragon bone${def.dragonBoneCost === 1 ? '' : 's'}`,
      `Need ${def.dragonBoneCost} dragon bone${def.dragonBoneCost === 1 ? '' : 's'} to build ${def.name}.`);
    return;
  }
  if (def.powerOutput < 0) {
    const draw = -def.powerOutput;
    const available = state.lastPowerProduced - state.lastPowerConsumed;
    if (draw > available) {
      refusePlacement(state, x, y, `need ${formatPower(draw)} free power`,
        `Need ${formatPower(draw)} of free power to build ${def.name}.`);
      return;
    }
  }
  const tl = topLeftFromClick(x, y, kind);
  if (!canPlaceBuilding(state, tl, kind)) {
    refusePlacement(state, x, y, 'blocked', 'Cannot place there — blocked.');
    return;
  }

  state.money -= moneyCost;
  if (def.bloodCost) state.blood -= def.bloodCost;
  if (def.dragonBoneCost) state.dragonBone -= def.dragonBoneCost;
  const b: Building = {
    id: state.nextId++,
    displayNum: nextBuildingDisplayNum(state, kind),
    kind,
    cell: tl,
    state: 'constructing',
    buildProgress: 0,
    assignedGoblins: [],
    selected: false,
  };
  state.buildings.set(b.id, b);
  markBuildingsChanged(state);
  state.pendingBuild = null;
  // Hell Portal: placing one (sticky) unlocks the descent affordance. The
  // red beam is drawn per-portal and gated on the building actually finishing
  // construction (see render.ts:drawHellBeams), so it appears together with
  // the active portal rather than the moment the placement is paid for.
  if (kind === 'hell_portal') state.hellUnlocked = true;
  playSound('place', 1.6);
  const staffGesture = window.matchMedia('(pointer: coarse)').matches ? 'long tap' : 'right-click';
  appendLog(state, `${def.name} #${b.displayNum} construction started — ${staffGesture} goblins onto it to staff the build.`);
  autoAssignAllIdle(state);
  maybeTriggerBobCutscene(state, b, def.name);
  maybeBobBuildingRemark(state, b);
}

// Wall placement — Ƶ1 per cell, 1×1 Building entity that goes straight to
// active. Using a real Building means the same destroy flow as everything
// else (selection → destroy → minotaur smashes it) works for free.
// Drag-paint calls this with silent=true so duplicate-cell attempts don't
// beep on every drag tick.
function tryPlaceWallAt(state: GameState, cx: number, cy: number, silent: boolean): boolean {
  if (!isInBounds(cx, cy)) return false;
  if (state.money < 1) {
    if (!silent) refusePlacement(state, (cx + 0.5) * CELL, (cy + 0.5) * CELL, 'need Ƶ1', 'Not enough Ƶ.');
    return false;
  }
  if (cellBlocksPlacement(state, cx, cy)) {
    // A deliberate tap on a blocked cell says why; drag-paint stays quiet so
    // sweeping across occupied cells doesn't spam beeps.
    if (!silent) refusePlacement(state, (cx + 0.5) * CELL, (cy + 0.5) * CELL, 'blocked', 'Cannot place there — blocked.');
    return false;
  }
  state.money -= 1;
  const b: Building = {
    id: state.nextId++,
    displayNum: nextBuildingDisplayNum(state, 'wall'),
    kind: 'wall',
    cell: { cx, cy },
    state: 'active',
    buildProgress: 1,
    assignedGoblins: [],
    selected: false,
  };
  state.buildings.set(b.id, b);
  markBuildingsChanged(state);
  maybeTriggerBobCutscene(state, b, BUILDING_DEFS.wall.name);
  maybeBobBuildingRemark(state, b);
  return true;
}

// Designer-only: drop any building straight to active for free (no cost, no
// construction, no Bob cutscenes — this is an authoring sandbox). Mirrors
// tryPlaceWallAt so non-wall kinds get the same instant + drag-paint flow.
// silent=true keeps drag-paint from beeping on blocked/duplicate cells.
function tryPlaceBuildingInstant(state: GameState, x: number, y: number, kind: BuildingKind, silent: boolean): boolean {
  const tl = topLeftFromClick(x, y, kind);
  if (!canPlaceBuilding(state, tl, kind)) {
    if (!silent) refusePlacement(state, x, y, 'blocked', 'Cannot place there — blocked.');
    return false;
  }
  const b: Building = {
    id: state.nextId++,
    displayNum: nextBuildingDisplayNum(state, kind),
    kind,
    cell: tl,
    state: 'active',
    buildProgress: 1,
    assignedGoblins: [],
    selected: false,
  };
  state.buildings.set(b.id, b);
  markBuildingsChanged(state);
  if (kind === 'hell_portal') state.hellUnlocked = true;
  playSound('place', 1.6);
  return true;
}

// Trigger the Bob cutscene if the player just placed their 20th-or-later
// building and Bob hasn't been spawned yet. Walls count. The cutscene fires
// async (no await) — the world keeps running while the goblin rises, and
// only freezes (bob-cutscene-hold) once he turns around — and on "yes" the
// picker takes over the next ground click.
//
// Because input stays live during the rise, the player can keep placing
// buildings while the cutscene is already on its way up; this flag stops
// those placements from kicking off a second, overlapping cutscene.
let bobCutsceneRunning = false;
function maybeTriggerBobCutscene(state: GameState, b: Building, kindName: string) {
  if (bobCutsceneRunning) return;
  if (state.bobPickingHole) return;
  // Goblin Holes are the seat target for Bob, so it would be confusing to
  // have the cutscene fire on top of one — defer until the next non-hole
  // placement. The cheat (if armed) stays pending.
  if (b.kind === 'goblin_hole') return;
  // The cheat overrides every gate (threshold + bobSpawned) so a dev can
  // re-trigger the cutscene at will. It stays pending across "no" answers
  // so the offer persists until the player actually accepts; cleared once
  // they say "okay" below.
  if (!state.bobCheatPending) {
    if (state.bobSpawned) return;
    // Time-gated: the first building placed after 10 minutes of (sim-clock)
    // playtime fires the cutscene.
    if (state.now < 600) return;
  }
  const ord = ordinalWord(b.displayNum);
  bobCutsceneRunning = true;
  // Once the goblin turns around and the cutscene freezes the world, bail out
  // of any pending build/strike — both surface a cursor ghost that would
  // otherwise still follow the mouse during the dialogue.
  const onHold = () => {
    state.pendingBuild = null;
    state.pendingStrike = false;
  };
  void runBobCutscene(ord, kindName, onHold).then((res) => {
    bobCutsceneRunning = false;
    if (res === 'yes') {
      state.bobCheatPending = false;
      state.bobPickingHole = true;
      appendLog(state, 'choose a spawning hole');
      playSound('select', 0.5);
    }
  });
}

// Bob's running commentary: while he's alive in the overworld, every other
// building placed (lifetime total, walls included) earns a quick typed bark
// above his head admiring the building that tipped the count over.
function maybeBobBuildingRemark(state: GameState, b: Building) {
  let bob: Goblin | undefined;
  for (const g of state.goblins.values()) {
    if (g.bob) { bob = g; break; }
  }
  if (!bob) return;
  let total = 0;
  for (const k in state.buildingCounts) total += state.buildingCounts[k as BuildingKind];
  if (total % 2 !== 0) return;
  const def = BUILDING_DEFS[b.kind];
  void bobOverworldBark(state, bob, `oh my, your ${ordinalNumber(b.displayNum)} ${def.name}! nice!`);
}

// "1st" / "2nd" / "3rd" / "11th" — numeric ordinal suffixing.
function ordinalNumber(n: number): string {
  const lastTwo = n % 100;
  if (lastTwo >= 11 && lastTwo <= 13) return `${n}th`;
  const last = n % 10;
  if (last === 1) return `${n}st`;
  if (last === 2) return `${n}nd`;
  if (last === 3) return `${n}rd`;
  return `${n}th`;
}

// Render a positive integer as its English ordinal word ("first", "twenty-
// fourth", ...). Covers 1–99 by name; falls back to numeric ordinals
// ("123rd") above that.
function ordinalWord(n: number): string {
  const ones = ['', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth'];
  const teens = ['tenth', 'eleventh', 'twelfth', 'thirteenth', 'fourteenth', 'fifteenth', 'sixteenth', 'seventeenth', 'eighteenth', 'nineteenth'];
  const tensCardinal = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
  const tensOrdinal = ['', '', 'twentieth', 'thirtieth', 'fortieth', 'fiftieth', 'sixtieth', 'seventieth', 'eightieth', 'ninetieth'];
  if (n <= 0) return `${n}th`;
  if (n < 10) return ones[n];
  if (n < 20) return teens[n - 10];
  if (n < 100) {
    const t = Math.floor(n / 10);
    const o = n % 10;
    return o === 0 ? tensOrdinal[t] : `${tensCardinal[t]}-${ones[o]}`;
  }
  return ordinalNumber(n);
}

// Translucent blast preview that follows the cursor while a Lightning Strike
// is armed. Reuses the placement-ghost graphics layer. Paints the exact cells
// the strike will hit — same test as lightningStrike's splatter loop in
// sim.ts (a cell is in the blast when its center falls inside the radius of
// the un-snapped cursor point) — so what you see is what gets scorched.
function drawStrikeGhost(input: InputState, x: number, y: number) {
  const radiusPx = (LIGHTNING.cellsWide / 2) * CELL;
  const r2 = radiusPx * radiusPx;
  const span = Math.ceil(LIGHTNING.cellsWide / 2);
  const ccx = Math.floor(x / CELL), ccy = Math.floor(y / CELL);
  const g = input.placementGhost;
  g.clear();
  for (let cy = ccy - span; cy <= ccy + span; cy++) {
    for (let cx = ccx - span; cx <= ccx + span; cx++) {
      const dx = (cx + 0.5) * CELL - x, dy = (cy + 0.5) * CELL - y;
      if (dx * dx + dy * dy > r2) continue;
      g.rect(cx * CELL, cy * CELL, CELL, CELL)
        .fill({ color: 0xcdeeff, alpha: 0.18 })
        .stroke({ width: 1, color: 0xffffff, alpha: 0.35 });
    }
  }
}

function drawGhost(input: InputState, x: number, y: number, state: GameState) {
  if (!state.pendingBuild) return;
  const kind = state.pendingBuild.kind;
  const def = BUILDING_DEFS[kind];
  const tl = topLeftFromClick(x, y, kind);
  const valid = canPlaceBuilding(state, tl, kind);
  const color = valid ? 0x6a8eb0 : 0xd96b6b;
  input.placementGhost.clear();
  input.placementGhost
    .rect(tl.cx * CELL, tl.cy * CELL, def.size, def.size)
    .fill({ color, alpha: 0.25 })
    .stroke({ width: 2, color });
}
