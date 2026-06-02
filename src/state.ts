import {
  BASE_SPAWN_CAPACITY, BUILDING_DEFS, BuildingDef, BuildingKind, CELL, COLS,
  DEMON, DIG_GROWTH_CELLS, GOBLIN_HOLE_CAPACITY_PER_BUILDING, HELL, ROWS, SOUL_SIGIL,
  INITIAL_PLAY_COLS, INITIAL_PLAY_ROWS, INITIAL_PLAY_X0, INITIAL_PLAY_Y0,
  START_CELL, START_GOBLINS, START_MONEY, WALL_BORDER, WORLD, formatPower,
} from './config';

export type Vec2 = { x: number; y: number };
export type Cell = { cx: number; cy: number };
// 8-way direction, clockwise from north. Even indices are cardinals.
export type Dir = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

export const DX: Record<Dir, number> = { 0: 0, 1: 1, 2: 1, 3: 1, 4: 0, 5: -1, 6: -1, 7: -1 };
export const DY: Record<Dir, number> = { 0: -1, 1: -1, 2: 0, 3: 1, 4: 1, 5: 1, 6: 0, 7: -1 };
export const ALL_DIRS: Dir[] = [0, 1, 2, 3, 4, 5, 6, 7];
export const CARDINAL_DIRS: Dir[] = [0, 2, 4, 6];
export function isDiagonal(d: Dir): boolean { return (d & 1) === 1; }

export type GoblinState =
  | { kind: 'idle' }
  | { kind: 'moving' }
  | { kind: 'going_to_build'; buildingId: number }
  | { kind: 'going_to_maintain'; buildingId: number }
  | { kind: 'building'; buildingId: number; nextWanderAt?: number }
  | { kind: 'maintaining'; buildingId: number; nextWanderAt: number }
  // Water carrier — cycles between a Datacentre and a water source. A
  // carrier only "waters" the DC after completing their first round trip
  // (source → DC); waterCarrierCount ignores carriers with firstLoopDone=false.
  // The optional initialTarget is the exact cell the player right-clicked,
  // used only for the first walk to the source; subsequent trips fall back
  // to the closest cell within the source region.
  // collectingSince records when the goblin first stepped into the water on
  // the current trip; they have to dwell for 1s before phase flips to to_dc.
  | { kind: 'fetching_water'; buildingId: number; sourceId: number; phase: 'to_source' | 'to_dc'; firstLoopDone?: boolean; initialTarget?: Cell; collectingSince?: number }
  | { kind: 'going_to_kill'; targetId: number; attackAt?: number };

export type Goblin = {
  id: number;
  pos: Vec2;
  cell: Cell;
  target: Cell | null;
  goal: Cell | null;
  path: Cell[];           // BFS-cached remaining cells from current toward goal
  facing: number;
  state: GoblinState;
  selected: boolean;
  idleSince: number | null; // game time when the current idle streak began
  // game time when this goblin's `cell` last changed (not pos — pos updates
  // every tick mid-step). Used by water-duty stuck detection: if a carrier
  // hasn't progressed a full cell in 3s, drop the role.
  lastCellChangedAt: number;
  // Rolled at spawn time when Goldgoblins is owned. Gold goblins render with
  // a yellow tint and drop GOLD_KILL_REWARD instead of the usual KILL_REWARD.
  gold?: boolean;
  // The unique "bob" goblin summoned from the post-15-buildings cutscene.
  // Renders with a yellow "bob" nametag above his head; otherwise behaves
  // exactly like a normal goblin. Dies once like any goblin; his ghost in
  // hell stays still rather than drifting.
  bob?: boolean;
  // state.now when another unit was last commanded onto this one. The renderer
  // flashes the selection ring once so the player sees their command target.
  commandFlashAt?: number;
};

export type MinotaurState =
  | { kind: 'wander' }
  | { kind: 'moving_to'; goal: Cell }
  | { kind: 'going_to_kill'; targetId: number; attackAt?: number }
  | { kind: 'going_to_kill_minotaur'; targetId: number; attackAt?: number }
  | { kind: 'going_to_destroy'; buildingId: number; attackAt?: number };

// A discovered water source — fills a rectangular region (the far third of
// the dug arm). Goblins on water duty cycle between any cell inside the
// region and the Datacentre.
export type WaterSource = {
  id: number;
  x0: number; y0: number;
  x1: number; y1: number;   // exclusive upper bounds
  selected: boolean;
};

export function isCellInWaterSource(w: WaterSource, c: Cell): boolean {
  return c.cx >= w.x0 && c.cx < w.x1 && c.cy >= w.y0 && c.cy < w.y1;
}

export function waterSourceAtCell(state: GameState, c: Cell): WaterSource | null {
  for (const w of state.waterSources.values()) {
    if (isCellInWaterSource(w, c)) return w;
  }
  return null;
}

// Closest cell inside `w` (clamped to its bounds) to `from`.
export function nearestCellInWaterSource(w: WaterSource, from: Cell): Cell {
  const cx = Math.min(w.x1 - 1, Math.max(w.x0, from.cx));
  const cy = Math.min(w.y1 - 1, Math.max(w.y0, from.cy));
  return { cx, cy };
}

// A demon — an uncommandable denizen of hell. For now a single giant Minotaur
// that paces slowly up and down. Lives entirely in hell coordinates (no grid).
// The player can only "parlay" with one by walking a goblin ghost up to it.
export type Demon = {
  id: number;
  kind: 'minotaur';
  hx: number; hy: number;   // absolute hell coordinates
  facing: number;           // radians (south = pacing downward)
  dir: 1 | -1;              // +1 pacing down, -1 pacing up
  y0: number; y1: number;   // patrol bounds (hell-y)
  selected: boolean;
  // The "speak to me, damned soul" greeting only plays the very first time any
  // soul parlays with this demon; it's skipped on every parlay afterwards.
  greeted: boolean;
  // Set after this demon's first failed parlay, when his brush-off ends with an
  // extra "try another" nudge. The extra line only ever plays once.
  hintedTryAnother: boolean;
  // Id of the ghost currently mid-parlay, or null. Only one soul may speak at a
  // time; while set the demon stands still and faces the speaker.
  busyWith: number | null;
  // state.now when a soul was last commanded onto this demon — flashes its ring.
  commandFlashAt?: number;
};

export type Minotaur = {
  id: number;
  pos: Vec2;
  cell: Cell;
  target: Cell | null;    // pixel-lerp target cell (mid-step)
  facing: number;
  state: MinotaurState;
  nextWanderAt: number;
  selected: boolean;
  // Stuck detection: minotaurs only step greedily (Chebyshev-toward-target)
  // with no real pathfinding, so an obstacle can trap them ping-ponging in a
  // tiny area. We periodically sample the cell and bail back to `wander`
  // when the sample stays inside a small box for too long. See updateMinotaur.
  stuckSampleCell: Cell | null;
  stuckSampleAt: number;
  stuckStreak: number;
  // Tinytaur variant: a tiny, much faster Minotaur. Shares all Minotaur
  // behaviour except movement/attack speed and render scale.
  tiny?: boolean;
  // state.now when another unit was last commanded onto this one — flashes its ring.
  commandFlashAt?: number;
};

