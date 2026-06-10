// Unit tests for the trading-card realm's core logic (src/cards-core.ts):
// world generation validity, serialization round-trips (including through
// the JSON meta blob), tier/ascension rules, trade rules, and the gathering
// generator's progression guarantees. Run with `npm test`.

import { describe, expect, it } from 'vitest';
import {
  APPETITE_LINE, CardMeta, CardResources, CardTier, TIER_ABOVE, TIER_RANK,
  WORLD_FLAVORS, WorldCard, appetiteAccepts, ascendCard, breakdownGives,
  creatureOpenTo, creatureTakesFor, decodeWorld, encodeWorld, generateEvents,
  generateJunkWorld, generateWeirdWorld, makeCard, mulberry32, regenerateEvent,
  reqMet, rollUpgradeReq, sameTierGives, sceneStructureCounts, worldName,
} from '../src/cards-core';
import { BUILDING_DEFS } from '../src/config';
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
      // All tasks pre-completed so card worlds never replay celebrations.
      expect([...st.unlocks!.completed]).toEqual(TASK_IDS);
      expect([...st.unlocks!.revealed]).toEqual(TASK_IDS);
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
    const common = generateWeirdWorld(5, 'common', TASK_IDS);
    const rare = generateWeirdWorld(5, 'rare', TASK_IDS);
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

describe('rollUpgradeReq', () => {
  it('rolls demands inside the tier bands for a from-nothing world, and none at rare', () => {
    for (let seed = 0; seed < 200; seed++) {
      const rng = mulberry32(seed);
      const common = rollUpgradeReq('common', rng, NO_RES);
      expect(common).not.toBeNull();
      if (common!.res === 'money') {
        expect(common!.amount).toBeGreaterThanOrEqual(5_000);
        expect(common!.amount).toBeLessThanOrEqual(15_000);
      } else {
        expect(common!.res).toBe('blood');
        expect(common!.amount).toBeGreaterThanOrEqual(200);
        expect(common!.amount).toBeLessThanOrEqual(800);
      }
      const un = rollUpgradeReq('uncommon', rng, NO_RES);
      expect(un).not.toBeNull();
      if (un!.res === 'money') {
        expect(un!.amount).toBeGreaterThanOrEqual(250_000);
        expect(un!.amount).toBeLessThanOrEqual(1_000_000);
      } else if (un!.res === 'blood') {
        expect(un!.amount).toBeGreaterThanOrEqual(5_000);
        expect(un!.amount).toBeLessThanOrEqual(20_000);
      } else {
        // Bones can't be demanded of a boneless world; power can.
        expect(un!.res).toBe('power');
        expect(un!.amount).toBeGreaterThanOrEqual(1_000_000_000);
        expect(un!.amount).toBeLessThanOrEqual(3_000_000_000);
      }
      expect(rollUpgradeReq('rare', rng, NO_RES)).toBeNull();
    }
  });

  it('is never born already met: amounts lean 2–4× past a spiked holding', () => {
    const spiked: CardResources = { money: 12, blood: 6_000, dragonBone: 0, power: 0 };
    for (let seed = 0; seed < 200; seed++) {
      const req = rollUpgradeReq('common', mulberry32(seed), spiked)!;
      expect((spiked as Record<string, number>)[req.res] ?? 0).toBeLessThan(req.amount);
      if (req.res === 'blood') {
        expect(req.amount).toBeGreaterThanOrEqual(12_000); // ≥ 2× the spike
        expect(req.amount).toBeLessThanOrEqual(24_000);    // ≤ 4× the spike
      }
    }
  });

  it('leans into the spike more often than not', () => {
    const bloodFarm: CardResources = { money: 10, blood: 700, dragonBone: 0, power: 0 };
    let bloodDemands = 0;
    for (let seed = 0; seed < 200; seed++) {
      if (rollUpgradeReq('common', mulberry32(seed), bloodFarm)!.res === 'blood') bloodDemands++;
    }
    expect(bloodDemands).toBeGreaterThan(100);
  });

  it('only demands bones of a world that keeps bones', () => {
    for (let seed = 0; seed < 200; seed++) {
      const req = rollUpgradeReq('uncommon', mulberry32(seed), NO_RES)!;
      expect(req.res).not.toBe('dragonBone');
    }
    let boneDemands = 0;
    const bony: CardResources = { money: 0, blood: 0, dragonBone: 8, power: 0 };
    for (let seed = 0; seed < 200; seed++) {
      if (rollUpgradeReq('uncommon', mulberry32(seed), bony)!.res === 'dragonBone') boneDemands++;
    }
    expect(boneDemands).toBeGreaterThan(0);
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

  it('records the world power on the card (zero until the world has run)', () => {
    const meta = freshMeta();
    const c = makeCard(meta, 'common', mulberry32(4), TASK_IDS);
    expect(c.resources.power).toBe(0);
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
    // The soft border's lone creature holds two commons — the first arc's
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
    junk.resources = { money: 10_000_000, blood: 100_000, dragonBone: 200 };
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
      half.resources = { money: 99_999_999, blood: 999_999, dragonBone: 999, power: 0 };
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
