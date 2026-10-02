import type {
  Chunk,
  StorageAdapterInterface,
  StorageKey,
} from '@automerge/automerge-repo';

const utf8Encoder = new TextEncoder();

export interface CanvinkStorageAdapterLimits {
  maxKeySegments: number;
  maxKeyBytes: number;
  maxSegmentBytes: number;
  maxDataBytes: number;
  maxRangeEntries: number;
  maxRangeBytes: number;
  maxAtomicMutations: number;
  maxAtomicWriteBytes: number;
}

export const DEFAULT_CANVINK_STORAGE_LIMITS = Object.freeze({
  maxKeySegments: 32,
  maxKeyBytes: 16 * 1024,
  maxSegmentBytes: 4 * 1024,
  maxDataBytes: 32 * 1024 * 1024,
  maxRangeEntries: 10_000,
  maxRangeBytes: 128 * 1024 * 1024,
  maxAtomicMutations: 20_000,
  maxAtomicWriteBytes: 256 * 1024 * 1024,
}) satisfies Readonly<CanvinkStorageAdapterLimits>;

export interface CanvinkStorageScanLimits {
  maxEntries: number;
  maxBytes: number;
}

export type CanvinkStorageMutation =
  | { type: 'save'; key: readonly string[]; data: Uint8Array }
  | { type: 'remove'; key: readonly string[] };

export interface CanvinkAtomicCommitPlan {
  /** Automerge Repo keys. The adapter's namespace is added as another array segment. */
  repo?: readonly CanvinkStorageMutation[];
  /** Absolute hierarchical keys for assets, manifests, and activation records. */
  shared?: readonly CanvinkStorageMutation[];
}

export interface CanvinkStorageRecord {
  key: string[];
  data: Uint8Array;
}

/**
 * Binary transactional bridge implemented by IndexedDB here and by native or
 * in-memory stores elsewhere. `commit` must apply every mutation or none.
 */
export interface CanvinkStorageBridge {
  load(key: readonly string[]): Promise<Uint8Array | undefined>;
  loadRange(
    keyPrefix: readonly string[],
    limits: CanvinkStorageScanLimits,
  ): Promise<CanvinkStorageRecord[]>;
  commit(mutations: readonly CanvinkStorageMutation[]): Promise<void>;
  removeRange(
    keyPrefix: readonly string[],
    limits: CanvinkStorageScanLimits,
  ): Promise<void>;
  close?(): void | Promise<void>;
}

export interface CanvinkStorageAdapterOptions {
  bridge?: CanvinkStorageBridge;
  /**
   * When set, every save of an Automerge document chunk
   * (`[documentId, 'snapshot' | 'incremental', hash]`) also writes the marker
   * `[dirtyNamespace, documentId, '<type>:<hash>']` in the same atomic
   * commit. Derived per-document indexes use the markers to detect that a
   * document changed after they were written, including across a crash.
   */
  dirtyNamespace?: string;
  namespace?: readonly string[];
  limits?: Partial<CanvinkStorageAdapterLimits>;
  indexedDB?: IDBFactory;
  databaseName?: string;
  objectStoreName?: string;
  databaseVersion?: number;
  onBlocked?: () => void;
  onVersionChange?: (event: IDBVersionChangeEvent) => void;
}

export interface IndexedDbCanvinkStorageBridgeOptions {
  indexedDB?: IDBFactory;
  databaseName?: string;
  objectStoreName?: string;
  databaseVersion?: number;
  onBlocked?: () => void;
  onVersionChange?: (event: IDBVersionChangeEvent) => void;
}

export class CanvinkStorageBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanvinkStorageBlockedError';
  }
}

function resolveLimits(
  overrides: Partial<CanvinkStorageAdapterLimits> = {},
): CanvinkStorageAdapterLimits {
  const limits = { ...DEFAULT_CANVINK_STORAGE_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`Storage limit ${name} must be a positive safe integer.`);
    }
  }
  if (limits.maxDataBytes > limits.maxRangeBytes) {
    throw new Error('maxDataBytes cannot exceed maxRangeBytes.');
  }
  return limits;
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

