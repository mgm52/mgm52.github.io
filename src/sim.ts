import { playDecayingGoblinDeath, playDecayingGoblinSpawn, playDecayingGoldKillCash, playSound } from './audio';
import { BUILDING_DEFS, BuildingKind, CELL, COLS, DEMON, DRAGON, DRAGON_KILL_REWARD, FINALE, GOBLIN, GOLD_GOBLIN_CHANCE, GOLD_KILL_REWARD, HELL, KILL_REWARD, LIGHTNING, LOLLY, LOLLY_BOOST, MINOTAUR_KILL_REWARD, REACTOR_MELTDOWN, ROBOT, SOUL_SIGIL, SPACE, SPACE_UNIT, SUMMON_UPGRADES, TICK_S, MINOTAUR, TINYTAUR, WATER_DEPLETION_PP_PER_SEC, WATER_METER_MAX, WORLD, SOUL_STRENGTH_LABEL, formatPower, sigilPortalOutput, soulStrengthOf } from './config';
import { DEMON_FACING_ANGLE, getOptions } from './options';
import {
  ALL_DIRS, Building, Cell, DX, DY, Demon, Dir, Dragon, Finale, FinalePhase, GameState, Ghost, Goblin, HOLE_SIZE, LollyBoostKind, LollyTarget, Minotaur, SoulChair, SpaceBuilding, SpaceUnit, Vec2, WaterSource, lollyBoostState,
  anySpawnHole, appendLog, buildingAtCell, buildingCenter, buildingFootprint, buildingPerimeter,
  cellCenter, cellKey, chairSoulSnapshot, constructedDragonBeacon, createMoon, currentPowerBoost, defOf, demonScaleOf, destroyBuilding, dragonsAtCap, dragonTargetBuilding,
  earnBlood, earnDragonBone, earnMoney, findHoleEmergenceCell, maxOverworldDragons,
  getSpawnCapacity, holeBlockedByBuilding, holeCenter, isCellBlocked, isCellInBuilding, isCellInWaterSource,
  isInBounds, maintainerCount, markBuildingsChanged, nearestCellInWaterSource, occupyCell, pushDeathEffect, pushFloater,
  hellMirrorCenter, hellToWorld, pruneSoulChairs, pushLaserBeam, pushLightningBolt, recordGhost, releaseCell, removeDragon, removeGoblin,
  spaceCentreMaintained, waterCarrierCount,
} from './state';

// Auto-assign normally only runs on discrete events (a spawn, a manual command,
// an upgrade purchase). That leaves gaps: a carrier that gets stuck and drops
// duty, or a maintainer that's killed, isn't backfilled until the next spawn —
// so a Datacentre can silently go dry. This periodic sweep re-runs the
// assignment on a steady cadence so understaffed buildings and thirsty drinkers
// are topped back up. Module-scoped (resets to 0 on reload, which just means the
// first tick after load runs a sweep — harmless).
let nextAutoAssignAt = 0;
const AUTO_ASSIGN_INTERVAL = 2;

// Vertical lift (world px) applied to building-center power floaters so the
// blue "±W" text clears the gold "+Ƶ" income floater spawned at the same point.
const POWER_FLOATER_Y_OFFSET = 26;

export function tick(state: GameState) {
  state.now += TICK_S;

  // Track the first descent into hell, then nudge a player who still hasn't
  // had Bob parlay with a demon five minutes on — the demon only talks to a
  // goblin that can speak (i.e. Bob).
  if (state.view === 'hell' && state.firstHellVisitAt === undefined) {
    state.firstHellVisitAt = state.now;
  }
  if (!state.hellHintShown && !state.bobParlayed
      && state.firstHellVisitAt !== undefined
      && state.now - state.firstHellVisitAt >= 300) {
    state.hellHintShown = true;
    appendLog(state, 'Hint: demons parlay with talking goblins.');
  }

  if (state.autoAssignEnabled && state.now >= nextAutoAssignAt) {
    autoAssignAllIdle(state);
    nextAutoAssignAt = state.now + AUTO_ASSIGN_INTERVAL;
  }

  if (state.lightningStrikeCooldown > 0) {
    state.lightningStrikeCooldown = Math.max(0, state.lightningStrikeCooldown - TICK_S);
  }

  // ── 1. Spawn queue ────────────────────────────────────────────────
  // Lolly has torn out every hole — nothing hole-born can hatch any more.
  // Drop every in-flight summon (the holes they'd crawl from no longer
  // exist); the UI greys the buttons out on the same anySpawnHole test.
  if (!anySpawnHole(state)
      && (state.spawnQueue.length > 0 || state.minotaurSpawnQueue.length > 0
          || state.robotSpawnQueue.length > 0 || state.terminatorSpawnQueue.length > 0)) {
    state.spawnQueue.length = 0;
    state.minotaurSpawnQueue.length = 0;
    state.robotSpawnQueue.length = 0;
    state.terminatorSpawnQueue.length = 0;
    appendLog(state, 'No holes remain. Nothing more will hatch.');
  }
  // After a reactor meltdown, autospawn holds its breath until the green
  // radiation wash has fully faded (REACTOR_MELTDOWN.tintSeconds) — no point
  // hatching goblins straight into the shockwave. The cadence timer simply
  // stops ticking, so spawning resumes at its normal rhythm afterwards.
  const meltdownFading = state.lastMeltdownAt !== undefined
    && state.now - state.lastMeltdownAt < REACTOR_MELTDOWN.tintSeconds;
  // The cadence runs at autoSpawnLevel — pinned to the purchased multiplier
  // until Lilly's prevent-spawning reward slider lets the player throttle it
  // down to a lower owned tier, or 0 (paused).
  if (state.autoSpawnEnabled && state.autoSpawnLevel > 0 && !meltdownFading) {
    state.autoSpawnTimer -= TICK_S;
    // Higher multipliers fire more often (interval / multiplier) instead of
    // queuing N goblins simultaneously — staggered cadence keeps the holes
    // pulsing evenly. One spawn per fire.
    if (state.autoSpawnTimer <= 0) {
      const cadence = SUMMON_UPGRADES.autoSpawn.intervalSeconds / Math.max(1, state.autoSpawnLevel);
      state.autoSpawnTimer += cadence;
      const cap = getSpawnCapacity(state);
      if (state.spawnQueue.length < cap) {
        const used = new Set(state.spawnQueue.map((s) => s.slot));
        for (let slot = 0; slot < cap; slot++) {
          if (!used.has(slot)) {
            state.spawnQueue.push({ remaining: GOBLIN.spawnTime, slot });
            break;
          }
        }
      }
    }
  }
  // Sticky onboarding flag: the player has had 2+ goblins queued at once, so
  // the "queue several at a time" hint never needs to surface (or hides now).
  if (state.spawnQueue.length >= 2) state.multiSpawnSeen = true;
  for (let i = state.spawnQueue.length - 1; i >= 0; i--) {
    state.spawnQueue[i].remaining -= TICK_S;
    if (state.spawnQueue[i].remaining <= 0) {
      spawnGoblin(state);
      state.spawnQueue.splice(i, 1);
    }
  }

  // ── 1b. Minotaur spawn queue ─────────────────────────────────────
  for (let i = state.minotaurSpawnQueue.length - 1; i >= 0; i--) {
    state.minotaurSpawnQueue[i].remaining -= TICK_S;
    if (state.minotaurSpawnQueue[i].remaining <= 0) {
      if (spawnMinotaur(state)) {
        state.minotaurSpawnQueue.splice(i, 1);
      } else {
        // Hole perimeter blocked — retry shortly so we don't burn the slot.
        state.minotaurSpawnQueue[i].remaining = 0.5;
      }
    }
  }

  // ── 1c. Dragon spawn queue ───────────────────────────────────────
  // Autodragon (Lilly's destroy-a-robot reward): every intervalSeconds —
  // divided by the owned tier multiplier, so x2 fires twice as often — queue
  // a dragon summon through the same gates the manual button enforces:
  // blood for the ritual, and an active Dragon Beacon with a free slot.
  if (state.autoDragonEnabled) {
    state.autoDragonTimer -= TICK_S;
    if (state.autoDragonTimer <= 0) {
      state.autoDragonTimer += SUMMON_UPGRADES.autoDragon.intervalSeconds
        / Math.max(1, state.autoDragonMultiplier);
      let activeBeacons = 0;
      for (const b of state.buildings.values()) {
        if (b.kind === 'dragon_beacon' && b.state === 'active') activeBeacons++;
      }
      if (activeBeacons > 0
          && state.blood >= DRAGON.bloodCost
          && state.dragonSpawnQueue.length < activeBeacons
          && !dragonsAtCap(state)) {
        state.blood -= DRAGON.bloodCost;
        state.dragonSpawnQueue.push({ remaining: DRAGON.spawnTime });
        appendLog(state, 'Autodragon: a summon ritual begins...');
      }
    }
  }
  for (let i = state.dragonSpawnQueue.length - 1; i >= 0; i--) {
    state.dragonSpawnQueue[i].remaining -= TICK_S;
    if (state.dragonSpawnQueue[i].remaining <= 0) {
      // Hold a completed ritual if the overworld is already at its dragon
      // ceiling (e.g. a Beacon went dormant mid-ritual, dropping the cap) —
      // retry shortly rather than overshooting, the way the Minotaur track
      // waits on a blocked hole.
      if (state.dragons.size >= maxOverworldDragons(state)) {
        state.dragonSpawnQueue[i].remaining = 0.5;
        continue;
      }
      spawnDragon(state);
      state.dragonSpawnQueue.splice(i, 1);
    }
  }

  // ── 1d. Robot assembly queue ─────────────────────────────────────
  // Mirrors the Minotaur track: money was charged at queue time; if every
  // hole exit is blocked when assembly completes, retry shortly rather than
  // burning the slot.
  for (let i = state.robotSpawnQueue.length - 1; i >= 0; i--) {
    state.robotSpawnQueue[i].remaining -= TICK_S;
    if (state.robotSpawnQueue[i].remaining <= 0) {
      if (spawnRobot(state)) {
        state.robotSpawnQueue.splice(i, 1);
      } else {
        state.robotSpawnQueue[i].remaining = 0.5;
      }
    }
  }
  // Terminators assemble on their own single-slot track, same retry rule.
  for (let i = state.terminatorSpawnQueue.length - 1; i >= 0; i--) {
    state.terminatorSpawnQueue[i].remaining -= TICK_S;
    if (state.terminatorSpawnQueue[i].remaining <= 0) {
      if (spawnRobot(state, true)) {
        state.terminatorSpawnQueue.splice(i, 1);
      } else {
        state.terminatorSpawnQueue[i].remaining = 0.5;
      }
    }
  }
  // Pain Gabbonsaw channels on its own one-shot bar. When it completes the
  // ritual is owned and main.ts (which owns the cutscene + camera) picks up
  // the pending flag to bring Bob back and loose Lolly.
  if (state.gabbonsawRitualRemaining !== null) {
    state.gabbonsawRitualRemaining -= TICK_S;
    if (state.gabbonsawRitualRemaining <= 0) {
      state.gabbonsawRitualRemaining = null;
      state.gabbonsawBought = true;
      state.gabbonsawCutscenePending = true;
    }
  }

  // ── 2. Goblin updates ─────────────────────────────────────────────
  // Terminator pass first: any idle terminator locks its laser onto the
  // nearest non-robot unit. The regular firing_laser state machine handles
  // the windup/shot and drops back to idle, so this re-acquires every kill —
  // a terminator simply never stops hunting while prey remains. The
  // terminating slider gates the acquisition: switched off, terminators
  // stand down (any in-flight shot finishes, then they sit idle).
  if (state.terminatorsTerminating) {
    const lollyRampaging = !!state.lolly && !state.finale;
    for (const g of state.goblins.values()) {
      if (!g.terminator || g.state.kind !== 'idle') continue;
      // While Lolly rampages she outranks all other prey — every terminator
      // pours fire into her. It never lands (she shrugs every beam off with
      // a 'no effect' floater), but a terminator doesn't know how to stop.
      if (lollyRampaging) {
        g.state = { kind: 'firing_laser', targetKind: 'lolly', targetId: 0 };
        continue;
      }
      const target = nearestTerminatorTarget(state, g);
      if (target) g.state = { kind: 'firing_laser', targetKind: target.kind, targetId: target.id };
    }
  }
  for (const g of state.goblins.values()) updateGoblin(state, g);

  // ── 2b. Minotaur updates ─────────────────────────────────────────────
  // Resolve auto-targets up front so two minotaurs never hunt the same goblin
  // unless the player explicitly ordered it. See assignMinotaurTargets.
  const minoTargets = assignMinotaurTargets(state);
  for (const t of state.minotaurs.values()) updateMinotaur(state, t, minoTargets);

  // ── 2c. Dragon updates ───────────────────────────────────────────────
  // Copy first: a dragon that crosses into space removes itself mid-loop.
  for (const d of [...state.dragons.values()]) updateDragon(state, d);
  // Floating space buildings drift within their bounds.
  for (const sb of state.spaceBuildings.values()) updateSpaceBuilding(sb);
  // Units adrift in space: robots work their assigned duty (one builder per
  // construction site, one maintainer per Space Centre), the rest tumble
  // until their vacuum timer pops them. Copy first — a perishing unit
  // removes itself mid-loop.
  const robotDuties = assignRobotDuties(state);
  for (const su of [...state.spaceUnits.values()]) updateSpaceUnit(state, su, robotDuties);
  // Robots on site advance any Orbital Platform under construction.
  advanceOrbitalPlatforms(state);

  // ── 2d. Demon updates (hell pacing + parlay arrivals) ─────────────────
  for (const d of state.demons.values()) updateDemon(state, d);

  // ── 2e. Lolly's rampage (Pain Gabbonsaw payoff) ───────────────────────
  // Once she's scoured the overworld bare, control passes to the finale
  // cinematic; until then she keeps hunting. updateLolly itself triggers the
  // hand-off, so call it first and let updateFinale take any active cinematic.
  if (state.lolly && !state.finale) updateLolly(state);
  if (state.finale) updateFinale(state);

  // Sticky: the Tinytaur summon reveals itself once the player has fielded
  // enough Minotaurs at once to pay its sacrifice cost.
  if (!state.tinytaurUnlocked && state.minotaurs.size >= TINYTAUR.minotaurCost) {
    state.tinytaurUnlocked = true;
  }

  // ── 3. Construction progress ──────────────────────────────────────
  for (const b of state.buildings.values()) updateConstruction(state, b);

  // ── 4. Water meter depletion (before power resolution so dormancy
  //       reflects the latest meter values). Buildings with a
  //       waterDeliveryAmount lose WATER_DEPLETION_PP_PER_SEC each second.
  for (const b of state.buildings.values()) {
    const def = defOf(b);
    if (!def.waterDeliveryAmount || b.state === 'constructing') continue;
    if (b.waterMeter === undefined) b.waterMeter = 0;
    const depletion = def.waterDepletionPerSec ?? WATER_DEPLETION_PP_PER_SEC;
    b.waterMeter = Math.max(0, b.waterMeter - depletion * TICK_S);
  }

  // ── 4. Power balance + active/dormant resolution ──────────────────
  // Keep each portal's soul sigil in step with the live portals first, so a
  // freshly-built or destroyed portal's chairs feed into the power pass below.
  pruneSoulChairs(state);
  resolvePowerAndState(state);

  // ── 5. Income ─────────────────────────────────────────────────────
  // Income arrives in discrete one-second chunks rather than trickling in
  // every tick: an active income building pays its full `income` once per
  // second. Each building's payout phase is anchored to when it first
  // became active (nextIncomeAt), so buildings placed at different times
  // pay on different ticks instead of all firing on the same second.
  for (const b of state.buildings.values()) {
    if (b.state !== 'active') continue;
    const def = defOf(b);
    if (def.income <= 0) continue;
    if (b.nextIncomeAt === undefined) { b.nextIncomeAt = state.now + 1; continue; }
    if (state.now >= b.nextIncomeAt) {
      earnMoney(state, def.income);
      b.nextIncomeAt = state.now + 1;
      const c = buildingCenter(b);
      pushFloater(state, c.x, c.y, `+Ƶ${def.income.toLocaleString('en-US')}`, 0xffd96b);
    }
  }

  // Space buildings keep paying their income — same one-second cadence as
  // ground income — but they still need the grid: a dormant orbital
  // Hypercentre (cut off by power shortage) earns nothing until the link is
  // restored. Generators in orbit run upkeep-free; resolvePowerAndState keeps
  // them marked active.
  for (const sb of state.spaceBuildings.values()) {
    const def = BUILDING_DEFS[sb.building.kind];
    if (def.income <= 0) continue;
    if (sb.building.state !== 'active') { sb.nextIncomeAt = undefined; continue; }
    if (sb.nextIncomeAt === undefined) { sb.nextIncomeAt = state.now + 1; continue; }
    if (state.now >= sb.nextIncomeAt) {
      earnMoney(state, def.income);
      sb.nextIncomeAt = state.now + 1;
      // Same gold income floater as a ground building, but flagged `space` so
      // it renders in the orbit scene at the floating building's position.
      pushFloater(state, sb.pos.x, sb.pos.y, `+Ƶ${def.income.toLocaleString('en-US')}`, 0xffd96b, 1.4, undefined, true);
    }
  }

  // Expire aged-out floaters and death-effect markers.
  for (let i = state.floaters.length - 1; i >= 0; i--) {
    const f = state.floaters[i];
    if (state.now - f.spawnAt >= f.lifetime) state.floaters.splice(i, 1);
  }
  for (let i = state.deathEffects.length - 1; i >= 0; i--) {
    if (state.now - state.deathEffects[i].spawnAt >= 2) state.deathEffects.splice(i, 1);
  }
  for (let i = state.lightningBolts.length - 1; i >= 0; i--) {
    const lb = state.lightningBolts[i];
    if (state.now - lb.spawnAt >= lb.lifetime) state.lightningBolts.splice(i, 1);
  }
  for (let i = state.laserBeams.length - 1; i >= 0; i--) {
    const beam = state.laserBeams[i];
    if (state.now - beam.spawnAt >= beam.lifetime) state.laserBeams.splice(i, 1);
  }
  for (let i = state.powerBoosts.length - 1; i >= 0; i--) {
    const pb = state.powerBoosts[i];
    if (state.now - pb.startAt >= pb.duration) state.powerBoosts.splice(i, 1);
  }
  // Reactor meltdown shockwaves — kills/fallout as each front expands.
  updateMeltdowns(state);
  // Ghosts drift downward at hellGhostFallSpeed px/sec, scaled by each ghost's
  // per-spawn speedMult so a cluster of ghosts spreads out over time rather
  // than falling in lockstep. Drifting ghosts are computed lazily from spawnAt
  // (no per-tick mutation) and pruned the moment their hell-y crosses the
  // bottom. Once a ghost has been interacted with (hx/hy set) we track its
  // position explicitly each tick — that branch also handles walking toward a
  // commanded goal at HELL.ghostWalkSpeed, then resuming the downward drift
  // from the new position.
  const fall = getOptions().hellGhostFallSpeed;
  const hellXOffset = (HELL.width - WORLD.width) / 2;
  const hellYOffset = (HELL.height - WORLD.height) / 2;
  for (let i = state.ghosts.length - 1; i >= 0; i--) {
    const g = state.ghosts[i];
    // Respawn pass: a soul struck by the demon's untruth punishment stays
    // vanished and inert until its timer runs out, then flashes back in at
    // the spot the strike pre-placed it (the centre of hell).
    if (g.respawnAt !== undefined) {
      if (state.now < g.respawnAt) continue;
      g.respawnAt = undefined;
      if (g.hx !== undefined && g.hy !== undefined) {
        const w = hellToWorld(g.hx, g.hy);
        pushDeathEffect(state, w.x, w.y, true, true);
        playSound('destroy', 0.5, 0.7);
      }
    }
    // speedMult is a per-ghost jitter on the *passive drift* only, so a
    // cluster spreads out rather than falling in lockstep. Walk commands run
    // at HELL.ghostWalkSpeed for everyone — including Bob (drift mult 0) —
    // so the player can still drag him around the underworld on command.
    const driftMult = g.speedMult ?? 1;
    // Bob's idle pacing needs an explicit position, so materialise him from
    // the lazy formula on first sight (his drift mult is 0, so it's static).
    if (g.bob && !g.commanded && (g.hx === undefined || g.hy === undefined)) {
      g.hx = g.x + (g.offX ?? 0) + hellXOffset;
      g.hy = g.y + (g.offY ?? 0) + hellYOffset + (state.now - g.spawnAt) * fall * driftMult;
    }
    if (g.hx !== undefined && g.hy !== undefined) {
      if (g.goal) {
        const dx = g.goal.x - g.hx;
        const dy = g.goal.y - g.hy;
        const dist = Math.hypot(dx, dy);
        // Commanded souls hustle: 2x the base walk speed, 3x for Bob.
        const speedMult = g.bob ? 3 : 2;
        const step = HELL.ghostWalkSpeed * speedMult * TICK_S;
        if (dist <= step) {
          g.hx = g.goal.x;
          g.hy = g.goal.y;
          g.goal = undefined;
        } else {
          g.hx += (dx / dist) * step;
          g.hy += (dy / dist) * step;
          g.facing = Math.atan2(dy, dx);
        }
      } else if (g.bob && !g.commanded) {
        paceBobGhost(state, g);
      } else if (fall > 0) {
        g.hy += fall * driftMult * TICK_S;
      }
      shoveGhostOffDemons(state, g);
      // A soul commanded onto another soul keeps steering toward the target's
      // live position (it may be drifting) and opens a gibberish chat (see
      // runGhostChat) once within HELL.chatRadius. Target gone — drifted off
      // the bottom, seated, resurrected — and the command is silently dropped.
      // While another chat is pending, keep walking; we'll trigger next tick.
      if (g.chatTargetId !== undefined) {
        const t = state.ghosts.find((o) => o.id === g.chatTargetId);
        if (!t || t.hx === undefined || t.hy === undefined) {
          g.chatTargetId = undefined;
          g.goal = undefined;
        } else {
          g.goal = { x: t.hx, y: t.hy };
          if (!state.pendingGhostChat
              && Math.hypot(g.hx - t.hx, g.hy - t.hy) <= HELL.chatRadius) {
            g.chatTargetId = undefined;
            g.goal = undefined;
            // Square up: the pair face each other for the exchange.
            g.facing = Math.atan2(t.hy - g.hy, t.hx - g.hx);
            t.facing = Math.atan2(g.hy - t.hy, g.hx - t.hx);
            state.pendingGhostChat = { aId: g.id, bId: t.id };
          }
        }
      }
      // A soul commanded onto a chair keeps steering to it (chairs are static)
      // and is consumed the instant it arrives. If the chair filled up first,
      // the command is silently dropped and the soul resumes its drift.
      if (g.targetChairId !== undefined) {
        const chair = state.soulChairs.find((c) => c.id === g.targetChairId);
        if (!chair || chair.occupied) {
          g.targetChairId = undefined;
          g.goal = undefined;
        } else {
          g.goal = { x: chair.hx, y: chair.hy };
          if (Math.hypot(g.hx - chair.hx, g.hy - chair.hy) <= SOUL_SIGIL.arriveRadius) {
            seatSoulInChair(state, chair, g);
            state.ghosts.splice(i, 1);
            continue;
          }
        }
      }
      if (g.hy > HELL.height) state.ghosts.splice(i, 1);
    } else {
      const hellY = g.y + (g.offY ?? 0) + hellYOffset + (state.now - g.spawnAt) * fall * driftMult;
      if (hellY > HELL.height) { state.ghosts.splice(i, 1); continue; }
      // A passively drifting soul that floats into a demon — or that a pacing
      // demon walks over — gets materialised (hx/hy set) so the shove can route
      // it around the body; from there it keeps drifting from its explicit
      // position like any interacted ghost.
      const hellX = g.x + (g.offX ?? 0) + hellXOffset;
      for (const d of state.demons.values()) {
        if (Math.hypot(hellX - d.hx, hellY - d.hy) < DEMON.bodyRadius * demonScaleOf(d)) {
          g.hx = hellX;
          g.hy = hellY;
          shoveGhostOffDemons(state, g);
          break;
        }
      }
    }
  }
}

