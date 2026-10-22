import { connectedOwned } from '../engine/fortify';
import { bestSet } from '../engine/rules';
import { computeReinforcements } from '../engine/turnEngine';
import type { AttackCampaignOrder, DraftPlacementOrder, SetupPlacementAction, TurnActionPlan } from '../types/actions';
import type { GameMap, GameState, PlayerIndex, TerritoryCard, TerritoryId } from '../types/game';

/*
 * "Dumb bot" (ARCHITECTURE §8): fast, deterministic, always legal. No randomness — ties break by
 * lowest territory id — and integer-only comparisons (ratios are cross-multiplied).
 */

const MAX_BOT_ATTACKS = 5;

function owned(state: GameState, player: PlayerIndex): TerritoryId[] {
  return state.territories.flatMap((t, id) => (t.owner === player ? [id] : []));
}

function borders(map: GameMap, state: GameState, player: PlayerIndex): TerritoryId[] {
  return owned(state, player).filter(id => map.territories[id].neighbors.some(n => state.territories[n].owner !== player));
}

/** Setup: round-robin the whole pool across border territories (all territories if somehow none border). */
export function generateBotSetupPlacement(map: GameMap, state: GameState, player: PlayerIndex): SetupPlacementAction {
  const targets = borders(map, state, player);
  const pool = state.players[player].setupTroops;
  const list = targets.length ? targets : owned(state, player);
  const amounts = new Map<TerritoryId, number>();
  for (let i = 0; i < pool; i++) amounts.set(list[i % list.length], (amounts.get(list[i % list.length]) ?? 0) + 1);
  return { type: 'SETUP_PLACEMENT', playerIndex: player, placements: [...amounts].map(([territoryId, troops]) => ({ territoryId, troops })) };
}

export function generateBotTurnPlan(map: GameMap, state: GameState): TurnActionPlan {
  const p = state.activePlayerIndex;
  const isMine = (id: TerritoryId) => state.territories[id].owner === p;

  // 1. Trade every valid set, highest value first (also satisfies the mandatory-trade rule).
  let hand: TerritoryCard[] = [...state.players[p].cards];
  const cardTrades: TurnActionPlan['cardTrades'] = [];
  const trades: TerritoryCard[][] = [];
  for (let set = bestSet(hand); set; set = bestSet(hand)) {
    const ids = set.cardIds;
    cardTrades.push({ cardIds: ids });
    trades.push(ids.map(id => hand.find(c => c.id === id)!));
    hand = hand.filter(c => !ids.includes(c.id));
  }
  const total = computeReinforcements(map, state, p, trades).total;

  // 2. Draft: 60% on the staging territory facing the weakest enemy, 40% round-robin on other borders.
  const front = borders(map, state, p);
  const weakestEnemy = (id: TerritoryId) => Math.min(...map.territories[id].neighbors.filter(n => !isMine(n)).map(n => state.territories[n].troops));
  const continentShare = (id: TerritoryId) => {
    const c = map.continents[map.territories[id].continentId];
    return Math.floor((c.territoryIds.filter(isMine).length * 100) / c.territoryIds.length);
  };
  const staging = [...front].sort((a, b) =>
    weakestEnemy(a) - weakestEnemy(b)
    || Number(continentShare(b) >= 60) - Number(continentShare(a) >= 60)
    || state.territories[b].troops - state.territories[a].troops
    || a - b)[0] ?? owned(state, p)[0];
  const others = front.filter(id => id !== staging);
  const rest = others.length ? Math.floor((total * 40) / 100) : 0;
  const draft = new Map<TerritoryId, number>([[staging, total - rest]]);
  for (let i = 0; i < rest; i++) draft.set(others[i % others.length], (draft.get(others[i % others.length]) ?? 0) + 1);
  const draftPlacements: DraftPlacementOrder[] = [...draft].map(([territoryId, troops]) => ({ territoryId, troops }));

  // 3. Attacks on a simulated board: best troop ratio first, optimistic conquest enables 1-step chains.
  const sim = state.territories.map((t, id) => ({ owner: t.owner, troops: t.troops + (draft.get(id) ?? 0) }));
  const attackQueue: AttackCampaignOrder[] = [];
  for (let i = 0; i < MAX_BOT_ATTACKS; i++) {
    let best: { from: TerritoryId; to: TerritoryId } | null = null;
    for (let from = 0; from < sim.length; from++) {
      if (sim[from].owner !== p || sim[from].troops < 4) continue;
      for (const to of map.territories[from].neighbors) {
        if (sim[to].owner === p || sim[from].troops < sim[to].troops + 2) continue;
        const better = !best
          || sim[from].troops * sim[best.to].troops > sim[best.from].troops * sim[to].troops
          || (sim[from].troops * sim[best.to].troops === sim[best.from].troops * sim[to].troops && (from < best.from || (from === best.from && to < best.to)));
        if (better) best = { from, to };
      }
    }
    if (!best) break;
    attackQueue.push({ orderId: `bot-${i + 1}`, fromTerritoryId: best.from, toTerritoryId: best.to, stopWhenAttackerAtOrBelow: 2, occupyMode: { type: 'ALL_BUT_ONE' } });
    const survivors = sim[best.from].troops - sim[best.to].troops;
    sim[best.to] = { owner: p, troops: survivors - 1 };
    sim[best.from].troops = 1;
  }

  // 4. Fortify: biggest interior stack (≥3) walks to the nearest connected border territory.
  let fortify: TurnActionPlan['fortify'] = null;
  const frontSet = new Set(front);
  const interior = owned(state, p).filter(id => !frontSet.has(id) && state.territories[id].troops >= 3)
    .sort((a, b) => state.territories[b].troops - state.territories[a].troops || a - b)[0];
  if (interior !== undefined) {
    const reachable = connectedOwned(map, state, p, interior);
    const dest = bfsNearest(map, interior, id => reachable.has(id) && frontSet.has(id), id => isMine(id));
    if (dest !== null) fortify = { fromTerritoryId: interior, toTerritoryId: dest, troops: state.territories[interior].troops - 1 };
  }

  return { type: 'TURN_ACTION_PLAN', turnNumber: state.turnNumber, playerIndex: p, cardTrades, draftPlacements, attackQueue, fortify };
}

function bfsNearest(map: GameMap, start: TerritoryId, goal: (id: TerritoryId) => boolean, passable: (id: TerritoryId) => boolean): TerritoryId | null {
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const n of [...map.territories[cur].neighbors].sort((a, b) => a - b)) {
      if (seen.has(n) || !passable(n)) continue;
      if (goal(n)) return n;
      seen.add(n); queue.push(n);
    }
  }
  return null;
}
