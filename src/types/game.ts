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
