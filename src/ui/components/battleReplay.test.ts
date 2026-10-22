import { describe, expect, it } from 'vitest';
import { generateBotTurnPlan } from '../../ai/dumbBot';
import { sha256Hex } from '../../crypto/prng';
import { canonicalStringify } from '../../crypto/stateHash';
import { chainedGame } from '../../engine/testing';
import { applyTurn, witnessFor } from '../../engine/turnEngine';
import { buildReplay } from './battleReplay';

describe('buildReplay', () => {
  it('every frame sequence ends exactly on the engine\'s new state, and intermediate frames are consistent', () => {
    const { map, state: initial, cursors } = chainedGame(4, 'replay', 1500);
    let state = initial;
    let checkedAttacks = 0;
    for (let turn = 0; turn < 120 && state.phase !== 'GAME_OVER'; turn++) {
      const plan = generateBotTurnPlan(map, state);
      const result = applyTurn(map, state, { plan, commitEventId: sha256Hex(canonicalStringify(plan)), revealedSecret: cursors[witnessFor(state)].next() });
      const frames = buildReplay(map, state, result);
      const last = frames.at(-1)!;
      expect(last.owners).toEqual(result.newState.territories.map(t => t.owner));
      expect(last.troops).toEqual(result.newState.territories.map(t => t.troops));
      // The derived board just before the final frame must already match the engine (no hidden jumps).
      const penultimate = frames.at(-2)!;
      expect(penultimate.owners).toEqual(last.owners);
      expect(penultimate.troops).toEqual(last.troops);
      for (const f of frames) expect(f.troops.every(n => n >= 0)).toBe(true);
      checkedAttacks += result.attackLogs.filter(l => !l.skippedReason).length;
      state = result.newState;
    }
    expect(checkedAttacks).toBeGreaterThan(20);
  });

  it('emits a dice frame per wave and a capture frame for conquests', () => {
    const { map, state, cursors } = chainedGame(2, 'replay-dice', 1500);
    const p = state.activePlayerIndex;
    const from = map.territories.find(t => state.territories[t.id].owner === p && t.neighbors.some(n => state.territories[n].owner !== p))!;
    const to = from.neighbors.find(n => state.territories[n].owner !== p)!;
    state.territories[from.id].troops = 40;
    state.territories[to].troops = 3;
    const plan = { ...generateBotTurnPlan(map, state), attackQueue: [{ orderId: 'x', fromTerritoryId: from.id, toTerritoryId: to, stopWhenAttackerAtOrBelow: 1, occupyMode: { type: 'MIN' as const } }], fortify: null };
    const result = applyTurn(map, state, { plan, commitEventId: 'c', revealedSecret: cursors[witnessFor(state)].next() });
    const frames = buildReplay(map, state, result);
    const waves = result.attackLogs[0].waves.length;
    expect(frames.filter(f => f.dice)).toHaveLength(waves);
    expect(frames.some(f => f.caption.startsWith('CAPTURED'))).toBe(result.attackLogs[0].conquered);
  });
});
