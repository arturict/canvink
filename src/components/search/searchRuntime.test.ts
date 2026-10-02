import { jsPDF } from 'jspdf';
import { describe, expect, it, vi } from 'vitest';
import { MemoryAssetRepository } from '../../assets';
import { createPageAutomergeDocV3, getAutomergeHeads, seedPortableRichText, type PageAutomergeDoc } from '../../crdt';
import type { WorkspaceState } from '../../domain/types';
import { sha256Bytes, type AssetRef, type PageDoc } from '../../domain/v2';
import type { PageDocV3 } from '../../domain/v3';
import { InMemorySearchAdapter } from '../../search/adapters';
import { TauriSqliteSearchIndex, type NativeInvoke } from '../../search/native';
import { OcrQueue, type OcrAdapter, type OcrRecognitionResult } from '../../search/ocr';
import { projectSearchPage } from '../../search/projection';
import type { SearchPageSource } from '../../search/types';
import type { RecoveryDraft } from '../../storage/recoveryJournal';
import { MemoryWorkspaceStore, memoryRepoFactory } from '../../storage/testing/memoryWorkspaceStore';
import {
  BrowserV2WorkspaceActivationStore,
  DefaultAutomergeMigrationMaterializer,
  InMemoryAutomergeRepoMigrationAdapter,
  V2WorkspaceMigrationOrchestrator,
  type V1WorkspaceMigrationSource,
} from '../../storage/v2WorkspaceStorage';
import {
  WorkspaceV2Runtime,
  type DocumentChangeEvent,
  type PageSummary,
  type V2RuntimeState,
} from '../../storage/workspaceV2Runtime';
import {
  LocalProjectionBackend,
  MemoryDerivedTextStore,
  RuntimeSearchSourceBuilder,
  WorkspaceSearchController,
  type SearchSourceBuilder,
} from './searchRuntime';

const TIME = '2026-08-03T08:00:00.000Z';
const PAGE_CACHE_SIZE = 2;
const unusedOcr: OcrAdapter = { availableLanguages: async () => ['de-DE'], recognize: async () => { throw new Error('unused'); } };

function source(overrides: Partial<SearchPageSource> = {}): SearchPageSource {
  return {
    documentId: 'page:one',
    notebookId: 'notebook-one',
    pageId: 'page-one',
    sectionId: 'section-one',
    notebookTitle: 'Schule',
    sectionTitle: 'Physik',
    pageTitle: 'Impulserhaltung',
    tags: ['prüfung'],
    updatedAt: '2026-08-03T12:00:00.000Z',
    pageHeads: ['head-1'],
    richTextDocuments: [{
      type: 'doc',
      blocks: [
        { id: 'paragraph', type: 'paragraph', spans: [{ text: 'Kraft und Bewegung', marks: [] }] },
        { id: 'check', type: 'checkItem', checked: false, spans: [{ text: 'Versuch auswerten', marks: [] }] },
      ],
    }],
    pdfText: ['Arbeitsblatt Stoß'],
    ocrText: ['Federkraft Scan'],
    ...overrides,
  };
}

/** A v1 workspace with one notebook, one section and `texts.length` pages, each with one text box. */
function v1Workspace(texts: readonly string[]): WorkspaceState {
  return {
    schemaVersion: 1,
    updatedAt: TIME,
    notebooks: [{
      id: 'notebook-1',
      title: 'Schule',
      color: '#123456',
      createdAt: TIME,
      updatedAt: TIME,
      sections: [{
        id: 'section-1',
        title: 'Physik',
        createdAt: TIME,
        updatedAt: TIME,
        pages: texts.map((text, index) => ({
          id: `page-${index + 1}`,
          title: `Seite ${index + 1}`,
          mode: 'a4' as const,
          createdAt: TIME,
          updatedAt: TIME,
          elements: [{
            id: `text-${index + 1}`, kind: 'text' as const, x: 10, y: 10, createdAt: TIME, updatedAt: TIME,
            text, width: 300, height: 80, color: '#111111', fontSize: 16, fontFamily: 'sans-serif', fontWeight: 400 as const,
          }],
        })),
      }],
    }],
    trash: [],
    activeNotebookId: 'notebook-1',
    activeSectionId: 'section-1',
    activePageId: 'page-1',
  };
}

class MemorySource implements V1WorkspaceMigrationSource {
  constructor(private readonly value: WorkspaceState) {}
  async loadWorkspace() { return { workspace: structuredClone(this.value), backend: 'indexeddb' as const }; }
  async loadRecoveryDraft(): Promise<RecoveryDraft | null> { return null; }
}

/** Real runtime sessions over one in-memory workspace store, plus one persisted search store. */
async function workspaceSetup(texts: readonly string[]) {
  const store = new MemoryWorkspaceStore();
  const source = new MemorySource(v1Workspace(texts));
  const activationStore = new BrowserV2WorkspaceActivationStore(store);
  const migrationFactory = () => new V2WorkspaceMigrationOrchestrator(
    source,
    activationStore,
    new InMemoryAutomergeRepoMigrationAdapter(),
    new DefaultAutomergeMigrationMaterializer(),
    { now: () => TIME },
  );
  await migrationFactory().run();
  const searchStore = new InMemorySearchAdapter();
  const open = async () => {
    const runtime = new WorkspaceV2Runtime({
      source,
      activationStore,
      repoFactory: memoryRepoFactory(store),
      migrationFactory,
      acquireWriteAccess: async () => 'indexeddb' as const,
      pageCacheSize: PAGE_CACHE_SIZE,
      indexWriteDelayMs: 0,
    });
    await runtime.startup();
    return runtime;
  };
  const controllerFor = (runtime: WorkspaceV2Runtime, sourceBuilder?: SearchSourceBuilder) => new WorkspaceSearchController(runtime, {
    backend: new LocalProjectionBackend(searchStore),
    derivedStore: new MemoryDerivedTextStore(),
    ocrAdapter: unusedOcr,
    liveUpdateDelayMs: 5,
    ...(sourceBuilder ? { sourceBuilder } : {}),
  });
  return { open, controllerFor, searchStore };
}