// Bob's ghost idles by pacing: until the player gives him his first command he
// wanders HELL.bobPaceRange either side of his arrival spot, pausing for a few
// seconds at the end of each leg before turning back. Selection alone doesn't
// stop it — only a real command (g.commanded) does, permanently.
function paceBobGhost(state: GameState, g: Ghost): void {
  if (g.hx === undefined || g.hy === undefined) return;
  g.paceAnchorX ??= g.hx;
  g.paceDir ??= 1;
  if (g.pacePauseUntil !== undefined && state.now < g.pacePauseUntil) return;
  g.pacePauseUntil = undefined;
  const target = g.paceAnchorX + g.paceDir * HELL.bobPaceRange;
  const step = HELL.bobPaceSpeed * TICK_S;
  g.facing = g.paceDir > 0 ? 0 : Math.PI;
  if (Math.abs(target - g.hx) <= step) {
    g.hx = target;
    g.paceDir = g.paceDir > 0 ? -1 : 1;
    g.pacePauseUntil = state.now + HELL.bobPacePauseSec;
  } else {
    g.hx += Math.sign(target - g.hx) * step;
  }
}

// Demons are solid. A soul that ends up inside DEMON.bodyRadius of a demon's
// centre is shoved radially back out to the rim, so commanded walkers slide
// naturally around him and drifters part past his legs — no soul can come to
// rest right under the colossus. (Goblin AI never plans around this; the
// per-tick shove is the whole collision model.)
function shoveGhostOffDemons(state: GameState, g: Ghost): void {
  if (g.hx === undefined || g.hy === undefined) return;
  let hx = g.hx;
  let hy = g.hy;
  for (const d of state.demons.values()) {
    const body = DEMON.bodyRadius * demonScaleOf(d);
    const dx = hx - d.hx;
    const dy = hy - d.hy;
    const dist = Math.hypot(dx, dy);
    if (dist >= body) continue;
    if (dist < 1e-6) {
      hx = d.hx + body;  // dead-centre overlap: eject sideways
    } else {
      hx = d.hx + (dx / dist) * body;
      hy = d.hy + (dy / dist) * body;
    }
    // A walk goal buried inside the demon can never be reached — drop it the
    // moment the soul is pressed against him so it doesn't shuffle at the rim
    // forever. (Chair- and parlay-bound souls re-acquire their goals each tick.)
    if (g.goal && Math.hypot(g.goal.x - d.hx, g.goal.y - d.hy) < body) {
      g.goal = undefined;
    }
  }
  g.hx = hx;
  g.hy = hy;
}

// Bind a soul into a chair: light it, clear its pending claim, and multiply
// the portal's power output by the soul's strength multiplier (x66 weak
// goblin / x100 strong minotaur / x144 very strong dragon or tinytaur) — the
// multiplier flashes over the mirror, the strength label over the chair, and
// the mirror's wattage readout (drawn in render.ts) jumps. The fifth soul
// also fires the sigil completion (sound + log + VFX timestamp). The payout
// itself is read off the seated chairs each tick in the power pass below.
function seatSoulInChair(state: GameState, chair: SoulChair, soul: Ghost) {
  chair.occupied = true;
  chair.claimedBy = undefined;
  chair.filledAt = state.now;
  const strength = soulStrengthOf(soul.kind, soul.tiny);
  chair.mult = SOUL_SIGIL.soulMultipliers[strength];
  // Snapshot the soul so unseatSoulFromChair can conjure it back out later.
  chair.soul = { kind: soul.kind, gold: soul.gold, tiny: soul.tiny };
  playSound('ritual', 0.6, 0.85);
  const sigil = state.soulChairs.filter((c) => c.portalId === chair.portalId);
  const filled = sigil.filter((c) => c.occupied).length;
  const portal = state.buildings.get(chair.portalId);
  const out = portal ? sigilPortalOutput(defOf(portal).powerOutput, sigil) : 0;
  appendLog(state, `A ${SOUL_STRENGTH_LABEL[strength]} takes its chair (${filled}/${SOUL_SIGIL.count}) — the mirror surges to ${formatPower(out)}.`);
  // The hell-scene twin of a building coming online: the multiplier flashes
  // over the mirror (whose live wattage label ticks up underneath it) while
  // the soul's strength label flashes over the chair it just took. Rendered
  // much bigger than a regular floater (sizeMult) so the surge reads even at
  // hell's zoomed-out scale, and held far longer than the 1.4s default — the
  // player has just watched a slow walk-and-bind and deserves time to read
  // the payoff (the linear fade means roughly the first two-thirds of the
  // lifetime is comfortably legible).
  const SOUL_FLOATER_LIFETIME = 6;
  if (portal) {
    const c = hellMirrorCenter(portal);
    pushFloater(state, c.x, c.y - SOUL_SIGIL.chairRadius * 1.5, `x${chair.mult}`, 0x8acfff, SOUL_FLOATER_LIFETIME, undefined, false, true, 4);
    pushFloater(state, chair.hx, chair.hy - SOUL_SIGIL.chairRadius * 1.5, SOUL_STRENGTH_LABEL[strength], 0x8acfff, SOUL_FLOATER_LIFETIME, undefined, false, true, 2);
  }
  if (filled === SOUL_SIGIL.count && !state.soulSigilCompletedAt.has(chair.portalId)) {
    state.soulSigilCompletedAt.set(chair.portalId, state.now);
    playSound('ritual', 0.95, 0.5);
    appendLog(state, `The pentagram blazes to life — the mirror floods the grid with ${formatPower(out)}!`);
  }
}

// The inverse of seatSoulInChair: pull a bound soul back out of its chair.
// The chair empties (the mirror's output divides back down on the next power
// tick), the sigil's completion record is dropped so re-filling the fifth
// chair fires the blaze again, and the soul re-materialises beside the chair
// as a selectable, commandable ghost. Chairs from saves predating the soul
// snapshot reconstruct the kind from the recorded multiplier (a very-strong
// dragon is indistinguishable from a tinytaur there — the dragon wins).
// Returns the freed ghost, or null if the chair was empty.
export function unseatSoulFromChair(state: GameState, chair: SoulChair): Ghost | null {
  if (!chair.occupied) return null;
  const snap = chairSoulSnapshot(chair);
  chair.occupied = false;
  chair.mult = undefined;
  chair.soul = undefined;
  chair.filledAt = undefined;
  chair.claimedBy = undefined;
  state.soulSigilCompletedAt.delete(chair.portalId);
  // Step the soul off the chair, radially outward from the mirror so it
  // doesn't re-trigger anything sitting on the ring.
  const portal = state.buildings.get(chair.portalId);
  const c = portal ? hellMirrorCenter(portal) : { x: chair.hx, y: chair.hy - 1 };
  const a = Math.atan2(chair.hy - c.y, chair.hx - c.x);
  const hx = chair.hx + Math.cos(a) * SOUL_SIGIL.chairRadius * 2;
  const hy = chair.hy + Math.sin(a) * SOUL_SIGIL.chairRadius * 2;
  const w = hellToWorld(hx, hy);
  const ghost: Ghost = {
    id: state.nextId++,
    kind: snap.kind,
    x: w.x, y: w.y,
    // Dragon ghosts use ±1 sprite mirroring where the others use radians.
    facing: snap.kind === 'dragon' ? 1 : Math.PI / 2,
    spawnAt: state.now,
    gold: snap.gold,
    tiny: snap.tiny,
    offX: 0, offY: 0,
    speedMult: 0.75 + Math.random() * 0.5,
    hx, hy,
    commanded: true,
  };
  state.ghosts.push(ghost);
  const sigil = state.soulChairs.filter((sc) => sc.portalId === chair.portalId);
  const filled = sigil.filter((sc) => sc.occupied).length;
  const out = portal ? sigilPortalOutput(defOf(portal).powerOutput, sigil) : 0;
  // The seating chime run upward — release rather than binding.
  playSound('ritual', 0.5, 1.2);
  pushFloater(state, chair.hx, chair.hy - SOUL_SIGIL.chairRadius * 1.5, 'soul freed', 0x8acfff, 4, undefined, false, true, 2);
  appendLog(state, `A soul is freed from its chair (${filled}/${SOUL_SIGIL.count}) — the mirror dims to ${formatPower(out)}.`);
  return ghost;
}


// Lightning Strike — fired by clicking the map while aiming the ability.
// Spends LIGHTNING.bloodCost, kills every unit inside the blast, paints a
// white splatter over every cell in range, drops a jagged bolt, and kicks off
// the decaying power surge. Returns false (with an error beep) when the player
// can't afford it, so the caller can leave aim mode untouched.
export function lightningStrike(state: GameState, x: number, y: number): boolean {
  if (state.blood < LIGHTNING.bloodCost) {
    playSound('error');
    return false;
  }
  state.blood -= LIGHTNING.bloodCost;

  const radiusPx = (LIGHTNING.cellsWide / 2) * CELL;
  const r2 = radiusPx * radiusPx;
  const within = (px: number, py: number) => {
    const dx = px - x, dy = py - y;
    return dx * dx + dy * dy <= r2;
  };

  // Lightning vaporises every unit in the blast — goblins, minotaurs, and
  // dragons — and pays out their usual kill rewards. Dragons grant their
  // dragon-on-dragon bone drop; any building a struck dragon was carrying is
  // lost with it, matching dragonKill's semantics. Each victim emits its own
  // floater above its head (same as a single goblin death) so the player
  // sees discrete drops rather than one aggregate readout at the centre.
  let killed = 0;
  for (const g of [...state.goblins.values()]) {
    // Robots are unkillable — the bolt washes right over them.
    if (g.robot) continue;
    if (within(g.pos.x, g.pos.y)) {
      vaporiseGoblin(state, g);
      killed++;
    }
  }
  for (const m of [...state.minotaurs.values()]) {
    if (within(m.pos.x, m.pos.y)) {
      vaporiseMinotaur(state, m);
      killed++;
    }
  }
  let dragonsKilled = 0;
  for (const d of [...state.dragons.values()]) {
    if (within(d.pos.x, d.pos.y)) {
      vaporiseDragon(state, d);
      killed++;
      dragonsKilled++;
    }
  }
  // Lolly mid-rampage isn't killed by the bolt — she drinks it, and surges.
  if (state.lolly && !state.finale && within(state.lolly.pos.x, state.lolly.pos.y)) {
    applyLollyBoost(state, 'lightning');
  }

  // White blood over every cell whose center falls inside the blast.
  const span = Math.ceil(LIGHTNING.cellsWide / 2);
  const ccx = Math.floor(x / CELL), ccy = Math.floor(y / CELL);
  for (let cy = ccy - span; cy <= ccy + span; cy++) {
    for (let cx = ccx - span; cx <= ccx + span; cx++) {
      const c = cellCenter({ cx, cy });
      if (within(c.x, c.y)) pushDeathEffect(state, c.x, c.y, true);
    }
  }

  pushLightningBolt(state, x, y);

  // One decaying +1 GW surge per building caught in the blast — the floater
  // rides over each struck building, and a strike that hits no buildings
  // produces no power gain at all. "Caught" means any of the building's
  // footprint cell centers lands in the blast — same test the splatter loop
  // above uses — so a large building visibly painted by the strike always
  // counts, even when its own center sits just outside the blast radius.
  const struckReactors: Building[] = [];
  for (const b of state.buildings.values()) {
    const struck = buildingFootprint(b).some((cell) => {
      const cc = cellCenter(cell);
      return within(cc.x, cc.y);
    });
    if (!struck) continue;
    // A completed Nuclear Reactor doesn't surge — it goes critical. Collected
    // here and detonated after the loop, since the meltdown deletes buildings
    // from the very map this loop is iterating. A mere construction site has
    // no fuel in it yet, so it takes the ordinary surge like anything else.
    if (b.kind === 'nuclear_reactor' && b.state !== 'constructing') {
      struckReactors.push(b);
      continue;
    }
    const c = buildingCenter(b);
    state.powerBoosts.push({
      startAt: state.now,
      peak: LIGHTNING.powerBoostWatts,
      duration: LIGHTNING.powerBoostSeconds,
    });
    pushFloater(
      state, c.x, c.y,
      `+${(LIGHTNING.powerBoostWatts / 1e9).toFixed(2)} GW`,
      0x8acfff,
      LIGHTNING.powerBoostSeconds,
      LIGHTNING.powerBoostWatts,
    );
  }
  // The thunderclap has its own dedicated pool ('lightning' — same sample,
  // pitched down): sharing the busy 'destroy' pool let other destroy plays
  // steal the element mid-rumble, which cut the thunder off or silenced it.
  playSound('lightning', 0.7, 0.4);
  if (killed > 0) playDecayingGoblinDeath(0.6);
  appendLog(state, `Lightning strike! ${killed} unit${killed === 1 ? '' : 's'} vaporised.`);

  // Detonate any struck reactors — each starts a radiating shockwave whose
  // kills accrue over the following seconds (see updateMeltdowns; the wave
  // folds its own cull into the sticky stats when it finishes).
  for (const b of struckReactors) detonateReactor(state, b);

  // Stat: remember the biggest single-strike cull (sticky).
  if (killed > state.maxStruckAtOnce) state.maxStruckAtOnce = killed;
  // Sticky truth the demons weigh: two-plus dragons gored in one bolt.
  if (dragonsKilled >= 2) state.slewTwoDragonsInOneStrike = true;
  // 2-second cooldown to stop the player from carpet-bombing through every
  // wave of spawns in one breath. Ticked down in the sim, gated in main's
  // onLightningStrike + ui's button refresh.
  state.lightningStrikeCooldown = 2;
  return true;
}

// Kill-with-bounty bookkeeping shared by Lightning Strike and the reactor
// meltdown: pay the victim's usual reward, raise its floaters over the
// corpse, record the hell ghost, and remove it from the world. Robots never
// come through here — they pay no bounty and have no soul to record.
function vaporiseGoblin(state: GameState, g: Goblin): void {
  const r = goblinKillReward(state, g);
  const tx = g.pos.x, ty = g.pos.y;
  earnMoney(state, r.money);
  earnBlood(state, r.blood);
  state.bloodUnlocked = true;
  pushFloater(state, tx, ty, `+Ƶ${r.money.toLocaleString('en-US')}`, 0xffd96b, 1.6);
  pushFloater(state, tx, ty - 14, `+${r.blood} blood`, 0xff8a8a, 1.6);
  recordGhost(state, 'goblin', tx, ty, g.facing, { gold: g.gold, bob: g.bob });
  removeGoblin(state, g.id);
}

function vaporiseMinotaur(state: GameState, m: Minotaur): void {
  const tx = m.pos.x, ty = m.pos.y;
  if (MINOTAUR_KILL_REWARD.money > 0) {
    earnMoney(state, MINOTAUR_KILL_REWARD.money);
    pushFloater(state, tx, ty, `+Ƶ${MINOTAUR_KILL_REWARD.money.toLocaleString('en-US')}`, 0xffd96b, 1.6);
  }
  earnBlood(state, MINOTAUR_KILL_REWARD.blood);
  state.bloodUnlocked = true;
  pushFloater(state, tx, ty - 14, `+${MINOTAUR_KILL_REWARD.blood} blood`, 0xff8a8a, 1.6);
  recordGhost(state, 'minotaur', tx, ty, m.facing, { tiny: m.tiny });
  state.minotaurs.delete(m.id);
}

// Any building the dragon was carrying is lost with it, matching dragonKill's
// semantics.
function vaporiseDragon(state: GameState, d: Dragon): void {
  const tx = d.pos.x, ty = d.pos.y;
  earnDragonBone(state, DRAGON_KILL_REWARD.dragonBone);
  state.dragonBoneUnlocked = true;
  pushFloater(state, tx, ty, `+${DRAGON_KILL_REWARD.dragonBone} dragon bone${DRAGON_KILL_REWARD.dragonBone === 1 ? '' : 's'}`, 0xeae0c0, 1.8);
  recordGhost(state, 'dragon', tx, ty, d.facing);
  removeDragon(state, d.id);
}

// Struck by lightning, a completed Nuclear Reactor goes critical: the core
// detonates and a green/white shockwave starts radiating out from the
// reactor's centre (advanced tick by tick in updateMeltdowns — every
// overworld unit dies as the front reaches it, even robots). This function
// handles the instant of rupture: the reactor is levelled, a fan of extra
// bolts answers from the sky, the dying core dumps one final
// REACTOR_MELTDOWN.powerBoostWatts surge into the grid, and a power-up tone
// plays pitched down as far as the resampler allows.
function detonateReactor(state: GameState, reactor: Building): void {
  const c = buildingCenter(reactor);
  const name = `${defOf(reactor).name} #${reactor.displayNum}`;
  destroyBuilding(state, reactor.id);
  pushDeathEffect(state, c.x, c.y, true);

  // The sky answers the rupture: a fan of extra bolts scattered around the
  // crater zone, on top of the one that set it off.
  const radiusPx = (REACTOR_MELTDOWN.splatterCells / 2) * CELL;
  for (let i = 0; i < REACTOR_MELTDOWN.boltCount; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = Math.random() * radiusPx;
    pushLightningBolt(state, c.x + Math.cos(a) * r, c.y + Math.sin(a) * r);
  }

  // The core's last act: a decaying death-surge an order of magnitude beyond
  // the reactor's rated output, with the countdown floater riding the crater.
  state.powerBoosts.push({
    startAt: state.now,
    peak: REACTOR_MELTDOWN.powerBoostWatts,
    duration: REACTOR_MELTDOWN.powerBoostSeconds,
  });
  pushFloater(
    state, c.x, c.y,
    `+${(REACTOR_MELTDOWN.powerBoostWatts / 1e9).toFixed(2)} GW`,
    0x8acfff,
    REACTOR_MELTDOWN.powerBoostSeconds,
    REACTOR_MELTDOWN.powerBoostWatts,
  );
  pushFloater(state, c.x, c.y - CELL * 2, 'MELTDOWN!', 0xff4040, 4, undefined, false, false, 3);

  // A sample dragged to the resampler's floor — a long electric groan as a
  // gigawatt leaves all at once (the building power-up chime by default;
  // pickable from the dev menu's Audio section). The strike's own
  // thunderclap covers the treble.
  playSound(getOptions().meltdownSound, 1, 0.25);
  appendLog(state, `${name} goes critical! A shockwave races out from the core...`);

  // Whole-screen radiation wash — faded back out by the renderer.
  state.lastMeltdownAt = state.now;
  state.meltdowns.push({
    id: state.nextId++,
    x: c.x, y: c.y,
    startAt: state.now,
    lastRadius: 0,
    killed: 0,
    dragonsKilled: 0,
  });
}

// Advance every active meltdown shockwave: kill the units the front passed
// over this tick (full bounties via the vaporise helpers; robots die too but
// leave no soul and pay nothing), paint fallout splatter across the crater
// zone as the wave crosses it, and — once the front has cleared the whole
// world — fold the cull into the strike stats and log the butcher's bill.
function updateMeltdowns(state: GameState) {
  if (state.meltdowns.length === 0) return;
  // Far enough to swallow the world's farthest corner from any origin.
  const maxRadius = Math.hypot(WORLD.width, WORLD.height);
  const splatterPx = (REACTOR_MELTDOWN.splatterCells / 2) * CELL;
  for (let i = state.meltdowns.length - 1; i >= 0; i--) {
    const m = state.meltdowns[i];
    const radius = (state.now - m.startAt) * REACTOR_MELTDOWN.waveSpeed;
    const r2 = radius * radius;
    const within = (px: number, py: number) => {
      const dx = px - m.x, dy = py - m.y;
      return dx * dx + dy * dy <= r2;
    };

    for (const g of [...state.goblins.values()]) {
      if (!within(g.pos.x, g.pos.y)) continue;
      pushDeathEffect(state, g.pos.x, g.pos.y, true);
      if (g.robot) {
        // The one thing a robot is allergic to: radioactive waste. No bounty,
        // no soul — but the kill counts toward Lilly's "Destroy a robot" Work.
        state.robotsDestroyed++;
        removeGoblin(state, g.id);
      } else {
        vaporiseGoblin(state, g);
      }
      m.killed++;
    }
    for (const mt of [...state.minotaurs.values()]) {
      if (!within(mt.pos.x, mt.pos.y)) continue;
      pushDeathEffect(state, mt.pos.x, mt.pos.y, true);
      vaporiseMinotaur(state, mt);
      m.killed++;
    }
    for (const d of [...state.dragons.values()]) {
      if (!within(d.pos.x, d.pos.y)) continue;
      pushDeathEffect(state, d.pos.x, d.pos.y, true);
      vaporiseDragon(state, d);
      m.killed++;
      m.dragonsKilled++;
    }
    // The front washing over Lolly doesn't kill her — the fallout supercharges
    // her. Once per meltdown, the first tick the wave reaches her.
    if (state.lolly && !state.finale && !m.lollyBoosted && within(state.lolly.pos.x, state.lolly.pos.y)) {
      m.lollyBoosted = true;
      applyLollyBoost(state, 'nuclear');
    }

    // Fallout splatter, painted progressively: cells inside the crater zone
    // whose centers sit in the (lastRadius, radius] annulus this tick.
    if (m.lastRadius < splatterPx) {
      const span = Math.ceil(REACTOR_MELTDOWN.splatterCells / 2);
      const ccx = Math.floor(m.x / CELL), ccy = Math.floor(m.y / CELL);
      const last2 = m.lastRadius * m.lastRadius;
      const sp2 = splatterPx * splatterPx;
      for (let cy = ccy - span; cy <= ccy + span; cy++) {
        for (let cx = ccx - span; cx <= ccx + span; cx++) {
          const cc = cellCenter({ cx, cy });
          const dx = cc.x - m.x, dy = cc.y - m.y;
          const d2 = dx * dx + dy * dy;
          if (d2 > last2 && d2 <= r2 && d2 <= sp2) pushDeathEffect(state, cc.x, cc.y, true);
        }
      }
    }

    m.lastRadius = radius;
    if (radius >= maxRadius) {
      // Stat: the meltdown counts toward the biggest single-strike cull, and
      // toward the demons' two-dragons truth — one bolt set it all off.
      if (m.killed > state.maxStruckAtOnce) state.maxStruckAtOnce = m.killed;
      if (m.dragonsKilled >= 2) state.slewTwoDragonsInOneStrike = true;
      if (m.killed > 0) playDecayingGoblinDeath(0.8);
      appendLog(state, `The meltdown wipes out ${m.killed} unit${m.killed === 1 ? '' : 's'} — nothing in the overworld survives.`);
      state.meltdowns.splice(i, 1);
    }
  }
}

// Designer-only: hatch a gold goblin immediately, bypassing the cost + spawn
// queue. Just spawnGoblin with the gold roll forced on.
export function spawnGoldGoblinNow(state: GameState): void {
  spawnGoblin(state, true);
}

function spawnGoblin(state: GameState, forceGold = false) {
  // Round-robin between the main hole and every completed Goblin Hole. A
  // freshly-built hole is added to the rotation automatically. A main hole
  // Lolly has destroyed drops out of the rotation entirely.
  const holeCells: Cell[] = [];
  const isMain: boolean[] = [];
  if (!state.holeDestroyed) {
    holeCells.push({ cx: state.hole.cell.cx, cy: state.hole.cell.cy });
    isMain.push(true);
  }
  for (const b of state.buildings.values()) {
    if (b.kind !== 'goblin_hole') continue;
    if (b.state === 'constructing') continue;
    holeCells.push({ cx: b.cell.cx, cy: b.cell.cy });
    isMain.push(false);
  }
  // Try each hole starting at the rotation index; pick the first that yields a
  // reachable free emergence cell (one a goblin could actually walk out to — a
  // hole walled over yields none). Bump rotation regardless so spawns spread out.
  const start = state.spawnHoleRotation % holeCells.length;
  let cell: Cell | null = null;
  for (let i = 0; i < holeCells.length; i++) {
    const idx = (start + i) % holeCells.length;
    if (isMain[idx] && holeBlockedByBuilding(state)) continue;
    cell = findHoleEmergenceCell(state, holeCells[idx].cx, holeCells[idx].cy);
    if (cell) {
      state.spawnHoleRotation = idx + 1;
      break;
    }
  }
  if (!cell) {
    state.money += GOBLIN.spawnCost;
    appendLog(state, 'All Goblin Holes blocked; spawn refunded.');
    // Once three spawns in a row have been blocked, mute the error beep so a
    // permanently walled-in hole doesn't machine-gun the soundscape. The next
    // successful spawn resets the streak and the beep returns.
    state.spawnFailStreak++;
    if (state.spawnFailStreak < 3) playSound('error');
    return;
  }
  const id = state.nextId++;
  const isGold = forceGold || (state.goldgoblinsEnabled && Math.random() < GOLD_GOBLIN_CHANCE);
  const g: Goblin = {
    id, pos: cellCenter(cell), cell,
    target: null, goal: null,
    path: [],
    facing: Math.PI / 2,
    state: { kind: 'idle' }, selected: false, idleSince: null, lastCellChangedAt: state.now,
    gold: isGold || undefined,
  };
  state.goblins.set(id, g);
  occupyCell(state, cell.cx, cell.cy, id);
  state.spawnsCompleted++;
  state.spawnFailStreak = 0;
  // Decaying-volume helper in audio.ts so a wall of late-game goblins
  // doesn't drown the rest of the soundscape. A slight random pitch wobble
  // (±4%) stops a burst of spawns sounding like one machine-gun tone.
  playDecayingGoblinSpawn(0.96 + Math.random() * 0.08);
  appendLog(state, isGold ? `Gold Goblin #${id} hatched!` : `Goblin #${id} hatched.`);
  if (state.autoAssignEnabled) autoAssignAllIdle(state);
}

