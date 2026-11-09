import { SimplePool } from 'nostr-tools/pool';
import type { Subscription } from 'nostr-tools/abstract-relay';
import type { Event, EventTemplate } from 'nostr-tools/pure';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { NostrIdentity } from './identity';
import { normalizeDisplayName } from './profile';
import { MAP_GENERATOR_VERSION } from '../engine/mapGenerator';
import { applySetupPlacement } from '../engine/setup';
import type { DraftPlacementOrder } from '../types/actions';
import { canonicalStringify } from '../crypto/stateHash';
import { sha256Hex } from '../crypto/prng';
import { createHashChain, generateRootSecret, isHex32 } from '../crypto/hashChain';
import { deriveSetup, isSetupPayload, seedCommitment, type MultiplayerSetup, type SetupPayload } from './setupProtocol';
import { derivePlay, isPlayPayload, parseDecision, parsePlayPayload, PLAY_CHAIN_LENGTH, validateDecision, type MultiplayerPlay, type PlayDecision, type PlayPayload } from './playProtocol';
import { witnessFor } from '../engine/turnEngine';
import { BEACON_CHAIN, beaconRandomness, beaconTime, fetchBeacon, futureBeaconRound, type BeaconProof } from './beacon';
import {
  deriveLobby, LOBBY_KIND, MAX_GAME_HISTORY, lobbyTemplate, normalizeRelays, parseLobbyEvent,
  type InvitedFriend, type LobbyInvite, type LobbyPayload, type LobbyRecord, type LobbyState,
} from './lobbyProtocol';

export interface PublishResult { accepted: number; total: number; failures: string[] }
export interface LobbyWire {
  subscribe(invite: LobbyInvite, receive: (event: Event) => void, status: (text: string) => void, ready: (value: boolean) => void): () => void;
  publish(relays: string[], event: Event): Promise<PublishResult>;
  destroy(): void;
}

export class RelayLobbyWire implements LobbyWire {
  private pool = new SimplePool({ enableReconnect: false });
  private stops = new Set<() => void>();
  subscribe(invite: LobbyInvite, receive: (event: Event) => void, status: (text: string) => void, ready: (value: boolean) => void): () => void {
    let active = true;
    let previous = '';
    const settled = new Set<string>();
    const complete = new Set<string>();
    const failures = new Map<string, string>();
    const subscriptions: Subscription[] = [];
    const timers: ReturnType<typeof setTimeout>[] = [];
    const check = () => {
      if (!active) return;
      const connected = invite.relays.filter(url => this.pool.listConnectionStatus().get(url)).length;
      ready(settled.size === invite.relays.length && [...complete].some(url => this.pool.listConnectionStatus().get(url)));
      const message = `${connected}/${invite.relays.length} relays connected${connected === 0 ? '. Offline: roster may be stale; reconnect before acting.' : '. Relay views can differ; this is not a consensus guarantee.'}${failures.size ? ` Relay errors: ${[...failures].map(([url, error]) => `${url}: ${error}`).join('; ')}. Reconnect to retry.` : ''}`;
      if (message !== previous) { previous = message; status(message); }
    };
    for (const url of invite.relays) {
      void this.pool.ensureRelay(url, { connectionTimeout: 5000 }).then(relay => {
        if (!active) return;
        let subscription: Subscription | undefined;
        let streamActive = true;
        const timer = setTimeout(() => subscription?.close('History did not finish within 10 seconds'), 10000);
        timers.push(timer);
        subscription = relay.subscribe([
          { ids: [invite.id], kinds: [LOBBY_KIND] },
          { kinds: [LOBBY_KIND], '#e': [invite.id] },
        ], {
          onevent: event => { if (active && streamActive) receive(event); },
          // The library synthesizes EOSE on timeout. Our shorter timer closes instead:
          // a timeout must never authorize signing on incomplete history.
          eoseTimeout: 2147483647,
          oneose: () => {
            if (!active || !streamActive) return;
            clearTimeout(timer);
            settled.add(url); complete.add(url); check();
          },
          onclose: reason => {
            streamActive = false;
            if (!active) return;
            clearTimeout(timer);
            settled.add(url); complete.delete(url); failures.set(url, reason); check();
          },
          oninvalidevent: () => { if (active) { failures.set(url, 'Ignored invalid signed event'); check(); } },
        });
        subscriptions.push(subscription);
      }).catch((error: unknown) => {
        if (!active) return;
        settled.add(url); failures.set(url, error instanceof Error ? error.message : String(error)); check();
      });
    }
    const timer = setInterval(check, 2000);
    check();
    const stop = () => {
      if (!active) return;
      active = false;
      clearInterval(timer);
      timers.forEach(clearTimeout);
      subscriptions.forEach(s => s.close());
      this.stops.delete(stop);
    };
    this.stops.add(stop);
    return stop;
  }
  async publish(relays: string[], event: Event): Promise<PublishResult> {
    const results = await Promise.allSettled(this.pool.publish(relays, event, { maxWait: 10000 }));
    return {
      accepted: results.filter(r => r.status === 'fulfilled').length, total: relays.length,
      failures: results.flatMap((r, i) => r.status === 'rejected' ? [`${relays[i]}: ${String(r.reason)}`] : []),
    };
  }
  destroy(): void {
    this.stops.forEach(stop => stop());
    // nostr-tools queues subscription CLOSE writes; flush those before closing sockets.
    queueMicrotask(() => this.pool.destroy());
  }
}

