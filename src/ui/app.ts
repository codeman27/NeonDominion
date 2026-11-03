import { LocalGame } from '../transport/localTransport';
import { clearSave, hasResumableGame, loadGame, saveGame } from './persistence';
import { mountGameScreen } from './screens/gameScreen';
import { mountMainMenu } from './screens/mainMenu';
import { mountMapLab } from './screens/mapLab';
import { mountNostrMenu } from './screens/nostrMenu';
import type { NostrIdentity } from '../nostr/identity';
import { mountNostrLobby } from './screens/nostrLobby';

type Unmount = () => void;

/** Screen router: menu ↔ game; `?lab` opens the Map Lab directly. */
export function startApp(root: HTMLElement): void {
  let unmount: Unmount | null = null;
  let identity: NostrIdentity | null = null;
  const swap = (next: () => Unmount) => { unmount?.(); unmount = next(); };

  if (new URLSearchParams(location.search).has('lab')) {
    swap(() => mountMapLab(root));
    return;
  }

  const showNostr = () => swap(() => mountNostrMenu(root, {
      identity,
      onIdentity: connected => { identity = connected; },
      onSolo: showMenu,
      onLobby: (connected, name, mode, gameId) => swap(() => mountNostrLobby(root, { identity: connected, name, mode, gameId, onBack: showNostr })),
    }));
  const showMenu = () => swap(() => mountMainMenu(root, {
    onNostr: showNostr,
    onStart: ({ playerCount, mapSeed }) => {
      const game = LocalGame.create({ playerCount, mapSeed });
      saveGame(game);
      showGame(game);
    },
    onContinue: hasResumableGame() ? () => { const g = loadGame(); if (g) showGame(g); else showMenu(); } : undefined,
  }));

  const showGame = (game: LocalGame) => swap(() => mountGameScreen(root, game, {
    onExit: () => { if (game.getState().phase === 'GAME_OVER') clearSave(); showMenu(); },
    onChange: g => { if (g.getState().phase === 'GAME_OVER') clearSave(); else saveGame(g); },
  }));

  showMenu();
}