// Dragon — a flying, grid-free creature summoned from a Dragon Beacon. See
// updateDragon in sim.ts for the behaviour of each state.
export type DragonState =
  // Default: fly to the single most valuable building, hoist it, climb to space.
  | { kind: 'seeking' }
  // Parked over a target building, counting down DRAGON.liftHover before the lift.
  | { kind: 'hovering_to_lift'; buildingId: number; liftAt: number }
  // Carrying a lifted building straight up; once past DRAGON.spaceY it's gone.
  | { kind: 'carrying' }
  // Carrying a building to a ground drop-off: fly to the goal and set it back
  // down if there's room (otherwise haul it on up to space).
  | { kind: 'delivering'; goal: Vec2 }
  // Commanded: fly to a free-floating world point, loiter there for
  // DRAGON.moveLingerTime once arrived (lingerUntil), then revert to seeking.
  | { kind: 'moving_to'; goal: Vec2; lingerUntil?: number }
  // Commanded: fly up to a unit and incinerate it, then revert to seeking.
  // A dragon target is fratricide — the victim drops a Dragon Bone.
  | { kind: 'going_to_kill'; targetKind: 'goblin' | 'minotaur' | 'dragon'; targetId: number; attackAt?: number }
  // Commanded: hoist one specific building (even the Beacon) up to space.
  | { kind: 'going_to_building'; buildingId: number }
  // Entrance animation: spawned far above the goal and flies down fast. On
  // arrival flips to `seeking` with spawnAt reset, so the usual seek-delay
  // hover beat starts from the landing rather than from the summon click.
  | { kind: 'swooping_in'; goal: Vec2 };

export type Dragon = {
  id: number;
  pos: Vec2;
  facing: number;        // -1 faces left, +1 faces right (sprite mirror)
  state: DragonState;
  // The building this dragon has lifted off the grid, en route to space.
  // Held here (removed from state.buildings) until it crosses into space.
  carrying: Building | null;
  selected: boolean;
  spawnAt: number;       // wing-flap phase offset / entry timing
  // state.now when another unit was last commanded onto this one — flashes its ring.
  commandFlashAt?: number;
};

// A building a dragon has hauled into space. No longer on the grid: it drifts
// freely within the space scene and needs no water/maintainers/power — it just
// keeps paying its income. pos/vel are in space-scene px.
export type SpaceBuilding = {
  id: number;            // reuses the lifted building's id
  building: Building;    // original building data (kind, etc.)
  pos: Vec2;
  vel: Vec2;
  spin: number;          // current render rotation (radians)
  spinRate: number;      // radians/sec
  selected: boolean;
  nextIncomeAt?: number;
};

export type BuildingState = 'constructing' | 'active' | 'dormant';

export type Building = {
  id: number;
  // Within-kind ordinal stamped at creation (1, 2, 3, …) — what the player sees
  // in logs and the info panel. Independent of `id`, which is a global monotonic
  // counter shared with goblins/minotaurs/dragons and reads as confusingly high
  // by the time the player builds their second Hypercentre.
  displayNum: number;
  kind: BuildingKind;
  cell: Cell;
  state: BuildingState;
  buildProgress: number;
  assignedGoblins: number[];
  selected: boolean;
  // Wall-clock time (state.now) of this building's next income payout.
  // Income arrives in discrete one-second chunks; the phase is anchored to
  // when the building first became active, so buildings placed at different
  // times pay on different ticks. Undefined until the first active tick.
  nextIncomeAt?: number;
  // state.now when this building first finished constructing — used by the
  // Hell Portal beam (overworld + hell side) to time its draw-in animation.
  // Undefined until construction completes.
  activatedAt?: number;
  // 0..100 percent. For buildings with `waterDeliveryAmount`, depletes at
  // WATER_DEPLETION_PP_PER_SEC; each carrier delivery bumps it by the def's
  // delivery amount. The building counts as "watered" while > 0.
  waterMeter?: number;
  // state.now when a unit was last commanded onto this building — flashes its ring.
  commandFlashAt?: number;
};

export type PendingBuild = { kind: BuildingKind } | null;

// Short-lived floating text drawn at a world position — used for kill rewards,
// income ticks, power going online, etc. Removed by the renderer once aged out.
export type Floater = {
  id: number;
  x: number; y: number;
  text: string;
  color: number;
  spawnAt: number;
  lifetime: number;
  // When set, the renderer ignores `text` and recomputes a GW readout each
  // frame that ticks down from this peak to 0 across the floater's lifetime
  // (the Lightning Strike power surge). In watts.
  powerCountdownWatts?: number;
  // Floaters over space buildings live in the space scene (panned by the space
  // camera) rather than the ground world layer.
  space?: boolean;
  // Floaters in the hell scene (the soul-chair power surge) carry hell
  // coordinates and ride the hell transform rather than the ground layer.
  hell?: boolean;
};

// One-shot blood-explosion GIF effect played at a world position. The Lightning
// Strike marks its splatters `white` so the renderer draws them as a pale
// silhouette instead of the usual blood color. Splatters flagged `hell` ride
// in the hell scene at the world→hell-mapped position — the "born in blood"
// counterpart to dying in the overworld.
export type DeathEffect = {
  id: number;
  x: number; y: number;
  spawnAt: number;
  white?: boolean;
  hell?: boolean;
};

// A ghost of a unit the player has killed — surfaced in Hell as a silhouette
// that drifts slowly downward from the world-x/y where the unit died until it
// disappears off the bottom of the hell scene. Persisted across saves so the
// underworld never forgets. `facing` is radians for goblin/minotaur and ±1
// (sprite mirror) for dragons, matching the live unit's facing field.
// `spawnAt` is state.now at recording; the renderer uses (state.now - spawnAt)
// to derive the current y drift, and the sim prunes ghosts that have fallen
// past the bottom of HELL.
export type Ghost = {
  id: number;
  kind: 'goblin' | 'minotaur' | 'dragon';
  x: number; y: number;
  facing: number;
  spawnAt: number;
  gold?: boolean;
  tiny?: boolean;
  // True for the ghost of the cutscene-summoned Bob. Hell Bob doesn't drift
  // downward — until his first player command he idly paces left and right
  // around where he died (see paceBobGhost in sim.ts), yellow nametag intact.
  bob?: boolean;
  // Small per-ghost jitter so a cluster of ghosts doesn't render exactly stacked
  // and doesn't all drift at the same speed. Set once at spawn; persisted.
  offX?: number;
  offY?: number;
  speedMult?: number;
  // Selection + walk-command state for the hell view. `hx/hy` are absolute hell
  // coordinates (only set once the ghost has been interacted with or commanded);
  // when set, they're the source of truth instead of the spawnAt+drift formula.
  // `goal` is a hell-coord destination — the ghost walks to it at HELL_GHOST_WALK_SPEED.
  selected?: boolean;
  hx?: number;
  hy?: number;
  goal?: { x: number; y: number };
  // When commanded to parlay, the id of the target demon. The ghost is steered
  // toward the demon's live position each tick; the conversation opens once it's
  // within DEMON.parlayRadius. Cleared the instant the parlay begins. Ephemeral
  // — reset on load so a half-issued command never auto-triggers on resume.
  parlayDemonId?: number;
  // When commanded onto a soul chair, the id of that chair. The ghost walks to
  // it and is consumed (seated) on arrival. Ephemeral — reset on load.
  targetChairId?: number;
  // Set the first time the player issues this ghost any command (walk, parlay,
  // chair). Bob's ghost idle-paces only until then; selection alone (which also
  // seeds hx/hy) doesn't count as a command and leaves him pacing.
  commanded?: boolean;
  // Bob's idle-pacing state (see paceBobGhost in sim.ts): the hell-x he paces
  // around, the leg direction, and when the end-of-leg pause finishes.
  paceAnchorX?: number;
  paceDir?: 1 | -1;
  pacePauseUntil?: number;
};

