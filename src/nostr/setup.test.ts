import { describe, expect, it } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure';
import { computeStateHash } from '../crypto/stateHash';
import { MAP_GENERATOR_VERSION } from '../engine/mapGenerator';
import type { NostrIdentity } from './identity';
import { createLobby, LobbySession, setupStorageKey, type LobbyWire } from './lobbySession';
import { lobbyTemplate, parseLobbyEvent, type LobbyPayload } from './lobbyProtocol';
import { deriveSetup, seedCommitment } from './setupProtocol';

function storage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    data,
  };
}
function identity(): NostrIdentity {
  const key = generateSecretKey();
  return { pubkey: getPublicKey(key), source: 'guest', signEvent: async e => finalizeEvent(e, key) };
}
async function fixture(count = 2) {
  const events = new Map<string, Event>(), subscribers = new Set<(e: Event) => void>();
  const network = { accepted: 1 };
  const wire = (): LobbyWire => {
    let callback: ((e: Event) => void) | null = null;
    return {
      subscribe: (_invite, receive, status, ready) => {
        callback = receive; subscribers.add(receive);
        [...events.values()].reverse().forEach(receive); status('Connected'); ready(true);
        return () => { subscribers.delete(receive); };
      },
      publish: async (_relays, event) => {
        events.set(event.id, event); subscribers.forEach(fn => fn(event));
        return { accepted: network.accepted, total: 1, failures: network.accepted ? [] : ['Lost acknowledgment'] };
      },
      destroy: () => { if (callback) subscribers.delete(callback); },
    };
  };
  const ids = Array.from({ length: count }, identity);
  const stores = ids.map(storage);
  const host = await createLobby(ids[0], 'Host', 8, ['wss://example.test/'], wire());
  host.start(); await host.retry();
  const sessions = [host];
  for (let i = 1; i < count; i++) {
    const guest = new LobbySession(ids[i], host.invite, wire());
    guest.start(); await guest.requestJoin(`Guest ${i}`); await host.approve(ids[i].pubkey);
    sessions.push(guest);
  }
  const sign = async (seat: number, payload: LobbyPayload) => ids[seat].signEvent(lobbyTemplate(payload, host.invite.id));
  const cleanup = () => sessions.forEach(s => s.destroy());
  const start = () => host.startGame(stores[0]);
  const seed = async () => {
    await start();
    for (let i = 0; i < count; i++) await sessions[i].commitSeed(stores[i]);
    for (let i = count - 1; i >= 0; i--) await sessions[i].revealSeed(stores[i]);
  };
  const placements = (seat: number) => {
    const base = host.setup.base!;
    return [{ territoryId: base.territories.findIndex(t => t.owner === seat), troops: base.players[seat].setupTroops }];
  };
  return { host, sessions, ids, stores, events, network, wire, sign, cleanup, start, seed, placements };
}

