import { afterEach, describe, expect, it } from 'vitest';
import { loadOfflineCopiesPolicy, saveOfflineCopiesPolicy } from './offlinePolicy';

function stubStorage(): Map<string, string> {
  const values = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  return values;
}

afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe('offline copies policy', () => {
  it('keeps every page unless the device was told to keep only opened ones', () => {
    stubStorage();
    expect(loadOfflineCopiesPolicy()).toBe('all');
    saveOfflineCopiesPolicy('opened');
    expect(loadOfflineCopiesPolicy()).toBe('opened');
    saveOfflineCopiesPolicy('all');
    expect(loadOfflineCopiesPolicy()).toBe('all');
  });

  it('falls back to all pages when storage is unavailable', () => {
    expect(loadOfflineCopiesPolicy()).toBe('all');
    expect(() => saveOfflineCopiesPolicy('opened')).not.toThrow();
  });
});