// A "soul chair" in an abyssal sigil. Five sit ringed around a Hell Portal's
// mirror; seating a soul in one powers it. With all five of that portal's chairs
// filled the pentagram is complete and they feed the grid. See SOUL_SIGIL.
export type SoulChair = {
  id: number;
  portalId: number;     // the hell_portal building this chair's sigil rings
  index: number;        // 0..4 position around the ring (drives the pentagram edges)
  hx: number; hy: number;
  occupied: boolean;
  filledAt?: number;    // state.now when seated — drives the seat-in VFX
  // Ephemeral: id of the soul currently walking to claim this chair, so a crowd
  // command only ever sends a single soul. Reset on load.
  claimedBy?: number;
  // Selection state for the hell info panel. Ephemeral — reset on load.
  selected?: boolean;
};

// One-shot jagged white bolt drawn from above down to a strike point. The
// polyline is precomputed at spawn so it doesn't reshuffle every frame.
export type LightningBolt = {
  id: number;
  points: Vec2[];
  spawnAt: number;
  lifetime: number;
};

// A decaying power surge (Lightning Strike). Contributes `peak` watts at
// spawn, ramping linearly to 0 over `duration` seconds.
export type PowerBoost = {
  startAt: number;
  peak: number;
  duration: number;
};

// The Goblin Hole — a 1×1 spawn point. Goblins emerge from cells around it.
// Buildings CAN be placed on top of the hole's cell; while one is, new spawns
// are blocked until the building is destroyed.
export const HOLE_SIZE = 1;
export type Hole = {
  cell: Cell;
  selected: boolean;
};

// Total in-flight spawn slots: base + GOBLIN_HOLE_CAPACITY_PER_BUILDING per
// completed Goblin Hole building. Computed fresh each tick so the spawn queue
// always reflects the latest infrastructure.
export function getSpawnCapacity(state: GameState): number {
  let cap = BASE_SPAWN_CAPACITY;
  for (const b of state.buildings.values()) {
    if (b.kind === 'goblin_hole' && b.state !== 'constructing') cap += GOBLIN_HOLE_CAPACITY_PER_BUILDING;
  }
  return cap;
}

export type GameState = {
  money: number;
  // Blood is earned by killing goblins. Once any blood is earned in this run
  // `bloodUnlocked` flips true and the resource row stays visible (sticky).
  blood: number;
  bloodUnlocked: boolean;
  // Dragon Bones — dropped when one dragon incinerates another. Rare; the
  // resource row stays hidden until the first bone is collected (sticky).
  dragonBone: number;
  dragonBoneUnlocked: boolean;
  // Cumulative gains only (income + kill rewards), never decremented by
  // spending. The per-second rate readouts derive from these so they reflect
  // earning rate and ignore money/blood spent on buildings, summons, etc.
  moneyEarned: number;
  bloodEarned: number;
  dragonBoneEarned: number;
  goblins: Map<number, Goblin>;
  minotaurs: Map<number, Minotaur>;
  dragons: Map<number, Dragon>;
  // Uncommandable hell denizens. Persisted so a demon's patrol position and
  // whether it has already greeted a soul survive a reload.
  demons: Map<number, Demon>;
  // Soul chairs across every portal's sigil (five per Hell Portal). Persisted so
  // seated souls stick. Reconciled with the live portals via syncSoulChairs.
  soulChairs: SoulChair[];
  // Per-portal completion: state.now when a portal's fifth chair was seated and
  // its pentagram lit, keyed by portalId. Drives the completed-sigil VFX and the
  // +25 GW-per-sigil payout. Absent until that portal's sigil completes.
  soulSigilCompletedAt: Map<number, number>;
  // state.now of the first time the player entered hell; undefined until then.
  // Anchors the "demons parlay with talking goblins" nudge.
  firstHellVisitAt?: number;
  // Set once Bob has actually parlayed with a demon — gates the hint above.
  bobParlayed: boolean;
  // Set once the "talking goblins" hint has fired, so it only shows once.
  hellHintShown: boolean;
  waterSources: Map<number, WaterSource>;
  buildings: Map<number, Building>;
  // Monotonic counter bumped whenever the set of buildings — or any building's
  // footprint cell — changes. The cell→building spatial index (buildingAtCell)
  // rebuilds lazily when this moves, so the index never goes stale. Always go
  // through markBuildingsChanged() when mutating `buildings` or a building's
  // `cell`, never touch the Map directly.
  buildingsVersion: number;
  // Buildings hauled into space by dragons — keyed by the original building id.
  spaceBuildings: Map<number, SpaceBuilding>;
  hole: Hole;
  // Ritual upgrades — sticky once bought, apply game-wide.
  autoAssignEnabled: boolean;
  autoSpawnEnabled: boolean;
  // Extends Autobuild: when on, idle goblins are also auto-routed onto
  // watering duty for thirsty buildings. Requires autoAssignEnabled.
  autoWaterEnabled: boolean;
  goldgoblinsEnabled: boolean;
  // Secret summon: flips true once the player has fielded TINYTAUR.minotaurCost
  // Minotaurs at once (checked in the sim tick). Sticky.
  tinytaurUnlocked: boolean;
  // Stat: the most units ever killed by a single Lightning Strike. Sticky
  // (only ever increases).
  maxStruckAtOnce: number;
  // Sticky: flips true once the player has vaporised two or more dragons with a
  // single Lightning Strike. (Legacy: no longer read by the demon parlay.)
  slewTwoDragonsInOneStrike: boolean;
  // Sticky: the Lightning Strike ritual. Granted solely by a truthful demon
  // parlay (Bob owning a dragon bone); never unlocked any other way.
  lightningUnlocked: boolean;
  // Number of Minotaurs summoned this run — drives the doubling summon cost.
  minotaursBought: number;
  // Multiplier applied to a gold goblin's GOLD_KILL_REWARD.money on death.
  // 1 by default; 10 once Goldgoblins x10 is purchased.
  goldgoblinMultiplier: number;
  autoSpawnTimer: number;
  // Increments per goblin spawn so successive goblins emerge from a different
  // hole (main + each completed Goblin Hole building, round-robin).
  spawnHoleRotation: number;
  autoSpawnMultiplier: number; // 1 baseline; 2 with x2; 4 with x4
  // Set of dig directions already purchased ('n'|'e'|'s'|'w'); each expands
  // the play area by DIG.cells in that direction and reveals a water source.
  dugDirections: Set<'n' | 'e' | 's' | 'w'>;
  // Bounds of the currently-walkable rectangle. Walls fill everything else.
  playArea: { x0: number; y0: number; x1: number; y1: number };
  floaters: Floater[];
  deathEffects: DeathEffect[];
  lightningBolts: LightningBolt[];
  // Active Lightning Strike power surges, summed into production each tick.
  powerBoosts: PowerBoost[];
  // True while the player is aiming a Lightning Strike (next map click fires
  // it). Ephemeral — never meaningfully persisted.
  pendingStrike: boolean;
  // Seconds remaining on the Lightning Strike cooldown after a successful
  // strike. Ticks down in the sim; the button is disabled while > 0.
  lightningStrikeCooldown: number;
  // Currently-selected ambient (background) dragon — renderer-owned cosmetic
  // dragons that the player can click for a "Distant dragon" popup but never
  // command. Null when nothing is picked. The renderer clears it when the
  // matching dragon despawns so the info panel never references a ghost.
  selectedAmbientDragonId: number | null;
  spawnQueue: { remaining: number; slot: number }[];
  minotaurSpawnQueue: { remaining: number }[];
  dragonSpawnQueue: { remaining: number }[];
  pendingBuild: PendingBuild;
  // Per-kind ordinal counters; incremented at building creation to stamp
  // Building.displayNum. Monotonic — destroying a building does NOT free up its
  // number, so the player sees "#2", "#3", "#4" even if #2 was smashed.
  buildingCounts: Record<BuildingKind, number>;
  log: { time: number; msg: string }[];
  occupancy: Map<string, number>;
  walls: Set<string>;     // permanently impassable cells (mutated by Dig)
  wallsVersion: number;   // bumped whenever `walls` changes — render redraws
  nextId: number;
  now: number;
  // Snapshot of last tick's power balance for display.
  lastPowerProduced: number;
  lastPowerConsumed: number;
  // Tutorial counters (cumulative — only ever increase).
  spawnsCompleted: number;
  // Pan-hint state: `firstDugAt` is the state.now timestamp of the player's
  // first successful dig (null until then). `waterSeen` flips sticky-true the
  // first frame any water source intersects the viewport. The hint appears
  // WATER_HINT_DELAY_SEC after firstDugAt, and disappears forever once the
  // player has actually looked at the water.
  firstDugAt: number | null;
  waterSeen: boolean;
  // Drag-select onboarding state. Flips sticky-true the first time the player
  // performs a drag-rectangle that picks up 2+ creatures; used to gate the
  // "Hint: drag to choose many creatures" nudge in refreshUI.
  multiSelectSeen: boolean;
  // Multi-spawn onboarding state. Flips sticky-true the first time the player
  // has 2+ goblins queued to spawn concurrently; gates the "queue several
  // goblins at once" nudge in refreshUI.
  multiSpawnSeen: boolean;
  // In production builds the options cog is hidden until the demon's gift to a
  // truthful Bob fires the demo-end gag (see revealSecretSettings) — or the
  // shift-click / long-press R reveal gesture. Sticky once flipped.
  optionsUnlocked: boolean;
  // Sticky: flips true the first time a building reaches space. Gates the
  // "hold ↑ at the top of the map to rise into space" affordance.
  spaceUnlocked: boolean;
  // Sticky: flips true the first time a Hell Portal is placed. Gates the
  // "hold ↓ at the bottom of the map to descend into hell" affordance.
  hellUnlocked: boolean;
  // Sticky once the player has accepted the Bob cutscene (the "tag me in
  // boss?" prompt that fires after the 20th building). Stays true even after
  // Bob dies, so the cutscene never re-offers.
  bobSpawned: boolean;
  // True between the player clicking "Okay" in the cutscene and clicking a
  // Goblin Hole to seat Bob. Every hole pulses yellow during this state and
  // a click on one summons Bob.
  bobPickingHole: boolean;
  // Dev cheat: when true, the next building placement triggers the Bob
  // cutscene regardless of the 20-building threshold or bobSpawned state.
  // Self-clearing once the cutscene fires.
  bobCheatPending: boolean;
  // Ghosts of every unit the player has killed (goblin, minotaur, dragon),
  // displayed in Hell as static silhouettes at the world-x/y where they died.
  ghosts: Ghost[];
  // Which scene the player is currently looking at. Ephemeral — always reset to
  // 'ground' on load; scene transitions live entirely in the renderer.
  view: 'ground' | 'space' | 'hell';
  // Persisted UI unlock progress (the sticky sets that live in ui.ts). Saved so
  // tutorial unlocks, the dig gate, and "outgrown" hides survive a reload even
  // after the buildings that triggered them are gone. ui.ts hydrates its module
  // sets from this on load and writes them back each refresh. Optional for
  // back-compat with pre-existing saves.
  unlocks?: UnlockState;
};