export class LobbySession {
  readonly records = new Map<string, LobbyRecord>();
  state: LobbyState;
  setup: MultiplayerSetup;
  play: MultiplayerPlay;
  status = 'Connecting to lobby relays...';
  notice = '';
  busy = false;
  pendingPublish: Event | null = null;
  historyReady = false;
  private historyLimit = false;
  private stop: (() => void) | null = null;
  private alive = true;
  private listeners = new Set<() => void>();
  private turnOutbox: { events: Event[]; publishing: boolean } = { events: [], publishing: false };
  private turnStorage: SetupStorage | null = null;
  private turnStorageError = '';

  get hasLocalTurn(): boolean { return this.turnOutbox.events.length > 0 && !this.turnOutbox.publishing; }
  get publishingTurn(): boolean { return this.turnOutbox.publishing; }
  get canContinueOffline(): boolean { return this.hasLocalTurn && !this.turnStorageError; }
  private get turnStorageKey(): string { return `nd.nostr.turn-outbox.v1.${this.invite.id}.${this.identity.pubkey}`; }

  restoreTurn(storage: SetupStorage): void {
    try {
      const raw = storage.getItem(this.turnStorageKey);
      const value: unknown = raw === null ? { events: [], publishing: false } : JSON.parse(raw);
      if (typeof value !== 'object' || value === null || !('events' in value) || !Array.isArray(value.events)
        || value.events.length > MAX_GAME_HISTORY || !('publishing' in value) || typeof value.publishing !== 'boolean'
        || value.publishing && !value.events.length) throw new Error('Invalid saved turn queue.');
      const records = value.events.map(event => parseLobbyEvent(event, this.invite));
      for (let i = 0; i < records.length; i++) {
        const record = records[i], previous = records[i - 1];
        if (record.event.pubkey !== this.identity.pubkey || record.payload.type !== 'play-action'
          || !['draft', 'trade', 'attack', 'move', 'end'].includes(record.payload.decision.kind)
          || previous && (previous.payload.type !== 'play-action' || record.payload.index !== previous.payload.index + 1
            || record.payload.prev !== previous.event.id)) throw new Error('Invalid signed turn queue history.');
      }
      this.turnOutbox = { events: records.map(r => r.event), publishing: value.publishing };
      this.turnStorage = storage;
      this.turnStorageError = '';
      for (const record of records) this.receive(record.event);
      if (value.publishing) this.pendingPublish = this.turnOutbox.events[0];
    } catch (error) {
      this.turnStorageError = `Could not restore your saved turn: ${error instanceof Error ? error.message : String(error)}. Restore the original site data before playing.`;
      throw new Error(this.turnStorageError);
    }
  }
  private saveTurn(next: typeof this.turnOutbox, storage: SetupStorage): void {
    const raw = storage.getItem(this.turnStorageKey);
    if (canonicalStringify(raw === null ? { events: [], publishing: false } : JSON.parse(raw)) !== canonicalStringify(this.turnOutbox)) {
      throw new Error('Another tab changed your saved turn. Reopen this game using one tab per account.');
    }
    storage.setItem(this.turnStorageKey, JSON.stringify(next));
    this.turnOutbox = next;
    this.turnStorage = storage;
  }
  private async flushTurn(storage: SetupStorage): Promise<void> {
    if (this.state.conflict || this.setup.conflict || this.play.conflict || this.turnStorageError) {
      throw new Error(this.state.conflict ?? this.setup.conflict ?? this.play.conflict ?? this.turnStorageError);
    }
    this.assertTurnHistory();
    const warnings = new Set<string>();
    for (const event of this.turnOutbox.events) {
      this.pendingPublish = event; this.changed();
      await this.publishPending();
      if (!this.alive) return;
      if (this.notice) warnings.add(this.notice);
    }
    this.saveTurn({ events: [], publishing: false }, storage);
    this.pendingPublish = null;
    this.notice = [...warnings].join(' ');
  }
  private assertTurnHistory(): void {
    if (this.turnOutbox.events.some(event => !this.play.applied.includes(event.id))) {
      throw new Error('Your saved turn is missing required game history. Reconnect before continuing or sending it.');
    }
  }

