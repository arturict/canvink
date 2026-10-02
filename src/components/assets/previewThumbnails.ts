/**
 * Small pictures of printout pages, kept on this device only.
 *
 * A long printout scrolls past faster than its sharp pictures can be read,
 * verified and decoded. A 200 px thumbnail per page is a few kilobytes: it
 * shows the page's shape and text layout at once, before the sharp picture
 * arrives. Thumbnails are cache, keyed by the content hash of the picture they
 * stand for, so one can never be stale; they are never synced and can always
 * be regenerated from the picture. Where IndexedDB is missing they live in
 * memory only.
 */

const DATABASE = 'canvink-preview-cache';
const STORE = 'thumbnails';
const MAX_STORED = 6_000;
const THUMBNAIL_WIDTH = 200;
const IDLE_URL_LIMIT = 400;

export interface ThumbnailStore {
  get(assetId: string): Promise<Blob | undefined>;
  put(assetId: string, blob: Blob): Promise<void>;
}

interface Record {
  blob: Blob;
  at: number;
}

export function createThumbnailStore(factory: IDBFactory | undefined = typeof indexedDB === 'undefined' ? undefined : indexedDB): ThumbnailStore {
  const memory = new Map<string, Blob>();
  let opening: Promise<IDBDatabase | undefined> | undefined;
  let stored = -1;

  function database(): Promise<IDBDatabase | undefined> {
    opening ??= new Promise<IDBDatabase | undefined>((resolve) => {
      if (!factory) {
        resolve(undefined);
        return;
      }
      try {
        const request = factory.open(DATABASE, 1);
        request.onupgradeneeded = () => request.result.createObjectStore(STORE);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(undefined);
        request.onblocked = () => resolve(undefined);
      } catch {
        resolve(undefined);
      }
    });
    return opening;
  }

  function request<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
    return database().then((db) => new Promise<T | undefined>((resolve) => {
      if (!db) {
        resolve(undefined);
        return;
      }
      try {
        const transaction = db.transaction(STORE, mode);
        const made = work(transaction.objectStore(STORE));
        transaction.oncomplete = () => resolve(made.result);
        transaction.onerror = () => resolve(undefined);
        transaction.onabort = () => resolve(undefined);
      } catch {
        resolve(undefined);
      }
    }));
  }

  /** Drops the oldest thumbnails once far more than a notebook's worth are stored. */
  async function prune(): Promise<void> {
    const db = await database();
    if (!db) return;
    await new Promise<void>((resolve) => {
      try {
        const transaction = db.transaction(STORE, 'readwrite');
        const store = transaction.objectStore(STORE);
        const all = store.openCursor();
        const entries: Array<{ key: IDBValidKey; at: number }> = [];
        all.onsuccess = () => {
          const cursor = all.result;
          if (cursor) {
            entries.push({ key: cursor.key, at: (cursor.value as Record).at });
            cursor.continue();
            return;
          }
          entries.sort((left, right) => left.at - right.at);
          for (const entry of entries.slice(0, Math.max(0, entries.length - MAX_STORED * 0.75))) store.delete(entry.key);
          stored = Math.min(entries.length, MAX_STORED * 0.75);
        };
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => resolve();
        transaction.onabort = () => resolve();
      } catch {
        resolve();
      }
    });
  }

  return {
    async get(assetId) {
      const cached = memory.get(assetId);
      if (cached) return cached;
      const record = await request<Record | undefined>('readonly', (store) => store.get(assetId));
      if (!record?.blob) return undefined;
      memory.set(assetId, record.blob);
      return record.blob;
    },
    async put(assetId, blob) {
      memory.set(assetId, blob);
      await request('readwrite', (store) => store.put({ blob, at: Date.now() } satisfies Record, assetId));
      stored = stored < 0 ? 0 : stored + 1;
      if (stored > MAX_STORED) await prune();
    },
  };
}

export const thumbnails = createThumbnailStore();

/** Blob URLs of thumbnails in use, shared by every element showing the same picture. */
const urls = new Map<string, { url: string; holders: number }>();

export function holdThumbnailUrl(assetId: string, blob: Blob): { url: string; release(): void } {
  let entry = urls.get(assetId);
  if (!entry) {
    entry = { url: URL.createObjectURL(blob), holders: 0 };
    urls.set(assetId, entry);
  }
  entry.holders += 1;
  const held = entry;
  let released = false;
  return {
    url: held.url,
    release() {
      if (released) return;
      released = true;
      held.holders -= 1;
      if (held.holders > 0) return;
      // Unused URLs stay valid for a while: revoking one while the browser still
      // decodes the picture behind it took the tab down on a headless Chromium.
      urls.delete(assetId);
      urls.set(assetId, held);
      for (const [key, entry] of urls) {
        if (urls.size <= IDLE_URL_LIMIT) break;
        if (entry.holders > 0) continue;
        urls.delete(key);
        URL.revokeObjectURL(entry.url);
      }
    },
  };
}

/** A thumbnail of `source` in the browser's own encoder, or undefined where it cannot make one. */
export async function makeThumbnail(source: Blob): Promise<Blob | undefined> {
  if (typeof createImageBitmap === 'undefined' || typeof OffscreenCanvas === 'undefined') return undefined;
  try {
    // Decoded and scaled off the main thread; only the small bitmap reaches it.
    const bitmap = await createImageBitmap(source, { resizeWidth: THUMBNAIL_WIDTH, resizeQuality: 'medium' });
    try {
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) return undefined;
      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0);
      return await canvas.convertToBlob({ type: 'image/webp', quality: 0.6 });
    } finally {
      bitmap.close();
    }
  } catch {
    return undefined;
  }
}

/** Thumbnails to make, one at a time and after the pictures on screen. */
let generating: Promise<void> = Promise.resolve();
const requested = new Set<string>();

export function generateThumbnailLater(assetId: string, source: Blob, store: ThumbnailStore = thumbnails): void {
  if (requested.has(assetId)) return;
  requested.add(assetId);
  generating = generating.then(async () => {
    await new Promise<void>((resolve) => {
      if (typeof requestIdleCallback === 'function') requestIdleCallback(() => resolve(), { timeout: 1_500 });
      else setTimeout(resolve, 50);
    });
    if (await store.get(assetId)) return;
    const blob = await makeThumbnail(source);
    if (blob) await store.put(assetId, blob);
  }).catch(() => undefined);
}
