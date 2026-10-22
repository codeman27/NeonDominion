import type { AttackCampaignOrder, AttackResolutionLog, DiceRollWaveLog, OccupyMode } from '../types/actions';
import type { GameMap, GameState, PlayerIndex } from '../types/game';

export type RollD6 = () => number;

export interface WaveResult {
  attackerDice: number[];
  defenderDice: number[];
  attackerLosses: number;
  defenderLosses: number;
}

/** One classic Risk exchange: attacker up to 3 dice (troops − 1), defender up to 2; ties go to the defender. */
export function resolveWave(attackerTroops: number, defenderTroops: number, rollD6: RollD6): WaveResult {
  const aCount = Math.min(3, attackerTroops - 1);
  const dCount = Math.min(2, defenderTroops);
  if (aCount < 1 || dCount < 1) throw new RangeError('a wave needs ≥2 attacking and ≥1 defending troops');
  const attackerDice = Array.from({ length: aCount }, rollD6).sort((a, b) => b - a);
  const defenderDice = Array.from({ length: dCount }, rollD6).sort((a, b) => b - a);
  let attackerLosses = 0; let defenderLosses = 0;
  for (let i = 0; i < Math.min(aCount, dCount); i++) {
    if (attackerDice[i] > defenderDice[i]) defenderLosses++; else attackerLosses++;
  }
  return { attackerDice, defenderDice, attackerLosses, defenderLosses };
}

/** Troops moved into a conquered territory: at least the dice just rolled, at most all but one. */
export function conquestMove(mode: OccupyMode, attackerTroops: number, diceRolled: number): number {
  const max = attackerTroops - 1;
  const min = Math.min(diceRolled, max);
  const clamp = (n: number) => Math.min(max, Math.max(min, n));
  switch (mode.type) {
    case 'MIN': return min;
    case 'ALL_BUT_ONE': return max;
    case 'HALF': return clamp(Math.floor(attackerTroops / 2));
    case 'LEAVE_BEHIND': return clamp(attackerTroops - mode.leaveTroops);
  }
}

/**
 * Resolves one attack order against a *working* state, mutating it in place (callers pass a clone).
 * Orders are evaluated against the state as it is when reached, which is what makes chains work:
 * B→C only runs if B was actually captured earlier in the queue.
 */
export function resolveAttack(map: GameMap, state: GameState, player: PlayerIndex, order: AttackCampaignOrder, rollD6: RollD6): AttackResolutionLog {
  const { orderId, fromTerritoryId: from, toTerritoryId: to } = order;
  const log: AttackResolutionLog = { orderId, fromTerritoryId: from, toTerritoryId: to, defenderIndex: null, waves: [], conquered: false, troopsMovedOnConquest: 0 };
  const src = state.territories[from];
  const dst = state.territories[to];
  if (!src || src.owner !== player) return { ...log, skippedReason: 'SOURCE_NOT_OWNED' };
  if (!dst || dst.owner === player) return { ...log, skippedReason: 'TARGET_ALREADY_OWNED' };
  log.defenderIndex = dst.owner;
  if (!map.territories[from].neighbors.includes(to)) return { ...log, skippedReason: 'NOT_ADJACENT' };
  const stopAt = Math.max(1, Math.floor(order.stopWhenAttackerAtOrBelow));
  if (src.troops < 2 || src.troops <= stopAt) return { ...log, skippedReason: 'INSUFFICIENT_TROOPS' };

  let lastDice = 0;
  while (dst.troops > 0 && src.troops > stopAt) {
    const w = resolveWave(src.troops, dst.troops, rollD6);
    src.troops -= w.attackerLosses;
    dst.troops -= w.defenderLosses;
    lastDice = w.attackerDice.length;
    const wave: DiceRollWaveLog = { ...w, remainingAttackerTroops: src.troops, remainingDefenderTroops: dst.troops };
    log.waves.push(wave);
  }

  if (dst.troops === 0) {
    const defender = dst.owner;
    const moved = conquestMove(order.occupyMode, src.troops, lastDice);
    dst.owner = player;
    dst.troops = moved;
    src.troops -= moved;
    log.conquered = true;
    log.troopsMovedOnConquest = moved;
    if (!state.territories.some(t => t.owner === defender)) {
      const loser = state.players[defender];
      loser.eliminated = true;
      state.players[player].cards.push(...loser.cards);
      loser.cards = [];
      log.eliminatedPlayerIndex = defender;
    }
  }
  return log;
}

/** Pure wrapper: resolves a whole queue in order on a clone of `state`. */
export function resolveAttackQueue(map: GameMap, state: GameState, player: PlayerIndex, orders: readonly AttackCampaignOrder[], rollD6: RollD6): { state: GameState; logs: AttackResolutionLog[] } {
  const working = structuredClone(state);
  const logs = orders.map(o => resolveAttack(map, working, player, o, rollD6));
  return { state: working, logs };
}
