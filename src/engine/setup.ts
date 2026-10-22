import { DeterministicRng, sha256Hex } from '../crypto/prng';
import { computeStateHash } from '../crypto/stateHash';
import type { SetupPlacementAction } from '../types/actions';
import type { CardEmblem, GameMap, GameState, PlayerState, TerritoryCard } from '../types/game';
import { GameRuleError } from './errors';

/** Starting troops per player by player count (ARCHITECTURE §3.1). */
export const STARTING_TROOPS: Readonly<Record<number, number>> = { 2: 35, 3: 35, 4: 30, 5: 25, 6: 20, 7: 20, 8: 20 };

const EMBLEM_CYCLE: CardEmblem[] = ['INFANTRY', 'CAVALRY', 'ARTILLERY'];
export const WILD_CARD_COUNT = 2;

export interface NewPlayer {
  id: string;
  name: string;
  isBot: boolean;
  /** C_0 of the player's hash chain. */
  hashCommitment: string;
}

export interface CreateGameOptions {
  gameId: string;
  map: GameMap;
  players: NewPlayer[];
  /** Agreed setup randomness (single player: random; multiplayer: from the setup commit-reveal). */
  setupSeed: string;
}

/** Deals territories (1 troop each), builds the shuffled deck and sets every player's setup pool. */
export function createGame(opts: CreateGameOptions): GameState {
  const { map, players, gameId, setupSeed } = opts;
  const P = players.length;
  const T = map.territories.length;
  if (P !== map.playerCount) throw new GameRuleError(`map was generated for ${map.playerCount} players, got ${P}`);
  if (T % P !== 0) throw new GameRuleError('territory count must divide evenly between players');
  if (new Set(players.map(p => p.id)).size !== P) throw new GameRuleError('player ids must be unique');

  const rng = new DeterministicRng(sha256Hex(`SETUP:${gameId}:${setupSeed}`));
  const ids = map.territories.map(t => t.id);

  const dealOrder = rng.fork('deal').shuffle([...ids]);
  const territories = ids.map(() => ({ owner: 0, troops: 1 }));
  dealOrder.forEach((tid, i) => { territories[tid].owner = i % P; });

  const emblemOrder = rng.fork('emblems').shuffle([...ids]);
  const emblemOf: CardEmblem[] = [];
  emblemOrder.forEach((tid, i) => { emblemOf[tid] = EMBLEM_CYCLE[i % EMBLEM_CYCLE.length]; });
  const cards: TerritoryCard[] = ids.map(tid => ({ id: tid, territoryId: tid, emblem: emblemOf[tid] }));
  for (let w = 0; w < WILD_CARD_COUNT; w++) cards.push({ id: T + w, territoryId: null, emblem: 'WILD' });
  const deck = rng.fork('deck').shuffle(cards);

  const setupTroops = STARTING_TROOPS[P] - T / P;
  const playerStates: PlayerState[] = players.map(p => ({
    id: p.id,
    name: p.name,
    isBot: p.isBot,
    eliminated: false,
    cards: [],
    setupTroops,
    setupDone: false,
    currentHashCommitment: p.hashCommitment,
    hashChainIndex: 0,
  }));

  return {
    version: 1,
    gameId,
    mapSeed: map.seed,
    mapGeneratorVersion: map.generatorVersion,
    phase: 'SETUP_PLACEMENT',
    turnNumber: 0,
    activePlayerIndex: 0,
    players: playerStates,
    territories,
    deck,
    discardPile: [],
    winnerIndex: null,
    prevStateHash: '',
    lastCommitEventId: null,
    lastRevealEventId: null,
  };
}

/**
 * Applies one player's whole setup placement. Once every player has submitted, the game moves to turn 1
 * with seat 0 active. Returns a new state; the input is never mutated.
 */
export function applySetupPlacement(state: GameState, action: SetupPlacementAction): GameState {
  if (state.phase !== 'SETUP_PLACEMENT') throw new GameRuleError('not in setup phase');
  const player = state.players[action.playerIndex];
  if (!player) throw new GameRuleError('unknown player');
  if (player.setupDone) throw new GameRuleError('setup already submitted');

  let total = 0;
  for (const p of action.placements) {
    if (!Number.isInteger(p.troops) || p.troops < 0) throw new GameRuleError('troop amounts must be non-negative integers');
    const t = state.territories[p.territoryId];
    if (!Number.isInteger(p.territoryId) || !t) throw new GameRuleError(`unknown territory ${p.territoryId}`);
    if (t.owner !== action.playerIndex) throw new GameRuleError(`territory ${p.territoryId} is not owned by this player`);
    total += p.troops;
  }
  if (total !== player.setupTroops) throw new GameRuleError(`must place exactly ${player.setupTroops} troops, got ${total}`);

  const next = structuredClone(state);
  for (const p of action.placements) next.territories[p.territoryId].troops += p.troops;
  next.players[action.playerIndex].setupTroops = 0;
  next.players[action.playerIndex].setupDone = true;
  if (next.players.every(p => p.setupDone)) {
    next.phase = 'ACTIVE_TURN_COMMIT';
    next.turnNumber = 1;
    next.activePlayerIndex = 0;
  }
  next.prevStateHash = computeStateHash(state);
  return next;
}
