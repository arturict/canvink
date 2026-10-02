import { createStore, del, get, keys, set, type UseStore } from 'idb-keyval';
import type { StrokeElementV2 } from '../domain/v2';
import { sha256Bytes } from '../domain/v2/hash';
import { decodeInkSegment } from './segmentCodec';

/**
 * Where committed ink lives. A page document only references segments by the
 * SHA-256 of their bytes; the bytes are kept here, next to (not inside) the
 * workspace storage, and travel to and from the cloud like assets.
 *
 * - `SegmentBackend` is the durable, local blob store (IndexedDB in the app,
 *   memory in tests). It also remembers which segments still have to be
 *   uploaded, so an interrupted upload resumes after a restart.
 * - The decoded strokes of segments in use are kept in memory: snapshots read
 *   them synchronously (`peekInkSegment`), so a page's segments are made
 *   resident (`ensureInkSegments`) before its document is shown.
 * - A `SegmentRemote` fetches segments this device does not hold (ink another
 *   device sealed) from the cloud.
 */
export interface SegmentBackend {
  get(hash: string): Promise<Uint8Array | undefined>;
  put(hash: string, bytes: Uint8Array): Promise<void>;
  /** Marks a segment as still to be uploaded (`true`) or as uploaded (`false`). */
  markPendingUpload(hash: string, pending: boolean): Promise<void>;
  pendingUploads(): Promise<string[]>;
  /** Every stored segment hash. */
  list(): Promise<string[]>;
  remove(hash: string): Promise<void>;
  /** The journal of strokes drawn but not yet sealed into a segment, one record per page document. */
  readJournal(key: string): Promise<Uint8Array | undefined>;
  /** Writes the journal record, or deletes it when `bytes` is undefined. */
  writeJournal(key: string, bytes: Uint8Array | undefined): Promise<void>;
  journalKeys(): Promise<string[]>;
}

export interface SegmentRemote {
  /** The segment bytes, or undefined when the cloud does not hold them (yet). */
  fetch(hash: string): Promise<Uint8Array | undefined>;
}

export interface ResidentSegment {
  readonly hash: string;
  readonly strokes: readonly StrokeElementV2[];
  /** Ids of `strokes`, for O(1) membership tests when a write must find a stroke's segment. */
  readonly ids: ReadonlySet<string>;
  readonly byId: ReadonlyMap<string, StrokeElementV2>;
  readonly byteLength: number;
}

const HASH = /^[0-9a-f]{64}$/;

export function isInkSegmentHash(value: string): boolean {
  return HASH.test(value);
}

export async function hashInkSegment(bytes: Uint8Array): Promise<string> {
  return (await sha256Bytes(bytes)).slice('sha256:'.length);
}

export class MemorySegmentBackend implements SegmentBackend {
  readonly blobs = new Map<string, Uint8Array>();
  readonly pending = new Set<string>();
  readonly journals = new Map<string, Uint8Array>();

  get(hash: string): Promise<Uint8Array | undefined> {
    const bytes = this.blobs.get(hash);
    return Promise.resolve(bytes ? bytes.slice() : undefined);
  }

  put(hash: string, bytes: Uint8Array): Promise<void> {
    this.blobs.set(hash, bytes.slice());
    return Promise.resolve();
  }

  markPendingUpload(hash: string, pending: boolean): Promise<void> {
    if (pending) this.pending.add(hash);
    else this.pending.delete(hash);
    return Promise.resolve();
  }

  pendingUploads(): Promise<string[]> {
    return Promise.resolve([...this.pending]);
  }

  list(): Promise<string[]> {
    return Promise.resolve([...this.blobs.keys()]);
  }

  remove(hash: string): Promise<void> {
    this.blobs.delete(hash);
    this.pending.delete(hash);
    return Promise.resolve();
  }

  readJournal(key: string): Promise<Uint8Array | undefined> {
    const bytes = this.journals.get(key);
    return Promise.resolve(bytes ? bytes.slice() : undefined);
  }

  writeJournal(key: string, bytes: Uint8Array | undefined): Promise<void> {
    if (bytes) this.journals.set(key, bytes.slice());
    else this.journals.delete(key);
    return Promise.resolve();
  }

  journalKeys(): Promise<string[]> {
    return Promise.resolve([...this.journals.keys()]);
  }
}

/** IndexedDB in its own database, so segment writes never queue behind workspace commits. */
export class IndexedDbSegmentBackend implements SegmentBackend {
  private store: UseStore | undefined;

  private db(): UseStore {
    this.store ??= createStore('canvink-ink-segments', 'segments');
    return this.store;
  }

  get(hash: string): Promise<Uint8Array | undefined> {
    return get<Uint8Array>(`blob:${hash}`, this.db());
  }

  put(hash: string, bytes: Uint8Array): Promise<void> {
    return set(`blob:${hash}`, bytes, this.db());
  }

  markPendingUpload(hash: string, pending: boolean): Promise<void> {
    return pending ? set(`upload:${hash}`, true, this.db()) : del(`upload:${hash}`, this.db());
  }

