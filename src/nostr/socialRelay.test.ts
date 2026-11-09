import { afterEach, describe, expect, it, vi } from 'vitest';
import { SimplePool } from 'nostr-tools/pool';
import { AbstractRelay, type Subscription } from 'nostr-tools/abstract-relay';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import { SocialRelay } from './socialRelay';
import { profileTemplate } from './friendsProtocol';
import { DEFAULT_RELAYS, normalizeRelays } from './lobbyProtocol';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

function fixture() {
  const subscriptions: Subscription[] = [];
  vi.spyOn(SimplePool.prototype, 'ensureRelay').mockImplementation(async url => {
    const relay = new AbstractRelay(url, { verifyEvent: () => true });
    vi.spyOn(relay, 'connected', 'get').mockReturnValue(true);
    vi.spyOn(relay, 'scheduleIdleClose').mockImplementation(() => {});
    vi.spyOn(relay, 'send').mockResolvedValue();
    vi.spyOn(relay, 'subscribe').mockImplementation((filters, params) => {
      const sub = relay.prepareSubscription(filters, params);
      subscriptions.push(sub);
      return sub;
    });
    return relay;
  });
  const connections = new Map(normalizeRelays(DEFAULT_RELAYS).map(url => [url, true]));
  vi.spyOn(SimplePool.prototype, 'listConnectionStatus').mockReturnValue(connections);
  return { subscriptions, connections };
}

describe('social relay delivery', () => {
  it('requires explicit history completion, reports partial failure and retires callbacks', async () => {
    vi.useFakeTimers();
    const { subscriptions } = fixture();
    const change = vi.fn(), receive = vi.fn();
    const wire = new SocialRelay();
    const stop = wire.watch([{ kinds: [30078] }], receive, change);
    await Promise.resolve();
    subscriptions[0].receivedEose();
    subscriptions[1].receivedEose();
    expect(change).not.toHaveBeenCalledWith(expect.objectContaining({ ready: true }));
    subscriptions[2].close('blocked');
    expect(change).toHaveBeenLastCalledWith(expect.objectContaining({ ready: true, status: expect.stringContaining('blocked') }));
    stop();
    change.mockClear();
    subscriptions[0].oneose?.();
    subscriptions[0].onclose?.('late');
    vi.advanceTimersByTime(2000);
    expect(change).not.toHaveBeenCalled();
    wire.destroy();
  });

  it('times out unfinished history instead of returning an empty successful result', async () => {
    vi.useFakeTimers();
    const { subscriptions } = fixture();
    const wire = new SocialRelay();
    const query = wire.query([{ kinds: [30078] }]);
    const rejected = expect(query).rejects.toThrow('Could not load friends data');
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(17000);
    await rejected;
    expect(subscriptions.every(s => s.closed)).toBe(true);
    wire.destroy();
  });

  it('deduplicates history and closes finite queries on EOSE', async () => {
    const { subscriptions } = fixture();
    const wire = new SocialRelay();
    const query = wire.query([{ kinds: [30078] }]);
    await Promise.resolve();
    const event = finalizeEvent(profileTemplate('Alice'), generateSecretKey());
    subscriptions[0].onevent?.(event);
    subscriptions[1].onevent?.(event);
    subscriptions.forEach(sub => sub.receivedEose());
    const snapshot = await query;
    expect(snapshot.events).toEqual([event]);
    expect(subscriptions.every(s => s.closed)).toBe(true);
    wire.destroy();
  });

  it('revokes readiness when all relays disconnect', async () => {
    vi.useFakeTimers();
    const { subscriptions, connections } = fixture();
    const wire = new SocialRelay(), change = vi.fn();
    wire.watch([{ kinds: [30078] }], vi.fn(), change);
    await Promise.resolve();
    subscriptions.forEach(sub => sub.receivedEose());
    expect(change).toHaveBeenLastCalledWith(expect.objectContaining({ ready: true }));
    connections.clear();
    vi.advanceTimersByTime(2000);
    expect(change).toHaveBeenLastCalledWith(expect.objectContaining({ ready: false }));
    wire.destroy();
  });

  it('cancels pending queries and prevents late subscriptions on screen exit', async () => {
    const { subscriptions } = fixture();
    const wire = new SocialRelay();
    const query = wire.query([{ kinds: [30078] }]);
    wire.destroy();
    await expect(query).rejects.toThrow('connection is closed');
    await Promise.resolve();
    expect(subscriptions).toHaveLength(0);
    await expect(wire.query([])).rejects.toThrow('connection is closed');
  });

  it('requires relay acknowledgments and exposes partial rejection', async () => {
    const wire = new SocialRelay();
    const event = finalizeEvent(profileTemplate('Alice'), generateSecretKey());
    const publish = vi.spyOn(SimplePool.prototype, 'publish').mockImplementation(() => [
      Promise.resolve('saved'), Promise.reject('blocked'), Promise.reject('offline'),
    ]);
    expect(await wire.publish(event)).toEqual({
      accepted: 1, total: 3, failures: [`${normalizeRelays(DEFAULT_RELAYS)[1]}: blocked`, `${normalizeRelays(DEFAULT_RELAYS)[2]}: offline`],
    });
    publish.mockImplementation(() => DEFAULT_RELAYS.map(() => Promise.reject('offline')));
    await expect(wire.publish(event)).rejects.toThrow('No relay saved the update');
    wire.destroy();
  });
});
