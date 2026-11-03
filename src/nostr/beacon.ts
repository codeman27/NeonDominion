import { bls12_381 } from '@noble/curves/bls12-381.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

export const BEACON_CHAIN = '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971';
const PUBLIC_KEY = '83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a';
const GENESIS = 1692803367;
const PERIOD = 3;
export const BEACON_LEAD_SECONDS = 9;
const ENDPOINTS = ['https://api.drand.sh', 'https://api2.drand.sh', 'https://api3.drand.sh'];
const verified = new Map<string, string>();

export interface BeaconProof { round: number; signature: string }
export function beaconTime(round: number): number { return GENESIS + (round - 1) * PERIOD; }
export function futureBeaconRound(createdAt: number): number {
  if (!Number.isSafeInteger(createdAt) || createdAt < GENESIS) throw new Error('Invalid attack timestamp for beacon.');
  return Math.floor((createdAt + BEACON_LEAD_SECONDS - GENESIS) / PERIOD) + 2;
}
export function beaconRandomness(proof: BeaconProof): string {
  if (!Number.isSafeInteger(proof.round) || proof.round < 1 || !/^[0-9a-f]{96}$/.test(proof.signature)) {
    throw new Error('Malformed drand quicknet proof.');
  }
  const key = `${proof.round}:${proof.signature}`, cached = verified.get(key);
  if (cached) return cached;
  const round = new Uint8Array(8);
  new DataView(round.buffer).setBigUint64(0, BigInt(proof.round), false);
  const bls = bls12_381.shortSignatures;
  let valid: boolean;
  try {
    valid = bls.verify(hexToBytes(proof.signature), bls.hash(sha256(round), 'BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_'), hexToBytes(PUBLIC_KEY));
  } catch {
    throw new Error('Invalid drand quicknet BLS proof encoding.');
  }
  if (!valid) throw new Error('Invalid drand quicknet BLS signature.');
  const randomness = bytesToHex(sha256(hexToBytes(proof.signature)));
  if (verified.size >= 8192) verified.delete(verified.keys().next().value!);
  verified.set(key, randomness);
  return randomness;
}

export async function fetchBeacon(round: number, signal?: AbortSignal): Promise<BeaconProof> {
  if (!Number.isSafeInteger(round) || round < 1) throw new Error('Invalid beacon round.');
  const failures: string[] = [];
  for (const endpoint of ENDPOINTS) {
    signal?.throwIfAborted();
    try {
      const response = await fetch(`${endpoint}/${BEACON_CHAIN}/public/${round}`, {
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const value: unknown = await response.json();
      if (typeof value !== 'object' || value === null || !('round' in value) || value.round !== round
        || !('signature' in value) || typeof value.signature !== 'string') throw new Error('Beacon response does not match the locked round.');
      const proof = { round, signature: value.signature };
      const randomness = beaconRandomness(proof);
      if (!('randomness' in value) || value.randomness !== randomness) throw new Error('Beacon randomness does not match its signature.');
      return proof;
    } catch (error) {
      signal?.throwIfAborted();
      failures.push(`${endpoint}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`Beacon unavailable. Attack remains locked to round ${round}; retry without changing it. ${failures.join('; ')}`);
}
