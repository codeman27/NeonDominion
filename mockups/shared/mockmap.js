/* Throwaway mockup-only hex-cluster map generator + themeable SVG renderer.
   Not the production engine — just enough to evaluate art direction. */
(function (global) {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';
  const SQRT3 = Math.sqrt(3);
  const S = 20;
  // Pointy-top axial directions; DIRS[i] is the neighbor across the edge between corner i and i+1.
  const DIRS = [[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]];
  const key = (q, r) => q + ',' + r;
  const hexDist = (a, b) => (Math.abs(a.q - b.q) + Math.abs(a.r - b.r) + Math.abs(a.q + a.r - b.q - b.r)) / 2;
  const toPx = (q, r) => ({ x: S * SQRT3 * (q + r / 2), y: S * 1.5 * r });

  function hashStr(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const TERRITORY_NAMES = ['NEO-KYOTO', 'SECTOR 7', 'RUSTWATER', 'CHROME HILL', 'THE SPRAWL', 'VOLT YARD', 'GHOSTLINE',
    'KILN DOCKS', 'ARCOLOGY 9', 'NULL HARBOR', 'SIGNAL PEAK', 'DATA FENS', 'IRONVEIL', 'SYNAPSE', 'LOW CITY',
    'HALO RIDGE', 'BLACKWIRE', 'OXIDE FLATS', 'PRISM BAY', 'CINDERGATE', 'MAGLEV 3', 'THE STACKS', 'NEON MILE',
    'QUARANTINE', 'VECTOR', 'COLDSINK', 'RELAY ONE', 'SHARD', 'OVERPASS', 'PULSE', 'HELIX', 'UNDERGRID',
    'SALT VAULT', 'ZERO DAY', 'BLOOM', 'ECHO PIER', 'TITAN WORKS', 'FLUX', 'STATIC', 'DEADZONE', 'KAIJU BAY',
    'OMEGA', 'PIXEL ROW', 'STRATA', 'AFTERGLOW', 'MERIDIAN', 'GRAYMARKET', 'LAST LIGHT'];
  const CONTINENT_NAMES = ['CHROME BELT', 'NEON DELTA', 'THE UNDERGRID', 'IRON MESA', 'VOID MARCH', 'DATA REACH', 'RUST COAST'];
  const PLAYER_NAMES = ['YOU', 'BOT-ALPHA', 'BOT-BRAVO', 'BOT-CIPHER', 'BOT-DELTA', 'BOT-ECHO', 'BOT-FLUX', 'BOT-GHOST'];
  const CFG = { 2: { t: 14, c: 3 }, 3: { t: 21, c: 4 }, 4: { t: 28, c: 5 }, 5: { t: 30, c: 5 }, 6: { t: 36, c: 6 }, 7: { t: 42, c: 6 }, 8: { t: 48, c: 7 } };

  function components(ids, neighborsOf) {
    const seen = new Set(); const comps = [];
    for (const id of ids) {
      if (seen.has(id)) continue;
      const comp = []; const stack = [id]; seen.add(id);
      while (stack.length) {
        const c = stack.pop(); comp.push(c);
        for (const n of neighborsOf(c)) if (!seen.has(n)) { seen.add(n); stack.push(n); }
      }
      comps.push(comp);
    }
    return comps;
  }

  function generate(opts) {
    const players = Math.min(8, Math.max(2, opts.players || 4));
    const seed = String(opts.seed || 'NEON-77');
    const T = CFG[players].t; const C = CFG[players].c;
    const rng = mulberry32(hashStr(seed + '|' + players));
    const pick = arr => arr[Math.floor(rng() * arr.length)];
    const hexNeighbors = (land, h) => DIRS.map(d => key(h.q + d[0], h.r + d[1])).filter(k => land.has(k));

    // 1. Ragged rectangular landmass
    const targetHexes = Math.round(T * 7.2);
    const rows = Math.max(6, Math.round(Math.sqrt(targetHexes / 1.75)));
    const cols = Math.round(targetHexes / rows);
    const land = new Map();
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const q = col - (row - (row & 1)) / 2; const r = row;
        const edge = Math.min(row, rows - 1 - row, col, cols - 1 - col);
        if (edge === 0 && rng() < 0.45) continue;
        land.set(key(q, r), { q, r });
      }
    }
    // 2. Lakes and a channel for chokepoints
    const pool = [...land.values()];
    const lakes = 1 + Math.floor(players / 3);
    for (let i = 0; i < lakes; i++) {
      const c = pick(pool);
      for (const h of pool) if (hexDist(h, c) <= 1 && rng() < 0.7) land.delete(key(h.q, h.r));
    }
    {
      let cur = pick([...land.values()]); let dir = Math.floor(rng() * 6);
      for (let i = 0; i < Math.floor(rows * 0.6); i++) {
        land.delete(key(cur.q, cur.r));
        if (rng() < 0.3) dir = (dir + (rng() < 0.5 ? 1 : 5)) % 6;
        cur = { q: cur.q + DIRS[dir][0], r: cur.r + DIRS[dir][1] };
      }
    }
    for (const comp of components([...land.keys()], k => hexNeighbors(land, land.get(k)))) {
      if (comp.length < 6) comp.forEach(k => land.delete(k));
    }

    // 3. Territory seeds via farthest-point sampling
    const hexList = [...land.values()];
    const seeds = [pick(hexList)];
    let minD = hexList.map(h => hexDist(h, seeds[0]));
    while (seeds.length < T) {
      let best = -1; let bi = 0;
      for (let i = 0; i < hexList.length; i++) { const v = minD[i] + rng() * 0.8; if (v > best) { best = v; bi = i; } }
      const s = hexList[bi]; seeds.push(s);
      minD = minD.map((d, i) => Math.min(d, hexDist(hexList[i], s)));
    }

    // 4. Balanced flood-fill growth (smallest territory grows next)
    const hexTerr = new Map();
    const terr = seeds.map((s, i) => ({ id: i, hexes: [s] }));
    seeds.forEach((s, i) => hexTerr.set(key(s.q, s.r), i));
    for (;;) {
      const order = terr.slice().sort((a, b) => a.hexes.length - b.hexes.length || (rng() - 0.5));
      let grew = false;
      for (const t of order) {
        const cand = [];
        for (const h of t.hexes) for (const k of hexNeighbors(land, h)) if (!hexTerr.has(k)) cand.push(k);
        if (!cand.length) continue;
        const k = pick(cand); hexTerr.set(k, t.id); t.hexes.push(land.get(k)); grew = true; break;
      }
      if (!grew) break;
    }
    for (const k of [...land.keys()]) if (!hexTerr.has(k)) land.delete(k);

    // 5. Territory metadata
    const names = TERRITORY_NAMES.slice();
    for (let i = names.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [names[i], names[j]] = [names[j], names[i]]; }
    for (const t of terr) {
      const px = t.hexes.map(h => toPx(h.q, h.r));
      const cx = px.reduce((a, p) => a + p.x, 0) / px.length; const cy = px.reduce((a, p) => a + p.y, 0) / px.length;
      let bi = 0; let bd = Infinity;
      px.forEach((p, i) => { const d = (p.x - cx) ** 2 + (p.y - cy) ** 2; if (d < bd) { bd = d; bi = i; } });
      t.center = px[bi];
      t.name = names[t.id];
      t.adj = new Set();
      for (const h of t.hexes) for (const k of hexNeighbors(land, h)) { const o = hexTerr.get(k); if (o !== t.id) t.adj.add(o); }
    }

    // 6. Sea lanes to guarantee connectivity
    const lanes = [];
    const ids = terr.map(t => t.id);
    let comps = components(ids, id => terr[id].adj);
    while (comps.length > 1) {
      let best = null;
      for (const other of comps.slice(1)) {
        for (const a of comps[0]) for (const b of other) {
          for (const ha of terr[a].hexes) for (const hb of terr[b].hexes) {
            const d = hexDist(ha, hb);
            if (!best || d < best.d) best = { a, b, d, ha, hb };
          }
        }
      }
      terr[best.a].adj.add(best.b); terr[best.b].adj.add(best.a);
      lanes.push({ a: best.a, b: best.b, p1: toPx(best.ha.q, best.ha.r), p2: toPx(best.hb.q, best.hb.r) });
      comps = components(ids, id => terr[id].adj);
    }

    // 7. Contiguous continents via balanced graph growth
    const bfs = src => {
      const d = new Array(T).fill(Infinity); d[src] = 0; const q = [src];
      while (q.length) { const c = q.shift(); for (const n of terr[c].adj) if (d[n] === Infinity) { d[n] = d[c] + 1; q.push(n); } }
      return d;
    };
    const cSeeds = [Math.floor(rng() * T)];
    let md = bfs(cSeeds[0]);
    while (cSeeds.length < C) {
      let bi = 0; let bv = -1;
      md.forEach((v, i) => { const s = v + rng() * 0.5; if (s > bv) { bv = s; bi = i; } });
      cSeeds.push(bi); const d2 = bfs(bi); md = md.map((v, i) => Math.min(v, d2[i]));
    }
    const continents = cSeeds.map((s, i) => ({ id: i, name: CONTINENT_NAMES[i], territoryIds: [s] }));
    terr.forEach(t => { t.continent = -1; });
    cSeeds.forEach((s, i) => { terr[s].continent = i; });
    for (;;) {
      const order = continents.slice().sort((a, b) => a.territoryIds.length - b.territoryIds.length || (rng() - 0.5));
      let grew = false;
      for (const c of order) {
        const cand = [];
        for (const tid of c.territoryIds) for (const n of terr[tid].adj) if (terr[n].continent === -1) cand.push(n);
        if (!cand.length) continue;
        const n = pick(cand); terr[n].continent = c.id; c.territoryIds.push(n); grew = true; break;
      }
      if (!grew) break;
    }
    for (const c of continents) {
      const borders = c.territoryIds.filter(tid => [...terr[tid].adj].some(n => terr[n].continent !== c.id)).length;
      c.bonus = Math.max(2, Math.min(7, Math.round(c.territoryIds.length * 0.45 + borders * 0.4)));
    }

    // 8. Deal owners & troops
    const deal = ids.slice();
    for (let i = deal.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [deal[i], deal[j]] = [deal[j], deal[i]]; }
    deal.forEach((tid, i) => { terr[tid].owner = i % players; terr[tid].troops = 1 + Math.floor(rng() * 6); });

    // 9. Sample turn plan for player 0 (chained attack + second attack + fortify)
    const plan = { attacks: [], fortify: null, selected: null };
    const mine = terr.filter(t => t.owner === 0);
    const enemyAdj = t => [...t.adj].filter(n => terr[n].owner !== 0);
    outer: for (const a of mine) {
      for (const b of enemyAdj(a)) {
        const c = [...terr[b].adj].find(n => n !== a.id && terr[n].owner !== 0);
        if (c !== undefined) {
          a.troops = 11;
          plan.attacks.push({ from: a.id, to: b, chain: false }, { from: b, to: c, chain: true });
          plan.selected = a.id;
          break outer;
        }
      }
    }
    const used = new Set(plan.attacks.flatMap(x => [x.from, x.to]));
    for (const d of mine) {
      if (used.has(d.id)) continue;
      const e = enemyAdj(d).find(n => !used.has(n));
      if (e !== undefined) { d.troops = 7; plan.attacks.push({ from: d.id, to: e, chain: false }); used.add(d.id); used.add(e); break; }
    }
    for (const f of mine) {
      if (used.has(f.id)) continue;
      const tgt = [...f.adj].find(n => terr[n].owner === 0);
      if (tgt !== undefined) { f.troops = Math.max(f.troops, 5); plan.fortify = { from: f.id, to: tgt, troops: f.troops - 1 }; break; }
    }

    const playerStats = Array.from({ length: players }, (_, i) => ({
      name: PLAYER_NAMES[i],
      territories: terr.filter(t => t.owner === i).length,
      troops: terr.filter(t => t.owner === i).reduce((a, t) => a + t.troops, 0),
    }));

    return { seed, players: playerStats, T, C, hexCount: land.size, territories: terr, continents, lanes, hexTerr, plan, rng };
  }

  /* ---------------- Rendering ---------------- */

  function el(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    if (attrs) for (const k in attrs) if (attrs[k] !== null && attrs[k] !== undefined) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  function text(parent, x, y, str, attrs) {
    const t = el('text', Object.assign({ x, y, 'text-anchor': 'middle', 'dominant-baseline': 'central' }, attrs), parent);
    t.textContent = str;
    return t;
  }
  function corners(cx, cy, size) {
    const pts = [];
    for (let i = 0; i < 6; i++) {
      const a = Math.PI / 180 * (60 * i - 30);
      pts.push([+(cx + size * Math.cos(a)).toFixed(2), +(cy + size * Math.sin(a)).toFixed(2)]);
    }
    return pts;
  }
  function drawPath(parent, d, attrs) {
    if (!d || !attrs) return;
    (Array.isArray(attrs) ? attrs : [attrs]).forEach(a => el('path', Object.assign({ d, fill: 'none' }, a), parent));
  }

  function render(svg, map, theme, o) {
    const opt = Object.assign({ labels: true, badges: true, arrows: true, preview: false, rotate: false, highlight: null }, o);
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    // Optional 90° view rotation for portrait screens; map data is untouched.
    const rot = opt.rotate ? p => ({ x: -p.y, y: p.x }) : p => p;
    const rc = (cx, cy, size) => corners(cx, cy, size).map(([x, y]) => { const r = rot({ x, y }); return [+r.x.toFixed(2), +r.y.toFixed(2)]; });
    const center = t => rot(t.center);

    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
    for (const t of map.territories) for (const h of t.hexes) {
      const p = toPx(h.q, h.r);
      for (const [x, y] of rc(p.x, p.y, S)) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    }
    const pad = (opt.preview ? 0.6 : (theme.pad || 1.4)) * S;
    const box = { x: minX - pad, y: minY - pad, w: maxX - minX + 2 * pad, h: maxY - minY + 2 * pad };
    svg.setAttribute('viewBox', `${box.x} ${box.y} ${box.w} ${box.h}`);
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

    const defs = el('defs', null, svg);
    defs.innerHTML = theme.defs ? theme.defs(map) : '';
    const layer = name => el('g', Object.assign({ class: 'layer-' + name }, (theme.layers && theme.layers[name]) || {}), svg);
    const gBg = layer('bg'); const gFill = layer('fill'); const gBorders = layer('borders'); const gLanes = layer('lanes');
    const gArrows = layer('arrows'); const gBadges = layer('badges'); const gLabels = layer('labels');
    if (theme.background) theme.background(gBg, box, map, opt);

    const color = t => theme.players[t.owner];
    const hexSize = S * (theme.hexInset || 1);
    for (const t of map.territories) {
      const sel = opt.arrows && map.plan.selected === t.id;
      const hl = opt.highlight ? (opt.highlight.has(t.id) ? ' target' : ' dim') : '';
      const g = el('g', { class: 'terr' + (sel ? ' selected' : '') + hl, 'data-t': t.id }, gFill);
      el('title', null, g).textContent = `${t.name} · ${map.players[t.owner].name} · ${t.troops} troops`;
      for (const h of t.hexes) {
        const p = toPx(h.q, h.r);
        el('polygon', Object.assign({ class: 'hex', points: rc(p.x, p.y, hexSize).map(c => c.join(',')).join(' ') },
          theme.hexAttrs(color(t), t, map, opt)), g);
      }
    }

    let coast = ''; let tEdge = ''; let cEdge = ''; const outline = {};
    for (const t of map.territories) {
      outline[t.id] = '';
      for (const h of t.hexes) {
        const p = toPx(h.q, h.r); const c = rc(p.x, p.y, S);
        for (let i = 0; i < 6; i++) {
          const nt = map.hexTerr.get(key(h.q + DIRS[i][0], h.r + DIRS[i][1]));
          const seg = `M${c[i][0]},${c[i][1]}L${c[(i + 1) % 6][0]},${c[(i + 1) % 6][1]}`;
          if (nt === undefined) { coast += seg; outline[t.id] += seg; }
          else if (nt !== t.id) {
            outline[t.id] += seg;
            if (t.id < nt) { if (map.territories[nt].continent !== t.continent) cEdge += seg; else tEdge += seg; }
          }
        }
      }
    }
    if (theme.outlineAttrs) for (const t of map.territories) drawPath(gBorders, outline[t.id], theme.outlineAttrs(color(t), t));
    drawPath(gBorders, tEdge, theme.edgeAttrs);
    drawPath(gBorders, cEdge, theme.continentAttrs);
    drawPath(gBorders, coast, theme.coastAttrs);

    for (const l of map.lanes) { const a = rot(l.p1); const b = rot(l.p2); drawPath(gLanes, `M${a.x},${a.y}L${b.x},${b.y}`, theme.laneAttrs); }

    if (opt.arrows) {
      const list = map.plan.attacks.map((a, i) => Object.assign({}, a, { kind: 'attack', n: i + 1 }));
      if (map.plan.fortify) list.push(Object.assign({}, map.plan.fortify, { kind: 'fortify', n: 'F' }));
      for (const a of list) {
        const A = center(map.territories[a.from]); const B = center(map.territories[a.to]);
        const dx = B.x - A.x; const dy = B.y - A.y; const len = Math.hypot(dx, dy) || 1;
        const ux = dx / len; const uy = dy / len;
        const s = { x: A.x + ux * 14, y: A.y + uy * 14 }; const e = { x: B.x - ux * 17, y: B.y - uy * 17 };
        const bend = len * 0.22;
        const c = { x: (s.x + e.x) / 2 - uy * bend, y: (s.y + e.y) / 2 + ux * bend };
        drawPath(gArrows, `M${s.x},${s.y}Q${c.x},${c.y} ${e.x},${e.y}`, theme.arrowAttrs(a.kind, a));
        const mx = 0.25 * s.x + 0.5 * c.x + 0.25 * e.x; const my = 0.25 * s.y + 0.5 * c.y + 0.25 * e.y;
        if (theme.arrowLabel) theme.arrowLabel(gArrows, mx, my, a.n, a.kind);
      }
    }

    for (const t of map.territories) {
      const sel = opt.arrows && map.plan.selected === t.id;
      const c = center(t);
      if (opt.badges && theme.badge) theme.badge(gBadges, c.x, c.y, t, color(t), sel);
      if (opt.labels && theme.label) theme.label(gLabels, c.x, c.y, t, color(t));
    }

    // Scope <defs> ids per-SVG so a hidden SVG with the same ids can't hijack url(#…) references.
    const pfx = (svg.id || 'svg') + '-';
    svg.querySelectorAll('defs [id]').forEach(n => { n.id = pfx + n.id; });
    svg.querySelectorAll('*').forEach(n => {
      for (const a of [...n.attributes]) if (a.value.includes('url(#')) n.setAttribute(a.name, a.value.replace(/url\(#/g, 'url(#' + pfx));
    });
    return box;
  }

  global.MockMap = { generate, render, el, text, corners, hash: hashStr, mulberry32, S };
})(window);
