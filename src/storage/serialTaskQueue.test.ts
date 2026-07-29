import { describe, expect, it } from 'vitest';
import { SerialTaskQueue } from './serialTaskQueue';

describe('SerialTaskQueue', () => {
  it('never starts a newer save before the older save settles', async () => {
    const queue = new SerialTaskQueue();
    const events: string[] = [];
    let finishFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });

    const first = queue.enqueue(async () => {
      events.push('first:start');
      await firstGate;
      events.push('first:end');
      return 1;
    });
    const second = queue.enqueue(async () => {
      events.push('second:start');
      events.push('second:end');
      return 2;
    });

    await Promise.resolve();
    expect(events).toEqual(['first:start']);

    finishFirst?.();
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    expect(events).toEqual([
      'first:start',
      'first:end',
      'second:start',
      'second:end',
    ]);
  });

  it('continues after a failed task', async () => {
    const queue = new SerialTaskQueue();
    const first = queue.enqueue(async () => {
      throw new Error('save failed');
    });
    const second = queue.enqueue(async () => 'saved');

    await expect(first).rejects.toThrow('save failed');
    await expect(second).resolves.toBe('saved');
  });
});