function validateKey(
  input: readonly string[],
  label: string,
  limits: CanvinkStorageAdapterLimits,
  allowEmpty: boolean,
): string[] {
  if (!Array.isArray(input) || (!allowEmpty && input.length === 0)) {
    throw new Error(`${label} must be a non-empty array of strings.`);
  }
  if (input.length > limits.maxKeySegments) {
    throw new Error(`${label} has too many segments.`);
  }
  let totalBytes = 0;
  const key = input.map((segment, index) => {
    if (
      typeof segment !== 'string' ||
      segment.length === 0 ||
      hasControlCharacter(segment)
    ) {
      throw new Error(`${label} segment ${index + 1} is empty or contains control characters.`);
    }
    const bytes = utf8Encoder.encode(segment).byteLength;
    if (bytes > limits.maxSegmentBytes) {
      throw new Error(`${label} segment ${index + 1} exceeds the byte limit.`);
    }
    totalBytes += bytes;
    return segment;
  });
  if (totalBytes > limits.maxKeyBytes) throw new Error(`${label} exceeds the byte limit.`);
  return key;
}

function cloneData(
  input: Uint8Array,
  label: string,
  limits: CanvinkStorageAdapterLimits,
): Uint8Array {
  if (!(input instanceof Uint8Array)) throw new Error(`${label} must be a Uint8Array.`);
  if (input.byteLength > limits.maxDataBytes) {
    throw new Error(`${label} exceeds the ${limits.maxDataBytes}-byte limit.`);
  }
  return Uint8Array.from(input);
}

function keysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((segment, index) => segment === right[index]);
}

function hasKeyPrefix(key: readonly string[], prefix: readonly string[]): boolean {
  return prefix.length <= key.length && prefix.every((segment, index) => key[index] === segment);
}

function compareKeys(left: readonly string[], right: readonly string[]): number {
  if (hasKeyPrefix(left, right) || hasKeyPrefix(right, left)) {
    return left.length - right.length;
  }
  // Repo chunk keys conventionally end in a content hash. Ordering by the
  // terminal segment first keeps acceptance-test insertion independent while
  // making chunk scans deterministic across IndexedDB and native bridges.
  const leftTerminal = left.at(-1) ?? '';
  const rightTerminal = right.at(-1) ?? '';
  if (leftTerminal < rightTerminal) return -1;
  if (leftTerminal > rightTerminal) return 1;
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] < right[index]) return -1;
    if (left[index] > right[index]) return 1;
  }
  return left.length - right.length;
}

function scanLimits(limits: CanvinkStorageAdapterLimits): CanvinkStorageScanLimits {
  return { maxEntries: limits.maxRangeEntries, maxBytes: limits.maxRangeBytes };
}

function validateRecords(
  records: CanvinkStorageRecord[],
  prefix: readonly string[],
  limits: CanvinkStorageAdapterLimits,
): CanvinkStorageRecord[] {
  if (records.length > limits.maxRangeEntries) {
    throw new Error('Storage range contains too many entries.');
  }
  let totalBytes = 0;
  const seen: string[][] = [];
  const result = records.map((record, index) => {
    const key = validateKey(record.key, `Stored range key ${index + 1}`, limits, false);
    if (!hasKeyPrefix(key, prefix)) throw new Error('Storage bridge returned a key outside the range.');
    if (seen.some((candidate) => keysEqual(candidate, key))) {
      throw new Error('Storage bridge returned a duplicate key.');
    }
    seen.push(key);
    const data = cloneData(record.data, `Stored range value ${index + 1}`, limits);
    totalBytes += data.byteLength;
    if (totalBytes > limits.maxRangeBytes) throw new Error('Storage range exceeds the byte limit.');
    return { key, data };
  });
  return result.sort((left, right) => compareKeys(left.key, right.key));
}

const DIRTY_MARKER_VALUE = Uint8Array.of(1);

/** Exact Automerge Repo 2.5.6 storage interface with a shared atomic commit hook. */
export class CanvinkStorageAdapter implements StorageAdapterInterface {
  readonly namespace: readonly string[];
  readonly limits: Readonly<CanvinkStorageAdapterLimits>;
  private readonly bridge: CanvinkStorageBridge;
  private readonly dirtyNamespace?: string;

