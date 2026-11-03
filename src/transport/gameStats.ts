import { computeStateHash } from '../crypto/stateHash';
import type { GameEvent } from '../types/protocol';
import { roundOfTurn } from '../ui/rounds';
import { replayEventLog } from './localTransport';

export interface PlayerStats {
  turns: number;
  attacks: number;
  captures: number;
  territoriesLost: number;
  troopsKilled: number;
  troopsLost: number;
  eliminated: number[];
  peakTerritories: number;
  eliminatedRound: number | null;
}

export interface GameStats {
  turns: number;
  winnerIndex: number | null;
  finalStateHash: string;
  players: PlayerStats[];
}

/** Game statistics derived purely from the text event log (so they survive save/resume). */
export function computeGameStats(log: string): GameStats {
  const events = JSON.parse(log) as GameEvent[];
  let players: PlayerStats[] = [];
  let turns = 0;
  const { state } = replayEventLog(log, (r, before) => {
    if (!players.length) {
      players = before.players.map((_, i) => ({
        turns: 0, attacks: 0, captures: 0, territoriesLost: 0, troopsKilled: 0, troopsLost: 0, eliminated: [],
        peakTerritories: before.territories.filter(t => t.owner === i).length, eliminatedRound: null,
      }));
    }
    turns++;
    const me = players[r.playerIndex];
    me.turns++;
    for (const eliminated of r.eliminatedPlayers) {
      players[eliminated].eliminatedRound = roundOfTurn(events, r.turnNumber, r.playerIndex);
    }
    for (const l of r.attackLogs) {
      if (l.skippedReason || l.defenderIndex === null) continue;
      const them = players[l.defenderIndex];
      me.attacks++;
      for (const w of l.waves) {
        me.troopsLost += w.attackerLosses; me.troopsKilled += w.defenderLosses;
        them.troopsLost += w.defenderLosses; them.troopsKilled += w.attackerLosses;
      }
      if (l.conquered) { me.captures++; them.territoriesLost++; }
      if (l.eliminatedPlayerIndex !== undefined) me.eliminated.push(l.eliminatedPlayerIndex);
    }
    r.newState.players.forEach((_, i) => {
      players[i].peakTerritories = Math.max(players[i].peakTerritories, r.newState.territories.filter(t => t.owner === i).length);
    });
  });
  if (!players.length) {
    players = state.players.map((_, i) => ({
      turns: 0, attacks: 0, captures: 0, territoriesLost: 0, troopsKilled: 0, troopsLost: 0, eliminated: [],
      peakTerritories: state.territories.filter(t => t.owner === i).length, eliminatedRound: null,
    }));
  }
  return { turns, winnerIndex: state.winnerIndex, finalStateHash: computeStateHash(state), players };
}
