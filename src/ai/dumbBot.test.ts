import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../crypto/prng';
import { canonicalStringify } from '../crypto/stateHash';
import { generateMap } from '../engine/mapGenerator';
import { applySetupPlacement, createGame } from '../engine/setup';
import { chainedGame, testPlayers } from '../engine/testing';
import { applyTurn, validateTurnPlan, witnessFor } from '../engine/turnEngine';
import { generateBotSetupPlacement, generateBotTurnPlan } from './dumbBot';

const TURN_CAP = 3000;

describe('generateBotSetupPlacement', () => {
  it.each([2, 4, 8])('places the whole pool on border territories (%i players)', players => {
    const map = generateMap({ seed: 'bot-setup', playerCount: players });
    let state = createGame({ gameId: 'g', map, players: testPlayers(players), setupSeed: 's' });
    for (let p = 0; p < players; p++) {
      const action = generateBotSetupPlacement(map, state, p);
      for (const pl of action.placements) {
        expect(map.territories[pl.territoryId].neighbors.some(n => state.territories[n].owner !== p)).toBe(true);
      }
      state = applySetupPlacement(state, action);
    }
    expect(state.phase).toBe('ACTIVE_TURN_COMMIT');
  });
});

describe('generateBotTurnPlan', () => {
  it('is deterministic', () => {
    const { map, state } = chainedGame(4, 'bot-det');
    expect(generateBotTurnPlan(map, state)).toEqual(generateBotTurnPlan(map, state));
  });

  it('trades cards when holding a set', () => {
    const { map, state } = chainedGame(3, 'bot-cards');
    const p = state.activePlayerIndex;
    state.players[p].cards = [0, 1, 2, 3, 4].map(id => ({ id, territoryId: id, emblem: (['INFANTRY', 'CAVALRY', 'ARTILLERY', 'INFANTRY', 'INFANTRY'] as const)[id] }));
    const plan = generateBotTurnPlan(map, state);
    expect(plan.cardTrades).toEqual([{ cardIds: [0, 1, 2] }]);
    expect(validateTurnPlan(map, state, plan)).toEqual([]);
  });
});

describe('bots-only games', () => {
  const games: [number, number][] = [];
  for (let players = 2; players <= 8; players++) for (let g = 0; g < (players <= 4 ? 16 : 13); g++) games.push([players, g]);

  it(`${games.length} seeded games all finish with a winner using only valid plans`, () => {
    for (const [players, g] of games) {
      const seed = `bots-${players}-${g}`;
      const { map, cursors } = chainedGame(players, seed, 1500);
      const roster = testPlayers(players).map((pl, i) => ({ ...pl, hashCommitment: cursors[i].initialCommitment }));
      let state = createGame({ gameId: `g-${seed}`, map, players: roster, setupSeed: seed });
      for (let p = 0; p < players; p++) state = applySetupPlacement(state, generateBotSetupPlacement(map, state, p));

      let turns = 0;
      while (state.phase !== 'GAME_OVER') {
        if (++turns > TURN_CAP) throw new Error(`${seed}: no winner after ${TURN_CAP} turns`);
        const plan = generateBotTurnPlan(map, state);
        const errors = validateTurnPlan(map, state, plan);
        if (errors.length) throw new Error(`${seed} turn ${state.turnNumber}: ${errors.join('; ')}`);
        state = applyTurn(map, state, { plan, commitEventId: sha256Hex(canonicalStringify(plan)), revealedSecret: cursors[witnessFor(state)].next() }).newState;
      }
      expect(state.winnerIndex).not.toBeNull();
    }
  }, 300_000);
});
