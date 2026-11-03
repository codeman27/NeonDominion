import { afterEach, describe, expect, it, vi } from 'vitest';
import { SimplePool } from 'nostr-tools/pool';
import { AbstractRelay, type Subscription } from 'nostr-tools/abstract-relay';
import { RelayLobbyWire } from './lobbySession';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import { lobbyTemplate, type LobbyInvite } from './lobbyProtocol';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
const invite: LobbyInvite = { v: 1, id: 'ab'.repeat(32), host: 'cd'.repeat(32), relays: ['wss://relay.example/'] };
function relayFixture() {
  const relay = new AbstractRelay(invite.relays[0], { verifyEvent: () => true });
  vi.spyOn(relay, 'connected', 'get').mockReturnValue(true);
  vi.spyOn(relay, 'scheduleIdleClose').mockImplementation(() => {});
  vi.spyOn(relay, 'send').mockResolvedValue();
  const subscriptions: Subscription[] = [];
  vi.spyOn(relay, 'subscribe').mockImplementation((filters, params) => {
    const sub = relay.prepareSubscription(filters, params);
    subscriptions.push(sub);
    return sub;
  });
  vi.spyOn(SimplePool.prototype, 'ensureRelay').mockResolvedValue(relay);
  const connection = new Map([[invite.relays[0], true]]);
  vi.spyOn(SimplePool.prototype, 'listConnectionStatus').mockReturnValue(connection);
  return { relay, subscriptions, connection };
}

describe('relay lobby wire', () => {
  it('requires explicit EOSE, reports normalized connection status and ignores retired callbacks', async () => {
    vi.useFakeTimers();
    const { subscriptions, connection } = relayFixture();
    const status = vi.fn(), ready = vi.fn();
    const wire = new RelayLobbyWire();
    const stop = wire.subscribe(invite, vi.fn(), status, ready);
    await Promise.resolve();
    expect(ready).not.toHaveBeenCalledWith(true);
    expect(subscriptions[0].filters).toHaveLength(2);
    subscriptions[0].receivedEose();
    expect(ready).toHaveBeenLastCalledWith(true);
    expect(status).toHaveBeenLastCalledWith(expect.stringContaining('1/1 relays connected'));
    connection.set(invite.relays[0], false);
    vi.advanceTimersByTime(2000);
    expect(ready).toHaveBeenLastCalledWith(false);
    expect(status).toHaveBeenLastCalledWith(expect.stringContaining('Offline'));
    stop();
    ready.mockClear(); status.mockClear();
    subscriptions[0].oneose?.();
    subscriptions[0].onclose?.('late callback');
    vi.advanceTimersByTime(4000);
    expect(ready).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
    wire.destroy();
  });
  it('closes on a history timeout rather than treating it as successful catch-up', async () => {
    vi.useFakeTimers();
    const { subscriptions } = relayFixture();
    const ready = vi.fn(), status = vi.fn();
    const wire = new RelayLobbyWire();
    const stop = wire.subscribe(invite, vi.fn(), status, ready);
    await Promise.resolve();
    vi.advanceTimersByTime(10000);
    expect(subscriptions[0].closed).toBe(true);
    expect(ready).not.toHaveBeenCalledWith(true);
    expect(status).toHaveBeenLastCalledWith(expect.stringContaining('History did not finish'));
    subscriptions[0].oneose?.();
    expect(ready).not.toHaveBeenCalledWith(true);
    stop(); wire.destroy();
  });
  it('does not mark disconnected history ready even after EOSE', async () => {
    const { subscriptions, connection } = relayFixture();
    connection.clear();
    const ready = vi.fn();
    const wire = new RelayLobbyWire();
    const stop = wire.subscribe(invite, vi.fn(), vi.fn(), ready);
    await Promise.resolve();
    subscriptions[0].receivedEose();
    expect(ready).not.toHaveBeenCalledWith(true);
    stop(); wire.destroy();
  });
  it('reports connection failure and cleans up late connections after screen exit', async () => {
    const { subscriptions } = relayFixture();
    const ready = vi.fn(), status = vi.fn();
    const wire = new RelayLobbyWire();
    const stop = wire.subscribe(invite, vi.fn(), status, ready);
    stop();
    await Promise.resolve();
    expect(subscriptions).toHaveLength(0);
    vi.spyOn(SimplePool.prototype, 'ensureRelay').mockRejectedValue(new Error('connection refused'));
    const stopFailed = wire.subscribe(invite, vi.fn(), status, ready);
    await Promise.resolve(); await Promise.resolve();
    expect(ready).not.toHaveBeenCalledWith(true);
    expect(status).toHaveBeenLastCalledWith(expect.stringContaining('connection refused'));
    stopFailed(); wire.destroy();
  });
  it('reports partial and total rejection rather than treating dispatch as acknowledgment', async () => {
    const event = finalizeEvent(lobbyTemplate({ v: 1, type: 'request', name: 'Commander', active: true, seq: 1, prev: invite.id }, invite.id), generateSecretKey());
    const publish = vi.spyOn(SimplePool.prototype, 'publish').mockImplementation(() => [Promise.resolve('saved'), Promise.reject('blocked')]);
    const wire = new RelayLobbyWire();
    expect(await wire.publish(['wss://a/', 'wss://b/'], event)).toEqual({ accepted: 1, total: 2, failures: ['wss://b/: blocked'] });
    publish.mockImplementation(() => [Promise.reject('offline')]);
    expect(await wire.publish(invite.relays, event)).toEqual({ accepted: 0, total: 1, failures: ['wss://relay.example/: offline'] });
    wire.destroy();
  });
});
