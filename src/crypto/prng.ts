import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

export function sha256Hex(input: string): string {
  return bytesToHex(sha256(utf8ToBytes(input)));
}

const TWO_32 = 0x1_0000_0000;

/**
 * SHA-256 counter-mode DRBG. Identical output on every JS engine, so every client
 * derives the same maps, shuffles and dice from the same seed. Never use Math.random()
 * for game logic.
 */
export class DeterministicRng {
  private counter = 0;
  private words = new Uint32Array(0);
  private index = 0;

  constructor(readonly seed: string) {}

  private refill(): void {
    const block = sha256(utf8ToBytes(`${this.seed}:${this.counter++}`));
    const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
    this.words = new Uint32Array(8);
    for (let i = 0; i < 8; i++) this.words[i] = view.getUint32(i * 4);
    this.index = 0;
  }

  nextU32(): number {
    if (this.index >= this.words.length) this.refill();
    return this.words[this.index++];
  }

  /** Unbiased integer in [min, max] inclusive (rejection sampling). */
  nextInt(min: number, max: number): number {
    if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) throw new RangeError(`bad range [${min}, ${max}]`);
    const range = max - min + 1;
    if (range > TWO_32) throw new RangeError('range too large');
    const limit = TWO_32 - (TWO_32 % range);
    for (;;) {
      const x = this.nextU32();
      if (x < limit) return min + (x % range);
    }
  }

  rollD6(): number {
    return this.nextInt(1, 6);
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new RangeError('pick from empty array');
    return items[this.nextInt(0, items.length - 1)];
  }

  /** In-place Fisher–Yates. */
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = this.nextInt(0, i);
      [items[i], items[j]] = [items[j], items[i]];
    }
    return items;
  }

  /** Independent child stream, so adding draws in one subsystem never shifts another. */
  fork(label: string): DeterministicRng {
    return new DeterministicRng(sha256Hex(`${this.seed}/${label}`));
  }
}
