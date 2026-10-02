/**
 * Hands the main thread back to the browser so that input, painting and timers run between the
 * slices of a long job. A job that processes many documents calls `yieldToMain` between them
 * (or `createYieldBudget` to yield only once a slice has used up its time) instead of holding the
 * thread for the whole job: a task of over 50 ms is what makes a click wait.
 */

interface SchedulerWithYield {
  yield?: () => Promise<void>;
}

/** Longest stretch of work between two yields, well inside the 50 ms a task may take before it counts as long. */
export const SLICE_BUDGET_MS = 12;

let channel: MessageChannel | undefined;
const waiting: Array<() => void> = [];

function viaMessageChannel(): Promise<void> {
  return new Promise((resolve) => {
    if (!channel) {
      channel = new MessageChannel();
      channel.port1.onmessage = () => waiting.shift()?.();
    }
    waiting.push(resolve);
    channel.port2.postMessage(undefined);
  });
}

/**
 * Resolves in a new task. `scheduler.yield()` keeps the continuation ahead of other queued tasks
 * where the browser has it; elsewhere a message task does the same without the clamp that nested
 * `setTimeout` calls get.
 */
export function yieldToMain(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: SchedulerWithYield }).scheduler;
  if (typeof scheduler?.yield === 'function') return scheduler.yield();
  if (typeof window !== 'undefined' && typeof MessageChannel === 'function') return viaMessageChannel();
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export interface YieldBudget {
  /** Yields when the current slice has used its budget; cheap to call in a loop. */
  maybeYield(): Promise<void>;
}

export function createYieldBudget(budgetMs: number = SLICE_BUDGET_MS, now: () => number = () => performance.now()): YieldBudget {
  let sliceStart = now();
  return {
    async maybeYield() {
      if (now() - sliceStart < budgetMs) return;
      await yieldToMain();
      sliceStart = now();
    },
  };
}

/**
 * Resolves once the browser has idle time, or after `timeoutMs` at the latest, and never sooner
 * than `minDelayMs`. Background work that should not compete with the user (downloading the rest
 * of the account) waits between its steps like this, so a click or a pen stroke is served first.
 */
export function whenIdle(timeoutMs: number, minDelayMs = 0): Promise<void> {
  return new Promise((resolve) => {
    const wait = (): void => {
      const idle = (globalThis as { requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number }).requestIdleCallback;
      if (typeof idle === 'function') idle(() => resolve(), { timeout: timeoutMs });
      else setTimeout(resolve, Math.min(timeoutMs, 50));
    };
    if (minDelayMs > 0) setTimeout(wait, minDelayMs);
    else wait();
  });
}
