import type { TurnResolutionResult } from '../../types/actions';
import type { GameMap, GameState } from '../../types/game';
import type { MapArrow } from './hexMapRenderer';

/** One step of a turn replay: a full board snapshot plus what to show about it. */
export interface ReplayFrame {
  owners: number[];
  troops: number[];
  caption: string;
  sub?: string;
  arrow?: MapArrow;
  /** Territories the camera should frame. */
  focus?: number[];
  dice?: { attacker: number[]; defender: number[]; attackerLosses: number; defenderLosses: number };
  boosted?: number[];
  tone?: 'good' | 'bad' | 'neutral';
  /** Relative display duration (1 = one beat). */
  weight: number;
}

/**
 * Turns a resolved turn into a frame-by-frame replay. Pure: derived only from the state before the
 * turn and the engine's resolution logs, and the final frame is the engine's actual new state.
 */
export function buildReplay(map: GameMap, before: GameState, result: TurnResolutionResult, round = result.turnNumber): ReplayFrame[] {
  const name = (p: number) => before.players[p].name;
  const tn = (id: number) => map.territories[id].name;
  const owners = before.territories.map(t => t.owner);
  const troops = before.territories.map(t => t.troops);
  const snap = (f: Omit<ReplayFrame, 'owners' | 'troops'>): ReplayFrame => ({ owners: [...owners], troops: [...troops], ...f });
  const frames: ReplayFrame[] = [];
  const r = result.reinforcements;

  frames.push(snap({ caption: `${name(result.playerIndex)} · TURN ${round}`, sub: `+${r.total} troops${r.cardTradeBonus ? ` (cards +${r.cardTradeBonus})` : ''}`, weight: 1 }));

  for (const id of r.territoryMatchBonusTerritories) troops[id] += 2;
  for (const d of result.draftApplied) troops[d.territoryId] += d.troops;
  const boosted = [...new Set([...result.draftApplied.map(d => d.territoryId), ...r.territoryMatchBonusTerritories])];
  if (boosted.length) frames.push(snap({ caption: 'DEPLOY', sub: boosted.map(tn).slice(0, 3).join(', ') + (boosted.length > 3 ? '…' : ''), boosted, focus: boosted, weight: 1 }));

  for (const log of result.attackLogs) {
    if (log.skippedReason) continue;
    const arrow: MapArrow = { from: log.fromTerritoryId, to: log.toTerritoryId, kind: 'attack', label: '⚔' };
    const focus = [log.fromTerritoryId, log.toTerritoryId];
    const vs = log.defenderIndex === null ? '' : ` vs ${name(log.defenderIndex)}`;
    frames.push(snap({ caption: `${tn(log.fromTerritoryId)} → ${tn(log.toTerritoryId)}`, sub: `${troops[log.fromTerritoryId]} attack ${troops[log.toTerritoryId]}${vs}`, arrow, focus, weight: 0.8 }));
    const fast = log.waves.length > 6;
    for (const w of log.waves) {
      troops[log.fromTerritoryId] = w.remainingAttackerTroops;
      troops[log.toTerritoryId] = w.remainingDefenderTroops;
      frames.push(snap({
        caption: `${tn(log.fromTerritoryId)} → ${tn(log.toTerritoryId)}`, arrow, focus,
        dice: { attacker: w.attackerDice, defender: w.defenderDice, attackerLosses: w.attackerLosses, defenderLosses: w.defenderLosses },
        sub: `${w.remainingAttackerTroops} vs ${w.remainingDefenderTroops}`, weight: fast ? 0.45 : 0.9,
      }));
    }
    if (log.conquered) {
      owners[log.toTerritoryId] = result.playerIndex;
      troops[log.toTerritoryId] = log.troopsMovedOnConquest;
      troops[log.fromTerritoryId] -= log.troopsMovedOnConquest;
      const out = log.eliminatedPlayerIndex === undefined ? '' : ` · ${name(log.eliminatedPlayerIndex)} ELIMINATED`;
      frames.push(snap({ caption: `CAPTURED ${tn(log.toTerritoryId)}`, sub: `${log.troopsMovedOnConquest} troops move in${out}`, focus, tone: 'good', weight: 1 }));
    } else {
      frames.push(snap({ caption: `${tn(log.toTerritoryId)} HOLDS`, sub: `Attack stopped at ${troops[log.fromTerritoryId]}`, focus, tone: 'bad', weight: 0.8 }));
    }
  }

  const f = result.fortify;
  if (f?.executed) {
    troops[f.order.fromTerritoryId] -= f.troopsMoved;
    troops[f.order.toTerritoryId] += f.troopsMoved;
    frames.push(snap({
      caption: 'FORTIFY', sub: `${f.troopsMoved} → ${tn(f.order.toTerritoryId)}`, focus: [f.order.fromTerritoryId, f.order.toTerritoryId],
      arrow: { from: f.order.fromTerritoryId, to: f.order.toTerritoryId, kind: 'fortify', label: 'F' }, weight: 0.9,
    }));
  }

  const captured = result.attackLogs.filter(l => l.conquered).length;
  const s = result.newState;
  const ending = s.phase === 'GAME_OVER' ? `${name(result.playerIndex)} WINS` : `${captured} captured${result.cardDrawn ? ' · drew a card' : ''}`;
  frames.push({ owners: s.territories.map(t => t.owner), troops: s.territories.map(t => t.troops), caption: 'TURN COMPLETE', sub: ending, tone: s.phase === 'GAME_OVER' ? 'good' : 'neutral', weight: 1.1 });
  return frames;
}
