import { describe, expect, it, vi } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure';
import { matchFilters, type Filter } from 'nostr-tools/filter';
import { npubEncode } from 'nostr-tools/nip19';
import { FriendsSession } from './friendsSession';
import { friendTemplate, newerEvent, profileTemplate } from './friendsProtocol';
import { publishCommanderProfile, type SocialConnection, type SocialWire } from './socialRelay';
import type { NostrIdentity } from './identity';

function identity(): NostrIdentity {
  const secret = generateSecretKey();
  return { pubkey: getPublicKey(secret), source: 'guest', signEvent: async template => finalizeEvent(template, secret) };
}

function hub() {
  const events = new Map<string, Event>();
  const listeners = new Set<{ filters: Filter[]; receive: (event: Event) => void }>();
  let fail = false;
  const query = (filters: Filter[]) => [...events.values()].filter(e => matchFilters(filters, e));
  const client = (): SocialWire => {
    const stops = new Set<() => void>();
    return {
      watch: (filters, receive, change) => {
        const listener = { filters, receive };
        listeners.add(listener);
        query(filters).forEach(receive);
        change({ ready: true, status: '3/3 relays synchronized.' });
        const stop = () => { listeners.delete(listener); stops.delete(stop); };
        stops.add(stop);
        return stop;
      },
      query: async filters => ({ events: query(filters), status: '3/3 relays synchronized.' }),
      publish: async event => {
        if (fail) throw new Error('All relays offline');
        const key = `${event.pubkey}:${event.tags.find(t => t[0] === 'd')?.[1]}`;
        if (newerEvent(event, events.get(key))) events.set(key, event);
        for (const l of listeners) if (matchFilters(l.filters, event)) l.receive(event);
        return { accepted: 3, total: 3, failures: [] };
      },
      destroy: () => { stops.forEach(stop => stop()); },
    };
  };
  return { client, events, setOffline: (value: boolean) => { fail = value; } };
}

