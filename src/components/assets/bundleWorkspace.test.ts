import { describe, expect, it, vi } from 'vitest';
import {
  createNotebookAutomergeDoc,
  createNotebookAutomergeDocV3,
  createPageAutomergeDoc,
  createPageAutomergeDocV3,
  getAutomergeSnapshot,
  loadAutomergeDocument,
  saveAutomergeDocument,
  type LiveNotebookDocV2,
  type LivePageDocV2,
} from '../../crdt';
import type { NotebookDoc, PageDoc } from '../../domain/v2';
import type { NotebookDocV3, PageDocV3 } from '../../domain/v3';
import { createCanvinkBundle, readCanvinkBundle } from '../../io';
import type {
  AdditiveImportOptions,
  AdditiveImportWriter,
  V2RuntimeState,
  WorkspaceV2Runtime,
} from '../../storage/workspaceV2Runtime';
import { summarizePage } from '../../storage/pageIndex';
import { exportNotebookBundle, importNotebookBundleAdditively } from './bundleWorkspace';

const TIME = '2026-08-03T00:00:00.000Z';

function v3Documents(): { notebook: NotebookDocV3; page: PageDocV3 } {
  const notebook: NotebookDocV3 = {
    schemaVersion: 3, documentId: 'notebook:source', kind: 'notebook', notebookId: 'source', title: 'Math', color: '#fff',
    createdAt: TIME, updatedAt: TIME,
    sections: [{ id: 'section', title: 'Algebra', createdAt: TIME, updatedAt: TIME, pageDocumentIds: ['page:source'] }],
    settings: { defaultPageType: 'free' }, version: { protocol: 'uninitialized', heads: [] },
  };
  const page: PageDocV3 = {
    schemaVersion: 3, documentId: 'page:source', kind: 'page', notebookId: 'source', sectionId: 'section', pageId: 'source',
    title: 'Graph', tags: [], pageType: 'free', background: { type: 'plain', color: '#fff' }, createdAt: TIME, updatedAt: TIME,
    mathSettings: { version: 1, resultMode: 'suggest', numberMode: 'exact', angleMode: 'degrees', autoRecognition: true },
    elementsById: {
      math: {
        id: 'math', kind: 'math', frame: { x: 0, y: 0, width: 120, height: 50, rotation: 0 }, createdAt: TIME, updatedAt: TIME, locked: false,
        inputKind: 'typed', autoRecognition: 'inherit', typedLatex: 'y=x^2', recognition: { state: 'idle', alternatives: [], warnings: [] },
        result: { state: 'valid', exactLatex: 'x^2', diagnostics: [] },
        dependencies: { defines: ['y'], references: ['x'], dependsOnElementIds: [], state: 'valid' },
      },
      graph: {
        id: 'graph', kind: 'graph', frame: { x: 0, y: 60, width: 240, height: 160, rotation: 0 }, createdAt: TIME, updatedAt: TIME, locked: false,
        series: [{ id: 'series', sourceMathElementId: 'math', color: '#3366cc', visible: true }],
        viewport: { xMin: -2, xMax: 2, yMin: -1, yMax: 4, equalScale: false, axesVisible: true, gridVisible: true },
      },
    },
    zOrder: ['math', 'graph'], version: { protocol: 'uninitialized', heads: [] },
  };
  return { notebook, page };
}

function v2Documents(): { notebook: NotebookDoc; page: PageDoc } {
  const v3 = v3Documents();
  const { mathSettings: _mathSettings, ...pageMetadata } = v3.page;
  void _mathSettings;
  return {
    notebook: { ...v3.notebook, schemaVersion: 2 },
    page: { ...pageMetadata, schemaVersion: 2, elementsById: {}, zOrder: [] } as PageDoc,
  };
}

async function bundle(
  notebookBytes: Uint8Array,
  pageBytes: Uint8Array,
  schemaVersion: 2 | 3,
): Promise<Uint8Array> {
  return createCanvinkBundle({
    schemaVersion,
    createdAt: TIME, notebook: { id: 'notebook:source', bytes: notebookBytes },
    pages: [{ id: 'page:source', bytes: pageBytes }], assets: [],
  });
}

function importState(): V2RuntimeState {
  return { schemaVersion: 3, authoritative: 'v3', activation: { artifactFingerprint: `sha256:${'a'.repeat(64)}` } } as V2RuntimeState;
}

interface CapturedImport {
  notebook: NotebookDoc | NotebookDocV3;
  pages: Array<PageDoc | PageDocV3>;
  committed: boolean;
  aborted: boolean;
}

/** A runtime whose streaming import writer records what it receives. */
function capturingImportRuntime(): { runtime: WorkspaceV2Runtime; captured: () => CapturedImport | undefined } {
  let captured: CapturedImport | undefined;
  const runtime = {
    beginAdditiveImport: vi.fn(async (options: AdditiveImportOptions): Promise<AdditiveImportWriter> => {
      const current: CapturedImport = { notebook: options.notebook, pages: [], committed: false, aborted: false };
      captured = current;
      return {
        addAssets: async () => undefined,
        addPage: async (page) => { current.pages.push(page); },
        progress: () => ({ pages: current.pages.length, assets: 0, stagedBytes: 0 }),
        commit: async () => {
          current.committed = true;
          return {
            status: 'committed', importId: options.importId, artifactFingerprint: `sha256:${'b'.repeat(64)}`,
            backupId: 'backup', notebookDocumentId: options.notebook.documentId,
            pageDocumentIds: current.pages.map((page) => page.documentId), assetIds: [],
          };
        },
        abort: async () => { current.aborted = true; },
      };
    }),
  } as unknown as WorkspaceV2Runtime;
  return { runtime, captured: () => captured };
}

