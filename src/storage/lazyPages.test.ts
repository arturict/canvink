import * as Automerge from '@automerge/automerge';
import { describe, expect, it, vi } from 'vitest';
import { getSharedAutomergeSnapshot, type LivePageDocV2 } from '../crdt';
import type { WorkspaceState } from '../domain/types';
import type { NotebookDocV3, PageDocV3 } from '../domain/v3';
import { DEFAULT_MATH_PAGE_SETTINGS } from '../domain/v3';
import type { RecoveryDraft } from './recoveryJournal';
import { PAGE_INDEX_NAMESPACE } from './pageIndex';
import { MemoryWorkspaceStore, memoryRepoFactory } from './testing/memoryWorkspaceStore';
import {
  BrowserV2WorkspaceActivationStore,
  DefaultAutomergeMigrationMaterializer,
  InMemoryAutomergeRepoMigrationAdapter,
  V2WorkspaceMigrationOrchestrator,
  type V1WorkspaceMigrationSource,
} from './v2WorkspaceStorage';
import { WorkspaceV2Runtime, type V2RuntimeState } from './workspaceV2Runtime';

const TIME = '2026-09-25T08:00:00.000Z';

function v1Workspace(): WorkspaceState {
  return {
    schemaVersion: 1,
    updatedAt: TIME,
    notebooks: [{
      id: 'notebook-1', title: 'Schule', color: '#123456', createdAt: TIME, updatedAt: TIME,
      sections: [{
        id: 'section-1', title: 'Physik', createdAt: TIME, updatedAt: TIME,
        pages: [{ id: 'page-1', title: 'Start', mode: 'a4', createdAt: TIME, updatedAt: TIME, elements: [] }],
      }],
    }],
    trash: [],
    activeNotebookId: 'notebook-1',
    activeSectionId: 'section-1',
    activePageId: 'page-1',
  };
}

const source: V1WorkspaceMigrationSource = {
  loadWorkspace: async () => ({ workspace: v1Workspace(), backend: 'indexeddb' as const }),
  loadRecoveryDraft: async (): Promise<RecoveryDraft | null> => null,
};

function strokePage(pageId: string, strokes: number, options: { notebookId?: string; sectionId?: string; title?: string } = {}): PageDocV3 {
  const elementsById: PageDocV3['elementsById'] = {};
  const zOrder: string[] = [];
  for (let index = 0; index < strokes; index += 1) {
    const id = `${pageId}-stroke-${index}`;
    elementsById[id] = {
      id, kind: 'stroke', frame: { x: index, y: index, width: 40, height: 20, rotation: 0 },
      createdAt: TIME, updatedAt: TIME, locked: false, tool: 'pen', color: '#111111', size: 2, opacity: 1,
      points: Array.from({ length: 8 }, (_, point) => ({
        x: index + point, y: index + point * 2, pressure: 0.5, tiltX: 0, tiltY: 0, time: point, pointerType: 'pen',
      })),
    };
    zOrder.push(id);
  }
  return {
    schemaVersion: 3, documentId: `page:${pageId}`, kind: 'page',
    notebookId: options.notebookId ?? 'notebook-1', sectionId: options.sectionId ?? 'section-1', pageId,
    title: options.title ?? `Seite ${pageId}`, tags: [], pageType: 'a4',
    background: { type: 'grid', color: '#ffffff' }, createdAt: TIME, updatedAt: TIME,
    elementsById, zOrder, mathSettings: { ...DEFAULT_MATH_PAGE_SETTINGS },
    pageContent: { version: 1, kind: 'canvas' }, version: { protocol: 'uninitialized', heads: [] },
  };
}

