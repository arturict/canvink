import { describe, expect, it } from 'vitest';
import type { PdfElementV2 } from '../../domain/v2';
import type { PortableWorkspaceJsonV3 } from '../../io/currentSchemaJson';
import {
  isStructuralPdfBackground,
  layoutPdfPrintoutElements,
  layoutPdfPrintoutFrames,
  mathSettingsForPdfExport,
  remapPortableWorkspaceForAdditiveImport,
} from './AssetWorkspaceControls';

const TIME = '2026-08-03T00:00:00.000Z';
const ASSET_ID = `sha256:${'a'.repeat(64)}` as PdfElementV2['previewAsset']['assetId'];

function pdfElement(id: string, width: number, height: number): PdfElementV2 {
  const previewAsset: PdfElementV2['previewAsset'] = {
    assetId: ASSET_ID,
    checksum: ASSET_ID,
    role: 'preview',
    mimeType: 'image/png',
    size: 12,
  };
  return {
    id,
    kind: 'pdf',
    frame: { x: 0, y: 0, width, height, rotation: 0 },
    createdAt: TIME,
    updatedAt: TIME,
    locked: true,
    originalAsset: { ...previewAsset, role: 'original', mimeType: 'application/pdf' },
    previewAsset,
    pageCount: 2,
    sourcePageNumber: 1,
    sourceAvailability: 'original',
  };
}

function payload(): PortableWorkspaceJsonV3 {
  return {
    format: 'canvink-portable-json-v3',
    schemaVersion: 3,
    exportedAt: TIME,
    notebook: {
      schemaVersion: 3, documentId: 'notebook:old', kind: 'notebook', notebookId: 'old',
      title: 'Algebra', color: '#123456', createdAt: TIME, updatedAt: TIME,
      sections: [{ id: 'section-old', title: 'A', createdAt: TIME, updatedAt: TIME, pageDocumentIds: ['page:parent', 'page:child'] }],
      settings: { defaultPageType: 'free' }, version: { protocol: 'uninitialized', heads: [] },
    },
    pages: [
      {
        schemaVersion: 3, documentId: 'page:parent', kind: 'page', notebookId: 'old', sectionId: 'section-old',
        pageId: 'parent', title: 'Parent', tags: [], pageType: 'free', background: { type: 'plain', color: '#fff' },
        createdAt: TIME, updatedAt: TIME, elementsById: {}, zOrder: [],
        mathSettings: { version: 1, resultMode: 'suggest', numberMode: 'exact', angleMode: 'degrees', autoRecognition: true },
        version: { protocol: 'uninitialized', heads: [] },
      },
      {
        schemaVersion: 3, documentId: 'page:child', kind: 'page', notebookId: 'old', sectionId: 'section-old',
        pageId: 'child', parentPageId: 'parent', title: 'Child', tags: [], pageType: 'free', background: { type: 'grid', color: '#fff' },
        createdAt: TIME, updatedAt: TIME, elementsById: {}, zOrder: [],
        mathSettings: { version: 1, resultMode: 'insert', numberMode: 'decimal', angleMode: 'radians', autoRecognition: false },
        version: { protocol: 'uninitialized', heads: [] },
      },
    ],
  };
}

describe('current schema JSON additive UI mapping', () => {
  it('binds PDF Math and Graph rendering to the persisted page modes', () => {
    expect(mathSettingsForPdfExport(payload().pages[1])).toEqual({ numberMode: 'decimal', angleMode: 'radians' });
    expect(mathSettingsForPdfExport({})).toEqual({ numberMode: 'exact', angleMode: 'degrees' });
  });

  it('remaps the complete notebook graph without mutating the validated payload', () => {
    const source = payload();
    const snapshot = structuredClone(source);
    let sequence = 0;
    const remapped = remapPortableWorkspaceForAdditiveImport(
      source,
      (scope) => `${scope}-${++sequence}`,
      '2026-08-03T01:00:00.000Z',
    );

    expect(source).toEqual(snapshot);
    expect(remapped.notebook.notebookId).not.toBe('old');
    expect(remapped.notebook.schemaVersion).toBe(3);
    expect(remapped.pages).toHaveLength(2);
    expect(remapped.notebook.sections[0]?.pageDocumentIds).toEqual(remapped.pages.map((page) => page.documentId));
    expect(remapped.pages[1]?.parentPageId).toBe(remapped.pages[0]?.pageId);
    expect(remapped.pages[1]?.mathSettings).toEqual(source.pages[1]?.mathSettings);
    expect(remapped.pages.every((page) => page.notebookId === remapped.notebook.notebookId)).toBe(true);
  });
});

describe('PDF printout placement', () => {
  it('lays every preview below existing content, proportionally capped at 720px, as page backgrounds', () => {
    const source = [pdfElement('pdf-1', 1_440, 2_000), pdfElement('pdf-2', 600, 800)];
    const snapshot = structuredClone(source);
    const placed = layoutPdfPrintoutElements(source, [{ frame: { y: 50, height: 200 } }]);

    expect(source).toEqual(snapshot);
    expect(placed.map((element) => element.frame)).toEqual([
      { x: 72, y: 280, width: 720, height: 1_000, rotation: 0 },
      { x: 72, y: 1_310, width: 600, height: 800, rotation: 0 },
    ]);
    // Printouts are for writing on: they start as backgrounds, below the ink.
    expect(placed.every((element) => element.locked)).toBe(true);
    expect(placed.some(isStructuralPdfBackground)).toBe(false);
  });

  it('uses only an unmoved locked original PDF at the page origin as an export background', () => {
    const background = pdfElement('background', 595, 842);
    expect(isStructuralPdfBackground(background)).toBe(true);
    expect(isStructuralPdfBackground({ ...background, locked: false })).toBe(false);
    expect(isStructuralPdfBackground({ ...background, frame: { ...background.frame, x: 72 } })).toBe(false);
    expect(isStructuralPdfBackground({ ...background, frame: { ...background.frame, rotation: 15 } })).toBe(false);
    expect(isStructuralPdfBackground({ ...background, originalAsset: undefined })).toBe(false);
  });
});

describe('layoutPdfPrintoutFrames', () => {
  it('lays pages out from sizes alone, so every batch of an insert continues one stack', () => {
    const sizes = [{ frame: { width: 595, height: 842 } }, { frame: { width: 1_440, height: 900 } }, { frame: { width: 595, height: 842 } }];
    const frames = layoutPdfPrintoutFrames(sizes, [{ frame: { y: 50, height: 200 } }]);
    expect(frames.map((frame) => frame.y)).toEqual([280, 1152, 1632]);
    // Wide pages are scaled down to the printout width.
    expect(frames[1]).toMatchObject({ width: 720, height: 450 });
    const elements = layoutPdfPrintoutElements(sizes.map((size, index) => pdfElement(`p${index}`, size.frame.width, size.frame.height)), [{ frame: { y: 50, height: 200 } }]);
    expect(elements.map((element) => element.frame)).toEqual(frames);
  });
});
