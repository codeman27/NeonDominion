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
  | { type: 'LEAVE_BEHIND'; leaveTroops: number }
  | { type: 'NONE' };

export interface AttackCampaignOrder {
  orderId: string;
  fromTerritoryId: TerritoryId;
  toTerritoryId: TerritoryId;
  /** Number of dice (attackers) to roll. Defaults to 3 (max). */
  attackerDice?: number;
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

/* ---------------------------------- Interactive attack results ---------------------------------- */

export interface InteractiveAttackResult {
  /** The attack that was just resolved. */
  attack: AttackResolutionLog;
  /** Snapshot of territory owners after this attack. */
  owners: number[];
  /** Snapshot of troop counts after this attack. */
  troops: number[];
  /** Whether there are more queued attacks remaining. */
  moreAttacks: boolean;
  /** Whether the turn is complete (attacks done, fortify applied, game advanced). */
  turnComplete: boolean;
}

/** Captures the full interactive turn state after committing but before all attacks resolve. */
export interface InteractiveTurnState {
  playerIndex: PlayerIndex;
  turnNumber: number;
  turnSeed: string;
  reinforcements: ReinforcementBreakdown;
  draftApplied: DraftPlacementOrder[];
  cardDrawn: boolean;
  /** True once any interactive attack this turn captured a territory (earns a card at turn end). */
  conqueredAny: boolean;
  /** All resolved attacks in execution order, for replay and end-game statistics. */
  attackLogs: AttackResolutionLog[];
  eliminatedPlayers: PlayerIndex[];
  fortify: FortifyResolution | null;
  /** Remaining attack orders to resolve. */
  remainingAttacks: AttackCampaignOrder[];
  /** Live clone of GameState during the interactive turn. */
  liveState: GameState;
  /** Last attack result for replay UI. */
  lastResult: InteractiveAttackResult | null;
}