  constructor(readonly identity: NostrIdentity, readonly invite: LobbyInvite, private wire: LobbyWire = new RelayLobbyWire()) {
    this.state = deriveLobby(invite, []);
    this.setup = deriveSetup(this.state, []);
    this.play = derivePlay(this.state, this.setup, []);
  }
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private changed(): void { if (this.alive) this.listeners.forEach(listener => listener()); }
  start(): void {
    if (!this.alive) throw new Error('This lobby connection is closed.');
    this.stop?.();
    this.historyReady = false;
    this.stop = this.wire.subscribe(this.invite, event => this.receive(event), text => { this.status = text; this.changed(); }, ready => {
      if (this.historyReady === ready) return;
      this.historyReady = ready;
      this.changed();
    });
  }
  receive(event: unknown): void {
    if (!this.alive) return;
    try {
      const record = parseLobbyEvent(event, this.invite);
      if (this.records.has(record.event.id)) return;
      if (this.records.size >= MAX_GAME_HISTORY) {
        this.historyLimit = true;
        throw new Error('Signed game history limit reached. Game paused; export history before starting a new game.');
      }
      this.records.set(record.event.id, record);
      this.state = deriveLobby(this.invite, [...this.records.values()]);
      this.setup = deriveSetup(this.state, [...this.records.values()], this.setup);
      this.play = derivePlay(this.state, this.setup, [...this.records.values()]);
    } catch (error) {
      this.notice = `Rejected lobby event: ${error instanceof Error ? error.message : String(error)}`;
    }
    this.changed();
  }
  restore(events: unknown[], pending: unknown): void {
    if (events.length > MAX_GAME_HISTORY) throw new Error('Saved game history is too large.');
    const records = events.map(event => parseLobbyEvent(event, this.invite));
    const retry = pending === null ? null : parseLobbyEvent(pending, this.invite).event;
    if (retry && retry.pubkey !== this.identity.pubkey) throw new Error('Saved pending event belongs to another identity.');
    records.forEach(record => this.records.set(record.event.id, record));
    this.state = deriveLobby(this.invite, [...this.records.values()]);
    this.setup = deriveSetup(this.state, [...this.records.values()], this.setup);
    this.play = derivePlay(this.state, this.setup, [...this.records.values()]);
    this.pendingPublish = retry;
  }
  private assertAction(allowStarted = false): void {
    if (!this.alive) throw new Error('This lobby connection is closed.');
    if (this.busy) throw new Error('Wait for the current signing or relay operation.');
    if (this.historyLimit) throw new Error('Lobby history limit reached. Create another lobby.');
    if (this.turnStorageError) throw new Error(this.turnStorageError);
    if (this.turnOutbox.publishing) throw new Error('Retry sending your completed turn before another action.');
    if (this.pendingPublish) throw new Error('Retry the pending signed event before another action.');
    if (this.state.conflict) throw new Error(this.state.conflict);
    if (this.setup.conflict) throw new Error(this.setup.conflict);
    if (this.play.conflict) throw new Error(this.play.conflict);
    this.assertTurnHistory();
    if (this.state.closed) throw new Error('The host has closed this lobby.');
    if (!this.historyReady && !(allowStarted && this.canContinueOffline)) throw new Error('Waiting for relay history. Reconnect if the connection was interrupted.');
    if (!this.state.creation) throw new Error('Waiting for signed lobby history. Check the invite and reconnect.');
    if (this.state.start && !allowStarted) throw new Error('The roster is locked. Lobby changes are no longer allowed.');
    const ownHistory = [...this.records.values()].filter(r => r.event.pubkey === this.identity.pubkey && !isSetupPayload(r.payload) && !isPlayPayload(r.payload));
    const latest = this.identity.pubkey === this.invite.host ? this.state.start ?? this.state.roster : this.state.requests.get(this.identity.pubkey);
    const chain = new Set([this.invite.id]);
    let cursor = latest;
    while (cursor && cursor.payload.type !== 'create' && !isSetupPayload(cursor.payload) && !isPlayPayload(cursor.payload)) {
      chain.add(cursor.event.id);
      cursor = this.records.get(cursor.payload.prev);
    }
    if (ownHistory.some(r => !chain.has(r.event.id))) {
      throw new Error('Your signed history has gaps or conflicts. Reconnect to fetch missing events; do not sign another branch.');
    }
  }
  private async send(payload: LobbyPayload, persist?: (event: Event) => void): Promise<void> {
    this.busy = true;
    this.changed();
    try {
      const event = await this.identity.signEvent(lobbyTemplate(payload, payload.type === 'create' ? undefined : this.invite.id));
      if (!this.alive) return;
      persist?.(event);
      this.pendingPublish = event;
      this.changed();
      await this.publishPending();
    } finally { this.busy = false; this.changed(); }
  }
  private async publishPending(): Promise<void> {
    const event = this.pendingPublish;
    if (!event) throw new Error('There is no pending event to retry.');
    const result = await this.wire.publish(this.invite.relays, event);
    if (!this.alive) return;
    if (!result.accepted) throw new Error(`No relay acknowledged this action. It may still have been delivered. Retry the same signed event. ${result.failures.join('; ')}`);
    this.receive(event);
    this.pendingPublish = null;
    this.notice = result.accepted === result.total ? ''
      : `Action accepted by ${result.accepted}/${result.total} relays; some players may not see it yet. ${result.failures.join('; ')}`;
  }
  async retry(): Promise<void> {
    if (this.turnOutbox.publishing && this.turnStorage) return this.retryPending(this.turnStorage);
    if (!this.alive) throw new Error('This lobby connection is closed.');
    if (this.busy) throw new Error('Wait for the current relay operation.');
    this.busy = true;
    this.changed();
    try { await this.publishPending(); } finally { this.busy = false; this.changed(); }
  }
  async requestJoin(displayName: string, active = true): Promise<void> {
    this.assertAction();
    if (this.identity.pubkey === this.invite.host) throw new Error('The host already has a seat.');
    if (this.state.creation?.invited && !this.state.creation.invited.some(f => f.pubkey === this.identity.pubkey)) {
      throw new Error('Only friends explicitly invited by the host can join this game.');
    }
    const last = this.state.requests.get(this.identity.pubkey);
    if (last?.payload.type === 'request' && last.payload.active === active) throw new Error(active ? 'Your join request is already active.' : 'You already left this lobby.');
    await this.send({
      v: 1, type: 'request', name: normalizeDisplayName(displayName), active,
      seq: last?.payload.type === 'request' ? last.payload.seq + 1 : 1, prev: last?.event.id ?? this.invite.id,
    });
  }
  async approve(pubkey: string): Promise<void> {
    this.assertAction();
    if (this.identity.pubkey !== this.invite.host) throw new Error('Only the host can approve players.');
    const request = this.state.pending.find(m => m.pubkey === pubkey);
    if (!request) throw new Error('That join request is no longer pending.');
    if (this.state.members.length >= this.state.creation!.maxPlayers) throw new Error('The lobby is full.');
    await this.updateRoster([...this.state.members.slice(1), request], false);
  }
  async closeLobby(): Promise<void> {
    this.assertAction();
    if (this.identity.pubkey !== this.invite.host) throw new Error('Only the host can close the lobby.');
    await this.updateRoster(this.state.members.slice(1), true);
  }
  private async updateRoster(members: LobbyState['members'], closed: boolean): Promise<void> {
    const last = this.state.roster;
    await this.send({
      v: 1, type: 'roster', members, closed,
      seq: last?.payload.type === 'roster' ? last.payload.seq + 1 : 1, prev: last?.event.id ?? this.invite.id,
    });
  }
  private durableState(storage: SetupStorage): DurableSetup {
    const saved = storage.getItem(setupStorageKey(this.invite.id, this.identity.pubkey));
    if (saved === null) return { secret: null, events: [] };
    const value: unknown = JSON.parse(saved);
    if (typeof value !== 'object' || value === null || !('secret' in value)
      || (value.secret !== null && (typeof value.secret !== 'string' || !isHex32(value.secret)))
      || !('events' in value) || !Array.isArray(value.events) || value.events.length > 4) {
      throw new Error('Invalid saved setup data. Do not clear it or generate a new commitment for this game.');
    }
    const events = value.events.map(input => {
      const record = parseLobbyEvent(input, this.invite);
      if (record.event.pubkey !== this.identity.pubkey || (record.payload.type !== 'start' && !isSetupPayload(record.payload))) {
        throw new Error('Saved setup event belongs to another identity or protocol.');
      }
      return record.event;
    });
    const types = events.map(e => parseLobbyEvent(e, this.invite).payload.type);
    if (new Set(types).size !== types.length) throw new Error('Conflicting saved setup bindings.');
    return { secret: value.secret, events };
  }
  private async sendDurable(payload: LobbyPayload, storage: SetupStorage): Promise<void> {
    const durable = this.durableState(storage);
    const saved = durable.events.find(e => parseLobbyEvent(e, this.invite).payload.type === payload.type);
    if (saved) {
      if (canonicalStringify(parseLobbyEvent(saved, this.invite).payload) !== canonicalStringify(payload)) {
        throw new Error('This action was already signed with different data. Restore and retry the original signed event.');
      }
      this.pendingPublish = saved;
      await this.retry();
      return;
    }
    await this.send(payload, event => {
      durable.events.push(event);
      storage.setItem(setupStorageKey(this.invite.id, this.identity.pubkey), JSON.stringify(durable));
    });
  }
  restoreSetup(storage: SetupStorage): void {
    const durable = this.durableState(storage);
    const missing = durable.events.some(event => !this.records.has(event.id));
    for (const event of durable.events) this.receive(event);
    // Resend durable local actions if the ordinary lobby cache lost them.
    if (!this.pendingPublish && missing) this.pendingPublish = durable.events[durable.events.length - 1];
  }
  async rebroadcastSetup(storage: SetupStorage): Promise<void> {
    if (!this.alive) throw new Error('This lobby connection is closed.');
    if (this.busy) throw new Error('Wait for the current operation.');
    this.busy = true; this.changed();
    try {
      for (const event of this.durableState(storage).events) {
        this.pendingPublish = event; this.changed();
        await this.publishPending();
      }
    } finally { this.busy = false; this.changed(); }
  }
  async retryPending(storage: SetupStorage): Promise<void> {
    if (!this.turnStorage) this.restoreTurn(storage);
    if (this.turnOutbox.publishing) {
      if (!this.alive) throw new Error('This lobby connection is closed.');
      if (this.busy) throw new Error('Wait for the current relay operation.');
      this.busy = true; this.changed();
      try { await this.flushTurn(storage); } finally { this.busy = false; this.changed(); }
      return;
    }
    const payload = this.pendingPublish ? parseLobbyEvent(this.pendingPublish, this.invite).payload : null;
    if (payload && (payload.type === 'start' || isSetupPayload(payload))) await this.rebroadcastSetup(storage);
    else await this.retry();
  }
  async startGame(storage: SetupStorage): Promise<void> {
    this.assertAction();
    if (this.identity.pubkey !== this.invite.host) throw new Error('Only the host can start the game.');
    if (this.state.members.length < 2) throw new Error('At least two approved commanders are required.');
    const last = this.state.roster;
    await this.sendDurable({
      v: 1, type: 'start', members: this.state.members.slice(1), mapGeneratorVersion: MAP_GENERATOR_VERSION,
      seq: last?.payload.type === 'roster' ? last.payload.seq + 1 : 1, prev: last?.event.id ?? this.invite.id,
    }, storage);
  }
  private assertParticipant(): string {
    this.assertAction(true);
    if (!this.state.start || !this.state.members.some(m => m.pubkey === this.identity.pubkey)) {
      throw new Error('Only a commander in the locked roster can participate in setup.');
    }
    return this.state.start.event.id;
  }
  async commitSeed(storage: SetupStorage): Promise<void> {
    const start = this.assertParticipant();
    if (this.setup.commits.has(this.identity.pubkey)) throw new Error('Your seed is already committed.');
    const durable = this.durableState(storage);
    if (!durable.secret) {
      if (durable.events.some(e => parseLobbyEvent(e, this.invite).payload.type === 'seed-commit')) {
        throw new Error('Your saved setup secret is missing. Do not generate a replacement commitment.');
      }
      durable.secret = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
      storage.setItem(setupStorageKey(this.invite.id, this.identity.pubkey), JSON.stringify(durable));
    }
    await this.sendDurable({ v: 1, type: 'seed-commit', start, commitment: seedCommitment(start, this.identity.pubkey, durable.secret) }, storage);
  }
  async revealSeed(storage: SetupStorage): Promise<void> {
    const start = this.assertParticipant();
    if (this.setup.commits.size !== this.state.members.length) throw new Error('Wait for every commander to commit before revealing.');
    if (this.setup.reveals.has(this.identity.pubkey)) throw new Error('Your seed is already revealed.');
    const secret = this.durableState(storage).secret;
    const commit = this.setup.commits.get(this.identity.pubkey)?.payload;
    if (!secret || commit?.type !== 'seed-commit' || seedCommitment(start, this.identity.pubkey, secret) !== commit.commitment) {
      throw new Error('Your saved setup secret is missing or does not match your signed commitment. Setup must pause; it cannot be regenerated.');
    }
    await this.sendDurable({
      v: 1, type: 'seed-reveal', start, secret,
      commits: this.state.members.map(m => this.setup.commits.get(m.pubkey)!.event.id),
    }, storage);
  }
  async deploySetup(placements: DraftPlacementOrder[], storage: SetupStorage): Promise<void> {
    const start = this.assertParticipant();
    if (!this.setup.base || !this.setup.baseHash) throw new Error('Wait for the shared map and deal.');
    if (this.setup.deployments.has(this.identity.pubkey)) throw new Error('Your deployment is already locked.');
    const sorted = [...placements].sort((a, b) => a.territoryId - b.territoryId);
    const payload: SetupPayload = { v: 1, type: 'setup-deploy', start, baseHash: this.setup.baseHash, placements: sorted };
    if (sorted.some((p, i) => i > 0 && p.territoryId === sorted[i - 1].territoryId)) throw new Error('Duplicate territory placement.');
    applySetupPlacement(this.setup.base, {
      type: 'SETUP_PLACEMENT', playerIndex: this.state.members.findIndex(m => m.pubkey === this.identity.pubkey), placements: sorted,
    });
    await this.sendDurable(payload, storage);
  }
  private chain(storage: SetupStorage): ReturnType<typeof createHashChain> {
    const key = `nd.nostr.play-root.v1.${this.invite.id}.${this.identity.pubkey}`;
    let root = storage.getItem(key);
    if (root === null) {
      if (this.play.ready.has(this.identity.pubkey)) throw new Error('Your private witness chain is missing. The game must pause; never generate a replacement.');
      root = generateRootSecret();
      storage.setItem(key, root);
    }
    if (!isHex32(root)) throw new Error('Invalid saved witness chain root. Restore the original device data.');
    const chain = createHashChain(root, PLAY_CHAIN_LENGTH);
    const ready = this.play.ready.get(this.identity.pubkey)?.payload;
    if (ready?.type === 'play-ready' && ready.head !== chain.head) throw new Error('Saved witness root does not match your signed commitment.');
    return chain;
  }
  private async sendPlay(payload: PlayPayload, slot: string, storage: SetupStorage, createdAt?: number): Promise<void> {
    const key = `nd.nostr.play-sign.v1.${this.invite.id}.${this.identity.pubkey}.${slot}`;
    const existing = storage.getItem(key);
    let template: EventTemplate;
    let signed: Event | null = null;
    if (existing !== null) {
      const saved: unknown = JSON.parse(existing);
      if (typeof saved !== 'object' || saved === null || !('template' in saved) || !('event' in saved)) throw new Error('Invalid saved game signing binding.');
      const t = saved.template;
      if (typeof t !== 'object' || t === null || !('content' in t) || typeof t.content !== 'string'
        || !('created_at' in t) || typeof t.created_at !== 'number' || !Number.isSafeInteger(t.created_at)) throw new Error('Invalid saved game signing template.');
      if (t.content !== JSON.stringify(payload)) throw new Error('A different action is already bound to this index. Retry the original signed action; do not create a branch.');
      template = { ...lobbyTemplate(payload, this.invite.id), created_at: t.created_at };
      if (saved.event !== null) {
        const record = parseLobbyEvent(saved.event, this.invite);
        if (record.event.pubkey !== this.identity.pubkey || canonicalStringify(record.payload) !== canonicalStringify(payload)
          || record.event.created_at !== template.created_at) throw new Error('Invalid durable game signature.');
        signed = record.event;
      }
    } else {
      template = lobbyTemplate(payload, this.invite.id);
      if (createdAt !== undefined) template.created_at = createdAt;
      storage.setItem(key, JSON.stringify({ template, event: null }));
    }
    this.busy = true; this.changed();
    try {
      signed ??= await this.identity.signEvent(structuredClone(template));
      if (!this.alive) return;
      const verified = parseLobbyEvent(signed, this.invite);
      if (verified.event.pubkey !== this.identity.pubkey || verified.event.content !== template.content
        || verified.event.created_at !== template.created_at || canonicalStringify(verified.event.tags) !== canonicalStringify(template.tags)) {
        throw new Error('Signer changed the durable game template. Nothing was published.');
      }
      const latest: unknown = JSON.parse(storage.getItem(key) ?? 'null');
      if (typeof latest !== 'object' || latest === null || !('template' in latest)
        || canonicalStringify(latest.template) !== canonicalStringify(template)) throw new Error('Concurrent signing changed the binding. Game paused; use one tab per identity.');
      storage.setItem(key, JSON.stringify({ template, event: signed }));
      if (payload.type === 'play-action' && this.play.snapshot?.randomness === 'nostr-dice-v1') {
        if (this.records.size >= MAX_GAME_HISTORY) throw new Error('Signed game history limit reached. Export history before starting a new game.');
        const nextPlay = derivePlay(this.state, this.setup, [...this.records.values(), verified]);
        if (nextPlay.conflict || nextPlay.index !== payload.index + 1) throw new Error(nextPlay.conflict ?? 'Signed action could not advance the saved turn.');
        const publishing = payload.decision.kind === 'end' || nextPlay.snapshot?.phase === 'over';
        this.saveTurn({ events: [...this.turnOutbox.events, signed], publishing }, storage);
        this.receive(signed);
        if (publishing) await this.flushTurn(storage);
        return;
      }
      this.pendingPublish = signed; this.changed();
      await this.publishPending();
    } finally { this.busy = false; this.changed(); }
  }
  async preparePlay(storage: SetupStorage): Promise<void> {
    const start = this.assertParticipant();
    if (!this.setup.state?.players.every(p => p.setupDone)) throw new Error('Wait for every initial deployment.');
    if (this.play.snapshot?.randomness) throw new Error('This game uses asynchronous beacon dice, not player witness chains.');
    if (this.play.ready.has(this.identity.pubkey)) return;
    const chain = this.chain(storage);
    await this.sendPlay({
      v: 1, type: 'play-ready', start, setupHash: sha256Hex(canonicalStringify(this.setup.state)), head: chain.head, length: chain.length,
    }, 'ready', storage);
  }
  async prepareAsyncPlay(storage: SetupStorage): Promise<void> {
    const start = this.assertParticipant();
    if (!this.setup.state?.players.every(p => p.setupDone)) throw new Error('Wait for every initial deployment.');
    if (this.play.snapshot) {
      if (this.play.snapshot.randomness || this.play.snapshot.phase === 'over') return;
      if (this.play.pending) {
        if (this.play.beaconLock) return;
        if (this.play.snapshot.state.players[this.play.snapshot.state.activePlayerIndex].id !== this.identity.pubkey) return;
        const key = `nd.nostr.play-sign.v1.${this.invite.id}.${this.identity.pubkey}.beacon-lock.${this.play.pending.event.id}`;
        const saved = storage.getItem(key);
        let createdAt = Math.floor(Date.now() / 1000);
        if (saved !== null) {
          const value: unknown = JSON.parse(saved);
          if (typeof value !== 'object' || value === null || !('template' in value) || typeof value.template !== 'object'
            || value.template === null || !('created_at' in value.template) || typeof value.template.created_at !== 'number') throw new Error('Invalid saved migration lock.');
          createdAt = value.template.created_at;
        }
        await this.sendPlay({
          v: 1, type: 'play-beacon-lock', start, index: this.play.index, commit: this.play.pending.event.id, round: futureBeaconRound(createdAt),
        }, `beacon-lock.${this.play.pending.event.id}`, storage, createdAt);
        return;
      }
      const index = this.play.index;
      await this.resumePlay(storage);
      if (this.play.index !== index || this.play.pending || this.play.snapshot?.randomness) return;
      await this.submitPlay({ kind: 'beacon' }, storage);
      return;
    }
    if (this.identity.pubkey !== this.setup.state.players[0].id) return;
    await this.sendPlay({
      v: 1, type: 'play-beacon-start', start, setupHash: sha256Hex(canonicalStringify(this.setup.state)), chain: BEACON_CHAIN,
    }, 'beacon-start', storage);
  }
  async prepareNostrPlay(storage: SetupStorage): Promise<void> {
    const start = this.assertParticipant();
    if (!this.setup.state?.players.every(p => p.setupDone)) throw new Error('Wait for every initial deployment.');
    const snapshot = this.play.snapshot;
    if (snapshot) {
      if (snapshot.randomness === 'nostr-dice-v1' || snapshot.phase === 'over') return;
      if (snapshot.state.players[snapshot.state.activePlayerIndex].id !== this.identity.pubkey) return;
      // Previously locked attacks keep their original result source; upgrades never reroll them.
      if (this.play.pending) {
        if (!snapshot.randomness && !this.play.beaconLock) await this.prepareAsyncPlay(storage);
        return;
      }
      const index = this.play.index;
      await this.resumePlay(storage);
      if (this.play.index !== index || this.play.pending) return;
      await this.submitPlay({ kind: 'nostr-dice' }, storage);
      return;
    }
    if (this.identity.pubkey !== this.setup.state.players[0].id) return;
    await this.sendPlay({ v: 1, type: 'play-dice-start', start, setupHash: sha256Hex(canonicalStringify(this.setup.state)) }, 'dice-start', storage);
  }
  async resumePlay(storage: SetupStorage): Promise<void> {
    if (!this.turnStorage) this.restoreTurn(storage);
    if (this.turnOutbox.publishing) return this.retryPending(storage);
    this.assertParticipant();
    const snapshot = this.play.snapshot;
    if (!snapshot || this.play.pending || snapshot.phase === 'over'
      || snapshot.state.players[snapshot.state.activePlayerIndex].id !== this.identity.pubkey) return;
    const saved = storage.getItem(`nd.nostr.play-sign.v1.${this.invite.id}.${this.identity.pubkey}.action.${this.play.index}`);
    if (saved === null) return;
    const binding: unknown = JSON.parse(saved);
    if (typeof binding !== 'object' || binding === null || !('template' in binding)
      || typeof binding.template !== 'object' || binding.template === null || !('content' in binding.template)
      || typeof binding.template.content !== 'string') throw new Error('Invalid saved game action binding.');
    const payload: unknown = JSON.parse(binding.template.content);
    if (typeof payload !== 'object' || payload === null || !('type' in payload) || payload.type !== 'play-action' || !('decision' in payload)) {
      throw new Error('Invalid saved game action.');
    }
    await this.submitPlay(parseDecision(payload.decision), storage);
  }
  async submitPlay(decision: PlayDecision, storage: SetupStorage): Promise<void> {
    if (!this.turnStorage) this.restoreTurn(storage);
    const start = this.assertParticipant();
    const snapshot = this.play.snapshot;
    if (!snapshot || !this.setup.map) throw new Error('Waiting for asynchronous game preparation.');
    if (this.play.pending) throw new Error('This attack is already locked. Wait for its randomness proof.');
    if (snapshot.state.players[snapshot.state.activePlayerIndex].id !== this.identity.pubkey) throw new Error('It is not your turn.');
    const parsed = parseDecision(decision);
    validateDecision(this.setup.map, snapshot, parsed);
    let createdAt = Math.floor(Date.now() / 1000), beaconRound: number | undefined, diceNonce: string | undefined;
    const saved = storage.getItem(`nd.nostr.play-sign.v1.${this.invite.id}.${this.identity.pubkey}.action.${this.play.index}`);
    if (parsed.kind === 'attack' && snapshot.randomness) {
      if (snapshot.randomness === 'nostr-dice-v1') diceNonce = generateRootSecret();
      else beaconRound = futureBeaconRound(createdAt);
      if (saved !== null) {
        const binding: unknown = JSON.parse(saved);
        if (typeof binding !== 'object' || binding === null || !('template' in binding)
          || typeof binding.template !== 'object' || binding.template === null
          || !('content' in binding.template) || typeof binding.template.content !== 'string'
          || !('created_at' in binding.template) || typeof binding.template.created_at !== 'number') throw new Error('Invalid saved attack binding.');
        createdAt = binding.template.created_at;
        const content: unknown = JSON.parse(binding.template.content);
        if (typeof content !== 'object' || content === null || Array.isArray(content)) throw new Error('Invalid saved attack payload.');
        const payload = parsePlayPayload(content as Record<string, unknown>);
        if (payload?.type !== 'play-action') throw new Error('Invalid saved attack payload.');
        if (snapshot.randomness === 'nostr-dice-v1') {
          if (!payload.diceNonce) throw new Error('Saved attack is missing its original nonce.');
          diceNonce = payload.diceNonce;
        } else beaconRound = futureBeaconRound(createdAt);
      }
    }
    await this.sendPlay({
      v: 1, type: 'play-action', start, index: this.play.index, prev: this.play.prev, stateHash: this.play.hash, decision: parsed,
      ...(beaconRound === undefined ? {} : { beaconRound }),
      ...(diceNonce === undefined ? {} : { diceNonce }),
    }, `action.${this.play.index}`, storage, createdAt);
  }
  async resolveBeacon(storage: SetupStorage, load: (round: number) => Promise<BeaconProof> = fetchBeacon): Promise<void> {
    const start = this.assertParticipant(), pending = this.play.pending;
    if ((!this.play.snapshot?.randomness && !this.play.beaconLock) || !pending || pending.payload.type !== 'play-action') {
      throw new Error('No beacon attack is pending.');
    }
    const round = this.play.beaconLock?.payload.type === 'play-beacon-lock' ? this.play.beaconLock.payload.round : pending.payload.beaconRound;
    const index = pending.payload.index;
    if (!round) throw new Error('Pending attack has no locked beacon round.');
    if (Date.now() / 1000 < beaconTime(round)) throw new Error(`Waiting for beacon round ${round}.`);
    const proof = await load(round);
    this.assertParticipant();
    if (this.play.pending?.event.id !== pending.event.id) return;
    if (proof.round !== round) throw new Error('Beacon response is for a different locked round.');
    beaconRandomness(proof);
    await this.sendPlay({ v: 1, type: 'play-beacon', start, index, commit: pending.event.id, round: proof.round, signature: proof.signature },
      `beacon.${pending.event.id}`, storage);
  }
  async revealAttack(storage: SetupStorage): Promise<void> {
    const start = this.assertParticipant();
    if (this.play.snapshot?.randomness || this.play.beaconLock) throw new Error('This attack uses asynchronous beacon dice, not a player witness.');
    const pending = this.play.pending;
    const snapshot = this.play.snapshot;
    if (!snapshot || !pending || pending.payload.type !== 'play-action') throw new Error('No attack is waiting for a witness.');
    const witness = snapshot.state.players[witnessFor(snapshot.state)];
    if (witness.id !== this.identity.pubkey) throw new Error('You are not the designated witness.');
    const chain = this.chain(storage);
    if (witness.hashChainIndex >= chain.length) throw new Error('Witness chain exhausted. Game paused.');
    const secret = chain.secrets[witness.hashChainIndex];
    await this.sendPlay({
      v: 1, type: 'play-reveal', start, index: this.play.index, commit: pending.event.id,
      secret, chainIndex: witness.hashChainIndex + 1,
    }, `reveal.${witness.hashChainIndex + 1}`, storage);
  }
  destroy(): void {
    this.alive = false;
    this.stop?.();
    this.wire.destroy();
    this.listeners.clear();
  }
}

