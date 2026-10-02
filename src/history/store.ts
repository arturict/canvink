import { createStore, get } from 'idb-keyval';
import { sha256Bytes, type Sha256Checksum } from '../domain/v2';
import type {
  HistorySnapshot,
  HistorySnapshotKind,
  HistorySnapshotMetadata,
  HistorySnapshotStore,
} from './types';

const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const MAX_LIST_LIMIT = 100;
const HISTORY_KEY_PREFIX = 'history-snapshot:';
/** Beside each snapshot record: its metadata alone, small enough to list without reading the page bytes. */
const HISTORY_METADATA_KEY_PREFIX = 'history-snapshot-meta:';

type TauriInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

interface NativeSnapshotMetadata {
  snapshotId: string;
  documentId: string;
  name: string | null;
  heads: string[];
  sha256: string;
  byteSize: number;
  createdAt: string;
}

interface NativeSnapshotBlob {
  metadata: NativeSnapshotMetadata;
  bytes: number[];
}

interface EncodedHistoryContext {
  v: 1;
  name?: string;
  deviceId: string;
  kind: HistorySnapshotKind;
  pageId: string;
}

async function defaultInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(command, args);
}

function assertChecksum(value: string): asserts value is Sha256Checksum {
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) throw new Error('History checksum is invalid.');
}

function assertByteArray(value: unknown, label: string): asserts value is number[] {
  if (
    !Array.isArray(value)
    || value.length === 0
    || value.length > MAX_SNAPSHOT_BYTES
    || value.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)
  ) throw new Error(`${label} is not a bounded byte array.`);
}

function encodeContext(snapshot: HistorySnapshotMetadata): string {
  return JSON.stringify({
    v: 1,
    ...(snapshot.name ? { name: snapshot.name } : {}),
    deviceId: snapshot.deviceId,
    kind: snapshot.kind,
    pageId: snapshot.pageId,
  } satisfies EncodedHistoryContext);
}

function decodeContext(value: string | null, documentId: string): EncodedHistoryContext {
  let parsed: unknown;
  try {
    parsed = value === null ? undefined : JSON.parse(value);
  } catch {
    throw new Error('History snapshot metadata is corrupt.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      v: 1,
      deviceId: 'legacy',
      kind: 'manual',
      pageId: documentId.startsWith('page:') ? documentId.slice(5) : documentId,
    };
  }
  const record = parsed as Partial<EncodedHistoryContext>;
  if (
    record.v !== 1
    || typeof record.deviceId !== 'string'
    || !record.deviceId
    || !['manual', 'automatic', 'trash'].includes(record.kind ?? '')
    || typeof record.pageId !== 'string'
    || !record.pageId
    || (record.name !== undefined && typeof record.name !== 'string')
  ) throw new Error('History snapshot metadata is corrupt.');
  return record as EncodedHistoryContext;
}

function parseNativeMetadata(value: unknown): HistorySnapshotMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Native history metadata is invalid.');
  }
  const item = value as Partial<NativeSnapshotMetadata>;
  if (
    typeof item.snapshotId !== 'string'
    || typeof item.documentId !== 'string'
    || (item.name !== null && typeof item.name !== 'string')
    || !Array.isArray(item.heads)
    || item.heads.some((head) => typeof head !== 'string' || !head)
    || typeof item.sha256 !== 'string'
    || typeof item.byteSize !== 'number'
    || !Number.isSafeInteger(item.byteSize)
    || item.byteSize <= 0
    || typeof item.createdAt !== 'string'
  ) throw new Error('Native history metadata is invalid.');
  assertChecksum(item.sha256);
  const context = decodeContext(item.name, item.documentId);
  return {
    version: 1,
    snapshotId: item.snapshotId,
    documentId: item.documentId,
    pageId: context.pageId,
    ...(context.name ? { name: context.name } : {}),
    deviceId: context.deviceId,
    kind: context.kind,
    heads: [...item.heads],
    checksum: item.sha256,
    size: item.byteSize,
    createdAt: item.createdAt,
  };
}

async function verifySnapshot(snapshot: HistorySnapshot): Promise<HistorySnapshot> {
  if (
    snapshot.version !== 1
    || !snapshot.snapshotId
    || !snapshot.documentId
    || !snapshot.pageId
    || !snapshot.deviceId
    || !['manual', 'automatic', 'trash'].includes(snapshot.kind)
    || snapshot.bytes.byteLength === 0
    || snapshot.bytes.byteLength > MAX_SNAPSHOT_BYTES
    || snapshot.size !== snapshot.bytes.byteLength
    || Number.isNaN(Date.parse(snapshot.createdAt))
  ) throw new Error('History snapshot is invalid.');
  assertChecksum(snapshot.checksum);
  if (await sha256Bytes(snapshot.bytes) !== snapshot.checksum) {
    throw new Error(`History snapshot ${snapshot.snapshotId} failed integrity verification.`);
  }
  return snapshot;
}

