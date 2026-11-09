import '../styles/menu.css';
import type { NostrIdentity } from '../../nostr/identity';
import { DEFAULT_RELAYS, decodeInvite, encodeInvite, type LobbyInvite } from '../../nostr/lobbyProtocol';
import { createLobby, LobbySession } from '../../nostr/lobbySession';
import { npubEncode } from 'nostr-tools/nip19';
import { mountMultiplayerSetup } from '../components/multiplayerSetup';
import { loadSavedLobby, saveLobby } from '../../nostr/savedLobby';
import { mountMultiplayerBoard } from '../components/multiplayerBoard';
import { commanderLabel, generatedGameName } from '../../nostr/profile';
import { FriendsSession } from '../../nostr/friendsSession';
import { parseFriend } from '../../nostr/friendsProtocol';

interface LobbyOptions {
  identity: NostrIdentity;
  name: string;
  mode: 'host' | 'join' | 'resume' | 'invite';
  gameId?: string;
  invitation?: LobbyInvite;
  onBack(): void;
}

export function mountNostrLobby(root: HTMLElement, opts: LobbyOptions): () => void {
  root.innerHTML = `
    <div class="menu"><div class="menu-col nostr-menu">
      <header class="m-title"><div class="kicker">NEON DOMINION</div><h1 class="title">LOBBY</h1></header>
      <section class="m-card glass">
        <p id="l-name"></p>
        <p id="l-intro">Select friends to invite. Accepting an invitation automatically adds them to the game; no host approval is needed. Everyone places their initial armies before the first turn.</p>
        <div id="l-setup">
          <form id="l-host-form">
            <h2>HOST GAME</h2>
            <label for="l-capacity">MAXIMUM PLAYERS (INCLUDING YOU)</label>
            <input id="l-capacity" type="number" min="2" max="8" value="4" required>
            <h2>INVITE FRIENDS</h2>
            <p>Choose up to one fewer than the maximum players. Only these friends can join this game. The invitation list is fixed when you create the game.</p>
            <div id="l-friends"></div>
            <p id="l-friends-status" role="status" aria-live="polite"></p>
            <button class="continue" type="button" id="l-friends-refresh">REFRESH FRIENDS</button>
            <p>Names and game invitations are public on the shared Nostr relays.</p>
            <button class="continue" type="submit" id="l-create">CREATE GAME &amp; INVITE FRIENDS</button>
          </form>
          <form id="l-join-form">
            <h2>JOIN GAME</h2>
            <label for="l-invite-input">PASTE INVITE</label>
            <textarea id="l-invite-input" rows="3" required spellcheck="false" aria-label="Game invite"></textarea>
            <p id="l-invite-details" class="nostr-notice">Paste an invite to review its host and relay addresses before connecting.</p>
            <button class="continue" type="submit" id="l-connect">OPEN LOBBY</button>
          </form>
        </div>
        <div id="l-room" hidden>
          <h2 id="l-title">WAITING FOR LOBBY</h2>
          <p id="l-position"></p>
          <div id="l-share">
          <label for="l-invite">SHARE THIS INVITE</label>
          <textarea id="l-invite" rows="3" readonly aria-label="Shareable game invite"></textarea>
          <button class="continue" id="l-copy">COPY INVITE</button>
          </div>
          <div id="l-invited-section" hidden><h2>INVITED FRIENDS</h2><ul id="l-invited" class="lobby-roster"></ul></div>
          <h2 id="l-members-title">COMMANDERS</h2>
          <ul id="l-members" class="lobby-roster"></ul>
          <h2 id="l-requests-title">JOIN REQUESTS</h2>
          <ul id="l-requests" class="lobby-roster"></ul>
          <button class="continue" id="l-request">REQUEST A SEAT</button>
          <button class="continue" id="l-leave">LEAVE LOBBY</button>
          <button class="continue" id="l-close">CLOSE LOBBY FOR EVERYONE</button>
          <button class="continue" id="l-retry" hidden>RETRY SENDING</button>
          <details><summary>CONNECTION DETAILS</summary>
          <p id="l-connection"></p>
          <button class="continue" id="l-reconnect">RECONNECT / REFRESH HISTORY</button>
          <button class="continue" id="l-export">DOWNLOAD SIGNED LOBBY HISTORY</button>
          <p>Game history is public. Reconnect with the same account and site data to keep your seat.</p></details>
          <button class="continue" id="l-start">START GAME</button>
          <p id="l-start-help">Ready with at least two commanders? You can start without filling every seat. No one can join after the game starts.</p>
          <p>You can leave this screen and return using My Games. Your seat is kept unless you choose Leave Lobby.</p>
        </div>
        <p id="l-status" role="status" aria-live="polite"></p>
        <p id="l-storage" class="nostr-notice" role="status"></p>
      </section>
      <button class="continue" id="l-back">BACK TO MULTIPLAYER</button>
    </div></div><div id="l-game-setup" hidden></div><div id="l-play" hidden></div>`;
  const q = <T extends HTMLElement = HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  q('#l-name').textContent = `Commander: ${opts.name}`;
  q('#l-host-form').hidden = opts.mode !== 'host';
  q('#l-join-form').hidden = opts.mode !== 'join';
  let session: LobbySession | null = null;
  let unsubscribe: (() => void) | null = null;
  let alive = true;
  let working = false;
  let acceptingInvitation = opts.mode === 'invite';
  const selectedFriends = new Set<string>();
  const friends = opts.mode === 'host' ? new FriendsSession(opts.identity, opts.name, renderFriends) : null;
  let setupView: ReturnType<typeof mountMultiplayerSetup> | null = null;
  let playView: ReturnType<typeof mountMultiplayerBoard> | null = null;
  const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
  const playerName = (pubkey: string, name: string) => commanderLabel(pubkey, name, { pubkey: opts.identity.pubkey, name: opts.name });
  function renderFriends(): void {
    if (!alive || !friends) return;
    const entries = friends.entries.filter(e => e.state === 'friends');
    for (const pubkey of selectedFriends) if (!entries.some(e => e.pubkey === pubkey)) selectedFriends.delete(pubkey);
    q('#l-friends').replaceChildren();
    for (const entry of entries) {
      const label = document.createElement('label');
      label.className = 'friend-choice';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = entry.pubkey;
      input.checked = selectedFriends.has(entry.pubkey);
      input.disabled = working || !friends.ready;
      input.onchange = () => {
        if (input.checked) selectedFriends.add(entry.pubkey); else selectedFriends.delete(entry.pubkey);
        renderFriends();
      };
      const text = document.createElement('span');
      text.textContent = `${entry.name || 'Commander'} (${npubEncode(entry.pubkey)})`;
      label.append(input, text);
      q('#l-friends').append(label);
    }
    const capacity = Number(q<HTMLInputElement>('#l-capacity').value);
    q('#l-friends-status').textContent = `${friends.connection} ${friends.notice} ${!friends.ready ? 'Waiting for synchronized friends.' : entries.length ? `${selectedFriends.size} friends selected.` : 'No friends available. Add and accept friends in the Friends menu first.'}${selectedFriends.size >= capacity ? ' Select fewer friends or increase maximum players.' : ''}`;
    q<HTMLButtonElement>('#l-create').disabled = working || !friends.ready || selectedFriends.size < 1 || selectedFriends.size >= capacity;
    q<HTMLButtonElement>('#l-friends-refresh').disabled = working;
  }
  const persist = () => {
    if (!session) return;
    try {
      saveLobby(opts.identity.pubkey, {
        invite: session.invite, events: [...session.records.values()].map(r => r.event), pending: session.pendingPublish,
      }, localStorage);
      q('#l-storage').textContent = '';
    } catch (error) { q('#l-storage').textContent = `Could not save lobby reconnect data: ${errorText(error)}. Copy your invite before leaving.`; }
  };
  const listMember = (member: { name: string; pubkey: string }, suffix: string): HTMLLIElement => {
    const li = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = `${playerName(member.pubkey, member.name)}${suffix}`;
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = 'PLAYER ID';
    const key = document.createElement('small');
    key.textContent = npubEncode(member.pubkey);
    details.append(summary, key);
    li.append(label, details);
    return li;
  };
  const render = () => {
    if (!session || !alive) return;
    const s = session.state;
    const host = opts.identity.pubkey === session.invite.host;
    const ownRequest = s.requests.get(opts.identity.pubkey);
    const requested = ownRequest?.payload.type === 'request' && ownRequest.payload.active;
    const accepted = s.members.some(m => m.pubkey === opts.identity.pubkey);
    const disabled = session.busy || working || (!session.historyReady && !session.canContinueOffline) || session.publishingTurn || !!session.pendingPublish || !!s.conflict || !!session.setup.conflict || !!session.play.conflict || s.closed || !s.creation;
    const locked = s.start !== null;
    const restricted = !!s.creation?.invited;
    const invited = s.creation?.invited?.some(f => f.pubkey === opts.identity.pubkey);
    q('.title').textContent = generatedGameName(session.invite.id);
    if (s.creation) {
      q('#l-intro').textContent = restricted
        ? 'Invited friends join automatically when they accept. Everyone places their initial armies before the first turn.'
        : 'This existing lobby uses invite codes and host-approved seats. Everyone places their initial armies before the first turn.';
    }
    q('#l-members-title').textContent = restricted ? 'COMMANDERS' : 'APPROVED COMMANDERS';
    q('#l-setup').hidden = true;
    q('#l-room').hidden = false;
    q('#l-title').textContent = s.closed ? 'LOBBY CLOSED' : locked ? 'PREPARE FOR BATTLE' : s.creation ? `LOBBY — ${s.members.length}/${s.creation.maxPlayers}` : 'LOADING LOBBY';
    q('#l-connection').textContent = session.status;
    q('#l-position').textContent = locked ? accepted ? 'Your game is starting. Prepare your armies below.' : 'This game has already started; new commanders cannot join.'
      : host ? restricted ? 'Your friends can accept their invitations from Multiplayer. Start when everyone is ready.' : 'You are the host. Share the invite and approve your friends below.'
      : accepted ? 'You are in! Waiting for the host to start.' : restricted ? invited ? 'Accept your invitation to join this game automatically.' : 'Only friends invited by the host can join this game.'
      : requested ? 'Waiting for the host to approve your seat.' : 'Request a seat to join your friends.';
    q('#l-share').hidden = restricted;
    q('#l-invited-section').hidden = !restricted;
    q('#l-invited').replaceChildren(...(s.creation?.invited ?? []).map(friend => {
      const proof = friend.proof.find(event => event.pubkey === friend.pubkey);
      const name = proof ? parseFriend(proof).name : '';
      return listMember({ pubkey: friend.pubkey, name }, s.members.some(m => m.pubkey === friend.pubkey) ? ' (JOINED)' : ' (INVITED)');
    }));
    q<HTMLTextAreaElement>('#l-invite').value = encodeInvite(session.invite);
    q('#l-members').replaceChildren(...s.members.map(m => listMember(m, `${m.pubkey === session!.invite.host ? ' (HOST)' : ''}${m.pubkey === opts.identity.pubkey ? ' (YOU)' : ''}`)));
    q('#l-requests').replaceChildren(...s.pending.map(m => {
      const li = listMember(m, m.pubkey === opts.identity.pubkey ? ' (YOU)' : '');
      if (host) {
        const button = document.createElement('button');
        button.className = 'continue';
        button.textContent = `APPROVE ${m.name}`;
        button.disabled = disabled || s.members.length >= s.creation!.maxPlayers;
        button.onclick = () => { void run(() => session!.approve(m.pubkey)); };
        li.append(button);
      }
      return li;
    }));
    q('#l-request').hidden = locked || host || !!requested || accepted || (restricted && !invited);
    q('#l-request').textContent = restricted ? 'ACCEPT INVITATION & JOIN' : 'REQUEST A SEAT';
    q('#l-leave').hidden = locked || host || !requested;
    q('#l-close').hidden = locked || !host || s.closed;
    q('#l-requests-title').hidden = locked || restricted;
    q('#l-requests').hidden = locked || restricted;
    q('#l-start').hidden = locked || !host || s.closed;
    q<HTMLButtonElement>('#l-start').disabled = disabled || s.members.length < 2;
    q('#l-start-help').hidden = locked || s.closed;
    const deployed = !!session.setup.state?.players.every(p => p.setupDone);
    const preparing = locked && accepted && !s.closed;
    q('.menu').hidden = preparing;
    q('#l-game-setup').hidden = !preparing || deployed;
    q('#l-play').hidden = !deployed;
    for (const id of ['#l-request', '#l-leave', '#l-close']) q<HTMLButtonElement>(id).disabled = disabled;
    q('#l-retry').hidden = !session.pendingPublish;
    q<HTMLButtonElement>('#l-retry').disabled = session.busy || working;
    q<HTMLButtonElement>('#l-reconnect').disabled = session.busy || working;
    q('#l-status').textContent = [s.conflict, session.setup.conflict, session.play.conflict, ...s.warnings, session.notice].filter(Boolean).join(' ');
    persist();
    if (preparing && !deployed) setupView?.render(disabled, q('#l-storage').textContent ?? '');
    playView?.render(disabled, q('#l-storage').textContent ?? '');
    if (acceptingInvitation && s.creation && !disabled) {
      acceptingInvitation = false;
      if (!locked && !accepted && !requested) queueMicrotask(() => {
        if (alive) void run(() => session!.requestJoin(opts.name));
      });
    }
  };
  const attach = (connected: LobbySession) => {
    if (!alive) { connected.destroy(); return; }
    try { connected.restoreSetup(localStorage); } catch (error) {
      connected.notice = `Could not restore private setup data: ${errorText(error)}. Setup cannot be safely resumed without the original data.`;
    }
    try { connected.restoreTurn(localStorage); } catch (error) {
      connected.notice = errorText(error);
    }
    session = connected;
    unsubscribe = session.onChange(render);
    render();
    renderFriends();
  };
  const run = async (operation: () => Promise<void>) => {
    if (working) return;
    working = true;
    q<HTMLButtonElement>('#l-create').disabled = true;
    q<HTMLButtonElement>('#l-connect').disabled = true;
    q<HTMLButtonElement>('#l-back').disabled = true;
    q('#l-status').textContent = 'Connecting...';
    render();
    renderFriends();
    try { await operation(); } catch (error) {
      if (alive) {
        if (session) session.notice = errorText(error);
        else q('#l-status').textContent = errorText(error);
      }
    } finally {
      working = false;
      if (alive) {
        for (const id of ['#l-create', '#l-connect', '#l-back']) q<HTMLButtonElement>(id).disabled = false;
        render();
        renderFriends();
      }
    }
  };
  setupView = mountMultiplayerSetup(q('#l-game-setup'), () => session, run, opts.name, opts.onBack);
  playView = mountMultiplayerBoard(q('#l-play'), () => session, run, opts.onBack, opts.name);
  const open = (code: string) => {
    const invite = decodeInvite(code);
    const connected = new LobbySession(opts.identity, invite);
    const existing = loadSavedLobby(opts.identity.pubkey, localStorage, invite.id);
    if (existing) connected.restore(existing.events, existing.pending);
    attach(connected);
    connected.start();
  };
  q<HTMLTextAreaElement>('#l-invite-input').oninput = () => {
    try {
      const invite = decodeInvite(q<HTMLTextAreaElement>('#l-invite-input').value);
      q('#l-invite-details').textContent = `Host: ${npubEncode(invite.host)}. Connect to: ${invite.relays.join(', ')}${invite.relays.some(url => url.startsWith('ws:')) ? '. Warning: this invite uses an unencrypted relay connection.' : ''}`;
    } catch (error) { q('#l-invite-details').textContent = errorText(error); }
  };
  q<HTMLFormElement>('#l-host-form').onsubmit = event => {
    event.preventDefault();
    void run(async () => {
      const connected = await createLobby(opts.identity, opts.name, Number(q<HTMLInputElement>('#l-capacity').value),
        DEFAULT_RELAYS, undefined, [...selectedFriends].map(pubkey => {
          if (!friends) throw new Error('Open Host Game to choose friends.');
          return { pubkey, proof: friends.friendshipProof(pubkey) };
        }));
      attach(connected);
      if (!alive) return;
      connected.start();
      await connected.retry();
    });
  };
  q<HTMLFormElement>('#l-join-form').onsubmit = event => {
    event.preventDefault();
    void run(async () => open(q<HTMLTextAreaElement>('#l-invite-input').value));
  };
  const resume = () => run(async () => {
    if (!opts.gameId) throw new Error('Choose a game from My Games first.');
    const value = loadSavedLobby(opts.identity.pubkey, localStorage, opts.gameId);
    if (!value) throw new Error('No saved game was found. Open your invite to reconnect.');
    const connected = new LobbySession(opts.identity, value.invite);
    connected.restore(value.events, value.pending);
    attach(connected);
    connected.start();
  });
  q('#l-request').onclick = () => { void run(() => session!.requestJoin(opts.name)); };
  q('#l-leave').onclick = () => { void run(() => session!.requestJoin(opts.name, false)); };
  q('#l-close').onclick = () => {
    if (confirm('Close this lobby for everyone? This cannot be undone.')) void run(() => session!.closeLobby());
  };
  q('#l-retry').onclick = () => { void run(() => session!.retryPending(localStorage)); };
  q('#l-start').onclick = () => {
    if (confirm(`Start with ${session!.state.members.length} commanders? No one else can join after starting.`)) {
      void run(() => session!.startGame(localStorage));
    }
  };
  q('#l-reconnect').onclick = () => { session?.start(); render(); };
  q('#l-copy').onclick = () => { void run(async () => {
    if (!navigator.clipboard) throw new Error('Clipboard unavailable on this connection. Select and copy the invite text manually.');
    await navigator.clipboard.writeText(encodeInvite(session!.invite));
    session!.notice = 'Invite copied.';
  }); };
  q('#l-export').onclick = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify([...session!.records.values()].map(r => r.event), null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url; link.download = `neon-dominion-lobby-${session!.invite.id.slice(0, 8)}.json`;
    link.click(); URL.revokeObjectURL(url);
  };
  q('#l-back').onclick = opts.onBack;
  q('#l-capacity').oninput = renderFriends;
  q('#l-friends-refresh').onclick = () => { if (!working) friends?.refresh(); };
  friends?.refresh();
  renderFriends();
  if (opts.mode === 'resume') void resume();
  if (opts.mode === 'invite') {
    void run(async () => {
      if (!opts.invitation) throw new Error('Choose a game invitation from Multiplayer first.');
      open(encodeInvite(opts.invitation));
    });
  }
  return () => { alive = false; friends?.destroy(); unsubscribe?.(); setupView?.destroy(); playView?.destroy(); session?.destroy(); root.innerHTML = ''; };
}
