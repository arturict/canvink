import * as Automerge from '@automerge/automerge';
import { describe, expect, it, vi } from 'vitest';
import { bindEditorSession, createRoomFromDocs, type EditorLocalDocsPort } from './ownerBridge';
import { encodeBase64Url } from './protocol';
import { openRoomSession } from './session';
import { createMockWebSocketFactory } from './testMocks';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('createRoomFromDocs', () => {
  it('creates a restricted room (no link) and uploads announce+snapshot per doc', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/rooms')) return jsonResponse({ roomId: 'room1', ownerToken: 'ot1' }, 201);
      throw new Error(`Unexpected request: ${url}`);
    });
    const { factory, sockets } = createMockWebSocketFactory();

    const pageDoc = Automerge.from({ kind: 'page', pageId: 'p1', title: 'Untitled' });
    const notebookDoc = Automerge.from({ kind: 'notebook', title: 'Physics', sections: [] });

    const resultPromise = createRoomFromDocs(
      { syncUrl: 'https://sync.example.com', appOrigin: 'https://canvink.app', fetchImpl },
      [
        { docId: 'notebook:1', kind: 'notebook', bytes: Automerge.save(notebookDoc) },
        { docId: 'page:1', kind: 'page', bytes: Automerge.save(pageDoc) },
      ],
      'Physics',
      { webSocketFactory: factory },
    );

    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const ws = sockets[0];
    ws.open();
    expect(ws.sentFrames()[0]).toEqual({
      t: 'hello',
      auth: { kind: 'owner', ownerToken: 'ot1' },
      since: {},
    });
    ws.receive({ t: 'welcome', role: 'owner', docs: [], notebookTitle: 'Physics' });
    ws.receive({ t: 'synced' });

    const result = await resultPromise;
    // The room starts restricted: no link is minted until the owner switches it on.
    expect(result).toEqual({ roomId: 'room1', ownerToken: 'ot1' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const frames = ws.sentFrames();
    expect(frames.some((f) => f.t === 'announce' && f.docId === 'notebook:1' && f.kind === 'notebook')).toBe(true);
    expect(frames.some((f) => f.t === 'snapshot' && f.docId === 'notebook:1' && f.covers === 0)).toBe(true);
    expect(frames.some((f) => f.t === 'announce' && f.docId === 'page:1' && f.kind === 'page')).toBe(true);
    expect(frames.some((f) => f.t === 'snapshot' && f.docId === 'page:1' && f.covers === 0)).toBe(true);
  });
});

describe('createRoomFromDocs with lazy readers', () => {
  it('reads each doc only when it is uploaded, one after the other', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/rooms')) return jsonResponse({ roomId: 'room1', ownerToken: 'ot1' }, 201);
      throw new Error(`Unexpected request: ${url}`);
    });
    const { factory, sockets } = createMockWebSocketFactory();
    let reading = 0;
    let maxConcurrentReads = 0;
    const reader = (value: string) => async () => {
      reading += 1;
      maxConcurrentReads = Math.max(maxConcurrentReads, reading);
      await Promise.resolve();
      reading -= 1;
      return Automerge.save(Automerge.from({ value }));
    };

    const resultPromise = createRoomFromDocs(
      { syncUrl: 'https://sync.example.com', appOrigin: 'https://canvink.app', fetchImpl },
      [
        { docId: 'notebook:1', kind: 'notebook', bytes: reader('notebook') },
        { docId: 'page:1', kind: 'page', bytes: reader('page 1') },
        { docId: 'page:2', kind: 'page', bytes: reader('page 2') },
      ],
      'Physics',
      { webSocketFactory: factory },
    );
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0].open();
    sockets[0].receive({ t: 'welcome', role: 'owner', docs: [], notebookTitle: 'Physics' });
    sockets[0].receive({ t: 'synced' });
    await resultPromise;

    expect(maxConcurrentReads).toBe(1);
    const snapshots = sockets[0].sentFrames().filter((frame) => frame.t === 'snapshot').map((frame) => frame.docId);
    expect(snapshots).toEqual(['notebook:1', 'page:1', 'page:2']);
  });
});

function liveOwnerSession() {
  const { factory, sockets } = createMockWebSocketFactory();
  const session = openRoomSession({
    syncUrl: 'https://sync.example.com',
    roomId: 'room1',
    auth: { kind: 'owner', ownerToken: 'ot1' },
    webSocketFactory: factory,
    callbacks: { onStatus: () => undefined },
  });
  const ws = sockets[0];
  ws.open();
  ws.receive({ t: 'welcome', role: 'owner', docs: [{ docId: 'page:1', kind: 'page' }], notebookTitle: 'Physics' });
  ws.receive({ t: 'synced' });
  return { session, ws };
}

