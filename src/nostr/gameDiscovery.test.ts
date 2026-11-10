import { describe, expect, it, vi } from 'vitest';
import { matchFilters } from 'nostr-tools/filter';
import type { Event } from 'nostr-tools/pure';
import { connectGuest } from './identity';
import { discoverGames } from './gameDiscovery';
import { DEFAULT_RELAYS, lobbyTemplate, normalizeRelays, type LobbyInvite } from './lobbyProtocol';
import { loadSavedLobbies, saveLobby } from './savedLobby';
import type { SocialWire } from './socialRelay';
import { friendTemplate } from './friendsProtocol';

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}
async function fixture() {
  const host = connectGuest(storage()), guest = connectGuest(storage()), outsider = connectGuest(storage());
  const relays = normalizeRelays(DEFAULT_RELAYS);
  const root = await host.signEvent(lobbyTemplate({
    v: 1, type: 'create', name: 'Emerald Fox', maxPlayers: 2, nonce: 'ab'.repeat(32), relays,
  }));
  const invite: LobbyInvite = { v: 1, id: root.id, host: host.pubkey, relays };
  const request = await guest.signEvent(lobbyTemplate({
    v: 1, type: 'request', name: 'Guest', active: true, seq: 1, prev: root.id,
  }, root.id));
  const roster = await host.signEvent(lobbyTemplate({
    v: 1, type: 'roster', members: [{ pubkey: guest.pubkey, name: 'Guest', request: request.id }],
    closed: false, seq: 1, prev: root.id,
  }, root.id));
  const events: Event[] = [roster, request, root];
  const wire: SocialWire = {
    query: vi.fn(async filters => ({ events: events.filter(e => matchFilters(filters, e)), status: '3/3 relays synchronized.' })),
    watch: () => () => {},
    publish: async () => { throw new Error('Discovery must not sign or publish.'); },
    destroy: () => {},
  };
  return { host, guest, outsider, root, request, roster, invite, events, wire };
}
const signal = () => new AbortController().signal;