  constructor(options: CanvinkStorageAdapterOptions = {}) {
    this.limits = Object.freeze(resolveLimits(options.limits));
    this.namespace = Object.freeze(
      validateKey(options.namespace ?? ['automerge-repo'], 'Repo namespace', this.limits, false),
    );
    if (options.dirtyNamespace !== undefined) {
      const [dirty] = validateKey([options.dirtyNamespace], 'Dirty namespace', this.limits, false);
      if (dirty === this.namespace[0]) throw new Error('The dirty namespace overlaps the Repo namespace.');
      this.dirtyNamespace = dirty;
    }
    this.bridge =
      options.bridge ??
      new IndexedDbCanvinkStorageBridge({
        indexedDB: options.indexedDB,
        databaseName: options.databaseName,
        objectStoreName: options.objectStoreName,
        databaseVersion: options.databaseVersion,
        onBlocked: options.onBlocked,
        onVersionChange: options.onVersionChange,
      });
  }

  async load(key: StorageKey): Promise<Uint8Array | undefined> {
    const physicalKey = this.repoStorageKey(key);
    const value = await this.bridge.load(physicalKey);
    return value === undefined ? undefined : cloneData(value, 'Stored value', this.limits);
  }

  save(key: StorageKey, data: Uint8Array): Promise<void> {
    const mutation: CanvinkStorageMutation = {
      type: 'save',
      key: this.repoStorageKey(key),
      data: cloneData(data, 'Stored value', this.limits),
    };
    const marker = this.dirtyMarkerKey(key);
    return this.bridge.commit(marker
      ? [mutation, { type: 'save', key: marker, data: DIRTY_MARKER_VALUE }]
      : [mutation]);
  }

  /** Reads absolute keys outside the Repo namespace, such as derived indexes. */
  async loadShared(keyPrefix: readonly string[]): Promise<CanvinkStorageRecord[]> {
    const prefix = validateKey(keyPrefix, 'Shared key prefix', this.limits, false);
    if (hasKeyPrefix(prefix, this.namespace)) {
      throw new Error('Shared reads cannot target the Automerge Repo namespace.');
    }
    return validateRecords(
      await this.bridge.loadRange(prefix, scanLimits(this.limits)),
      prefix,
      this.limits,
    );
  }

  private dirtyMarkerKey(key: StorageKey): string[] | undefined {
    if (
      !this.dirtyNamespace
      || key.length !== 3
      || (key[1] !== 'snapshot' && key[1] !== 'incremental')
    ) return undefined;
    return validateKey(
      [this.dirtyNamespace, key[0], `${key[1]}:${key[2]}`],
      'Dirty marker key',
      this.limits,
      false,
    );
  }

  remove(key: StorageKey): Promise<void> {
    return this.bridge.commit([{ type: 'remove', key: this.repoStorageKey(key) }]);
  }

  async loadRange(keyPrefix: StorageKey): Promise<Chunk[]> {
    const logicalPrefix = validateKey(
      keyPrefix,
      'Repo key prefix',
      this.limits,
      true,
    );
    const physicalPrefix = this.physicalRepoKey(logicalPrefix);
    const records = validateRecords(
      await this.bridge.loadRange(physicalPrefix, scanLimits(this.limits)),
      physicalPrefix,
      this.limits,
    );
    return records.map(({ key, data }) => {
      const logicalKey = key.slice(this.namespace.length);
      if (logicalKey.length === 0) throw new Error('Storage contains an invalid empty Repo key.');
      return { key: logicalKey, data: Uint8Array.from(data) };
    });
  }

  removeRange(keyPrefix: StorageKey): Promise<void> {
    const logicalPrefix = validateKey(
      keyPrefix,
      'Repo key prefix',
      this.limits,
      true,
    );
    return this.bridge.removeRange(
      this.physicalRepoKey(logicalPrefix),
      scanLimits(this.limits),
    );
  }

