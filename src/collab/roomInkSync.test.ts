import { describe, expect, it, vi } from 'vitest';
import type { StrokeElementV2 } from '../domain/v2';
import { encodeInkSegment } from '../ink/segmentCodec';
import { inkSegments, MemorySegmentBackend, resetInkSegments } from '../ink/segmentStore';
import { INK_SEGMENT_MIME_TYPE } from '../storage/pageIndex';
import { startRoomInkSync, type RoomInkSyncRuntime } from './roomInkSync';
import { createRoomSegmentClient } from './roomSegments';

const TIME = '2026-09-25T08:00:00.000Z';

function segment(seed: number): Uint8Array {
  const stroke: StrokeElementV2 = {
    id: `s${seed}`, kind: 'stroke', frame: { x: 0, y: 0, width: 1, height: 1, rotation: 0 },
    createdAt: TIME, updatedAt: TIME, locked: false, tool: 'pen', color: '#000', size: 1, opacity: 1,
    points: [{ x: seed, y: 0, pressure: 0.5, tiltX: 0, tiltY: 0, time: 0, pointerType: 'pen' }],
  };
  return encodeInkSegment([stroke]);
}

function fakeRoom() {
  const objects = new Map<string, Uint8Array>();
  const calls: Array<{ method: string; url: string; headers: Record<string, string> }> = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ method, url, headers: init?.headers as Record<string, string> });
    const hash = url.slice(url.lastIndexOf('/') + 1);
    if (method === 'PUT') {
      objects.set(hash, new Uint8Array(init?.body as Uint8Array));
      return new Response(null, { status: 201 });
    }
    const bytes = objects.get(hash);
    if (!bytes) return new Response(null, { status: 404 });
    return method === 'HEAD' ? new Response(null, { status: 200 }) : new Response(bytes.slice(), { status: 200 });
  });
  return { objects, calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

describe('room ink segments', () => {
  it('scopes every request to the room and carries the credential in headers', async () => {
    const room = fakeRoom();
    const client = createRoomSegmentClient(
      { syncUrl: 'https://sync.example/', appOrigin: 'https://app.example', fetchImpl: room.fetchImpl },
      'room-1',
      () => ({ kind: 'user', jwt: 'jwt-1', linkSecret: 'link-1' }),
    );
    const bytes = segment(1);
    await client.put('a'.repeat(64), bytes);
    expect(await client.head('a'.repeat(64))).toBe(true);
    expect(await client.head('b'.repeat(64))).toBe(false);
    expect(await client.remote.fetch('a'.repeat(64))).toEqual(bytes);
    expect(await client.remote.fetch('b'.repeat(64))).toBeUndefined();
    expect(room.calls[0].url).toBe(`https://sync.example/api/v1/rooms/room-1/assets/${'a'.repeat(64)}`);
    expect(room.calls[0].headers).toMatchObject({ Authorization: 'Bearer jwt-1', 'X-Link-Secret': 'link-1' });
  });

  it('uploads the segments the notebook references, once, and lets its pages fetch from the room', async () => {
    const store = resetInkSegments(new MemorySegmentBackend());
    const first = await store.put(segment(1));
    const second = await store.put(segment(2));
    const foreign = await store.put(segment(3));
    const room = fakeRoom();
    const client = createRoomSegmentClient(
      { syncUrl: 'https://sync', appOrigin: '', fetchImpl: room.fetchImpl },
      'room-2',
      () => ({ kind: 'owner', ownerToken: 'token' }),
    );
    const listeners = new Set<() => void>();
    const runtime: RoomInkSyncRuntime = {
      getState: () => ({
        schemaVersion: 3,
        pages: [
          { documentId: 'page:a', notebookId: 'shared', assets: [{ assetId: `sha256:${first}`, mimeType: INK_SEGMENT_MIME_TYPE }] },
          { documentId: 'page:b', notebookId: 'shared', assets: [{ assetId: `sha256:${second}`, mimeType: INK_SEGMENT_MIME_TYPE }] },
          // Another notebook's ink is not this room's business.
          { documentId: 'page:c', notebookId: 'private', assets: [{ assetId: `sha256:${foreign}`, mimeType: INK_SEGMENT_MIME_TYPE }] },
        ],
      }),
      subscribeToDocumentChanges: () => () => undefined,
      subscribeToState: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    };
    const sync = startRoomInkSync({ runtime, notebookId: 'shared', client, remoteKey: 'room:room-2' });
    await sync.drain();
    expect([...room.objects.keys()].sort()).toEqual([first, second].sort());
    await sync.drain();
    expect(room.calls.filter((call) => call.method === 'PUT')).toHaveLength(2);

    // A device without the segment fetches it from the room through the store.
    const other = resetInkSegments(new MemorySegmentBackend());
    other.setRemote('room:room-2', client.remote);
    expect(await other.ensure([first])).toEqual([]);
    expect(inkSegments().peek(first)?.strokes[0].id).toBe('s1');
    sync.stop();
  });

  it('keeps a segment queued while the room is unreachable and sends it later', async () => {
    const store = resetInkSegments(new MemorySegmentBackend());
    const hash = await store.put(segment(4));
    const room = fakeRoom();
    let offline = true;
    const flaky = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (offline) throw new TypeError('offline');
      return room.fetchImpl(input, init);
    });
    const client = createRoomSegmentClient(
      { syncUrl: 'https://sync', appOrigin: '', fetchImpl: flaky as unknown as typeof fetch },
      'room-3',
      () => ({ kind: 'owner', ownerToken: 't' }),
    );
    const runtime: RoomInkSyncRuntime = {
      getState: () => ({ schemaVersion: 3, pages: [{ documentId: 'page:a', notebookId: 'n', assets: [{ assetId: `sha256:${hash}`, mimeType: INK_SEGMENT_MIME_TYPE }] }] }),
      subscribeToDocumentChanges: () => () => undefined,
      subscribeToState: () => () => undefined,
    };
    const sync = startRoomInkSync({ runtime, notebookId: 'n', client, remoteKey: 'room:room-3' });
    await sync.drain();
    expect(room.objects.size).toBe(0);
    offline = false;
    await sync.drain();
    expect(room.objects.has(hash)).toBe(true);
    sync.stop();
  });
});
