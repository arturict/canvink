import { describe, expect, it } from 'vitest';
import type { WorkspaceState } from '../domain/types';
import {
  getAutomergeSnapshot,
  loadAutomergeDocument,
  materializeMigrationAsAutomerge,
  prepareV1ToAutomergeMigration,
  projectLiveRichText,
  type LivePageDocV2,
} from './index';
import { prepareV1ToV2Migration } from '../domain/v2';

const TIME = '2026-08-03T08:00:00.000Z';

function workspaceFixture(): WorkspaceState {
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
        pages: [{
          id: 'page-1',
          title: 'Vectors',
          mode: 'a4',
          background: 'grid',
          createdAt: TIME,
          updatedAt: TIME,
          elements: [
            {
              id: 'text-1',
              kind: 'text',
              x: 24,
              y: 48,
              width: 360,
              height: 180,
              text: 'First\n\nLast\n',
              color: '#112233',
              fontSize: 18,
              fontFamily: 'Inter',
              fontWeight: 700,
              fontStyle: 'italic',
              textDecoration: 'underline',
              textAlign: 'center',
              listStyle: 'bullet',
              createdAt: TIME,
              updatedAt: TIME,
            },
            {
              id: 'checklist-1',
              kind: 'checklist',
              x: 40,
              y: 260,
              width: 320,
              height: 120,
              color: '#334455',
              fontSize: 16,
              createdAt: TIME,
              updatedAt: TIME,
              items: [
                { id: 'check-1', text: 'Read chapter', checked: true },
                { id: 'check-2', text: 'Solve exercise', checked: false },
              ],
            },
          ],
        }],
      }],
    }],
    trash: [{
      id: 'trash-text-1',
      kind: 'element',
      deletedAt: TIME,
      origin: { notebookId: 'notebook-1', sectionId: 'section-1', pageId: 'page-1' },
      item: {
        id: 'deleted-text-1',
        kind: 'text',
        x: 5,
        y: 6,
        width: 100,
        height: 50,
        text: 'Deleted but preserved',
        color: '#000000',
        fontSize: 14,
        fontFamily: 'Inter',
        fontWeight: 400,
        createdAt: TIME,
        updatedAt: TIME,
      },
    }],
    activeNotebookId: 'notebook-1',
    activeSectionId: 'section-1',
    activePageId: 'page-1',
  };
}

describe('v1 to Automerge materialization', () => {
  it('creates deterministic Automerge binary documents that round-trip', async () => {
    const first = await prepareV1ToAutomergeMigration(workspaceFixture());
    const second = await prepareV1ToAutomergeMigration(workspaceFixture());

    expect(first.materialized.documents).toHaveLength(2);
    expect(first.materialized.documents.map((document) => document.documentId)).toEqual(
      second.materialized.documents.map((document) => document.documentId),
    );
    for (let index = 0; index < first.materialized.documents.length; index += 1) {
      const left = first.materialized.documents[index];
      const right = second.materialized.documents[index];
      expect(left.documentFormat).toBe('automerge');
      expect(left.encoding).toBe('binary');
      expect(left.version.protocol).toBe('automerge');
      expect(left.version.heads.length).toBeGreaterThan(0);
      expect([...left.bytes]).toEqual([...right.bytes]);
    }

    const storedPage = first.materialized.documents.find((document) => document.kind === 'page');
    if (!storedPage) throw new Error('Page fixture was not materialized.');
    const page = loadAutomergeDocument<LivePageDocV2>(storedPage.bytes, {
      expectedDocumentId: storedPage.documentId,
      expectedKind: 'page',
    });
    expect(getAutomergeSnapshot(page)).toMatchObject({
      documentId: 'page:page-1',
      title: 'Vectors',
    });
    expect(getAutomergeSnapshot(page)).not.toHaveProperty('version');
    const text = projectLiveRichText(page, 'text-1');
    expect(text.blocks.map((block) => block.type)).toEqual([
      'paragraph',
      'paragraph',
      'paragraph',
      'paragraph',
    ]);
    expect(text.blocks.map((block) => block.type === 'paragraph' ? block.list : undefined))
      .toEqual(['bullet', 'bullet', 'bullet', 'bullet']);
    expect(text.blocks.map((block) => block.type === 'table'
      ? ''
      : block.spans.map((span) => span.text).join(''))).toEqual(['First', '', 'Last', '']);
    expect(text.blocks[0].type === 'paragraph' ? text.blocks[0].spans[0].marks : []).toEqual([
      { type: 'bold' },
      { type: 'italic' },
      { type: 'underline' },
    ]);
    expect(projectLiveRichText(page, 'checklist-1').blocks).toMatchObject([
      { id: 'check-1', type: 'checkItem', checked: true },
      { id: 'check-2', type: 'checkItem', checked: false },
    ]);
    expect(first.migration.manifest.trash[0].element).toMatchObject({
      id: 'deleted-text-1',
      kind: 'richText',
      frame: { x: 5, y: 6, width: 100, height: 50, rotation: 0 },
    });
  });

  it('refuses to materialize a migration projection that no longer verifies', async () => {
    const migration = await prepareV1ToV2Migration(workspaceFixture());
    migration.documents[0].title = 'Tampered';

    await expect(materializeMigrationAsAutomerge(migration)).rejects.toThrow(/fingerprint/i);
  });
});
