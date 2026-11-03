import { sha256Hex } from '../crypto/prng';
import { canonicalStringify, computeStateHash } from '../crypto/stateHash';
import { isHex32 } from '../crypto/hashChain';
import { generateMap } from '../engine/mapGenerator';
import { applySetupPlacement, createGame } from '../engine/setup';
import type { DraftPlacementOrder } from '../types/actions';
import type { GameMap, GameState } from '../types/game';
import type { LobbyRecord, LobbyState } from './lobbyProtocol';

export interface SeedCommit { v: 1; type: 'seed-commit'; start: string; commitment: string }
export interface SeedReveal { v: 1; type: 'seed-reveal'; start: string; secret: string; commits: string[] }
export interface SetupDeploy { v: 1; type: 'setup-deploy'; start: string; baseHash: string; placements: DraftPlacementOrder[] }
export type SetupPayload = SeedCommit | SeedReveal | SetupDeploy;
export interface MultiplayerSetup {
  commits: Map<string, LobbyRecord>;
  reveals: Map<string, LobbyRecord>;
  deployments: Map<string, LobbyRecord>;
  map: GameMap | null;
  base: GameState | null;
  state: GameState | null;
  baseHash: string | null;
  conflict: string | null;
  warnings: string[];
}

export function isSetupPayload(payload: { type: string }): payload is SetupPayload {
  return ['seed-commit', 'seed-reveal', 'setup-deploy'].includes(payload.type);
}

export function parseSetupPayload(p: Record<string, unknown>): SetupPayload | null {
  if (p.type !== 'seed-commit' && p.type !== 'seed-reveal' && p.type !== 'setup-deploy') return null;
  if (p.v !== 1 || typeof p.start !== 'string' || !isHex32(p.start)) throw new Error('Invalid setup start reference.');
  if (p.type === 'seed-commit' && typeof p.commitment === 'string' && isHex32(p.commitment)) {
    return { v: 1, type: p.type, start: p.start, commitment: p.commitment };
  }
  if (p.type === 'seed-reveal' && typeof p.secret === 'string' && isHex32(p.secret)
    && Array.isArray(p.commits) && p.commits.length >= 2 && p.commits.length <= 8
    && p.commits.every((id): id is string => typeof id === 'string' && isHex32(id))) {
    return { v: 1, type: p.type, start: p.start, secret: p.secret, commits: p.commits };
  }
  if (p.type === 'setup-deploy' && typeof p.baseHash === 'string' && isHex32(p.baseHash)
    && Array.isArray(p.placements) && p.placements.length > 0 && p.placements.length <= 48) {
    const placements = p.placements.map(value => {
      if (typeof value !== 'object' || value === null || !('territoryId' in value) || !('troops' in value)
        || typeof value.territoryId !== 'number' || !Number.isSafeInteger(value.territoryId) || value.territoryId < 0
        || typeof value.troops !== 'number' || !Number.isSafeInteger(value.troops) || value.troops < 0 || value.troops > 35) {
        throw new Error('Invalid setup placement.');
      }
      return { territoryId: value.territoryId, troops: value.troops };
    });
    if (placements.some((p, i) => i > 0 && p.territoryId <= placements[i - 1].territoryId)) {
      throw new Error('Setup placements must have unique, increasing territory IDs.');
    }
    return { v: 1, type: p.type, start: p.start, baseHash: p.baseHash, placements };
  }
  throw new Error('Invalid setup payload.');
}

export function seedCommitment(start: string, pubkey: string, secret: string): string {
  return sha256Hex(`neon-dominion-setup-commit-v1:${start}:${pubkey}:${secret}`);
}

export function deriveSetup(lobby: LobbyState, records: readonly LobbyRecord[], previous?: MultiplayerSetup): MultiplayerSetup {
  const setup: MultiplayerSetup = {
    commits: new Map(), reveals: new Map(), deployments: new Map(),
    map: null, base: null, state: null, baseHash: null, conflict: lobby.conflict, warnings: [],
  };
  if (!lobby.start || lobby.conflict) return setup;
  const start = lobby.start.event.id;
  const participants = new Set(lobby.members.map(m => m.pubkey));
  const relevant = records.filter(r => isSetupPayload(r.payload) && r.payload.start === start && participants.has(r.event.pubkey));
  for (const member of lobby.members) {
    for (const [type, target] of [
      ['seed-commit', setup.commits], ['seed-reveal', setup.reveals], ['setup-deploy', setup.deployments],
    ] as const) {
      const candidates = relevant.filter(r => r.event.pubkey === member.pubkey && r.payload.type === type);
      if (candidates.length > 1) {
        setup.conflict = `${member.name} signed conflicting ${type} events. Setup halted; retain signed history.`;
        return setup;
      }
      if (candidates.length) target.set(member.pubkey, candidates[0]);
    }
  }
  if (setup.commits.size !== lobby.members.length) return setup;
  const secrets: string[] = [];
  for (const member of lobby.members) {
    const commit = setup.commits.get(member.pubkey)!.payload;
    const reveal = setup.reveals.get(member.pubkey)?.payload;
    if (!reveal) continue;
    if (commit.type !== 'seed-commit' || reveal.type !== 'seed-reveal') throw new Error('Unexpected setup record.');
    if (JSON.stringify(reveal.commits) !== JSON.stringify(lobby.members.map(m => setup.commits.get(m.pubkey)!.event.id))) {
      setup.conflict = `${member.name} revealed against a different commitment roster. Setup halted.`;
      return setup;
    }
    if (seedCommitment(start, member.pubkey, reveal.secret) !== commit.commitment) {
      setup.conflict = `${member.name} revealed a seed that does not match their commitment. Setup halted.`;
      return setup;
    }
    secrets.push(reveal.secret);
  }
  if (secrets.length !== lobby.members.length) return setup;
  const seed = sha256Hex(canonicalStringify({ domain: 'neon-dominion-setup-seed-v1', start, secrets }));
  let map: GameMap;
  let base: GameState;
  try {
    map = previous?.map?.seed === seed ? previous.map : generateMap({ seed, playerCount: lobby.members.length });
    base = previous?.base?.gameId === start && previous.base.mapSeed === seed ? previous.base : createGame({
      gameId: start, map, setupSeed: seed,
      // Witness heads bind to the fully deployed state in the separate play-ready stage.
      players: lobby.members.map(m => ({ id: m.pubkey, name: m.name, isBot: false, hashCommitment: '' })),
    });
  } catch (error) {
    setup.conflict = `Cannot generate the agreed setup: ${error instanceof Error ? error.message : String(error)}. Setup halted; no replacement seed is permitted.`;
    return setup;
  }
  setup.map = map;
  setup.base = base;
  setup.baseHash = computeStateHash(base);
  let state = base;
  for (let seat = 0; seat < lobby.members.length; seat++) {
    const member = lobby.members[seat];
    const record = setup.deployments.get(member.pubkey);
    if (!record || record.payload.type !== 'setup-deploy') continue;
    const payload = record.payload;
    try {
      if (payload.baseHash !== setup.baseHash) throw new Error('Initial state hash does not match the shared map/deal.');
      applySetupPlacement(base, { type: 'SETUP_PLACEMENT', playerIndex: seat, placements: payload.placements });
      state = applySetupPlacement(state, { type: 'SETUP_PLACEMENT', playerIndex: seat, placements: payload.placements });
    } catch (error) {
      setup.conflict = `${member.name} signed an invalid deployment: ${error instanceof Error ? error.message : String(error)} Setup halted.`;
      return setup;
    }
  }
  setup.state = state;
  return setup;
}
