import { DIRS, hexCorners, hexKey, hexToPixel } from '../../engine/hexMath';
import type { AxialCoord, GameMap, Territory } from '../../types/game';
import { NEON } from '../theme';

const NS = 'http://www.w3.org/2000/svg';
const SIZE = 20;

export interface ViewBox { x: number; y: number; w: number; h: number }

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
`;
  const glow = `url(#${pfx}glow)`;
  const layer = (name: string, attrs: Record<string, string> = {}) => el('g', { class: `layer-${name}`, ...attrs }, svg);
  const gFill = layer('fill');
  const gBorders = layer('borders', { filter: glow });
  const gInner = layer('inner-borders');
  const gLanes = layer('sea-lanes', { filter: glow });
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
    const g = el('g', { class: `terr${opts.selected === t.id ? ' selected' : ''}`, 'data-t': t.id }, gFill);
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

  if (!opts.preview) {
    for (const t of map.territories) {
      const p = center(t.labelHex); const c = colorOf(t);
      if (opts.badges !== false) {
        if (opts.troops) {
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
