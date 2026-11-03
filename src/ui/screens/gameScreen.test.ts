import { describe, expect, it } from 'vitest';
import { resolveAttack } from '../../engine/combatResolver';
import { startedGame } from '../../engine/testing';
import { attackStopThreshold, tradeHand } from './gameScreen';

describe('trade hand lookup', () => {
  const old = [{ id: 1, territoryId: 0, emblem: 'INFANTRY' as const }];
  const live = [{ id: 7, territoryId: 2, emblem: 'CAVALRY' as const }];
  it('uses the live hand outside an interactive turn, even with a stale snapshot', () => {
    expect(tradeHand(false, old, live)).toBe(live);
  });
  it('uses the pre-trade snapshot during the interactive turn', () => {
    expect(tradeHand(true, old, live)).toBe(old);
  });
});

describe('interactive attack stop threshold', () => {
  it.each([[13, 14], [1, 2], [null, 0]])('converts %s remaining attackers to %s total source troops', (remaining, total) => {
    expect(attackStopThreshold(remaining)).toBe(total);
  });

  it('stops 14 attacking armies at 13, with one additional army reserved', () => {
    const { map, state } = startedGame(2, 'attack-stop');
    const from = map.territories[0].id;
    const to = map.territories[from].neighbors[0];
    state.territories[from] = { owner: 0, troops: 15 };
    state.territories[to] = { owner: 1, troops: 20 };
    // Each wave splits the losses: one attacker and one defender.
    const dice = [6, 1, 1, 5, 5];
    let rolls = 0;
    const result = resolveAttack(map, state, 0, {
      orderId: 'stop-at-13',
      fromTerritoryId: from,
      toTerritoryId: to,
      stopWhenAttackerAtOrBelow: attackStopThreshold(13),
      occupyMode: { type: 'NONE' },
    }, () => dice[rolls++ % dice.length]);

    expect(result.waves).toHaveLength(1);
    expect(state.territories[from].troops).toBe(14);
    expect(state.territories[from].troops - 1).toBe(13);
    expect(result.conquered).toBe(false);
  });

  it('checks the limit after a full wave, allowing a two-loss wave to cross it', () => {
    const { map, state } = startedGame(2, 'attack-stop');
    const from = map.territories[0].id;
    const to = map.territories[from].neighbors[0];
    state.territories[from] = { owner: 0, troops: 15 };
    state.territories[to] = { owner: 1, troops: 20 };
    const result = resolveAttack(map, state, 0, {
      orderId: 'stop-after-wave',
      fromTerritoryId: from,
      toTerritoryId: to,
      stopWhenAttackerAtOrBelow: attackStopThreshold(13),
      occupyMode: { type: 'NONE' },
    }, () => 1);

    expect(result.waves).toHaveLength(1);
    expect(result.waves[0].attackerDice).toHaveLength(3);
    expect(state.territories[from].troops - 1).toBe(12);
  });
});
