import { describe, expect, it } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey, type Event, type EventTemplate } from 'nostr-tools/pure';
import { npubEncode } from 'nostr-tools/nip19';
import {
  commanderSearch, deriveFriends, friendTemplate, newerEvent, parseFriend, parseProfile, profileTemplate,
} from './friendsProtocol';

const a = generateSecretKey(), b = generateSecretKey(), c = generateSecretKey();
const alice = getPublicKey(a), bob = getPublicKey(b);
const sign = (template: EventTemplate, secret = a) => finalizeEvent(template, secret);
const request = () => parseFriend(sign(friendTemplate('Alice', bob, 'request', null)));

describe('commander discovery', () => {
  it('signs app-specific searchable profiles with normalized names and duplicate-name identities', () => {
    const first = parseProfile(sign(profileTemplate('  Neon   Fox  ')));
    const second = parseProfile(sign(profileTemplate('Neon Fox'), b));
    expect(first.name).toBe('Neon Fox');
    expect(first.event.pubkey).not.toBe(second.event.pubkey);
    expect(commanderSearch('  neon FOX ').filter['#t']).toEqual([first.event.tags[2][1]]);
    expect(commanderSearch('neon fox').filter['#d']).toEqual(['neon-dominion-profile-v1']);
    expect(commanderSearch(npubEncode(bob)).pubkey).toBe(bob);
    expect(() => commanderSearch('npub1bad')).toThrow('Invalid npub');
    expect(() => commanderSearch('')).toThrow('visible characters');
  });

  it('uses Nostr replaceable ordering and advances same-second updates', () => {
    const first = sign(profileTemplate('Alice'));
    const second = sign(profileTemplate('Alice Two', first));
    expect(second.created_at).toBeGreaterThan(first.created_at);
    expect(newerEvent(second, first)).toBe(true);
    expect(newerEvent(first, second)).toBe(false);
    expect(newerEvent({ ...first, id: '00'.repeat(32) }, { ...first, id: 'ff'.repeat(32) })).toBe(true);
    expect(() => profileTemplate('Alice', { ...first, created_at: first.created_at + 301 })).toThrow('device clock');
  });
});

describe('signed friend state', () => {
  it('shows incoming/outgoing requests and mutual friendship only after acceptance', () => {
    const req = request();
    expect(deriveFriends(alice, [req])[0].state).toBe('outgoing');
    expect(deriveFriends(bob, [req])[0].state).toBe('incoming');
    const accept = parseFriend(sign(friendTemplate('Bob', alice, 'accept', req.event.id), b));
    for (const pubkey of [alice, bob]) expect(deriveFriends(pubkey, [accept, req])[0].state).toBe('friends');
    expect(deriveFriends(getPublicKey(c), [req, accept])).toEqual([]);
  });

  it('declines, re-requests and never accepts a stale request', () => {
    const req = request();
    const decline = parseFriend(sign(friendTemplate('Bob', alice, 'decline', req.event.id), b));
    expect(deriveFriends(alice, [req, decline])).toEqual([]);
    expect(deriveFriends(bob, [req, decline])).toEqual([]);
    const next = parseFriend(sign(friendTemplate('Alice', bob, 'request', null, req.event)));
    const oldAccept = parseFriend(sign(friendTemplate('Bob', alice, 'accept', req.event.id, decline.event), b));
    expect(deriveFriends(bob, [req, decline, next, oldAccept])[0].state).toBe('incoming');
    expect(deriveFriends(alice, [req, next, oldAccept])[0].state).toBe('outgoing');
  });

  it('allows either party to remove friendship and does not resurrect it on replay', () => {
    const req = request();
    const accept = parseFriend(sign(friendTemplate('Bob', alice, 'accept', req.event.id), b));
    const removeSender = parseFriend(sign(friendTemplate('Alice', bob, 'remove', req.event.id, req.event)));
    const removeRecipient = parseFriend(sign(friendTemplate('Bob', alice, 'remove', req.event.id, accept.event), b));
    for (const remove of [removeSender, removeRecipient]) {
      for (const pubkey of [alice, bob]) expect(deriveFriends(pubkey, [remove, accept, req, accept, req])).toEqual([]);
    }
  });

  it('handles crossed requests, cancellation and repeated updates deterministically', () => {
    const req = request();
    const crossed = parseFriend(sign(friendTemplate('Bob', alice, 'request', null), b));
    expect(deriveFriends(alice, [req, crossed])[0].state).toBe('incoming');
    const accept = parseFriend(sign(friendTemplate('Alice', bob, 'accept', crossed.event.id, req.event)));
    expect(deriveFriends(bob, [req, crossed, accept])[0].state).toBe('friends');
    const cancel = parseFriend(sign(friendTemplate('Bob', alice, 'remove', crossed.event.id, crossed.event), b));
    expect(deriveFriends(alice, [req, crossed, accept, cancel])).toEqual([]);
  });

  it('rejects spoofed, malformed and cached-signature mutations', () => {
    const req = request();
    expect(() => parseFriend({ ...req.event, content: '{"v":1,"name":"Imposter","action":"request","request":null}' })).toThrow('Invalid signed');
    const invalid: EventTemplate[] = [
      { ...friendTemplate('Alice', bob, 'request', null), tags: [['d', 'wrong']] },
      { ...friendTemplate('Alice', bob, 'request', null), created_at: Math.floor(Date.now() / 1000) + 600 },
      { ...friendTemplate('Alice', bob, 'request', null), content: JSON.stringify({ v: 1, name: 'Alice', action: 'accept', request: null }) },
      { ...friendTemplate('Alice', bob, 'request', null), tags: [...friendTemplate('Alice', bob, 'request', null).tags, ['p', alice]] },
      friendTemplate('Alice', alice, 'request', null),
    ];
    for (const template of invalid) expect(() => parseFriend(sign(template))).toThrow();
    expect(() => parseProfile(sign({ ...profileTemplate('Alice'), tags: [['d', 'wrong']] }))).toThrow();
    expect(() => friendTemplate('Alice', bob, 'accept', null)).toThrow('Invalid friend');
    const cached: Event = sign(profileTemplate('Alice'));
    cached.content = JSON.stringify({ v: 1, name: 'Hacked' });
    expect(() => parseProfile(cached)).toThrow('Invalid signed');
  });
});
