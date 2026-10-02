import { describe, expect, it } from 'vitest';
import { CalculatorHistory, CALCULATOR_HISTORY_LIMITS } from './history';
import { MemoryCalculatorHistoryStorage } from './storage';
import type { CalculatorHistoryInput } from './types';

const input: CalculatorHistoryInput = {
  expression: 'x=4',
  visibleResult: '4',
  numberMode: 'decimal',
  angleMode: 'degrees',
};

const SCOPE = 'page:security-test' as const;

describe('CalculatorHistory security boundaries', () => {
  it('rejects oversized strings, null characters, invalid modes, and raised limits', async () => {
    const history = new CalculatorHistory({
      scopeId: SCOPE,
      storage: new MemoryCalculatorHistoryStorage(),
      createId: () => 'entry',
      now: () => '2026-08-03T10:00:00.000Z',
    });
    await expect(history.add({
      ...input,
      expression: 'x'.repeat(CALCULATOR_HISTORY_LIMITS.maxExpressionBytes + 1),
    })).rejects.toThrow(/bounded string/);
    await expect(history.add({ ...input, visibleResult: '4\0secret' })).rejects.toThrow(/null/);
    await expect(history.add({ ...input, angleMode: 'gradians' } as unknown as CalculatorHistoryInput))
      .rejects.toThrow(/angle mode/);
    expect(() => new CalculatorHistory({
      scopeId: SCOPE,
      limits: { maxEntries: CALCULATOR_HISTORY_LIMITS.maxEntries + 1 },
    })).toThrow(/limit maxEntries/);
  });

  it('rejects raw strokes, provider metadata, endpoints, keys, and unknown stored fields', async () => {
    for (const forbidden of ['rawStrokes', 'provider', 'endpoint', 'apiKey', 'token']) {
      const history = new CalculatorHistory({
        scopeId: SCOPE,
        storage: new MemoryCalculatorHistoryStorage(),
        createId: () => 'entry',
        now: () => '2026-08-03T10:00:00.000Z',
      });
      await expect(history.add({ ...input, [forbidden]: 'secret' } as unknown as CalculatorHistoryInput))
        .rejects.toThrow(/unsupported fields/);
    }

    const stored = { ...input, id: 'entry', createdAt: '2026-08-03T10:00:00.000Z', token: 'secret' };
    const history = new CalculatorHistory({
      scopeId: SCOPE,
      storage: new MemoryCalculatorHistoryStorage({ [SCOPE]: [stored] }),
    });
    await expect(history.list()).rejects.toThrow(/unsupported fields/);
  });

  it('fails closed for duplicate IDs, excessive counts, bytes, and malformed timestamps', async () => {
    const valid = { ...input, id: 'same', createdAt: '2026-08-03T10:00:00.000Z' };
    await expect(new CalculatorHistory({
      scopeId: SCOPE,
      storage: new MemoryCalculatorHistoryStorage({ [SCOPE]: [valid, valid] }),
    }).list()).rejects.toThrow(/duplicate IDs/);
    await expect(new CalculatorHistory({
      scopeId: SCOPE,
      storage: new MemoryCalculatorHistoryStorage({ [SCOPE]: [valid, { ...valid, id: 'second' }] }),
      limits: { maxEntries: 1 },
    }).list()).rejects.toThrow(/count limit/);
    await expect(new CalculatorHistory({
      scopeId: SCOPE,
      storage: new MemoryCalculatorHistoryStorage({ [SCOPE]: [{ ...valid, createdAt: 'yesterday' }] }),
    }).list()).rejects.toThrow(/timestamp/);
    await expect(new CalculatorHistory({
      scopeId: SCOPE,
      storage: new MemoryCalculatorHistoryStorage({ [SCOPE]: [valid] }),
      limits: { maxTotalBytes: 10 },
    }).list()).rejects.toThrow(/byte limit/);
  });

  it('never serializes forbidden content into the local record', async () => {
    const storage = new MemoryCalculatorHistoryStorage();
    const history = new CalculatorHistory({
      scopeId: SCOPE,
      storage,
      createId: () => 'entry',
      now: () => '2026-08-03T10:00:00.000Z',
    });
    await history.add(input);
    const serialized = JSON.stringify(await storage.read(SCOPE));
    expect(serialized).not.toMatch(/rawStroke|provider|endpoint|apiKey|token|workspace|notebook|pageId/i);
    expect(JSON.parse(serialized)[0]).toEqual({
      ...input,
      id: 'entry',
      createdAt: '2026-08-03T10:00:00.000Z',
    });
  });

  it('requires a bounded page/notebook scope', () => {
    expect(() => new CalculatorHistory({ scopeId: '' as 'page:' })).toThrow(/scopeId/);
    expect(() => new CalculatorHistory({ scopeId: 'workspace:global' as 'page:global' })).toThrow(/scopeId/);
    expect(() => new CalculatorHistory({ scopeId: `page:${'x'.repeat(600)}` })).toThrow(/scopeId/);
  });
});
