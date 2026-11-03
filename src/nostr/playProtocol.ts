import { isHex32, verifyReveal } from '../crypto/hashChain';
import { canonicalStringify } from '../crypto/stateHash';
import { DeterministicRng, sha256Hex } from '../crypto/prng';
import { applyFortify } from '../engine/fortify';
import { resolveAttack } from '../engine/combatResolver';
import { computeReinforcements, deriveTurnSeed, nextAlivePlayer, tradeCards, witnessFor } from '../engine/turnEngine';
import { mustTrade, TERRITORY_MATCH_BONUS } from '../engine/rules';
import type { AttackResolutionLog, CardTradeOrder, DraftPlacementOrder, FortifyOrder, TurnActionPlan } from '../types/actions';
import type { GameMap, GameState } from '../types/game';
import type { LobbyRecord, LobbyState } from './lobbyProtocol';
import type { MultiplayerSetup } from './setupProtocol';
import { BEACON_CHAIN, beaconRandomness, futureBeaconRound } from './beacon';

export const PLAY_CHAIN_LENGTH = 8192;
export interface PlayReady { v: 1; type: 'play-ready'; start: string; setupHash: string; head: string; length: number }
export type PlayDecision =
  | { kind: 'draft' | 'trade'; trades: CardTradeOrder[]; placements: DraftPlacementOrder[] }
  | { kind: 'attack'; from: number; to: number; dice: number; stop: number }
  | { kind: 'move'; troops: number }
  | { kind: 'beacon' }
  | { kind: 'nostr-dice' }
  | { kind: 'end'; fortify: FortifyOrder | null };
