import type { FortifyOrder, FortifyResolution } from '../types/actions';
import type { GameMap, GameState, PlayerIndex, TerritoryId } from '../types/game';

/** Territories reachable from `from` moving only through territories owned by `player` (BFS, excludes `from`). */
export function connectedOwned(map: GameMap, state: GameState, player: PlayerIndex, from: TerritoryId): Set<TerritoryId> {
  const seen = new Set<TerritoryId>([from]);
  const queue = [from];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const n of map.territories[cur].neighbors) {
      if (!seen.has(n) && state.territories[n].owner === player) { seen.add(n); queue.push(n); }
    }
  }
  seen.delete(from);
  return seen;
}

/** One end-of-turn move along a path of the player's own territories, always leaving 1 behind. Pure. */
export function applyFortify(map: GameMap, state: GameState, player: PlayerIndex, order: FortifyOrder): { state: GameState; resolution: FortifyResolution } {
  const skip = (skippedReason: FortifyResolution['skippedReason']) => ({ state, resolution: { order, executed: false, troopsMoved: 0, skippedReason } });
  const { fromTerritoryId: from, toTerritoryId: to } = order;
  const src = state.territories[from];
  const dst = state.territories[to];
  if (!src || !dst || src.owner !== player || dst.owner !== player) return skip('NOT_OWNED');
  if (from === to) return skip('SAME_TERRITORY');
  const requested = Number.isInteger(order.troops) ? order.troops : 0;
  const moved = Math.min(requested, src.troops - 1);
  if (moved <= 0) return skip('NOTHING_TO_MOVE');
  if (!connectedOwned(map, state, player, from).has(to)) return skip('NO_CONNECTED_PATH');

  const next = structuredClone(state);
  next.territories[from].troops -= moved;
  next.territories[to].troops += moved;
  return { state: next, resolution: { order, executed: true, troopsMoved: moved } };
}
