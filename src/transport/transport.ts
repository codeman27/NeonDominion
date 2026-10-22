import type { SetupPlacementAction, TurnActionPlan, TurnResolutionResult } from '../types/actions';
import type { GameMap, GameState, PlayerIndex } from '../types/game';
import type { GameEvent, TurnCommitPayload, TurnRevealPayload } from '../types/protocol';

export interface TurnOutcome {
  commit: GameEvent<TurnCommitPayload>;
  reveal: GameEvent<TurnRevealPayload>;
  resolution: TurnResolutionResult;
}

/**
 * What the UI talks to. Phase 1 = LocalGame (everything in-process); Phase 2 = Nostr relays.
 * The engine and UI never know which one they're using (ARCHITECTURE §10).
 */
export interface GameTransport {
  readonly mode: 'LOCAL' | 'NOSTR';
  readonly map: GameMap;
  /** Seat of the human using this client. */
  readonly localPlayerIndex: PlayerIndex;
  getState(): GameState;
  submitSetupPlacement(action: SetupPlacementAction): Promise<GameState>;
  submitTurnCommit(plan: TurnActionPlan): Promise<TurnOutcome>;
  /** Fires for every resolved turn (local human, bots, or remote players). Returns an unsubscribe fn. */
  onTurnResolved(callback: (outcome: TurnOutcome) => void): () => void;
  /** The complete public game log as text. */
  exportEventLog(): string;
}
