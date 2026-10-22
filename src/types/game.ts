export type TerritoryId = number;
export type ContinentId = number;

export interface AxialCoord {
  q: number;
  r: number;
}

export interface Territory {
  id: TerritoryId;
  name: string;
  continentId: ContinentId;
  /** Land hexes, including any land-bridge hexes assigned to this territory. */
  hexes: AxialCoord[];
  /** Most central hex (medoid); where the troop badge goes. */
  labelHex: AxialCoord;
  /** All adjacent territories (land borders, bridges and sea lanes), sorted ascending. */
  neighbors: TerritoryId[];
  /** Subset of `neighbors` reached only by a sea lane. */
  seaLaneNeighbors: TerritoryId[];
}

export interface Continent {
  id: ContinentId;
  name: string;
  bonus: number;
  territoryIds: TerritoryId[];
}

/**
 * The only connections between continents. BRIDGE = a narrow strip of land hexes (already
 * included in territories a/b). SEA_LANE = a naval link drawn between two coastal hexes.
 */
export interface Chokepoint {
  kind: 'BRIDGE' | 'SEA_LANE';
  a: TerritoryId;
  b: TerritoryId;
  from: AxialCoord;
  to: AxialCoord;
  bridgeHexes: AxialCoord[];
}

export interface GameMap {
  generatorVersion: number;
  seed: string;
  playerCount: number;
  /** Which internal retry produced this map (part of the deterministic derivation, useful for debugging). */
  attempt: number;
  territories: Territory[];
  continents: Continent[];
  chokepoints: Chokepoint[];
}

/* ---------------------------------------- Game state ---------------------------------------- */

/** Players are referenced by seat index inside game state; `PlayerState.id` carries the stable identity (later a pubkey). */
export type PlayerIndex = number;

export type CardEmblem = 'INFANTRY' | 'CAVALRY' | 'ARTILLERY' | 'WILD';

export interface TerritoryCard {
  id: number;
  /** null for WILD cards. */
  territoryId: TerritoryId | null;
  emblem: CardEmblem;
}

export interface PlayerState {
  id: string;
  name: string;
  isBot: boolean;
  eliminated: boolean;
  cards: TerritoryCard[];
  /** Troops still to place during SETUP_PLACEMENT (0 once submitted). */
  setupTroops: number;
  setupDone: boolean;
  /** Current head of this player's SHA-256 hash chain (C_k). */
  currentHashCommitment: string;
  /** Number of secrets this player has revealed so far. */
  hashChainIndex: number;
}

export type GamePhase = 'SETUP_PLACEMENT' | 'ACTIVE_TURN_COMMIT' | 'GAME_OVER';

export interface TerritoryState {
  owner: PlayerIndex;
  troops: number;
}

/**
 * Complete, canonical-JSON-safe game state (integers, strings, booleans, null, arrays, plain objects).
 * The map itself is not stored: every client regenerates it from (mapSeed, players.length, mapGeneratorVersion).
 */
export interface GameState {
  version: 1;
  gameId: string;
  mapSeed: string;
  mapGeneratorVersion: number;
  phase: GamePhase;
  /** 0 during setup; the first regular turn is 1. */
  turnNumber: number;
  activePlayerIndex: PlayerIndex;
  players: PlayerState[];
  /** Indexed by TerritoryId. */
  territories: TerritoryState[];
  /** Top of the deck is the LAST element (draw with pop). */
  deck: TerritoryCard[];
  discardPile: TerritoryCard[];
  winnerIndex: PlayerIndex | null;
  /** Hash of the state before the last applied action ('' for the initial state). */
  prevStateHash: string;
  lastCommitEventId: string | null;
  lastRevealEventId: string | null;
}