  /** Convert an Automerge key to its non-ambiguous physical hierarchical key. */
  repoStorageKey(key: readonly string[]): string[] {
    return this.physicalRepoKey(
      validateKey(key, 'Repo storage key', this.limits, false),
    );
  }

  /**
   * Atomically commit Repo chunks together with asset or activation bytes.
   * Prepare hashes and serialization before calling this method; the bridge
   * transaction must contain storage work only.
   */
  commitAtomically(plan: CanvinkAtomicCommitPlan): Promise<void> {
    const repo = plan.repo ?? [];
    const shared = plan.shared ?? [];
    if (repo.length + shared.length === 0) return Promise.resolve();
    if (repo.length + shared.length > this.limits.maxAtomicMutations) {
      throw new Error('Atomic storage commit has too many mutations.');
    }
    let writeBytes = 0;
    const prepareMutation = (
      mutation: CanvinkStorageMutation,
      key: string[],
      label: string,
    ): CanvinkStorageMutation => {
      if (mutation.type === 'remove') return { type: 'remove', key };
      const data = cloneData(mutation.data, label, this.limits);
      writeBytes += data.byteLength;
      if (writeBytes > this.limits.maxAtomicWriteBytes) {
        throw new Error('Atomic storage commit exceeds the byte limit.');
      }
      return { type: 'save', key, data };
    };
    const mutations: CanvinkStorageMutation[] = repo.map((mutation, index) =>
      prepareMutation(
        mutation,
        this.repoStorageKey(mutation.key),
        `Atomic Repo value ${index + 1}`,
      ),
    );
    shared.forEach((mutation, index) => {
      const key = validateKey(
        mutation.key,
        `Atomic shared key ${index + 1}`,
        this.limits,
        false,
      );
      if (hasKeyPrefix(key, this.namespace)) {
        throw new Error('Atomic shared key overlaps the Automerge Repo namespace.');
      }
      mutations.push(
        prepareMutation(mutation, key, `Atomic shared value ${index + 1}`),
      );
    });
    return this.bridge.commit(mutations);
  }

  close(): void | Promise<void> {
    return this.bridge.close?.();
  }

  private physicalRepoKey(logicalKey: readonly string[]): string[] {
    return validateKey(
      [...this.namespace, ...logicalKey],
      'Physical Repo storage key',
      this.limits,
      false,
    );
  }
}

export class MemoryCanvinkStorageBridge implements CanvinkStorageBridge {
  private records: CanvinkStorageRecord[] = [];
  private failAfterMutation: number | undefined;

  /** Test/native-fallback fault injection; the next commit aborts without publishing its shadow. */
  failNextCommit(afterMutation: number): void {
    if (!Number.isSafeInteger(afterMutation) || afterMutation < 0) {
      throw new Error('Failure index must be a non-negative safe integer.');
    }
    this.failAfterMutation = afterMutation;
  }

  async load(key: readonly string[]): Promise<Uint8Array | undefined> {
    const record = this.records.find((candidate) => keysEqual(candidate.key, key));
    return record ? Uint8Array.from(record.data) : undefined;
  }

  async loadRange(
    keyPrefix: readonly string[],
    limits: CanvinkStorageScanLimits,
  ): Promise<CanvinkStorageRecord[]> {
    const matches = this.records
      .filter((record) => hasKeyPrefix(record.key, keyPrefix))
      .sort((left, right) => compareKeys(left.key, right.key));
    let bytes = 0;
    if (matches.length > limits.maxEntries) throw new Error('Storage range contains too many entries.');
    return matches.map((record) => {
      bytes += record.data.byteLength;
      if (bytes > limits.maxBytes) throw new Error('Storage range exceeds the byte limit.');
      return { key: [...record.key], data: Uint8Array.from(record.data) };
    });
  }

  async commit(mutations: readonly CanvinkStorageMutation[]): Promise<void> {
    const shadow = this.records.map((record) => ({
      key: [...record.key],
      data: Uint8Array.from(record.data),
    }));
    const failureIndex = this.failAfterMutation;
    this.failAfterMutation = undefined;
    for (const [index, mutation] of mutations.entries()) {
      const existing = shadow.findIndex((record) => keysEqual(record.key, mutation.key));
      if (mutation.type === 'remove') {
        if (existing >= 0) shadow.splice(existing, 1);
      } else {
        const record = { key: [...mutation.key], data: Uint8Array.from(mutation.data) };
        if (existing >= 0) shadow[existing] = record;
        else shadow.push(record);
      }
      if (failureIndex === index) throw new Error('Simulated atomic storage crash.');
    }
    this.records = shadow;
  }

