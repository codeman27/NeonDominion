import { verifyEvent, type Event, type EventTemplate } from 'nostr-tools/pure';
import { isHex32 } from '../crypto/hashChain';
import { normalizeDisplayName } from './profile';
import { normalizeURL } from 'nostr-tools/utils';
import { MAP_GENERATOR_VERSION } from '../engine/mapGenerator';
import { parseSetupPayload, type SetupPayload } from './setupProtocol';
import { parsePlayPayload, type PlayPayload } from './playProtocol';

export const LOBBY_KIND = 1042;
export const MAX_GAME_HISTORY = 250000;
export const LOBBY_TOPIC = 'neon-dominion-lobby-v1';
export const DEFAULT_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net'];
export interface LobbyInvite { v: 1; id: string; host: string; relays: string[] }
export interface LobbyMember { pubkey: string; name: string; request: string }
export interface CreateLobby { v: 1; type: 'create'; name: string; maxPlayers: number; relays: string[]; nonce: string }
export interface LobbyRequest { v: 1; type: 'request'; name: string; active: boolean; seq: number; prev: string }
export interface LobbyRoster { v: 1; type: 'roster'; members: LobbyMember[]; closed: boolean; seq: number; prev: string }
export interface LobbyStart { v: 1; type: 'start'; members: LobbyMember[]; mapGeneratorVersion: number; seq: number; prev: string }
export type LobbyPayload = CreateLobby | LobbyRequest | LobbyRoster | LobbyStart | SetupPayload | PlayPayload;
export interface LobbyRecord { event: Event; payload: LobbyPayload }
export interface LobbyState {
  creation: CreateLobby | null;
  members: LobbyMember[];
  pending: LobbyMember[];
  requests: Map<string, LobbyRecord>;
  roster: LobbyRecord | null;
  start: LobbyRecord | null;
  closed: boolean;
  conflict: string | null;
  warnings: string[];
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function name(value: unknown): value is string {
  return typeof value === 'string' && normalizeDisplayName(value) === value;
}
function sequence(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === 'number' && value >= 1;
}

export function normalizeRelays(values: string[]): string[] {
  if (values.length < 1 || values.length > 3) throw new Error('Choose 1–3 relay URLs.');
  const relays = values.map(value => {
    let url: URL;
    try { url = new URL(value.trim()); } catch { throw new Error('Invalid relay URL. Use wss:// or ws://.'); }
    if (!['wss:', 'ws:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) {
      throw new Error('Relay URLs must use wss:// or ws:// without credentials, query strings or fragments.');
    }
    return normalizeURL(url.href);
  });
  if (new Set(relays).size !== relays.length) throw new Error('Relay URLs must be different.');
  return relays;
}

export function encodeInvite(invite: LobbyInvite): string {
  return `nd1:${btoa(JSON.stringify(invite)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')}`;
}

export function decodeInvite(input: string): LobbyInvite {
  try {
    const text = input.trim();
    if (!text.startsWith('nd1:') || text.length > 4096) throw new Error('Invalid format');
    const value: unknown = JSON.parse(atob(text.slice(4).replaceAll('-', '+').replaceAll('_', '/')));
    if (!object(value) || value.v !== 1 || typeof value.id !== 'string' || !isHex32(value.id)
      || typeof value.host !== 'string' || !isHex32(value.host)
      || !Array.isArray(value.relays) || !value.relays.every((r): r is string => typeof r === 'string')) throw new Error('Invalid fields');
    return { v: 1, id: value.id, host: value.host, relays: normalizeRelays(value.relays) };
  } catch {
    throw new Error('Invalid Neon Dominion invite. Paste the complete nd1: code.');
  }
}

export function lobbyTemplate(payload: LobbyPayload, gameId?: string): EventTemplate {
  return {
    kind: LOBBY_KIND, created_at: Math.floor(Date.now() / 1000),
    tags: [['t', LOBBY_TOPIC], ...(gameId ? [['e', gameId]] : [])],
    content: JSON.stringify(payload),
  };
}

/** Reconstruct the event so a library verification-cache symbol cannot bypass validation. */
export function parseLobbyEvent(input: unknown, invite: LobbyInvite): LobbyRecord {
  if (!object(input) || typeof input.id !== 'string' || typeof input.pubkey !== 'string'
    || typeof input.sig !== 'string' || typeof input.kind !== 'number' || typeof input.created_at !== 'number'
    || !Number.isSafeInteger(input.created_at) || typeof input.content !== 'string' || !Array.isArray(input.tags)
    || input.tags.length > 16 || !input.tags.every((t): t is string[] => Array.isArray(t) && t.length <= 4 && t.every(s => typeof s === 'string' && s.length <= 256))) {
    throw new Error('Malformed lobby event.');
  }
  const event: Event = {
    id: input.id, pubkey: input.pubkey, sig: input.sig, kind: input.kind,
    created_at: input.created_at, tags: structuredClone(input.tags), content: input.content,
  };
  if (event.kind !== LOBBY_KIND || event.content.length > 8192 || !verifyEvent(event)
    || !event.tags.some(t => t.length === 2 && t[0] === 't' && t[1] === LOBBY_TOPIC)) {
    throw new Error('Invalid lobby signature, kind or topic.');
  }
  const p: unknown = JSON.parse(event.content);
  if (!object(p) || p.v !== 1) throw new Error('Unsupported lobby message.');
  if (p.type === 'create') {
    if (event.id !== invite.id || event.pubkey !== invite.host || !name(p.name)
      || typeof p.maxPlayers !== 'number' || !Number.isInteger(p.maxPlayers) || p.maxPlayers < 2 || p.maxPlayers > 8
      || typeof p.nonce !== 'string' || !isHex32(p.nonce) || !Array.isArray(p.relays)
      || !p.relays.every((r): r is string => typeof r === 'string')
      || JSON.stringify(normalizeRelays(p.relays)) !== JSON.stringify(invite.relays)) throw new Error('Invalid lobby creation or invite mismatch.');
    return { event, payload: { v: 1, type: 'create', name: p.name, maxPlayers: p.maxPlayers, nonce: p.nonce, relays: invite.relays } };
  }
  if (!event.tags.some(t => t.length === 2 && t[0] === 'e' && t[1] === invite.id)) throw new Error('Invalid lobby reference.');
  const setup = parseSetupPayload(p);
  if (setup) return { event, payload: setup };
  const play = parsePlayPayload(p);
  if (play) return { event, payload: play };
  if (!sequence(p.seq) || typeof p.prev !== 'string' || !isHex32(p.prev)) throw new Error('Invalid lobby sequence.');
  if (p.type === 'request' && name(p.name) && typeof p.active === 'boolean' && event.pubkey !== invite.host) {
    return { event, payload: { v: 1, type: 'request', name: p.name, active: p.active, seq: p.seq, prev: p.prev } };
  }
  if ((p.type === 'roster' || p.type === 'start') && event.pubkey === invite.host
    && (p.type === 'roster' ? typeof p.closed === 'boolean' : p.mapGeneratorVersion === MAP_GENERATOR_VERSION)
    && Array.isArray(p.members) && p.members.length <= 7) {
    const members: LobbyMember[] = p.members.map(m => {
      if (!object(m) || typeof m.pubkey !== 'string' || !isHex32(m.pubkey) || m.pubkey === invite.host
        || !name(m.name) || typeof m.request !== 'string' || !isHex32(m.request)) throw new Error('Invalid lobby member.');
      return { pubkey: m.pubkey, name: m.name, request: m.request };
    });
    if (new Set(members.map(m => m.pubkey)).size !== members.length) throw new Error('Duplicate lobby member.');
    if (p.type === 'start') {
      if (!members.length) throw new Error('Start Game requires at least two approved commanders.');
      return { event, payload: { v: 1, type: 'start', members, mapGeneratorVersion: MAP_GENERATOR_VERSION, seq: p.seq, prev: p.prev } };
    }
    return { event, payload: { v: 1, type: 'roster', members, closed: p.closed === true, seq: p.seq, prev: p.prev } };
  }
  throw new Error('Invalid lobby message or unauthorized author.');
}

/** Arrival order and event timestamps never choose a winner between conflicting signatures. */
export function deriveLobby(invite: LobbyInvite, records: readonly LobbyRecord[]): LobbyState {
  const root = records.find(r => r.event.id === invite.id);
  const creation = root?.payload.type === 'create' ? root.payload : null;
  const state: LobbyState = { creation, members: [], pending: [], requests: new Map(), roster: null, start: null, closed: false, conflict: null, warnings: [] };
  if (!creation) return state;
  const validRequests = new Map<string, LobbyRecord>();
  const authors = [...new Set(records.filter(r => r.payload.type === 'request').map(r => r.event.pubkey))].sort();
  for (const author of authors) {
    let prev = invite.id;
    for (let seq = 1; ; seq++) {
      const next = records.filter(r => r.event.pubkey === author && r.payload.type === 'request' && r.payload.seq === seq && r.payload.prev === prev);
      if (next.length > 1) {
        if (records.some(r => r.payload.type === 'start' && r.payload.members.some(m => m.pubkey === author))) {
          state.conflict = 'A commander named in a signed start has conflicting join/leave signatures. Setup halted; retain signed history.';
          return state;
        }
        state.warnings.push(`Conflicting join/leave signatures from ${author}. This identity cannot be admitted; retain the event history.`);
        state.requests.delete(author);
        break;
      }
      if (!next.length) break;
      state.requests.set(author, next[0]);
      validRequests.set(next[0].event.id, next[0]);
      prev = next[0].event.id;
    }
  }
  let prev = invite.id;
  for (let seq = 1; ; seq++) {
    const next = records.filter(r => (r.payload.type === 'roster' || r.payload.type === 'start') && r.payload.seq === seq && r.payload.prev === prev);
    if (next.length > 1) { state.conflict = 'The host signed conflicting rosters. Lobby halted; retain the event history.'; return state; }
    if (!next.length) break;
    const current = next[0];
    if (current.payload.type !== 'roster' && current.payload.type !== 'start') break;
    if (current.payload.members.length >= creation.maxPlayers) {
      state.conflict = 'The host signed an over-capacity roster.'; return state;
    }
    if (!current.payload.members.every(m => {
      const request = validRequests.get(m.request);
      return request?.event.pubkey === m.pubkey && request.payload.type === 'request' && request.payload.active && request.payload.name === m.name;
    })) {
      state.warnings.push('Waiting for signed join requests referenced by the host roster. Reconnect if history is incomplete.');
      break;
    }
    if (current.payload.type === 'start') {
      const approved = state.roster?.payload;
      if (!current.payload.members.every(m => approved?.type === 'roster'
        && approved.members.some(a => a.pubkey === m.pubkey && a.request === m.request && a.name === m.name))) {
        state.conflict = 'The host attempted to start with unapproved commanders.'; return state;
      }
      state.start = current;
      break;
    }
    state.roster = current;
    prev = current.event.id;
    if (current.payload.closed) { state.closed = true; break; }
  }
  const accepted = state.start?.payload.type === 'start' ? state.start.payload.members
    : state.roster?.payload.type === 'roster' ? state.roster.payload.members : [];
  state.members = [{ pubkey: invite.host, name: creation.name, request: invite.id }, ...accepted.filter(m => {
    if (state.start) return true;
    const request = state.requests.get(m.pubkey);
    return request?.event.id === m.request && request.payload.type === 'request' && request.payload.active;
  })];
  state.pending = [...state.requests.values()].filter(r => r.payload.type === 'request' && r.payload.active
    && !state.members.some(m => m.pubkey === r.event.pubkey))
    .map(r => ({ pubkey: r.event.pubkey, name: r.payload.type === 'request' ? r.payload.name : '', request: r.event.id }))
    .sort((a, b) => a.pubkey.localeCompare(b.pubkey));
  if (state.start) state.pending = [];
  return state;
}