export class TauriHistorySnapshotStore implements HistorySnapshotStore {
  constructor(private readonly invoke: TauriInvoke = defaultInvoke) {}

  async put(snapshot: HistorySnapshot): Promise<HistorySnapshotMetadata> {
    await verifySnapshot(snapshot);
    const response = await this.invoke<unknown>('v2_put_snapshot', {
      request: {
        snapshotId: snapshot.snapshotId,
        documentId: snapshot.documentId,
        name: encodeContext(snapshot),
        heads: snapshot.heads,
        expectedSha256: snapshot.checksum,
        bytes: [...snapshot.bytes],
        createdAt: snapshot.createdAt,
      },
    });
    return parseNativeMetadata(response);
  }

  async get(snapshotId: string): Promise<HistorySnapshot | undefined> {
    const response = await this.invoke<unknown>('v2_get_snapshot', { snapshotId });
    if (response === null || response === undefined) return undefined;
    if (!response || typeof response !== 'object' || Array.isArray(response)) {
      throw new Error('Native history snapshot is invalid.');
    }
    const blob = response as Partial<NativeSnapshotBlob>;
    const metadata = parseNativeMetadata(blob.metadata);
    assertByteArray(blob.bytes, 'Native history bytes');
    return verifySnapshot({ ...metadata, bytes: Uint8Array.from(blob.bytes) });
  }

  async list(documentId: string, limit = MAX_LIST_LIMIT): Promise<HistorySnapshotMetadata[]> {
    const response = await this.invoke<unknown>('v2_list_snapshots', {
      documentId,
      limit: Math.min(MAX_LIST_LIMIT, Math.max(1, limit)),
    });
    if (!Array.isArray(response)) throw new Error('Native history list is invalid.');
    return response.map(parseNativeMetadata);
  }

  deleteGuarded(snapshotId: string, expectedChecksum: Sha256Checksum): Promise<boolean> {
    return this.invoke<boolean>('v2_delete_snapshot_guarded', {
      request: { snapshotId, expectedSha256: expectedChecksum },
    });
  }
}

export class BrowserHistorySnapshotStore implements HistorySnapshotStore {
  private readonly persistence: BrowserHistoryPersistence;

  constructor(persistence: BrowserHistoryPersistence = new IndexedDbHistoryPersistence()) {
    this.persistence = persistence;
  }

  private key(snapshotId: string): string {
    return `${HISTORY_KEY_PREFIX}${snapshotId}`;
  }

  private metadataKey(snapshotId: string): string {
    return `${HISTORY_METADATA_KEY_PREFIX}${snapshotId}`;
  }

  async put(snapshot: HistorySnapshot): Promise<HistorySnapshotMetadata> {
    const checked = await verifySnapshot(structuredClone(snapshot));
    const existing = await this.get(snapshot.snapshotId);
    if (existing) {
      if (existing.checksum !== snapshot.checksum) {
        throw new Error('Snapshot ID is already used for different history content.');
      }
      const { bytes: _bytes, ...metadata } = existing;
      void _bytes;
      return metadata;
    }
    const { bytes: _bytes, ...metadata } = checked;
    void _bytes;
    await this.persistence.setAll([
      [this.key(snapshot.snapshotId), checked],
      [this.metadataKey(snapshot.snapshotId), metadata],
    ]);
    return metadata;
  }

  async get(snapshotId: string): Promise<HistorySnapshot | undefined> {
    const snapshot = await this.persistence.get<HistorySnapshot>(this.key(snapshotId));
    return snapshot ? verifySnapshot(structuredClone(snapshot)) : undefined;
  }