describe('multiplayer Start Game and seed agreement', () => {
  it('only lets the host start, locks approved players rather than maximum capacity, and blocks lobby changes', async () => {
    const f = await fixture();
    await expect(f.sessions[1].startGame(f.stores[1])).rejects.toThrow('Only the host');
    await f.start();
    expect(f.host.state.members).toHaveLength(2);
    expect(f.host.state.start?.event.id).toBe(f.sessions[1].state.start?.event.id);
    await expect(f.host.startGame(f.stores[0])).rejects.toThrow('locked');
    await expect(f.host.closeLobby()).rejects.toThrow('locked');
    await expect(f.sessions[1].requestJoin('Guest 1', false)).rejects.toThrow('locked');
    f.cleanup();
  });
  it('requires at least two players and validates start version, signatures and prior approval', async () => {
    const f = await fixture(1);
    await expect(f.start()).rejects.toThrow('two approved');
    const request = 'ab'.repeat(32);
    const payload = {
      v: 1, type: 'start', members: [{ pubkey: identity().pubkey, name: 'Unknown', request }],
      mapGeneratorVersion: MAP_GENERATOR_VERSION, seq: 1, prev: f.host.invite.id,
    } as const;
    const invalidVersion = await f.ids[0].signEvent(lobbyTemplate({ ...payload, members: [...payload.members], mapGeneratorVersion: 999 }, f.host.invite.id));
    expect(() => parseLobbyEvent(invalidVersion, f.host.invite)).toThrow('unauthorized');
    f.cleanup();
    const approved = await fixture();
    const outsider = identity();
    const requestEvent = await outsider.signEvent(lobbyTemplate({
      v: 1, type: 'request', name: 'Unapproved', active: true, seq: 1, prev: approved.host.invite.id,
    }, approved.host.invite.id));
    approved.host.receive(requestEvent);
    const last = approved.host.state.roster!;
    if (last.payload.type !== 'roster') throw new Error('Missing roster');
    approved.host.receive(await approved.sign(0, {
      v: 1, type: 'start', members: [{ pubkey: outsider.pubkey, name: 'Unapproved', request: requestEvent.id }],
      mapGeneratorVersion: MAP_GENERATOR_VERSION, seq: last.payload.seq + 1, prev: last.event.id,
    }));
    expect(approved.host.state.conflict).toContain('unapproved');
    approved.cleanup();
  });
  it('waits for all commitments before revealing, and all reveals before creating the identical map and deal', async () => {
    const f = await fixture(3);
    await f.start();
    await f.sessions[0].commitSeed(f.stores[0]);
    await expect(f.sessions[0].revealSeed(f.stores[0])).rejects.toThrow('every commander');
    expect(f.sessions[0].setup.map).toBeNull();
    for (let i = 1; i < 3; i++) await f.sessions[i].commitSeed(f.stores[i]);
    await f.sessions[0].revealSeed(f.stores[0]);
    expect(f.host.setup.map).toBeNull();
    for (let i = 1; i < 3; i++) await f.sessions[i].revealSeed(f.stores[i]);
    for (const session of f.sessions) {
      expect(session.setup.baseHash).toBe(f.host.setup.baseHash);
      expect(session.setup.map).toEqual(f.host.setup.map);
      expect(session.setup.base?.players.every(p => !p.isBot)).toBe(true);
      expect(session.setup.base?.players.map(p => p.id)).toEqual(f.ids.map(i => i.pubkey));
    }
    f.cleanup();
  });
  it('restores a committed private contribution after reload without regenerating or broadcasting it early', async () => {
    const f = await fixture();
    await f.start();
    await f.sessions[1].commitSeed(f.stores[1]);
    const saved = f.stores[1].getItem(setupStorageKey(f.host.invite.id, f.ids[1].pubkey))!;
    const secret: string = JSON.parse(saved).secret;
    expect([...f.events.values()].some(e => e.content.includes(secret))).toBe(false);
    f.sessions[1].destroy();
    const restored = new LobbySession(f.ids[1], f.host.invite, f.wire());
    restored.restoreSetup(f.stores[1]);
    restored.start();
    await restored.retryPending(f.stores[1]);
    await f.host.commitSeed(f.stores[0]);
    await restored.revealSeed(f.stores[1]);
    await f.host.revealSeed(f.stores[0]);
    expect(restored.setup.baseHash).toBe(f.host.setup.baseHash);
    expect(JSON.parse(f.stores[1].getItem(setupStorageKey(f.host.invite.id, f.ids[1].pubkey))!).secret).toBe(secret);
    restored.destroy(); f.cleanup();
  });
  it('stops before broadcast on private storage failure, and visibly fails if the original secret is missing', async () => {
    const f = await fixture();
    await f.start();
    const before = f.events.size;
    await expect(f.sessions[1].commitSeed({ getItem: () => null, setItem: () => { throw new Error('Storage blocked'); } })).rejects.toThrow('Storage blocked');
    expect(f.events.size).toBe(before);
    const initial = storage();
    let writes = 0;
    await expect(f.sessions[1].commitSeed({
      getItem: initial.getItem,
      setItem: (key, value) => { if (++writes === 2) throw new Error('Signed binding storage blocked'); initial.setItem(key, value); },
    })).rejects.toThrow('Signed binding storage blocked');
    expect(f.events.size).toBe(before);
    await f.sessions[1].commitSeed(f.stores[1]); await f.host.commitSeed(f.stores[0]);
    await expect(f.sessions[1].revealSeed(storage())).rejects.toThrow('missing');
    expect(f.host.setup.map).toBeNull();
    f.cleanup();
  });
  it('halts on conflicting member commitments and wrong reveals, but ignores outsider setup actions', async () => {
    const f = await fixture();
    await f.start();
    await f.host.commitSeed(f.stores[0]);
    const start = f.host.state.start!.event.id;
    const outsider = identity();
    f.host.receive(await outsider.signEvent(lobbyTemplate({ v: 1, type: 'seed-commit', start, commitment: 'ab'.repeat(32) }, f.host.invite.id)));
    expect(f.host.setup.commits.size).toBe(1);
    await f.sessions[1].commitSeed(f.stores[1]);
    const wrong = await f.sign(1, {
      v: 1, type: 'seed-reveal', start, secret: 'ff'.repeat(32),
      commits: f.host.state.members.map(m => f.host.setup.commits.get(m.pubkey)!.event.id),
    });
    f.host.receive(wrong);
    expect(f.host.setup.conflict).toContain('does not match');
    expect(f.host.setup.map).toBeNull();
    const records = [...f.host.records.values()].filter(r => r.event.id !== wrong.id);
    const conflicting = parseLobbyEvent(await f.sign(0, { v: 1, type: 'seed-commit', start, commitment: 'cd'.repeat(32) }), f.host.invite);
    expect(deriveSetup(f.host.state, [...records, conflicting]).conflict).toContain('conflicting seed-commit');
    f.cleanup();
  });
  it('binds reveals to the exact ordered commitment IDs and isolates seed contributions by start and identity', async () => {
    const f = await fixture();
    await f.start();
    for (let i = 0; i < 2; i++) await f.sessions[i].commitSeed(f.stores[i]);
    const start = f.host.state.start!.event.id;
    f.host.receive(await f.sign(0, {
      v: 1, type: 'seed-reveal', start, secret: JSON.parse(f.stores[0].getItem(setupStorageKey(f.host.invite.id, f.ids[0].pubkey))!).secret,
      commits: f.host.state.members.map(m => f.host.setup.commits.get(m.pubkey)!.event.id).reverse(),
    }));
    expect(f.host.setup.conflict).toContain('different commitment roster');
    const secret = 'ab'.repeat(32);
    expect(seedCommitment(start, f.ids[0].pubkey, secret)).not.toBe(seedCommitment(start, f.ids[1].pubkey, secret));
    expect(seedCommitment(start, f.ids[0].pubkey, secret)).not.toBe(seedCommitment('cd'.repeat(32), f.ids[0].pubkey, secret));
    f.cleanup();
  });
});