function v2State(runtime: WorkspaceV2Runtime): V2RuntimeState {
  const state = runtime.getState();
  if (state.schemaVersion === 1) throw new Error('Expected a schema-v2 workspace.');
  return state;
}

/** Counts reads per page and records the largest number of loaded pages seen during any read. */
function watchReads(runtime: WorkspaceV2Runtime) {
  const reads: string[] = [];
  let maxLoadedPages = runtime.getMemoryDiagnostics().loadedPages;
  const readPage = runtime.readPage.bind(runtime);
  vi.spyOn(runtime, 'readPage').mockImplementation((pageId, reader) => {
    reads.push(pageId);
    return readPage(pageId, (document) => {
      maxLoadedPages = Math.max(maxLoadedPages, runtime.getMemoryDiagnostics().loadedPages);
      return reader(document);
    });
  });
  return { reads, maxLoadedPages: () => maxLoadedPages };
}

describe('workspace search over lazily loaded pages', () => {
  it('finds text on a page that was never opened in this session, and a second session reuses the stored record', async () => {
    const texts = ['Vektoren', 'Kräfte', 'Energie', 'Arbeit', 'Leistung', 'Gravitationskonstante bestimmen', 'Wellen', 'Optik'];
    const setup = await workspaceSetup(texts);
    const runtime = await setup.open();
    expect(runtime.isPageLoaded('page-6')).toBe(false);
    const watched = watchReads(runtime);

    const controller = setup.controllerFor(runtime);
    await controller.initialize(v2State(runtime));
    await controller.whenIdle();

    expect(controller.search('Gravitationskonstante').map((result) => result.pageId)).toEqual(['page-6']);
    expect(controller.getSnapshot()).toMatchObject({ phase: 'ready', recordCount: texts.length });
    expect(runtime.isPageLoaded('page-6')).toBe(false);
    // Every page was read once, and reading never kept more pages than the cache allows.
    expect([...watched.reads].sort()).toEqual(texts.map((_, index) => `page-${index + 1}`).sort());
    expect(watched.maxLoadedPages()).toBeLessThanOrEqual(PAGE_CACHE_SIZE + 1);
    expect(runtime.getMemoryDiagnostics().loadedPages).toBeLessThanOrEqual(PAGE_CACHE_SIZE + 1);
    controller.dispose();
    await runtime.shutdown();

    const second = await setup.open();
    const secondReads = watchReads(second);
    const reopened = setup.controllerFor(second);
    await reopened.initialize(v2State(second));
    // Current records are searchable as soon as initialize resolves.
    expect(reopened.search('Gravitationskonstante').map((result) => result.pageId)).toEqual(['page-6']);
    await reopened.whenIdle();
    expect(secondReads.reads).toEqual([]);
    expect(second.isPageLoaded('page-6')).toBe(false);
    reopened.dispose();
    await second.shutdown();
  });

  it('updates results after an edit of a loaded page and coalesces a burst of changes', async () => {
    const setup = await workspaceSetup(['Newton', 'Kepler', 'Galilei']);
    const runtime = await setup.open();
    await runtime.ensureSchemaV3();
    const controller = setup.controllerFor(runtime);
    await controller.initialize(v2State(runtime));
    await controller.whenIdle();
    expect(controller.search('Newton').map((result) => result.pageId)).toEqual(['page-1']);
    const revision = controller.getSnapshot().revision;
    const watched = watchReads(runtime);

    const writer = await runtime.preparePageWrite('page-1');
    for (let index = 0; index < 10; index += 1) {
      writer.change({ message: `Edit ${index}` }, (page) => {
        seedPortableRichText(page, 'text-1', {
          type: 'doc',
          blocks: [{ id: 'paragraph', type: 'paragraph', spans: [{ text: `Quantenmechanik Schritt${index}`, marks: [] }] }],
        });
      });
    }
    await vi.waitFor(() => expect(controller.search('Quantenmechanik').map((result) => result.pageId)).toEqual(['page-1']));
    await controller.whenIdle();

    expect(controller.search('Schritt9').map((result) => result.pageId)).toEqual(['page-1']);
    expect(controller.search('Newton')).toEqual([]);
    expect(controller.getSnapshot().revision).toBeGreaterThan(revision);
    expect(watched.reads.filter((pageId) => pageId === 'page-1').length).toBeLessThanOrEqual(2);
    controller.dispose();
    await runtime.shutdown();
  });

  it('patches notebook titles without reading pages and removes records of pages that are gone', async () => {
    const setup = await workspaceSetup(['Newton', 'Kepler']);
    const runtime = await setup.open();
    await runtime.ensureSchemaV3();
    const controller = setup.controllerFor(runtime);
    await controller.initialize(v2State(runtime));
    await controller.whenIdle();
    const watched = watchReads(runtime);

    const state = v2State(runtime);
    await runtime.commitWorkspaceGraphRevision({
      operationId: 'rename-notebook',
      expectedActivationArtifactFingerprint: state.activation.artifactFingerprint,
      message: 'Rename notebook',
      changes: [{
        documentId: state.notebooks[0].documentId,
        change: (notebook) => {
          if (notebook.kind !== 'notebook') throw new Error('Expected the notebook document.');
          notebook.title = 'Naturwissenschaften';
        },
      }],
    });
    await vi.waitFor(() => expect(controller.search('Naturwissenschaften').map((result) => result.pageId).sort())
      .toEqual(['page-1', 'page-2']));
    expect(controller.search('Kepler')[0]).toMatchObject({ notebookTitle: 'Naturwissenschaften', sectionTitle: 'Physik' });
    await controller.whenIdle();
    expect(watched.reads).toEqual([]);

    const current = v2State(runtime);
    controller.updateWorkspace({ ...current, pages: current.pages.filter((page) => page.pageId !== 'page-2') });
    await controller.whenIdle();
    expect(controller.search('Kepler')).toEqual([]);
    expect(controller.getSnapshot().recordCount).toBe(1);
    await expect(setup.searchStore.load()).resolves.toMatchObject({ records: [expect.objectContaining({ pageId: 'page-1' })] });
    controller.dispose();
    await runtime.shutdown();
  });

  it('re-projects every page one at a time on an explicit rebuild', async () => {
    const setup = await workspaceSetup(['Newton', 'Kepler', 'Galilei', 'Hooke']);
    const runtime = await setup.open();
    const controller = setup.controllerFor(runtime);
    await controller.initialize(v2State(runtime));
    await controller.whenIdle();
    const reads: string[] = [];
    let reading = 0;
    let overlapping = false;
    const readPage = runtime.readPage.bind(runtime);
    vi.spyOn(runtime, 'readPage').mockImplementation(async (pageId, reader) => {
      reads.push(pageId);
      reading += 1;
      overlapping ||= reading > 1;
      try {
        return await readPage(pageId, reader);
      } finally {
        reading -= 1;
      }
    });

    await controller.rebuild();
    expect(reads).toHaveLength(4);
    expect(overlapping).toBe(false);
    expect(controller.getSnapshot()).toMatchObject({ phase: 'ready', message: 'Suchindex wurde neu aufgebaut.', recordCount: 4 });
    controller.dispose();
    await runtime.shutdown();
  });

  it('coalesces a StrictMode-style reopen and attaches one live subscription', async () => {
    const setup = await workspaceSetup(['Newton']);
    const runtime = await setup.open();
    const subscribe = vi.spyOn(runtime, 'subscribeToDocumentChanges');
    const derivedStore = new MemoryDerivedTextStore();
    const load = vi.spyOn(derivedStore, 'load');
    const controller = new WorkspaceSearchController(runtime, {
      backend: new LocalProjectionBackend(new InMemorySearchAdapter()),
      derivedStore,
      ocrAdapter: unusedOcr,
    });

    const unsubscribeFirst = controller.subscribe(() => undefined);
    const first = controller.initialize(v2State(runtime));
    unsubscribeFirst();
    controller.dispose();
    const unsubscribeSecond = controller.subscribe(() => undefined);
    const second = controller.initialize(v2State(runtime));
    await Promise.all([first, second]);
    await controller.whenIdle();

    expect(load).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(controller.search('Newton')).toHaveLength(1);
    unsubscribeSecond();
    controller.dispose();
    await runtime.shutdown();
  });
});