describe('bindEditorSession', () => {
  it('forwards local changes and hands remote docs to the port', async () => {
    const { session, ws } = liveOwnerSession();

    let localCallback: ((bytes: Uint8Array) => void) | undefined;
    const applied: Array<{ docId: string; bytes: Uint8Array }> = [];
    const added: Array<{ docId: string; kind: string }> = [];
    const port: EditorLocalDocsPort = {
      listDocs: () => [{ docId: 'page:1', kind: 'page' }],
      subscribe: (docId, callback) => {
        expect(docId).toBe('page:1');
        localCallback = callback;
        return () => {
          localCallback = undefined;
        };
      },
      applyRemote: (docId, bytes) => { applied.push({ docId, bytes }); },
      onRemoteDocAdded: (docId, kind) => { added.push({ docId, kind }); },
      getSnapshotBytes: () => undefined,
    };

    const unbind = bindEditorSession(session, port);
    await unbind.idle();

    localCallback?.(new Uint8Array([9, 9, 9]));
    expect(ws.sentFrames().some((f) => f.t === 'append' && f.docId === 'page:1')).toBe(true);

    const pageDoc = Automerge.from({ kind: 'page', pageId: 'p1', title: 't' });
    ws.receive({
      t: 'snapshot',
      docId: 'page:1',
      payload: encodeBase64Url(Automerge.save(pageDoc)),
      covers: 0,
    });
    await unbind.idle();
    expect(applied).toHaveLength(1);
    expect(applied[0].docId).toBe('page:1');

    const newPageDoc = Automerge.from({ kind: 'page', pageId: 'p2', title: 't2' });
    ws.receive({
      t: 'snapshot',
      docId: 'page:2',
      payload: encodeBase64Url(Automerge.save(newPageDoc)),
      covers: 0,
    });
    await unbind.idle();
    expect(added).toEqual([{ docId: 'page:2', kind: 'page' }]);

    unbind();
    session.close();
  });

  it('applies a burst of frames for one doc once, and one doc at a time', async () => {
    const { session, ws } = liveOwnerSession();
    let applying = 0;
    let maxConcurrent = 0;
    const applied: string[] = [];
    const port: EditorLocalDocsPort = {
      listDocs: () => [{ docId: 'page:1', kind: 'page' }, { docId: 'page:2', kind: 'page' }],
      hasDoc: () => true,
      subscribe: () => () => undefined,
      applyRemote: async (docId) => {
        applying += 1;
        maxConcurrent = Math.max(maxConcurrent, applying);
        await new Promise((resolve) => setTimeout(resolve, 1));
        applying -= 1;
        applied.push(docId);
      },
      onRemoteDocAdded: () => undefined,
      getSnapshotBytes: () => undefined,
    };
    const unbind = bindEditorSession(session, port);
    let doc = Automerge.from<{ n: number }>({ n: 0 });
    ws.receive({ t: 'snapshot', docId: 'page:1', payload: encodeBase64Url(Automerge.save(doc)), covers: 0 });
    for (let n = 1; n <= 5; n += 1) {
      const before = Automerge.getHeads(doc);
      doc = Automerge.change(doc, (draft) => { draft.n = n; });
      ws.receive({ t: 'append', docId: 'page:1', payload: encodeBase64Url(Automerge.saveSince(doc, before)), seq: n });
    }
    ws.receive({ t: 'snapshot', docId: 'page:2', payload: encodeBase64Url(Automerge.save(Automerge.from({ m: 1 }))), covers: 0 });
    await unbind.idle();

    expect(applied).toEqual(['page:1', 'page:2']);
    expect(maxConcurrent).toBe(1);
    unbind();
    session.close();
  });

  it('announces a doc that appears locally before any append, and removes one that leaves', async () => {
    const { session, ws } = liveOwnerSession();
    let docs = [{ docId: 'page:1', kind: 'page' as const }];
    let notifyDocSet: (() => void) | undefined;
    const callbacks = new Map<string, (bytes: Uint8Array) => void>();
    const port: EditorLocalDocsPort = {
      listDocs: () => docs,
      subscribe: (docId, callback) => {
        callbacks.set(docId, callback);
        return () => callbacks.delete(docId);
      },
      subscribeDocSet: (listener) => {
        notifyDocSet = listener;
        return () => { notifyDocSet = undefined; };
      },
      applyRemote: () => undefined,
      onRemoteDocAdded: () => undefined,
      getSnapshotBytes: async (docId) => new TextEncoder().encode(docId),
    };
    const unbind = bindEditorSession(session, port);
    await unbind.idle();

    docs = [...docs, { docId: 'page:new', kind: 'page' }];
    notifyDocSet?.();
    await unbind.idle();
    callbacks.get('page:new')?.(new Uint8Array([1]));

    const frames = ws.sentFrames().filter((frame) => frame.docId === 'page:new').map((frame) => frame.t);
    expect(frames).toEqual(['announce', 'snapshot', 'append']);

    docs = [{ docId: 'page:new', kind: 'page' }];
    notifyDocSet?.();
    await unbind.idle();
    expect(ws.sentFrames().some((frame) => frame.t === 'remove' && frame.docId === 'page:1')).toBe(true);
    expect(callbacks.has('page:1')).toBe(false);

    unbind();
    session.close();
  });

  it('B1c: compacts after 64 acked appends per doc, reading fresh bytes from the port', async () => {
    const { session, ws } = liveOwnerSession();

    const currentBytes = new Uint8Array([7, 7, 7]);
    const port: EditorLocalDocsPort = {
      listDocs: () => [{ docId: 'page:1', kind: 'page' }],
      subscribe: () => () => undefined,
      applyRemote: () => undefined,
      onRemoteDocAdded: () => undefined,
      getSnapshotBytes: async (docId) => (docId === 'page:1' ? currentBytes : undefined),
    };

    const unbind = bindEditorSession(session, port);

    for (let seq = 1; seq <= 64; seq += 1) {
      ws.receive({ t: 'seq', docId: 'page:1', seq });
    }
    await vi.waitFor(() => expect(ws.sentFrames().filter((f) => f.t === 'snapshot')).toHaveLength(1));

    const snapshotFrames = ws.sentFrames().filter((f) => f.t === 'snapshot');
    expect(snapshotFrames[0]).toMatchObject({ docId: 'page:1', covers: 64 });
    expect(snapshotFrames[0].payload).toBe(encodeBase64Url(currentBytes));

    unbind();
    session.close();
  });
});
