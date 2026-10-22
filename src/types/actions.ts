import type { GameState, PlayerIndex, TerritoryId } from './game';

export interface SetupPlacementAction {
  type: 'SETUP_PLACEMENT';
  playerIndex: PlayerIndex;
  /** Extra troops per owned territory; must sum exactly to the player's setup pool. Order is irrelevant. */
  placements: DraftPlacementOrder[];
}

export interface CardTradeOrder {
  cardIds: [number, number, number];
}

export interface DraftPlacementOrder {
  territoryId: TerritoryId;
  troops: number;
}

export type OccupyMode =
  | { type: 'MIN' }
  | { type: 'HALF' }
  | { type: 'ALL_BUT_ONE' }
  | { type: 'LEAVE_BEHIND'; leaveTroops: number };

export interface AttackCampaignOrder {
  orderId: string;
  fromTerritoryId: TerritoryId;
  toTerritoryId: TerritoryId;
  /** Stop rolling further waves once attacker troops on the source are <= this (treated as at least 1). */
  stopWhenAttackerAtOrBelow: number;
  occupyMode: OccupyMode;
}

export interface FortifyOrder {
  fromTerritoryId: TerritoryId;
  toTerritoryId: TerritoryId;
  troops: number;
}

export interface TurnActionPlan {
  type: 'TURN_ACTION_PLAN';
  turnNumber: number;
  playerIndex: PlayerIndex;
  cardTrades: CardTradeOrder[];
  draftPlacements: DraftPlacementOrder[];
  attackQueue: AttackCampaignOrder[];
  fortify: FortifyOrder | null;
}

/* ---------------------------------- Resolution logs (for replay UI) ---------------------------------- */

export interface DiceRollWaveLog {
  attackerDice: number[];
  defenderDice: number[];
  attackerLosses: number;
  defenderLosses: number;
  remainingAttackerTroops: number;
  remainingDefenderTroops: number;
}

export type AttackSkipReason =
  | 'SOURCE_NOT_OWNED'
  | 'TARGET_ALREADY_OWNED'
  | 'NOT_ADJACENT'
  | 'INSUFFICIENT_TROOPS';

export interface AttackResolutionLog {
  orderId: string;
  fromTerritoryId: TerritoryId;
  toTerritoryId: TerritoryId;
  /** Owner of the target when the order was reached (null if skipped before lookup). */
  defenderIndex: PlayerIndex | null;
  skippedReason?: AttackSkipReason;
  waves: DiceRollWaveLog[];
  conquered: boolean;
  troopsMovedOnConquest: number;
  eliminatedPlayerIndex?: PlayerIndex;
}

export type FortifySkipReason = 'NOT_OWNED' | 'SAME_TERRITORY' | 'NO_CONNECTED_PATH' | 'NOTHING_TO_MOVE';

export interface FortifyResolution {
  order: FortifyOrder;
  executed: boolean;
  troopsMoved: number;
  skippedReason?: FortifySkipReason;
}

export interface ReinforcementBreakdown {
  base: number;
  continentBonus: number;
  cardTradeBonus: number;
  /** Territories that received the +2 card match bonus (placed automatically). */
  territoryMatchBonusTerritories: TerritoryId[];
  /** base + continentBonus + cardTradeBonus (excludes the automatic +2 match troops). */
  total: number;
}

export interface TurnResolutionResult {
  turnNumber: number;
  playerIndex: PlayerIndex;
  turnSeed: string;
  reinforcements: ReinforcementBreakdown;
  draftApplied: DraftPlacementOrder[];
  attackLogs: AttackResolutionLog[];
  fortify: FortifyResolution | null;
  cardDrawn: boolean;
  eliminatedPlayers: PlayerIndex[];
  newState: GameState;
  newStateHash: string;
}
