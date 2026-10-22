import { describe, expect, it } from 'vitest';
import { computeStateHash } from '../crypto/stateHash';
import type { GameState } from '../types/game';
import { GameRuleError } from './errors';
import { generateMap } from './mapGenerator';
import { STARTING_TROOPS, applySetupPlacement, createGame } from './setup';
import { testPlayers } from './testing';

function newGame(players = 4, setupSeed = 'setup') {
  const map = generateMap({ seed: 'map-seed', playerCount: players });
  return { map, state: createGame({ gameId: 'g1', map, players: testPlayers(players), setupSeed }) };
}

/** Puts all of a player's setup troops on their first territory. */
function dumpSetup(state: GameState, playerIndex: number) {
  const tid = state.territories.findIndex(t => t.owner === playerIndex);
  return { type: 'SETUP_PLACEMENT' as const, playerIndex, placements: [{ territoryId: tid, troops: state.players[playerIndex].setupTroops }] };
}

describe('createGame', () => {
  it.each([2, 3, 4, 5, 6, 7, 8])('deals evenly with 1 troop each (%i players)', p => {
    const { map, state } = newGame(p);
    const counts = new Array(p).fill(0);
    for (const t of state.territories) { counts[t.owner]++; expect(t.troops).toBe(1); }
    expect(new Set(counts)).toEqual(new Set([map.territories.length / p]));
    for (const pl of state.players) expect(pl.setupTroops).toBe(STARTING_TROOPS[p] - map.territories.length / p);
    expect(state.phase).toBe('SETUP_PLACEMENT');
    expect(state.turnNumber).toBe(0);
  });

  it('is deterministic and seed-dependent', () => {
    expect(newGame(4, 'a').state).toEqual(newGame(4, 'a').state);
    expect(newGame(4, 'a').state.territories).not.toEqual(newGame(4, 'b').state.territories);
  });

  it('builds a T+2 card deck with balanced emblems and 2 wilds', () => {
    const { map, state } = newGame(5);
    const T = map.territories.length;
    expect(state.deck).toHaveLength(T + 2);
    expect(state.deck.map(c => c.id).sort((a, b) => a - b)).toEqual(Array.from({ length: T + 2 }, (_, i) => i));
    const wilds = state.deck.filter(c => c.emblem === 'WILD');
    expect(wilds).toHaveLength(2);
    expect(wilds.every(c => c.territoryId === null && c.id >= T)).toBe(true);
    const counts = ['INFANTRY', 'CAVALRY', 'ARTILLERY'].map(e => state.deck.filter(c => c.emblem === e).length);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
    for (const c of state.deck.filter(c => c.territoryId !== null)) expect(c.id).toBe(c.territoryId);
  });

  it('rejects mismatched player counts and duplicate ids', () => {
    const map = generateMap({ seed: 'x', playerCount: 3 });
    expect(() => createGame({ gameId: 'g', map, players: testPlayers(4), setupSeed: 's' })).toThrow(GameRuleError);
    const dup = testPlayers(3); dup[2].id = 'p0';
    expect(() => createGame({ gameId: 'g', map, players: dup, setupSeed: 's' })).toThrow(GameRuleError);
  });

  it('produces canonical-JSON-safe state', () => {
    expect(() => computeStateHash(newGame(3).state)).not.toThrow();
  });
});

describe('applySetupPlacement', () => {
  it('places troops, marks done and chains the previous hash without mutating input', () => {
    const { state } = newGame(3);
    const before = structuredClone(state);
    const action = dumpSetup(state, 1);
    const next = applySetupPlacement(state, action);
    expect(state).toEqual(before);
    expect(next.territories[action.placements[0].territoryId].troops).toBe(1 + state.players[1].setupTroops);
    expect(next.players[1].setupDone).toBe(true);
    expect(next.players[1].setupTroops).toBe(0);
    expect(next.prevStateHash).toBe(computeStateHash(state));
    expect(next.phase).toBe('SETUP_PLACEMENT');
  });

  it('starts turn 1 with seat 0 once everyone has placed', () => {
    let { state } = newGame(3);
    for (const i of [2, 0, 1]) state = applySetupPlacement(state, dumpSetup(state, i));
    expect(state.phase).toBe('ACTIVE_TURN_COMMIT');
    expect(state.turnNumber).toBe(1);
    expect(state.activePlayerIndex).toBe(0);
  });

  it('accepts splitting troops across several territories', () => {
    const { state } = newGame(4);
    const mine = state.territories.map((t, i) => [t, i] as const).filter(([t]) => t.owner === 0).map(([, i]) => i);
    const pool = state.players[0].setupTroops;
    const next = applySetupPlacement(state, { type: 'SETUP_PLACEMENT', playerIndex: 0, placements: [
      { territoryId: mine[0], troops: pool - 3 }, { territoryId: mine[1], troops: 2 }, { territoryId: mine[0], troops: 1 },
    ] });
    expect(next.territories[mine[0]].troops).toBe(1 + pool - 2);
    expect(next.territories[mine[1]].troops).toBe(3);
  });

  describe('rejects invalid placements', () => {
    const { state } = newGame(4);
    const mine = state.territories.findIndex(t => t.owner === 0);
    const theirs = state.territories.findIndex(t => t.owner === 1);
    const pool = state.players[0].setupTroops;
    const cases: [string, unknown][] = [
      ['territory not owned', [{ territoryId: theirs, troops: pool }]],
      ['unknown territory', [{ territoryId: 999, troops: pool }]],
      ['negative troops', [{ territoryId: mine, troops: pool + 1 }, { territoryId: mine, troops: -1 }]],
      ['non-integer troops', [{ territoryId: mine, troops: pool - 0.5 }, { territoryId: mine, troops: 0.5 }]],
      ['too few', [{ territoryId: mine, troops: pool - 1 }]],
      ['too many', [{ territoryId: mine, troops: pool + 1 }]],
    ];
    it.each(cases)('%s', (_, placements) => {
      expect(() => applySetupPlacement(state, { type: 'SETUP_PLACEMENT', playerIndex: 0, placements } as never)).toThrow(GameRuleError);
    });

    it('a second submission', () => {
      const once = applySetupPlacement(state, dumpSetup(state, 0));
      expect(() => applySetupPlacement(once, dumpSetup(state, 0))).toThrow(GameRuleError);
    });

    it('unknown player and wrong phase', () => {
      expect(() => applySetupPlacement(state, { ...dumpSetup(state, 0), playerIndex: 9 })).toThrow(GameRuleError);
      expect(() => applySetupPlacement({ ...state, phase: 'ACTIVE_TURN_COMMIT' }, dumpSetup(state, 0))).toThrow(GameRuleError);
    });
  });
});
