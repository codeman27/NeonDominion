import { advanceCommitment, verifyReveal } from '../crypto/hashChain';
import { DeterministicRng, sha256Hex } from '../crypto/prng';
import { computeStateHash } from '../crypto/stateHash';
import type { AttackResolutionLog, DraftPlacementOrder, ReinforcementBreakdown, TurnActionPlan, TurnResolutionResult } from '../types/actions';
import type { GameMap, GameState, PlayerIndex, TerritoryCard, TerritoryId } from '../types/game';
import { resolveAttack } from './combatResolver';
import { GameRuleError } from './errors';
import { applyFortify } from './fortify';
import {
  MANDATORY_TRADE_HAND_SIZE, TERRITORY_MATCH_BONUS, baseReinforcements, cardSetValue, continentBonusFor, ownedTerritoryCount, territoryMatchFor,
} from './rules';

/** Upper bound on queued attacks per turn (keeps hostile plans from stalling every client). */
export const MAX_ATTACK_ORDERS = 64;

/** TurnSeed = SHA256(commitEventId + ":" + revealedSecret)  (ARCHITECTURE §5.2). */
export function deriveTurnSeed(commitEventId: string, revealedSecret: string): string {
  return sha256Hex(`${commitEventId}:${revealedSecret}`);
}

/** Next non-eliminated seat after `from`, wrapping around. Returns `from` if nobody else is alive. */
export function nextAlivePlayer(state: GameState, from: PlayerIndex): PlayerIndex {
  const n = state.players.length;
  for (let step = 1; step <= n; step++) {
    const i = (from + step) % n;
    if (!state.players[i].eliminated) return i;
  }
  return from;
}

/** The player whose hash-chain secret seeds the active player's turn. */
export function witnessFor(state: GameState): PlayerIndex {
  return nextAlivePlayer(state, state.activePlayerIndex);
}

/** Reinforcements the active player gets for a set of card trades (trades must already be valid). */
export function computeReinforcements(map: GameMap, state: GameState, player: PlayerIndex, trades: TerritoryCard[][]): ReinforcementBreakdown & { matchTerritories: TerritoryId[] } {
  const base = baseReinforcements(ownedTerritoryCount(state, player));
  const continentBonus = continentBonusFor(map, state, player);
  let cardTradeBonus = 0;
  const matchTerritories: TerritoryId[] = [];
  for (const cards of trades) {
    cardTradeBonus += cardSetValue(cards) ?? 0;
    const match = territoryMatchFor(cards, id => state.territories[id].owner === player);
    if (match !== null) matchTerritories.push(match);
  }
  return {
    base, continentBonus, cardTradeBonus,
    territoryMatchBonusTerritories: matchTerritories,
    total: base + continentBonus + cardTradeBonus,
    matchTerritories,
  };
}

export function tradeCards(state: GameState, plan: TurnActionPlan): { trades: TerritoryCard[][]; errors: string[] } {
  const errors: string[] = [];
  const hand = state.players[plan.playerIndex]?.cards ?? [];
  const byId = new Map(hand.map(c => [c.id, c]));
  const used = new Set<number>();
  const trades: TerritoryCard[][] = [];
  plan.cardTrades.forEach((t, i) => {
    if (!Array.isArray(t.cardIds) || t.cardIds.length !== 3) { errors.push(`trade ${i}: must be exactly 3 cards`); return; }
    const cards: TerritoryCard[] = [];
    for (const id of t.cardIds) {
      const c = byId.get(id);
      if (!c) errors.push(`trade ${i}: card ${id} is not in hand`);
      else if (used.has(id)) errors.push(`trade ${i}: card ${id} used twice`);
      else { used.add(id); cards.push(c); }
    }
    if (cards.length === 3) {
      if (cardSetValue(cards) === null) errors.push(`trade ${i}: not a valid set`);
      else trades.push(cards);
    }
  });
  if (hand.length >= MANDATORY_TRADE_HAND_SIZE && hand.length - used.size >= MANDATORY_TRADE_HAND_SIZE) {
    errors.push(`must trade until fewer than ${MANDATORY_TRADE_HAND_SIZE} cards remain`);
  }
  return { trades, errors };
}

