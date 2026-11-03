import { afterEach, describe, expect, it, vi } from 'vitest';
import { beaconRandomness, beaconTime, BEACON_CHAIN, fetchBeacon, futureBeaconRound } from './beacon';

// Public quicknet round 1000, fetched from the pinned chain's /public/1000 endpoint.
export const SAMPLE_BEACON = {
  round: 1000,
  randomness: 'fe290beca10872ef2fb164d2aa4442de4566183ec51c56ff3cd603d930e54fdd',
  signature: 'b44679b9a59af2ec876b1a6b1ad52ea9b1615fc3982b19576350f93447cb1125e342b73a8dd2bacbe47e4b6b63ed5e39',
};
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe('drand quicknet proof verification', () => {
  it('verifies a real public BLS proof and derives the published randomness', () => {
    expect(beaconRandomness(SAMPLE_BEACON)).toBe(SAMPLE_BEACON.randomness);
    expect(beaconRandomness(SAMPLE_BEACON)).toBe(SAMPLE_BEACON.randomness);
  });
  it('rejects altered signatures, wrong rounds, malformed lengths and unsafe round numbers', () => {
    expect(() => beaconRandomness({ ...SAMPLE_BEACON, round: 1001 })).toThrow('signature');
    expect(() => beaconRandomness({ ...SAMPLE_BEACON, signature: '0'.repeat(96) })).toThrow();
    expect(() => beaconRandomness({ ...SAMPLE_BEACON, signature: 'aa' })).toThrow('Malformed');
    expect(() => beaconRandomness({ ...SAMPLE_BEACON, round: 1.1 })).toThrow('Malformed');
    expect(() => beaconRandomness({ ...SAMPLE_BEACON, round: Number.MAX_SAFE_INTEGER + 1 })).toThrow('Malformed');
  });
  it('selects a strictly future round 9–12 seconds after an integer commitment timestamp', () => {
    for (let offset = 0; offset < 9; offset++) {
      const time = beaconTime(1000) + offset;
      const delay = beaconTime(futureBeaconRound(time)) - time;
      expect(delay).toBeGreaterThan(9);
      expect(delay).toBeLessThanOrEqual(12);
    }
    expect(futureBeaconRound(beaconTime(1000) - 10)).toBe(1000);
    expect(() => futureBeaconRound(0)).toThrow('timestamp');
  });
  it('requests only the pinned round and chain and falls back between mirrors without rerolling', async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new Error('Unavailable')).mockResolvedValueOnce(Response.json(SAMPLE_BEACON));
    vi.stubGlobal('fetch', fetch);
    expect(await fetchBeacon(1000)).toEqual({ round: 1000, signature: SAMPLE_BEACON.signature });
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const [url] of fetch.mock.calls) expect(url).toContain(`/${BEACON_CHAIN}/public/1000`);
  });
  it('rejects forged API data and reports total outage instead of returning fallback dice', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ ...SAMPLE_BEACON, randomness: 'ab'.repeat(32) })));
    await expect(fetchBeacon(1000)).rejects.toThrow('randomness does not match');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ ...SAMPLE_BEACON, round: 1001 })));
    await expect(fetchBeacon(1000)).rejects.toThrow('locked round');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    await expect(fetchBeacon(1000)).rejects.toThrow('Attack remains locked to round 1000');
  });
  it('honors cancellation without trying other mirrors', async () => {
    const controller = new AbortController(); controller.abort();
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(fetchBeacon(1000, controller.signal)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