describe('friends sessions', () => {
  it('delivers offline requests, accepts across identities and restores the list on another device', async () => {
    const relay = hub(), alice = identity(), bob = identity();
    const a = new FriendsSession(alice, 'Alice', vi.fn(), relay.client());
    a.refresh();
    expect(() => a.friendshipProof(bob.pubkey)).toThrow('current friend');
    await a.act(bob.pubkey, 'request');
    const b = new FriendsSession(bob, 'Bob', vi.fn(), relay.client());
    b.refresh();
    expect(b.entries[0]).toMatchObject({ name: 'Alice', state: 'incoming' });
    await b.act(alice.pubkey, 'accept');
    expect(a.entries[0]).toMatchObject({ name: 'Bob', state: 'friends' });
    expect(b.entries[0].state).toBe('friends');
    expect(a.friendshipProof(bob.pubkey)).toHaveLength(2);
    a.destroy();
    const restored = new FriendsSession(alice, 'Alice New Name', vi.fn(), relay.client());
    restored.refresh();
    expect(restored.entries[0].state).toBe('friends');
    await restored.act(bob.pubkey, 'remove');
    expect(b.entries).toEqual([]);
    expect(restored.entries).toEqual([]);
    restored.destroy(); b.destroy();
  });

  it('declines, cancels and re-requests without reviving old relationships', async () => {
    const relay = hub(), alice = identity(), bob = identity();
    const a = new FriendsSession(alice, 'Alice', vi.fn(), relay.client());
    const b = new FriendsSession(bob, 'Bob', vi.fn(), relay.client());
    a.refresh(); b.refresh();
    await a.act(bob.pubkey, 'request');
    await b.act(alice.pubkey, 'decline');
    expect(a.entries).toEqual([]);
    await a.act(bob.pubkey, 'request');
    expect(b.entries[0].state).toBe('incoming');
    await a.act(bob.pubkey, 'remove');
    expect(b.entries).toEqual([]);
    await a.act(bob.pubkey, 'request');
    await b.act(alice.pubkey, 'accept');
    await b.act(alice.pubkey, 'remove');
    expect(a.entries).toEqual([]);
    expect(b.entries).toEqual([]);
    await b.act(alice.pubkey, 'request');
    expect(b.entries[0].state).toBe('outgoing');
    expect(a.entries[0].state).toBe('incoming');
    await b.act(alice.pubkey, 'remove');
    expect(a.entries).toEqual([]);
    expect(b.entries).toEqual([]);
    a.destroy(); b.destroy();
  });

  it('publishes/searches full names, handles duplicates and preserves signing identities', async () => {
    const relay = hub(), alice = identity(), bob = identity(), otherBob = identity();
    const wire = relay.client();
    await publishCommanderProfile(wire, bob, 'Neon Fox');
    await publishCommanderProfile(wire, otherBob, 'Neon Fox');
    const a = new FriendsSession(alice, 'Alice', vi.fn(), relay.client());
    expect((await a.search('neon FOX')).results).toHaveLength(2);
    expect((await a.search('neon')).results).toEqual([]);
    expect((await a.search(npubEncode(bob.pubkey))).results).toEqual([{ name: 'Neon Fox', pubkey: bob.pubkey }]);
    const count = relay.events.size;
    await publishCommanderProfile(wire, bob, 'Neon Fox');
    expect(relay.events.size).toBe(count);
    await publishCommanderProfile(wire, bob, 'Chrome Wolf');
    expect((await a.search('Neon Fox')).results).toEqual([{ name: 'Neon Fox', pubkey: otherBob.pubkey }]);
    expect((await a.search('Chrome Wolf')).results[0].pubkey).toBe(bob.pubkey);
    expect((await a.search(npubEncode(alice.pubkey))).results).toEqual([]);
    const unknown = identity();
    expect((await a.search(npubEncode(unknown.pubkey))).results[0].pubkey).toBe(unknown.pubkey);
    a.destroy(); wire.destroy();
  });

  it('rejects self, duplicate, stale and unsynchronized actions, surfacing publish failures', async () => {
    const relay = hub(), alice = identity(), bob = identity();
    const a = new FriendsSession(alice, 'Alice', vi.fn(), relay.client());
    await expect(a.act(bob.pubkey, 'request')).rejects.toThrow('synchronize');
    a.refresh();
    await expect(a.act(alice.pubkey, 'request')).rejects.toThrow('yourself');
    await expect(a.act(bob.pubkey, 'accept')).rejects.toThrow('no longer pending');
    relay.setOffline(true);
    await expect(a.act(bob.pubkey, 'request')).rejects.toThrow('offline');
    expect(a.entries).toEqual([]);
    expect(a.busy).toBe(false);
    relay.setOffline(false);
    await a.act(bob.pubkey, 'request');
    await expect(a.act(bob.pubkey, 'request')).rejects.toThrow('already');
    a.destroy();
    await expect(a.act(bob.pubkey, 'remove')).rejects.toThrow('synchronize');
  });

  it('surfaces invalid incoming signatures and ignores events addressed to another identity', async () => {
    const relay = hub(), alice = identity(), bob = identity();
    const wire = relay.client();
    let receive: (event: Event) => void = () => {};
    let state: (value: SocialConnection) => void = () => {};
    vi.spyOn(wire, 'watch').mockImplementation((_filters, onEvent, onState) => {
      receive = onEvent; state = onState;
      return () => {};
    });
    const a = new FriendsSession(alice, 'Alice', vi.fn(), wire);
    a.refresh();
    state({ ready: true, status: 'Ready' });
    const profile = await bob.signEvent(profileTemplate('Bob'));
    receive(profile);
    expect(a.notice).toContain('Invalid signed');
    expect(a.entries).toEqual([]);
    receive(await bob.signEvent(friendTemplate('Bob', identity().pubkey, 'request', null)));
    expect(a.notice).toContain('another account');
    expect(a.entries).toEqual([]);
    a.destroy();
  });

  it('does not publish an acceptance if its request changes during a signer prompt', async () => {
    const relay = hub(), alice = identity(), bob = identity();
    const a = new FriendsSession(alice, 'Alice', vi.fn(), relay.client());
    const b = new FriendsSession(bob, 'Bob', vi.fn(), relay.client());
    a.refresh(); b.refresh();
    await a.act(bob.pubkey, 'request');
    const originalSign = bob.signEvent;
    let release: (() => void) | undefined;
    vi.spyOn(bob, 'signEvent').mockImplementation(async template => {
      await new Promise<void>(resolve => { release = resolve; });
      return originalSign(template);
    });
    const accepting = b.act(alice.pubkey, 'accept');
    await a.act(bob.pubkey, 'remove');
    release!();
    await expect(accepting).rejects.toThrow('changed while signing');
    expect(a.entries).toEqual([]);
    expect(b.entries).toEqual([]);
    a.destroy(); b.destroy();
  });

  it('rejects a stale-name search result even when a relay retains the old name tag', async () => {
    const alice = identity(), bob = identity(), wire = hub().client();
    const old = await bob.signEvent(profileTemplate('Old Name'));
    const current = await bob.signEvent(profileTemplate('New Name', old));
    vi.spyOn(wire, 'query')
      .mockResolvedValueOnce({ events: [old], status: 'Old relay' })
      .mockResolvedValueOnce({ events: [current], status: 'Current relay' });
    const a = new FriendsSession(alice, 'Alice', vi.fn(), wire);
    expect((await a.search('Old Name')).results).toEqual([]);
    a.destroy();
  });

  it('does not publish after screen exit while a signer is pending', async () => {
    const relay = hub(), alice = identity(), bob = identity(), wire = relay.client();
    const publish = vi.spyOn(wire, 'publish');
    const originalSign = alice.signEvent;
    let release: (() => void) | undefined;
    vi.spyOn(alice, 'signEvent').mockImplementation(async template => {
      await new Promise<void>(resolve => { release = resolve; });
      return originalSign(template);
    });
    const a = new FriendsSession(alice, 'Alice', vi.fn(), wire);
    a.refresh();
    const request = a.act(bob.pubkey, 'request');
    a.destroy();
    release!();
    await request;
    expect(publish).not.toHaveBeenCalled();
  });
});