/** A runtime port that emits document changes on demand, for queue behaviour at a scale real pages would make slow. */
function scriptedRuntime(pageCount: number) {
  const heads = new Map<string, string[]>();
  const pages: PageSummary[] = Array.from({ length: pageCount }, (_, index) => {
    const documentId = `page:${index}`;
    heads.set(documentId, ['h0']);
    return {
      documentId, pageId: `p${index}`, notebookId: 'notebook-one', sectionId: 'section-one', title: `Seite ${index}`,
      tags: [], pageType: 'free', background: { type: 'plain' }, pageContentKind: 'canvas',
      createdAt: TIME, updatedAt: TIME, schemaVersion: 3, assets: [], heads: ['h0'],
    };
  });
  const state = {
    schemaVersion: 3,
    authoritative: 'v3',
    activation: { artifactFingerprint: `sha256:${'a'.repeat(64)}` },
    active: { notebookId: 'notebook-one', sectionId: 'section-one', pageId: 'p0' },
    notebooks: [{
      schemaVersion: 3, documentId: 'notebook:notebook-one', kind: 'notebook', notebookId: 'notebook-one', title: 'Schule',
      color: '#fff', createdAt: TIME, updatedAt: TIME, settings: { defaultPageType: 'free' },
      sections: [{ id: 'section-one', title: 'Physik', createdAt: TIME, updatedAt: TIME, pageDocumentIds: pages.map((page) => page.documentId) }],
    }],
    pages,
  } as unknown as V2RuntimeState;
  let listener: ((event: DocumentChangeEvent) => void) | undefined;
  const runtime = {
    getState: () => state,
    subscribeToState: () => () => undefined,
    subscribeToDocumentChanges: (next: (event: DocumentChangeEvent) => void) => { listener = next; return () => { listener = undefined; }; },
    getDocumentHeads: (documentId: string) => heads.get(documentId),
    readPage: async () => { throw new Error('The scripted runtime has no page documents.'); },
    getAsset: async () => undefined,
  } as unknown as WorkspaceV2Runtime;
  const change = (index: number, head: string) => {
    const documentId = `page:${index}`;
    const beforeHeads = heads.get(documentId) ?? [];
    heads.set(documentId, [head]);
    listener?.({ documentId, kind: 'page', beforeHeads, heads: [head], origin: { kind: 'remote', source: 'test' } });
  };
  return { runtime, state, heads, change };
}

class ScriptedBuilder implements SearchSourceBuilder {
  active = 0;
  maxActive = 0;
  readonly built: string[] = [];
  ocr = new Map<string, string>();
  constructor(private readonly heads: Map<string, string[]>) {}
  initialize = vi.fn(async () => 'loaded' as const);
  buildPage = vi.fn<SearchSourceBuilder['buildPage']>(async (_notebooks, pageId) => {
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    this.active -= 1;
    this.built.push(pageId);
    const index = Number(pageId.slice(1));
    const documentId = `page:${index}`;
    const heads = this.heads.get(documentId) ?? [];
    return source({
      documentId, pageId, pageTitle: `Seite ${index} Stand ${heads.join('')}`, pageHeads: [...heads],
      ocrText: this.ocr.has(pageId) ? [this.ocr.get(pageId) ?? ''] : [],
    });
  });
  recognizePage = vi.fn(async (pageId: string) => {
    this.ocr.set(pageId, 'Lokaler OCR Treffer');
    return { recognizedAssets: 1, textCharacters: 19 };
  });
  diagnoseAsset = vi.fn(async (): Promise<OcrRecognitionResult> => ({
    engine: 'windows-media-ocr', languageTag: 'de-DE', text: 'Diagnose', lines: [],
  }));
}