export interface PlayAction { v: 1; type: 'play-action'; start: string; index: number; prev: string; stateHash: string; decision: PlayDecision; beaconRound?: number; diceNonce?: string }
export interface PlayDiceStart { v: 1; type: 'play-dice-start'; start: string; setupHash: string }
export interface PlayReveal { v: 1; type: 'play-reveal'; start: string; index: number; commit: string; secret: string; chainIndex: number }
export interface PlayBeaconStart { v: 1; type: 'play-beacon-start'; start: string; setupHash: string; chain: typeof BEACON_CHAIN }
export interface PlayBeacon { v: 1; type: 'play-beacon'; start: string; index: number; commit: string; round: number; signature: string }
export interface PlayBeaconLock { v: 1; type: 'play-beacon-lock'; start: string; index: number; commit: string; round: number }
export type PlayPayload = PlayReady | PlayAction | PlayReveal | PlayBeaconStart | PlayBeacon | PlayBeaconLock | PlayDiceStart;
export interface PlayStats { captures: number; kills: number; losses: number; peak: number; out: number | null }
export interface PlaySnapshot {
  state: GameState;
  phase: 'draft' | 'attack' | 'move' | 'over';
  move: { from: number; to: number; min: number } | null;
  conquered: boolean;
  round: number;
  stats: PlayStats[];
  randomness?: 'drand-quicknet-v1' | 'nostr-dice-v1';
}
export interface MultiplayerPlay {
  ready: Map<string, LobbyRecord>;
  snapshot: PlaySnapshot | null;
  index: number;
  prev: string;
  hash: string;
  pending: LobbyRecord | null;
  beaconLock: LobbyRecord | null;
  lastBattle: AttackResolutionLog | null;
  battles: AttackResolutionLog[];
  conflict: string | null;
  applied: string[];
}
export function isPlayPayload(p: { type: string }): p is PlayPayload {
  return ['play-ready', 'play-action', 'play-reveal', 'play-beacon-start', 'play-beacon', 'play-beacon-lock', 'play-dice-start'].includes(p.type);
}
function object(v: unknown): v is Record<string, unknown> { return typeof v === 'object' && v !== null && !Array.isArray(v); }
function int(v: unknown, min = 0, max = 1000000): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
}
function hex(v: unknown): v is string { return typeof v === 'string' && isHex32(v); }
export function parseDecision(v: unknown): PlayDecision {
  if (!object(v)) throw new Error('Malformed game decision.');
  if (v.kind === 'beacon') return { kind: 'beacon' };
  if (v.kind === 'nostr-dice') return { kind: 'nostr-dice' };
  if ((v.kind === 'draft' || v.kind === 'trade') && Array.isArray(v.trades) && v.trades.length <= 16
    && Array.isArray(v.placements) && v.placements.length <= 48) {
    const trades = v.trades.map(t => {
      if (!object(t) || !Array.isArray(t.cardIds) || t.cardIds.length !== 3 || !t.cardIds.every(id => int(id, 0, 100))) throw new Error('Invalid card trade.');
      const cardIds: [number, number, number] = [t.cardIds[0], t.cardIds[1], t.cardIds[2]];
      return { cardIds };
    });
    const placements = v.placements.map(p => {
      if (!object(p) || !int(p.territoryId, 0, 47) || !int(p.troops)) throw new Error('Invalid draft placement.');
      return { territoryId: p.territoryId, troops: p.troops };
    });
    if (new Set(placements.map(p => p.territoryId)).size !== placements.length) throw new Error('Duplicate draft territory.');
    return { kind: v.kind, trades, placements };
  }
  if (v.kind === 'attack' && int(v.from, 0, 47) && int(v.to, 0, 47) && int(v.dice, 1, 3) && int(v.stop)) {
    return { kind: 'attack', from: v.from, to: v.to, dice: v.dice, stop: v.stop };
  }
  if (v.kind === 'move' && int(v.troops, 1)) return { kind: 'move', troops: v.troops };
  if (v.kind === 'end') {
    if (v.fortify === null) return { kind: 'end', fortify: null };
    const f = v.fortify;
    if (object(f) && int(f.fromTerritoryId, 0, 47) && int(f.toTerritoryId, 0, 47) && int(f.troops, 1)) {
      return { kind: 'end', fortify: { fromTerritoryId: f.fromTerritoryId, toTerritoryId: f.toTerritoryId, troops: f.troops } };
    }
  }
  throw new Error('Invalid game decision.');
}
export function parsePlayPayload(p: Record<string, unknown>): PlayPayload | null {
  if (!isPlayPayload({ type: String(p.type) })) return null;
  if (p.v !== 1 || !hex(p.start)) throw new Error('Invalid game start.');
  if (p.type === 'play-dice-start' && hex(p.setupHash)) return { v: 1, type: p.type, start: p.start, setupHash: p.setupHash };
  if (p.type === 'play-beacon-start' && hex(p.setupHash) && p.chain === BEACON_CHAIN) {
    return { v: 1, type: p.type, start: p.start, setupHash: p.setupHash, chain: BEACON_CHAIN };
  }
  if (p.type === 'play-beacon-lock' && int(p.index, 1) && hex(p.commit) && int(p.round, 1, Number.MAX_SAFE_INTEGER)) {
    return { v: 1, type: p.type, start: p.start, index: p.index, commit: p.commit, round: p.round };
  }
  if (p.type === 'play-beacon' && int(p.index, 1) && hex(p.commit) && int(p.round, 1, Number.MAX_SAFE_INTEGER)
    && typeof p.signature === 'string') {
    beaconRandomness({ round: p.round, signature: p.signature });
    return { v: 1, type: p.type, start: p.start, index: p.index, commit: p.commit, round: p.round, signature: p.signature };
  }
  if (p.type === 'play-ready' && hex(p.setupHash) && hex(p.head) && p.length === PLAY_CHAIN_LENGTH) {
    return { v: 1, type: p.type, start: p.start, setupHash: p.setupHash, head: p.head, length: PLAY_CHAIN_LENGTH };
  }
  if (p.type === 'play-action' && int(p.index, 1) && hex(p.prev) && hex(p.stateHash)) {
    const decision = parseDecision(p.decision);
    if (p.beaconRound !== undefined && (!int(p.beaconRound, 1, Number.MAX_SAFE_INTEGER) || decision.kind !== 'attack')) throw new Error('Invalid locked beacon round.');
    if (p.diceNonce !== undefined && (!hex(p.diceNonce) || decision.kind !== 'attack' || p.beaconRound !== undefined)) throw new Error('Invalid attack dice nonce.');
    return { v: 1, type: p.type, start: p.start, index: p.index, prev: p.prev, stateHash: p.stateHash, decision,
      ...(p.beaconRound === undefined ? {} : { beaconRound: p.beaconRound }),
      ...(p.diceNonce === undefined ? {} : { diceNonce: p.diceNonce }) };
  }
  if (p.type === 'play-reveal' && int(p.index, 1) && hex(p.commit) && hex(p.secret) && int(p.chainIndex, 1, PLAY_CHAIN_LENGTH)) {
    return { v: 1, type: p.type, start: p.start, index: p.index, commit: p.commit, secret: p.secret, chainIndex: p.chainIndex };
  }
  throw new Error('Invalid signed gameplay payload.');
}
export function playHash(snapshot: PlaySnapshot): string { return sha256Hex(canonicalStringify(snapshot)); }

