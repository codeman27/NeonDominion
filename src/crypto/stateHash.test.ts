import { describe, expect, it } from 'vitest';
import { sha256Hex } from './prng';
import { canonicalStringify, computeStateHash } from './stateHash';

describe('canonicalStringify', () => {
  it('sorts object keys and keeps array order, no whitespace', () => {
    expect(canonicalStringify({ b: 1, a: [2, { d: 'x', c: null }] })).toBe('{"a":[2,{"c":null,"d":"x"}],"b":1}');
  });

  it('is independent of key insertion order', () => {
    expect(canonicalStringify({ x: 1, y: { p: true, q: 'z' } })).toBe(canonicalStringify({ y: { q: 'z', p: true }, x: 1 }));
  });

  it('escapes strings like JSON', () => {
    expect(canonicalStringify({ 'k"': 'a\nb' })).toBe('{"k\\"":"a\\nb"}');
  });

  it.each([
    ['float', { a: 1.5 }],
    ['NaN', { a: NaN }],
    ['Infinity', [Infinity]],
    ['undefined value', { a: undefined }],
    ['top-level undefined', undefined],
    ['function', { f: () => 1 }],
    ['Map', new Map()],
    ['Set', { s: new Set([1]) }],
    ['class instance', { d: new Date(0) }],
    ['unsafe integer', { n: 2 ** 60 }],
  ])('throws on %s', (_, value) => {
    expect(() => canonicalStringify(value)).toThrow(TypeError);
  });
});

describe('computeStateHash', () => {
  it('pins a known vector', () => {
    const v = { b: 1, a: [2, { d: 'x', c: null }] };
    expect(computeStateHash(v)).toBe(sha256Hex('{"a":[2,{"c":null,"d":"x"}],"b":1,"prevStateHash":""}'));
    expect(computeStateHash(v)).toBe('11236c362d0a5770c0ba130be63af130c01f9143f9efda144066de0d9440618e');
  });

  it('ignores the prevStateHash field itself', () => {
    expect(computeStateHash({ turn: 3, prevStateHash: 'aaa' })).toBe(computeStateHash({ turn: 3, prevStateHash: 'bbb' }));
  });

  it('changes when any nested field changes', () => {
    const base = { turn: 3, territories: [{ owner: 0, troops: 2 }, { owner: 1, troops: 5 }] };
    const changed = structuredClone(base); changed.territories[1].troops = 6;
    expect(computeStateHash(base)).not.toBe(computeStateHash(changed));
  });

  it('does not depend on key order', () => {
    expect(computeStateHash({ a: 1, b: [1, 2] })).toBe(computeStateHash({ b: [1, 2], a: 1 }));
  });
});
