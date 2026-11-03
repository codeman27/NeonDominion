import type { GameEvent } from '../types/protocol';

/**
 * Display round for an engine turn. The engine numbers every seat's turn; a round is one pass through
 * all living commanders, so it advances whenever play wraps back to an earlier (or the same) seat.
 * Turns not yet committed (the one being planned) are placed after the last committed turn.
 */
export function roundOfTurn(events: readonly GameEvent[], turnNumber: number, playerIndex: number): number {
  let round = 0;
  let prev = Infinity;
  for (const e of events) {
    if (e.payload.kind !== 'TURN_COMMIT') continue;
    const seat = e.payload.actionPlan.playerIndex;
    if (seat <= prev) round++;
    prev = seat;
    if (e.payload.turnNumber === turnNumber) return round;
  }
  if (prev === Infinity) return 1;
  return playerIndex <= prev ? round + 1 : round;
}
