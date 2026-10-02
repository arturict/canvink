import type { Repo } from '@automerge/automerge-repo';
import * as Automerge from '@automerge/automerge';
import type { ChangeFn } from '@automerge/automerge';
import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceState } from '../domain/types';
import type { MigrationManifestV2, NotebookDoc, PageDoc, Sha256Checksum } from '../domain/v2';
import type { PageDocV3 } from '../domain/v3';
import { MemoryCanvinkStorageBridge } from '../crdt/canvinkStorageAdapter';
import {
  createAutomergeDocument,
  type LiveCanvinkDocumentV2,
  saveAutomergeDocument,
  projectLiveRichText,
  seedPortableRichText,
  type LivePageDocV2,
  type PageAutomergeDoc,
} from '../crdt';
import { ReadOnlyDocumentError, setReadOnlyDocuments } from './readOnlyDocuments';
import { MemoryWorkspaceStore, memoryRepoFactory, memoryRepoSession, type MemoryRecord } from './testing/memoryWorkspaceStore';
import type { RecoveryDraft } from './recoveryJournal';
import {
  BrowserV2WorkspaceActivationStore,
  DefaultAutomergeMigrationMaterializer,
  InMemoryAutomergeRepoMigrationAdapter,
  V2WorkspaceMigrationOrchestrator,
  type V1WorkspaceMigrationSource,
  type V2WorkspaceActivationStore,
} from './v2WorkspaceStorage';
import {
  WorkspaceV2RecoveryRequiredError,
  WorkspaceV2Runtime,
  createBridgeBackedWorkspaceV2Runtime,
  type PersistentRepoFactory,
} from './workspaceV2Runtime';

const TIME = '2026-08-03T08:00:00.000Z';

function workspace(title = 'School'): WorkspaceState {
  return {
    schemaVersion: 1,
    updatedAt: TIME,
    notebooks: [{
      id: 'notebook-1',
      title,
      color: '#123456',
      createdAt: TIME,
      updatedAt: TIME,
      sections: [{
        id: 'section-1',
        title: 'Physics',
        createdAt: TIME,
        updatedAt: TIME,
        pages: [
          {
            id: 'page-1', title: 'Vectors', mode: 'a4',
            createdAt: TIME, updatedAt: TIME, elements: [],
          },
          {
            id: 'page-2', title: 'Forces', mode: 'a4',
            createdAt: TIME, updatedAt: TIME, elements: [],
          },
        ],
      }],
    }],
    trash: [],
    activeNotebookId: 'notebook-1',
    activeSectionId: 'section-1',
    activePageId: 'page-1',
  };
}

class MemorySource implements V1WorkspaceMigrationSource {
  loadCount = 0;

  constructor(private readonly value: WorkspaceState) {}

  async loadWorkspace() {
    this.loadCount += 1;
    return { workspace: structuredClone(this.value), backend: 'indexeddb' as const };
  }

  async loadRecoveryDraft(): Promise<RecoveryDraft | null> {
    return null;
  }
}

type MemoryAtomicStore = MemoryWorkspaceStore;

function runtimeSetup(value = workspace()) {
  const atomic: MemoryAtomicStore = new MemoryWorkspaceStore();
  const source = new MemorySource(value);
  const activationStore = new BrowserV2WorkspaceActivationStore(atomic);
  const close = vi.fn<() => void>();
  const repoFactory: PersistentRepoFactory = memoryRepoFactory(atomic, close);
  const migrationFactory = () => new V2WorkspaceMigrationOrchestrator(
    source,
    activationStore,
    new InMemoryAutomergeRepoMigrationAdapter(),
    new DefaultAutomergeMigrationMaterializer(),
    { now: () => TIME },
  );
  const acquireWriteAccess = vi.fn(async () => 'indexeddb' as const);
  const createRuntime = () => new WorkspaceV2Runtime({
    source,
    activationStore,
    repoFactory,
    migrationFactory,
    acquireWriteAccess,
  });
  return {
    atomic,
    source,
    activationStore,
    close,
    repoFactory,
    migrationFactory,
    acquireWriteAccess,
    createRuntime,
  };
}

async function activate(setup: ReturnType<typeof runtimeSetup>): Promise<void> {
  await setup.migrationFactory().run();
}

function importedNotebook(): { notebook: NotebookDoc; pages: PageDoc[] } {
  const page: PageDoc = {
    schemaVersion: 2,
    documentId: 'page:imported-page',
    kind: 'page',
    notebookId: 'imported-notebook',
    sectionId: 'imported-section',
    pageId: 'imported-page',
    title: 'Imported lesson',
    tags: [],
    pageType: 'a4',
    background: { type: 'grid', color: '#ffffff' },
    createdAt: TIME,
    updatedAt: TIME,
    elementsById: {},
    zOrder: [],
    version: { protocol: 'uninitialized', heads: [] },
  };
  const notebook: NotebookDoc = {
    schemaVersion: 2,
    documentId: 'notebook:imported-notebook',
    kind: 'notebook',
    notebookId: 'imported-notebook',
    title: 'Imported course',
    color: '#654321',
    createdAt: TIME,
    updatedAt: TIME,
    sections: [{
      id: 'imported-section',
      title: 'Lessons',
      createdAt: TIME,
      updatedAt: TIME,
      pageDocumentIds: [page.documentId],
    }],
    settings: { defaultPageType: 'a4' },
    version: { protocol: 'uninitialized', heads: [] },
  };
  return { notebook, pages: [page] };
}

