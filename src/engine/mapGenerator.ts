import { DeterministicRng, sha256Hex } from '../crypto/prng';
import type { AxialCoord, Chokepoint, Continent, GameMap, Territory, TerritoryId } from '../types/game';
import { hexDistance, hexKey, hexLine, hexNeighbors, hexOffsetsWithin, offsetToAxial, type HexKey } from './hexMath';

/*
 * Continents-first procedural map generator.
 *
 *  1. Split the territory count into continents of varied size.
 *  2. Grow every continent as its own landmass on a shared canvas. A hex can only be claimed if no
 *     other continent's land is within `continentSeparation - 1`, so continents never touch.
 *  3. Link continents with a minimum spanning tree (guarantees connectivity) plus a few extra
 *     short links (gives alternative routes). Short gaps become 1–3 hex LAND BRIDGES, long gaps become
 *     SEA LANES. These links are the ONLY inter-continent borders → every link is a chokepoint.
 *  4. Partition each continent into territories (farthest-point seeds, balanced flood fill, Lloyd relax).
 *  5. Validate; on failure retry with the next deterministic attempt.
 *
 * Determinism: all game-relevant math is integer-only (no Math.sin/cos/sqrt), and all randomness
 * comes from a SHA-256 DRBG seeded by (seed, playerCount, attempt), so every device gets the same map.
 */

export const MAP_GENERATOR_VERSION = 2;

export const MAP_SCALE: Readonly<Record<number, { territories: number; continents: number }>> = {
  2: { territories: 14, continents: 3 },
  3: { territories: 21, continents: 4 },
  4: { territories: 28, continents: 5 },
  5: { territories: 30, continents: 5 },
  6: { territories: 36, continents: 6 },
  7: { territories: 42, continents: 6 },
  8: { territories: 48, continents: 7 },
};

export const MAP_TUNING = {
  minContinentTerritories: 3,
  maxContinentTerritories: 9,
  minHexesPerTerritory: 5,
  maxHexesPerTerritory: 7,
  /** Approximate share of the canvas that becomes land. Lower = more ocean between continents. */
  landPercent: 40,
  /** Minimum hex distance between land of two different continents (3 ⇒ at least 2 water hexes). */
  continentSeparation: 3,
  /** Gaps up to this hex distance become land bridges; longer gaps become sea lanes. */
  maxBridgeDistance: 4,
  /** Extra (non-spanning-tree) links are only added if no longer than this. */
  maxExtraLinkDistance: 7,
  /** No continent gets more than this many links (keeps chokepoints scarce and meaningful). */
  maxLinksPerContinent: 3,
  minTerritoryHexes: 3,
  maxTerritoryHexes: 14,
  /** Every territory must border at least this many others (no dead-end pockets). */
  minTerritoryDegree: 2,
  lloydIterations: 2,
  maxAttempts: 80,
  /** Growth shape: higher noise weight = more lobes/peninsulas, higher distance weight = rounder blobs. */
  growthDistanceWeight: 34,
  growthJitter: 50,
} as const;

const TERRITORY_NAMES = [
  'NEO-KYOTO', 'SECTOR 7', 'RUSTWATER', 'CHROME HILL', 'THE SPRAWL', 'VOLT YARD', 'GHOSTLINE', 'KILN DOCKS',
  'ARCOLOGY 9', 'NULL HARBOR', 'SIGNAL PEAK', 'DATA FENS', 'IRONVEIL', 'SYNAPSE', 'LOW CITY', 'HALO RIDGE',
  'BLACKWIRE', 'OXIDE FLATS', 'PRISM BAY', 'CINDERGATE', 'MAGLEV 3', 'THE STACKS', 'NEON MILE', 'QUARANTINE',
  'VECTOR', 'COLDSINK', 'RELAY ONE', 'SHARD', 'OVERPASS', 'PULSE', 'HELIX', 'UNDERGRID', 'SALT VAULT',
  'ZERO DAY', 'BLOOM', 'ECHO PIER', 'TITAN WORKS', 'FLUX', 'STATIC', 'DEADZONE', 'KAIJU BAY', 'OMEGA',
  'PIXEL ROW', 'STRATA', 'AFTERGLOW', 'MERIDIAN', 'GRAYMARKET', 'LAST LIGHT', 'HOLLOW SUN', 'FERRO GATE',
  'NOVA SPIRE', 'CIRCUIT BAY',
];
const CONTINENT_NAMES = [
  'CHROME BELT', 'NEON DELTA', 'THE UNDERGRID', 'IRON MESA', 'VOID MARCH', 'DATA REACH', 'RUST COAST',
  'GLASS STEPPE', 'SIGNAL ISLES', 'ASH FRONTIER',
];