  async pendingUploads(): Promise<string[]> {
    return (await keys(this.db()))
      .flatMap((key) => (typeof key === 'string' && key.startsWith('upload:') ? [key.slice('upload:'.length)] : []));
  }

  async list(): Promise<string[]> {
    return (await keys(this.db()))
      .flatMap((key) => (typeof key === 'string' && key.startsWith('blob:') ? [key.slice('blob:'.length)] : []));
  }

  async remove(hash: string): Promise<void> {
    await del(`blob:${hash}`, this.db());
    await del(`upload:${hash}`, this.db());
  }

  readJournal(key: string): Promise<Uint8Array | undefined> {
    return get<Uint8Array>(`journal:${key}`, this.db());
  }

  writeJournal(key: string, bytes: Uint8Array | undefined): Promise<void> {
    return bytes ? set(`journal:${key}`, bytes, this.db()) : del(`journal:${key}`, this.db());
  }

  async journalKeys(): Promise<string[]> {
    return (await keys(this.db()))
      .flatMap((key) => (typeof key === 'string' && key.startsWith('journal:') ? [key.slice('journal:'.length)] : []));
  }
}

/** How many decoded strokes stay in memory beyond the ones pinned by loaded pages. */
const DEFAULT_UNPINNED_STROKE_BUDGET = 30_000;

export class InkSegmentStore {
  private readonly resident = new Map<string, ResidentSegment>();
  private readonly loading = new Map<string, Promise<ResidentSegment | undefined>>();
  private readonly pins = new Map<string, ReadonlySet<string>>();
  private readonly loadedListeners = new Set<(hashes: readonly string[]) => void>();
  private readonly storedListeners = new Set<(hash: string) => void>();
  private readonly remotes = new Map<string, SegmentRemote>();

  constructor(
    private backend: SegmentBackend,
    private readonly unpinnedStrokeBudget = DEFAULT_UNPINNED_STROKE_BUDGET,
  ) {}

  /** Replaces the backend and drops everything resident (tests and workspace switches). */
  reset(backend: SegmentBackend): void {
    this.backend = backend;
    this.resident.clear();
    this.loading.clear();
    this.pins.clear();
    this.remotes.clear();
  }

  /**
   * Registers (or, with undefined, removes) a place to fetch segments this device lacks: the
   * personal space, or one shared room. They are tried in the order they were added.
   */
  setRemote(key: string, remote: SegmentRemote | undefined): void {
    if (remote) this.remotes.set(key, remote);
    else this.remotes.delete(key);
  }

  /** Whether segments can be fetched from (and are uploaded to) some cloud at the moment. */
  hasRemote(): boolean {
    return this.remotes.size > 0;
  }

  /**
   * Removes a remote, but only if it is still the one registered under `key`: a session that closes
   * late must not unregister the session that replaced it.
   */
  removeRemote(key: string, remote: SegmentRemote): void {
    if (this.remotes.get(key) === remote) this.remotes.delete(key);
  }

  get localBackend(): SegmentBackend {
    return this.backend;
  }

  /** The decoded segment when it is resident; snapshots use this and never wait. */
  peek(hash: string): ResidentSegment | undefined {
    const segment = this.resident.get(hash);
    if (segment) {
      // Refresh recency: the Map keeps insertion order, the oldest entry is evicted first.
      this.resident.delete(hash);
      this.resident.set(hash, segment);
    }
    return segment;
  }

  /** Called with the hashes of segments that became resident after their page was first read. */
  onLoaded(listener: (hashes: readonly string[]) => void): () => void {
    this.loadedListeners.add(listener);
    return () => { this.loadedListeners.delete(listener); };
  }

  /** Called with the hash of every segment this device wrote (not those it downloaded). */
  onStored(listener: (hash: string) => void): () => void {
    this.storedListeners.add(listener);
    return () => { this.storedListeners.delete(listener); };
  }

  /** Keeps the segments a loaded page references resident until the pin is replaced or released. */
  pin(owner: string, hashes: Iterable<string>): void {
    this.pins.set(owner, new Set(hashes));
  }

  unpin(owner: string): void {
    this.pins.delete(owner);
    this.evict();
  }

  private become(hash: string, bytes: Uint8Array, strokes: StrokeElementV2[]): ResidentSegment {
    const byId = new Map(strokes.map((stroke) => [stroke.id, stroke] as const));
    const segment: ResidentSegment = {
      hash,
      strokes,
      ids: new Set(byId.keys()),
      byId,
      byteLength: bytes.byteLength,
    };
    this.resident.set(hash, segment);
    this.evict();
    return segment;
  }

  private evict(): void {
    const pinned = new Set<string>();
    for (const hashes of this.pins.values()) for (const hash of hashes) pinned.add(hash);
    let unpinnedStrokes = 0;
    for (const [hash, segment] of this.resident) if (!pinned.has(hash)) unpinnedStrokes += segment.strokes.length;
    for (const [hash, segment] of this.resident) {
      if (unpinnedStrokes <= this.unpinnedStrokeBudget) return;
      if (pinned.has(hash)) continue;
      this.resident.delete(hash);
      unpinnedStrokes -= segment.strokes.length;
    }
  }

