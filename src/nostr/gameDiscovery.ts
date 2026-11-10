import type { Event } from 'nostr-tools/pure';
import {
  DEFAULT_RELAYS, LOBBY_KIND, LOBBY_TOPIC, MAX_GAME_HISTORY, deriveLobby, normalizeRelays,
  parseLobbyCreation, parseLobbyEvent, type LobbyInvite,
} from './lobbyProtocol';
import { loadSavedLobbies, saveLobby } from './savedLobby';
import type { SocialWire } from './socialRelay';

type GameStorage = Pick<Storage, 'getItem' | 'setItem'>;
const PAGE_SIZE = 1000;

/** Discover on shared relays only; never auto-connect to addresses supplied by another author. */
export async function discoverGames(
  pubkey: string, wire: SocialWire, storage: GameStorage, signal: AbortSignal,
): Promise<{ count: number; status: string }> {
  const notices = new Set<string>();
  const own = new Map<string, Event>();
  let until: number | undefined;
  for (let page = 0; page < 10; page++) {
    signal.throwIfAborted();
    const snapshot = await wire.query([{
      kinds: [LOBBY_KIND], authors: [pubkey], '#t': [LOBBY_TOPIC], limit: PAGE_SIZE,
      ...(until === undefined ? {} : { until }),
    }]);
    signal.throwIfAborted();
    notices.add(snapshot.status);
    for (const event of snapshot.events) if (event.pubkey === pubkey) own.set(event.id, event);
    // Each relay can return a full page, with different overlap.
    if (snapshot.events.length < PAGE_SIZE) break;
    const oldest = Math.min(...snapshot.events.map(e => e.created_at));
    if (snapshot.events.every(e => e.created_at === oldest)) {
      notices.add('Discovery reached a full page of same-second events; older games may be missing.');
      break;
    }
    // Include the boundary second again so equal-timestamp events aren't silently skipped.
    if (until !== undefined && oldest >= until) {
      notices.add('Discovery could not paginate past a busy timestamp; older games may be missing.');
      break;
    }
    until = oldest;
    if (page === 9) notices.add('Discovery reached its history scan limit; older games may be missing.');
  }
  const candidates = new Map<string, LobbyInvite>();
  let rejected = 0;
  for (const event of own.values()) {
    if (event.tags.some(t => t[0] === 'e')) continue;
    try {
      const { invite } = parseLobbyCreation(event);
      if (invite.host === pubkey) candidates.set(invite.id, invite);
    } catch { rejected++; }
  }
  const roots = [...new Set([...own.values()].flatMap(e => e.tags.filter(t => t[0] === 'e').map(t => t[1])))];
  for (let i = 0; i < roots.length; i += 100) {
    signal.throwIfAborted();
    const snapshot = await wire.query([{ kinds: [LOBBY_KIND], ids: roots.slice(i, i + 100) }]);
    signal.throwIfAborted();
    notices.add(snapshot.status);
    for (const event of snapshot.events) {
      try {
        const { invite } = parseLobbyCreation(event);
        if (roots.includes(invite.id)) candidates.set(invite.id, invite);
      } catch { rejected++; }
    }
  }
  for (const game of loadSavedLobbies(pubkey, storage)) candidates.set(game.invite.id, game.invite);
  const shared = new Set(normalizeRelays(DEFAULT_RELAYS));
  let count = 0;
  for (const invite of candidates.values()) {
    signal.throwIfAborted();
    if (!invite.relays.some(url => shared.has(url))) {
      notices.add('Some games use custom relays. Open them from the original site to reconnect.');
      continue;
    }
    try {
      const snapshot = await wire.query([
        { kinds: [LOBBY_KIND], ids: [invite.id] },
        { kinds: [LOBBY_KIND], '#e': [invite.id] },
      ], MAX_GAME_HISTORY);
      signal.throwIfAborted();
      notices.add(snapshot.status);
      // Reload at write time to preserve local changes made while the query was running.
      const existing = loadSavedLobbies(pubkey, storage).find(g => g.invite.id === invite.id);
      const records = new Map((existing?.events ?? []).map(e => [e.id, parseLobbyEvent(e, invite)]));
      for (const event of snapshot.events) {
        try { records.set(event.id, parseLobbyEvent(event, invite)); }
        catch { rejected++; }
      }
      const state = deriveLobby(invite, [...records.values()]);
      if (!state.creation) {
        notices.add(`Game ${invite.id.slice(0, 8)} is missing its signed creation; keep the original site's data.`);
        continue;
      }
      if (invite.host !== pubkey && !state.requests.has(pubkey) && !state.members.some(m => m.pubkey === pubkey)) continue;
      saveLobby(pubkey, {
        invite, events: [...records.values()].map(r => r.event), pending: existing?.pending ?? null,
      }, storage);
      count++;
    } catch (error) {
      signal.throwIfAborted();
      notices.add(`Could not sync game ${invite.id.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (rejected) notices.add(`Ignored ${rejected} invalid or unrelated relay event(s).`);
  return { count, status: [...notices].join(' ') };
}
