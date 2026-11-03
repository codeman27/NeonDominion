import { decodeInvite, encodeInvite, deriveLobby, MAX_GAME_HISTORY, parseLobbyEvent, type LobbyInvite, type LobbyState } from './lobbyProtocol';
import { lobbyStorageKey } from './lobbySession';
import type { Event } from 'nostr-tools/pure';
import { isSetupPayload } from './setupProtocol';
import { deriveSetup } from './setupProtocol';
import { derivePlay } from './playProtocol';
import { commanderLabel } from './profile';

export interface SavedLobby {
  invite: LobbyInvite;
  events: Event[];
  pending: Event | null;
  state: LobbyState;
}

export function savedGamesStorageKey(pubkey: string): string { return `nd.nostr.games.v1.${pubkey}`; }

/** Treat cached history as untrusted, just like history fetched from a relay. */
function parseSavedLobby(value: unknown, pubkey: string): SavedLobby {
  if (typeof value !== 'object' || value === null || !('invite' in value) || typeof value.invite !== 'string'
    || !('events' in value) || !Array.isArray(value.events) || value.events.length > MAX_GAME_HISTORY || !('pending' in value)) {
    throw new Error('Invalid saved game. Reconnect using your invite; do not clear your identity or setup data.');
  }
  const invite = decodeInvite(value.invite);
  const records = new Map(value.events.map(input => {
    const record = parseLobbyEvent(input, invite);
    return [record.event.id, record] as const;
  }));
  const pending = value.pending === null ? null : parseLobbyEvent(value.pending, invite);
  if (pending && pending.event.pubkey !== pubkey) throw new Error('Saved pending event belongs to another identity.');
  // Pending setup events are also kept in durable setup storage. Include cached pending
  // history for the resume card so a lost relay acknowledgment does not hide the game.
  if (pending) records.set(pending.event.id, pending);
  const state = deriveLobby(invite, [...records.values()]);
  return { invite, events: [...records.values()].map(r => r.event), pending: pending?.event ?? null, state };
}

function savedEntries(pubkey: string, storage: Pick<Storage, 'getItem'>): unknown[] {
  const raw = storage.getItem(savedGamesStorageKey(pubkey));
  const entries: unknown = raw === null ? [] : JSON.parse(raw);
  if (!Array.isArray(entries)) throw new Error('Invalid saved game list. Keep your site data and reconnect using your invites.');
  return entries;
}

export function loadSavedLobbies(pubkey: string, storage: Pick<Storage, 'getItem'>): SavedLobby[] {
  const games = savedEntries(pubkey, storage).map(value => parseSavedLobby(value, pubkey));
  const legacy = storage.getItem(lobbyStorageKey(pubkey));
  if (legacy !== null) {
    const game = parseSavedLobby(JSON.parse(legacy), pubkey);
    if (!games.some(g => g.invite.id === game.invite.id)) games.push(game);
  }
  if (new Set(games.map(g => g.invite.id)).size !== games.length) throw new Error('Duplicate entries in saved game list.');
  return games;
}

export function loadSavedLobby(pubkey: string, storage: Pick<Storage, 'getItem'>, gameId?: string): SavedLobby | null {
  const games = loadSavedLobbies(pubkey, storage);
  return gameId === undefined ? games[0] ?? null : games.find(g => g.invite.id === gameId) ?? null;
}

export function saveLobby(pubkey: string, game: Pick<SavedLobby, 'invite' | 'events' | 'pending'>, storage: Pick<Storage, 'getItem' | 'setItem'>): void {
  const serialize = (g: Pick<SavedLobby, 'invite' | 'events' | 'pending'>) => ({ invite: encodeInvite(g.invite), events: g.events, pending: g.pending });
  const current = serialize(game);
  parseSavedLobby(current, pubkey);
  const others = loadSavedLobbies(pubkey, storage).filter(g => g.invite.id !== game.invite.id);
  storage.setItem(savedGamesStorageKey(pubkey), JSON.stringify([current, ...others.map(serialize)]));
}

export function savedLobbyDescription(saved: SavedLobby, pubkey: string, accountName?: string): string {
  const { state, invite } = saved;
  const role = pubkey === invite.host ? 'Hosting' : 'Joined';
  const account = accountName === undefined ? undefined : { pubkey, name: accountName };
  const names = state.members.map(m => commanderLabel(m.pubkey, m.name, account)).join(', ');
  if (state.conflict) return `Game needs attention: ${state.conflict}`;
  if (state.closed) return `Closed lobby — ${names}`;
  if (state.start) {
    const records = saved.events.map(e => parseLobbyEvent(e, invite));
    const play = derivePlay(state, deriveSetup(state, records), records);
    if (play.conflict) return `Game needs attention: ${play.conflict}`;
    if (play.snapshot) {
      const snapshot = play.snapshot;
      const current = snapshot.state.players[snapshot.phase === 'over' ? snapshot.state.winnerIndex! : snapshot.state.activePlayerIndex];
      const currentName = commanderLabel(current.id, current.name, account);
      return snapshot.phase === 'over' ? `${currentName} won — ${names}.`
        : `${role} — ${names}. Round ${snapshot.round}; ${currentName}'s turn${play.pending ? ', finishing a saved attack' : ''}.`;
    }
    const deployments = new Set(saved.events.filter(e => {
      const p = parseLobbyEvent(e, invite).payload;
      return isSetupPayload(p) && p.type === 'setup-deploy' && p.start === state.start!.event.id
        && state.members.some(m => m.pubkey === e.pubkey);
    }).map(e => e.pubkey)).size;
    return `${role} — ${names}. ${deployments === state.members.length ? 'Initial deployment complete' : 'Game setup in progress'}.`;
  }
  const request = state.requests.get(pubkey)?.payload;
  if (pubkey !== invite.host && request?.type === 'request' && !request.active) return `Left lobby — ${names}`;
  return `${role} — ${names || 'Loading lobby'}. ${state.members.length} approved commanders${pubkey !== invite.host && !state.members.some(m => m.pubkey === pubkey) ? '; waiting for host approval' : ''}.`;
}