describe('cross-site game discovery', () => {
  it('recovers joined friend-only games but does not turn unaccepted invitations into memberships', async () => {
    const f = await fixture(), store = storage();
    const request = await f.host.signEvent(friendTemplate('Host', f.guest.pubkey, 'request', null));
    const accept = await f.guest.signEvent(friendTemplate('Guest', f.host.pubkey, 'accept', request.id));
    const root = await f.host.signEvent(lobbyTemplate({
      v: 1, type: 'create', name: 'Friends Game', maxPlayers: 2, nonce: 'cd'.repeat(32), relays: f.invite.relays,
      invited: [{ pubkey: f.guest.pubkey, proof: [request, accept] }],
    }));
    f.events.splice(0, f.events.length, root);
    expect((await discoverGames(f.guest.pubkey, f.wire, store, signal())).count).toBe(0);
    f.events.push(await f.guest.signEvent(lobbyTemplate({
      v: 1, type: 'request', name: 'Guest', active: true, seq: 1, prev: root.id,
    }, root.id)));
    expect((await discoverGames(f.guest.pubkey, f.wire, store, signal())).count).toBe(1);
    expect(loadSavedLobbies(f.guest.pubkey, store)[0].state.members).toHaveLength(2);
  });

  it('recovers hosted and joined games in fresh site storage without another invite or signature', async () => {
    const f = await fixture();
    for (const identity of [f.host, f.guest]) {
      const liveStorage = storage();
      expect(loadSavedLobbies(identity.pubkey, liveStorage)).toEqual([]);
      const result = await discoverGames(identity.pubkey, f.wire, liveStorage, signal());
      expect(result.count).toBe(1);
      const games = loadSavedLobbies(identity.pubkey, liveStorage);
      expect(games[0].invite).toEqual(f.invite);
      expect(games[0].state.members).toHaveLength(2);
      expect(games[0].pending).toBeNull();
    }
    const otherStorage = storage();
    expect((await discoverGames(f.outsider.pubkey, f.wire, otherStorage, signal())).count).toBe(0);
    expect(loadSavedLobbies(f.outsider.pubkey, otherStorage)).toEqual([]);
  });

  it('finds multiple hosted games and keeps existing local history and pending signatures', async () => {
    const f = await fixture(), store = storage();
    const secondRoot = await f.host.signEvent(lobbyTemplate({
      v: 1, type: 'create', name: 'Second Game', maxPlayers: 2, relays: f.invite.relays, nonce: 'cd'.repeat(32),
    }));
    f.events.push(secondRoot);
    saveLobby(f.host.pubkey, { invite: f.invite, events: f.events.slice(0, 3), pending: f.roster }, store);
    // Simulate a relay missing events the local site already has.
    f.events.splice(f.events.indexOf(f.roster), 1);
    const result = await discoverGames(f.host.pubkey, f.wire, store, signal());
    expect(result.count).toBe(2);
    const restored = loadSavedLobbies(f.host.pubkey, store);
    expect(restored).toHaveLength(2);
    const first = restored.find(g => g.invite.id === f.invite.id)!;
    expect(first.pending?.id).toBe(f.roster.id);
    expect(first.events.some(e => e.id === f.roster.id)).toBe(true);
    expect(first.state.members).toHaveLength(2);
  });

  it('ignores malformed signed data visibly instead of poisoning recovery', async () => {
    const f = await fixture(), store = storage();
    f.events.push(await f.outsider.signEvent({
      ...lobbyTemplate({ v: 1, type: 'request', name: 'Bad', active: true, seq: 1, prev: f.root.id }, f.root.id),
      content: '{}',
    }));
    const result = await discoverGames(f.guest.pubkey, f.wire, store, signal());
    expect(result.count).toBe(1);
    expect(result.status).toContain('Ignored 1 invalid');
    expect(loadSavedLobbies(f.guest.pubkey, store)[0].events).toHaveLength(3);
  });

  it('keeps local saves when relays fail and reports per-game failures', async () => {
    const f = await fixture(), store = storage();
    saveLobby(f.host.pubkey, { invite: f.invite, events: f.events, pending: f.roster }, store);
    const original = JSON.stringify(loadSavedLobbies(f.host.pubkey, store));
    vi.spyOn(f.wire, 'query').mockRejectedValueOnce(new Error('Offline'));
    await expect(discoverGames(f.host.pubkey, f.wire, store, signal())).rejects.toThrow('Offline');
    expect(JSON.stringify(loadSavedLobbies(f.host.pubkey, store))).toBe(original);
    vi.spyOn(f.wire, 'query').mockImplementation(async filters => {
      if (filters.some(f => f['#e'])) throw new Error('History unavailable');
      return { events: f.events.filter(e => matchFilters(filters, e)), status: 'Connected' };
    });
    const result = await discoverGames(f.host.pubkey, f.wire, store, signal());
    expect(result.status).toContain('History unavailable');
    expect(JSON.stringify(loadSavedLobbies(f.host.pubkey, store))).toBe(original);
  });

  it('does not save after logout or screen exit while a query is pending', async () => {
    const f = await fixture(), store = storage(), controller = new AbortController();
    vi.spyOn(f.wire, 'query').mockImplementation(async filters => {
      const result = { events: f.events.filter(e => matchFilters(filters, e)), status: 'Connected' };
      controller.abort();
      return result;
    });
    await expect(discoverGames(f.host.pubkey, f.wire, store, controller.signal)).rejects.toThrow();
    expect(loadSavedLobbies(f.host.pubkey, store)).toEqual([]);
  });

  it('never auto-connects to relay addresses supplied by remote game authors', async () => {
    const f = await fixture(), store = storage();
    const customRoot = await f.host.signEvent(lobbyTemplate({
      v: 1, type: 'create', name: 'Custom', maxPlayers: 2, nonce: 'ff'.repeat(32), relays: ['ws://192.168.1.1/'],
    }));
    f.events.push(customRoot);
    const result = await discoverGames(f.host.pubkey, f.wire, store, signal());
    expect(result.status).toContain('custom relays');
    expect(loadSavedLobbies(f.host.pubkey, store)).toHaveLength(1);
  });

  it('reports busy timestamp pagination limits rather than silently claiming complete discovery', async () => {
    const f = await fixture();
    vi.spyOn(f.wire, 'query').mockResolvedValue({
      events: Array.from({ length: 1000 }, () => f.request), status: 'Connected',
    });
    const result = await discoverGames(f.outsider.pubkey, f.wire, storage(), signal());
    expect(result.status).toContain('same-second events');
  });
});
