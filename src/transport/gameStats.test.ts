import { describe, expect, it } from 'vitest';
import { generateBotSetupPlacement, generateBotTurnPlan } from '../ai/dumbBot';
import { sha256Hex } from '../crypto/prng';
import { computeStateHash } from '../crypto/stateHash';
import { LocalGame } from './localTransport';
import { computeGameStats } from './gameStats';

describe('computeGameStats', () => {
  it('summarises a finished game consistently', async () => {
    let n = 0;
    const game = LocalGame.create({ playerCount: 4, mapSeed: 'STATS', random: () => sha256Hex(`stats:${n++}`) });
    await game.submitSetupPlacement(generateBotSetupPlacement(game.map, game.getState(), 0));
    const eliminatedRounds = new Map<number, number>();
    let round = 0;
    let previousSeat = Infinity;
    while (game.getState().phase !== 'GAME_OVER') {
      const seat = game.getState().activePlayerIndex;
      if (seat <= previousSeat) round++;
      previousSeat = seat;
      const outcome = game.isLocalTurn()
        ? await game.submitTurnCommit(generateBotTurnPlan(game.map, game.getState()))
        : (await game.playBotTurn())!;
      for (const eliminated of outcome.resolution.eliminatedPlayers) eliminatedRounds.set(eliminated, round);
    }
    const stats = computeGameStats(game.exportEventLog());
    const T = game.map.territories.length;
    expect(stats.winnerIndex).toBe(game.getState().winnerIndex);
    expect(stats.finalStateHash).toBe(computeStateHash(game.getState()));
    expect(stats.turns).toBe(game.getState().turnNumber - 1 + 1);
    expect(stats.players.reduce((a, p) => a + p.turns, 0)).toBe(stats.turns);
    expect(stats.players.reduce((a, p) => a + p.captures, 0)).toBe(stats.players.reduce((a, p) => a + p.territoriesLost, 0));
    expect(stats.players.reduce((a, p) => a + p.troopsKilled, 0)).toBe(stats.players.reduce((a, p) => a + p.troopsLost, 0));
    expect(stats.players[stats.winnerIndex!].peakTerritories).toBe(T);
    expect(stats.players.flatMap(p => p.eliminated).sort()).toEqual([0, 1, 2, 3].filter(i => i !== stats.winnerIndex));
    stats.players.forEach((p, i) => expect(p.eliminatedRound).toBe(eliminatedRounds.get(i) ?? null));
    expect(stats.players[stats.winnerIndex!].eliminatedRound).toBeNull();
    expect(computeGameStats(LocalGame.restore(game.save()).exportEventLog())).toEqual(stats);
  });

  it('works on a game that has not started yet', () => {
    const game = LocalGame.create({ playerCount: 3, mapSeed: 'EMPTY', random: () => sha256Hex('x') });
    const stats = computeGameStats(game.exportEventLog());
    expect(stats.turns).toBe(0);
    expect(stats.players).toHaveLength(3);
    expect(stats.players.every(p => p.eliminatedRound === null)).toBe(true);
  });
});
