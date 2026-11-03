import { describe, expect, it } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure';
import {
  decodeInvite, deriveLobby, encodeInvite, lobbyTemplate, normalizeRelays, parseLobbyEvent,
  type LobbyInvite, type LobbyPayload,
} from './lobbyProtocol';
import { createLobby, LobbySession, type LobbyWire, type PublishResult } from './lobbySession';
import type { NostrIdentity } from './identity';

function identity(): NostrIdentity {
  const secret = generateSecretKey();
  return { pubkey: getPublicKey(secret), source: 'guest', signEvent: async template => finalizeEvent(template, secret) };
}
const relays = ['wss://relay.example/'];
async function fixture() {
  const host = identity(), guest = identity(), outsider = identity();
  const root = await host.signEvent(lobbyTemplate({ v: 1, type: 'create', name: 'Neon Host', maxPlayers: 2, relays, nonce: 'ab'.repeat(32) }));
  const invite: LobbyInvite = { v: 1, id: root.id, host: host.pubkey, relays };
  const records = [parseLobbyEvent(root, invite)];
  const sign = async (who: NostrIdentity, payload: LobbyPayload) => parseLobbyEvent(await who.signEvent(lobbyTemplate(payload, root.id)), invite);
  const request = await sign(guest, { v: 1, type: 'request', name: '<Captain>', active: true, seq: 1, prev: root.id });
  const member = { pubkey: guest.pubkey, name: '<Captain>', request: request.event.id };
  const roster = await sign(host, { v: 1, type: 'roster', members: [member], closed: false, seq: 1, prev: root.id });
  return { host, guest, outsider, root, invite, records, sign, request, member, roster };
}

class Hub {
  events: Event[] = [];
  subscribers = new Set<(event: Event) => void>();
  accepted = 1;
  wire(): LobbyWire {
    let receive: ((event: Event) => void) | null = null;
    return {
      subscribe: (_invite, callback, status, ready) => {
        receive = callback;
        this.subscribers.add(callback);
        [...this.events].reverse().forEach(callback);
        status('Test relay connected');
        ready(true);
        return () => { this.subscribers.delete(callback); };
      },
      publish: async (_relays, event): Promise<PublishResult> => {
        this.events.push(event);
        this.subscribers.forEach(callback => callback(event));
        return { accepted: this.accepted, total: 1, failures: this.accepted ? [] : ['Test relay: acknowledgment lost'] };
      },
      destroy: () => { if (receive) this.subscribers.delete(receive); },
    };
  }
}

