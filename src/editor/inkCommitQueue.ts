/**
 * Strokes the pen has lifted from but that are not written to the page yet.
 *
 * Writing a stroke means an Automerge change, a React render of the notebook
 * and a repaint of the ink tile. That takes tens of milliseconds on a laptop
 * and used to run inside the pointer-up handler, right before the pen came
 * down again for the next letter: the first samples of every stroke of quick
 * handwriting waited for it. The stroke is on screen (the overlay holds it)
 * the moment the pen lifts; the write waits for a quiet moment and then takes
 * all strokes that gathered in one go.
 *
 * Whatever reads or changes the page flushes the queue first (see
 * LiveCanvasEditor), so the page never shows less than was drawn.
 */
export interface InkCommitClock {
  now(): number;
  setTimer(callback: () => void, delayMs: number): unknown;
  clearTimer(handle: unknown): void;
}

export interface InkCommitQueueOptions<T> {
  /** Writes the strokes, oldest first. Called with at least one. */
  commit: (items: readonly T[]) => void;
  /** True while the pen is on the glass; nothing is written then. */
  isBusy: () => boolean;
  /** How long the pen must have been idle, both up and not drawing, before the write. */
  quietMs?: number;
  /** A queue this long is written at the next pen-up, quiet or not. */
  maxBatch?: number;
  clock?: InkCommitClock;
}

const DEFAULT_QUIET_MS = 180;
const DEFAULT_MAX_BATCH = 16;
/** How often a pen that is still down is looked at again. */
const BUSY_POLL_MS = 60;

const realClock: InkCommitClock = {
  now: () => performance.now(),
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Queues that hold strokes, so the app around the editor can write them
 * before it closes or reloads and can tell that it is not saved yet.
 */
const holding = new Set<InkCommitQueue<unknown>>();
const listeners = new Set<() => void>();

function announce(): void {
  for (const listener of [...listeners]) listener();
}

/** Strokes drawn and shown but not written to their page yet, over all editors. */
export function queuedInkStrokes(): number {
  let total = 0;
  for (const queue of holding) total += queue.size;
  return total;
}

export function subscribePendingInk(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const leaveHooks = new Set<() => void>();

/**
 * An editor's say in what happens when the page is closed or reloaded: it
 * gets to put what the asynchronous page write might not finish somewhere
 * synchronous. Returns the function that removes the hook.
 */
export function onInkLeave(hook: () => void): () => void {
  leaveHooks.add(hook);
  return () => {
    leaveHooks.delete(hook);
  };
}

/**
 * The page is being closed or hidden: lets every editor stash its recent
 * strokes, then writes every waiting stroke. The caller persists the page
 * afterwards.
 */
export function flushAllInkQueues(): void {
  for (const hook of [...leaveHooks]) hook();
  for (const queue of [...holding]) queue.flush();
}

export class InkCommitQueue<T> {
  private commit: (items: readonly T[]) => void;
  private isBusy: () => boolean;
  private quietMs: number;
  private readonly maxBatch: number;
  private readonly clock: InkCommitClock;
  private items: T[] = [];
  private timer: unknown = null;
  private lastActivity = Number.NEGATIVE_INFINITY;

  constructor(options: InkCommitQueueOptions<T>) {
    this.commit = options.commit;
    this.isBusy = options.isBusy;
    this.quietMs = options.quietMs ?? DEFAULT_QUIET_MS;
    this.maxBatch = options.maxBatch ?? DEFAULT_MAX_BATCH;
    this.clock = options.clock ?? realClock;
  }

  /** Points the queue at the current page's write and at the current state of the pen. */
  bind(handlers: Pick<InkCommitQueueOptions<T>, 'commit' | 'isBusy'>): void {
    this.commit = handlers.commit;
    this.isBusy = handlers.isBusy;
  }

  /** The right value depends on whether others watch the page, which can change. */
  setQuietMs(ms: number): void {
    this.quietMs = ms;
  }

  /** The strokes still waiting, oldest first. */
  waiting(): readonly T[] {
    return this.items;
  }

  get size(): number {
    return this.items.length;
  }

  /** The pen touched down or lifted: the quiet period starts over. */
  noteActivity(): void {
    this.lastActivity = this.clock.now();
  }

  enqueue(item: T): void {
    this.items.push(item);
    holding.add(this as InkCommitQueue<unknown>);
    announce();
    this.noteActivity();
    this.arm(this.items.length >= this.maxBatch ? 0 : this.quietMs);
  }

  /** Writes everything queued now, whatever the pen is doing. */
  flush(): void {
    this.disarm();
    if (this.items.length === 0) return;
    const batch = this.items;
    this.items = [];
    holding.delete(this as InkCommitQueue<unknown>);
    try {
      this.commit(batch);
    } finally {
      announce();
    }
  }

  dispose(): void {
    this.disarm();
    holding.delete(this as InkCommitQueue<unknown>);
  }

  private disarm(): void {
    if (this.timer === null) return;
    this.clock.clearTimer(this.timer);
    this.timer = null;
  }

  private arm(delayMs: number): void {
    this.disarm();
    this.timer = this.clock.setTimer(() => {
      this.timer = null;
      if (this.items.length === 0) return;
      if (this.isBusy()) {
        this.arm(BUSY_POLL_MS);
        return;
      }
      const idleFor = this.clock.now() - this.lastActivity;
      if (idleFor < this.quietMs && this.items.length < this.maxBatch) {
        this.arm(this.quietMs - idleFor);
        return;
      }
      this.flush();
    }, delayMs);
  }
}
