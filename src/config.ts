export const TICK_HZ = 20;
export const TICK_MS = 1000 / TICK_HZ;
export const TICK_S = 1 / TICK_HZ;

export const CELL = 32;
// World grid is sized to fit the maximum possible play area: the initial
// 24x20 region plus DIG.cells (20) of growth in every direction. Walls fill
// everything outside the current play area, so the visible map starts small.
export const INITIAL_PLAY_COLS = 24;
export const INITIAL_PLAY_ROWS = 20;
export const DIG_GROWTH_CELLS = 12;
export const COLS = INITIAL_PLAY_COLS + DIG_GROWTH_CELLS * 2;
export const ROWS = INITIAL_PLAY_ROWS + DIG_GROWTH_CELLS * 2;
export const WORLD = { width: COLS * CELL, height: ROWS * CELL };
export const WALL_BORDER = 2; // impassable wall thickness at the world's outer edge

// Where the initial play area sits within the larger world (top-left, in cells).
// Centered so dig in any direction has 20 cells of headroom.
export const INITIAL_PLAY_X0 = DIG_GROWTH_CELLS;
export const INITIAL_PLAY_Y0 = DIG_GROWTH_CELLS;
export const CAMERA_SPEED = 700; // px/sec when panning with WASD
export const RENDER_SCALE = 1.3; // visual zoom factor applied to the world layer

// Hard cap on how many units the player can have selected at once — ground
// creatures (goblins, minotaurs, dragons), souls in hell, and drifting units
// in space all count against it; buildings and other scenery don't. A
// box-select fills up to the cap and drops the overflow; shift-clicking one
// more unit onto a full selection refuses outright.
export const MAX_SELECTED_UNITS = 30;

// Seconds after the first dig before the pan-hint (WASD/arrows) appears, if
// the player hasn't already panned the camera to bring water into view.
export const WATER_HINT_DELAY_SEC = 4;

// General map-movement nudge: if the player has never panned the camera at
// all (keyboard on desktop, two-finger drag on touch), surface the pan hint
// after this many seconds of total play. Sticky-hidden on the first pan.
export const PAN_HINT_DELAY_SEC = 300;

// Onboarding hint: nudges the player to spawn + kill goblins. Surfaces when
// either bar passes: 30 s with zero spawns, or 90 s without completing the
// first task (earn Ƶ100, which requires killing goblins).
export const SPAWN_HINT_NO_SPAWN_SEC = 30;
export const SPAWN_HINT_NO_TASK_SEC = 90;

// Drag-select onboarding nudge. Once the player is past the first task, surface
// a "drag to select many" hint if they still haven't done a multi-creature
// drag-select after this many seconds of total play. Sticky once seen.
export const DRAG_SELECT_HINT_DELAY_SEC = 180;

// Multi-spawn onboarding nudge. Once the player has spawned at least one goblin,
// surface a "queue several at once" hint if they still haven't had more than one
// goblin in the spawn queue at a time after this many seconds of total play.
// Sticky once they queue 2+ concurrently.
export const MULTI_SPAWN_HINT_DELAY_SEC = 300;

export const GOBLIN = {
  speed: 110,
  radius: 12,
  spawnCost: 0,
  spawnTime: 2,
  arriveDist: 2,
  // Hard ceiling for the spawn-progress track. Per-hole capacity lives on
  // `state.hole.spawnCapacity` and currently doesn't ramp; the headroom is
  // here in case future upgrades raise it.
  concurrentBuildLimit: 40,
  breakdanceAfter: 30, // seconds of continuous idle before goblins start breakdancing
};

// Minotaur — a player-summoned predator. Walks the map, hunts the nearest
// goblin, and gives the same KILL_REWARD per kill as a goblin-on-goblin kill.
// Minotaurs respect building footprints, walls, and the world border when
// stepping; goblin occupancy doesn't block them (they hunt straight through).
export const MINOTAUR = {
  speed: 70,
  radius: 22,
  bloodCost: 16,       // flat per summon (bar the one-time first discount)
  firstBloodCost: 8,   // first-summon mercy price — see minotaurBloodCost
  spawnTime: 2,
  spawnCapacity: 1,
  arriveDist: 2,
  attackWindup: 0.5,
  wanderInterval: 1.2,
};

// Flat price per summon, with one mercy exception: if the player was sitting
// on less than the discounted price in blood at the moment the summon
// unlocked (state.minotaurFirstDiscount, decided in refreshUI), their FIRST
// Minotaur costs firstBloodCost so reaching it isn't a long grind.
export function minotaurBloodCost(bought: number, firstDiscount: boolean | null): number {
  return bought === 0 && firstDiscount ? MINOTAUR.firstBloodCost : MINOTAUR.bloodCost;
}

