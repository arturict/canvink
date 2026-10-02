import { createStore, del, delMany, get, setMany, type UseStore } from "idb-keyval";
import type { Rect } from "./operations/geometry";

/**
 * A low-resolution picture of a page's committed ink, shown while the
 * page's document loads (see inkRaster.ts). Rasters are derived data: they
 * live in their own IndexedDB database, are never synced or exported, and
 * may be dropped at any time. A record that does not have this exact shape
 * and version is ignored.
 */
export const INK_RASTER_VERSION = 1;

export interface InkRasterRecord {
  version: typeof INK_RASTER_VERSION;
  pageId: string;
  /** The page area the picture covers, in page units. */
  bounds: Rect;
  /** Pixel size of the picture. */
  width: number;
  height: number;
  /**
   * Screen position of the page's origin when the page opens (pan 0, zoom 1),
   * in CSS pixels from the window's top-left corner, as measured when the
   * raster was drawn.
   */
  origin: { x: number; y: number };
  /** The editor's viewport on screen (CSS pixels); the picture is clipped to it. */
  view: Rect;
  /** The page's paper within the viewport, on screen, and its colour. */
  paper: Rect & { color: string };
  /** Live strokes on the page when the raster was drawn. */
  strokeCount: number;
  /** Identity of the ink in the picture (see inkFingerprint). */
  fingerprint: string;
  /** The page's `updatedAt` when the raster was drawn. */
  updatedAt: string;
  savedAt: number;
  blob: Blob;
}

/** Newest rasters kept; older ones are evicted by `savedAt`. */
export const INK_RASTER_LIMIT = 200;

/** The key that holds pageId → savedAt for every stored raster. */
const INDEX_KEY = "__index__";
type RasterIndex = Record<string, number>;

/** The few key-value operations the cache needs; IndexedDB in the app, a Map in tests. */
export interface RasterKeyValue {
  get(key: string): Promise<unknown>;
  setMany(entries: Array<[string, unknown]>): Promise<void>;
  delMany(keys: string[]): Promise<void>;
  del(key: string): Promise<void>;
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function isRect(value: unknown): value is Rect {
  if (!value || typeof value !== "object") return false;
  const rect = value as Record<string, unknown>;
  return finite(rect.x) && finite(rect.y) && finite(rect.width) && finite(rect.height)
    && (rect.width as number) > 0 && (rect.height as number) > 0;
}

/** The record when it is a complete raster of the current version, else null. */
export function validInkRaster(value: unknown, pageId: string): InkRasterRecord | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const origin = record.origin as Record<string, unknown> | undefined;
  const valid = record.version === INK_RASTER_VERSION
    && record.pageId === pageId
    && isRect(record.bounds)
    && finite(record.width) && (record.width as number) > 0
    && finite(record.height) && (record.height as number) > 0
    && !!origin && finite(origin.x) && finite(origin.y)
    && isRect(record.view)
    && isRect(record.paper) && typeof (record.paper as { color?: unknown }).color === "string"
    && finite(record.strokeCount)
    && typeof record.fingerprint === "string"
    && typeof record.updatedAt === "string"
    && finite(record.savedAt)
    && typeof Blob !== "undefined" && record.blob instanceof Blob && record.blob.size > 0;
  return valid ? (value as InkRasterRecord) : null;
}

function readIndex(value: unknown): RasterIndex {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const index: RasterIndex = {};
  for (const [pageId, savedAt] of Object.entries(value as Record<string, unknown>)) {
    if (finite(savedAt)) index[pageId] = savedAt;
  }
  return index;
}

/** The page ids to evict so that at most `limit` rasters remain, oldest first. */
export function rastersToEvict(index: Readonly<RasterIndex>, limit = INK_RASTER_LIMIT): string[] {
  const entries = Object.entries(index).sort((left, right) => right[1] - left[1]);
  return entries.slice(limit).map(([pageId]) => pageId);
}

export class InkRasterStore {
  constructor(
    private readonly backend: RasterKeyValue,
    private readonly limit = INK_RASTER_LIMIT,
  ) {}

  /** The stored raster of a page; a missing, old or corrupt record is null. */
  async load(pageId: string): Promise<InkRasterRecord | null> {
    if (pageId === INDEX_KEY) return null;
    let value: unknown;
    try {
      value = await this.backend.get(pageId);
    } catch {
      return null;
    }
    if (value === undefined) return null;
    const record = validInkRaster(value, pageId);
    // An unreadable record is only in the way; it is rebuilt on the next visit.
    if (!record) await this.backend.del(pageId).catch(() => undefined);
    return record;
  }

  /** Stores a page's raster, replacing the previous one, and evicts the oldest. */
  async save(record: InkRasterRecord): Promise<void> {
    if (record.pageId === INDEX_KEY) return;
    const index = readIndex(await this.backend.get(INDEX_KEY));
    index[record.pageId] = record.savedAt;
    const evicted = rastersToEvict(index, this.limit);
    for (const pageId of evicted) delete index[pageId];
    await this.backend.setMany([[record.pageId, record], [INDEX_KEY, index]]);
    if (evicted.length > 0) await this.backend.delMany(evicted);
  }

  async remove(pageId: string): Promise<void> {
    if (pageId === INDEX_KEY) return;
    const index = readIndex(await this.backend.get(INDEX_KEY));
    delete index[pageId];
    await this.backend.setMany([[INDEX_KEY, index]]);
    await this.backend.del(pageId);
  }

  /** Drops the rasters of pages that are no longer in the workspace. */
  async prune(existingPageIds: ReadonlySet<string>): Promise<number> {
    const index = readIndex(await this.backend.get(INDEX_KEY));
    const gone = Object.keys(index).filter((pageId) => !existingPageIds.has(pageId));
    if (gone.length === 0) return 0;
    for (const pageId of gone) delete index[pageId];
    await this.backend.setMany([[INDEX_KEY, index]]);
    await this.backend.delMany(gone);
    return gone.length;
  }

  /** The stored page ids, newest first (for tests and diagnostics). */
  async pageIds(): Promise<string[]> {
    const index = readIndex(await this.backend.get(INDEX_KEY));
    return Object.entries(index).sort((left, right) => right[1] - left[1]).map(([pageId]) => pageId);
  }

  /** Whether each of the pages has a stored entry (without reading its blob). */
  async has(pageIds: string[]): Promise<boolean[]> {
    const index = readIndex(await this.backend.get(INDEX_KEY));
    return pageIds.map((pageId) => pageId in index);
  }
}

/** The database name, separate from the workspace's and the Automerge repo's. */
export const INK_RASTER_DATABASE = "canvink-ink-raster";

function indexedDbBackend(): RasterKeyValue {
  let store: UseStore | undefined;
  const database = () => (store ??= createStore(INK_RASTER_DATABASE, "rasters"));
  return {
    get: (key) => get(key, database()),
    setMany: (entries) => setMany(entries, database()),
    delMany: (keys) => delMany(keys, database()),
    del: (key) => del(key, database()),
  };
}

let shared: InkRasterStore | null | undefined;

/** The app's raster cache, or null where IndexedDB is unavailable. */
export function inkRasterStore(): InkRasterStore | null {
  if (shared !== undefined) return shared;
  shared = typeof indexedDB === "undefined" ? null : new InkRasterStore(indexedDbBackend());
  return shared;
}