export interface MapGenOptions {
  seed: string;
  playerCount: number;
}

export type RejectReason =
  | 'centers' | 'growth-boxed-in' | 'no-spanning-links' | 'partition' | 'territory-size' | 'dead-end' | 'stray-border' | 'disconnected';

export interface MapGenReport {
  map: GameMap;
  /** How many attempts were rejected, by reason (for tuning / the map lab). */
  rejections: Partial<Record<RejectReason, number>>;
}

export function generateMap(opts: MapGenOptions): GameMap {
  return generateMapWithReport(opts).map;
}

export function generateMapWithReport(opts: MapGenOptions): MapGenReport {
  const { seed, playerCount } = opts;
  if (!MAP_SCALE[playerCount]) throw new RangeError(`playerCount must be 2..8, got ${playerCount}`);
  const rejections: Partial<Record<RejectReason, number>> = {};
  for (let attempt = 0; attempt < MAP_TUNING.maxAttempts; attempt++) {
    const rng = new DeterministicRng(sha256Hex(`MAP:v${MAP_GENERATOR_VERSION}:${seed}:${playerCount}:${attempt}`));
    const result = tryGenerate(rng, seed, playerCount, attempt);
    if (typeof result !== 'string') return { map: result, rejections };
    rejections[result] = (rejections[result] ?? 0) + 1;
  }
  throw new Error(`map generation failed after ${MAP_TUNING.maxAttempts} attempts (seed=${seed}, players=${playerCount}): ${JSON.stringify(rejections)}`);
}

/* ------------------------------------------------------------------------------------------------ */