  async removeRange(
    keyPrefix: readonly string[],
    limits: CanvinkStorageScanLimits,
  ): Promise<void> {
    const matches = this.records.filter((record) => hasKeyPrefix(record.key, keyPrefix));
    if (matches.length > limits.maxEntries) throw new Error('Storage range contains too many entries.');
    const bytes = matches.reduce((total, record) => total + record.data.byteLength, 0);
    if (bytes > limits.maxBytes) throw new Error('Storage range exceeds the byte limit.');
    this.records = this.records.filter((record) => !hasKeyPrefix(record.key, keyPrefix));
  }
}

function transactionCompletion(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted.'));
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed.'));
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed.'));
  });
}

function idbKey(key: readonly string[]): string[] {
  return [...key];
}

function isStringKey(value: IDBValidKey): value is string[] {
  return Array.isArray(value) && value.every((segment) => typeof segment === 'string');
}

export class IndexedDbCanvinkStorageBridge implements CanvinkStorageBridge {
  private readonly factory: IDBFactory;
  private readonly databaseName: string;
  private readonly objectStoreName: string;
  private readonly databaseVersion: number;
  private readonly onBlocked?: () => void;
  private readonly onVersionChange?: (event: IDBVersionChangeEvent) => void;
  private readonly database: Promise<IDBDatabase>;
  private closed = false;
  private versionChanged = false;

  constructor(options: IndexedDbCanvinkStorageBridgeOptions = {}) {
    const factory = options.indexedDB ?? globalThis.indexedDB;
    if (!factory) throw new Error('IndexedDB is unavailable in this runtime.');
    this.factory = factory;
    this.databaseName = options.databaseName ?? 'canvink-v2';
    this.objectStoreName = options.objectStoreName ?? 'documents-assets-repo';
    this.databaseVersion = options.databaseVersion ?? 1;
    this.onBlocked = options.onBlocked;
    this.onVersionChange = options.onVersionChange;
    if (!this.databaseName || !this.objectStoreName) {
      throw new Error('IndexedDB database and object-store names must be non-empty.');
    }
    if (!Number.isSafeInteger(this.databaseVersion) || this.databaseVersion < 1) {
      throw new Error('IndexedDB database version must be a positive safe integer.');
    }
    this.database = this.open();
  }

  async load(key: readonly string[]): Promise<Uint8Array | undefined> {
    const db = await this.getDatabase();
    const transaction = db.transaction(this.objectStoreName, 'readonly');
    const completion = transactionCompletion(transaction);
    const value = await requestResult<unknown>(transaction.objectStore(this.objectStoreName).get(idbKey(key)));
    await completion;
    if (value === undefined) return undefined;
    if (!(value instanceof Uint8Array)) throw new Error('IndexedDB storage value is not binary data.');
    return Uint8Array.from(value);
  }

  async loadRange(
    keyPrefix: readonly string[],
    limits: CanvinkStorageScanLimits,
  ): Promise<CanvinkStorageRecord[]> {
    return this.scan(keyPrefix, limits, false);
  }

  async commit(mutations: readonly CanvinkStorageMutation[]): Promise<void> {
    if (mutations.length === 0) return;
    const db = await this.getDatabase();
    const transaction = db.transaction(this.objectStoreName, 'readwrite');
    const completion = transactionCompletion(transaction);
    const store = transaction.objectStore(this.objectStoreName);
    try {
      for (const mutation of mutations) {
        if (mutation.type === 'save') store.put(Uint8Array.from(mutation.data), idbKey(mutation.key));
        else store.delete(idbKey(mutation.key));
      }
    } catch (error) {
      transaction.abort();
      await completion.catch(() => undefined);
      throw error;
    }
    await completion;
  }

