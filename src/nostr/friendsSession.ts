import type { NostrIdentity } from './identity';
import type { Event } from 'nostr-tools/pure';
import { generatedName } from './profile';
import {
  commanderSearch, deriveFriends, friendFilters, friendTemplate, newerEvent, parseFriend, parseProfile,
  PROFILE_TOPIC, SOCIAL_KIND, type CommanderProfile, type FriendAction, type FriendRecord,
} from './friendsProtocol';
import { SocialRelay, type SocialWire } from './socialRelay';

export interface CommanderResult { pubkey: string; name: string }

export class FriendsSession {
  private records = new Map<string, FriendRecord>();
  private stop: (() => void) | null = null;
  private alive = true;
  ready = false;
  busy = false;
  connection = 'Loading friends from relays...';
  notice = '';

  constructor(
    readonly identity: NostrIdentity, readonly name: string,
    private change: () => void, private wire: SocialWire = new SocialRelay(),
  ) {}

  get entries() { return deriveFriends(this.identity.pubkey, this.records.values()); }

  friendshipProof(peer: string): Event[] {
    if (!this.ready || this.entries.find(e => e.pubkey === peer)?.state !== 'friends') {
      throw new Error('Choose a current friend after friends have synchronized.');
    }
    return [
      this.records.get(`${this.identity.pubkey}:${peer}`)!.event,
      this.records.get(`${peer}:${this.identity.pubkey}`)!.event,
    ];
  }

  private receive(record: FriendRecord): void {
    if (record.event.pubkey !== this.identity.pubkey && record.peer !== this.identity.pubkey) {
      throw new Error('Ignored friend message for another account.');
    }
    const key = `${record.event.pubkey}:${record.peer}`;
    if (this.records.size >= 10000 && !this.records.has(key)) throw new Error('Friends history is too large to load safely.');
    if (newerEvent(record.event, this.records.get(key)?.event)) this.records.set(key, record);
  }

  refresh(): void {
    this.stop?.();
    this.ready = false;
    this.connection = 'Loading friends from relays...';
    this.change();
    this.stop = this.wire.watch(friendFilters(this.identity.pubkey), event => {
      if (!this.alive) return;
      try { this.receive(parseFriend(event)); }
      catch (error) { this.notice = error instanceof Error ? error.message : String(error); }
      this.change();
    }, state => {
      if (!this.alive) return;
      if (this.ready === state.ready && this.connection === state.status) return;
      this.ready = state.ready;
      this.connection = state.status;
      this.change();
    });
  }

  async search(input: string): Promise<{ results: CommanderResult[]; status: string }> {
    const search = commanderSearch(input);
    const snapshot = await this.wire.query([search.filter]);
    const profiles = new Map<string, CommanderProfile>();
    const collect = (events: typeof snapshot.events) => {
      for (const event of events) {
        const profile = parseProfile(event);
        if (newerEvent(event, profiles.get(event.pubkey)?.event)) profiles.set(event.pubkey, profile);
      }
    };
    collect(snapshot.events);
    let status = snapshot.status;
    if (search.name && profiles.size) {
      // Recheck current names: a lagging relay can still return a profile's old name tag.
      const current = await this.wire.query([{
        kinds: [SOCIAL_KIND], authors: [...profiles.keys()], '#d': [PROFILE_TOPIC],
      }]);
      collect(current.events);
      if (current.status !== status) status += ` ${current.status}`;
    }
    const results = [...profiles.values()]
      .filter(p => p.event.pubkey !== this.identity.pubkey
        && (search.pubkey ? p.event.pubkey === search.pubkey : p.name.toLowerCase() === search.name?.toLowerCase()))
      .map(p => ({ pubkey: p.event.pubkey, name: p.name }));
    if (search.pubkey && search.pubkey !== this.identity.pubkey && !results.length) {
      results.push({ pubkey: search.pubkey, name: generatedName(search.pubkey) });
      status += ' No published commander name found; showing a generated label. Verify the npub with your friend.';
    }
    return { results, status };
  }

  async act(peer: string, action: FriendAction): Promise<void> {
    if (!this.alive || this.busy || !this.ready) throw new Error('Wait for friends to synchronize before making changes.');
    if (peer === this.identity.pubkey) throw new Error('You cannot add yourself as a friend.');
    const entry = this.entries.find(e => e.pubkey === peer);
    if (action === 'request' && entry) throw new Error('You already have a friend or pending request for this commander.');
    if ((action === 'accept' || action === 'decline') && entry?.state !== 'incoming') throw new Error('This friend request is no longer pending.');
    if (action === 'remove' && (!entry || entry.state === 'incoming')) throw new Error('This friend or outgoing request is no longer active.');
    const other = this.records.get(`${peer}:${this.identity.pubkey}`);
    const request = action === 'request' ? null
      : other?.action === 'request' ? other.event.id : entry?.own?.event.id ?? null;
    const previous = this.records.get(`${this.identity.pubkey}:${peer}`)?.event;
    this.busy = true;
    this.change();
    try {
      const event = await this.identity.signEvent(friendTemplate(this.name, peer, action, request, previous));
      if (!this.alive) return;
      const current = this.entries.find(e => e.pubkey === peer);
      if (current?.own?.event.id !== entry?.own?.event.id || current?.incoming?.event.id !== entry?.incoming?.event.id
        || current?.state !== entry?.state) throw new Error('Friend state changed while signing. Review the current request and try again.');
      const result = await this.wire.publish(event);
      if (!this.alive) return;
      this.receive(parseFriend(event));
      const message = { request: 'Friend request sent', accept: 'Friend request accepted', decline: 'Friend request declined', remove: 'Friend or request removed' }[action];
      this.notice = `${message}. Saved by ${result.accepted}/${result.total} relays.${result.failures.length ? ` ${result.failures.join('; ')}` : ''}`;
    } finally {
      this.busy = false;
      if (this.alive) this.change();
    }
  }

  destroy(): void {
    this.alive = false;
    this.stop?.();
    this.wire.destroy();
  }
}
