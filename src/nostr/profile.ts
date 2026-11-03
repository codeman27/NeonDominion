import { isHex32 } from '../crypto/hashChain';
import { sha256Hex } from '../crypto/prng';

const ADJECTIVES = ['Neon', 'Chrome', 'Cosmic', 'Solar', 'Silent', 'Electric', 'Lunar', 'Crimson', 'Arctic', 'Golden', 'Iron', 'Silver', 'Violet', 'Quantum', 'Emerald', 'Radiant'];
const NOUNS = ['Falcon', 'Fox', 'Raven', 'Wolf', 'Tiger', 'Comet', 'Phoenix', 'Lynx', 'Dragon', 'Panther', 'Owl', 'Viper', 'Orion', 'Puma', 'Hawk', 'Nova'];
export const MAX_DISPLAY_NAME_LENGTH = 32;

export function commanderLabel(pubkey: string, gameName: string, account?: { pubkey: string; name: string }): string {
  return account?.pubkey === pubkey ? account.name : gameName;
}

function profileKey(pubkey: string): string {
  if (!isHex32(pubkey)) throw new Error('Invalid public identity for commander name.');
  return `nd.nostr.name.v1.${pubkey}`;
}

/** Hash the entire public key, not the shared npub prefix. Names are labels, not unique IDs. */
export function generatedName(pubkey: string): string {
  profileKey(pubkey);
  const hash = sha256Hex(`neon-dominion-name-v1:${pubkey}`);
  return `${ADJECTIVES[parseInt(hash.slice(0, 1), 16)]} ${NOUNS[parseInt(hash.slice(1, 2), 16)]} ${parseInt(hash.slice(2, 6), 16).toString().padStart(5, '0')}`;
}

export function normalizeDisplayName(value: string): string {
  const name = value.trim().replace(/\s+/gu, ' ');
  if (!name || [...name].length > MAX_DISPLAY_NAME_LENGTH || /[\p{Cc}\p{Cf}]/u.test(name)) {
    throw new Error(`Use 1–${MAX_DISPLAY_NAME_LENGTH} visible characters for your commander name.`);
  }
  return name;
}

export function loadDisplayName(pubkey: string, storage: Pick<Storage, 'getItem'>): string {
  const saved = storage.getItem(profileKey(pubkey));
  return saved === null ? generatedName(pubkey) : normalizeDisplayName(saved);
}

export function saveDisplayName(pubkey: string, name: string, storage: Pick<Storage, 'setItem'>): string {
  const normalized = normalizeDisplayName(name);
  storage.setItem(profileKey(pubkey), normalized);
  return normalized;
}

export function resetDisplayName(pubkey: string, storage: Pick<Storage, 'removeItem'>): string {
  storage.removeItem(profileKey(pubkey));
  return generatedName(pubkey);
}
