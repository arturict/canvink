import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_UI_PREFERENCES,
  loadUiPreferences,
  saveUiPreferences,
  type UiPreferences,
} from './preferences';

const STORAGE_KEY = 'canvink:ui-preferences:v1';

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(initial));

  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key) {
      return values.get(key) ?? null;
    },
    key(index) {
      return [...values.keys()][index] ?? null;
    },
    removeItem(key) {
      values.delete(key);
    },
    setItem(key, value) {
      values.set(key, value);
    },
  };
}

function stubLocalStorage(storage: Storage): void {
  vi.stubGlobal('window', { localStorage: storage });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('UI preferences', () => {
  it('returns safe defaults when local storage is unavailable or empty', () => {
    expect(loadUiPreferences()).toEqual(DEFAULT_UI_PREFERENCES);

    stubLocalStorage(memoryStorage());
    const loaded = loadUiPreferences();
    expect(loaded).toEqual(DEFAULT_UI_PREFERENCES);
    expect(loaded).not.toBe(DEFAULT_UI_PREFERENCES);
  });

  it('loads a valid version 1 preference record', () => {
    stubLocalStorage(
      memoryStorage({
        [STORAGE_KEY]: JSON.stringify({
          schemaVersion: 1,
          guideDismissed: true,
          textSize: 'large',
        }),
      }),
    );

    expect(loadUiPreferences()).toEqual({
      schemaVersion: 1,
      guideDismissed: true,
      textSize: 'large',
    });
  });

  it.each([
    ['malformed JSON', '{'],
    [
      'a newer schema',
      JSON.stringify({ schemaVersion: 2, guideDismissed: true, textSize: 'large' }),
    ],
    [
      'an invalid guide flag',
      JSON.stringify({ schemaVersion: 1, guideDismissed: 'yes', textSize: 'large' }),
    ],
    [
      'an invalid text size',
      JSON.stringify({ schemaVersion: 1, guideDismissed: false, textSize: 'huge' }),
    ],
  ])('falls back safely for %s', (_label, stored) => {
    stubLocalStorage(memoryStorage({ [STORAGE_KEY]: stored }));
    expect(loadUiPreferences()).toEqual(DEFAULT_UI_PREFERENCES);
  });

  it('falls back safely when reading local storage throws', () => {
    const storage = memoryStorage();
    storage.getItem = () => {
      throw new DOMException('blocked', 'SecurityError');
    };
    stubLocalStorage(storage);

    expect(() => loadUiPreferences()).not.toThrow();
    expect(loadUiPreferences()).toEqual(DEFAULT_UI_PREFERENCES);
  });

  it('writes only the strict version 1 shape', () => {
    const storage = memoryStorage();
    stubLocalStorage(storage);

    saveUiPreferences({
      schemaVersion: 1,
      guideDismissed: true,
      textSize: 'large',
      unexpected: 'discard me',
    } as UiPreferences & { unexpected: string });

    expect(JSON.parse(storage.getItem(STORAGE_KEY) ?? '')).toEqual({
      schemaVersion: 1,
      guideDismissed: true,
      textSize: 'large',
    });
  });

  it('does not throw or overwrite stored data for invalid input or write failures', () => {
    const storage = memoryStorage({ [STORAGE_KEY]: 'preserve-me' });
    stubLocalStorage(storage);

    expect(() =>
      saveUiPreferences({
        schemaVersion: 1,
        guideDismissed: false,
        textSize: 'huge',
      } as unknown as UiPreferences),
    ).not.toThrow();
    expect(storage.getItem(STORAGE_KEY)).toBe('preserve-me');

    storage.setItem = () => {
      throw new DOMException('blocked', 'QuotaExceededError');
    };
    expect(() => saveUiPreferences(DEFAULT_UI_PREFERENCES)).not.toThrow();
  });
});