describe('schema-aware notebook bundles', () => {
  it('exports schema-v3 Automerge documents with Math/Graph fields losslessly', async () => {
    const { notebook, page } = v3Documents();
    const notebookDocument = createNotebookAutomergeDocV3(notebook);
    const pageDocument = createPageAutomergeDocV3(page);
    const state = {
      ...importState(),
      notebooks: [getAutomergeSnapshot<LiveNotebookDocV2>(notebookDocument)],
      pages: [summarizePage(getAutomergeSnapshot<LivePageDocV2>(pageDocument), [])],
    } as V2RuntimeState;
    // Export copies stored page bytes; it never loads a page.
    const readDocumentBytes = vi.fn(async () => saveAutomergeDocument(pageDocument));
    const readPage = vi.fn();
    const runtime = {
      getNotebookHandle: () => ({ doc: () => notebookDocument }),
      sealAllPendingInk: vi.fn(async () => undefined),
      getState: () => state,
      readDocumentBytes,
      readPage,
      getAsset: vi.fn(),
    } as unknown as WorkspaceV2Runtime;
    const exported = await exportNotebookBundle(runtime, state, 'source');
    expect(readDocumentBytes).toHaveBeenCalledWith('page:source');
    expect(readPage).not.toHaveBeenCalled();
    const reopened = await readCanvinkBundle(new Uint8Array(await exported.arrayBuffer()));
    expect(reopened.manifest.generator).toBe('canvink-v3');
    expect(reopened.manifest).toMatchObject({ formatVersion: 3, schemaVersion: 3 });
    const restored = loadAutomergeDocument<LivePageDocV2>(reopened.pages[0].bytes, { expectedSchemaVersion: 3 });
    const snapshot = getAutomergeSnapshot<LivePageDocV2>(restored);
    expect(snapshot.mathSettings).toEqual(page.mathSettings);
    expect(snapshot.elementsById.math).toMatchObject({ kind: 'math', typedLatex: 'y=x^2' });
    expect(snapshot.elementsById.graph).toMatchObject({ kind: 'graph', series: [{ sourceMathElementId: 'math' }] });
  });

  it('imports v3 additively without dropping Math/Graph and keeps v2 bundle input compatible', async () => {
    for (const schemaVersion of [3, 2] as const) {
      const documents = schemaVersion === 3 ? v3Documents() : v2Documents();
      const notebookDocument = schemaVersion === 3
        ? createNotebookAutomergeDocV3(documents.notebook)
        : createNotebookAutomergeDoc(documents.notebook as NotebookDoc);
      const pageDocument = schemaVersion === 3
        ? createPageAutomergeDocV3(documents.page)
        : createPageAutomergeDoc(documents.page as PageDoc);
      const { runtime, captured: capture } = capturingImportRuntime();
      let id = 0;
      await importNotebookBundleAdditively(
        runtime, importState(), await bundle(saveAutomergeDocument(notebookDocument), saveAutomergeDocument(pageDocument), schemaVersion),
        (scope) => `${scope}-${++id}`,
      );
      const captured = capture();
      expect(captured?.notebook.schemaVersion).toBe(schemaVersion);
      expect(captured?.pages.every((page) => page.schemaVersion === schemaVersion)).toBe(true);
      if (schemaVersion === 3) {
        const imported = captured?.pages[0];
        expect(imported && imported.schemaVersion === 3 && imported.mathSettings).toEqual((documents.page as PageDocV3).mathSettings);
        expect(imported?.elementsById.graph).toMatchObject({ kind: 'graph', series: [{ sourceMathElementId: 'math' }] });
      }
    }
  });

  it('refuses a mixed-schema bundle before starting an additive transaction', async () => {
    const v2 = v2Documents();
    const v3 = v3Documents();
    const mixed = await bundle(
      saveAutomergeDocument(createNotebookAutomergeDoc(v2.notebook)),
      saveAutomergeDocument(createPageAutomergeDocV3(v3.page)),
      2,
    );
    const { runtime, captured } = capturingImportRuntime();
    await expect(importNotebookBundleAdditively(runtime, importState(), mixed, (scope) => scope))
      .rejects.toThrow(/schema version/i);
    expect(captured()?.committed).not.toBe(true);
  });

  it('validates every embedded page before starting an additive transaction', async () => {
    const v2 = v2Documents();
    const v3 = v3Documents();
    const notebook: NotebookDoc = {
      ...v2.notebook,
      sections: [{ ...v2.notebook.sections[0], pageDocumentIds: ['page:source', 'page:second'] }],
    };
    const invalidSecond: PageDocV3 = {
      ...v3.page,
      documentId: 'page:second',
      pageId: 'second',
    };
    const bytes = await createCanvinkBundle({
      schemaVersion: 2,
      createdAt: TIME,
      notebook: {
        id: notebook.documentId,
        bytes: saveAutomergeDocument(createNotebookAutomergeDoc(notebook)),
      },
      pages: [
        { id: v2.page.documentId, bytes: saveAutomergeDocument(createPageAutomergeDoc(v2.page)) },
        { id: invalidSecond.documentId, bytes: saveAutomergeDocument(createPageAutomergeDocV3(invalidSecond)) },
      ],
      assets: [],
    });
    const { runtime, captured } = capturingImportRuntime();

    await expect(importNotebookBundleAdditively(runtime, importState(), bytes, (scope) => scope))
      .rejects.toThrow(/schema version/i);
    expect(captured()?.committed).not.toBe(true);
    expect(captured()?.aborted).toBe(true);
  });
});
