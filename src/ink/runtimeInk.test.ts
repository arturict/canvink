import { afterEach, describe, expect, it } from 'vitest';
import { getSharedAutomergeSnapshot, type LivePageDocV2 } from '../crdt';
import type { WorkspaceState } from '../domain/types';
import type { StrokeElementV2 } from '../domain/v2';
import type { PageDocV3 } from '../domain/v3';
import { DEFAULT_MATH_PAGE_SETTINGS } from '../domain/v3';
import { applyPageElementChanges } from '../editor/pageChanges';
import type { RecoveryDraft } from '../storage/recoveryJournal';
import { MemoryWorkspaceStore, memoryRepoFactory } from '../storage/testing/memoryWorkspaceStore';
import {
  BrowserV2WorkspaceActivationStore,
  DefaultAutomergeMigrationMaterializer,
  InMemoryAutomergeRepoMigrationAdapter,
  V2WorkspaceMigrationOrchestrator,
  type V1WorkspaceMigrationSource,
} from '../storage/v2WorkspaceStorage';
import { WorkspaceV2Runtime, type V2RuntimeState } from '../storage/workspaceV2Runtime';
import { exportNotebookBundle, importNotebookBundleAdditively } from '../components/assets/bundleWorkspace';
import { pendingInk } from './pendingInk';
import { referencedInkSegments } from './projection';
import { MemorySegmentBackend, resetInkSegments } from './segmentStore';

const TIME = '2026-09-25T08:00:00.000Z';

const source: V1WorkspaceMigrationSource = {
  loadWorkspace: async () => ({
    workspace: {
      schemaVersion: 1, updatedAt: TIME,
      notebooks: [{
        id: 'notebook-1', title: 'Schule', color: '#123456', createdAt: TIME, updatedAt: TIME,
        sections: [{
          id: 'section-1', title: 'Physik', createdAt: TIME, updatedAt: TIME,
          pages: [{ id: 'page-1', title: 'Start', mode: 'a4', createdAt: TIME, updatedAt: TIME, elements: [] }],
        }],
      }],
      trash: [], activeNotebookId: 'notebook-1', activeSectionId: 'section-1', activePageId: 'page-1',
    } satisfies WorkspaceState,
    backend: 'indexeddb' as const,
  }),
  loadRecoveryDraft: async (): Promise<RecoveryDraft | null> => null,
};

function stroke(id: string, x = 0): StrokeElementV2 {
  return {
    id, kind: 'stroke', frame: { x, y: x, width: 40, height: 20, rotation: 0 },
    createdAt: TIME, updatedAt: TIME, locked: false, tool: 'pen', color: '#111111', size: 2, opacity: 1,
    points: Array.from({ length: 8 }, (_, point) => ({
      x: x + point, y: x + point * 2, pressure: 0.5, tiltX: 0, tiltY: 0, time: point, pointerType: 'pen',
    })),
  };
}

function inkPage(pageId: string, strokes: number): PageDocV3 {
  const elementsById: PageDocV3['elementsById'] = {};
  const zOrder: string[] = [];
  for (let index = 0; index < strokes; index += 1) {
    const id = `${pageId}-s${index}`;
    elementsById[id] = stroke(id, index);
    zOrder.push(id);
  }
  return {
    schemaVersion: 3, documentId: `page:${pageId}`, kind: 'page', notebookId: 'notebook-1', sectionId: 'section-1', pageId,
    title: `Seite ${pageId}`, tags: [], pageType: 'a4', background: { type: 'grid', color: '#ffffff' },
    createdAt: TIME, updatedAt: TIME, elementsById, zOrder, mathSettings: { ...DEFAULT_MATH_PAGE_SETTINGS },
    pageContent: { version: 1, kind: 'canvas' }, version: { protocol: 'uninitialized', heads: [] },
  };
}

function setup() {
  const store = new MemoryWorkspaceStore();
  const activationStore = new BrowserV2WorkspaceActivationStore(store);
  const migrationFactory = () => new V2WorkspaceMigrationOrchestrator(
    source, activationStore, new InMemoryAutomergeRepoMigrationAdapter(), new DefaultAutomergeMigrationMaterializer(), { now: () => TIME },
  );
  const createRuntime = () => new WorkspaceV2Runtime({
    source, activationStore, repoFactory: memoryRepoFactory(store), migrationFactory,
    pageCacheSize: 2, indexWriteDelayMs: 10,
  });
  return { createRuntime, migrationFactory };
}

async function workspaceWithInkPage(strokes: number) {
  const context = setup();
  await context.migrationFactory().run();
  const runtime = context.createRuntime();
  await runtime.startup();
  const state = (await runtime.ensureSchemaV3()) as V2RuntimeState;
  await runtime.commitWorkspaceGraphRevision({
    operationId: 'add-ink',
    expectedActivationArtifactFingerprint: state.activation.artifactFingerprint,
    message: 'Add page',
    newDocuments: [inkPage('ink', strokes)],
    changes: [{
      documentId: 'notebook:notebook-1',
      change: (document) => {
        if (document.kind !== 'notebook') throw new Error('Expected notebook.');
        document.sections[0].pageDocumentIds.push('page:ink');
      },
    }],
    updateManifest: (manifest) => { manifest.pageDocumentIds.push('page:ink'); },
  });
  return { ...context, runtime };
}

function shown(runtime: WorkspaceV2Runtime): Promise<string[]> {
  return runtime.readPage('ink', (document) => [...getSharedAutomergeSnapshot<LivePageDocV2>(document).zOrder]);
}