describe('workspace search queue', () => {
  it('falls back to one sequential pass when more pages change than the live queue holds', async () => {
    const scripted = scriptedRuntime(200);
    const builder = new ScriptedBuilder(scripted.heads);
    const controller = new WorkspaceSearchController(scripted.runtime, {
      backend: new LocalProjectionBackend(new InMemorySearchAdapter()),
      sourceBuilder: builder,
      ocrAdapter: unusedOcr,
      liveUpdateDelayMs: 5,
    });
    await controller.initialize(scripted.state);
    await controller.whenIdle();
    expect(builder.built).toHaveLength(200);
    builder.built.length = 0;

    for (let index = 0; index < 200; index += 1) scripted.change(index, 'h1');
    await controller.whenIdle();

    expect([...builder.built].sort()).toEqual(scripted.state.pages.map((page) => page.pageId).sort());
    expect(builder.maxActive).toBe(1);
    expect(controller.search('Stand h1')).toHaveLength(100);
    expect(controller.getSnapshot()).toMatchObject({ phase: 'ready', recordCount: 200 });
    controller.dispose();
  });

  it('indexes the page being viewed first, then its section, then the rest', async () => {
    const scripted = scriptedRuntime(9);
    // Pages 0-2 and 6-8 are in another section than the viewed page 4 (with 3 and 5).
    // The runtime port returns this same state object, so it is changed in place.
    const state = Object.assign(scripted.state, {
      pages: scripted.state.pages.map((page, index) => (index >= 3 && index <= 5 ? { ...page, sectionId: 'section-two' } : page)),
      active: { notebookId: 'notebook-one', sectionId: 'section-two', pageId: 'p4' },
    });
    const builder = new ScriptedBuilder(scripted.heads);
    const controller = new WorkspaceSearchController(scripted.runtime, {
      backend: new LocalProjectionBackend(new InMemorySearchAdapter()),
      sourceBuilder: builder,
      ocrAdapter: unusedOcr,
    });
    await controller.initialize(state);
    await controller.whenIdle();
    expect(builder.built.slice(0, 3)).toEqual(['p4', 'p3', 'p5']);
    expect(builder.built).toHaveLength(9);
    controller.dispose();
  });

  it('indexes every page without PDF text first, then reads the PDF text page by page', async () => {
    const scripted = scriptedRuntime(6);
    const builder = new ScriptedBuilder(scripted.heads);
    const withPdf = (index: number) => index % 2 === 0;
    const calls: string[] = [];
    const build = builder.buildPage.getMockImplementation()!;
    builder.buildPage.mockImplementation(async (notebooks, pageId, signal, options) => {
      const index = Number(pageId.slice(1));
      const deferred = Boolean(options?.deferPdfText) && withPdf(index);
      calls.push(`${pageId}${deferred ? ':deferred' : ''}`);
      const built = await build(notebooks, pageId);
      if (!withPdf(index)) return built;
      return deferred ? { ...built, pdfText: [], pdfTextPending: true as const } : { ...built, pdfText: [`Zusatzblatt ${index}`] };
    });
    const searchStore = new InMemorySearchAdapter();
    const controller = new WorkspaceSearchController(scripted.runtime, {
      backend: new LocalProjectionBackend(searchStore),
      sourceBuilder: builder,
      ocrAdapter: unusedOcr,
    });
    await controller.initialize(scripted.state);
    await controller.whenIdle();
    // Every page's own text is read before any PDF text.
    expect(calls).toEqual(['p0:deferred', 'p1', 'p2:deferred', 'p3', 'p4:deferred', 'p5', 'p0', 'p2', 'p4']);
    expect(controller.search('Stand')).toHaveLength(6);
    expect(controller.search('Zusatzblatt').map((result) => result.pageId).sort()).toEqual(['p0', 'p2', 'p4']);
    expect(controller.getSnapshot()).toMatchObject({ phase: 'ready', recordCount: 6 });
    await expect(searchStore.load()).resolves.toMatchObject({ records: expect.not.arrayContaining([expect.objectContaining({ pdfTextPending: true })]) });
    controller.dispose();
  });

  it('completes pending PDF text after a restart without reading the other pages', async () => {
    const scripted = scriptedRuntime(4);
    const searchStore = new InMemorySearchAdapter();
    const firstBuilder = new ScriptedBuilder(scripted.heads);
    const build = firstBuilder.buildPage.getMockImplementation()!;
    // In the first session p1's PDF cannot be read: its record stays pending.
    firstBuilder.buildPage.mockImplementation(async (notebooks, pageId, signal, options) => {
      if (pageId === 'p1' && !options?.deferPdfText) throw new Error('PDF unreadable');
      const built = await build(notebooks, pageId);
      return pageId === 'p1' ? { ...built, pdfText: [], pdfTextPending: true as const } : built;
    });
    const first = new WorkspaceSearchController(scripted.runtime, {
      backend: new LocalProjectionBackend(searchStore),
      sourceBuilder: firstBuilder,
      ocrAdapter: unusedOcr,
    });
    await first.initialize(scripted.state);
    await first.whenIdle();
    expect(firstBuilder.built).toEqual(['p0', 'p1', 'p2', 'p3']);
    first.dispose();
    await expect(searchStore.load()).resolves.toMatchObject({ records: expect.arrayContaining([expect.objectContaining({ pageId: 'p1', pdfTextPending: true })]) });

    const secondBuilder = new ScriptedBuilder(scripted.heads);
    const second = new WorkspaceSearchController(scripted.runtime, {
      backend: new LocalProjectionBackend(searchStore),
      sourceBuilder: secondBuilder,
      ocrAdapter: unusedOcr,
    });
    await second.initialize(scripted.state);
    await second.whenIdle();
    expect(secondBuilder.built).toEqual(['p1']);
    second.dispose();
  });

  it('reads a PDF that stays unreadable once per session, not again and again', async () => {
    const scripted = scriptedRuntime(3);
    const searchStore = new InMemorySearchAdapter();
    const session = async () => {
      const builder = new ScriptedBuilder(scripted.heads);
      const build = builder.buildPage.getMockImplementation()!;
      // Every build of p1 leaves its PDF unread, as a damaged file does.
      builder.buildPage.mockImplementation(async (notebooks, pageId) => {
        const built = await build(notebooks, pageId);
        return pageId === 'p1' ? { ...built, pdfTextPending: true as const } : built;
      });
      const controller = new WorkspaceSearchController(scripted.runtime, {
        backend: new LocalProjectionBackend(searchStore),
        sourceBuilder: builder,
        ocrAdapter: unusedOcr,
      });
      await controller.initialize(scripted.state);
      await controller.whenIdle();
      controller.dispose();
      return builder.built;
    };
    // The first read defers the PDFs and the second one completes the page.
    expect(await session()).toEqual(['p0', 'p1', 'p2', 'p1']);
    // A restart tries the page once more, and only that page.
    expect(await session()).toEqual(['p1']);
  });

  it('publishes explicit OCR text for the page', async () => {
    const scripted = scriptedRuntime(2);
    const builder = new ScriptedBuilder(scripted.heads);
    const controller = new WorkspaceSearchController(scripted.runtime, {
      backend: new LocalProjectionBackend(new InMemorySearchAdapter()),
      sourceBuilder: builder,
      ocrAdapter: unusedOcr,
    });
    await controller.initialize(scripted.state);
    await controller.whenIdle();
    await controller.recognizePage('p1', 'de-DE');
    expect(controller.search('Lokaler OCR Treffer', { source: 'ocr' }).map((result) => result.pageId)).toEqual(['p1']);
    expect(builder.recognizePage).toHaveBeenCalledWith('p1', 'de-DE', undefined);
    controller.dispose();
  });
});