// Seat Bob (the cutscene-summoned goblin) at the chosen hole. Bypasses the
// spawn queue — he's a one-shot summon, not a regular hatchling — but uses the
// same perimeter-cell picker so he can't land on top of an existing goblin or
// inside a building footprint. Returns false (with an error beep) when no free
// cell is reachable around the hole; the caller stays in bobPickingHole so the
// player can try a different hole.
export function spawnBob(state: GameState, holeCell: Cell): boolean {
  const cell = findHoleEmergenceCell(state, holeCell.cx, holeCell.cy);
  if (!cell) {
    playSound('error');
    appendLog(state, 'No room to summon Bob — try a different Goblin Hole.');
    return false;
  }
  const id = state.nextId++;
  const g: Goblin = {
    id, pos: cellCenter(cell), cell,
    target: null, goal: null,
    path: [], facing: Math.PI / 2,
    state: { kind: 'idle' }, selected: false, idleSince: null, lastCellChangedAt: state.now,
    bob: true,
  };
  state.goblins.set(id, g);
  occupyCell(state, cell.cx, cell.cy, id);
  state.spawnsCompleted++;
  playDecayingGoblinSpawn(0.85);
  appendLog(state, 'Bob has joined the crew.');
  if (state.autoAssignEnabled) autoAssignAllIdle(state);
  return true;
}

// Assemble a robot at the main hole — the late-game money summon. Uses the
// same emergence-cell flood as a hatching goblin so it can't land on top of
// anyone. Returns false silently when every hole exit is blocked — the
// assembly queue in tick() retries shortly after. With `terminator` set the
// chassis comes out hunting instead: red head-lamp, no jobs, lasers for
// everything fleshy (see the terminator pass in tick).
export function spawnRobot(state: GameState, terminator = false): boolean {
  // Assembly normally happens at the main hole; if Lolly has destroyed it,
  // fall back to any completed Goblin Hole still standing.
  let cell: Cell | null = null;
  if (!state.holeDestroyed) {
    const h = state.hole.cell;
    cell = findHoleEmergenceCell(state, h.cx, h.cy);
  }
  if (!cell) {
    for (const b of state.buildings.values()) {
      if (b.kind !== 'goblin_hole' || b.state === 'constructing') continue;
      cell = findHoleEmergenceCell(state, b.cell.cx, b.cell.cy);
      if (cell) break;
    }
  }
  if (!cell) return false;
  const id = state.nextId++;
  const g: Goblin = {
    id, pos: cellCenter(cell), cell, target: null, goal: null,
    path: [], facing: Math.PI / 2,
    state: { kind: 'idle' }, selected: false, idleSince: null, lastCellChangedAt: state.now,
    robot: true,
    terminator: terminator || undefined,
  };
  state.goblins.set(id, g);
  occupyCell(state, cell.cx, cell.cy, id);
  // First terminator ever assembled reveals the terminating slider (stays
  // visible thereafter even if every terminator later dies).
  if (terminator) state.terminatorEverSpawned = true;
  // No sound here — the robotic chirp plays at queue time (onSummonRobot),
  // like the Minotaur's ritual sting, rather than when the bar completes.
  appendLog(state, terminator
    ? `Terminator #${id} online. It begins scanning for targets.`
    : `Robot #${id} whirrs to life.`);
  if (state.autoAssignEnabled) autoAssignAllIdle(state);
  return true;
}

// A terminator's next prey: the most VALUABLE killable unit first, nearest
// within a value tier. A dragon's bone drop outranks a goldblin's payout,
// which outranks a minotaur's blood, which outranks a common goblin's
// pocket change. Robots and fellow terminators are kin. Null once the world
// is picked clean.
function nearestTerminatorTarget(
  state: GameState, t: Goblin,
): { kind: 'goblin' | 'minotaur' | 'dragon'; id: number } | null {
  let best: { kind: 'goblin' | 'minotaur' | 'dragon'; id: number } | null = null;
  let bestTier = -1;
  let bestD = Infinity;
  const consider = (kind: 'goblin' | 'minotaur' | 'dragon', id: number, x: number, y: number, tier: number) => {
    if (tier < bestTier) return;
    const d = (x - t.pos.x) * (x - t.pos.x) + (y - t.pos.y) * (y - t.pos.y);
    if (tier > bestTier || d < bestD) { bestTier = tier; bestD = d; best = { kind, id }; }
  };
  for (const g of state.goblins.values()) {
    if (g.robot) continue;
    // Spare goblins busy on a building — maintaining or constructing one, or on
    // their way to do so. Terminators leave the workforce to its labour and hunt
    // the idle/wandering/fighting rest.
    if (g.state.kind === 'maintaining' || g.state.kind === 'building'
        || g.state.kind === 'going_to_maintain' || g.state.kind === 'going_to_build') continue;
    consider('goblin', g.id, g.pos.x, g.pos.y, g.gold ? 2 : 0);
  }
  for (const m of state.minotaurs.values()) consider('minotaur', m.id, m.pos.x, m.pos.y, 1);
  for (const d of state.dragons.values()) consider('dragon', d.id, d.pos.x, d.pos.y, 3);
  return best;
}

// How many carriers Autowater should keep on a drinking building. Close to the
// water a tiny crew keeps the meter full; the farther the round trip, the more
// carriers it takes to refill faster than the meter drains. Floored at the def's
// base target and capped at waterCarrierMax so one distant building can't
// swallow the whole workforce.
function waterCarrierTarget(state: GameState, b: Building): number {
  const def = defOf(b);
  const base = def.waterAutoAssignTarget ?? 0;
  const delivery = def.waterDeliveryAmount ?? 0;
  if (base === 0 || delivery <= 0) return base;
  const src = nearestWaterSourceTo(state, b);
  if (!src) return base;
  const depletion = def.waterDepletionPerSec ?? WATER_DEPLETION_PP_PER_SEC;
  const c = buildingCenter(b);
  // Nearest point of the source region to the building, in pixels.
  const sx = Math.min(Math.max(c.x, src.x0 * CELL), src.x1 * CELL);
  const sy = Math.min(Math.max(c.y, src.y0 * CELL), src.y1 * CELL);
  const oneWay = Math.hypot(c.x - sx, c.y - sy);
  // There and back at goblin speed, plus the ~1s dip the carrier dwells in water.
  const roundTrip = (2 * oneWay) / GOBLIN.speed + 1;
  // Each carrier delivers `delivery` pp per round trip; size the crew to the drain.
  const needed = Math.ceil((depletion * roundTrip) / delivery);
  const cap = def.waterCarrierMax ?? base;
  return Math.max(base, Math.min(cap, needed));
}

// Fill every understaffed building from the pool of idle goblins, picking the
// closest idle goblin for each open slot. Tier order is constructing > dormant
// > active-short-on-maintainers; within a tier, fewer-currently-assigned wins
// the next pick (so two equally-needy buildings get filled evenly).
export function autoAssignAllIdle(state: GameState) {
  if (!state.autoAssignEnabled) return;

  type Need = { b: Building; tier: number; slots: number; center: { x: number; y: number } };
  const needs: Need[] = [];
  for (const b of state.buildings.values()) {
    const def = defOf(b);
    const required = b.state === 'constructing' ? def.buildersRequired : def.maintainersRequired;
    const slots = required - b.assignedGoblins.length;
    if (slots <= 0) continue;
    const tier =
      b.state === 'constructing' ? 3 :
      b.state === 'dormant' ? 2 : 1;
    needs.push({ b, tier, slots, center: buildingCenter(b) });
  }
  const idle: Goblin[] = [];
  for (const g of state.goblins.values()) {
    // Terminators take no jobs — between kills they're "idle" only in the
    // instant before the hunting pass re-locks their laser.
    if (g.terminator) continue;
    if (g.state.kind === 'idle') idle.push(g);
  }
  if (idle.length === 0) return;

  // Water duty runs independently of maintainer/builder needs — a fully-staffed
  // map still has Datacentres to keep wet, so this must not be gated behind
  // `needs` being non-empty (it used to be, which silently starved watering
  // whenever everything was staffed). Keep every thirsty, fully-staffed drinker
  // topped up to its (distance-scaled) carrier target, driest building first so
  // scarce idle goblins shore up whichever is closest to running dry. Gated on
  // the Autowater ritual; manual right-click ignores these caps.
  if (state.autoWaterEnabled && state.waterSources.size > 0) {
    type Drinker = { b: Building; target: number; meter: number };
    const drinkers: Drinker[] = [];
    for (const b of state.buildings.values()) {
      const def = defOf(b);
      if ((def.waterAutoAssignTarget ?? 0) === 0) continue;
      if (b.state === 'constructing') continue;
      // Maintainers are the more pressing need, and a delivery doesn't even
      // land while understaffed — so don't water until fully staffed.
      if (maintainerCount(state, b) < def.maintainersRequired) continue;
      if (!nearestWaterSourceTo(state, b)) continue;
      drinkers.push({ b, target: waterCarrierTarget(state, b), meter: b.waterMeter ?? 0 });
    }
    drinkers.sort((x, y) => x.meter - y.meter);
    for (const dr of drinkers) {
      if (idle.length === 0) break;
      const source = nearestWaterSourceTo(state, dr.b)!;
      while (waterCarrierCount(state, dr.b) < dr.target && idle.length > 0) {
        const c = buildingCenter(dr.b);
        // Robots take watering duty ahead of any goblin, however far away —
        // they're the fastest carriers and nothing can kill one en route.
        // Within a class (robot vs goblin), nearest still wins.
        let pickI = 0;
        let pickD = Infinity;
        let pickRobot = false;
        for (let i = 0; i < idle.length; i++) {
          const g = idle[i];
          const isRobot = !!g.robot;
          if (pickRobot && !isRobot) continue;
          const dx = g.pos.x - c.x;
          const dy = g.pos.y - c.y;
          const d = dx * dx + dy * dy;
          if ((isRobot && !pickRobot) || d < pickD) { pickD = d; pickI = i; pickRobot = isRobot; }
        }
        const g = idle.splice(pickI, 1)[0];
        dr.b.assignedGoblins.push(g.id);
        g.goal = null;
        g.path = [];
        g.state = { kind: 'fetching_water', buildingId: dr.b.id, sourceId: source.id, phase: 'to_source' };
        g.lastCellChangedAt = state.now;
      }
    }
  }

  while (idle.length > 0) {
    let best: Need | null = null;
    for (const n of needs) {
      if (n.slots <= 0) continue;
      if (!best
          || n.tier > best.tier
          || (n.tier === best.tier && n.b.assignedGoblins.length < best.b.assignedGoblins.length)) {
        best = n;
      }
    }
    if (!best) return;

    // Construction sites poach idle robots ahead of any goblin, however far
    // away — their compounding 0.7× build-time bonus beats a goblin's head
    // start. Maintain needs are the inverse: robots are never auto-assigned
    // to them (a robot maintains no better than a goblin, so it'd be a waste
    // of one — manual commands can still do it). Within a class, nearest wins.
    const wantRobot = best.b.state === 'constructing';
    let pickI = -1;
    let pickD = Infinity;
    let pickRobot = false;
    for (let i = 0; i < idle.length; i++) {
      const g = idle[i];
      const isRobot = !!g.robot;
      if (!wantRobot && isRobot) continue;
      if (wantRobot && pickRobot && !isRobot) continue;
      const dx = g.pos.x - best.center.x;
      const dy = g.pos.y - best.center.y;
      const d = dx * dx + dy * dy;
      if ((wantRobot && isRobot && !pickRobot) || d < pickD) { pickD = d; pickI = i; pickRobot = isRobot; }
    }
    // Only robots left in the pool and a maintain slot on the table: nothing
    // eligible. Retire this need and move on, so the loop can't stall (or
    // worse, draft a robot at index 0 by default).
    if (pickI === -1) { best.slots = 0; continue; }
    const g = idle.splice(pickI, 1)[0];
    best.b.assignedGoblins.push(g.id);
    g.goal = null;
    g.path = [];
    g.state = best.b.state === 'constructing'
      ? { kind: 'going_to_build', buildingId: best.b.id }
      : { kind: 'going_to_maintain', buildingId: best.b.id };
    best.slots--;
  }
}

// Pop a minotaur out of the goblin hole. Minotaurs don't queue/take spawn time —
// summoning is instant; if the hole and its perimeter are fully blocked, the
// summon refunds.
function makeMinotaur(state: GameState, cell: Cell, tiny: boolean): Minotaur {
  return {
    id: state.nextId++,
    pos: cellCenter(cell),
    cell,
    target: null,
    facing: 0,
    state: { kind: 'wander' },
    nextWanderAt: state.now + MINOTAUR.wanderInterval,
    selected: false,
    stuckSampleCell: null,
    stuckSampleAt: state.now,
    stuckStreak: 0,
    detour: null,
    tiny: tiny || undefined,
  };
}

export function spawnMinotaur(state: GameState, tiny = false): boolean {
  const cell = pickMinotaurSpawnCell(state);
  if (!cell) return false;
  const t = makeMinotaur(state, cell, tiny);
  state.minotaurs.set(t.id, t);
  // The Summon-2-Minotaurs task counts rituals that actually finished, not
  // purchases — this is the moment the minotaur exists.
  if (!tiny) state.minotaursSummoned++;
  appendLog(state, tiny ? `Tinytaur #${t.id} skitters out of the hole.` : `Minotaur #${t.id} crawls out of the hole.`);
  playSound('goblin_spawn', tiny ? 2.2 : 1.4, 0.3);
  return true;
}

// Summon a Tinytaur by sacrificing TINYTAUR.minotaurCost living Minotaurs:
// they die on the spot and the Tinytaur rises from where the first one fell.
// Returns false (charging nothing) if there aren't enough Minotaurs.
export function spawnTinytaur(state: GameState): boolean {
  const fodder = [...state.minotaurs.values()].filter((m) => !m.tiny);
  if (fodder.length < TINYTAUR.minotaurCost) return false;
  const victims = fodder.slice(0, TINYTAUR.minotaurCost);
  const birthCell = victims[0].cell;
  for (const m of victims) {
    pushDeathEffect(state, m.pos.x, m.pos.y);
    recordGhost(state, 'minotaur', m.pos.x, m.pos.y, m.facing, { tiny: m.tiny });
    state.minotaurs.delete(m.id);
  }
  const t = makeMinotaur(state, birthCell, true);
  state.minotaurs.set(t.id, t);
  appendLog(state, `Tinytaur #${t.id} rises from ${TINYTAUR.minotaurCost} sacrificed Minotaurs.`);
  playSound('ritual');
  playSound('goblin_spawn', 2.2, 0.3);
  return true;
}

function minotaurWalkable(state: GameState, cx: number, cy: number, selfId?: number): boolean {
  if (!isInBounds(cx, cy)) return false;
  if (state.walls.has(cellKey(cx, cy))) return false;
  if (buildingAtCell(state, cx, cy)) return false;
  // Reserve cells already held — current cell or in-flight step target — by
  // any other minotaur. Two of them must never share a square.
  for (const m of state.minotaurs.values()) {
    if (m.id === selfId) continue;
    if (m.cell.cx === cx && m.cell.cy === cy) return false;
    if (m.target && m.target.cx === cx && m.target.cy === cy) return false;
  }
  return true;
}

// Rotate an 8-way direction by k steps of 45° (positive = clockwise).
function rotDir(d: Dir, k: number): Dir {
  return ((((d + k) % 8) + 8) % 8) as Dir;
}

// One movement step toward whatever `distFn` measures (octile to a cell,
// or to a building's footprint). Same cost class as the old pure-greedy step:
// a constant handful of neighbor checks, no search, no allocation beyond the
// returned cell.
//
// Greedy alone ping-pongs against building faces — every walkable neighbor
// ties with the current distance, so the minotaur jitters in place until the
// stuck-check gives up on the order. Instead, when no neighbor makes strict
// progress we start a Bug-style detour: pick the turn sense whose side opens
// up first and then hug the obstacle hand-on-wall (sharpest turn back toward
// the wall first, so corners wrap tightly), leaving the wall as soon as a
// step would land strictly closer than where we hit it (`hitDist`). Each
// detour therefore exits closer to the goal than the last began, so progress
// is monotone across detours; the stuck-check stays on as the backstop for
// genuinely unreachable targets. `tag` names the pursuit (target id / goal
// key) — a detour only persists while the tag matches, so new orders never
// inherit stale wall-following state.
function minotaurStep(
  state: GameState,
  t: Minotaur,
  tag: number,
  distFn: (cx: number, cy: number) => number,
): Cell | null {
  if (t.detour && t.detour.tag !== tag) t.detour = null;
  // Greedy candidate: walkable 8-neighbor with the smallest distance.
  let best: Cell | null = null;
  let bestDist = Infinity;
  let walkableCount = 0;
  for (const d of ALL_DIRS) {
    const nx = t.cell.cx + DX[d];
    const ny = t.cell.cy + DY[d];
    if (!minotaurWalkable(state, nx, ny, t.id)) continue;
    walkableCount++;
    const dist = distFn(nx, ny);
    if (dist < bestDist) { bestDist = dist; best = { cx: nx, cy: ny }; }
  }
  if (!best) return null; // fully boxed in
  if (t.detour) {
    // Leave the wall once a step beats the distance where we hit it — or if
    // there's no wall left to follow (the obstacle was a unit that moved on),
    // in which case greedy progress is guaranteed: the ideal direction is
    // walkable, so following further would just spiral in open space.
    if (bestDist < t.detour.hitDist || walkableCount === 8) {
      t.detour = null;
      return best;
    }
    // Hand-on-wall: the obstacle sits on the -dir side of our heading, so try
    // the sharpest turn toward it first (wraps corners), straight ahead next,
    // then progressively away — full reverse only as a dead-end last resort.
    const s = t.detour.dir;
    for (let i = -2; i <= 5; i++) {
      const d = rotDir(t.detour.lastDir, i * s);
      const nx = t.cell.cx + DX[d];
      const ny = t.cell.cy + DY[d];
      if (!minotaurWalkable(state, nx, ny, t.id)) continue;
      t.detour.lastDir = d;
      return { cx: nx, cy: ny };
    }
    return best; // unreachable: `best` is itself walkable
  }
  const curDist = distFn(t.cell.cx, t.cell.cy);
  if (bestDist < curDist) return best; // clear progress — no detour needed
  // Ran into an obstacle. The desired heading is the (possibly unwalkable)
  // direction that closes distance fastest; probe rotations alternating
  // outward from it and commit to whichever turn sense opens up first.
  let idealDir: Dir = 0;
  let idealDist = Infinity;
  for (const d of ALL_DIRS) {
    const dist = distFn(t.cell.cx + DX[d], t.cell.cy + DY[d]);
    if (dist < idealDist) { idealDist = dist; idealDir = d; }
  }
  for (let r = 1; r <= 4; r++) {
    for (const s of [1, -1] as const) {
      const d = rotDir(idealDir, r * s);
      const nx = t.cell.cx + DX[d];
      const ny = t.cell.cy + DY[d];
      if (!minotaurWalkable(state, nx, ny, t.id)) continue;
      t.detour = { tag, dir: s, hitDist: curDist, lastDir: d };
      return { cx: nx, cy: ny };
    }
  }
  return best;
}

// Octile distance — the length of an unobstructed 8-way path where diagonal
// steps cost their true √2. Plain Chebyshev made the greedy step veer off on
// huge diagonals: toward a target due east, NE "improves" the distance just
// as much as E does and is probed first (ALL_DIRS is clockwise from north),
// so a minotaur would climb a long diagonal until the axes balanced and then
// ride another diagonal back down — a big triangle instead of a straight
// line. Charging diagonals √2 makes greedy pick the natural
// diagonal-while-it-helps, straight-once-aligned line.
const DIAG_EXTRA = Math.SQRT2 - 1;
function octile(dx: number, dy: number): number {
  const ax = Math.abs(dx), ay = Math.abs(dy);
  return Math.max(ax, ay) + DIAG_EXTRA * Math.min(ax, ay);
}

function minotaurStepToward(state: GameState, t: Minotaur, target: Cell, tag: number): Cell | null {
  return minotaurStep(state, t, tag, (cx, cy) =>
    octile(cx - target.cx, cy - target.cy));
}

function minotaurWanderStep(state: GameState, t: Minotaur): Cell | null {
  const choices: Cell[] = [];
  for (const d of ALL_DIRS) {
    const nx = t.cell.cx + DX[d];
    const ny = t.cell.cy + DY[d];
    if (minotaurWalkable(state, nx, ny, t.id)) choices.push({ cx: nx, cy: ny });
  }
  if (choices.length === 0) return null;
  return choices[Math.floor(Math.random() * choices.length)];
}

// Auto-target assignment for minotaurs. Each idle/hunting minotaur is matched to
// at most one goblin, and no two minotaurs share a goblin: we greedily commit the
// globally-closest (minotaur, goblin) pair, then the next-closest among what's
// left, and so on. So when several minotaurs would otherwise pile onto the same
// goblin, only the nearest keeps it and the rest peel off to other prey (or
// wander if none remain). Player-issued orders (moving_to / going_to_destroy /
// going_to_kill_minotaur / a manual going_to_kill) are excluded — explicit
// commands are never overridden, so the player can still deliberately gang
// several minotaurs onto one target.
function assignMinotaurTargets(state: GameState): Map<number, number> {
  const result = new Map<number, number>();
  const autos: Minotaur[] = [];
  for (const m of state.minotaurs.values()) {
    if (m.state.kind === 'wander' || (m.state.kind === 'going_to_kill' && !m.state.manual)) autos.push(m);
  }
  if (autos.length === 0) return result;
  const goblins: Goblin[] = [];
  for (const g of state.goblins.values()) {
    // Robots can't die, so a minotaur hunting one would gore at it forever.
    if (g.robot) continue;
    // Goblins inside building footprints (workers/maintainers, plus any idle
    // straggler on a footprint cell) are sheltered from minotaurs.
    if (buildingAtCell(state, g.cell.cx, g.cell.cy)) continue;
    goblins.push(g);
  }
  if (goblins.length === 0) return result;
  const assignedM = new Set<number>();
  const takenG = new Set<number>();
  const pairs = Math.min(autos.length, goblins.length);
  for (let k = 0; k < pairs; k++) {
    let bestM: Minotaur | null = null;
    let bestG: Goblin | null = null;
    let bestD = Infinity;
    for (const m of autos) {
      if (assignedM.has(m.id)) continue;
      for (const g of goblins) {
        if (takenG.has(g.id)) continue;
        const dx = g.pos.x - m.pos.x;
        const dy = g.pos.y - m.pos.y;
        const d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; bestM = m; bestG = g; }
      }
    }
    if (!bestM || !bestG) break;
    result.set(bestM.id, bestG.id);
    assignedM.add(bestM.id);
    takenG.add(bestG.id);
  }
  return result;
}

// Chebyshev stays the *adjacency* metric — a diagonally-touching minotaur is
// in smashing range — while octile (below) is the *movement* metric. Both are
// kept allocation-free: the step distFn runs once per probed neighbor.
function chebyshevToBuilding(cell: Cell, b: Building): number {
  const n = defOf(b).cellSize;
  const right = b.cell.cx + n - 1;
  const bottom = b.cell.cy + n - 1;
  const dx = Math.max(0, b.cell.cx - cell.cx, cell.cx - right);
  const dy = Math.max(0, b.cell.cy - cell.cy, cell.cy - bottom);
  return Math.max(dx, dy);
}

function octileToBuilding(cell: Cell, b: Building): number {
  const n = defOf(b).cellSize;
  const right = b.cell.cx + n - 1;
  const bottom = b.cell.cy + n - 1;
  const dx = Math.max(0, b.cell.cx - cell.cx, cell.cx - right);
  const dy = Math.max(0, b.cell.cy - cell.cy, cell.cy - bottom);
  return octile(dx, dy);
}

