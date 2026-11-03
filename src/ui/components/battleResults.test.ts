import { describe, expect, it } from 'vitest';
import type { AttackResolutionLog, DiceRollWaveLog } from '../../types/actions';
import { battleResultsHtml, describeWave, waveOutcome } from './battleResults';

const wave = (a: number[], d: number[], aLoss: number, dLoss: number, remD = 3): DiceRollWaveLog =>
  ({ attackerDice: a, defenderDice: d, attackerLosses: aLoss, defenderLosses: dLoss, remainingAttackerTroops: 5, remainingDefenderTroops: remD });

describe('battle results', () => {
  it('classifies each roll', () => {
    expect(waveOutcome(wave([6, 5, 4], [2, 1], 0, 2))).toBe('Attackers win');
    expect(waveOutcome(wave([3], [5], 1, 0))).toBe('Defenders win');
    expect(waveOutcome(wave([6, 2], [4, 3], 1, 1))).toBe('Split');
  });

  it('describes a round with dice and losses', () => {
    expect(describeWave(wave([6, 5, 4], [2, 1], 0, 2), 1))
      .toBe('Round 1: 6, 5, 4 vs 2, 1 → Attackers win (defenders lose 2, attackers lose 0)');
  });

  it('renders one collapsed row per round', () => {
    const attack: AttackResolutionLog = {
      orderId: 'x', fromTerritoryId: 0, toTerritoryId: 1, defenderIndex: 1, conquered: true, troopsMovedOnConquest: 0,
      waves: [wave([6, 2], [4, 3], 1, 1, 1), wave([5], [1], 0, 1, 0)],
    };
    const html = battleResultsHtml(attack, id => `T${id}`, false);
    expect(html).toContain('BATTLE RESULTS · 2 rounds');
    expect(html).toContain('T0 → T1');
    expect(html).toContain('★ CAPTURED');
    expect(html.match(/<li /g)).toHaveLength(2);
    expect(html).not.toMatch(/<details[^>]*\sopen[\s>]/);
    expect(battleResultsHtml(attack, String, true)).toMatch(/<details[^>]*\sopen[\s>]/);
  });
});