function setup(options: { pageCacheSize?: number; indexWriteDelayMs?: number } = {}) {
  const store = new MemoryWorkspaceStore();
  const activationStore = new BrowserV2WorkspaceActivationStore(store);
  const migrationFactory = () => new V2WorkspaceMigrationOrchestrator(
    source,
    activationStore,
    new InMemoryAutomergeRepoMigrationAdapter(),
    new DefaultAutomergeMigrationMaterializer(),
    { now: () => TIME },
  );
  const createRuntime = (overrides: { pageCacheSize?: number; pageCacheOperations?: number; indexWriteDelayMs?: number; startPageId?: () => string | undefined } = {}) => new WorkspaceV2Runtime({
    source,
    activationStore,
    repoFactory: memoryRepoFactory(store),
    migrationFactory,
    pageCacheSize: overrides.pageCacheSize ?? options.pageCacheSize ?? 2,
    pageCacheOperations: overrides.pageCacheOperations,
    indexWriteDelayMs: overrides.indexWriteDelayMs ?? options.indexWriteDelayMs ?? 20,
    startPageId: overrides.startPageId,
  });
  return { store, activationStore, migrationFactory, createRuntime };
}

function v3(state: ReturnType<WorkspaceV2Runtime['getState']>): V2RuntimeState {
  if (state.schemaVersion !== 3) throw new Error('Expected schema v3.');
  return state;
}

/** Adds pages to section-1 with one delta commit per batch. */
async function addPages(runtime: WorkspaceV2Runtime, pages: PageDocV3[]): Promise<void> {
  const state = v3(await runtime.ensureSchemaV3());
  await runtime.commitWorkspaceGraphRevision({
    operationId: `add-${pages[0]?.pageId}`,
    expectedActivationArtifactFingerprint: state.activation.artifactFingerprint,
    message: 'Add pages',
    newDocuments: pages,
    changes: [{
      documentId: 'notebook:notebook-1',
      change: (document) => {
        if (document.kind !== 'notebook') throw new Error('Expected notebook.');
        document.sections[0].pageDocumentIds.push(...pages.map((page) => page.documentId));
      },
    }],
    updateManifest: (manifest) => { manifest.pageDocumentIds.push(...pages.map((page) => page.documentId)); },
  });
}

async function seededWorkspace(pageCount: number, strokes = 20) {
  const context = setup();
  await context.migrationFactory().run();
  const runtime = context.createRuntime();
  await runtime.startup();
  for (let start = 0; start < pageCount; start += 10) {
    const batch = Array.from({ length: Math.min(10, pageCount - start) }, (_, offset) =>
      strokePage(`p${start + offset}`, strokes));
    await addPages(runtime, batch);
  }
  await runtime.shutdown();
  return context;
}