function minotaurStepTowardBuilding(state: GameState, t: Minotaur, b: Building): Cell | null {
  // One shared probe cell so the distFn doesn't allocate per neighbor.
  const probe: Cell = { cx: 0, cy: 0 };
  return minotaurStep(state, t, b.id, (cx, cy) => {
    probe.cx = cx; probe.cy = cy;
    return octileToBuilding(probe, b);
  });
}

// Stuck detection. Minotaurs step greedily (octile-toward-target) with only
// a wall-following detour for obstacles (see minotaurStep) — no real
// pathfinding — so a pathological pinch — minotaurs blocking each other in a
// corridor, a fully sealed-off target — can still trap one in a tiny area. Every
// STUCK_SAMPLE_PERIOD we snapshot the cell; if the cell hasn't moved more than
// STUCK_BOX_RADIUS in STUCK_THRESHOLD consecutive samples, drop the current
// order and fall back to `wander`. Wander itself never triggers this — it's
// the default state and we don't want to "rescue" a minotaur that's just
// idling somewhere.
const STUCK_SAMPLE_PERIOD = 2;
const STUCK_BOX_RADIUS = 2;
const STUCK_THRESHOLD = 4;
function applyMinotaurStuckCheck(state: GameState, t: Minotaur): boolean {
  if (t.state.kind === 'wander') {
    t.stuckStreak = 0;
    t.stuckSampleCell = t.cell;
    t.stuckSampleAt = state.now;
    // No pursuit — drop any wall-following detour so a later order (even one
    // re-acquiring the same target) starts fresh.
    t.detour = null;
    return false;
  }
  // Defensive defaults for saves persisted before these fields existed.
  if (t.stuckSampleAt === undefined) t.stuckSampleAt = state.now;
  if (t.stuckStreak === undefined) t.stuckStreak = 0;
  if (state.now - t.stuckSampleAt < STUCK_SAMPLE_PERIOD) return false;
  const prev = t.stuckSampleCell;
  t.stuckSampleAt = state.now;
  if (!prev) {
    t.stuckSampleCell = t.cell;
    return false;
  }
  const cd = Math.max(Math.abs(t.cell.cx - prev.cx), Math.abs(t.cell.cy - prev.cy));
  if (cd > STUCK_BOX_RADIUS) {
    t.stuckStreak = 0;
  } else {
    t.stuckStreak++;
  }
  t.stuckSampleCell = t.cell;
  if (t.stuckStreak >= STUCK_THRESHOLD) {
    appendLog(state, `Minotaur #${t.id} can't find a path — standing down.`);
    t.state = { kind: 'wander' };
    t.target = null;
    t.detour = null;
    t.nextWanderAt = state.now + MINOTAUR.wanderInterval;
    t.stuckStreak = 0;
    t.stuckSampleCell = t.cell;
    return true;
  }
  return false;
}

// Demons pace slowly up and down their patrol band. While a soul is mid-parlay
// (busyWith set) they stand still and face the speaker. Any ghost commanded to
// parlay (parlayDemonId === this demon) is steered toward the demon's live
// position; the conversation opens — and main.ts freezes the world to run it —
// once the ghost is within DEMON.parlayRadius. Only one soul may speak at once.
function updateDemon(state: GameState, d: Demon) {
  // Drop a stale lock if the soul vanished (drifted off-screen, resurrected).
  if (d.busyWith !== null && !state.ghosts.some((g) => g.id === d.busyWith)) {
    d.busyWith = null;
  }
  if (d.busyWith !== null) {
    const g = state.ghosts.find((x) => x.id === d.busyWith);
    if (g && g.hx !== undefined && g.hy !== undefined) {
      d.facing = Math.atan2(g.hy - d.hy, g.hx - d.hx);
    }
    return;
  }
  // Demons stand still by default now, each holding its own dev-tunable
  // facing (R faces left, L faces right — the pair eye each other across the
  // abyss; Lolly faces up-left into her corner) and its own dev-tunable
  // standing hell-y. The dev "walks" toggle resumes the old slow vertical
  // patrol for all of them. A live parlay still turns the demon toward the
  // speaker (handled above).
  const o = getOptions();
  if (o.demonWalks) {
    d.hy += d.dir * DEMON.speed * o.demonWalkSpeed * TICK_S;
    if (d.hy >= d.y1) { d.hy = d.y1; d.dir = -1; }
    else if (d.hy <= d.y0) { d.hy = d.y0; d.dir = 1; }
    d.facing = d.dir > 0 ? Math.PI / 2 : -Math.PI / 2;
  } else if (d.variant === 'l' && d.pacing) {
    // Lilly's attention-seeking pace: a tight vertical back-and-forth around
    // her standing spot (demonLX/Y), brisker than the dev patrol. Runs until
    // Bob next parlays with her (clears d.pacing in demon-dialogue). Her
    // standing X is held; only the Y oscillates so she stays in her lane.
    d.hx = o.demonLX;
    const scale = demonScaleOf(d);
    const lo = o.demonLY - DEMON.pacingHalf * scale;
    const hi = o.demonLY + DEMON.pacingHalf * scale;
    d.hy += d.dir * DEMON.pacingSpeed * TICK_S;
    if (d.hy >= hi) { d.hy = hi; d.dir = -1; }
    else if (d.hy <= lo) { d.hy = lo; d.dir = 1; }
    d.facing = d.dir > 0 ? Math.PI / 2 : -Math.PI / 2;
  } else {
    const variant = d.variant ?? 'pit';
    const facing = variant === 'l' ? o.demonLFacing
      : variant === 'friend' ? o.demonFriendFacing
      : o.demonFacing;
    d.facing = DEMON_FACING_ANGLE[facing];
    d.hx = variant === 'l' ? o.demonLX
      : variant === 'friend' ? o.demonFriendX
      : o.demonRX;
    d.hy = variant === 'l' ? o.demonLY
      : variant === 'friend' ? o.demonFriendY
      : o.demonRY;
  }
  // Steer any approaching soul and open a parlay once one is close enough.
  for (const g of state.ghosts) {
    if (g.parlayDemonId !== d.id) continue;
    if (g.hx === undefined || g.hy === undefined) continue;
    g.goal = { x: d.hx, y: d.hy };
    if (Math.hypot(g.hx - d.hx, g.hy - d.hy) <= DEMON.parlayRadius * demonScaleOf(d)) {
      d.busyWith = g.id;
      g.parlayDemonId = undefined;
      g.goal = undefined;
      d.facing = Math.atan2(g.hy - d.hy, g.hx - d.hx);
      break;
    }
  }
}

// ─── Bob & Lolly's quiet exit ───────────────────────────────────────
// Once Bob has worked through all three of his hell beats — heard Lolly's
// corner conversation through to "tell the others we talked of golf", been
// handed Lilly's optional Work, and completed demon R's 5-bone trade at least
// once — he and Lolly slip out of hell together. The vanishing is never shown:
// they only go while both are off screen (or the player isn't looking at hell
// at all), so the player simply finds the corner empty. Sticky — they stay
// gone until the Pain Gabbonsaw ritual reunites them on the overworld
// (spawnLollyRampage). Called every frame from main.ts with the hell-coord
// rect currently visible, or null when the hell scene isn't on screen.
export function maybeDepartBobAndLolly(
  state: GameState,
  visible: { x0: number; y0: number; x1: number; y1: number } | null,
): void {
  if (state.bobLollyDeparted || state.gabbonsawBought) return;
  const demons = [...state.demons.values()];
  const lolly = demons.find((d) => d.variant === 'friend');
  if (!lolly?.toldOfGolf) return;
  if (!state.lillyTasksGiven) return;
  if (!demons.some((d) => (d.variant ?? 'pit') === 'pit' && d.boneGiftGiven)) return;
  const bob = state.ghosts.find((g) => g.bob);
  // Never vanish anyone mid-engagement: Lolly locked in (or awaiting) a
  // parlay, or Bob walking under a live command / holding a conversation.
  if (lolly.busyWith !== null) return;
  if (bob !== undefined) {
    if (bob.parlayDemonId !== undefined || bob.chatTargetId !== undefined
        || bob.targetChairId !== undefined || bob.goal !== undefined) return;
    if (demons.some((d) => d.busyWith === bob.id)) return;
  }
  // Off-screen check. Margins are generous half-sprite reaches so neither can
  // pop out while a sliver of them is still in view.
  const offScreen = (hx: number, hy: number, margin: number): boolean =>
    visible === null
    || hx < visible.x0 - margin || hx > visible.x1 + margin
    || hy < visible.y0 - margin || hy > visible.y1 + margin;
  if (!offScreen(lolly.hx, lolly.hy, DEMON.displayPx * demonScaleOf(lolly))) return;
  if (bob !== undefined) {
    // A Bob hidden by the untruth strike is off screen by definition.
    const hidden = bob.respawnAt !== undefined && state.now < bob.respawnAt;
    // Bob's hell position: his commanded hx/hy when set, otherwise his death
    // spot mapped into hell space (he never drifts — see recordGhost).
    const hx = bob.hx ?? bob.x + (HELL.width - WORLD.width) / 2;
    const hy = bob.hy ?? bob.y + (HELL.height - WORLD.height) / 2;
    if (!hidden && !offScreen(hx, hy, HELL.bobPaceRange + 60)) return;
  }
  // Both unseen — they go. No log line: the disappearance is meant to be
  // discovered, not announced.
  state.bobLollyDeparted = true;
  state.demons.delete(lolly.id);
  state.ghosts = state.ghosts.filter((g) => !g.bob);
}

// ─── Lolly's rampage ────────────────────────────────────────────────
// The Pain Gabbonsaw ritual's payoff: Lolly arrives on the overworld with
// Bob riding on top. She works like a Minotaur — walk to the nearest prey,
// wind up, smash — except she's colossal, grid-free (straight lines over
// walls, water, anything), and her prey list is everything: every building
// (Goblin Holes included — even the original spawning hole, which nothing
// else in the game can touch), every goblin, robot, and minotaur. Kills pay
// nothing — this is a calamity, not a harvest. Once nothing is left she
// wanders the ruins.

// Spawn Lolly at the right edge of the play area — she arrives from outside
// the world and marches in on the colony (the original Goblin Hole is still
// her likely first target; it's just a walk away now).
// Bob leaves wherever he currently is — alive on the ground, a soul in hell,
// even adrift in space — to take his seat on her shoulders. Returns the
// spawn point so the caller can swing the camera onto it.
export function spawnLollyRampage(state: GameState): Vec2 {
  for (const g of [...state.goblins.values()]) {
    if (g.bob) removeGoblin(state, g.id);
  }
  state.ghosts = state.ghosts.filter((g) => !g.bob);
  for (const [id, su] of [...state.spaceUnits]) {
    if (su.bob) state.spaceUnits.delete(id);
  }
  const pa = state.playArea;
  const c = {
    x: Math.min(WORLD.width - CELL * 2, pa.x1 * CELL - CELL),
    y: ((pa.y0 + pa.y1) / 2) * CELL,
  };
  state.lolly = {
    pos: { x: c.x, y: c.y },
    facing: Math.PI / 2,
    target: null,
    nextWanderAt: 0,
    spawnAt: state.now,
  };
  // An arrival worthy of a demon: bolts from a clear sky and a blood-flash.
  pushLightningBolt(state, c.x, c.y);
  pushLightningBolt(state, c.x - CELL * 2, c.y + CELL);
  pushLightningBolt(state, c.x + CELL * 2, c.y - CELL);
  pushDeathEffect(state, c.x, c.y);
  playSound('ritual', 1, 0.35);
  playSound('destroy', 0.8, 0.45);
  appendLog(state, 'Lolly has come to the overworld. Bob rides upon her shoulders.');
  return c;
}

// What Lolly bears down on next, in her rampage's priority order:
//   1. While she's crushed fewer than two buildings, the nearest building
//      (any kind) — her opening statement.
//   2. Then every spawn hole: the original Goblin Hole plus every Goblin
//      Hole building, nearest first — she cuts off the reinforcements.
//   3. Then the default scour: whatever's closest — buildings, the hole,
//      goblins (robots aren't spared — nothing is), minotaurs.
// Null once the overworld is picked clean.
function acquireLollyTarget(state: GameState, pos: Vec2, buildingsSmashed: number): LollyTarget | null {
  let best: LollyTarget | null = null;
  let bestD = Infinity;
  const consider = (t: LollyTarget, x: number, y: number) => {
    const dx = x - pos.x, dy = y - pos.y;
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = t; }
  };
  const considerBuildings = () => {
    for (const b of state.buildings.values()) {
      const c = buildingCenter(b);
      consider({ kind: 'building', id: b.id }, c.x, c.y);
    }
  };
  // Phase 1 — the two nearest buildings. Falls straight through when the
  // overworld doesn't have any left to offer.
  if (buildingsSmashed < 2) {
    considerBuildings();
    if (best) return best;
  }
  // Phase 2 — every spawn hole, original first among equals.
  for (const b of state.buildings.values()) {
    if (b.kind !== 'goblin_hole') continue;
    const c = buildingCenter(b);
    consider({ kind: 'building', id: b.id }, c.x, c.y);
  }
  if (!state.holeDestroyed) {
    const c = holeCenter(state);
    consider({ kind: 'hole' }, c.x, c.y);
  }
  if (best) return best;
  // Phase 3 — everything else, nearest first.
  considerBuildings();
  for (const g of state.goblins.values()) consider({ kind: 'goblin', id: g.id }, g.pos.x, g.pos.y);
  for (const m of state.minotaurs.values()) consider({ kind: 'minotaur', id: m.id }, m.pos.x, m.pos.y);
  return best;
}

// Resolve a target's live position + smashing reach (bigger footprints are
// in range from further out). Null when the target no longer exists.
function lollyTargetSpot(state: GameState, t: LollyTarget): { x: number; y: number; reach: number } | null {
  if (t.kind === 'building') {
    const b = state.buildings.get(t.id);
    if (!b) return null;
    const c = buildingCenter(b);
    return { x: c.x, y: c.y, reach: LOLLY.reach + defOf(b).size / 2 };
  }
  if (t.kind === 'hole') {
    if (state.holeDestroyed) return null;
    const c = holeCenter(state);
    return { x: c.x, y: c.y, reach: LOLLY.reach + CELL / 2 };
  }
  if (t.kind === 'goblin') {
    const g = state.goblins.get(t.id);
    return g ? { x: g.pos.x, y: g.pos.y, reach: LOLLY.reach } : null;
  }
  const m = state.minotaurs.get(t.id);
  return m ? { x: m.pos.x, y: m.pos.y, reach: LOLLY.reach } : null;
}

// Land the smash. No rewards anywhere — the world simply gets smaller.
function lollySmash(state: GameState, t: LollyTarget): void {
  if (t.kind === 'building') {
    const b = state.buildings.get(t.id);
    if (!b) return;
    const c = buildingCenter(b);
    appendLog(state, `Lolly crushes ${defOf(b).name} #${b.displayNum}.`);
    pushDeathEffect(state, c.x, c.y);
    destroyBuilding(state, b.id);
    playSound('destroy', 0.55);
    return;
  }
  if (t.kind === 'hole') {
    const c = holeCenter(state);
    state.holeDestroyed = true;
    state.hole.selected = false;
    pushDeathEffect(state, c.x, c.y);
    playSound('destroy', 0.7, 0.6);
    appendLog(state, 'Lolly tears the Goblin Hole out of the earth.');
    return;
  }
  if (t.kind === 'goblin') {
    const g = state.goblins.get(t.id);
    if (!g) return;
    const x = g.pos.x, y = g.pos.y;
    if (g.robot) {
      // Even the indestructible chassis comes apart in her hands. No soul —
      // but it still counts toward Lilly's "Destroy a robot" Work.
      state.robotsDestroyed++;
      appendLog(state, `${g.terminator ? 'Terminator' : 'Robot'} #${g.id} torn apart by Lolly.`);
    } else {
      recordGhost(state, 'goblin', x, y, g.facing, { gold: g.gold });
      appendLog(state, `Goblin #${g.id} devoured by Lolly.`);
    }
    removeGoblin(state, g.id);
    pushDeathEffect(state, x, y);
    playDecayingGoblinDeath();
    return;
  }
  const m = state.minotaurs.get(t.id);
  if (!m) return;
  recordGhost(state, 'minotaur', m.pos.x, m.pos.y, m.facing, { tiny: m.tiny });
  state.minotaurs.delete(m.id);
  pushDeathEffect(state, m.pos.x, m.pos.y);
  playSound('goblin_death', 0.56, 0.3);
  appendLog(state, `Minotaur #${m.id} devoured by Lolly.`);
}

// Feed Lolly a speed surge: a lightning hit (blue, ~10s) or reactor fallout
// (green, bigger, ~30s). Stacks on any boost already running, throws up its
// "speed up!" floaters (one for lightning, three for the meltdown), and chimes.
function applyLollyBoost(state: GameState, kind: LollyBoostKind): void {
  const L = state.lolly;
  if (!L) return;
  const cfg = LOLLY_BOOST[kind];
  (L.boosts ??= []).push({ kind, start: state.now, duration: cfg.duration, peak: cfg.peak });
  // Floaters ride above her head (x/y are offsets from her live position — see
  // followLolly), stacked so several "speed up!"s read as a burst as she moves.
  for (let i = 0; i < cfg.floaters; i++) {
    pushFloater(state, 0, -LOLLY.displayPx * 0.62 - i * 26, 'speed up!', cfg.floaterColor, 1.7 + i * 0.25, undefined, false, false, undefined, true);
  }
  playSound('online', 0.6, kind === 'nuclear' ? 1.3 : 1.0);
  appendLog(state, kind === 'lightning'
    ? 'Lolly drinks the lightning — she only gets faster.'
    : 'The fallout supercharges Lolly — faster still.');
}

function updateLolly(state: GameState): void {
  const L = state.lolly;
  if (!L) return;
  // Drop any boosts that have fully decayed, then read the live speed surge.
  if (L.boosts && L.boosts.length > 0) {
    L.boosts = L.boosts.filter((b) => state.now - b.start < b.duration);
    if (L.boosts.length === 0) L.boosts = undefined;
  }
  const speedMult = lollyBoostState(L, state.now).speedMult;
  const speed = LOLLY.speed * speedMult;
  // Re-validate the current target (it may have died, been destroyed, or —
  // for a unit — moved); re-acquire when it's gone.
  let spot = L.target ? lollyTargetSpot(state, L.target) : null;
  if (!spot) {
    L.target = acquireLollyTarget(state, L.pos, L.buildingsSmashed ?? 0);
    L.attackAt = undefined;
    spot = L.target ? lollyTargetSpot(state, L.target) : null;
  }
  if (spot && L.target) {
    const dx = spot.x - L.pos.x;
    const dy = spot.y - L.pos.y;
    const d = Math.hypot(dx, dy);
    if (d <= spot.reach) {
      // Windup → smash, same beat as a Minotaur's — and a surge shortens it too.
      if (L.attackAt === undefined) {
        L.attackAt = state.now + LOLLY.attackWindup / speedMult;
        if (d > 1e-3) L.facing = Math.atan2(dy, dx);
        return;
      }
      if (state.now < L.attackAt) return;
      L.attackAt = undefined;
      if (L.target.kind === 'building') {
        L.buildingsSmashed = (L.buildingsSmashed ?? 0) + 1;
      }
      lollySmash(state, L.target);
      L.target = null;
      return;
    }
    L.attackAt = undefined;
    const step = speed * TICK_S;
    L.pos.x += (dx / d) * step;
    L.pos.y += (dy / d) * step;
    L.facing = Math.atan2(dy, dx);
    return;
  }
  // Nothing left to destroy — the overworld is scoured bare. This is the cue
  // for the finale: Lolly calls down a dragon and the cinematic takes over
  // (after which this function is no longer called — see tick).
  if (startFinale(state)) return;
  // Defensive: if the finale somehow couldn't start, she wanders the ruins.
  if (!L.wanderGoal || state.now >= L.nextWanderAt) {
    const pa = state.playArea;
    L.wanderGoal = {
      x: (pa.x0 + Math.random() * (pa.x1 - pa.x0)) * CELL,
      y: (pa.y0 + Math.random() * (pa.y1 - pa.y0)) * CELL,
    };
    L.nextWanderAt = state.now + LOLLY.wanderInterval + Math.random() * LOLLY.wanderInterval;
  }
  const dx = L.wanderGoal.x - L.pos.x;
  const dy = L.wanderGoal.y - L.pos.y;
  const d = Math.hypot(dx, dy);
  if (d < LOLLY.reach) {
    L.wanderGoal = undefined;
    return;
  }
  const step = speed * 0.5 * TICK_S; // an unhurried victory lap (still boostable)
  L.pos.x += (dx / d) * step;
  L.pos.y += (dy / d) * step;
  L.facing = Math.atan2(dy, dx);
}

// ─── The finale ─────────────────────────────────────────────────────
// Kicked off the instant Lolly has nothing left on the overworld to smash. She
// calls down a dragon, mounts it, climbs to space to wreck what the player
// stashed up there (sparing the dragons — there's nothing else of theirs left),
// hoists the moon, and rides back down, leaving Bob behind on the ground. The
// confrontation that follows — the moon-eating demand, Bob's refusal, the
// shattering — is driven by main.ts, which owns the modal and the screen
// effects; this runs only the scripted world up to that hand-off (confrontReady).

// Centre of the play area, in world px.
function playAreaCentre(state: GameState): Vec2 {
  const pa = state.playArea;
  return { x: ((pa.x0 + pa.x1) / 2) * CELL, y: ((pa.y0 + pa.y1) / 2) * CELL };
}

// Step `p` toward `goal` at `speed` px/sec, snapping on once within reach.
// Returns whether it arrived and the heading travelled (radians).
function stepToward(p: Vec2, goal: Vec2, speed: number, arrive: number): { arrived: boolean; facing: number } {
  const dx = goal.x - p.x, dy = goal.y - p.y;
  const d = Math.hypot(dx, dy);
  const facing = d > 1e-3 ? Math.atan2(dy, dx) : 0;
  const step = speed * TICK_S;
  if (d <= Math.max(arrive, step)) {
    p.x = goal.x; p.y = goal.y;
    return { arrived: true, facing };
  }
  p.x += (dx / d) * step;
  p.y += (dy / d) * step;
  return { arrived: false, facing };
}

// Begin the finale, lifting Lolly's live rampage position into the cinematic.
// Returns true once it's running (idempotent). The moon has hung in space
// since the start of the run (state.moon) — it's already there waiting when
// the player rises to watch.
function startFinale(state: GameState): boolean {
  if (state.finale) return true;
  const L = state.lolly;
  if (!L) return false;
  state.finale = {
    phase: 'summon',
    phaseStartedAt: state.now,
    lollyPos: { x: L.pos.x, y: L.pos.y },
    lollyFacing: L.facing,
    scene: 'ground',
    dragonShown: false,
    // Bob slides off her shoulders to just beside her feet.
    bobPos: { x: L.pos.x - 64, y: L.pos.y + 40 },
    bobFacing: Math.PI / 2,
    bobAtCentre: false,
    target: null,
    confrontReady: false,
  };
  // She's bound for space whether or not the player ever sent a building up —
  // unlock the climb so they can always follow her to watch.
  state.spaceUnlocked = true;
  pushLightningBolt(state, L.pos.x, L.pos.y - LOLLY.displayPx * 0.5);
  playSound('ritual', 1, 0.3);
  appendLog(state, 'The overworld is bare. Lolly calls down a dragon and lifts her eyes to the sky.');
  return true;
}

// Dev pacing dial: a tester can run the whole cinematic fast. Clamped so it
// can never stall (0) or run backwards.
function finaleSpeed(): number {
  return Math.max(0.1, getOptions().finaleSpeedMult);
}

// Dev cheat: scour the overworld, loose Lolly, and start the finale right now —
// from whatever point the game is at. Resets any in-flight finale first.
export function devTriggerFinale(state: GameState): void {
  for (const b of [...state.buildings.values()]) destroyBuilding(state, b.id);
  for (const g of [...state.goblins.values()]) removeGoblin(state, g.id);
  state.minotaurs.clear();
  state.holeDestroyed = true;
  const c = playAreaCentre(state);
  state.lolly = { pos: { x: c.x, y: c.y }, facing: Math.PI / 2, target: null, nextWanderAt: 0, spawnAt: state.now };
  state.finale = null;
  // A re-triggered cinematic needs a moon back in the sky (the previous run
  // may have shattered it).
  state.moon = createMoon();
  startFinale(state);
}