describe('signed lobby protocol', () => {
  it('keeps successful sends quiet without hiding partial delivery warnings', async () => {
    const hub = new Hub(), wire = hub.wire();
    const publish = wire.publish;
    let partial = false;
    wire.publish = async (relays, event) => {
      const result = await publish(relays, event);
      return partial ? { ...result, total: 2, failures: ['Second relay unavailable'] } : result;
    };
    const host = await createLobby(identity(), 'Host', 2, relays, wire);
    host.start();
    await host.retry();
    expect(host.notice).toBe('');
    partial = true;
    const guest = new LobbySession(identity(), host.invite, hub.wire());
    guest.start();
    await guest.requestJoin('Guest');
    await host.approve(guest.identity.pubkey);
    expect(host.notice).toContain('some players may not see it yet');
    expect(host.notice).toContain('Second relay unavailable');
    host.destroy(); guest.destroy();
  });
  it('round-trips invites and rejects malformed or unsafe relay configurations', async () => {
    const { invite } = await fixture();
    expect(decodeInvite(encodeInvite(invite))).toEqual(invite);
    expect(normalizeRelays([' wss://relay.example/ ', 'ws://192.168.1.1:7777/'])).toEqual(['wss://relay.example/', 'ws://192.168.1.1:7777/']);
    for (const bad of ['', 'npub1abc', 'nd1:invalid']) expect(() => decodeInvite(bad)).toThrow('Invalid Neon Dominion invite');
    for (const bad of [[], ['https://example.com'], ['wss://user:pass@example.com'], ['wss://example.com?secret=x'], ['wss://a', 'wss://a/']]) {
      expect(() => normalizeRelays(bad)).toThrow();
    }
  });
  it('replays out-of-order approvals, deduplicates at the session boundary, and releases seats on leave', async () => {
    const f = await fixture();
    let state = deriveLobby(f.invite, [f.roster, f.request, ...f.records]);
    expect(state.members.map(m => m.name)).toEqual(['Neon Host', '<Captain>']);
    const leave = await f.sign(f.guest, { v: 1, type: 'request', name: '<Captain>', active: false, seq: 2, prev: f.request.event.id });
    state = deriveLobby(f.invite, [leave, f.roster, ...f.records, f.request]);
    expect(state.members).toHaveLength(1);
    expect(state.pending).toHaveLength(0);
    const rejoin = await f.sign(f.guest, { v: 1, type: 'request', name: 'New Name', active: true, seq: 3, prev: leave.event.id });
    state = deriveLobby(f.invite, [rejoin, leave, f.roster, ...f.records, f.request]);
    expect(state.members).toHaveLength(1);
    expect(state.pending[0].name).toBe('New Name');
  });
  it('rejects signature tampering, foreign games, malformed data and unauthorized rosters', async () => {
    const f = await fixture();
    const forged = { ...f.roster.event, content: '{}' };
    expect(() => parseLobbyEvent(forged, f.invite)).toThrow('signature');
    expect(() => parseLobbyEvent(f.request.event, { ...f.invite, id: '00'.repeat(32) })).toThrow('reference');
    expect(() => parseLobbyEvent(null, f.invite)).toThrow('Malformed');
    await expect(f.sign(f.outsider, f.roster.payload)).rejects.toThrow('unauthorized');
    await expect(f.sign(f.guest, { v: 1, type: 'request', name: 'x\u202e', active: true, seq: 1, prev: f.root.id })).rejects.toThrow();
  });
  it('halts on conflicting host signatures regardless of event timestamps or arrival order', async () => {
    const f = await fixture();
    const conflict = await f.sign(f.host, { v: 1, type: 'roster', members: [], closed: false, seq: 1, prev: f.root.id });
    for (const pair of [[conflict, f.roster], [f.roster, conflict]]) {
      expect(deriveLobby(f.invite, [...f.records, f.request, ...pair]).conflict).toContain('conflicting rosters');
    }
  });
  it('isolates conflicting applicant requests instead of letting an unapproved outsider halt the lobby', async () => {
    const f = await fixture();
    const a = await f.sign(f.outsider, { v: 1, type: 'request', name: 'Outsider', active: true, seq: 1, prev: f.root.id });
    const b = await f.sign(f.outsider, { v: 1, type: 'request', name: 'Other', active: false, seq: 1, prev: f.root.id });
    const state = deriveLobby(f.invite, [...f.records, f.request, f.roster, a, b]);
    expect(state.conflict).toBeNull();
    expect(state.warnings).toHaveLength(1);
    expect(state.members).toHaveLength(2);
    expect(state.pending).toHaveLength(0);
  });
  it('waits for approval dependencies and treats closure as terminal', async () => {
    const f = await fixture();
    expect(deriveLobby(f.invite, [...f.records, f.roster]).members).toHaveLength(1);
    const closed = await f.sign(f.host, { v: 1, type: 'roster', members: [f.member], closed: true, seq: 2, prev: f.roster.event.id });
    const reopened = await f.sign(f.host, { v: 1, type: 'roster', members: [], closed: false, seq: 3, prev: closed.event.id });
    expect(deriveLobby(f.invite, [...f.records, f.request, f.roster, closed, reopened]).closed).toBe(true);
  });
});

