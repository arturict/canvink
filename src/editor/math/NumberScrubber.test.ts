import { describe, expect, it } from 'vitest';
import { createScrubTransaction, scrubValue } from './NumberScrubber';

describe('scrubValue', () => {
  it('uses horizontal pixel increments and clamps bounds', () => {
    expect(scrubValue(10, 16, 0.5, 8)).toBe(11);
    expect(scrubValue(10, -80, 1, 8, 5, 20)).toBe(5);
    expect(scrubValue(10, 160, 1, 8, 5, 20)).toBe(20);
  });

  it('rejects invalid arithmetic inputs', () => {
    expect(() => scrubValue(10, 1, 0)).toThrow();
    expect(() => scrubValue(Number.NaN, 1, 1)).toThrow();
    expect(() => scrubValue(10, 1, 1, -1)).toThrow();
  });
});

describe('scrub transaction', () => {
  it('coalesces transient previews and commits exactly once', () => {
    const frames = new Map<number, FrameRequestCallback>();
    const previews: number[] = [];
    const commits: Array<[number, number]> = [];
    let nextFrame = 1;
    const transaction = createScrubTransaction(
      10,
      (callback) => { const id = nextFrame++; frames.set(id, callback); return id; },
      (id) => { frames.delete(id); },
      { onPreview: (value) => previews.push(value), onCommit: (next, prior) => commits.push([next, prior]) },
    );
    transaction.update(11);
    transaction.update(12);
    expect(frames.size).toBe(1);
    transaction.commit();
    transaction.commit();
    expect(frames.size).toBe(0);
    expect(previews).toEqual([12]);
    expect(commits).toEqual([[12, 10]]);
  });

  it('cancels to the original value without committing', () => {
    const previews: number[] = [];
    const cancelled: number[] = [];
    const transaction = createScrubTransaction(
      4,
      () => 1,
      () => undefined,
      {
        onPreview: (value) => previews.push(value),
        onCommit: () => { throw new Error('must not commit'); },
        onCancel: (value) => cancelled.push(value),
      },
    );
    transaction.update(8);
    transaction.cancel();
    expect(previews).toEqual([4]);
    expect(cancelled).toEqual([4]);
  });
});
