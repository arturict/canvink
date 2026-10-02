import { INK_SEGMENT_MIME_TYPE } from '../../storage/pageIndex';
import type { InkSegmentStore, SegmentRemote } from '../../ink/segmentStore';
import type { AssetSyncHttpPort } from './assetSyncQueue';

/**
 * Ink segments travel between devices like assets: content-addressed blobs in
 * the personal space's R2 prefix, reached through the same `HEAD`, `PUT` and
 * `GET /me/assets/<sha256>` routes (which check the hash server-side), so the
 * Worker needs no change.
 *
 * - Upload: every segment this device wrote is queued in its local store until
 *   the cloud holds it. The queue survives restarts; a failing upload is
 *   retried with a growing delay. A segment that is already in the cloud
 *   (`HEAD`) is not sent again, which is what deduplicates two devices that
 *   sealed identical ink.
 * - Download: a page that references a segment this device lacks fetches it on
 *   demand through `remote`, at most a few at a time.
 */
export interface InkSegmentSyncOptions {
  http: AssetSyncHttpPort;
  store: InkSegmentStore;
  maxConcurrentDownloads?: number;
  maxConcurrentUploads?: number;
  /** Pause between passes over the upload queue while it is not empty. */
  passDelayMs?: number;
  setTimeout?: (callback: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

export interface InkSegmentSync {
  /** Starts uploading what is queued and answers fetches for the store. */
  start(): void;
  stop(): void;
  /** Runs one pass over the upload queue and resolves when it is done (tests, "sync now"). */
  drain(): Promise<void>;
}

function assetId(hash: string): string {
  return `sha256:${hash}`;
}

export function createInkSegmentSync(options: InkSegmentSyncOptions): InkSegmentSync {
  const { http, store } = options;
  const maxDownloads = Math.max(1, options.maxConcurrentDownloads ?? 3);
  const maxUploads = Math.max(1, options.maxConcurrentUploads ?? 2);
  const passDelayMs = options.passDelayMs ?? 4000;
  const schedule = options.setTimeout ?? ((callback, ms) => setTimeout(callback, ms));
  const cancel = options.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let running = false;
  let timer: unknown;
  let pass: Promise<void> | undefined;
  let failures = 0;

  let activeDownloads = 0;
  const waiting: Array<() => void> = [];
  const acquire = async (): Promise<void> => {
    if (activeDownloads < maxDownloads) {
      activeDownloads += 1;
      return;
    }
    await new Promise<void>((resolve) => waiting.push(resolve));
  };
  const release = (): void => {
    const next = waiting.shift();
    if (next) next();
    else activeDownloads -= 1;
  };

  const remote: SegmentRemote = {
    fetch: async (hash) => {
      await acquire();
      try {
        return (await http.getAsset(assetId(hash)))?.bytes;
      } catch {
        return undefined;
      } finally {
        release();
      }
    },
  };

  const uploadOne = async (hash: string): Promise<void> => {
    const bytes = await store.read(hash);
    if (!bytes) {
      // Nothing local to send (the record is stale): forget it.
      await store.localBackend.markPendingUpload(hash, false);
      return;
    }
    if (!(await http.headAsset(assetId(hash)))) await http.putAsset(assetId(hash), bytes, INK_SEGMENT_MIME_TYPE);
    await store.localBackend.markPendingUpload(hash, false);
  };

  const run = async (): Promise<void> => {
    const queue = await store.localBackend.pendingUploads();
    let failed = false;
    const workers = Array.from({ length: Math.min(maxUploads, queue.length) }, async () => {
      for (;;) {
        const hash = queue.shift();
        if (hash === undefined || !running) return;
        try {
          await uploadOne(hash);
        } catch {
          failed = true;
        }
      }
    });
    await Promise.all(workers);
    failures = failed ? failures + 1 : 0;
  };

  const offline = (): boolean => typeof navigator !== 'undefined' && navigator.onLine === false;
  const onOnline = (): void => {
    if (!running) return;
    failures = 0;
    if (timer !== undefined) cancel(timer);
    timer = schedule(loop, 200);
  };

  const loop = (): void => {
    if (!running) return;
    if (offline()) {
      // No network: wait for it instead of failing (the browser logs every failed request).
      timer = schedule(loop, 2000);
      return;
    }
    pass = run().catch(() => { failures += 1; }).finally(async () => {
      pass = undefined;
      if (!running) return;
      const pending = await store.localBackend.pendingUploads().catch(() => []);
      // Idle queues are checked rarely (a new segment also wakes the loop); a failing one backs off.
      const delay = failures > 0 ? Math.min(passDelayMs * 2 ** Math.min(failures, 5), 120_000)
        : pending.length > 0 ? passDelayMs : passDelayMs * 5;
      timer = schedule(loop, delay);
    });
  };

  let unsubscribe: (() => void) | undefined;
  return {
    start() {
      if (running) return;
      running = true;
      store.setRemote('personal', remote);
      if (typeof window !== 'undefined') window.addEventListener('online', onOnline);
      unsubscribe = store.onStored(() => {
        if (!running || pass) return;
        if (timer !== undefined) cancel(timer);
        timer = schedule(loop, 250);
      });
      loop();
    },
    stop() {
      running = false;
      if (timer !== undefined) cancel(timer);
      timer = undefined;
      unsubscribe?.();
      unsubscribe = undefined;
      if (typeof window !== 'undefined') window.removeEventListener('online', onOnline);
      store.removeRemote('personal', remote);
    },
    async drain() {
      await pass;
      const wasRunning = running;
      running = true;
      try {
        await run();
      } finally {
        running = wasRunning;
      }
    },
  };
}
