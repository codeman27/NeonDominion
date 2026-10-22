import { generateBotSetupPlacement, generateBotTurnPlan } from '../ai/dumbBot';
import { HashChainCursor, generateRootSecret } from '../crypto/hashChain';
import { sha256Hex } from '../crypto/prng';
import { canonicalStringify, computeStateHash } from '../crypto/stateHash';
import { GameRuleError } from '../engine/errors';
import { MAP_GENERATOR_VERSION, generateMap } from '../engine/mapGenerator';
import { applySetupPlacement, createGame } from '../engine/setup';
import { applyTurn, validateTurnPlan, witnessFor } from '../engine/turnEngine';
import type { SetupPlacementAction, TurnActionPlan, TurnResolutionResult } from '../types/actions';
import type { GameMap, GameState, PlayerIndex } from '../types/game';
import type { GameCreatePayload, GameEvent, GamePayload, TurnCommitPayload, TurnRevealPayload } from '../types/protocol';
import type { GameTransport, TurnOutcome } from './transport';

/** Long enough for any realistic single-player game (each seat reveals only when it is witness). */
export const LOCAL_CHAIN_LENGTH = 2000;

const BOT_NAMES = ['BOT-ALPHA', 'BOT-BRAVO', 'BOT-CIPHER', 'BOT-DELTA', 'BOT-ECHO', 'BOT-FLUX', 'BOT-GHOST'];

export interface LocalGameOptions {
  playerCount: number;
  mapSeed: string;
  humanName?: string;
  /** Source of 32-byte hex randomness (chain roots, game id, setup seed). Defaults to the CSPRNG; tests inject a fixed one. */
  random?: () => string;
}

/** Everything needed to resume: the public log plus the private hash-chain state. */
export interface LocalGameSave {
  log: string;
  chains: { root: string; length: number; used: number }[];
  localPlayerIndex: PlayerIndex;
}

function makeEvent<P extends GamePayload>(author: string, seq: number, payload: P): GameEvent<P> {
  return { id: sha256Hex(canonicalStringify({ author, seq, payload })), author, seq, payload };
}

/**
 * Phase 1 transport: human vs. dumb bots in-process, but every turn still goes through the real
 * commit → reveal → applyTurn pipeline and is recorded as text events (ARCHITECTURE §10).
 * In single player the client holds every chain, so this is about fidelity, not anti-cheat.
 */
export class LocalGame implements GameTransport {
  readonly mode = 'LOCAL' as const;
  private events: GameEvent[] = [];
  private listeners = new Set<(o: TurnOutcome) => void>();

  private constructor(
    readonly map: GameMap,
    private state: GameState,
    private cursors: HashChainCursor[],
    readonly localPlayerIndex: PlayerIndex,
  ) {}

  /** New game: human in seat 0, bots in the other seats; bots place their setup troops immediately. */
  static create(opts: LocalGameOptions): LocalGame {
    const rand = opts.random ?? generateRootSecret;
    const map = generateMap({ seed: opts.mapSeed, playerCount: opts.playerCount });
    const cursors = Array.from({ length: opts.playerCount }, () => HashChainCursor.fromRoot(rand(), LOCAL_CHAIN_LENGTH));
    const players = cursors.map((c, i) => ({
      id: i === 0 ? 'local-human' : `bot-${i}`,
      name: i === 0 ? (opts.humanName ?? 'YOU') : BOT_NAMES[i - 1],
      isBot: i !== 0,
      hashCommitment: c.initialCommitment,
    }));
    const create: GameCreatePayload = {
      kind: 'GAME_CREATE', gameId: rand().slice(0, 16), mapSeed: opts.mapSeed, mapGeneratorVersion: MAP_GENERATOR_VERSION,
      setupSeed: rand(), players,
    };
    const game = new LocalGame(map, createGame({ gameId: create.gameId, map, players, setupSeed: create.setupSeed }), cursors, 0);
    game.append(players[0].id, create);
    for (let i = 1; i < players.length; i++) game.applySetup(generateBotSetupPlacement(map, game.state, i));
    return game;
  }

  /** Resume from `save()`. Replays and verifies the whole log, then checks the private chains still line up. */
  static restore(save: LocalGameSave): LocalGame {
    const { map, state, events } = replayEventLog(save.log);
    const cursors = save.chains.map(c => HashChainCursor.restore(c));
    if (cursors.length !== state.players.length) throw new GameRuleError('saved chains do not match player count');
    cursors.forEach((c, i) => {
      if (c.currentCommitment !== state.players[i].currentHashCommitment) throw new GameRuleError(`saved chain ${i} is out of sync with the log`);
    });
    const game = new LocalGame(map, state, cursors, save.localPlayerIndex);
    game.events = events;
    return game;
  }

  getState(): GameState {
    return this.state;
  }

  getEvents(): readonly GameEvent[] {
    return this.events;
  }

  isLocalTurn(): boolean {
    return this.state.phase === 'ACTIVE_TURN_COMMIT' && this.state.activePlayerIndex === this.localPlayerIndex;
  }

  isBotTurn(): boolean {
    return this.state.phase === 'ACTIVE_TURN_COMMIT' && this.state.players[this.state.activePlayerIndex].isBot;
  }

  async submitSetupPlacement(action: SetupPlacementAction): Promise<GameState> {
    if (action.playerIndex !== this.localPlayerIndex) throw new GameRuleError('can only submit your own setup');
    this.applySetup(action);
    return this.state;
  }

