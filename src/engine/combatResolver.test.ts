import { describe, expect, it } from 'vitest';
import { DeterministicRng } from '../crypto/prng';
import type { AttackCampaignOrder, OccupyMode } from '../types/actions';
import type { GameMap, GameState } from '../types/game';
import { conquestMove, resolveAttack, resolveAttackQueue, resolveWave } from './combatResolver';
import { startedGame } from './testing';

function script(...values: number[]) {
  let i = 0;
  return () => {
    if (i >= values.length) throw new Error('scripted dice exhausted');
    return values[i++];
  };
}

/** A→B→C path with A not adjacent to C; everything else owned by player 3 so nobody else is eliminated. */
function arena(): { map: GameMap; state: GameState; a: number; b: number; c: number } {
  const { map, state } = startedGame(4, 'combat');
  for (const t of map.territories) for (const b of t.neighbors) for (const c of map.territories[b].neighbors) {
    if (c !== t.id && !t.neighbors.includes(c)) {
      const s = structuredClone(state);
      s.territories.forEach(x => { x.owner = 3; x.troops = 1; });
      s.territories[t.id] = { owner: 0, troops: 10 };
      s.territories[b] = { owner: 1, troops: 1 };
      s.territories[c] = { owner: 2, troops: 1 };
      // Keep players 1 and 2 alive elsewhere unless a test removes it.
      const spare = map.territories.find(x => ![t.id, b, c].includes(x.id))!.id;
      const spare2 = map.territories.find(x => ![t.id, b, c, spare].includes(x.id))!.id;
      s.territories[spare] = { owner: 1, troops: 1 };
      s.territories[spare2] = { owner: 2, troops: 1 };
      return { map, state: s, a: t.id, b, c };
    }
  }
  throw new Error('no A-B-C path');
}

const order = (from: number, to: number, extra: Partial<AttackCampaignOrder> = {}): AttackCampaignOrder => ({
  orderId: `${from}-${to}`, fromTerritoryId: from, toTerritoryId: to, stopWhenAttackerAtOrBelow: 1, occupyMode: { type: 'ALL_BUT_ONE' }, ...extra,
});

describe('resolveWave', () => {
  it('compares sorted dice pairwise; attacker wins strictly higher', () => {
    expect(resolveWave(10, 5, script(1, 6, 5, 4, 5))).toEqual({ attackerDice: [6, 5, 1], defenderDice: [5, 4], attackerLosses: 0, defenderLosses: 2 });
  });

  it('ties go to the defender', () => {
    expect(resolveWave(10, 5, script(4, 4, 4, 4, 4))).toMatchObject({ attackerLosses: 2, defenderLosses: 0 });
    expect(resolveWave(10, 5, script(6, 3, 1, 6, 2))).toMatchObject({ attackerLosses: 1, defenderLosses: 1 });
  });

  it('dice counts depend on troops (attacker troops−1 up to 3, defender up to 2)', () => {
    const w = resolveWave(2, 1, script(5, 3));
    expect(w.attackerDice).toHaveLength(1);
    expect(w.defenderDice).toHaveLength(1);
    expect(resolveWave(3, 9, script(2, 2, 6, 1)).attackerDice).toHaveLength(2);
  });

  it('only compares min(attackDice, defenseDice) pairs', () => {
    expect(resolveWave(10, 1, script(6, 6, 6, 1))).toMatchObject({ attackerLosses: 0, defenderLosses: 1 });
  });
});

describe('conquestMove', () => {
  it.each<[OccupyMode, number, number, number]>([
    [{ type: 'MIN' }, 10, 3, 3],
    [{ type: 'ALL_BUT_ONE' }, 10, 3, 9],
    [{ type: 'HALF' }, 10, 3, 5],
    [{ type: 'HALF' }, 4, 3, 3],               // half (2) is below the dice rolled → clamped up to 3
    [{ type: 'LEAVE_BEHIND', leaveTroops: 4 }, 10, 3, 6],
    [{ type: 'LEAVE_BEHIND', leaveTroops: 9 }, 10, 3, 3],  // can't leave more than allows the minimum move
    [{ type: 'LEAVE_BEHIND', leaveTroops: 0 }, 10, 3, 9],  // must always leave 1
    [{ type: 'MIN' }, 2, 1, 1],
  ])('%j with %i troops after %i dice → %i', (mode, troops, dice, expected) => {
    expect(conquestMove(mode, troops, dice)).toBe(expected);
  });
});

