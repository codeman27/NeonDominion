import { sha256Hex } from './prng';

/**
 * Canonical JSON stringify.
 * - Objects: keys sorted by plain string comparison.
 * - Arrays: preserve order.
 * - Allowed values: strings, booleans, null, safe integers.
 * - Throws on non-integer numbers, NaN, Infinity, undefined, functions, Map/Set, class instances.
 */
export function canonicalStringify(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) throw new TypeError(`non-integer number: ${value}`);
    if (!Number.isSafeInteger(value)) throw new TypeError(`unsafe integer: ${value}`);
    return String(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalStringify).join(',') + ']';
  }
  if (typeof value === 'object') {
    // Reject class instances (they have a prototype chain that isn't Object.prototype)
    const proto = Object.getPrototypeOf(value);
    if (proto !== null && proto !== Object.prototype) {
      throw new TypeError('class instance not allowed');
    }
    const keys = Object.keys(value).sort();
    const pairs = keys.map(k => `${JSON.stringify(k)}:${canonicalStringify((value as Record<string, unknown>)[k])}`);
    return '{' + pairs.join(',') + '}';
  }
  throw new TypeError(`unsupported type: ${typeof value}`);
}

/**
 * SHA-256 fingerprint of a game state. `prevStateHash` is blanked so a state's hash never depends on
 * its own hash field; the hash chain is formed by storing the *previous* state's hash in that field.
 */
export function computeStateHash(state: object): string {
  return sha256Hex(canonicalStringify({ ...state, prevStateHash: '' }));
}