// Dev cheat: jump straight to the moon confrontation — Lolly a hair out from her
// landing spot with the moon in hand, so she sets down and the modal fires within
// a tick or two.
export function devSkipFinaleToConfront(state: GameState): void {
  devTriggerFinale(state);
  const F = state.finale;
  if (!F) return;
  const c = playAreaCentre(state);
  F.scene = 'ground';
  F.dragonShown = true;
  F.bobPos = { x: c.x, y: c.y };
  F.bobFacing = Math.PI / 2;
  F.bobAtCentre = true;
  F.lollyPos = { x: c.x + FINALE.landGap + 30, y: c.y };
  F.lollyFacing = Math.PI;
  state.moon.state = 'grabbed';
  state.moon.scene = 'ground';
  state.moon.selected = false;
  F.phase = 'lolly_descends';
  F.phaseStartedAt = state.now;
}

function updateFinale(state: GameState): void {
  const F = state.finale;
  if (!F) return;
  // Bob's own thread: once she's airborne he trudges to the middle of the play
  // area and turns to face the player, then holds there.
  updateFinaleBob(state, F);

  const spd = finaleSpeed();
  const elapsed = (state.now - F.phaseStartedAt) * spd;
  const enter = (phase: FinalePhase) => { F.phase = phase; F.phaseStartedAt = state.now; };

  switch (F.phase) {
    case 'summon': {
      F.dragonShown = true;       // the dragon is in the sky (render swoops it in)
      if (elapsed >= FINALE.summonHold) enter('lolly_ascends');
      return;
    }
    case 'lolly_ascends': {
      F.lollyFacing = -Math.PI / 2;
      F.lollyPos.y -= FINALE.flySpeed * spd * TICK_S;
      if (F.lollyPos.y <= state.playArea.y0 * CELL - FINALE.edgeOffset) {
        // Cross into the orbit scene, entering from above the top edge.
        F.scene = 'space';
        F.lollyPos = { x: SPACE.width * 0.5, y: -FINALE.edgeOffset };
        enter('space_rampage');
      }
      return;
    }
    case 'space_rampage': {
      finaleSpaceRampage(state, F);
      return;
    }
    case 'grab_moon': {
      finaleGrabMoon(state, F);
      return;
    }
    case 'lolly_descends': {
      F.lollyFacing = Math.PI / 2;
      if (F.scene === 'space') {
        F.lollyPos.y += FINALE.flySpeed * spd * TICK_S;
        if (F.lollyPos.y >= SPACE.height + FINALE.edgeOffset) {
          // Re-enter the overworld from above the centre, the moon still hers.
          F.scene = 'ground';
          F.lollyPos = { x: playAreaCentre(state).x, y: state.playArea.y0 * CELL - FINALE.edgeOffset };
          state.moon.scene = 'ground';
        }
      } else {
        // Settle just to the side of Bob, facing him across the centre.
        const c = playAreaCentre(state);
        const r = stepToward(F.lollyPos, { x: c.x + FINALE.landGap, y: c.y }, FINALE.flySpeed * 0.7 * spd, 6);
        F.lollyFacing = Math.PI;
        if (r.arrived) {
          F.dragonShown = false;     // she dismounts; the dragon wheels away (render)
          // She sets the moon down on the ground between herself and Bob — her
          // offering, there for the taking (or the breaking).
          state.moon.scene = 'ground';
          state.moon.state = 'placed';
          // Down on the ground midway between them, dropped toward the camera
          // so it rests in the foreground rather than over her torso.
          state.moon.pos = { x: (F.lollyPos.x + F.bobPos.x) / 2, y: (F.lollyPos.y + F.bobPos.y) / 2 + 78 };
          F.confrontReady = true;    // hand the modal to main.ts
          enter('confront');
        }
      }
      return;
    }
    case 'confront':
    case 'shattered':
      // main.ts (the modal) and the renderer (the shatter) drive these. Hold.
      return;
  }
}

// Bob, dismounted: holds at Lolly's side through the summon beat, then walks to
// the centre and turns to the player, holding there for the rest of the show.
function updateFinaleBob(state: GameState, F: Finale): void {
  if (F.phase === 'summon' || F.phase === 'confront' || F.phase === 'shattered') return;
  if (F.bobAtCentre) { F.bobFacing = Math.PI / 2; return; }
  const r = stepToward(F.bobPos, playAreaCentre(state), FINALE.bobWalkSpeed * finaleSpeed(), 4);
  if (r.arrived) { F.bobAtCentre = true; F.bobFacing = Math.PI / 2; }
  else F.bobFacing = r.facing;
}

// Nearest thing Lolly can still wreck in orbit: a floating building or a unit
// adrift. Dragons are decorative here and never targeted.
function acquireFinaleSpaceTarget(state: GameState, pos: Vec2): Finale['target'] {
  let best: Finale['target'] = null;
  let bestD = Infinity;
  const consider = (kind: 'building' | 'unit', id: number, x: number, y: number) => {
    const dx = x - pos.x, dy = y - pos.y, d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = { kind, id }; }
  };
  for (const sb of state.spaceBuildings.values()) consider('building', sb.id, sb.pos.x, sb.pos.y);
  for (const su of state.spaceUnits.values()) consider('unit', su.id, su.pos.x, su.pos.y);
  return best;
}

function finaleTargetSpot(state: GameState, t: NonNullable<Finale['target']>): Vec2 | null {
  if (t.kind === 'building') { const sb = state.spaceBuildings.get(t.id); return sb ? { x: sb.pos.x, y: sb.pos.y } : null; }
  const su = state.spaceUnits.get(t.id);
  return su ? { x: su.pos.x, y: su.pos.y } : null;
}

function finaleSpaceSmash(state: GameState, t: NonNullable<Finale['target']>): void {
  if (t.kind === 'building') {
    const sb = state.spaceBuildings.get(t.id);
    if (!sb) return;
    pushDeathEffect(state, sb.pos.x, sb.pos.y, false, false, true);
    state.spaceBuildings.delete(t.id);
    appendLog(state, `Lolly crushes ${defOf(sb.building).name} #${sb.building.displayNum} out of the sky.`);
    playSound('destroy', 0.55);
    return;
  }
  const su = state.spaceUnits.get(t.id);
  if (!su) return;
  pushDeathEffect(state, su.pos.x, su.pos.y, false, false, true);
  state.spaceUnits.delete(t.id);
  playSound('goblin_death', 0.5, 0.3);
}

function finaleSpaceRampage(state: GameState, F: Finale): void {
  const spd = finaleSpeed();
  let spot = F.target ? finaleTargetSpot(state, F.target) : null;
  if (!spot) {
    F.target = acquireFinaleSpaceTarget(state, F.lollyPos);
    F.attackAt = undefined;
    spot = F.target ? finaleTargetSpot(state, F.target) : null;
  }
  if (spot && F.target) {
    const dx = spot.x - F.lollyPos.x, dy = spot.y - F.lollyPos.y;
    const d = Math.hypot(dx, dy);
    if (d <= FINALE.smashReach) {
      if (F.attackAt === undefined) {
        F.attackAt = state.now + FINALE.smashWindup / spd;
        if (d > 1e-3) F.lollyFacing = Math.atan2(dy, dx);
        return;
      }
      if (state.now < F.attackAt) return;
      F.attackAt = undefined;
      finaleSpaceSmash(state, F.target);
      F.target = null;
      return;
    }
    F.attackAt = undefined;
    const step = FINALE.flySpeed * spd * TICK_S;
    F.lollyPos.x += (dx / d) * step;
    F.lollyPos.y += (dy / d) * step;
    F.lollyFacing = Math.atan2(dy, dx);
    return;
  }
  // Orbit is swept clean — go take the moon.
  F.target = null;
  F.phase = 'grab_moon';
  F.phaseStartedAt = state.now;
}

function finaleGrabMoon(state: GameState, F: Finale): void {
  const spd = finaleSpeed();
  const m = state.moon;
  const dx = m.pos.x - F.lollyPos.x, dy = m.pos.y - F.lollyPos.y;
  const d = Math.hypot(dx, dy);
  if (d > FINALE.moonGrabDist) {
    const step = FINALE.flySpeed * spd * TICK_S;
    F.lollyPos.x += (dx / d) * step;
    F.lollyPos.y += (dy / d) * step;
    F.lollyFacing = Math.atan2(dy, dx);
    F.grabHoverUntil = undefined;
    return;
  }
  // In reach — hover a beat of menace, then hoist it onto her shoulder.
  if (F.grabHoverUntil === undefined) { F.grabHoverUntil = state.now + FINALE.moonGrabHover / spd; playSound('ritual', 0.7, 0.5); return; }
  if (state.now < F.grabHoverUntil) return;
  m.state = 'grabbed';
  m.selected = false;     // no inspecting what's no longer in the sky
  appendLog(state, 'Lolly tears the moon down from the sky.');
  playSound('destroy', 0.7, 0.4);
  F.phase = 'lolly_descends';
  F.phaseStartedAt = state.now;
}

function updateMinotaur(state: GameState, t: Minotaur, autoTargets: Map<number, number>) {
  // Tinytaurs move and attack much faster; everything else is shared.
  const speed = t.tiny ? TINYTAUR.speed : MINOTAUR.speed;
  const windup = t.tiny ? TINYTAUR.attackWindup : MINOTAUR.attackWindup;
  // Mid-step pixel lerp (shared with goblin movement model).
  if (t.target) {
    const tc = cellCenter(t.target);
    const dx = tc.x - t.pos.x;
    const dy = tc.y - t.pos.y;
    const d = Math.hypot(dx, dy);
    const step = speed * TICK_S;
    if (d <= step + MINOTAUR.arriveDist) {
      t.cell = t.target;
      t.pos = tc;
      t.target = null;
    } else {
      t.pos.x += (dx / d) * step;
      t.pos.y += (dy / d) * step;
      t.facing = Math.atan2(dy, dx);
      return;
    }
  }

  if (applyMinotaurStuckCheck(state, t)) return;

  // Player-issued commands take priority over auto-targeting.
  if (t.state.kind === 'moving_to') {
    const goal = t.state.goal;
    if (t.cell.cx === goal.cx && t.cell.cy === goal.cy) {
      t.state = { kind: 'wander' };
      t.nextWanderAt = state.now + MINOTAUR.wanderInterval;
      return;
    }
    // Tag in negative space so a goal-cell key can never collide with an
    // entity id used as a tag by the kill pursuits.
    const next = minotaurStepToward(state, t, goal, -1 - nkey(goal.cx, goal.cy));
    if (next) {
      t.target = next;
      t.facing = Math.atan2(next.cy - t.cell.cy, next.cx - t.cell.cx);
    } else {
      // Boxed in — give up the order and resume normal behavior next tick.
      t.state = { kind: 'wander' };
      t.nextWanderAt = state.now + MINOTAUR.wanderInterval;
    }
    return;
  }

  if (t.state.kind === 'going_to_destroy') {
    const b = state.buildings.get(t.state.buildingId);
    if (!b) {
      t.state = { kind: 'wander' };
      t.nextWanderAt = state.now + MINOTAUR.wanderInterval;
      return;
    }
    const s = t.state;
    if (chebyshevToBuilding(t.cell, b) <= 1) {
      if (s.attackAt === undefined) {
        const c = buildingCenter(b);
        s.attackAt = state.now + windup;
        t.facing = Math.atan2(c.y - t.pos.y, c.x - t.pos.x);
        return;
      }
      if (state.now < s.attackAt) return;
      const c = buildingCenter(b);
      const def = defOf(b);
      appendLog(state, `Minotaur #${t.id} smashes ${def.name} #${b.displayNum}.`);
      pushDeathEffect(state, c.x, c.y);
      destroyBuilding(state, b.id);
      playSound('destroy', 0.5);
      t.state = { kind: 'wander' };
      t.nextWanderAt = state.now + MINOTAUR.wanderInterval;
      return;
    }
    const next = minotaurStepTowardBuilding(state, t, b);
    if (next) {
      t.target = next;
      t.facing = Math.atan2(next.cy - t.cell.cy, next.cx - t.cell.cx);
    }
    return;
  }

  if (t.state.kind === 'going_to_kill_lolly') {
    // Commanded onto rampaging Lolly: charge, gore — and bounce. The swipe
    // plays, a 'no effect' floater rides over her head, nothing changes.
    const L = state.finale ? null : state.lolly;
    if (!L) {
      t.state = { kind: 'wander' };
      t.nextWanderAt = state.now + MINOTAUR.wanderInterval;
      return;
    }
    const s = t.state;
    const lc = { cx: Math.floor(L.pos.x / CELL), cy: Math.floor(L.pos.y / CELL) };
    const cdx = Math.abs(lc.cx - t.cell.cx);
    const cdy = Math.abs(lc.cy - t.cell.cy);
    // Her bulk: goring range from a couple of cells out.
    if (Math.max(cdx, cdy) <= 2) {
      if (s.attackAt === undefined) {
        s.attackAt = state.now + windup;
        t.facing = Math.atan2(L.pos.y - t.pos.y, L.pos.x - t.pos.x);
        return;
      }
      if (state.now < s.attackAt) return;
      lollyNoEffectFlash(state);
      t.state = { kind: 'wander' };
      t.nextWanderAt = state.now + MINOTAUR.wanderInterval;
      return;
    }
    s.attackAt = undefined;
    const next = minotaurStepToward(state, t, lc, -1);
    if (next) {
      t.target = next;
      t.facing = Math.atan2(next.cy - t.cell.cy, next.cx - t.cell.cx);
    }
    return;
  }

  if (t.state.kind === 'going_to_kill_minotaur') {
    const target = state.minotaurs.get(t.state.targetId);
    if (!target || target.id === t.id) {
      t.state = { kind: 'wander' };
      t.nextWanderAt = state.now + MINOTAUR.wanderInterval;
      return;
    }
    const s = t.state;
    const cdx = Math.abs(target.cell.cx - t.cell.cx);
    const cdy = Math.abs(target.cell.cy - t.cell.cy);
    if (Math.max(cdx, cdy) <= 1) {
      if (s.attackAt === undefined) {
        s.attackAt = state.now + windup;
        t.facing = Math.atan2(target.pos.y - t.pos.y, target.pos.x - t.pos.x);
        return;
      }
      if (state.now < s.attackAt) return;
      const tx = target.pos.x, ty = target.pos.y;
      recordGhost(state, 'minotaur', tx, ty, target.facing, { tiny: target.tiny });
      state.minotaurs.delete(target.id);
      earnMoney(state, MINOTAUR_KILL_REWARD.money);
      earnBlood(state, MINOTAUR_KILL_REWARD.blood);
      state.bloodUnlocked = true;
      pushFloater(state, tx, ty, `+Ƶ${MINOTAUR_KILL_REWARD.money.toLocaleString('en-US')}`, 0xffd96b, 1.6);
      pushFloater(state, tx, ty - 14, `+${MINOTAUR_KILL_REWARD.blood} blood`, 0xff8a8a, 1.6);
      pushDeathEffect(state, tx, ty);
      playSound('goblin_death', 0.56, 0.3);
      appendLog(state, `Minotaur #${target.id} gored by Minotaur #${t.id}.`);
      t.state = { kind: 'wander' };
      t.nextWanderAt = state.now + MINOTAUR.wanderInterval;
      return;
    }
    const next = minotaurStepToward(state, t, target.cell, target.id);
    if (next) {
      t.target = next;
      t.facing = Math.atan2(next.cy - t.cell.cy, next.cx - t.cell.cx);
    }
    return;
  }

  // A player-commanded kill (manual) keeps its prey; otherwise take whatever
  // goblin the auto-targeter matched this minotaur with.
  let target: Goblin | null = null;
  if (t.state.kind === 'going_to_kill' && t.state.manual) {
    target = state.goblins.get(t.state.targetId) ?? null;
  } else {
    const assignedId = autoTargets.get(t.id);
    target = assignedId !== undefined ? (state.goblins.get(assignedId) ?? null) : null;
  }
  if (target) {
    if (t.state.kind !== 'going_to_kill' || t.state.targetId !== target.id) {
      t.state = { kind: 'going_to_kill', targetId: target.id };
    }
    const s = t.state;
    const cdx = Math.abs(target.cell.cx - t.cell.cx);
    const cdy = Math.abs(target.cell.cy - t.cell.cy);
    if (Math.max(cdx, cdy) <= 1) {
      // Windup → kill.
      if (s.attackAt === undefined) {
        s.attackAt = state.now + windup;
        t.facing = Math.atan2(target.pos.y - t.pos.y, target.pos.x - t.pos.x);
        return;
      }
      if (state.now < s.attackAt) return;
      // A robot soaks the gore: "immune" floater, no kill, back to wandering.
      if (target.robot) {
        robotImmuneFlash(state, target);
        appendLog(state, `${t.tiny ? 'Tinytaur' : 'Minotaur'} #${t.id}'s horns glance off ${target.terminator ? 'Terminator' : 'Robot'} #${target.id}.`);
        t.state = { kind: 'wander' };
        t.nextWanderAt = state.now + MINOTAUR.wanderInterval;
        return;
      }
      const tx = target.pos.x, ty = target.pos.y;
      const reward = goblinKillReward(state, target);
      const wasGold = !!target.gold;
      recordGhost(state, 'goblin', tx, ty, target.facing, { gold: target.gold, bob: target.bob });
      removeGoblin(state, target.id);
      earnMoney(state, reward.money);
      earnBlood(state, reward.blood);
      state.bloodUnlocked = true;
      pushFloater(state, tx, ty, `+Ƶ${reward.money.toLocaleString('en-US')}`, 0xffd96b, 1.6);
      pushFloater(state, tx, ty - 14, `+${reward.blood} blood`, 0xff8a8a, 1.6);
      pushDeathEffect(state, tx, ty);
      playDecayingGoblinDeath();
      if (wasGold) playDecayingGoldKillCash();
      appendLog(state, `Goblin #${target.id} ${t.tiny ? 'gored by Tinytaur' : 'killed by Minotaur'} #${t.id}.`);
      t.state = { kind: 'wander' };
      t.nextWanderAt = state.now + MINOTAUR.wanderInterval;
      return;
    }
    // Step one cell toward the target.
    const next = minotaurStepToward(state, t, target.cell, target.id);
    if (next) {
      t.target = next;
      t.facing = Math.atan2(next.cy - t.cell.cy, next.cx - t.cell.cx);
    }
    return;
  }

  // No goblins — wander.
  if (t.state.kind !== 'wander') t.state = { kind: 'wander' };
  if (state.now >= t.nextWanderAt) {
    const next = minotaurWanderStep(state, t);
    if (next) {
      t.target = next;
      t.facing = Math.atan2(next.cy - t.cell.cy, next.cx - t.cell.cx);
    }
    t.nextWanderAt = state.now + MINOTAUR.wanderInterval;
  }
}

// ─── Dragons ────────────────────────────────────────────────────────
// Summon a dragon. Targets the first finished Dragon Beacon (or the hole, as
// a fallback) but spawns far above and swoops down so the entrance reads as
// arriving from off-screen rather than popping into existence at the beacon.
export function spawnDragon(state: GameState): boolean {
  const beacon = constructedDragonBeacon(state);
  const origin = beacon ? buildingCenter(beacon) : holeCenter(state);
  const id = state.nextId++;
  const goal = { x: origin.x, y: origin.y - CELL * 2 };
  const d: Dragon = {
    id,
    pos: { x: goal.x, y: goal.y - DRAGON.swoopFromOffset },
    facing: 1,
    state: { kind: 'swooping_in', goal },
    carrying: null,
    carryingUnit: null,
    selected: false,
    spawnAt: state.now,
  };
  state.dragons.set(id, d);
  appendLog(state, `Dragon #${id} swoops down from above.`);
  // The summon ritual sound fires when the player queues the summon (main.ts);
  // this is the dragon actually arriving.
  playSound('online', 0.5, 0.35);
  return true;
}

// Fly straight toward (tx,ty) at `speed`. Returns true on arrival (within
// DRAGON.arriveDist). Updates facing from horizontal travel.
function dragonFlyToward(d: Dragon, tx: number, ty: number, speed: number): boolean {
  const dx = tx - d.pos.x;
  const dy = ty - d.pos.y;
  const dist = Math.hypot(dx, dy);
  if (Math.abs(dx) > 0.5) d.facing = dx < 0 ? -1 : 1;
  const step = speed * TICK_S;
  if (dist <= Math.max(step, DRAGON.arriveDist)) {
    d.pos.x = tx;
    d.pos.y = ty;
    return true;
  }
  d.pos.x += (dx / dist) * step;
  d.pos.y += (dy / dist) * step;
  return false;
}

// Lift a building off the grid onto a dragon. Maintainers/builders/carriers
// fall back to idle; the building is removed from the world and rides the
// dragon up. From here the dragon climbs and the load enters space.
function dragonLift(state: GameState, d: Dragon, b: Building) {
  // A dragon already hauling a building (or a snatched unit) can't pick up more.
  if (d.carrying || d.carryingUnit) return;
  // Hell Portals are rooted to the abyss — no dragon may haul one. Already
  // filtered out at command time in input.ts and skipped by the auto-seek
  // (income-based) picker, but kept here as defense in depth.
  if (b.kind === 'hell_portal') {
    d.state = { kind: 'seeking' };
    appendLog(state, `Dragon #${d.id} cannot pry the ${BUILDING_DEFS.hell_portal.name} from the ground.`);
    return;
  }
  for (const gid of b.assignedGoblins) {
    const g = state.goblins.get(gid);
    if (!g) continue;
    g.state = { kind: 'idle' };
    g.goal = null;
    g.path = [];
  }
  b.assignedGoblins = [];
  b.selected = false;
  state.buildings.delete(b.id);
  markBuildingsChanged(state);
  d.carrying = b;
  d.state = { kind: 'carrying' };
  appendLog(state, `Dragon #${d.id} hoists ${defOf(b).name} #${b.displayNum} skyward.`);
  playSound('online', 0.8, 0.45);
}

// Snatch a living unit off the ground onto a dragon. The unit is removed from
// the world on the spot (its cell freed, building assignments scrubbed by
// removeGoblin) and rides the dragon up as a CarriedUnit snapshot.
function dragonSnatchUnit(state: GameState, d: Dragon, kind: 'goblin' | 'minotaur', id: number) {
  if (d.carrying || d.carryingUnit) { d.state = { kind: 'seeking' }; return; }
  if (kind === 'goblin') {
    const g = state.goblins.get(id);
    if (!g) { d.state = { kind: 'seeking' }; return; }
    d.carryingUnit = { kind: 'goblin', robot: g.robot, gold: g.gold, bob: g.bob };
    const label = g.robot ? 'Robot' : g.bob ? 'Bob' : g.gold ? 'Gold Goblin' : 'Goblin';
    removeGoblin(state, id);
    appendLog(state, `Dragon #${d.id} snatches ${label} #${id} skyward.`);
  } else {
    const m = state.minotaurs.get(id);
    if (!m) { d.state = { kind: 'seeking' }; return; }
    d.carryingUnit = { kind: 'minotaur', tiny: m.tiny };
    state.minotaurs.delete(id);
    appendLog(state, `Dragon #${d.id} snatches ${m.tiny ? 'Tinytaur' : 'Minotaur'} #${id} skyward.`);
  }
  d.state = { kind: 'carrying_unit' };
  playSound('online', 0.8, 0.45);
}

// The snatched unit crosses into space: it's set adrift in the void (with a
// vacuum timer unless it's a robot — robots survive up there, and are the
// only hands that can assemble an Orbital Platform) and the dragon vanishes,
// its one trip made, just like a building haul.
function dragonReachSpaceWithUnit(state: GameState, d: Dragon) {
  const u = d.carryingUnit;
  if (u) {
    const id = state.nextId++;
    const ang = Math.random() * Math.PI * 2;
    const su: SpaceUnit = {
      id,
      kind: u.kind,
      robot: u.robot || undefined,
      gold: u.gold || undefined,
      bob: u.bob || undefined,
      tiny: u.tiny || undefined,
      pos: {
        x: SPACE.width / 2 + (Math.random() - 0.5) * SPACE.width * 0.45,
        y: SPACE.height / 2 + (Math.random() - 0.5) * SPACE.height * 0.45,
      },
      vel: { x: Math.cos(ang) * SPACE_UNIT.driftSpeed, y: Math.sin(ang) * SPACE_UNIT.driftSpeed },
      facing: Math.PI / 2,
      spin: Math.random() * Math.PI * 2,
      spinRate: (Math.random() - 0.5) * 0.5,
      diesAt: u.robot ? undefined : state.now + SPACE_UNIT.lifetime,
      selected: false,
    };
    state.spaceUnits.set(id, su);
    state.spaceUnlocked = true;
    appendLog(state, u.robot
      ? 'A robot drifts among the stars, entirely unbothered.'
      : `A ${u.kind === 'minotaur' ? 'minotaur' : 'goblin'} tumbles into the void. It does not have long.`);
    playSound('task_complete', 0.5);
  }
  removeDragon(state, d.id);
}

