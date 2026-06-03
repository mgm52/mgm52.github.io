import { BUILDING_DEFS, BuildingKind } from './config';
import treeData from './upgrade-tree.json';

// ─── The pip-based upgrade tree ──────────────────────────────────────
// Tasks pay out pips; pips buy upgrade nodes; owning a node surfaces its
// button in the Build / Summon / Ritual menus (gating lives in ui.ts).
// All balance numbers live in upgrade-tree.json so the dev editor
// (upgrade-editor.html, vite dev server only) can tweak and save them
// without touching code.

export type UpgradeDef = { cost: number; requires: string[] };

// A task's completion condition, as a data template the game turns into a
// live check (goalDone) and a label (goalText). The dev editor builds new
// work blocks from these.
export type CreatureKind = 'goblin' | 'minotaur' | 'dragon';
export type TaskGoal =
  | { type: 'earn_money'; amount: number }     // money balance reaches amount
  | { type: 'place'; building: string; count: number }  // N of kind ever placed (cumulative)
  | { type: 'build'; building: string; count: number }  // N of kind ever finished constructing (cumulative)
  | { type: 'run'; building: string; count: number }    // N of kind simultaneously active
  | { type: 'kill'; creature: CreatureKind; count: number } // cumulative kills (state.kills)
  | { type: 'summon_minotaurs'; count: number }  // cumulative Minotaurs bought
  | { type: 'collect_bones'; amount: number };   // cumulative dragon bones earned

export type TaskDef = {
  id: string;
  pips: number;
  goal: TaskGoal;
  // Custom label; goalText(goal) when absent.
  text?: string;
  // Renders as "Optional: …" and sorts below mandatory work in the task line.
  optional?: boolean;
  // Prerequisite task ids — explicit DAG, same model as an upgrade's
  // requires. Empty/absent = available from the start.
  requires?: string[];
  // Legacy single-prereq field from when mandatory tasks chained in array
  // order; folded into `requires` by taskRequiresOf.
  after?: string;
};

// What a truthful demon parlay grants Bob (demon-dialogue.ts). 'upgrade'
// adds the node to purchasedUpgrades free of charge — the id may be a tree
// node or an off-tree ability (the default 'lightning' isn't a tree node
// unless the designer adds it, in which case the demon should probably
// reward something else).
export type DemonReward =
  | { type: 'upgrade'; id: string }
  | { type: 'pips'; amount: number }
  | { type: 'money'; amount: number }
  | { type: 'blood'; amount: number }
  | { type: 'bones'; amount: number };

export type UpgradeTreeData = {
  // ORDERED: mandatory tasks chain in array order (see taskPrereqOf).
  tasks: TaskDef[];
  upgrades: Record<string, UpgradeDef>;
  layout: Record<string, { x: number; y: number }>;
  demonReward?: DemonReward;
};

export const UPGRADE_TREE = treeData as UpgradeTreeData;

// Falls back to the original gift when the json predates the field.
export function demonReward(): DemonReward {
  return UPGRADE_TREE.demonReward ?? { type: 'upgrade', id: 'lightning' };
}

// Tasks that shipped with the game. The dev editor warns before deleting
// these — game code still references a couple of their ids (the money-rate
// readout gate, the collect_dragon_bones secret-settings gag, the work-skip
// rigs), all of which degrade gracefully if they're gone.
export const BUILTIN_TASK_IDS = new Set([
  'earn_100', 'run_phone_farm', 'build_gas_engine', 'run_datacentre',
  'build_hypercentre', 'summon_minotaurs', 'collect_dragon_bones',
]);

// A task's prerequisite task ids. Tasks carry an explicit `requires` DAG
// (like upgrades); the legacy `after` single-prereq field folds in for old
// json files.
export function taskRequiresOf(d: TaskDef): string[] {
  if (d.requires) return d.requires;
  return d.after ? [d.after] : [];
}

const CREATURE_NAMES: Record<CreatureKind, string> = {
  goblin: 'Goblin', minotaur: 'Minotaur', dragon: 'Dragon',
};

function buildingDisplayName(id: string): string {
  return isBuildingUpgrade(id) ? BUILDING_DEFS[id].name : id;
}

