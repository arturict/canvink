import { describe, expect, it } from 'vitest';
import { flushAllInkQueues, InkCommitQueue, queuedInkStrokes, subscribePendingInk, type InkCommitClock } from './inkCommitQueue';

/** A clock the test moves by hand. */
function manualClock() {
  let time = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  let next = 1;
  const clock: InkCommitClock = {
    now: () => time,
    setTimer: (callback, delay) => {
      const handle = next;
      next += 1;
      timers.set(handle, { at: time + delay, callback });
      return handle;
    },
    clearTimer: (handle) => {
      timers.delete(handle as number);
    },
  };
  const advance = (ms: number) => {
    const target = time + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      time = due[1].at;
      due[1].callback();
    }
    time = target;
  };
  return { clock, advance, pending: () => timers.size };
}

describe('InkCommitQueue', () => {
  it('writes nothing at pen-up and everything once the pen has been quiet', () => {
    const { clock, advance } = manualClock();
    const written: string[][] = [];
    const queue = new InkCommitQueue<string>({ commit: (items) => written.push([...items]), isBusy: () => false, clock });
    queue.enqueue('a');
    expect(written).toEqual([]);
    advance(100);
    queue.enqueue('b');
    advance(179);
    expect(written).toEqual([]);
    advance(2);
    expect(written).toEqual([['a', 'b']]);
  });

  it('never writes while the pen is down, and writes soon after it lifts', () => {
    const { clock, advance } = manualClock();
    let down = false;
    const written: string[][] = [];
    const queue = new InkCommitQueue<string>({ commit: (items) => written.push([...items]), isBusy: () => down, clock });
    queue.enqueue('a');
    down = true;
    advance(1_000);
    expect(written).toEqual([]);
    down = false;
    queue.noteActivity();
    advance(300);
    expect(written).toEqual([['a']]);
  });

  it('writes a long queue at once instead of holding on to it', () => {
    const { clock, advance } = manualClock();
    const written: number[][] = [];
    const queue = new InkCommitQueue<number>({ commit: (items) => written.push([...items]), isBusy: () => false, maxBatch: 3, clock });
    queue.enqueue(1);
    queue.enqueue(2);
    queue.enqueue(3);
    advance(0);
    expect(written).toEqual([[1, 2, 3]]);
  });

  it('flushes on demand in drawing order and leaves no timer behind', () => {
    const { clock, pending } = manualClock();
    const written: string[][] = [];
    const queue = new InkCommitQueue<string>({ commit: (items) => written.push([...items]), isBusy: () => true, clock });
    queue.enqueue('a');
    queue.enqueue('b');
    queue.flush();
    expect(written).toEqual([['a', 'b']]);
    expect(queue.size).toBe(0);
    expect(pending()).toBe(0);
    queue.flush();
    expect(written).toHaveLength(1);
  });

  it('keeps strokes that are queued while a flush runs for the next write', () => {
    const { clock, advance } = manualClock();
    const written: string[][] = [];
    const queue: InkCommitQueue<string> = new InkCommitQueue<string>({
      commit: (items) => {
        written.push([...items]);
        if (items[0] === 'a') queue.enqueue('late');
      },
      isBusy: () => false,
      clock,
    });
    queue.enqueue('a');
    queue.flush();
    advance(500);
    expect(written).toEqual([['a'], ['late']]);
  });

  it('tells the app what is waiting, and writes it on request, so a reload cannot lose it', () => {
    const { clock } = manualClock();
    const written: string[][] = [];
    const queue = new InkCommitQueue<string>({ commit: (items) => written.push([...items]), isBusy: () => true, clock });
    let announced = 0;
    const stop = subscribePendingInk(() => { announced += 1; });
    queue.enqueue('a');
    expect(queuedInkStrokes()).toBe(1);
    flushAllInkQueues();
    expect(written).toEqual([['a']]);
    expect(queuedInkStrokes()).toBe(0);
    expect(announced).toBe(2);
    stop();
  });
});
