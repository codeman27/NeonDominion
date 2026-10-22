import { describe, expect, it } from 'vitest';
import type { HashChainCursor } from '../crypto/hashChain';
import { sha256Hex } from '../crypto/prng';
import { canonicalStringify, computeStateHash } from '../crypto/stateHash';
import type { AttackCampaignOrder, TurnActionPlan } from '../types/actions';
import type { GameMap, GameState, TerritoryCard } from '../types/game';
import { GameRuleError } from './errors';
import { bestSet } from './rules';
import { chainedGame } from './testing';
import { applyTurn, computeReinforcements, deriveTurnSeed, nextAlivePlayer, validateTurnPlan, witnessFor } from './turnEngine';

const commitIdOf = (plan: TurnActionPlan) => sha256Hex(canonicalStringify(plan));

function emptyPlan(map: GameMap, state: GameState, overrides: Partial<TurnActionPlan> = {}): TurnActionPlan {
  const p = state.activePlayerIndex;
  const total = computeReinforcements(map, state, p, []).total;
  const first = state.territories.findIndex(t => t.owner === p);
  return { type: 'TURN_ACTION_PLAN', turnNumber: state.turnNumber, playerIndex: p, cardTrades: [], draftPlacements: [{ territoryId: first, troops: total }], attackQueue: [], fortify: null, ...overrides };
}

/** Simple aggressive planner (stand-in until the dumb bot exists): mandatory trades, stack on the strongest front, attack + chain. */
function simplePlan(map: GameMap, state: GameState): TurnActionPlan {
  const p = state.activePlayerIndex;
  const hand = [...state.players[p].cards];
  const cardTrades: TurnActionPlan['cardTrades'] = [];
  let remaining: TerritoryCard[] = hand;
  while (remaining.length >= 5 || (remaining.length >= 3 && bestSet(remaining))) {
    const set = bestSet(remaining);
    if (!set) break;
    cardTrades.push({ cardIds: set.cardIds });
    remaining = remaining.filter(c => !set.cardIds.includes(c.id));
  }
  const trades = cardTrades.map(t => t.cardIds.map(id => hand.find(c => c.id === id)!));
  const total = computeReinforcements(map, state, p, trades).total;
  const fronts = map.territories.filter(t => state.territories[t.id].owner === p && t.neighbors.some(n => state.territories[n].owner !== p));
  const front = fronts.sort((a, b) => state.territories[b.id].troops - state.territories[a.id].troops)[0] ?? map.territories.find(t => state.territories[t.id].owner === p)!;
  const attackQueue: AttackCampaignOrder[] = [];
  const target = front.neighbors.filter(n => state.territories[n].owner !== p).sort((a, b) => state.territories[a].troops - state.territories[b].troops)[0];
  if (target !== undefined) {
    attackQueue.push({ orderId: 'a1', fromTerritoryId: front.id, toTerritoryId: target, stopWhenAttackerAtOrBelow: 2, occupyMode: { type: 'ALL_BUT_ONE' } });
    const next = map.territories[target].neighbors.find(n => state.territories[n].owner !== p && n !== front.id);
    if (next !== undefined) attackQueue.push({ orderId: 'a2', fromTerritoryId: target, toTerritoryId: next, stopWhenAttackerAtOrBelow: 2, occupyMode: { type: 'HALF' } });
  }
  return { type: 'TURN_ACTION_PLAN', turnNumber: state.turnNumber, playerIndex: p, cardTrades, draftPlacements: [{ territoryId: front.id, troops: total }], attackQueue, fortify: null };
}

function play(map: GameMap, state: GameState, cursors: HashChainCursor[], plan: TurnActionPlan) {
  return applyTurn(map, state, { plan, commitEventId: commitIdOf(plan), revealedSecret: cursors[witnessFor(state)].next() });
}