// Auto-generated task label for a goal template.
export function goalText(goal: TaskGoal): string {
  switch (goal.type) {
    case 'earn_money':
      return `Earn Ƶ${goal.amount.toLocaleString('en-US')}`;
    case 'place': {
      const name = buildingDisplayName(goal.building);
      return goal.count === 1 ? `Place a ${name}` : `Place ${goal.count} ${name}s`;
    }
    case 'build': {
      const name = buildingDisplayName(goal.building);
      return goal.count === 1 ? `Build a ${name}` : `Build ${goal.count} ${name}s`;
    }
    case 'run': {
      const name = buildingDisplayName(goal.building);
      return goal.count === 1 ? `Run a ${name}` : `Run ${goal.count} ${name}s`;
    }
    case 'kill': {
      const name = CREATURE_NAMES[goal.creature];
      return goal.count === 1 ? `Kill a ${name}` : `Kill ${goal.count} ${name}s`;
    }
    case 'summon_minotaurs':
      return goal.count === 1 ? 'Summon a Minotaur' : `Summon ${goal.count} Minotaurs`;
    case 'collect_bones':
      return `Collect ${goal.amount} dragon bone${goal.amount === 1 ? '' : 's'}`;
  }
}

// The slice of GameState a goal check reads. Structural (like PipState) so
// the dev editor importing this module doesn't drag state.ts in at runtime.
export type GoalState = {
  money: number;
  buildings: Map<number, { kind: string; state: string }>;
  // Cumulative placements / construction completions per kind. Both are
  // monotonic, so place/build goals stay reachable even after the targeted
  // kind is demolished, hauled to space, or its build button is outgrown.
  buildingCounts: Record<BuildingKind, number>;
  buildingsBuilt: Record<BuildingKind, number>;
  kills: Record<CreatureKind, number>;
  minotaursBought: number;
  dragonBoneEarned: number;
};

export function goalDone(goal: TaskGoal, s: GoalState): boolean {
  switch (goal.type) {
    case 'earn_money':
      return s.money >= goal.amount;
    case 'place':
      // Cumulative ever-placed count (buildingCounts is monotonic).
      return ((s.buildingCounts as Record<string, number | undefined>)[goal.building] ?? 0) >= goal.count;
    case 'build':
      // Cumulative ever-finished count.
      return ((s.buildingsBuilt as Record<string, number | undefined>)[goal.building] ?? 0) >= goal.count;
    case 'run': {
      // Simultaneously active — intentionally a live count.
      let n = 0;
      for (const b of s.buildings.values()) {
        if (b.kind === goal.building && b.state === 'active' && ++n >= goal.count) return true;
      }
      return false;
    }
    case 'kill':
      return s.kills[goal.creature] >= goal.count;
    case 'summon_minotaurs':
      return s.minotaursBought >= goal.count;
    case 'collect_bones':
      return s.dragonBoneEarned >= goal.amount;
  }
}

// Support nodes a building needs before it can actually RUN: a generator
// tier sized to its power draw, plus the dig+minotaur water chain for
// drinkers. Derived from BUILDING_DEFS so new buildings inherit sensible
// inference. Drives the editor's needs-lines and balance simulation, which
// would otherwise report e.g. "run a Phone Farm" as affordable without the
// Goblin Wheel that powers it.
function runSupportNeeds(building: string): string[] {
  if (!isBuildingUpgrade(building)) return [];
  const def = BUILDING_DEFS[building];
  const needs: string[] = [];
  if (def.powerOutput < 0) {
    const draw = -def.powerOutput;
    // Wheels are 100 W, Gas Turbines 2.5 MW, Reactors 1 GW — pick the
    // smallest tier the player could plausibly stack to cover the draw.
    needs.push(draw <= 1_000 ? 'goblin_wheel' : draw <= 100_000_000 ? 'gas_engine' : 'nuclear_reactor');
  }
  if (def.waterDeliveryAmount !== undefined) needs.push('dig', 'minotaur');
  return needs;
}

// The upgrades a goal implicitly depends on — drives the editor's
// work→unlock lines and its balance simulation. Only ids that exist as tree
// nodes are reported (off-tree ids can't be bought, so they aren't "needs").
export function goalNeeds(goal: TaskGoal): string[] {
  const needs = (() => {
    switch (goal.type) {
      case 'earn_money': return [];
      case 'place':
      case 'build':
        return [goal.building];
      case 'run':
        return [goal.building, ...runSupportNeeds(goal.building)];
      case 'kill':
        if (goal.creature === 'minotaur') return ['minotaur'];
        if (goal.creature === 'dragon') return ['dragon_beacon', ...runSupportNeeds('dragon_beacon')];
        return [];
      case 'summon_minotaurs': return ['minotaur'];
      case 'collect_bones': return ['dragon_beacon', ...runSupportNeeds('dragon_beacon')];
    }
  })();
  return [...new Set(needs)].filter((id) => id in UPGRADE_TREE.upgrades);
}

