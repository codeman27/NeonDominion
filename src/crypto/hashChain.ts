import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

/*
 * Pre-committed SHA-256 hash chains (ARCHITECTURE.md §5.1).
 *
 *   S_N = random root secret (32 bytes)
 *   S_k = SHA256(S_{k+1})           for k = N-1 … 0
 *   C_0 = S_0                       (published at game join)
 *
 * Reveals happen in order S_1, S_2, …, S_N. Each reveal is checked with SHA256(S_k) === current head,
 * after which S_k becomes the new head. Nobody (including the owner) can choose a different future
 * secret once C_0 is public, and a secret can never be revealed twice or out of order.
 *
 * All values are lowercase 64-char hex strings; hashing is over the raw 32 bytes, not the hex text.
 */

export const HASH_CHAIN_LENGTH = 500;

const HEX32 = /^[0-9a-f]{64}$/;

export function isHex32(value: string): boolean {
  return HEX32.test(value);
}

/** One link of the chain: SHA256 over the 32 raw bytes of `secretHex`. */
export function hashLink(secretHex: string): string {
  if (!isHex32(secretHex)) throw new TypeError('hash-chain values must be 64 lowercase hex chars');
  return bytesToHex(sha256(hexToBytes(secretHex)));
}

/** Fresh 32-byte root secret from the platform CSPRNG. Never derive this from game state. */
export function generateRootSecret(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
}

export interface HashChain {
  /** Number of revealable secrets (N). */
  length: number;
  /** C_0, the public commitment published when joining a game. */
  head: string;
  /** secrets[k - 1] = S_k, in reveal order. secrets[length - 1] is the root. Keep private. */
  secrets: string[];
}

/** Deterministically expands a root secret into a full chain (also used to restore from storage). */
export function createHashChain(rootSecret: string, length: number = HASH_CHAIN_LENGTH): HashChain {
  if (!Number.isInteger(length) || length < 1) throw new RangeError('chain length must be a positive integer');
  if (!isHex32(rootSecret)) throw new TypeError('root secret must be 64 lowercase hex chars');
  const secrets = new Array<string>(length);
  secrets[length - 1] = rootSecret;
  for (let k = length - 2; k >= 0; k--) secrets[k] = hashLink(secrets[k + 1]);
  return { length, head: hashLink(secrets[0]), secrets };
}

/** True if `secret` is exactly the next reveal for `commitment` (SHA256(secret) === commitment). */
export function verifyReveal(commitment: string, secret: string): boolean {
  return isHex32(commitment) && isHex32(secret) && hashLink(secret) === commitment;
}

/** Validates a reveal and returns the new commitment head (which is the revealed secret). */
export function advanceCommitment(commitment: string, secret: string): string {
  if (!verifyReveal(commitment, secret)) throw new HashChainError('reveal does not match the current commitment');
  return secret;
}

export class HashChainError extends Error {
  override name = 'HashChainError';
}

/**
 * Owner-side cursor: hands out secrets strictly in order and remembers how many were used.
 * Persist `{ root, length, used }` (e.g. in IndexedDB) and rebuild with `HashChainCursor.restore`.
 */
export class HashChainCursor {
  private constructor(private readonly chain: HashChain, private used: number) {}

  static fromRoot(rootSecret: string, length: number = HASH_CHAIN_LENGTH): HashChainCursor {
    return new HashChainCursor(createHashChain(rootSecret, length), 0);
  }

  static restore(saved: { root: string; length: number; used: number }): HashChainCursor {
    const chain = createHashChain(saved.root, saved.length);
    if (!Number.isInteger(saved.used) || saved.used < 0 || saved.used > chain.length) throw new RangeError('invalid used count');
    return new HashChainCursor(chain, saved.used);
  }

  /** The public C_0 for this chain. */
  get initialCommitment(): string {
    return this.chain.head;
  }

  /** What other players currently expect the next reveal to hash to. */
  get currentCommitment(): string {
    return this.used === 0 ? this.chain.head : this.chain.secrets[this.used - 1];
  }

  get revealsUsed(): number {
    return this.used;
  }

  get remaining(): number {
    return this.chain.length - this.used;
  }

  /** Returns the next secret to reveal and advances. Throws when the chain is exhausted. */
  next(): string {
    if (this.used >= this.chain.length) throw new HashChainError('hash chain exhausted');
    return this.chain.secrets[this.used++];
  }

  save(): { root: string; length: number; used: number } {
    return { root: this.chain.secrets[this.chain.length - 1], length: this.chain.length, used: this.used };
  }
}
