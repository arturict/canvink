import { describe, expect, it, vi } from 'vitest';
import type { StrokeElementV2 } from '../../domain/v2';
import { encodeInkSegment } from '../../ink/segmentCodec';
import { InkSegmentStore, MemorySegmentBackend } from '../../ink/segmentStore';
import { INK_SEGMENT_MIME_TYPE } from '../../storage/pageIndex';
import type { AssetSyncHttpPort } from './assetSyncQueue';
import { createInkSegmentSync } from './inkSegmentSync';

const TIME = '2026-09-25T08:00:00.000Z';

function segmentBytes(seed: number): Uint8Array {
  const stroke: StrokeElementV2 = {
    id: `s${seed}`, kind: 'stroke', frame: { x: 0, y: 0, width: 1, height: 1, rotation: 0 },
    createdAt: TIME, updatedAt: TIME, locked: false, tool: 'pen', color: '#000', size: 1, opacity: 1,
    points: [{ x: seed, y: 0, pressure: 0.5, tiltX: 0, tiltY: 0, time: 0, pointerType: 'pen' }],
  };
  return encodeInkSegment([stroke]);
}

function cloud() {
  const objects = new Map<string, Uint8Array>();
  const http: AssetSyncHttpPort = {
    headAsset: vi.fn(async (id) => objects.has(id)),
    putAsset: vi.fn(async (id, bytes) => { objects.set(id, bytes.slice()); }),
    getAsset: vi.fn(async (id) => {
      const bytes = objects.get(id);
      return bytes ? { bytes: bytes.slice(), mimeType: INK_SEGMENT_MIME_TYPE } : undefined;
    }),
  };
  return { objects, http };
}

describe('ink segment sync', () => {
  it('uploads what this device wrote once, and skips what the cloud already holds', async () => {
    const { objects, http } = cloud();
    const store = new InkSegmentStore(new MemorySegmentBackend());
    const first = await store.put(segmentBytes(1));
    const second = await store.put(segmentBytes(2));
    objects.set(`sha256:${second}`, (await store.read(second)) as Uint8Array);
    const sync = createInkSegmentSync({ http, store });
    await sync.drain();
    expect([...objects.keys()].sort()).toEqual([`sha256:${first}`, `sha256:${second}`].sort());
    expect(http.putAsset).toHaveBeenCalledTimes(1);
    expect(http.putAsset).toHaveBeenCalledWith(`sha256:${first}`, expect.any(Uint8Array), INK_SEGMENT_MIME_TYPE);
    expect(await store.localBackend.pendingUploads()).toEqual([]);
    await sync.drain();
    expect(http.putAsset).toHaveBeenCalledTimes(1);
  });

  it('keeps a segment queued when the upload fails, and sends it on the next pass', async () => {
    const { objects, http } = cloud();
    const store = new InkSegmentStore(new MemorySegmentBackend());
    const hash = await store.put(segmentBytes(3));
    vi.mocked(http.putAsset).mockRejectedValueOnce(new Error('offline'));
    const sync = createInkSegmentSync({ http, store });
    await sync.drain();
    expect(await store.localBackend.pendingUploads()).toEqual([hash]);
    expect(objects.size).toBe(0);
    await sync.drain();
    expect(objects.has(`sha256:${hash}`)).toBe(true);
    expect(await store.localBackend.pendingUploads()).toEqual([]);
  });

  it('gives a device that lacks a segment the cloud copy, verified against its address', async () => {
    const { objects, http } = cloud();
    const writer = new InkSegmentStore(new MemorySegmentBackend());
    const hash = await writer.put(segmentBytes(4));
    await createInkSegmentSync({ http, store: writer }).drain();

    const reader = new InkSegmentStore(new MemorySegmentBackend());
    const sync = createInkSegmentSync({ http, store: reader });
    sync.start();
    expect(await reader.ensure([hash])).toEqual([]);
    expect(reader.peek(hash)?.strokes[0].id).toBe('s4');
    // Now it is local: no second download.
    reader.reset(reader.localBackend);
    sync.stop();

    // A tampered copy is refused.
    objects.set(`sha256:${hash}`, segmentBytes(5));
    const skeptic = new InkSegmentStore(new MemorySegmentBackend());
    const skepticSync = createInkSegmentSync({ http, store: skeptic });
    skepticSync.start();
    expect(await skeptic.ensure([hash])).toEqual([hash]);
    skepticSync.stop();
  });
});