describe('helpers', () => {
  it('deriveTurnSeed = SHA256(commitId:secret)', () => {
    expect(deriveTurnSeed('abc', 'def')).toBe(sha256Hex('abc:def'));
  });

  it('nextAlivePlayer skips eliminated seats and wraps', () => {
    const { state } = chainedGame(4);
    state.players[1].eliminated = true; state.players[2].eliminated = true;
    expect(nextAlivePlayer(state, 0)).toBe(3);
    expect(nextAlivePlayer(state, 3)).toBe(0);
  });
});

describe('validateTurnPlan', () => {
  const { map, state } = chainedGame(3, 'validate');
  const p = state.activePlayerIndex;
  const theirs = state.territories.findIndex(t => t.owner !== p);
  const withHand = (cards: TerritoryCard[]) => { const s = structuredClone(state); s.players[p].cards = cards; return s; };
  const c = (id: number, emblem: TerritoryCard['emblem']): TerritoryCard => ({ id, territoryId: emblem === 'WILD' ? null : id, emblem });

  it('accepts a minimal valid plan', () => {
    expect(validateTurnPlan(map, state, emptyPlan(map, state))).toEqual([]);
  });

  it.each<[string, (pl: TurnActionPlan) => TurnActionPlan]>([
    ['wrong turn', pl => ({ ...pl, turnNumber: 99 })],
    ['wrong player', pl => ({ ...pl, playerIndex: (p + 1) % 3 })],
    ['too few troops', pl => ({ ...pl, draftPlacements: [{ ...pl.draftPlacements[0], troops: pl.draftPlacements[0].troops - 1 }] })],
    ['too many troops', pl => ({ ...pl, draftPlacements: [{ ...pl.draftPlacements[0], troops: pl.draftPlacements[0].troops + 1 }] })],
    ['draft on enemy territory', pl => ({ ...pl, draftPlacements: [{ territoryId: theirs, troops: pl.draftPlacements[0].troops }] })],
    ['negative draft', pl => ({ ...pl, draftPlacements: [...pl.draftPlacements, { territoryId: pl.draftPlacements[0].territoryId, troops: -1 }] })],
    ['card not in hand', pl => ({ ...pl, cardTrades: [{ cardIds: [1, 2, 3] }] })],
    ['duplicate attack ids', pl => ({ ...pl, attackQueue: [0, 1].map(() => ({ orderId: 'x', fromTerritoryId: 0, toTerritoryId: 1, stopWhenAttackerAtOrBelow: 1, occupyMode: { type: 'MIN' as const } })) })],
    ['bad occupy mode', pl => ({ ...pl, attackQueue: [{ orderId: 'x', fromTerritoryId: 0, toTerritoryId: 1, stopWhenAttackerAtOrBelow: 1, occupyMode: { type: 'NOPE' } as never }] })],
    ['unknown attack territory', pl => ({ ...pl, attackQueue: [{ orderId: 'x', fromTerritoryId: 0, toTerritoryId: 999, stopWhenAttackerAtOrBelow: 1, occupyMode: { type: 'MIN' } }] })],
    ['non-integer fortify', pl => ({ ...pl, fortify: { fromTerritoryId: 0, toTerritoryId: 1, troops: 1.5 } })],
  ])('rejects %s', (_, mutate) => {
    expect(validateTurnPlan(map, state, mutate(emptyPlan(map, state))).length).toBeGreaterThan(0);
  });

  it('rejects an invalid set and reused cards', () => {
    const s = withHand([c(0, 'INFANTRY'), c(1, 'INFANTRY'), c(2, 'CAVALRY'), c(3, 'CAVALRY')]);
    expect(validateTurnPlan(map, s, emptyPlan(map, s, { cardTrades: [{ cardIds: [0, 1, 2] }] })).join()).toMatch(/not a valid set/);
    const s2 = withHand([c(0, 'INFANTRY'), c(1, 'INFANTRY'), c(2, 'INFANTRY'), c(3, 'CAVALRY'), c(4, 'CAVALRY'), c(5, 'CAVALRY')]);
    expect(validateTurnPlan(map, s2, emptyPlan(map, s2, { cardTrades: [{ cardIds: [0, 1, 2] }, { cardIds: [2, 3, 4] }] })).join()).toMatch(/used twice/);
  });

  it('requires trading down below 5 cards', () => {
    const s = withHand([c(0, 'INFANTRY'), c(1, 'INFANTRY'), c(2, 'INFANTRY'), c(3, 'CAVALRY'), c(4, 'CAVALRY')]);
    expect(validateTurnPlan(map, s, emptyPlan(map, s)).join()).toMatch(/must trade/);
    const trade = [{ cardIds: [0, 1, 2] as [number, number, number] }];
    const total = computeReinforcements(map, s, p, [[s.players[p].cards[0], s.players[p].cards[1], s.players[p].cards[2]]]).total;
    const plan = emptyPlan(map, s, { cardTrades: trade });
    plan.draftPlacements[0].troops = total;
    expect(validateTurnPlan(map, s, plan)).toEqual([]);
  });

  it('refuses plans outside the turn phase', () => {
    expect(validateTurnPlan(map, { ...state, phase: 'GAME_OVER' }, emptyPlan(map, state))).toHaveLength(1);
  });
});