function assert(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
export function validateDecision(map: GameMap, snapshot: PlaySnapshot, decision: PlayDecision): void {
  const { state, phase } = snapshot;
  const seat = state.activePlayerIndex;
  const hand = state.players[seat].cards;
  assert(phase !== 'over', 'The game is over.');
  if (decision.kind === 'beacon') {
    assert(!snapshot.randomness, 'Beacon mode is already enabled.');
    return;
  }
  if (decision.kind === 'nostr-dice') {
    assert(snapshot.randomness !== 'nostr-dice-v1', 'Nostr dice mode is already enabled.');
    return;
  }
  if (decision.kind === 'draft' || decision.kind === 'trade') {
    assert(decision.kind === 'draft' ? phase === 'draft' : phase === 'attack' && mustTrade(hand.length), 'Not accepting this draft/trade.');
    const plan: TurnActionPlan = {
      type: 'TURN_ACTION_PLAN', playerIndex: seat, turnNumber: state.turnNumber, cardTrades: decision.trades,
      draftPlacements: decision.placements, attackQueue: [], fortify: null,
    };
    const { trades, errors } = tradeCards(state, plan);
    assert(!errors.length, errors.join('; '));
    assert(decision.kind !== 'trade' || trades.length > 0, 'A mandatory card trade is required.');
    const reinforcement = computeReinforcements(map, state, seat, trades);
    const total = decision.kind === 'draft' ? reinforcement.total : reinforcement.cardTradeBonus;
    assert(decision.placements.every(p => state.territories[p.territoryId]?.owner === seat), 'Cannot draft on an enemy territory.');
    assert(decision.placements.reduce((sum, p) => sum + p.troops, 0) === total, `Place exactly ${total} reinforcements.`);
    return;
  }
  if (decision.kind === 'move') {
    const m = snapshot.move;
    assert(phase === 'move' && m, 'No pending conquest movement.');
    assert(decision.troops >= m.min && decision.troops < state.territories[m.from].troops, `Move at least ${m.min}, leaving one behind.`);
    return;
  }
  assert(phase === 'attack', 'Finish drafting or conquest movement first.');
  assert(!mustTrade(hand.length), 'Trade captured cards before attacking or ending the turn.');
  if (decision.kind === 'attack') {
    const src = state.territories[decision.from], dst = state.territories[decision.to];
    assert(src?.owner === seat && dst && dst.owner !== seat, 'Choose your source and an enemy target.');
    assert(map.territories[decision.from].neighbors.includes(decision.to), 'Attack target is not adjacent.');
    assert(src.troops > Math.max(1, decision.stop), 'Not enough attacking armies above Stop At.');
    if (!snapshot.randomness) {
      const witness = state.players[witnessFor(state)];
      assert(witness.hashChainIndex < PLAY_CHAIN_LENGTH, 'Witness chain exhausted. Switch to asynchronous beacon mode.');
    }
    return;
  }
  if (decision.kind === 'end' && decision.fortify) {
    assert(decision.fortify.troops < (state.territories[decision.fortify.fromTerritoryId]?.troops ?? 0), 'Fortification must leave one army.');
    const result = applyFortify(map, state, seat, decision.fortify);
    assert(result.resolution.executed && result.resolution.troopsMoved === decision.fortify.troops, 'Invalid connected fortification.');
  }
}

function finishVictory(snapshot: PlaySnapshot): void {
  const seat = snapshot.state.activePlayerIndex;
  if (snapshot.state.territories.every(t => t.owner === seat)) {
    snapshot.state.phase = 'GAME_OVER'; snapshot.state.winnerIndex = seat; snapshot.phase = 'over';
  }
}
export function applyDecision(map: GameMap, before: PlaySnapshot, decision: PlayDecision, eventId: string): PlaySnapshot {
  validateDecision(map, before, decision);
  const next = structuredClone(before);
  let state = next.state;
  const seat = state.activePlayerIndex;
  if (decision.kind === 'beacon') next.randomness = 'drand-quicknet-v1';
  else if (decision.kind === 'nostr-dice') next.randomness = 'nostr-dice-v1';
  else if (decision.kind === 'draft' || decision.kind === 'trade') {
    const plan: TurnActionPlan = {
      type: 'TURN_ACTION_PLAN', playerIndex: seat, turnNumber: state.turnNumber, cardTrades: decision.trades,
      draftPlacements: decision.placements, attackQueue: [], fortify: null,
    };
    const { trades } = tradeCards(state, plan);
    const reinforcement = computeReinforcements(map, state, seat, trades);
    const used = new Set(trades.flatMap(t => t.map(c => c.id)));
    state.discardPile.push(...state.players[seat].cards.filter(c => used.has(c.id)));
    state.players[seat].cards = state.players[seat].cards.filter(c => !used.has(c.id));
    for (const id of reinforcement.matchTerritories) state.territories[id].troops += TERRITORY_MATCH_BONUS;
    for (const p of decision.placements) state.territories[p.territoryId].troops += p.troops;
    next.phase = 'attack';
  } else if (decision.kind === 'move' && next.move) {
    state.territories[next.move.from].troops -= decision.troops;
    state.territories[next.move.to].troops += decision.troops;
    next.move = null; next.phase = 'attack'; finishVictory(next);
  } else if (decision.kind === 'end') {
    if (decision.fortify) { state = applyFortify(map, state, seat, decision.fortify).state; next.state = state; }
    if (next.conquered) {
      if (!state.deck.length && state.discardPile.length) {
        state.deck = new DeterministicRng(sha256Hex(`neon-dominion-deck-v1:${eventId}`)).shuffle([...state.discardPile].sort((a, b) => a.id - b.id));
        state.discardPile = [];
      }
      const card = state.deck.pop();
      if (card) state.players[seat].cards.push(card);
    }
    state.activePlayerIndex = nextAlivePlayer(state, seat);
    if (state.activePlayerIndex <= seat) next.round++;
    state.turnNumber++; next.phase = 'draft'; next.conquered = false;
  }
  state.lastCommitEventId = eventId;
  return next;
}

export function derivePlay(lobby: LobbyState, setup: MultiplayerSetup, records: readonly LobbyRecord[]): MultiplayerPlay {
  const result: MultiplayerPlay = {
    ready: new Map(), snapshot: null, index: 1, prev: '', hash: '', pending: null, beaconLock: null,
    lastBattle: null, battles: [], conflict: lobby.conflict ?? setup.conflict, applied: [],
  };
  if (result.conflict || !setup.state || !setup.map || !setup.state.players.every(p => p.setupDone) || !lobby.start) return result;
  const start = lobby.start.event.id;
  const members = new Set(lobby.members.map(m => m.pubkey));
  const relevant = [...new Map(records.filter(r => isPlayPayload(r.payload) && r.payload.start === start && members.has(r.event.pubkey)).map(r => [r.event.id, r])).values()];
  const indexed = new Map<string, LobbyRecord[]>();
  for (const r of relevant) {
    if (r.payload.type === 'play-action' || r.payload.type === 'play-reveal') {
      const key = `${r.payload.type}:${r.payload.index}:${r.event.pubkey}`;
      const group = indexed.get(key) ?? [];
      group.push(r); indexed.set(key, group);
    }
  }
  try {
    const setupHash = sha256Hex(canonicalStringify(setup.state));
    const beaconStarts = relevant.filter(r => r.payload.type === 'play-beacon-start' && r.event.pubkey === setup.state!.players[0].id);
    assert(beaconStarts.length <= 1, 'Host signed conflicting beacon genesis events.');
    const beaconStart = beaconStarts[0];
    const diceStarts = relevant.filter(r => r.payload.type === 'play-dice-start' && r.event.pubkey === setup.state!.players[0].id);
    assert(diceStarts.length <= 1 && !(diceStarts.length && beaconStart), 'Host signed conflicting dice genesis events.');
    const diceStart = diceStarts[0];
    if (diceStart) assert(diceStart.payload.type === 'play-dice-start' && diceStart.payload.setupHash === setupHash, 'Dice genesis has a different deployed state.');
    if (beaconStart) assert(beaconStart.payload.type === 'play-beacon-start' && beaconStart.payload.setupHash === setupHash, 'Beacon genesis has a different deployed state.');
    for (const member of lobby.members) {
      const candidates = relevant.filter(r => r.event.pubkey === member.pubkey && r.payload.type === 'play-ready');
      assert(candidates.length <= 1, `${member.name} signed conflicting witness commitments.`);
      if (candidates.length) {
        const record = candidates[0];
        assert(record.payload.type === 'play-ready' && record.payload.setupHash === setupHash, `${member.name} committed to a different deployed state.`);
        result.ready.set(member.pubkey, record);
      }
    }
    if (!beaconStart && !diceStart && result.ready.size !== lobby.members.length) return result;
    const state = structuredClone(setup.state);
    for (let i = 0; !beaconStart && !diceStart && i < state.players.length; i++) {
      const p = result.ready.get(state.players[i].id)!.payload;
      assert(p.type === 'play-ready', 'Invalid witness commitment.');
      state.players[i].currentHashCommitment = p.head;
      state.players[i].hashChainIndex = 0;
    }
    result.snapshot = {
      state, phase: 'draft', move: null, conquered: false, round: 1,
      stats: state.players.map((_, i) => ({ captures: 0, kills: 0, losses: 0, peak: state.territories.filter(t => t.owner === i).length, out: null })),
      ...(diceStart ? { randomness: 'nostr-dice-v1' as const } : beaconStart ? { randomness: 'drand-quicknet-v1' as const } : {}),
    };
    result.prev = diceStart?.event.id ?? beaconStart?.event.id ?? sha256Hex(canonicalStringify({ domain: 'neon-dominion-play-v1', start, setupHash, ready: lobby.members.map(m => result.ready.get(m.pubkey)!.event.id) }));
    for (let count = 0; count <= relevant.length; count++) {
      const snapshot: PlaySnapshot = result.snapshot;
      result.hash = playHash(snapshot);
      if (snapshot.phase === 'over') break;
      const seat = snapshot.state.activePlayerIndex;
      const candidates = indexed.get(`play-action:${result.index}:${snapshot.state.players[seat].id}`) ?? [];
      assert(candidates.length <= 1, `Commander signed conflicting actions at index ${result.index}. Game halted; export signed history.`);
      if (!candidates.length) break;
      const record = candidates[0], action = record.payload;
      assert(action.type === 'play-action', 'Invalid action.');
      assert(action.prev === result.prev && action.stateHash === result.hash, `Action ${result.index} has a different predecessor or state hash.`);
      validateDecision(setup.map, snapshot, action.decision);
      assert(action.diceNonce === undefined || snapshot.randomness === 'nostr-dice-v1', 'Nonce dice require an explicit mode upgrade.');
      if (action.decision.kind !== 'attack') {
        assert(action.beaconRound === undefined, 'Only attacks can bind beacon rounds.');
        result.snapshot = applyDecision(setup.map, snapshot, action.decision, record.event.id);
        result.prev = record.event.id; result.index++; result.applied.push(record.event.id);
        continue;
      }
      const next: PlaySnapshot = structuredClone(snapshot);
      let secret: string, resolutionId: string;
      const locks = relevant.filter(r => r.payload.type === 'play-beacon-lock' && r.payload.commit === record.event.id && r.event.pubkey === record.event.pubkey);
      assert(locks.length <= 1, 'Commander signed conflicting migration locks.');
      const lock = locks[0];
      if (lock) {
        assert(!snapshot.randomness && action.beaconRound === undefined && lock.payload.type === 'play-beacon-lock'
          && lock.payload.index === result.index && lock.payload.round === futureBeaconRound(lock.event.created_at), 'Invalid pending-attack beacon migration.');
        assert(!(indexed.get(`play-reveal:${result.index}:${snapshot.state.players[witnessFor(snapshot.state)].id}`)?.length), 'Legacy witness and beacon migration both resolved this attack. Game halted; retain signed history.');
        next.randomness = 'drand-quicknet-v1';
      }
      if (snapshot.randomness === 'nostr-dice-v1') {
        assert(isHex32(action.diceNonce ?? '') && action.beaconRound === undefined && !lock, 'Nostr attacks require a fresh signed dice nonce, not a beacon.');
        secret = sha256Hex(`neon-dominion-nostr-dice-v1:${record.event.id}:${action.diceNonce}`);
        resolutionId = record.event.id;
      } else if (snapshot.randomness || lock) {
        const round = lock?.payload.type === 'play-beacon-lock' ? lock.payload.round : action.beaconRound;
        if (!lock) assert(round === futureBeaconRound(record.event.created_at), 'Attack did not lock the required future beacon round.');
        const proofs = relevant.filter(r => r.payload.type === 'play-beacon' && r.payload.commit === record.event.id);
        for (const proof of proofs) assert(proof.payload.type === 'play-beacon' && proof.payload.index === result.index && proof.payload.round === round, 'Beacon proof references a different attack round/index.');
        if (!proofs.length) { result.pending = record; result.beaconLock = lock ?? null; break; }
        const proof = proofs[0].payload;
        assert(proof.type === 'play-beacon', 'Invalid beacon proof.');
        secret = beaconRandomness(proof);
        // Different participants may relay the same unique BLS proof; event IDs must not select state.
        resolutionId = sha256Hex(canonicalStringify({ domain: 'neon-dominion-beacon-v1', commit: record.event.id, chain: BEACON_CHAIN, round: proof.round, signature: proof.signature }));
      } else {
        assert(action.beaconRound === undefined, 'Beacon attacks require an explicit mode upgrade.');
        const witnessSeat = witnessFor(snapshot.state), witness = snapshot.state.players[witnessSeat];
        const reveals = indexed.get(`play-reveal:${result.index}:${witness.id}`) ?? [];
        assert(reveals.length <= 1, `Witness signed conflicting reveals at index ${result.index}. Game halted.`);
        if (!reveals.length) { result.pending = record; break; }
        const revealRecord = reveals[0], reveal = revealRecord.payload;
        assert(reveal.type === 'play-reveal' && reveal.commit === record.event.id, 'Witness reveal is bound to another attack.');
        assert(reveal.chainIndex === witness.hashChainIndex + 1 && verifyReveal(witness.currentHashCommitment, reveal.secret), 'Invalid or reused witness secret.');
        next.state.players[witnessSeat].currentHashCommitment = reveal.secret;
        next.state.players[witnessSeat].hashChainIndex++;
        secret = reveal.secret; resolutionId = revealRecord.event.id;
      }
      const d = action.decision;
      const rng = new DeterministicRng(deriveTurnSeed(record.event.id, secret)).fork('dice');
      const battle = resolveAttack(setup.map, next.state, seat, {
        orderId: record.event.id, fromTerritoryId: d.from, toTerritoryId: d.to, attackerDice: d.dice,
        stopWhenAttackerAtOrBelow: d.stop, occupyMode: { type: 'NONE' },
      }, () => rng.rollD6());
      assert(!battle.skippedReason && battle.waves.length, 'Committed attack could not execute.');
      const defender = battle.defenderIndex!;
      for (const wave of battle.waves) {
        next.stats[seat].kills += wave.defenderLosses; next.stats[seat].losses += wave.attackerLosses;
        next.stats[defender].kills += wave.attackerLosses; next.stats[defender].losses += wave.defenderLosses;
      }
      if (battle.conquered) {
        next.conquered = true; next.phase = 'move';
        next.move = { from: d.from, to: d.to, min: battle.waves[battle.waves.length - 1].attackerDice.length };
        next.stats[seat].captures++;
        next.stats[seat].peak = Math.max(next.stats[seat].peak, next.state.territories.filter(t => t.owner === seat).length);
        if (battle.eliminatedPlayerIndex !== undefined) next.stats[battle.eliminatedPlayerIndex].out = next.round;
      }
      next.state.lastCommitEventId = record.event.id;
      next.state.lastRevealEventId = resolutionId;
      result.snapshot = next; result.lastBattle = battle; result.battles.push(battle);
      result.prev = resolutionId; result.index++; result.applied.push(record.event.id, resolutionId);
    }
  } catch (error) { result.conflict = error instanceof Error ? error.message : String(error); }
  return result;
}
