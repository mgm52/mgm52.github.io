// Unit tests for the trading-card realm's core logic (src/cards-core.ts):
// world generation validity, serialization round-trips (including through
// the JSON meta blob), tier/ascension rules, trade rules, and the gathering
// generator's progression guarantees. Run with `npm test`.

import { describe, expect, it } from 'vitest';
import {
  APPETITE_LINE, CardMeta, CardTier, TIER_ABOVE, TIER_RANK, WorldCard,
  appetiteAccepts, ascendCard, breakdownGives, creatureTakesFor, decodeWorld,
  encodeWorld, generateEvents, generateJunkWorld, generateWeirdWorld, makeCard,
  mulberry32, regenerateEvent, reqMet, rollUpgradeReq, sameTierGives, worldName,
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
    resources: { money: 0, blood: 0, dragonBone: 0 },
    upgradeReq: null,
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
  it('rolls demands inside the tier bands, and none at rare', () => {
    for (let seed = 0; seed < 200; seed++) {
      const rng = mulberry32(seed);
      const common = rollUpgradeReq('common', rng);
      expect(common).not.toBeNull();
      if (common!.res === 'money') {
        expect(common!.amount).toBeGreaterThanOrEqual(5_000);
        expect(common!.amount).toBeLessThanOrEqual(15_000);
      } else {
        expect(common!.res).toBe('blood');
        expect(common!.amount).toBeGreaterThanOrEqual(200);
        expect(common!.amount).toBeLessThanOrEqual(800);
      }
      const un = rollUpgradeReq('uncommon', rng);
      expect(un).not.toBeNull();
      if (un!.res === 'money') {
        expect(un!.amount).toBeGreaterThanOrEqual(250_000);
        expect(un!.amount).toBeLessThanOrEqual(1_000_000);
      } else if (un!.res === 'blood') {
        expect(un!.amount).toBeGreaterThanOrEqual(5_000);
        expect(un!.amount).toBeLessThanOrEqual(20_000);
      } else {
        expect(un!.amount).toBeGreaterThanOrEqual(3);
        expect(un!.amount).toBeLessThanOrEqual(10);
      }
      expect(rollUpgradeReq('rare', rng)).toBeNull();
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
  it('builds one gathering per tier, decks matching, with an any-appetite creature each', () => {
    const meta = freshMeta();
    const events = generateEvents(meta, null, TASK_IDS);
    expect(events.map((e) => e.tier)).toEqual(['common', 'uncommon', 'rare']);
    for (const ev of events) {
      expect(ev.creatures.length).toBe(2);
      // Progression guarantee: someone at every table will consider anything.
      expect(ev.creatures.some((c) => c.appetite === 'any')).toBe(true);
      for (const cr of ev.creatures) {
        expect(cr.deck.length).toBeGreaterThanOrEqual(2);
        expect(cr.deck.every((c) => c.tier === ev.tier)).toBe(true);
        expect(APPETITE_LINE[cr.appetite]).toBeTruthy();
      }
    }
  });

  it('seats the stolen origin card with the rare exchange\'s any-appetite creature', () => {
    const meta = freshMeta();
    const stolen = card('rare', { id: 1, origin: true });
    const events = generateEvents(meta, stolen, TASK_IDS);
    const holder = events[2].creatures[0];
    expect(holder.appetite).toBe('any');
    expect(holder.deck[0].origin).toBe(true);
  });

  it('keeps the origin card through reshuffles and discards the rest', () => {
    const meta = freshMeta();
    const stolen = card('rare', { id: 1, origin: true });
    const events = generateEvents(meta, stolen, TASK_IDS);
    const ev = events[2];
    const strayId = ev.creatures[1].deck[0].id;
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

  it('a tier-above card can always rebuild a collection (two-for-one path)', () => {
    const meta = freshMeta();
    const events = generateEvents(meta, null, TASK_IDS);
    // Holding ONLY an uncommon: the common gathering's any-appetite creature
    // must offer a two-for-one for it.
    const onlyCard = card('uncommon', { id: 999 });
    const anyCreature = events[0].creatures.find((c) => c.appetite === 'any')!;
    expect(breakdownGives(anyCreature, onlyCard).length).toBeGreaterThanOrEqual(2);
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
