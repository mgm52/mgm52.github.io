// Unit tests for the trading-card realm's core logic (src/cards-core.ts):
// world generation validity, serialization round-trips (including through
// the JSON meta blob), trader wants + the want-satisfaction rules, manual-
// pool minting, and the gathering generator's progression guarantees. Run
// with `npm test`.

import { describe, expect, it } from 'vitest';
import {
  CardMeta, CardTier, ManualWorld, MAIN_TRACK, TIER_ABOVE, TIER_RANK,
  Want, WorldCard, cardFromManual, cardPower, cardQualifies, countQualifying,
  decodeWorld, encodeWorld, generateEvents, generateJunkWorld, generateWeirdWorld,
  makeCard, mintDeckCard, mulberry32, regenerateEvent, rollWant, sceneStructureCounts,
  spicyAmount, wantLine, wantSatisfiableBy, wantSatisfiedBy, worldName,
  STREET, gatheringRowCount, gatheringSlot, streetDist, streetDollyPose, streetDoor,
  streetEnterPose, streetFocusPose, streetHouse, streetViewSpace,
} from '../src/cards-core';
import { BUILDING_DEFS, SOUL_SIGIL } from '../src/config';
import { GameState, cellKey, isInPlayCell } from '../src/state';

const TASK_IDS = ['earn_100', 'run_phone_farm', 'collect_blood'];
const TIERS: CardTier[] = ['common', 'uncommon', 'rare'];

