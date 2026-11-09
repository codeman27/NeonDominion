import { verifyEvent, type Event, type EventTemplate } from 'nostr-tools/pure';
import { decode } from 'nostr-tools/nip19';
import type { Filter } from 'nostr-tools/filter';
import { isHex32 } from '../crypto/hashChain';
import { sha256Hex } from '../crypto/prng';
import { normalizeDisplayName } from './profile';

export const SOCIAL_KIND = 30078;
export const PROFILE_TOPIC = 'neon-dominion-profile-v1';
export const FRIEND_TOPIC = 'neon-dominion-friend-v1';
export type FriendAction = 'request' | 'accept' | 'decline' | 'remove';
export interface CommanderProfile { event: Event; name: string }
export interface FriendRecord {
  event: Event;
  name: string;
  peer: string;
  action: FriendAction;
  request: string | null;
  dismissed: string | null;
}
export interface FriendEntry {
  pubkey: string;
  name: string;
  state: 'friends' | 'incoming' | 'outgoing';
  incoming?: FriendRecord;
  own?: FriendRecord;
}

function nameTag(name: string): string {
  return `nd-name:${sha256Hex(normalizeDisplayName(name).toLowerCase())}`;
}

export function newerEvent(candidate: Event, previous?: Event): boolean {
  return !previous || candidate.created_at > previous.created_at
    || (candidate.created_at === previous.created_at && candidate.id < previous.id);
}

function timestamp(previous?: Event): number {
  const now = Math.floor(Date.now() / 1000);
  const next = Math.max(now, (previous?.created_at ?? 0) + 1);
  if (next > now + 300) throw new Error('Too many updates or an incorrect device clock. Wait a few minutes and refresh.');
  return next;
}

export function profileTemplate(name: string, previous?: Event): EventTemplate {
  name = normalizeDisplayName(name);
  return {
    kind: SOCIAL_KIND, created_at: timestamp(previous),
    tags: [['d', PROFILE_TOPIC], ['t', PROFILE_TOPIC], ['t', nameTag(name)]],
    content: JSON.stringify({ v: 1, name }),
  };
}

export function friendTemplate(
  name: string, peer: string, action: FriendAction, request: string | null, previous?: Event,
): EventTemplate {
  if (!isHex32(peer) || (request !== null && !isHex32(request))
    || ((action === 'accept' || action === 'decline') && request === null)) throw new Error('Invalid friend action or request reference.');
  // Keep old incoming requests dismissed even when a new outgoing request replaces our state.
  const previousDismissal = previous ? parseFriend(previous).dismissed : null;
  const dismissed = action === 'accept' ? null
    : action === 'decline' || action === 'remove' ? request ?? previousDismissal : previousDismissal;
  return {
    kind: SOCIAL_KIND, created_at: timestamp(previous),
    tags: [['d', `${FRIEND_TOPIC}:${peer}`], ['t', FRIEND_TOPIC], ['p', peer]],
    content: JSON.stringify({ v: 1, name: normalizeDisplayName(name), action, request, dismissed }),
  };
}

function checkedEvent(input: Event, topic: string): Event {
  const event: Event = {
    id: input.id, pubkey: input.pubkey, sig: input.sig, kind: input.kind,
    created_at: input.created_at, content: input.content, tags: structuredClone(input.tags),
  };
  if (event.kind !== SOCIAL_KIND || typeof event.content !== 'string' || event.content.length > 1024
    || !Number.isSafeInteger(event.created_at) || event.created_at < 0 || event.created_at > Math.floor(Date.now() / 1000) + 300
    || !Array.isArray(event.tags) || event.tags.length > 8
    || !event.tags.every(t => Array.isArray(t) && t.length === 2 && t.every(s => typeof s === 'string' && s.length <= 256))
    || !event.tags.some(t => t[0] === 't' && t[1] === topic) || !verifyEvent(event)) {
    throw new Error('Invalid signed friends event.');
  }
  return event;
}

function payload(event: Event): { name: string; action: unknown; request: unknown; dismissed: unknown } {
  const value: unknown = JSON.parse(event.content);
  if (typeof value !== 'object' || value === null || !('v' in value) || value.v !== 1
    || !('name' in value) || typeof value.name !== 'string' || normalizeDisplayName(value.name) !== value.name) {
    throw new Error('Invalid commander profile or friend message.');
  }
  return {
    name: value.name,
    action: 'action' in value ? value.action : undefined,
    request: 'request' in value ? value.request : undefined,
    dismissed: 'dismissed' in value ? value.dismissed : undefined,
  };
}

