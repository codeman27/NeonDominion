import { describe, expect, it, vi } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure';
import { canonicalStringify } from '../crypto/stateHash';
import { createHashChain } from '../crypto/hashChain';
import { sha256Hex } from '../crypto/prng';
import { computeReinforcements, witnessFor } from '../engine/turnEngine';
import { bestSet } from '../engine/rules';
import { applyDecision, derivePlay, parseDecision, PLAY_CHAIN_LENGTH, playHash, validateDecision, type PlaySnapshot } from './playProtocol';
import { createLobby, LobbySession, type LobbyWire } from './lobbySession';
import { lobbyTemplate, parseLobbyEvent, type LobbyPayload, type LobbyRecord } from './lobbyProtocol';
import type { NostrIdentity } from './identity';
import { beaconTime, BEACON_CHAIN } from './beacon';

const proof = { round: 1000, signature: 'b44679b9a59af2ec876b1a6b1ad52ea9b1615fc3982b19576350f93447cb1125e342b73a8dd2bacbe47e4b6b63ed5e39' };

async function fixture(count = 2) {
  const events = new Map<string, Event>(), listeners = new Set<(e: Event) => void>();
  const network = { accepted: 1, delivered: true, attempts: [] as Event[], failAt: -1 };
  const wire = (): LobbyWire => {
    let cb: ((e: Event) => void) | null = null;
    return {
      subscribe: (_, receive, _status, ready) => {
        cb = receive; listeners.add(receive); [...events.values()].reverse().forEach(receive); ready(true);
        return () => { listeners.delete(receive); };
      },
      publish: async (_, event) => {
        network.attempts.push(event);
        events.set(event.id, event);
        if (network.delivered) listeners.forEach(fn => fn(event));
        const accepted = network.attempts.length === network.failAt ? 0 : network.accepted;
        return { accepted, total: 1, failures: accepted ? [] : ['Lost acknowledgment'] };
      },
      destroy: () => { if (cb) listeners.delete(cb); },
    };
  };
  const ids = Array.from({ length: count }, (): NostrIdentity => {
    const key = generateSecretKey();
    return { pubkey: getPublicKey(key), source: 'guest', signEvent: async e => finalizeEvent(e, key) };
  });
  const stores = ids.map(() => {
    const data = new Map<string, string>();
    return { data, getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
  });
  const host = await createLobby(ids[0], 'Host', 8, ['wss://example.test/'], wire());
  host.start(); await host.retry();
  const sessions = [host];
  for (let i = 1; i < count; i++) {
    const guest = new LobbySession(ids[i], host.invite, wire());
    guest.start(); await guest.requestJoin(`Guest ${i}`); await host.approve(ids[i].pubkey); sessions.push(guest);
  }
  await host.startGame(stores[0]);
  for (let i = 0; i < count; i++) await sessions[i].commitSeed(stores[i]);
  for (let i = 0; i < count; i++) await sessions[i].revealSeed(stores[i]);
  for (let i = 0; i < count; i++) {
    const state = host.setup.base!, map = host.setup.map!;
    const territoryId = state.territories.findIndex((t, id) => t.owner === i && map.territories[id].neighbors.some(n => state.territories[n].owner !== i));
    await sessions[i].deploySetup([{ territoryId, troops: state.players[i].setupTroops }], stores[i]);
  }
  const ready = async () => { for (let i = 0; i < count; i++) await sessions[i].preparePlay(stores[i]); };
  const draft = async () => {
    const snap = host.play.snapshot!, seat = snap.state.activePlayerIndex;
    const territoryId = snap.state.territories.findIndex(t => t.owner === seat && t.troops > 1);
    const troops = computeReinforcements(host.setup.map!, snap.state, seat, []).total;
    await sessions[seat].submitPlay({ kind: 'draft', trades: [], placements: [{ territoryId, troops }] }, stores[seat]);
  };
  const attack = async () => {
    const snap = host.play.snapshot!, seat = snap.state.activePlayerIndex;
    const from = snap.state.territories.findIndex((t, id) => t.owner === seat && t.troops > 1 && host.setup.map!.territories[id].neighbors.some(n => snap.state.territories[n].owner !== seat));
    const to = host.setup.map!.territories[from].neighbors.find(n => snap.state.territories[n].owner !== seat)!;
    await sessions[seat].submitPlay({ kind: 'attack', from, to, dice: 3, stop: 0 }, stores[seat]);
    return { from, to };
  };
  const sign = async (seat: number, payload: LobbyPayload) => ids[seat].signEvent(lobbyTemplate(payload, host.invite.id));
  const cleanup = () => sessions.forEach(s => s.destroy());
  return { host, sessions, ids, stores, events, network, wire, ready, draft, attack, sign, cleanup };
}

describe('signed multiplayer turns', () => {
  it('bootstraps existing deployments without changing armies, then synchronizes draft, private attack, witness, move, card and next turn', async () => {
    const f = await fixture();
    const armies = f.host.setup.state!.territories.map(t => t.troops);
    await f.sessions[0].preparePlay(f.stores[0]);
    expect(f.host.play.snapshot).toBeNull();
    await f.sessions[1].preparePlay(f.stores[1]);
    expect(f.host.play.snapshot!.state.territories.map(t => t.troops)).toEqual(armies);
    expect(f.host.play.snapshot!.state.players.every(p => p.currentHashCommitment.length === 64)).toBe(true);
    await f.draft();
    const before = f.host.play.hash;
    await f.attack();
    expect(f.host.play.hash).toBe(before);
    expect(f.host.play.pending).not.toBeNull();
    await expect(f.host.revealAttack(f.stores[0])).rejects.toThrow('not the designated');
    await expect(f.host.submitPlay({ kind: 'end', fortify: null }, f.stores[0])).rejects.toThrow('already locked');
    await f.sessions[1].revealAttack(f.stores[1]);
    expect(f.host.play.lastBattle!.waves.length).toBeGreaterThan(0);
    if (f.host.play.snapshot!.move) {
      const snap = f.host.play.snapshot!;
      await expect(f.host.submitPlay({ kind: 'end', fortify: null }, f.stores[0])).rejects.toThrow('conquest movement');
      await expect(f.host.submitPlay({ kind: 'move', troops: snap.state.territories[snap.move!.from].troops }, f.stores[0])).rejects.toThrow('leaving one');
      await f.host.submitPlay({ kind: 'move', troops: snap.move!.min }, f.stores[0]);
    }
    const conquered = f.host.play.snapshot!.conquered;
    await f.host.submitPlay({ kind: 'end', fortify: null }, f.stores[0]);
    expect(f.host.play.snapshot!.state.players[0].cards).toHaveLength(conquered ? 1 : 0);
    expect(f.host.play.snapshot!.state.activePlayerIndex).toBe(1);
    expect(f.host.play.snapshot!.phase).toBe('draft');
    expect(f.host.play.hash).toBe(f.sessions[1].play.hash);
    expect(f.host.play.snapshot!.state.players[1].hashChainIndex).toBe(1);
    for (const [key, value] of f.stores[1].data) if (key.includes('play-root')) expect([...f.events.values()].some(e => e.content.includes(value))).toBe(false);
    f.cleanup();
  });
  it('authorizes turns, exact reinforcements, Stop At attacking armies, and connected exact fortification', async () => {
    const f = await fixture(); await f.ready();
    await expect(f.sessions[1].submitPlay({ kind: 'end', fortify: null }, f.stores[1])).rejects.toThrow('not your turn');
    await expect(f.host.submitPlay({ kind: 'draft', trades: [], placements: [] }, f.stores[0])).rejects.toThrow('exactly');
    await f.draft();
    const snap = f.host.play.snapshot!, map = f.host.setup.map!;
    const from = snap.state.territories.findIndex(t => t.owner === 0 && t.troops > 1);
    const to = map.territories[from].neighbors.find(n => snap.state.territories[n].owner !== 0)!;
    const troops = snap.state.territories[from].troops;
    expect(() => validateDecision(map, snap, { kind: 'attack', from, to, dice: 3, stop: troops })).toThrow('above Stop At');
    expect(() => validateDecision(map, snap, { kind: 'attack', from, to, dice: 3, stop: troops - 1 })).not.toThrow();
    const owned = snap.state.territories.findIndex((t, id) => t.owner === 0 && id !== from);
    await expect(f.host.submitPlay({ kind: 'end', fortify: { fromTerritoryId: from, toTerritoryId: owned, troops } }, f.stores[0])).rejects.toThrow('leave one');
    await expect(f.host.submitPlay({ kind: 'end', fortify: { fromTerritoryId: from, toTerritoryId: to, troops: 1 } }, f.stores[0])).rejects.toThrow('connected');
    f.cleanup();
  });
  it('replays reverse, duplicate and incomplete history identically after reconnect during an attack', async () => {
    const f = await fixture(3); await f.ready(); await f.draft(); await f.attack();
    const seat = witnessFor(f.host.play.snapshot!.state);
    f.sessions[seat].destroy();
    const restored = new LobbySession(f.ids[seat], f.host.invite, f.wire());
    restored.start();
    expect(restored.play.pending!.event.id).toBe(f.host.play.pending!.event.id);
    await restored.revealAttack(f.stores[seat]);
    const reverse = [...f.events.values()].reverse().map(e => parseLobbyEvent(e, f.host.invite));
    const replay = derivePlay(f.host.state, f.host.setup, reverse);
    expect(replay.conflict).toBeNull(); expect(replay.hash).toBe(f.host.play.hash);
    const copy = new LobbySession(f.ids[0], f.host.invite, f.wire());
    for (const e of [...f.events.values()].reverse()) { copy.receive(e); copy.receive(e); }
    expect(copy.play.hash).toBe(f.host.play.hash);
    expect(copy.play.lastBattle).toEqual(f.host.play.lastBattle);
    copy.destroy(); restored.destroy(); f.cleanup();
  });
  it('persists exact signed action and per-secret reveal before publication, and retries lost acknowledgments unchanged', async () => {
    const f = await fixture(); await f.ready();
    f.network.accepted = 0;
    await expect(f.draft()).rejects.toThrow('No relay acknowledged');
    const draftId = f.host.pendingPublish!.id;
    expect([...f.stores[0].data.values()].some(v => v.includes(draftId))).toBe(true);
    f.network.accepted = 1; await f.host.retryPending(f.stores[0]);
    expect(f.host.pendingPublish).toBeNull(); expect(f.events.has(draftId)).toBe(true);
    await f.attack();
    f.network.accepted = 0;
    await expect(f.sessions[1].revealAttack(f.stores[1])).rejects.toThrow('No relay acknowledged');
    const revealId = f.sessions[1].pendingPublish!.id;
    expect([...f.stores[1].data.values()].some(v => v.includes(revealId))).toBe(true);
    f.network.accepted = 1; await f.sessions[1].retryPending(f.stores[1]);
    expect([...f.events.values()].filter(e => JSON.parse(e.content).type === 'play-reveal')).toHaveLength(1);
    expect(f.host.play.hash).toBe(f.sessions[1].play.hash); f.cleanup();
  });
  it('recovers the exact durable action after both the ordinary cache and relay copy were lost, without allowing an alternate action', async () => {
    const f = await fixture(); await f.ready();
    f.network.accepted = 0; f.network.delivered = false;
    await expect(f.draft()).rejects.toThrow('No relay acknowledged');
    const signed = f.host.pendingPublish!;
    f.events.delete(signed.id);
    f.host.destroy();
    const restored = new LobbySession(f.ids[0], f.host.invite, f.wire()); restored.start();
    const seat = restored.play.snapshot!.state.activePlayerIndex;
    const original = JSON.parse(signed.content).decision.placements[0];
    const id = restored.play.snapshot!.state.territories.findIndex((t, i) => t.owner === seat && i !== original.territoryId);
    await expect(restored.submitPlay({ kind: 'draft', trades: [], placements: [{ territoryId: id, troops: original.troops }] }, f.stores[0])).rejects.toThrow('already bound');
    f.network.accepted = 1; f.network.delivered = true;
    await restored.resumePlay(f.stores[0]);
    expect(f.events.get(signed.id)).toEqual(signed);
    expect(restored.play.snapshot!.phase).toBe('attack');
    expect(restored.play.hash).toBe(f.sessions[1].play.hash);
    restored.destroy(); f.cleanup();
  });
  it('halts incorrect state references and witness equivocation after an already resolved attack', async () => {
    const f = await fixture(); await f.ready(); await f.draft(); await f.attack();
    const pending = f.host.play.pending!, index = f.host.play.index;
    await f.sessions[1].revealAttack(f.stores[1]);
    const reveal = [...f.events.values()].find(e => JSON.parse(e.content).type === 'play-reveal')!;
    f.host.receive(await f.sign(1, { ...JSON.parse(reveal.content), commit: '12'.repeat(32) }));
    expect(f.host.play.conflict).toContain('conflicting reveals');
    const g = await fixture(); await g.ready();
    g.host.receive(await g.sign(0, {
      v: 1, type: 'play-action', start: g.host.state.start!.event.id, index: g.host.play.index,
      prev: 'ab'.repeat(32), stateHash: g.host.play.hash, decision: { kind: 'end', fortify: null },
    }));
    expect(g.host.play.conflict).toContain('different predecessor');
    expect(pending.event.id).not.toBe(reveal.id); expect(index).toBe(2);
    f.cleanup(); g.cleanup();
  });
  it('refuses private-root loss, persistence failure, reused secrets, and 8192-chain exhaustion', async () => {
    const f = await fixture(); await f.ready(); await f.draft(); await f.attack();
    await expect(f.sessions[1].revealAttack({ getItem: () => null, setItem: () => {} })).rejects.toThrow('missing');
    const count = f.events.size;
    await expect(f.sessions[1].revealAttack({ getItem: f.stores[1].getItem, setItem: () => { throw new Error('Storage full'); } })).rejects.toThrow('Storage full');
    expect(f.events.size).toBe(count);
    const snap = structuredClone(f.host.play.snapshot!);
    snap.state.players[1].hashChainIndex = PLAY_CHAIN_LENGTH;
    const attack = f.host.play.pending!.payload;
    if (attack.type !== 'play-action') throw new Error('Missing attack');
    expect(() => validateDecision(f.host.setup.map!, snap, attack.decision)).toThrow('exhausted');
    const wrong = await f.sign(1, { v: 1, type: 'play-reveal', start: f.host.state.start!.event.id, index: f.host.play.index, commit: f.host.play.pending!.event.id, secret: 'ab'.repeat(32), chainIndex: 1 });
    f.host.receive(wrong); expect(f.host.play.conflict).toContain('Invalid or reused');
    f.cleanup();
  });
  it('halts action/ready/witness forks instead of choosing timestamps; ignores outsiders', async () => {
    const f = await fixture(); await f.ready(); await f.draft();
    const index = f.host.play.index, prev = f.host.play.prev, stateHash = f.host.play.hash, start = f.host.state.start!.event.id;
    await f.host.submitPlay({ kind: 'end', fortify: null }, f.stores[0]);
    const fork = await f.sign(0, { v: 1, type: 'play-action', start, index, prev, stateHash, decision: { kind: 'attack', from: 0, to: 1, dice: 1, stop: 0 } });
    f.host.receive(fork); expect(f.host.play.conflict).toContain('conflicting actions');
    const g = await fixture(); await g.ready();
    const outsiderKey = generateSecretKey();
    g.host.receive(finalizeEvent(lobbyTemplate({ v: 1, type: 'play-ready', start: g.host.state.start!.event.id, setupHash: 'ab'.repeat(32), head: 'cd'.repeat(32), length: PLAY_CHAIN_LENGTH }, g.host.invite.id), outsiderKey));
    expect(g.host.play.conflict).toBeNull();
    const old = [...g.events.values()].find(e => e.pubkey === g.ids[0].pubkey && JSON.parse(e.content).type === 'play-ready')!;
    const payload = JSON.parse(old.content);
    g.host.receive(await g.sign(0, { ...payload, head: 'ab'.repeat(32) }));
    expect(g.host.play.conflict).toContain('conflicting witness commitments');
    f.cleanup(); g.cleanup();
  });
});

describe('multiplayer deterministic rules', () => {
  it('validates bounded action shapes, duplicate placements, integers and exactly 8192 committed secrets', () => {
    expect(() => parseDecision({ kind: 'attack', from: 0, to: 1, dice: 4, stop: 0 })).toThrow();
    expect(() => parseDecision({ kind: 'move', troops: 1.5 })).toThrow();
    expect(() => parseDecision({ kind: 'draft', trades: [], placements: [{ territoryId: 0, troops: 1 }, { territoryId: 0, troops: 2 }] })).toThrow('Duplicate');
    const chain = createHashChain('12'.repeat(32), PLAY_CHAIN_LENGTH);
    expect(chain.secrets).toHaveLength(8192);
    expect(chain.secrets[8191]).toBe('12'.repeat(32));
  });

  describe('asynchronous beacon turns', () => {
    it('plays a whole turn with the opponent disconnected, then lets the opponent catch up later', async () => {
      const f = await fixture();
      f.sessions[1].destroy();
      await f.host.prepareAsyncPlay(f.stores[0]);
      expect(f.host.play.snapshot!.randomness).toBe('drand-quicknet-v1');
      expect(f.host.play.ready.size).toBe(0);
      await f.draft();
      const clock = vi.spyOn(Date, 'now').mockReturnValue((beaconTime(1000) - 10) * 1000);
      try { await f.attack(); } finally { clock.mockRestore(); }
      const commit = f.host.play.pending!;
      if (commit.payload.type !== 'play-action') throw new Error('Missing attack');
      expect(commit.payload.beaconRound).toBe(1000);
      await f.host.resolveBeacon(f.stores[0], async () => proof);
      expect(f.host.play.lastBattle!.waves.length).toBeGreaterThan(0);
      if (f.host.play.snapshot!.move) await f.host.submitPlay({ kind: 'move', troops: f.host.play.snapshot!.move!.min }, f.stores[0]);
      await f.host.submitPlay({ kind: 'end', fortify: null }, f.stores[0]);
      expect(f.host.play.snapshot!.state.activePlayerIndex).toBe(1);
      expect([...f.events.values()].some(e => JSON.parse(e.content).type === 'play-reveal')).toBe(false);
      const guest = new LobbySession(f.ids[1], f.host.invite, f.wire()); guest.start();
      expect(guest.play.hash).toBe(f.host.play.hash);
      expect(guest.play.snapshot).toEqual(f.host.play.snapshot);
      f.host.destroy();
      const snap = guest.play.snapshot!, territoryId = snap.state.territories.findIndex(t => t.owner === 1);
      const troops = computeReinforcements(guest.setup.map!, snap.state, 1, []).total;
      await guest.submitPlay({ kind: 'draft', trades: [], placements: [{ territoryId, troops }] }, f.stores[1]);
      await guest.submitPlay({ kind: 'end', fortify: null }, f.stores[1]);
      expect(guest.play.snapshot!.state.activePlayerIndex).toBe(0);
      expect(guest.play.snapshot!.round).toBe(2);
      guest.destroy(); f.cleanup();
    });

    describe('responsive Nostr-only dice', () => {
      it('does not contact relays during a turn, including after disconnecting, and flushes the exact ordered events once', async () => {
        const f = await fixture(); await f.host.prepareNostrPlay(f.stores[0]);
        const attempts = f.network.attempts.length, remoteHash = f.sessions[1].play.hash;
        await f.draft();
        f.host.historyReady = false;
        await f.attack();
        if (f.host.play.snapshot!.move) await f.host.submitPlay({ kind: 'move', troops: f.host.play.snapshot!.move!.min }, f.stores[0]);
        const conquered = f.host.play.snapshot!.conquered;
        const local = [...f.host.records.values()].filter(r => r.payload.type === 'play-action').map(r => r.event);
        expect(f.network.attempts).toHaveLength(attempts);
        expect(f.sessions[1].play.hash).toBe(remoteHash);
        expect(f.host.hasLocalTurn).toBe(true);
        await f.host.submitPlay({ kind: 'end', fortify: null }, f.stores[0]);
        expect(f.network.attempts.slice(attempts, -1)).toEqual(local);
        expect(JSON.parse(f.network.attempts.at(-1)!.content).decision.kind).toBe('end');
        expect(f.host.play.hash).toBe(f.sessions[1].play.hash);
        expect(f.host.play.snapshot!.state.players[0].cards).toHaveLength(conquered ? 1 : 0);
        expect(f.host.hasLocalTurn).toBe(false);
        expect(f.host.publishingTurn).toBe(false);
        f.cleanup();
      });
      it('retries a partially delivered completed turn after reload without resigning, duplicating cards or permitting the next turn', async () => {
        const f = await fixture(); await f.host.prepareNostrPlay(f.stores[0]); await f.draft(); await f.attack();
        if (f.host.play.snapshot!.move) await f.host.submitPlay({ kind: 'move', troops: f.host.play.snapshot!.move!.min }, f.stores[0]);
        const attempts = f.network.attempts.length;
        f.network.failAt = attempts + 2;
        await expect(f.host.submitPlay({ kind: 'end', fortify: null }, f.stores[0])).rejects.toThrow('No relay acknowledged');
        const completed = structuredClone(f.host.play.snapshot), hash = f.host.play.hash;
        expect(f.host.publishingTurn).toBe(true);
        expect(f.host.pendingPublish).not.toBeNull();
        f.host.destroy();
        const sign = vi.spyOn(f.ids[0], 'signEvent');
        const restored = new LobbySession(f.ids[0], f.host.invite, f.wire()); restored.start(); restored.restoreTurn(f.stores[0]);
        expect(restored.play.hash).toBe(hash);
        await expect(restored.submitPlay({ kind: 'end', fortify: null }, f.stores[0])).rejects.toThrow('Retry sending');
        await restored.retryPending(f.stores[0]);
        expect(sign).not.toHaveBeenCalled();
        expect(restored.play.snapshot).toEqual(completed);
        expect(f.sessions[1].play.hash).toBe(hash);
        expect(restored.pendingPublish).toBeNull();
        expect(restored.publishingTurn).toBe(false);
        expect(f.network.attempts.slice(attempts, attempts + 2)).toEqual(f.network.attempts.slice(attempts + 2, attempts + 4));
        restored.destroy(); f.cleanup();
      });
      it('blocks corrupted or foreign outboxes rather than silently discarding the local turn', async () => {
        const f = await fixture(); await f.host.prepareNostrPlay(f.stores[0]); await f.draft();
        const key = [...f.stores[0].data.keys()].find(k => k.includes('turn-outbox'))!;
        const good = f.stores[0].getItem(key)!;
        f.stores[0].setItem(key, '{invalid');
        const restored = new LobbySession(f.ids[0], f.host.invite, f.wire()); restored.start();
        expect(() => restored.restoreTurn(f.stores[0])).toThrow('Could not restore your saved turn');
        await expect(restored.submitPlay({ kind: 'end', fortify: null }, f.stores[0])).rejects.toThrow('saved turn');
        f.stores[0].setItem(key, good);
        restored.restoreTurn(f.stores[0]);
        expect(restored.play.hash).toBe(f.host.play.hash);
        const guestKey = key.replace(f.ids[0].pubkey, f.ids[1].pubkey);
        f.stores[1].setItem(guestKey, good);
        expect(() => f.sessions[1].restoreTurn(f.stores[1])).toThrow('Invalid signed turn queue');
        restored.destroy(); f.cleanup();
      });
      it('keeps the completed batch retryable if saving the final acknowledgment fails', async () => {
        const f = await fixture(); await f.host.prepareNostrPlay(f.stores[0]); await f.draft();
        const storage = { getItem: f.stores[0].getItem, setItem: (key: string, value: string) => {
          if (key.includes('turn-outbox') && JSON.parse(value).events.length === 0) throw new Error('Storage full after delivery');
          f.stores[0].setItem(key, value);
        } };
        await expect(f.host.submitPlay({ kind: 'end', fortify: null }, storage)).rejects.toThrow('Storage full after delivery');
        const completed = f.host.play.hash;
        expect(f.host.publishingTurn).toBe(true);
        expect(f.sessions[1].play.hash).toBe(completed);
        await f.host.retryPending(f.stores[0]);
        expect(f.host.publishingTurn).toBe(false);
        expect(f.host.play.hash).toBe(completed);
        expect(f.host.play.snapshot!.state.players[0].cards).toHaveLength(0);
        f.cleanup();
      });
      it('detects a concurrent change to the local turn before publishing or accepting another action', async () => {
        const f = await fixture(); await f.host.prepareNostrPlay(f.stores[0]); await f.draft();
        const key = [...f.stores[0].data.keys()].find(k => k.includes('turn-outbox'))!;
        const before = f.network.attempts.length, hash = f.host.play.hash;
        f.stores[0].setItem(key, JSON.stringify({ events: [], publishing: false }));
        await expect(f.host.submitPlay({ kind: 'end', fortify: null }, f.stores[0])).rejects.toThrow('Another tab changed');
        expect(f.host.play.hash).toBe(hash);
        expect(f.network.attempts).toHaveLength(before);
        f.cleanup();
      });
      it('resolves attacks immediately without opponents, fetches, witnesses, timers or fabricated results', async () => {
        const f = await fixture(); f.sessions[1].destroy();
        const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('External requests forbidden'));
        try {
          await f.host.prepareNostrPlay(f.stores[0]);
          expect(f.host.play.snapshot!.randomness).toBe('nostr-dice-v1');
          await f.draft(); await f.attack();
          expect(f.host.play.pending).toBeNull();
          expect(f.host.play.lastBattle!.waves.length).toBeGreaterThan(0);
          const attack = [...f.host.records.values()].find(r => r.payload.type === 'play-action' && r.payload.decision.kind === 'attack')!.event;
          expect(f.events.has(attack.id)).toBe(false);
          expect(JSON.parse(attack.content).diceNonce).toMatch(/^[a-f0-9]{64}$/);
          expect(JSON.parse(attack.content).beaconRound).toBeUndefined();
          if (f.host.play.snapshot!.move) await f.host.submitPlay({ kind: 'move', troops: f.host.play.snapshot!.move!.min }, f.stores[0]);
          await f.host.submitPlay({ kind: 'end', fortify: null }, f.stores[0]);
          const restored = new LobbySession(f.ids[1], f.host.invite, f.wire()); restored.start();
          expect(restored.play.hash).toBe(f.host.play.hash);
          expect(restored.play.lastBattle).toEqual(f.host.play.lastBattle);
          expect(restored.play.snapshot!.state.activePlayerIndex).toBe(1);
          expect(fetch).not.toHaveBeenCalled(); restored.destroy();
        } finally { fetch.mockRestore(); f.cleanup(); }
      });
      it('saves the entire turn locally, restores identical dice without the cache, and publishes only at Finish Turn', async () => {
        const f = await fixture(); await f.host.prepareNostrPlay(f.stores[0]); await f.draft();
        const remoteHash = f.sessions[1].play.hash, count = f.events.size;
        f.network.accepted = 0; f.network.delivered = false;
        await f.attack();
        const signed = [...f.host.records.values()].find(r => r.payload.type === 'play-action' && r.payload.decision.kind === 'attack')!.event;
        expect([...f.stores[0].data.values()].some(v => v.includes(signed.id))).toBe(true);
        expect(f.events.size).toBe(count);
        expect(f.host.pendingPublish).toBeNull();
        expect(f.sessions[1].play.hash).toBe(remoteHash);
        const hash = f.host.play.hash, battle = structuredClone(f.host.play.lastBattle);
        f.host.destroy();
        const restored = new LobbySession(f.ids[0], f.host.invite, f.wire()); restored.start();
        await restored.resumePlay(f.stores[0]);
        expect(restored.play.hash).toBe(hash);
        expect(restored.play.lastBattle).toEqual(battle);
        expect(f.events.size).toBe(count);
        if (restored.play.snapshot!.move) await restored.submitPlay({ kind: 'move', troops: restored.play.snapshot!.move!.min }, f.stores[0]);
        f.network.accepted = 1; f.network.delivered = true;
        await restored.submitPlay({ kind: 'end', fortify: null }, f.stores[0]);
        expect(f.events.get(signed.id)).toEqual(signed);
        expect(restored.play.pending).toBeNull();
        expect(restored.play.lastBattle).toEqual(f.sessions[1].play.lastBattle);
        expect(restored.play.hash).toBe(f.sessions[1].play.hash);
        const completedHash = restored.play.hash;
        restored.receive(signed);
        expect(restored.play.hash).toBe(completedHash);
        expect(restored.hasLocalTurn).toBe(false);
        restored.destroy(); f.cleanup();
      });
      it('rejects publication on binding storage failure and never permits a replacement attack at the same slot', async () => {
        const f = await fixture(); await f.host.prepareNostrPlay(f.stores[0]); await f.draft();
        const snap = f.host.play.snapshot!, map = f.host.setup.map!;
        const from = snap.state.territories.findIndex(t => t.owner === 0 && t.troops > 1);
        const to = map.territories[from].neighbors.find(n => snap.state.territories[n].owner !== 0)!;
        const decision = { kind: 'attack' as const, from, to, dice: 3, stop: 0 };
        const count = f.events.size;
        await expect(f.host.submitPlay(decision, { getItem: f.stores[0].getItem, setItem: () => { throw new Error('Storage full'); } })).rejects.toThrow('Storage full');
        expect(f.events.size).toBe(count);
        const failingOutbox = { getItem: f.stores[0].getItem, setItem: (key: string, value: string) => {
          if (key.includes('turn-outbox')) throw new Error('Queue storage full');
          f.stores[0].setItem(key, value);
        } };
        await expect(f.host.submitPlay(decision, failingOutbox)).rejects.toThrow('Queue storage full');
        expect(f.events.size).toBe(count);
        f.host.destroy();
        const restored = new LobbySession(f.ids[0], f.host.invite, f.wire()); restored.start();
        restored.restoreTurn(f.stores[0]);
        await expect(restored.submitPlay({ ...decision, dice: 1 }, f.stores[0])).rejects.toThrow('already bound');
        expect(restored.play.lastBattle).toBeNull();
        await restored.resumePlay(f.stores[0]);
        expect(restored.play.lastBattle).not.toBeNull();
        expect(f.events.size).toBe(count);
        restored.destroy(); f.cleanup();
      });
      it('upgrades beacon games without resetting progress, while preserving the original result of an already locked beacon attack', async () => {
        const f = await fixture(); await f.host.prepareAsyncPlay(f.stores[0]); await f.draft();
        const before = structuredClone(f.host.play.snapshot!);
        await f.host.prepareNostrPlay(f.stores[0]);
        expect(f.host.play.snapshot!.state.territories).toEqual(before.state.territories);
        expect(f.host.play.snapshot!.state.players).toEqual(before.state.players);
        expect(f.host.play.snapshot!.phase).toBe('attack');
        expect(f.host.play.snapshot!.randomness).toBe('nostr-dice-v1');
        const g = await fixture(); await g.host.prepareAsyncPlay(g.stores[0]); await g.draft();
        const clock = vi.spyOn(Date, 'now').mockReturnValue((beaconTime(1000) - 10) * 1000);
        try { await g.attack(); } finally { clock.mockRestore(); }
        const pending = g.host.play.pending!.event.id;
        await g.host.prepareNostrPlay(g.stores[0]);
        expect(g.host.play.pending!.event.id).toBe(pending);
        await g.host.resolveBeacon(g.stores[0], async () => proof);
        const battle = structuredClone(g.host.play.lastBattle);
        await g.host.prepareNostrPlay(g.stores[0]);
        expect(g.host.play.lastBattle).toEqual(battle);
        expect(g.host.play.snapshot!.randomness).toBe('nostr-dice-v1');
        expect(g.host.play.conflict).toBeNull();
        f.cleanup(); g.cleanup();
      });
      it('rejects nonce tampering, illegal dice and conflicting signed attacks during replay', async () => {
        const f = await fixture(); await f.host.prepareNostrPlay(f.stores[0]); await f.draft(); await f.attack();
        const event = [...f.host.records.values()].find(r => r.payload.type === 'play-action' && r.payload.decision.kind === 'attack')!.event;
        const payload = JSON.parse(event.content);
        expect(() => parseLobbyEvent({ ...event, content: JSON.stringify({ ...payload, diceNonce: 'ab'.repeat(32) }) }, f.host.invite)).toThrow('signature');
        f.host.receive(await f.sign(0, { ...payload, diceNonce: 'ab'.repeat(32) }));
        expect(f.host.play.conflict).toContain('conflicting actions');
        expect(() => parseDecision({ kind: 'attack', from: 0, to: 1, dice: 100, stop: 0 })).toThrow();
        f.cleanup();
      });
    });
    it('upgrades a deployed legacy game in place, retaining phase, troops, cards and statistics without the witness', async () => {
      const f = await fixture(); await f.ready(); await f.draft();
      const before = structuredClone(f.host.play.snapshot!);
      f.sessions[1].destroy();
      await f.host.prepareAsyncPlay(f.stores[0]);
      const after = f.host.play.snapshot!;
      expect(after.randomness).toBe('drand-quicknet-v1');
      expect(after.phase).toBe(before.phase);
      expect(after.state.territories).toEqual(before.state.territories);
      expect(after.state.players).toEqual(before.state.players);
      expect(after.stats).toEqual(before.stats);
      await f.host.submitPlay({ kind: 'end', fortify: null }, f.stores[0]);
      expect(f.host.play.snapshot!.state.activePlayerIndex).toBe(1);
      f.cleanup();
    });
    it('recovers a bound legacy action before attempting an automatic mode upgrade at that index', async () => {
      const f = await fixture(); await f.ready();
      f.network.accepted = 0; f.network.delivered = false;
      await expect(f.draft()).rejects.toThrow('No relay acknowledged');
      const signed = f.host.pendingPublish!; f.events.delete(signed.id);
      f.host.destroy();
      const restored = new LobbySession(f.ids[0], f.host.invite, f.wire()); restored.start();
      f.network.accepted = 1; f.network.delivered = true;
      await restored.prepareAsyncPlay(f.stores[0]);
      expect(restored.play.snapshot!.phase).toBe('attack');
      expect(restored.play.applied).toContain(signed.id);
      await restored.prepareAsyncPlay(f.stores[0]);
      expect(restored.play.snapshot!.randomness).toBe('drand-quicknet-v1');
      restored.destroy(); f.cleanup();
    });
    it('migrates an already locked legacy attack to a future beacon without changing the selected attack', async () => {
      const f = await fixture(); await f.ready(); await f.draft(); await f.attack();
      const original = f.host.play.pending!;
      f.sessions[1].destroy();
      const clock = vi.spyOn(Date, 'now').mockReturnValue((beaconTime(1000) - 10) * 1000);
      try { await f.host.prepareAsyncPlay(f.stores[0]); } finally { clock.mockRestore(); }
      expect(f.host.play.pending!.event.id).toBe(original.event.id);
      expect(f.host.play.beaconLock!.payload.type).toBe('play-beacon-lock');
      await f.host.resolveBeacon(f.stores[0], async () => proof);
      expect(f.host.play.conflict).toBeNull();
      expect(f.host.play.snapshot!.randomness).toBe('drand-quicknet-v1');
      expect(f.host.play.lastBattle!.orderId).toBe(original.event.id);
      const copy = new LobbySession(f.ids[1], f.host.invite, f.wire()); copy.start();
      expect(copy.play.hash).toBe(f.host.play.hash);
      copy.destroy(); f.cleanup();
    });
    it('retains the same committed round through outage, reload and lost proof acknowledgment', async () => {
      const f = await fixture(); await f.host.prepareAsyncPlay(f.stores[0]); await f.draft();
      const clock = vi.spyOn(Date, 'now').mockReturnValue((beaconTime(1000) - 10) * 1000);
      try { await f.attack(); } finally { clock.mockRestore(); }
      const id = f.host.play.pending!.event.id;
      await expect(f.host.resolveBeacon(f.stores[0], async () => { throw new Error('Beacon offline'); })).rejects.toThrow('Beacon offline');
      expect(f.host.play.pending!.event.id).toBe(id);
      f.host.destroy();
      const restored = new LobbySession(f.ids[0], f.host.invite, f.wire()); restored.start();
      expect(restored.play.pending!.event.id).toBe(id);
      await expect(restored.resolveBeacon(f.stores[0], async () => ({ ...proof, round: 1001 }))).rejects.toThrow('different locked round');
      f.network.accepted = 0;
      await expect(restored.resolveBeacon(f.stores[0], async () => proof)).rejects.toThrow('No relay acknowledged');
      const signed = restored.pendingPublish!;
      f.network.accepted = 1; await restored.retryPending(f.stores[0]);
      expect(restored.pendingPublish).toBeNull(); expect(f.events.get(signed.id)).toEqual(signed);
      expect(restored.play.hash).toBe(f.sessions[1].play.hash);
      restored.destroy(); f.cleanup();
    });
    it('does not request randomness before the locked round, or rebind an unpublished attack after a clock change', async () => {
      const f = await fixture(); await f.host.prepareAsyncPlay(f.stores[0]); await f.draft();
      const clock = vi.spyOn(Date, 'now').mockReturnValue((beaconTime(1000) - 10) * 1000);
      f.network.accepted = 0; f.network.delivered = false;
      try { await expect(f.attack()).rejects.toThrow('No relay acknowledged'); } finally { clock.mockRestore(); }
      const attack = f.host.pendingPublish!; f.events.delete(attack.id);
      f.host.destroy();
      const restored = new LobbySession(f.ids[0], f.host.invite, f.wire()); restored.start();
      f.network.accepted = 1; f.network.delivered = true;
      await restored.resumePlay(f.stores[0]);
      expect(restored.play.pending!.event.id).toBe(attack.id);
      expect(JSON.parse(restored.play.pending!.event.content).beaconRound).toBe(1000);
      const earlyClock = vi.spyOn(Date, 'now').mockReturnValue((beaconTime(1000) - 1) * 1000);
      const load = vi.fn(async () => proof);
      try { await expect(restored.resolveBeacon(f.stores[0], load)).rejects.toThrow('Waiting for beacon'); } finally { earlyClock.mockRestore(); }
      expect(load).not.toHaveBeenCalled();
      await expect(restored.resolveBeacon(f.stores[0], async () => ({ ...proof, signature: 'ab'.repeat(48) }))).rejects.toThrow();
      expect(restored.play.pending!.event.id).toBe(attack.id);
      await restored.resolveBeacon(f.stores[0], async () => proof);
      expect(restored.play.pending).toBeNull();
      restored.destroy(); f.cleanup();
    });
    it('halts competing legacy witness and migration resolution rather than rewriting an already resolved attack', async () => {
      const f = await fixture(); await f.ready(); await f.draft(); await f.attack();
      const pending = f.host.play.pending!;
      const clock = vi.spyOn(Date, 'now').mockReturnValue((beaconTime(1000) - 10) * 1000);
      try { await f.host.prepareAsyncPlay(f.stores[0]); } finally { clock.mockRestore(); }
      const root = [...f.stores[1].data].find(([k]) => k.startsWith('nd.nostr.play-root.v1.'))![1];
      f.host.receive(await f.sign(1, {
        v: 1, type: 'play-reveal', start: f.host.state.start!.event.id, index: f.host.play.index,
        commit: pending.event.id, secret: createHashChain(root, PLAY_CHAIN_LENGTH).secrets[0], chainIndex: 1,
      }));
      expect(f.host.play.conflict).toContain('Legacy witness and beacon migration');
      f.cleanup();
    });
    it('verifies proof integrity and produces the same state if multiple participants publish the same proof out of order', async () => {
      const f = await fixture(); await f.host.prepareAsyncPlay(f.stores[0]); await f.draft();
      const clock = vi.spyOn(Date, 'now').mockReturnValue((beaconTime(1000) - 10) * 1000);
      try { await f.attack(); } finally { clock.mockRestore(); }
      const index = f.host.play.index, commit = f.host.play.pending!.event.id, start = f.host.state.start!.event.id;
      await f.host.resolveBeacon(f.stores[0], async () => proof);
      const hash = f.host.play.hash;
      const duplicate = await f.sign(1, { v: 1, type: 'play-beacon', start, index, commit, ...proof });
      f.host.receive(duplicate);
      expect(f.host.play.hash).toBe(hash);
      const invalid = await f.sign(1, { v: 1, type: 'play-beacon', start, index, commit, ...proof, signature: 'ab'.repeat(48) });
      f.host.receive(invalid);
      expect(f.host.notice).toContain('Rejected'); expect(f.host.play.hash).toBe(hash);
      const records = [...f.events.values(), duplicate].reverse().map(e => parseLobbyEvent(e, f.host.invite));
      expect(derivePlay(f.host.state, f.host.setup, records).hash).toBe(hash);
      f.cleanup();
    });
    it('rejects round substitution and mismatched genesis state rather than silently using different dice', async () => {
      const f = await fixture(); await f.host.prepareAsyncPlay(f.stores[0]); await f.draft();
      const snap = f.host.play.snapshot!, from = snap.state.territories.findIndex(t => t.owner === 0 && t.troops > 1);
      const to = f.host.setup.map!.territories[from].neighbors.find(n => snap.state.territories[n].owner !== 0)!;
      f.host.receive(await f.sign(0, {
        v: 1, type: 'play-action', start: f.host.state.start!.event.id, index: f.host.play.index,
        prev: f.host.play.prev, stateHash: f.host.play.hash, decision: { kind: 'attack', from, to, dice: 3, stop: 0 }, beaconRound: 1000,
      }));
      expect(f.host.play.conflict).toContain('required future beacon');
      const g = await fixture();
      g.host.receive(await g.sign(0, { v: 1, type: 'play-beacon-start', start: g.host.state.start!.event.id, setupHash: 'ab'.repeat(32), chain: BEACON_CHAIN }));
      expect(g.host.play.conflict).toContain('different deployed state');
      f.cleanup(); g.cleanup();
    });
  });
  it('does not declare victory until conquest movement and full ownership; hashes all phase/context/stats', async () => {
    const f = await fixture(); await f.ready();
    const snap: PlaySnapshot = structuredClone(f.host.play.snapshot!);
    snap.state.territories.forEach(t => { t.owner = 0; t.troops = 5; });
    snap.state.territories[1].troops = 0;
    snap.phase = 'move'; snap.move = { from: 0, to: 1, min: 3 };
    const after = applyDecision(f.host.setup.map!, snap, { kind: 'move', troops: 3 }, 'ab'.repeat(32));
    expect(after.phase).toBe('over'); expect(after.state.winnerIndex).toBe(0);
    expect(snap.phase).toBe('move'); expect(snap.state.territories[1].troops).toBe(0);
    const changed = structuredClone(after); changed.stats[0].kills++;
    expect(playHash(changed)).not.toBe(playHash(after));
    expect(sha256Hex(canonicalStringify(after))).toBe(playHash(after));
    f.cleanup();
  });
  it('replays eliminations, transferred mandatory trades, changing witnesses and full-map victory without a final reward card', async () => {
    const f = await fixture(3);
    const setup = { ...f.host.setup, state: structuredClone(f.host.setup.state!) }, state = setup.state!, map = setup.map!;
    state.territories.forEach(t => { t.owner = 0; t.troops = 100; });
    const to1 = 1, to2 = map.territories.findIndex(t => t.id !== to1 && t.neighbors.some(n => n !== to1));
    state.territories[to1] = { owner: 1, troops: 1 };
    state.territories[to2] = { owner: 2, troops: 1 };
    state.players[1].cards = state.deck.splice(0, 5);
    const chains = f.ids.map((_, i) => createHashChain(String(i + 1).padStart(64, '0'), PLAY_CHAIN_LENGTH));
    const start = f.host.state.start!.event.id, setupHash = sha256Hex(canonicalStringify(state));
    const records: LobbyRecord[] = [];
    for (let i = 0; i < 3; i++) records.push(parseLobbyEvent(await f.sign(i, { v: 1, type: 'play-ready', start, setupHash, head: chains[i].head, length: PLAY_CHAIN_LENGTH }), f.host.invite));
    let play = derivePlay(f.host.state, setup, records);
    const act = async (decision: Parameters<typeof applyDecision>[2]) => {
      const event = await f.sign(0, { v: 1, type: 'play-action', start, index: play.index, prev: play.prev, stateHash: play.hash, decision });
      records.push(parseLobbyEvent(event, f.host.invite)); play = derivePlay(f.host.state, setup, records);
      expect(play.conflict).toBeNull(); return event;
    };
    const pool = computeReinforcements(map, play.snapshot!.state, 0, []).total;
    const home = map.territories[to1].neighbors.find(n => n !== to2)!;
    await act({ kind: 'draft', trades: [], placements: [{ territoryId: home, troops: pool }] });
    for (const [to, witness] of [[to1, 1], [to2, 2]]) {
      const from = map.territories[to].neighbors.find(n => play.snapshot!.state.territories[n].owner === 0)!;
      const commit = await act({ kind: 'attack', from, to, dice: 3, stop: 0 });
      expect(play.pending).not.toBeNull();
      records.push(parseLobbyEvent(await f.sign(witness, { v: 1, type: 'play-reveal', start, index: play.index, commit: commit.id, secret: chains[witness].secrets[0], chainIndex: 1 }), f.host.invite));
      play = derivePlay(f.host.state, setup, records);
      expect(play.conflict).toBeNull(); expect(play.snapshot!.state.players[witness].eliminated).toBe(true);
      expect(play.snapshot!.phase).toBe('move'); expect(play.snapshot!.stats[witness].out).toBe(1);
      await act({ kind: 'move', troops: play.snapshot!.move!.min });
      if (witness === 1) {
        expect(play.snapshot!.state.players[0].cards).toHaveLength(5);
        expect(() => validateDecision(map, play.snapshot!, { kind: 'end', fortify: null })).toThrow('Trade captured cards');
        const set = bestSet(play.snapshot!.state.players[0].cards)!;
        const originalArmies = play.snapshot!.state.territories.reduce((s, t) => s + t.troops, 0);
        await act({ kind: 'trade', trades: [{ cardIds: set.cardIds }], placements: [{ territoryId: home, troops: set.value }] });
        const armies = play.snapshot!.state.territories.reduce((s, t) => s + t.troops, 0);
        expect(armies - originalArmies).toBeGreaterThanOrEqual(set.value);
        expect(armies - originalArmies).toBeLessThanOrEqual(set.value + 2);
        expect(play.snapshot!.state.players[0].cards).toHaveLength(2);
      }
    }
    expect(play.snapshot!.phase).toBe('over'); expect(play.snapshot!.state.winnerIndex).toBe(0);
    expect(play.snapshot!.state.players[0].cards).toHaveLength(2);
    const reversed = derivePlay(f.host.state, setup, [...records].reverse());
    expect(reversed.hash).toBe(play.hash);
    expect(reversed.snapshot).toEqual(play.snapshot);
    f.cleanup();
  });
  it('reshuffles the real discard deterministically and draws at most one reward at turn end', async () => {
    const f = await fixture(); await f.ready();
    const snap = structuredClone(f.host.play.snapshot!);
    snap.phase = 'attack'; snap.conquered = true;
    snap.state.discardPile = snap.state.deck.splice(0);
    const a = applyDecision(f.host.setup.map!, snap, { kind: 'end', fortify: null }, 'ab'.repeat(32));
    const b = applyDecision(f.host.setup.map!, snap, { kind: 'end', fortify: null }, 'ab'.repeat(32));
    expect(a).toEqual(b); expect(a.state.players[0].cards).toHaveLength(1);
    expect(a.state.discardPile).toHaveLength(0);
    expect(a.state.deck.length).toBe(snap.state.discardPile.length - 1);
    snap.conquered = false;
    expect(applyDecision(f.host.setup.map!, snap, { kind: 'end', fortify: null }, 'ab'.repeat(32)).state.players[0].cards).toHaveLength(0);
    f.cleanup();
  });
});
