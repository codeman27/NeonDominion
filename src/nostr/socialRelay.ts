import { SimplePool } from 'nostr-tools/pool';
import type { Subscription } from 'nostr-tools/abstract-relay';
import type { Filter } from 'nostr-tools/filter';
import type { Event } from 'nostr-tools/pure';
import type { NostrIdentity } from './identity';
import { DEFAULT_RELAYS, normalizeRelays } from './lobbyProtocol';
import { newerEvent, parseProfile, profileFilter, profileTemplate } from './friendsProtocol';

export interface SocialConnection { ready: boolean; status: string }
export interface SocialPublish { accepted: number; total: number; failures: string[] }
export interface SocialWire {
  watch(filters: Filter[], receive: (event: Event) => void, change: (state: SocialConnection) => void): () => void;
  query(filters: Filter[], maxEvents?: number): Promise<{ events: Event[]; status: string }>;
  publish(event: Event): Promise<SocialPublish>;
  destroy(): void;
}

export class SocialRelay implements SocialWire {
  private pool = new SimplePool({ enableReconnect: false });
  private relays = normalizeRelays(DEFAULT_RELAYS);
  private stops = new Set<() => void>();
  private cancellations = new Set<() => void>();
  private destroyed = false;

  watch(filters: Filter[], receive: (event: Event) => void, change: (state: SocialConnection) => void): () => void {
    if (this.destroyed) throw new Error('Friends connection is closed.');
    let active = true;
    const complete = new Set<string>(), settled = new Set<string>(), failures = new Map<string, string>();
    const subscriptions: Subscription[] = [];
    const timers: ReturnType<typeof setTimeout>[] = [];
    const update = () => {
      if (!active) return;
      const connected = this.pool.listConnectionStatus();
      const readyCount = [...complete].filter(url => connected.get(url)).length;
      change({
        ready: settled.size === this.relays.length && readyCount > 0,
        status: `${readyCount}/${this.relays.length} friends relays synchronized.${failures.size ? ` Relay errors: ${[...failures].map(([url, error]) => `${url}: ${error}`).join('; ')}. Refresh to retry.` : ''}`,
      });
    };
    for (const url of this.relays) {
      void this.pool.ensureRelay(url, { connectionTimeout: 5000 }).then(relay => {
        if (!active) return;
        let streamActive = true;
        let sub: Subscription | undefined;
        const timer = setTimeout(() => sub?.close('Friends history timed out'), 10000);
        timers.push(timer);
        sub = relay.subscribe(filters, {
          eoseTimeout: 2147483647,
          onevent: event => { if (active && streamActive) receive(event); },
          oneose: () => {
            if (!active || !streamActive) return;
            clearTimeout(timer);
            complete.add(url); settled.add(url); update();
          },
          onclose: reason => {
            streamActive = false;
            clearTimeout(timer);
            if (!active) return;
            complete.delete(url); settled.add(url); failures.set(url, reason); update();
          },
          oninvalidevent: () => { if (active) { failures.set(url, 'Ignored invalid signed event'); update(); } },
        });
        subscriptions.push(sub);
      }).catch((error: unknown) => {
        if (!active) return;
        settled.add(url); failures.set(url, error instanceof Error ? error.message : String(error)); update();
      });
    }
    const interval = setInterval(update, 2000);
    const stop = () => {
      if (!active) return;
      active = false;
      timers.forEach(clearTimeout);
      clearInterval(interval);
      subscriptions.forEach(sub => sub.close());
      this.stops.delete(stop);
    };
    this.stops.add(stop);
    return stop;
  }

  query(filters: Filter[], maxEvents = 10000): Promise<{ events: Event[]; status: string }> {
    if (this.destroyed) return Promise.reject(new Error('Friends connection is closed.'));
    return new Promise((resolve, reject) => {
      const events = new Map<string, Event>();
      let done = false;
      let lastStatus = 'No relay history completed.';
      const finish = (error?: Error, status = '') => {
        if (done) return;
        done = true;
        clearTimeout(timeout);
        stop();
        this.cancellations.delete(cancel);
        if (error) reject(error); else resolve({ events: [...events.values()], status });
      };
      const cancel = () => finish(new Error('Friends connection is closed.'));
      const timeout = setTimeout(() => finish(new Error(`Could not load friends data. Check your connection and refresh. ${lastStatus}`)), 17000);
      const stop = this.watch(filters, event => {
        if (events.size >= maxEvents && !events.has(event.id)) {
          finish(new Error('Relay history exceeds the supported event limit. Keep your local data and reconnect using the original game.'));
          return;
        }
        events.set(event.id, event);
      }, state => {
        lastStatus = state.status;
        if (state.ready) finish(undefined, state.status);
      });
      this.cancellations.add(cancel);
    });
  }

  async publish(event: Event): Promise<SocialPublish> {
    if (this.destroyed) throw new Error('Friends connection is closed.');
    const results = await Promise.allSettled(this.pool.publish(this.relays, event, { maxWait: 10000 }));
    const result = {
      accepted: results.filter(r => r.status === 'fulfilled').length, total: this.relays.length,
      failures: results.flatMap((r, i) => r.status === 'rejected' ? [`${this.relays[i]}: ${String(r.reason)}`] : []),
    };
    if (!result.accepted) throw new Error(`No relay saved the update. ${result.failures.join('; ')}`);
    return result;
  }

  destroy(): void {
    this.destroyed = true;
    this.cancellations.forEach(cancel => cancel());
    this.stops.forEach(stop => stop());
    queueMicrotask(() => this.pool.destroy());
  }
}

export async function publishCommanderProfile(wire: SocialWire, identity: NostrIdentity, name: string): Promise<string> {
  const snapshot = await wire.query([profileFilter(identity.pubkey)]);
  let latest: ReturnType<typeof parseProfile> | undefined;
  for (const event of snapshot.events) {
    const profile = parseProfile(event);
    if (event.pubkey === identity.pubkey && newerEvent(event, latest?.event)) latest = profile;
  }
  if (latest?.name === name) return `Commander name is searchable. ${snapshot.status}`;
  const event = await identity.signEvent(profileTemplate(name, latest?.event));
  const result = await wire.publish(event);
  return `Commander name published to ${result.accepted}/${result.total} relays.${result.failures.length ? ` ${result.failures.join('; ')}` : ''}`;
}
