import { describe, expect, it } from 'vitest';
import { CalculatorHistory } from './history';
import { MemoryCalculatorHistoryStorage } from './storage';
import type { CalculatorHistoryInput, CalculatorHistoryStorage } from './types';

const exactInput: CalculatorHistoryInput = {
  expression: '\\frac{1}{3}',
  visibleResult: '1/3',
  numberMode: 'exact',
  angleMode: 'radians',
};

const SCOPE = 'page:math-history-test' as const;

function ids(...values: string[]): () => string {
  let index = 0;
  return () => values[index++] ?? `generated-${index}`;
}

describe('CalculatorHistory', () => {
  it('adds and lists entries in deterministic newest-first order', async () => {
    const timestamps = [
      '2026-08-03T10:00:00.000Z',
      '2026-08-03T11:00:00.000Z',
      '2026-08-03T11:00:00.000Z',
    ];
    const history = new CalculatorHistory({
      scopeId: SCOPE,
      storage: new MemoryCalculatorHistoryStorage(),
      createId: ids('a', 'z', 'b'),
      now: () => timestamps.shift() as string,
    });

    await history.add(exactInput);
    await history.add({ ...exactInput, expression: '2+2', visibleResult: '4' });
    await history.add({ ...exactInput, expression: '3+3', visibleResult: '6' });

    expect((await history.list()).map((entry) => entry.id)).toEqual(['b', 'z', 'a']);
  });

  it('serializes concurrent additions and prunes the oldest count atomically', async () => {
    const history = new CalculatorHistory({
      scopeId: SCOPE,
      storage: new MemoryCalculatorHistoryStorage(),
      createId: ids('one', 'two', 'three'),
      now: (() => {
        let second = 0;
        return () => `2026-08-03T10:00:0${second++}.000Z`;
      })(),
      limits: { maxEntries: 2 },
    });

    await Promise.all([
      history.add({ ...exactInput, expression: '1' }),
      history.add({ ...exactInput, expression: '2' }),
      history.add({ ...exactInput, expression: '3' }),
    ]);

    expect((await history.list()).map((entry) => entry.expression)).toEqual(['3', '2']);
  });

  it('prunes the oldest entries to the configured total byte budget', async () => {
    const history = new CalculatorHistory({
      scopeId: SCOPE,
      storage: new MemoryCalculatorHistoryStorage(),
      createId: ids('old', 'new'),
      now: (() => {
        const values = ['2026-08-03T10:00:00.000Z', '2026-08-03T11:00:00.000Z'];
        return () => values.shift() as string;
      })(),
      limits: { maxTotalBytes: 180 },
    });
    await history.add({ ...exactInput, expression: 'old-expression' });
    await history.add({ ...exactInput, expression: 'new-expression' });

    expect((await history.list()).map((entry) => entry.id)).toEqual(['new']);
  });

  it('copies only plain text and restores only the bounded calculation input', async () => {
    const history = new CalculatorHistory({
      scopeId: SCOPE,
      storage: new MemoryCalculatorHistoryStorage(),
      createId: () => 'entry',
      now: () => '2026-08-03T10:00:00.000Z',
    });
    await history.add(exactInput);

    await expect(history.copyPayload('entry', 'expression')).resolves.toBe('\\frac{1}{3}');
    await expect(history.copyPayload('entry', 'result')).resolves.toBe('1/3');
    await expect(history.copyPayload('entry')).resolves.toBe('\\frac{1}{3} = 1/3');
    let restored: CalculatorHistoryInput | undefined;
    await history.restore('entry', (input) => { restored = input; });
    expect(restored).toEqual(exactInput);
    expect(Object.keys(restored as unknown as object).sort()).toEqual([
      'angleMode', 'expression', 'numberMode', 'visibleResult',
    ]);
  });

  it('deletes one entry and clears all entries without touching another store', async () => {
    const localStorage = new MemoryCalculatorHistoryStorage();
    const unrelatedStorage = new MemoryCalculatorHistoryStorage({ 'page:unrelated': [{ unrelated: true }] });
    const history = new CalculatorHistory({
      scopeId: SCOPE,
      storage: localStorage,
      createId: ids('first', 'second'),
      now: () => '2026-08-03T10:00:00.000Z',
    });
    await history.add(exactInput);
    await history.add({ ...exactInput, expression: '2+2', visibleResult: '4' });

    await expect(history.delete('missing')).resolves.toBe(false);
    await expect(history.delete('first')).resolves.toBe(true);
    await expect(history.clear()).resolves.toBe(1);
    await expect(history.list()).resolves.toEqual([]);
    await expect(unrelatedStorage.read('page:unrelated')).resolves.toEqual([{ unrelated: true }]);
  });

  it('does not expose a partial mutation when persistence fails', async () => {
    const original = {
      ...exactInput,
      id: 'existing',
      createdAt: '2026-08-03T10:00:00.000Z',
    };
    const storage: CalculatorHistoryStorage = {
      read: async () => [original],
      replace: async () => { throw new Error('storage unavailable'); },
    };
    const history = new CalculatorHistory({
      scopeId: SCOPE,
      storage,
      createId: () => 'new',
      now: () => '2026-08-03T11:00:00.000Z',
    });

    await expect(history.add({ ...exactInput, expression: 'new' })).rejects.toThrow('storage unavailable');
    await expect(history.list()).resolves.toEqual([original]);
  });

  it('leaves history unchanged when a restore callback fails', async () => {
    const history = new CalculatorHistory({
      scopeId: SCOPE,
      storage: new MemoryCalculatorHistoryStorage(),
      createId: () => 'entry',
      now: () => '2026-08-03T10:00:00.000Z',
    });
    await history.add(exactInput);
    await expect(history.restore('entry', async () => {
      throw new Error('editor rejected restore');
    })).rejects.toThrow('editor rejected restore');
    await expect(history.list()).resolves.toHaveLength(1);
  });

  it('keeps page and notebook scopes isolated in a shared storage backend', async () => {
    const storage = new MemoryCalculatorHistoryStorage();
    const page = new CalculatorHistory({
      scopeId: 'page:algebra', storage, createId: () => 'page-entry',
      now: () => '2026-08-03T10:00:00.000Z',
    });
    const notebook = new CalculatorHistory({
      scopeId: 'notebook:school', storage, createId: () => 'notebook-entry',
      now: () => '2026-08-03T10:00:00.000Z',
    });
    await page.add(exactInput);
    await notebook.add({ ...exactInput, expression: 'notebook-only' });

    expect((await page.list()).map((entry) => entry.expression)).toEqual([exactInput.expression]);
    expect((await notebook.list()).map((entry) => entry.expression)).toEqual(['notebook-only']);
    await page.clear();
    await expect(notebook.list()).resolves.toHaveLength(1);
  });
});
