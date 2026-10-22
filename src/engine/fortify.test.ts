import { describe, expect, it } from 'vitest';
import type { GameMap, GameState } from '../types/game';
import { applyFortify, connectedOwned } from './fortify';
import { startedGame } from './testing';

/** Player 0 owns a path A–B–C (A not adjacent to C) plus an isolated territory D; everything else is player 1. */
function arena(): { map: GameMap; state: GameState; a: number; b: number; c: number; d: number } {
  const { map, state } = startedGame(2, 'fortify');
  for (const t of map.territories) for (const b of t.neighbors) for (const c of map.territories[b].neighbors) {
    if (c === t.id || t.neighbors.includes(c)) continue;
    const near = new Set([t.id, b, c, ...t.neighbors, ...map.territories[b].neighbors, ...map.territories[c].neighbors]);
    const d = map.territories.find(x => !near.has(x.id));
    if (!d) continue;
    const s = structuredClone(state);
    s.territories.forEach(x => { x.owner = 1; x.troops = 1; });
    s.territories[t.id] = { owner: 0, troops: 8 };
    s.territories[b] = { owner: 0, troops: 1 };
    s.territories[c] = { owner: 0, troops: 1 };
    s.territories[d.id] = { owner: 0, troops: 1 };
    return { map, state: s, a: t.id, b, c, d: d.id };
  }
  throw new Error('no arena');
}

const f = (from: number, to: number, troops: number) => ({ fromTerritoryId: from, toTerritoryId: to, troops });

describe('applyFortify', () => {
  it('moves troops along a multi-hop owned path without mutating input', () => {
    const { map, state, a, c } = arena();
    const before = structuredClone(state);
    const { state: next, resolution } = applyFortify(map, state, 0, f(a, c, 5));
    expect(resolution).toMatchObject({ executed: true, troopsMoved: 5 });
    expect(next.territories[a].troops).toBe(3);
    expect(next.territories[c].troops).toBe(6);
    expect(state).toEqual(before);
  });

  it('clamps over-moves so 1 troop stays behind', () => {
    const { map, state, a, b } = arena();
    const { state: next, resolution } = applyFortify(map, state, 0, f(a, b, 50));
    expect(resolution.troopsMoved).toBe(7);
    expect(next.territories[a].troops).toBe(1);
  });

  it.each([
    ['NO_CONNECTED_PATH', (s: ReturnType<typeof arena>) => f(s.a, s.d, 3)],
    ['NOT_OWNED', (s: ReturnType<typeof arena>) => f(s.a, s.map.territories[s.a].neighbors.find(n => s.state.territories[n].owner === 1)!, 3)],
    ['NOT_OWNED', (s: ReturnType<typeof arena>) => f(s.map.territories.find(t => s.state.territories[t.id].owner === 1)!.id, s.a, 1)],
    ['SAME_TERRITORY', (s: ReturnType<typeof arena>) => f(s.a, s.a, 3)],
    ['NOTHING_TO_MOVE', (s: ReturnType<typeof arena>) => f(s.b, s.a, 3)],
    ['NOTHING_TO_MOVE', (s: ReturnType<typeof arena>) => f(s.a, s.b, 0)],
    ['NOTHING_TO_MOVE', (s: ReturnType<typeof arena>) => f(s.a, s.b, -2)],
  ])('skips with %s and returns the same state', (reason, make) => {
    const s = arena();
    const { state: next, resolution } = applyFortify(s.map, s.state, 0, make(s));
    expect(resolution).toMatchObject({ executed: false, troopsMoved: 0, skippedReason: reason });
    expect(next).toBe(s.state);
  });

  it('a path broken by an enemy territory is not connected', () => {
    const { map, state, a, b, c } = arena();
    state.territories[b].owner = 1;
    expect(connectedOwned(map, state, 0, a).has(c)).toBe(false);
  });
});
