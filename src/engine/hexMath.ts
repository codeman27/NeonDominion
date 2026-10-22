import type { AxialCoord } from '../types/game';

/** Pointy-top axial directions. DIRS[i] is the neighbor across the edge between corner i and corner i+1. */
export const DIRS: readonly AxialCoord[] = [
  { q: 1, r: 0 }, { q: 0, r: 1 }, { q: -1, r: 1 },
  { q: -1, r: 0 }, { q: 0, r: -1 }, { q: 1, r: -1 },
];

export type HexKey = string;

export const hexKey = (h: AxialCoord): HexKey => `${h.q},${h.r}`;

export function parseHexKey(key: HexKey): AxialCoord {
  const i = key.indexOf(',');
  return { q: Number(key.slice(0, i)), r: Number(key.slice(i + 1)) };
}

export function hexDistance(a: AxialCoord, b: AxialCoord): number {
  const dq = a.q - b.q;
  const dr = a.r - b.r;
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
}

export function hexNeighbors(h: AxialCoord): AxialCoord[] {
  return DIRS.map(d => ({ q: h.q + d.q, r: h.r + d.r }));
}

/** All hexes within `radius` of the origin, excluding the origin itself. */
export function hexOffsetsWithin(radius: number): AxialCoord[] {
  const out: AxialCoord[] = [];
  for (let q = -radius; q <= radius; q++) {
    for (let r = Math.max(-radius, -q - radius); r <= Math.min(radius, -q + radius); r++) {
      if (q !== 0 || r !== 0) out.push({ q, r });
    }
  }
  return out;
}

/** Odd-r offset (col,row) → axial. */
export function offsetToAxial(col: number, row: number): AxialCoord {
  return { q: col - (row - (row & 1)) / 2, r: row };
}

function cubeRound(q: number, r: number): AxialCoord {
  const s = -q - r;
  let rq = Math.round(q);
  let rr = Math.round(r);
  const rs = Math.round(s);
  const dq = Math.abs(rq - q);
  const dr = Math.abs(rr - r);
  const ds = Math.abs(rs - s);
  if (dq > dr && dq > ds) rq = -rr - rs;
  else if (dr > ds) rr = -rq - rs;
  return { q: rq + 0, r: rr + 0 };
}

/** Hexes on the straight line from a to b inclusive (uses only IEEE-exact + - * / so it is deterministic). */
export function hexLine(a: AxialCoord, b: AxialCoord): AxialCoord[] {
  const n = hexDistance(a, b);
  const out: AxialCoord[] = [];
  // Tiny nudge keeps rounding consistent when the line passes exactly between two hexes.
  const aq = a.q + 1e-6; const ar = a.r + 1e-6;
  const bq = b.q + 1e-6; const br = b.r + 1e-6;
  for (let i = 0; i <= n; i++) {
    const t = n === 0 ? 0 : i / n;
    out.push(cubeRound(aq + (bq - aq) * t, ar + (br - ar) * t));
  }
  return out;
}

/* ---------- Pixel geometry (rendering only; never used for game logic) ---------- */

export const SQRT3 = Math.sqrt(3);

export function hexToPixel(h: AxialCoord, size: number): { x: number; y: number } {
  return { x: size * SQRT3 * (h.q + h.r / 2), y: size * 1.5 * h.r };
}

export function hexCorners(cx: number, cy: number, size: number): [number, number][] {
  const pts: [number, number][] = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 180) * (60 * i - 30);
    pts.push([cx + size * Math.cos(a), cy + size * Math.sin(a)]);
  }
  return pts;
}
