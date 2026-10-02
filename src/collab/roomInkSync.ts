import type * as Automerge from '@automerge/automerge';
import { referencedInkSegments } from '../ink/projection';
import { inkSegments } from '../ink/segmentStore';
import { INK_SEGMENT_MIME_TYPE } from '../storage/pageIndex';
import type { DocumentFeedEvent } from './documentFeedPort';
import type { RoomSegmentClient } from './roomSegments';

/**
 * Keeps the ink segments of a shared notebook in its room. The owner's device holds the notebook's
 * real copy, so it is the one that uploads: every segment a page of the notebook references is
 * sent once (`HEAD` first, the Worker verifies the hash), at start for the pages that exist and
 * again whenever a page changes (a new seal, a rewrite). Failed uploads are retried with a growing
 * delay. Collaborators fetch what they lack through `client.remote`.
 */
export interface RoomInkSyncRuntime {
  getState(): {
    schemaVersion: number;
    pages?: ReadonlyArray<{ documentId: string; notebookId: string; assets: ReadonlyArray<{ assetId: string; mimeType: string }> }>;
  };
  subscribeToDocumentChanges(listener: (event: DocumentFeedEvent) => void): () => void;
  subscribeToState(listener: () => void): () => void;
}

export interface RoomInkSyncOptions {
  runtime: RoomInkSyncRuntime;
  notebookId: string;
  client: RoomSegmentClient;
  /** Registered with the segment store under this key so pages of the notebook can fetch from the room. */
  remoteKey: string;
  retryBaseMs?: number;
  /** Whether the room can be reached right now (its live session is connected); uploads wait for it. */
  canRun?: () => boolean;
}

export interface RoomInkSync {
  stop(): void;
  /** The room became reachable: send what is queued now. */
  wake(): void;
  /** Uploads what is queued and resolves when the queue is empty or a pass failed (tests). */
  drain(): Promise<void>;
}

export function startRoomInkSync(options: RoomInkSyncOptions): RoomInkSync {
  const { runtime, notebookId, client } = options;
  const store = inkSegments();
  const retryBase = options.retryBaseMs ?? 3000;
  const queued = new Set<string>();
  const done = new Set<string>();
  let running = false;
  let stopped = false;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pass: Promise<void> | undefined;

  store.setRemote(options.remoteKey, client.remote);

  const enqueue = (hashes: Iterable<string>): void => {
    for (const hash of hashes) if (!done.has(hash)) queued.add(hash);
    if (queued.size > 0) schedule(200);
  };

  const notebookPages = (): Array<{ documentId: string; hashes: string[] }> => {
    const state = runtime.getState();
    return (state.pages ?? [])
      .filter((page) => page.notebookId === notebookId)
      .map((page) => ({
        documentId: page.documentId,
        hashes: page.assets
          .filter((asset) => asset.mimeType === INK_SEGMENT_MIME_TYPE)
          .map((asset) => asset.assetId.slice('sha256:'.length)),
      }));
  };

  const scan = (): void => {
    for (const page of notebookPages()) enqueue(page.hashes);
  };

  const uploadOne = async (hash: string): Promise<void> => {
    if (await client.head(hash)) return;
    const bytes = await store.read(hash);
    // Not on this device (yet): nothing to send, and not an error.
    if (bytes) await client.put(hash, bytes);
  };

  const run = async (): Promise<void> => {
    let failed = false;
    const work = [...queued];
    const workers = Array.from({ length: Math.min(2, work.length) }, async () => {
      for (;;) {
        const hash = work.shift();
        if (hash === undefined || stopped) return;
        try {
          await uploadOne(hash);
          queued.delete(hash);
          done.add(hash);
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
    failures = 0;
    if (queued.size > 0) schedule(200);
  };
  if (typeof window !== 'undefined') window.addEventListener('online', onOnline);

  function schedule(delayMs: number): void {
    if (stopped || running) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      // No network: wait for it instead of failing (every failed request is logged by the browser).
      if (offline() || (options.canRun && !options.canRun())) {
        schedule(2000);
        return;
      }
      running = true;
      pass = run().catch(() => { failures += 1; }).finally(() => {
        running = false;
        pass = undefined;
        if (!stopped && queued.size > 0) schedule(Math.min(retryBase * 2 ** Math.min(failures, 5), 120_000));
      });
    }, delayMs);
  }

  const onChange = (event: DocumentFeedEvent): void => {
    if (event.kind !== 'page' || !event.document) return;
    const belongs = (runtime.getState().pages ?? []).some(
      (page) => page.documentId === event.documentId && page.notebookId === notebookId,
    );
    if (belongs) enqueue(referencedInkSegments(event.document as Automerge.Doc<object>));
  };

  const unsubscribeChanges = runtime.subscribeToDocumentChanges(onChange);
  const unsubscribeState = runtime.subscribeToState(scan);
  scan();

  return {
    wake: onOnline,
    stop() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      unsubscribeChanges();
      unsubscribeState();
      if (typeof window !== 'undefined') window.removeEventListener('online', onOnline);
      store.removeRemote(options.remoteKey, client.remote);
    },
    async drain() {
      await pass;
      const wasStopped = stopped;
      await run();
      void wasStopped;
    },
  };
}
