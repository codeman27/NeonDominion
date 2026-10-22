/* Shared fixtures for engine tests (not imported by production code). */
import { HashChainCursor } from '../crypto/hashChain';
import { sha256Hex } from '../crypto/prng';
import type { GameMap, GameState } from '../types/game';
import { generateMap } from './mapGenerator';
import { applySetupPlacement, createGame, type NewPlayer } from './setup';

export function testPlayers(n: number): NewPlayer[] {
  return Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}`, isBot: i > 0, hashCommitment: 'c'.repeat(63) + i }));
}

/** A game past setup: every player dumped their setup troops on their lowest-id territory. */
export function startedGame(players = 4, seed = 'fixture'): { map: GameMap; state: GameState } {
  const map = generateMap({ seed, playerCount: players });
  let state = createGame({ gameId: `g-${seed}`, map, players: testPlayers(players), setupSeed: seed });
  for (let i = 0; i < players; i++) {
    const tid = state.territories.findIndex(t => t.owner === i);
    state = applySetupPlacement(state, { type: 'SETUP_PLACEMENT', playerIndex: i, placements: [{ territoryId: tid, troops: state.players[i].setupTroops }] });
  }
  return { map, state };
}

/** A started game where every player has a real hash chain (needed for applyTurn). */
export function chainedGame(players = 3, seed = 'chained'): { map: GameMap; state: GameState; cursors: HashChainCursor[] } {
  const map = generateMap({ seed, playerCount: players });
  const cursors = Array.from({ length: players }, (_, i) => HashChainCursor.fromRoot(sha256Hex(`root:${seed}:${i}`), 500));
  const roster = testPlayers(players).map((p, i) => ({ ...p, hashCommitment: cursors[i].initialCommitment }));
  let state = createGame({ gameId: `g-${seed}`, map, players: roster, setupSeed: seed });
  for (let i = 0; i < players; i++) {
    const tid = state.territories.findIndex(t => t.owner === i);
    state = applySetupPlacement(state, { type: 'SETUP_PLACEMENT', playerIndex: i, placements: [{ territoryId: tid, troops: state.players[i].setupTroops }] });
  }
  return { map, state, cursors };
}
