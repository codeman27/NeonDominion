import { generateBotSetupPlacement, generateBotTurnPlan } from '../ai/dumbBot';
import { HashChainCursor, generateRootSecret } from '../crypto/hashChain';
import { sha256Hex } from '../crypto/prng';
import { canonicalStringify, computeStateHash } from '../crypto/stateHash';
import { GameRuleError } from '../engine/errors';
import { MAP_GENERATOR_VERSION, generateMap } from '../engine/mapGenerator';
import { applySetupPlacement, createGame } from '../engine/setup';
import { applyTurn, validateTurnPlan, witnessFor, tradeCards, computeReinforcements } from '../engine/turnEngine';
import { DeterministicRng } from '../crypto/prng';
import { resolveAttack } from '../engine/combatResolver';
import { applyFortify } from '../engine/fortify';
import { TERRITORY_MATCH_BONUS } from '../engine/rules';
import { advanceCommitment } from '../crypto/hashChain';
import type { InteractiveTurnState, FortifyOrder, FortifyResolution, SetupPlacementAction, TurnActionPlan, TurnResolutionResult, AttackCampaignOrder, InteractiveAttackResult, DraftPlacementOrder } from '../types/actions';
import type { GameMap, GameState, PlayerIndex, TerritoryId } from '../types/game';
import type { GameCreatePayload, GameEvent, GamePayload, InteractiveTurnStep, TurnCommitPayload, TurnRevealPayload } from '../types/protocol';
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
/** Tracks the in-progress interactive turn. */

export class LocalGame implements GameTransport {
  readonly mode = 'LOCAL' as const;
  private events: GameEvent[] = [];
  private listeners = new Set<(o: TurnOutcome) => void>();
  private interactiveTurn: {
    before: GameState;
    commit: GameEvent<TurnCommitPayload>;
    secret: string;
    witness: PlayerIndex;
    steps: InteractiveTurnStep[];
  } | null = null;

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

  // ------------------------------------------------------------------ Interactive turn helpers
  /**
   * Commit the starting plan and consume the witness secret. The reveal is recorded at
   * completion, together with the interactive decisions and the final state hash.
   */
  startInteractiveTurn(plan: TurnActionPlan): InteractiveTurnState {
    const state = this.state;
    if (!this.isLocalTurn() && !this.isBotTurn()) throw new GameRuleError('not a turn to start');
    if (this.interactiveTurn) throw new GameRuleError('interactive turn already started');

    const errors = validateTurnPlan(this.map, state, plan);
    if (errors.length) throw new GameRuleError(errors.join('; '));

    const commit = this.append(state.players[plan.playerIndex].id, {
      kind: 'TURN_COMMIT', gameId: state.gameId, turnNumber: state.turnNumber, stateHash: computeStateHash(state), actionPlan: plan,
    } satisfies TurnCommitPayload);

    const witness = witnessFor(state);
    const secret = this.cursors[witness].next();

    return this.beginInteractiveTurn(plan, commit, secret);
  }

  private beginInteractiveTurn(plan: TurnActionPlan, commit: GameEvent<TurnCommitPayload>, secret: string): InteractiveTurnState {
    const state = this.state;
    const errors = validateTurnPlan(this.map, state, plan);
    if (errors.length) throw new GameRuleError(errors.join('; '));
    const witness = witnessFor(state);
    this.interactiveTurn = { before: state, commit, secret, witness, steps: [] };

    // Derive turn seed from commit event ID + revealed secret
    const turnSeed = sha256Hex(commit.id + secret);

    // Apply the starting plan before accepting interactive decisions.
    let s = structuredClone(state);
    s.players[witness].currentHashCommitment = advanceCommitment(state.players[witness].currentHashCommitment, secret);
    s.players[witness].hashChainIndex++;

    // 1. Card trades (+2 match troops are placed automatically on the matched territory).
    const { trades } = tradeCards(state, plan);
    const reinforcements = computeReinforcements(this.map, state, plan.playerIndex, trades);
    const tradedIds = new Set(trades.flat().map(c => c.id));
    s.discardPile.push(...s.players[plan.playerIndex].cards.filter(c => tradedIds.has(c.id)));
    s.players[plan.playerIndex].cards = s.players[plan.playerIndex].cards.filter(c => !tradedIds.has(c.id));
    for (const tid of reinforcements.matchTerritories) s.territories[tid].troops += TERRITORY_MATCH_BONUS;

    // 2. Draft.
    const draftApplied: DraftPlacementOrder[] = [];
    for (const d of plan.draftPlacements) {
      if (d.troops === 0) continue;
      s.territories[d.territoryId].troops += d.troops;
      draftApplied.push({ territoryId: d.territoryId, troops: d.troops });
    }

    // 3. Fortify (applied before interactive attacks so the map is in the final defensive position).
    let fortify: FortifyResolution | null = null;
    if (plan.fortify) {
      const r = applyFortify(this.map, s, plan.playerIndex, plan.fortify);
      s = r.state;
      fortify = r.resolution;
    }

    const cloneState = structuredClone(s);

    this.state = s;

    return {
      playerIndex: plan.playerIndex,
      turnNumber: state.turnNumber,
      turnSeed,
      remainingAttacks: [...plan.attackQueue],
      draftApplied,
      reinforcements: { base: reinforcements.base, continentBonus: reinforcements.continentBonus, cardTradeBonus: reinforcements.cardTradeBonus, territoryMatchBonusTerritories: reinforcements.territoryMatchBonusTerritories, total: reinforcements.total },
      cardDrawn: false,
      conqueredAny: false,
      attackLogs: [],
      eliminatedPlayers: [],
      fortify,
      liveState: cloneState,
      lastResult: null,
    };
  }

