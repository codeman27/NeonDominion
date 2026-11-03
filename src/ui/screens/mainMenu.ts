import '../styles/menu.css';
import { MAP_SCALE, generateMap } from '../../engine/mapGenerator';
import { renderMap } from '../components/hexMapRenderer';
import { NEON } from '../theme';

const WORDS = ['NEON', 'CHROME', 'VOID', 'GHOST', 'RUST', 'HALO', 'ZERO', 'PRISM', 'OXIDE', 'CIPHER', 'STATIC', 'NOVA'];

/** Menu-level randomness only; the game itself is fully determined by the seed string. */
export function randomMapSeed(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return `${WORDS[bytes[0] % WORDS.length]}-${[...bytes.slice(1)].map(b => b.toString(36).padStart(2, '0')).join('').slice(0, 5).toUpperCase()}`;
}

export interface MenuOptions {
  onStart(settings: { playerCount: number; mapSeed: string }): void;
  onNostr(): void;
  /** Present when a saved game exists. */
  onContinue?: () => void;
}

/** Main menu (ARCHITECTURE §9.3.1). Returns an unmount function. */
export function mountMainMenu(root: HTMLElement, opts: MenuOptions): () => void {
  root.innerHTML = MENU_HTML;
  const q = <T extends HTMLElement = HTMLElement>(sel: string) => root.querySelector(sel) as T;
  const state = { players: 4, seed: randomMapSeed() };

  if (opts.onContinue) {
    const btn = q<HTMLButtonElement>('#m-continue');
    btn.hidden = false;
    btn.onclick = () => opts.onContinue!();
  }

  function refresh(): void {
    q('#pc-val').textContent = String(state.players);
    q<HTMLInputElement>('#seed').value = state.seed;
    q<HTMLButtonElement>('#pc-minus').disabled = state.players <= 2;
    q<HTMLButtonElement>('#pc-plus').disabled = state.players >= 8;
    q('#pc-dots').innerHTML = Array.from({ length: state.players }, (_, i) =>
      `<span class="${i ? '' : 'you'}" style="--pc:${NEON.players[i]}">${i ? 'BOT' : 'YOU'}</span>`).join('');
    const map = generateMap({ seed: state.seed, playerCount: state.players });
    renderMap(q('#preview') as unknown as SVGSVGElement, map, { colorMode: 'continent', preview: true });
    const lanes = map.chokepoints.filter(c => c.kind === 'SEA_LANE').length;
    q('#m-stats').innerHTML = `<b>${map.territories.length}</b> territories · <b>${map.continents.length}</b> continents · <b>${lanes}</b> sea lane${lanes === 1 ? '' : 's'}
      <br><b>${MAP_SCALE[state.players].territories / state.players}</b> territories each`;
  }

  const setPlayers = (n: number) => { state.players = Math.min(8, Math.max(2, n)); state.seed = randomMapSeed(); refresh(); };
  q('#pc-minus').onclick = () => setPlayers(state.players - 1);
  q('#pc-plus').onclick = () => setPlayers(state.players + 1);
  q('#reroll').onclick = () => { state.seed = randomMapSeed(); refresh(); };
  q<HTMLInputElement>('#seed').oninput = e => {
    state.seed = (e.target as HTMLInputElement).value.trim().toUpperCase() || randomMapSeed();
    refresh();
  };
  q('#start').onclick = () => opts.onStart({ playerCount: state.players, mapSeed: state.seed });
  q('#nostr').onclick = opts.onNostr;

  refresh();
  return () => { root.innerHTML = ''; };
}

export const MENU_BACKGROUND = '<div class="stars"></div><div class="sun"></div><div class="floor-wrap"><div class="floor"></div></div><div class="horizon"></div>';
export const MENU_HEADING = '<header class="m-title"><div class="kicker">◢ HEX WARFARE ◣</div><h1 class="title">NEON<br>DOMINION</h1></header>';

const MENU_HTML = `
<div class="menu">
  ${MENU_BACKGROUND}
  <div class="menu-col">
    ${MENU_HEADING}
    <div class="m-card glass">
      <div class="seg"><button class="active">SOLO</button><button id="nostr">MULTIPLAYER</button></div>
      <div class="row"><span class="lbl">COMMANDERS</span>
        <div class="stepper"><button id="pc-minus" aria-label="Fewer commanders">−</button><b id="pc-val">4</b><button id="pc-plus" aria-label="More commanders">+</button></div></div>
      <div class="dots" id="pc-dots"></div>
      <div class="m-prev"><svg id="preview" role="img" aria-label="Map preview"></svg><button id="reroll" class="reroll">⟳ NEW MAP</button></div>
      <div class="m-stats" id="m-stats"></div>
      <details class="adv"><summary>ADVANCED</summary>
        <input id="seed" spellcheck="false" autocapitalize="characters" aria-label="Map seed">
        <small>Same seed + same commander count = same map. Share it to replay. · <a href="?lab">Map Lab</a></small>
      </details>
    </div>
    <button id="m-continue" class="continue" hidden>▶ CONTINUE SAVED GAME</button>
    <button id="start" class="primary start">START ▸</button>
  </div>
</div>`;
