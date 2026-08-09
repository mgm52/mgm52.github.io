// Unit tests for the trading-card realm's core logic (src/cards-core.ts):
// world generation validity, serialization round-trips (including through
// the JSON meta blob), trader wants + the want-satisfaction rules, manual-
// pool minting, and the gathering generator's progression guarantees. Run
// with `npm test`.

import { describe, expect, it } from 'vitest';
import {
  CardMeta, CardTier, CHARM_DEFS, CHARM_KINDS, HARDCODED_LEVELS, ManualWorld,
  MAIN_TRACK, RARE_DEPTH,
  TIER_ABOVE, TIER_RANK, Want, WorldCard, applyCharms, cardFromManual, cardPower,
  cardQualifies, countQualifying, decodeWorld, encodeWorld, ensureBranches,
  generateEvents, generateJunkWorld, generateWeirdWorld, makeCard, makeCharmCard,
  mintDeckCard, mulberry32, pathName, regenerateEvent, resetChain, rollWant,
  sceneStructureCounts, spicyAmount, tradeKeepsAWorld, wantLine, wantSatisfiableBy,
  wantSatisfiedBy, worldName, makeKeyCard, makeSalon, salonName, salonTierForDepth,
  STOLEN_DEPTH,
} from '../src/cards-core';
import { BUILDING_DEFS, SOUL_SIGIL } from '../src/config';
import { GameState, cellKey, isInPlayCell } from '../src/state';

const TASK_IDS = ['earn_100', 'run_phone_farm', 'collect_blood'];
const TIERS: CardTier[] = ['common', 'uncommon', 'rare'];

// resets: 1 puts the meta past the first reset, on the procedural chain most
// tests exercise; tests of the opening hand-authored chain set resets: 0.
function freshMeta(): CardMeta {
  return { v: 1, phase: 'free', nextId: 1, cards: [], events: null, activeCardId: null, resets: 1 };
}

function card(tier: CardTier, over: Partial<WorldCard> = {}): WorldCard {
  return {
    id: over.id ?? Math.floor(Math.random() * 1e9),
    name: 'test world',
    tier,
    data: '',
    resources: { money: 0, blood: 0, dragonBone: 0, power: 0 },
    ...over,
  };
}

// ─── Seeded RNG ──────────────────────────────────────────────────────

