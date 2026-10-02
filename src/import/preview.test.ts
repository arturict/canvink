import { describe, expect, it } from 'vitest';
import { createOneNoteImportPreview, OneNoteImportInputError } from './preview';
import type { GraphOneNoteImportInput } from './types';

function inputFixture(): GraphOneNoteImportInput {
  return {
    notebooks: [{
      id: 'notebook-1',
      displayName: 'Physics',
      sections: [{
        id: 'section-late',
        displayName: 'Later',
        order: 2,
        pages: [],
      }, {
        id: 'section-1',
        displayName: 'Mechanics',
        order: 1,
        pages: [{
          id: 'page-visual',
          title: 'Ink page',
          order: 3,
          level: 1,
          html: '<iframe src="https://example.invalid/drawing">drawing</iframe>',
        }, {
          id: 'page-complete',
          title: 'Forces',
          order: 1,
          html: '<h1>Forces</h1><p data-tag="important; to_do">F = ma</p>',
        }, {
          id: 'page-simplified',
          title: 'Styled note',
          order: 2,
          html: '<p style="color:red">Red note</p>',
        }, {
          id: 'page-unsupported',
          title: 'Embedded page',
          order: 4,
          html: '<iframe src="https://example.invalid">not available</iframe>',
        }],
      }],
    }],
    resources: [{
      id: 'fallback-pdf',
      contentUrl: 'local-resource:fallback-pdf',
      mediaType: 'application/pdf',
      fileName: 'ink-page.pdf',
      byteLength: 1024,
      sha256: 'a'.repeat(64),
    }, {
      id: 'fallback-preview',
      contentUrl: 'local-resource:fallback-preview',
      mediaType: 'image/png',
      fileName: 'ink-page.png',
      byteLength: 512,
      sha256: 'b'.repeat(64),
    }],
    pdfFallbacks: [{ pageId: 'page-visual', resourceId: 'fallback-pdf', previewResourceId: 'fallback-preview', width: 794, height: 1123 }],
  };
}

describe('createOneNoteImportPreview', () => {
  it('creates a deterministic, ordered, inert plan with all fidelity classes', () => {
    const input = inputFixture();
    const before = JSON.stringify(input);
    const plan = createOneNoteImportPreview(input, { createdAt: '2026-08-03T12:00:00.000Z' });

    expect(JSON.stringify(input)).toBe(before);
    expect(plan).toMatchObject({
      kind: 'onenote-import-preview',
      version: 1,
      createdAt: '2026-08-03T12:00:00.000Z',
      summary: { complete: 1, visual: 1, simplified: 1, unsupported: 1 },
      resources: [
        { sourceId: 'fallback-pdf', mediaType: 'application/pdf', byteLength: 1024 },
        { sourceId: 'fallback-preview', mediaType: 'image/png', byteLength: 512 },
      ],
    });
    expect(plan.notebooks[0].sections.map((section) => section.sourceId)).toEqual(['section-1', 'section-late']);
    expect(plan.notebooks[0].sections[0].pages.map((page) => page.sourceId)).toEqual([
      'page-complete', 'page-simplified', 'page-visual', 'page-unsupported',
    ]);
    expect(plan.pageReports.map((report) => [report.pageId, report.status])).toEqual([
      ['page-complete', 'complete'],
      ['page-simplified', 'simplified'],
      ['page-visual', 'visual'],
      ['page-unsupported', 'unsupported'],
    ]);
    expect(plan.pageReports[2].pdfFallbackResourceId).toBe('fallback-pdf');
    expect(plan.notebooks[0].sections[0].pages[0]).toMatchObject({
      sourceId: 'page-complete',
      tags: ['important', 'todo'],
      taskState: 'open',
      blocks: expect.arrayContaining([expect.objectContaining({ type: 'checklist' })]),
    });
  });

  it('does not expose an apply hook or accept workspace state', () => {
    const plan = createOneNoteImportPreview(inputFixture(), { createdAt: '2026-08-03T12:00:00Z' });
    expect(Object.keys(plan)).not.toContain('apply');
    expect(Object.keys(plan)).not.toContain('workspace');
    expect(JSON.stringify(plan)).not.toContain('contentUrl');
  });

  it('rejects ambiguous IDs, invalid resource sizes, and unknown fallback pages', () => {
    const duplicate = inputFixture();
    (duplicate.notebooks[0].sections[0].pages as Array<(typeof duplicate.notebooks)[number]['sections'][number]['pages'][number]>).push({
      id: 'page-complete', title: 'Duplicate', order: 10, html: '<p>x</p>',
    });
    expect(() => createOneNoteImportPreview(duplicate, { createdAt: '2026-08-03T12:00:00Z' }))
      .toThrowError(OneNoteImportInputError);

    const unknownFallback = inputFixture();
    unknownFallback.pdfFallbacks = [{ pageId: 'missing', resourceId: 'fallback-pdf', previewResourceId: 'fallback-preview', width: 794, height: 1123 }];
    expect(() => createOneNoteImportPreview(unknownFallback, { createdAt: '2026-08-03T12:00:00Z' }))
      .toThrow('PDF fallback references unknown page');

    const invalidSize = inputFixture();
    invalidSize.resources[0].byteLength = -1;
    expect(() => createOneNoteImportPreview(invalidSize, { createdAt: '2026-08-03T12:00:00Z' }))
      .toThrow('byteLength');
  });

  it('carries section group paths into the plan and rejects blank or too deep ones', () => {
    const input = inputFixture();
    input.notebooks[0].sections[1].groupPath = ['z_Abgeschlossen', 'Naturwissenschaft'];
    input.notebooks[0].sections[0].groupPath = [];
    const plan = createOneNoteImportPreview(input, { createdAt: '2026-08-03T12:00:00Z' });
    expect(plan.notebooks[0].sections.map((section) => [section.displayName, section.groupPath])).toEqual([
      ['Mechanics', ['z_Abgeschlossen', 'Naturwissenschaft']],
      ['Later', undefined],
    ]);
    expect(plan.notebooks[0].sections[1]).not.toHaveProperty('groupPath');

    for (const groupPath of [['Mathematik', ' '], Array.from({ length: 17 }, (_, index) => `Ebene ${index}`)]) {
      const invalid = inputFixture();
      invalid.notebooks[0].sections[0].groupPath = groupPath;
      expect(() => createOneNoteImportPreview(invalid, { createdAt: '2026-08-03T12:00:00Z' }))
        .toThrowError(OneNoteImportInputError);
    }
  });

  it('reports a missing or non-PDF fallback without importing it', () => {
    const input = inputFixture();
    input.pdfFallbacks = [{ pageId: 'page-visual', resourceId: 'missing-resource', previewResourceId: 'missing-preview', width: 794, height: 1123 }];
    const plan = createOneNoteImportPreview(input, { createdAt: '2026-08-03T12:00:00Z' });
    const report = plan.pageReports.find((item) => item.pageId === 'page-visual');
    expect(report).toMatchObject({ status: 'unsupported', pdfFallbackResourceId: undefined });
    expect(report?.issues).toContainEqual(expect.objectContaining({ code: 'pdf-fallback-invalid' }));
    expect(plan.resources).toEqual([]);
  });
});
