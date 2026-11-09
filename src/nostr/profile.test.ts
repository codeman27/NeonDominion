import { describe, expect, it } from 'vitest';
import { commanderLabel, generatedGameName, generatedName, loadDisplayName, normalizeDisplayName, resetDisplayName, saveDisplayName } from './profile';

const first = 'ab'.repeat(32);
const second = 'cd'.repeat(32);

describe('multiplayer game names', () => {
  it('generates stable two-word names without numbers for every viewer', () => {
    expect(generatedGameName(first)).toBe(generatedGameName(first));
    expect(generatedGameName(first)).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
    expect(generatedGameName(first)).not.toBe(generatedGameName(second));
    expect(() => generatedGameName('bad')).toThrow('Invalid game identity');
  });

  it('varies both words across game identities', () => {
    const names = Array.from({ length: 256 }, (_, i) => generatedGameName(i.toString(16).padStart(64, '0')));
    expect(new Set(names.map(name => name.split(' ')[0])).size).toBe(16);
    expect(new Set(names.map(name => name.split(' ')[1])).size).toBe(16);
    expect(new Set(names).size).toBeGreaterThan(100);
  });
});

describe('commander names', () => {
  it('uses the saved account label only for that identity without rewriting game names', () => {
    const account = { pubkey: first, name: 'Chrome Hawk' };
    expect(commanderLabel(first, 'Chrome Hawk 27367', account)).toBe('Chrome Hawk');
    expect(commanderLabel(second, 'Crimson Comet', account)).toBe('Crimson Comet');
    expect(commanderLabel(first, 'Chrome Hawk 27367')).toBe('Chrome Hawk 27367');
  });
  it('generates stable human-readable names from the full public key', () => {
    expect(generatedName(first)).toBe(generatedName(first));
    expect(generatedName(first)).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+ \d{5}$/);
    expect(generatedName(first)).not.toBe(generatedName(second));
    expect(() => generatedName('bad')).toThrow('Invalid public identity');
  });

  it('saves overrides per identity and resets to the generated name', () => {
    const data = new Map<string, string>();
    const storage = {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => { data.set(key, value); },
      removeItem: (key: string) => { data.delete(key); },
    };
    expect(loadDisplayName(first, storage)).toBe(generatedName(first));
    expect(saveDisplayName(first, '  Captain   Cody  ', storage)).toBe('Captain Cody');
    expect(loadDisplayName(first, storage)).toBe('Captain Cody');
    expect(loadDisplayName(second, storage)).toBe(generatedName(second));
    expect(resetDisplayName(first, storage)).toBe(generatedName(first));
    expect(loadDisplayName(first, storage)).toBe(generatedName(first));
  });

  it('validates names and supports Unicode', () => {
    expect(normalizeDisplayName('Étoile 星')).toBe('Étoile 星');
    expect(normalizeDisplayName('a'.repeat(32))).toHaveLength(32);
    for (const name of ['', '   ', 'a'.repeat(33), 'Captain\u0000', 'Captain\u202e']) {
      expect(() => normalizeDisplayName(name)).toThrow('visible characters');
    }
  });

  it('surfaces storage failures rather than pretending a name was saved', () => {
    expect(() => saveDisplayName(first, 'Cody', { setItem: () => { throw new Error('Storage blocked'); } })).toThrow('Storage blocked');
    expect(() => loadDisplayName(first, { getItem: () => '' })).toThrow('visible characters');
  });
});