  /** Execute one attack during the interactive turn. The attack is resolved against the live state. */
  executeInteractiveAttack(state: InteractiveTurnState, order: AttackCampaignOrder): { result: InteractiveAttackResult; state: InteractiveTurnState } {
    if (!this.interactiveTurn) throw new GameRuleError('no interactive turn started');
    const workState: GameState = JSON.parse(canonicalStringify(state.liveState));

    const attackIndex = state.attackLogs.length;
    const rng = new DeterministicRng(sha256Hex(`${state.turnSeed}/dice/${attackIndex}`));

    const log = resolveAttack(this.map, workState, state.playerIndex, order, () => rng.rollD6());
    this.interactiveTurn.steps.push({ kind: 'ATTACK', order: structuredClone(order) });

    // Remove the executed order from remaining attacks
    const remainingAttacks = state.remainingAttacks.slice(1);

    const nextState: InteractiveTurnState = {
      ...state,
      liveState: workState,
      remainingAttacks,
      conqueredAny: state.conqueredAny || log.conquered,
      attackLogs: [...state.attackLogs, log],
      eliminatedPlayers: log.eliminatedPlayerIndex === undefined ? state.eliminatedPlayers : [...state.eliminatedPlayers, log.eliminatedPlayerIndex],
    };

    return {
      result: {
        attack: log,
        owners: workState.territories.map(t => t.owner),
        troops: workState.territories.map(t => t.troops),
        moreAttacks: remainingAttacks.length > 0,
        turnComplete: false,
      },
      state: nextState,
    };
  }

  /** Move troops from one territory to a conquered adjacent territory (post-attack move step). */
  moveTroopsToConquered(state: InteractiveTurnState, from: TerritoryId, to: TerritoryId, count: number): { state: InteractiveTurnState } {
    if (!this.interactiveTurn) throw new GameRuleError('no interactive turn started');
    const workState: GameState = JSON.parse(canonicalStringify(state.liveState));

    const src = workState.territories[from];
    const dst = workState.territories[to];
    if (!src || !dst) throw new GameRuleError('invalid territories');
    if (src.owner !== state.playerIndex) throw new GameRuleError('source not owned');
    const attack = state.attackLogs[state.attackLogs.length - 1];
    if (!attack?.conquered || attack.fromTerritoryId !== from || attack.toTerritoryId !== to || dst.owner !== state.playerIndex || dst.troops !== 0) {
      throw new GameRuleError('no pending conquest move');
    }
    const minMove = attack.waves[attack.waves.length - 1].attackerDice.length;
    if (!Number.isInteger(count) || count < minMove) throw new GameRuleError(`must move at least ${minMove} troops`);
    if (src.troops - 1 < count) throw new GameRuleError('not enough troops');

    src.troops -= count;
    dst.troops += count;
    this.interactiveTurn.steps.push({ kind: 'MOVE', from, to, troops: count });

    return {
      state: {
        ...state,
        liveState: workState,
      },
    };
  }

