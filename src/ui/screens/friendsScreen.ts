import '../styles/menu.css';
import { npubEncode } from 'nostr-tools/nip19';
import type { NostrIdentity } from '../../nostr/identity';
import { FriendsSession, type CommanderResult } from '../../nostr/friendsSession';
import type { FriendAction } from '../../nostr/friendsProtocol';
import { generatedName } from '../../nostr/profile';
import { MENU_BACKGROUND, MENU_HEADING } from './mainMenu';

interface FriendsOptions {
  identity: NostrIdentity;
  name: string;
  onBack(): void;
}

export function mountFriendsScreen(root: HTMLElement, opts: FriendsOptions): () => void {
  root.innerHTML = `
    <div class="menu">${MENU_BACKGROUND}<div class="menu-col nostr-menu multiplayer-menu">
      ${MENU_HEADING}
      <section class="m-card glass">
        <h2>FRIENDS</h2>
        <p>Search by complete commander name (not case-sensitive), or paste an npub. Names are not unique: verify the public identity before adding someone.</p>
        <p>Your commander name, requests and friendships are public on Nostr relays. Requests appear here when the recipient opens Friends. Use Host Game to invite friends; game invitations appear on Multiplayer.</p>
        <form id="f-search-form">
          <label for="f-search">COMMANDER NAME OR NPUB</label>
          <input id="f-search" required maxlength="200" autocomplete="off" spellcheck="false">
          <button class="continue" id="f-search-button" type="submit">SEARCH COMMANDERS</button>
        </form>
        <p id="f-search-status" role="status" aria-live="polite"></p>
        <div id="f-results"></div>
        <h2>FRIEND REQUESTS</h2><div id="f-incoming"></div>
        <h2>YOUR FRIENDS</h2><div id="f-friends"></div>
        <h2>SENT REQUESTS</h2><div id="f-outgoing"></div>
        <p id="f-status" role="status" aria-live="polite"></p>
        <details><summary>CONNECTION DETAILS</summary><p id="f-connection"></p></details>
        <button class="continue" id="f-refresh">REFRESH FRIENDS</button>
        <button class="continue" id="f-back">BACK TO MULTIPLAYER</button>
      </section>
    </div></div>`;
  const q = <T extends HTMLElement = HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  let alive = true;
  let searching = false;
  let results: CommanderResult[] = [];
  const session = new FriendsSession(opts.identity, opts.name, render);
  const action = (pubkey: string, value: FriendAction) => {
    void session.act(pubkey, value).catch((error: unknown) => {
      if (!alive) return;
      session.notice = error instanceof Error ? error.message : String(error);
      render();
    });
  };
  function card(commander: CommanderResult, actions: { label: string; action: FriendAction }[]): HTMLElement {
    const section = document.createElement('section');
    section.className = 'saved-game';
    const title = document.createElement('h3');
    title.textContent = commander.name || generatedName(commander.pubkey);
    const label = document.createElement('label');
    label.textContent = 'PUBLIC IDENTITY';
    const key = document.createElement('input');
    key.readOnly = true;
    key.value = npubEncode(commander.pubkey);
    key.setAttribute('aria-label', `${title.textContent} public identity`);
    section.append(title, label, key);
    for (const item of actions) {
      const button = document.createElement('button');
      button.className = 'continue';
      button.textContent = item.label;
      button.disabled = session.busy || !session.ready;
      button.onclick = () => action(commander.pubkey, item.action);
      section.append(button);
    }
    return section;
  }
  function render(): void {
    if (!alive) return;
    q('#f-status').textContent = session.notice;
    q('#f-connection').textContent = session.connection;
    q<HTMLButtonElement>('#f-refresh').disabled = session.busy;
    q<HTMLButtonElement>('#f-search-button').disabled = searching;
    const entries = session.entries;
    for (const state of ['incoming', 'friends', 'outgoing'] as const) {
      const container = q(`#f-${state}`);
      container.replaceChildren();
      const selected = entries.filter(e => e.state === state);
      for (const entry of selected) {
        const actions: { label: string; action: FriendAction }[] = state === 'incoming'
          ? [{ label: 'ACCEPT REQUEST', action: 'accept' }, { label: 'DECLINE REQUEST', action: 'decline' }]
          : [{ label: state === 'friends' ? 'REMOVE FRIEND' : 'CANCEL REQUEST', action: 'remove' }];
        container.append(card(entry, actions));
      }
      if (!selected.length) {
        const empty = document.createElement('p');
        empty.textContent = session.ready ? { incoming: 'No pending friend requests.', friends: 'No friends yet.', outgoing: 'No sent requests.' }[state]
          : 'Waiting for relay synchronization...';
        container.append(empty);
      }
    }
    q('#f-results').replaceChildren();
    for (const commander of results) {
      const entry = entries.find(e => e.pubkey === commander.pubkey);
      const section = card(commander, entry ? [] : [{ label: 'SEND FRIEND REQUEST', action: 'request' }]);
      if (entry) {
        const state = document.createElement('p');
        state.textContent = { friends: 'Already friends.', incoming: 'Incoming request. Accept or decline below.', outgoing: 'Friend request already sent.' }[entry.state];
        section.append(state);
      }
      q('#f-results').append(section);
    }
  }
  q<HTMLFormElement>('#f-search-form').onsubmit = event => {
    event.preventDefault();
    if (searching) return;
    searching = true;
    results = [];
    q('#f-search-status').textContent = 'Searching shared relays...';
    render();
    void session.search(q<HTMLInputElement>('#f-search').value).then(found => {
      if (!alive) return;
      results = found.results;
      q('#f-search-status').textContent = `${results.length ? `${results.length} commander(s) found.` : 'No matching commanders found. Check the full name or ask for their npub.'} ${found.status}`;
    }).catch((error: unknown) => {
      if (alive) q('#f-search-status').textContent = error instanceof Error ? error.message : String(error);
    }).finally(() => {
      searching = false;
      if (alive) render();
    });
  };
  q('#f-refresh').onclick = () => { if (!session.busy) session.refresh(); };
  q('#f-back').onclick = opts.onBack;
  session.refresh();
  render();
  return () => { alive = false; session.destroy(); root.innerHTML = ''; };
}
