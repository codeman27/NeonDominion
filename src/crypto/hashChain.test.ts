import { describe, expect, it } from 'vitest';
import {
  HASH_CHAIN_LENGTH, HashChainCursor, HashChainError, advanceCommitment, createHashChain,
  generateRootSecret, hashLink, verifyReveal,
} from './hashChain';

const ZERO = '0'.repeat(64);
const ROOT = 'a1'.repeat(32);

describe('hashLink', () => {
  it('hashes the raw 32 bytes (known SHA-256 vector of 32 zero bytes)', () => {
    expect(hashLink(ZERO)).toBe('66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925');
  });

  it('rejects non-canonical input (uppercase, wrong length, non-hex)', () => {
    expect(() => hashLink(ZERO.toUpperCase().replace(/0/g, 'A'))).toThrow(TypeError);
    expect(() => hashLink('00')).toThrow(TypeError);
    expect(() => hashLink('zz'.repeat(32))).toThrow(TypeError);
  });
});

describe('createHashChain', () => {
  const chain = createHashChain(ROOT, 10);

  it('is deterministic for the same root', () => {
    expect(createHashChain(ROOT, 10)).toEqual(chain);
  });

  it('ends at the root and starts at SHA256^N(root)', () => {
    expect(chain.secrets).toHaveLength(10);
    expect(chain.secrets[9]).toBe(ROOT);
    let h = ROOT;
    for (let i = 0; i < 10; i++) h = hashLink(h);
    expect(chain.head).toBe(h);
  });

  it('defaults to the documented length', () => {
    expect(createHashChain(ROOT).length).toBe(HASH_CHAIN_LENGTH);
  });

  it('rejects bad roots and lengths', () => {
    expect(() => createHashChain('abc', 10)).toThrow(TypeError);
    expect(() => createHashChain(ROOT, 0)).toThrow(RangeError);
  });
});

describe('reveal verification', () => {
  const chain = createHashChain(ROOT, 10);

  it('accepts every secret in order, each becoming the next head', () => {
    let head = chain.head;
    for (const s of chain.secrets) head = advanceCommitment(head, s);
    expect(head).toBe(ROOT);
  });

  it('rejects a wrong secret', () => {
    expect(verifyReveal(chain.head, 'b2'.repeat(32))).toBe(false);
    expect(() => advanceCommitment(chain.head, 'b2'.repeat(32))).toThrow(HashChainError);
  });

  it('rejects out-of-order reveals (skipping ahead)', () => {
    expect(verifyReveal(chain.head, chain.secrets[1])).toBe(false);
  });

  it('rejects replaying an already revealed secret', () => {
    const head1 = advanceCommitment(chain.head, chain.secrets[0]);
    expect(verifyReveal(head1, chain.secrets[0])).toBe(false);
  });

  it('rejects revealing the commitment itself', () => {
    expect(verifyReveal(chain.head, chain.head)).toBe(false);
  });
});

describe('HashChainCursor', () => {
  it('hands out secrets in order and tracks the expected commitment', () => {
    const cursor = HashChainCursor.fromRoot(ROOT, 3);
    const c0 = cursor.initialCommitment;
    expect(cursor.currentCommitment).toBe(c0);
    const s1 = cursor.next();
    expect(verifyReveal(c0, s1)).toBe(true);
    expect(cursor.currentCommitment).toBe(s1);
    expect(verifyReveal(s1, cursor.next())).toBe(true);
    expect(cursor.remaining).toBe(1);
    cursor.next();
    expect(() => cursor.next()).toThrow(HashChainError);
  });

  it('saves and restores mid-chain', () => {
    const a = HashChainCursor.fromRoot(ROOT, 5);
    a.next(); a.next();
    const b = HashChainCursor.restore(a.save());
    expect(b.revealsUsed).toBe(2);
    expect(b.currentCommitment).toBe(a.currentCommitment);
    expect(b.next()).toBe(a.next());
  });

  it('rejects corrupted saves', () => {
    expect(() => HashChainCursor.restore({ root: ROOT, length: 5, used: 6 })).toThrow(RangeError);
  });
});

describe('generateRootSecret', () => {
  it('produces distinct 32-byte hex secrets', () => {
    const a = generateRootSecret(); const b = generateRootSecret();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });

  it('a full-length chain builds quickly enough for game start', () => {
    const t0 = performance.now();
    createHashChain(generateRootSecret());
    expect(performance.now() - t0).toBeLessThan(500);
  });
});