export type UnlockState = {
  completed: Set<string>;       // completedTaskIds
  revealed: Set<string>;        // revealedTaskIds
  obsoleted: Set<BuildingKind>; // obsoletedKinds
  everBuilt: Set<BuildingKind>; // everBuiltKinds
  minotaurEverSummoned: boolean;
};

export function defOf(b: Building): BuildingDef { return BUILDING_DEFS[b.kind]; }

// Build a counts map seeded to zero for every defined kind. New-game init and
// pre-buildingCounts save migration both need this.
export function emptyBuildingCounts(): Record<BuildingKind, number> {
  const counts = {} as Record<BuildingKind, number>;
  for (const k of Object.keys(BUILDING_DEFS) as BuildingKind[]) counts[k] = 0;
  return counts;
}

// Bump the per-kind counter and return the next within-kind ordinal. Callers
// stamp the result onto a freshly-created Building's `displayNum`.
export function nextBuildingDisplayNum(state: GameState, kind: BuildingKind): number {
  const next = (state.buildingCounts[kind] ?? 0) + 1;
  state.buildingCounts[kind] = next;
  return next;
}

// Human-readable label for a building reference held by goblin/dragon state.
// Falls back to a bare `#id` if the building has been destroyed mid-tick (the
// describe-state helpers can be called between sim and render).
export function buildingLabel(state: GameState, buildingId: number): string {
  const b = state.buildings.get(buildingId);
  if (!b) return `#${buildingId}`;
  return `${BUILDING_DEFS[b.kind].name} #${b.displayNum}`;
}

export function cellKey(cx: number, cy: number): string { return `${cx},${cy}`; }

export function cellCenter(c: Cell): Vec2 {
  return { x: c.cx * CELL + CELL / 2, y: c.cy * CELL + CELL / 2 };
}

export function pixelToCell(x: number, y: number): Cell {
  return { cx: Math.floor(x / CELL), cy: Math.floor(y / CELL) };
}

export function isInBounds(cx: number, cy: number): boolean {
  return cx >= 0 && cy >= 0 && cx < COLS && cy < ROWS;
}

export function buildingFootprint(b: Building): Cell[] {
  const out: Cell[] = [];
  const n = defOf(b).cellSize;
  for (let dx = 0; dx < n; dx++) {
    for (let dy = 0; dy < n; dy++) {
      out.push({ cx: b.cell.cx + dx, cy: b.cell.cy + dy });
    }
  }
  return out;
}

export function buildingCenter(b: Building): Vec2 {
  const n = defOf(b).cellSize;
  return cellCenter({
    cx: b.cell.cx + (n - 1) / 2,
    cy: b.cell.cy + (n - 1) / 2,
  });
}

export function isCellInBuilding(b: Building, cx: number, cy: number): boolean {
  const n = defOf(b).cellSize;
  return cx >= b.cell.cx && cx < b.cell.cx + n &&
         cy >= b.cell.cy && cy < b.cell.cy + n;
}

// ─── Cell→building spatial index ────────────────────────────────────
// buildingAtCell used to scan every building on every call. It sits in the
// pathfinding hot loop (canStep → isCellBlocked → buildingAtCell), so with a
// busy late-game map — many buildings, plus a Hypercentre's swarm of water
// carriers each re-running BFS — that linear scan dominated tick time. We now
// keep a cell→building lookup, rebuilt lazily only when buildingsVersion moves.
//
// Module-scoped (not on GameState) so it never serializes into a save. Tagged
// with the owning state + its buildingsVersion so a fresh state from load, or
// any building add/remove/move, transparently triggers a rebuild.
let biCache: Map<number, Building> | null = null;
let biState: GameState | null = null;
let biVersion = -1;

// Bump after any change to `state.buildings` or a building's footprint `cell`.
// The next buildingAtCell call rebuilds the index from scratch.
export function markBuildingsChanged(state: GameState): void {
  state.buildingsVersion++;
}

function buildingIndex(state: GameState): Map<number, Building> {
  if (biCache && biState === state && biVersion === state.buildingsVersion) return biCache;
  const idx = new Map<number, Building>();
  for (const b of state.buildings.values()) {
    const n = defOf(b).cellSize;
    for (let dx = 0; dx < n; dx++) {
      for (let dy = 0; dy < n; dy++) {
        const k = (b.cell.cy + dy) * COLS + (b.cell.cx + dx);
        const existing = idx.get(k);
        // Goblin Holes sit at "ground level" — other buildings can be placed on
        // top of them. A non-hole building stacked on a hole wins the cell;
        // the hole only shows through where nothing else covers it.
        if (!existing || (existing.kind === 'goblin_hole' && b.kind !== 'goblin_hole')) {
          idx.set(k, b);
        }
      }
    }
  }
  biCache = idx;
  biState = state;
  biVersion = state.buildingsVersion;
  return idx;
}