describe('workspace search queries', () => {
  async function controllerWith(sources: SearchPageSource[]) {
    const backend = new LocalProjectionBackend(new InMemorySearchAdapter());
    await backend.open();
    for (const value of sources) await backend.put(projectSearchPage(value));
    return new WorkspaceSearchController({} as WorkspaceV2Runtime, {
      backend,
      derivedStore: new MemoryDerivedTextStore(),
      ocrAdapter: unusedOcr,
    });
  }

  it('filters ranked source badges', async () => {
    const controller = await controllerWith([source()]);
    expect(controller.search('Federkraft', { source: 'ocr' })).toEqual([
      expect.objectContaining({ pageId: 'page-one', sourceBadges: ['ocr'] }),
    ]);
    expect(controller.search('Federkraft', { source: 'pdf' })).toEqual([]);
  });

  it('cuts results to several notebooks or sections, one page, and leaves excluded sections out', async () => {
    const page = (id: string, notebookId: string, sectionId: string) => source({
      documentId: `page:${id}`, pageId: id, notebookId, sectionId, pageTitle: `Kraft ${id}`,
    });
    const controller = await controllerWith([
      page('a', 'nb-1', 'sec-1'), page('b', 'nb-1', 'sec-2'), page('c', 'nb-2', 'sec-3'), page('d', 'nb-2', 'sec-4'),
    ]);
    const ids = (filters: Parameters<typeof controller.search>[1]) => controller.search('Kraft', filters).map((result) => result.pageId).sort();

    expect(ids({ notebookIds: ['nb-1', 'nb-2'] })).toEqual(['a', 'b', 'c', 'd']);
    expect(ids({ notebookIds: ['nb-2'] })).toEqual(['c', 'd']);
    expect(ids({ sectionIds: ['sec-2', 'sec-3'] })).toEqual(['b', 'c']);
    expect(ids({ notebookIds: ['nb-1'], sectionIds: ['sec-3'] })).toEqual([]);
    expect(ids({ pageId: 'd' })).toEqual(['d']);
    expect(ids({ excludeSectionIds: new Set(['sec-1', 'sec-4']) })).toEqual(['b', 'c']);
    expect(ids({})).toEqual(['a', 'b', 'c', 'd']);
  });

  it('folds task and tag filters into the operator engine and reviews tasks across pages', async () => {
    const controller = await controllerWith([
      source({ documentId: 'page:one', pageId: 'page-one', pageTitle: 'Offene Aufgabe', tags: ['todo'], taskState: 'open' }),
      source({ documentId: 'page:two', pageId: 'page-two', pageTitle: 'Erledigte Aufgabe', tags: ['todo'], taskState: 'done' }),
      source({ documentId: 'page:three', pageId: 'page-three', pageTitle: 'Nur Notiz', tags: ['idee'], taskState: undefined }),
    ]);

    expect(controller.availableTags()).toEqual(['idee', 'todo']);
    expect(controller.search('', { taskState: 'open' }).map((result) => result.pageId)).toEqual(['page-one']);
    expect(controller.search('', { tag: 'idee' }).map((result) => result.pageId)).toEqual(['page-three']);
    expect(controller.search('', {})).toEqual([]);

    const review = controller.taskReview();
    expect(review.map((result) => result.pageId).sort()).toEqual(['page-one', 'page-two']);
    expect(review.find((result) => result.pageId === 'page-two')).toMatchObject({
      taskState: 'done',
      tags: ['todo'],
    });
    expect(controller.taskReview({ taskState: 'open' }).map((result) => result.pageId))
      .toEqual(['page-one']);
  });

  it('answers an over-limit query with an empty result and a hint instead of throwing', async () => {
    const controller = await controllerWith([
      source({ documentId: 'page:one', pageId: 'page-one', pageTitle: 'Impuls', tags: ['todo'], taskState: 'open' }),
    ]);

    // React renders `search` inside a useMemo, so a thrown SearchLimitError
    // tears down the whole app. An over-long query must fail soft.
    const tooManyWords = Array.from({ length: 40 }, (_, index) => `wort${index}`).join(' ');
    expect(() => controller.search(tooManyWords, {})).not.toThrow();
    expect(controller.search(tooManyWords, {})).toEqual([]);
    expect(() => controller.taskReview({ taskState: 'open' })).not.toThrow();
    expect(controller.describeQueryLimit(tooManyWords, {})).toMatch(/token|Zeichen|byte|filter/i);
    expect(controller.describeQueryLimit('impuls', {})).toBeNull();
  });
});

