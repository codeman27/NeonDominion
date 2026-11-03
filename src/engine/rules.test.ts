import { describe, expect, it } from 'vitest';
import type { CardEmblem, TerritoryCard } from '../types/game';
import {
  baseReinforcements, bestSet, cardSetValue, continentBonusFor, mustTrade, ownedTerritoryCount, territoryMatchFor,
} from './rules';
import { startedGame } from './testing';

let nextId = 0;
const card = (emblem: CardEmblem, territoryId: number | null = emblem === 'WILD' ? null : nextId): TerritoryCard => ({ id: nextId++, territoryId, emblem });
const set = (...e: CardEmblem[]) => e.map(x => card(x));

describe('baseReinforcements', () => {
  it.each([[0, 3], [1, 3], [8, 3], [9, 3], [11, 3], [12, 4], [14, 4], [15, 5], [48, 16]])('%i territories → %i', (owned, troops) => {
    expect(baseReinforcements(owned)).toBe(troops);
  });
});

describe('cardSetValue', () => {
  it.each<[string, CardEmblem[], number | null]>([
    ['3 infantry', ['INFANTRY', 'INFANTRY', 'INFANTRY'], 3],
    ['3 cavalry', ['CAVALRY', 'CAVALRY', 'CAVALRY'], 6],
    ['3 artillery', ['ARTILLERY', 'ARTILLERY', 'ARTILLERY'], 8],
    ['one of each', ['INFANTRY', 'CAVALRY', 'ARTILLERY'], 10],
    ['one of each (any order)', ['ARTILLERY', 'INFANTRY', 'CAVALRY'], 10],
    ['wild + 2 infantry → best is 3 infantry', ['WILD', 'INFANTRY', 'INFANTRY'], 3],
    ['wild + 2 artillery', ['ARTILLERY', 'WILD', 'ARTILLERY'], 8],
    ['wild + inf + cav → one of each', ['WILD', 'INFANTRY', 'CAVALRY'], 10],
    ['2 wilds + anything → one of each', ['WILD', 'WILD', 'INFANTRY'], 10],
    ['3 wilds', ['WILD', 'WILD', 'WILD'], 10],
    ['2 inf + 1 cav is invalid', ['INFANTRY', 'INFANTRY', 'CAVALRY'], null],
    ['2 art + 1 inf is invalid', ['ARTILLERY', 'INFANTRY', 'ARTILLERY'], null],
  ])('%s', (_, emblems, value) => {
    expect(cardSetValue(set(...emblems))).toBe(value);
  });

  it('requires exactly 3 cards', () => {
    expect(cardSetValue(set('INFANTRY', 'INFANTRY'))).toBeNull();
    expect(cardSetValue(set('INFANTRY', 'INFANTRY', 'INFANTRY', 'INFANTRY'))).toBeNull();
  });
});

describe('mustTrade', () => {
  it.each([[3, false], [4, false], [5, true], [7, true]])('%i cards → %s', (n, must) => expect(mustTrade(n)).toBe(must));
});

describe('territoryMatchFor', () => {
  it('returns the first owned card territory in order, ignoring wilds', () => {
    const cards: TerritoryCard[] = [{ id: 1, territoryId: null, emblem: 'WILD' }, { id: 2, territoryId: 7, emblem: 'INFANTRY' }, { id: 3, territoryId: 5, emblem: 'INFANTRY' }];
    expect(territoryMatchFor(cards, id => id === 5 || id === 7)).toBe(7);
    expect(territoryMatchFor(cards, id => id === 5)).toBe(5);
    expect(territoryMatchFor(cards, () => false)).toBeNull();
  });
});

describe('bestSet', () => {
  it('picks the highest-value set in a hand', () => {
    const hand: TerritoryCard[] = [
      { id: 10, territoryId: 1, emblem: 'INFANTRY' }, { id: 11, territoryId: 2, emblem: 'INFANTRY' },
      { id: 12, territoryId: 3, emblem: 'INFANTRY' }, { id: 13, territoryId: 4, emblem: 'CAVALRY' },
      { id: 14, territoryId: 5, emblem: 'ARTILLERY' },
    ];
    expect(bestSet(hand)).toEqual({ cardIds: [10, 13, 14], value: 10 });
  });

  it('returns null when no set exists', () => {
    expect(bestSet([{ id: 1, territoryId: 1, emblem: 'INFANTRY' }, { id: 2, territoryId: 2, emblem: 'INFANTRY' }, { id: 3, territoryId: 3, emblem: 'CAVALRY' }, { id: 4, territoryId: 4, emblem: 'CAVALRY' }])).toBeNull();
    expect(bestSet([])).toBeNull();
  });
});

describe('continent bonus & ownership', () => {
  it('counts only fully owned continents', () => {
    const { map, state } = startedGame(4);
    const c = map.continents[0];
    expect(continentBonusFor(map, state, 0)).toBe(map.continents.filter(k => k.territoryIds.every(id => state.territories[id].owner === 0)).reduce((a, k) => a + k.bonus, 0));
    const owned = structuredClone(state);
    for (const id of c.territoryIds) owned.territories[id].owner = 2;
    expect(continentBonusFor(map, owned, 2)).toBeGreaterThanOrEqual(c.bonus);
    owned.territories[c.territoryIds[0]].owner = 3;
    const others = map.continents.slice(1).filter(k => k.territoryIds.every(id => owned.territories[id].owner === 2)).reduce((a, k) => a + k.bonus, 0);
    expect(continentBonusFor(map, owned, 2)).toBe(others);
  });

  it('counts owned territories', () => {
    const { map, state } = startedGame(4);
    expect(ownedTerritoryCount(state, 1)).toBe(map.territories.length / 4);
  });
});