describe('mulberry32', () => {
  it('is deterministic per seed and bounded to [0, 1)', () => {
    const a = mulberry32(123), b = mulberry32(123), c = mulberry32(124);
    const seqA = [a(), a(), a()];
    const seqB = [b(), b(), b()];
    expect(seqA).toEqual(seqB);
    expect(seqA).not.toEqual([c(), c(), c()]);
    const r = mulberry32(42);
    for (let i = 0; i < 1000; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

// ─── World generation ────────────────────────────────────────────────

describe('generateWeirdWorld', () => {
  it.each(TIERS)('produces a sanitized, demonless %s world', (tier) => {
    for (let seed = 1; seed <= 5; seed++) {
      const st = generateWeirdWorld(seed * 1000 + 7, tier, TASK_IDS);
      expect(st.cardWorld).toBe(true);
      expect(st.demons.size).toBe(0);
      expect(st.finale).toBeNull();
      expect(st.lolly).toBeNull();
      expect(st.gabbonsawBought).toBe(true);
      expect(st.bobSpawned).toBe(true);
      expect(st.bobLollyDeparted).toBe(true);
      expect([...st.goblins.values()].some((g) => g.bob)).toBe(false);
      expect(st.ghosts.some((g) => g.bob)).toBe(false);
      expect(st.view).toBe('ground');
      // The world sits partway along the work track: completed is a prefix
      // of the track (never out-of-order), and revealed mirrors it exactly
      // so the stamped tasks never replay their celebrations.
      const completed = st.unlocks!.completed;
      expect([...st.unlocks!.revealed].sort()).toEqual([...completed].sort());
      const track = MAIN_TRACK.filter((id) => TASK_IDS.includes(id));
      const onTrack = track.filter((id) => completed.has(id));
      expect(track.slice(0, onTrack.length)).toEqual(onTrack);
    }
  });

  it('deals worlds at tier-appropriate phases of the work track', () => {
    // The real game's full track — commons stay early, rares land late.
    const fullTrack = [...MAIN_TRACK];
    for (let seed = 1; seed <= 20; seed++) {
      const common = generateWeirdWorld(seed * 7, 'common', fullTrack, 'balanced');
      const doneCommon = fullTrack.filter((id) => common.unlocks!.completed.has(id));
      expect(doneCommon.length).toBeGreaterThanOrEqual(1);
      expect(doneCommon.length).toBeLessThanOrEqual(3);

      const rare = generateWeirdWorld(seed * 13, 'rare', fullTrack, 'balanced');
      const doneRare = fullTrack.filter((id) => rare.unlocks!.completed.has(id));
      expect(doneRare.length).toBeGreaterThanOrEqual(5);
    }
  });

  it('places buildings on in-play, non-overlapping footprints', () => {
    for (const tier of TIERS) {
      const st = generateWeirdWorld(tier.length * 99 + 1, tier, TASK_IDS);
      const claimed = new Set<string>();
      for (const b of st.buildings.values()) {
        const n = BUILDING_DEFS[b.kind].cellSize;
        for (let dy = 0; dy < n; dy++) {
          for (let dx = 0; dx < n; dx++) {
            const key = cellKey(b.cell.cx + dx, b.cell.cy + dy);
            expect(isInPlayCell(st, b.cell.cx + dx, b.cell.cy + dy)).toBe(true);
            expect(claimed.has(key)).toBe(false);
            claimed.add(key);
          }
        }
      }
    }
  });

  it('registers goblins in the occupancy index on free in-play cells', () => {
    const st = generateWeirdWorld(31337, 'rare', TASK_IDS);
    expect(st.goblins.size).toBeGreaterThan(0);
    for (const g of st.goblins.values()) {
      expect(isInPlayCell(st, g.cell.cx, g.cell.cy)).toBe(true);
      expect(st.occupancy.get(cellKey(g.cell.cx, g.cell.cy))).toBe(g.id);
    }
  });

  it('scales resources with tier and keeps the sticky unlock flags consistent', () => {
    // Pinned to the balanced flavor — the spiked flavors deliberately break
    // the tier baselines this test checks.
    const common = generateWeirdWorld(5, 'common', TASK_IDS, 'balanced');
    const rare = generateWeirdWorld(5, 'rare', TASK_IDS, 'balanced');
    expect(common.money).toBeLessThanOrEqual(60);
    expect(rare.money).toBeGreaterThanOrEqual(100_000);
    expect(rare.blood).toBeGreaterThanOrEqual(1_000);
    expect(rare.dragonBone).toBeGreaterThanOrEqual(4);
    expect(common.bloodUnlocked).toBe(common.blood > 0);
    expect(rare.dragonBoneUnlocked).toBe(true);
  });

  it('only unlocks hell when a portal actually exists', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const st = generateWeirdWorld(seed, 'rare', TASK_IDS);
      const hasPortal = [...st.buildings.values()].some((b) => b.kind === 'hell_portal');
      expect(st.hellUnlocked).toBe(hasPortal);
    }
  });
});

describe('generateJunkWorld', () => {
  it('is pitiful: Ƶ3, at most two goblins, walls only, nothing unlocked', () => {
    for (let seed = 1; seed <= 5; seed++) {
      const st = generateJunkWorld(seed * 17, TASK_IDS);
      expect(st.money).toBe(3);
      expect(st.blood).toBe(0);
      expect(st.dragonBone).toBe(0);
      expect(st.goblins.size).toBeLessThanOrEqual(2);
      expect([...st.buildings.values()].every((b) => b.kind === 'wall')).toBe(true);
      expect(st.ghosts).toEqual([]);
      expect(st.hellUnlocked).toBe(false);
      expect(st.spaceUnlocked).toBe(false);
      expect(st.spaceBuildings.size).toBe(0);
      // The junk world replays the game's opening: nothing on the work
      // track is done. And with the spawn hole caved in, no income source
      // exists — its Ƶ10,000 demand is only reachable by trading it away.
      expect(st.unlocks!.completed.size).toBe(0);
      expect(st.unlocks!.revealed.size).toBe(0);
      expect(st.holeDestroyed).toBe(true);
    }
  });
});

describe('world flavors (the spikes)', () => {
  it('each named flavor leaves its signature on the world', () => {
    for (let seed = 1; seed <= 4; seed++) {
      const blood = generateWeirdWorld(seed * 11, 'common', TASK_IDS, 'bloodbath');
      expect(blood.blood).toBeGreaterThanOrEqual(15);
      expect(blood.blood).toBeGreaterThan(blood.money);

      const mint = generateWeirdWorld(seed * 13, 'common', TASK_IDS, 'mint');
      expect(mint.money).toBeGreaterThanOrEqual(180);
      expect(mint.blood).toBe(0);

      // Bones at common — unheard of outside a boneyard.
      const bones = generateWeirdWorld(seed * 17, 'common', TASK_IDS, 'boneyard');
      expect(bones.dragonBone).toBeGreaterThanOrEqual(1);
      expect(bones.dragonBoneUnlocked).toBe(true);

      const mono = generateWeirdWorld(seed * 19, 'uncommon', TASK_IDS, 'monoculture');
      const kinds = new Set([...mono.buildings.values()].map((b) => b.kind));
      expect(kinds.size).toBe(1);
      expect(mono.buildings.size).toBeGreaterThanOrEqual(5);

      const crowd = generateWeirdWorld(seed * 23, 'common', TASK_IDS, 'crowd');
      expect(crowd.goblins.size).toBeGreaterThanOrEqual(5);

      const haunted = generateWeirdWorld(seed * 29, 'common', TASK_IDS, 'haunted');
      expect(haunted.ghosts.length).toBeGreaterThanOrEqual(10);
      expect(haunted.hellUnlocked).toBe(true);
      expect([...haunted.buildings.values()].some((b) => b.kind === 'hell_portal')).toBe(true);

      // The séance: hell open behind a portal, the bank holding a
      // five-candle budget (plus crumbs), souls in short supply.
      const seance = generateWeirdWorld(seed * 31, 'common', TASK_IDS, 'seance');
      expect(seance.hellUnlocked).toBe(true);
      expect([...seance.buildings.values()].some((b) => b.kind === 'hell_portal')).toBe(true);
      const budget = SOUL_SIGIL.count * SOUL_SIGIL.candleBloodCost;
      expect(seance.blood).toBeGreaterThanOrEqual(budget);
      expect(seance.blood).toBeLessThanOrEqual(budget + 6);
      expect(seance.ghosts.length).toBeLessThan(SOUL_SIGIL.count);

      // Overcharged: reactors standing, pockets empty, track reset to the
      // opening grind.
      const oc = generateWeirdWorld(seed * 37, 'uncommon', TASK_IDS, 'overcharged');
      expect(oc.money).toBeLessThanOrEqual(10);
      expect([...oc.buildings.values()].some((b) => b.kind === 'nuclear_reactor' || b.kind === 'gas_engine')).toBe(true);
      expect(oc.unlocks!.completed.size).toBeLessThanOrEqual(1);

      // Goldrush: every standing goblin glitters, and fresh spawns can too.
      const gr = generateWeirdWorld(seed * 41, 'common', TASK_IDS, 'goldrush');
      expect(gr.goblins.size).toBeGreaterThan(0);
      expect([...gr.goblins.values()].every((g) => g.gold)).toBe(true);
      expect(gr.goldgoblinsEnabled).toBe(true);
      expect(gr.money).toBeLessThanOrEqual(30);

      // Flooded: extra lakes beyond whatever the dug arms brought.
      const fl = generateWeirdWorld(seed * 43, 'common', TASK_IDS, 'flooded');
      expect(fl.waterSources.size).toBeGreaterThanOrEqual(3);
    }
  });

  it('spicyAmount stays inside the band and sometimes lands charismatic figures', () => {
    let charismatic = 0;
    for (let seed = 0; seed < 300; seed++) {
      const v = spicyAmount(5_000, 15_000, mulberry32(seed));
      expect(v).toBeGreaterThanOrEqual(5_000);
      expect(v).toBeLessThanOrEqual(15_000);
      if (v === 8_192 || v === 6_666 || v === 7_777 || v === 8_888 || v === 9_999 || v % 1_000 === 0) charismatic++;
    }
    expect(charismatic).toBeGreaterThan(30);
  });

  it('still mints challenge-flavor worlds unforced (they just carry no demand now)', () => {
    const meta = freshMeta();
    let seance = 0, overcharged = 0;
    for (let seed = 0; seed < 200 && (!seance || !overcharged); seed++) {
      const c = makeCard(meta, 'common', mulberry32(seed), TASK_IDS);
      // Cards no longer carry an ascension demand at all.
      expect((c as { upgradeReq?: unknown }).upgradeReq).toBeUndefined();
      const st = decodeWorld(c.data)!;
      const isSeance = st.hellUnlocked
        && st.blood >= SOUL_SIGIL.count * SOUL_SIGIL.candleBloodCost
        && st.blood <= SOUL_SIGIL.count * SOUL_SIGIL.candleBloodCost + 6;
      if (isSeance) seance++;
      const isOvercharged = st.money <= 10
        && [...st.buildings.values()].some((b) => b.kind === 'nuclear_reactor');
      if (isOvercharged) overcharged++;
    }
    expect(seance).toBeGreaterThan(0);
    expect(overcharged).toBeGreaterThan(0);
  });

  it('unforced generation actually varies across seeds', () => {
    const signatures = new Set<string>();
    for (let seed = 1; seed <= 24; seed++) {
      const st = generateWeirdWorld(seed * 101, 'uncommon', TASK_IDS);
      signatures.add([
        st.blood > st.money ? 'bloody' : 'moneyed',
        st.goblins.size > 12 ? 'crowded' : 'sparse',
        st.ghosts.length > 20 ? 'haunted' : 'quiet',
      ].join('-'));
    }
    expect(signatures.size).toBeGreaterThanOrEqual(3);
  });
});

describe('sceneStructureCounts (preview pane fade/glow)', () => {
  it('walls are scenery: the junk world reads as nothing-built everywhere', () => {
    const counts = sceneStructureCounts(generateJunkWorld(3, TASK_IDS));
    expect(counts).toEqual({ space: 0, earth: 0, hell: 0 });
  });

  it('counts each scene separately', () => {
    const haunted = generateWeirdWorld(7, 'common', TASK_IDS, 'haunted');
    expect(sceneStructureCounts(haunted).hell).toBeGreaterThanOrEqual(1); // the portal
    const mono = generateWeirdWorld(9, 'uncommon', TASK_IDS, 'monoculture');
    const counts = sceneStructureCounts(mono);
    const nonWall = [...mono.buildings.values()].filter((b) => b.kind !== 'wall').length;
    expect(counts.earth).toBe(nonWall);
    // Find a rare with space debris for the orbit count.
    for (let seed = 1; seed < 60; seed++) {
      const st = generateWeirdWorld(seed, 'rare', TASK_IDS);
      if (st.spaceBuildings.size > 0) {
        expect(sceneStructureCounts(st).space).toBe(st.spaceBuildings.size);
        return;
      }
    }
    throw new Error('no rare world with space debris in 60 seeds');
  });
});

// ─── Serialization ───────────────────────────────────────────────────

describe('world serialization', () => {
  it('round-trips a generated world through encode/decode', () => {
    const st = generateWeirdWorld(2024, 'uncommon', TASK_IDS);
    const back = decodeWorld(encodeWorld(st));
    expect(back).not.toBeNull();
    const b = back as GameState;
    expect(b.money).toBe(st.money);
    expect(b.blood).toBe(st.blood);
    expect(b.buildings.size).toBe(st.buildings.size);
    expect(b.goblins.size).toBe(st.goblins.size);
    expect(b.cardWorld).toBe(true);
    expect(b.walls instanceof Set).toBe(true);
    expect(b.occupancy instanceof Map).toBe(true);
  });

  it('survives the meta blob: card data stays decodable through JSON', () => {
    // The compressed UTF-16 payload rides inside JSON.stringify(meta) in
    // localStorage — this guards against any encoding that JSON mangles.
    const meta = freshMeta();
    const rng = mulberry32(99);
    const c = makeCard(meta, 'common', rng, TASK_IDS);
    const thawed = JSON.parse(JSON.stringify({ meta: { cards: [c] } })) as { meta: { cards: WorldCard[] } };
    const st = decodeWorld(thawed.meta.cards[0].data);
    expect(st).not.toBeNull();
    expect(st!.money).toBe(c.resources.money);
  });

  it('returns null for garbage data instead of throwing', () => {
    expect(decodeWorld('not a save')).toBeNull();
    expect(decodeWorld('')).toBeNull();
  });
});

// ─── Trader wants ────────────────────────────────────────────────────

describe('wantLine', () => {
  it('reads naturally for each kind of want', () => {
    expect(wantLine({ kind: 'any', count: 1 })).toBe('i will take any world.');
    expect(wantLine({ kind: 'any', count: 2 })).toBe('i want any two worlds.');
    expect(wantLine({ kind: 'tier', tier: 'common', count: 1 })).toBe('i want any common world.');
    expect(wantLine({ kind: 'tier', tier: 'uncommon', count: 3 })).toBe('i want three uncommon worlds.');
    expect(wantLine({ kind: 'resource', res: 'money', amount: 10_000, count: 1 })).toBe('i want a world worth Ƶ10,000+.');
    expect(wantLine({ kind: 'resource', res: 'blood', amount: 800, count: 1 })).toContain('800+ blood');
    expect(wantLine({ kind: 'resource', res: 'dragonBone', amount: 5, count: 2 })).toContain('5+ bones');
    expect(wantLine({ kind: 'resource', res: 'power', amount: 1_000_000_000, count: 1 })).toContain('making');
  });
});

describe('cardQualifies / wantSatisfiedBy / wantSatisfiableBy', () => {
  const any1: Want = { kind: 'any', count: 1 };
  const twoCommon: Want = { kind: 'tier', tier: 'common', count: 2 };
  const richWant: Want = { kind: 'resource', res: 'money', amount: 1_000, count: 1 };

  it('cardQualifies matches each want against a single card', () => {
    expect(cardQualifies(any1, card('rare'))).toBe(true);
    expect(cardQualifies(twoCommon, card('common'))).toBe(true);
    expect(cardQualifies(twoCommon, card('uncommon'))).toBe(false);
    expect(cardQualifies(richWant, card('common', { resources: { money: 5_000, blood: 0, dragonBone: 0 } }))).toBe(true);
    expect(cardQualifies(richWant, card('common', { resources: { money: 500, blood: 0, dragonBone: 0 } }))).toBe(false);
    // Power reads the measured production field.
    const powWant: Want = { kind: 'resource', res: 'power', amount: 1_000, count: 1 };
    expect(cardQualifies(powWant, card('rare', { resources: { money: 0, blood: 0, dragonBone: 0, power: 2_000 } }))).toBe(true);
  });

  it('countQualifying / wantSatisfiableBy gauge a whole hand', () => {
    const hand = [card('common'), card('common'), card('uncommon')];
    expect(countQualifying(twoCommon, hand)).toBe(2);
    expect(wantSatisfiableBy(twoCommon, hand)).toBe(true);
    expect(wantSatisfiableBy({ kind: 'tier', tier: 'common', count: 3 }, hand)).toBe(false);
    expect(wantSatisfiableBy(any1, [])).toBe(false);
  });

  it('wantSatisfiedBy needs the exact offer: right count, every card qualifying', () => {
    const c1 = card('common', { id: 1 }), c2 = card('common', { id: 2 }), u = card('uncommon', { id: 3 });
    expect(wantSatisfiedBy(twoCommon, [c1, c2])).toBe(true);
    expect(wantSatisfiedBy(twoCommon, [c1])).toBe(false);          // too few
    expect(wantSatisfiedBy(twoCommon, [c1, c2, card('common')])).toBe(false); // too many
    expect(wantSatisfiedBy(twoCommon, [c1, u])).toBe(false);       // one doesn't qualify
    expect(wantSatisfiedBy(any1, [c1])).toBe(true);
    expect(wantSatisfiedBy(any1, [c1, c2])).toBe(false);           // any wants exactly one
  });
});

describe('rollWant', () => {
  it('hands the opener an easy rung: any-one at common, a single lesser-tier card above', () => {
    for (let seed = 0; seed < 50; seed++) {
      const rng = mulberry32(seed);
      expect(rollWant('common', rng, true)).toEqual({ kind: 'any', count: 1 });
      expect(rollWant('uncommon', mulberry32(seed), true)).toEqual({ kind: 'tier', tier: 'common', count: 1 });
      expect(rollWant('rare', mulberry32(seed), true)).toEqual({ kind: 'tier', tier: 'uncommon', count: 1 });
    }
  });

  it('the picky slots ask for the table\'s own tier, a resource threshold in band, or a charm', () => {
    for (let seed = 0; seed < 200; seed++) {
      const w = rollWant('common', mulberry32(seed), false);
      expect(w.kind === 'tier' || w.kind === 'resource' || w.kind === 'charm').toBe(true);
      if (w.kind === 'charm') expect(w.count).toBe(1);
      if (w.kind === 'tier') {
        expect(w.tier).toBe('common');
        expect(w.count).toBeGreaterThanOrEqual(1);
        expect(w.count).toBeLessThanOrEqual(3);
      } else {
        // Common's resource bands: cash 1k–15k, blood 50–800.
        expect(['money', 'blood']).toContain(w.res);
        if (w.res === 'money') { expect(w.amount).toBeGreaterThanOrEqual(1_000); expect(w.amount).toBeLessThanOrEqual(15_000); }
        else { expect(w.amount).toBeGreaterThanOrEqual(50); expect(w.amount).toBeLessThanOrEqual(800); }
      }
    }
  });
});

describe('makeCard', () => {
  it('mints the junk card as a pitiful Ƶ3 common', () => {
    const meta = freshMeta();
    const junk = makeCard(meta, 'common', mulberry32(1), TASK_IDS, true);
    expect(junk.tier).toBe('common');
    expect(junk.resources.money).toBe(3);
  });

  it('reads no power off a never-run card: dormant generators don\'t count', () => {
    const meta = freshMeta();
    for (let seed = 0; seed < 8; seed++) {
      const c = makeCard(meta, 'common', mulberry32(seed), TASK_IDS);
      const st = decodeWorld(c.data)!;
      // The card reports the world's real output, not the theoretical sum of
      // every generator placed — and a generated common's buildings all sit
      // dormant (walls, the only active kind, make nothing).
      expect(c.resources.power).toBe(cardPower(st));
      expect(c.resources.power).toBe(0);
    }
  });

  it('assigns unique ids from the meta counter', () => {
    const meta = freshMeta();
    const rng = mulberry32(8);
    const ids = [makeCard(meta, 'common', rng, TASK_IDS).id, makeCard(meta, 'common', rng, TASK_IDS).id];
    expect(new Set(ids).size).toBe(2);
    expect(meta.nextId).toBe(3);
  });
});

// ─── Manual-pool minting ─────────────────────────────────────────────

describe('mintDeckCard', () => {
  function manualPool(tier: CardTier, n: number): ManualWorld[] {
    return Array.from({ length: n }, (_, i) => ({
      id: 1000 + i, name: `manual ${tier} ${i}`, tier,
      data: encodeWorld(generateWeirdWorld(i + 1, tier, TASK_IDS, 'balanced')),
      resources: { money: 1, blood: 0, dragonBone: 0, power: 0 },
    }));
  }

  it('draws ~95% from a stubbed manual pool of the matching tier', () => {
    const meta = freshMeta();
    const pool = manualPool('common', 4);
    const manualNames = new Set(pool.map((m) => m.name));
    let fromPool = 0;
    const total = 400;
    for (let seed = 0; seed < total; seed++) {
      const c = mintDeckCard(meta, 'common', mulberry32(seed), TASK_IDS, pool);
      if (manualNames.has(c.name)) fromPool++;
    }
    // ~95% expected — generous band for the seeded RNG.
    expect(fromPool).toBeGreaterThan(total * 0.88);
    expect(fromPool).toBeLessThan(total); // some still procedural
  });

  it('falls back to procedural when the pool is empty or lacks the tier', () => {
    const meta = freshMeta();
    const commonsOnly = manualPool('common', 3);
    const manualNames = new Set(commonsOnly.map((m) => m.name));
    // Empty pool: always procedural.
    for (let seed = 0; seed < 20; seed++) {
      const c = mintDeckCard(meta, 'rare', mulberry32(seed), TASK_IDS, []);
      expect(c.tier).toBe('rare');
    }
    // Pool lacks the requested tier (only commons): rare requests stay procedural.
    for (let seed = 0; seed < 20; seed++) {
      const c = mintDeckCard(meta, 'rare', mulberry32(seed), TASK_IDS, commonsOnly);
      expect(c.tier).toBe('rare');
      expect(manualNames.has(c.name)).toBe(false);
    }
  });

  it('cardFromManual stamps a fresh id and copies the stored world', () => {
    const meta = freshMeta();
    const m = manualPool('uncommon', 1)[0];
    const c = cardFromManual(meta, m);
    expect(c.id).toBe(1);
    expect(c.tier).toBe('uncommon');
    expect(c.data).toBe(m.data);
    expect(c.resources).toEqual(m.resources);
    expect(c.resources).not.toBe(m.resources); // a copy, not the same object
  });
});

// ─── Gatherings ──────────────────────────────────────────────────────

describe('generateEvents', () => {
  it('seeds the opening salons from the soft border down to the stolen-world depth — every salon seats a gatekeeper and decks its own tier', () => {
    const meta = freshMeta();
    const events = generateEvents(meta, null, TASK_IDS);
    // The chain opens with one salon per depth, the gentle common bootstrap
    // then the (non-escalating) uncommon salons, down to STOLEN_DEPTH; deeper
    // salons are rolled lazily as the player reaches them.
    expect(events.length).toBe(STOLEN_DEPTH + 1);
    expect(events.map((e) => e.depth)).toEqual([0, 1, 2]);
    expect(events.map((e) => e.tier)).toEqual(['common', 'uncommon', 'uncommon']);
    // Every salon now seats a gatekeeper (a key for any one world) atop its
    // traders, so the creature counts are 1+1 / 2+1 / 2+1.
    expect(events.map((e) => e.creatures.length)).toEqual([2, 3, 3]);
    // The soft border's lone creature holds two commons — satisfying its open
    // want with a single world doubles the hand on the first trade.
    expect(events[0].creatures[0].deck.length).toBe(2);
    for (const ev of events) {
      for (const cr of ev.creatures) {
        // Every creature advertises a want, and its non-key deck is the salon's
        // own tier (keys carry no tier rung; a charm-seeker's sweetener is the
        // one card allowed a tier above).
        expect(cr.want).toBeTruthy();
        expect(wantLine(cr.want)).toBeTruthy();
        expect(cr.deck.every((c) => c.key || c.tier === ev.tier
          || (cr.want.kind === 'charm' && c.tier === TIER_ABOVE[ev.tier]))).toBe(true);
      }
    }
    // The opener everywhere keeps the easy rung (any world at the border, a
    // single common at the salons).
    expect(events[0].creatures[0].want).toEqual({ kind: 'any', count: 1 });
    expect(events[1].creatures[0].want).toEqual({ kind: 'tier', tier: 'common', count: 1 });
    expect(events[2].creatures[0].want).toEqual({ kind: 'tier', tier: 'common', count: 1 });
  });

  it('seats the stolen origin card at the fixed stolen-world salon, on its easy-want opener', () => {
    const meta = freshMeta();
    const stolen = card('uncommon', { id: 1, origin: true });
    const events = generateEvents(meta, stolen, TASK_IDS);
    const holder = events[STOLEN_DEPTH].creatures[0];
    // The opener wants a single common — the easiest rung to win the world back from.
    expect(holder.want).toEqual({ kind: 'tier', tier: 'common', count: 1 });
    expect(holder.deck[0].origin).toBe(true);
  });

  it('gives each creature slot its own frame pattern, stamped onto its deck and stable across reshuffles', () => {
    const meta = freshMeta();
    const stolen = card('uncommon', { id: 1, origin: true });
    const events = generateEvents(meta, stolen, TASK_IDS);
    // Frames are FRAME_BASE[tier] + slot: the border's lone trader is 0, and
    // each uncommon salon's pair is 1–2. Gatekeepers + the seeded origin carry
    // no frame, so filter them out.
    expect(events.flatMap((e) => e.creatures.filter((c) => c.frame !== undefined).map((c) => c.frame)))
      .toEqual([0, 1, 2, 1, 2]);
    for (const ev of events) {
      for (const cr of ev.creatures) {
        // Every minted card wears its dealer's frame; the seeded origin card
        // (player-minted) and key cards stay plain.
        expect(cr.deck.every((c) => (c.origin || c.key) ? c.frame === undefined : c.frame === cr.frame)).toBe(true);
      }
    }
    regenerateEvent(meta, events[STOLEN_DEPTH], TASK_IDS);
    expect(events[STOLEN_DEPTH].creatures.filter((c) => c.frame !== undefined).map((c) => c.frame)).toEqual([1, 2]);
  });

  it('keeps the origin card through reshuffles and discards the rest', () => {
    const meta = freshMeta();
    const stolen = card('uncommon', { id: 1, origin: true });
    const events = generateEvents(meta, stolen, TASK_IDS);
    const ev = events[STOLEN_DEPTH];
    const strayId = ev.creatures[1].deck[0].id;
    for (let i = 0; i < 3; i++) {
      regenerateEvent(meta, ev, TASK_IDS);
      const all = ev.creatures.flatMap((c) => c.deck);
      expect(all.filter((c) => c.origin).length).toBe(1);
      expect(all.some((c) => c.id === strayId)).toBe(false);
      for (const cr of ev.creatures) {
        expect(cr.deck.every((c) => c.origin || c.key || c.tier === ev.tier
          || (cr.want.kind === 'charm' && c.tier === TIER_ABOVE[ev.tier]))).toBe(true);
      }
    }
  });
});

// ─── The endless chains behind the hall of doors ─────────────────────

describe('endless salon chains', () => {
  it('escalates every chain the same way: common threshold, uncommon salons, rare from RARE_DEPTH down', () => {
    expect(salonTierForDepth(0)).toBe('common');
    for (let d = 1; d < RARE_DEPTH; d++) expect(salonTierForDepth(d)).toBe('uncommon');
    for (let d = RARE_DEPTH; d < 20; d++) expect(salonTierForDepth(d)).toBe('rare');
  });

  it('names branch 0 the soft border, later doors their own thresholds, deeper salons stably', () => {
    expect(salonName(123, 0)).toBe('gathering at the soft border');
    for (let d = 1; d < 20; d++) expect(salonName(123, d)).toMatch(/^the [a-z]+ salon$/);
    // Names are stable per (seed, branch, depth) so a revisited salon reads
    // the same — and each branch's chain names itself.
    expect(salonName(123, 7)).toBe(salonName(123, 7));
    expect(salonName(123, 7, 2)).toBe(salonName(123, 7, 2));
    // Each branch's chain names itself: a single depth can coincide across
    // branches (the adjective pool is small), but the runs don't.
    const run = (branch: number) =>
      Array.from({ length: 12 }, (_, d) => salonName(123, d + 1, branch)).join('|');
    expect(run(2)).not.toBe(run(3));
    // Every later door's threshold gets its own name; the first score of
    // doors never repeat one.
    expect(pathName(123, 0)).toBe('the soft border');
    const names = Array.from({ length: 20 }, (_, b) => pathName(123, b + 1));
    for (const n of names) expect(n).toMatch(/^the [a-z]+ threshold$/);
    expect(new Set(names).size).toBe(20);
    expect(salonName(123, 0, 3)).toBe(`gathering at ${pathName(123, 3)}`);
  });

  it('rolls a fresh salon at any depth, its gatekeeper keyed to the door onward', () => {
    const meta = freshMeta();
    const deep = makeSalon(meta, 0, 9, mulberry32(999), TASK_IDS);
    expect(deep.depth).toBe(9);
    expect(deep.tier).toBe('rare');
    const gate = deep.creatures.find((c) => c.deck.some((d) => d.key))!;
    expect(gate.deck[0].keyDepth).toBe(10);
    expect(gate.deck[0].keyBranch).toBe(0);
  });

  it('a later door\'s threshold is the same gentle bootstrap: an open want over two commons, keys stamped to its own branch', () => {
    const meta = freshMeta();
    const threshold = makeSalon(meta, 3, 0, mulberry32(555), TASK_IDS);
    expect(threshold.branch).toBe(3);
    expect(threshold.tier).toBe('common');
    // Even pre-reset, only branch 0 deals the hand-authored chain — a fresh
    // door's threshold rolls procedurally, under its own threshold name.
    const preReset = { ...freshMeta(), resets: 0 };
    expect(makeSalon(preReset, 3, 0, mulberry32(555), TASK_IDS).name)
      .not.toBe('gathering at the soft border');
    expect(threshold.creatures[0].want).toEqual({ kind: 'any', count: 1 });
    expect(threshold.creatures[0].deck.filter((c) => !c.key && !c.charm).length).toBe(2);
    const gate = threshold.creatures.find((c) => c.deck.some((d) => d.key))!;
    expect(gate.deck[0].keyDepth).toBe(1);
    expect(gate.deck[0].keyBranch).toBe(3);
  });

  it('a rare exchange deals rare decks behind an uncommon-rung opener', () => {
    const meta = freshMeta();
    const rare = makeSalon(meta, 1, RARE_DEPTH, mulberry32(777), TASK_IDS);
    expect(rare.tier).toBe('rare');
    expect(rare.creatures[0].want).toEqual({ kind: 'tier', tier: 'uncommon', count: 1 });
    for (const cr of rare.creatures) {
      expect(cr.deck.every((c) => c.key || c.charm || c.tier === 'rare')).toBe(true);
    }
  });
});

// ─── The hall of doors ───────────────────────────────────────────────

describe('ensureBranches (the hall migration)', () => {
  it('adopts a legacy single-chain meta as branch 0, chain and unlock depth intact', () => {
    const meta = freshMeta();
    meta.events = generateEvents(meta, null, TASK_IDS);
    meta.unlockedDepth = 2;
    const legacyEvents = meta.events;
    const branches = ensureBranches(meta);
    expect(branches.length).toBe(1);
    expect(branches[0].events).toBe(legacyEvents);
    expect(branches[0].unlockedDepth).toBe(2);
    expect(branches[0].events.every((e) => e.branch === 0)).toBe(true);
    expect(meta.events).toBeNull();
    // Idempotent: a second call changes nothing.
    expect(ensureBranches(meta)).toBe(branches);
  });

  it('a meta with no chain at all migrates to an empty hall', () => {
    const meta = freshMeta();
    expect(ensureBranches(meta)).toEqual([]);
  });
});

// ─── The intended progression ────────────────────────────────────────

describe('progression sanity (trade-only, fixed tiers)', () => {
  it('the opener\'s easy want is satisfiable from the junk hand — the first trade is never hard-locked', () => {
    const meta = freshMeta();
    meta.resets = 0; // the intro deals the opening hand-authored chain
    const rng = mulberry32(77);
    // The goblin's trade: player holds the junk common; origin waits at III.
    const junk = makeCard(meta, 'common', rng, TASK_IDS, true);
    meta.cards = [junk];
    const origin = card('rare', { id: meta.nextId++, origin: true });
    meta.events = generateEvents(meta, origin, TASK_IDS);

    // Level 1's opener wants "any one world" — the lone junk common satisfies
    // it, and handing it over yields the trader's two cards.
    const opener = meta.events[0].creatures[0];
    expect(wantSatisfiableBy(opener.want, meta.cards)).toBe(true);
    expect(wantSatisfiedBy(opener.want, [junk])).toBe(true);
    expect(opener.deck.length).toBe(2); // doubling the hand
    // Tiers never change: trading is the only way the collection grows.
    expect(junk.tier).toBe('common');
  });

  it('winning the origin back: after the first reset, a common in hand satisfies the stolen-world opener\'s want', () => {
    const meta = freshMeta();
    const stolen = card('uncommon', { id: meta.nextId++, origin: true });
    meta.events = generateEvents(meta, stolen, TASK_IDS);
    const holder = meta.events[STOLEN_DEPTH].creatures[0];
    // The procedural stolen-world salon's opener keeps the easy rung — a
    // single common — so the world is always winnable back post-reset.
    expect(holder.want).toEqual({ kind: 'tier', tier: 'common', count: 1 });
    const mine = [card('common', { id: 999 })];
    expect(wantSatisfiedBy(holder.want, mine)).toBe(true);
    expect(holder.deck.find((c) => c.origin)).toBeTruthy();
  });
});

// ─── The opening hand-authored chain ─────────────────────────────────

describe('the opening chain (levels 1–3, pre-reset)', () => {
  function openingEvents(stolen: WorldCard | null = null): { meta: CardMeta; events: ReturnType<typeof generateEvents> } {
    const meta = freshMeta();
    meta.resets = 0;
    const events = generateEvents(meta, stolen, TASK_IDS);
    return { meta, events };
  }

  it('levels 1 and 2 are the curated on-ramp, and level 2\'s opener deals the gilded charm', () => {
    const { events } = openingEvents();
    expect(events.length).toBe(HARDCODED_LEVELS);
    // Level 1: the open-want doubler plus a gatekeeper who takes anything.
    expect(events[0].creatures[0].want).toEqual({ kind: 'any', count: 1 });
    expect(events[0].creatures[0].deck.length).toBe(2);
    const gate1 = events[0].creatures.find((c) => c.deck.some((d) => d.key))!;
    expect(gate1.want).toEqual({ kind: 'any', count: 1 });
    expect(gate1.deck[0].keyDepth).toBe(1);
    // Level 2: the ladder — the opener turns the arriving common into an
    // uncommon (its deck introduces charms), the collector doubles it.
    expect(events[1].creatures[0].want).toEqual({ kind: 'tier', tier: 'common', count: 1 });
    expect(events[1].creatures[0].deck.some((c) => c.charm === 'gold')).toBe(true);
    expect(events[1].creatures[1].want).toEqual({ kind: 'tier', tier: 'uncommon', count: 1 });
    expect(events[1].creatures[1].deck.filter((c) => !c.key && !c.charm).length).toBe(2);
    const gate2 = events[1].creatures.find((c) => c.deck.some((d) => d.key))!;
    expect(gate2.want).toEqual({ kind: 'any', count: 1 });
    expect(gate2.deck[0].keyDepth).toBe(2);
  });

  it('is beatable from the junk hand under EVERY legal trade order — level 3 stays reachable from all states', () => {
    const meta = freshMeta();
    meta.resets = 0;
    const junk = makeCard(meta, 'common', mulberry32(5), TASK_IDS, true);
    const origin = card('rare', { id: meta.nextId++, origin: true });
    const events = generateEvents(meta, origin, TASK_IDS);

    // The realm modelled exactly as the UI enforces it: an exact-offer trade
    // with any unspent creature in a reachable salon (want satisfied, the
    // keep-a-world guard honoured, the whole deck received), or spending a
    // held key on the next locked door.
    type St = { hand: WorldCard[]; spent: number[]; unlocked: number };
    const kindOf = (c: WorldCard) => (c.key ? `k${c.keyDepth}` : c.charm ? 'charm' : c.tier);
    const sig = (s: St) => JSON.stringify([
      s.hand.map(kindOf).sort(), [...s.spent].sort((a, b) => a - b), s.unlocked,
    ]);
    const choose = (cards: WorldCard[], n: number): WorldCard[][] => {
      if (n === 0) return [[]];
      if (cards.length < n) return [];
      const [head, ...rest] = cards;
      return [...choose(rest, n - 1).map((c) => [head, ...c]), ...choose(rest, n)];
    };
    const moves = (s: St): St[] => {
      const out: St[] = [];
      for (const ev of events) {
        if (ev.depth > s.unlocked) continue;
        for (const cr of ev.creatures) {
          if (s.spent.includes(cr.id)) continue;
          for (const given of choose(s.hand.filter((c) => cardQualifies(cr.want, c)), cr.want.count)) {
            if (!tradeKeepsAWorld(s.hand, given, cr.deck)) continue;
            out.push({
              hand: [...s.hand.filter((c) => !given.includes(c)), ...cr.deck],
              spent: [...s.spent, cr.id],
              unlocked: s.unlocked,
            });
          }
        }
      }
      const key = s.hand.find((c) => c.key && c.keyDepth === s.unlocked + 1);
      if (key) out.push({ hand: s.hand.filter((c) => c !== key), spent: s.spent, unlocked: s.unlocked + 1 });
      return out;
    };

    // Walk the ENTIRE reachable state space from the swindle's aftermath.
    const start: St = { hand: [junk], spent: [], unlocked: 0 };
    const seen = new Map<string, St>([[sig(start), start]]);
    const queue = [start];
    while (queue.length > 0) {
      const s = queue.shift()!;
      for (const n of moves(s)) {
        const k = sig(n);
        if (!seen.has(k)) { seen.set(k, n); queue.push(n); }
      }
    }

    // Level 3 is reachable at all…
    expect([...seen.values()].some((s) => s.unlocked >= 2)).toBe(true);
    // …the level-3 wall never trades, whatever the player does…
    const wallIds = new Set(events[2].creatures.map((c) => c.id));
    for (const s of seen.values()) {
      expect(s.spent.some((id) => wallIds.has(id))).toBe(false);
    }
    // …and from EVERY reachable state level 3 is still reachable: the opening
    // chain has no dead ends, no matter the trade order.
    const winnable = new Map<string, boolean>();
    const canWin = (s: St): boolean => {
      if (s.unlocked >= 2) return true;
      const k = sig(s);
      const hit = winnable.get(k);
      if (hit !== undefined) return hit;
      winnable.set(k, false); // guard (the trade graph is a DAG anyway)
      const ok = moves(s).some(canWin);
      winnable.set(k, ok);
      return ok;
    };
    for (const s of seen.values()) {
      expect(canWin(s)).toBe(true);
    }
  });

  it('level 3 is the wall: no want there — the gatekeeper\'s included — is satisfiable by any pre-reset hand', () => {
    const stolen = card('rare', { id: 1, origin: true });
    const { events } = openingEvents(stolen);
    const wall = events[HARDCODED_LEVELS - 1];
    // The origin sits in the wall's opener deck: visible, unwinnable.
    expect(wall.creatures[0].deck[0].origin).toBe(true);
    // The best hand the opening chain could conceivably deal: a fat stack of
    // commons and uncommons with absurdly maxed resources (no rare ever
    // circulates before the first reset). Nothing at the wall takes any of it.
    const best = (['common', 'uncommon'] as CardTier[]).flatMap((t, i) =>
      Array.from({ length: 5 }, (_, k) => card(t, {
        id: 800 + i * 10 + k,
        resources: { money: 500_000_000, blood: 1_000_000, dragonBone: 1_000, power: 10_000_000_000 },
      })));
    for (const cr of wall.creatures) {
      expect(wantSatisfiableBy(cr.want, best)).toBe(false);
    }
  });
});

// ─── The reset ───────────────────────────────────────────────────────

describe('resetChain (begin again)', () => {
  const hallDecks = (meta: CardMeta) =>
    meta.branches!.flatMap((b) => b.events).flatMap((e) => e.creatures).flatMap((c) => c.deck);

  it('seals the hall back to one door, refreshes every salon, keeps the hand, and goes procedural', () => {
    const meta = freshMeta();
    meta.resets = 0;
    meta.unlockedDepth = 2;
    const held = [card('common', { id: 501 }), makeKeyCard(meta, 'common', 9)];
    meta.cards = [...held];
    const stolen = card('rare', { id: meta.nextId++, origin: true });
    meta.events = generateEvents(meta, stolen, TASK_IDS);
    // The player also unsealed a second door and climbed it a little.
    ensureBranches(meta).push({
      events: [makeSalon(meta, 1, 0, mulberry32(9), TASK_IDS)],
      unlockedDepth: 1,
    });
    meta.doorsUnsealed = 2;
    meta.lastUnsealAt = 123456;
    resetChain(meta, TASK_IDS);
    expect(meta.resets).toBe(1);
    expect(meta.branches!.length).toBe(1);     // the hall seals back to one chain
    expect(meta.branches![0].unlockedDepth).toBe(0);
    expect(meta.doorsUnsealed).toBe(0);        // ...with even door 1 sealed again
    expect(meta.lastUnsealAt).toBeUndefined(); // ...and no countdown in the way
    expect(meta.cards).toEqual(held); // the hand is untouched
    // The fresh chain is procedural — its stolen-world opener keeps the easy
    // rung (the impossible magistrate is gone) — and still carries the origin.
    const holder = meta.branches![0].events[STOLEN_DEPTH].creatures[0];
    expect(holder.want).toEqual({ kind: 'tier', tier: 'common', count: 1 });
    expect(hallDecks(meta).filter((c) => c.origin).length).toBe(1);
    // Resetting again keeps counting and keeps carrying the origin.
    resetChain(meta, TASK_IDS);
    expect(meta.resets).toBe(2);
    expect(hallDecks(meta).filter((c) => c.origin).length).toBe(1);
  });

  it('carries the origin home even when it waits behind a later door', () => {
    const meta = freshMeta();
    meta.events = generateEvents(meta, null, TASK_IDS);
    const branches = ensureBranches(meta);
    const stolen = card('rare', { id: 900, origin: true });
    const side = makeSalon(meta, 2, 0, mulberry32(4), TASK_IDS);
    side.creatures[0].deck.unshift(stolen);
    branches.push({ events: [side], unlockedDepth: 0 });
    resetChain(meta, TASK_IDS);
    expect(meta.branches!.length).toBe(1);
    expect(hallDecks(meta).filter((c) => c.origin).length).toBe(1);
  });

  it('an origin already won stays won — it never re-enters the refreshed hall', () => {
    const meta = freshMeta();
    meta.events = generateEvents(meta, null, TASK_IDS);
    meta.cards = [card('rare', { id: 700, origin: true })];
    resetChain(meta, TASK_IDS);
    expect(meta.cards.length).toBe(1); // still in hand
    expect(hallDecks(meta).some((c) => c.origin)).toBe(false);
  });
});

// ─── Charms ──────────────────────────────────────────────────────────

describe('charms', () => {
  it('every charm carries a full reading: name, glyph and a real description', () => {
    for (const kind of Object.keys(CHARM_DEFS) as (keyof typeof CHARM_DEFS)[]) {
      const def = CHARM_DEFS[kind];
      expect(def.name.length).toBeGreaterThan(0);
      expect(def.glyph.length).toBeGreaterThan(0);
      expect(def.desc.length).toBeGreaterThan(20);
    }
  });

  it('the wet charm is retired from the minting pool but keeps its def for old hands', () => {
    expect(CHARM_KINDS).not.toContain('rain');
    expect(CHARM_DEFS.rain.name).toBe('the wet charm');
  });

  it('a charm is a keepsake: no world behind it, and it never satisfies any want', () => {
    const meta = freshMeta();
    const charm = makeCharmCard(meta, 'uncommon', 'gold');
    expect(charm.charm).toBe('gold');
    expect(charm.data).toBe('');
    expect(cardQualifies({ kind: 'any', count: 1 }, charm)).toBe(false);
    expect(cardQualifies({ kind: 'tier', tier: 'uncommon', count: 1 }, charm)).toBe(false);
    expect(cardQualifies({ kind: 'resource', res: 'money', amount: 0, count: 1 }, charm)).toBe(false);
  });

  it('applyCharms blesses a world with every held charm\'s flag (worlds in hand ride along untouched)', () => {
    const meta = freshMeta();
    // A balanced common: every charm flag starts false.
    const st = generateWeirdWorld(11, 'common', TASK_IDS, 'balanced');
    expect(st.goldgoblinsEnabled).toBe(false);
    applyCharms(st, [
      card('common', { id: 1 }),
      makeCharmCard(meta, 'common', 'gold'),
      makeCharmCard(meta, 'common', 'rain'),
      makeCharmCard(meta, 'common', 'storm'),
      makeCharmCard(meta, 'common', 'tiny'),
    ]);
    expect(st.goldgoblinsEnabled).toBe(true);
    expect(st.goldgoblinsAlways).toBe(true);  // gilded: EVERY spawn, not the 1-in-5 roll
    expect(st.autoAssignEnabled).toBe(true); // rain implies the busy hands too
    expect(st.autoWaterEnabled).toBe(true);
    expect(st.lightningUnlocked).toBe(true);
    expect(st.minotaursSpawnTiny).toBe(true); // little: all summons arrive tiny
    // And a plain hand blesses nothing.
    const st2 = generateWeirdWorld(11, 'common', TASK_IDS, 'balanced');
    applyCharms(st2, [card('common', { id: 2 })]);
    expect(st2.goldgoblinsEnabled).toBe(false);
    expect(st2.goldgoblinsAlways).toBeUndefined();
    expect(st2.minotaursSpawnTiny).toBeUndefined();
  });

  it('procedural picky traders sometimes tuck a charm into their deck', () => {
    const meta = freshMeta(); // resets: 1 — the procedural chain
    let found = false;
    for (let seed = 1; seed <= 40 && !found; seed++) {
      const salon = makeSalon(meta, 0, 1, mulberry32(seed * 313), TASK_IDS);
      found = salon.creatures.some((c) => c.deck.some((d) => d.charm));
    }
    expect(found).toBe(true);
  });
});

// ─── Charm-seekers ───────────────────────────────────────────────────

describe('charm-seekers (traders who want charms)', () => {
  it('a charm satisfies exactly a charm want — worlds and keys never do', () => {
    const meta = freshMeta();
    const charm = makeCharmCard(meta, 'uncommon', 'gold');
    const charmWant: Want = { kind: 'charm', count: 1 };
    expect(cardQualifies(charmWant, charm)).toBe(true);
    expect(cardQualifies(charmWant, card('rare'))).toBe(false);
    expect(cardQualifies(charmWant, makeKeyCard(meta, 'common', 1, 0))).toBe(false);
    expect(wantSatisfiedBy(charmWant, [charm])).toBe(true);
    expect(wantLine(charmWant)).toBe('i want a charm.');
    expect(wantLine({ kind: 'charm', count: 2 })).toBe('i want two charms.');
  });

  it('picky slots sometimes roll a charm want; the opener never does', () => {
    let seekers = 0;
    for (let seed = 0; seed < 300; seed++) {
      expect(rollWant('uncommon', mulberry32(seed), true).kind).not.toBe('charm');
      if (rollWant('uncommon', mulberry32(seed * 7 + 1), false).kind === 'charm') seekers++;
    }
    expect(seekers).toBeGreaterThan(10);
  });

  it('a charm-seeker\'s deck carries a sweetener of the tier above its salon', () => {
    const meta = freshMeta();
    for (let seed = 1; seed <= 80; seed++) {
      const salon = makeSalon(meta, 0, 1, mulberry32(seed * 131), TASK_IDS);
      const seeker = salon.creatures.find((c) => c.want.kind === 'charm');
      if (!seeker) continue;
      // An uncommon salon's seeker holds a rare — treasure worth a keepsake.
      expect(seeker.deck.some((c) => !c.key && !c.charm && c.tier === 'rare')).toBe(true);
      return;
    }
    throw new Error('no charm-seeker rolled in 80 salons');
  });
});

// ─── Names ───────────────────────────────────────────────────────────

describe('worldName', () => {
  it('always produces a two-word "the x y" name', () => {
    const rng = mulberry32(3);
    for (let i = 0; i < 50; i++) {
      expect(worldName(rng)).toMatch(/^the [a-z]+ [a-z]+$/);
    }
  });
});

// Tier tables stay in sync with each other.
describe('tier tables', () => {
  it('TIER_ABOVE climbs exactly one rank', () => {
    for (const t of TIERS) {
      const above = TIER_ABOVE[t];
      if (above) expect(TIER_RANK[above]).toBe(TIER_RANK[t] + 1);
      else expect(TIER_RANK[t]).toBe(2);
    }
  });
});

// ─── Keys + the gatekeeper ───────────────────────────────────────────

describe('keys and the gatekeeper', () => {
  const keyHolder = (ev: ReturnType<typeof generateEvents>[number]) =>
    ev.creatures.find((c) => c.deck.some((d) => d.key));

  it('seats a key-bearing gatekeeper in every salon — its key opens the one door onward', () => {
    const meta = freshMeta();
    const events = generateEvents(meta, null, TASK_IDS);
    // The chain is endless, so every salon (no top tier any more) has a door
    // onward and a gatekeeper minting the key for it.
    for (const ev of events) {
      const gate = keyHolder(ev)!;
      expect(gate).toBeTruthy();
      expect(gate.want).toEqual({ kind: 'any', count: 1 });
      expect(gate.deck).toHaveLength(1);
      expect(gate.deck[0].key).toBe(true);
      // The key opens exactly the door up out of this salon — the next depth.
      expect(gate.deck[0].keyDepth).toBe(ev.depth + 1);
    }
  });

  it('a key never satisfies a want — not even an open one', () => {
    const meta = freshMeta();
    const key = makeKeyCard(meta, 'common', 1);
    expect(key.key).toBe(true);
    expect(key.data).toBe('');
    expect(key.keyDepth).toBe(1);
    expect(cardQualifies({ kind: 'any', count: 1 }, key)).toBe(false);
    expect(wantSatisfiedBy({ kind: 'any', count: 1 }, [key])).toBe(false);
    // A real world still satisfies the same open want.
    expect(wantSatisfiedBy({ kind: 'any', count: 1 }, [card('common', { id: 5 })])).toBe(true);
  });

  it('keeps a gatekeeper across reshuffles', () => {
    const meta = freshMeta();
    const events = generateEvents(meta, null, TASK_IDS);
    const home = events[0];
    for (let i = 0; i < 3; i++) {
      regenerateEvent(meta, home, TASK_IDS);
      const gate = keyHolder(home)!;
      expect(gate).toBeTruthy();
      expect(gate.deck[0].keyDepth).toBe(1);
    }
  });
});
