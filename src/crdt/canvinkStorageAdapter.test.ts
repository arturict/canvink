import { runStorageAdapterTests } from '@automerge/automerge-repo/helpers/tests/storage-adapter-tests.js';
import { describe, expect, it, vi } from 'vitest';
import {
  CanvinkStorageBlockedError,
  CanvinkStorageAdapter,
  IndexedDbCanvinkStorageBridge,
  MemoryCanvinkStorageBridge,
} from './canvinkStorageAdapter';

const binary = (...values: number[]): Uint8Array => new Uint8Array(values);

runStorageAdapterTests(
  async () => ({
    adapter: new CanvinkStorageAdapter({
      bridge: new MemoryCanvinkStorageBridge(),
    }),
  }),
  'CanvinkStorageAdapter',
);

describe('CanvinkStorageAdapter safety and transaction extensions', () => {
  it('clones saved, loaded, and ranged bytes instead of retaining caller aliases', async () => {
    const adapter = new CanvinkStorageAdapter({ bridge: new MemoryCanvinkStorageBridge() });
    const source = binary(1, 2, 3);
    await adapter.save(['document', 'snapshot', 'hash'], source);
    source[0] = 99;

    const loaded = await adapter.load(['document', 'snapshot', 'hash']);
    expect(loaded).toEqual(binary(1, 2, 3));
    loaded![1] = 88;
    const ranged = await adapter.loadRange(['document']);
    expect(ranged[0].data).toEqual(binary(1, 2, 3));
    ranged[0].key[0] = 'changed';
    ranged[0].data![2] = 77;

    await expect(adapter.load(['document', 'snapshot', 'hash'])).resolves.toEqual(
      binary(1, 2, 3),
    );
  });

  it('keeps hierarchical keys distinct when slash joining would alias them', async () => {
    const adapter = new CanvinkStorageAdapter({ bridge: new MemoryCanvinkStorageBridge() });
    await adapter.save(['course/math', 'page'], binary(1));
    await adapter.save(['course', 'math/page'], binary(2));
    await adapter.save(['course', 'math', 'page'], binary(3));

    await expect(adapter.load(['course/math', 'page'])).resolves.toEqual(binary(1));
    await expect(adapter.load(['course', 'math/page'])).resolves.toEqual(binary(2));
    await expect(adapter.load(['course', 'math', 'page'])).resolves.toEqual(binary(3));
    await expect(adapter.loadRange(['course'])).resolves.toEqual([
      { key: ['course', 'math/page'], data: binary(2) },
      { key: ['course', 'math', 'page'], data: binary(3) },
    ]);
  });

  it('uses exact segment prefixes and returns the same deterministic order after overwrites', async () => {
    const adapter = new CanvinkStorageAdapter({ bridge: new MemoryCanvinkStorageBridge() });
    await adapter.save(['doc', 'incremental', 'z'], binary(3));
    await adapter.save(['doc', 'snapshot', 'y'], binary(2));
    await adapter.save(['doc', 'incremental', 'x'], binary(1));
    await adapter.save(['document', 'incremental', 'a'], binary(9));

    const expected = [
      { key: ['doc', 'incremental', 'x'], data: binary(1) },
      { key: ['doc', 'snapshot', 'y'], data: binary(2) },
      { key: ['doc', 'incremental', 'z'], data: binary(3) },
    ];
    await expect(adapter.loadRange(['doc'])).resolves.toEqual(expected);
    await adapter.save(['doc', 'snapshot', 'y'], binary(2));
    await expect(adapter.loadRange(['doc'])).resolves.toEqual(expected);

    await adapter.removeRange(['doc', 'incremental']);
    await expect(adapter.loadRange(['doc'])).resolves.toEqual([
      { key: ['doc', 'snapshot', 'y'], data: binary(2) },
    ]);
    await expect(adapter.load(['document', 'incremental', 'a'])).resolves.toEqual(binary(9));
  });

  it('atomically commits repo chunks with asset and activation records', async () => {
    const bridge = new MemoryCanvinkStorageBridge();
    const adapter = new CanvinkStorageAdapter({ bridge, namespace: ['repo'] });
    const plan = {
      repo: [
        {
          type: 'save' as const,
          key: ['doc', 'snapshot', 'head'],
          data: binary(1, 2),
        },
      ],
      shared: [
        { type: 'save' as const, key: ['assets', 'sha256:abc'], data: binary(3, 4) },
        { type: 'save' as const, key: ['activation', 'current'], data: binary(5) },
      ],
    };

    await adapter.commitAtomically(plan);
    await adapter.commitAtomically(plan);

    await expect(adapter.load(['doc', 'snapshot', 'head'])).resolves.toEqual(binary(1, 2));
    await expect(bridge.load(['assets', 'sha256:abc'])).resolves.toEqual(binary(3, 4));
    await expect(bridge.load(['activation', 'current'])).resolves.toEqual(binary(5));
  });

  it('publishes none of an atomic plan when the bridge crashes mid-commit', async () => {
    const bridge = new MemoryCanvinkStorageBridge();
    const adapter = new CanvinkStorageAdapter({ bridge, namespace: ['repo'] });
    await adapter.save(['existing'], binary(9));
    bridge.failNextCommit(1);

    await expect(
      adapter.commitAtomically({
        repo: [{ type: 'save', key: ['new'], data: binary(1) }],
        shared: [
          { type: 'save', key: ['assets', 'hash'], data: binary(2) },
          { type: 'save', key: ['activation', 'current'], data: binary(3) },
        ],
      }),
    ).rejects.toThrow('Simulated atomic storage crash');

    await expect(adapter.load(['existing'])).resolves.toEqual(binary(9));
    await expect(adapter.load(['new'])).resolves.toBeUndefined();
    await expect(bridge.load(['assets', 'hash'])).resolves.toBeUndefined();
    await expect(bridge.load(['activation', 'current'])).resolves.toBeUndefined();
  });

  it('rejects malformed keys, oversized values, oversized ranges, and namespace overlap', async () => {
    const bridge = new MemoryCanvinkStorageBridge();
    const adapter = new CanvinkStorageAdapter({
      bridge,
      namespace: ['repo'],
      limits: {
        maxDataBytes: 4,
        maxRangeBytes: 8,
        maxRangeEntries: 2,
        maxSegmentBytes: 8,
      },
    });

    expect(() => adapter.save([], binary(1))).toThrow('non-empty');
    expect(() => adapter.save([''], binary(1))).toThrow('empty');
    expect(() => adapter.save(['123456789'], binary(1))).toThrow('segment');
    expect(() => adapter.save(['valid'], binary(1, 2, 3, 4, 5))).toThrow('byte limit');
    expect(() =>
      adapter.commitAtomically({
        shared: [{ type: 'save', key: ['repo', 'x'], data: binary(1) }],
      }),
    ).toThrow('overlaps');

    await adapter.save(['range', 'a'], binary(1));
    await adapter.save(['range', 'b'], binary(2));
    await adapter.save(['range', 'c'], binary(3));
    await expect(adapter.loadRange(['range'])).rejects.toThrow('too many entries');
  });

  it('fails closed when IndexedDB is unavailable', () => {
    expect(
      () =>
        new CanvinkStorageAdapter({
          indexedDB: undefined,
        }),
    ).toThrow(/IndexedDB is unavailable/i);
  });

  it('rejects a blocked IndexedDB open and invokes the coordination hook', async () => {
    const request: Partial<IDBOpenDBRequest> = {};
    const factory = {
      open: () => request as IDBOpenDBRequest,
    } as unknown as IDBFactory;
    const onBlocked = vi.fn();
    const bridge = new IndexedDbCanvinkStorageBridge({ indexedDB: factory, onBlocked });

    request.onblocked?.call(
      request as IDBOpenDBRequest,
      {} as IDBVersionChangeEvent,
    );

    await expect(bridge.load(['key'])).rejects.toBeInstanceOf(CanvinkStorageBlockedError);
    expect(onBlocked).toHaveBeenCalledOnce();
  });

  it('closes and invalidates an IndexedDB connection on versionchange', async () => {
    const request: Partial<IDBOpenDBRequest> = {};
    const close = vi.fn();
    const database = {
      objectStoreNames: { contains: () => true },
      close,
      onversionchange: null,
    } as unknown as IDBDatabase;
    Object.defineProperty(request, 'result', { value: database });
    const factory = {
      open: () => request as IDBOpenDBRequest,
    } as unknown as IDBFactory;
    const onVersionChange = vi.fn();
    const bridge = new IndexedDbCanvinkStorageBridge({
      indexedDB: factory,
      onVersionChange,
    });
    request.onsuccess?.call(request as IDBOpenDBRequest, {} as Event);
    const versionEvent = { oldVersion: 1, newVersion: 2 } as IDBVersionChangeEvent;

    database.onversionchange?.(versionEvent);

    await expect(bridge.load(['key'])).rejects.toBeInstanceOf(CanvinkStorageBlockedError);
    expect(close).toHaveBeenCalledOnce();
    expect(onVersionChange).toHaveBeenCalledWith(versionEvent);
  });
});
