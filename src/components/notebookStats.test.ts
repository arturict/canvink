import { describe, expect, it } from 'vitest';
import {
  formatBytes,
  measureNotebookStorage,
  notebookCounts,
  pageFootprint,
  type PageFootprint,
  type StorageReader,
} from './notebookStats';

const notebook = {
  notebookId: 'n',
  documentId: 'notebook:n',
  sections: [
    { pageDocumentIds: ['page:a', 'page:b'] },
    { pageDocumentIds: ['page:c'] },
  ],
};

describe('notebook size', () => {
  it('counts sections, pages and the pages this device holds', () => {
    expect(notebookCounts(notebook, (id) => id !== 'page:c')).toEqual({ sections: 2, pages: 3, pagesOnDevice: 2 });
  });

  it('reads ink and files a page references, each file once', () => {
    const footprint = pageFootprint({
      'ink:abc': { strokes: 3, bytes: 1200 },
      'ink:def': { strokes: 1, bytes: 300 },
      elementsById: {
        image: { asset: { assetId: 'sha256:1', size: 5000 } },
        pdf: { originalAsset: { assetId: 'sha256:2', size: 8000 }, previewAsset: { assetId: 'sha256:3', size: 700 } },
        again: { asset: { assetId: 'sha256:1', size: 5000 } },
        text: { text: 'hello' },
      },
    } as never);
    expect(footprint.inkBytes).toBe(1500);
    expect([...footprint.assets]).toEqual([['sha256:1', 5000], ['sha256:2', 8000], ['sha256:3', 700]]);
  });

  it('adds documents, ink and files across pages without counting a shared file twice', async () => {
    const footprints = new Map<string, PageFootprint | null>([
      ['page:a', { inkBytes: 100, assets: new Map([['f', 1000]]) }],
      ['page:b', { inkBytes: 0, assets: new Map([['f', 1000], ['g', 50]]) }],
      ['page:c', null],
    ]);
    const sizes: Record<string, number> = { 'notebook:n': 10, 'page:a': 20, 'page:b': 30, 'page:c': 0 };
    const reader: StorageReader = {
      documentBytes: async (id) => sizes[id] ?? 0,
      pageFootprint: async (id) => footprints.get(id) ?? null,
    };
    const progress: number[] = [];
    const result = await measureNotebookStorage(notebook, reader, (measure) => progress.push(measure.measuredPages));
    expect(result).toEqual({ bytes: 10 + 20 + 100 + 1000 + 30 + 50, measuredPages: 2 });
    expect(progress).toEqual([0, 1, 2]);
  });

  it('stops when cancelled', async () => {
    let cancelled = false;
    const reader: StorageReader = {
      documentBytes: async () => 1,
      pageFootprint: async () => {
        cancelled = true;
        return { inkBytes: 0, assets: new Map() };
      },
    };
    const result = await measureNotebookStorage(notebook, reader, () => undefined, () => cancelled);
    expect(result.measuredPages).toBe(1);
  });

  it('formats sizes for the language', () => {
    expect(formatBytes(0, 'en')).toBe('0 B');
    expect(formatBytes(820 * 1024, 'en')).toBe('820 KB');
    expect(formatBytes(4.2 * 1024 * 1024, 'en')).toBe('4.2 MB');
    expect(formatBytes(4.2 * 1024 * 1024, 'de-CH')).toMatch(/^4[.,]2 MB$/);
    expect(formatBytes(52 * 1024 * 1024, 'en')).toBe('52 MB');
  });
});