  async submitTurnCommit(plan: TurnActionPlan): Promise<TurnOutcome> {
    if (!this.isLocalTurn()) throw new GameRuleError('not your turn');
    return this.resolve(plan);
  }

  /** Plays exactly one bot turn (so the UI can replay it before the next). Null if it isn't a bot's turn. */
  async playBotTurn(): Promise<TurnOutcome | null> {
    if (!this.isBotTurn()) return null;
    return this.resolve(generateBotTurnPlan(this.map, this.state));
  }

  onTurnResolved(callback: (outcome: TurnOutcome) => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  exportEventLog(): string {
    return canonicalStringify(this.events);
  }

  save(): LocalGameSave {
    return { log: this.exportEventLog(), chains: this.cursors.map(c => c.save()), localPlayerIndex: this.localPlayerIndex };
  }

  private append<P extends GamePayload>(author: string, payload: P): GameEvent<P> {
    const event = makeEvent(author, this.events.length, payload);
    this.events.push(event);
    return event;
  }

  private applySetup(action: SetupPlacementAction): void {
    const next = applySetupPlacement(this.state, action);
    this.append(this.state.players[action.playerIndex].id, { kind: 'SETUP_PLACEMENT', gameId: this.state.gameId, action });
    this.state = next;
  }

  private resolve(plan: TurnActionPlan): TurnOutcome {
    const errors = validateTurnPlan(this.map, this.state, plan);
    if (errors.length) throw new GameRuleError(errors.join('; '));
    const { state } = this;
    const commit = this.append(state.players[plan.playerIndex].id, {
      kind: 'TURN_COMMIT', gameId: state.gameId, turnNumber: state.turnNumber, stateHash: computeStateHash(state), actionPlan: plan,
    } satisfies TurnCommitPayload);

    const witness = witnessFor(state);
    const before = this.cursors[witness].save();
    const secret = this.cursors[witness].next();
    let resolution;
    try {
      resolution = applyTurn(this.map, state, { plan, commitEventId: commit.id, revealedSecret: secret });
    } catch (err) {
      // Never leave a half-recorded turn or a burned secret behind.
      this.events.pop();
      this.cursors[witness] = HashChainCursor.restore(before);
      throw err;
    }
    const reveal = this.append(state.players[witness].id, {
      kind: 'TURN_REVEAL', gameId: state.gameId, turnNumber: state.turnNumber, witnessIndex: witness,
      commitEventId: commit.id, revealedSecret: secret, expectedNewStateHash: resolution.newStateHash,
    } satisfies TurnRevealPayload);
    this.state = resolution.newState;

    const outcome: TurnOutcome = { commit, reveal, resolution };
    for (const cb of this.listeners) cb(outcome);
    return outcome;
  }
}

/**
 * Rebuilds a game from its text log alone and verifies everything: event ids and order, authorship,
 * map version, every setup, every commit's base state hash, every witness reveal and resulting state hash.
 */
export function replayEventLog(json: string, onTurn?: (result: TurnResolutionResult, before: GameState) => void): { map: GameMap; state: GameState; events: GameEvent[] } {
  const events = JSON.parse(json) as GameEvent[];
  const fail = (seq: number, msg: string): never => { throw new GameRuleError(`event ${seq}: ${msg}`); };
  events.forEach((e, i) => {
    if (e.seq !== i) fail(i, 'out of order');
    if (e.id !== sha256Hex(canonicalStringify({ author: e.author, seq: e.seq, payload: e.payload }))) fail(i, 'id does not match content');
  });

  const first = events[0]?.payload;
  if (!first || first.kind !== 'GAME_CREATE') return fail(0, 'log must start with GAME_CREATE');
  if (first.mapGeneratorVersion !== MAP_GENERATOR_VERSION) fail(0, `map generator v${first.mapGeneratorVersion} is not supported by this client`);
  const map = generateMap({ seed: first.mapSeed, playerCount: first.players.length });
  let state = createGame({ gameId: first.gameId, map, players: first.players, setupSeed: first.setupSeed });

  for (let i = 1; i < events.length; i++) {
    const e = events[i];
    const p = e.payload;
    if (p.kind === 'SETUP_PLACEMENT') {
      if (e.author !== state.players[p.action.playerIndex]?.id) fail(i, 'setup signed by the wrong player');
      state = applySetupPlacement(state, p.action);
    } else if (p.kind === 'TURN_COMMIT') {
      if (e.author !== state.players[p.actionPlan.playerIndex]?.id) fail(i, 'commit signed by the wrong player');
      if (p.turnNumber !== state.turnNumber) fail(i, 'commit for the wrong turn');
      if (p.stateHash !== computeStateHash(state)) fail(i, 'commit was made against a different state');
      const r = events[i + 1];
      if (!r || r.payload.kind !== 'TURN_REVEAL') return fail(i, 'commit without a reveal');
      const witness = witnessFor(state);
      if (r.payload.commitEventId !== e.id) fail(i + 1, 'reveal references a different commit');
      if (r.payload.witnessIndex !== witness || r.author !== state.players[witness].id) fail(i + 1, 'reveal from the wrong witness');
      const result = applyTurn(map, state, { plan: p.actionPlan, commitEventId: e.id, revealedSecret: r.payload.revealedSecret });
      if (result.newStateHash !== r.payload.expectedNewStateHash) fail(i + 1, 'state hash mismatch');
      onTurn?.(result, state);
      state = result.newState;
      i++;
    } else {
      fail(i, `unexpected ${p.kind}`);
    }
  }
  return { map, state, events };
}
