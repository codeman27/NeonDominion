import '../styles/menu.css';
import { npubEncode } from 'nostr-tools/nip19';
import { browserExtension, connectExtension, connectGuest, connectNsec, forgetGuest, rememberLogin, restoreGuest, type NostrIdentity } from '../../nostr/identity';
import { generatedName, loadDisplayName, saveDisplayName } from '../../nostr/profile';
import { loadSavedLobbies, savedLobbyDescription } from '../../nostr/savedLobby';
import { MENU_BACKGROUND, MENU_HEADING } from './mainMenu';

export interface NostrMenuOptions {
  identity: NostrIdentity | null;
  onIdentity(identity: NostrIdentity | null): void;
  onSolo(): void;
  onLobby(identity: NostrIdentity, name: string, mode: 'host' | 'join' | 'resume', gameId?: string): void;
}

/** Identity setup and entry to relay-backed, host-approved lobbies. */
export function mountNostrMenu(root: HTMLElement, opts: NostrMenuOptions): () => void {
  root.innerHTML = `
    <div class="menu">
      ${MENU_BACKGROUND}
      <div class="menu-col nostr-menu multiplayer-menu">
      ${MENU_HEADING}
      <section class="m-card glass">
        <div class="seg" aria-label="Game mode"><button id="n-solo">SOLO</button><button class="active" aria-current="page" id="n-multiplayer">MULTIPLAYER</button></div>
        <section id="n-home" aria-label="Multiplayer">
        <details class="multiplayer-help">
          <summary aria-label="Multiplayer help">?</summary>
          <div>
            <p>Invite 2–8 commanders. Take your turn when it suits you; your friends can play theirs later.</p>
            <p>Create an account first, then host a game and share the invite, or join a friend's game.</p>
            <p>My Games keeps your existing seats. Choose a game to continue. Use the same browser and site address.</p>
            <p>Play with people you trust. Games use public Nostr relays and are not encrypted. Moves are checked, but modified apps can manipulate dice before sharing an attack.</p>
          </div>
        </details>
        <button class="continue" id="n-games-open" hidden>MY GAMES</button>
        <p id="n-account-summary"></p>
        <button class="continue" id="n-account-open">CREATE ACCOUNT</button>
        <div class="nostr-game-actions">
          <button class="continue" id="n-host">HOST GAME</button>
          <button class="continue" id="n-join">JOIN GAME</button>
        </div>
        </section>
        <section id="n-games" hidden aria-labelledby="n-games-title">
          <h2 id="n-games-title">MY GAMES</h2>
          <div id="n-games-list"></div>
          <button class="continue" id="n-games-back">BACK TO MULTIPLAYER</button>
        </section>
        <section id="n-account" hidden aria-labelledby="n-account-title">
        <h2 id="n-account-title">CREATE ACCOUNT</h2>
        <div id="n-login">
          <button class="continue" id="n-guest">CREATE ACCOUNT ON THIS DEVICE</button>
          <details class="multiplayer-help">
            <summary aria-label="Account help">?</summary>
            <div><p>No email or password needed. Your account is saved in this browser. Keep this site's data; clearing it loses access to your account and games.</p></div>
          </details>
          <details><summary>USE AN EXISTING ACCOUNT</summary>
          <button class="continue" id="n-extension">CONNECT NOSTR SIGNER</button>
          <details id="n-import">
            <summary>PASTE NSEC</summary>
            <p>Your NSEC is your private key. A browser signer is safer. Only paste a dedicated game key on a trusted device and connection; never send it to another person.</p>
            <p>Imported keys stay in memory only. Reloading or disconnecting requires pasting the key again. This app does not save it to browser storage.</p>
            <form id="n-import-form" autocomplete="off">
              <label for="n-nsec">NSEC PRIVATE KEY</label>
              <input id="n-nsec" type="password" placeholder="nsec1…" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" required aria-label="NSEC private key">
              <button class="continue" id="n-nsec-connect" type="submit">CONNECT WITH NSEC</button>
            </form>
          </details>
          <p>Use a NIP-07 browser signer, or create a dedicated guest identity for this browser. Signer permission errors will not silently switch you to a guest.</p>
          <p>Guest keys are stored unencrypted on this device. Use only for games, not as your main Nostr account. Clearing site data loses the guest identity. LAN addresses, localhost and different browsers have separate storage.</p>
          </details>
        </div>
        <div id="n-connected" hidden>
          <form id="n-name-form">
            <label for="n-name">COMMANDER NAME</label>
            <input id="n-name" required autocomplete="nickname" aria-label="Commander name">
            <button class="continue" type="submit">SAVE NAME</button>
          </form>
          <details><summary>ACCOUNT SETTINGS</summary>
          <p id="n-source"></p>
          <label for="n-pubkey">YOUR PUBLIC IDENTITY</label>
          <input id="n-pubkey" readonly aria-label="Your Nostr public identity">
          <p>Your profile is specific to this browser and site address. Clearing site data can lose access to games. Saved guest keys are unencrypted; use a dedicated game account.</p>
          <button class="continue" id="n-disconnect">DISCONNECT</button>
          <button class="continue" id="n-forget" hidden>FORGET GUEST IDENTITY</button>
          </details>
        </div>
        <button class="continue" id="n-account-back">BACK TO MULTIPLAYER</button>
        </section>
        <p id="n-resume-error" class="nostr-notice" role="status"></p>
        <p id="n-status" role="status" aria-live="polite"></p>
      </section>
    </div></div>`;
  const q = <T extends HTMLElement = HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  q('#n-solo').onclick = opts.onSolo;
  let identity = opts.identity;
  let alive = true;
  let busy = false;
  let accountOpen = false;
  let gamesOpen = false;
  let accountName = '';
  const loadGame = () => {
    q('#n-games-open').hidden = true;
    q('#n-games-list').replaceChildren();
    q('#n-resume-error').textContent = '';
    if (!identity) return;
    try {
      const games = loadSavedLobbies(identity.pubkey, localStorage);
      q('#n-games-open').hidden = games.length === 0;
      q('#n-games-open').textContent = `MY GAMES (${games.length})`;
      for (const saved of games) {
        const card = document.createElement('section');
        card.className = 'saved-game';
        const title = document.createElement('h3');
        title.textContent = `GAME ${saved.invite.id.slice(0, 8).toUpperCase()}`;
        const description = document.createElement('p');
        description.textContent = savedLobbyDescription(saved, identity.pubkey, accountName);
        const open = document.createElement('button');
        open.className = 'continue';
        open.textContent = saved.state.closed ? 'VIEW GAME' : 'OPEN GAME';
        open.disabled = busy;
        open.onclick = () => { if (identity && !busy) opts.onLobby(identity, accountName, 'resume', saved.invite.id); };
        card.append(title, description, open);
        q('#n-games-list').append(card);
      }
    } catch (error) {
      q('#n-resume-error').textContent = `Could not load saved game: ${error instanceof Error ? error.message : String(error)}`;
    }
  };
  const loadName = () => {
    if (!identity) return;
    accountName = generatedName(identity.pubkey);
    try {
      accountName = loadDisplayName(identity.pubkey, localStorage);
    } catch (error) {
      q('#n-status').textContent = `Could not load saved commander name: ${error instanceof Error ? error.message : String(error)} Using the generated name.`;
    }
    q<HTMLInputElement>('#n-name').value = accountName;
  };
  const render = () => {
    q('#n-home').hidden = accountOpen || gamesOpen;
    q('#n-account').hidden = !accountOpen;
    q('#n-games').hidden = !gamesOpen;
    q('#n-account-open').textContent = identity ? 'MANAGE ACCOUNT' : 'CREATE ACCOUNT';
    q('#n-account-title').textContent = identity ? 'YOUR ACCOUNT' : 'CREATE ACCOUNT';
    q('#n-account-summary').textContent = identity ? `Commander: ${accountName}` : '';
    q('#n-login').hidden = identity !== null;
    q('#n-connected').hidden = identity === null;
    q<HTMLButtonElement>('#n-extension').disabled = busy;
    q<HTMLButtonElement>('#n-guest').disabled = busy;
    q<HTMLButtonElement>('#n-nsec-connect').disabled = busy;
    for (const id of ['#n-host', '#n-join']) {
      q<HTMLButtonElement>(id).disabled = busy;
      q(id).setAttribute('aria-disabled', String(busy || !identity));
    }
    q<HTMLButtonElement>('#n-account-back').disabled = busy;
    q<HTMLButtonElement>('#n-games-open').disabled = busy || !identity;
    for (const button of root.querySelectorAll<HTMLButtonElement>('#n-games-list button')) button.disabled = busy || !identity;
    q('#n-forget').hidden = identity?.source !== 'guest';
    if (identity) {
      q('#n-source').textContent = identity.source === 'guest' ? 'Connected with a saved guest identity.'
        : identity.source === 'nsec' ? 'Connected with an imported NSEC (memory only).'
        : 'Connected with your Nostr signer.';
      q<HTMLInputElement>('#n-pubkey').value = npubEncode(identity.pubkey);
    }
  };
  const connect = async (operation: () => Promise<NostrIdentity>) => {
    if (busy) return;
    busy = true;
    q('#n-status').textContent = 'Connecting…';
    render();
    try {
      const connected = await operation();
      if (!alive) return;
      rememberLogin(connected.source, localStorage);
      identity = connected;
      q<HTMLInputElement>('#n-nsec').value = '';
      q<HTMLDetailsElement>('#n-import').open = false;
      opts.onIdentity(identity);
      q('#n-status').textContent = 'Ready to play. Choose your commander name, then host or join a game.';
      loadName();
      loadGame();
    } catch (error) {
      if (alive) q('#n-status').textContent = error instanceof Error ? error.message : String(error);
    } finally {
      busy = false;
      if (alive) render();
    }
  };
  q('#n-extension').onclick = () => { void connect(() => connectExtension(browserExtension())); };
  q('#n-guest').onclick = () => { void connect(async () => connectGuest(localStorage)); };
  q<HTMLFormElement>('#n-name-form').onsubmit = event => {
    event.preventDefault();
    if (!identity) return;
    try {
      const input = q<HTMLInputElement>('#n-name');
      input.value = saveDisplayName(identity.pubkey, input.value, localStorage);
      accountName = input.value;
      q('#n-status').textContent = `Commander name saved: ${input.value}.`;
      loadGame();
      render();
    } catch (error) {
      q('#n-status').textContent = error instanceof Error ? error.message : String(error);
    }
  };
  q<HTMLFormElement>('#n-import-form').onsubmit = event => {
    event.preventDefault();
    void connect(async () => {
      const input = q<HTMLInputElement>('#n-nsec');
      try {
        return connectNsec(input.value);
      } finally {
        input.value = '';
      }
    });
  };
  q('#n-disconnect').onclick = () => {
    try { rememberLogin(null, localStorage); } catch (error) {
      q('#n-status').textContent = `Could not save disconnect: ${error instanceof Error ? error.message : String(error)}`;
      return;
    }
    identity = null;
    q<HTMLInputElement>('#n-pubkey').value = '';
    opts.onIdentity(null);
    q('#n-status').textContent = 'Disconnected. A saved guest identity stays on this device until explicitly forgotten.';
    render();
    loadName();
    loadGame();
  };
  q('#n-forget').onclick = () => {
    if (!confirm('Forget this guest identity? You will lose access to any matches using it.')) return;
    try {
      forgetGuest(localStorage);
      identity = null;
      opts.onIdentity(null);
      q('#n-status').textContent = 'Guest identity forgotten.';
      render();
      loadGame();
    } catch (error) {
      q('#n-status').textContent = error instanceof Error ? error.message : String(error);
    }
  };
  q('#n-account-open').onclick = () => {
    accountOpen = true;
    q('#n-status').textContent = '';
    render();
    q(identity ? '#n-name' : '#n-guest').focus();
  };
  q('#n-account-back').onclick = () => {
    accountOpen = false;
    q<HTMLInputElement>('#n-nsec').value = '';
    q('#n-status').textContent = '';
    render();
    q('#n-account-open').focus();
  };
  q('#n-multiplayer').onclick = () => {
    if (busy) return;
    accountOpen = false;
    gamesOpen = false;
    q<HTMLInputElement>('#n-nsec').value = '';
    render();
  };
  const lobby = (mode: 'host' | 'join') => {
    if (busy) return;
    if (!identity) {
      q('#n-status').textContent = 'You need an account first';
      return;
    }
    try {
      const name = saveDisplayName(identity.pubkey, q<HTMLInputElement>('#n-name').value, localStorage);
      accountName = name;
      opts.onLobby(identity, name, mode);
    } catch (error) { q('#n-status').textContent = error instanceof Error ? error.message : String(error); }
  };
  q('#n-host').onclick = () => lobby('host');
  q('#n-join').onclick = () => lobby('join');
  q('#n-games-open').onclick = () => {
    if (!identity || busy) return;
    gamesOpen = true;
    loadGame();
    render();
    q<HTMLButtonElement>('#n-games-list button')?.focus();
  };
  q('#n-games-back').onclick = () => { gamesOpen = false; render(); q('#n-games-open').focus(); };
  if (!identity) {
    try {
      identity = restoreGuest(localStorage);
      if (identity) {
        opts.onIdentity(identity);
      }
    } catch (error) {
      q('#n-status').textContent = `Could not restore saved guest identity: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  loadName();
  loadGame();
  render();
  return () => { alive = false; q<HTMLInputElement>('#n-nsec').value = ''; root.innerHTML = ''; };
}
