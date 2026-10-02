import { describe, expect, it } from 'vitest';
import { de, en } from './catalog';
import {
  catalogKeyDifference,
  interpolate,
  isLanguage,
  translate,
  translatePlural,
} from './core';
import {
  DEFAULT_LANGUAGE,
  LANGUAGE_STORAGE_KEY,
  languageFromBrowser,
  loadLanguagePreference,
  saveLanguagePreference,
} from './preference';

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(initial));
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
}

describe('Canvink i18n', () => {
  it('keeps the German and English catalogs complete with no missing keys', () => {
    expect(catalogKeyDifference(de, en)).toEqual({ missing: [], extra: [] });
    expect(catalogKeyDifference(en, de)).toEqual({ missing: [], extra: [] });
    expect(Object.values(de).every((message) => message.trim().length > 0)).toBe(true);
    expect(Object.values(en).every((message) => message.trim().length > 0)).toBe(true);
  });

  it('writes German in the Swiss standard: no sharp s', () => {
    const withSharpS = Object.entries(de).filter(([, message]) => message.includes('ß')).map(([key]) => key);
    expect(withSharpS).toEqual([]);
  });

  it('interpolates known parameters and leaves malformed templates visible', () => {
    expect(interpolate('Hallo {name}, {count} Seiten', { name: 'Ada', count: 2 }))
      .toBe('Hallo Ada, 2 Seiten');
    expect(interpolate('Fehlt: {value}')).toBe('Fehlt: {value}');
    expect(translate('de', 'workspace.recovery.code', { code: 'ABC-123' }))
      .toBe('Wiederherstellungscode: ABC-123');
  });

  it('uses locale plural rules and injects the count', () => {
    const keys = { one: 'common.count.one', other: 'common.count.other' } as const;
    expect(translatePlural('de', 1, keys)).toBe('1 Eintrag');
    expect(translatePlural('de', 0, keys)).toBe('0 Einträge');
    expect(translatePlural('en', 2, keys)).toBe('2 items');
  });

  it('defaults to German and persists only supported local choices', () => {
    expect(DEFAULT_LANGUAGE).toBe('de');
    expect(isLanguage('de')).toBe(true);
    expect(isLanguage('fr')).toBe(false);

    const storage = memoryStorage();
    expect(loadLanguagePreference(storage)).toBe('de');
    saveLanguagePreference('en', storage);
    expect(storage.getItem(LANGUAGE_STORAGE_KEY)).toBe('en');
    expect(loadLanguagePreference(storage)).toBe('en');
    storage.setItem(LANGUAGE_STORAGE_KEY, 'fr');
    expect(loadLanguagePreference(storage)).toBe('de');
  });

  it('picks German for de* browsers and English for everything else', () => {
    expect(languageFromBrowser(['de-CH', 'en'])).toBe('de');
    expect(languageFromBrowser(['DE'])).toBe('de');
    expect(languageFromBrowser(['en-US', 'de'])).toBe('en');
    expect(languageFromBrowser(['fr-FR'])).toBe('en');
    expect(languageFromBrowser([])).toBe(DEFAULT_LANGUAGE);
    const storage = memoryStorage();
    expect(loadLanguagePreference(storage, 'en')).toBe('en');
    saveLanguagePreference('de', storage);
    expect(loadLanguagePreference(storage, 'en')).toBe('de');
  });

  it('fails safely when local storage cannot be read or written', () => {
    const storage = memoryStorage();
    storage.getItem = () => { throw new DOMException('blocked', 'SecurityError'); };
    expect(loadLanguagePreference(storage)).toBe('de');
    storage.setItem = () => { throw new DOMException('blocked', 'QuotaExceededError'); };
    expect(() => saveLanguagePreference('en', storage)).not.toThrow();
  });
});
