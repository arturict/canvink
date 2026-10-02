/**
 * §5.7 personal-space asset sync queue: upload diff + HEAD-dedupe on the way
 * up, lazy coalesced download + batched adoption on the way down.
 *
 * Both the HTTP client and the local-workspace write path are injected as
 * constructor ports declared in this file, not imported from `http.ts`
 * (wave 2) or `workspaceV2Runtime.ts` (wave 3) directly, so this module
 * compiles and tests independently of those waves (see the module-tree note
 * in PERSONAL-SYNC.md §5.1 and the Wave-4 "must not touch" list in §9).
 */

import { SPACE_ASSET_BATCH_MS, SPACE_MAX_ASSET_BYTES } from '../contract';

export interface AssetBytesFetch {
  bytes: Uint8Array;
  mimeType: string;
}

export interface AssetUploadEntry {
  assetId: string;
  bytes: Uint8Array;
  mimeType: string;
  size: number;
}

export interface AssetAdoptEntry {
  assetId: string;
  bytes: Uint8Array;
  mimeType: string;
  size: number;
}

/** HTTP surface the queue needs; the personal-space asset routes of §3.5. */
export interface AssetSyncHttpPort {
  /** `HEAD /me/assets/<assetId>` — true iff the object already exists. */
  headAsset(assetId: string): Promise<boolean>;
  /** `PUT /me/assets/<assetId>`. */
  putAsset(assetId: string, bytes: Uint8Array, mimeType: string): Promise<void>;
  /** `GET /me/assets/<assetId>`; undefined when the object does not exist. */
  getAsset(assetId: string): Promise<AssetBytesFetch | undefined>;
}

/** The local-workspace surface the queue needs; satisfied by the caller that owns
 * the workspace doc (wave 3's `workspaceDoc.ts`) and the runtime (§5.5). */
export interface AssetSyncRuntimePort {
  /** Records a successfully-uploaded asset, e.g. `workspaceDoc.recordAsset(...)`. */
  recordUploadedAsset(entry: { assetId: string; size: number; mimeType: string; addedAt: string }): Promise<void> | void;
  /** Adopts a batch of downloaded assets into the local workspace in one transaction (§5.5). */
  adoptDownloadedAssets(assets: readonly AssetAdoptEntry[]): Promise<void>;
}

export interface AssetSyncQueuePorts {
  http: AssetSyncHttpPort;
  runtime: AssetSyncRuntimePort;
}

export interface AssetSyncQueueConfig {
  /** Debounce before a download batch is committed (§5.7). Default `SPACE_ASSET_BATCH_MS`. */
  batchMs?: number;
  /** Flush immediately once the pending batch reaches this many blobs. Default 16. */
  maxBatchCount?: number;
  /** Flush immediately once the pending batch reaches this many bytes. Default 32 MiB. */
  maxBatchBytes?: number;
  /** Upload fan-out limit ("at most two concurrent", §5.7). Default 2. */
  maxConcurrentUploads?: number;
  minRetryBackoffMs?: number;
  maxRetryBackoffMs?: number;
  /** Downloads that run at the same time; the rest wait by priority. Default 4. */
  maxConcurrentDownloads?: number;
  /** Attempts per asset before `syncUploads` rejects for that asset. Default 5. */
  maxUploadAttempts?: number;
  /** Injectable for deterministic backoff tests; defaults to `Math.random`. */
  random?: () => number;
  /** Injectable clock for `recordUploadedAsset`'s `addedAt`; defaults to `Date.now`. */
  now?: () => string;
}

const DEFAULT_MAX_BATCH_COUNT = 16;
const DEFAULT_MAX_BATCH_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_CONCURRENT_UPLOADS = 2;
const DEFAULT_MAX_CONCURRENT_DOWNLOADS = 4;
const DEFAULT_MAX_UPLOAD_ATTEMPTS = 5;
const DEFAULT_MIN_RETRY_BACKOFF_MS = 1_000;
const DEFAULT_MAX_RETRY_BACKOFF_MS = 30_000;

/**
 * Pure: `activation.assetIds minus Object.keys(workspaceDoc.assets)` (§5.7).
 * Deterministic and order-preserving; duplicate ids in `activationAssetIds`
 * are folded into a single entry.
 */
export function computeAssetUploadDiff(
  activationAssetIds: readonly string[],
  knownAssetIds: ReadonlySet<string> | readonly string[],
): string[] {
  const known = knownAssetIds instanceof Set ? knownAssetIds : new Set(knownAssetIds);
  const seen = new Set<string>();
  const diff: string[] = [];
  for (const assetId of activationAssetIds) {
    if (known.has(assetId) || seen.has(assetId)) continue;
    seen.add(assetId);
    diff.push(assetId);
  }
  return diff;
}

/** What a caller of `requestAsset` can say about how much it needs the bytes now. */
export interface AssetRequestOptions {
  /** Lower runs first among the downloads that wait. Default 100: behind everything a screen asks for. */
  priority?: number;
  /** Withdraws this caller's interest; a download nobody waits for and that has not started is dropped. */
  signal?: AbortSignal;
}