// The carried building crosses into space: it begins drifting in the void and
// the dragon, its work done, vanishes.
function dragonReachSpace(state: GameState, d: Dragon) {
  const b = d.carrying;
  if (b) {
    const px = SPACE.width / 2 + (Math.random() - 0.5) * SPACE.width * 0.45;
    const py = SPACE.height / 2 + (Math.random() - 0.5) * SPACE.height * 0.45;
    const ang = Math.random() * Math.PI * 2;
    state.spaceBuildings.set(b.id, {
      id: b.id,
      building: b,
      pos: { x: px, y: py },
      vel: { x: Math.cos(ang) * SPACE.driftSpeed, y: Math.sin(ang) * SPACE.driftSpeed },
      spin: Math.random() * Math.PI * 2,
      spinRate: (Math.random() - 0.5) * 0.25,
      selected: false,
    });
    state.spaceUnlocked = true;
    const orbitName = b.kind === 'dragon_beacon' ? 'Useless Beacon' : defOf(b).name;
    appendLog(state, `${orbitName} #${b.displayNum} now drifts among the stars.`);
    playSound('task_complete', 0.6);
  }
  removeDragon(state, d.id);
}

// Set a carried building back down on the grid near `goal`. Searches outward
// from the goal cell for a free footprint; returns false if there's no room
// anywhere nearby (the caller then falls back to hauling it to space).
function dragonDropAt(state: GameState, d: Dragon, goal: { x: number; y: number }): boolean {
  const b = d.carrying;
  if (!b) return false;
  const def = defOf(b);
  const center: Cell = { cx: Math.floor(goal.x / CELL), cy: Math.floor(goal.y / CELL) };
  const tl = findFreeFootprintNear(state, center, def.cellSize);
  if (!tl) return false;
  b.cell = tl;
  b.state = 'dormant';            // resolvePowerAndState re-evaluates next tick
  b.assignedGoblins = [];
  b.buildProgress = 1;
  b.selected = false;
  b.nextIncomeAt = undefined;     // re-anchor income cadence
  b.waterMeter = 0;
  state.buildings.set(b.id, b);
  markBuildingsChanged(state);
  d.carrying = null;
  d.state = { kind: 'seeking' };
  appendLog(state, `Dragon #${d.id} sets ${def.name} #${b.displayNum} back down.`);
  playSound('place', 1.2);
  autoAssignAllIdle(state);
  return true;
}

// Spiral outward from `center` for a top-left where the whole footprint is
// unblocked, preferring a placement centered on the requested cell.
function findFreeFootprintNear(state: GameState, center: Cell, n: number): Cell | null {
  const half = Math.floor((n - 1) / 2);
  for (let r = 0; r < 30; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const tl: Cell = { cx: center.cx - half + dx, cy: center.cy - half + dy };
        if (footprintClear(state, tl, n)) return tl;
      }
    }
  }
  return null;
}

function footprintClear(state: GameState, tl: Cell, n: number): boolean {
  for (let dx = 0; dx < n; dx++) {
    for (let dy = 0; dy < n; dy++) {
      const cx = tl.cx + dx, cy = tl.cy + dy;
      if (!isInBounds(cx, cy)) return false;
      if (isCellBlocked(state, cx, cy)) return false;
    }
  }
  return true;
}

function dragonKill(state: GameState, d: Dragon, kind: 'goblin' | 'minotaur' | 'dragon', id: number) {
  if (kind === 'dragon') {
    const victim = state.dragons.get(id);
    if (!victim || victim.id === d.id) return;
    const tx = victim.pos.x, ty = victim.pos.y;
    const bones = DRAGON_KILL_REWARD.dragonBone;
    recordGhost(state, 'dragon', tx, ty, victim.facing);
    removeDragon(state, id);
    earnDragonBone(state, bones);
    state.dragonBoneUnlocked = true;
    pushFloater(state, tx, ty, `+${bones} dragon bone${bones === 1 ? '' : 's'}`, 0xeae0c0, 1.8);
    pushDeathEffect(state, tx, ty);
    playSound('goblin_death', 0.85, 0.22);
    appendLog(state, `Dragon #${id} struck down by Dragon #${d.id} — a bone clatters to earth.`);
    return;
  }
  if (kind === 'goblin') {
    const g = state.goblins.get(id);
    if (!g || g.robot) return; // robots are fireproof (and otherwise-proof)
    const tx = g.pos.x, ty = g.pos.y;
    const reward = goblinKillReward(state, g);
    const wasGold = !!g.gold;
    recordGhost(state, 'goblin', tx, ty, g.facing, { gold: g.gold, bob: g.bob });
    removeGoblin(state, id);
    earnMoney(state, reward.money);
    earnBlood(state, reward.blood);
    state.bloodUnlocked = true;
    pushFloater(state, tx, ty, `+Ƶ${reward.money.toLocaleString('en-US')}`, 0xffd96b, 1.6);
    pushFloater(state, tx, ty - 14, `+${reward.blood} blood`, 0xff8a8a, 1.6);
    pushDeathEffect(state, tx, ty);
    playDecayingGoblinDeath();
    if (wasGold) playDecayingGoldKillCash();
    appendLog(state, `Goblin #${id} incinerated by Dragon #${d.id}.`);
  } else {
    const m = state.minotaurs.get(id);
    if (!m) return;
    const tx = m.pos.x, ty = m.pos.y;
    recordGhost(state, 'minotaur', tx, ty, m.facing, { tiny: m.tiny });
    state.minotaurs.delete(id);
    earnMoney(state, MINOTAUR_KILL_REWARD.money);
    earnBlood(state, MINOTAUR_KILL_REWARD.blood);
    state.bloodUnlocked = true;
    pushFloater(state, tx, ty, `+Ƶ${MINOTAUR_KILL_REWARD.money.toLocaleString('en-US')}`, 0xffd96b, 1.6);
    pushFloater(state, tx, ty - 14, `+${MINOTAUR_KILL_REWARD.blood} blood`, 0xff8a8a, 1.6);
    pushDeathEffect(state, tx, ty);
    playSound('goblin_death', 0.6, 0.4);
    appendLog(state, `Minotaur #${id} incinerated by Dragon #${d.id}.`);
  }
}

// A manual attack connects with a robot: the blow/beam visibly lands but the
// chassis shrugs it off — float "immune" over the robot instead of a kill.
function robotImmuneFlash(state: GameState, target: Goblin) {
  pushFloater(state, target.pos.x, target.pos.y - 18, 'immune', 0xcfd5dc, 1.4);
}

// An attack connects with rampaging Lolly: nothing happens — a 'no effect'
// floater rides above her head. Rate-limited so a wall of terminator fire
// doesn't stack the text into an unreadable blur.
function lollyNoEffectFlash(state: GameState): void {
  const L = state.lolly;
  if (!L) return;
  if (L.lastImmuneAt !== undefined && state.now - L.lastImmuneAt < 0.8) return;
  L.lastImmuneAt = state.now;
  // x/y are offsets from her live position (followLolly), like her boost text.
  pushFloater(state, 0, -LOLLY.displayPx * 0.62, 'no effect', 0xcfd5dc, 1.5, undefined, false, false, undefined, true);
}

// A robot's laser connects. Mirrors dragonKill's reward semantics: goblins
// and minotaurs pay their usual kill rewards, a dragon drops a Dragon Bone —
// so a robot is a second (much cheaper-per-shot) route to the bone grind.
function robotLaserKill(state: GameState, r: Goblin, kind: 'goblin' | 'minotaur' | 'dragon', id: number) {
  const shooter = r.terminator ? `Terminator #${r.id}` : `Robot #${r.id}`;
  if (kind === 'dragon') {
    const victim = state.dragons.get(id);
    if (!victim) return;
    const tx = victim.pos.x, ty = victim.pos.y;
    const bones = DRAGON_KILL_REWARD.dragonBone;
    recordGhost(state, 'dragon', tx, ty, victim.facing);
    removeDragon(state, id);
    earnDragonBone(state, bones);
    state.dragonBoneUnlocked = true;
    pushFloater(state, tx, ty, `+${bones} dragon bone${bones === 1 ? '' : 's'}`, 0xeae0c0, 1.8);
    pushDeathEffect(state, tx, ty);
    playSound('goblin_death', 0.85, 0.22);
    appendLog(state, `Dragon #${id} lasered out of the sky by ${shooter} — a bone clatters to earth.`);
    return;
  }
  if (kind === 'goblin') {
    const g = state.goblins.get(id);
    if (!g || g.robot) return; // robots can't be lasered (or otherwise killed)
    const tx = g.pos.x, ty = g.pos.y;
    const reward = goblinKillReward(state, g);
    const wasGold = !!g.gold;
    recordGhost(state, 'goblin', tx, ty, g.facing, { gold: g.gold, bob: g.bob });
    removeGoblin(state, id);
    earnMoney(state, reward.money);
    earnBlood(state, reward.blood);
    state.bloodUnlocked = true;
    pushFloater(state, tx, ty, `+Ƶ${reward.money.toLocaleString('en-US')}`, 0xffd96b, 1.6);
    pushFloater(state, tx, ty - 14, `+${reward.blood} blood`, 0xff8a8a, 1.6);
    pushDeathEffect(state, tx, ty);
    playDecayingGoblinDeath();
    if (wasGold) playDecayingGoldKillCash();
    appendLog(state, `Goblin #${id} lasered by ${shooter}.`);
  } else {
    const m = state.minotaurs.get(id);
    if (!m) return;
    const tx = m.pos.x, ty = m.pos.y;
    recordGhost(state, 'minotaur', tx, ty, m.facing, { tiny: m.tiny });
    state.minotaurs.delete(id);
    earnMoney(state, MINOTAUR_KILL_REWARD.money);
    earnBlood(state, MINOTAUR_KILL_REWARD.blood);
    state.bloodUnlocked = true;
    pushFloater(state, tx, ty, `+Ƶ${MINOTAUR_KILL_REWARD.money.toLocaleString('en-US')}`, 0xffd96b, 1.6);
    pushFloater(state, tx, ty - 14, `+${MINOTAUR_KILL_REWARD.blood} blood`, 0xff8a8a, 1.6);
    pushDeathEffect(state, tx, ty);
    playSound('goblin_death', 0.6, 0.4);
    appendLog(state, `Minotaur #${id} lasered by ${shooter}.`);
  }
}

// The robot a default (seeking) dragon hauls up when there's no income
// building left to take: the nearest ground robot not already being chased
// by another dragon. Terminators stay put — they're hunters, and their red
// lamp would be wasted on orbital chores.
function dragonTargetRobot(state: GameState, d: Dragon): Goblin | null {
  const claimed = new Set<number>();
  for (const other of state.dragons.values()) {
    if (other.id === d.id) continue;
    if (other.state.kind === 'going_to_unit' && other.state.targetKind === 'goblin') {
      claimed.add(other.state.targetId);
    }
  }
  let best: Goblin | null = null;
  let bestD = Infinity;
  for (const g of state.goblins.values()) {
    if (!g.robot || g.terminator || claimed.has(g.id)) continue;
    const dx = g.pos.x - d.pos.x, dy = g.pos.y - d.pos.y;
    const dist = dx * dx + dy * dy;
    if (dist < bestD) { bestD = dist; best = g; }
  }
  return best;
}

function updateDragon(state: GameState, d: Dragon) {
  // Player-issued orders fly at the snappier manualSpeed so commands feel
  // responsive; the default auto-collecting path stays at the calmer speed.
  const k = d.state.kind;
  const isManualOrder = k === 'moving_to' || k === 'going_to_kill'
    || k === 'going_to_building' || k === 'delivering' || k === 'going_to_unit';
  const speed = isManualOrder ? DRAGON.manualSpeed : DRAGON.speed;
  switch (d.state.kind) {
    case 'carrying': {
      // Climb straight up; once high enough the load enters space.
      dragonFlyToward(d, d.pos.x, DRAGON.spaceY, speed);
      if (d.pos.y <= DRAGON.spaceY + 1) dragonReachSpace(state, d);
      return;
    }

    case 'carrying_unit': {
      // Same climb, but the claws hold a struggling unit instead of a building.
      dragonFlyToward(d, d.pos.x, DRAGON.spaceY, speed);
      if (d.pos.y <= DRAGON.spaceY + 1) dragonReachSpaceWithUnit(state, d);
      return;
    }

    case 'going_to_unit': {
      // Commanded onto a non-dragon unit: chase it down and snatch it skyward.
      const s = d.state;
      if (d.carrying || d.carryingUnit) { d.state = { kind: 'seeking' }; return; }
      const target = s.targetKind === 'goblin'
        ? state.goblins.get(s.targetId)
        : state.minotaurs.get(s.targetId);
      // Gone (killed, or another dragon got there first) — back to default.
      if (!target) { d.state = { kind: 'seeking' }; return; }
      const tx = target.pos.x, ty = target.pos.y;
      const reached = dragonFlyToward(d, tx, ty, speed);
      if (reached || Math.hypot(tx - d.pos.x, ty - d.pos.y) <= DRAGON.pickupDist) {
        dragonSnatchUnit(state, d, s.targetKind, s.targetId);
      }
      return;
    }

    case 'delivering': {
      // Carrying a building to a ground drop-off. Fly to the goal, then set it
      // back down if there's room — otherwise haul it on up to space.
      if (!d.carrying) { d.state = { kind: 'seeking' }; return; }
      if (dragonFlyToward(d, d.state.goal.x, d.state.goal.y, speed)) {
        if (!dragonDropAt(state, d, d.state.goal)) {
          appendLog(state, `Dragon #${d.id} finds no room below — climbing to space.`);
          d.state = { kind: 'carrying' };
        }
      }
      return;
    }

    case 'moving_to': {
      // Fly to the spot, then loiter there for moveLingerTime before reverting
      // to the default seeking behaviour.
      if (dragonFlyToward(d, d.state.goal.x, d.state.goal.y, speed)) {
        if (d.state.lingerUntil === undefined) {
          d.state.lingerUntil = state.now + DRAGON.moveLingerTime;
        } else if (state.now >= d.state.lingerUntil) {
          d.state = { kind: 'seeking' };
        }
      }
      return;
    }

    case 'hovering_to_lift': {
      const b = state.buildings.get(d.state.buildingId);
      if (!b || d.carrying || d.carryingUnit) { d.state = { kind: 'seeking' }; return; }
      // Park over the building while the lift timer runs down, then hoist.
      const c = buildingCenter(b);
      dragonFlyToward(d, c.x, c.y, speed);
      if (state.now >= d.state.liftAt) dragonLift(state, d, b);
      return;
    }

    case 'going_to_building': {
      const b = state.buildings.get(d.state.buildingId);
      if (!b || d.carrying || d.carryingUnit) { d.state = { kind: 'seeking' }; return; }
      const c = buildingCenter(b);
      const reached = dragonFlyToward(d, c.x, c.y, speed);
      if (reached || Math.hypot(c.x - d.pos.x, c.y - d.pos.y) <= DRAGON.pickupDist) {
        d.state = { kind: 'hovering_to_lift', buildingId: b.id, liftAt: state.now + DRAGON.liftHover };
      }
      return;
    }

    case 'going_to_kill': {
      const s = d.state;
      const target = s.targetKind === 'goblin'
        ? state.goblins.get(s.targetId)
        : s.targetKind === 'minotaur'
          ? state.minotaurs.get(s.targetId)
          : state.dragons.get(s.targetId);
      // Bail if the target is gone, or if it somehow resolved to this dragon.
      if (!target || (s.targetKind === 'dragon' && s.targetId === d.id)) {
        d.state = { kind: 'seeking' };
        return;
      }
      const tx = target.pos.x, ty = target.pos.y;
      const dist = Math.hypot(tx - d.pos.x, ty - d.pos.y);
      const inRange = dist <= DRAGON.arriveDist + DRAGON.killReach;
      // Begin the windup the first time we close to striking range. Crucially we
      // never clear it once set — a moving target (e.g. another dragon) would
      // otherwise drift just out of reach every frame and reset the windup
      // forever, the "starts then stops attacking" bug. Once committed, the
      // dragon keeps chasing and lands the blow the instant it's both wound up
      // and back in reach.
      if (inRange && s.attackAt === undefined) {
        s.attackAt = state.now + DRAGON.attackWindup;
      }
      if (Math.abs(tx - d.pos.x) > 0.5) d.facing = tx < d.pos.x ? -1 : 1;
      if (inRange && s.attackAt !== undefined && state.now >= s.attackAt) {
        dragonKill(state, d, s.targetKind, s.targetId);
        // Hover in place for postKillPause before drifting back to default
        // seeking — reuses moving_to's linger machinery with the current
        // position as the goal so the dragon won't actually travel.
        d.state = {
          kind: 'moving_to',
          goal: { x: d.pos.x, y: d.pos.y },
          lingerUntil: state.now + DRAGON.postKillPause,
        };
        return;
      }
      // Keep pursuing — both while winding up (so a drifting target can't slip
      // away and cancel the strike) and while still closing the gap.
      dragonFlyToward(d, tx, ty, speed);
      return;
    }

    case 'swooping_in': {
      // Fast entrance from above. On arrival, hand off to seeking and reset
      // the spawn clock so the usual seek-delay hover beat starts from the
      // landing (giving the player a window to issue a manual command).
      if (dragonFlyToward(d, d.state.goal.x, d.state.goal.y, DRAGON.swoopSpeed)) {
        d.state = { kind: 'seeking' };
        d.spawnAt = state.now;
      }
      return;
    }

    case 'seeking':
    default: {
      // Hover for a beat after summoning before chasing a building, so the
      // player has a window to issue a manual command first.
      if (state.now < d.spawnAt + DRAGON.seekDelay) return;
      if (d.carrying) { d.state = { kind: 'carrying' }; return; }
      if (d.carryingUnit) { d.state = { kind: 'carrying_unit' }; return; }
      const b = dragonTargetBuilding(state);
      if (!b) {
        // No income-earner left to haul — bring up a robot instead (the only
        // unit that survives the vacuum, and the only hands that can build up
        // there). Falls back to hovering when there's no robot either.
        const r = dragonTargetRobot(state, d);
        if (r) d.state = { kind: 'going_to_unit', targetKind: 'goblin', targetId: r.id };
        return;
      }
      const c = buildingCenter(b);
      const reached = dragonFlyToward(d, c.x, c.y, speed);
      if (reached || Math.hypot(c.x - d.pos.x, c.y - d.pos.y) <= DRAGON.pickupDist) {
        d.state = { kind: 'hovering_to_lift', buildingId: b.id, liftAt: state.now + DRAGON.liftHover };
      }
      return;
    }
  }
}

// Gentle bounded drift for a floating space building. Bounces off the scene
// margins so it never wanders out of view, with the occasional small course
// nudge so the motion reads as organic rather than perfectly linear.
function updateSpaceBuilding(sb: SpaceBuilding) {
  // Orbital Platforms are anchored where they're deployed — no drift, no spin
  // (they're platforms; a tumbling one would be a fairground ride). Space
  // Centres are bolted to their platform, so they hold station too.
  if (sb.building.kind === 'orbital_platform' || sb.building.kind === 'space_centre') return;
  const def = BUILDING_DEFS[sb.building.kind];
  const halfPx = def.size / 2;
  sb.pos.x += sb.vel.x * TICK_S;
  sb.pos.y += sb.vel.y * TICK_S;
  sb.spin += sb.spinRate * TICK_S;
  const minX = SPACE.margin + halfPx, maxX = SPACE.width - SPACE.margin - halfPx;
  const minY = SPACE.margin + halfPx, maxY = SPACE.height - SPACE.margin - halfPx;
  if (sb.pos.x < minX) { sb.pos.x = minX; sb.vel.x = Math.abs(sb.vel.x); }
  else if (sb.pos.x > maxX) { sb.pos.x = maxX; sb.vel.x = -Math.abs(sb.vel.x); }
  if (sb.pos.y < minY) { sb.pos.y = minY; sb.vel.y = Math.abs(sb.vel.y); }
  else if (sb.pos.y > maxY) { sb.pos.y = maxY; sb.vel.y = -Math.abs(sb.vel.y); }
  if (Math.random() < 0.01) {
    sb.vel.x += (Math.random() - 0.5) * 8;
    sb.vel.y += (Math.random() - 0.5) * 8;
    const sp = Math.hypot(sb.vel.x, sb.vel.y) || 1;
    sb.vel.x = (sb.vel.x / sp) * SPACE.driftSpeed;
    sb.vel.y = (sb.vel.y / sp) * SPACE.driftSpeed;
  }
}

// One robot per job. Each structure under robot assembly needs exactly one
// builder (extra hands compound the fast-build cut, but only if the player
// marches them over — see advanceOrbitalPlatforms), and
// each completed Space Centre needs exactly one robot stationed on its deck
// as crew. Greedily claim the nearest free robot for every job so the rest
// stay parked instead of the whole fleet piling onto the same site.
// Recomputed every tick; robots mid-march to a player goal are off the books
// (they ignore work entirely until they arrive), and a robot standing fast at
// its goal may only be claimed for fresh construction work — maintainer duty
// never pulls a commanded robot off its post.
type RobotDuty = { kind: 'build' | 'maintain'; siteId: number };
function assignRobotDuties(state: GameState): Map<number, RobotDuty> {
  const duties = new Map<number, RobotDuty>();
  const free: SpaceUnit[] = [];
  for (const su of state.spaceUnits.values()) {
    if (!su.robot) continue;
    if (su.goal && Math.hypot(su.goal.x - su.pos.x, su.goal.y - su.pos.y) > ROBOT.arriveDist + 0.5) continue;
    free.push(su);
  }
  const claim = (sb: SpaceBuilding, kind: RobotDuty['kind']): void => {
    let best: SpaceUnit | null = null;
    let bestD = Infinity;
    for (const su of free) {
      if (duties.has(su.id)) continue;
      if (kind === 'maintain' && su.goal) continue; // commanded posts yield to builds only
      const dx = su.pos.x - sb.pos.x, dy = su.pos.y - sb.pos.y;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = su; }
    }
    if (best) duties.set(best.id, { kind, siteId: sb.id });
  };
  // Construction first — an unfinished structure earns nothing, so it
  // outranks keeping an already-built Centre crewed.
  for (const sb of state.spaceBuildings.values()) {
    if (isRobotBuilt(sb.building.kind) && sb.building.state === 'constructing') claim(sb, 'build');
  }
  for (const sb of state.spaceBuildings.values()) {
    if (sb.building.kind === 'space_centre' && sb.building.state !== 'constructing') claim(sb, 'maintain');
  }
  return duties;
}

// Step a robot toward a point, stopping `hold` px short of it. Returns true
// once within that range. Sets the walk pose (facing, no tumble) and flags
// `walking` on ticks it actually moved.
function robotStepToward(su: SpaceUnit, x: number, y: number, hold: number): boolean {
  const dx = x - su.pos.x;
  const dy = y - su.pos.y;
  const dist = Math.hypot(dx, dy);
  su.spin = 0; // squared up, not tumbling
  if (dist <= hold) return true;
  const step = Math.min(getOptions().robotSpaceSpeed * TICK_S, dist - hold);
  su.pos.x += (dx / dist) * step;
  su.pos.y += (dy / dist) * step;
  su.facing = Math.atan2(dy, dx);
  su.walking = true;
  return false;
}

// A robot's parking spot on a platform's deck: a stable per-robot position on
// a ring just inside the deck edge — the walkable rim a Space Centre leaves
// uncovered. The golden angle spreads any number of robots around the ring
// without two ever sharing a spot.
function robotParkSpot(su: SpaceUnit, platform: SpaceBuilding): { x: number; y: number } {
  const r = BUILDING_DEFS.orbital_platform.size / 2 - ROBOT.parkInset;
  const ang = su.id * 2.399963; // golden angle, radians
  return { x: platform.pos.x + Math.cos(ang) * r, y: platform.pos.y + Math.sin(ang) * r };
}

