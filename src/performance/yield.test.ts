import { afterEach, describe, expect, it, vi } from 'vitest';
import { createYieldBudget, whenIdle, yieldToMain } from './yield';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('yieldToMain', () => {
  it('lets other tasks run before the awaiting code continues', async () => {
    const order: string[] = [];
    setTimeout(() => order.push('task'), 0);
    await yieldToMain();
    order.push('continued');
    // The timer task queued before the yield ran first, so the yield did hand the thread back.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(order).toEqual(['task', 'continued']);
  });

  it('uses scheduler.yield where the browser has it', async () => {
    const yielded = vi.fn(() => Promise.resolve());
    vi.stubGlobal('scheduler', { yield: yielded });
    await yieldToMain();
    expect(yielded).toHaveBeenCalledOnce();
  });
});

describe('createYieldBudget', () => {
  it('yields only once a slice has used up its budget, and starts a new slice afterwards', async () => {
    let clock = 0;
    const yielded = vi.fn(() => Promise.resolve());
    vi.stubGlobal('scheduler', { yield: yielded });
    const budget = createYieldBudget(12, () => clock);
    await budget.maybeYield();
    clock = 11;
    await budget.maybeYield();
    expect(yielded).not.toHaveBeenCalled();
    clock = 12;
    await budget.maybeYield();
    expect(yielded).toHaveBeenCalledTimes(1);
    clock = 20;
    await budget.maybeYield();
    expect(yielded).toHaveBeenCalledTimes(1);
    clock = 24;
    await budget.maybeYield();
    expect(yielded).toHaveBeenCalledTimes(2);
  });
});

describe('whenIdle', () => {
  it('waits for the browser to be idle, after the minimum delay', async () => {
    vi.useFakeTimers();
    const idle = vi.fn((callback: () => void) => { setTimeout(callback, 100); return 1; });
    vi.stubGlobal('requestIdleCallback', idle);
    let done = false;
    void whenIdle(400, 40).then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(39);
    expect(idle).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(idle).toHaveBeenCalledWith(expect.any(Function), { timeout: 400 });
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(done).toBe(true);
  });

  it('falls back to a short timer without requestIdleCallback', async () => {
    vi.useFakeTimers();
    let done = false;
    void whenIdle(400).then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(50);
    expect(done).toBe(true);
  });
});
