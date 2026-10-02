/**
 * A shared notebook's owner on the lazy workspace runtime: pages that are
 * not open are uploaded, receive a collaborator's edits and send changes the
 * owner's other sync channels made, without staying in memory.
 */
import * as Automerge from '@automerge/automerge';
import { describe, expect, it, vi } from 'vitest';
import { bindEditorSession, openRoomSession, type RoomSession } from '../../collab';
import { FakeRelay } from '../../collab/testRelay';
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
import { createRuntimeEditorPort } from './runtimeEditorPort';

const TIME = '2026-09-02T08:00:00.000Z';
const PAGE_COUNT = 6;

function workspace(): WorkspaceState {
  return {
    schemaVersion: 1,
    updatedAt: TIME,
    notebooks: [{
      id: 'notebook-1', title: 'School', color: '#123456', createdAt: TIME, updatedAt: TIME,
      sections: [{
        id: 'section-1', title: 'Physics', createdAt: TIME, updatedAt: TIME,
        pages: Array.from({ length: PAGE_COUNT }, (_, index) => ({
          id: `page-${index + 1}`, title: `Page ${index + 1}`, mode: 'a4' as const, createdAt: TIME, updatedAt: TIME, elements: [],
        })),
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

async function ownerRuntime(): Promise<WorkspaceV2Runtime> {
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
    pageCacheSize: 1,
  });
  await runtime.startup();
  await runtime.ensureSchemaV3();
  return runtime;
}

function session(relay: FakeRelay, mode: 'owner' | 'peer'): RoomSession {
  return openRoomSession({
    syncUrl: 'https://sync.example.com',
    roomId: 'room1',
    auth: mode === 'owner' ? { kind: 'owner', ownerToken: 'tok' } : { kind: 'link', linkSecret: 'secret' },
    webSocketFactory: relay.factory(),
    ...(mode === 'owner' ? { resyncStrategy: 'reconcile' as const, docStorage: 'bytes' as const } : {}),
    callbacks: { onStatus: () => undefined },
  });
}

async function settle(idle: () => Promise<void>): Promise<void> {
  for (let round = 0; round < 12; round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 3));
    await idle();
  }
}

describe('shared notebook owner on the lazy runtime', () => {
  it('uploads, receives and sends changes of pages that are not open, one page in memory at a time', async () => {
    const runtime = await ownerRuntime();
    const relay = new FakeRelay();
    const owner = session(relay, 'owner');
    const binding = bindEditorSession(owner, createRuntimeEditorPort(runtime, 'notebook-1'));
    let maxLoadedPages = 0;
    const unsubscribe = runtime.subscribeToDocumentChanges(() => {
      maxLoadedPages = Math.max(maxLoadedPages, runtime.getMemoryDiagnostics().loadedPages);
    });
    try {
      // The room was empty: the reconcile after the first catch-up uploads every page.
      await settle(binding.idle);
      expect(relay.docs.size).toBe(PAGE_COUNT + 1);
      expect(runtime.isPageLoaded('page-4')).toBe(false);

      // A collaborator edits a page the owner does not have open.
      const peer = session(relay, 'peer');
      await settle(binding.idle);
      const peerCopy = peer.getDoc('page:page-4') as Automerge.Doc<PageDocV3>;
      const edited = Automerge.change(Automerge.clone(peerCopy), (doc) => { doc.title = 'Edited by a collaborator'; });
      peer.sendLocalChange('page:page-4', Automerge.saveSince(edited, Automerge.getHeads(peerCopy)));
      await settle(binding.idle);

      expect(runtime.isPageLoaded('page-4')).toBe(false);
      expect(runtime.getPageSummary('page-4')?.title).toBe('Edited by a collaborator');

      // Another of the owner's sync channels (the personal space) changes a page that is not open.
      const current = await runtime.readDocument('page:page-5', (doc) => Automerge.save(doc as Automerge.Doc<PageDocV3>));
      const fromAccount = Automerge.change(Automerge.load<PageDocV3>(current), (doc) => { doc.title = 'Renamed by the owner'; });
      expect(await runtime.applyRemoteDocumentChanges('page:page-5', Automerge.save(fromAccount), { source: 'personal-space' }))
        .toBe('applied');
      await settle(binding.idle);
      expect((peer.getDoc('page:page-5') as PageDocV3).title).toBe('Renamed by the owner');
      expect(runtime.isPageLoaded('page-5')).toBe(false);
      // Besides the open page, at most the configured cache held pages; nothing loaded them all.
      expect(maxLoadedPages).toBeLessThanOrEqual(2);
      expect(owner.getMemoryDiagnostics().liveDocs).toBeLessThanOrEqual(1);
      peer.close();
    } finally {
      unsubscribe();
      binding();
      owner.close();
      await runtime.shutdown();
    }
  });
});