  /**
   * A snapshot record holds the whole page, so listing reads the small
   * metadata record kept beside each one instead (the automatic snapshot
   * check lists on every page open). Snapshots written before those records
   * existed get theirs on first listing.
   */
  async list(documentId: string, limit = MAX_LIST_LIMIT): Promise<HistorySnapshotMetadata[]> {
    const [snapshotKeys, metadata] = await Promise.all([
      this.persistence.keys(HISTORY_KEY_PREFIX),
      this.persistence.entries<HistorySnapshotMetadata>(HISTORY_METADATA_KEY_PREFIX),
    ]);
    const stored = new Set(snapshotKeys);
    const known = new Map<string, HistorySnapshotMetadata>();
    for (const [, item] of metadata) {
      // A record whose snapshot is gone (deleted by an older version) is ignored.
      if (stored.has(this.key(item.snapshotId))) known.set(item.snapshotId, item);
    }
    for (const snapshotKey of snapshotKeys) {
      const snapshotId = snapshotKey.slice(HISTORY_KEY_PREFIX.length);
      if (known.has(snapshotId)) continue;
      const snapshot = await this.persistence.get<HistorySnapshot>(snapshotKey);
      if (!snapshot) continue;
      const { bytes: _bytes, ...backfilled } = snapshot;
      void _bytes;
      await this.persistence.setAll([[this.metadataKey(snapshotId), backfilled]]);
      known.set(snapshotId, backfilled);
    }
    return [...known.values()]
      .filter((item) => item.documentId === documentId)
      .map((item) => structuredClone(item))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt)
        || right.snapshotId.localeCompare(left.snapshotId))
      .slice(0, Math.min(MAX_LIST_LIMIT, Math.max(1, limit)));
  }

  async deleteGuarded(snapshotId: string, expectedChecksum: Sha256Checksum): Promise<boolean> {
    const existing = await this.get(snapshotId);
    if (!existing) return false;
    if (existing.checksum !== expectedChecksum) {
      throw new Error('History snapshot changed before guarded deletion.');
    }
    await this.persistence.deleteAll([this.key(snapshotId), this.metadataKey(snapshotId)]);
    return true;
  }
}

export interface BrowserHistoryPersistence {
  get<T>(key: string): Promise<T | undefined>;
  /** Writes every record in one transaction, so a snapshot and its metadata stay together. */
  setAll(records: ReadonlyArray<readonly [string, unknown]>): Promise<void>;
  /** Records whose key starts with `prefix` (the store holds the whole workspace, not only history). */
  entries<T>(prefix: string): Promise<Array<[string, T]>>;
  /** Keys starting with `prefix`, read without their values. */
  keys(prefix: string): Promise<string[]>;
  /** Removes every key in one transaction. */
  deleteAll(keys: readonly string[]): Promise<void>;
}

class IndexedDbHistoryPersistence implements BrowserHistoryPersistence {
  // Reuse the existing schema-v2 object store. idb-keyval's helper opens a
  // fixed database version and therefore cannot add a second store after the
  // activation store has already created the database.
  private readonly store = createStore('canvink-v2', 'documents-assets');

  get<T>(key: string): Promise<T | undefined> {
    return get<T>(key, this.store);
  }

  setAll(records: ReadonlyArray<readonly [string, unknown]>): Promise<void> {
    return this.store('readwrite', (objectStore) => {
      for (const [key, value] of records) objectStore.put(value, key);
      return transactionDone(objectStore.transaction);
    });
  }

  deleteAll(keys: readonly string[]): Promise<void> {
    return this.store('readwrite', (objectStore) => {
      for (const key of keys) objectStore.delete(key);
      return transactionDone(objectStore.transaction);
    });
  }

  entries<T>(prefix: string): Promise<Array<[string, T]>> {
    return this.store('readonly', (objectStore) => new Promise<Array<[string, T]>>((resolve, reject) => {
      const found: Array<[string, T]> = [];
      const request = objectStore.openCursor(prefixRange(prefix));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve(found);
          return;
        }
        found.push([String(cursor.key), cursor.value as T]);
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
    }));
  }

  keys(prefix: string): Promise<string[]> {
    return this.store('readonly', (objectStore) => new Promise<string[]>((resolve, reject) => {
      const found: string[] = [];
      const request = objectStore.openKeyCursor(prefixRange(prefix));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve(found);
          return;
        }
        found.push(String(cursor.key));
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
    }));
  }
}

/** Every string key that starts with the prefix sorts between the prefix and the prefix plus the highest code unit. */
function prefixRange(prefix: string): IDBKeyRange {
  return IDBKeyRange.bound(prefix, `${prefix}\uffff`);
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

export function createPlatformHistorySnapshotStore(): HistorySnapshotStore {
  return typeof window !== 'undefined' && typeof window.__TAURI_INTERNALS__ !== 'undefined'
    ? new TauriHistorySnapshotStore()
    : new BrowserHistorySnapshotStore();
}
