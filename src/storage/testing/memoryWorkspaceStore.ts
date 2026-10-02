import { Repo } from '@automerge/automerge-repo';
import {
  CanvinkStorageAdapter,
  type CanvinkStorageBridge,
  type CanvinkStorageMutation,
  type CanvinkStorageRecord,
  type CanvinkStorageScanLimits,
} from '../../crdt/canvinkStorageAdapter';
import type { AtomicKeyValueStore, AtomicStorageKey } from '../browserAssetStore';
import { DIRTY_NAMESPACE } from '../pageIndex';
import type { PersistentRepoFactory, PersistentRepoSession } from '../workspaceV2Runtime';

export interface MemoryRecord {
  key: AtomicStorageKey;
  value: unknown;
}

function hasPrefix(key: readonly string[], prefix: readonly string[]): boolean {
  return prefix.length <= key.length && prefix.every((part, index) => key[index] === part);
}

/**
 * One in-memory key space shared by the activation store (as an
 * `AtomicKeyValueStore`) and the Repo storage adapter (as a
 * `CanvinkStorageBridge`), like the single IndexedDB object store the browser
 * uses for both. Tests use it to exercise the real runtime, storage adapter
 * and activation store together without IndexedDB.
 */
export class MemoryWorkspaceStore implements AtomicKeyValueStore, CanvinkStorageBridge {
  private records = new Map<string, MemoryRecord>();
  /** Every committed write, for tests that assert what a commit touched. */
  readonly writeLog: string[][] = [];
  failNextReplace = false;
  private readonly heldReads = new Map<string, Promise<void>>();

  private async heldRead(key: readonly string[]): Promise<void> {
    for (const [storageId, held] of this.heldReads) {
      if (key.includes(storageId)) await held;
    }
  }

  /**
   * Holds every read of one Repo document (by its storage id) until the
   * returned function is called, so a test decides what happens while a page
   * is still loading.
   */
  holdReads(storageId: string): () => void {
    let release = () => undefined as void;
    this.heldReads.set(storageId, new Promise<void>((resolve) => { release = resolve; }));
    return () => {
      release();
      this.heldReads.delete(storageId);
    };
  }

  private encoded(key: AtomicStorageKey): string {
    return typeof key === 'string' ? `string:${key}` : `array:${JSON.stringify(key)}`;
  }

  async get<T>(key: AtomicStorageKey): Promise<T | undefined> {
    const value = this.records.get(this.encoded(key))?.value;
    return value === undefined ? undefined : structuredClone(value) as T;
  }

  async setMany(entries: Array<readonly [AtomicStorageKey, unknown]>): Promise<void> {
    for (const [key, value] of entries) this.write(key, value);
  }

  async replaceMany(
    entries: Array<readonly [AtomicStorageKey, unknown]>,
    removedKeys: readonly AtomicStorageKey[],
    removedPrefixes: ReadonlyArray<readonly string[]> = [],
  ): Promise<void> {
    if (this.failNextReplace) {
      this.failNextReplace = false;
      throw new Error('Simulated storage failure.');
    }
    const shadow = new Map(this.records);
    for (const prefix of removedPrefixes) {
      for (const [encoded, record] of shadow) {
        if (Array.isArray(record.key) && hasPrefix(record.key, prefix)) shadow.delete(encoded);
      }
    }
    for (const key of removedKeys) shadow.delete(this.encoded(key));
    for (const [key, value] of entries) {
      shadow.set(this.encoded(key), {
        key: typeof key === 'string' ? key : [...key],
        value: structuredClone(value),
      });
      if (Array.isArray(key)) this.writeLog.push([...key]);
    }
    this.records = shadow;
  }

  entries(): MemoryRecord[] {
    return [...this.records.values()].map((record) => structuredClone(record));
  }

  put(key: AtomicStorageKey, value: unknown): void {
    this.write(key, value);
  }

  delete(key: AtomicStorageKey): void {
    this.records.delete(this.encoded(key));
  }

  keys(prefix: readonly string[] = []): string[][] {
    return [...this.records.values()]
      .flatMap((record) => Array.isArray(record.key) && hasPrefix(record.key, prefix) ? [[...record.key]] : []);
  }

  // CanvinkStorageBridge

  async load(key: readonly string[]): Promise<Uint8Array | undefined> {
    await this.heldRead(key);
    const value = this.records.get(this.encoded(key))?.value;
    return value instanceof Uint8Array ? Uint8Array.from(value) : undefined;
  }

  async loadRange(
    keyPrefix: readonly string[],
    limits: CanvinkStorageScanLimits,
  ): Promise<CanvinkStorageRecord[]> {
    await this.heldRead(keyPrefix);
    const matches = [...this.records.values()].flatMap((record) =>
      Array.isArray(record.key) && hasPrefix(record.key, keyPrefix) && record.value instanceof Uint8Array
        ? [{ key: [...record.key], data: Uint8Array.from(record.value) }]
        : []);
    if (matches.length > limits.maxEntries) throw new Error('Storage range contains too many entries.');
    return matches;
  }

  async commit(mutations: readonly CanvinkStorageMutation[]): Promise<void> {
    for (const mutation of mutations) {
      if (mutation.type === 'remove') this.records.delete(this.encoded(mutation.key));
      else this.write(mutation.key, Uint8Array.from(mutation.data));
    }
  }

  async removeRange(keyPrefix: readonly string[]): Promise<void> {
    for (const [encoded, record] of this.records) {
      if (Array.isArray(record.key) && hasPrefix(record.key, keyPrefix)) this.records.delete(encoded);
    }
  }

  private write(key: AtomicStorageKey, value: unknown): void {
    this.records.set(this.encoded(key), {
      key: typeof key === 'string' ? key : [...key],
      value: structuredClone(value),
    });
    if (Array.isArray(key)) this.writeLog.push([...key]);
  }
}

/** A Repo session over the shared store, with the production storage adapter. */
export function memoryRepoSession(store: MemoryWorkspaceStore, close?: () => void): PersistentRepoSession {
  const storage = new CanvinkStorageAdapter({
    bridge: store,
    namespace: ['automerge-repo'],
    dirtyNamespace: DIRTY_NAMESPACE,
  });
  return {
    repo: new Repo({ storage, network: [], isEphemeral: false }),
    storage,
    readChunks: async () => (await storage.loadRange([])).map(({ key, data }) => {
      if (!data) throw new Error('Expected Repo bytes.');
      return { key: [...key], bytes: Uint8Array.from(data) };
    }),
    close,
  };
}

export function memoryRepoFactory(store: MemoryWorkspaceStore, close?: () => void): PersistentRepoFactory {
  return () => memoryRepoSession(store, close);
}