// Tinytaur — a secret summon unlocked once the player has fielded a few
// Minotaurs at once. A Minotaur shrunk to a fraction of the size and much
// faster (movement + attack), so it zips through a packed-in horde culling
// goblins quickly. Summoned instantly (no queue) by sacrificing living
// Minotaurs: `minotaurCost` of them die the instant the Tinytaur spawns.
// Reuses the Minotaur unit internally (a Minotaur with `tiny: true`).
export const TINYTAUR = {
  minotaurCost: 4,  // living Minotaurs consumed (and killed) per summon
  speed: 170,       // vs MINOTAUR.speed 70
  attackWindup: 0.2, // vs MINOTAUR.attackWindup 0.5
  scale: 0.5,       // render size multiplier vs a full Minotaur
};

// Robot — a late-game summon unlocked alongside the Hypercentre era. Costs
// money (not blood) and demands a serious industrial base (4 Hypercentres)
// before the button even arms. On the ground a robot is just a small white
// goblin — same jobs, same pathfinding, faster servos — except it's all but
// unkillable: lightning, minotaurs, kill orders and dragon fire all pass over
// it. Its one allergy is radioactive waste — a reactor meltdown's shockwave
// destroys robots like anything else (see updateMeltdowns). Its
// real purpose is orbit: a robot snatched to space by a dragon survives the
// vacuum and is the only unit able to assemble an Orbital Platform.
// Look + orbital speed live in options (robotScale / robotTint /
// robotGreyscale / robotSpaceSpeed) so they're tunable from the dev menu.
export const ROBOT = {
  moneyCost: 250_000,
  hypercentresRequired: 4,
  speed: 200,         // px/sec on the ground — near-double GOBLIN.speed (110)
  buildRange: 30,     // px past a platform's edge that counts as "on site"
  // Each robot actively building a ground site multiplies the build time by
  // this factor, compounding — two robots run a build at 1/0.49 ≈ 2× rate.
  // Announced by a white "fast build" tag pinned above the robot's head for
  // as long as it stays on the job (render's syncFastBuildTags).
  buildTimeMult: 0.7,
  // Robots assemble on a timed queue like the other summons (one at a time,
  // mirroring the Minotaur's single-slot ritual track).
  spawnTime: 2,
  spawnCapacity: 1,
  // Commanded onto another unit, a robot stands fast and shoots it with a
  // hitscan laser (no chase, no range limit — even a dragon on the wing).
  // The windup is the charge-up beat before the beam fires.
  laserWindup: 0.5,
  // In orbit, an idle robot paddles to the nearest completed Orbital
  // Platform and parks on its deck, at a per-robot spot on a ring this far
  // (px) inside the deck edge — out on the walkable rim a Space Centre
  // leaves uncovered.
  parkInset: 18,
  // A commanded robot (see SpaceUnit.goal) counts as arrived within this
  // many px of its goal, then stands fast there.
  arriveDist: 3,
};

// Terminator — the endgame killer, unlocked by completing the Collect
// 9,999,999 blood task. A terminator is a robot under the chrome (same
// servos, same laser, same single allergy to radioactive waste) wearing a
// red targeting lamp on its head — and it doesn't take jobs: it hunts,
// automatically locking its laser onto the nearest non-robot unit (goblins,
// minotaurs, even dragons on the wing) until nothing fleshy is left.
// Spawning demands a serious orbital base before the button arms.
export const TERMINATOR = {
  moneyCost: 2_500_000,
  spaceCentresRequired: 2,
  // Assembles on the same single-slot timed track as a robot.
  spawnTime: 3,
  spawnCapacity: 1,
};

// Units hauled to space by a dragon. Anything that isn't a robot suffocates
// after `lifetime` seconds adrift; until then it tumbles gently like the
// floating buildings do.
export const SPACE_UNIT = {
  lifetime: 5,        // seconds a non-robot unit survives the vacuum
  driftSpeed: 22,     // baseline tumble speed, px/sec
  margin: 60,         // keep drifting units this far inside the space bounds
};