const isNonNegInt = (n: unknown) => Number.isInteger(n) && (n as number) >= 0;

/**
 * Every rule violation detectable at commit time (empty array = valid). Conditions that depend on dice
 * (e.g. a chained attack from a territory that might not be captured) are *not* errors; they become
 * logged skips during resolution.
 */
export function validateTurnPlan(map: GameMap, state: GameState, plan: TurnActionPlan): string[] {
  const errors: string[] = [];
  if (state.phase !== 'ACTIVE_TURN_COMMIT') return ['game is not accepting turns'];
  if (plan.type !== 'TURN_ACTION_PLAN') errors.push('not a turn plan');
  if (plan.turnNumber !== state.turnNumber) errors.push(`expected turn ${state.turnNumber}, got ${plan.turnNumber}`);
  if (plan.playerIndex !== state.activePlayerIndex) errors.push(`it is player ${state.activePlayerIndex}'s turn`);
  if (errors.length) return errors;

  const { trades, errors: tradeErrors } = tradeCards(state, plan);
  errors.push(...tradeErrors);

  const { total } = computeReinforcements(map, state, plan.playerIndex, trades);
  let placed = 0;
  for (const d of plan.draftPlacements) {
    if (!isNonNegInt(d.troops)) { errors.push('draft troops must be non-negative integers'); continue; }
    if (!Number.isInteger(d.territoryId) || state.territories[d.territoryId]?.owner !== plan.playerIndex) {
      errors.push(`cannot draft onto territory ${d.territoryId}`);
      continue;
    }
    placed += d.troops;
  }
  if (placed !== total) errors.push(`must place exactly ${total} troops, placed ${placed}`);

  if (plan.attackQueue.length > MAX_ATTACK_ORDERS) errors.push(`at most ${MAX_ATTACK_ORDERS} attack orders`);
  const ids = new Set<string>();
  for (const a of plan.attackQueue) {
    if (typeof a.orderId !== 'string' || ids.has(a.orderId)) errors.push('attack order ids must be unique strings');
    ids.add(a.orderId);
    if (!Number.isInteger(a.fromTerritoryId) || !Number.isInteger(a.toTerritoryId) || !map.territories[a.fromTerritoryId] || !map.territories[a.toTerritoryId]) {
      errors.push(`attack ${a.orderId}: unknown territory`);
    }
    if (!isNonNegInt(a.stopWhenAttackerAtOrBelow)) errors.push(`attack ${a.orderId}: stop threshold must be a non-negative integer`);
    const m = a.occupyMode;
    const okMode = m && (m.type === 'MIN' || m.type === 'HALF' || m.type === 'ALL_BUT_ONE' || (m.type === 'LEAVE_BEHIND' && isNonNegInt(m.leaveTroops)));
    if (!okMode) errors.push(`attack ${a.orderId}: invalid occupy mode`);
  }

  const f = plan.fortify;
  if (f && (!Number.isInteger(f.fromTerritoryId) || !Number.isInteger(f.toTerritoryId) || !Number.isInteger(f.troops))) {
    errors.push('fortify fields must be integers');
  }
  return errors;
}

export interface ApplyTurnInput {
  plan: TurnActionPlan;
  /** Nostr event id (or local equivalent) of the signed TurnCommit. */
  commitEventId: string;
  /** Next hash-chain secret of the witness (`witnessFor(state)`). */
  revealedSecret: string;
  revealEventId?: string | null;
}