describe('lobby sessions', () => {
  it('hosts, joins, approves, leaves, rejoins and reconnects with identical signed names and roster', async () => {
    const hub = new Hub(), hostIdentity = identity(), guestIdentity = identity();
    const host = await createLobby(hostIdentity, 'Host', 2, relays, hub.wire());
    host.start(); await host.retry();
    const guest = new LobbySession(guestIdentity, host.invite, hub.wire());
    guest.start();
    await guest.requestJoin('Commander');
    expect(host.state.pending[0].name).toBe('Commander');
    expect(guest.state.members).toHaveLength(1);
    await expect(guest.approve(guestIdentity.pubkey)).rejects.toThrow('Only the host');
    await host.approve(guestIdentity.pubkey);
    expect(guest.state.members).toEqual(host.state.members);
    guest.destroy();
    const resumed = new LobbySession(guestIdentity, host.invite, hub.wire());
    resumed.start();
    expect(resumed.state.members).toEqual(host.state.members);
    await resumed.requestJoin('Commander', false);
    expect(host.state.members).toHaveLength(1);
    await resumed.requestJoin('New Commander');
    expect(host.state.members).toHaveLength(1);
    await host.approve(guestIdentity.pubkey);
    expect(host.state.members[1].name).toBe('New Commander');
    await host.closeLobby();
    await expect(resumed.requestJoin('New Commander', false)).rejects.toThrow('closed');
    host.destroy(); resumed.destroy();
    expect(hub.subscribers.size).toBe(0);
  });
  it('keeps an uncertain publish for exact-event retry, including across saved-session restoration', async () => {
    const hub = new Hub(), who = identity();
    const host = await createLobby(who, 'Host', 2, relays, hub.wire());
    host.start();
    hub.accepted = 0;
    await expect(host.retry()).rejects.toThrow('No relay acknowledged');
    const id = host.pendingPublish!.id;
    const savedEvents = [...host.records.values()].map(r => r.event);
    const pending = host.pendingPublish;
    host.destroy();
    const resumed = new LobbySession(who, host.invite, hub.wire());
    resumed.restore(savedEvents, pending);
    resumed.start();
    hub.accepted = 1;
    await resumed.retry();
    expect(hub.events.every(e => e.id === id)).toBe(true);
    expect(resumed.pendingPublish).toBeNull();
    expect(resumed.records.size).toBe(1);
    resumed.destroy();
  });
  it('enforces capacity and serial signing, and rejects duplicate requests', async () => {
    const hub = new Hub();
    const host = await createLobby(identity(), 'Host', 2, relays, hub.wire());
    host.start(); await host.retry();
    const guests = [new LobbySession(identity(), host.invite, hub.wire()), new LobbySession(identity(), host.invite, hub.wire())];
    guests.forEach(g => g.start());
    await guests[0].requestJoin('One');
    await expect(guests[0].requestJoin('One')).rejects.toThrow('already active');
    await guests[1].requestJoin('Two');
    const approval = host.approve(guests[0].identity.pubkey);
    await expect(host.approve(guests[1].identity.pubkey)).rejects.toThrow('Wait');
    await approval;
    await expect(host.approve(guests[1].identity.pubkey)).rejects.toThrow('full');
    host.destroy(); guests.forEach(g => g.destroy());
  });
  it('requires caught-up history and does not sign over gaps', async () => {
    const f = await fixture(), hub = new Hub();
    const host = new LobbySession(f.host, f.invite, hub.wire());
    host.receive(f.root);
    await expect(host.closeLobby()).rejects.toThrow('Waiting for relay history');
    host.start();
    host.receive(f.roster.event);
    await expect(host.closeLobby()).rejects.toThrow('gaps or conflicts');
    host.receive(f.request.event);
    await host.closeLobby();
    expect(host.state.closed).toBe(true);
    host.destroy();
  });
  it('surfaces invalid saved state, signer denial and received junk without accepting them', async () => {
    const f = await fixture(), hub = new Hub();
    const host = new LobbySession({ ...f.host, signEvent: async () => { throw new Error('Permission denied'); } }, f.invite, hub.wire());
    host.receive(f.root); host.start();
    host.receive(null);
    expect(host.notice).toContain('Rejected lobby event');
    expect(host.records.size).toBe(1);
    expect(() => host.restore([{}], null)).toThrow();
    expect(() => host.restore([], f.request.event)).toThrow('another identity');
    await expect(host.closeLobby()).rejects.toThrow('Permission denied');
    expect(host.busy).toBe(false);
    expect(host.pendingPublish).toBeNull();
    host.destroy();
  });
});