export function buildingAtCell(state: GameState, cx: number, cy: number): Building | null {
  return buildingIndex(state).get(cy * COLS + cx) ?? null;
}

export function isCellBlocked(
  state: GameState,
  cx: number, cy: number,
  exemptGoblinId?: number,
  exemptBuildingId?: number,
): boolean {
  if (!isInBounds(cx, cy)) return true;
  if (state.walls.has(cellKey(cx, cy))) return true;
  const b = buildingAtCell(state, cx, cy);
  if (b && b.id !== exemptBuildingId) return true;
  const occ = state.occupancy.get(cellKey(cx, cy));
  if (occ !== undefined && occ !== exemptGoblinId) return true;
  // Water cells are walkable only for goblins currently on water-duty —
  // everyone else has to path around the source.
  if (waterSourceAtCell(state, { cx, cy })) {
    if (exemptGoblinId === undefined) return true;
    const eg = state.goblins.get(exemptGoblinId);
    if (!eg || eg.state.kind !== 'fetching_water') return true;
  }
  return false;
}

export function occupyCell(state: GameState, cx: number, cy: number, goblinId: number) {
  state.occupancy.set(cellKey(cx, cy), goblinId);
}

export function releaseCell(state: GameState, cx: number, cy: number, goblinId: number) {
  const k = cellKey(cx, cy);
  if (state.occupancy.get(k) === goblinId) state.occupancy.delete(k);
}

export function buildingPerimeter(b: Building): Cell[] {
  const result: Cell[] = [];
  const n = defOf(b).cellSize;
  for (let dx = -1; dx <= n; dx++) {
    result.push({ cx: b.cell.cx + dx, cy: b.cell.cy - 1 });
    result.push({ cx: b.cell.cx + dx, cy: b.cell.cy + n });
  }
  for (let dy = 0; dy < n; dy++) {
    result.push({ cx: b.cell.cx - 1, cy: b.cell.cy + dy });
    result.push({ cx: b.cell.cx + n, cy: b.cell.cy + dy });
  }
  return result.filter(c => isInBounds(c.cx, c.cy));
}

export function findFreeCellNear(
  state: GameState,
  cx: number, cy: number,
  exemptGoblinId?: number,
  blocked?: Set<string>,
  maxSteps = 400,
): Cell | null {
  const visited = new Set<string>();
  const queue: Cell[] = [{ cx, cy }];
  while (queue.length > 0 && visited.size < maxSteps) {
    const c = queue.shift()!;
    const k = cellKey(c.cx, c.cy);
    if (visited.has(k)) continue;
    visited.add(k);
    if (!isInBounds(c.cx, c.cy)) continue;
    if (blocked?.has(k)) {
      // skip but explore neighbors
    } else if (!isCellBlocked(state, c.cx, c.cy, exemptGoblinId)) {
      return c;
    }
    for (const d of CARDINAL_DIRS) {
      queue.push({ cx: c.cx + DX[d], cy: c.cy + DY[d] });
    }
  }
  return null;
}

// Cardinal expansion order biased toward the play area (East first, then the
// verticals, then West) so an open hole keeps streaming goblins out to its
// right — mirroring the old perimeter picker's directional preference.
const EMERGENCE_DIR_ORDER: Dir[] = [2, 0, 4, 6]; // E, N, S, W

// Nearest free, unoccupied cell a goblin can emerge into from the hole at
// (cx,cy), found by flooding outward through open space ONLY: walls, buildings,
// water sources and the map edge are impassable, so the flood can't tunnel
// through them. A hole sealed off (e.g. walled over) therefore reaches no free
// cell and returns null — goblins can no longer pop out past a covering wall.
// Occupied cells stay traversable (their goblin will move on) but are never
// returned as a landing spot, and the hole's own cell is never returned.
export function findHoleEmergenceCell(
  state: GameState,
  cx: number, cy: number,
  maxSteps = 400,
): Cell | null {
  const passable = (x: number, y: number): boolean =>
    isInBounds(x, y)
    && !state.walls.has(cellKey(x, y))
    && !buildingAtCell(state, x, y)
    && !waterSourceAtCell(state, { cx: x, cy: y });
  const visited = new Set<string>([cellKey(cx, cy)]);
  const queue: Cell[] = [];
  const enqueueNeighbors = (c: Cell) => {
    for (const d of EMERGENCE_DIR_ORDER) {
      const nx = c.cx + DX[d], ny = c.cy + DY[d];
      const k = cellKey(nx, ny);
      if (visited.has(k)) continue;
      visited.add(k);
      if (passable(nx, ny)) queue.push({ cx: nx, cy: ny });
    }
  };
  enqueueNeighbors({ cx, cy });
  while (queue.length > 0 && visited.size < maxSteps) {
    const c = queue.shift()!;
    if (!isCellBlocked(state, c.cx, c.cy)) return c;
    enqueueNeighbors(c);
  }
  return null;
}

// Initial center play area, before any digs.
export function initialPlayArea(): { x0: number; y0: number; x1: number; y1: number } {
  return {
    x0: INITIAL_PLAY_X0,
    y0: INITIAL_PLAY_Y0,
    x1: INITIAL_PLAY_X0 + INITIAL_PLAY_COLS,
    y1: INITIAL_PLAY_Y0 + INITIAL_PLAY_ROWS,
  };
}

// Predicate over the plus-shaped play area: a cell is in play if it's in the
// initial center rectangle, OR in an axis-aligned extension off one of its
// sides for a dug direction. Diagonal corners are never in play (the final
// shape is a +).
export function isInPlayCell(state: GameState, cx: number, cy: number): boolean {
  const c = initialPlayArea();
  if (cx >= c.x0 && cx < c.x1 && cy >= c.y0 && cy < c.y1) return true;
  if (state.dugDirections.has('n')
      && cx >= c.x0 && cx < c.x1
      && cy >= c.y0 - DIG_GROWTH_CELLS && cy < c.y0) return true;
  if (state.dugDirections.has('s')
      && cx >= c.x0 && cx < c.x1
      && cy >= c.y1 && cy < c.y1 + DIG_GROWTH_CELLS) return true;
  if (state.dugDirections.has('w')
      && cy >= c.y0 && cy < c.y1
      && cx >= c.x0 - DIG_GROWTH_CELLS && cx < c.x0) return true;
  if (state.dugDirections.has('e')
      && cy >= c.y0 && cy < c.y1
      && cx >= c.x1 && cx < c.x1 + DIG_GROWTH_CELLS) return true;
  return false;
}

// Rebuilds the wall set: every cell that's NOT in play, plus a thin border
// around the entire world (catches anything against the outer edge).
export function rebuildWalls(state: GameState): Set<string> {
  const walls = new Set<string>();
  for (let cy = 0; cy < ROWS; cy++) {
    for (let cx = 0; cx < COLS; cx++) {
      const inBorder =
        cx < WALL_BORDER || cx >= COLS - WALL_BORDER ||
        cy < WALL_BORDER || cy >= ROWS - WALL_BORDER;
      if (inBorder || !isInPlayCell(state, cx, cy)) walls.add(cellKey(cx, cy));
    }
  }
  return walls;
}

