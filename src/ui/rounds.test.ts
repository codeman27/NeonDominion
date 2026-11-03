import { describe, expect, it } from 'vitest';
import type { GameEvent } from '../types/protocol';
import { roundOfTurn } from './rounds';

/** Minimal TURN_COMMIT events for the given seat order (turn numbers start at 1). */
function commits(seats: number[]): GameEvent[] {
  return seats.map((playerIndex, i) => ({
    id: String(i), author: '', seq: i,
    payload: { kind: 'TURN_COMMIT', gameId: 'g', turnNumber: i + 1, stateHash: '', actionPlan: { playerIndex } },
  }) as unknown as GameEvent);
}

describe('roundOfTurn', () => {
  it('counts one round per pass through all commanders', () => {
    const events = commits([0, 1, 2, 3, 0, 1, 2, 3]);
    expect([1, 2, 3, 4, 5, 8].map(t => roundOfTurn(events, t, -1))).toEqual([1, 1, 1, 1, 2, 2]);
  });

  it('turn 9 in a 4-player game is round 3 for the human about to play', () => {
    expect(roundOfTurn(commits([0, 1, 2, 3, 0, 1, 2, 3]), 9, 0)).toBe(3);
  });

  it('places the uncommitted turn in the current round when play has not wrapped', () => {
    expect(roundOfTurn(commits([0, 1]), 3, 2)).toBe(1);
    expect(roundOfTurn([], 1, 0)).toBe(1);
  });

  it('stays correct after a commander is eliminated', () => {
    // Seat 2 eliminated after round 1: the next rounds are 0,1,3.
    const events = commits([0, 1, 2, 3, 0, 1, 3, 0, 1, 3]);
    expect(roundOfTurn(events, 7, 3)).toBe(2);
    expect(roundOfTurn(events, 8, 0)).toBe(3);
    expect(roundOfTurn(events, 11, 0)).toBe(4);
  });
});