// Dragon — summoned from a constructed Dragon Beacon (64 blood each). A flying
// creature that, by default, hauls the single most valuable building up to
// space, where it floats free of the grid. It can also be commanded to
// incinerate a unit, fly to a spot, or lift a specific building. Each dragon
// makes one trip: the instant it carries a building across into space it's gone.
// Dragons fly in straight lines, ignoring walls, buildings, and occupancy.
export const DRAGON = {
  bloodCost: 64,
  speed: 90,             // px/sec, default auto-seek / carry speed
  // Snappier travel speed used while obeying a player command (moving_to,
  // going_to_kill, going_to_building, delivering). Auto-collecting stays calm.
  manualSpeed: 160,      // px/sec
  // Ritual delay between summoning a dragon and it appearing, mirroring the
  // Minotaur's summon-in time. Only one dragon can be in the ritual at once.
  spawnTime: 2,          // seconds
  spawnCapacity: 1,
  // Hard ceiling for the summon-progress track. The live cap matches the
  // current active-beacon count, but the DOM pre-creates this many segments
  // so the track can grow/shrink as beacons come and go without rebuilding.
  concurrentBuildLimit: 16,
  // A freshly-summoned dragon hovers this long before it starts auto-seeking a
  // building to haul, giving the player a beat to issue a manual command first.
  seekDelay: 2.5,        // seconds
  // After a player-commanded move reaches its destination, the dragon loiters
  // here this long before reverting to its default building-hauling behaviour.
  moveLingerTime: 3,     // seconds
  // After landing a commanded kill, the dragon hovers in place this long
  // before reverting to its default building-hauling behaviour.
  postKillPause: 3,      // seconds
  // Once over a target building, the dragon hovers this long before hoisting it
  // — a beat of menace before the lift.
  liftHover: 2,          // seconds
  attackWindup: 0.6,     // seconds of fire-breath before a commanded kill lands
  pickupDist: 26,        // px from a building's center before it's hoisted
  arriveDist: 8,         // px from a move/kill target before it counts as reached
  killReach: 22,         // px the fire-breath reaches past the target center
  spaceY: -4 * CELL,     // world-y a carrier climbs to before its load enters space
  displayPx: 132,        // on-screen sprite size of a full dragon
  // Entrance swoop: a freshly-summoned dragon spawns this many px above its
  // landing point and flies down at swoopSpeed. The offset is well past the
  // top of the viewport at any reasonable zoom, so it reads as arriving from
  // off-screen rather than popping into existence at the beacon.
  swoopFromOffset: 1200, // px above target on summon
  swoopSpeed: 1500,      // px/sec entry speed
};

// Ambient dragons — purely decorative silhouettes that drift across the space
// scene's starfield. They can't be selected or commanded and never interact
// with anything; they live only in the renderer (not in game state or saves).
// Smaller and darker than a summoned dragon so they read as distant background.
// Each one enters off one edge, crosses the void, and despawns off the far edge.
export const AMBIENT_DRAGON = {
  maxOnScreen: 2,        // never more than a couple drifting at once
  speedMin: 26,          // space-px/sec
  speedMax: 52,
  scaleMin: 0.34,        // fraction of a full dragon's display size
  scaleMax: 0.55,
  spawnDelayMin: 2.5,    // seconds between spawns once below the cap
  spawnDelayMax: 8,
  bobAmpMin: 4,          // gentle vertical bob amplitude (px)
  bobAmpMax: 9,
  margin: 220,           // off-screen spawn/despawn padding (space-px)
};

// The void the dragons haul buildings into. Its own little coordinate space
// with a starfield; lifted buildings drift here within these bounds (px) and
// never need water, maintainers, or power — they simply keep earning income.
export const SPACE = {
  width: 1800,
  height: 1200,
  driftSpeed: 16,        // baseline float speed, px/sec
  margin: 90,            // keep floating buildings this far inside the bounds
};

// Hell — the dim mirror world the Hell Portal opens onto. Its own coordinate
// space, deliberately bigger than the overworld so the camera has somewhere
// to zoom out into on arrival. Ghosts of every killed unit are scattered here
// at the same world-x/y where they died.
export const HELL = {
  width: 2400,
  height: 3200,
  // On arrival the camera shows hell at the normal RENDER_SCALE, then eases
  // out to this multiplier so the player can see the larger map. Going back
  // up reverses the zoom first, then plays the rise transition.
  zoomedOutScale: 0.5,   // fraction of RENDER_SCALE shown at full zoom-out
  zoomMs: 1600,          // duration of the easing zoom in/out
  // Red beam from the portal down to the abyss — animates in over this many
  // ms after placement, then stays drawn at full length.
  lineDrawMs: 1400,
  lineColor: 0xff2030,
  // Visual style of the void.
  bgColor: 0x0a0203,
  fogColor: 0x4a0a0e,
  // Hit radius (hell-px) for clicking a ghost. Generous so a single tap on a
  // small drifting silhouette still lands.
  ghostHitRadius: 24,
  // Speed (hell-px / sec) a ghost walks toward a commanded destination.
  ghostWalkSpeed: 40,
  // A soul commanded onto another soul opens their chat once within this
  // (hell-px) of it — just outside arm's reach, so the two don't overlap.
  chatRadius: 60,
  // Idle pacing for Bob's ghost: until his first player command he wanders
  // left and right this far (hell-px) around his arrival spot, at this speed,
  // pausing this long (sec) at each end before turning back.
  bobPaceRange: 90,
  bobPaceSpeed: 20,
  bobPacePauseSec: 3,
  // How long Bob's soul stays vanished after the demon's untruth strike
  // before re-materialising at the centre of hell.
  bobRespawnDelaySec: 2,
};