  /**
   * Stores freshly encoded segment bytes and makes them resident. The blob is
   * durable when this resolves, so a document may reference the hash right after.
   * Returns the hash. New segments are queued for upload.
   */
  async put(bytes: Uint8Array): Promise<string> {
    const hash = await hashInkSegment(bytes);
    if (this.resident.has(hash)) {
      // Same content, same address: an idempotent write.
      await this.backend.put(hash, bytes);
      return hash;
    }
    const strokes = decodeInkSegment(bytes);
    await this.backend.put(hash, bytes);
    if (!(await this.backend.get(hash))) throw new Error('The ink segment could not be stored.');
    await this.backend.markPendingUpload(hash, true);
    this.become(hash, bytes, strokes);
    for (const listener of [...this.storedListeners]) listener(hash);
    return hash;
  }

  /** Adopts segment bytes downloaded from the cloud after checking them against their address. */
  async adopt(hash: string, bytes: Uint8Array): Promise<boolean> {
    if (!isInkSegmentHash(hash) || await hashInkSegment(bytes) !== hash) return false;
    const strokes = decodeInkSegment(bytes);
    await this.backend.put(hash, bytes);
    if (!this.resident.has(hash)) this.become(hash, bytes, strokes);
    return true;
  }

  /** The verified bytes of a locally stored segment, for uploads and exports. */
  async read(hash: string): Promise<Uint8Array | undefined> {
    const bytes = await this.backend.get(hash);
    if (!bytes) return undefined;
    if (await hashInkSegment(bytes) !== hash) throw new Error(`The stored ink segment ${hash} is corrupt.`);
    return bytes;
  }

  private async load(hash: string): Promise<ResidentSegment | undefined> {
    const known = this.resident.get(hash);
    if (known) return known;
    let bytes = await this.backend.get(hash);
    if (bytes && await hashInkSegment(bytes) !== hash) {
      // A damaged local copy is never used; the cloud copy replaces it when there is one.
      bytes = undefined;
    }
    for (const remote of [...this.remotes.values()]) {
      if (bytes) break;
      const fetched = await remote.fetch(hash).catch(() => undefined);
      if (fetched && await hashInkSegment(fetched) === hash) {
        await this.backend.put(hash, fetched);
        bytes = fetched;
      }
    }
    if (!bytes) return undefined;
    return this.resident.get(hash) ?? this.become(hash, bytes, decodeInkSegment(bytes));
  }

  private start(hash: string): Promise<ResidentSegment | undefined> {
    let pending = this.loading.get(hash);
    if (!pending) {
      pending = this.load(hash)
        .then((segment) => {
          // Also for a segment that arrives after the caller stopped waiting for it.
          if (segment) for (const listener of [...this.loadedListeners]) listener([hash]);
          return segment;
        })
        .finally(() => { this.loading.delete(hash); });
      this.loading.set(hash, pending);
    }
    return pending;
  }

  /**
   * Makes the segments resident: from memory, else the local store, else the
   * cloud. Resolves with the hashes that could not be found anywhere (yet), or
   * that were still on their way when `remoteWaitMs` ran out; those keep
   * loading, and `onLoaded` reports them when they arrive. All segments load
   * at once, and each one decodes in a task of its own, so a page with many
   * segments never blocks the main thread for long.
   */
  async ensure(hashes: Iterable<string>, options: { remoteWaitMs?: number } = {}): Promise<string[]> {
    const started: Array<[string, Promise<ResidentSegment | undefined>]> = [];
    for (const hash of new Set(hashes)) {
      if (!this.resident.has(hash)) started.push([hash, this.start(hash)]);
    }
    const deadline = options.remoteWaitMs === undefined ? Number.POSITIVE_INFINITY : Date.now() + options.remoteWaitMs;
    const missing: string[] = [];
    for (const [hash, pending] of started) {
      const remaining = deadline - Date.now();
      let segment: ResidentSegment | undefined;
      if (remaining === Number.POSITIVE_INFINITY) segment = await pending;
      else {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), Math.max(0, remaining)); });
        segment = await Promise.race([pending, timeout]);
        clearTimeout(timer);
      }
      if (!segment) missing.push(hash);
    }
    return missing;
  }
}

let shared: InkSegmentStore | undefined;

/** The app's segment store. Created on first use so importing this module touches no storage. */
export function inkSegments(): InkSegmentStore {
  // Without IndexedDB (Node scripts, unit tests) segments live in memory for the process.
  shared ??= new InkSegmentStore(typeof indexedDB === 'undefined' ? new MemorySegmentBackend() : new IndexedDbSegmentBackend());
  return shared;
}

/** Test seam: replaces the shared store's backend and clears what is resident. */
export function resetInkSegments(backend: SegmentBackend = new MemorySegmentBackend()): InkSegmentStore {
  const store = inkSegments();
  store.reset(backend);
  return store;
}

/** The resident segment for `hash`, if any. Snapshot code uses this synchronously. */
export function peekInkSegment(hash: string): ResidentSegment | undefined {
  return shared?.peek(hash);
}