describe('resolveAttack', () => {
  it('conquers, moves troops by occupy mode and logs each wave', () => {
    const { map, state, a, b } = arena();
    const log = resolveAttack(map, state, 0, order(a, b, { occupyMode: { type: 'MIN' } }), script(6, 5, 4, 1));
    expect(log).toMatchObject({ conquered: true, troopsMovedOnConquest: 3, defenderIndex: 1 });
    expect(log.waves).toHaveLength(1);
    expect(state.territories[b]).toEqual({ owner: 0, troops: 3 });
    expect(state.territories[a].troops).toBe(7);
  });

  it('stops when attacker troops reach the threshold', () => {
    const { map, state, a, b } = arena();
    state.territories[b].troops = 20;
    // Every wave: attacker rolls 1s, defender 6s → attacker loses 2 per wave. 10 → 8 → 6 → 4 (≤ 4 stop).
    const log = resolveAttack(map, state, 0, order(a, b, { stopWhenAttackerAtOrBelow: 4 }), () => 1);
    expect(log.conquered).toBe(false);
    expect(state.territories[a].troops).toBe(4);
    expect(log.waves.map(w => w.remainingAttackerTroops)).toEqual([8, 6, 4]);
    expect(state.territories[b]).toEqual({ owner: 1, troops: 20 });
  });

  it('never attacks below 1 even with a 0 threshold', () => {
    const { map, state, a, b } = arena();
    state.territories[b].troops = 50;
    resolveAttack(map, state, 0, order(a, b, { stopWhenAttackerAtOrBelow: 0 }), () => 1);
    expect(state.territories[a].troops).toBe(1);
  });

  it.each([
    ['SOURCE_NOT_OWNED', (s: ReturnType<typeof arena>) => order(s.b, s.c)],
    ['TARGET_ALREADY_OWNED', (s: ReturnType<typeof arena>) => { s.state.territories[s.b].owner = 0; return order(s.a, s.b); }],
    ['NOT_ADJACENT', (s: ReturnType<typeof arena>) => order(s.a, s.c)],
    ['INSUFFICIENT_TROOPS', (s: ReturnType<typeof arena>) => { s.state.territories[s.a].troops = 1; return order(s.a, s.b); }],
    ['INSUFFICIENT_TROOPS', (s: ReturnType<typeof arena>) => order(s.a, s.b, { stopWhenAttackerAtOrBelow: 10 })],
  ])('skips with %s without rolling dice', (reason, make) => {
    const s = arena();
    const o = make(s);
    const snapshot = structuredClone(s.state.territories);
    const log = resolveAttack(s.map, s.state, 0, o, script());
    expect(log.skippedReason).toBe(reason);
    expect(log.waves).toEqual([]);
    expect(s.state.territories).toEqual(snapshot);
  });

  it('eliminates a defender who loses their last territory and hands over their cards', () => {
    const { map, state, a, b } = arena();
    state.territories.forEach(t => { if (t.owner === 1) t.owner = 3; });
    state.territories[b].owner = 1;
    state.players[1].cards = [{ id: 0, territoryId: 0, emblem: 'INFANTRY' }, { id: 99, territoryId: null, emblem: 'WILD' }];
    const log = resolveAttack(map, state, 0, order(a, b), script(6, 5, 4, 1)); // 3 attack dice vs 1
    expect(log.eliminatedPlayerIndex).toBe(1);
    expect(state.players[1].eliminated).toBe(true);
    expect(state.players[1].cards).toEqual([]);
    expect(state.players[0].cards.map(c => c.id)).toEqual([0, 99]);
  });
});

describe('resolveAttackQueue (chains)', () => {
  it('A→B then B→C uses the troops moved into B', () => {
    const { map, state, a, b, c } = arena();
    const { state: next, logs } = resolveAttackQueue(map, state, 0, [order(a, b), order(b, c)], script(6, 5, 4, 1, 6, 5, 4, 1));
    expect(logs.map(l => l.conquered)).toEqual([true, true]);
    // A 10 → moves 9 into B (leaves 1); B 9 → moves 8 into C.
    expect(next.territories[a].troops).toBe(1);
    expect(next.territories[b]).toEqual({ owner: 0, troops: 1 });
    expect(next.territories[c]).toEqual({ owner: 0, troops: 8 });
  });

  it('skips B→C when B was not captured', () => {
    const { map, state, a, b, c } = arena();
    state.territories[b].troops = 30;
    const { logs } = resolveAttackQueue(map, state, 0, [order(a, b, { stopWhenAttackerAtOrBelow: 6 }), order(b, c)], () => 1);
    expect(logs[0].conquered).toBe(false);
    expect(logs[1].skippedReason).toBe('SOURCE_NOT_OWNED');
  });

  it('does not mutate the input state', () => {
    const { map, state, a, b } = arena();
    const before = structuredClone(state);
    resolveAttackQueue(map, state, 0, [order(a, b)], script(6, 5, 4, 1));
    expect(state).toEqual(before);
  });
});

describe('statistics', () => {
  it('3v2 single wave: attacker wins both ≈ 37.2%, split ≈ 33.6%, defender both ≈ 29.3%', () => {
    const rng = new DeterministicRng('stats');
    const roll = () => rng.rollD6();
    const N = 10_000; let both = 0; let split = 0;
    for (let i = 0; i < N; i++) {
      const w = resolveWave(4, 2, roll);
      if (w.defenderLosses === 2) both++; else if (w.defenderLosses === 1) split++;
    }
    expect(Math.abs(both / N - 2890 / 7776)).toBeLessThan(0.02);
    expect(Math.abs(split / N - 2611 / 7776)).toBeLessThan(0.02);
  });
});
