import '@fontsource/orbitron/500.css';
import '@fontsource/orbitron/700.css';
import '@fontsource/orbitron/900.css';
import '@fontsource/share-tech-mono/400.css';
import './ui/styles/main.css';
import { MAP_SCALE, generateMapWithReport, type MapGenReport } from './engine/mapGenerator';
import { renderMap } from './ui/components/hexMapRenderer';
import { MapCamera } from './ui/components/mapCamera';
import { NEON } from './ui/theme';

/* Map Lab: generate, inspect and share procedural maps before the full game exists. */

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const svg = document.getElementById('map') as unknown as SVGSVGElement;
const board = $('board');

const WORDS = ['NEON', 'CHROME', 'VOID', 'GHOST', 'RUST', 'HALO', 'ZERO', 'PRISM', 'OXIDE', 'CIPHER', 'STATIC', 'NOVA'];

/** Menu-level randomness only; the map itself is fully determined by the seed string. */
function randomSeed(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  const word = WORDS[bytes[0] % WORDS.length];
  return `${word}-${[...bytes.slice(1)].map(b => b.toString(36).padStart(2, '0')).join('').slice(0, 5).toUpperCase()}`;
}

const params = new URLSearchParams(location.hash.slice(1));
const state = {
  players: Math.min(8, Math.max(2, Number(params.get('p')) || 4)),
  seed: params.get('seed') || randomSeed(),
  selected: null as number | null,
  rotated: false,
  report: null as MapGenReport | null,
  ms: 0,
};

const camera = new MapCamera(board, svg, onTap, zoom => svg.classList.toggle('zoomed', zoom > 1.5));

function generate(newSeed: boolean): void {
  if (newSeed) state.seed = randomSeed();
  const t0 = performance.now();
  state.report = generateMapWithReport({ seed: state.seed, playerCount: state.players });
  state.ms = performance.now() - t0;
  state.selected = null;
  $('pill').hidden = true;
  history.replaceState(null, '', `#p=${state.players}&seed=${encodeURIComponent(state.seed)}`);
  draw(true);
  updatePanel();
}

function draw(refit: boolean): void {
  const map = state.report!.map;
  const rotate = board.clientHeight > board.clientWidth * 1.1;
  const box = renderMap(svg, map, {
    // Ownership is dealt at game start, not at map generation, so the lab only shows geography.
    colorMode: 'continent',
    rotate,
    continentLabels: true,
    selected: state.selected,
  });
  if (state.selected !== null) {
    for (const n of map.territories[state.selected].neighbors) svg.querySelector(`.terr[data-t="${n}"]`)?.classList.add('neighbor');
  }
  camera.setFitBox(box, refit || rotate !== state.rotated);
  state.rotated = rotate;
}

function onTap(target: Element): void {
  const g = target.closest('.terr');
  const map = state.report!.map;
  if (!g) { state.selected = null; $('pill').hidden = true; draw(false); return; }
  const id = Number(g.getAttribute('data-t'));
  state.selected = state.selected === id ? null : id;
  draw(false);
  const pill = $('pill');
  if (state.selected === null) { pill.hidden = true; return; }
  const t = map.territories[id];
  const c = map.continents[t.continentId];
  const color = NEON.continents[c.id];
  const links = map.chokepoints.filter(cp => cp.a === id || cp.b === id).map(cp => {
    const other = map.territories[cp.a === id ? cp.b : cp.a];
    return `<div class="link">${cp.kind === 'BRIDGE' ? '⛓ BRIDGE' : '≈ SEA LANE'} → ${other.name} <span class="meta">(${map.continents[other.continentId].name})</span></div>`;
  }).join('');
  pill.style.setProperty('--pc', color);
  pill.innerHTML = `<b>${t.name}</b> <span class="meta">· ${c.name}</span> <span class="bonus">+${c.bonus}</span>
    <div class="meta">${t.hexes.length} hexes · ${t.neighbors.length} neighbors</div>${links}`;
  pill.hidden = false;
}

function updatePanel(): void {
  const { map, rejections } = state.report!;
  $('pc-val').textContent = String(state.players);
  $('seed').textContent = state.seed;
  const bridges = map.chokepoints.filter(c => c.kind === 'BRIDGE').length;
  const lanes = map.chokepoints.length - bridges;
  const retries = Object.values(rejections).reduce((a, b) => a + (b ?? 0), 0);
  $('stats').innerHTML = [
    [map.territories.length, 'TERRITORIES', ''], [map.continents.length, 'CONTINENTS', ''],
    [bridges, 'BRIDGES', 'mag'], [lanes, 'SEA LANES', 'mag'],
  ].map(([v, l, cls]) => `<div class="stat ${cls}"><b>${v}</b><small>${l}</small></div>`).join('')
    + `<div class="stat sun" style="grid-column: span 4" title="${JSON.stringify(rejections).replace(/"/g, '')}"><small>GENERATED IN ${state.ms.toFixed(0)} MS · ${retries} RETR${retries === 1 ? 'Y' : 'IES'} · ${MAP_SCALE[state.players].territories / state.players} TERRITORIES / COMMANDER</small></div>`;
  $('legend').innerHTML = map.continents.map(c => {
    const links = map.chokepoints.filter(cp => map.territories[cp.a].continentId === c.id || map.territories[cp.b].continentId === c.id).length;
    return `<li style="--cc:${NEON.continents[c.id]}"><span class="sw"></span><span>${c.name}</span>
      <span class="n" title="⌊${c.territoryIds.length}/3⌋ + ${links} entry points">${c.territoryIds.length} terr · ${links} entr${links === 1 ? 'y' : 'ies'}</span><span class="bn">+${c.bonus}</span></li>`;
  }).join('');
}

/* ---------- controls ---------- */
const setPlayers = (n: number) => { state.players = Math.min(8, Math.max(2, n)); generate(true); };
$('pc-minus').onclick = () => setPlayers(state.players - 1);
$('pc-plus').onclick = () => setPlayers(state.players + 1);
$('generate').onclick = () => generate(true);
$('fit').onclick = () => camera.fit();
$('copy').onclick = async () => {
  await navigator.clipboard?.writeText(location.href).catch(() => undefined);
  $('copy').textContent = 'COPIED ✓';
  setTimeout(() => { $('copy').textContent = 'COPY LINK'; }, 1200);
};
addEventListener('keydown', e => { if (e.key === 'g' || e.key === ' ') { e.preventDefault(); generate(true); } });
new ResizeObserver(() => { if (state.report) draw(false); }).observe(board);
// Legend is open on desktop, collapsed on phones (keeps the map big and the Generate button in reach).
($('legend-wrap') as HTMLDetailsElement).open = matchMedia('(min-width: 900px)').matches;

generate(false);
