/**
 * V9 (PERSONAL-SYNC.md §9 Wave 5 verification criteria; design rationale in
 * §5.6 "No double-apply with sharing"): a notebook that is simultaneously
 * shared and personal must not ping-pong. A remote change arriving through
 * the *personal* room merges into the shared `DocHandle`; that handle's
 * `change` event then makes the independent *sharing* port compute a diff
 * against its own baseline and forward exactly one frame to the shared
 * room — and it terminates there (no further callback fires from that single
 * remote change).
 *
 * This binds `createRuntimeEditorPort` (sharing, `src/components/collab`) and
 * `createRuntimeSpacePort` (personal, `src/personal-space`) to the SAME
 * `WorkspaceV2Runtime` handles, the same configuration `usePersonalSpaceSync`
 * and `useSharedNotebookSync` produce when a notebook is both shared and
 * personal, and drives the personal side directly (no real session/socket is
 * needed to exercise the mechanism the design describes).
 */

import * as Automerge from '@automerge/automerge';
import { describe, expect, it, vi } from 'vitest';
import { bindEditorSession, type RoomSession } from '../../collab';
import { createRuntimeEditorPort } from '../collab/runtimeEditorPort';
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
import { createRuntimeSpacePort } from '../../personal-space';

const TIME = '2026-09-02T08:00:00.000Z';

function workspaceState(): WorkspaceState {
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
  constructor(private readonly value: WorkspaceState) {}
  async loadWorkspace() {
    return { workspace: structuredClone(this.value), backend: 'indexeddb' as const };
  }
  async loadRecoveryDraft(): Promise<RecoveryDraft | null> {
    return null;
  }
}

async function setUpRuntime(): Promise<WorkspaceV2Runtime> {
  const store = new MemoryWorkspaceStore();
  const source = new MemorySource(workspaceState());
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
  const state = await runtime.ensureSchemaV3();
  if (state.schemaVersion !== 3) throw new Error('Expected schema v3.');
  return runtime;
}

function fakeSharedRoomSession(): RoomSession & { sendLocalChangeCalls: Array<[string, Uint8Array]> } {
  const docsChangedListeners = new Set<(docId: string) => void>();
  const calls: Array<[string, Uint8Array]> = [];
  return {
    sendLocalChangeCalls: calls,
    getStatus: () => 'live',
    getRole: () => 'owner',
    getDocs: () => new Map(),
    fetchDocs: async () => undefined,
    holdsDoc: () => false,
    awaitsFetch: () => false,
    getDoc: () => undefined,
    getDocBytes: () => undefined,
    getMemoryDiagnostics: () => ({ liveDocs: 0, storedBytes: 0 }),
    getResumeState: () => ({ docs: {} }),
    sendLocalChange: (docId, bytes) => { calls.push([docId, bytes]); },
    sendSnapshot: () => undefined,
    replaceDoc: () => undefined,
    getDocSeq: () => undefined,
    takeDocUpdates: () => ({ full: false }),
    announceDoc: () => undefined,
    removeDoc: () => undefined,
    subscribeDocsChanged: (listener) => {
      docsChangedListeners.add(listener);
      return () => docsChangedListeners.delete(listener);
    },
    subscribeAcked: () => () => undefined,
    sendReauth: () => undefined,
    subscribeReauthed: () => () => undefined,
    sendPresence: () => false,
    subscribePresence: () => () => undefined,
    subscribeSynced: () => () => undefined,
    getConfirmedHeads: () => undefined,
    close: () => undefined,
  };
}

async function settle(): Promise<void> {
  for (let round = 0; round < 3; round += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

async function remoteTitleChange(runtime: WorkspaceV2Runtime, documentId: string, title: string): Promise<Uint8Array> {
  // A "remote" change that extends the SAME history the local document holds
  // (so the apply below is a real merge, not a replacement).
  const current = await runtime.readDocument(documentId, (doc) => Automerge.save(doc as Automerge.Doc<PageDocV3>));
  const remote = Automerge.change(Automerge.load<PageDocV3>(current), (doc) => { doc.title = title; });
  return Automerge.save(remote);
}

describe('personal-space + sharing on the same notebook: no ping-pong (V9)', () => {
  for (const pageId of ['page-1', 'page-2']) {
    const loaded = pageId === 'page-1';
    it(`a personal-room remote change to ${loaded ? 'the open page' : 'a page that is not open'} produces exactly one forwarded frame to the shared room, and terminates`, async () => {
      const runtime = await setUpRuntime();
      expect(runtime.isPageLoaded(pageId)).toBe(loaded);

      const sharedSession = fakeSharedRoomSession();
      const unbindShared = bindEditorSession(sharedSession, createRuntimeEditorPort(runtime, 'notebook-1'));
      await unbindShared.idle();

      const personalPort = createRuntimeSpacePort(runtime, { onRemoteDocAdded: vi.fn() });

      try {
        // Simulate the personal session having received this and handed it to the port,
        // exactly as the personal-space binding does for a doc this device has.
        await personalPort.applyRemote(`page:${pageId}`, await remoteTitleChange(runtime, `page:${pageId}`, 'Edited via the personal room'));
        await settle();

        expect(sharedSession.sendLocalChangeCalls).toHaveLength(1);
        expect(sharedSession.sendLocalChangeCalls[0]?.[0]).toBe(`page:${pageId}`);

        // It terminates: no further callback fires from this single remote change, even after
        // more ticks (the regression this test guards against is an unbounded ping-pong).
        await settle();
        expect(sharedSession.sendLocalChangeCalls).toHaveLength(1);

        // The content actually merged (this is real convergence, not a coincidental call count),
        // and a page that was not open was merged in storage without staying loaded.
        expect(await runtime.readPage(pageId, (doc) => doc.title)).toBe('Edited via the personal room');
        expect(runtime.isPageLoaded(pageId)).toBe(loaded);
      } finally {
        unbindShared();
        await runtime.shutdown();
      }
    });
  }
});
