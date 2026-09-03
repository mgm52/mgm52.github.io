// Unit tests for hell's narrative gates (src/state.ts): the predicates behind
// the refused climb out of hell and the Pain Gabbonsaw lock. Run with
// `npm test`.

import { describe, expect, it } from 'vitest';
import {
  GameState, createInitialState, gabbonsawLockedByHell, hellBeatsDone, hellBusinessUnfinished,
  markHellBeatsDone, unlockEverything,
} from '../src/state';

function demon(st: GameState, variant: 'pit' | 'l' | 'friend') {
  const d = [...st.demons.values()].find((x) => (x.variant ?? 'pit') === variant);
  if (!d) throw new Error(`no ${variant} demon`);
  return d;
}

function fresh(): GameState {
  const st = createInitialState();
  expect(st.demons.size).toBe(3);
  return st;
}

describe('hellBeatsDone', () => {
  it('needs both Lolly heard through and Lilly\'s handout', () => {
    const st = fresh();
    expect(hellBeatsDone(st)).toBe(false);
    demon(st, 'friend').toldOfGolf = true;
    expect(hellBeatsDone(st)).toBe(false);
    st.lillyTasksGiven = true;
    expect(hellBeatsDone(st)).toBe(true);
  });

  it('counts the departure even though Lolly has left the roster', () => {
    const st = fresh();
    st.lillyTasksGiven = true;
    st.demons.delete(demon(st, 'friend').id);
    expect(hellBeatsDone(st)).toBe(false);
    st.bobLollyDeparted = true;
    expect(hellBeatsDone(st)).toBe(true);
  });
});

describe('the refused climb (hellBusinessUnfinished)', () => {
  it('never blocks before the colossus has taken the bones', () => {
    // Bones come from the overworld — blocking here could strand the player.
    const st = fresh();
    expect(hellBusinessUnfinished(st)).toBe(false);
    demon(st, 'friend').toldOfGolf = true;
    expect(hellBusinessUnfinished(st)).toBe(false);
  });

  it('blocks after the trade until both beats are done', () => {
    const st = fresh();
    demon(st, 'pit').boneGiftGiven = true;
    expect(hellBusinessUnfinished(st)).toBe(true);
    demon(st, 'friend').toldOfGolf = true;
    expect(hellBusinessUnfinished(st)).toBe(true);
    st.lillyTasksGiven = true;
    expect(hellBusinessUnfinished(st)).toBe(false);
  });

  it('is off in card worlds and the designer sandbox', () => {
    const st = fresh();
    demon(st, 'pit').boneGiftGiven = true;
    st.cardWorld = true;
    expect(hellBusinessUnfinished(st)).toBe(false);
    st.cardWorld = false;
    st.tasksDisabled = true;
    expect(hellBusinessUnfinished(st)).toBe(false);
  });
});

describe('the Pain Gabbonsaw lock (gabbonsawLockedByHell)', () => {
  it('locks regardless of how the blood was earned', () => {
    // No trade, no visit — a grind to 9,999,999 blood still can't skip hell.
    const st = fresh();
    st.blood = 9_999_999;
    expect(gabbonsawLockedByHell(st)).toBe(true);
    demon(st, 'friend').toldOfGolf = true;
    st.lillyTasksGiven = true;
    expect(gabbonsawLockedByHell(st)).toBe(false);
  });

  it('never blocks the climb and the ritual in a way that could strand: the climb lifts first', () => {
    const st = fresh();
    demon(st, 'pit').boneGiftGiven = true;
    markHellBeatsDone(st);
    expect(hellBusinessUnfinished(st)).toBe(false);
    expect(gabbonsawLockedByHell(st)).toBe(false);
  });

  it('is off in card worlds and the designer sandbox', () => {
    const st = fresh();
    st.cardWorld = true;
    expect(gabbonsawLockedByHell(st)).toBe(false);
    st.cardWorld = false;
    st.tasksDisabled = true;
    expect(gabbonsawLockedByHell(st)).toBe(false);
  });
});

describe('dev cheats', () => {
  it('unlockEverything stamps the beats so the ritual is not locked', () => {
    const st = fresh();
    unlockEverything(st, ['earn_100']);
    expect(gabbonsawLockedByHell(st)).toBe(false);
  });
});