export async function createLobby(
  identity: NostrIdentity, name: string, maxPlayers: number, relayURLs: string[], wire: LobbyWire = new RelayLobbyWire(),
  invited?: InvitedFriend[],
): Promise<LobbySession> {
  const relays = normalizeRelays(relayURLs);
  if (!Number.isInteger(maxPlayers) || maxPlayers < 2 || maxPlayers > 8) throw new Error('Choose 2–8 players.');
  const event = await identity.signEvent(lobbyTemplate({
    v: 1, type: 'create', name: normalizeDisplayName(name), maxPlayers, relays,
    nonce: bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
    ...(invited ? { invited } : {}),
  }));
  parseLobbyEvent(event, { v: 1, id: event.id, host: identity.pubkey, relays });
  const session = new LobbySession(identity, { v: 1, id: event.id, host: identity.pubkey, relays }, wire);
  // Keep the exact signed creation for retries even if an acknowledgment is lost.
  session.receive(event);
  session.pendingPublish = event;
  return session;
}

export function lobbyStorageKey(pubkey: string): string { return `nd.nostr.lobby.v1.${pubkey}`; }
export type SetupStorage = Pick<Storage, 'getItem' | 'setItem'>;
interface DurableSetup { secret: string | null; events: Event[] }
export function setupStorageKey(lobby: string, pubkey: string): string { return `nd.nostr.setup.v1.${lobby}.${pubkey}`; }