function tryGenerate(rng: DeterministicRng, seed: string, playerCount: number, attempt: number): GameMap | RejectReason {
  const { territories: T, continents: C } = MAP_SCALE[playerCount];
  const sizes = continentSizes(T, C, rng.fork('sizes'));
  const sizeRng = rng.fork('budget');
  const budgets = sizes.map(n => n * sizeRng.nextInt(MAP_TUNING.minHexesPerTerritory, MAP_TUNING.maxHexesPerTerritory));

  const canvas = buildCanvas(budgets.reduce((a, b) => a + b, 0));
  const noise = buildNoise(canvas, rng.fork('noise'));
  const centers = pickCenters(canvas, C, rng.fork('centers'));
  if (!centers) return 'centers';

  const grown = growContinents(canvas, noise, centers, budgets, rng.fork('grow'));
  if (!grown) return 'growth-boxed-in';
  const { landByContinent, owner } = grown;

  const links = linkContinents(landByContinent, owner, rng.fork('links'));
  if (!links) return 'no-spanning-links';

  // Partition each continent into territories.
  const partRng = rng.fork('partition');
  const groups: { continent: number; hexes: AxialCoord[]; medoid: AxialCoord }[] = [];
  for (let c = 0; c < C; c++) {
    const anchors = new Set(links.flatMap(l => (l.a === c ? [hexKey(l.ha)] : l.b === c ? [hexKey(l.hb)] : [])));
    const parts = partition(landByContinent[c], sizes[c], anchors, partRng);
    if (!parts) return 'partition';
    // Stable reading order inside a continent (top-to-bottom, left-to-right by label hex).
    parts.sort((a, b) => a.medoid.r - b.medoid.r || a.medoid.q - b.medoid.q);
    for (const p of parts) groups.push({ continent: c, ...p });
  }

  const hexTerr = new Map<HexKey, TerritoryId>();
  groups.forEach((g, id) => g.hexes.forEach(h => hexTerr.set(hexKey(h), id)));

  // Materialise links as chokepoints; bridges add land hexes to their endpoint territories.
  const chokepoints: Chokepoint[] = [];
  const bridgeZone = new Set<HexKey>();
  for (const link of links) {
    const a = hexTerr.get(hexKey(link.ha))!;
    const b = hexTerr.get(hexKey(link.hb))!;
    const bridge = link.distance <= MAP_TUNING.maxBridgeDistance ? tryBridge(link, owner, bridgeZone) : null;
    if (bridge) {
      bridge.aSide.forEach(h => { hexTerr.set(hexKey(h), a); groups[a].hexes.push(h); });
      bridge.bSide.forEach(h => { hexTerr.set(hexKey(h), b); groups[b].hexes.push(h); });
      chokepoints.push({ kind: 'BRIDGE', a, b, from: link.ha, to: link.hb, bridgeHexes: [...bridge.aSide, ...bridge.bSide] });
    } else {
      chokepoints.push({ kind: 'SEA_LANE', a, b, from: link.ha, to: link.hb, bridgeHexes: [] });
    }
  }

  // Adjacency from shared hex edges + sea lanes.
  const adj = groups.map(() => new Set<TerritoryId>());
  const sea = groups.map(() => new Set<TerritoryId>());
  groups.forEach((g, id) => {
    for (const h of g.hexes) for (const n of hexNeighbors(h)) {
      const o = hexTerr.get(hexKey(n));
      if (o !== undefined && o !== id) adj[id].add(o);
    }
  });
  for (const cp of chokepoints) if (cp.kind === 'SEA_LANE') {
    adj[cp.a].add(cp.b); adj[cp.b].add(cp.a);
    sea[cp.a].add(cp.b); sea[cp.b].add(cp.a);
  }

  // Validation.
  for (const g of groups) {
    if (g.hexes.length < MAP_TUNING.minTerritoryHexes || g.hexes.length > MAP_TUNING.maxTerritoryHexes) return 'territory-size';
  }
  if (adj.some(s => s.size < MAP_TUNING.minTerritoryDegree)) return 'dead-end';
  const linkPairs = new Set(chokepoints.map(cp => pairKey(cp.a, cp.b)));
  for (let id = 0; id < groups.length; id++) {
    for (const n of adj[id]) {
      if (groups[n].continent !== groups[id].continent && !linkPairs.has(pairKey(id, n))) return 'stray-border';
    }
  }
  if (!isConnected(adj)) return 'disconnected';

  // Names, bonuses, output.
  const nameRng = rng.fork('names');
  const tNames = nameRng.shuffle([...TERRITORY_NAMES]);
  const cNames = nameRng.shuffle([...CONTINENT_NAMES]);

  const territories: Territory[] = groups.map((g, id) => ({
    id,
    name: tNames[id],
    continentId: g.continent,
    hexes: g.hexes,
    labelHex: g.medoid,
    neighbors: [...adj[id]].sort((x, y) => x - y),
    seaLaneNeighbors: [...sea[id]].sort((x, y) => x - y),
  }));

  const continents: Continent[] = sizes.map((_, c) => {
    const ids = territories.filter(t => t.continentId === c).map(t => t.id);
    const entryPoints = chokepoints.filter(cp => territories[cp.a].continentId === c || territories[cp.b].continentId === c).length;
    return { id: c, name: cNames[c], territoryIds: ids, bonus: continentBonus(ids.length, entryPoints) };
  });

  return { generatorVersion: MAP_GENERATOR_VERSION, seed, playerCount, attempt, territories, continents, chokepoints };
}

/**
 * Reinforcement bonus for holding a whole continent: ⌊territories / 3⌋ + entry points (bridges + sea lanes),
 * clamped to 2..10. More territories to conquer and more doors to defend ⇒ bigger reward. Integer-only.
 */
export function continentBonus(territories: number, entryPoints: number): number {
  return Math.min(10, Math.max(2, Math.floor(territories / 3) + entryPoints));
}

/* ---------------------------------------- steps ---------------------------------------- */

function continentSizes(total: number, count: number, rng: DeterministicRng): number[] {
  const { minContinentTerritories: lo, maxContinentTerritories: hi } = MAP_TUNING;
  const sizes = new Array<number>(count).fill(Math.floor(total / count));
  for (let i = 0; i < total % count; i++) sizes[i]++;
  // Shuffle territory counts between continents so they differ in size (a "Australia" and an "Asia").
  for (let i = 0; i < count * 3; i++) {
    const from = rng.nextInt(0, count - 1);
    const to = rng.nextInt(0, count - 1);
    const amount = rng.nextInt(1, 2);
    if (from !== to && sizes[from] - amount >= lo && sizes[to] + amount <= hi) {
      sizes[from] -= amount; sizes[to] += amount;
    }
  }
  return sizes;
}

function buildCanvas(totalLand: number): Map<HexKey, AxialCoord> {
  const area = Math.ceil((totalLand * 100) / MAP_TUNING.landPercent);
  // ~16:10 landscape in pixels; a hex row is 1.5 units tall vs √3≈1.732 wide, so rows ≈ √(area / 1.4).
  let rows = 4;
  while (rows * rows * 14 < area * 10) rows++;
  const cols = Math.ceil(area / rows);
  const canvas = new Map<HexKey, AxialCoord>();
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const h = offsetToAxial(col, row);
      canvas.set(hexKey(h), h);
    }
  }
  return canvas;
}