  async removeRange(
    keyPrefix: readonly string[],
    limits: CanvinkStorageScanLimits,
  ): Promise<void> {
    await this.scan(keyPrefix, limits, true);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const database = await this.database.catch(() => undefined);
    database?.close();
  }

  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = this.factory.open(this.databaseName, this.databaseVersion);
      let settled = false;
      const rejectOnce = (error: unknown): void => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(this.objectStoreName)) {
          request.result.createObjectStore(this.objectStoreName);
        }
      };
      request.onblocked = () => {
        try {
          this.onBlocked?.();
        } catch {
          // Coordination hooks are observational and cannot keep the open pending.
        }
        rejectOnce(
          new CanvinkStorageBlockedError(
            `IndexedDB upgrade for ${this.databaseName} is blocked by another open connection.`,
          ),
        );
      };
      request.onerror = () => rejectOnce(request.error ?? new Error('Could not open IndexedDB.'));
      request.onsuccess = () => {
        const database = request.result;
        if (settled || this.closed) {
          database.close();
          if (!settled) rejectOnce(new Error('IndexedDB bridge was closed before opening.'));
          return;
        }
        if (!database.objectStoreNames.contains(this.objectStoreName)) {
          database.close();
          rejectOnce(
            new Error(
              `IndexedDB ${this.databaseName} does not contain object store ${this.objectStoreName}.`,
            ),
          );
          return;
        }
        database.onversionchange = (event) => {
          this.versionChanged = true;
          database.close();
          this.onVersionChange?.(event);
        };
        settled = true;
        resolve(database);
      };
    });
  }

  private async getDatabase(): Promise<IDBDatabase> {
    if (this.closed) throw new Error('IndexedDB storage bridge is closed.');
    if (this.versionChanged) {
      throw new CanvinkStorageBlockedError(
        'IndexedDB version changed; create a new adapter after the upgrade completes.',
      );
    }
    const database = await this.database;
    if (this.closed || this.versionChanged) {
      database.close();
      throw new CanvinkStorageBlockedError('IndexedDB connection is no longer usable.');
    }
    return database;
  }

  private async scan(
    keyPrefix: readonly string[],
    limits: CanvinkStorageScanLimits,
    remove: boolean,
  ): Promise<CanvinkStorageRecord[]> {
    const db = await this.getDatabase();
    const transaction = db.transaction(
      this.objectStoreName,
      remove ? 'readwrite' : 'readonly',
    );
    const completion = transactionCompletion(transaction);
    const store = transaction.objectStore(this.objectStoreName);
    const range = keyPrefix.length === 0 ? undefined : IDBKeyRange.lowerBound(idbKey(keyPrefix));
    const request = store.openCursor(range);
    const records: CanvinkStorageRecord[] = [];
    let totalBytes = 0;
    let entryCount = 0;
    const scanned = new Promise<void>((resolve, reject) => {
      request.onerror = () => reject(request.error ?? new Error('IndexedDB cursor failed.'));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve();
          return;
        }
        if (!isStringKey(cursor.key)) {
          transaction.abort();
          reject(new Error('IndexedDB contains a non-hierarchical storage key.'));
          return;
        }
        if (!hasKeyPrefix(cursor.key, keyPrefix)) {
          resolve();
          return;
        }
        if (!(cursor.value instanceof Uint8Array)) {
          transaction.abort();
          reject(new Error('IndexedDB storage value is not binary data.'));
          return;
        }
        totalBytes += cursor.value.byteLength;
        entryCount += 1;
        if (entryCount > limits.maxEntries || totalBytes > limits.maxBytes) {
          transaction.abort();
          reject(new Error('IndexedDB range exceeds configured import limits.'));
          return;
        }
        if (remove) cursor.delete();
        else records.push({ key: [...cursor.key], data: Uint8Array.from(cursor.value) });
        cursor.continue();
      };
    });
    try {
      await Promise.all([scanned, completion]);
    } catch (error) {
      await completion.catch(() => undefined);
      throw error;
    }
    return records.sort((left, right) => compareKeys(left.key, right.key));
  }
}