// Demons — uncommandable denizens of hell. Three of them now: the original
// colossus (demon "R", Hungry, right of the
// landing zone, bellowing in ALL CAPS), his half-size counterpart across the
// abyss (demon "L", Lilly, who speaks every word backwards), and Lilly's
// smaller friend Lolly tucked away in a corner of the map.
// They all stand still by default — R facing left, L facing right, so the
// pair eye each other across the landing zone; Lolly faces into her corner.
// The player can't order one around; a goblin ghost can only be walked up to
// one to "parlay" (see demon-dialogue.ts). All radii below are for the
// full-size colossus and are scaled down by each demon's `scale` (see
// Demon.scale in state.ts).
export const DEMON = {
  speed: 16,          // hell-px/sec — a slow, ponderous patrol (dev toggle only)
  displayPx: 900,     // colossal, ~9x a summoned Minotaur
  patrolHalf: 360,    // hell-px travelled either side of the spawn centre
  parlayRadius: 360,  // a ghost within this (hell-px) of the demon starts a parlay
  hitRadius: 390,     // click radius (hell-px) for selecting the demon
  // The demon is solid: no soul may stand within this (hell-px) of his centre —
  // any that ends up inside is shoved back out to the rim. Kept well under
  // parlayRadius so a commanded soul opens its parlay before it ever collides.
  bodyRadius: 240,
  // Hell-x offset from the map centre where demon R stands; demon L mirrors
  // it on the other side. Nudged out so they stand clear of the soul sigil
  // at the centre of the abyss.
  spawnOffsetX: 620,
  // Demon L (Lilly) renders at this fraction of the colossus. This is the
  // seed stamped onto the Demon record; the LIVE size is the demonLScale
  // dev option (same default) — see demonScaleOf in state.ts.
  smallScale: 0.5,
  // Lolly (L's friend) is smaller still — live size is the demonFriendScale
  // dev option (same default).
  friendScale: 0.35,
  // Where Lolly stands — the top-left corner of the abyss, nudged a bit
  // higher up so she reads as truly tucked into the corner.
  friendCorner: { x: 320, y: 380 },
};

// The soul sigil — up to five candles placed by the player on the outer ring
// of a Hell Portal's abyssal mirror (the "beacon"). Every portal gets its own
// ring. Candles cost blood and snap onto the ring; pentagram lines spring
// between them as they're placed. Once all five stand, each candle becomes a
// soul chair ("needs soul") — walking a soul onto one seats it, and every
// seated soul multiplies the portal's deadpan 1 W output by its own strength
// multiplier (see soulMultipliers / soulStrengthOf).
export const SOUL_SIGIL = {
  count: 5,
  ringRadius: 290,      // hell-px from a portal's mirror out to each candle
  innerRadius: 110,     // the central ring drawn at the mirror, inside the candles
  chairRadius: 28,      // candle disc radius + click hit radius
  arriveRadius: 40,     // a commanded soul seats once this close to its chair
  candleBloodCost: 9,   // blood per candle placed
  placeBand: 70,        // hell-px either side of ringRadius where a tap counts as "on the ring"
  candleMinGap: 256,    // hell-px a new candle must keep from its ring-mates
  // Per-soul power multiplier by the strength of the bound soul: goblin souls
  // are weak, full-size minotaur souls strong, dragon and tinytaur souls very
  // strong. Five strong souls = 100^5 W = 10 GW per portal.
  soulMultipliers: { weak: 66, strong: 100, veryStrong: 144 },
};

export type SoulStrength = keyof typeof SOUL_SIGIL.soulMultipliers;

// The floater label flashed over a chair as its soul binds.
export const SOUL_STRENGTH_LABEL: Record<SoulStrength, string> = {
  weak: 'weak soul',
  strong: 'strong soul',
  veryStrong: 'very strong soul',
};

