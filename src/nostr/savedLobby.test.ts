import { describe, expect, it } from 'vitest';
import { connectGuest } from './identity';
import { encodeInvite, lobbyTemplate } from './lobbyProtocol';
import { lobbyStorageKey } from './lobbySession';
import { loadSavedLobbies, loadSavedLobby, saveLobby, savedGamesStorageKey, savedLobbyDescription } from './savedLobby';
import { MAP_GENERATOR_VERSION } from '../engine/mapGenerator';

function storage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
  };
}
async function fixture() {
  const host = connectGuest(storage()), guest = connectGuest(storage()), store = storage();
  const root = await host.signEvent(lobbyTemplate({
    v: 1, type: 'create', name: 'Crimson Comet', maxPlayers: 2, nonce: 'ab'.repeat(32), relays: ['wss://example.test/'],
  }));
  const invite = { v: 1 as const, id: root.id, host: host.pubkey, relays: ['wss://example.test/'] };
  const request = await guest.signEvent(lobbyTemplate({ v: 1, type: 'request', name: 'Phone Commander', active: true, seq: 1, prev: root.id }, root.id));
  const members = [{ pubkey: guest.pubkey, name: 'Phone Commander', request: request.id }];
  const roster = await host.signEvent(lobbyTemplate({ v: 1, type: 'roster', members, closed: false, seq: 1, prev: root.id }, root.id));
  const events = [roster, request, root];
  const save = (extra: object = {}) => store.setItem(lobbyStorageKey(guest.pubkey), JSON.stringify({ invite: encodeInvite(invite), events, pending: null, ...extra }));
  save();
  return { host, guest, store, root, request, roster, members, events, save };
}
describe('saved multiplayer game', () => {
  it('keeps multiple games per account and opens the selected game rather than the most recent one', async () => {
    const a = await fixture(), b = await fixture();
    // Both hosts can be joined using the same account; an invite can also be saved before requesting a seat.
    const first = loadSavedLobby(a.guest.pubkey, a.store)!;
    const second = loadSavedLobby(b.guest.pubkey, b.store)!;
    const legacy = a.store.getItem(lobbyStorageKey(a.guest.pubkey));
    saveLobby(a.guest.pubkey, second, a.store);
    expect(loadSavedLobbies(a.guest.pubkey, a.store).map(g => g.invite.id)).toEqual([second.invite.id, first.invite.id]);
    expect(a.store.getItem(lobbyStorageKey(a.guest.pubkey))).toBe(legacy);
    saveLobby(a.guest.pubkey, first, a.store);
    expect(loadSavedLobbies(a.guest.pubkey, a.store)).toHaveLength(2);
    expect(loadSavedLobby(a.guest.pubkey, a.store, second.invite.id)!.events).toEqual(second.events);
    expect(loadSavedLobby(a.guest.pubkey, a.store, 'ff'.repeat(32))).toBeNull();
    expect(loadSavedLobbies(b.host.pubkey, a.store)).toEqual([]);
  });
  it('updates only one game and preserves each pending signed event', async () => {
    const a = await fixture(), b = await fixture();
    const first = loadSavedLobby(a.guest.pubkey, a.store)!;
    const other = loadSavedLobby(b.guest.pubkey, b.store)!;
    saveLobby(a.guest.pubkey, other, a.store);
    const request = await a.guest.signEvent(lobbyTemplate({ v: 1, type: 'request', name: 'Updated', active: true, seq: 2, prev: a.request.id }, a.root.id));
    saveLobby(a.guest.pubkey, { ...first, pending: request }, a.store);
    expect(loadSavedLobby(a.guest.pubkey, a.store, first.invite.id)!.pending?.id).toBe(request.id);
    expect(loadSavedLobby(a.guest.pubkey, a.store, other.invite.id)!.events).toEqual(other.events);
    expect(loadSavedLobby(a.guest.pubkey, a.store, other.invite.id)!.pending).toBeNull();
    expect(loadSavedLobbies(a.guest.pubkey, a.store)).toHaveLength(2);
  });
  it('retains existing games on write failure and refuses to overwrite a corrupted collection', async () => {
    const f = await fixture();
    const game = loadSavedLobby(f.guest.pubkey, f.store)!;
    const before = f.store.getItem(lobbyStorageKey(f.guest.pubkey));
    expect(() => saveLobby(f.guest.pubkey, game, { getItem: f.store.getItem, setItem: () => { throw new Error('Storage full'); } })).toThrow('Storage full');
    expect(f.store.getItem(lobbyStorageKey(f.guest.pubkey))).toBe(before);
    f.store.setItem(savedGamesStorageKey(f.guest.pubkey), '{}');
    expect(() => saveLobby(f.guest.pubkey, game, f.store)).toThrow('Invalid saved game list');
    expect(f.store.getItem(savedGamesStorageKey(f.guest.pubkey))).toBe('{}');
  });
  it('refreshes resume labels with the account name without altering signed membership', async () => {
    const f = await fixture();
    const saved = loadSavedLobby(f.guest.pubkey, f.store)!;
    const original = JSON.stringify(saved.events);
    expect(savedLobbyDescription(saved, f.guest.pubkey, 'New Commander')).toContain('New Commander');
    expect(savedLobbyDescription(saved, f.guest.pubkey, 'New Commander')).not.toContain('Phone Commander');
    expect(savedLobbyDescription(saved, f.guest.pubkey, 'New Commander')).toContain('Crimson Comet');
    expect(saved.state.members[1].name).toBe('Phone Commander');
    expect(JSON.stringify(saved.events)).toBe(original);
  });
  it('loads signed accepted membership directly without a new invite, request or approval', async () => {
    const f = await fixture();
    const saved = loadSavedLobby(f.guest.pubkey, f.store)!;
    expect(saved.state.members.map(m => m.name)).toEqual(['Crimson Comet', 'Phone Commander']);
    expect(saved.state.requests.get(f.guest.pubkey)?.event.id).toBe(f.request.id);
    expect(savedLobbyDescription(saved, f.guest.pubkey)).toContain('2 approved commanders');
    expect(loadSavedLobby(f.host.pubkey, f.store)).toBeNull();
  });
  it('describes a locked game after restart and retains the signed start and pending action', async () => {
    const f = await fixture();
    const start = await f.host.signEvent(lobbyTemplate({
      v: 1, type: 'start', members: f.members, mapGeneratorVersion: MAP_GENERATOR_VERSION, seq: 2, prev: f.roster.id,
    }, f.root.id));
    const pending = await f.guest.signEvent(lobbyTemplate({ v: 1, type: 'seed-commit', start: start.id, commitment: 'cd'.repeat(32) }, f.root.id));
    f.save({ events: [...f.events, start], pending });
    const saved = loadSavedLobby(f.guest.pubkey, f.store)!;
    expect(saved.state.start?.event.id).toBe(start.id);
    expect(saved.pending?.id).toBe(pending.id);
    expect(savedLobbyDescription(saved, f.guest.pubkey)).toContain('Game setup in progress');
    expect(savedLobbyDescription(saved, f.guest.pubkey)).toContain('Crimson Comet');
  });
  it('surfaces corrupt saves, forged history, foreign pending signatures and storage failures', async () => {
    const f = await fixture();
    f.save({ events: [{ ...f.root, content: '{}' }] });
    expect(() => loadSavedLobby(f.guest.pubkey, f.store)).toThrow('signature');
    f.save({ pending: f.roster });
    expect(() => loadSavedLobby(f.guest.pubkey, f.store)).toThrow('another identity');
    f.store.setItem(lobbyStorageKey(f.guest.pubkey), '{}');
    expect(() => loadSavedLobby(f.guest.pubkey, f.store)).toThrow('Invalid saved game');
    expect(() => loadSavedLobby(f.guest.pubkey, { getItem: () => { throw new Error('Storage blocked'); } })).toThrow('Storage blocked');
  });
});
