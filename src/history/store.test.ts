import { describe, expect, it } from 'vitest';
import { sha256Bytes, type Sha256Checksum } from '../domain/v2';
import {
  BrowserHistorySnapshotStore,
  TauriHistorySnapshotStore,
  type BrowserHistoryPersistence,
} from './store';
import type { HistorySnapshot } from './types';

const TIME = '2026-08-03T10:00:00.000Z';

class MemoryBrowserPersistence implements BrowserHistoryPersistence {
  readonly records = new Map<string, unknown>();
  /** Keys whose value was read, to tell listing from reading whole snapshots. */
  readonly valueReads: string[] = [];

  async get<T>(key: string): Promise<T | undefined> {
    this.valueReads.push(key);
    const value = this.records.get(key);
    return value === undefined ? undefined : structuredClone(value) as T;
  }

  async setAll(records: ReadonlyArray<readonly [string, unknown]>): Promise<void> {
    for (const [key, value] of records) this.records.set(key, structuredClone(value));
  }

  async entries<T>(prefix: string): Promise<Array<[string, T]>> {
    return [...this.records]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => {
        this.valueReads.push(key);
        return [key, structuredClone(value) as T];
      });
  }

  async keys(prefix: string): Promise<string[]> {
    return [...this.records.keys()].filter((key) => key.startsWith(prefix));
  }

  async deleteAll(keys: readonly string[]): Promise<void> {
    for (const key of keys) this.records.delete(key);
  }
}

describe('TauriHistorySnapshotStore', () => {
  it('matches the snapshot contract and uses checksum-guarded deletion', async () => {
    const native = new Map<string, {
      metadata: Record<string, unknown>;
      bytes: number[];
    }>();
    const invoke = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
      if (command === 'v2_put_snapshot') {
        const request = args?.request as Record<string, unknown>;
        const metadata = {
          snapshotId: request.snapshotId,
          documentId: request.documentId,
          name: request.name,
          heads: request.heads,
          sha256: request.expectedSha256,
          byteSize: (request.bytes as number[]).length,
          createdAt: request.createdAt,
        };
        native.set(request.snapshotId as string, { metadata, bytes: request.bytes as number[] });
        return metadata as T;
      }
      if (command === 'v2_get_snapshot') return (native.get(args?.snapshotId as string) ?? null) as T;
      if (command === 'v2_list_snapshots') {
        return [...native.values()]
          .filter((item) => item.metadata.documentId === args?.documentId)
          .map((item) => item.metadata) as T;
      }
      if (command === 'v2_delete_snapshot_guarded') {
        const request = args?.request as { snapshotId: string; expectedSha256: string };
        const found = native.get(request.snapshotId);
        if (!found) return false as T;
        if (found.metadata.sha256 !== request.expectedSha256) throw new Error('guard conflict');
        return native.delete(request.snapshotId) as T;
      }
      throw new Error(`unexpected command ${command}`);
    };
    const bytes = new TextEncoder().encode('checked automerge bytes');
    const checksum = await sha256Bytes(bytes);
    const snapshot: HistorySnapshot = {
      version: 1,
      snapshotId: 'history-1',
      documentId: 'page:page-1',
      pageId: 'page-1',
      name: 'Vor Prüfung',
      deviceId: 'device-a',
      kind: 'manual',
      heads: ['head-1'],
      checksum,
      size: bytes.byteLength,
      createdAt: TIME,
      bytes,
    };
    const store = new TauriHistorySnapshotStore(invoke);
    await expect(store.put(snapshot)).resolves.toMatchObject({ name: 'Vor Prüfung', deviceId: 'device-a' });
    await expect(store.list(snapshot.documentId)).resolves.toHaveLength(1);
    await expect(store.get(snapshot.snapshotId)).resolves.toMatchObject({ bytes, checksum });
    await expect(store.deleteGuarded(snapshot.snapshotId, `sha256:${'0'.repeat(64)}` as Sha256Checksum))
      .rejects.toThrow(/guard/i);
    await expect(store.deleteGuarded(snapshot.snapshotId, checksum)).resolves.toBe(true);
    await expect(store.get(snapshot.snapshotId)).resolves.toBeUndefined();
  });

  it('rejects a native snapshot whose returned bytes no longer match metadata', async () => {
    const checksum = await sha256Bytes(Uint8Array.from([1, 2, 3]));
    const store = new TauriHistorySnapshotStore(async <T>() => ({
      metadata: {
        snapshotId: 'history-corrupt', documentId: 'page:page-1',
        name: JSON.stringify({ v: 1, deviceId: 'device-a', kind: 'automatic', pageId: 'page-1' }),
        heads: ['head-1'], sha256: checksum, byteSize: 3, createdAt: TIME,
      },
      bytes: [1, 2, 4],
    }) as T);
    await expect(store.get('history-corrupt')).rejects.toThrow(/integrity/i);
  });
});