describe('lazy page loading', { timeout: 30_000 }, () => {
  it('opens a workspace with more pages than it keeps in memory and navigates through all of them', async () => {
    const context = await seededWorkspace(40);
    const runtime = context.createRuntime({ pageCacheSize: 2 });
    const state = v3(await runtime.startup());

    expect(state.pages).toHaveLength(41);
    expect(state.pages.find((page) => page.pageId === 'p39')?.title).toBe('Seite p39');
    // Only the active page is loaded; the others are summaries.
    expect(runtime.getMemoryDiagnostics()).toMatchObject({ loadedPages: 1, pageDocuments: 41 });
    expect(runtime.isPageLoaded('p39')).toBe(false);

    for (let index = 0; index < 40; index += 1) {
      const context = await runtime.navigateTo({ notebookId: 'notebook-1', sectionId: 'section-1', pageId: `p${index}` });
      expect(context.page.pageId).toBe(`p${index}`);
      expect(context.page.zOrder).toHaveLength(20);
      await expect.poll(() => runtime.getMemoryDiagnostics().loadedPages).toBeLessThanOrEqual(3);
    }
    await runtime.shutdown();
  }, 60_000);

  it('keeps fewer pages in memory when they are large, but always the one just left', async () => {
    const context = await seededWorkspace(6);
    // A budget of one operation: no page fits, so only the count's first slot
    // (the page most recently left) stays besides the active page.
    const runtime = context.createRuntime({ pageCacheSize: 4, pageCacheOperations: 1 });
    await runtime.startup();
    for (const index of [0, 1, 2, 3]) {
      await runtime.navigateTo({ notebookId: 'notebook-1', sectionId: 'section-1', pageId: `p${index}` });
    }

    await expect.poll(() => runtime.getMemoryDiagnostics().loadedPages).toBe(2);
    expect(runtime.isPageLoaded('p3')).toBe(true);
    expect(runtime.isPageLoaded('p2')).toBe(true);
    expect(runtime.isPageLoaded('p1')).toBe(false);
    await runtime.shutdown();

    // Without the budget the count alone decides.
    const unbounded = context.createRuntime({ pageCacheSize: 4 });
    await unbounded.startup();
    for (const index of [0, 1, 2, 3]) {
      await unbounded.navigateTo({ notebookId: 'notebook-1', sectionId: 'section-1', pageId: `p${index}` });
    }
    await expect.poll(() => unbounded.getMemoryDiagnostics().loadedPages).toBeGreaterThan(3);
    await unbounded.shutdown();
  });

  it('reads a page that is not open without keeping it loaded', async () => {
    const context = await seededWorkspace(5);
    const runtime = context.createRuntime();
    await runtime.startup();
    const strokes = await runtime.readPage('p3', (document) => document.zOrder.length);
    expect(strokes).toBe(20);
    expect(runtime.isPageLoaded('p3')).toBe(false);
    expect(runtime.getMemoryDiagnostics().loadedPages).toBe(1);
    await runtime.shutdown();
  });

  it('adds a page without loading or rewriting any other page', async () => {
    const context = await seededWorkspace(20);
    const runtime = context.createRuntime();
    await runtime.startup();
    const writesBefore = context.store.writeLog.length;
    await addPages(runtime, [strokePage('new-page', 3)]);
    const written = context.store.writeLog.slice(writesBefore).map((key) => key.join('/'));
    const pageStorageIds = v3(runtime.getState()).activation.documents
      .filter((document) => document.kind === 'page' && !document.documentId.includes('new-page'))
      .map((document) => document.url.replace('automerge:', ''));
    // Existing pages are neither loaded nor written by the commit.
    expect(runtime.getMemoryDiagnostics().loadedPages).toBe(1);
    expect(written.some((key) => pageStorageIds.some((id) => key.includes(`automerge-repo/${id}/`)))).toBe(false);
    expect(v3(runtime.getState()).pages.some((page) => page.pageId === 'new-page')).toBe(true);
    await runtime.shutdown();

    const reopened = context.createRuntime();
    const state = v3(await reopened.startup());
    expect(state.pages).toHaveLength(22);
    await expect(reopened.readPage('new-page', (document) => document.zOrder.length)).resolves.toBe(3);
    await reopened.shutdown();
  });

  it('moves a page that is not open into another section through a delta commit', async () => {
    const context = await seededWorkspace(3);
    const runtime = context.createRuntime();
    const state = v3(await runtime.startup());
    await runtime.commitWorkspaceGraphRevision({
      operationId: 'add-section',
      expectedActivationArtifactFingerprint: state.activation.artifactFingerprint,
      message: 'Move page p2',
      changes: [
        {
          documentId: 'notebook:notebook-1',
          change: (document) => {
            if (document.kind !== 'notebook') return;
            document.sections[0].pageDocumentIds = document.sections[0].pageDocumentIds.filter((id) => id !== 'page:p2');
            document.sections.push({ id: 'section-2', title: 'Chemie', createdAt: TIME, updatedAt: TIME, pageDocumentIds: ['page:p2'] });
          },
        },
        {
          documentId: 'page:p2',
          change: (document) => {
            if (document.kind === 'page') document.sectionId = 'section-2';
          },
        },
      ],
    });
    expect(runtime.isPageLoaded('p2')).toBe(false);
    expect(runtime.getPageSummary('p2')?.sectionId).toBe('section-2');
    await runtime.shutdown();
    const reopened = context.createRuntime();
    await reopened.startup();
    const moved = await reopened.navigateTo({ notebookId: 'notebook-1', sectionId: 'section-2', pageId: 'p2' });
    expect(moved.page.sectionId).toBe('section-2');
    await reopened.shutdown();
  });

  it('does not open a page that was deleted while it loaded', async () => {
    const context = await seededWorkspace(3, 2);
    const runtime = context.createRuntime({ pageCacheSize: 1 });
    const state = v3(await runtime.startup());
    const before = state.active;
    const target = state.pages.find((page) => page.pageId !== before.pageId && page.pageId.startsWith('p'));
    if (!target) throw new Error('Expected a second seeded page.');
    expect(runtime.isPageLoaded(target.pageId)).toBe(false);

    const storageId = state.activation.documents
      .find((document) => document.documentId === target.documentId)?.url.replace('automerge:', '');
    if (!storageId) throw new Error('Expected the target document in the activation.');
    // The page is still being read from storage when the deletion commits.
    const release = context.store.holdReads(storageId);
    const navigation = runtime.navigateTo({
      notebookId: target.notebookId, sectionId: target.sectionId, pageId: target.pageId,
    });
    await runtime.commitWorkspaceGraphRevision({
      operationId: 'trash-while-loading',
      expectedActivationArtifactFingerprint: state.activation.artifactFingerprint,
      message: 'Trash page',
      changes: [{
        documentId: 'notebook:notebook-1',
        change: (document) => {
          if (document.kind !== 'notebook') throw new Error('Expected notebook.');
          const section = document.sections[0];
          section.pageDocumentIds.splice(section.pageDocumentIds.indexOf(target.documentId), 1);
        },
      }],
      updateManifest: (manifest) => {
        manifest.trash.push({
          id: 'trash-target', kind: 'page', deletedAt: TIME, pageDocumentId: target.documentId,
          origin: { notebookId: target.notebookId, sectionId: target.sectionId },
        });
      },
    });
    release();
    // The navigation ends on the page that stays open instead of failing.
    await expect(navigation).resolves.toMatchObject({ page: { pageId: before.pageId } });

    const after = v3(runtime.getState());
    expect(after.active.pageId).not.toBe(target.pageId);
    expect(runtime.getActiveContext().page.pageId).toBe(after.active.pageId);
    await runtime.shutdown();
  });

  it('never drops unsaved changes when a page is evicted', async () => {
    const context = await seededWorkspace(4);
    const runtime = context.createRuntime({ pageCacheSize: 0, indexWriteDelayMs: 60_000 });
    await runtime.startup();
    await runtime.navigateTo({ notebookId: 'notebook-1', sectionId: 'section-1', pageId: 'p0' });
    const writer = await runtime.preparePageWrite('p0');
    // Edit and leave the page at once: the change is still only in memory.
    writer.change({ message: 'Last stroke' }, (page) => { page.title = 'Geändert vor dem Wechsel'; });
    await runtime.navigateTo({ notebookId: 'notebook-1', sectionId: 'section-1', pageId: 'p1' });
    await expect.poll(() => runtime.isPageLoaded('p0')).toBe(false);
    // The evicted page is written, and so is its index entry.
    expect(runtime.getPageSummary('p0')?.title).toBe('Geändert vor dem Wechsel');
    await expect(runtime.readPage('p0', (document) => document.title)).resolves.toBe('Geändert vor dem Wechsel');

    // Simulate a crash: the runtime is abandoned without flush or shutdown.
    const reopened = context.createRuntime();
    const state = v3(await reopened.startup());
    expect(state.pages.find((page) => page.pageId === 'p0')?.title).toBe('Geändert vor dem Wechsel');
    await expect(reopened.readPage('p0', (document) => document.title)).resolves.toBe('Geändert vor dem Wechsel');
    // Every evicted page kept its content (unloading must never store an empty document).
    await expect(reopened.readPage('page-1', (document) => document.title)).resolves.toBe('Start');
    await expect(reopened.readPage('p1', (document) => document.zOrder.length)).resolves.toBe(20);
    await reopened.shutdown();
  });

  it('keeps a retained page in memory until it is released', async () => {
    const context = await seededWorkspace(4);
    const runtime = context.createRuntime({ pageCacheSize: 0 });
    await runtime.startup();
    const release = await runtime.retainPage('p2');
    await runtime.navigateTo({ notebookId: 'notebook-1', sectionId: 'section-1', pageId: 'p1' });
    await runtime.navigateTo({ notebookId: 'notebook-1', sectionId: 'section-1', pageId: 'p3' });
    expect(runtime.isPageLoaded('p2')).toBe(true);
    release();
    await expect.poll(() => runtime.isPageLoaded('p2')).toBe(false);
    await runtime.shutdown();
  });

  it('rebuilds a page summary after a crash left the index behind the page', async () => {
    const context = await seededWorkspace(3);
    // A long index delay stands in for a crash between the page write and the index write.
    const runtime = context.createRuntime({ indexWriteDelayMs: 60_000 });
    await runtime.startup();
    await runtime.navigateTo({ notebookId: 'notebook-1', sectionId: 'section-1', pageId: 'p1' });
    await runtime.changePage('p1', { message: 'Rename' }, (page) => { page.title = 'Nach Absturz'; });
    // Wait for the Repo's throttled save of the page, then abandon the runtime.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const reopened = context.createRuntime();
    const state = v3(await reopened.startup());
    expect(state.pages.find((page) => page.pageId === 'p1')?.title).toBe('Nach Absturz');
    await reopened.shutdown();
  });

  it('does not report a flush done while an index write is still in flight', async () => {
    const context = await seededWorkspace(3);
    const runtime = context.createRuntime({ indexWriteDelayMs: 0 });
    await runtime.startup();
    await runtime.navigateTo({ notebookId: 'notebook-1', sectionId: 'section-1', pageId: 'p1' });
    // The timer's index write starts and waits on its storage read.
    const releases = context.store.keys([PAGE_INDEX_NAMESPACE]).map((key) => context.store.holdReads(key[1]));
    await runtime.changePage('p1', { message: 'Rename' }, (page) => { page.title = 'Neuer Titel'; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    let flushed = false;
    const flushing = runtime.flush().then(() => { flushed = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(flushed).toBe(false);
    for (const release of releases) release();
    await flushing;
    await runtime.shutdown();

    const reopened = context.createRuntime();
    const state = v3(await reopened.startup());
    expect(state.pages.find((page) => page.pageId === 'p1')?.title).toBe('Neuer Titel');
    await reopened.shutdown();
  });

  it('keeps the newest title when page changes follow each other while index writes run', async () => {
    const context = await seededWorkspace(2);
    const runtime = context.createRuntime({ indexWriteDelayMs: 0 });
    await runtime.startup();
    await runtime.navigateTo({ notebookId: 'notebook-1', sectionId: 'section-1', pageId: 'p1' });
    for (let round = 0; round < 20; round += 1) {
      await runtime.changePage('p1', { message: 'Rename' }, (page) => { page.title = `Titel ${round}`; });
      await runtime.changePage('p1', { message: 'Edit' }, (page) => { page.updatedAt = `2026-09-25T08:00:${String(round).padStart(2, '0')}.000Z`; });
      await new Promise((resolve) => setTimeout(resolve, round % 3));
    }
    await runtime.flush();
    await runtime.shutdown();

    const reopened = context.createRuntime();
    const state = v3(await reopened.startup());
    expect(state.pages.find((page) => page.pageId === 'p1')?.title).toBe('Titel 19');
    await reopened.shutdown();
  });

  it('applies a remote change to a page that is not open and persists it', async () => {
    const context = await seededWorkspace(3);
    const runtime = context.createRuntime();
    await runtime.startup();
    const events: string[] = [];
    runtime.subscribeToDocumentChanges((event) => {
      if (event.origin.kind === 'remote') events.push(`${event.documentId}:${event.origin.source}`);
    });
    // Another device's copy of page p2 with one more change.
    const bytes = await runtime.readPage('p2', (document) => {
      const remote = Automerge.change(Automerge.clone(document), (page) => { page.title = 'Vom Laptop'; });
      const change = Automerge.saveSince(remote, Automerge.getHeads(document));
      Automerge.free(remote);
      return change;
    });
    await expect(runtime.applyRemoteDocumentChanges('page:p2', bytes, { source: 'test' })).resolves.toBe('applied');
    expect(runtime.isPageLoaded('p2')).toBe(false);
    expect(runtime.getPageSummary('p2')?.title).toBe('Vom Laptop');
    expect(events).toEqual(['page:p2:test']);
    await expect(runtime.applyRemoteDocumentChanges('page:p2', bytes, { source: 'test' })).resolves.toBe('unchanged');
    await expect(runtime.applyRemoteDocumentChanges('page:unknown', bytes, { source: 'test' })).resolves.toBe('unknown');
    await runtime.shutdown();

    const reopened = context.createRuntime();
    await reopened.startup();
    await expect(reopened.readPage('p2', (document) => document.title)).resolves.toBe('Vom Laptop');
    await reopened.shutdown();
  });

  it('reports a throwing document change listener instead of swallowing it', async () => {
    const context = await seededWorkspace(2);
    const runtime = context.createRuntime();
    await runtime.startup();
    const failure = new Error('listener rejected the page');
    const reported: unknown[] = [];
    runtime.subscribeToListenerFailures((error) => reported.push(error));
    runtime.subscribeToDocumentChanges(() => { throw failure; });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await runtime.changePage('p1', { message: 'Rename' }, (page) => { page.title = 'Neu'; });
    logged.mockRestore();
    expect(reported).toEqual([failure]);
    await runtime.shutdown();
  });

  it('imports a notebook page by page with bounded memory and rolls it back without touching existing pages', async () => {
    const context = await seededWorkspace(2);
    const runtime = context.createRuntime();
    const state = v3(await runtime.startup());
    const pageIds = Array.from({ length: 30 }, (_, index) => `import-${index}`);
    const notebook: NotebookDocV3 = {
      schemaVersion: 3, documentId: 'notebook:imported', kind: 'notebook', notebookId: 'imported',
      title: 'bm', color: '#335577', createdAt: TIME, updatedAt: TIME,
      sections: [{ id: 'algebra', title: 'Algebra', createdAt: TIME, updatedAt: TIME, pageDocumentIds: pageIds.map((id) => `page:${id}`) }],
      settings: { defaultPageType: 'a4' }, version: { protocol: 'uninitialized', heads: [] },
    };
    const writer = await runtime.beginAdditiveImport({
      importId: 'bm-import', preparedAt: TIME, notebook, batchBytes: 64 * 1024,
    });
    for (const pageId of pageIds) {
      await writer.addPage(strokePage(pageId, 50, { notebookId: 'imported', sectionId: 'algebra' }));
      expect(runtime.getMemoryDiagnostics().loadedPages).toBe(1);
    }
    expect(writer.progress().pages).toBe(30);
    const result = await writer.commit(`sha256:${'7'.repeat(64)}`);
    expect(result).toMatchObject({ status: 'committed', pageDocumentIds: pageIds.map((id) => `page:${id}`) });
    const imported = v3(runtime.getState());
    expect(imported.pages).toHaveLength(33);
    expect(runtime.getMemoryDiagnostics().loadedPages).toBe(1);
    // The page's ink is held in segments; its snapshot lists every stroke.
    await expect(runtime.readPage('import-29', (document) => getSharedAutomergeSnapshot<LivePageDocV2>(document).zOrder.length)).resolves.toBe(50);

    // An edit to an existing page after the import survives the rollback.
    await runtime.changePage('page-1', { message: 'After import' }, (page) => { page.title = 'Nach dem Import'; });
    await runtime.flush();
    await expect(runtime.rollbackWorkspaceImport('bm-import')).resolves.toBe('rolled-back');
    const rolledBack = v3(runtime.getState());
    expect(rolledBack.pages).toHaveLength(3);
    expect(rolledBack.activation.artifactFingerprint).toBe(state.activation.artifactFingerprint);
    await expect(runtime.readPage('page-1', (document) => document.title)).resolves.toBe('Nach dem Import');
    const importedStorageIds = imported.activation.documents
      .filter((document) => document.documentId.startsWith('page:import-'))
      .map((document) => document.url.replace('automerge:', ''));
    expect(context.store.keys(['automerge-repo']).some((key) => importedStorageIds.includes(key[1]))).toBe(false);
    await runtime.shutdown();
  }, 60_000);

  it('opens a complete-image workspace unchanged and switches it to the live layout on the first commit', async () => {
    const context = setup();
    await context.migrationFactory().run();
    const before = await context.activationStore.getActivation();
    expect(before?.layout).toBeUndefined();
    expect(context.store.entries().some((record) => typeof record.key === 'string' && record.key.startsWith('repo-chunk:'))).toBe(true);

    const runtime = context.createRuntime();
    const opened = await runtime.startup();
    expect(opened).toMatchObject({ schemaVersion: 2, pages: [{ title: 'Start' }] });
    // Opening does not write the activation.
    expect(await context.activationStore.getActivation()).toEqual(before);

    await addPages(runtime, [strokePage('first-delta', 1)]);
    const after = await context.activationStore.getActivation();
    expect(after?.layout).toBe('repo-live');
    expect(context.store.entries().some((record) => typeof record.key === 'string' && record.key.startsWith('repo-chunk:'))).toBe(false);
    await runtime.shutdown();
    const reopened = context.createRuntime();
    expect(v3(await reopened.startup()).pages.map((page) => page.pageId)).toEqual(['page-1', 'first-delta']);
    await reopened.shutdown();
  });
});

describe('start page', () => {
  it('opens the page last viewed on this device instead of the stored target', async () => {
    const context = await seededWorkspace(4, 2);
    const stored = v3(await context.createRuntime().startup()).active.pageId;
    expect(stored).not.toBe('p2');

    const runtime = context.createRuntime({ startPageId: () => 'p2' });
    const state = v3(await runtime.startup());
    expect(state.active).toEqual({ notebookId: 'notebook-1', sectionId: 'section-1', pageId: 'p2' });
    expect(runtime.getActiveContext().page.pageId).toBe('p2');
    // Only that page was loaded to open the workspace.
    expect(runtime.getMemoryDiagnostics().loadedPages).toBe(1);
    expect(runtime.isPageLoaded(stored)).toBe(false);
    await runtime.shutdown();
  });

  it('starts on the stored target when the last viewed page cannot be read', async () => {
    const context = await seededWorkspace(3, 2);
    const first = context.createRuntime();
    const stored = v3(await first.startup()).active;
    const pageStorageId = v3(first.getState()).activation.documents
      .find((document) => document.documentId === 'page:p2')!.url.replace('automerge:', '');
    await first.shutdown();
    for (const key of context.store.keys(['automerge-repo', pageStorageId])) context.store.delete(key);

    const runtime = context.createRuntime({ startPageId: () => 'p2' });
    expect(v3(await runtime.startup()).active).toEqual(stored);
    await runtime.shutdown();
  });

  it('falls back to the stored target when the last viewed page is gone or in the trash', async () => {
    const context = await seededWorkspace(3, 2);
    const stored = v3(await context.createRuntime().startup()).active;

    const missing = context.createRuntime({ startPageId: () => 'no-such-page' });
    expect(v3(await missing.startup()).active).toEqual(stored);
    await missing.shutdown();

    const writer = context.createRuntime();
    const state = v3(await writer.ensureSchemaV3());
    const trashed = state.pages.find((page) => page.pageId === 'p1')!;
    await writer.commitWorkspaceGraphRevision({
      operationId: 'trash-p1',
      expectedActivationArtifactFingerprint: state.activation.artifactFingerprint,
      message: 'Trash page',
      changes: [{
        documentId: 'notebook:notebook-1',
        change: (document) => {
          if (document.kind !== 'notebook') throw new Error('Expected notebook.');
          const section = document.sections[0];
          section.pageDocumentIds.splice(section.pageDocumentIds.indexOf(trashed.documentId), 1);
        },
      }],
      updateManifest: (manifest) => {
        manifest.trash.push({
          id: 'trash-p1', kind: 'page', deletedAt: TIME, pageDocumentId: trashed.documentId,
          origin: { notebookId: 'notebook-1', sectionId: 'section-1' },
        });
      },
    });
    await writer.shutdown();

    const reopened = context.createRuntime({ startPageId: () => 'p1' });
    expect(v3(await reopened.startup()).active.pageId).not.toBe('p1');
    await reopened.shutdown();
  });
});