describe('native search mirror', () => {
  it('rebuilds the desktop FTS table from stored records, then follows each write', async () => {
    const calls: Array<[string, Record<string, unknown> | undefined]> = [];
    let failNextUpsert = false;
    const call: NativeInvoke = async <T>(command: string, args?: Record<string, unknown>) => {
      calls.push([command, args]);
      if (command === 'search_v2_upsert' && failNextUpsert) {
        failNextUpsert = false;
        throw new Error('native write failed');
      }
      return undefined as T;
    };
    const adapter = new InMemorySearchAdapter();
    await adapter.upsert(projectSearchPage(source()));
    const backend = new LocalProjectionBackend(adapter, new TauriSqliteSearchIndex(call));
    await backend.open();
    await backend.nativeSettled();
    expect(calls.map(([command, args]) => [command, (args?.row as { documentId?: string } | undefined)?.documentId]))
      .toEqual([['search_v2_clear', undefined], ['search_v2_upsert', 'page:one']]);

    calls.length = 0;
    await backend.put(projectSearchPage(source({ documentId: 'page:two', pageId: 'page-two' })));
    await backend.remove('page:one');
    await backend.nativeSettled();
    expect(calls.map(([command]) => command)).toEqual(['search_v2_upsert', 'search_v2_remove']);

    calls.length = 0;
    failNextUpsert = true;
    await backend.put(projectSearchPage(source({ documentId: 'page:three', pageId: 'page-three' })));
    await backend.nativeSettled();
    // A failed write resynchronises the mirror from the records.
    expect(calls.map(([command]) => command)).toEqual(['search_v2_upsert', 'search_v2_clear', 'search_v2_upsert', 'search_v2_upsert']);
  });
});

function builderFor(page: PageDoc | PageDocV3, assets = new MemoryAssetRepository(), ocrAdapter: OcrAdapter = unusedOcr) {
  const document: PageAutomergeDoc = createPageAutomergeDocV3(page);
  return new RuntimeSearchSourceBuilder(
    { readPage: async (_pageId, reader) => reader(document) },
    assets,
    new MemoryDerivedTextStore(),
    new OcrQueue(ocrAdapter),
  );
}

const notebook = {
  schemaVersion: 3 as const,
  documentId: 'notebook:notebook-one',
  kind: 'notebook' as const,
  notebookId: 'notebook-one',
  title: 'Schule',
  color: '#fff',
  createdAt: TIME,
  updatedAt: TIME,
  sections: [{ id: 'section-one', title: 'Physik', createdAt: TIME, updatedAt: TIME, pageDocumentIds: ['page:one'] }],
  settings: { defaultPageType: 'free' as const },
};

function portablePage(overrides: Partial<PageDocV3>): PageDocV3 {
  return {
    schemaVersion: 3,
    documentId: 'page:one',
    kind: 'page',
    notebookId: 'notebook-one',
    sectionId: 'section-one',
    pageId: 'page-one',
    title: 'Impulserhaltung',
    tags: ['prüfung'],
    pageType: 'free',
    background: { type: 'plain', color: '#fff' },
    createdAt: TIME,
    updatedAt: TIME,
    elementsById: {},
    zOrder: [],
    version: { protocol: 'uninitialized', heads: [] },
    ...overrides,
  };
}

describe('runtime PDF and OCR source projection', () => {
  it('projects schema-v3 Math/Graph pages losslessly into the content-minimized math search field', async () => {
    const page = portablePage({
      mathSettings: { version: 1, resultMode: 'suggest', numberMode: 'exact', angleMode: 'degrees', autoRecognition: true },
      elementsById: {
        math: {
          id: 'math', kind: 'math', frame: { x: 0, y: 0, width: 120, height: 50, rotation: 0 },
          createdAt: TIME, updatedAt: TIME, locked: false,
          inputKind: 'typed', autoRecognition: 'inherit', typedLatex: 'typed-secret', correctedLatex: 'a=x^2',
          recognition: { state: 'recognized', alternatives: ['alternative-secret'], warnings: ['warning-secret'] },
          result: { state: 'valid', exactLatex: 'x^2', diagnostics: ['diagnostic-secret'] },
          dependencies: { defines: ['a'], references: ['x'], dependsOnElementIds: [], state: 'valid' },
        },
        graph: {
          id: 'graph', kind: 'graph', frame: { x: 0, y: 60, width: 200, height: 120, rotation: 0 },
          createdAt: TIME, updatedAt: TIME, locked: false,
          series: [{ id: 'series', sourceMathElementId: 'math', color: '#3366cc', visible: true }],
          viewport: { xMin: -2, xMax: 2, yMin: -1, yMax: 4, equalScale: false, axesVisible: true, gridVisible: true },
        },
      },
      zOrder: ['math', 'graph'],
    });
    const builder = builderFor(page);
    await builder.initialize();
    const projected = await builder.buildPage([notebook], 'page-one');
    expect(projected.pageHeads.length).toBeGreaterThan(0);
    expect(projected.mathText?.join('\n')).toContain('a=x^2');
    expect(projected.mathText?.join('\n')).toContain('x^2');
    expect(projected.mathText?.join('\n')).toContain('defines a');
    expect(projected.mathText?.join('\n')).not.toMatch(/typed-secret|alternative-secret|warning-secret|diagnostic-secret/);
  });

  it('extracts PDF text from AssetRepository and persists explicit image OCR projections', async () => {
    const repository = new MemoryAssetRepository();
    const pdfDocument = new jsPDF();
    pdfDocument.text('Lokales PDF Arbeitsblatt', 20, 20);
    const pdfBytes = new Uint8Array(pdfDocument.output('arraybuffer'));
    const pdfId = await sha256Bytes(pdfBytes);
    await repository.putAsset({ assetId: pdfId, checksum: pdfId, size: pdfBytes.length, bytes: pdfBytes });
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
    const imageId = await sha256Bytes(pngBytes);
    await repository.putAsset({ assetId: imageId, checksum: imageId, size: pngBytes.length, bytes: pngBytes });
    const pdfRef: AssetRef = { assetId: pdfId, checksum: pdfId, size: pdfBytes.length, mimeType: 'application/pdf', role: 'original' };
    const imageRef: AssetRef = { assetId: imageId, checksum: imageId, size: pngBytes.length, mimeType: 'image/png', role: 'original' };
    const page = portablePage({
      elementsById: {
        pdf: {
          id: 'pdf', kind: 'pdf', frame: { x: 0, y: 0, width: 100, height: 100, rotation: 0 },
          createdAt: TIME, updatedAt: TIME, locked: true,
          originalAsset: pdfRef, previewAsset: imageRef, pageCount: 1, sourcePageNumber: 1, sourceAvailability: 'original',
        },
        image: {
          id: 'image', kind: 'image', frame: { x: 0, y: 0, width: 100, height: 100, rotation: 0 },
          createdAt: TIME, updatedAt: TIME, locked: false,
          asset: imageRef, alt: 'Scan',
        },
      },
      zOrder: ['pdf', 'image'],
    });
    const builder = builderFor(page, repository, {
      availableLanguages: async () => ['de-DE'],
      recognize: async () => ({ engine: 'windows-media-ocr', languageTag: 'de-DE', text: 'OCR Versuchsanordnung', lines: [] }),
    });
    await builder.initialize();
    const before = await builder.buildPage([notebook], 'page-one');
    expect(before.pdfText.join(' ')).toContain('Lokales PDF Arbeitsblatt');
    await builder.recognizePage('page-one', 'de-DE');
    const after = await builder.buildPage([notebook], 'page-one');
    expect(after.ocrText).toContain('OCR Versuchsanordnung');
  });
});

