import { readAssetBytes, type AssetReadOptions, type AssetRepository } from '../../assets';
import type { AssetRef } from '../../domain/v2';

/**
 * Where the picture of an image or printout element comes from.
 *
 * A page shows the same asset again and again (reopening it, moving between
 * pages), and reading one costs a database read, two SHA-256 passes over its
 * bytes and a copy. This cache reads and verifies an asset once, hands out one
 * blob URL per asset, shares a read that is still in flight, and keeps recently
 * used blobs for the next visit within a byte budget. A URL is revoked when its
 * entry is dropped.
 */

/** Encoded bytes of unused entries kept for the next visit. */
const IDLE_BYTE_BUDGET = 96 * 1024 * 1024;

/** What the cache needs to know about an asset; a full `AssetRef` fits. */
export type ImageAsset = Pick<AssetRef, 'assetId' | 'checksum' | 'size' | 'mimeType'>;

export interface ImageLease {
  readonly url: string;
  /** Lets go of the URL; it stays valid until then. Releasing twice is harmless. */
  release(): void;
}

export interface ImageUrls {
  create(blob: Blob): string;
  revoke(url: string): void;
}

interface Entry {
  readonly key: string;
  readonly blob: Blob;
  readonly owner: Map<string, Promise<Entry>>;
  refs: number;
  url: string | undefined;
  dropped: boolean;
}

export function createImageSourceCache(options: { urls: ImageUrls; idleByteBudget?: number }) {
  const { urls } = options;
  const budget = options.idleByteBudget ?? IDLE_BYTE_BUDGET;
  const repositories = new WeakMap<AssetRepository, Map<string, Promise<Entry>>>();
  /** Entries nobody holds, least recently used first. */
  const idle = new Map<Entry, number>();
  let idleBytes = 0;

  function drop(entry: Entry): void {
    if (entry.dropped) return;
    entry.dropped = true;
    entry.owner.delete(entry.key);
    if (idle.delete(entry)) idleBytes -= entry.blob.size;
    if (entry.refs === 0 && entry.url !== undefined) urls.revoke(entry.url);
  }

  function enforceBudget(): void {
    for (const entry of idle.keys()) {
      if (idleBytes <= budget) return;
      drop(entry);
    }
  }

  function take(entry: Entry): ImageLease {
    if (idle.delete(entry)) idleBytes -= entry.blob.size;
    entry.refs += 1;
    entry.url ??= urls.create(entry.blob);
    const url = entry.url;
    let released = false;
    return {
      url,
      release() {
        if (released) return;
        released = true;
        entry.refs -= 1;
        if (entry.refs > 0) return;
        if (entry.dropped) {
          urls.revoke(url);
          entry.url = undefined;
          return;
        }
        idle.set(entry, entry.blob.size);
        idleBytes += entry.blob.size;
        enforceBudget();
      },
    };
  }

  function entries(repository: AssetRepository): Map<string, Promise<Entry>> {
    let map = repositories.get(repository);
    if (!map) {
      map = new Map();
      repositories.set(repository, map);
    }
    return map;
  }

  /** Reads still waiting for their bytes: how many callers want each, and the way to stop it. */
  const waiting = new WeakMap<Promise<Entry>, { callers: number; controller: AbortController; forget(): void }>();

  /** The verified original of an asset, read once however many elements show it. */
  function source(repository: AssetRepository, asset: ImageAsset, options: AssetReadOptions = {}): Promise<Entry> {
    const owner = entries(repository);
    const key = asset.assetId;
    const existing = owner.get(key);
    if (existing) return joined(existing, options);
    const controller = new AbortController();
    const created = (async (): Promise<Entry> => {
      const bytes = await readAssetBytes(repository, asset, { priority: options.priority, signal: controller.signal });
      const entry: Entry = { key, blob: blobOf(bytes, asset.mimeType), owner, refs: 0, url: undefined, dropped: false };
      idle.set(entry, entry.blob.size);
      idleBytes += entry.blob.size;
      enforceBudget();
      return entry;
    })();
    owner.set(key, created);
    // A read that was stopped must not be joined by the next caller.
    waiting.set(created, { callers: 0, controller, forget: () => { if (owner.get(key) === created) owner.delete(key); } });
    created.then(() => waiting.delete(created), () => waiting.delete(created));
    created.catch(() => {
      if (owner.get(key) === created) owner.delete(key);
    });
    return joined(created, options);
  }

  /**
   * `read` as one caller sees it. A caller that withdraws stops the read only
   * when nobody else waits for it, and rejects on its own either way.
   */
  function joined(read: Promise<Entry>, options: AssetReadOptions): Promise<Entry> {
    const pending = waiting.get(read);
    const { signal } = options;
    if (!pending) return read;
    pending.callers += 1;
    // A caller that cannot withdraw keeps the read alive for good.
    if (!signal) return read;
    if (signal.aborted) {
      pending.callers -= 1;
      if (pending.callers === 0) {
        pending.forget();
        pending.controller.abort(signal.reason);
      }
      return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    }
    return new Promise<Entry>((resolve, reject) => {
      const onAbort = () => {
        pending.callers -= 1;
        if (pending.callers === 0) {
          pending.forget();
          pending.controller.abort(signal.reason);
        }
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      read.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    });
  }

  return {
    /** A URL that shows `asset`. Rejects when it is missing or fails its integrity check. */
    async lease(repository: AssetRepository, asset: ImageAsset, options?: AssetReadOptions): Promise<ImageLease> {
      return take(await source(repository, asset, options));
    },
    /** The verified bytes' blob for a picture that is already read, without holding a URL. */
    async blob(repository: AssetRepository, asset: ImageAsset, options?: AssetReadOptions): Promise<Blob> {
      return (await source(repository, asset, options)).blob;
    },
    /** Drops every unused entry; leased ones go when their last holder lets go. */
    trim(): void {
      for (const entry of [...idle.keys()]) drop(entry);
    },
    stats: () => ({ idleBytes, idleEntries: idle.size }),
  };
}

/** A blob over `bytes`, without copying them first when they sit in an ordinary ArrayBuffer. */
function blobOf(bytes: Uint8Array, type: string): Blob {
  const { buffer } = bytes;
  return new Blob(
    [buffer instanceof ArrayBuffer ? new Uint8Array(buffer, bytes.byteOffset, bytes.byteLength) : Uint8Array.from(bytes)],
    { type },
  );
}

export const imageSources = createImageSourceCache({
  urls: { create: (blob) => URL.createObjectURL(blob), revoke: (url) => URL.revokeObjectURL(url) },
});
