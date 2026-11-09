import { describe, expect, it } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent, type EventTemplate } from 'nostr-tools/pure';
import { connectExtension, connectGuest, connectNsec, forgetGuest, rememberLogin, restoreGuest } from './identity';
import { nsecEncode, npubEncode } from 'nostr-tools/nip19';

const template: EventTemplate = { kind: 1, created_at: 1700000000, tags: [['t', 'neon-dominion-test']], content: 'signing test' };

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

describe('Nostr identity', () => {
  it('exports device-account backups that restore the exact signing identity without serializing secrets', async () => {
    const storage = memoryStorage();
    const guest = connectGuest(storage);
    expect(guest.exportNsec).toBeTypeOf('function');
    const backup = guest.exportNsec!();
    const imported = connectNsec(backup);
    expect(imported.pubkey).toBe(guest.pubkey);
    expect(verifyEvent(await imported.signEvent(template))).toBe(true);
    expect(restoreGuest(storage)?.exportNsec?.()).toBe(backup);
    expect(JSON.stringify(guest)).not.toContain(backup);
    expect(JSON.stringify(guest)).not.toContain(storage.getItem('nd.nostr.guest.v1'));
    expect(imported.exportNsec).toBeUndefined();
  });
  it('restores an existing guest without generating or rewriting keys, including pre-preference saves', () => {
    const storage = memoryStorage();
    expect(restoreGuest(storage)).toBeNull();
    expect(storage.getItem('nd.nostr.guest.v1')).toBeNull();
    const original = connectGuest(storage);
    const readOnly = { getItem: storage.getItem, setItem: () => { throw new Error('Unexpected write'); } };
    expect(restoreGuest(readOnly)?.pubkey).toBe(original.pubkey);
    rememberLogin('guest', storage);
    expect(restoreGuest(readOnly)?.pubkey).toBe(original.pubkey);
  });
  it('respects explicit disconnect and other login methods instead of falling back to a saved guest', () => {
    const storage = memoryStorage();
    const guest = connectGuest(storage);
    for (const source of [null, 'extension', 'nsec'] as const) {
      rememberLogin(source, storage);
      expect(restoreGuest(storage)).toBeNull();
    }
    rememberLogin('guest', storage);
    expect(restoreGuest(storage)?.pubkey).toBe(guest.pubkey);
    forgetGuest(storage);
    expect(restoreGuest(storage)).toBeNull();
  });
  it('surfaces automatic restoration errors without replacing saved identity data', () => {
    const storage = memoryStorage();
    storage.setItem('nd.nostr.guest.v1', 'invalid');
    expect(() => restoreGuest(storage)).toThrow('saved guest identity is invalid');
    expect(storage.getItem('nd.nostr.guest.v1')).toBe('invalid');
    storage.setItem('nd.nostr.login.v1', 'invalid');
    expect(() => restoreGuest(storage)).toThrow('Invalid saved login preference');
    expect(() => restoreGuest({ getItem: () => { throw new Error('Storage blocked'); }, setItem: () => {} })).toThrow('Storage blocked');
  });
  it('imports an NSEC with surrounding whitespace and signs with its identity', async () => {
    const secret = generateSecretKey();
    const nsec = nsecEncode(secret);
    const identity = connectNsec(` \n${nsec} \n`);
    expect(identity.source).toBe('nsec');
    expect(identity.pubkey).toBe(getPublicKey(secret));
    const signed = await identity.signEvent(template);
    expect(verifyEvent(signed)).toBe(true);
    expect(signed.pubkey).toBe(identity.pubkey);
    expect(JSON.stringify(identity)).not.toContain(nsec);
  });

  it('rejects invalid and non-secret keys without including input in errors', () => {
    for (const input of ['', 'nsec1invalid-sensitive-input', 'ab'.repeat(32), npubEncode(getPublicKey(generateSecretKey())), nsecEncode(new Uint8Array(32))]) {
      expect(() => connectNsec(input)).toThrow('Invalid NSEC. Paste a valid nsec1 private key, not an npub or a hex key.');
    }
  });
  it('creates a guest identity, restores it, and signs verifiable events without changing the template', async () => {
    const storage = memoryStorage();
    const guest = connectGuest(storage);
    expect(guest.source).toBe('guest');
    expect(connectGuest(storage).pubkey).toBe(guest.pubkey);
    const input = structuredClone(template);
    const signed = await guest.signEvent(input);
    expect(verifyEvent(signed)).toBe(true);
    expect(signed.pubkey).toBe(guest.pubkey);
    expect(input).toEqual(template);
    expect(JSON.stringify(signed)).not.toContain(storage.getItem('nd.nostr.guest.v1'));
  });

  it('forgets guests only when explicitly requested', () => {
    const storage = memoryStorage();
    const first = connectGuest(storage).pubkey;
    forgetGuest(storage);
    expect(connectGuest(storage).pubkey).not.toBe(first);
  });

  it('does not silently replace invalid stored keys or swallow storage failures', () => {
    const storage = memoryStorage();
    storage.setItem('nd.nostr.guest.v1', 'invalid');
    expect(() => connectGuest(storage)).toThrow('saved guest identity is invalid');
    expect(storage.getItem('nd.nostr.guest.v1')).toBe('invalid');
    expect(() => connectGuest({ getItem: () => null, setItem: () => { throw new Error('Storage blocked'); } })).toThrow('Storage blocked');
  });

  it('uses the extension without requesting or storing its private key', async () => {
    const secret = generateSecretKey();
    const pubkey = getPublicKey(secret);
    const identity = await connectExtension({
      getPublicKey: async () => pubkey,
      signEvent: async event => finalizeEvent(event, secret),
    });
    expect(identity.source).toBe('extension');
    expect(identity.exportNsec).toBeUndefined();
    expect(verifyEvent(await identity.signEvent(template))).toBe(true);
  });

  it('surfaces missing signers, rejected permissions, and invalid pubkeys', async () => {
    await expect(connectExtension(undefined)).rejects.toThrow('No NIP-07 signer');
    await expect(connectExtension({
      getPublicKey: async () => { throw new Error('Permission denied'); },
      signEvent: async () => { throw new Error('Unexpected signing'); },
    })).rejects.toThrow('Permission denied');
    await expect(connectExtension({
      getPublicKey: async () => 'bad',
      signEvent: async () => { throw new Error('Unexpected signing'); },
    })).rejects.toThrow('invalid public key');
  });

  it('rejects valid signatures on changed messages or from a different identity', async () => {
    const secret = generateSecretKey();
    for (const signEvent of [
      async (event: EventTemplate) => finalizeEvent({ ...event, content: 'changed' }, secret),
      async (event: EventTemplate) => finalizeEvent(event, generateSecretKey()),
    ]) {
      const identity = await connectExtension({ getPublicKey: async () => getPublicKey(secret), signEvent });
      await expect(identity.signEvent(template)).rejects.toThrow('invalid or modified event');
    }
  });

  it('rejects invalid signatures', async () => {
    const secret = generateSecretKey();
    const identity = await connectExtension({
      getPublicKey: async () => getPublicKey(secret),
      signEvent: async event => ({ ...finalizeEvent(event, secret), sig: '0'.repeat(128) }),
    });
    await expect(identity.signEvent(template)).rejects.toThrow();
  });
});
