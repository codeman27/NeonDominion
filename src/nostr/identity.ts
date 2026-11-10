import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent, type Event, type EventTemplate } from 'nostr-tools/pure';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { isHex32 } from '../crypto/hashChain';
import { decode, nsecEncode } from 'nostr-tools/nip19';

const GUEST_KEY = 'nd.nostr.guest.v1';
const LOGIN_KEY = 'nd.nostr.login.v1';
const NSEC_KEY = 'nd.nostr.nsec.v1';

export interface NostrExtension {
  getPublicKey(): Promise<string>;
  signEvent(event: EventTemplate): Promise<Event>;
}

export interface NostrIdentity {
  readonly pubkey: string;
  readonly source: 'extension' | 'guest' | 'nsec';
  signEvent(event: EventTemplate): Promise<Event>;
  exportNsec?(): string;
}

export function browserExtension(): NostrExtension | undefined {
  const provider: unknown = Reflect.get(window, 'nostr');
  if (typeof provider !== 'object' || provider === null
    || !('getPublicKey' in provider) || typeof provider.getPublicKey !== 'function'
    || !('signEvent' in provider) || typeof provider.signEvent !== 'function') return undefined;
  return provider as NostrExtension;
}

function assertPubkey(pubkey: string): void {
  if (!isHex32(pubkey)) throw new Error('The Nostr signer returned an invalid public key.');
}

/** Never accept a signer changing the message or identity that the game asked it to sign. */
async function signChecked(identity: string, template: EventTemplate, sign: (event: EventTemplate) => Promise<Event>): Promise<Event> {
  const requested = structuredClone(template);
  const response = await sign(structuredClone(requested));
  // Strip library verification-cache symbols so signatures are always checked afresh.
  const signed: Event = {
    id: response.id, pubkey: response.pubkey, sig: response.sig,
    kind: response.kind, created_at: response.created_at, content: response.content,
    tags: response.tags,
  };
  if (signed.pubkey !== identity || signed.kind !== requested.kind
    || signed.created_at !== requested.created_at || signed.content !== requested.content
    || JSON.stringify(signed.tags) !== JSON.stringify(requested.tags)
    || !verifyEvent(signed)) {
    throw new Error('The Nostr signer returned an invalid or modified event.');
  }
  return signed;
}

export async function connectExtension(provider: NostrExtension | undefined): Promise<NostrIdentity> {
  if (!provider) throw new Error('No NIP-07 signer found. Install a Nostr browser signer or use a guest identity.');
  const pubkey = await provider.getPublicKey();
  assertPubkey(pubkey);
  return {
    pubkey,
    source: 'extension',
    signEvent: event => signChecked(pubkey, event, e => provider.signEvent(e)),
  };
}

/** Dedicated low-value game identity. Export happens only through an explicit backup action. */
export function connectGuest(storage: Pick<Storage, 'getItem' | 'setItem'>): NostrIdentity {
  const saved = storage.getItem(GUEST_KEY);
  if (saved !== null && !isHex32(saved)) throw new Error('The saved guest identity is invalid. Clear it explicitly before creating another.');
  const secret = saved === null ? generateSecretKey() : hexToBytes(saved);
  const pubkey = getPublicKey(secret);
  if (saved === null) storage.setItem(GUEST_KEY, bytesToHex(secret));
  return {
    pubkey,
    source: 'guest',
    exportNsec: () => nsecEncode(secret),
    signEvent: event => signChecked(pubkey, event, async e => finalizeEvent(e, secret)),
  };
}

export function forgetGuest(storage: Pick<Storage, 'removeItem'>): void {
  storage.removeItem(GUEST_KEY);
}

export function rememberLogin(source: NostrIdentity['source'] | null, storage: Pick<Storage, 'setItem'>): void {
  storage.setItem(LOGIN_KEY, source ?? 'disconnected');
}

/** Restore only an existing guest, never create a new key or prompt an extension on page load. */
export function restoreGuest(storage: Pick<Storage, 'getItem' | 'setItem'>): NostrIdentity | null {
  const source = storage.getItem(LOGIN_KEY);
  if (source !== null && !['guest', 'extension', 'nsec', 'disconnected'].includes(source)) {
    throw new Error('Invalid saved login preference. Choose a login method to reconnect.');
  }
  if (source !== null && source !== 'guest') return null;
  if (storage.getItem(GUEST_KEY) === null) return null;
  return connectGuest(storage);
}

export function forgetSavedNsec(storage: Pick<Storage, 'removeItem'>): void {
  storage.removeItem(NSEC_KEY);
}

export function loginWithNsec(
  input: string, remember: boolean, storage: Pick<Storage, 'setItem' | 'removeItem'>,
): NostrIdentity {
  const identity = connectNsec(input);
  if (remember) storage.setItem(NSEC_KEY, input.trim());
  else forgetSavedNsec(storage);
  return identity;
}

/** Never prompt a signer or create a key during automatic restoration. */
export function restoreLogin(storage: Pick<Storage, 'getItem' | 'setItem'>): NostrIdentity | null {
  if (storage.getItem(LOGIN_KEY) !== 'nsec') return restoreGuest(storage);
  const saved = storage.getItem(NSEC_KEY);
  if (saved === null) return null;
  return connectNsec(saved);
}

/** Imported keys are kept only in the signing closure, never in browser storage. */
export function connectNsec(input: string): NostrIdentity {
  let secret: Uint8Array;
  let pubkey: string;
  try {
    const decoded = decode(input.trim());
    if (decoded.type !== 'nsec') throw new Error('Wrong key type');
    secret = decoded.data;
    pubkey = getPublicKey(secret);
  } catch {
    // Decoder errors can contain the supplied private key. Never surface those details.
    throw new Error('Invalid NSEC. Paste a valid nsec1 private key, not an npub or a hex key.');
  }
  return {
    pubkey,
    source: 'nsec',
    signEvent: event => signChecked(pubkey, event, async e => finalizeEvent(e, secret)),
  };
}