async function draw(runtime: WorkspaceV2Runtime, ...strokes: StrokeElementV2[]): Promise<void> {
  const session = await runtime.preparePageWrite('ink');
  const before = getSharedAutomergeSnapshot<LivePageDocV2>(session.handle.doc() as never);
  session.change({ message: 'Draw' }, (draft) => {
    applyPageElementChanges(
      draft, { upserts: strokes }, before.elementsById as never, TIME, before.zOrder, undefined, { holdNewInk: true },
    );
  });
}

afterEach(() => {
  pendingInk().reset();
});

describe('ink in a workspace runtime', () => {
  it('builds an imported page with its ink in segments and reads it back', async () => {
    resetInkSegments(new MemorySegmentBackend());
    const { runtime } = await workspaceWithInkPage(60);
    expect(await shown(runtime)).toHaveLength(60);
    await runtime.readPage('ink', (document) => {
      expect(referencedInkSegments(document)).toHaveLength(1);
      expect(Object.keys(document.elementsById)).toHaveLength(0);
    });
    await runtime.shutdown();
  });

  it('holds drawn ink outside the document, shows it at once and seals it after a rest', async () => {
    resetInkSegments(new MemorySegmentBackend());
    const { runtime } = await workspaceWithInkPage(30);
    const headsBefore = await runtime.readPage('ink', (document) => JSON.stringify(document.title));
    void headsBefore;
    await draw(runtime, stroke('new-1', 500), stroke('new-2', 501));

    // In the snapshot at once, but not part of the document yet.
    expect((await shown(runtime)).slice(-2)).toEqual(['new-1', 'new-2']);
    await runtime.readPage('ink', (document) => {
      expect(document.elementsById['new-1']).toBeUndefined();
      expect(referencedInkSegments(document)).toHaveLength(1);
    });

    expect(await runtime.sealPendingInk('page:ink')).toBe(2);
    expect(pendingInk().count('page:ink')).toBe(0);
    await runtime.readPage('ink', (document) => {
      expect(referencedInkSegments(document)).toHaveLength(2);
      expect(document.elementsById['new-1']).toBeUndefined();
    });
    expect((await shown(runtime)).slice(-2)).toEqual(['new-1', 'new-2']);
    await runtime.shutdown();
  });

  it('keeps sealed ink across a restart and removes a stroke that was erased', async () => {
    const backend = new MemorySegmentBackend();
    resetInkSegments(backend);
    const { runtime, createRuntime } = await workspaceWithInkPage(30);
    await draw(runtime, stroke('kept', 600), stroke('erased', 601));
    await runtime.sealPendingInk('page:ink');
    const session = await runtime.preparePageWrite('ink');
    const before = getSharedAutomergeSnapshot<LivePageDocV2>(session.handle.doc() as never);
    session.change({ message: 'Erase' }, (draft) => {
      applyPageElementChanges(draft, { removals: ['erased', 'ink-s3'] }, before.elementsById as never, TIME, before.zOrder, undefined, { holdNewInk: true });
    });
    await runtime.shutdown();

    // A new session: the segments come from the local store, nothing else.
    resetInkSegments(backend);
    const reopened = createRuntime();
    await reopened.startup();
    const order = await shown(reopened);
    expect(order).toContain('kept');
    expect(order).not.toContain('erased');
    expect(order).not.toContain('ink-s3');
    expect(order).toHaveLength(30 + 2 - 2);
    await reopened.shutdown();
  });

  it('recovers ink that was drawn but not sealed when the app went away', async () => {
    const backend = new MemorySegmentBackend();
    resetInkSegments(backend);
    const { runtime, createRuntime } = await workspaceWithInkPage(30);
    await draw(runtime, stroke('unsaved-1', 700), stroke('unsaved-2', 701));
    await pendingInk().flushJournals();
    expect(backend.journals.has('page:ink')).toBe(true);
    // The process ends here: no seal, no shutdown; memory is gone.
    pendingInk().reset();

    resetInkSegments(backend);
    const reopened = createRuntime();
    await reopened.startup();
    await vi_waitFor(async () => (await shown(reopened)).includes('unsaved-2'));
    expect((await shown(reopened)).slice(-2)).toEqual(['unsaved-1', 'unsaved-2']);
    await vi_waitFor(() => pendingInk().count('page:ink') === 0);
    await reopened.shutdown();
  });

  it('carries sealed ink through a .canvink bundle into a workspace that holds no segments', async () => {
    resetInkSegments(new MemorySegmentBackend());
    const { runtime } = await workspaceWithInkPage(40);
    await draw(runtime, stroke('drawn-late', 900));
    const blob = await exportNotebookBundle(runtime, runtime.getState() as V2RuntimeState, 'notebook-1');
    await runtime.shutdown();

    // Another device: a different workspace, and a segment store that has never seen this ink.
    resetInkSegments(new MemorySegmentBackend());
    const other = setup();
    await other.migrationFactory().run();
    const target = other.createRuntime();
    await target.startup();
    const state = (await target.ensureSchemaV3()) as V2RuntimeState;
    let counter = 0;
    await importNotebookBundleAdditively(target, state, blob, (scope) => `${scope}-${++counter}`);
    const pages = (target.getState() as V2RuntimeState).pages;
    const counts: number[] = [];
    for (const page of pages) {
      counts.push(await target.readPage(page.pageId, (document) => Object.values(
        getSharedAutomergeSnapshot<LivePageDocV2>(document).elementsById).filter((element) => element.kind === 'stroke').length));
    }
    expect(counts).toContain(41);
    await target.shutdown();
  });

  it('seals pending ink before a bundle export reads the page bytes', async () => {
    resetInkSegments(new MemorySegmentBackend());
    const { runtime } = await workspaceWithInkPage(30);
    await draw(runtime, stroke('late', 800));
    const bytes = await runtime.readDocumentBytes('page:ink');
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(pendingInk().count('page:ink')).toBe(0);
    await runtime.shutdown();
  });
});

async function vi_waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Condition not met in time.');
}