// The strength of a unit's soul, from the ghost's kind. Tinytaurs punch far
// above their weight: their cursed little souls bind as hard as a dragon's.
export function soulStrengthOf(kind: 'goblin' | 'minotaur' | 'dragon', tiny?: boolean): SoulStrength {
  if (kind === 'goblin') return 'weak';
  if (kind === 'minotaur' && !tiny) return 'strong';
  return 'veryStrong';
}

// A Hell Portal's true output: its deadpan base wattage multiplied by each
// seated soul's own strength multiplier. Chairs bound before souls had
// strengths carry no mult — they count as strong. 0 souls → 1 W.
export function sigilPortalOutput(baseWatts: number, chairs: { occupied: boolean; mult?: number }[]): number {
  let out = baseWatts;
  for (const c of chairs) {
    if (c.occupied) out *= c.mult ?? SOUL_SIGIL.soulMultipliers.strong;
  }
  return out;
}

// One-shot Ritual upgrades. Autobuild + Autospawn unlock once a Phone
// Farm has been run; Goldblins unlocks via the Earn-30-blood side-task. Dig
// unlocks once a Gas Turbine has been built.
// "Autobuild": newly-hatched goblins route themselves to understaffed
// buildings. "Autospawn": queues a free spawn every 3 seconds. "Autowater":
// extends Autobuild so idle goblins are also routed onto watering duty —
// unlocks once Autobuild is owned and a water source has been dug.
export const SUMMON_UPGRADES = {
  autoAssign: { bloodCost: 4 },
  autoSpawn: { bloodCost: 13, intervalSeconds: 3 },
  autoWater: { bloodCost: 128 },
  goldgoblins: { bloodCost: 26 },
  goldgoblinsX10: { bloodCost: 128, multiplier: 10 },
  // Autodragon — unlocked by Lilly's "Destroy a robot" optional task. Once
  // bought, a dragon summon is queued automatically every intervalSeconds,
  // provided the player can cover the usual DRAGON.bloodCost and an active
  // Dragon Beacon has a free ritual slot (same gates as the manual button).
  autoDragon: { bloodCost: 256, intervalSeconds: 5 },
};

// Tier ladder for the Autospawn ritual. Each subsequent purchase replaces the
// previous in the menu (level → next entry). Doubling cost per tier.
export const AUTOSPAWN_TIERS: { multiplier: number; bloodCost: number }[] = [
  { multiplier: 1,  bloodCost: 13 },
  { multiplier: 2,  bloodCost: 26 },
  { multiplier: 4,  bloodCost: 52 },
  { multiplier: 8,  bloodCost: 104 },
  { multiplier: 16, bloodCost: 208 },
  { multiplier: 32, bloodCost: 416 },
];

// Dig cost ramps after the first hole — the freebie unlocks the mechanic,
// subsequent digs cost a small fortune so the player can't trivially
// surround everything with water.
export const DIG = {
  firstBloodCost: 50,
  secondBloodCost: 500,
  laterBloodCost: 2000,
  cells: DIG_GROWTH_CELLS,
};
// Returns the blood cost of the next dig given how many directions are already
// dug: the first dig is cheap, the second steps up, and every dig after that
// is the full price.
export function digBloodCost(dugCount: number): number {
  if (dugCount === 0) return DIG.firstBloodCost;
  if (dugCount === 1) return DIG.secondBloodCost;
  return DIG.laterBloodCost;
}

// Water meter — every building with `waterDeliveryAmount` keeps a 0..100
// score that depletes at this rate and is bumped per delivery.
export const WATER_METER_MAX = 100;
export const WATER_DEPLETION_PP_PER_SEC = 10;

// Default per-hole capacity. Each completed Goblin Hole building stacks
// another GOBLIN_HOLE_CAPACITY_PER_BUILDING on top of the base.
export const BASE_SPAWN_CAPACITY = 5;
export const GOBLIN_HOLE_CAPACITY_PER_BUILDING = 5;

// Lightning Strike — a ritual granted by a truthful demon parlay. Aim it at
// the map: it kills every unit inside a circular blast —
// goblins, minotaurs, and dragons — granting their usual kill rewards, and
// powers a temporary surge that decays linearly to zero.
export const LIGHTNING = {
  cellsWide: 7,                    // blast diameter, in cells
  bloodCost: 32,                   // blood spent per strike
  powerBoostWatts: 1_000_000_000,  // 1 GW peak surge
  powerBoostSeconds: 5,            // surge decays to 0 over this many seconds
};

