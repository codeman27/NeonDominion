import type { AttackResolutionLog, DiceRollWaveLog } from '../../types/actions';

export type WaveOutcome = 'Attackers win' | 'Defenders win' | 'Split';

export function waveOutcome(w: DiceRollWaveLog): WaveOutcome {
  if (w.attackerLosses === 0) return 'Attackers win';
  if (w.defenderLosses === 0) return 'Defenders win';
  return 'Split';
}

/** Plain-text summary of one roll, e.g. "Round 1: 6, 5, 4 vs 2, 1 → Attackers win (defenders lose 2, attackers lose 0)". */
export function describeWave(w: DiceRollWaveLog, round: number): string {
  return `Round ${round}: ${w.attackerDice.join(', ')} vs ${w.defenderDice.join(', ')} → ${waveOutcome(w)} (defenders lose ${w.defenderLosses}, attackers lose ${w.attackerLosses})`;
}

/** Collapsible round-by-round breakdown of an interactive attack. */
export function battleResultsHtml(attack: AttackResolutionLog, territoryName: (id: number) => string, open: boolean): string {
  if (!attack.waves.length) return '';
  const pairs = (w: DiceRollWaveLog) => Math.min(w.attackerDice.length, w.defenderDice.length);
  const rows = attack.waves.map((w, i) => {
    const att = w.attackerDice.map((v, j) => `<span class="die a ${j < pairs(w) && v > w.defenderDice[j] ? 'won' : ''}">${v}</span>`).join('');
    const def = w.defenderDice.map((v, j) => `<span class="die d ${j < pairs(w) && v >= w.attackerDice[j] ? 'won' : ''}">${v}</span>`).join('');
    const outcome = waveOutcome(w);
    const cls = outcome === 'Attackers win' ? 'att' : outcome === 'Defenders win' ? 'def' : 'split';
    return `<li title="${describeWave(w, i + 1)}"><span class="br-round">R${i + 1}</span><span class="br-dice">${att}<em>vs</em>${def}</span>`
      + `<span class="br-out ${cls}">${outcome}<small>Def −${w.defenderLosses} · Att −${w.attackerLosses}</small></span></li>`;
  }).join('');
  const last = attack.waves[attack.waves.length - 1];
  const verdict = attack.conquered ? '★ CAPTURED' : `HELD · ${last.remainingDefenderTroops} left`;
  return `<details class="battle-results" id="battle-results" ${open ? 'open' : ''}>
    <summary>BATTLE RESULTS · ${attack.waves.length} round${attack.waves.length === 1 ? '' : 's'}</summary>
    <div class="br-head">${territoryName(attack.fromTerritoryId)} → ${territoryName(attack.toTerritoryId)} · <b class="${attack.conquered ? 'att' : 'def'}">${verdict}</b></div>
    <ol class="br-list">${rows}</ol>
  </details>`;
}
