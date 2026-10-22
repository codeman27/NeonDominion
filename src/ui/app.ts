import { LocalGame } from '../transport/localTransport';
import { mountMainMenu } from './screens/mainMenu';
import { mountMapLab } from './screens/mapLab';

type Unmount = () => void;

/** Screen router: menu ↔ game; `?lab` opens the Map Lab directly. */
export function startApp(root: HTMLElement): void {
  let unmount: Unmount | null = null;
  const swap = (next: () => Unmount) => { unmount?.(); unmount = next(); };

  if (new URLSearchParams(location.search).has('lab')) {
    swap(() => mountMapLab(root));
    return;
  }

  const showMenu = () => swap(() => mountMainMenu(root, {
    onStart: ({ playerCount, mapSeed }) => showGame(LocalGame.create({ playerCount, mapSeed })),
  }));

  const showGame = (game: LocalGame) => swap(() => mountGamePlaceholder(root, game, showMenu));

  showMenu();
}

/** Temporary until steps 1.15–1.16 add the real game screen. */
function mountGamePlaceholder(root: HTMLElement, game: LocalGame, onExit: () => void): Unmount {
  const s = game.getState();
  root.innerHTML = `<div style="padding:24px;display:grid;gap:12px">
    <b style="font:900 18px var(--display)">GAME CREATED</b>
    <span>${s.players.length} commanders · ${game.map.territories.length} territories · phase ${s.phase}</span>
    <button class="primary" id="back">◂ MENU</button></div>`;
  (root.querySelector('#back') as HTMLButtonElement).onclick = onExit;
  return () => { root.innerHTML = ''; };
}
