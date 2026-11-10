import '../styles/menu.css';
import { npubEncode } from 'nostr-tools/nip19';
import { browserExtension, connectExtension, connectGuest, forgetGuest, forgetSavedNsec, loginWithNsec, rememberLogin, restoreLogin, type NostrIdentity } from '../../nostr/identity';
import { generatedGameName, generatedName, loadDisplayName, saveDisplayName } from '../../nostr/profile';
import { loadSavedLobbies, savedLobbyDescription } from '../../nostr/savedLobby';
import { MENU_BACKGROUND, MENU_HEADING } from './mainMenu';
import { SocialRelay, publishCommanderProfile } from '../../nostr/socialRelay';
import { LOBBY_KIND, LOBBY_TOPIC, parseGameInvitation, type LobbyInvite } from '../../nostr/lobbyProtocol';
import { discoverGames } from '../../nostr/gameDiscovery';

export interface NostrMenuOptions {
  identity: NostrIdentity | null;
  onIdentity(identity: NostrIdentity | null): void;
  onSolo(): void;
  onFriends(identity: NostrIdentity, name: string): void;
  onLobby(identity: NostrIdentity, name: string, mode: 'host' | 'join' | 'resume' | 'invite', gameId?: string, invitation?: LobbyInvite): void;
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
        <button class="continue" id="n-games-open" hidden>MY GAMES</button>
        <p id="n-account-summary"></p>
        <button class="continue" id="n-account-open">LOG IN / CREATE ACCOUNT</button>
        <button class="continue" id="n-friends-open" hidden>FRIENDS</button>
        <div class="nostr-game-actions">
          <button class="continue" id="n-host">HOST GAME</button>
        </div>
        <section id="n-invitations" hidden aria-labelledby="n-invitations-title">
          <h2 id="n-invitations-title">GAME INVITATIONS</h2>
          <div id="n-invitations-list"></div>
          <p id="n-invitations-status" role="status" aria-live="polite"></p>
          <button class="continue" id="n-invitations-refresh">REFRESH INVITATIONS</button>
        </section>
        </section>
        <section id="n-games" hidden aria-labelledby="n-games-title">
          <h2 id="n-games-title">MY GAMES</h2>
          <div id="n-games-list"></div>
          <p>Private setup secrets and unsent turns stay on the original device and site.</p>
          <button class="continue" id="n-games-back">BACK TO MULTIPLAYER</button>
        </section>
        <section id="n-account" hidden aria-label="Account">
        <h2 id="n-account-title" hidden>YOUR ACCOUNT</h2>
        <div id="n-login">
          <h2>CREATE AN ACCOUNT</h2>
          <button class="continue" id="n-guest">CREATE ACCOUNT ON THIS DEVICE</button>
          <h2>LOG IN TO AN EXISTING ACCOUNT</h2>
          <button class="continue" id="n-extension">LOG IN WITH NOSTR SIGNER</button>
          <details id="n-import">
            <summary>LOG IN WITH NSEC</summary>
            <p>Your NSEC is your private key. A browser signer is safer. Only paste a dedicated game key on a trusted device and connection; never send it to another person.</p>
            <p>Keys stay in memory unless you choose to remember this device.</p>
            <form id="n-import-form" autocomplete="off">
              <label for="n-nsec">NSEC PRIVATE KEY</label>
              <input id="n-nsec" type="password" placeholder="nsec1…" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" required aria-label="NSEC private key">
              <label class="friend-choice"><input id="n-remember-nsec" type="checkbox"><span>Remember on this device. Stores your private key unencrypted in this browser; use only on a trusted device.</span></label>
              <button class="continue" id="n-nsec-connect" type="submit">LOG IN WITH NSEC</button>
            </form>
          </details>
        </div>
        <div id="n-connected" hidden>
          <p>Your commander name and public identity are published on Nostr relays for friend search. Saving a new name updates your public profile.</p>
          <form id="n-name-form">
            <label for="n-name">COMMANDER NAME</label>
            <input id="n-name" required autocomplete="nickname" aria-label="Commander name">
            <button class="continue" type="submit">SAVE NAME</button>
          </form>
          <details id="n-account-settings"><summary>ACCOUNT SETTINGS</summary>
          <p id="n-source"></p>
          <label for="n-pubkey">YOUR PUBLIC IDENTITY</label>
          <input id="n-pubkey" readonly aria-label="Your Nostr public identity">
          <div id="n-backup" hidden>
            <label for="n-private-key">YOUR NSEC PRIVATE KEY</label>
            <input id="n-private-key" type="password" readonly placeholder="••••••••••••••••" autocomplete="off" spellcheck="false" aria-label="Your NSEC private key">
            <button class="continue" id="n-reveal-nsec" aria-controls="n-private-key" aria-expanded="false">Click to Reveal. Keep this private, whoever has your nsec can log in as you</button>
            <button class="continue" id="n-copy-nsec" hidden>COPY NSEC</button>
          </div>
          <p>Your profile is specific to this browser and site address. Clearing site data can lose access to games. Saved guest keys are unencrypted; use a dedicated game account.</p>
          <button class="continue" id="n-disconnect">DISCONNECT</button>
          <button class="continue" id="n-forget" hidden>FORGET GUEST IDENTITY</button>
          </details>
        </div>
        <button class="continue" id="n-account-back">BACK TO MULTIPLAYER</button>
        </section>
        <p id="n-resume-error" class="nostr-notice" role="status"></p>
        <p id="n-game-sync-status" role="status" aria-live="polite"></p>
        <button class="continue" id="n-game-sync" hidden>SYNC MY GAMES</button>
        <p id="n-status" role="status" aria-live="polite"></p>
        <p id="n-profile-status" class="nostr-notice" role="status" aria-live="polite"></p>
        <button class="continue" id="n-profile-retry" hidden>RETRY PUBLISHING COMMANDER NAME</button>
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
  let publishingProfile = false;
  const social = new SocialRelay();
  let gameSync: AbortController | null = null;
  const syncGames = async () => {
    gameSync?.abort();
    gameSync = null;
    q('#n-game-sync').hidden = !identity;
    if (!identity) {
      q('#n-game-sync-status').textContent = '';
      return;
    }
    const connected = identity;
    const controller = new AbortController();
    gameSync = controller;
    q<HTMLButtonElement>('#n-game-sync').disabled = true;
    q('#n-game-sync-status').textContent = 'Finding your games on shared relays...';
    try {
      const result = await discoverGames(connected.pubkey, social, localStorage, controller.signal);
      if (!alive || controller.signal.aborted) return;
      q('#n-game-sync-status').textContent = `${result.count} game(s) synchronized. ${result.status}`;
      loadGame();
      render();
    } catch (error) {
      if (alive && !controller.signal.aborted) {
        q('#n-game-sync-status').textContent = `Could not sync games: ${error instanceof Error ? error.message : String(error)} Local games have been kept.`;
      }
    } finally {
      if (alive && !controller.signal.aborted) q<HTMLButtonElement>('#n-game-sync').disabled = false;
    }
  };
  q('#n-game-sync').onclick = () => { void syncGames(); };
  let stopInvitations: (() => void) | null = null;
  const invitations = new Map<string, ReturnType<typeof parseGameInvitation>>();
  let invitationsReady = false;
  let invitationError = '';
  let invitationConnection = '';
  const renderInvitationStatus = () => {
    q('#n-invitations-status').textContent = [invitationError, invitationConnection].filter(Boolean).join(' ');
  };
  const renderInvitations = () => {
    q('#n-invitations').hidden = !identity;
    q('#n-invitations-list').replaceChildren();
    if (!identity) return;
    let saved: Set<string>;
    try { saved = new Set(loadSavedLobbies(identity.pubkey, localStorage).filter(g =>
      g.state.closed || g.state.start || g.state.members.some(m => m.pubkey === identity?.pubkey)).map(g => g.invite.id)); }
    catch (error) {
      q('#n-invitations-status').textContent = `Could not check saved invitations: ${error instanceof Error ? error.message : String(error)}`;
      return;
    }
    for (const { invite, creation } of invitations.values()) {
      if (saved.has(invite.id)) continue;
      const card = document.createElement('section');
      card.className = 'saved-game';
      const title = document.createElement('h3');
      title.textContent = generatedGameName(invite.id);
      const host = document.createElement('p');
      host.textContent = `Host: ${creation.name} (${npubEncode(invite.host)}). Relays: ${invite.relays.join(', ')}`;
      const accept = document.createElement('button');
      accept.className = 'continue';
      accept.textContent = 'ACCEPT INVITATION & JOIN';
      accept.disabled = busy || !invitationsReady;
      accept.onclick = () => {
        if (identity && !busy && invitationsReady) opts.onLobby(identity, accountName, 'invite', undefined, invite);
      };
      card.append(title, host, accept);
      q('#n-invitations-list').append(card);
    }
    if (!q('#n-invitations-list').childElementCount) {
      const empty = document.createElement('p');
      empty.textContent = invitationsReady ? 'No new game invitations.' : 'Loading game invitations...';
      q('#n-invitations-list').append(empty);
    }
  };
  const watchInvitations = () => {
    stopInvitations?.();
    stopInvitations = null;
    invitations.clear();
    invitationsReady = false;
    invitationError = '';
    invitationConnection = 'Connecting to invitation relays...';
    renderInvitations();
    renderInvitationStatus();
    if (!identity) return;
    const recipient = identity.pubkey;
    stopInvitations = social.watch([{ kinds: [LOBBY_KIND], '#t': [LOBBY_TOPIC], '#p': [recipient], limit: 100 }], event => {
      if (!alive || identity?.pubkey !== recipient) return;
      try {
        const invitation = parseGameInvitation(event, recipient);
        if (invitations.size >= 300 && !invitations.has(event.id)) throw new Error('Too many game invitations to display.');
        invitations.set(event.id, invitation);
        renderInvitations();
      } catch (error) {
        invitationError = `Rejected game invitation: ${error instanceof Error ? error.message : String(error)}`;
        renderInvitationStatus();
      }
    }, state => {
      if (!alive || identity?.pubkey !== recipient) return;
      if (invitationsReady === state.ready && invitationConnection === state.status) return;
      invitationsReady = state.ready;
      invitationConnection = state.status;
      renderInvitationStatus();
      renderInvitations();
    });
  };
  q('#n-invitations-refresh').onclick = watchInvitations;
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
        title.textContent = generatedGameName(saved.invite.id);
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
    if (!accountOpen || identity?.source !== 'guest') hideNsec();
    q('#n-home').hidden = accountOpen || gamesOpen;
    q('#n-account').hidden = !accountOpen;
    q('#n-games').hidden = !gamesOpen;
    q('#n-account-open').textContent = identity ? 'MANAGE ACCOUNT' : 'LOG IN / CREATE ACCOUNT';
    q('#n-account-title').hidden = identity === null;
    q('#n-account-summary').textContent = identity ? `Commander: ${accountName}` : '';
    q('#n-login').hidden = identity !== null;
    q('#n-connected').hidden = identity === null;
    const working = busy || publishingProfile;
    q<HTMLButtonElement>('#n-extension').disabled = working;
    q<HTMLButtonElement>('#n-guest').disabled = working;
    q<HTMLButtonElement>('#n-nsec-connect').disabled = working;
    q<HTMLInputElement>('#n-name').disabled = working;
    q<HTMLButtonElement>('#n-name-form button').disabled = working;
    q<HTMLButtonElement>('#n-disconnect').disabled = working;
    q<HTMLButtonElement>('#n-forget').disabled = working;
    q('#n-friends-open').hidden = !identity;
    q<HTMLButtonElement>('#n-friends-open').disabled = working || !identity;
    q<HTMLButtonElement>('#n-profile-retry').disabled = working;
    q<HTMLButtonElement>('#n-host').disabled = busy;
    q('#n-host').setAttribute('aria-disabled', String(busy || !identity));
    q<HTMLButtonElement>('#n-account-back').disabled = busy;
    q<HTMLButtonElement>('#n-games-open').disabled = busy || !identity;
    for (const button of root.querySelectorAll<HTMLButtonElement>('#n-games-list button')) button.disabled = busy || !identity;
    q('#n-forget').hidden = identity?.source !== 'guest';
    q('#n-backup').hidden = identity?.source !== 'guest' || !identity.exportNsec;
    if (identity) {
      q('#n-source').textContent = identity.source === 'guest' ? 'Connected with a saved guest identity.'
        : identity.source === 'nsec' ? 'Connected with an imported NSEC. Disconnect clears any remembered NSEC on this site.'
        : 'Connected with your Nostr signer.';
      q<HTMLInputElement>('#n-pubkey').value = npubEncode(identity.pubkey);
    }
    renderInvitations();
  };
  const hideNsec = () => {
    q<HTMLInputElement>('#n-private-key').value = '';
    q<HTMLInputElement>('#n-private-key').type = 'password';
    q('#n-copy-nsec').hidden = true;
    q('#n-reveal-nsec').textContent = 'Click to Reveal. Keep this private, whoever has your nsec can log in as you';
    q('#n-reveal-nsec').setAttribute('aria-expanded', 'false');
  };
  q<HTMLDetailsElement>('#n-account-settings').ontoggle = () => {
    if (!q<HTMLDetailsElement>('#n-account-settings').open) hideNsec();
  };
  const publishName = async () => {
    if (!identity || publishingProfile) return;
    publishingProfile = true;
    q('#n-profile-status').textContent = 'Publishing your commander name for friend search...';
    q('#n-profile-retry').hidden = true;
    render();
    try {
      const status = await publishCommanderProfile(social, identity, accountName);
      if (alive) q('#n-profile-status').textContent = status;
    } catch (error) {
      if (alive) {
        q('#n-profile-status').textContent = `Commander name is saved locally, but public profile synchronization failed: ${error instanceof Error ? error.message : String(error)}`;
        q('#n-profile-retry').hidden = false;
      }
    } finally {
      publishingProfile = false;
      if (alive) render();
    }
  };
  q('#n-profile-retry').onclick = () => { void publishName(); };
  q('#n-reveal-nsec').onclick = () => {
    if (q<HTMLInputElement>('#n-private-key').value) {
      hideNsec();
      return;
    }
    if (identity?.source !== 'guest' || !identity.exportNsec) {
      q('#n-status').textContent = 'NSEC reveal is only available for accounts created on this device.';
      return;
    }
    try {
      const input = q<HTMLInputElement>('#n-private-key');
      input.value = identity.exportNsec();
      input.type = 'text';
      q('#n-reveal-nsec').textContent = 'HIDE NSEC';
      q('#n-reveal-nsec').setAttribute('aria-expanded', 'true');
      q('#n-copy-nsec').hidden = false;
    } catch {
      hideNsec();
      q('#n-status').textContent = 'Could not reveal your NSEC. Try again in this browser.';
    }
  };
  q('#n-copy-nsec').onclick = () => {
    const input = q<HTMLInputElement>('#n-private-key');
    if (!input.value || input.type !== 'text') return;
    input.focus();
    input.select();
    if (!navigator.clipboard) {
      q('#n-status').textContent = 'Clipboard unavailable. The NSEC is selected; copy it manually.';
      return;
    }
    void navigator.clipboard.writeText(input.value).then(() => {
      if (alive) q('#n-status').textContent = 'NSEC copied. Keep it private.';
    }).catch(() => {
      if (alive) q('#n-status').textContent = 'Could not copy NSEC. Select the key and copy it manually.';
    });
  };
  q('#n-friends-open').onclick = () => {
    if (identity && !busy && !publishingProfile) opts.onFriends(identity, accountName);
  };
  const connect = async (operation: () => Promise<NostrIdentity>, rememberNsec = false) => {
    if (busy) return;
    busy = true;
    q('#n-status').textContent = 'Connecting…';
    render();
    try {
      const connected = await operation();
      if (!alive) return;
      if (!rememberNsec) forgetSavedNsec(localStorage);
      rememberLogin(connected.source, localStorage);
      identity = connected;
      q<HTMLInputElement>('#n-nsec').value = '';
      q<HTMLDetailsElement>('#n-import').open = false;
      opts.onIdentity(identity);
      q('#n-status').textContent = 'Ready to play. Choose your commander name, then host or join a game.';
      loadName();
      loadGame();
      watchInvitations();
      void syncGames();
      await publishName();
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
    if (!identity || busy || publishingProfile) return;
    try {
      const input = q<HTMLInputElement>('#n-name');
      input.value = saveDisplayName(identity.pubkey, input.value, localStorage);
      accountName = input.value;
      q('#n-status').textContent = `Commander name saved: ${input.value}.`;
      loadGame();
      render();
      void publishName();
    } catch (error) {
      q('#n-status').textContent = error instanceof Error ? error.message : String(error);
    }
  };
  q<HTMLFormElement>('#n-import-form').onsubmit = event => {
    event.preventDefault();
    const remember = q<HTMLInputElement>('#n-remember-nsec').checked;
    void connect(async () => {
      const input = q<HTMLInputElement>('#n-nsec');
      try {
        return loginWithNsec(input.value, remember, localStorage);
      } finally {
        input.value = '';
      }
    }, remember);
  };
  q('#n-disconnect').onclick = () => {
    try {
      forgetSavedNsec(localStorage);
      rememberLogin(null, localStorage);
    } catch (error) {
      q('#n-status').textContent = `Could not save disconnect: ${error instanceof Error ? error.message : String(error)}`;
      return;
    }
    identity = null;
    void syncGames();
    watchInvitations();
    q<HTMLInputElement>('#n-pubkey').value = '';
    opts.onIdentity(null);
    q('#n-status').textContent = 'Disconnected. A saved guest identity stays on this device until explicitly forgotten.';
    q('#n-profile-status').textContent = '';
    q('#n-profile-retry').hidden = true;
    render();
    loadName();
    loadGame();
  };
  q('#n-forget').onclick = () => {
    if (!confirm('Forget this guest identity? You will lose access to any matches using it.')) return;
    try {
      forgetGuest(localStorage);
      identity = null;
      void syncGames();
      watchInvitations();
      opts.onIdentity(null);
      q('#n-status').textContent = 'Guest identity forgotten.';
      q('#n-profile-status').textContent = '';
      q('#n-profile-retry').hidden = true;
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
  q('#n-host').onclick = () => {
    if (busy) return;
    if (!identity) {
      q('#n-status').textContent = 'You need an account first';
      return;
    }
    try {
      const name = saveDisplayName(identity.pubkey, q<HTMLInputElement>('#n-name').value, localStorage);
      accountName = name;
      opts.onLobby(identity, name, 'host');
    } catch (error) { q('#n-status').textContent = error instanceof Error ? error.message : String(error); }
  };
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
      identity = restoreLogin(localStorage);
      if (identity) {
        opts.onIdentity(identity);
      }
    } catch (error) {
      q('#n-status').textContent = `Could not restore saved login: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  loadName();
  loadGame();
  render();
  watchInvitations();
  void syncGames();
  void publishName();
  return () => { alive = false; gameSync?.abort(); hideNsec(); stopInvitations?.(); social.destroy(); q<HTMLInputElement>('#n-nsec').value = ''; root.innerHTML = ''; };
}
