import { describe, expect, it } from 'vitest';
import { prepareV1ToV2Migration } from '../domain/v2/migration';
import type { WorkspaceState } from '../domain/types';
import type { StoredDocumentV2 } from '../domain/v2/types';
import type { StoredCanvinkDocument } from '../domain/v3';
import { runAutomergeTask } from './automergeTaskCore';
import type { ActivatedDocumentV2, StagedRepoWorkspace } from './v2WorkspaceStorage';

const TIME = '2026-10-01T08:00:00.000Z';

function workspace(): WorkspaceState {
  return {
    schemaVersion: 1,
    updatedAt: TIME,
    notebooks: [{
      id: 'notebook-1',
      title: 'School',
      color: '#123456',
      createdAt: TIME,
      updatedAt: TIME,
      sections: [{
        id: 'section-1',
        title: 'Physics',
        createdAt: TIME,
        updatedAt: TIME,
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

describe('whole-workspace Automerge tasks', () => {
  it('materializes, stages, reopens and upgrades a workspace image the way the main thread does', async () => {
    const migration = await prepareV1ToV2Migration(workspace());
    const stored = await runAutomergeTask({ task: 'materialize', migration }) as StoredDocumentV2[];
    expect(stored.map((document) => document.documentId).sort()).toEqual(['notebook:notebook-1', 'page:page-1', 'page:page-2']);

    const staged = await runAutomergeTask({ task: 'stage', documents: stored as StoredCanvinkDocument[] }) as StagedRepoWorkspace;
    expect(staged.documents).toHaveLength(3);
    expect(staged.chunks.length).toBeGreaterThan(0);

    const reopened = await runAutomergeTask({ task: 'reopen', chunks: staged.chunks, documents: staged.documents as ActivatedDocumentV2[] });
    expect(reopened).toHaveLength(3);

    const upgraded = await runAutomergeTask({ task: 'upgradeSchemaV3', chunks: staged.chunks, documents: staged.documents as ActivatedDocumentV2[] }) as StagedRepoWorkspace;
    expect(upgraded.documents.map((document) => document.documentId).sort()).toEqual(staged.documents.map((document) => document.documentId).sort());
    // The upgrade is a new revision of every document, so the heads moved.
    for (const document of upgraded.documents) {
      const before = staged.documents.find((candidate) => candidate.documentId === document.documentId);
      expect(document.heads).not.toEqual(before?.heads);
    }
  });
});