// Striking a completed Nuclear Reactor with Lightning ruptures the core: the
// reactor detonates, and a green/white shockwave radiates out from its
// centre at waveSpeed, killing every unit in the overworld as the front
// reaches it — even robots, which nothing else in the game can touch. The
// wave paints fallout splatter as it crosses the crater zone, extra bolts
// are hurled skyward at the rupture, and one final decaying surge is dumped
// into the grid as the core lets go (to a super pitched-down power-up tone).
export const REACTOR_MELTDOWN = {
  splatterCells: 20,                // fallout splatter diameter, in cells
  boltCount: 6,                     // extra bolts thrown up around the rupture
  waveSpeed: 450,                   // shockwave expansion, px/sec
  powerBoostWatts: 10_000_000_000,  // 10 GW peak death-surge
  powerBoostSeconds: 10,            // surge decays to 0 over this many seconds
  // Whole-screen radiation tint at the rupture instant: a green wash over
  // everything (canvas + panels) starting at tintAlpha and fading linearly
  // to nothing over tintSeconds. Driven by state.lastMeltdownAt in render.
  tintAlpha: 0.32,
  tintSeconds: 10,
};

// Killing a goblin yields this much money + this much blood.
export const KILL_REWARD = { money: 25, blood: 1 };
// A gold-tinted goblin (rolled at spawn time when Goldgoblins is owned)
// drops a much fatter pile of money on death.
export const GOLD_KILL_REWARD = { money: 250, blood: 1 };
// Probability a fresh goblin is gold-tinted, applied when Goldgoblins is
// owned. Independent per spawn.
export const GOLD_GOBLIN_CHANCE = 0.20;

// Killing a Minotaur (only possible by goring it with another Minotaur)
// drops blood but no money — the player paid summoning blood, this returns
// it (and then some) via the kill but doesn't generate Ƶ.
export const MINOTAUR_KILL_REWARD = { money: 0, blood: 128 };

// A dragon can be commanded to incinerate another dragon. The victim drops a
// Dragon Bone — a rare currency, since each dragon costs 64 blood to summon.
export const DRAGON_KILL_REWARD = { dragonBone: 1 };

export type BuildingColors = {
  active: number; activeBorder: number;
  dormant: number; dormantBorder: number;
  constructing: number; constructingBorder: number;
};

export type BuildingDef = {
  name: string;
  short: string;          // short label drawn on the building, e.g. 'DC', 'GW'
  cellSize: number;
  size: number;           // pixel size = cellSize * CELL
  cost: number;
  bloodCost?: number;     // optional secondary cost in blood
  dragonBoneCost?: number; // optional tertiary cost in dragon bones
  buildersRequired: number;
  buildTime: number;      // seconds
  maintainersRequired: number;
  // Per-delivery water bump (0..100). Set on buildings that drink (DC, HC).
  // The building maintains a 0..100 waterMeter that depletes at
  // WATER_DEPLETION_PP_PER_SEC (or `waterDepletionPerSec` if overridden)
  // and is bumped by this amount each time a carrier completes a
  // source → building round trip. The building counts as watered while
  // the meter is > 0.
  waterDeliveryAmount?: number;
  // Optional per-def override of the global depletion rate (pp/sec). Lets
  // a thirsty endgame building drain faster or a tier-1 sip more gently
  // without changing the global constant.
  waterDepletionPerSec?: number;
  // Auto-assign target — Autobuild will keep this many carriers on the
  // building. Manual right-click ignores the auto cap; `waterCarrierMax`
  // is a soft preference (drinkers below it are picked first) so a single
  // DC won't hoover up every goblin while another building is still dry.
  waterAutoAssignTarget?: number;
  waterCarrierMax?: number;
  income: number;         // Ƶ/sec while active
  powerOutput: number;    // watts: positive = produces, negative = consumes
  wanderInterval: number;
  wanderJitter: number;
  colors: BuildingColors;
};

function def(cellSize: number, rest: Omit<BuildingDef, 'cellSize' | 'size'>): BuildingDef {
  return { cellSize, size: cellSize * CELL, ...rest };
}

