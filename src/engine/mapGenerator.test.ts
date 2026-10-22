import { describe, expect, it } from 'vitest';
import type { GameMap } from '../types/game';
import { hexKey, hexNeighbors } from './hexMath';
import { MAP_SCALE, MAP_TUNING, continentBonus, generateMap } from './mapGenerator';

const SEEDS_PER_COUNT = 15;
const maps: GameMap[] = [];
for (let p = 2; p <= 8; p++) for (let s = 0; s < SEEDS_PER_COUNT; s++) maps.push(generateMap({ seed: `test-${s}`, playerCount: p }));

const label = (m: GameMap) => `players=${m.playerCount} seed=${m.seed}`;

function components(ids: number[], next: (id: number) => number[]): number {
  const seen = new Set<number>(); let count = 0;
  for (const id of ids) {
    if (seen.has(id)) continue;
    count++; const stack = [id]; seen.add(id);
    while (stack.length) for (const n of next(stack.pop()!)) if (ids.includes(n) && !seen.has(n)) { seen.add(n); stack.push(n); }
  }
  return count;
}

describe('generateMap', () => {
  it('is deterministic for the same seed and player count', () => {
    const a = generateMap({ seed: 'repeat', playerCount: 5 });
    const b = generateMap({ seed: 'repeat', playerCount: 5 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('produces different maps for different seeds', () => {
    const a = generateMap({ seed: 'one', playerCount: 4 });
    const b = generateMap({ seed: 'two', playerCount: 4 });
    expect(JSON.stringify(a.territories.map(t => t.hexes))).not.toBe(JSON.stringify(b.territories.map(t => t.hexes)));
  });

  it('rejects unsupported player counts', () => {
    expect(() => generateMap({ seed: 'x', playerCount: 1 })).toThrow(RangeError);
    expect(() => generateMap({ seed: 'x', playerCount: 9 })).toThrow(RangeError);
  });

  it.each(maps.map(m => [label(m), m] as const))('valid map: %s', (_, m) => {
    const { territories: T, continents: C } = MAP_SCALE[m.playerCount];
    expect(m.territories).toHaveLength(T);
    expect(T % m.playerCount).toBe(0);
    expect(m.continents).toHaveLength(C);

    // Every hex belongs to exactly one territory.
    const owner = new Map<string, number>();
    for (const t of m.territories) for (const h of t.hexes) {
      expect(owner.has(hexKey(h))).toBe(false);
      owner.set(hexKey(h), t.id);
    }

    for (const t of m.territories) {
      // Size bounds and contiguity.
      expect(t.hexes.length).toBeGreaterThanOrEqual(MAP_TUNING.minTerritoryHexes);
      expect(t.hexes.length).toBeLessThanOrEqual(MAP_TUNING.maxTerritoryHexes);
      const own = new Set(t.hexes.map(hexKey));
      const idx = t.hexes.map((_, i) => i);
      const byKey = new Map(t.hexes.map((h, i) => [hexKey(h), i]));
      expect(components(idx, i => hexNeighbors(t.hexes[i]).map(hexKey).filter(k => own.has(k)).map(k => byKey.get(k)!))).toBe(1);
      // No dead ends, symmetric adjacency, label inside territory.
      expect(t.neighbors.length).toBeGreaterThanOrEqual(MAP_TUNING.minTerritoryDegree);
      for (const n of t.neighbors) expect(m.territories[n].neighbors).toContain(t.id);
      expect(own.has(hexKey(t.labelHex))).toBe(true);
    }

    // Continents: sized within bounds, internally contiguous.
    for (const c of m.continents) {
      expect(c.territoryIds.length).toBeGreaterThanOrEqual(MAP_TUNING.minContinentTerritories);
      expect(c.territoryIds.length).toBeLessThanOrEqual(MAP_TUNING.maxContinentTerritories);
      const entries = m.chokepoints.filter(cp => m.territories[cp.a].continentId === c.id || m.territories[cp.b].continentId === c.id).length;
      expect(c.bonus).toBe(continentBonus(c.territoryIds.length, entries));
      expect(components(c.territoryIds, id => m.territories[id].neighbors)).toBe(1);
    }

    // Chokepoints are the ONLY borders between continents.
    const linkPairs = new Set(m.chokepoints.map(cp => [cp.a, cp.b].sort((x, y) => x - y).join('-')));
    for (const cp of m.chokepoints) expect(m.territories[cp.a].continentId).not.toBe(m.territories[cp.b].continentId);
    for (const t of m.territories) for (const n of t.neighbors) {
      if (m.territories[n].continentId !== t.continentId) expect(linkPairs.has([t.id, n].sort((x, y) => x - y).join('-'))).toBe(true);
    }
    expect(m.chokepoints.length).toBeGreaterThanOrEqual(C - 1);
    const perContinent = new Array(C).fill(0);
    for (const cp of m.chokepoints) { perContinent[m.territories[cp.a].continentId]++; perContinent[m.territories[cp.b].continentId]++; }
    for (const n of perContinent) {
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBeLessThanOrEqual(MAP_TUNING.maxLinksPerContinent);
    }

    // Whole map connected.
    expect(components(m.territories.map(t => t.id), id => m.territories[id].neighbors)).toBe(1);
  });

  it('continent bonus follows the documented formula', () => {
    expect(continentBonus(4, 1)).toBe(2);   // Australia-like
    expect(continentBonus(4, 2)).toBe(3);   // South America-like
    expect(continentBonus(9, 3)).toBe(6);   // North America-like
    expect(continentBonus(12, 5)).toBe(9);  // Asia-like
    expect(continentBonus(3, 1)).toBe(2);   // floor
    expect(continentBonus(30, 9)).toBe(10); // ceiling
  });
});

describe('generation stats', () => {
  it('reports retry rate and chokepoint mix', () => {
    const attempts = maps.map(m => m.attempt);
    const bridges = maps.reduce((a, m) => a + m.chokepoints.filter(c => c.kind === 'BRIDGE').length, 0);
    const lanes = maps.reduce((a, m) => a + m.chokepoints.filter(c => c.kind === 'SEA_LANE').length, 0);
    console.info(`maps=${maps.length} avgAttempt=${(attempts.reduce((a, b) => a + b, 0) / maps.length).toFixed(2)} maxAttempt=${Math.max(...attempts)} bridges=${bridges} seaLanes=${lanes}`);
    expect(Math.max(...attempts)).toBeLessThan(MAP_TUNING.maxAttempts);
  });
});
