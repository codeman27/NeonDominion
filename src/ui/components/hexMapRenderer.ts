import { DIRS, hexCorners, hexKey, hexToPixel } from '../../engine/hexMath';
import type { AxialCoord, GameMap, Territory } from '../../types/game';
import { NEON } from '../theme';

const NS = 'http://www.w3.org/2000/svg';
const SIZE = 20;

export interface ViewBox { x: number; y: number; w: number; h: number }

/** A planned order drawn on the map (curved, animated). */
export interface MapArrow {
  from: number;
  to: number;
  kind: 'attack' | 'fortify';
  /** Short label in the arrow's badge, e.g. "1" or "F". */
  label: string;
}

export interface MapRenderOptions {
  /** 'continent' tints territories by continent (map lab); 'owner' uses player colors (gameplay). */
  colorMode: 'continent' | 'owner';
  owners?: readonly number[];
  troops?: readonly number[];
  /** Rotate the view 90° (portrait screens). Map data is untouched. */
  rotate?: boolean;
  badges?: boolean;
  labels?: boolean;
  continentLabels?: boolean;
  selected?: number | null;
  /** When set, these territories pulse as valid targets and every other territory (except `selected`) dims. */
  highlight?: ReadonlySet<number> | null;
  /** Territories that received troops this turn (drawn with a lime ring). */
  boosted?: ReadonlySet<number>;
  arrows?: readonly MapArrow[];
  /** Small thumbnail rendering (menu preview): thicker fills, no text. */
  preview?: boolean;
}

type Pt = { x: number; y: number };

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number | undefined>, parent?: Element): SVGElementTagNameMap[K] {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined) node.setAttribute(k, String(v));
  parent?.appendChild(node);
  return node;
}

function text(parent: Element, x: number, y: number, value: string | number, attrs: Record<string, string | number | undefined>): SVGTextElement {
  const t = el('text', { x, y, 'text-anchor': 'middle', 'dominant-baseline': 'central', ...attrs }, parent);
  t.textContent = String(value);
  return t;
}

function medoidPx(points: Pt[]): Pt {
  let best = points[0]; let bestSum = Infinity;
  for (const p of points) {
    let s = 0;
    for (const o of points) s += (p.x - o.x) ** 2 + (p.y - o.y) ** 2;
    if (s < bestSum) { bestSum = s; best = p; }
  }
  return best;
}

/** Board coordinates of a territory's badge, matching `renderMap` (including portrait rotation). */
export function territoryPoint(map: GameMap, id: number, rotate: boolean): Pt {
  const p = hexToPixel(map.territories[id].labelHex, SIZE);
  return rotate ? { x: -p.y, y: p.x } : p;
}