export const BUILDING_DEFS = {
  phone_farm: def(3, {
    name: 'Phone Farm',
    short: 'PF',
    cost: 50,
    buildersRequired: 3,
    buildTime: 4,
    maintainersRequired: 3,
    income: 20,
    powerOutput: -200, // 200 W draw
    wanderInterval: 1.4,
    wanderJitter: 0.8,
    colors: {
      active: 0x8a7a3a, activeBorder: 0xeada6a,
      dormant: 0x5a4a3a, dormantBorder: 0xa8985a,
      constructing: 0x3a3f47, constructingBorder: 0x808890,
    },
  }),
  goblin_wheel: def(2, {
    name: 'Goblin Wheel',
    short: 'GW',
    cost: 50,
    buildersRequired: 1,
    buildTime: 5,
    maintainersRequired: 1,
    income: 0,
    powerOutput: 100, // 100 W
    wanderInterval: 0.45,    // runs the wheel quickly
    wanderJitter: 0.15,
    colors: {
      active: 0x3a6a8a, activeBorder: 0x8acfff,
      dormant: 0x3a4a5a, dormantBorder: 0x7a8aa0,
      constructing: 0x3a3f47, constructingBorder: 0x808890,
    },
  }),
  datacentre: def(5, {
    name: 'Datacentre',
    short: 'DC',
    cost: 10_000,
    buildersRequired: 15,
    buildTime: 30,
    maintainersRequired: 15,
    waterDeliveryAmount: 50,
    waterAutoAssignTarget: 2,
    waterCarrierMax: 5,
    // 30% slower than the global default so a single carrier round-trip can
    // keep the DC sated longer.
    waterDepletionPerSec: 7,
    income: 1000,
    powerOutput: -6_000_000, // 6 MW draw
    wanderInterval: 1.4,
    wanderJitter: 0.8,
    colors: {
      active: 0x8a3a3a, activeBorder: 0xff8080,
      dormant: 0x4a3a3a, dormantBorder: 0x8a6a6a,
      constructing: 0x3a3f47, constructingBorder: 0x808890,
    },
  }),
  nuclear_reactor: def(2, {
    name: 'Nuclear Reactor',
    short: 'NR',
    cost: 500_000,
    buildersRequired: 4,
    buildTime: 60,
    maintainersRequired: 4,
    income: 0,
    powerOutput: 1_000_000_000, // 1 GW
    wanderInterval: 1.2,
    wanderJitter: 0.4,
    colors: {
      active: 0x2a6a4a, activeBorder: 0x6affb0,
      dormant: 0x2a4a3a, dormantBorder: 0x5a8a70,
      constructing: 0x3a3f47, constructingBorder: 0x808890,
    },
  }),
  dragon_beacon: def(3, {
    name: 'Dragon Beacon',
    short: 'DB',
    cost: 10_000_000,
    buildersRequired: 5,
    buildTime: 15,
    maintainersRequired: 0,
    income: 0,
    powerOutput: -5_000_000_000, // 5 GW
    wanderInterval: 1.0,
    wanderJitter: 0.2,
    colors: {
      active: 0xffa800, activeBorder: 0xffe080,
      dormant: 0x6a4a1a, dormantBorder: 0xa07840,
      constructing: 0x3a3f47, constructingBorder: 0x808890,
    },
  }),
  wall: def(1, {
    name: 'Wall',
    short: 'W',
    cost: 1,
    buildersRequired: 0,
    buildTime: 0,
    maintainersRequired: 0,
    income: 0,
    powerOutput: 0,
    wanderInterval: 0,
    wanderJitter: 0,
    colors: {
      active: 0x191919, activeBorder: 0x191919,
      dormant: 0x191919, dormantBorder: 0x191919,
      constructing: 0x191919, constructingBorder: 0x191919,
    },
  }),
  hypercentre: def(6, {
    name: 'Hypercentre',
    short: 'HC',
    cost: 500_000,
    buildersRequired: 20,
    buildTime: 30,
    maintainersRequired: 30,
    waterDeliveryAmount: 10,
    waterAutoAssignTarget: 5,
    waterCarrierMax: 15,
    income: 50_000,
    powerOutput: -1_000_000_000, // 1 GW draw
    wanderInterval: 1.6,
    wanderJitter: 0.9,
    colors: {
      active: 0x6a2a8a, activeBorder: 0xc080ff,
      dormant: 0x4a2a5a, dormantBorder: 0x80608a,
      constructing: 0x3a3f47, constructingBorder: 0x808890,
    },
  }),
  gas_engine: def(4, {
    name: 'Gas Turbine',
    short: 'GT',
    cost: 1900,
    buildersRequired: 5,
    buildTime: 7.5,
    maintainersRequired: 5,
    income: 0,
    powerOutput: 2_500_000, // 2.5 MW
    wanderInterval: 0.9,
    wanderJitter: 0.3,
    colors: {
      active: 0x3a6aaa, activeBorder: 0x9ac8ef,
      dormant: 0x3a4a5a, dormantBorder: 0x6a7a90,
      constructing: 0x3a3f47, constructingBorder: 0x808890,
    },
  }),
  goblin_hole: def(1, {
    name: 'Goblin Hole',
    short: 'GH',
    cost: 2626,
    buildersRequired: 0,
    buildTime: 4,
    maintainersRequired: 0,
    income: 0,
    powerOutput: 0,
    wanderInterval: 1.0,
    wanderJitter: 0.4,
    colors: {
      active: 0x2a1a2a, activeBorder: 0xa06aff,
      dormant: 0x2a1a2a, dormantBorder: 0x705580,
      constructing: 0x3a3f47, constructingBorder: 0x808890,
    },
  }),
  // Hell Portal — unlocked by the Build a Nuclear Reactor task. A
  // 1×1 portal that opens the way
  // down to Hell. Once placed, a red beam animates from the portal toward
  // the abyss below and the player can hold ↓ at the bottom of the map to
  // descend. Display name is "Bad power source?".
  hell_portal: def(1, {
    name: 'Bad power source?',
    short: 'BPS',
    cost: 999_999,
    bloodCost: 999,
    buildersRequired: 1,
    buildTime: 12,
    maintainersRequired: 0,
    income: 0,
    powerOutput: 1, // +1W — technically a power source
    wanderInterval: 1.0,
    wanderJitter: 0.2,
    colors: {
      active: 0x6a0a14, activeBorder: 0xff2030,
      dormant: 0x3a0a14, dormantBorder: 0x8a2030,
      constructing: 0x3a3f47, constructingBorder: 0x808890,
    },
  }),
  // Orbital Platform — the only structure built IN space rather than hauled
  // up to it. Its button replaces the Build list while the player is in
  // orbit (mirroring how the Candle takes over in hell). Requires 1 builder,
  // and the vacuum means only robots qualify — the player has to have a
  // dragon snatch a robot up first. Once assembled it's the foundation a
  // Space Centre can be set down on — its deck is a bit wider than the
  // Centre's footprint, leaving a walkable rim where robots park.
  orbital_platform: def(9, {
    name: 'Orbital Platform',
    short: 'OP',
    cost: 1_000_000,
    buildersRequired: 1,
    buildTime: 20,
    maintainersRequired: 0,
    income: 0,
    powerOutput: 0,
    wanderInterval: 0,
    wanderJitter: 0,
    colors: {
      active: 0x4a505a, activeBorder: 0xb8bec6,
      dormant: 0x3a3f47, dormantBorder: 0x808890,
      constructing: 0x3a3f47, constructingBorder: 0x808890,
    },
  }),
  // Space Centre — the endgame income building, built in orbit and ONLY on
  // top of a completed Orbital Platform (one Centre per platform — tapping
  // bare void refuses with a "no platform" floater). Bigger than a
  // Hypercentre but a bit smaller than its platform, so robots still fit on
  // the deck around it. Robot-assembled like the platform under it, and a
  // glutton: each one draws 10 GW from the ground grid but pays out a
  // fortune while the power link holds.
  space_centre: def(7, {
    name: 'Space Centre',
    short: 'SC',
    cost: 25_000_000,
    buildersRequired: 1,
    buildTime: 30,
    maintainersRequired: 0,
    income: 500_000,
    powerOutput: -10_000_000_000, // 10 GW draw
    wanderInterval: 0,
    wanderJitter: 0,
    colors: {
      active: 0x1a5a6a, activeBorder: 0x6ae0ff,
      dormant: 0x2a3f4a, dormantBorder: 0x5a8090,
      constructing: 0x3a3f47, constructingBorder: 0x808890,
    },
  }),
} as const;

export type BuildingKind = keyof typeof BUILDING_DEFS;
export const BUILDABLE_KINDS: BuildingKind[] = ['goblin_wheel', 'gas_engine', 'datacentre', 'phone_farm', 'goblin_hole', 'nuclear_reactor', 'hypercentre', 'dragon_beacon', 'hell_portal', 'wall'];

export const START_MONEY = 0;
export const START_GOBLINS = 0;
// Place start near the top-left of the playable area, just inside the wall border.
export const START_CELL = { cx: INITIAL_PLAY_X0 + 4, cy: INITIAL_PLAY_Y0 + 8 };

export function formatPower(w: number): string {
  const abs = Math.abs(w);
  if (abs >= 1e9) return `${(Math.floor(w / 1e9 * 100) / 100).toFixed(2)} GW`;
  if (abs >= 1e6) return `${(Math.floor(w / 1e6 * 100) / 100).toFixed(2)} MW`;
  return `${Math.floor(w)} W`;
}