// A unit adrift in space. Robots have a little life up here: a player move
// command (goal) takes priority — walk there and stand fast; otherwise they
// work whatever duty assignRobotDuties handed them this tick — sole builder
// at a structure under robot assembly (advanceOrbitalPlatforms counts them
// there), or sole maintainer parked on a completed Space Centre's deck —
// failing that they head for the nearest completed Orbital Platform and park
// on its deck. Everything else — and robots with nowhere to go — tumbles
// gently within the space bounds, mirroring the building drift. A non-robot's
// vacuum timer pops it once SPACE_UNIT.lifetime is up.
function updateSpaceUnit(state: GameState, su: SpaceUnit, duties: Map<number, RobotDuty>) {
  if (su.diesAt !== undefined && state.now >= su.diesAt) {
    spaceUnitPerish(state, su);
    return;
  }
  if (su.robot) {
    su.walking = false;
    const duty = duties.get(su.id);
    // Maintainer assignment mirrors a ground goblin's: it only holds while
    // assignRobotDuties keeps handing this robot the same Centre.
    su.maintains = duty?.kind === 'maintain' ? duty.siteId : undefined;
    // 1) Player command — walk to the goal, then STAY there (a commanded
    // goblin doesn't wander off its post). Only fresh construction work may
    // claim a robot off its post once it's standing (mirroring autobuild
    // grabbing an idle goblin); a robot mid-walk ignores work entirely.
    if (su.goal) {
      su.workingOn = undefined;
      if (!robotStepToward(su, su.goal.x, su.goal.y, ROBOT.arriveDist)) return;
      if (duty?.kind !== 'build') return; // standing fast
      su.goal = undefined; // work calls — release the post and fall through
    }
    // 2) Assembly work — the one site this robot is the claimed builder for.
    if (duty?.kind === 'build') {
      const target = state.spaceBuildings.get(duty.siteId);
      if (target) {
        su.workingOn = target.id;
        const def = BUILDING_DEFS[target.building.kind];
        // Park just inside the build range so the robot reads as ON the site.
        robotStepToward(su, target.pos.x, target.pos.y, def.size / 2 + ROBOT.buildRange * 0.5);
        return;
      }
    }
    su.workingOn = undefined;
    // 3) Maintainer duty — park on the assigned Centre's deck rim, where
    // spaceCentreMaintained counts this robot as the crew.
    if (duty?.kind === 'maintain') {
      const centre = state.spaceBuildings.get(duty.siteId);
      if (centre) {
        const platform = centre.platformId !== undefined
          ? state.spaceBuildings.get(centre.platformId) : undefined;
        const spot = robotParkSpot(su, platform ?? centre);
        robotStepToward(su, spot.x, spot.y, ROBOT.arriveDist);
        return;
      }
    }
    // 4) Idle — park on the nearest completed platform's deck.
    let platform: SpaceBuilding | null = null;
    let bestD = Infinity;
    for (const sb of state.spaceBuildings.values()) {
      if (sb.building.kind !== 'orbital_platform' || sb.building.state === 'constructing') continue;
      const dx = sb.pos.x - su.pos.x, dy = sb.pos.y - su.pos.y;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; platform = sb; }
    }
    if (platform) {
      const spot = robotParkSpot(su, platform);
      robotStepToward(su, spot.x, spot.y, ROBOT.arriveDist);
      return;
    }
  }
  // Gentle bounded tumble — same physics as the floating buildings.
  su.pos.x += su.vel.x * TICK_S;
  su.pos.y += su.vel.y * TICK_S;
  su.spin += su.spinRate * TICK_S;
  const m = SPACE_UNIT.margin;
  if (su.pos.x < m) { su.pos.x = m; su.vel.x = Math.abs(su.vel.x); }
  else if (su.pos.x > SPACE.width - m) { su.pos.x = SPACE.width - m; su.vel.x = -Math.abs(su.vel.x); }
  if (su.pos.y < m) { su.pos.y = m; su.vel.y = Math.abs(su.vel.y); }
  else if (su.pos.y > SPACE.height - m) { su.pos.y = SPACE.height - m; su.vel.y = -Math.abs(su.vel.y); }
}

// A non-robot unit's vacuum timer runs out. Pays the usual kill rewards (a
// death is a death, however bleak) with space-flagged floaters; no ghost —
// a soul lost to the void never reaches the underworld.
function spaceUnitPerish(state: GameState, su: SpaceUnit) {
  state.spaceUnits.delete(su.id);
  const x = su.pos.x, y = su.pos.y;
  if (su.kind === 'goblin') {
    const reward = su.gold
      ? { money: GOLD_KILL_REWARD.money * state.goldgoblinMultiplier, blood: GOLD_KILL_REWARD.blood }
      : KILL_REWARD;
    earnMoney(state, reward.money);
    earnBlood(state, reward.blood);
    state.bloodUnlocked = true;
    pushFloater(state, x, y, `+Ƶ${reward.money.toLocaleString('en-US')}`, 0xffd96b, 1.6, undefined, true);
    pushFloater(state, x, y - 14, `+${reward.blood} blood`, 0xff8a8a, 1.6, undefined, true);
  } else {
    earnBlood(state, MINOTAUR_KILL_REWARD.blood);
    state.bloodUnlocked = true;
    pushFloater(state, x, y - 14, `+${MINOTAUR_KILL_REWARD.blood} blood`, 0xff8a8a, 1.6, undefined, true);
  }
  const label = su.bob ? 'Bob'
    : su.kind === 'minotaur' ? (su.tiny ? 'A tinytaur' : 'A minotaur')
    : su.gold ? 'A gold goblin' : 'A goblin';
  // No death cry — in space, no one can hear it scream.
  appendLog(state, `${label} perishes silently in the vacuum.`);
}

// The structures born in space that a robot can assemble (everything else up
// there was hauled up already built).
function isRobotBuilt(kind: BuildingKind): boolean {
  return kind === 'orbital_platform' || kind === 'space_centre';
}

// Robots holding station at an unfinished Orbital Platform or Space Centre
// advance its build. buildersRequired is 1, so a single robot on site keeps
// the work moving — and exactly like a ground site, every robot on site
// compounds the ROBOT.buildTimeMult (0.7×) "fast build" cut, so marching
// extra robots over genuinely speeds the assembly up.
function advanceOrbitalPlatforms(state: GameState) {
  for (const sb of state.spaceBuildings.values()) {
    const b = sb.building;
    if (!isRobotBuilt(b.kind) || b.state !== 'constructing') continue;
    const def = BUILDING_DEFS[b.kind];
    let workers = 0;
    for (const su of state.spaceUnits.values()) {
      if (!su.robot) continue;
      if (Math.hypot(su.pos.x - sb.pos.x, su.pos.y - sb.pos.y) <= def.size / 2 + ROBOT.buildRange) workers++;
    }
    if (workers < def.buildersRequired) continue;
    b.buildProgress += TICK_S / (def.buildTime * Math.pow(ROBOT.buildTimeMult, workers));
    if (b.buildProgress >= 1) {
      b.buildProgress = 1;
      b.activatedAt = state.now;
      playSound('build_done');
      if (b.kind === 'space_centre') {
        // Finish dormant — resolvePowerAndState flips it active (with the
        // power-link floater) the first tick the grid can spare its 10 GW.
        b.state = 'dormant';
        appendLog(state, `${def.name} #${b.displayNum} assembled in the void — hungry for ${formatPower(-def.powerOutput)} from below.`);
      } else {
        b.state = 'active';
        appendLog(state, `${def.name} #${b.displayNum} assembled in the void. It does nothing. For now.`);
      }
    }
  }
}

export function nearestWaterSourceTo(state: GameState, b: Building) {
  const c = buildingCenter(b);
  let best = null;
  let bestD = Infinity;
  for (const w of state.waterSources.values()) {
    // Use region center for distance comparison.
    const wcx = (w.x0 + w.x1) / 2 * CELL;
    const wcy = (w.y0 + w.y1) / 2 * CELL;
    const dx = wcx - c.x;
    const dy = wcy - c.y;
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = w; }
  }
  return best;
}

// Standard kill payout, with a fatter pile for gold-tinted goblins. The
// gold multiplier (1 by default, 10 with Goldgoblins x10) scales the money
// drop without touching the blood reward.
function goblinKillReward(state: GameState, g: Goblin) {
  if (!g.gold) return KILL_REWARD;
  return {
    money: GOLD_KILL_REWARD.money * state.goldgoblinMultiplier,
    blood: GOLD_KILL_REWARD.blood,
  };
}

// Nearest cell inside the water region that `g` can actually stand in (not held
// by another goblin or otherwise blocked). When a Datacentre is jammed up
// against the water, several carriers compete for the same edge cell; aiming
// each at the closest FREE cell spreads them along the standable line instead of
// piling onto one square (whoever loses the race used to find their fixed goal
// permanently blocked, fail to path, and drop water duty on the stuck timer).
// Falls back to the geometric nearest cell when every cell is contended so the
// carrier still has something to aim at.
function nearestFreeWaterCell(state: GameState, src: WaterSource, g: Goblin): Cell {
  let best: Cell | null = null;
  let bestD = Infinity;
  for (let cy = src.y0; cy < src.y1; cy++) {
    for (let cx = src.x0; cx < src.x1; cx++) {
      if (isCellBlocked(state, cx, cy, g.id)) continue;
      const dx = cx - g.cell.cx;
      const dy = cy - g.cell.cy;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = { cx, cy }; }
    }
  }
  return best ?? nearestCellInWaterSource(src, g.cell);
}

// Closest unblocked perimeter cell of `b` to the goblin — used by water
// carriers as the "delivery" cell where they touch the Datacentre.
function pickDcDeliveryCell(state: GameState, b: Building, g: Goblin): Cell | null {
  let best: Cell | null = null;
  let bestD = Infinity;
  for (const c of buildingPerimeter(b)) {
    if (isCellBlocked(state, c.cx, c.cy, g.id)) continue;
    const d = (c.cx - g.cell.cx) * (c.cx - g.cell.cx) + (c.cy - g.cell.cy) * (c.cy - g.cell.cy);
    if (d < bestD) { bestD = d; best = c; }
  }
  return best;
}

function nearestFreeNeighbor(state: GameState, cell: Cell, hunter: Goblin): Cell | null {
  let best: Cell | null = null;
  let bestDist = Infinity;
  for (const d of ALL_DIRS) {
    const cx = cell.cx + DX[d];
    const cy = cell.cy + DY[d];
    if (!isInBounds(cx, cy)) continue;
    if (cx === hunter.cell.cx && cy === hunter.cell.cy) return { cx, cy };
    if (isCellBlocked(state, cx, cy, hunter.id)) continue;
    const dist = Math.hypot(cx - hunter.cell.cx, cy - hunter.cell.cy);
    if (dist < bestDist) { best = { cx, cy }; bestDist = dist; }
  }
  return best;
}

// Cells on the ring just outside the 2×2 hole footprint, sorted with a
// strong rightward bias and a mild "stay near the centerline" tiebreak.
// Minotaurs spawn straight onto the hole ring (no reachability flood — they're
// summoned, not hatched) but the spawn-blocked check ignores goblin occupancy
// (a fresh minotaur can crowd onto a goblin's cell — it'll
// just kill them on the next tick) and rejects cells already held by another
// minotaur. Used at summon time to prevent two minotaurs sharing a square.
function pickMinotaurSpawnCell(state: GameState): Cell | null {
  // Minotaurs crawl out of the original hole specifically — once Lolly has
  // torn it out of the earth there is nothing to crawl out of.
  if (state.holeDestroyed) return null;
  const h = state.hole.cell;
  const cx0 = h.cx + (HOLE_SIZE - 1) / 2;
  const cy0 = h.cy + (HOLE_SIZE - 1) / 2;
  const ring: Cell[] = [];
  for (let dx = -1; dx <= HOLE_SIZE; dx++) {
    for (let dy = -1; dy <= HOLE_SIZE; dy++) {
      const inHole = dx >= 0 && dx < HOLE_SIZE && dy >= 0 && dy < HOLE_SIZE;
      if (inHole) continue;
      ring.push({ cx: h.cx + dx, cy: h.cy + dy });
    }
  }
  ring.sort((a, b) => {
    const sa = (a.cx - cx0) - 0.25 * Math.abs(a.cy - cy0);
    const sb = (b.cx - cx0) - 0.25 * Math.abs(b.cy - cy0);
    return sb - sa;
  });
  for (const c of ring) {
    if (minotaurWalkable(state, c.cx, c.cy)) return c;
  }
  return null;
}

// ─── Goblin update ──────────────────────────────────────────────────
function updateGoblin(state: GameState, g: Goblin) {
  // Track continuous idle time so the renderer can switch animations once a
  // goblin's been standing around long enough.
  if (g.state.kind === 'idle') {
    if (g.idleSince === null) g.idleSince = state.now;
  } else if (g.idleSince !== null) {
    g.idleSince = null;
  }

  // Continue interpolating toward target cell if mid-step. Robots run on
  // quicker servos than the flesh-and-blood goblins.
  if (g.target) {
    const tc = cellCenter(g.target);
    const dx = tc.x - g.pos.x;
    const dy = tc.y - g.pos.y;
    const d = Math.hypot(dx, dy);
    const step = (g.robot ? ROBOT.speed : GOBLIN.speed) * TICK_S;
    if (d <= step + GOBLIN.arriveDist) {
      releaseCell(state, g.cell.cx, g.cell.cy, g.id);
      g.cell = g.target;
      g.pos = tc;
      g.target = null;
      g.lastCellChangedAt = state.now;
    } else {
      g.pos.x += (dx / d) * step;
      g.pos.y += (dy / d) * step;
      g.facing = Math.atan2(dy, dx);
      return;
    }
  }

  const s = g.state;
  switch (s.kind) {
    case 'idle': {
      // Auto-exit if standing inside a building we don't belong to
      const here = buildingAtCell(state, g.cell.cx, g.cell.cy);
      if (here) {
        const exit = nearestExitCell(state, g, here);
        if (exit) {
          g.goal = exit;
          g.path = [];
          g.state = { kind: 'moving' };
          return;
        }
      }
      g.goal = null;
      g.path = [];
      return;
    }

    case 'moving': {
      if (!g.goal) { g.state = { kind: 'idle' }; return; }
      planStep(state, g);
      if (!g.goal && !g.target) g.state = { kind: 'idle' };
      return;
    }

    case 'going_to_build': {
      const b = state.buildings.get(s.buildingId);
      if (!b) { g.goal = null; g.path = []; g.state = { kind: 'idle' }; return; }
      const buildDef = defOf(b);

      // At-commit capacity check: count other goblins already in 'building' state.
      // First-to-arrive wins; the loser un-assigns and reverts to idle.
      const tryBecomeBuilder = (): boolean => {
        let workers = 0;
        for (const aid of b.assignedGoblins) {
          if (aid === g.id) continue;
          const og = state.goblins.get(aid);
          if (og && og.state.kind === 'building' && og.state.buildingId === b.id) workers++;
        }
        if (workers >= buildDef.buildersRequired) {
          const i = b.assignedGoblins.indexOf(g.id);
          if (i >= 0) b.assignedGoblins.splice(i, 1);
          g.state = { kind: 'idle' };
          g.goal = null;
          g.path = [];
          return false;
        }
        g.goal = null;
        g.path = [];
        g.state = { kind: 'building', buildingId: b.id };
        // A robot's compounding 0.7× build-time bonus (see updateConstruction)
        // is announced by the renderer: a white "fast build" tag pinned above
        // its head for as long as it stays in this state (syncFastBuildTags).
        return true;
      };

      // Pick the deepest free footprint cell as the goal, where depth = rings
      // from the edge. A goblin only commits once it stands at max-depth among
      // currently-free cells; otherwise it keeps walking inward. This stops
      // first-arrivals from corking the doorway on big builds (e.g. DC needs 15).
      const footprint = buildingFootprint(b);
      const isFreeForMe = (c: Cell) =>
        (c.cx === g.cell.cx && c.cy === g.cell.cy) ||
        !isCellBlocked(state, c.cx, c.cy, g.id, b.id);
      const free = footprint.filter(isFreeForMe);
      if (free.length === 0) return; // every cell blocked; wait a tick

      let maxDepth = -1;
      for (const c of free) {
        const d = cellDepth(b, c.cx, c.cy);
        if (d > maxDepth) maxDepth = d;
      }

      const insideFootprint = isCellInBuilding(b, g.cell.cx, g.cell.cy);
      if (insideFootprint && cellDepth(b, g.cell.cx, g.cell.cy) >= maxDepth) {
        tryBecomeBuilder();
        return;
      }

      const candidates = free
        .filter(c => cellDepth(b, c.cx, c.cy) === maxDepth)
        .sort((a, c) =>
          Math.hypot(a.cx - g.cell.cx, a.cy - g.cell.cy) -
          Math.hypot(c.cx - g.cell.cx, c.cy - g.cell.cy));
      const slot = candidates[0];
      if (!g.goal || g.goal.cx !== slot.cx || g.goal.cy !== slot.cy) {
        g.goal = slot;
        g.path = [];
      }
      planStep(state, g);
      return;
    }

    case 'going_to_maintain': {
      const b = state.buildings.get(s.buildingId);
      if (!b) { g.goal = null; g.path = []; g.state = { kind: 'idle' }; return; }
      const def = defOf(b);
      const slot = maintainerSlot(state, b, g);
      if (!slot) return;
      if (g.cell.cx === slot.cx && g.cell.cy === slot.cy) {
        // At-commit cap: count other maintainers; bail if full.
        let m = 0;
        for (const aid of b.assignedGoblins) {
          if (aid === g.id) continue;
          const og = state.goblins.get(aid);
          if (og && og.state.kind === 'maintaining' && og.state.buildingId === b.id) m++;
        }
        if (m >= def.maintainersRequired) {
          const i = b.assignedGoblins.indexOf(g.id);
          if (i >= 0) b.assignedGoblins.splice(i, 1);
          g.state = { kind: 'idle' };
          g.goal = null;
          g.path = [];
          return;
        }
        g.goal = null;
        g.path = [];
        g.state = { kind: 'maintaining', buildingId: b.id, nextWanderAt: state.now + jitterInterval(b) };
        return;
      }
      if (!g.goal || g.goal.cx !== slot.cx || g.goal.cy !== slot.cy) {
        g.path = [];
        g.goal = slot;
      }
      planStep(state, g);
      return;
    }

    case 'building': {
      const bb = state.buildings.get(s.buildingId);
      if (!bb) { g.state = { kind: 'idle' }; g.goal = null; g.path = []; return; }
      // Random idle-fidget every ~5s while standing inside the footprint
      // (typically waiting for the rest of the build crew to show up). Picks
      // a free 8-neighbor cell that's still inside the footprint and steps
      // there. No-ops if the goblin is already in motion (target set).
      if (s.nextWanderAt === undefined) s.nextWanderAt = state.now + 5;
      if (!g.target && state.now >= s.nextWanderAt) {
        const choices: Dir[] = [];
        for (const d of ALL_DIRS) {
          const nx = g.cell.cx + DX[d];
          const ny = g.cell.cy + DY[d];
          if (!isCellInBuilding(bb, nx, ny)) continue;
          if (!canStep(state, g.cell.cx, g.cell.cy, nx, ny, g.id, bb.id)) continue;
          choices.push(d);
        }
        if (choices.length > 0) {
          const chosen = choices[Math.floor(Math.random() * choices.length)];
          const nx = g.cell.cx + DX[chosen];
          const ny = g.cell.cy + DY[chosen];
          occupyCell(state, nx, ny, g.id);
          g.target = { cx: nx, cy: ny };
          g.facing = Math.atan2(DY[chosen], DX[chosen]);
        }
        s.nextWanderAt = state.now + 5;
      }
      g.goal = null;
      g.path = [];
      return;
    }

    case 'fetching_water': {
      const b = state.buildings.get(s.buildingId);
      const src = state.waterSources.get(s.sourceId);
      if (!b || !src) {
        // DC was destroyed or source vanished — drop the role.
        if (b) {
          const i = b.assignedGoblins.indexOf(g.id);
          if (i >= 0) b.assignedGoblins.splice(i, 1);
        }
        g.state = { kind: 'idle' };
        g.goal = null;
        g.path = [];
        return;
      }
      // Stuck check: if the goblin hasn't progressed a cell in 3s while on
      // water duty, drop the role and idle.
      if (state.now - g.lastCellChangedAt > 3) {
        const i = b.assignedGoblins.indexOf(g.id);
        if (i >= 0) b.assignedGoblins.splice(i, 1);
        appendLog(state, `Goblin #${g.id} stuck — water duty cancelled.`);
        g.state = { kind: 'idle' };
        g.goal = null;
        g.path = [];
        return;
      }
      // 'to_source' counts as arrived once we step into ANY cell of the water
      // region AND have stood there for at least 1s (the goblin has to dip
      // their bucket — instant jumping to to_dc looked silly).
      if (s.phase === 'to_source') {
        if (isCellInWaterSource(src, g.cell)) {
          if (s.collectingSince === undefined) s.collectingSince = state.now;
          // While dwelling, hold position — clear any goal so planStep
          // doesn't keep nudging us forward.
          g.goal = null;
          g.path = [];
          if (state.now - s.collectingSince >= 1) {
            s.phase = 'to_dc';
            s.initialTarget = undefined;  // first trip done; closest point thereafter
            s.collectingSince = undefined;
          }
          return;
        }
        // Stepped back out (or never arrived) — reset the dwell timer.
        s.collectingSince = undefined;
        // First trip aims at the click cell; later trips pick the closest FREE
        // cell in the source region (so multiple carriers spread along the
        // standable line rather than fighting over one square). If the click
        // cell turns out to be unreachable, fall back to a free cell same tick.
        const desired = s.initialTarget ?? nearestFreeWaterCell(state, src, g);
        if (!g.goal || g.goal.cx !== desired.cx || g.goal.cy !== desired.cy) {
          g.goal = desired;
          g.path = [];
        }
        planStep(state, g);
        if (!g.target && s.initialTarget) {
          // Couldn't path to the click cell — drop it and try the closest free.
          s.initialTarget = undefined;
          const fallback = nearestFreeWaterCell(state, src, g);
          g.goal = fallback;
          g.path = [];
          planStep(state, g);
        }
        return;
      }
      // phase === 'to_dc'
      const dcTarget = pickDcDeliveryCell(state, b, g) ?? buildingPerimeter(b)[0];
      if (!dcTarget) return;
      if (g.cell.cx === dcTarget.cx && g.cell.cy === dcTarget.cy) {
        // Delivery: bump the building's water meter — but only if the
        // building is fully staffed. A half-built crew can't keep the
        // tanks online, so the carrier's water "spills" until maintainers
        // are in place.
        const bDef = defOf(b);
        const delivery = bDef.waterDeliveryAmount ?? 0;
        const fullyStaffed = maintainerCount(state, b) >= bDef.maintainersRequired;
        if (delivery > 0 && fullyStaffed) {
          b.waterMeter = Math.min(WATER_METER_MAX, (b.waterMeter ?? 0) + delivery);
          playSound('water_splash', 0.5);
        }
        s.firstLoopDone = true;
        s.phase = 'to_source';
        g.goal = null;
        g.path = [];
        return;
      }
      if (!g.goal || g.goal.cx !== dcTarget.cx || g.goal.cy !== dcTarget.cy) {
        g.goal = dcTarget;
        g.path = [];
      }
      planStep(state, g);
      return;
    }

    case 'going_to_kill': {
      const target = state.goblins.get(s.targetId);
      // No target or self-target — stand down. A robot target stays valid:
      // the attacker chases and swings, the chassis just shrugs it off.
      if (!target || target.id === g.id) {
        g.state = { kind: 'idle' };
        g.goal = null;
        g.path = [];
        return;
      }
      const dx = Math.abs(target.cell.cx - g.cell.cx);
      const dy = Math.abs(target.cell.cy - g.cell.cy);
      if (Math.max(dx, dy) <= 1) {
        // Windup → swing → kill. Holding for a beat lets the swipe animation
        // visibly play before the target vanishes.
        if (s.attackAt === undefined) {
          s.attackAt = state.now + 0.4;
          g.facing = Math.atan2(target.pos.y - g.pos.y, target.pos.x - g.pos.x);
          g.goal = null;
          g.path = [];
          return;
        }
        if (state.now < s.attackAt) {
          g.goal = null;
          g.path = [];
          return;
        }
        // The swing lands on a robot: no kill, no reward — just an "immune"
        // floater over the chassis, and the attacker stands down.
        if (target.robot) {
          robotImmuneFlash(state, target);
          appendLog(state, `Goblin #${g.id}'s blow glances off ${target.terminator ? 'Terminator' : 'Robot'} #${target.id}.`);
          g.state = { kind: 'idle' };
          g.goal = null;
          g.path = [];
          return;
        }
        const tx = target.pos.x, ty = target.pos.y;
        const reward = goblinKillReward(state, target);
        const wasGold = !!target.gold;
        recordGhost(state, 'goblin', tx, ty, target.facing, { gold: target.gold, bob: target.bob });
        removeGoblin(state, target.id);
        earnMoney(state, reward.money);
        earnBlood(state, reward.blood);
        state.bloodUnlocked = true;
        pushFloater(state, tx, ty, `+Ƶ${reward.money.toLocaleString('en-US')}`, 0xffd96b, 1.6);
        pushFloater(state, tx, ty - 14, `+${reward.blood} blood`, 0xff8a8a, 1.6);
        pushDeathEffect(state, tx, ty);
        playSound('goblin_death', 0.56);
        if (wasGold) playSound('cash', 0.7);
        appendLog(state, `Goblin #${target.id} killed by #${g.id}.`);
        g.state = { kind: 'idle' };
        g.goal = null;
        g.path = [];
        return;
      }
      // Target's own cell is blocked by the target itself, so we'd never
      // path there — head to the closest free 8-neighbor instead.
      s.attackAt = undefined;
      const adj = nearestFreeNeighbor(state, target.cell, g);
      if (!adj) { g.path = []; return; }
      if (!g.goal || g.goal.cx !== adj.cx || g.goal.cy !== adj.cy) {
        g.goal = adj;
        g.path = [];
      }
      planStep(state, g);
      return;
    }

    case 'attacking_lolly': {
      // Chase rampaging Lolly and swing at her. The blow always lands and
      // never matters — a 'no effect' floater over her head, then idle.
      const L = state.finale ? null : state.lolly;
      if (!L) {
        g.state = { kind: 'idle' };
        g.goal = null;
        g.path = [];
        return;
      }
      const dist = Math.hypot(L.pos.x - g.pos.x, L.pos.y - g.pos.y);
      // Her bulk counts as the target: swing from just outside her footprint.
      if (dist <= LOLLY.displayPx * 0.3) {
        if (s.attackAt === undefined) {
          s.attackAt = state.now + 0.4;
          g.facing = Math.atan2(L.pos.y - g.pos.y, L.pos.x - g.pos.x);
          g.goal = null;
          g.path = [];
          return;
        }
        if (state.now < s.attackAt) {
          g.goal = null;
          g.path = [];
          return;
        }
        lollyNoEffectFlash(state);
        g.state = { kind: 'idle' };
        g.goal = null;
        g.path = [];
        return;
      }
      // Keep chasing her live position (she's grid-free; her cell is walkable).
      s.attackAt = undefined;
      const lc = { cx: Math.floor(L.pos.x / CELL), cy: Math.floor(L.pos.y / CELL) };
      const adj = isCellBlocked(state, lc.cx, lc.cy, g.id) ? nearestFreeNeighbor(state, lc, g) : lc;
      if (!adj) { g.path = []; return; }
      if (!g.goal || g.goal.cx !== adj.cx || g.goal.cy !== adj.cy) {
        g.goal = adj;
        g.path = [];
      }
      planStep(state, g);
      return;
    }

    case 'firing_laser': {
      // Robot-only: stand fast and shoot the target with a hitscan laser —
      // no chase, no range limit, so even a dragon on the wing is fair game.
      const target =
        s.targetKind === 'goblin' ? state.goblins.get(s.targetId)
        : s.targetKind === 'minotaur' ? state.minotaurs.get(s.targetId)
        : s.targetKind === 'lolly' ? (state.finale ? undefined : state.lolly ?? undefined)
        : state.dragons.get(s.targetId);
      // A vanished target (or somehow the shooter itself) stands the unit
      // down. A robot target stays valid: the beam fires and the chassis
      // soaks it with an "immune" floater below. Same for Lolly ('no effect').
      if (!g.robot || !target || (s.targetKind === 'goblin' && s.targetId === g.id)) {
        g.state = { kind: 'idle' };
        g.goal = null;
        g.path = [];
        return;
      }
      g.goal = null;
      g.path = [];
      // Track the target through the windup so the shot lands where they are,
      // not where they were when the order came in.
      g.facing = Math.atan2(target.pos.y - g.pos.y, target.pos.x - g.pos.x);
      if (s.fireAt === undefined) {
        // Charge-up beat — gives the renderer's glow flare a moment to read.
        // Terminators run on their own live dev dial, since the windup IS
        // their kill rate when auto-hunting.
        s.fireAt = state.now + (g.terminator
          ? getOptions().terminatorLaserWindup
          : ROBOT.laserWindup);
        return;
      }
      if (state.now < s.fireAt) return;
      pushLaserBeam(state, g.pos.x, g.pos.y - 6, target.pos.x, target.pos.y);
      // A terminator fires non-stop while prey remains — keep its report far
      // quieter than a one-off commanded robot shot or it dominates the mix.
      playSound('lightning', g.terminator ? 0.14 : 0.45, 2.1);
      // Robot-on-robot: the beam lands, the chassis doesn't care. And
      // anything-on-Lolly: she barely notices.
      if (s.targetKind === 'lolly') {
        lollyNoEffectFlash(state);
      } else if (s.targetKind === 'goblin' && (target as Goblin).robot) {
        robotImmuneFlash(state, target as Goblin);
        appendLog(state, `${g.terminator ? 'Terminator' : 'Robot'} #${g.id}'s laser washes off ${(target as Goblin).terminator ? 'Terminator' : 'Robot'} #${(target as Goblin).id}.`);
      } else {
        robotLaserKill(state, g, s.targetKind, s.targetId);
      }
      g.state = { kind: 'idle' };
      return;
    }

    case 'maintaining': {
      const b = state.buildings.get(s.buildingId);
      if (!b) { g.state = { kind: 'idle' }; g.goal = null; g.path = []; return; }
      // Visual-flair wander: every wander interval, try a single random step
      // to an adjacent free footprint cell. No goal, no pathfinding.
      g.goal = null;
      g.path = [];
      if (state.now >= s.nextWanderAt) {
        let chosen: Dir | null = null;
        if (b.kind === 'goblin_wheel') {
          // Walk clockwise around the 2×2 footprint — looks like a turning wheel.
          const d = wheelNextDir(b, g.cell);
          const nx = g.cell.cx + DX[d];
          const ny = g.cell.cy + DY[d];
          if (isCellInBuilding(b, nx, ny) && !isCellBlocked(state, nx, ny, g.id, b.id)) {
            chosen = d;
          }
        } else {
          const choices: Dir[] = [];
          for (const d of ALL_DIRS) {
            const nx = g.cell.cx + DX[d];
            const ny = g.cell.cy + DY[d];
            if (!isCellInBuilding(b, nx, ny)) continue;
            if (!canStep(state, g.cell.cx, g.cell.cy, nx, ny, g.id, b.id)) continue;
            choices.push(d);
          }
          if (choices.length > 0) chosen = choices[Math.floor(Math.random() * choices.length)];
        }
        if (chosen !== null) {
          const nx = g.cell.cx + DX[chosen];
          const ny = g.cell.cy + DY[chosen];
          occupyCell(state, nx, ny, g.id);
          g.target = { cx: nx, cy: ny };
          g.facing = Math.atan2(DY[chosen], DX[chosen]);
        }
        s.nextWanderAt = state.now + jitterInterval(b);
      }
      return;
    }
  }
}

