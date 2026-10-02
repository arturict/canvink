import { PDFDocument } from 'pdf-lib';
import { describe, expect, it, vi } from 'vitest';
import type { OneNoteGraphPreviewResult } from './graph';
import { createOneNoteImportPreview } from './preview';
import { addLocalPdfFallback, removeLocalPdfFallback } from './pdfFallback';

const PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='),
  (character) => character.charCodeAt(0),
);

function acquisition(): OneNoteGraphPreviewResult {
  const input = {
    notebooks: [{
      id: 'notebook', displayName: 'School', sections: [{
        id: 'section', displayName: 'Physics', order: 0, pages: [{
          id: 'page', title: 'Diagram', order: 0, html: '<iframe>ink</iframe>',
        }],
      }],
    }],
    resources: [],
  };
  return {
    input,
    resourceBodies: [],
    stats: { requests: 1, retries: 0, metadataBytes: 10, pageHtmlBytes: 22, resourceBytes: 0 },
    preview: createOneNoteImportPreview(input, { createdAt: '2026-08-03T12:00:00.000Z' }),
  };
}

describe('local OneNote PDF fallback', () => {
  it('stores validated original and rendered preview bytes and removes both again', async () => {
    const document = await PDFDocument.create();
    document.addPage([595, 842]);
    const pdf = await document.save();
    const renderer = {
      renderPage: vi.fn(async () => ({ bytes: PNG, mimeType: 'image/png' as const, width: 1, height: 1 })),
    };
    const added = await addLocalPdfFallback(acquisition(), 'page', {
      name: 'page.pdf',
      type: 'application/pdf',
      arrayBuffer: async () => pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength) as ArrayBuffer,
    }, renderer);

    expect(renderer.renderPage).toHaveBeenCalledOnce();
    expect(added.input.pdfFallbacks).toEqual([expect.objectContaining({
      pageId: 'page', width: 595, height: 842,
    })]);
    expect(added.resourceBodies).toHaveLength(2);
    expect(added.resourceBodies.find((resource) => resource.mediaType === 'application/pdf')?.bytes).toEqual(pdf);
    expect(added.preview.pageReports[0]).toMatchObject({
      status: 'visual',
      pdfFallbackResourceId: expect.stringMatching(/^local-pdf:/),
      pdfFallbackPreviewResourceId: expect.stringMatching(/^local-preview:/),
    });

    const removed = removeLocalPdfFallback(added, 'page');
    expect(removed.input.pdfFallbacks).toEqual([]);
    expect(removed.input.resources).toEqual([]);
    expect(removed.resourceBodies).toEqual([]);
    expect(removed.preview.pageReports[0].status).toBe('unsupported');
  });

  it('rejects a multi-page fallback before it reaches the import plan', async () => {
    const document = await PDFDocument.create();
    document.addPage();
    document.addPage();
    const pdf = await document.save();
    await expect(addLocalPdfFallback(acquisition(), 'page', {
      name: 'two-pages.pdf', type: 'application/pdf',
      arrayBuffer: async () => pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength) as ArrayBuffer,
    }, { renderPage: vi.fn() })).rejects.toThrow('one-page PDF');
  });
});
