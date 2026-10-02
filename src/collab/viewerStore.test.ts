import * as Automerge from '@automerge/automerge';
import { describe, expect, it } from 'vitest';
import { encodeBase64Url } from './protocol';
import { openRoomSession } from './session';
import { createMockWebSocketFactory } from './testMocks';
import { createViewerStore } from './viewerStore';

describe('viewerStore', () => {
  it('projects a real schema-v3-shaped notebook and its page docs', () => {
    const { factory, sockets } = createMockWebSocketFactory();
    const session = openRoomSession({
      syncUrl: 'https://sync.example.com',
      roomId: 'room1',
      auth: { kind: 'link', linkSecret: 'sec' },
      webSocketFactory: factory,
      callbacks: { onStatus: () => undefined },
    });
    const ws = sockets[0];
    ws.open();
    ws.receive({
      t: 'welcome',
      role: 'viewer',
      docs: [
        { docId: 'notebook:nb1', kind: 'notebook' },
        { docId: 'page:pg1', kind: 'page' },
      ],
      notebookTitle: 'Physics',
    });

    const notebookDoc = Automerge.from({
      schemaVersion: 3,
      documentId: 'notebook:nb1',
      kind: 'notebook',
      notebookId: 'nb1',
      title: 'Physics',
      sections: [
        { id: 'sec1', title: 'Mechanics', createdAt: '2026-01-01', updatedAt: '2026-01-01', pageDocumentIds: ['page:pg1'] },
      ],
    });
    ws.receive({
      t: 'snapshot',
      docId: 'notebook:nb1',
      payload: encodeBase64Url(Automerge.save(notebookDoc)),
      covers: 0,
    });

    const pageDoc = Automerge.from({
      schemaVersion: 3,
      documentId: 'page:pg1',
      kind: 'page',
      notebookId: 'nb1',
      sectionId: 'sec1',
      pageId: 'pg1',
      title: 'Newton laws',
    });
    ws.receive({
      t: 'snapshot',
      docId: 'page:pg1',
      payload: encodeBase64Url(Automerge.save(pageDoc)),
      covers: 0,
    });
    ws.receive({ t: 'synced' });

    const viewerStore = createViewerStore(session);
    const view = viewerStore.getNotebookView();
    expect(view).toEqual({
      title: 'Physics',
      sections: [
        {
          id: 'sec1',
          title: 'Mechanics',
          pages: [{ docId: 'page:pg1', pageId: 'pg1', title: 'Newton laws' }],
        },
      ],
    });

    const projectedPageDoc = viewerStore.getPageDoc('page:pg1') as { title: string } | undefined;
    expect(projectedPageDoc?.title).toBe('Newton laws');

    session.close();
  });

  it('returns undefined before any notebook doc has arrived', () => {
    const { factory, sockets } = createMockWebSocketFactory();
    const session = openRoomSession({
      syncUrl: 'https://sync.example.com',
      roomId: 'room1',
      auth: { kind: 'link', linkSecret: 'sec' },
      webSocketFactory: factory,
      callbacks: { onStatus: () => undefined },
    });
    sockets[0].open();
    const viewerStore = createViewerStore(session);
    expect(viewerStore.getNotebookView()).toBeUndefined();
    session.close();
  });
});