describe('multiplayer setup deployment and replay', () => {
  it('produces identical final state hashes regardless of deployment arrival order and retains the exact map', async () => {
    const f = await fixture(3);
    await f.seed();
    const map = f.host.setup.map;
    for (let i = 2; i >= 0; i--) await f.sessions[i].deploySetup(f.placements(i), f.stores[i]);
    expect(f.host.setup.state!.players.every(p => p.setupDone)).toBe(true);
    const hash = computeStateHash(f.host.setup.state!);
    for (const session of f.sessions) expect(computeStateHash(session.setup.state!)).toBe(hash);
    expect(f.host.setup.map).toBe(map);
    const replay = new LobbySession(f.ids[1], f.host.invite, f.wire());
    for (const event of [...f.events.values()].reverse()) replay.receive(event);
    expect(computeStateHash(replay.setup.state!)).toBe(hash);
    expect(replay.setup.map).toEqual(map);
    replay.destroy(); f.cleanup();
  });
  it('rejects invalid local placement totals, enemy territory, duplicates and repeat deploys before signing', async () => {
    const f = await fixture();
    await f.seed();
    const mine = f.placements(0)[0], enemy = f.placements(1)[0].territoryId;
    await expect(f.host.deploySetup([{ ...mine, troops: 0 }], f.stores[0])).rejects.toThrow('must place exactly');
    await expect(f.host.deploySetup([{ ...mine, territoryId: enemy }], f.stores[0])).rejects.toThrow('not owned');
    await expect(f.host.deploySetup([mine, mine], f.stores[0])).rejects.toThrow('Duplicate');
    await f.host.deploySetup([mine], f.stores[0]);
    await expect(f.host.deploySetup([mine], f.stores[0])).rejects.toThrow('already locked');
    f.cleanup();
  });
  it('halts on wrong base hashes, invalid remote deployment and host start forks', async () => {
    const f = await fixture();
    await f.seed();
    f.host.receive(await f.sign(1, {
      v: 1, type: 'setup-deploy', start: f.host.state.start!.event.id, baseHash: 'ab'.repeat(32), placements: f.placements(1),
    }));
    expect(f.host.setup.conflict).toContain('Initial state hash');
    const start = f.host.state.start!.payload;
    if (start?.type !== 'start') throw new Error('Missing start');
    const fork = await f.ids[0].signEvent({ ...lobbyTemplate(start, f.host.invite.id), created_at: 1 });
    f.host.receive(fork);
    expect(f.host.state.conflict).toContain('conflicting rosters');
    expect(f.host.setup.map).toBeNull();
    f.cleanup();
  });
  it('halts on a signed enemy-territory deployment and on conflicting deployment signatures', async () => {
    const f = await fixture();
    await f.seed();
    const bad = await f.sign(1, {
      v: 1, type: 'setup-deploy', start: f.host.state.start!.event.id, baseHash: f.host.setup.baseHash!, placements: f.placements(0),
    });
    f.host.receive(bad);
    expect(f.host.setup.conflict).toContain('not owned');
    const second = await f.sign(1, {
      v: 1, type: 'setup-deploy', start: f.host.state.start!.event.id, baseHash: f.host.setup.baseHash!, placements: f.placements(1),
    });
    f.host.receive(second);
    expect(f.host.setup.conflict).toContain('conflicting setup-deploy');
    f.cleanup();
  });
  it('supports eight human commanders with even deals and correct setup pools', async () => {
    const f = await fixture(8);
    await f.seed();
    expect(f.host.setup.base?.players).toHaveLength(8);
    expect(f.host.setup.map?.territories).toHaveLength(48);
    for (let seat = 0; seat < 8; seat++) {
      expect(f.host.setup.base!.territories.filter(t => t.owner === seat)).toHaveLength(6);
      expect(f.host.setup.base!.players[seat].setupTroops).toBe(14);
      expect(f.sessions[seat].setup.baseHash).toBe(f.host.setup.baseHash);
    }
    f.cleanup();
  });
  it('retries the same durable signed setup event after lost acknowledgment and recovers without the lobby cache', async () => {
    const f = await fixture();
    await f.start();
    f.network.accepted = 0;
    await expect(f.sessions[1].commitSeed(f.stores[1])).rejects.toThrow('No relay acknowledged');
    const eventId = f.sessions[1].pendingPublish!.id;
    f.sessions[1].destroy();
    const restored = new LobbySession(f.ids[1], f.host.invite, f.wire());
    restored.restoreSetup(f.stores[1]); restored.start();
    f.network.accepted = 1;
    await restored.retryPending(f.stores[1]);
    expect(restored.setup.commits.get(f.ids[1].pubkey)!.event.id).toBe(eventId);
    expect(restored.pendingPublish).toBeNull();
    expect([...f.events.values()].filter(e => e.pubkey === f.ids[1].pubkey && JSON.parse(e.content).type === 'seed-commit')).toHaveLength(1);
    restored.destroy(); f.cleanup();
  });
  it('keeps the original deployment binding even if normal lobby history is lost and a different placement is attempted', async () => {
    const f = await fixture();
    await f.seed();
    await f.host.deploySetup(f.placements(0), f.stores[0]);
    const deployment = [...f.events.values()].find(e => e.pubkey === f.ids[0].pubkey && JSON.parse(e.content).type === 'setup-deploy')!;
    f.host.destroy(); f.events.delete(deployment.id);
    const restored = new LobbySession(f.ids[0], f.host.invite, f.wire());
    restored.start();
    const other = f.host.setup.base!.territories.findIndex((t, i) => t.owner === 0 && i !== f.placements(0)[0].territoryId);
    await expect(restored.deploySetup([{ territoryId: other, troops: f.placements(0)[0].troops }], f.stores[0])).rejects.toThrow('already signed with different data');
    restored.destroy(); f.cleanup();
  });
});
