import { LocalGame } from '../transport/localTransport';
import { mountGameScreen } from './screens/gameScreen';
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

  const showGame = (game: LocalGame) => swap(() => mountGameScreen(root, game, { onExit: showMenu }));

  showMenu();
}