// Bounding box of the union of plus arms — used by the camera to know how
// far it can pan. Always covers the initial center; expands per dug direction.
export function computePlayBounds(state: GameState): { x0: number; y0: number; x1: number; y1: number } {
  const c = initialPlayArea();
  const b = { ...c };
  if (state.dugDirections.has('n')) b.y0 = c.y0 - DIG_GROWTH_CELLS;
  if (state.dugDirections.has('s')) b.y1 = c.y1 + DIG_GROWTH_CELLS;
  if (state.dugDirections.has('w')) b.x0 = c.x0 - DIG_GROWTH_CELLS;
  if (state.dugDirections.has('e')) b.x1 = c.x1 + DIG_GROWTH_CELLS;
  return b;
}

// Expand the plus-shape by adding an arm in the given direction, refresh walls
// + camera bounds, and lay down a water region covering the far third of the
// new arm (full cross-section).
export function digDirection(state: GameState, dir: 'n' | 'e' | 's' | 'w'): { ok: boolean; reason?: string } {
  if (state.dugDirections.has(dir)) return { ok: false, reason: 'already-dug' };
  state.dugDirections.add(dir);
  if (state.firstDugAt == null) state.firstDugAt = state.now;
  state.walls = rebuildWalls(state);
  state.wallsVersion++;
  state.playArea = computePlayBounds(state);

  // Water occupies the FAR third of the dug arm (away from the center).
  const c = initialPlayArea();
  const grow = DIG_GROWTH_CELLS;
  const third = Math.ceil(grow / 3);
  let region: { x0: number; y0: number; x1: number; y1: number };
  if (dir === 'n') region = { x0: c.x0, x1: c.x1, y0: c.y0 - grow,    y1: c.y0 - grow + third };
  else if (dir === 's') region = { x0: c.x0, x1: c.x1, y0: c.y1 + grow - third, y1: c.y1 + grow };
  else if (dir === 'w') region = { x0: c.x0 - grow,    x1: c.x0 - grow + third, y0: c.y0, y1: c.y1 };
  else region = { x0: c.x1 + grow - third, x1: c.x1 + grow, y0: c.y0, y1: c.y1 };

  const id = state.nextId++;
  state.waterSources.set(id, { id, ...region, selected: false });
  return { ok: true };
}

export function createInitialState(): GameState {
  const state: GameState = {
    money: START_MONEY,
    blood: 0,
    bloodUnlocked: false,
    dragonBone: 0,
    dragonBoneUnlocked: false,
    moneyEarned: 0,
    bloodEarned: 0,
    dragonBoneEarned: 0,
    goblins: new Map(),
    minotaurs: new Map(),
    dragons: new Map(),
    demons: new Map(),
    soulChairs: [],
    soulSigilCompletedAt: new Map(),
    bobParlayed: false,
    hellHintShown: false,
    waterSources: new Map(),
    buildings: new Map(),
    buildingsVersion: 0,
    spaceBuildings: new Map(),
    hole: {
      cell: { cx: START_CELL.cx, cy: START_CELL.cy },
      selected: false,
    },
    autoAssignEnabled: false,
    autoSpawnEnabled: false,
    autoWaterEnabled: false,
    goldgoblinsEnabled: false,
    tinytaurUnlocked: false,
    maxStruckAtOnce: 0,
    slewTwoDragonsInOneStrike: false,
    lightningUnlocked: false,
    goldgoblinMultiplier: 1,
    autoSpawnTimer: 0,
    autoSpawnMultiplier: 0,
    spawnHoleRotation: 0,
    dugDirections: new Set(),
    playArea: initialPlayArea(),
    floaters: [],
    deathEffects: [],
    lightningBolts: [],
    powerBoosts: [],
    pendingStrike: false,
    minotaursBought: 0,
    spawnQueue: [],
    minotaurSpawnQueue: [],
    dragonSpawnQueue: [],
    pendingBuild: null,
    buildingCounts: emptyBuildingCounts(),
    lightningStrikeCooldown: 0,
    selectedAmbientDragonId: null,
    log: [],
    occupancy: new Map(),
    walls: new Set<string>(),  // populated after construction
    wallsVersion: 0,
    nextId: 1,
    now: 0,
    lastPowerProduced: 0,
    lastPowerConsumed: 0,
    spawnsCompleted: 0,
    firstDugAt: null,
    waterSeen: false,
    multiSelectSeen: false,
    multiSpawnSeen: false,
    optionsUnlocked: false,
    spaceUnlocked: false,
    hellUnlocked: false,
    bobSpawned: false,
    bobPickingHole: false,
    bobCheatPending: false,
    ghosts: [],
    view: 'ground',
  };
  state.walls = rebuildWalls(state);
  state.demons = createDemons(state);
  let placed = 0;
  let radius = 0;
  while (placed < START_GOBLINS && radius < 12) {
    for (let dy = -radius; dy <= radius && placed < START_GOBLINS; dy++) {
      for (let dx = -radius; dx <= radius && placed < START_GOBLINS; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius && radius > 0) continue;
        const cx = START_CELL.cx + dx;
        const cy = START_CELL.cy + dy;
        if (!isInBounds(cx, cy)) continue;
        if (state.occupancy.has(cellKey(cx, cy))) continue;
        const id = state.nextId++;
        const c: Cell = { cx, cy };
        const g: Goblin = {
          id, pos: cellCenter(c), cell: c, target: null, goal: null,
          path: [], facing: Math.PI / 2,
          state: { kind: 'idle' }, selected: false, idleSince: null, lastCellChangedAt: 0,
        };
        state.goblins.set(id, g);
        occupyCell(state, cx, cy, id);
        placed++;
      }
    }
    radius++;
  }
  appendLog(state, 'Welcome, overseer.');
  return state;
}

export function appendLog(state: GameState, msg: string) {
  state.log.push({ time: state.now, msg });
  if (state.log.length > 60) state.log.shift();
}

// Seed the hell denizens. For now a single giant Minotaur that paces up and
// down, offset to one side of the landing zone (the centre of hell, where the
// player arrives) so the player spots it without it sitting on the portal beam.
export function createDemons(state: GameState): Map<number, Demon> {
  const demons = new Map<number, Demon>();
  const cx = HELL.width / 2 + DEMON.spawnOffsetX;
  const cy = HELL.height / 2;
  const id = state.nextId++;
  demons.set(id, {
    id, kind: 'minotaur',
    hx: cx, hy: cy,
    facing: Math.PI / 2, dir: 1,
    y0: cy - DEMON.patrolHalf, y1: cy + DEMON.patrolHalf,
    selected: false, greeted: false, hintedTryAnother: false, busyWith: null,
  });
  return demons;
}

// Build the five soul chairs as a point-up pentagon around the sigil centre.
// The chair index drives both its place on the ring and the pentagram edges
// (each chair links to the one two steps around), so a clean five-pointed star
// emerges as they fill.
// Hell-coord centre of a Hell Portal's abyssal mirror — the portal's world
// centre mapped into hell space (same offset render.ts uses). Each sigil rings
// this point.
export function hellMirrorCenter(b: Building): Vec2 {
  const ctr = buildingCenter(b);
  return {
    x: ctr.x + (HELL.width - WORLD.width) / 2,
    y: ctr.y + (HELL.height - WORLD.height) / 2,
  };
}

