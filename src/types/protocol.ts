import type { SetupPlacementAction, TurnActionPlan } from './actions';
import type { PlayerIndex } from './game';

/*
 * Text event envelope shared by the local transport (Phase 1) and the Nostr transport (Phase 2).
 * Locally `author` is the player id and `id` is a content hash; on Nostr these map to the event
 * pubkey and the NIP-01 event id, with the payload in `content`. See ARCHITECTURE §6.3.
 */
export interface GameEvent<P extends GamePayload = GamePayload> {
  /** SHA-256 of canonicalStringify({ author, seq, payload }). */
  id: string;
  /** Player id of the signer (pubkey in Phase 2). */
  author: string;
  /** Position in the game log (0-based); replaces timestamps so logs stay deterministic. */
  seq: number;
  payload: P;
}

export interface GameCreatePayload {
  kind: 'GAME_CREATE';
  gameId: string;
  mapSeed: string;
  mapGeneratorVersion: number;
  setupSeed: string;
  players: { id: string; name: string; isBot: boolean; hashCommitment: string }[];
}

export interface SetupPlacementPayload {
  kind: 'SETUP_PLACEMENT';
  gameId: string;
  action: SetupPlacementAction;
}

export interface TurnCommitPayload {
  kind: 'TURN_COMMIT';
  gameId: string;
  turnNumber: number;
  /** Hash of the state the plan was made against (the engine's current state). */
  stateHash: string;
  actionPlan: TurnActionPlan;
}

export interface TurnRevealPayload {
  kind: 'TURN_REVEAL';
  gameId: string;
  turnNumber: number;
  witnessIndex: PlayerIndex;
  commitEventId: string;
  revealedSecret: string;
  /** Hash of the state after applying the turn; every client must reproduce it. */
  expectedNewStateHash: string;
}

export type GamePayload = GameCreatePayload | SetupPlacementPayload | TurnCommitPayload | TurnRevealPayload;