describe('deferred PDF text', () => {
  it('builds a page without its PDF text first and completes it later from the same read', async () => {
    const repository = new MemoryAssetRepository();
    const pdfDocument = new jsPDF();
    pdfDocument.text('Zweites PDF Arbeitsblatt', 20, 20);
    const pdfBytes = new Uint8Array(pdfDocument.output('arraybuffer'));
    const pdfId = await sha256Bytes(pdfBytes);
    await repository.putAsset({ assetId: pdfId, checksum: pdfId, size: pdfBytes.length, bytes: pdfBytes });
    const pdfRef: AssetRef = { assetId: pdfId, checksum: pdfId, size: pdfBytes.length, mimeType: 'application/pdf', role: 'original' };
    const previewBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 2]);
    const previewId = await sha256Bytes(previewBytes);
    const previewRef: AssetRef = { assetId: previewId, checksum: previewId, size: previewBytes.length, mimeType: 'image/png', role: 'original' };
    const document: PageAutomergeDoc = createPageAutomergeDocV3(portablePage({
      elementsById: {
        pdf: {
          id: 'pdf', kind: 'pdf', frame: { x: 0, y: 0, width: 100, height: 100, rotation: 0 },
          createdAt: TIME, updatedAt: TIME, locked: true,
          originalAsset: pdfRef, previewAsset: previewRef, pageCount: 1, sourcePageNumber: 1, sourceAvailability: 'original',
        },
      },
      zOrder: ['pdf'],
    }));
    let reads = 0;
    let heads = getAutomergeHeads(document);
    const getAsset = vi.spyOn(repository, 'getAsset');
    const builder = new RuntimeSearchSourceBuilder(
      {
        readPage: async (_pageId, reader) => { reads += 1; return reader(document); },
        getDocumentHeads: () => heads,
      },
      repository,
      new MemoryDerivedTextStore(),
      new OcrQueue(unusedOcr),
    );
    await builder.initialize();

    const deferred = await builder.buildPage([notebook], 'page-one', undefined, { deferPdfText: true });
    expect(deferred).toMatchObject({ pdfText: [], pdfTextPending: true });
    expect(getAsset).not.toHaveBeenCalled();

    const complete = await builder.buildPage([notebook], 'page-one');
    expect(complete.pdfText.join(' ')).toContain('Zweites PDF Arbeitsblatt');
    expect(complete.pdfTextPending).toBeUndefined();
    expect(reads).toBe(1);

    // A page that changed after the deferred read is read again.
    await builder.buildPage([notebook], 'page-one', undefined, { deferPdfText: true });
    heads = ['changed'];
    await builder.buildPage([notebook], 'page-one');
    expect(reads).toBe(3);
  });
});

describe('unreadable PDF printouts', () => {
  it('indexes the readable printouts of a page and marks it for a later attempt instead of failing the page', async () => {
    const repository = new MemoryAssetRepository();
    const readable = new jsPDF();
    readable.text('Lesbares Arbeitsblatt', 20, 20);
    const stored = async (bytes: Uint8Array): Promise<AssetRef> => {
      const assetId = await sha256Bytes(bytes);
      await repository.putAsset({ assetId, checksum: assetId, size: bytes.length, bytes });
      return { assetId, checksum: assetId, size: bytes.length, mimeType: 'application/pdf', role: 'original' };
    };
    const readableRef = await stored(new Uint8Array(readable.output('arraybuffer')));
    const damagedRef = await stored(new TextEncoder().encode('%PDF-1.7\n% not a document\n%%EOF'));
    const missingRef: AssetRef = { ...readableRef, assetId: `sha256:${'0'.repeat(64)}`, checksum: `sha256:${'0'.repeat(64)}` };
    const previewBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 3]);
    const previewId = await sha256Bytes(previewBytes);
    const previewRef: AssetRef = { assetId: previewId, checksum: previewId, size: previewBytes.length, mimeType: 'image/png', role: 'original' };
    const printout = (id: string, original: AssetRef): PageDocV3['elementsById'][string] => ({
      id, kind: 'pdf', frame: { x: 0, y: 0, width: 100, height: 100, rotation: 0 },
      createdAt: TIME, updatedAt: TIME, locked: true,
      originalAsset: original, previewAsset: previewRef, pageCount: 1, sourcePageNumber: 1, sourceAvailability: 'original',
    });
    const page = portablePage({
      elementsById: {
        damaged: printout('damaged', damagedRef),
        missing: printout('missing', missingRef),
        readable: printout('readable', readableRef),
      },
      zOrder: ['damaged', 'missing', 'readable'],
    });
    const builder = builderFor(page, repository);
    await builder.initialize();

    const built = await builder.buildPage([notebook], 'page-one');
    expect(built.pdfText.join(' ')).toContain('Lesbares Arbeitsblatt');
    expect(built.pdfTextPending).toBe(true);
    expect(projectSearchPage(built)).toMatchObject({ pdfTextPending: true });
  });
});

