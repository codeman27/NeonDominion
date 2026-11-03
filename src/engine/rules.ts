import type { CardEmblem, GameMap, GameState, PlayerIndex, TerritoryCard, TerritoryId } from '../types/game';

/** Fixed set values (ARCHITECTURE §4.2.1). */
export const SET_VALUES = { INFANTRY: 3, CAVALRY: 6, ARTILLERY: 8, ONE_OF_EACH: 10 } as const;
export const MANDATORY_TRADE_HAND_SIZE = 5;
export const TERRITORY_MATCH_BONUS = 2;

const BASIC: Exclude<CardEmblem, 'WILD'>[] = ['INFANTRY', 'CAVALRY', 'ARTILLERY'];

export function baseReinforcements(ownedTerritories: number): number {
  return Math.max(3, Math.floor(ownedTerritories / 3));
}

export function ownedTerritoryCount(state: GameState, player: PlayerIndex): number {
  let n = 0;
  for (const t of state.territories) if (t.owner === player) n++;
  return n;
}

/** Sum of bonuses of every continent the player owns completely. */
export function continentBonusFor(map: GameMap, state: GameState, player: PlayerIndex): number {
  let bonus = 0;
  for (const c of map.continents) {
    if (c.territoryIds.every(id => state.territories[id].owner === player)) bonus += c.bonus;
  }
  return bonus;
}

/**
 * Value of a 3-card set, or null if it isn't one. WILD substitutes for any emblem; when several
 * interpretations are valid the highest value wins (so WILD+WILD+anything = 10).
 */
export function cardSetValue(cards: readonly TerritoryCard[]): number | null {
  if (cards.length !== 3) return null;
  const real = cards.filter(c => c.emblem !== 'WILD').map(c => c.emblem);
  let best: number | null = null;
  if (new Set(real).size === real.length) best = SET_VALUES.ONE_OF_EACH;
  for (const e of BASIC) {
    if (real.every(r => r === e)) best = Math.max(best ?? 0, SET_VALUES[e]);
  }
  return best;
}

export function mustTrade(handSize: number): boolean {
  return handSize >= MANDATORY_TRADE_HAND_SIZE;
}

/** First traded card (in the given order) whose territory the player owns; that territory gets +2. */
export function territoryMatchFor(cards: readonly TerritoryCard[], owns: (id: TerritoryId) => boolean): TerritoryId | null {
  for (const c of cards) if (c.territoryId !== null && owns(c.territoryId)) return c.territoryId;
  return null;
}

/** Highest-value set in a hand (ties broken by lowest card ids), or null. Used by bots and the UI. */
export function bestSet(hand: readonly TerritoryCard[]): { cardIds: [number, number, number]; value: number } | null {
  const sorted = [...hand].sort((a, b) => a.id - b.id);
  let best: { cardIds: [number, number, number]; value: number } | null = null;
  for (let i = 0; i < sorted.length; i++) for (let j = i + 1; j < sorted.length; j++) for (let k = j + 1; k < sorted.length; k++) {
    const a = sorted[i], b = sorted[j], c = sorted[k];
    const value = cardSetValue([a, b, c]);
    if (value !== null && (!best || value > best.value)) best = { cardIds: [a.id, b.id, c.id], value };
  }
  return best;
}