// Reconcile soul chairs with the live Hell Portals: every built portal gets one
// ring of `count` chairs around its mirror, and chairs whose portal is gone (or
// still constructing) are dropped. Cheap to run each tick — there are rarely
// more than a handful of portals. Also prunes stale completion timestamps.
export function syncSoulChairs(state: GameState): void {
  const { count, ringRadius } = SOUL_SIGIL;
  const livePortals = new Set<number>();
  for (const b of state.buildings.values()) {
    if (b.kind === 'hell_portal' && b.state !== 'constructing') livePortals.add(b.id);
  }
  // Drop chairs (and completion marks) belonging to portals that no longer exist.
  state.soulChairs = state.soulChairs.filter((c) => livePortals.has(c.portalId));
  for (const portalId of state.soulSigilCompletedAt.keys()) {
    if (!livePortals.has(portalId)) state.soulSigilCompletedAt.delete(portalId);
  }
  // Add a ring for any portal that doesn't have one yet.
  const haveChairs = new Set(state.soulChairs.map((c) => c.portalId));
  for (const b of state.buildings.values()) {
    if (b.kind !== 'hell_portal' || b.state === 'constructing') continue;
    if (haveChairs.has(b.id)) continue;
    const center = hellMirrorCenter(b);
    for (let i = 0; i < count; i++) {
      const a = -Math.PI / 2 + (i * 2 * Math.PI) / count; // first chair at the top
      state.soulChairs.push({
        id: state.nextId++,
        portalId: b.id,
        index: i,
        hx: center.x + Math.cos(a) * ringRadius,
        hy: center.y + Math.sin(a) * ringRadius,
        occupied: false,
      });
    }
  }
}

// Nearest soul chair within SOUL_SIGIL.chairRadius of a hell-coord point, or null.
export function soulChairAt(state: GameState, hx: number, hy: number): SoulChair | null {
  let best: SoulChair | null = null;
  let bestD = SOUL_SIGIL.chairRadius * SOUL_SIGIL.chairRadius;
  for (const c of state.soulChairs) {
    const dx = c.hx - hx, dy = c.hy - hy;
    const dd = dx * dx + dy * dy;
    if (dd <= bestD) { bestD = dd; best = c; }
  }
  return best;
}

// Topmost demon within DEMON.hitRadius of a hell-coord point, or null.
export function demonAtHell(state: GameState, hx: number, hy: number): Demon | null {
  let best: Demon | null = null;
  let bestD = DEMON.hitRadius * DEMON.hitRadius;
  for (const d of state.demons.values()) {
    const dx = d.hx - hx, dy = d.hy - hy;
    const dd = dx * dx + dy * dy;
    if (dd <= bestD) { bestD = dd; best = d; }
  }
  return best;
}

// Topmost Hell Portal whose hell-side mirror covers a hell-coord point, or
// null. The mirror sits at the portal's world centre mapped into hell space
// (matching render.ts's worldToHell offset); we treat its footprint as a
// generous square so the beacon is easy to tap in the abyss.
export function hellPortalAt(state: GameState, hx: number, hy: number): Building | null {
  const offX = (HELL.width - WORLD.width) / 2;
  const offY = (HELL.height - WORLD.height) / 2;
  for (const b of state.buildings.values()) {
    if (b.kind !== 'hell_portal') continue;
    const ctr = buildingCenter(b);
    const reach = defOf(b).size;
    if (Math.abs(ctr.x + offX - hx) <= reach && Math.abs(ctr.y + offY - hy) <= reach) {
      return b;
    }
  }
  return null;
}

// World coordinates that map (via worldToHell) to a hell-coord point — the
// inverse of the offset baked into render.ts's worldToHellX/Y. Used to place a
// hell-flagged effect at a given hell position.
export function hellToWorld(hx: number, hy: number): Vec2 {
  return {
    x: hx - (HELL.width - WORLD.width) / 2,
    y: hy - (HELL.height - WORLD.height) / 2,
  };
}

// Cast Bob back to the overworld as a living goblin — the demon's "untruth"
// punishment. Drops him at a free cell near the Goblin Hole.
export function resurrectBob(state: GameState): void {
  const h = state.hole.cell;
  const cell = findHoleEmergenceCell(state, h.cx, h.cy);
  if (!cell) {
    appendLog(state, 'Bob claws at the overworld but finds no room to land.');
    return;
  }
  const id = state.nextId++;
  const g: Goblin = {
    id, pos: cellCenter(cell), cell, target: null, goal: null,
    path: [], facing: Math.PI / 2,
    state: { kind: 'idle' }, selected: false, idleSince: state.now, lastCellChangedAt: state.now,
    bob: true,
  };
  state.goblins.set(id, g);
  occupyCell(state, cell.cx, cell.cy, id);
  appendLog(state, 'A bolt of lightning hurls Bob back to the overworld.');
}

// Credit a gain (income or kill reward) to a resource. Tracks the cumulative
// earned total alongside the balance so per-second readouts measure earning
// rate without spending dragging it down. Use plain `+=` for refunds, debug
// grants, and other non-earnings that shouldn't show up in the rate.
export function earnMoney(state: GameState, amount: number): void {
  state.money += amount;
  state.moneyEarned += amount;
}
export function earnBlood(state: GameState, amount: number): void {
  state.blood += amount;
  state.bloodEarned += amount;
}
export function earnDragonBone(state: GameState, amount: number): void {
  state.dragonBone += amount;
  state.dragonBoneEarned += amount;
}

export function countIdle(state: GameState): number {
  let n = 0;
  for (const g of state.goblins.values()) if (g.state.kind === 'idle') n++;
  return n;
}

export function totalIncome(state: GameState): number {
  let inc = 0;
  for (const b of state.buildings.values()) if (b.state === 'active') inc += defOf(b).income;
  return inc;
}

// Stamp a permanent ghost at the world-x/y where a unit died. Called from
// every kill site (lightning, dragon, minotaur, goblin, tinytaur sacrifice,
// player kill button). The ghosts list is rendered in Hell. A matching
// hell-flagged death effect is also spawned so the ghost manifests with a
// blood splatter — "dying in reverse" as the unit enters the underworld.
export function recordGhost(
  state: GameState,
  kind: Ghost['kind'],
  x: number, y: number,
  facing: number,
  opts: { gold?: boolean; tiny?: boolean; bob?: boolean } = {},
): void {
  state.ghosts.push({
    id: state.nextId++,
    kind, x, y, facing,
    spawnAt: state.now,
    gold: opts.gold || undefined,
    tiny: opts.tiny || undefined,
    bob: opts.bob || undefined,
    offX: opts.bob ? 0 : (Math.random() - 0.5) * 16,
    offY: opts.bob ? 0 : (Math.random() - 0.5) * 16,
    // Bob refuses to drift. A speedMult of 0 also disqualifies him from any
    // walk command in handleHellRightClick (we skip ghosts with bob set).
    speedMult: opts.bob ? 0 : 0.75 + Math.random() * 0.5,
  });
  pushDeathEffect(state, x, y, false, true);
}

export function pushDeathEffect(state: GameState, x: number, y: number, white = false, hell = false) {
  state.deathEffects.push({
    id: state.nextId++,
    x, y,
    spawnAt: state.now,
    white: white || undefined,
    hell: hell || undefined,
  });
}

export function pushFloater(
  state: GameState,
  x: number, y: number,
  text: string,
  color: number,
  lifetime = 1.4,
  powerCountdownWatts?: number,
  space = false,
  hell = false,
) {
  state.floaters.push({
    id: state.nextId++,
    x, y, text, color,
    spawnAt: state.now,
    lifetime,
    powerCountdownWatts,
    space,
    hell,
  });
}

// A jagged white bolt that lances down from well above the target to the
// strike point. Horizontal jitter tapers to 0 at the bottom so the tip lands
// exactly on (x, y).
export function pushLightningBolt(state: GameState, x: number, y: number) {
  const topY = Math.max(0, y - 14 * CELL);
  const segs = 12;
  const points: Vec2[] = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const py = topY + (y - topY) * t;
    const jitter = (1 - t) * (Math.random() - 0.5) * CELL * 2.5;
    points.push({ x: x + jitter, y: py });
  }
  points[points.length - 1] = { x, y };
  state.lightningBolts.push({
    id: state.nextId++,
    points,
    spawnAt: state.now,
    lifetime: 0.45,
  });
}