// The slice of GameState the purchase logic needs. Structural so this module
// (which the dev editor also imports) never drags in state.ts at runtime.
export type PipState = { pips: number; purchasedUpgrades: Set<string> };

// Upgrade nodes that aren't building kinds: the purchasable abilities.
// `section` says which sidebar list the unlocked button lives in. Not every
// ability has to be in the tree — lightning starts off-tree as the demon's
// gift, but the editor can add it as a node (and reassign the demon's gift).
export const ABILITY_UPGRADES: Record<string, { name: string; section: 'summon' | 'ritual'; desc: string }> = {
  minotaur: { name: 'Minotaur', section: 'summon', desc: 'Summon hulking Minotaurs with blood' },
  dig: { name: 'Dig', section: 'ritual', desc: 'Expand the map outward (needs a Minotaur)' },
  autobuild: { name: 'Autobuild', section: 'ritual', desc: 'Idle goblins staff constructions on their own' },
  autospawn: { name: 'Autospawn', section: 'ritual', desc: 'Goblins spawn automatically while cash allows' },
  goldblins: { name: 'Goldblins', section: 'ritual', desc: '~10% of new goblins spawn gold and drop bonus cash' },
  lightning: { name: 'Lightning Strike', section: 'ritual', desc: 'Call down an aimed bolt that reaps every unit it hits' },
};

// Every id that may exist as an upgrade node — building kinds plus the
// ability ids above. The editor's "+ Add upgrade" offers the ones not
// currently in the tree.
export function upgradeCatalogIds(): string[] {
  return [...Object.keys(BUILDING_DEFS), ...Object.keys(ABILITY_UPGRADES)];
}

export function isBuildingUpgrade(id: string): id is BuildingKind {
  return id in BUILDING_DEFS;
}

export function upgradeName(id: string): string {
  if (isBuildingUpgrade(id)) return BUILDING_DEFS[id].name;
  return ABILITY_UPGRADES[id]?.name ?? id;
}

export function upgradeSection(id: string): 'build' | 'summon' | 'ritual' {
  // The Goblin Hole is a building but renders in the Ritual list (see ui.ts).
  if (id === 'goblin_hole') return 'ritual';
  if (isBuildingUpgrade(id)) return 'build';
  return ABILITY_UPGRADES[id]?.section ?? 'ritual';
}

export function pipsForTask(taskId: string): number {
  return UPGRADE_TREE.tasks.find((t) => t.id === taskId)?.pips ?? 0;
}

export function upgradeOwned(state: PipState, id: string): boolean {
  return state.purchasedUpgrades.has(id);
}

export function upgradePrereqsMet(state: PipState, id: string): boolean {
  const def = UPGRADE_TREE.upgrades[id];
  if (!def) return false;
  return def.requires.every((r) => state.purchasedUpgrades.has(r));
}

export function canPurchaseUpgrade(state: PipState, id: string): boolean {
  const def = UPGRADE_TREE.upgrades[id];
  if (!def) return false;
  return !upgradeOwned(state, id) && upgradePrereqsMet(state, id) && state.pips >= def.cost;
}

export function purchaseUpgrade(state: PipState, id: string): boolean {
  if (!canPurchaseUpgrade(state, id)) return false;
  state.pips -= UPGRADE_TREE.upgrades[id].cost;
  state.purchasedUpgrades.add(id);
  return true;
}

export function anyUpgradeAffordable(state: PipState): boolean {
  for (const id of Object.keys(UPGRADE_TREE.upgrades)) {
    if (canPurchaseUpgrade(state, id)) return true;
  }
  return false;
}

// ─── Legacy-save migration ───────────────────────────────────────────
// Before pips, each task's completion directly unlocked these nodes. A save
// from that era carries only completed task ids, so loadGame seeds the
// purchase set from this map (no pips refunded — the player ends up exactly
// where the old gating left them).
export const LEGACY_TASK_UNLOCKS: Record<string, string[]> = {
  earn_100: ['goblin_wheel', 'phone_farm'],
  run_phone_farm: ['gas_engine', 'autobuild', 'autospawn'],
  build_gas_engine: ['datacentre', 'minotaur', 'dig'],
  run_datacentre: ['nuclear_reactor', 'hypercentre', 'wall'],
  build_hypercentre: ['dragon_beacon', 'hell_portal'],
  summon_minotaurs: ['goblin_hole', 'goldblins'],
};

// Display label for a task: custom text wins, else generated from the goal.
export function taskText(d: TaskDef): string {
  return d.text ?? goalText(d.goal);
}
