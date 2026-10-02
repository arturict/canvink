import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { OneNoteApplyTarget } from '../../import/apply';
import type { MicrosoftOneNoteAuthClient, MicrosoftGraphOneNoteClient } from '../../import/graph';
import type { OneNoteImportPreviewPlan } from '../../import/types';
import OneNoteImportDialog, {
  discoverOneNoteImportConfiguration,
  selectOneNoteImportPreview,
  type OneNoteImportDialogDependencies,
} from './OneNoteImportDialog';

function preview(): OneNoteImportPreviewPlan {
  const reportA = { pageId: 'page-a', status: 'complete' as const, issues: [], convertedBlockCount: 1 };
  const reportB = {
    pageId: 'page-b',
    status: 'visual' as const,
    issues: [{ code: 'style-dropped' as const, severity: 'visual' as const, message: 'Layout vereinfacht.' }],
    convertedBlockCount: 1,
    pdfFallbackResourceId: 'pdf-b',
  };
  return {
    kind: 'onenote-import-preview',
    version: 1,
    createdAt: '2026-08-03T10:00:00.000Z',
    notebooks: [{
      sourceId: 'notebook-a',
      displayName: 'Schule',
      sections: [{
        sourceId: 'section-a', displayName: 'Physik', order: 0,
        pages: [{ sourceId: 'page-a', title: 'Kräfte', order: 0, level: 0, blocks: [], fidelity: reportA }],
      }, {
        sourceId: 'section-b', displayName: 'Archiv', order: 1,
        pages: [{ sourceId: 'page-b', title: 'Alt', order: 0, level: 0, blocks: [], fidelity: reportB }],
      }],
    }],
    resources: [{ sourceId: 'pdf-b', mediaType: 'application/pdf', byteLength: 10 }],
    pageReports: [reportA, reportB],
    summary: { complete: 1, visual: 1, simplified: 0, unsupported: 0 },
  };
}

describe('OneNote import dialog', () => {
  it('discovers public configuration without any secret setting', () => {
    const configuration = discoverOneNoteImportConfiguration({
      clientId: '11111111-1111-4111-8111-111111111111',
      redirectUri: 'https://app.example.test/auth/microsoft',
    });
    expect(configuration).toEqual(expect.objectContaining({
      clientId: '11111111-1111-4111-8111-111111111111',
      redirectUri: 'https://app.example.test/auth/microsoft',
    }));
    expect(configuration).not.toHaveProperty('clientSecret');
  });

  it('builds a one-notebook, section-filtered review with recomputed fidelity counts', () => {
    const selected = selectOneNoteImportPreview(preview(), 'notebook-a', new Set(['section-b']));
    expect(selected.notebooks).toHaveLength(1);
    expect(selected.notebooks[0].sections.map((section) => section.sourceId)).toEqual(['section-b']);
    expect(selected.pageReports).toEqual([expect.objectContaining({ pageId: 'page-b', status: 'visual' })]);
    expect(selected.summary).toEqual({ complete: 0, visual: 1, simplified: 0, unsupported: 0 });
    // A partial import is named after its sections; importing all keeps the notebook name.
    expect(selected.notebooks[0].displayName).toBe('Schule – Archiv');
    expect(selectOneNoteImportPreview(preview(), 'notebook-a', new Set(['section-a', 'section-b'])).notebooks[0].displayName)
      .toBe('Schule');
  });

  it('renders the German consent and additive-safety gate with mocked auth, Graph, and runtime target factories', () => {
    const dependencies: OneNoteImportDialogDependencies = {
      createAuth: vi.fn(() => ({}) as MicrosoftOneNoteAuthClient),
      createGraphClient: vi.fn(() => ({}) as MicrosoftGraphOneNoteClient),
      createTarget: vi.fn(() => ({}) as OneNoteApplyTarget),
      createPdfPreviewRenderer: vi.fn(() => ({ renderPage: vi.fn() })),
      now: () => '2026-08-03T10:00:00.000Z',
    };
    const markup = renderToStaticMarkup(createElement(OneNoteImportDialog, {
      open: true,
      onClose: vi.fn(),
      target: {} as OneNoteApplyTarget,
      dependencies,
      configuration: {
        clientId: '11111111-1111-4111-8111-111111111111',
        redirectUri: 'https://app.example.test/auth/microsoft',
      },
    }));
    expect(markup).toContain('OneNote sicher importieren');
    expect(markup).toContain('<code>Notes.Read</code>');
    expect(markup).toContain('ersetzt keine vorhandenen Daten');
    expect(markup).toContain('niemals ein Client Secret');
    expect(markup).not.toContain('type="password"');
  });
});