/** Renders the map into `svg` and returns the fitted view box (for the camera). */
export function renderMap(svg: SVGSVGElement, map: GameMap, opts: MapRenderOptions): ViewBox {
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  const rot = opts.rotate ? (p: Pt): Pt => ({ x: -p.y, y: p.x }) : (p: Pt): Pt => p;
  const center = (h: AxialCoord) => rot(hexToPixel(h, SIZE));
  const corners = (h: AxialCoord, size = SIZE) => {
    const c = hexToPixel(h, SIZE);
    return hexCorners(c.x, c.y, size).map(([x, y]) => { const r = rot({ x, y }); return [+r.x.toFixed(2), +r.y.toFixed(2)] as const; });
  };

  const hexTerr = new Map<string, Territory>();
  for (const t of map.territories) for (const h of t.hexes) hexTerr.set(hexKey(h), t);

  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const t of map.territories) for (const h of t.hexes) for (const [x, y] of corners(h)) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  const pad = SIZE * (opts.preview ? 0.4 : 1.2);
  const box: ViewBox = { x: minX - pad, y: minY - pad, w: maxX - minX + 2 * pad, h: maxY - minY + 2 * pad };
  svg.setAttribute('viewBox', `${box.x} ${box.y} ${box.w} ${box.h}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

  const pfx = `${svg.id || 'map'}-`;
  const defs = el('defs', {}, svg);
  defs.innerHTML = `
    <filter id="${pfx}glow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="2.2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <marker id="${pfx}ah-attack" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="4" markerHeight="4" orient="auto"><path d="M0,0L10,5L0,10z" fill="${NEON.mag}"/></marker>
    <marker id="${pfx}ah-fortify" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="4" markerHeight="4" orient="auto"><path d="M0,0L10,5L0,10z" fill="${NEON.cyan}"/></marker>
`;
  const glow = `url(#${pfx}glow)`;
  const layer = (name: string, attrs: Record<string, string> = {}) => el('g', { class: `layer-${name}`, ...attrs }, svg);
  const gFill = layer('fill');
  const gBorders = layer('borders', { filter: glow });
  const gInner = layer('inner-borders');
  const gLanes = layer('sea-lanes', { filter: glow });
  const gArrows = layer('arrows', { filter: glow });
  const gBadges = layer('badges');
  const gLabels = layer('labels');
  const gContinents = layer('continent-labels');

  const colorOf = (t: Territory) => opts.colorMode === 'owner' && opts.owners
    ? NEON.players[opts.owners[t.id] % NEON.players.length]
    : NEON.continents[t.continentId % NEON.continents.length];

  // Shade levels: neighbors inside the same continent never share a level, so territory
  // shapes read clearly even when every territory has the same hue (continent or owner color).
  const SHADES = opts.preview ? [0.2, 0.34, 0.12, 0.27] : [0.07, 0.3, 0.16, 0.4];
  const shade = new Map<number, number>();
  for (const t of map.territories) {
    const used = new Set(t.neighbors.filter(n => map.territories[n].continentId === t.continentId).map(n => shade.get(n)));
    let level = 0;
    while (used.has(level) && level < SHADES.length - 1) level++;
    shade.set(t.id, level);
  }

  // Hex fills, grouped per territory for hit-testing.
  for (const t of map.territories) {
    const c = colorOf(t);
    const hl = opts.highlight && opts.selected !== t.id ? (opts.highlight.has(t.id) ? ' target' : ' dim') : '';
    const g = el('g', { class: `terr${opts.selected === t.id ? ' selected' : ''}${hl}`, 'data-t': t.id }, gFill);
    for (const h of t.hexes) {
      el('polygon', {
        class: 'hex',
        points: corners(h).map(p => p.join(',')).join(' '),
        fill: c,
        'fill-opacity': SHADES[shade.get(t.id)!],
        stroke: c, 'stroke-opacity': 0.12, 'stroke-width': 0.6,
      }, g);
    }
  }

  // Borders: glowing coastline, white continent junctions, and crisp "etched" lines between
  // territories (dark gap + bright line) so internal borders don't blend into the hex grid.
  let coast = ''; let continentEdge = ''; let innerEdge = '';
  for (const t of map.territories) {
    for (const h of t.hexes) {
      const c = corners(h);
      DIRS.forEach((d, i) => {
        const n = hexTerr.get(hexKey({ q: h.q + d.q, r: h.r + d.r }));
        if (n === t) return;
        const seg = `M${c[i][0]},${c[i][1]}L${c[(i + 1) % 6][0]},${c[(i + 1) % 6][1]}`;
        if (!n) coast += seg;
        else if (t.id < n.id) {
          if (n.continentId !== t.continentId) continentEdge += seg; else innerEdge += seg;
        }
      });
    }
  }
  el('path', { d: coast, fill: 'none', stroke: NEON.cyan, 'stroke-width': 7, 'stroke-opacity': 0.1, 'stroke-linecap': 'round' }, gBorders);
  el('path', { d: coast, fill: 'none', stroke: NEON.cyan, 'stroke-width': 1.8, 'stroke-linecap': 'round' }, gBorders);
  if (continentEdge) el('path', { d: continentEdge, fill: 'none', stroke: '#fff', 'stroke-width': 2.6, 'stroke-opacity': 0.8, 'stroke-linecap': 'round' }, gBorders);
  if (innerEdge && !opts.preview) {
    el('path', { d: innerEdge, fill: 'none', stroke: NEON.bg, 'stroke-width': 3.2, 'stroke-linecap': 'round' }, gInner);
    el('path', { d: innerEdge, fill: 'none', stroke: '#fff', 'stroke-width': 1.1, 'stroke-opacity': 0.75, 'stroke-linecap': 'round' }, gInner);
  }

  // Sea lanes are the only non-obvious connection, so they stay visible as dotted links.
  for (const cp of map.chokepoints) {
    if (cp.kind !== 'SEA_LANE') continue;
    const a = center(cp.from); const b = center(cp.to);
    el('path', { class: 'lane', d: `M${a.x},${a.y}L${b.x},${b.y}`, stroke: NEON.cyan, 'stroke-width': 1.8, 'stroke-dasharray': '1 5', 'stroke-linecap': 'round', fill: 'none' }, gLanes);
    for (const p of [a, b]) el('circle', { cx: p.x, cy: p.y, r: 2.6, fill: NEON.cyan }, gLanes);
  }

  for (const a of opts.arrows ?? []) {
    const A = center(map.territories[a.from].labelHex); const B = center(map.territories[a.to].labelHex);
    const dx = B.x - A.x; const dy = B.y - A.y; const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len; const uy = dy / len;
    const s = { x: A.x + ux * 12, y: A.y + uy * 12 }; const e = { x: B.x - ux * 15, y: B.y - uy * 15 };
    const c = { x: (s.x + e.x) / 2 - uy * len * 0.22, y: (s.y + e.y) / 2 + ux * len * 0.22 };
    const color = a.kind === 'attack' ? NEON.mag : NEON.cyan;
    el('path', {
      class: 'flow', d: `M${s.x},${s.y}Q${c.x},${c.y} ${e.x},${e.y}`, fill: 'none', stroke: color, 'stroke-width': a.kind === 'attack' ? 3 : 2.4,
      'stroke-dasharray': a.kind === 'attack' ? '10 6' : '4 4', 'stroke-linecap': 'round', 'marker-end': `url(#${pfx}ah-${a.kind})`,
    }, gArrows);
    const mx = 0.25 * s.x + 0.5 * c.x + 0.25 * e.x; const my = 0.25 * s.y + 0.5 * c.y + 0.25 * e.y;
    el('circle', { cx: mx, cy: my, r: 7, fill: color }, gArrows);
    text(gArrows, mx, my + 0.5, a.label, { fill: '#120428', 'font-family': NEON.fontDisplay, 'font-weight': 900, 'font-size': 8 });
  }

  if (!opts.preview) {
    for (const t of map.territories) {
      const p = center(t.labelHex); const c = colorOf(t);
      if (opts.badges !== false) {
        if (opts.troops) {
          if (opts.boosted?.has(t.id)) el('circle', { cx: p.x, cy: p.y, r: 13.5, fill: 'none', stroke: NEON.lime, 'stroke-width': 1.6, 'stroke-dasharray': '3 2' }, gBadges);
          if (opts.selected === t.id) el('circle', { class: 'sel-ring', cx: p.x, cy: p.y, r: 15, fill: 'none', stroke: NEON.sun, 'stroke-width': 1.6, 'stroke-dasharray': '3 3' }, gBadges);
          el('circle', { cx: p.x, cy: p.y, r: 10, fill: '#0b0219', stroke: c, 'stroke-width': 1.8, filter: glow }, gBadges);
          text(gBadges, p.x, p.y + 0.6, opts.troops[t.id], { fill: c, 'font-family': NEON.fontDisplay, 'font-weight': 700, 'font-size': 10 });
        } else {
          el('circle', { cx: p.x, cy: p.y, r: 3.2, fill: c, filter: glow }, gBadges);
        }
      }
      if (opts.labels !== false) {
        text(gLabels, p.x, p.y + (opts.troops ? 17 : 10), t.name, { class: 'tlabel', fill: NEON.txt, 'fill-opacity': 0.85, 'font-family': NEON.fontMono, 'font-size': 6.5, 'letter-spacing': 0.8 });
      }
    }
    if (opts.continentLabels) {
      for (const c of map.continents) {
        const pts = c.territoryIds.flatMap(id => map.territories[id].hexes.map(center));
        const m = medoidPx(pts);
        const g = el('g', { class: 'clabel' }, gContinents);
        const common = { stroke: '#07010f', 'stroke-width': 3.5, 'paint-order': 'stroke', 'font-family': NEON.fontDisplay, 'font-weight': 900 };
        text(g, m.x, m.y - 6, c.name, { ...common, fill: NEON.continents[c.id % NEON.continents.length], 'font-size': 10, 'letter-spacing': 1.5 });
        text(g, m.x, m.y + 7, `+${c.bonus}`, { ...common, fill: NEON.sun, 'font-size': 11 });
      }
    }
  }
  return box;
}
