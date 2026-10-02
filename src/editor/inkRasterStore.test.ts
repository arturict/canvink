import { describe, expect, it } from 'vitest';
import {
  INK_RASTER_VERSION,
  InkRasterStore,
  rastersToEvict,
  type InkRasterRecord,
  type RasterKeyValue,
} from './inkRasterStore';

/** IndexedDB stand-in: a Map with the same operations. */
function memoryBackend(): RasterKeyValue & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: async (key) => structuredClone(data.get(key)),
    setMany: async (entries) => {
      for (const [key, value] of entries) data.set(key, value);
    },
    delMany: async (keys) => {
      for (const key of keys) data.delete(key);
    },
    del: async (key) => {
      data.delete(key);
    },
  };
}

function record(pageId: string, savedAt: number, overrides: Partial<InkRasterRecord> = {}): InkRasterRecord {
  return {
    version: INK_RASTER_VERSION,
    pageId,
    bounds: { x: 10, y: 20, width: 300, height: 200 },
    width: 600,
    height: 400,
    origin: { x: 280, y: 190 },
    view: { x: 256, y: 166, width: 1184, height: 734 },
    paper: { x: 256, y: 166, width: 1184, height: 734, color: '#ffffff' },
    strokeCount: 42,
    fingerprint: '42:abc',
    updatedAt: '2026-09-30T10:00:00.000Z',
    savedAt,
    blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/webp' }),
    ...overrides,
  };
}

describe('ink raster cache', () => {
  it('returns a stored raster with its placement and picture', async () => {
    const store = new InkRasterStore(memoryBackend());
    await store.save(record('page-a', 1));
    const loaded = await store.load('page-a');
    expect(loaded).toMatchObject({ pageId: 'page-a', strokeCount: 42, bounds: { x: 10, y: 20, width: 300, height: 200 } });
    expect(new Uint8Array(await loaded!.blob.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(await store.load('page-b')).toBeNull();
  });

  it('replaces the raster of a page that is saved again', async () => {
    const store = new InkRasterStore(memoryBackend());
    await store.save(record('page-a', 1));
    await store.save(record('page-a', 2, { strokeCount: 43 }));
    expect((await store.load('page-a'))?.strokeCount).toBe(43);
    expect(await store.pageIds()).toEqual(['page-a']);
  });

  it('keeps only the newest rasters', async () => {
    const backend = memoryBackend();
    const store = new InkRasterStore(backend, 3);
    for (let index = 1; index <= 5; index += 1) await store.save(record(`page-${index}`, index * 10));
    expect(await store.pageIds()).toEqual(['page-5', 'page-4', 'page-3']);
    expect(await store.load('page-1')).toBeNull();
    expect(backend.data.has('page-1')).toBe(false);
    expect(backend.data.has('page-2')).toBe(false);
    // Visiting an old page again makes it the newest.
    await store.save(record('page-3', 60));
    await store.save(record('page-6', 70));
    expect(await store.pageIds()).toEqual(['page-6', 'page-3', 'page-5']);
  });

  it('picks the oldest rasters to evict', () => {
    expect(rastersToEvict({ a: 3, b: 1, c: 2 }, 2)).toEqual(['b']);
    expect(rastersToEvict({ a: 3 }, 2)).toEqual([]);
  });

  it('ignores and drops a corrupt, foreign or old-version record', async () => {
    const backend = memoryBackend();
    const store = new InkRasterStore(backend);
    backend.data.set('page-a', { ...record('page-a', 1), version: 0 });
    backend.data.set('page-b', { ...record('page-b', 1), bounds: { x: 0, y: 0, width: Number.NaN, height: 1 } });
    backend.data.set('page-c', 'not a record');
    backend.data.set('page-d', { ...record('page-d', 1), blob: 'bytes' });
    backend.data.set('page-e', record('page-other', 1));
    for (const pageId of ['page-a', 'page-b', 'page-c', 'page-d', 'page-e']) {
      expect(await store.load(pageId)).toBeNull();
      expect(backend.data.has(pageId)).toBe(false);
    }
  });

  it('survives a corrupt index', async () => {
    const backend = memoryBackend();
    const store = new InkRasterStore(backend);
    backend.data.set('__index__', ['broken']);
    await store.save(record('page-a', 1));
    expect(await store.pageIds()).toEqual(['page-a']);
  });

  it('drops the rasters of pages that no longer exist', async () => {
    const store = new InkRasterStore(memoryBackend());
    await store.save(record('page-a', 1));
    await store.save(record('page-b', 2));
    expect(await store.prune(new Set(['page-b']))).toBe(1);
    expect(await store.load('page-a')).toBeNull();
    expect(await store.load('page-b')).not.toBeNull();
    await store.remove('page-b');
    expect(await store.pageIds()).toEqual([]);
  });
});