describe('applyTurn', () => {
  it('verifies the witness reveal and advances their commitment', () => {
    const { map, state, cursors } = chainedGame(3, 'reveal');
    const plan = emptyPlan(map, state);
    const witness = witnessFor(state);
    expect(() => applyTurn(map, state, { plan, commitEventId: 'c', revealedSecret: 'f'.repeat(64) })).toThrow(GameRuleError);
    const secret = cursors[witness].next();
    const r = applyTurn(map, state, { plan, commitEventId: 'c', revealedSecret: secret });
    expect(r.newState.players[witness].currentHashCommitment).toBe(secret);
    expect(r.newState.players[witness].hashChainIndex).toBe(1);
    // The same secret can't be used twice.
    expect(() => applyTurn(map, r.newState, { plan: emptyPlan(map, r.newState), commitEventId: 'd', revealedSecret: secret })).toThrow(GameRuleError);
  });

  it('applies trades, +2 territory match, draft; discards traded cards; chains hashes; does not mutate input', () => {
    const { map, state, cursors } = chainedGame(3, 'trade');
    const p = state.activePlayerIndex;
    const owned = state.territories.findIndex(t => t.owner === p);
    state.players[p].cards = [
      { id: owned, territoryId: owned, emblem: 'INFANTRY' }, { id: 900, territoryId: null, emblem: 'WILD' }, { id: 901, territoryId: null, emblem: 'CAVALRY' },
    ];
    const before = structuredClone(state);
    const plan = emptyPlan(map, state, { cardTrades: [{ cardIds: [owned, 900, 901] }] });
    plan.draftPlacements = [{ territoryId: owned, troops: computeReinforcements(map, state, p, [state.players[p].cards]).total }];
    const r = play(map, state, cursors, plan);
    expect(state).toEqual(before);
    expect(r.reinforcements.cardTradeBonus).toBe(10);
    expect(r.reinforcements.territoryMatchBonusTerritories).toEqual([owned]);
    expect(r.newState.territories[owned].troops).toBe(state.territories[owned].troops + r.reinforcements.total + 2);
    expect(r.newState.players[p].cards).toEqual([]);
    expect(r.newState.discardPile.map(c => c.id).sort()).toEqual([owned, 900, 901].sort());
    expect(r.newState.prevStateHash).toBe(computeStateHash(state));
    expect(r.newStateHash).toBe(computeStateHash(r.newState));
    expect(r.newState.turnNumber).toBe(state.turnNumber + 1);
    expect(r.newState.activePlayerIndex).toBe(nextAlivePlayer(state, p));
    expect(r.cardDrawn).toBe(false);
  });

  it('draws a card after conquering and reshuffles discards into an empty deck', () => {
    const { map, state, cursors } = chainedGame(2, 'draw');
    const p = state.activePlayerIndex;
    const from = map.territories.find(t => state.territories[t.id].owner === p && t.neighbors.some(n => state.territories[n].owner !== p))!;
    const to = from.neighbors.find(n => state.territories[n].owner !== p)!;
    state.territories[from.id].troops = 60;
    state.territories[to].troops = 1;
    state.discardPile = state.deck.splice(0, state.deck.length);
    const plan = emptyPlan(map, state, { attackQueue: [{ orderId: 'x', fromTerritoryId: from.id, toTerritoryId: to, stopWhenAttackerAtOrBelow: 1, occupyMode: { type: 'MIN' } }] });
    const r = play(map, state, cursors, plan);
    expect(r.attackLogs[0].conquered).toBe(true);
    expect(r.cardDrawn).toBe(true);
    expect(r.newState.players[p].cards).toHaveLength(1);
    expect(r.newState.discardPile).toEqual([]);
    expect(r.newState.deck.length).toBe(state.discardPile.length - 1);
  });

  it('detects the winner when the last enemy territory falls', () => {
    const { map, state, cursors } = chainedGame(2, 'win');
    const p = state.activePlayerIndex;
    const enemy = 1 - p;
    const target = map.territories.find(t => t.neighbors.length > 0)!;
    const from = target.neighbors[0];
    state.territories.forEach(t => { t.owner = p; });
    state.territories[target.id] = { owner: enemy, troops: 1 };
    state.territories[from] = { owner: p, troops: 50 };
    state.players[enemy].cards = [{ id: 0, territoryId: 0, emblem: 'INFANTRY' }];
    const plan = emptyPlan(map, state, {
      attackQueue: [{ orderId: 'w', fromTerritoryId: from, toTerritoryId: target.id, stopWhenAttackerAtOrBelow: 1, occupyMode: { type: 'MIN' } }],
      fortify: { fromTerritoryId: from, toTerritoryId: target.id, troops: 5 },
    });
    const r = play(map, state, cursors, plan);
    expect(r.newState.phase).toBe('GAME_OVER');
    expect(r.newState.winnerIndex).toBe(p);
    expect(r.eliminatedPlayers).toEqual([enemy]);
    expect(r.newState.players[enemy].eliminated).toBe(true);
    expect(r.newState.players[p].cards.map(c => c.id)).toContain(0);
    expect(r.fortify).toBeNull();
  });

  it('is deterministic; a different reveal changes the dice', () => {
    const a = chainedGame(3, 'det');
    const plan = simplePlan(a.map, a.state);
    const secret = a.cursors[witnessFor(a.state)].next();
    const r1 = applyTurn(a.map, a.state, { plan, commitEventId: 'c1', revealedSecret: secret });
    const r2 = applyTurn(a.map, a.state, { plan, commitEventId: 'c1', revealedSecret: secret });
    expect(r1).toEqual(r2);
    const r3 = applyTurn(a.map, a.state, { plan, commitEventId: 'c2', revealedSecret: secret });
    expect(r3.turnSeed).not.toBe(r1.turnSeed);
  });
});

describe('full game', () => {
  it.each([2, 3, 5])('%i players: plays to a winner, keeps invariants, and replays to the same final hash', players => {
    const { map, state: initial, cursors } = chainedGame(players, `full-${players}`);
    const T = map.territories.length;
    const log: { plan: TurnActionPlan; commitEventId: string; revealedSecret: string }[] = [];
    let state = initial;
    for (let i = 0; i < 1500 && state.phase !== 'GAME_OVER'; i++) {
      const plan = simplePlan(map, state);
      const input = { plan, commitEventId: commitIdOf(plan), revealedSecret: cursors[witnessFor(state)].next() };
      log.push(input);
      state = applyTurn(map, state, input).newState;
      expect(state.territories.every(t => t.troops >= 1)).toBe(true);
      const cards = state.deck.length + state.discardPile.length + state.players.reduce((a, pl) => a + pl.cards.length, 0);
      expect(cards).toBe(T + 2);
    }
    expect(state.phase).toBe('GAME_OVER');
    expect(state.winnerIndex).not.toBeNull();

    let replay = initial;
    for (const input of log) replay = applyTurn(map, replay, input).newState;
    expect(computeStateHash(replay)).toBe(computeStateHash(state));
  });
});