interface DownloadRequest {
  assetId: string;
  priority: number;
  waiters: number;
  started: boolean;
  promise: Promise<Uint8Array | undefined>;
  start(): void;
  cancel(): void;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Upload diff + HEAD-dedupe + bounded-concurrency uploader, plus a lazy,
 * coalesced, batch-adopting downloader. See the module doc comment above for
 * why the ports are declared locally rather than imported.
 */
export class AssetSyncQueue {
  private readonly http: AssetSyncHttpPort;
  private readonly runtime: AssetSyncRuntimePort;
  private readonly batchMs: number;
  private readonly maxBatchCount: number;
  private readonly maxBatchBytes: number;
  private readonly maxConcurrentUploads: number;
  private readonly maxConcurrentDownloads: number;
  private readonly minRetryBackoffMs: number;
  private readonly maxRetryBackoffMs: number;
  private readonly maxUploadAttempts: number;
  private readonly random: () => number;
  private readonly now: () => string;

  private readonly inFlightDownloads = new Map<string, DownloadRequest>();
  private readonly waitingDownloads: DownloadRequest[] = [];
  private activeDownloads = 0;
  private activeUploads = 0;
  private readonly uploadWaiters: Array<() => void> = [];
  private readonly pendingAdoption = new Map<string, AssetAdoptEntry>();
  private pendingAdoptionBytes = 0;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(ports: AssetSyncQueuePorts, config: AssetSyncQueueConfig = {}) {
    this.http = ports.http;
    this.runtime = ports.runtime;
    this.batchMs = config.batchMs ?? SPACE_ASSET_BATCH_MS;
    this.maxBatchCount = config.maxBatchCount ?? DEFAULT_MAX_BATCH_COUNT;
    this.maxBatchBytes = config.maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES;
    this.maxConcurrentUploads = Math.max(1, config.maxConcurrentUploads ?? DEFAULT_MAX_CONCURRENT_UPLOADS);
    this.maxConcurrentDownloads = Math.max(1, config.maxConcurrentDownloads ?? DEFAULT_MAX_CONCURRENT_DOWNLOADS);
    this.minRetryBackoffMs = config.minRetryBackoffMs ?? DEFAULT_MIN_RETRY_BACKOFF_MS;
    this.maxRetryBackoffMs = config.maxRetryBackoffMs ?? DEFAULT_MAX_RETRY_BACKOFF_MS;
    this.maxUploadAttempts = config.maxUploadAttempts ?? DEFAULT_MAX_UPLOAD_ATTEMPTS;
    this.random = config.random ?? Math.random;
    this.now = config.now ?? (() => new Date().toISOString());
  }

  /**
   * Uploads every asset in `pendingAssets` the workspace doc does not list
   * yet (`knownAssetIds`). HEAD-dedupes before each PUT, runs at most
   * `maxConcurrentUploads` uploads in parallel, and retries a failing
   * HEAD/PUT with exponential backoff before giving up on that one asset —
   * a later call retries it again, since it stays out of `knownAssetIds`
   * until `recordUploadedAsset` succeeds.
   */
  async syncUploads(
    pendingAssets: readonly AssetUploadEntry[],
    knownAssetIds: ReadonlySet<string> | readonly string[],
  ): Promise<void> {
    const missing = computeAssetUploadDiff(
      pendingAssets.map((asset) => asset.assetId),
      knownAssetIds,
    );
    if (missing.length === 0) return;
    const byId = new Map(pendingAssets.map((asset) => [asset.assetId, asset] as const));
    const queue = [...missing];
    const workerCount = Math.min(this.maxConcurrentUploads, queue.length);
    await Promise.all(Array.from({ length: workerCount }, () => this.runUploadWorker(queue, byId)));
  }

  private async runUploadWorker(queue: string[], byId: ReadonlyMap<string, AssetUploadEntry>): Promise<void> {
    for (;;) {
      const assetId = queue.shift();
      if (assetId === undefined) return;
      const asset = byId.get(assetId);
      if (!asset) continue;
      await this.uploadWithinLimit(asset);
    }
  }

  /**
   * Several `syncUploads` calls can overlap (an import saved in batches, each
   * batch asking for its uploads); the limit holds across all of them.
   */
  private async uploadWithinLimit(asset: AssetUploadEntry): Promise<void> {
    if (this.activeUploads >= this.maxConcurrentUploads) {
      await new Promise<void>((resolve) => this.uploadWaiters.push(resolve));
    } else {
      this.activeUploads += 1;
    }
    try {
      await this.uploadOne(asset);
    } finally {
      const next = this.uploadWaiters.shift();
      // The slot passes straight to the next waiter.
      if (next) next();
      else this.activeUploads -= 1;
    }
  }