/** Smoothed integer value noise in [0, 1000]; drives organic coastlines and peninsulas. */
function buildNoise(canvas: Map<HexKey, AxialCoord>, rng: DeterministicRng): Map<HexKey, number> {
  let noise = new Map<HexKey, number>();
  for (const k of canvas.keys()) noise.set(k, rng.nextInt(0, 1000));
  for (let pass = 0; pass < 3; pass++) {
    const next = new Map<HexKey, number>();
    for (const [k, h] of canvas) {
      let sum = noise.get(k)! * 2; let n = 2;
      for (const nb of hexNeighbors(h)) {
        const v = noise.get(hexKey(nb));
        if (v !== undefined) { sum += v; n++; }
      }
      next.set(k, Math.floor(sum / n));
    }
    noise = next;
  }
  let min = Infinity; let max = -Infinity;
  for (const v of noise.values()) { min = Math.min(min, v); max = Math.max(max, v); }
  const span = Math.max(1, max - min);
  for (const [k, v] of noise) noise.set(k, Math.floor(((v - min) * 1000) / span));
  return noise;
}

function pickCenters(canvas: Map<HexKey, AxialCoord>, count: number, rng: DeterministicRng): AxialCoord[] | null {
  // Keep centers off the canvas edge so every continent has room to grow.
  const all = [...canvas.values()];
  const maxR = all.reduce((m, h) => Math.max(m, h.r), 0);
  const interior = all.filter(h => {
    const col = h.q + (h.r - (h.r & 1)) / 2;
    const maxCol = all.filter(x => x.r === h.r).length - 1;
    return h.r >= 2 && h.r <= maxR - 2 && col >= 2 && col <= maxCol - 2;
  });
  if (interior.length < count) return null;
  const centers = [rng.pick(interior)];
  let minD = interior.map(h => hexDistance(h, centers[0]));
  while (centers.length < count) {
    let best = -1; let bi = 0;
    for (let i = 0; i < interior.length; i++) {
      const v = minD[i] * 4 + rng.nextInt(0, 3);
      if (v > best) { best = v; bi = i; }
    }
    const c = interior[bi];
    centers.push(c);
    minD = minD.map((d, i) => Math.min(d, hexDistance(interior[i], c)));
  }
  return centers;
}

function growContinents(
  canvas: Map<HexKey, AxialCoord>, noise: Map<HexKey, number>, centers: AxialCoord[], budgets: number[], rng: DeterministicRng,
): { landByContinent: AxialCoord[][]; owner: Map<HexKey, number> } | null {
  const owner = new Map<HexKey, number>();
  const land: AxialCoord[][] = centers.map(() => []);
  const frontier: Set<HexKey>[] = centers.map(() => new Set());
  const near = hexOffsetsWithin(MAP_TUNING.continentSeparation - 1);

  const blocked = (h: AxialCoord, cid: number) => near.some(o => {
    const c = owner.get(hexKey({ q: h.q + o.q, r: h.r + o.r }));
    return c !== undefined && c !== cid;
  });
  const claim = (h: AxialCoord, cid: number) => {
    const k = hexKey(h);
    owner.set(k, cid); land[cid].push(h); frontier[cid].delete(k);
    for (const n of hexNeighbors(h)) {
      const nk = hexKey(n);
      if (canvas.has(nk) && !owner.has(nk)) frontier[cid].add(nk);
    }
  };
  centers.forEach((c, i) => { if (!blocked(c, i)) claim(c, i); });
  if (land.some(l => l.length === 0)) return null;

  for (;;) {
    // Grow the continent that is furthest behind its budget (integer cross-multiplied ratios).
    let cid = -1;
    for (let i = 0; i < centers.length; i++) {
      if (land[i].length >= budgets[i] || frontier[i].size === 0) continue;
      if (cid < 0 || land[i].length * budgets[cid] < land[cid].length * budgets[i]) cid = i;
    }
    if (cid < 0) break;

    let pick: HexKey | null = null; let pickScore = -Infinity;
    for (const k of [...frontier[cid]]) {
      const h = canvas.get(k)!;
      if (owner.has(k) || blocked(h, cid)) { frontier[cid].delete(k); continue; }
      const score = noise.get(k)! - MAP_TUNING.growthDistanceWeight * hexDistance(h, centers[cid]) + rng.nextInt(0, MAP_TUNING.growthJitter);
      if (score > pickScore) { pickScore = score; pick = k; }
    }
    if (pick !== null) claim(canvas.get(pick)!, cid);
  }

  // A continent that got boxed in well short of its budget would produce cramped territories.
  if (land.some((l, i) => l.length * 100 < budgets[i] * 85)) return null;
  return { landByContinent: land, owner };
}

