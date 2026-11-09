import { describe, expect, it } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure';
import type { NostrIdentity } from './identity';
import { friendTemplate } from './friendsProtocol';
import {
  deriveLobby, lobbyTemplate, parseGameInvitation, parseLobbyEvent, type CreateLobby, type InvitedFriend,
} from './lobbyProtocol';
import { createLobby, LobbySession, type LobbyWire } from './lobbySession';
import { MAP_GENERATOR_VERSION } from '../engine/mapGenerator';

function identity(): NostrIdentity {
  const secret = generateSecretKey();
  return { pubkey: getPublicKey(secret), source: 'guest', signEvent: async template => finalizeEvent(template, secret) };
}
function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}
async function friendship(host: NostrIdentity, guest: NostrIdentity): Promise<InvitedFriend> {
  const request = await host.signEvent(friendTemplate('Host', guest.pubkey, 'request', null));
  const accept = await guest.signEvent(friendTemplate('Friend', host.pubkey, 'accept', request.id));
  return { pubkey: guest.pubkey, proof: [request, accept] };
}
function network() {
  const events = new Map<string, Event>(), subscribers = new Set<(event: Event) => void>();
  let accepted = 1;
  const wire = (): LobbyWire => {
    let callback: ((event: Event) => void) | null = null;
    return {
      subscribe: (_invite, receive, status, ready) => {
        callback = receive;
        subscribers.add(receive);
        [...events.values()].reverse().forEach(receive);
        status('Connected'); ready(true);
        return () => { subscribers.delete(receive); };
      },
      publish: async (_relays, event) => {
        events.set(event.id, event);
        subscribers.forEach(receive => receive(event));
        return { accepted, total: 1, failures: accepted ? [] : ['Acknowledgment lost'] };
      },
      destroy: () => { if (callback) subscribers.delete(callback); },
    };
  };
  return { wire, events, setAccepted: (value: number) => { accepted = value; } };
}
async function fixture() {
  const hub = network(), hostIdentity = identity(), guestIdentity = identity(), outsider = identity();
  const invited = await friendship(hostIdentity, guestIdentity);
  const host = await createLobby(hostIdentity, 'Host', 2, ['wss://relay.example/'], hub.wire(), [invited]);
  host.start(); await host.retry();
  const guest = new LobbySession(guestIdentity, host.invite, hub.wire());
  guest.start();
  return { hub, hostIdentity, guestIdentity, outsider, invited, host, guest };
}