/** Applies a committed whole-turn plan. Pure: the input state is never mutated. Throws GameRuleError on invalid input. */
export function applyTurn(map: GameMap, state: GameState, input: ApplyTurnInput): TurnResolutionResult {
  const { plan, commitEventId, revealedSecret } = input;
  const errors = validateTurnPlan(map, state, plan);
  if (errors.length) throw new GameRuleError(errors.join('; '));

  const witness = witnessFor(state);
  if (!verifyReveal(state.players[witness].currentHashCommitment, revealedSecret)) {
    throw new GameRuleError(`reveal does not match player ${witness}'s commitment`);
  }

  const player = plan.playerIndex;
  const turnSeed = deriveTurnSeed(commitEventId, revealedSecret);
  const rng = new DeterministicRng(turnSeed);
  const dice = rng.fork('dice');
  const rollD6 = () => dice.rollD6();

  let s = structuredClone(state);
  s.players[witness].currentHashCommitment = advanceCommitment(state.players[witness].currentHashCommitment, revealedSecret);
  s.players[witness].hashChainIndex++;

  // 1. Card trades (+2 match troops are placed automatically on the matched territory).
  const { trades } = tradeCards(state, plan);
  const reinforcements = computeReinforcements(map, state, player, trades);
  const tradedIds = new Set(trades.flat().map(c => c.id));
  s.discardPile.push(...s.players[player].cards.filter(c => tradedIds.has(c.id)));
  s.players[player].cards = s.players[player].cards.filter(c => !tradedIds.has(c.id));
  for (const tid of reinforcements.matchTerritories) s.territories[tid].troops += TERRITORY_MATCH_BONUS;

  // 2. Draft.
  const draftApplied: DraftPlacementOrder[] = [];
  for (const d of plan.draftPlacements) {
    if (d.troops === 0) continue;
    s.territories[d.territoryId].troops += d.troops;
    draftApplied.push({ territoryId: d.territoryId, troops: d.troops });
  }

  // 3. Attacks, in queue order, against the evolving state.
  const attackLogs: AttackResolutionLog[] = plan.attackQueue.map(o => resolveAttack(map, s, player, o, rollD6));
  const conqueredAny = attackLogs.some(l => l.conquered);
  const eliminatedPlayers = attackLogs.flatMap(l => (l.eliminatedPlayerIndex === undefined ? [] : [l.eliminatedPlayerIndex]));
  const won = s.territories.every(t => t.owner === player);

  // 4. Fortify.
  let fortify: TurnResolutionResult['fortify'] = null;
  if (plan.fortify && !won) {
    const r = applyFortify(map, s, player, plan.fortify);
    s = r.state;
    fortify = r.resolution;
  }

  // 5. Card draw for conquering at least one territory (reshuffle discards when the deck runs out).
  let cardDrawn = false;
  if (conqueredAny && !won) {
    if (s.deck.length === 0 && s.discardPile.length > 0) {
      s.deck = rng.fork('reshuffle').shuffle(s.discardPile.sort((a, b) => a.id - b.id));
      s.discardPile = [];
    }
    const card = s.deck.pop();
    if (card) { s.players[player].cards.push(card); cardDrawn = true; }
  }

  // 6. Win check / advance turn.
  if (won) {
    s.phase = 'GAME_OVER';
    s.winnerIndex = player;
  } else {
    s.activePlayerIndex = nextAlivePlayer(s, player);
    s.turnNumber = state.turnNumber + 1;
  }
  s.lastCommitEventId = commitEventId;
  s.lastRevealEventId = input.revealEventId ?? null;
  s.prevStateHash = computeStateHash(state);

  const { base, continentBonus, cardTradeBonus, territoryMatchBonusTerritories, total } = reinforcements;
  return {
    turnNumber: state.turnNumber,
    playerIndex: player,
    turnSeed,
    reinforcements: { base, continentBonus, cardTradeBonus, territoryMatchBonusTerritories, total },
    draftApplied,
    attackLogs,
    fortify,
    cardDrawn,
    eliminatedPlayers,
    newState: s,
    newStateHash: computeStateHash(s),
  };
}