export function parseProfile(input: Event): CommanderProfile {
  const event = checkedEvent(input, PROFILE_TOPIC);
  const p = payload(event);
  const name = p.name;
  if (event.tags.filter(t => t[0] === 'd').length !== 1
    || !event.tags.some(t => t[0] === 'd' && t[1] === PROFILE_TOPIC)
    || !event.tags.some(t => t[0] === 't' && t[1] === nameTag(name))) throw new Error('Invalid commander profile tags.');
  return { event, name };
}

export function parseFriend(input: Event): FriendRecord {
  const event = checkedEvent(input, FRIEND_TOPIC);
  const p = payload(event);
  const recipients = event.tags.filter(t => t[0] === 'p');
  const peer = recipients[0]?.[1];
  if (recipients.length !== 1 || !isHex32(peer ?? '') || peer === event.pubkey
    || event.tags.filter(t => t[0] === 'd').length !== 1
    || !event.tags.some(t => t[0] === 'd' && t[1] === `${FRIEND_TOPIC}:${peer}`)
    || (p.action !== 'request' && p.action !== 'accept' && p.action !== 'decline' && p.action !== 'remove')
    || (p.request !== null && (typeof p.request !== 'string' || !isHex32(p.request)))
    || (p.dismissed !== null && (typeof p.dismissed !== 'string' || !isHex32(p.dismissed)))
    || ((p.action === 'accept' || p.action === 'decline') && p.request === null)) {
    throw new Error('Invalid friend recipient, action or request reference.');
  }
  return { event, name: p.name, peer, action: p.action, request: p.request, dismissed: p.dismissed };
}

export function profileFilter(pubkey: string): Filter {
  return { kinds: [SOCIAL_KIND], authors: [pubkey], '#d': [PROFILE_TOPIC] };
}

export function commanderSearch(input: string): { filter: Filter; pubkey?: string; name?: string } {
  const text = input.trim();
  if (text.startsWith('npub1')) {
    try {
      const key = decode(text);
      if (key.type !== 'npub') throw new Error('Wrong key type');
      return { filter: profileFilter(key.data), pubkey: key.data };
    } catch {
      throw new Error('Invalid npub. Paste the complete npub public identity.');
    }
  }
  const name = normalizeDisplayName(text);
  return { filter: { kinds: [SOCIAL_KIND], '#d': [PROFILE_TOPIC], '#t': [nameTag(name)], limit: 100 }, name };
}

export function friendFilters(pubkey: string): Filter[] {
  return [
    { kinds: [SOCIAL_KIND], authors: [pubkey], '#t': [FRIEND_TOPIC] },
    { kinds: [SOCIAL_KIND], '#p': [pubkey], '#t': [FRIEND_TOPIC] },
  ];
}

/** Each author controls only their directed, replaceable state for a peer. */
export function deriveFriends(pubkey: string, records: Iterable<FriendRecord>): FriendEntry[] {
  const latest = new Map<string, FriendRecord>();
  for (const record of records) {
    if (record.event.pubkey !== pubkey && record.peer !== pubkey) continue;
    const key = `${record.event.pubkey}:${record.peer}`;
    if (newerEvent(record.event, latest.get(key)?.event)) latest.set(key, record);
  }
  const peers = new Set([...latest.values()].map(r => r.event.pubkey === pubkey ? r.peer : r.event.pubkey));
  const result: FriendEntry[] = [];
  for (const peer of peers) {
    const own = latest.get(`${pubkey}:${peer}`), other = latest.get(`${peer}:${pubkey}`);
    const accepted = (own?.action === 'accept' && other?.action === 'request' && own.request === other.event.id)
      || (other?.action === 'accept' && own?.action === 'request' && other.request === own.event.id);
    const incoming = other?.action === 'request' && own?.dismissed !== other.event.id ? other : undefined;
    const outgoing = own?.action === 'request'
      && !((other?.action === 'decline' || other?.action === 'remove') && other.request === own.event.id);
    if (accepted || incoming || outgoing) result.push({
      pubkey: peer, name: other?.name ?? '', state: accepted ? 'friends' : incoming ? 'incoming' : 'outgoing', incoming, own,
    });
  }
  return result.sort((a, b) => a.pubkey.localeCompare(b.pubkey));
}