// Direction to step from `cell` to the next cell on the clockwise loop
// around a 2×2 building footprint (top-left → top-right → bottom-right → bottom-left → ...).
function wheelNextDir(b: Building, cell: Cell): Dir {
  const lx = cell.cx - b.cell.cx;
  const ly = cell.cy - b.cell.cy;
  if (lx === 0 && ly === 0) return 2; // east
  if (lx === 1 && ly === 0) return 4; // south
  if (lx === 1 && ly === 1) return 6; // west
  return 0;                            // (0,1) → north
}

// Can a goblin step from (fx,fy) to (tx,ty) in one move? Validates the
// destination, and for diagonals also rejects corner-cutting through static
// obstacles (walls, buildings). Other goblins are *not* corner blockers — that
// would deadlock tight crowds (e.g. a goblin surrounded on all 4 cardinals).
function canStep(
  state: GameState,
  fx: number, fy: number,
  tx: number, ty: number,
  gid: number,
  exemptB: number | undefined,
): boolean {
  if (isCellBlocked(state, tx, ty, gid, exemptB)) return false;
  const dx = tx - fx;
  const dy = ty - fy;
  if (dx !== 0 && dy !== 0) {
    if (isCornerStaticBlocked(state, fx + dx, fy, exemptB)) return false;
    if (isCornerStaticBlocked(state, fx, fy + dy, exemptB)) return false;
  }
  return true;
}

function isCornerStaticBlocked(
  state: GameState,
  cx: number, cy: number,
  exemptB: number | undefined,
): boolean {
  if (!isInBounds(cx, cy)) return true;
  if (state.walls.has(cellKey(cx, cy))) return true;
  const b = buildingAtCell(state, cx, cy);
  if (b && b.id !== exemptB) return true;
  return false;
}

function jitterInterval(b: Building): number {
  const def = defOf(b);
  return def.wanderInterval + (Math.random() - 0.5) * 2 * def.wanderJitter;
}

function nearestExitCell(state: GameState, g: Goblin, b: Building): Cell | null {
  const perim = buildingPerimeter(b).slice();
  perim.sort((a, c) =>
    Math.hypot(a.cx - g.cell.cx, a.cy - g.cell.cy) -
    Math.hypot(c.cx - g.cell.cx, c.cy - g.cell.cy),
  );
  for (const c of perim) {
    if (!isCellBlocked(state, c.cx, c.cy, g.id)) return c;
  }
  return null;
}

// Concentric-ring depth of a footprint cell: 0 on the outer ring, increasing
// inward. Used by `going_to_build` to send arrivals to the deepest free spot.
function cellDepth(b: Building, cx: number, cy: number): number {
  const n = defOf(b).cellSize;
  const lx = cx - b.cell.cx;
  const ly = cy - b.cell.cy;
  return Math.min(lx, ly, n - 1 - lx, n - 1 - ly);
}

function maintainerSlot(state: GameState, b: Building, g: Goblin): Cell | null {
  const idx = b.assignedGoblins.indexOf(g.id);
  if (idx < 0) return null;
  const cells = buildingFootprint(b);
  const order = [cells[idx % cells.length], ...cells];
  for (const c of order) {
    if (c.cx === g.cell.cx && c.cy === g.cell.cy) return c;
    if (!isCellBlocked(state, c.cx, c.cy, g.id, b.id)) return c;
  }
  return null;
}

// ─── Pathfinding (BFS over the cell grid) ───────────────────────────
function preferredDir(from: Cell, to: Cell): Dir {
  const sx = Math.sign(to.cx - from.cx);
  const sy = Math.sign(to.cy - from.cy);
  for (const d of ALL_DIRS) {
    if (DX[d] === sx && DY[d] === sy) return d;
  }
  return 0;
}

function exemptBuildingFor(state: GameState, g: Goblin): number | undefined {
  const s = g.state;
  if (s.kind === 'going_to_maintain' || s.kind === 'going_to_build' ||
      s.kind === 'maintaining' || s.kind === 'building') return s.buildingId;
  const here = buildingAtCell(state, g.cell.cx, g.cell.cy);
  if (here) return here.id;
  return undefined;
}

function confineToBuildingFor(g: Goblin): number | undefined {
  return g.state.kind === 'maintaining' ? g.state.buildingId : undefined;
}

// Numeric cell key used inside BFS — avoids string allocation.
function nkey(cx: number, cy: number): number { return cy * COLS + cx; }

// Cardinals first, diagonals last. Every step costs 1 in this BFS, so
// cardinal and diagonal moves tie — and whichever neighbor is enqueued first
// claims the cell and freezes the prev-link. Visiting cardinals first means a
// straight-axis step wins ties over a diagonal that would happen to land on
// the same cell, so paths hug the axis instead of drifting "wide" before
// curving back.
const BFS_DIRS: Dir[] = [0, 2, 4, 6, 1, 3, 5, 7];

function bfsPath(
  state: GameState,
  gid: number,
  start: Cell,
  goal: Cell,
  exemptB: number | undefined,
  confineB: number | undefined,
): Cell[] | null {
  if (start.cx === goal.cx && start.cy === goal.cy) return [];
  const goalKey = nkey(goal.cx, goal.cy);
  const startKey = nkey(start.cx, start.cy);
  // BFS with a head pointer instead of Array.shift()
  const queue: number[] = [startKey];
  const prev = new Map<number, number>();
  prev.set(startKey, -1);
  let confineBuilding: Building | null = null;
  if (confineB !== undefined) confineBuilding = state.buildings.get(confineB) ?? null;
  for (let head = 0; head < queue.length; head++) {
    const curKey = queue[head];
    if (curKey === goalKey) {
      const path: Cell[] = [];
      let k = curKey;
      while (k !== startKey) {
        path.unshift({ cx: k % COLS, cy: (k - (k % COLS)) / COLS });
        const p = prev.get(k);
        if (p === undefined || p === -1) break;
        k = p;
      }
      return path;
    }
    const cx = curKey % COLS;
    const cy = (curKey - cx) / COLS;
    for (const d of BFS_DIRS) {
      const nx = cx + DX[d];
      const ny = cy + DY[d];
      const k = nkey(nx, ny);
      if (prev.has(k)) continue;
      if (confineBuilding && !isCellInBuilding(confineBuilding, nx, ny)) continue;
      if (!canStep(state, cx, cy, nx, ny, gid, exemptB)) continue;
      prev.set(k, curKey);
      queue.push(k);
    }
  }
  return null;
}

function planStep(state: GameState, g: Goblin) {
  if (g.target) return;
  if (!g.goal) return;
  if (g.cell.cx === g.goal.cx && g.cell.cy === g.goal.cy) {
    g.goal = null;
    g.path = [];
    return;
  }
  const exemptB = exemptBuildingFor(state, g);
  const confineB = confineToBuildingFor(g);

  // Validate the cached next step; recompute if missing or now blocked.
  let next: Cell | undefined = g.path[0];
  let needsReplan = false;
  if (!next) needsReplan = true;
  else if (!canStep(state, g.cell.cx, g.cell.cy, next.cx, next.cy, g.id, exemptB)) needsReplan = true;
  else if (confineB !== undefined) {
    const b = state.buildings.get(confineB);
    if (b && !isCellInBuilding(b, next.cx, next.cy)) needsReplan = true;
  }
  // Sanity: next must be a single 8-way step from current cell.
  if (next) {
    const adx = Math.abs(next.cx - g.cell.cx);
    const ady = Math.abs(next.cy - g.cell.cy);
    if (Math.max(adx, ady) !== 1) needsReplan = true;
  }

  if (needsReplan) {
    const path = bfsPath(state, g.id, g.cell, g.goal, exemptB, confineB);
    g.path = path ?? [];
    next = g.path[0];
  }

  if (!next) return; // no path right now; wait a tick

  occupyCell(state, next.cx, next.cy, g.id);
  g.target = next;
  g.facing = Math.atan2(next.cy - g.cell.cy, next.cx - g.cell.cx);
  g.path = g.path.slice(1);
}

// ─── Construction & power resolution ────────────────────────────────
function updateConstruction(state: GameState, b: Building) {
  if (b.state !== 'constructing') return;
  const def = defOf(b);
  let workers = 0;
  let robotWorkers = 0;
  for (const id of b.assignedGoblins) {
    const g = state.goblins.get(id);
    if (g && g.state.kind === 'building' && g.state.buildingId === b.id) {
      workers++;
      if (g.robot) robotWorkers++;
    }
  }
  if (workers < def.buildersRequired) return;
  // Each robot on the site compounds a ROBOT.buildTimeMult (0.7×) cut to the
  // build time — announced by the "fast build" floater when it set to work.
  const buildTime = def.buildTime * Math.pow(ROBOT.buildTimeMult, robotWorkers);
  b.buildProgress += TICK_S / buildTime;
  if (b.buildProgress >= 1) {
    b.buildProgress = 1;
    const keep = def.maintainersRequired;
    const newAssigned: number[] = [];
    let kept = 0;
    for (const gid of b.assignedGoblins) {
      const g = state.goblins.get(gid);
      if (!g) continue;
      // Robots never roll into maintaining — they bring nothing over a goblin
      // there (unlike builds), so they idle out instead and the auto-assign
      // sweep routes them to the next construction site within a couple of
      // seconds. A manual command can still put one on maintain duty.
      if (!g.robot && kept < keep) {
        newAssigned.push(gid);
        g.state = { kind: 'going_to_maintain', buildingId: b.id };
        kept++;
      } else {
        g.state = { kind: 'idle' };
      }
      g.path = [];
      g.goal = null;
    }
    b.assignedGoblins = newAssigned;
    // Buildings with no power draw and no maintainers (e.g. Goblin Hole)
    // skip resolvePowerAndState and stay where we put them, so finish them
    // straight to active.
    b.state = (def.maintainersRequired === 0 && def.powerOutput === 0) ? 'active' : 'dormant';
    b.activatedAt = state.now;
    playSound('build_done');
    appendLog(state, `${def.name} #${b.displayNum} construction complete.`);
  }
}

function resolvePowerAndState(state: GameState) {
  const buildings = [...state.buildings.values()];

  let production = 0;
  for (const b of buildings) {
    if (b.state === 'constructing') continue;
    const def = defOf(b);
    if (def.powerOutput <= 0) continue;
    const staffed = maintainerCount(state, b) >= def.maintainersRequired;
    setActiveOrDormant(state, b, staffed, undefined);
    if (b.state === 'active') production += def.powerOutput;
  }

  // Buildings hauled into space keep producing power for the grid below, free
  // of any maintainer / water / power upkeep — the same hands-off deal they get
  // on income. Only generators contribute; off-grid consumers draw nothing.
  for (const sb of state.spaceBuildings.values()) {
    if (sb.building.state === 'constructing') continue;
    const out = BUILDING_DEFS[sb.building.kind].powerOutput;
    if (out > 0) production += out;
  }

  // Lightning Strike surges add to the grid on top of building output, so a
  // strike can flick power-starved buildings online for the few seconds it
  // takes the surge to decay back to nothing.
  production += currentPowerBoost(state);

  // Each seated soul multiplies its portal's base output (1 W) by its own
  // strength multiplier (x66/x100/x144 — see soulStrengthOf). The base watt
  // itself was already counted in the building loop above, so only the
  // surplus is added here.
  const chairsPerPortal = new Map<number, SoulChair[]>();
  for (const c of state.soulChairs) {
    if (!c.occupied) continue;
    const list = chairsPerPortal.get(c.portalId);
    if (list) list.push(c); else chairsPerPortal.set(c.portalId, [c]);
  }
  for (const [portalId, chairs] of chairsPerPortal) {
    const portal = state.buildings.get(portalId);
    if (!portal || portal.state === 'constructing') continue;
    const base = defOf(portal).powerOutput;
    production += sigilPortalOutput(base, chairs) - base;
  }

  let consumed = 0;
  for (const b of buildings) {
    if (b.state === 'constructing') continue;
    const def = defOf(b);
    if (def.powerOutput >= 0) continue;
    const draw = -def.powerOutput;
    const staffed = maintainerCount(state, b) >= def.maintainersRequired;
    // DC counts as watered only with at least one EFFECTIVE carrier (one
    // who has completed a full source → DC loop). Carriers mid-first-loop
    // are already counted in waterCarrierCount so they don't trigger more
    // assignments, but they don't make the DC operational.
    // New mechanic: a building with `waterDeliveryAmount` is watered while
    // its meter is > 0. Carriers replenish on each delivery and the meter
    // depletes between deliveries.
    const drinks = (def.waterDeliveryAmount ?? 0) > 0;
    const watered = !drinks || (b.waterMeter ?? 0) > 0;
    let reason: 'no_staff' | 'no_power' | 'no_water' | undefined;
    let active = false;
    if (!staffed) reason = 'no_staff';
    else if (!watered) reason = 'no_water';
    else if (consumed + draw > production) reason = 'no_power';
    else { active = true; consumed += draw; }
    setActiveOrDormant(state, b, active, reason);
  }

  // Space consumers draw from the same grid as ground consumers — orbit
  // doesn't free a building from its power link. Evaluated after ground
  // buildings so the local lights stay on first; any excess capacity then
  // feeds the orbiting fleet. Income for space buildings (in the per-second
  // loop above) skips dormant ones, so an underpowered space Hypercentre
  // earns nothing until the grid catches back up.
  for (const sb of state.spaceBuildings.values()) {
    const b = sb.building;
    // A Space Centre still under robot assembly isn't on the grid yet — it
    // neither draws power nor gets flipped active here.
    if (b.state === 'constructing') continue;
    // Dragon Beacons in orbit are inert ("Useless Beacons") — they neither
    // draw power nor summon anything. Skip them entirely so they don't
    // silently siphon 10 GW from the grid.
    if (b.kind === 'dragon_beacon') { b.state = 'dormant'; continue; }
    const def = BUILDING_DEFS[b.kind];
    if (def.powerOutput >= 0) continue;
    const draw = -def.powerOutput;
    // A Space Centre needs its one-robot crew on deck (maintainersRequired);
    // unstaffed it goes dark and stops drawing from the grid until a robot
    // parks back on the rim.
    if (b.kind === 'space_centre' && !spaceCentreMaintained(state, sb)) {
      if (b.state === 'active') {
        b.state = 'dormant';
        appendLog(state, `${def.name} #${b.displayNum} goes dark — needs a robot maintainer on deck.`);
        pushFloater(state, sb.pos.x, sb.pos.y - POWER_FLOATER_Y_OFFSET, `+${formatPower(draw)}`, 0x8acfff, 1.6, undefined, true);
      }
      continue;
    }
    const wasActive = b.state === 'active';
    const fits = consumed + draw <= production;
    if (fits) {
      consumed += draw;
      if (!wasActive) {
        b.state = 'active';
        appendLog(state, `${def.name} #${b.displayNum} re-establishes its power link from orbit.`);
        pushFloater(state, sb.pos.x, sb.pos.y - POWER_FLOATER_Y_OFFSET, `-${formatPower(draw)}`, 0x8acfff, 1.6, undefined, true);
      }
    } else {
      if (wasActive) {
        b.state = 'dormant';
        appendLog(state, `${def.name} #${b.displayNum} goes dark — orbital power link severed.`);
        pushFloater(state, sb.pos.x, sb.pos.y - POWER_FLOATER_Y_OFFSET, `+${formatPower(draw)}`, 0x8acfff, 1.6, undefined, true);
      }
    }
  }

  state.lastPowerProduced = production;
  state.lastPowerConsumed = consumed;
}

function setActiveOrDormant(
  state: GameState,
  b: Building,
  active: boolean,
  reason: 'no_staff' | 'no_power' | 'no_water' | undefined,
) {
  const def = defOf(b);
  if (active) {
    if (b.state !== 'active') {
      b.state = 'active';
      playSound('online');
      appendLog(state, `${def.name} #${b.displayNum} online.`);
      const c = buildingCenter(b);
      // Raise power floaters above the building center so they don't pile up
      // under the gold "+Ƶ" income floater that spawns at the same point.
      if (def.powerOutput > 0) {
        pushFloater(state, c.x, c.y - POWER_FLOATER_Y_OFFSET, `+${formatPower(def.powerOutput)}`, 0x8acfff, 1.6);
      } else if (def.powerOutput < 0) {
        pushFloater(state, c.x, c.y - POWER_FLOATER_Y_OFFSET, `-${formatPower(-def.powerOutput)}`, 0x8acfff, 1.6);
      }
    }
  } else {
    if (b.state !== 'dormant') {
      b.state = 'dormant';
      const why =
        reason === 'no_power' ? 'underpowered' :
        reason === 'no_water' ? 'needs water' :
        `needs ${def.maintainersRequired} maintainer${def.maintainersRequired === 1 ? '' : 's'}`;
      appendLog(state, `${def.name} #${b.displayNum} dormant — ${why}.`);
      // A thirsty building (DC/HC) that just ran dry stops drawing its load —
      // surface the power it freed back to the grid. The matching watered →
      // online draw is shown by the activation floater above.
      if (reason === 'no_water' && def.powerOutput < 0) {
        const c = buildingCenter(b);
        pushFloater(state, c.x, c.y - POWER_FLOATER_Y_OFFSET, `+${formatPower(-def.powerOutput)}`, 0x8acfff, 1.6);
      }
    }
  }
}
