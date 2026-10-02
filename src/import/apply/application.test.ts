import { describe, expect, it, vi } from 'vitest';
import { sha256Bytes, type Sha256Checksum } from '../../domain/v2';
import { PAGE_TAG_LIMIT, normalizePageTags } from '../../domain/pageTags';
import type { AcquiredGraphResource } from '../graph/types';
import type { OneNoteImportPreviewPlan } from '../types';
import {
  applyOneNoteImportApplication,
  prepareOneNoteImportApplication,
  rollbackOneNoteImportApplication,
} from './application';
import { oneNoteImportFromPreview, selectOneNoteImportOutline } from './sources';
import { MemoryOneNoteApplyTarget } from './testing';
import type { OneNoteApplyTarget } from './types';

const ACTIVE = `sha256:${'1'.repeat(64)}` as Sha256Checksum;

class FakeTarget extends MemoryOneNoteApplyTarget {
  constructor() {
    super(ACTIVE, { notebookDocumentIds: ['notebook:existing'], pageDocumentIds: ['page:existing'] });
  }
}

function png(): Uint8Array {
  return Uint8Array.from(
    atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='),
    (character) => character.charCodeAt(0),
  );
}

async function fixture(options: { missingBody?: boolean; unsafeLink?: boolean } = {}) {
  const image = png();
  const pdf = new TextEncoder().encode('%PDF-1.7\nfixture');
  const imageHash = await sha256Bytes(image);
  const pdfHash = await sha256Bytes(pdf);
  const preview: OneNoteImportPreviewPlan = {
    kind: 'onenote-import-preview',
    version: 1,
    createdAt: '2026-08-03T10:00:00.000Z',
    notebooks: [{
      sourceId: 'notebook-source',
      displayName: 'Physics',
      sections: [{
        sourceId: 'section-source',
        displayName: 'Mechanics',
        order: 0,
        pages: [
          {
            sourceId: 'page-parent',
            title: 'Forces',
            order: 0,
            level: 0,
            blocks: [{
              type: 'paragraph',
              content: [{
                text: 'Newton',
                marks: options.unsafeLink
                  ? [{ type: 'link', href: 'javascript:alert(1)' }]
                  : [{ type: 'bold' }],
              }],
            }, {
              type: 'image',
              resourceId: 'image-resource',
              mediaType: 'image/png',
              alt: 'force diagram',
              position: { x: 25, y: 80, width: 200, height: 120 },
            }],
            fidelity: {
              pageId: 'page-parent',
              status: 'complete',
              issues: [],
              convertedBlockCount: 2,
            },
          },
          {
            sourceId: 'page-child',
            title: 'Examples',
            order: 1,
            level: 1,
            blocks: [{
              type: 'checklist',
              items: [{ checked: false, content: [{ text: 'Solve exercise', marks: [] }] }],
            }],
            tags: ['important', 'onenote:customer-follow-up', 'todo'],
            taskState: 'open',
            fidelity: {
              pageId: 'page-child',
              status: 'visual',
              issues: [{ code: 'style-dropped', severity: 'visual', message: 'Shadow simplified.' }],
              convertedBlockCount: 1,
              pdfFallbackResourceId: 'pdf-resource',
              pdfFallbackPreviewResourceId: 'image-resource',
              pdfFallbackWidth: 794,
              pdfFallbackHeight: 1123,
            },
          },
        ],
      }],
    }],
    resources: [
      {
        sourceId: 'image-resource',
        mediaType: 'image/png',
        fileName: 'diagram.png',
        byteLength: image.byteLength,
        sha256: imageHash.slice('sha256:'.length),
      },
      {
        sourceId: 'pdf-resource',
        mediaType: 'application/pdf',
        fileName: 'page.pdf',
        byteLength: pdf.byteLength,
        sha256: pdfHash.slice('sha256:'.length),
      },
    ],
    pageReports: [],
    summary: { complete: 1, visual: 1, simplified: 0, unsupported: 0 },
  };
  preview.pageReports = preview.notebooks[0].sections[0].pages.map((page) => page.fidelity);
  const resources: AcquiredGraphResource[] = [
    {
      id: 'image-resource',
      bytes: image,
      mediaType: 'image/png',
      fileName: 'diagram.png',
      sha256: imageHash.slice('sha256:'.length),
    },
    {
      id: 'pdf-resource',
      bytes: pdf,
      mediaType: 'application/pdf',
      fileName: 'page.pdf',
      sha256: pdfHash.slice('sha256:'.length),
    },
  ];
  if (options.missingBody) resources.pop();
  return { preview, resourceBodies: resources };
}

