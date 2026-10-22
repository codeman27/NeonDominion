/* Style A (Neon Grid) map theme — shared by desktop + mobile mockups */
window.NEON_THEME = (function () {
  const { el, text } = MockMap;
  return {
  players: ['#19f6ff', '#ff2bd6', '#39ff14', '#ffb800', '#a463ff', '#ff4b4b', '#f4f4ff', '#00ffa3'],
  continentColors: ['#ff2bd6', '#19f6ff', '#ffb800', '#39ff14', '#a463ff', '#ff4b4b', '#00ffa3'],
  defs: () => `
    <filter id="glow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="2.2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <marker id="ah" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse"><path d="M0,0L10,5L0,10z" fill="#ff2bd6"/></marker>
    <marker id="ahf" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse"><path d="M0,0L10,5L0,10z" fill="#19f6ff"/></marker>`,
  layers: { borders: { filter: 'url(#glow)' }, arrows: { filter: 'url(#glow)' }, lanes: { filter: 'url(#glow)' } },
  hexAttrs: (c, t, m, o) => ({ fill: c, 'fill-opacity': o.preview ? 0.22 : 0.14, stroke: c, 'stroke-opacity': 0.2, 'stroke-width': 0.7 }),
  outlineAttrs: c => ({ stroke: c, 'stroke-width': 1.4, 'stroke-opacity': 0.85, 'stroke-linecap': 'round' }),
  continentAttrs: { stroke: '#ffffff', 'stroke-width': 2.4, 'stroke-opacity': 0.55, 'stroke-linecap': 'round' },
  coastAttrs: [{ stroke: '#19f6ff', 'stroke-width': 7, 'stroke-opacity': 0.1, 'stroke-linecap': 'round' }, { stroke: '#19f6ff', 'stroke-width': 1.8, 'stroke-linecap': 'round' }],
  laneAttrs: { stroke: '#19f6ff', 'stroke-width': 1.6, 'stroke-dasharray': '1 5', 'stroke-linecap': 'round' },
  arrowAttrs: kind => kind === 'fortify'
    ? { stroke: '#19f6ff', 'stroke-width': 2.4, 'stroke-dasharray': '4 4', class: 'flow', 'marker-end': 'url(#ahf)' }
    : { stroke: '#ff2bd6', 'stroke-width': 3, 'stroke-dasharray': '10 6', class: 'flow', 'marker-end': 'url(#ah)', 'stroke-linecap': 'round' },
  arrowLabel: (g, x, y, n, kind) => {
    const c = kind === 'fortify' ? '#19f6ff' : '#ff2bd6';
    el('circle', { cx: x, cy: y, r: 7, fill: c }, g);
    text(g, x, y + 0.5, n, { fill: '#120428', 'font-family': 'Orbitron', 'font-weight': 900, 'font-size': 8 });
  },
  badge: (g, x, y, t, c, sel) => {
    if (sel) el('circle', { cx: x, cy: y, r: 15, fill: 'none', stroke: '#ffb800', 'stroke-width': 1.4, 'stroke-dasharray': '3 3', filter: 'url(#glow)' }, g);
    el('circle', { cx: x, cy: y, r: 10, fill: '#0b0219', stroke: c, 'stroke-width': 1.8, filter: 'url(#glow)' }, g);
    text(g, x, y + 0.6, t.troops, { fill: c, 'font-family': 'Orbitron', 'font-weight': 700, 'font-size': 10 });
  },
  label: (g, x, y, t) => text(g, x, y + 17, t.name, { fill: '#ece6ff', 'fill-opacity': 0.8, 'font-family': 'Share Tech Mono', 'font-size': 6.5, 'letter-spacing': 0.8 }),
};
})();