// Sum of every live power surge's current contribution (watts), each ramping
// linearly from its peak down to 0 across its duration.
export function currentPowerBoost(state: GameState): number {
  let total = 0;
  for (const b of state.powerBoosts) {
    const k = (state.now - b.startAt) / b.duration;
    if (k < 1) total += b.peak * (1 - k);
  }
  return total;
}

export function removeGoblin(state: GameState, goblinId: number) {
  const g = state.goblins.get(goblinId);
  if (!g) return;
  // Detach from any building it was assigned to.
  const s = g.state;
  if (s.kind === 'going_to_build' || s.kind === 'going_to_maintain' ||
      s.kind === 'building' || s.kind === 'maintaining') {
    const b = state.buildings.get(s.buildingId);
    if (b) {
      const i = b.assignedGoblins.indexOf(goblinId);
      if (i >= 0) b.assignedGoblins.splice(i, 1);
    }
  }
  releaseCell(state, g.cell.cx, g.cell.cy, goblinId);
  if (g.target) releaseCell(state, g.target.cx, g.target.cy, goblinId);
  state.goblins.delete(goblinId);
}

// Walks every building's assignedGoblins and removes duplicate entries plus
// any ID that doesn't currently reference this building via its goblin state.
// Run on save load to repair pre-fix bloat, and cheap to call defensively
// after batch operations that touch assignments.
export function pruneAllAssignedGoblins(state: GameState): void {
  for (const b of state.buildings.values()) {
    const seen = new Set<number>();
    const kept: number[] = [];
    for (const gid of b.assignedGoblins) {
      if (seen.has(gid)) continue;
      const g = state.goblins.get(gid);
      if (!g) continue;
      const s = g.state;
      const refsThisBuilding =
        (s.kind === 'building' || s.kind === 'maintaining' ||
         s.kind === 'going_to_build' || s.kind === 'going_to_maintain' ||
         s.kind === 'fetching_water') && s.buildingId === b.id;
      if (!refsThisBuilding) continue;
      seen.add(gid);
      kept.push(gid);
    }
    b.assignedGoblins = kept;
  }
}

export function destroyBuilding(state: GameState, buildingId: number) {
  const b = state.buildings.get(buildingId);
  if (!b) return;
  // If the building was online, its power contribution is going away — show
  // the inverse of the floater that appeared when it came online.
  const def = defOf(b);
  if (b.state === 'active' && def.powerOutput !== 0) {
    const c = buildingCenter(b);
    if (def.powerOutput > 0) {
      pushFloater(state, c.x, c.y, `-${formatPower(def.powerOutput)}`, 0x8acfff, 1.6);
    } else {
      pushFloater(state, c.x, c.y, `+${formatPower(-def.powerOutput)}`, 0x8acfff, 1.6);
    }
  }
  // Release any assigned goblins; they'll auto-exit via the idle handler if they're
  // still standing on what used to be the footprint.
  for (const gid of b.assignedGoblins) {
    const g = state.goblins.get(gid);
    if (!g) continue;
    g.state = { kind: 'idle' };
    g.goal = null;
    g.path = [];
  }
  state.buildings.delete(buildingId);
  markBuildingsChanged(state);
}

// The building a default (seeking) dragon will haul to space: the single most
// valuable finished income-earner (Datacentre, Hypercentre, Phone Farm), by Ƶ
// cost. Only money-generating towers are auto-picked — power plants, walls, the
// Dragon Beacon, etc. are skipped (the player can still command a dragon onto
// any of them manually).
export function dragonTargetBuilding(state: GameState): Building | null {
  let best: Building | null = null;
  for (const b of state.buildings.values()) {
    if (b.state === 'constructing') continue;
    if (defOf(b).income <= 0) continue;
    if (best === null || defOf(b).cost > defOf(best).cost) best = b;
  }
  return best;
}

// Floating building whose (unrotated) footprint contains the given point, in
// SPACE coordinates. On overlap, the one whose center is nearest wins. Used to
// click-select buildings while looking at the void.
export function spaceBuildingAt(state: GameState, x: number, y: number): SpaceBuilding | null {
  let best: SpaceBuilding | null = null;
  let bestD = Infinity;
  for (const sb of state.spaceBuildings.values()) {
    const half = BUILDING_DEFS[sb.building.kind].size / 2;
    const dx = x - sb.pos.x, dy = y - sb.pos.y;
    if (Math.abs(dx) <= half && Math.abs(dy) <= half) {
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = sb; }
    }
  }
  return best;
}

// The first finished Dragon Beacon, if any — used as a dragon's launch point.
export function constructedDragonBeacon(state: GameState): Building | null {
  for (const b of state.buildings.values()) {
    if (b.kind === 'dragon_beacon' && b.state !== 'constructing') return b;
  }
  return null;
}

export function removeDragon(state: GameState, dragonId: number) {
  state.dragons.delete(dragonId);
}

export function holeAtCell(state: GameState, cx: number, cy: number): boolean {
  const h = state.hole.cell;
  return cx >= h.cx && cx < h.cx + HOLE_SIZE && cy >= h.cy && cy < h.cy + HOLE_SIZE;
}

export function holeCells(state: GameState): Cell[] {
  const h = state.hole.cell;
  const out: Cell[] = [];
  for (let dx = 0; dx < HOLE_SIZE; dx++) {
    for (let dy = 0; dy < HOLE_SIZE; dy++) {
      out.push({ cx: h.cx + dx, cy: h.cy + dy });
    }
  }
  return out;
}

export function holeCenter(state: GameState): Vec2 {
  return cellCenter({
    cx: state.hole.cell.cx + (HOLE_SIZE - 1) / 2,
    cy: state.hole.cell.cy + (HOLE_SIZE - 1) / 2,
  });
}

// True iff a building's footprint covers any of the Goblin Hole's 2×2 cells.
// Money cost to build `kind` right now. Fixed at BUILDING_DEFS.cost for most
// kinds, but the Goblin Hole doubles for every Goblin Hole already in play — so
// it starts at its base price and gets twice as steep with each one placed.
export function buildingMoneyCost(state: GameState, kind: BuildingKind): number {
  const base = BUILDING_DEFS[kind].cost;
  if (kind !== 'goblin_hole') return base;
  let holes = 0;
  for (const b of state.buildings.values()) {
    if (b.kind === 'goblin_hole') holes++;
  }
  return base * 2 ** holes;
}

export function holeBlockedByBuilding(state: GameState): boolean {
  for (const c of holeCells(state)) {
    if (buildingAtCell(state, c.cx, c.cy)) return true;
  }
  return false;
}

export function maintainerCount(state: GameState, b: Building): number {
  let n = 0;
  for (const id of b.assignedGoblins) {
    const g = state.goblins.get(id);
    if (g && g.state.kind === 'maintaining' && g.state.buildingId === b.id) n++;
  }
  return n;
}

// All goblins ASSIGNED as water carriers for `b`, including ones who haven't
// completed their first loop. Used to decide whether to assign more (so we
// don't pile up duplicate carriers while one is still doing the first run).
export function waterCarrierCount(state: GameState, b: Building): number {
  let n = 0;
  for (const id of b.assignedGoblins) {
    const g = state.goblins.get(id);
    if (g && g.state.kind === 'fetching_water' && g.state.buildingId === b.id) n++;
  }
  return n;
}

// Only carriers who have actually delivered water (completed at least one
// source → DC round trip). Used to decide whether the DC counts as watered.
export function effectiveWaterCarrierCount(state: GameState, b: Building): number {
  let n = 0;
  for (const id of b.assignedGoblins) {
    const g = state.goblins.get(id);
    if (g && g.state.kind === 'fetching_water'
        && g.state.buildingId === b.id
        && g.state.firstLoopDone) n++;
  }
  return n;
}

