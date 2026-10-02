import { describe, expect, it } from 'vitest';
import type { WorkspaceState } from '../types';
import {
  migrationResultContainsInlineAssets,
  prepareV1ToV2Migration,
  verifyMigrationResult,
} from './migration';

const TIME = '2026-08-03T08:00:00.000Z';
const HELLO_DATA_URL = 'data:image/png;base64,SGVsbG8=';

function fixture(): WorkspaceState {
  return {
    schemaVersion: 1,
    updatedAt: TIME,
    notebooks: [
      {
        id: 'notebook-1',
        title: 'School',
        color: '#123456',
        createdAt: TIME,
        updatedAt: TIME,
        sections: [
          {
            id: 'section-1',
            title: 'Physics',
            createdAt: TIME,
            updatedAt: TIME,
            pages: [
              {
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
                    x: 10,
                    y: 20,
                    width: 300,
                    height: 80,
                    text: 'Result',
                    color: '#111111',
                    fontSize: 20,
                    fontFamily: 'Inter',
                    fontWeight: 700,
                    fontStyle: 'italic',
                    createdAt: TIME,
                    updatedAt: TIME,
                  },
                  {
                    id: 'shape-1',
                    kind: 'shape',
                    shapeType: 'arrow',
                    x: 30,
                    y: 40,
                    width: 120,
                    height: 20,
                    rotation: 15,
                    color: '#222222',
                    strokeWidth: 3,
                    createdAt: TIME,
                    updatedAt: TIME,
                  },
                  {
                    id: 'checklist-1',
                    kind: 'checklist',
                    x: 30,
                    y: 100,
                    width: 240,
                    height: 80,
                    color: '#222222',
                    fontSize: 18,
                    items: [{ id: 'check-1', text: 'Show work', checked: true }],
                    createdAt: TIME,
                    updatedAt: TIME,
                  },
                  {
                    id: 'stroke-1',
                    kind: 'stroke',
                    tool: 'pen',
                    x: 0,
                    y: 0,
                    points: [{
                      x: 1,
                      y: 2,
                      pressure: 0.5,
                      tiltX: 0,
                      tiltY: 0,
                      time: 1,
                      pointerType: 'pen',
                    }],
                    color: '#111111',
                    size: 4,
                    opacity: 1,
                    createdAt: TIME,
                    updatedAt: TIME,
                  },
                  {
                    id: 'image-1',
                    kind: 'image',
                    x: 50,
                    y: 60,
                    width: 100,
                    height: 80,
                    dataUrl: HELLO_DATA_URL,
                    name: 'diagram.png',
                    alt: 'diagram',
                    createdAt: TIME,
                    updatedAt: TIME,
                  },
                  {
                    id: 'pdf-1',
                    kind: 'pdf',
                    x: 70,
                    y: 80,
                    width: 200,
                    height: 250,
                    previewDataUrl: HELLO_DATA_URL,
                    sourceName: 'worksheet.pdf',
                    pageCount: 4,
                    createdAt: TIME,
                    updatedAt: TIME,
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
    trash: [
      {
        id: 'trash-1',
        kind: 'element',
        deletedAt: TIME,
        origin: { notebookId: 'notebook-1', sectionId: 'section-1', pageId: 'page-1' },
        item: {
          id: 'image-deleted',
          kind: 'image',
          x: 0,
          y: 0,
          width: 10,
          height: 10,
          dataUrl: HELLO_DATA_URL,
          name: 'deleted.png',
          alt: '',
          createdAt: TIME,
          updatedAt: TIME,
        },
      },
    ],
    activeNotebookId: 'notebook-1',
    activeSectionId: 'section-1',
    activePageId: 'page-1',
  };
}

describe('schema-v2 migration', () => {
  it('prepares deterministic documents and deduplicated checksum assets', async () => {
    const source = fixture();
    const before = structuredClone(source);

    const first = await prepareV1ToV2Migration(source);
    const second = await prepareV1ToV2Migration(source);

    expect(source).toEqual(before);
    expect(second).toEqual(first);
    expect(first.preview).toMatchObject({
      notebooks: 1,
      sections: 1,
      pages: 1,
      elements: 7,
      trashEntries: 1,
      uniqueAssets: 1,
      extractedAssetBytes: 5,
      previewOnlyPdfs: 1,
    });
    expect(first.assets[0]).toMatchObject({
      assetId: 'sha256:185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
      size: 5,
    });
    expect(migrationResultContainsInlineAssets(first)).toBe(false);
    const page = first.documents.find((document) => document.kind === 'page');
    expect(page?.background.type).toBe('grid');
    expect(page?.zOrder).toEqual(Object.keys(page?.elementsById ?? {}));
    expect(page?.elementsById['shape-1']).toMatchObject({
      kind: 'shape',
      shape: 'arrow',
      frame: { rotation: 15 },
    });
    expect(page?.elementsById['checklist-1']).toMatchObject({
      kind: 'richText',
      content: { blocks: [{ type: 'checkItem', checked: true }] },
    });
    expect(page?.elementsById['stroke-1']).toMatchObject({
      kind: 'stroke',
      tool: 'pen',
    });
    expect(page?.elementsById['pdf-1']).toMatchObject({
      kind: 'pdf',
      sourceAvailability: 'preview-only',
    });
  });

  it('fails closed on malformed inline data and leaves v1 untouched', async () => {
    const source = fixture();
    const image = source.notebooks[0].sections[0].pages[0].elements.find(
      (element) => element.kind === 'image',
    );
    if (!image || image.kind !== 'image') throw new Error('Fixture mismatch.');
    image.dataUrl = 'data:image/png;base64,%%%';
    const before = structuredClone(source);

    await expect(prepareV1ToV2Migration(source)).rejects.toThrow(/malformed|decode/i);
    expect(source).toEqual(before);
  });

  it('detects asset corruption before a result can be committed', async () => {
    const result = await prepareV1ToV2Migration(fixture());
    result.assets[0].bytes[0] ^= 0xff;

    await expect(verifyMigrationResult(result)).rejects.toThrow(/SHA-256/i);
  });

  it('rejects a page whose stable element map and z-order disagree', async () => {
    const result = await prepareV1ToV2Migration(fixture());
    const page = result.documents.find((document) => document.kind === 'page');
    if (!page || page.kind !== 'page') throw new Error('Page fixture mismatch.');
    page.zOrder.push(page.zOrder[0]);

    await expect(verifyMigrationResult(result)).rejects.toThrow(/duplicate z-order/i);
  });

  it('preserves the legacy implicit grid background', async () => {
    const source = fixture();
    delete source.notebooks[0].sections[0].pages[0].background;

    const result = await prepareV1ToV2Migration(source);
    const page = result.documents.find((document) => document.kind === 'page');

    expect(page?.background.type).toBe('grid');
  });
});