describe('background indexing', () => {
  it('answers a search during the startup pass from the pages indexed so far and reports it as incomplete', async () => {
    const scripted = scriptedRuntime(20);
    const builder = new ScriptedBuilder(scripted.heads);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const build = builder.buildPage.getMockImplementation()!;
    builder.buildPage.mockImplementation(async (notebooks, pageId) => {
      if (Number(pageId.slice(1)) >= 5) await gate;
      return build(notebooks, pageId);
    });
    const controller = new WorkspaceSearchController(scripted.runtime, {
      backend: new LocalProjectionBackend(new InMemorySearchAdapter()),
      sourceBuilder: builder,
      ocrAdapter: unusedOcr,
    });
    await controller.initialize(scripted.state);
    await vi.waitFor(() => expect(builder.built).toHaveLength(5));

    // Pages indexed so far answer at once; the snapshot says the pass is still running.
    expect(controller.search('Stand').map((result) => result.pageId).sort()).toEqual(['p0', 'p1', 'p2', 'p3', 'p4']);
    expect(controller.getSnapshot()).toMatchObject({ phase: 'rebuilding', progress: { total: 20 } });

    release();
    await controller.whenIdle();
    expect(controller.search('Stand')).toHaveLength(20);
    expect(controller.getSnapshot().phase).toBe('ready');
    expect(controller.getSnapshot().progress).toBeUndefined();
    controller.dispose();
  });

  it('shows progress for a pass that checks many new pages, such as after an import', async () => {
    const scripted = scriptedRuntime(3);
    const builder = new ScriptedBuilder(scripted.heads);
    const controller = new WorkspaceSearchController(scripted.runtime, {
      backend: new LocalProjectionBackend(new InMemorySearchAdapter()),
      sourceBuilder: builder,
      ocrAdapter: unusedOcr,
    });
    await controller.initialize(scripted.state);
    await controller.whenIdle();
    const snapshots: Array<{ phase: string; progress?: { done: number; total: number } }> = [];
    controller.subscribe((snapshot) => snapshots.push(snapshot));

    const imported = Array.from({ length: 30 }, (_, index) => {
      const documentId = `page:${index + 3}`;
      scripted.heads.set(documentId, ['h0']);
      return { ...scripted.state.pages[0], documentId, pageId: `p${index + 3}`, title: `Import ${index}` };
    });
    controller.updateWorkspace({ ...scripted.state, pages: [...scripted.state.pages, ...imported] });
    await controller.whenIdle();

    expect(snapshots.some((snapshot) => snapshot.phase === 'rebuilding' && snapshot.progress?.total === 30)).toBe(true);
    expect(controller.getSnapshot().progress).toBeUndefined();
    expect(controller.search('Stand')).toHaveLength(33);
    controller.dispose();
  });

  it('projects pages that are not open through the page projector and reads the open page in place', async () => {
    const setup = await workspaceSetup(['Newton', 'Kepler', 'Galilei']);
    const runtime = await setup.open();
    const watched = watchReads(runtime);
    const projected: string[] = [];
    // Stands in for the worker: loads the stored bytes into its own document.
    const projector = {
      project: vi.fn(async (documentId: string, bytes: Uint8Array) => {
        projected.push(documentId);
        const { searchablePage } = await import('../../search/searchablePage');
        const Automerge = await import('@automerge/automerge');
        const document = Automerge.load(bytes) as PageAutomergeDoc;
        try {
          return { ...structuredClone(searchablePage(document)), heads: [...Automerge.getHeads(document)] };
        } finally {
          Automerge.free(document);
        }
      }),
      dispose: vi.fn(),
    };
    const controller = new WorkspaceSearchController(runtime, {
      backend: new LocalProjectionBackend(new InMemorySearchAdapter()),
      derivedStore: new MemoryDerivedTextStore(),
      ocrAdapter: unusedOcr,
      pageProjector: projector,
    });
    await controller.initialize(v2State(runtime));
    await controller.whenIdle();

    expect(controller.search('Kepler').map((result) => result.pageId)).toEqual(['page-2']);
    expect(controller.search('Galilei').map((result) => result.pageId)).toEqual(['page-3']);
    const documentIdOf = (pageId: string) => v2State(runtime).pages.find((page) => page.pageId === pageId)?.documentId;
    expect(projected.sort()).toEqual([documentIdOf('page-2'), documentIdOf('page-3')].sort());
    expect(watched.reads).toEqual(['page-1']);
    expect(runtime.isPageLoaded('page-2')).toBe(false);
    controller.dispose();
    expect(projector.dispose).toHaveBeenCalled();
    await runtime.shutdown();
  });

  it('reads a page on the main thread when the projector fails', async () => {
    const setup = await workspaceSetup(['Newton', 'Kepler']);
    const runtime = await setup.open();
    const watched = watchReads(runtime);
    const controller = new WorkspaceSearchController(runtime, {
      backend: new LocalProjectionBackend(new InMemorySearchAdapter()),
      derivedStore: new MemoryDerivedTextStore(),
      ocrAdapter: unusedOcr,
      pageProjector: { project: async () => { throw new Error('worker gone'); }, dispose: () => undefined },
    });
    await controller.initialize(v2State(runtime));
    await controller.whenIdle();
    expect(controller.search('Kepler').map((result) => result.pageId)).toEqual(['page-2']);
    expect([...watched.reads].sort()).toEqual(['page-1', 'page-2']);
    controller.dispose();
    await runtime.shutdown();
  });
});