async function prepared(data: Awaited<ReturnType<typeof fixture>>, target: OneNoteApplyTarget, onProgress?: () => void) {
  const handle = await oneNoteImportFromPreview(data.preview, data.resourceBodies);
  return prepareOneNoteImportApplication({ ...handle, target, ...(onProgress ? { onProgress } : {}) });
}

async function applied(data: Awaited<ReturnType<typeof fixture>>, target = new FakeTarget()) {
  const stage = await prepared(data, target);
  const result = await applyOneNoteImportApplication(target, stage, {
    approvalArtifactFingerprint: stage.review.approvalArtifactFingerprint,
  });
  return { stage, result, target };
}

describe('OneNote additive application', () => {
  it('plans a separate ordered notebook from the structure and writes pages with hierarchy, assets, fidelity and a locked PDF background', async () => {
    const data = await fixture();
    const target = new FakeTarget();
    const progress = vi.fn();
    const stage = await prepared(data, target, progress);

    expect(stage.notebook.title).toBe('Physics (OneNote import)');
    expect(stage.notebook.schemaVersion).toBe(3);
    expect(stage.notebook.documentId).toBe(`notebook:${stage.notebook.notebookId}`);
    expect(stage.notebook.sections[0].pageDocumentIds).toEqual(stage.pages.map((page) => page.documentId));
    expect(stage.pages[1].parentPageId).toBe(stage.pages[0].pageId);
    expect(stage.review.warnings).toContain('page-child: visual');
    expect(stage.review.resourceCount).toBe(2);
    expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'awaiting-review' }));

    const applyProgress = vi.fn();
    const result = await applyOneNoteImportApplication(target, stage, {
      approvalArtifactFingerprint: stage.review.approvalArtifactFingerprint,
      onProgress: applyProgress,
    });
    const [parent, child] = target.pages;
    expect(target.pages.every((page) => page.schemaVersion === 3)).toBe(true);
    expect(parent).toHaveProperty('mathSettings', {
      version: 1,
      resultMode: 'suggest',
      numberMode: 'exact',
      angleMode: 'degrees',
      autoRecognition: true,
    });
    expect(target.pages.map((page) => page.documentId)).toEqual(stage.pages.map((page) => page.documentId));
    expect(child.parentPageId).toBe(parent.pageId);
    expect(child).toMatchObject({ tags: ['important', 'onenote:customer-follow-up', 'todo'], taskState: 'open' });
    const background = child.elementsById[child.zOrder[0]];
    expect(background).toMatchObject({
      kind: 'pdf',
      locked: true,
      sourceAvailability: 'original',
      originalAsset: { mimeType: 'application/pdf', role: 'original' },
      previewAsset: { mimeType: 'image/png', role: 'preview' },
    });
    // The picture is shared by both pages and written once.
    expect(target.assets).toHaveLength(2);
    expect(result.fidelity.map((report) => report.status)).toEqual(['complete', 'visual']);
    expect(result.pageTitles).toEqual({ 'page-parent': 'Forces', 'page-child': 'Examples' });
    expect(result.stats).toMatchObject({ pages: 2, assets: 2, strokes: 0 });
    expect(result.timing.totalMs).toBeGreaterThanOrEqual(0);
    const pageSteps = applyProgress.mock.calls.map(([step]) => step).filter((step) => step.phase === 'writing-pages');
    expect(pageSteps.map((step) => step.completed)).toEqual([0, 1, 2]);
    expect(pageSteps.at(-1)).toMatchObject({ total: 2, stagedBytes: expect.any(Number) });
  });

  it('rejects blank or excessively nested section group paths before staging', async () => {
    for (const groupPath of [['Mathematik', '  '], Array.from({ length: 17 }, (_, index) => `Ebene ${index}`)]) {
      const data = await fixture();
      data.preview.notebooks[0].sections[0].groupPath = groupPath;
      await expect(prepared(data, new FakeTarget())).rejects.toThrow(/section group/i);
    }
  });

  it('normalizes and bounds imported page tags like manual entry', async () => {
    const data = await fixture();
    const page = data.preview.notebooks[0].sections[0].pages[1];
    // A OneNote page can carry more raw, mixed-case, diacritic-bearing tags
    // than the manual editor would ever store. Acquisition dedupes but does not
    // bound, so the applied page must be re-normalized to the shared contract.
    page.tags = [
      'Prüfung', 'prufung', '  Wichtig  ',
      ...Array.from({ length: 30 }, (_, index) => `thema-${index}`),
    ];
    const { target } = await applied(data);
    const staged = target.pages[1].tags;

    expect(staged.length).toBeLessThanOrEqual(PAGE_TAG_LIMIT);
    expect(staged).not.toContain('Prüfung');
    expect(staged.filter((tag) => tag === 'prufung')).toHaveLength(1);
    expect(staged).toContain('wichtig');
    // Idempotent: every stored tag is already in normalized slug form.
    expect(staged).toEqual(normalizePageTags(staged));
  });

  it('requires matching explicit review, rejects post-review mutation, and never overwrites existing roots', async () => {
    const data = await fixture();
    const target = new FakeTarget();
    const begin = vi.spyOn(target, 'begin');
    const stage = await prepared(data, target);
    await expect(applyOneNoteImportApplication(target, stage, {
      approvalArtifactFingerprint: ACTIVE,
    })).rejects.toThrow('Explicit approval');

    stage.notebook.title = 'tampered';
    await expect(applyOneNoteImportApplication(target, stage, {
      approvalArtifactFingerprint: stage.review.approvalArtifactFingerprint,
    })).rejects.toThrow('changed after review');
    expect(begin).not.toHaveBeenCalled();
    expect(target.receipt).toBeUndefined();
  });

  it('is receipt-idempotent after a lost acknowledgement and supports exact rollback', async () => {
    const data = await fixture();
    const target = new FakeTarget();
    const stage = await prepared(data, target);
    const options = { approvalArtifactFingerprint: stage.review.approvalArtifactFingerprint };
    const first = await applyOneNoteImportApplication(target, stage, options);
    const second = await applyOneNoteImportApplication(target, stage, options);
    expect(first.status).toBe('committed');
    expect(second.status).toBe('already-committed');
    expect(second.importId).toBe(first.importId);
    await expect(rollbackOneNoteImportApplication(target, first)).resolves.toBe('rolled-back');
  });

  it('gives a new preparation a new import ID', async () => {
    const data = await fixture();
    const handle = await oneNoteImportFromPreview(data.preview, data.resourceBodies);
    const target = new FakeTarget();
    const first = await prepareOneNoteImportApplication({ ...handle, target });
    const same = await prepareOneNoteImportApplication({ ...handle, target });
    const later = await prepareOneNoteImportApplication({ ...handle, target, preparedAt: '2026-08-04T10:00:00.000Z' });
    expect(same.review.importId).toBe(first.review.importId);
    expect(later.review.importId).not.toBe(first.review.importId);
    expect(later.notebook.documentId).toBe(first.notebook.documentId);
  });

  it('fails before review for a partial resource acquisition', async () => {
    const data = await fixture({ missingBody: true });
    await expect(prepared(data, new FakeTarget())).rejects.toThrow('incomplete');
  });

  it('aborts the writer and commits nothing when a page fails part-way', async () => {
    const data = await fixture();
    const target = new FakeTarget();
    const stage = await prepared(data, target);
    const readPage = stage.source.readPage;
    let reads = 0;
    stage.source = {
      ...stage.source,
      readPage: async (outline, signal) => {
        reads += 1;
        if (reads === 2) throw new Error('page file unreadable');
        return readPage(outline, signal);
      },
    };
    await expect(applyOneNoteImportApplication(target, stage, {
      approvalArtifactFingerprint: stage.review.approvalArtifactFingerprint,
    })).rejects.toThrow('page file unreadable');
    expect(target.aborted).toBe(1);
    expect(target.receipt).toBeUndefined();
  });

  it('automatically rolls back when post-commit reopen verification fails', async () => {
    const data = await fixture();
    const target = new FakeTarget();
    target.verifyFailure = true;
    await expect(applied(data, target)).rejects.toThrow('failed verification and was rolled back');
    expect(target.rollbackCalls).toBe(1);
  });

  it('rejects malicious links even when a forged preview bypasses HTML sanitization', async () => {
    const data = await fixture({ unsafeLink: true });
    const target = new FakeTarget();
    await expect(applied(data, target)).rejects.toThrow('unsafe protocol');
    expect(target.aborted).toBe(1);
    expect(target.receipt).toBeUndefined();
  });

  it('refuses deterministic document collisions before any commit', async () => {
    const data = await fixture();
    const first = await prepared(data, new FakeTarget());
    const collisionTarget = new FakeTarget();
    collisionTarget.snapshot.notebookDocumentIds.push(first.notebook.documentId);
    await expect(prepared(data, collisionTarget)).rejects.toThrow('collides');
    expect(collisionTarget.receipt).toBeUndefined();
  });

  it('narrows an outline to the chosen sections, names a partial import after them, and keeps their warnings', async () => {
    const data = await fixture();
    data.preview.notebooks[0].sections.push({
      sourceId: 'section-two', displayName: 'Optik', order: 1,
      pages: [{
        sourceId: 'page-optics', title: 'Linsen', order: 0, level: 0, blocks: [],
        fidelity: { pageId: 'page-optics', status: 'complete', issues: [], convertedBlockCount: 0 },
      }],
    });
    data.preview.pageReports.push(data.preview.notebooks[0].sections[1].pages[0].fidelity);
    data.preview.summary.complete += 1;
    const { outline } = await oneNoteImportFromPreview(data.preview, data.resourceBodies);
    outline.warnings = [
      { message: 'Export warning' },
      { pageId: 'page-optics', message: 'not exported' },
      { pageId: 'page-parent', message: 'not exported' },
    ];
    const errors = { notebookUnavailable: 'gone', sectionRequired: 'choose' };
    const selected = selectOneNoteImportOutline(outline, 'notebook-source', new Set(['section-two']), errors);
    expect(selected.notebooks[0].displayName).toBe('Physics – Optik');
    expect(selected.notebooks[0].sections.map((section) => section.sourceId)).toEqual(['section-two']);
    expect(selected.warnings).toEqual([{ message: 'Export warning' }, { pageId: 'page-optics', message: 'not exported' }]);
    expect(selectOneNoteImportOutline(outline, 'notebook-source', new Set(['section-source', 'section-two']), errors)
      .notebooks[0].displayName).toBe('Physics');
    expect(() => selectOneNoteImportOutline(outline, 'notebook-source', new Set(), errors)).toThrow('choose');
    expect(() => selectOneNoteImportOutline(outline, 'missing', new Set(['section-two']), errors)).toThrow('gone');
  });
});
