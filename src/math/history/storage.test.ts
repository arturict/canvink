import { describe, expect, it } from 'vitest';
import {
  FallbackCalculatorHistoryStorage,
  MemoryCalculatorHistoryStorage,
  calculatorHistoryStorageKey,
} from './storage';
import type { CalculatorHistoryEntry, CalculatorHistoryStorage } from './types';

const entry: CalculatorHistoryEntry = {
  id: 'entry',
  expression: '2+2',
  visibleResult: '4',
  numberMode: 'exact',
  angleMode: 'radians',
  createdAt: '2026-08-03T10:00:00.000Z',
};

const SCOPE = 'page:storage-test' as const;

describe('calculator history storage', () => {
  it('clones memory reads and writes', async () => {
    const storage = new MemoryCalculatorHistoryStorage({ [SCOPE]: [entry] });
    const first = await storage.read(SCOPE) as CalculatorHistoryEntry[];
    first[0].expression = 'mutated';
    expect(await storage.read(SCOPE)).toEqual([entry]);
  });

  it('falls back permanently when IndexedDB-style reads fail', async () => {
    let primaryReads = 0;
    const primary: CalculatorHistoryStorage = {
      read: async () => { primaryReads += 1; throw new Error('IDB blocked'); },
      replace: async () => { throw new Error('must not retry'); },
    };
    const fallback = new MemoryCalculatorHistoryStorage({ [SCOPE]: [entry] });
    const storage = new FallbackCalculatorHistoryStorage(primary, fallback);

    await expect(storage.read(SCOPE)).resolves.toEqual([entry]);
    await storage.replace(SCOPE, []);
    await expect(storage.read(SCOPE)).resolves.toEqual([]);
    expect(primaryReads).toBe(1);
  });

  it('writes the complete replacement to memory after a primary write failure', async () => {
    const primary: CalculatorHistoryStorage = {
      read: async () => [],
      replace: async () => { throw new Error('quota'); },
    };
    const fallback = new MemoryCalculatorHistoryStorage();
    const storage = new FallbackCalculatorHistoryStorage(primary, fallback);

    await storage.replace(SCOPE, [entry]);
    await expect(storage.read(SCOPE)).resolves.toEqual([entry]);
  });

  it('uses collision-free scoped keys and never reads the legacy global key', () => {
    expect(calculatorHistoryStorageKey('page:a')).not.toBe(calculatorHistoryStorageKey('notebook:a'));
    expect(calculatorHistoryStorageKey('page:a')).not.toBe('entries-v1');
  });
});
