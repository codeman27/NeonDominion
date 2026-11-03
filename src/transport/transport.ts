import type { InteractiveAttackResult, InteractiveTurnState, FortifyOrder, SetupPlacementAction, TurnActionPlan, TurnResolutionResult, AttackCampaignOrder } from '../types/actions';
import type { GameMap, GameState, PlayerIndex, TerritoryId } from '../types/game';
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
  /** Commit the starting plan and seed interactive dice. The final reveal records all decisions
   *  when finishInteractiveTurn is called. Only for LOCAL transport. */
  startInteractiveTurn(plan: TurnActionPlan): InteractiveTurnState;
  /** Resolve an attack in the interactive turn. The attack is resolved against the live state. */
  executeInteractiveAttack(state: InteractiveTurnState, order: AttackCampaignOrder): { result: InteractiveAttackResult; state: InteractiveTurnState };
  /** Apply the fortify step of the interactive turn. */
  executeInteractiveFortify(state: InteractiveTurnState, order: FortifyOrder): { state: InteractiveTurnState };
  /** Move troops from one territory to another (conquered territory step). */
  moveTroopsToConquered(state: InteractiveTurnState, from: TerritoryId, to: TerritoryId, count: number): { state: InteractiveTurnState };
  /** Mark the interactive turn as complete (card draw, win check, advance turn). */
  finishInteractiveTurn(state: InteractiveTurnState): TurnOutcome;
  /** Fires for every resolved turn (local human, bots, or remote players). Returns an unsubscribe fn. */
  onTurnResolved(callback: (outcome: TurnOutcome) => void): () => void;
  /** The complete public game log as text. */
  exportEventLog(): string;
}
