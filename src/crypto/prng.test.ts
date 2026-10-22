import { describe, expect, it } from 'vitest';
import { DeterministicRng, sha256Hex } from './prng';

describe('DeterministicRng', () => {
  it('produces identical sequences for identical seeds', () => {
    const a = new DeterministicRng('seed'); const b = new DeterministicRng('seed');
    expect(Array.from({ length: 50 }, () => a.nextU32())).toEqual(Array.from({ length: 50 }, () => b.nextU32()));
  });

  it('is pinned to a known vector (guards against accidental algorithm changes)', () => {
    const rng = new DeterministicRng('neon');
    const block = sha256Hex('neon:0');
    expect(rng.nextU32()).toBe(parseInt(block.slice(0, 8), 16));
    expect(rng.nextU32()).toBe(parseInt(block.slice(8, 16), 16));
  });

  it('nextInt stays in range and covers every value roughly uniformly', () => {
    const rng = new DeterministicRng('dice');
    const counts = new Array(6).fill(0);
    for (let i = 0; i < 60_000; i++) counts[rng.rollD6() - 1]++;
    for (const c of counts) expect(Math.abs(c - 10_000)).toBeLessThan(500);
  });

  it('forked streams are independent and deterministic', () => {
    const r = new DeterministicRng('root');
    expect(r.fork('x').nextU32()).toBe(new DeterministicRng('root').fork('x').nextU32());
    expect(r.fork('x').nextU32()).not.toBe(r.fork('y').nextU32());
  });

  it('rejects invalid ranges', () => {
    expect(() => new DeterministicRng('x').nextInt(5, 4)).toThrow(RangeError);
  });
});
