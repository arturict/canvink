import * as Automerge from '@automerge/automerge';
import { describe, expect, it, vi } from 'vitest';
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
import { adoptRemotePage, adoptSharedNotebook, JoinRoomError, type SharedNotebookDocuments } from './adoptSharedDocuments';

const TIME = '2026-10-01T08:00:00.000Z';

function workspaceState(notebookId: string, title: string, pageIds: string[]): WorkspaceState {
  return {
    schemaVersion: 1,
    updatedAt: TIME,
    notebooks: [{
      id: notebookId, title, color: '#123456', createdAt: TIME, updatedAt: TIME,
      sections: [{
        id: `${notebookId}-section`, title: 'Physik', createdAt: TIME, updatedAt: TIME,
        pages: pageIds.map((id) => ({
          id, title: id, mode: 'a4' as const, createdAt: TIME, updatedAt: TIME, elements: [],
        })),
      }],
    }],
    trash: [],
    activeNotebookId: notebookId,
    activeSectionId: `${notebookId}-section`,
    activePageId: pageIds[0],
  };
}

async function setUpRuntime(notebookId: string, title: string, pageIds: string[]): Promise<WorkspaceV2Runtime> {
  const store = new MemoryWorkspaceStore();
  const source: V1WorkspaceMigrationSource = {
    loadWorkspace: async () => ({ workspace: structuredClone(workspaceState(notebookId, title, pageIds)), backend: 'indexeddb' as const }),
    loadRecoveryDraft: async (): Promise<RecoveryDraft | null> => null,
  };
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

async function roomCopy(owner: WorkspaceV2Runtime, pageIds: string[]): Promise<SharedNotebookDocuments> {
  const state = owner.getState();
  if (state.schemaVersion === 1) throw new Error('Expected a v2/v3 workspace.');
  const notebook = state.notebooks[0];
  const bytes = (documentId: string) => owner.readDocumentBytes(documentId);
  return {
    roomId: 'room-1',
    role: 'editor',
    notebookDocumentId: notebook.documentId,
    notebookId: notebook.notebookId,
    title: notebook.title,
    pageDocumentIds: pageIds.map((id) => `page:${id}`),
    documents: [
      { documentId: notebook.documentId, kind: 'notebook', bytes: await bytes(notebook.documentId) },
      ...await Promise.all(pageIds.map(async (id) => ({ documentId: `page:${id}`, kind: 'page' as const, bytes: await bytes(`page:${id}`) }))),
    ],
  };
}

/** A collaborator's new page: the notebook lists it and its document joins the workspace. */
async function addPage(runtime: WorkspaceV2Runtime, pageId: string): Promise<void> {
  const state = runtime.getState();
  if (state.schemaVersion === 1) throw new Error('Expected a v2/v3 workspace.');
  const notebook = state.notebooks[0];
  const template = await runtime.readDocument('page:page-1', (document) => JSON.parse(JSON.stringify(Automerge.toJS(document as Automerge.Doc<unknown>))) as PageDocV3);
  const page: PageDocV3 = { ...template, documentId: `page:${pageId}`, pageId, title: pageId };
  // The collaborator's own workspace is where this transaction belongs; the code under test must never run one.
  // eslint-disable-next-line no-restricted-syntax
  await runtime.commitWorkspaceGraphRevision({
    operationId: `add-${pageId}`,
    expectedActivationArtifactFingerprint: state.activation.artifactFingerprint,
    message: 'Seite hinzugefügt',
    newDocuments: [page],
    changes: [{
      documentId: notebook.documentId,
      change: (document) => {
        if (document.kind === 'notebook') document.sections[0].pageDocumentIds.push(page.documentId);
      },
    }],
    updateManifest: (manifest) => { manifest.pageDocumentIds.push(page.documentId); },
  });
}

describe('adopting a shared notebook into a workspace', () => {
  it('adds the notebook and its pages with their history, once', async () => {
    const owner = await setUpRuntime('notebook-1', 'Gemeinsam', ['page-1', 'page-2']);
    const member = await setUpRuntime('notebook-own', 'Eigenes', ['page-own']);
    try {
      const shared = await roomCopy(owner, ['page-1', 'page-2']);
      expect(await adoptSharedNotebook(member, shared)).toEqual({ notebookId: 'notebook-1', added: true });

      const state = member.getState();
      if (state.schemaVersion === 1) throw new Error('Expected a v2/v3 workspace.');
      expect(state.notebooks.map((notebook) => notebook.title).sort()).toEqual(['Eigenes', 'Gemeinsam']);
      expect(state.pages.map((page) => page.documentId)).toEqual(expect.arrayContaining(['page:page-own', 'page:page-1', 'page:page-2']));

      // The adopted page shares its history with the owner's page, so later changes merge instead of duplicating.
      const ownerPage = await owner.readDocumentBytes('page:page-1');
      const memberHeads = member.getDocumentHeads('page:page-1');
      expect(memberHeads).toEqual(Automerge.getHeads(Automerge.load(ownerPage)));

      // The same link opened again leaves the workspace as it is.
      expect(await adoptSharedNotebook(member, shared)).toEqual({ notebookId: 'notebook-1', added: false });
      expect(member.getState()).toBe(state);
    } finally {
      await owner.shutdown();
      await member.shutdown();
    }
  });

  it('refuses a notebook whose page ids the workspace already holds in another notebook', async () => {
    const owner = await setUpRuntime('notebook-1', 'Gemeinsam', ['page-1']);
    // An older install: its own start page has the same id, with an unrelated history.
    const member = await setUpRuntime('notebook-own', 'Eigenes', ['page-1']);
    try {
      const before = member.getState();
      await expect(adoptSharedNotebook(member, await roomCopy(owner, ['page-1']))).rejects.toBeInstanceOf(JoinRoomError);
      expect(member.getState()).toBe(before);
    } finally {
      await owner.shutdown();
      await member.shutdown();
    }
  });

  it('adopts a page a collaborator added, but only one that belongs to the notebook', async () => {
    const owner = await setUpRuntime('notebook-1', 'Gemeinsam', ['page-1', 'page-2']);
    const member = await setUpRuntime('notebook-own', 'Eigenes', ['page-own']);
    const stranger = await setUpRuntime('notebook-x', 'Fremd', ['page-x']);
    try {
      await adoptSharedNotebook(member, await roomCopy(owner, ['page-1', 'page-2']));
      await addPage(owner, 'page-3');

      // The room delivers the notebook's update first, then the new page document.
      const notebookId = 'notebook:notebook-1';
      expect(await member.applyRemoteDocumentChanges(notebookId, await owner.readDocumentBytes(notebookId), { source: 'collab:notebook-1' })).toBe('applied');
      expect(member.getDocumentHeads('page:page-3')).toBeUndefined();
      await adoptRemotePage(member, 'notebook-1', 'page:page-3', 'page', await owner.readDocumentBytes('page:page-3'));
      expect(member.getDocumentHeads('page:page-3')).toBeDefined();

      // A page of some other notebook is not this notebook's.
      await adoptRemotePage(member, 'notebook-1', 'page:page-x', 'page', await stranger.readDocumentBytes('page:page-x'));
      expect(member.getDocumentHeads('page:page-x')).toBeUndefined();
    } finally {
      await owner.shutdown();
      await member.shutdown();
      await stranger.shutdown();
    }
  });
});