  private async uploadOne(asset: AssetUploadEntry): Promise<void> {
    let attempt = 0;
    let backoffMs = this.minRetryBackoffMs;
    for (;;) {
      attempt += 1;
      try {
        const exists = await this.http.headAsset(asset.assetId);
        if (!exists) await this.http.putAsset(asset.assetId, asset.bytes, asset.mimeType);
        await this.runtime.recordUploadedAsset({
          assetId: asset.assetId,
          size: asset.size,
          mimeType: asset.mimeType,
          addedAt: this.now(),
        });
        return;
      } catch (error) {
        if (attempt >= this.maxUploadAttempts) throw error;
        const jitter = this.random() * backoffMs * 0.2;
        await delay(Math.min(backoffMs, this.maxRetryBackoffMs) + jitter);
        backoffMs = Math.min(backoffMs * 2, this.maxRetryBackoffMs);
      }
    }
  }

  /**
   * Lazy download (§5.7), never eager. Duplicate requests for the same
   * asset id coalesce into one in-flight fetch. A successful download joins
   * a batch that is committed once, through `runtime.adoptDownloadedAssets`,
   * after `batchMs` — or immediately once the pending batch reaches
   * `maxBatchCount` blobs or `maxBatchBytes`.
   */
  requestAsset(assetId: string, options: AssetRequestOptions = {}): Promise<Uint8Array | undefined> {
    const { signal } = options;
    if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    const priority = options.priority ?? 100;
    let request = this.inFlightDownloads.get(assetId);
    if (request) {
      // A closer caller moves the waiting download up.
      request.priority = Math.min(request.priority, priority);
    } else {
      request = this.createDownload(assetId, priority);
      this.inFlightDownloads.set(assetId, request);
      this.waitingDownloads.push(request);
      this.pumpDownloads();
    }
    const current = request;
    current.waiters += 1;
    if (!signal) return current.promise;
    // Each caller settles on its own: an aborted one rejects, the download goes on for the others.
    return new Promise<Uint8Array | undefined>((resolve, reject) => {
      const onAbort = () => {
        current.waiters -= 1;
        if (current.waiters === 0 && !current.started) current.cancel();
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      current.promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    });
  }

  private createDownload(assetId: string, priority: number): DownloadRequest {
    let resolve!: (bytes: Uint8Array | undefined) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<Uint8Array | undefined>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const request: DownloadRequest = {
      assetId,
      priority,
      waiters: 0,
      started: false,
      promise,
      start: () => {
        request.started = true;
        this.activeDownloads += 1;
        this.downloadAndBatch(assetId).then(resolve, reject).finally(() => {
          this.activeDownloads -= 1;
          this.inFlightDownloads.delete(assetId);
          this.pumpDownloads();
        });
      },
      cancel: () => {
        const index = this.waitingDownloads.indexOf(request);
        if (index >= 0) this.waitingDownloads.splice(index, 1);
        this.inFlightDownloads.delete(assetId);
        reject(new DOMException('Aborted', 'AbortError'));
      },
    };
    // A cancelled download rejects with nobody listening; that is not an error.
    promise.catch(() => undefined);
    return request;
  }

  private pumpDownloads(): void {
    while (this.activeDownloads < this.maxConcurrentDownloads && this.waitingDownloads.length > 0) {
      let best = 0;
      for (let index = 1; index < this.waitingDownloads.length; index += 1) {
        if (this.waitingDownloads[index].priority < this.waitingDownloads[best].priority) best = index;
      }
      const [next] = this.waitingDownloads.splice(best, 1);
      next.start();
    }
  }

  private async downloadAndBatch(assetId: string): Promise<Uint8Array | undefined> {
    const fetched = await this.http.getAsset(assetId);
    if (!fetched) return undefined;
    if (fetched.bytes.byteLength > SPACE_MAX_ASSET_BYTES) {
      throw new Error(`Asset ${assetId} exceeds the ${SPACE_MAX_ASSET_BYTES}-byte personal-space limit.`);
    }
    this.enqueueAdoption({
      assetId,
      bytes: fetched.bytes,
      mimeType: fetched.mimeType,
      size: fetched.bytes.byteLength,
    });
    return fetched.bytes;
  }

  private enqueueAdoption(entry: AssetAdoptEntry): void {
    if (!this.pendingAdoption.has(entry.assetId)) this.pendingAdoptionBytes += entry.size;
    this.pendingAdoption.set(entry.assetId, entry);
    if (this.pendingAdoption.size >= this.maxBatchCount || this.pendingAdoptionBytes >= this.maxBatchBytes) {
      void this.flushAdoption();
      return;
    }
    if (this.flushTimer === undefined) {
      this.flushTimer = setTimeout(() => {
        void this.flushAdoption();
      }, this.batchMs);
    }
  }

  /** Flushes the pending download batch immediately (e.g. before the app suspends). No-op if empty. */
  flushAdoption(): Promise<void> {
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (this.pendingAdoption.size === 0) return Promise.resolve();
    const batch = [...this.pendingAdoption.values()];
    this.pendingAdoption.clear();
    this.pendingAdoptionBytes = 0;
    return this.runtime.adoptDownloadedAssets(batch);
  }
}
