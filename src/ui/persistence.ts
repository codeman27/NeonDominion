import { LocalGame, type LocalGameSave } from '../transport/localTransport';

/*
 * Single-player autosave. The save holds the public event log *and* the private hash-chain roots for
 * every seat — fine for single player (the client already holds all chains), never do this in Phase 2.
 */
const KEY = 'nd.save.v1';

export function saveGame(game: LocalGame): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(game.save()));
  } catch {
    // Storage full or unavailable (private mode): the game keeps running, it just can't resume.
  }
}

/** Restores (and fully re-verifies) the saved game; returns null and discards the save if it's unusable. */
export function loadGame(): LocalGame | null {
  const raw = localStorage.getItem(KEY);
  if (!raw) return null;
  try {
    return LocalGame.restore(JSON.parse(raw) as LocalGameSave);
  } catch {
    clearSave();
    return null;
  }
}

/** True if there's a saved game that isn't finished. */
export function hasResumableGame(): boolean {
  const game = loadGame();
  return !!game && game.getState().phase !== 'GAME_OVER';
}

export function clearSave(): void {
  localStorage.removeItem(KEY);
}