function freshMeta(): CardMeta {
  return { v: 1, phase: 'free', nextId: 1, cards: [], events: null, activeCardId: null };
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
    expect(wantLine({ kind: 'any', count: 1 })).toBe('i will take any one world.');
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

  it('the picky slots ask for the table\'s own tier or a resource threshold in band', () => {
    for (let seed = 0; seed < 200; seed++) {
      const w = rollWant('common', mulberry32(seed), false);
      expect(w.kind === 'tier' || w.kind === 'resource').toBe(true);
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

  it('records the standing generators\' potential power on a never-run card', () => {
    const meta = freshMeta();
    for (let seed = 0; seed < 8; seed++) {
      const c = makeCard(meta, 'common', mulberry32(seed), TASK_IDS);
      const st = decodeWorld(c.data)!;
      // A never-run world reports what its placed generators COULD make —
      // a card with a lone "bad power source" reads 1 W, not "nothing".
      expect(c.resources.power).toBe(cardPower(st));
      let potential = 0;
      for (const b of st.buildings.values()) {
        const out = BUILDING_DEFS[b.kind].powerOutput;
        if (out > 0) potential += out;
      }
      expect(c.resources.power).toBe(potential);
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
  it('grows the tables with the tiers: 1 creature (two cards), then 2, then 3 — every trader wants and decks the table\'s tier', () => {
    const meta = freshMeta();
    const events = generateEvents(meta, null, TASK_IDS);
    expect(events.map((e) => e.tier)).toEqual(['common', 'uncommon', 'rare']);
    expect(events.map((e) => e.creatures.length)).toEqual([1, 2, 3]);
    // The soft border's lone creature holds two commons — satisfying its open
    // want with a single world doubles the hand on the first trade.
    expect(events[0].creatures[0].deck.length).toBe(2);
    for (const ev of events) {
      for (const cr of ev.creatures) {
        // Every creature advertises a want, and decks only the table's tier.
        expect(cr.want).toBeTruthy();
        expect(wantLine(cr.want)).toBeTruthy();
        expect(cr.deck.every((c) => c.tier === ev.tier)).toBe(true);
      }
    }
    // The opener everywhere keeps the easy rung.
    expect(events[0].creatures[0].want).toEqual({ kind: 'any', count: 1 });
    expect(events[1].creatures[0].want).toEqual({ kind: 'tier', tier: 'common', count: 1 });
    expect(events[2].creatures[0].want).toEqual({ kind: 'tier', tier: 'uncommon', count: 1 });
  });

  it('seats the stolen origin card with the rare exchange\'s easy-want opener', () => {
    const meta = freshMeta();
    const stolen = card('rare', { id: 1, origin: true });
    const events = generateEvents(meta, stolen, TASK_IDS);
    const holder = events[2].creatures[0];
    // The opener wants a single uncommon — the easiest rung to win the rare back from.
    expect(holder.want).toEqual({ kind: 'tier', tier: 'uncommon', count: 1 });
    expect(holder.deck[0].origin).toBe(true);
  });

  it('gives each creature slot its own frame pattern, stamped onto its deck and stable across reshuffles', () => {
    const meta = freshMeta();
    const stolen = card('rare', { id: 1, origin: true });
    const events = generateEvents(meta, stolen, TASK_IDS);
    // The six slots map onto the six patterns: 0 / 1–2 / 3–5.
    expect(events.flatMap((e) => e.creatures.map((c) => c.frame))).toEqual([0, 1, 2, 3, 4, 5]);
    for (const ev of events) {
      for (const cr of ev.creatures) {
        // Every minted card wears its dealer's frame; the seeded origin
        // card is player-minted and stays plain.
        expect(cr.deck.every((c) => c.origin ? c.frame === undefined : c.frame === cr.frame)).toBe(true);
      }
    }
    regenerateEvent(meta, events[2], TASK_IDS);
    expect(events[2].creatures.map((c) => c.frame)).toEqual([3, 4, 5]);
  });

  it('keeps the origin card through reshuffles and discards the rest', () => {
    const meta = freshMeta();
    const stolen = card('rare', { id: 1, origin: true });
    const events = generateEvents(meta, stolen, TASK_IDS);
    const ev = events[2];
    const strayId = ev.creatures[2].deck[0].id;
    for (let i = 0; i < 3; i++) {
      regenerateEvent(meta, ev, TASK_IDS);
      const all = ev.creatures.flatMap((c) => c.deck);
      expect(all.filter((c) => c.origin).length).toBe(1);
      expect(all.some((c) => c.id === strayId)).toBe(false);
      expect(all.every((c) => c.origin || c.tier === ev.tier)).toBe(true);
    }
  });
});

// ─── The intended progression ────────────────────────────────────────

describe('progression sanity (trade-only, fixed tiers)', () => {
  it('the opener\'s easy want is satisfiable from the junk hand — the first trade is never hard-locked', () => {
    const meta = freshMeta();
    const rng = mulberry32(77);
    // The goblin's trade: player holds the junk common; origin waits at III.
    const junk = makeCard(meta, 'common', rng, TASK_IDS, true);
    meta.cards = [junk];
    const origin = card('rare', { id: meta.nextId++, origin: true });
    meta.events = generateEvents(meta, origin, TASK_IDS);

    // The common gathering's opener wants "any one world" — the lone junk
    // common satisfies it, and handing it over yields the trader's two cards.
    const opener = meta.events[0].creatures[0];
    expect(wantSatisfiableBy(opener.want, meta.cards)).toBe(true);
    expect(wantSatisfiedBy(opener.want, [junk])).toBe(true);
    expect(opener.deck.length).toBe(2); // doubling the hand
    // Tiers never change: trading is the only way the collection grows.
    expect(junk.tier).toBe('common');
  });

  it('winning the origin back: a rare in hand satisfies the rare opener\'s want', () => {
    const meta = freshMeta();
    const stolen = card('rare', { id: meta.nextId++, origin: true });
    meta.events = generateEvents(meta, stolen, TASK_IDS);
    const holder = meta.events[2].creatures[0];
    // The opener wants a single uncommon — but the rare exchange's tiers are
    // fixed: to win the rare origin back you bring it an uncommon.
    expect(holder.want).toEqual({ kind: 'tier', tier: 'uncommon', count: 1 });
    const mine = [card('uncommon', { id: 999 })];
    expect(wantSatisfiedBy(holder.want, mine)).toBe(true);
    expect(holder.deck.find((c) => c.origin)).toBeTruthy();
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

// The street-of-gatherings camera. These prove the geometry the renderer
// drives off — most importantly that clicking a house flies the camera square
// into its door (the door dead-centre in view, a nose away) — without a DOM.
describe('street camera', () => {
  const sides = ['L', 'R'] as const;

  it('lays the houses out in two lines down the street', () => {
    for (const plot of [0, 1, 2]) {
      const L = streetHouse(plot, 'L');
      const R = streetHouse(plot, 'R');
      expect(L.x).toBe(-STREET.laneX);          // left line
      expect(R.x).toBe(STREET.laneX);           // right line
      expect(L.z).toBe(R.z);                     // same plot, same depth
      expect(L.z).toBeLessThan(0);               // down −Z, into the screen
      // deeper plots sit further down the street
      if (plot > 0) expect(streetHouse(plot, 'L').z).toBeLessThan(streetHouse(plot - 1, 'L').z);
    }
  });

  it('flies the camera square into each door', () => {
    for (const side of sides) {
      for (const plot of [0, 1, 2]) {
        const house = streetHouse(plot, side);
        const door = streetDoor(house);
        const cam = streetEnterPose(house);
        const v = streetViewSpace(door.pos, cam);
        // the door projects dead-centre on screen (the "central raycast")
        expect(Math.abs(v.x)).toBeLessThan(0.5);
        expect(Math.abs(v.y)).toBeLessThan(0.5);
        // it sits a nose IN FRONT of the eye (down the street), ~doorStop away
        expect(v.z).toBeLessThan(0);
        expect(Math.abs(-v.z - STREET.doorStop)).toBeLessThan(0.5);
        // the camera really is right at the door — well inside one house depth
        const dist = streetDist(cam, door.pos);
        expect(dist).toBeCloseTo(STREET.doorStop, 5);
        expect(dist).toBeLessThan(STREET.house.d);
        // …and stands on the door's OUTWARD side (in front of it, not inside)
        const ahead = (cam.x - door.pos.x) * door.normal.x + (cam.z - door.pos.z) * door.normal.z;
        expect(ahead).toBeGreaterThan(0);
      }
    }
  });

  it('a focused row sees its left house left-of-centre and right house right', () => {
    for (const row of [0, 1, 2]) {
      const cam = streetFocusPose(row);
      const base = (h: { x: number; z: number }) => ({ x: h.x, y: STREET.groundY, z: h.z });
      const vL = streetViewSpace(base(streetHouse(row, 'L')), cam);
      const vR = streetViewSpace(base(streetHouse(row, 'R')), cam);
      expect(vL.x).toBeLessThan(0);   // left house off to the left
      expect(vR.x).toBeGreaterThan(0); // right house off to the right
      expect(vL.z).toBeLessThan(0);   // both ahead, down the street
      expect(vR.z).toBeLessThan(0);
    }
  });

  it('walking forward moves the camera further down the street', () => {
    expect(streetFocusPose(1).z).toBeLessThan(streetFocusPose(0).z);
    expect(streetFocusPose(2).z).toBeLessThan(streetFocusPose(1).z);
  });

  it('the whole fly-in keeps the door centred and dollies it from far → through', () => {
    for (const side of sides) {
      const house = streetHouse(0, side);
      const door = streetDoor(house);
      // dist: far out on the road → the threshold → well past it, inside.
      const zs = [240, STREET.doorStop, -640].map((dist) => {
        const v = streetViewSpace(door.pos, streetDollyPose(house, dist));
        expect(Math.abs(v.x)).toBeLessThan(0.5);  // dead-centre the whole way in
        expect(Math.abs(v.y)).toBeLessThan(0.5);
        return v.z;
      });
      // Approaching: the door reads far/small (well into the screen).
      expect(zs[0]).toBeLessThan(-150);
      // It swells monotonically toward the eye…
      expect(zs[1]).toBeGreaterThan(zs[0]);
      expect(zs[2]).toBeGreaterThan(zs[1]);
      // …and on the final push the door has crossed the eye plane (z > 0):
      // it fills the view as we step through, the whole point of "into the door".
      expect(zs[2]).toBeGreaterThan(0);
    }
  });

  it('houses ahead are visible; ones the camera has passed sit behind the eye', () => {
    // The cull rule keys on view-space z: ahead of the eye (z ≤ 0) renders,
    // behind it (z large +) gets hidden before CSS perspective blows it up.
    const cam = streetFocusPose(0);
    const ahead = streetViewSpace({ x: -STREET.laneX, y: STREET.groundY, z: streetHouse(0, 'L').z }, cam);
    expect(ahead.z).toBeLessThan(0);   // a row ahead → on screen
    // A house the camera has already walked past (nearer the viewer than the
    // eye) lands behind the eye plane — exactly what the cull hides.
    const behind = streetViewSpace({ x: STREET.laneX, y: STREET.groundY, z: cam.z + 120 }, cam);
    expect(behind.z).toBeGreaterThan(STREET.doorStop);
  });

  it('packs gatherings into rows of two (left then right)', () => {
    expect(gatheringRowCount(3)).toBe(2);
    expect(gatheringSlot(0)).toEqual({ plot: 0, side: 'L' });
    expect(gatheringSlot(1)).toEqual({ plot: 0, side: 'R' });
    expect(gatheringSlot(2)).toEqual({ plot: 1, side: 'L' });
  });
});