  /** Apply the fortify step of the interactive turn. */
  executeInteractiveFortify(state: InteractiveTurnState, order: FortifyOrder): { state: InteractiveTurnState } {
    if (!this.interactiveTurn) throw new GameRuleError('no interactive turn started');
    const workState: GameState = JSON.parse(canonicalStringify(state.liveState));

    const { state: resolvedState, resolution } = applyFortify(this.map, workState, state.playerIndex, order);
    this.interactiveTurn.steps.push({ kind: 'FORTIFY', order: structuredClone(order) });

    return {
      state: {
        ...state,
        liveState: resolvedState,
        fortify: { ...resolution, order },
      },
    };
  }

  private completeInteractiveTurn(state: InteractiveTurnState): TurnResolutionResult {
    if (!this.interactiveTurn) throw new GameRuleError('no interactive turn started');
    // Apply the interactive turn state to the real game state
    this.state = state.liveState;

    // Same card-draw rule as applyTurn: one real deck card for conquering at least one territory.
    let cardDrawn = state.cardDrawn;
    const won = this.state.territories.every(t => t.owner === state.playerIndex);
    if (!cardDrawn && state.conqueredAny && !won) {
      if (this.state.deck.length === 0 && this.state.discardPile.length > 0) {
        this.state.deck = new DeterministicRng(state.turnSeed).fork('reshuffle').shuffle(this.state.discardPile.sort((a, b) => a.id - b.id));
        this.state.discardPile = [];
      }
      const card = this.state.deck.pop();
      if (card) { this.state.players[state.playerIndex].cards.push(card); cardDrawn = true; }
    }

    // Check for win condition
    if (won) {
      this.state.winnerIndex = state.playerIndex;
      this.state.phase = 'GAME_OVER';
    } else {
      const n = this.state.players.length;
      for (let step = 1; step <= n; step++) {
        const i = (state.playerIndex + step) % n;
        if (!this.state.players[i].eliminated) {
          this.state.activePlayerIndex = i;
          break;
        }
      }
      this.state.turnNumber = state.turnNumber + 1;
      this.state.phase = 'ACTIVE_TURN_COMMIT';
    }

    this.state.lastCommitEventId = this.interactiveTurn.commit.id;
    this.state.lastRevealEventId = null;
    this.state.prevStateHash = computeStateHash(this.interactiveTurn.before);

    return {
      turnNumber: state.turnNumber,
      playerIndex: state.playerIndex,
      turnSeed: state.turnSeed,
      newState: this.state,
      newStateHash: computeStateHash(this.state),
      reinforcements: state.reinforcements,
      eliminatedPlayers: state.eliminatedPlayers,
      cardDrawn,
      attackLogs: state.attackLogs,
      fortify: state.fortify,
      draftApplied: state.draftApplied,
    };
  }

  /** Finish once, recording the complete turn so replay, saves and statistics agree. */
  finishInteractiveTurn(state: InteractiveTurnState): TurnOutcome {
    const resolution = this.completeInteractiveTurn(state);
    const { commit, secret, witness, steps } = this.interactiveTurn!;
    const reveal = this.append(this.state.players[witness].id, {
      kind: 'TURN_REVEAL', gameId: this.state.gameId, turnNumber: state.turnNumber,
      witnessIndex: witness, commitEventId: commit.id, revealedSecret: secret,
      expectedNewStateHash: resolution.newStateHash, interactiveSteps: steps,
    });
    this.interactiveTurn = null;
    const outcome = { commit, reveal, resolution };
    for (const cb of this.listeners) cb(outcome);
    return outcome;
  }

  /** Re-execute local interactive decisions using the same rules as live play. */
  static replayInteractiveTurn(map: GameMap, state: GameState, commit: GameEvent<TurnCommitPayload>, reveal: TurnRevealPayload): TurnResolutionResult {
    const game = new LocalGame(map, state, [], commit.payload.actionPlan.playerIndex);
    let turn = game.beginInteractiveTurn(commit.payload.actionPlan, commit, reveal.revealedSecret);
    for (const step of reveal.interactiveSteps ?? []) {
      if (step.kind === 'ATTACK') turn = game.executeInteractiveAttack(turn, step.order).state;
      else if (step.kind === 'MOVE') turn = game.moveTroopsToConquered(turn, step.from, step.to, step.troops).state;
      else if (step.kind === 'FORTIFY') turn = game.executeInteractiveFortify(turn, step.order).state;
      else throw new GameRuleError('unknown interactive step');
    }
    return game.completeInteractiveTurn(turn);
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
      const result = r.payload.interactiveSteps !== undefined
        ? LocalGame.replayInteractiveTurn(map, state, { ...e, payload: p }, r.payload)
        : applyTurn(map, state, { plan: p.actionPlan, commitEventId: e.id, revealedSecret: r.payload.revealedSecret });
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