describe('browser and Tauri history parity', () => {
  it('gives browser snapshots the same integrity, list, and guarded-delete semantics', async () => {
    const bytes = new TextEncoder().encode('browser automerge bytes');
    const checksum = await sha256Bytes(bytes);
    const snapshot: HistorySnapshot = {
      version: 1,
      snapshotId: 'history-browser',
      documentId: 'page:page-1',
      pageId: 'page-1',
      deviceId: 'device-browser',
      kind: 'automatic',
      heads: ['head-browser'],
      checksum,
      size: bytes.byteLength,
      createdAt: TIME,
      bytes,
    };
    const persistence = new MemoryBrowserPersistence();
    const store = new BrowserHistorySnapshotStore(persistence);
    await expect(store.put(snapshot)).resolves.toMatchObject({
      snapshotId: snapshot.snapshotId,
      checksum,
    });
    await expect(store.list(snapshot.documentId)).resolves.toEqual([
      expect.objectContaining({ snapshotId: snapshot.snapshotId, kind: 'automatic' }),
    ]);
    await expect(store.get(snapshot.snapshotId)).resolves.toMatchObject({ bytes, checksum });
    await expect(store.deleteGuarded(snapshot.snapshotId, `sha256:${'0'.repeat(64)}` as Sha256Checksum))
      .rejects.toThrow(/changed/i);
    await expect(store.deleteGuarded(snapshot.snapshotId, checksum)).resolves.toBe(true);
  });

  async function snapshotOf(snapshotId: string, documentId = 'page:page-1'): Promise<HistorySnapshot> {
    const bytes = new TextEncoder().encode(`bytes of ${snapshotId}`);
    return {
      version: 1,
      snapshotId,
      documentId,
      pageId: documentId.replace('page:', ''),
      deviceId: 'device-browser',
      kind: 'automatic',
      heads: [`head-${snapshotId}`],
      checksum: await sha256Bytes(bytes),
      size: bytes.byteLength,
      createdAt: TIME,
      bytes,
    };
  }

  it('lists from the metadata records without reading any snapshot bytes', async () => {
    const persistence = new MemoryBrowserPersistence();
    const store = new BrowserHistorySnapshotStore(persistence);
    await store.put(await snapshotOf('history-a'));
    await store.put(await snapshotOf('history-b', 'page:page-2'));
    persistence.valueReads.length = 0;

    const listed = await store.list('page:page-1');

    expect(listed.map((item) => item.snapshotId)).toEqual(['history-a']);
    expect(persistence.valueReads.every((key) => key.startsWith('history-snapshot-meta:'))).toBe(true);
  });

  it('gives snapshots stored before the metadata records existed theirs on first listing', async () => {
    const persistence = new MemoryBrowserPersistence();
    const legacy = await snapshotOf('history-legacy');
    persistence.records.set('history-snapshot:history-legacy', structuredClone(legacy));
    const store = new BrowserHistorySnapshotStore(persistence);

    await expect(store.list('page:page-1')).resolves.toEqual([
      expect.objectContaining({ snapshotId: 'history-legacy' }),
    ]);
    expect(persistence.records.has('history-snapshot-meta:history-legacy')).toBe(true);

    persistence.valueReads.length = 0;
    await store.list('page:page-1');
    expect(persistence.valueReads).not.toContain('history-snapshot:history-legacy');
  });

  it('removes the metadata with its snapshot and ignores metadata whose snapshot is gone', async () => {
    const persistence = new MemoryBrowserPersistence();
    const store = new BrowserHistorySnapshotStore(persistence);
    const snapshot = await snapshotOf('history-a');
    await store.put(snapshot);
    await store.put(await snapshotOf('history-b'));
    // An older version deleted this snapshot and left its metadata behind.
    persistence.records.delete('history-snapshot:history-b');

    await expect(store.list('page:page-1')).resolves.toEqual([
      expect.objectContaining({ snapshotId: 'history-a' }),
    ]);
    await expect(store.deleteGuarded('history-a', snapshot.checksum)).resolves.toBe(true);
    expect(persistence.records.has('history-snapshot-meta:history-a')).toBe(false);
    await expect(store.list('page:page-1')).resolves.toEqual([]);
  });
});
