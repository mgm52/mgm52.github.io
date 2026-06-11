// Unit tests for the trading-card realm's core logic (src/cards-core.ts):
// world generation validity, serialization round-trips (including through
// the JSON meta blob), tier/ascension rules, trade rules, and the gathering
// generator's progression guarantees. Run with `npm test`.

import { describe, expect, it } from 'vitest';
import {
  APPETITE_LINE, CardMeta, CardResources, CardTier, MAIN_TRACK, TIER_ABOVE, TIER_RANK,
  WORLD_FLAVORS, WorldCard, appetiteAccepts, ascendCard, breakdownGives, cardPower,
  cardIncome, challengeReq, creatureOpenTo, creatureTakesFor, decodeWorld, encodeWorld,
  generateEvents, generateJunkWorld, generateWeirdWorld, makeCard, mulberry32,
  regenerateEvent, reqMet, rollUpgradeReq, roundNice, sameTierGives,
  sceneStructureCounts, spicyAmount, worldName,
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
    upgradeReq: null,
    ...over,
  };
}

const NO_RES: CardResources = { money: 0, blood: 0, dragonBone: 0, power: 0 };

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
  it('is pitiful: Ƶ3, not a single goblin, walls only, nothing unlocked', () => {
    for (let seed = 1; seed <= 5; seed++) {
      const st = generateJunkWorld(seed * 17, TASK_IDS);
      expect(st.money).toBe(3);
      expect(st.blood).toBe(0);
      expect(st.dragonBone).toBe(0);
      expect(st.goblins.size).toBe(0);
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

      // Necropolis: portal beams on the surface, hell packed with the dead.
      const nec = generateWeirdWorld(seed * 47, 'common', TASK_IDS, 'necropolis');
      expect(nec.ghosts.length).toBeGreaterThanOrEqual(30);
      expect(nec.hellUnlocked).toBe(true);
      expect([...nec.buildings.values()].some((b) => b.kind === 'hell_portal')).toBe(true);

      // Rampage: live minotaurs already loose among the goblins, with the
      // summon task settled so the herd never replays a celebration.
      const ram = generateWeirdWorld(seed * 53, 'common', TASK_IDS, 'rampage');
      expect(ram.minotaurs.size).toBeGreaterThanOrEqual(2);
      expect(ram.goblins.size).toBeGreaterThan(0);
      expect(ram.unlocks!.completed.has('summon_minotaurs')).toBe(true);
      expect(ram.minotaursSummoned).toBe(ram.minotaurs.size);
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

  it('challenge flavors pin their ascension demand to the puzzle goal', () => {
    const meta = freshMeta();
    let seance = 0, overcharged = 0;
    for (let seed = 0; seed < 80 && (!seance || !overcharged); seed++) {
      const c = makeCard(meta, 'common', mulberry32(seed), TASK_IDS);
      const st = decodeWorld(c.data)!;
      const isSeance = st.hellUnlocked
        && st.blood >= SOUL_SIGIL.count * SOUL_SIGIL.candleBloodCost
        && st.blood <= SOUL_SIGIL.count * SOUL_SIGIL.candleBloodCost + 6;
      if (isSeance && c.upgradeReq?.res === 'power') {
        expect(c.upgradeReq.amount).toBe(1_000_000_000);
        seance++;
      }
      const isOvercharged = st.money <= 10
        && [...st.buildings.values()].some((b) => b.kind === 'nuclear_reactor');
      if (isOvercharged && c.upgradeReq?.res === 'money') overcharged++;
    }
    expect(seance).toBeGreaterThan(0);
    expect(overcharged).toBeGreaterThan(0);
  });

  it('crowd and rampage demands name their puzzle (and vanish at rare)', () => {
    for (let seed = 0; seed < 50; seed++) {
      const rng = mulberry32(seed);
      // A population goal, not a stockpile.
      const crowd = challengeReq('crowd', 'common', rng)!;
      expect(crowd.res).toBe('goblins');
      expect(crowd.amount).toBeGreaterThanOrEqual(20);
      expect(crowd.amount).toBeLessThanOrEqual(40);
      // Blood priced in clean 128-blood beasts.
      const ram = challengeReq('rampage', 'uncommon', rng)!;
      expect(ram.res).toBe('blood');
      expect(ram.amount % 128).toBe(0);
      expect(challengeReq('crowd', 'rare', rng)).toBeNull();
      expect(challengeReq('rampage', 'rare', rng)).toBeNull();
    }
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

// ─── Cards, tiers, ascension ─────────────────────────────────────────

describe('rollUpgradeReq (world-derived demands)', () => {
  it('falls back to a small tier-floor roll for a world that expresses nothing, and none at rare', () => {
    const floors: Record<string, Record<string, number>> = {
      common: { money: 2_000, blood: 150, goblins: 10 },
      uncommon: { money: 100_000, blood: 2_500, goblins: 30 },
    };
    for (let seed = 0; seed < 200; seed++) {
      const rng = mulberry32(seed);
      for (const tier of ['common', 'uncommon'] as const) {
        const req = rollUpgradeReq(tier, rng, NO_RES)!;
        // Bones can't be demanded of a boneless world; power not of an
        // unpowered one — the fallback sticks to the universal three.
        const floor = floors[tier][req.res];
        expect(floor).toBeDefined();
        expect(req.amount).toBeGreaterThanOrEqual(floor);
        expect(req.amount).toBeLessThanOrEqual(floor * 3);
      }
      expect(rollUpgradeReq('rare', rng, NO_RES)).toBeNull();
    }
  });

  it('demands a clean 2–4× multiple of the one thing a world expresses', () => {
    const bloodFarm: CardResources = { money: 10, blood: 6_000, dragonBone: 0, power: 0 };
    for (let seed = 0; seed < 100; seed++) {
      const req = rollUpgradeReq('common', mulberry32(seed), bloodFarm)!;
      // Blood is all this world has (Ƶ10 is beneath notice) — the demand
      // grows it, and lands on a legible two-digit figure.
      expect(req.res).toBe('blood');
      expect(req.amount).toBeGreaterThanOrEqual(12_000); // ≥ 2× the holding
      expect(req.amount).toBeLessThanOrEqual(24_000);    // ≤ 4× the holding
      expect(req.amount).toBe(roundNice(req.amount));
    }
  });

  it("prices a money goal off the standing buildings' income (5–10 minutes, banked)", () => {
    const farm: CardResources = { money: 0, blood: 0, dragonBone: 0, power: 0, income: 1_000 };
    for (let seed = 0; seed < 100; seed++) {
      const req = rollUpgradeReq('uncommon', mulberry32(seed), farm)!;
      expect(req.res).toBe('money');
      expect(req.amount).toBeGreaterThanOrEqual(290_000); // ~300s of income
      expect(req.amount).toBeLessThanOrEqual(610_000);    // ~600s of income
    }
  });

  it('asks a powered world to double its generation', () => {
    const reactor: CardResources = { money: 0, blood: 0, dragonBone: 0, power: 1_000_000_000 };
    for (let seed = 0; seed < 50; seed++) {
      const req = rollUpgradeReq('uncommon', mulberry32(seed), reactor)!;
      expect(req).toEqual({ res: 'power', amount: 2_000_000_000 });
    }
  });

  it('asks a crowded world to double its crowd', () => {
    const crowded: CardResources = { money: 0, blood: 0, dragonBone: 0, power: 0, goblins: 26 };
    for (let seed = 0; seed < 50; seed++) {
      const req = rollUpgradeReq('common', mulberry32(seed), crowded)!;
      expect(req).toEqual({ res: 'goblins', amount: 52 });
    }
  });

  it('only demands bones of a world that keeps bones', () => {
    const bony: CardResources = { money: 0, blood: 0, dragonBone: 8, power: 0 };
    for (let seed = 0; seed < 50; seed++) {
      // Bones are all this world keeps — the demand doubles them.
      expect(rollUpgradeReq('uncommon', mulberry32(seed), bony)).toEqual({ res: 'dragonBone', amount: 16 });
      expect(rollUpgradeReq('common', mulberry32(seed), bony)!.res).not.toBe('dragonBone');
    }
  });

  it('is never born already met, whatever mix the world holds', () => {
    for (let seed = 0; seed < 300; seed++) {
      const r = mulberry32(seed * 31 + 1);
      const resources: CardResources = {
        money: Math.floor(r() * 1_000_000),
        blood: Math.floor(r() * 50_000),
        dragonBone: Math.floor(r() * 20),
        power: Math.floor(r() * 3_000_000_000),
        goblins: Math.floor(r() * 100),
        income: Math.floor(r() * 5_000),
      };
      const tier = seed % 2 === 0 ? 'common' as const : 'uncommon' as const;
      const req = rollUpgradeReq(tier, mulberry32(seed), resources)!;
      expect(req.amount).toBeGreaterThan((resources as Record<string, number>)[req.res] ?? 0);
      // And never beneath the tier floor — pennies still cost a session.
      const floor = tier === 'common'
        ? { money: 2_000, blood: 150, dragonBone: 2, power: 300, goblins: 10 }[req.res]
        : { money: 100_000, blood: 2_500, dragonBone: 4, power: 1_000_000_000, goblins: 30 }[req.res];
      expect(req.amount).toBeGreaterThanOrEqual(floor!);
    }
  });
});

describe('reqMet / ascendCard', () => {
  it('meets a demand only at or above the threshold', () => {
    const c = card('common', { upgradeReq: { res: 'money', amount: 10_000 } });
    c.resources.money = 9_999;
    expect(reqMet(c)).toBe(false);
    c.resources.money = 10_000;
    expect(reqMet(c)).toBe(true);
    expect(reqMet(card('rare'))).toBe(false);
  });

  it('handles power demands (and metas saved before power existed)', () => {
    const c = card('uncommon', { upgradeReq: { res: 'power', amount: 1_000_000_000 } });
    delete (c.resources as Partial<CardResources>).power; // pre-power meta
    expect(reqMet(c)).toBe(false);
    c.resources.power = 1_500_000_000;
    expect(reqMet(c)).toBe(true);
  });

  it('walks the full ladder: common → uncommon → rare → capped', () => {
    const meta = freshMeta();
    const c = card('common', { id: 7, upgradeReq: { res: 'money', amount: 1 } });
    ascendCard(meta, c);
    expect(c.tier).toBe('uncommon');
    expect(c.upgradeReq).not.toBeNull();
    ascendCard(meta, c);
    expect(c.tier).toBe('rare');
    expect(c.upgradeReq).toBeNull();
    ascendCard(meta, c);
    expect(c.tier).toBe('rare');
  });
});

describe('makeCard', () => {
  it('pins the junk card to a Ƶ10,000 climb', () => {
    const meta = freshMeta();
    const junk = makeCard(meta, 'common', mulberry32(1), TASK_IDS, true);
    expect(junk.upgradeReq).toEqual({ res: 'money', amount: 10_000 });
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

  it("records the standing buildings' income potential on the card", () => {
    const meta = freshMeta();
    for (let seed = 0; seed < 8; seed++) {
      const c = makeCard(meta, 'uncommon', mulberry32(seed), TASK_IDS);
      const st = decodeWorld(c.data)!;
      expect(c.resources.income).toBe(cardIncome(st));
      let potential = 0;
      for (const b of st.buildings.values()) potential += BUILDING_DEFS[b.kind].income;
      for (const sb of st.spaceBuildings.values()) {
        if (!st.buildings.has(sb.id)) potential += BUILDING_DEFS[sb.building.kind].income;
      }
      expect(c.resources.income).toBe(potential);
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

// ─── Appetites + trade rules ─────────────────────────────────────────

describe('appetiteAccepts', () => {
  it('matches each appetite against the card resources', () => {
    const poor = card('common');
    const bloody = card('common', { resources: { money: 0, blood: 5, dragonBone: 0 } });
    const rich = card('common', { resources: { money: 5_000, blood: 0, dragonBone: 0 } });
    const bony = card('common', { resources: { money: 0, blood: 0, dragonBone: 2 } });
    expect(appetiteAccepts('any', poor)).toBe(true);
    expect(appetiteAccepts('blood', poor)).toBe(false);
    expect(appetiteAccepts('blood', bloody)).toBe(true);
    expect(appetiteAccepts('rich', rich)).toBe(true);
    expect(appetiteAccepts('rich', bloody)).toBe(false);
    expect(appetiteAccepts('bones', bony)).toBe(true);
    expect(appetiteAccepts('bones', rich)).toBe(false);
  });
});

describe('trade rules', () => {
  const deck = (...tiers: CardTier[]) => tiers.map((t, i) => card(t, { id: 100 + i }));

  it('same-tier trades offer exactly the matching-tier cards', () => {
    const cr = { id: 1, name: 'x', appetite: 'any' as const, deck: deck('common', 'common', 'uncommon') };
    expect(sameTierGives(cr, card('common')).length).toBe(2);
    expect(sameTierGives(cr, card('uncommon')).length).toBe(1);
    expect(sameTierGives(cr, card('rare')).length).toBe(0);
  });

  it('breakdowns need a card one tier above AND two lesser cards in the deck', () => {
    const two = { id: 1, name: 'x', appetite: 'any' as const, deck: deck('common', 'common') };
    const one = { id: 2, name: 'y', appetite: 'any' as const, deck: deck('common', 'uncommon') };
    expect(breakdownGives(two, card('uncommon')).length).toBe(2);
    expect(breakdownGives(one, card('uncommon')).length).toBe(0);  // only one common held
    expect(breakdownGives(two, card('rare')).length).toBe(0);      // two tiers above
    expect(breakdownGives(two, card('common')).length).toBe(0);    // same tier isn't a breakdown
    expect(breakdownGives(one, card('rare')).length).toBe(0);      // single uncommon below rare
  });

  it('takes only appetite-matching cards of the asked-for tier', () => {
    const cr = { id: 1, name: 'x', appetite: 'blood' as const, deck: deck('common') };
    const mine = [
      card('common', { id: 1, resources: { money: 0, blood: 9, dragonBone: 0 } }),
      card('common', { id: 2 }),                                                    // no blood
      card('uncommon', { id: 3, resources: { money: 0, blood: 9, dragonBone: 0 } }), // wrong tier
    ];
    const takers = creatureTakesFor(cr, cr.deck[0], mine);
    expect(takers.map((c) => c.id)).toEqual([1]);
  });
});

// ─── Gatherings ──────────────────────────────────────────────────────

describe('generateEvents', () => {
  it('grows the tables with the tiers: 1 creature (two cards), then 2, then 3 — first one always open to anything', () => {
    const meta = freshMeta();
    const events = generateEvents(meta, null, TASK_IDS);
    expect(events.map((e) => e.tier)).toEqual(['common', 'uncommon', 'rare']);
    expect(events.map((e) => e.creatures.length)).toEqual([1, 2, 3]);
    // The common market's lone creature holds two commons — the first arc's
    // two-for-one partner.
    expect(events[0].creatures[0].deck.length).toBe(2);
    for (const ev of events) {
      expect(ev.creatures[0].appetite).toBe('any');
      for (const cr of ev.creatures) {
        expect(cr.deck.every((c) => c.tier === ev.tier)).toBe(true);
        expect(APPETITE_LINE[cr.appetite]).toBeTruthy();
      }
    }
    // Picky creatures at the same table don't share an appetite.
    const rareAppetites = events[2].creatures.slice(1).map((c) => c.appetite);
    expect(new Set(rareAppetites).size).toBe(rareAppetites.length);
  });

  it('seats the stolen origin card with the rare exchange\'s any-appetite creature', () => {
    const meta = freshMeta();
    const stolen = card('rare', { id: 1, origin: true });
    const events = generateEvents(meta, stolen, TASK_IDS);
    const holder = events[2].creatures[0];
    expect(holder.appetite).toBe('any');
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

  it('deals no duplicate names: world names unique across the tables (and clear of the hand), creatures seated once', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const meta = { ...freshMeta(), seed };
      meta.cards = [card('common', { name: 'the damp shelf' })];
      const events = generateEvents(meta, null, TASK_IDS);
      const worldNames = events.flatMap((e) => e.creatures.flatMap((c) => c.deck.map((d) => d.name)));
      expect(new Set(worldNames).size).toBe(worldNames.length);
      expect(worldNames).not.toContain('the damp shelf');
      const creatureNames = events.flatMap((e) => e.creatures.map((c) => c.name));
      expect(new Set(creatureNames).size).toBe(creatureNames.length);
    }
  });

  it('reshuffles keep clear of the names still seated at the other gatherings', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const meta = { ...freshMeta(), seed };
      meta.events = generateEvents(meta, null, TASK_IDS);
      const ev = meta.events[1];
      regenerateEvent(meta, ev, TASK_IDS);
      const others = meta.events.filter((e) => e.id !== ev.id);
      const otherCreatures = new Set(others.flatMap((e) => e.creatures.map((c) => c.name)));
      const otherWorlds = new Set(others.flatMap((e) => e.creatures.flatMap((c) => c.deck.map((d) => d.name))));
      for (const cr of ev.creatures) {
        expect(otherCreatures.has(cr.name)).toBe(false);
        for (const d of cr.deck) expect(otherWorlds.has(d.name)).toBe(false);
      }
    }
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

describe('progression sanity', () => {
  it('the full journey is closed: junk common → ascend twice → win the origin back', () => {
    const meta = freshMeta();
    const rng = mulberry32(77);
    // The goblin's trade: player holds the junk card; origin waits at III.
    const junk = makeCard(meta, 'common', rng, TASK_IDS, true);
    meta.cards = [junk];
    const origin = card('rare', { id: meta.nextId++, origin: true });
    meta.events = generateEvents(meta, origin, TASK_IDS);

    // The junk card's demand is reachable by playing (simulated here), and
    // ascending it twice reaches rare.
    junk.resources.money = junk.upgradeReq!.amount;
    expect(reqMet(junk)).toBe(true);
    ascendCard(meta, junk);
    expect(junk.tier).toBe('uncommon');
    junk.resources = { money: 10_000_000, blood: 100_000, dragonBone: 200, power: 9_999_999_999, goblins: 999 };
    expect(reqMet(junk)).toBe(true);
    ascendCard(meta, junk);
    expect(junk.tier).toBe('rare');

    // At the rare exchange, the any-appetite holder accepts the player's
    // rare for the origin card — the win condition is reachable.
    const holder = meta.events[2].creatures[0];
    const theOrigin = holder.deck.find((c) => c.origin)!;
    const takers = creatureTakesFor(holder, theOrigin, meta.cards);
    expect(takers).toContain(junk);
  });

  it('walks the designed first arc: ascend the junk card, break it down, ascend both halves', () => {
    const meta = freshMeta();
    const rng = mulberry32(31);
    const junk = makeCard(meta, 'common', rng, TASK_IDS, true);
    meta.cards = [junk];
    meta.events = generateEvents(meta, null, TASK_IDS);
    const [gatheringOne, gatheringTwo] = meta.events;

    // 1. Ascend the junk common (its pinned Ƶ10,000 climb).
    junk.resources.money = 10_000;
    expect(reqMet(junk)).toBe(true);
    ascendCard(meta, junk);
    expect(junk.tier).toBe('uncommon');

    // 2. The common gathering's lone creature holds two commons — it will
    // break the uncommon down whatever its appetite says (greed beats taste).
    const two = gatheringOne.creatures[0];
    expect(two.deck.length).toBe(2);
    expect(creatureOpenTo(two, junk)).toBe(true);
    expect(breakdownGives(two, junk).length).toBe(2);
    const halves = [...two.deck];
    meta.cards = halves;
    two.deck = [junk];

    // 3. Ascend both halves: two uncommons — the uncommon salon's currency.
    for (const half of halves) {
      half.resources = { money: 99_999_999, blood: 999_999, dragonBone: 999, power: 9_999_999_999, goblins: 999 };
      expect(reqMet(half)).toBe(true);
      ascendCard(meta, half);
      expect(half.tier).toBe('uncommon');
    }
    expect(meta.cards.filter((c) => c.tier === 'uncommon').length).toBe(2);
    expect(meta.cards.some((c) => c.tier === gatheringTwo.tier)).toBe(true);
  });

  it('breakdowns ignore appetite; same-tier swaps respect it', () => {
    const bloodless = card('uncommon', { id: 50 }); // nothing a blood-lover wants
    const picky = { id: 1, name: 'x', appetite: 'blood' as const, deck: [card('common', { id: 51 }), card('common', { id: 52 })] };
    expect(appetiteAccepts(picky.appetite, bloodless)).toBe(false);
    expect(creatureOpenTo(picky, bloodless)).toBe(true); // via the two-for-one
    const sameTierPicky = { id: 2, name: 'y', appetite: 'blood' as const, deck: [card('uncommon', { id: 53 })] };
    expect(creatureOpenTo(sameTierPicky, bloodless)).toBe(false); // 1:1 needs the appetite
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