describe('WorkspaceV2Runtime', () => {
  it('reads activation first and loads v1 only when activation is absent', async () => {
    const setup = runtimeSetup();
    const events: string[] = [];
    const store: V2WorkspaceActivationStore = {
      getActivation: async () => {
        events.push('activation');
        return setup.activationStore.getActivation();
      },
      commit: (commit) => setup.activationStore.commit(commit),
      readCommitted: (activation) => setup.activationStore.readCommitted(activation),
    };
    const source: V1WorkspaceMigrationSource = {
      loadWorkspace: async () => {
        events.push('v1');
        return setup.source.loadWorkspace();
      },
      loadRecoveryDraft: () => setup.source.loadRecoveryDraft(),
    };
    const runtime = new WorkspaceV2Runtime({
      source,
      activationStore: store,
      repoFactory: setup.repoFactory,
      acquireWriteAccess: setup.acquireWriteAccess,
    });

    await expect(runtime.startup()).resolves.toMatchObject({
      schemaVersion: 1,
      authoritative: 'v1',
      workspace: { activePageId: 'page-1' },
    });
    expect(events).toEqual(['activation', 'v1']);
    expect(setup.acquireWriteAccess).toHaveBeenCalledOnce();
  });

  it('opens every persistent Automerge root/page URL and exposes active navigation', async () => {
    const setup = runtimeSetup();
    await activate(setup);
    const runtime = setup.createRuntime();

    const state = await runtime.startup();
    expect(state).toMatchObject({
      schemaVersion: 2,
      authoritative: 'v2',
      active: { pageId: 'page-1' },
    });
    if (state.schemaVersion !== 2) throw new Error('Expected schema v2.');
    expect(state.notebooks.map((notebook) => notebook.title)).toEqual(['School']);
    expect(state.pages.map((page) => page.title)).toEqual(['Vectors', 'Forces']);
    expect(setup.source.loadCount).toBe(1); // migration only; startup did not load v1
    expect(runtime.getActiveContext().page.title).toBe('Vectors');
    expect((await runtime.navigateTo({
      notebookId: 'notebook-1', sectionId: 'section-1', pageId: 'page-2',
    })).page.title).toBe('Forces');
    expect(runtime.getPageHandle('page-1').doc().kind).toBe('page');
  });

  it('opens activated documents through an injected native/Tauri storage bridge', async () => {
    const setup = runtimeSetup();
    await activate(setup);
    const bridge = new MemoryCanvinkStorageBridge();
    const repoRecords = setup.atomic.entries().filter(
      (record): record is MemoryRecord & { key: string[]; value: Uint8Array } =>
        Array.isArray(record.key)
        && record.key[0] === 'automerge-repo'
        && record.value instanceof Uint8Array,
    );
    await bridge.commit(repoRecords.map((record) => ({
      type: 'save' as const,
      key: record.key,
      data: record.value,
    })));
    const acquireWriteAccess = vi.fn(async () => 'tauri' as const);
    const runtime = createBridgeBackedWorkspaceV2Runtime({
      source: setup.source,
      activationStore: setup.activationStore,
      bridge,
      acquireWriteAccess,
    });

    await expect(runtime.startup()).resolves.toMatchObject({
      schemaVersion: 2,
      authoritative: 'v2',
      active: { pageId: 'page-1' },
    });
    expect(acquireWriteAccess).toHaveBeenCalledOnce();
    await runtime.shutdown();
  });

  it('migrates only on explicit request, then reopens the persistent Repo', async () => {
    const setup = runtimeSetup();
    const runtime = setup.createRuntime();
    await runtime.startup();
    await expect(setup.atomic.get('activation:v2')).resolves.toBeUndefined();

    const state = await runtime.migrateV1ToV2();
    expect(state).toMatchObject({
      schemaVersion: 3,
      authoritative: 'v3',
    });
    expect(state.pages.map((page) => page.title)).toContain('Vectors');
    expect(state.pages.every((page) => page.schemaVersion === 3)).toBe(true);
    expect(state.pages.every((page) => !('mathSettings' in page))).toBe(true);
    expect(state.activation).toMatchObject({
      schemaVersion: 3,
      format: 'canvink-automerge-v3',
      manifest: { schemaVersion: 3, format: 'canvink-schema-v3' },
    });
    const committedV3 = await setup.atomic.get('activation:v2');
    await runtime.ensureSchemaV3();
    expect(await setup.atomic.get('activation:v2')).toEqual(committedV3);
    await expect(setup.atomic.get('activation:v2')).resolves.toBeDefined();
    expect(runtime.getActiveContext().page.pageId).toBe('page-1');
  });

  it('runs a schema upgrade requested while the migration publishes its first state only once', async () => {
    const setup = runtimeSetup();
    const runtime = setup.createRuntime();
    await runtime.startup();
    const concurrent: Array<Promise<unknown>> = [];
    // The editor asks for a writer as soon as it sees the first v2 state,
    // which the migration publishes before its own schema upgrade ran.
    runtime.subscribeToState((state) => {
      if (state.schemaVersion === 2 && concurrent.length === 0) concurrent.push(runtime.ensureSchemaV3());
    });
    const migrated = await runtime.migrateV1ToV2();
    await Promise.all(concurrent);
    expect(concurrent).toHaveLength(1);
    expect(migrated.schemaVersion).toBe(3);
    await runtime.shutdown();

    const reopened = setup.createRuntime();
    await expect(reopened.startup()).resolves.toMatchObject({ schemaVersion: 3 });
    const heads = reopened.getNotebookHandle('notebook-1').heads();
    expect(heads).toHaveLength(1);
    await reopened.shutdown();
  });

  it('keeps v1 state authoritative when explicit migration fails', async () => {
    const setup = runtimeSetup();
    const runtime = new WorkspaceV2Runtime({
      source: setup.source,
      activationStore: setup.activationStore,
      repoFactory: setup.repoFactory,
      migrationFactory: () => ({
        run: async () => { throw new Error('simulated migration failure'); },
      }) as unknown as V2WorkspaceMigrationOrchestrator,
    });
    await runtime.startup();

    await expect(runtime.migrateV1ToV2()).rejects.toThrow(/migration failure/i);
    expect(runtime.getState()).toMatchObject({ schemaVersion: 1, authoritative: 'v1' });
  });

  it('publishes page changes, flushes them, and reopens the updated persistent document', async () => {
    const setup = runtimeSetup();
    await activate(setup);
    const runtime = setup.createRuntime();
    await runtime.startup();
    await expect(runtime.changePage('page-1', { message: '   ' }, () => undefined)).rejects.toThrow(
      /requires a message/i,
    );
    expect(runtime.getState()).toMatchObject({ schemaVersion: 2 });
    const writer = await runtime.preparePageWrite('page-1');
    const listener = vi.fn();
    const unsubscribe = runtime.subscribeToPageChanges('page-1', listener);

    const changed = writer.change(
      { message: 'Rename page' },
      (document) => { document.title = 'Updated vectors'; },
    );
    expect(changed.title).toBe('Updated vectors');
    await vi.waitFor(() => expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Updated vectors' }),
    ));
    unsubscribe();
    await runtime.flush();
    await runtime.shutdown();
    expect(setup.close).toHaveBeenCalledTimes(2);

    const reopened = setup.createRuntime();
    await reopened.startup();
    expect(reopened.getActiveContext().page.title).toBe('Updated vectors');
    await reopened.shutdown();
  });

  it('migrates a v2 first page write atomically and never mutates the stale v2 handle', async () => {
    const setup = runtimeSetup();
    await activate(setup);
    const runtime = setup.createRuntime();
    await runtime.startup();
    const staleV2Handle = runtime.getPageHandle('page-1');
    const originalTitle = staleV2Handle.doc().title;

    const changed = await runtime.changePage(
      'page-1',
      { message: 'First v3 edit' },
      (document) => { document.title = 'Written on fresh v3 authority'; },
    );

    expect(changed).toMatchObject({ schemaVersion: 3, title: 'Written on fresh v3 authority' });
    const state = runtime.getState();
    expect(state).toMatchObject({ schemaVersion: 3, authoritative: 'v3' });
    if (state.schemaVersion === 1) throw new Error('Expected schema v3.');
    expect([...state.notebooks, ...state.pages].every((document) => document.schemaVersion === 3)).toBe(true);
    expect(staleV2Handle.doc()).toMatchObject({ schemaVersion: 2, title: originalTitle });
    expect(runtime.getPageHandle('page-1')).not.toBe(staleV2Handle);
    await runtime.shutdown();
  });

  it('prepares rich-text and drawing writes once, keeps them synchronous, and rejects a stale writer', async () => {
    const setup = runtimeSetup();
    await activate(setup);
    const commitRevision = vi.spyOn(setup.activationStore, 'commitActiveWorkspaceRevision');
    const runtime = setup.createRuntime();
    await runtime.startup();
    const staleV2Handle = runtime.getPageHandle('page-1');

    const writer = await runtime.preparePageWrite('page-1');
    expect(commitRevision).toHaveBeenCalledTimes(1);
    const firstWrite = writer.change({ message: 'Create collaborative notes' }, (page) => {
      page.elementsById.notes = {
        id: 'notes', kind: 'richText', frame: { x: 10, y: 10, width: 240, height: 100, rotation: 0 },
        createdAt: TIME, updatedAt: TIME, locked: false, text: '',
        style: { color: '#111111', fontFamily: 'sans-serif', fontSize: 16, textAlign: 'left' },
      };
      page.elementsById.ink = {
        id: 'ink', kind: 'stroke', frame: { x: 10, y: 120, width: 80, height: 40, rotation: 0 },
        createdAt: TIME, updatedAt: TIME, locked: false, tool: 'pen', color: '#111111', size: 2, opacity: 1,
        points: [
          { x: 10, y: 120, pressure: 0.4, tiltX: 0, tiltY: 0, time: 1, pointerType: 'pen' },
          { x: 90, y: 160, pressure: 0.7, tiltX: 0, tiltY: 0, time: 2, pointerType: 'pen' },
        ],
      };
      page.zOrder.push('notes', 'ink');
      seedPortableRichText(page, 'notes', {
        type: 'doc',
        blocks: [{ id: 'paragraph-1', type: 'paragraph', spans: [{ text: 'Newton', marks: [] }] }],
      });
    });
    expect(firstWrite).not.toBeInstanceOf(Promise);
    expect(firstWrite.schemaVersion).toBe(3);
    expect(projectLiveRichText(writer.handle.doc() as PageAutomergeDoc, 'notes'))
      .toMatchObject({ blocks: [{ spans: [{ text: 'Newton' }] }] });
    expect(staleV2Handle.doc().elementsById).not.toHaveProperty('notes');

    for (let index = 0; index < 32; index += 1) {
      const result = writer.change({ message: `Local edit ${index}` }, (page) => {
        page.updatedAt = `2026-08-03T00:00:${String(index).padStart(2, '0')}Z`;
      });
      expect(result).not.toBeInstanceOf(Promise);
    }
    expect(commitRevision).toHaveBeenCalledTimes(1);

    const state = runtime.getState();
    if (state.schemaVersion === 1) throw new Error('Expected schema v3.');
    // A delta commit leaves the loaded page in place, so the writer stays valid.
    await runtime.commitWorkspaceGraphRevision({
      operationId: 'touch-page',
      expectedActivationArtifactFingerprint: state.activation.artifactFingerprint,
      message: 'Touch the page',
      changes: [{ documentId: writer.handle.doc().documentId, change: () => undefined }],
    });
    expect(() => writer.change({ message: 'Still valid' }, () => undefined)).not.toThrow();
    // Reopening the workspace replaces every handle; the writer fails closed.
    const latest = runtime.getState();
    if (latest.schemaVersion === 1) throw new Error('Expected schema v3.');
    await runtime.shutdown();
    await runtime.startup();
    expect(() => writer.change({ message: 'Stale edit' }, () => undefined)).toThrow(/stale/i);
    await runtime.shutdown();
  });

  it('refuses local edits of documents of a notebook shared read-only, whichever way they come in', async () => {
    const setup = runtimeSetup();
    await activate(setup);
    const runtime = setup.createRuntime();
    await runtime.startup();
    const writer = await runtime.preparePageWrite('page-1');
    const documentId = writer.handle.doc().documentId;
    const state = runtime.getState();
    if (state.schemaVersion === 1) throw new Error('Expected schema v3.');

    setReadOnlyDocuments([documentId]);
    try {
      // The prepared writer of an open page.
      expect(() => writer.change({ message: 'Rename page' }, (page) => { page.title = 'Mine'; })).toThrow(ReadOnlyDocumentError);
      // A topology change that touches the document.
      await expect(runtime.commitWorkspaceGraphRevision({
        operationId: 'rename-in-reader-notebook',
        expectedActivationArtifactFingerprint: state.activation.artifactFingerprint,
        message: 'Rename page',
        changes: [{ documentId, change: () => undefined }],
      })).rejects.toThrow(ReadOnlyDocumentError);
      expect(writer.handle.doc().title).not.toBe('Mine');
    } finally {
      setReadOnlyDocuments([]);
    }
    // A promotion lifts the guard on the same writer.
    expect(() => writer.change({ message: 'Rename page' }, (page) => { page.title = 'Mine'; })).not.toThrow();
    await runtime.shutdown();
  });

  it('returns checked backup data and a detached, non-destructive rollback copy', async () => {
    const setup = runtimeSetup();
    await activate(setup);
    const runtime = setup.createRuntime();
    await runtime.startup();

    const backup = await runtime.getV1Backup();
    const copy = await runtime.createV1RollbackCopy();
    expect(backup?.workspace.notebooks[0].title).toBe('School');
    copy.notebooks[0].title = 'Local copy only';
    expect((await runtime.createV1RollbackCopy()).notebooks[0].title).toBe('School');
    expect(runtime.getState()).toMatchObject({ schemaVersion: 2, authoritative: 'v2' });
  });

  it('atomically extends, idempotently reconciles, and rolls back an imported notebook', async () => {
    const setup = runtimeSetup();
    await activate(setup);
    const runtime = setup.createRuntime();
    await runtime.startup();
    const state = await runtime.ensureSchemaV3();
    if (state.schemaVersion !== 3) throw new Error('Expected schema v3.');
    await runtime.changePage('page-1', { message: 'Unsquashed live edit' }, (page) => {
      page.title = 'Edited before import';
    });
    const imported = importedNotebook();
    const request = {
      importId: 'onenote-import-1',
      importArtifactFingerprint: `sha256:${'1'.repeat(64)}` as Sha256Checksum,
      expectedActivationArtifactFingerprint: state.activation.artifactFingerprint,
      ...imported,
      assets: [],
      preparedAt: TIME,
    };

    const committed = await runtime.extendActiveWorkspace(request);
    expect(committed).toMatchObject({
      status: 'committed',
      notebookDocumentId: imported.notebook.documentId,
      pageDocumentIds: [imported.pages[0].documentId],
    });
    expect(runtime.getState()).toMatchObject({ schemaVersion: 3 });
    const extendedState = runtime.getState();
    if (extendedState.schemaVersion !== 3) throw new Error('Expected extended schema v3.');
    expect(extendedState.notebooks.map((notebook) => notebook.title)).toEqual([
      'School',
      'Imported course',
    ]);
    expect(runtime.getPageHandle('page-1').doc().title).toBe('Edited before import');
    await expect(runtime.extendActiveWorkspace(request)).resolves.toMatchObject({
      status: 'already-committed',
      artifactFingerprint: committed.artifactFingerprint,
    });

    await expect(runtime.rollbackWorkspaceImport(request.importId)).resolves.toBe('rolled-back');
    const rolledBackState = runtime.getState();
    if (rolledBackState.schemaVersion !== 3) throw new Error('Expected restored schema v3.');
    expect(rolledBackState.notebooks.map((notebook) => notebook.title)).toEqual(['School']);
    expect(runtime.getPageHandle('page-1').doc().title).toBe('Edited before import');
    await expect(runtime.rollbackWorkspaceImport(request.importId)).resolves.toBe(
      'already-rolled-back',
    );
  });

  it('materializes genuine schema-v3 Math/Graph documents and refuses v2 downgrade documents', async () => {
    const setup = runtimeSetup();
    await activate(setup);
    const runtime = setup.createRuntime();
    await runtime.startup();
    const state = await runtime.ensureSchemaV3();
    if (state.schemaVersion !== 3) throw new Error('Expected schema v3.');
    const page: PageDocV3 = {
      schemaVersion: 3, documentId: 'page:math-copy', kind: 'page', notebookId: 'notebook-1',
      sectionId: 'section-1', pageId: 'math-copy', title: 'Math copy', tags: [], pageType: 'free',
      background: { type: 'grid', color: '#ffffff' }, createdAt: TIME, updatedAt: TIME,
      mathSettings: { version: 1, resultMode: 'suggest', numberMode: 'exact', angleMode: 'degrees', autoRecognition: true },
      elementsById: {
        math: {
          id: 'math', kind: 'math', frame: { x: 0, y: 0, width: 120, height: 50, rotation: 0 },
          createdAt: TIME, updatedAt: TIME, locked: false, inputKind: 'typed', autoRecognition: 'inherit', typedLatex: 'y=x^2',
          recognition: { state: 'idle', alternatives: [], warnings: [] }, result: { state: 'valid', exactLatex: 'x^2', diagnostics: [] },
          dependencies: { defines: ['y'], references: ['x'], dependsOnElementIds: [], state: 'valid' },
        },
        graph: {
          id: 'graph', kind: 'graph', frame: { x: 0, y: 60, width: 240, height: 160, rotation: 0 },
          createdAt: TIME, updatedAt: TIME, locked: false,
          series: [{ id: 'series', sourceMathElementId: 'math', color: '#3366cc', visible: true }],
          viewport: { xMin: -2, xMax: 2, yMin: -1, yMax: 4, equalScale: false, axesVisible: true, gridVisible: true },
        },
      },
      zOrder: ['math', 'graph'], version: { protocol: 'uninitialized', heads: [] },
    };
    const committed = await runtime.commitWorkspaceGraphRevision({
      operationId: 'add-v3-math-page', expectedActivationArtifactFingerprint: state.activation.artifactFingerprint,
      message: 'Add Math copy', newDocuments: [page],
      changes: [{
        documentId: 'notebook:notebook-1',
        change: (document) => {
          if (document.kind !== 'notebook') throw new Error('Expected notebook.');
          document.sections[0].pageDocumentIds.push(page.documentId);
        },
      }],
      updateManifest: (manifest) => { manifest.pageDocumentIds.push(page.documentId); },
      activatedAt: TIME,
    });
    expect(committed.schemaVersion).toBe(3);
    expect((await runtime.loadPage('math-copy')).doc().elementsById).toMatchObject({
      math: { kind: 'math', typedLatex: 'y=x^2' },
      graph: { kind: 'graph', series: [{ sourceMathElementId: 'math' }] },
    });

    const downgraded = { ...page, schemaVersion: 2, elementsById: {}, zOrder: [] } as unknown as PageDoc;
    await expect(runtime.commitWorkspaceGraphRevision({
      operationId: 'reject-v2-page', expectedActivationArtifactFingerprint: committed.activation.artifactFingerprint,
      message: 'Reject downgrade', newDocuments: [downgraded],
    })).rejects.toThrow(/Downgrade or implicit upgrade is refused/);
    const unchanged = runtime.getState();
    if (unchanged.schemaVersion === 1) throw new Error('Unexpected schema-v1 state.');
    expect(unchanged.pages.some((candidate) => candidate.documentId === downgraded.documentId && candidate.schemaVersion === 2)).toBe(false);

    await expect(runtime.commitWorkspaceGraphRevision({
      operationId: 'reject-v2-manifest', expectedActivationArtifactFingerprint: committed.activation.artifactFingerprint,
      message: 'Reject manifest downgrade',
      replacementManifest: {
        ...structuredClone(committed.activation.manifest), schemaVersion: 2, format: 'canvink-schema-v2',
      } as unknown as MigrationManifestV2,
    })).rejects.toThrow(/cannot change active schema v3 to v2/);
  });

  it('stays on the open page when a topology change such as a rename commits', async () => {
    const setup = runtimeSetup();
    await activate(setup);
    const runtime = setup.createRuntime();
    await runtime.startup();
    const state = await runtime.ensureSchemaV3();
    if (state.schemaVersion !== 3) throw new Error('Expected schema v3.');
    await runtime.navigateTo({ notebookId: 'notebook-1', sectionId: 'section-1', pageId: 'page-2' });

    await runtime.commitWorkspaceGraphRevision({
      operationId: 'rename-notebook',
      expectedActivationArtifactFingerprint: state.activation.artifactFingerprint,
      message: 'Rename notebook',
      changes: [{
        documentId: 'notebook:notebook-1',
        change: (document) => {
          if (document.kind !== 'notebook') throw new Error('Expected notebook.');
          document.title = 'Physik';
        },
      }],
    });

    expect(runtime.getActiveContext().notebook.title).toBe('Physik');
    expect(runtime.getActiveContext().page.title).toBe('Forces');
    await runtime.shutdown();
  });

  it('serializes overlapping topology transactions so a fail-mode second one fails as a conflict', async () => {
    const setup = runtimeSetup();
    await activate(setup);
    const runtime = setup.createRuntime();
    await runtime.startup();
    const state = await runtime.ensureSchemaV3();
    if (state.schemaVersion !== 3) throw new Error('Expected schema v3.');
    const fingerprint = state.activation.artifactFingerprint;

    const rename = (title: string) => runtime.commitWorkspaceGraphRevision({
      operationId: `rename-${title}`,
      expectedActivationArtifactFingerprint: fingerprint,
      message: `Rename to ${title}`,
      onConflict: 'fail',
      changes: [{
        documentId: 'notebook:notebook-1',
        change: (document) => {
          if (document.kind !== 'notebook') throw new Error('Expected notebook.');
          document.title = title;
        },
      }],
    });

    // Both operations start from the same fingerprint. Exactly one must win;
    // the other must fail closed rather than commit a second time and produce
    // a chimera that loses one operation's effect.
    const results = await Promise.allSettled([rename('Alpha'), rename('Beta')]);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      message: expect.stringMatching(/changed before the topology transaction/i),
    });

    const notebookTitle = runtime.getNotebookHandle('notebook-1').doc().title;
    expect(['Alpha', 'Beta']).toContain(notebookTitle);
    await runtime.shutdown();
  });

  describe('a local topology commit racing a sync adoption', () => {
    /** The second device's page, as the account delivers it: Automerge bytes with their history. */
    function remotePageBytes(pageId: string): Uint8Array {
      const page: PageDocV3 = {
        schemaVersion: 3, documentId: `page:${pageId}`, kind: 'page', notebookId: 'notebook-1',
        sectionId: 'section-1', pageId, title: `Remote ${pageId}`, tags: [], pageType: 'a4',
        background: { type: 'grid', color: '#ffffff' }, createdAt: TIME, updatedAt: TIME,
        elementsById: {}, zOrder: [], version: { protocol: 'uninitialized', heads: [] },
      };
      return saveAutomergeDocument(createAutomergeDocument(page));
    }

    /** A fake sync source: adopts one remote page into the workspace, the way the personal-space catch-up does. */
    async function adoptRemotePage(runtime: WorkspaceV2Runtime, pageId: string): Promise<void> {
      // Like the catch-up, it re-plans from the newest state when a commit beat it to the activation.
      for (let attempt = 0; ; attempt += 1) {
        try {
          await adoptRemotePageOnce(runtime, pageId);
          return;
        } catch (error) {
          if (attempt >= 5 || !/changed before the topology transaction/i.test(String(error))) throw error;
        }
      }
    }

    async function adoptRemotePageOnce(runtime: WorkspaceV2Runtime, pageId: string): Promise<void> {
      const current = runtime.getState();
      if (current.schemaVersion === 1) throw new Error('Expected schema v2/v3.');
      await runtime.commitWorkspaceGraphRevision({
        operationId: `sync-adopt-${pageId}`,
        expectedActivationArtifactFingerprint: current.activation.artifactFingerprint,
        onConflict: 'fail',
        message: 'Adopt remote page',
        adoptedDocuments: [{ documentId: `page:${pageId}`, kind: 'page', bytes: remotePageBytes(pageId) }],
        changes: [{
          documentId: 'notebook:notebook-1',
          change: (document) => {
            if (document.kind !== 'notebook') throw new Error('Expected notebook.');
            document.sections[0].pageDocumentIds.push(`page:${pageId}`);
          },
        }],
        updateManifest: (manifest) => { manifest.pageDocumentIds.push(`page:${pageId}`); },
      });
    }

    async function started() {
      const setup = runtimeSetup();
      await activate(setup);
      const runtime = setup.createRuntime();
      await runtime.startup();
      const state = await runtime.ensureSchemaV3();
      if (state.schemaVersion !== 3) throw new Error('Expected schema v3.');
      return { runtime, state };
    }

    const renameNotebook = (title: string) => ({
      documentId: 'notebook:notebook-1',
      change: ((document) => {
        if (document.kind !== 'notebook') throw new Error('Expected notebook.');
        document.title = title;
      }) as ChangeFn<LiveCanvinkDocumentV2>,
    });

    it('rebases a local commit onto the adopted state instead of failing', async () => {
      const { runtime, state } = await started();
      // The local commit read the fingerprint first; the adoption wins the queue.
      const adoption = adoptRemotePage(runtime, 'from-b');
      const local = runtime.commitWorkspaceGraphRevision({
        operationId: 'local-rename',
        expectedActivationArtifactFingerprint: state.activation.artifactFingerprint,
        message: 'Rename notebook',
        changes: [renameNotebook('Physik')],
      });
      await adoption;
      const next = await local;
      expect(next.notebooks[0].title).toBe('Physik');
      expect(next.pages.map((page) => page.pageId)).toContain('from-b');
      await runtime.shutdown();
    });

    it('keeps every local commit when adoptions keep interleaving', async () => {
      const { runtime, state } = await started();
      const fingerprint = state.activation.artifactFingerprint;
      const work: Array<Promise<unknown>> = [];
      for (let index = 0; index < 4; index += 1) {
        work.push(adoptRemotePage(runtime, `remote-${index}`));
        work.push(runtime.commitWorkspaceGraphRevision({
          operationId: `local-${index}`,
          expectedActivationArtifactFingerprint: fingerprint,
          message: `Local ${index}`,
          changes: [renameNotebook(`Titel ${index}`)],
        }));
      }
      await expect(Promise.all(work)).resolves.toBeDefined();
      const final = runtime.getState();
      if (final.schemaVersion === 1) throw new Error('Expected schema v2/v3.');
      expect(final.notebooks[0].title).toBe('Titel 3');
      expect(final.pages.filter((page) => page.pageId.startsWith('remote-'))).toHaveLength(4);
      await runtime.shutdown();
    });

    it('commits locally while a remote notebook change lists a page that is not adopted yet', async () => {
      const { runtime, state } = await started();
      // The second device added a page to the shared notebook; its change arrives before the page does.
      const local = runtime.getNotebookHandle('notebook-1').doc();
      const remote = Automerge.change(Automerge.load<LiveCanvinkDocumentV2>(Automerge.save(local)), (draft) => {
        if (draft.kind !== 'notebook') throw new Error('Expected notebook.');
        draft.sections[0].pageDocumentIds.push('page:not-adopted-yet');
      });
      const applied = await runtime.applyRemoteDocumentChanges(
        'notebook:notebook-1',
        Automerge.saveSince(remote, Automerge.getHeads(local)),
        { source: 'test' },
      );
      expect(applied).toBe('applied');

      const next = await runtime.commitWorkspaceGraphRevision({
        operationId: 'local-rename-during-adoption',
        expectedActivationArtifactFingerprint: state.activation.artifactFingerprint,
        message: 'Rename notebook',
        changes: [renameNotebook('Physik')],
      });
      expect(next.notebooks[0].title).toBe('Physik');
      await runtime.shutdown();
    });

    it('ignores a rebased removal of a page the adoption already removed, and still fails a fail-mode commit', async () => {
      const { runtime, state } = await started();
      const fingerprint = state.activation.artifactFingerprint;
      await adoptRemotePage(runtime, 'to-remove');
      const afterAdopt = runtime.getState();
      if (afterAdopt.schemaVersion === 1) throw new Error('Expected schema v2/v3.');
      const removal = {
        message: 'Delete page',
        removedDocumentIds: ['page:to-remove'],
        changes: [{
          documentId: 'notebook:notebook-1',
          change: ((document) => {
            if (document.kind !== 'notebook') throw new Error('Expected notebook.');
            document.sections[0].pageDocumentIds = document.sections[0].pageDocumentIds.filter((id) => id !== 'page:to-remove');
          }) as ChangeFn<LiveCanvinkDocumentV2>,
        }],
        updateManifest: (manifest: { pageDocumentIds: string[] }) => {
          manifest.pageDocumentIds = manifest.pageDocumentIds.filter((id) => id !== 'page:to-remove');
        },
      };
      await runtime.commitWorkspaceGraphRevision({
        ...removal, operationId: 'remove-1',
        expectedActivationArtifactFingerprint: afterAdopt.activation.artifactFingerprint,
      });
      // A second device's identical delete arrives from a stale read.
      await expect(runtime.commitWorkspaceGraphRevision({
        ...removal, operationId: 'remove-2', expectedActivationArtifactFingerprint: fingerprint,
      })).resolves.toBeDefined();
      await expect(runtime.commitWorkspaceGraphRevision({
        ...removal, operationId: 'remove-3', expectedActivationArtifactFingerprint: fingerprint, onConflict: 'fail',
      })).rejects.toThrow(/changed before the topology transaction/i);
      await runtime.shutdown();
    });
  });

  it('prunes the Automerge chunks of a permanently deleted page so its bytes cannot be recovered', async () => {
    const setup = runtimeSetup();
    await activate(setup);
    const runtime = setup.createRuntime();
    await runtime.startup();
    const state = await runtime.ensureSchemaV3();
    if (state.schemaVersion !== 3) throw new Error('Expected schema v3.');

    const page: PageDocV3 = {
      schemaVersion: 3, documentId: 'page:secret', kind: 'page', notebookId: 'notebook-1',
      sectionId: 'section-1', pageId: 'secret', title: 'Confidential exam key', tags: [], pageType: 'free',
      background: { type: 'grid', color: '#ffffff' }, createdAt: TIME, updatedAt: TIME,
      mathSettings: { version: 1, resultMode: 'suggest', numberMode: 'exact', angleMode: 'degrees', autoRecognition: true },
      elementsById: {
        note: {
          id: 'note', kind: 'math', frame: { x: 0, y: 0, width: 120, height: 50, rotation: 0 },
          createdAt: TIME, updatedAt: TIME, locked: false, inputKind: 'typed', autoRecognition: 'inherit',
          typedLatex: 'answer=42',
          recognition: { state: 'idle', alternatives: [], warnings: [] },
          result: { state: 'valid', exactLatex: '42', diagnostics: [] },
          dependencies: { defines: ['answer'], references: [], dependsOnElementIds: [], state: 'valid' },
        },
      },
      zOrder: ['note'], version: { protocol: 'uninitialized', heads: [] },
    };

    const added = await runtime.commitWorkspaceGraphRevision({
      operationId: 'add-secret-page', expectedActivationArtifactFingerprint: state.activation.artifactFingerprint,
      message: 'Add secret page', newDocuments: [page],
      changes: [{
        documentId: 'notebook:notebook-1',
        change: (document) => {
          if (document.kind !== 'notebook') throw new Error('Expected notebook.');
          document.sections[0].pageDocumentIds.push(page.documentId);
        },
      }],
      updateManifest: (manifest) => { manifest.pageDocumentIds.push(page.documentId); },
      activatedAt: TIME,
    });
    const secretUrl = added.activation.documents.find(
      (document) => document.documentId === page.documentId,
    )?.url;
    if (!secretUrl) throw new Error('Expected the secret page to be activated.');
    const secretDocumentId = secretUrl.replace('automerge:', '');
    expect(
      added.activation.chunks.some((chunk) => chunk.key.includes(secretDocumentId)),
    ).toBe(true);

    const deleted = await runtime.commitWorkspaceGraphRevision({
      operationId: 'purge-secret-page', expectedActivationArtifactFingerprint: added.activation.artifactFingerprint,
      message: 'Permanently delete secret page', removedDocumentIds: [page.documentId],
      changes: [{
        documentId: 'notebook:notebook-1',
        change: (document) => {
          if (document.kind !== 'notebook') throw new Error('Expected notebook.');
          document.sections[0].pageDocumentIds = document.sections[0].pageDocumentIds.filter(
            (id) => id !== page.documentId,
          );
        },
      }],
      updateManifest: (manifest) => {
        manifest.pageDocumentIds = manifest.pageDocumentIds.filter((id) => id !== page.documentId);
      },
      activatedAt: TIME,
    });
    // The descriptor list already drops the page; the leak is that its content
    // chunks stay in the committed bundle forever. Nothing keyed by the removed
    // document may survive in the new activation.
    expect(
      deleted.activation.documents.some((document) => document.documentId === page.documentId),
    ).toBe(false);
    expect(
      deleted.activation.chunks.some((chunk) => chunk.key.includes(secretDocumentId)),
    ).toBe(false);
    await runtime.shutdown();
  });

  it('returns typed recovery-required when activation cannot be read and never loads v1', async () => {
    const setup = runtimeSetup();
    const runtime = new WorkspaceV2Runtime({
      source: setup.source,
      activationStore: {
        getActivation: async () => { throw new Error('storage read failed'); },
        commit: (commit) => setup.activationStore.commit(commit),
        readCommitted: (activation) => setup.activationStore.readCommitted(activation),
      },
      repoFactory: setup.repoFactory,
    });

    await expect(runtime.startup()).rejects.toMatchObject({
      name: 'WorkspaceV2RecoveryRequiredError',
      code: 'activation-unreadable',
    });
    expect(setup.source.loadCount).toBe(0);
  });

  it('returns typed recovery-required for malformed activation without opening v1', async () => {
    const setup = runtimeSetup();
    await activate(setup);
    const activation = await setup.atomic.get<Record<string, unknown>>('activation:v2');
    setup.atomic.put('activation:v2', { ...activation, format: 'wrong' });
    const runtime = setup.createRuntime();

    await expect(runtime.startup()).rejects.toMatchObject({
      name: 'WorkspaceV2RecoveryRequiredError',
      code: 'activation-invalid',
    });
    expect(setup.source.loadCount).toBe(1);
  });

  it('opens without reading the v1 backup and reports a missing backup when it is needed', async () => {
    const setup = runtimeSetup();
    await activate(setup);
    const backup = setup.atomic.entries().find(
      (record) => typeof record.key === 'string' && record.key.startsWith('backup:'),
    );
    if (!backup) throw new Error('Expected activated backup.');
    setup.atomic.delete(backup.key);
    const runtime = setup.createRuntime();

    await expect(runtime.startup()).resolves.toMatchObject({ schemaVersion: 2 });
    await expect(runtime.createV1RollbackCopy()).rejects.toMatchObject({
      name: 'WorkspaceV2RecoveryRequiredError',
      code: 'committed-payload-corrupt',
    });
    expect(setup.source.loadCount).toBe(1);
  });

  it('returns typed recovery-required for an invalid active graph without v1 fallback', async () => {
    const setup = runtimeSetup();
    await activate(setup);
    const activation = await setup.atomic.get<Record<string, unknown>>('activation:v2');
    setup.atomic.put('activation:v2', {
      ...activation,
      manifest: {
        ...(activation?.manifest as Record<string, unknown>),
        active: { notebookId: 'notebook-1', sectionId: 'missing', pageId: 'page-1' },
      },
    });
    const runtime = setup.createRuntime();

    await expect(runtime.startup()).rejects.toMatchObject({
      name: 'WorkspaceV2RecoveryRequiredError',
      code: 'document-invalid',
    });
    expect(setup.source.loadCount).toBe(1);
  });

  it('closes an opened Repo when a document is unavailable', async () => {
    const setup = runtimeSetup();
    await activate(setup);
    const close = vi.fn();
    const runtime = new WorkspaceV2Runtime({
      source: setup.source,
      activationStore: setup.activationStore,
      repoFactory: () => ({
        repo: {
          find: async () => { throw new Error('not found'); },
          shutdown: async () => undefined,
        } as unknown as Repo,
        storage: memoryRepoSession(setup.atomic).storage,
        close,
      }),
    });

    await expect(runtime.startup()).rejects.toBeInstanceOf(WorkspaceV2RecoveryRequiredError);
    await expect(runtime.startup()).rejects.toMatchObject({ code: 'document-unavailable' });
    expect(close).toHaveBeenCalledTimes(2);
    expect(setup.source.loadCount).toBe(1);
  });

  it('startup is idempotent and shutdown removes page subscriptions', async () => {
    const setup = runtimeSetup();
    await activate(setup);
    const runtime = setup.createRuntime();
    const first = await runtime.startup();
    const second = await runtime.startup();
    expect(second).toEqual(first);
    const listener = vi.fn();
    runtime.subscribeToPageChanges('page-1', listener);
    const handle = runtime.getPageHandle('page-1');

    await runtime.shutdown();
    (handle as unknown as { change(change: ChangeFn<LivePageDocV2>): void }).change(
      (document) => { document.title = 'after close'; },
    );
    expect(listener).not.toHaveBeenCalled();
  });
});
