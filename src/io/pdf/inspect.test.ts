import { jsPDF } from 'jspdf';
import { describe, expect, it, vi } from 'vitest';
import { MemoryAssetRepository, reopenAsset } from '../../assets';
import {
  createPdfImportPageDocument,
  importOriginalPdf,
  materializePdfPreview,
} from './importPlan';
import { inspectPdf, normalizePdfError } from './inspect';

const PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='),
  (character) => character.charCodeAt(0),
);

function pdfBytes(pages: readonly string[]): Uint8Array {
  const pdf = new jsPDF({ unit: 'pt', format: 'a4' });
  pages.forEach((text, index) => {
    if (index > 0) pdf.addPage('a4', 'portrait');
    if (text) pdf.text(text, 40, 60);
  });
  return new Uint8Array(pdf.output('arraybuffer'));
}

describe('safe original PDF inspection and import planning', () => {
  it('validates every page, extracts bounded local text, and plans blank append pages', async () => {
    const bytes = pdfBytes(['First page', 'Second page']);
    const inspected = await inspectPdf(bytes);
    expect(inspected.pageCount).toBe(2);
    expect(inspected.pages.map((page) => page.text)).toEqual(['First page', 'Second page']);

    let sequence = 0;
    const repository = new MemoryAssetRepository();
    const plan = await importOriginalPdf(
      repository,
      { bytes, fileName: 'worksheet.pdf' },
      (scope) => `${scope}-${++sequence}`,
      1,
      () => '2026-08-03T12:00:00.000Z',
    );
    expect(plan.pages.map((page) => page.kind)).toEqual(['pdf-page', 'pdf-page', 'blank-page']);
    const first = plan.pages[0];
    expect(first.kind === 'pdf-page' && first.element.locked).toBe(true);
    expect(first.kind === 'pdf-page' && first.lazyPreview.pageNumber).toBe(1);
    expect(first.kind === 'pdf-page' && first.element.createdAt).toBe('2026-08-03T12:00:00.000Z');
    if (first.kind !== 'pdf-page') throw new Error('Expected a planned PDF page.');
    const materialized = await materializePdfPreview(repository, {
      renderPage: async (input) => {
        expect(input).toMatchObject({ pageNumber: 1, maxWidth: 1_600, maxPixels: 16_000_000 });
        expect(input.pdfBytes).toEqual(bytes);
        return { bytes: PNG, mimeType: 'image/png', width: 1, height: 1 };
      },
    }, first);
    expect(materialized.previewAsset).toMatchObject({ role: 'preview', mimeType: 'image/png' });
    expect(materialized.page.element.previewAsset).toEqual(materialized.previewAsset);

    const v3Page = createPdfImportPageDocument({
      pageId: first.pageId,
      notebookId: 'notebook-1',
      sectionId: 'section-1',
      title: 'Worksheet · Page 1',
      pageType: 'free',
      background: { type: 'plain', color: '#ffffff' },
      createdAt: '2026-08-03T12:00:01.000Z',
      element: { ...materialized.page.element, previewAsset: materialized.previewAsset },
    });
    expect(v3Page).toMatchObject({
      schemaVersion: 3,
      documentId: `page:${first.pageId}`,
      mathSettings: { version: 1, numberMode: 'exact', angleMode: 'degrees' },
      zOrder: [materialized.page.element.id],
    });
    expect(v3Page.elementsById[materialized.page.element.id]).toMatchObject({
      kind: 'pdf',
      sourcePageNumber: 1,
    });

    // Bytes the caller already read are handed to the renderer as they are, so it can keep the PDF open across pages.
    const shared = await reopenAsset(repository, plan.originalAsset);
    const seen: Uint8Array[] = [];
    const renderer = {
      renderPage: async (input: { pdfBytes: Uint8Array }) => {
        seen.push(input.pdfBytes);
        return { bytes: PNG, mimeType: 'image/png' as const, width: 1, height: 1 };
      },
    };
    const getAsset = vi.spyOn(repository, 'getAsset');
    for (const planned of plan.pages) {
      if (planned.kind === 'pdf-page') await materializePdfPreview(repository, renderer, planned, shared);
    }
    expect(seen).toHaveLength(2);
    expect(seen.every((candidate) => candidate === shared)).toBe(true);
    // Only the preview images were looked up, never the PDF.
    expect(getAsset.mock.calls.every(([assetId]) => assetId !== plan.originalAsset.assetId)).toBe(true);

    const blank = plan.pages[2];
    if (blank.kind !== 'blank-page') throw new Error('Expected the planned blank page.');
    expect(createPdfImportPageDocument({
      pageId: blank.pageId,
      notebookId: 'notebook-1',
      sectionId: 'section-1',
      title: 'Worksheet · Notes',
      pageType: 'a4',
      background: { type: 'plain', color: '#ffffff' },
      createdAt: '2026-08-03T12:00:02.000Z',
    })).toMatchObject({ schemaVersion: 3, elementsById: {}, zOrder: [] });

  });

  it('accepts a scan-like page with no extractable text', async () => {
    const inspected = await inspectPdf(pdfBytes(['']));
    expect(inspected.pages[0]).toMatchObject({ text: '', hasExtractableText: false });
  });

  it('rejects corrupt/truncated data and maps password errors explicitly', async () => {
    await expect(inspectPdf(new TextEncoder().encode('%PDF-broken'))).rejects.toThrow(/corrupt|truncated|unsupported/i);
    const valid = pdfBytes(['complete']);
    await expect(inspectPdf(valid.slice(0, Math.floor(valid.length / 2)))).rejects.toThrow(/corrupt|truncated|unsupported/i);
    expect(normalizePdfError({ name: 'PasswordException' }).message).toMatch(/Password-protected/);
  });

  it('rejects PDFs above the page-count limit before per-page work', async () => {
    const pdf = new jsPDF({ unit: 'pt', format: 'a4' });
    for (let page = 1; page < 501; page += 1) pdf.addPage('a4', 'portrait');
    await expect(inspectPdf(new Uint8Array(pdf.output('arraybuffer')))).rejects.toThrow(/between 1 and 500 pages/);
  });
});
