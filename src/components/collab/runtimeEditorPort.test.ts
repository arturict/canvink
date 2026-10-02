/**
 * The sharing port over the runtime's document API: scoped to one notebook,
 * works for pages that are not loaded, and `getSnapshotBytes` never moves the
 * change-tracking baseline (punch-list item 4: if reading a snapshot for
 * compaction moved it, a local edit racing that read would compute an empty
 * diff and be dropped without any error).
 */
import * as Automerge from '@automerge/automerge';
import { describe, expect, it, vi } from 'vitest';
import { FakeDocumentRuntime } from '../../collab/testDocumentRuntime';
import type { V2RuntimeState } from '../../storage/workspaceV2Runtime';
import { collabSource, createRuntimeEditorPort, type RuntimeEditorPortSource } from './runtimeEditorPort';

type Titled = { title: string };

function sharedNotebookRuntime(pageIds: string[] = ['doc:page']) {
  const fake = new FakeDocumentRuntime([
    { documentId: 'doc:notebook', kind: 'notebook', doc: Automerge.from<Titled>({ title: 'Notebook' }) },
    ...pageIds.map((documentId) => ({ documentId, kind: 'page' as const, doc: Automerge.from<Titled>({ title: documentId }) })),
    { documentId: 'doc:other-notebook-page', kind: 'page', doc: Automerge.from<Titled>({ title: 'Elsewhere' }) },
  ]);
  let sectionPages = [...pageIds];
  const runtime: RuntimeEditorPortSource = Object.assign(fake, {
    getState: () => ({
      schemaVersion: 3,
      notebooks: [{ notebookId: 'nb1', documentId: 'doc:notebook', sections: [{ pageDocumentIds: sectionPages }] }],
    }) as unknown as V2RuntimeState,
  });
  return {
    fake,
    runtime,
    setSectionPages: (next: string[]) => { sectionPages = next; },
  };
}

describe('createRuntimeEditorPort', () => {
  it('covers the notebook and its pages only', async () => {
    const { runtime } = sharedNotebookRuntime();
    const port = createRuntimeEditorPort(runtime, 'nb1');
    expect((await port.listDocs()).map((doc) => doc.docId).sort()).toEqual(['doc:notebook', 'doc:page']);
    expect(port.hasDoc?.('doc:other-notebook-page')).toBe(false);
    expect(await port.getSnapshotBytes('doc:other-notebook-page')).toBeUndefined();
  });

  it('does not advance heads for unrelated docs, so a later local change still forwards a non-empty diff', async () => {
    const { fake, runtime } = sharedNotebookRuntime();
    const port = createRuntimeEditorPort(runtime, 'nb1');
    await port.listDocs();

    const received: Uint8Array[] = [];
    const unsubscribe = port.subscribe('doc:notebook', (bytes) => received.push(bytes));

    // Compaction reads another doc's snapshot bytes between two changes.
    expect(await port.getSnapshotBytes('doc:page')).toBeDefined();
    fake.change<Titled>('doc:notebook', (draft) => { draft.title = 'Changed after a compaction read'; });
    unsubscribe();

    expect(received).toHaveLength(1);
    expect(received[0]?.byteLength).toBeGreaterThan(0);
  });

  it('returns the current full save', async () => {
    const { fake, runtime } = sharedNotebookRuntime();
    const port = createRuntimeEditorPort(runtime, 'nb1');
    expect(await port.getSnapshotBytes('doc:notebook')).toEqual(Automerge.save(fake.doc('doc:notebook')));
    expect(await port.getSnapshotBytes('missing-doc')).toBeUndefined();
  });

  it('merges remote bytes under its own source and does not send them back', async () => {
    const { fake, runtime } = sharedNotebookRuntime();
    const port = createRuntimeEditorPort(runtime, 'nb1');
    await port.listDocs();
    const callback = vi.fn();
    port.subscribe('doc:page', callback);
    const sources: string[] = [];
    fake.subscribeToDocumentChanges((event) => {
      if (event.origin.kind === 'remote') sources.push(event.origin.source);
    });

    const remote = Automerge.change(Automerge.clone(fake.doc<Titled>('doc:page')), (draft) => { draft.title = 'Remote'; });
    await port.applyRemote('doc:page', Automerge.save(remote));

    expect(fake.doc<Titled>('doc:page').title).toBe('Remote');
    expect(sources).toEqual([collabSource('nb1')]);
    expect(callback).not.toHaveBeenCalled();
  });

  it('takeChangesSince returns what the room lacks and advances the baseline', async () => {
    const { fake, runtime } = sharedNotebookRuntime();
    const port = createRuntimeEditorPort(runtime, 'nb1');
    await port.listDocs();
    const roomHeads = Automerge.getHeads(fake.doc('doc:page'));
    fake.change<Titled>('doc:page', (draft) => { draft.title = 'Offline edit'; });

    const afterOffline = Automerge.getHeads(fake.doc('doc:page'));
    const bytes = await port.takeChangesSince?.('doc:page', roomHeads);
    expect(bytes?.byteLength).toBeGreaterThan(0);
    expect(await port.takeChangesSince?.('doc:page', ['0'.repeat(64)])).toBeUndefined();

    // The baseline moved: the next local change sends only itself.
    const callback = vi.fn();
    port.subscribe('doc:page', callback);
    fake.change<Titled>('doc:page', (draft) => { draft.title = 'Next'; });
    const [next] = callback.mock.calls[0] as [Uint8Array];
    expect(Automerge.decodeChange(next).deps).toEqual(afterOffline);
  });

  it('reports a page added to the notebook as a document-set change', async () => {
    const { fake, runtime, setSectionPages } = sharedNotebookRuntime();
    const port = createRuntimeEditorPort(runtime, 'nb1');
    const listener = vi.fn();
    const unsubscribe = port.subscribeDocSet?.(listener);

    fake.addDocument('doc:new-page', 'page', Automerge.from<Titled>({ title: 'New' }));
    setSectionPages(['doc:page', 'doc:new-page']);
    fake.addDocument('doc:new-page', 'page', fake.doc('doc:new-page'), { emit: true });

    expect(listener).toHaveBeenCalledTimes(1);
    expect((await port.listDocs()).map((doc) => doc.docId)).toContain('doc:new-page');
    unsubscribe?.();
  });
});
