/**
 * The encrypted sync bridge with the lazy workspace runtime: only the open
 * page is registered with its handle, yet changes for the notebook's other
 * pages must be merged (not abort the catch-up) and local changes of those
 * pages must be sent.
 */
import * as Automerge from '@automerge/automerge';
import type { DocHandle } from '@automerge/automerge-repo';
import { describe, expect, it, vi } from 'vitest';
import { notebookWorkspaceDocuments } from '../../components/sync/controller';
import type { WorkspaceState } from '../../domain/types';
import type { PageDocV3 } from '../../domain/v3';
import type { RecoveryDraft } from '../../storage/recoveryJournal';
import {
  BrowserV2WorkspaceActivationStore,
  DefaultAutomergeMigrationMaterializer,
  InMemoryAutomergeRepoMigrationAdapter,
  V2WorkspaceMigrationOrchestrator,
  type V1WorkspaceMigrationSource,
} from '../../storage/v2WorkspaceStorage';
import { MemoryWorkspaceStore, memoryRepoFactory } from '../../storage/testing/memoryWorkspaceStore';
import { WorkspaceV2Runtime } from '../../storage/workspaceV2Runtime';
import { DocHandleSyncBridge } from './browserPorts';

const TIME = '2026-09-02T08:00:00.000Z';

function workspace(): WorkspaceState {
  return {
    schemaVersion: 1,
    updatedAt: TIME,
    notebooks: [{
      id: 'notebook-1', title: 'School', color: '#123456', createdAt: TIME, updatedAt: TIME,
      sections: [{
        id: 'section-1', title: 'Physics', createdAt: TIME, updatedAt: TIME,
        pages: [
          { id: 'page-1', title: 'Vectors', mode: 'a4', createdAt: TIME, updatedAt: TIME, elements: [] },
          { id: 'page-2', title: 'Forces', mode: 'a4', createdAt: TIME, updatedAt: TIME, elements: [] },
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
  async loadWorkspace() {
    return { workspace: workspace(), backend: 'indexeddb' as const };
  }
  async loadRecoveryDraft(): Promise<RecoveryDraft | null> {
    return null;
  }
}

async function startedRuntime(): Promise<WorkspaceV2Runtime> {
  const store = new MemoryWorkspaceStore();
  const source = new MemorySource();
  const activationStore = new BrowserV2WorkspaceActivationStore(store);
  const migrationFactory = () => new V2WorkspaceMigrationOrchestrator(
    source, activationStore, new InMemoryAutomergeRepoMigrationAdapter(),
    new DefaultAutomergeMigrationMaterializer(), { now: () => TIME },
  );
  await migrationFactory().run();
  const runtime = new WorkspaceV2Runtime({
    source, activationStore, repoFactory: memoryRepoFactory(store), migrationFactory,
    acquireWriteAccess: vi.fn(async () => 'indexeddb' as const),
  });
  await runtime.startup();
  await runtime.ensureSchemaV3();
  return runtime;
}

/** One change on top of the current page, as another device's encrypted change carries it. */
async function remoteChange(runtime: WorkspaceV2Runtime, pageId: string, title: string): Promise<Uint8Array> {
  const bytes = await runtime.readPage(pageId, (doc) => Automerge.save(doc));
  const base = Automerge.load<PageDocV3>(bytes);
  const changed = Automerge.change(Automerge.clone(base, { actor: 'abcdef01' }), (doc) => { doc.title = title; });
  const [change] = Automerge.getChanges(base, changed);
  if (!change) throw new Error('Expected one change.');
  return change;
}

function bridgeFor(runtime: WorkspaceV2Runtime) {
  const bridge = new DocHandleSyncBridge(notebookWorkspaceDocuments(runtime, 'notebook-1'));
  const captured: Array<{ documentId: string; change: Uint8Array }> = [];
  const detach = bridge.attachWorkspace((documentId, change) => { captured.push({ documentId, change }); });
  const openPage = runtime.getPageHandle('page-1') as unknown as DocHandle<object>;
  const unregister = bridge.register('page:page-1', openPage, (documentId, change) => { captured.push({ documentId, change }); });
  return { bridge, captured, dispose: () => { unregister(); detach(); } };
}

describe('DocHandleSyncBridge with the lazy workspace runtime', () => {
  it('merges a remote change for a page that is not open and keeps it out of memory', async () => {
    const runtime = await startedRuntime();
    const { bridge, captured, dispose } = bridgeFor(runtime);
    try {
      expect(runtime.isPageLoaded('page-2')).toBe(false);
      await bridge.applyRemoteChange('page:page-2', await remoteChange(runtime, 'page-2', 'Forces, from another device'));

      expect(runtime.isPageLoaded('page-2')).toBe(false);
      expect(runtime.getPageSummary('page-2')?.title).toBe('Forces, from another device');
      expect(await runtime.readPage('page-2', (doc) => doc.title)).toBe('Forces, from another device');
      // A received change is not sent back as a local one.
      expect(captured).toEqual([]);
    } finally {
      dispose();
      await runtime.shutdown();
    }
  });

  it('still merges changes for the registered open page through its handle', async () => {
    const runtime = await startedRuntime();
    const { bridge, captured, dispose } = bridgeFor(runtime);
    try {
      await bridge.applyRemoteChange('page:page-1', await remoteChange(runtime, 'page-1', 'Vectors, from another device'));
      expect(runtime.getPageHandle('page-1').doc().title).toBe('Vectors, from another device');
      expect(captured).toEqual([]);
    } finally {
      dispose();
      await runtime.shutdown();
    }
  });

  it('rejects a change for a document outside the notebook, as before', async () => {
    const runtime = await startedRuntime();
    const { bridge, dispose } = bridgeFor(runtime);
    try {
      await expect(bridge.applyRemoteChange('page:unknown', new Uint8Array([1, 2, 3]))).rejects.toThrow(/not part of this workspace|not open/);
    } finally {
      dispose();
      await runtime.shutdown();
    }
  });

  it('sends local changes of pages that are not open exactly once, and those of the open page once', async () => {
    const runtime = await startedRuntime();
    const { captured, dispose } = bridgeFor(runtime);
    try {
      const state = runtime.getState();
      if (state.schemaVersion === 1) throw new Error('Expected schema v3.');
      await runtime.commitWorkspaceGraphRevision({
        operationId: 'rename-unloaded',
        expectedActivationArtifactFingerprint: state.activation.artifactFingerprint,
        message: 'Rename a page that is not open',
        changes: [{
          documentId: 'page:page-2',
          change: (document) => {
            if (document.kind !== 'page') throw new Error('Expected page.');
            document.title = 'Renamed by a commit';
          },
        }],
      });
      expect(runtime.isPageLoaded('page-2')).toBe(false);
      await runtime.changePage('page-1', { message: 'Edit the open page' }, (draft) => { draft.title = 'Edited'; });

      expect(captured.map((entry) => entry.documentId)).toEqual(['page:page-2', 'page:page-1']);
      const renamed = Automerge.decodeChange(captured[0]!.change);
      expect(renamed.ops.length).toBeGreaterThan(0);
    } finally {
      dispose();
      await runtime.shutdown();
    }
  });
});