describe('friend-only game invitations', () => {
  it('delivers an addressed signed invitation and admits its recipient without host approval', async () => {
    const f = await fixture();
    const root = f.hub.events.get(f.host.invite.id)!;
    const parsed = parseGameInvitation(root, f.guestIdentity.pubkey);
    expect(parsed.invite).toEqual(f.host.invite);
    expect(parsed.creation.invited?.[0].pubkey).toBe(f.guestIdentity.pubkey);
    expect(root.tags).toContainEqual(['p', f.guestIdentity.pubkey]);
    expect(() => parseGameInvitation(root, f.outsider.pubkey)).toThrow('not addressed');
    expect(() => parseGameInvitation({ ...root, content: '{}' }, f.guestIdentity.pubkey)).toThrow();
    await f.guest.requestJoin('Friend');
    expect(f.host.state.members.map(m => m.pubkey)).toEqual([f.hostIdentity.pubkey, f.guestIdentity.pubkey]);
    expect(f.guest.state.members).toEqual(f.host.state.members);
    expect(f.host.state.pending).toEqual([]);
    expect(f.host.state.roster).toBeNull();
    f.host.destroy(); f.guest.destroy();
  });

  it('accepts while the host is offline and replays acceptance into the host roster on return', async () => {
    const f = await fixture();
    f.host.destroy();
    await f.guest.requestJoin('Offline Friend');
    const returned = new LobbySession(f.hostIdentity, f.host.invite, f.hub.wire());
    returned.start();
    expect(returned.state.members[1].name).toBe('Offline Friend');
    const store = storage(), guestStore = storage();
    await returned.startGame(store);
    expect(f.guest.state.start?.event.id).toBe(returned.state.start?.event.id);
    expect(f.guest.state.members).toEqual(returned.state.members);
    await returned.commitSeed(store);
    await f.guest.commitSeed(guestStore);
    expect(f.guest.setup.commits.size).toBe(2);
    await returned.revealSeed(store);
    await f.guest.revealSeed(guestStore);
    expect(returned.setup.conflict).toBeNull();
    expect(returned.setup.baseHash).toBe(f.guest.setup.baseHash);
    expect(returned.setup.base?.players.map(p => p.id)).toEqual([f.hostIdentity.pubkey, f.guestIdentity.pubkey]);
    returned.destroy(); f.guest.destroy();
  });

  it('blocks uninvited accounts even with a code, signed join requests or a host-signed roster', async () => {
    const f = await fixture();
    const outsider = new LobbySession(f.outsider, f.host.invite, f.hub.wire());
    outsider.start();
    await expect(outsider.requestJoin('Outsider')).rejects.toThrow('explicitly invited');
    const request = await f.outsider.signEvent(lobbyTemplate({
      v: 1, type: 'request', name: 'Outsider', active: true, seq: 1, prev: f.host.invite.id,
    }, f.host.invite.id));
    f.host.receive(request);
    f.host.receive(await f.outsider.signEvent(lobbyTemplate({
      v: 1, type: 'request', name: 'Other Outsider', active: false, seq: 1, prev: f.host.invite.id,
    }, f.host.invite.id)));
    expect(f.host.state.conflict).toBeNull();
    expect(f.host.state.requests.has(f.outsider.pubkey)).toBe(false);
    const member = { pubkey: f.outsider.pubkey, name: 'Outsider', request: request.id };
    for (const payload of [
      { v: 1, type: 'roster', members: [member], closed: false, seq: 1, prev: f.host.invite.id } as const,
      { v: 1, type: 'start', members: [member], mapGeneratorVersion: MAP_GENERATOR_VERSION, seq: 1, prev: f.host.invite.id } as const,
    ]) {
      const event = await f.hostIdentity.signEvent(lobbyTemplate({ ...payload, members: [...payload.members] }, f.host.invite.id));
      const state = deriveLobby(f.host.invite, [
        parseLobbyEvent(f.hub.events.get(f.host.invite.id)!, f.host.invite),
        parseLobbyEvent(request, f.host.invite), parseLobbyEvent(event, f.host.invite),
      ]);
      expect(state.members.some(m => m.pubkey === f.outsider.pubkey)).toBe(false);
      expect(state.start).toBeNull();
    }
    outsider.destroy(); f.host.destroy(); f.guest.destroy();
  });

  it('releases seats on leave, automatically readmits invited friends and locks the accepted roster at start', async () => {
    const f = await fixture();
    await f.guest.requestJoin('Friend');
    await f.guest.requestJoin('Friend', false);
    expect(f.host.state.members).toHaveLength(1);
    await f.guest.requestJoin('New Name');
    expect(f.host.state.members[1].name).toBe('New Name');
    await f.host.startGame(storage());
    await expect(f.guest.requestJoin('New Name', false)).rejects.toThrow('locked');
    expect(f.host.state.members).toEqual(f.guest.state.members);
    f.host.destroy(); f.guest.destroy();
  });

  it('rejects invalid friendship proofs, nonfriends, duplicate or excessive invitees and mismatched recipient tags', async () => {
    const host = identity(), guest = identity(), other = identity();
    const invited = await friendship(host, guest);
    const base: CreateLobby = {
      v: 1, type: 'create', name: 'Host', maxPlayers: 3, relays: ['wss://relay.example/'], nonce: 'ab'.repeat(32), invited: [invited],
    };
    const assertInvalid = async (payload: CreateLobby, wrongTags = false) => {
      const template = lobbyTemplate(payload);
      if (wrongTags) template.tags = template.tags.filter(t => t[0] !== 'p');
      const event = await host.signEvent(template);
      expect(() => parseGameInvitation(event, guest.pubkey)).toThrow();
    };
    await assertInvalid({ ...base, invited: [] });
    await assertInvalid({ ...base, invited: [invited, invited] });
    await assertInvalid({ ...base, maxPlayers: 2, invited: [invited, await friendship(host, other)] });
    await assertInvalid({ ...base, invited: [{ ...invited, pubkey: other.pubkey }] });
    await assertInvalid({ ...base, invited: [{ ...invited, proof: [invited.proof[0], invited.proof[0]] }] });
    await assertInvalid({ ...base, invited: [await friendship(other, guest)] });
    await assertInvalid(base, true);
  });

  it('supports all seven invited friends within event limits and capacity', async () => {
    const hostIdentity = identity(), guests = Array.from({ length: 7 }, identity), hub = network();
    const invited = await Promise.all(guests.map(g => friendship(hostIdentity, g)));
    const host = await createLobby(hostIdentity, 'Host', 8, ['wss://relay.example/'], hub.wire(), invited);
    host.start(); await host.retry();
    expect(parseGameInvitation(hub.events.get(host.invite.id)!, guests[6].pubkey).creation.invited).toHaveLength(7);
    const sessions = guests.map(g => new LobbySession(g, host.invite, hub.wire()));
    for (const [i, session] of sessions.entries()) { session.start(); await session.requestJoin(`Friend ${i}`); }
    expect(host.state.members).toHaveLength(8);
    await host.startGame(storage());
    for (const session of sessions) {
      expect(session.state.start?.event.id).toBe(host.state.start?.event.id);
      expect(session.state.members).toEqual(host.state.members);
      session.destroy();
    }
    host.destroy();
  });

  it('retries the same invitation and acceptance after lost acknowledgments', async () => {
    const f = await fixture();
    f.hub.setAccepted(0);
    await expect(f.guest.requestJoin('Friend')).rejects.toThrow('No relay acknowledged');
    const pending = f.guest.pendingPublish!;
    expect(f.host.state.members).toHaveLength(2);
    f.hub.setAccepted(1);
    await f.guest.retry();
    expect(f.guest.pendingPublish).toBeNull();
    expect(f.guest.state.members[1].request).toBe(pending.id);
    f.host.destroy(); f.guest.destroy();
  });
});