interface Link { a: number; b: number; distance: number; ha: AxialCoord; hb: AxialCoord }

function linkContinents(land: AxialCoord[][], owner: Map<HexKey, number>, rng: DeterministicRng): Link[] | null {
  const C = land.length;
  const candidates: Link[] = [];
  for (let a = 0; a < C; a++) for (let b = a + 1; b < C; b++) {
    const link = closestClearLink(land, owner, a, b, rng);
    if (link) candidates.push(link);
  }
  candidates.sort((x, y) => x.distance - y.distance || x.a - y.a || x.b - y.b);

  // Degree-capped Kruskal minimum spanning tree (keeps every continent at ≤ maxLinksPerContinent).
  const parent = Array.from({ length: C }, (_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const degree = new Array<number>(C).fill(0);
  const cap = MAP_TUNING.maxLinksPerContinent;
  const chosen: Link[] = [];
  for (const l of candidates) {
    const ra = find(l.a); const rb = find(l.b);
    if (ra !== rb && degree[l.a] < cap && degree[l.b] < cap) { parent[ra] = rb; chosen.push(l); degree[l.a]++; degree[l.b]++; }
  }
  if (chosen.length !== C - 1) return null;
  const extras = candidates.filter(l => !chosen.includes(l));

  // A few extra links create alternative routes (loops) without flooding the map with borders.
  let extraBudget = Math.floor((C - 1) / 2);
  for (const l of extras) {
    if (extraBudget === 0) break;
    if (l.distance > MAP_TUNING.maxExtraLinkDistance) break;
    if (degree[l.a] >= cap || degree[l.b] >= cap) continue;
    chosen.push(l); degree[l.a]++; degree[l.b]++; extraBudget--;
  }
  return chosen;
}

/** Closest coastal hex pair between two continents whose straight path does not graze a third continent. */
function closestClearLink(land: AxialCoord[][], owner: Map<HexKey, number>, a: number, b: number, rng: DeterministicRng): Link | null {
  let best = Infinity;
  for (const ha of land[a]) for (const hb of land[b]) best = Math.min(best, hexDistance(ha, hb));
  const pairs: [AxialCoord, AxialCoord, number][] = [];
  for (const ha of land[a]) for (const hb of land[b]) {
    const d = hexDistance(ha, hb);
    if (d <= best + 1) pairs.push([ha, hb, d]);
  }
  pairs.sort((x, y) => x[2] - y[2]);
  const clear = pairs.filter(([ha, hb]) => hexLine(ha, hb).slice(1, -1).every(h => {
    const here = owner.get(hexKey(h));
    if (here !== undefined) return false;
    return hexNeighbors(h).every(n => { const o = owner.get(hexKey(n)); return o === undefined || o === a || o === b; });
  }));
  if (!clear.length) return null;
  const shortest = clear[0][2];
  const [ha, hb, distance] = rng.pick(clear.filter(p => p[2] === shortest));
  return { a, b, distance, ha, hb };
}

/** Land bridge hexes: first half joins territory A, second half joins territory B. Null if it would create stray borders. */
function tryBridge(link: Link, owner: Map<HexKey, number>, bridgeZone: Set<HexKey>): { aSide: AxialCoord[]; bSide: AxialCoord[] } | null {
  const inner = hexLine(link.ha, link.hb).slice(1, -1);
  const half = Math.ceil(inner.length / 2);
  const aSide = inner.slice(0, half);
  const bSide = inner.slice(half);
  const touches = (h: AxialCoord, c: number) => hexNeighbors(h).some(n => owner.get(hexKey(n)) === c);
  if (aSide.some(h => touches(h, link.b)) || bSide.some(h => touches(h, link.a))) return null;
  if (inner.some(h => bridgeZone.has(hexKey(h)))) return null;
  for (const h of inner) { bridgeZone.add(hexKey(h)); hexNeighbors(h).forEach(n => bridgeZone.add(hexKey(n))); }
  return { aSide, bSide };
}

/**
 * Split one continent into `n` territories. Retries locally (cheap) until every territory has at least
 * `minTerritoryDegree` neighbors inside the continent — or one fewer if it holds a chokepoint endpoint,
 * because the link supplies the missing border. This avoids rejecting a whole map for one dead-end pocket.
 */
function partition(
  hexes: AxialCoord[], n: number, anchors: Set<HexKey>, rng: DeterministicRng,
): { hexes: AxialCoord[]; medoid: AxialCoord }[] | null {
  if (hexes.length < n * MAP_TUNING.minTerritoryHexes) return null;
  const inside = new Set(hexes.map(hexKey));
  for (let tryNo = 0; tryNo < PARTITION_TRIES; tryNo++) {
    const groups = partitionOnce(hexes, n, inside, rng);
    if (partitionIsPlayable(groups, anchors)) return groups.map(g => ({ hexes: g, medoid: medoid(g) }));
  }
  return null;
}

const PARTITION_TRIES = 12;

function partitionOnce(hexes: AxialCoord[], n: number, inside: Set<HexKey>, rng: DeterministicRng): AxialCoord[][] {
  let seeds = [rng.pick(hexes)];
  let minD = hexes.map(h => hexDistance(h, seeds[0]));
  while (seeds.length < n) {
    let best = -1; let bi = 0;
    for (let i = 0; i < hexes.length; i++) {
      const v = minD[i] * 4 + rng.nextInt(0, 3);
      if (v > best) { best = v; bi = i; }
    }
    seeds.push(hexes[bi]);
    minD = minD.map((d, i) => Math.min(d, hexDistance(hexes[i], hexes[bi])));
  }
  let groups: AxialCoord[][] = [];
  for (let iter = 0; iter <= MAP_TUNING.lloydIterations; iter++) {
    groups = floodFillBalanced(seeds, inside, rng);
    if (iter < MAP_TUNING.lloydIterations) seeds = groups.map(medoid);
  }
  return groups;
}

function partitionIsPlayable(groups: AxialCoord[][], anchors: Set<HexKey>): boolean {
  const owner = new Map<HexKey, number>();
  groups.forEach((g, i) => g.forEach(h => owner.set(hexKey(h), i)));
  return groups.every((g, i) => {
    if (g.length < MAP_TUNING.minTerritoryHexes || g.length > MAP_TUNING.maxTerritoryHexes) return false;
    const nb = new Set<number>();
    for (const h of g) for (const x of hexNeighbors(h)) {
      const o = owner.get(hexKey(x));
      if (o !== undefined && o !== i) nb.add(o);
    }
    const hasAnchor = g.some(h => anchors.has(hexKey(h)));
    return nb.size >= MAP_TUNING.minTerritoryDegree - (hasAnchor ? 1 : 0);
  });
}

function floodFillBalanced(seeds: AxialCoord[], inside: Set<HexKey>, rng: DeterministicRng): AxialCoord[][] {
  const taken = new Set<HexKey>(seeds.map(hexKey));
  const groups = seeds.map(s => [s]);
  const frontier = seeds.map(s => new Set(hexNeighbors(s).map(hexKey).filter(k => inside.has(k) && !taken.has(k))));
  for (;;) {
    let gi = -1;
    for (let i = 0; i < groups.length; i++) {
      for (const k of [...frontier[i]]) if (taken.has(k)) frontier[i].delete(k);
      if (frontier[i].size && (gi < 0 || groups[i].length < groups[gi].length)) gi = i;
    }
    if (gi < 0) break;
    const k = rng.pick([...frontier[gi]]);
    const [q, r] = k.split(',').map(Number);
    taken.add(k); groups[gi].push({ q, r }); frontier[gi].delete(k);
    for (const nb of hexNeighbors({ q, r })) {
      const nk = hexKey(nb);
      if (inside.has(nk) && !taken.has(nk)) frontier[gi].add(nk);
    }
  }
  return groups;
}

function medoid(group: AxialCoord[]): AxialCoord {
  let best = group[0]; let bestSum = Infinity;
  for (const h of group) {
    let sum = 0;
    for (const o of group) sum += hexDistance(h, o) * hexDistance(h, o);
    if (sum < bestSum) { bestSum = sum; best = h; }
  }
  return best;
}

function isConnected(adj: Set<number>[]): boolean {
  if (!adj.length) return false;
  const seen = new Set([0]); const stack = [0];
  while (stack.length) for (const n of adj[stack.pop()!]) if (!seen.has(n)) { seen.add(n); stack.push(n); }
  return seen.size === adj.length;
}

const pairKey = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);
