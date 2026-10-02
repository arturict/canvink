import { createStore, del, get, set } from 'idb-keyval';
import { getAutomergeHeads, type LiveNotebookDocV2 } from '../../crdt';
import type { AssetRepository } from '../../assets';
import type { AssetRef, Sha256Checksum } from '../../domain/v2';
import type { PageElementV3 } from '../../domain/v3';
import { inspectPdf } from '../../io/pdf';
import { IndexedDbSearchAdapter } from '../../search/adapters';
import { RebuildableSearchIndex } from '../../search';
import { TauriSqliteSearchIndex } from '../../search/native';
import {
  OcrQueue,
  OcrBackpressureError,
  OcrCancelledError,
  TauriWindowsOcrAdapter,
  UnsupportedBrowserOcrAdapter,
  type OcrAdapter,
  type OcrRecognitionResult,
} from '../../search/ocr';
import { SearchLimitError, type SearchTaskState } from '../../search/normalize';
import { createDefaultPageProjector, type PageProjector, type ProjectedPage } from '../../search/pageProjector';
import { searchablePage } from '../../search/searchablePage';
import {
  buildSearchPageSource,
  projectedFromHeads,
  projectSearchPage,
  withLocationTitles,
} from '../../search/projection';
import type {
  SearchField,
  SearchPageSource,
  SearchProjectionAdapter,
  SearchProjectionRecord,
  SearchResult,
} from '../../search/types';
import type {
  DocumentChangeEvent,
  PageSummary,
  V2RuntimeState,
  WorkspaceV2Runtime,
} from '../../storage/workspaceV2Runtime';

const DERIVED_VERSION = 1 as const;
/** Distinct pages waiting for a live update; more fall back to a background pass. */
const MAX_PENDING_UPDATES = 128;
/** Quiet time after the last change of a page before it is projected again. */
const LIVE_UPDATE_DELAY_MS = 400;
/** Continuous typing still refreshes the index at least this often. */
const LIVE_UPDATE_MAX_DELAY_MS = 3_000;
/** Background passes publish progress at most this often. */
const PROGRESS_PUBLISH_INTERVAL_MS = 250;
/** Stored records are prepared for searching in slices of this length between other work. */
const WARM_SLICE_MS = 8;
/** Reconciliation passes with fewer pages run without showing progress. */
const LARGE_CHECK_PASS = 8;
/** Matches a search returns. */
const RESULT_LIMIT = 100;
/** Matches ranked before a notebook, section or page filter cuts them down. */
const SCOPED_RESULT_LIMIT = 400;

export type SearchSourceBadge = 'title' | 'text' | 'tag' | 'checklist' | 'pdf' | 'ocr';

export interface SearchUiResult extends SearchResult {
  sectionId: string;
  notebookTitle: string;
  sectionTitle: string;
  sourceBadges: SearchSourceBadge[];
  tags: string[];
  taskState?: SearchTaskState;
}

export interface SearchFilters {
  notebookId?: string;
  sectionId?: string;
  /** Any of these notebooks; combines with `notebookId`. */
  notebookIds?: readonly string[];
  /** Any of these sections; combines with `sectionId`. */
  sectionIds?: readonly string[];
  /** Sections that never match, such as an imported OneNote recycle bin. */
  excludeSectionIds?: ReadonlySet<string>;
  /** Only this page. */
  pageId?: string;
  source?: SearchSourceBadge;
  taskState?: SearchTaskState;
  tag?: string;
}

export type SearchRuntimePhase = 'idle' | 'opening' | 'ready' | 'rebuilding' | 'ocr' | 'error';

export interface SearchIndexProgress {
  /** Pages checked in the current background pass. */
  done: number;
  total: number;
  /** Pages whose text is searchable but whose PDF printouts are still being read. */
  pdfPending?: number;
}

export interface SearchRuntimeSnapshot {
  phase: SearchRuntimePhase;
  message: string;
  recordCount: number;
  rebuiltBecauseCorrupt: boolean;
  error?: string;
  /** Set while a background pass checks pages one at a time. */
  progress?: SearchIndexProgress;
  /**
   * Monotonic counter bumped on every publish. An incremental edit can leave
   * `recordCount` and `phase` unchanged, so memoized views in the query bar key
   * off this instead to refresh after the index content actually changes.
   */
  revision: number;
}

interface PdfDerivedText {
  checksum: Sha256Checksum;
  pages: string[];
}

interface OcrDerivedText {
  checksum: Sha256Checksum;
  languageTag: string;
  engine: 'windows-media-ocr';
  text: string;
}

interface DerivedTextSnapshot {
  version: typeof DERIVED_VERSION;
  pdfByAssetId: Record<string, PdfDerivedText>;
  ocrByAssetId: Record<string, OcrDerivedText>;
}

export interface DerivedTextStore {
  load(): Promise<DerivedTextSnapshot>;
  save(snapshot: DerivedTextSnapshot): Promise<void>;
  clear(): Promise<void>;
}

function emptyDerived(): DerivedTextSnapshot {
  return { version: DERIVED_VERSION, pdfByAssetId: {}, ocrByAssetId: {} };
}

function validateDerived(value: unknown): DerivedTextSnapshot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Derived search text is corrupt.');
  const candidate = value as Partial<DerivedTextSnapshot>;
  if (candidate.version !== DERIVED_VERSION || !candidate.pdfByAssetId || !candidate.ocrByAssetId) {
    throw new Error('Derived search text has an unsupported version.');
  }
  for (const [assetId, pdf] of Object.entries(candidate.pdfByAssetId)) {
    if (!assetId.startsWith('sha256:') || pdf.checksum !== assetId || !Array.isArray(pdf.pages)
      || pdf.pages.some((text) => typeof text !== 'string')) throw new Error('Derived PDF text is corrupt.');
  }
  for (const [assetId, ocr] of Object.entries(candidate.ocrByAssetId)) {
    if (!assetId.startsWith('sha256:') || ocr.checksum !== assetId || ocr.engine !== 'windows-media-ocr'
      || typeof ocr.languageTag !== 'string' || typeof ocr.text !== 'string') throw new Error('Derived OCR text is corrupt.');
  }
  return structuredClone(candidate as DerivedTextSnapshot);
}

export class MemoryDerivedTextStore implements DerivedTextStore {
  value: unknown = emptyDerived();

  async load(): Promise<DerivedTextSnapshot> { return validateDerived(this.value); }
  async save(snapshot: DerivedTextSnapshot): Promise<void> { this.value = validateDerived(snapshot); }
  async clear(): Promise<void> { this.value = emptyDerived(); }
}

export class IndexedDbDerivedTextStore implements DerivedTextStore {
  private readonly store = createStore('canvink-search-derived-v1', 'derived-text');
  async load(): Promise<DerivedTextSnapshot> {
    const value = await get<unknown>('snapshot', this.store);
    return value === undefined ? emptyDerived() : validateDerived(value);
  }
  save(snapshot: DerivedTextSnapshot): Promise<void> { return set('snapshot', validateDerived(snapshot), this.store); }
  clear(): Promise<void> { return del('snapshot', this.store); }
}

function assetRefs(element: PageElementV3): AssetRef[] {
  if (element.kind === 'image' || element.kind === 'attachment') return [element.asset];
  if (element.kind === 'pdf') return [element.previewAsset, ...(element.originalAsset ? [element.originalAsset] : [])];
  return [];
}

export interface BuildPageOptions {
  /**
   * Leave the text of the page's PDF printouts for later: reading them takes
   * far longer than everything else on the page, and the page is searchable
   * without them. The source is marked `pdfTextPending`; building the page
   * again without this option completes it.
   */
  deferPdfText?: boolean;
}

export interface SearchSourceBuilder {
  initialize(): Promise<'loaded' | 'reset-corrupt'>;
  /** Reads one page (loading it only for the read) and returns its search source. */
  buildPage(
    notebooks: readonly LiveNotebookDocV2[],
    pageId: string,
    signal?: AbortSignal,
    options?: BuildPageOptions,
  ): Promise<SearchPageSource>;
  recognizePage(pageId: string, languageTag: string, signal?: AbortSignal): Promise<{ recognizedAssets: number; textCharacters: number }>;
  diagnoseAsset(assetId: Sha256Checksum, languageTag?: string, signal?: AbortSignal): Promise<OcrRecognitionResult>;
}

type SourceRuntime = Pick<WorkspaceV2Runtime, 'readPage'>
  & Partial<Pick<WorkspaceV2Runtime, 'isPageLoaded' | 'getPageSummary' | 'readDocumentBytes' | 'getDocumentHeads'>>;

export class RuntimeSearchSourceBuilder implements SearchSourceBuilder {
  private derived: DerivedTextSnapshot = emptyDerived();
  /**
   * Pages built with `deferPdfText`, so that completing them does not load
   * the page a second time (a page with thousands of strokes takes seconds).
   * An entry counts only while the page still has the heads it was read at.
   */
  private readonly deferred = new Map<string, ProjectedPage>();

  constructor(
    private readonly runtime: SourceRuntime,
    private readonly assets: AssetRepository,
    private readonly derivedStore: DerivedTextStore,
    private readonly ocr: OcrQueue,
    /**
     * Projects pages that are not open in a worker, so reading them never
     * holds the main thread. Without one (tests, no Worker support) pages are
     * read through `runtime.readPage`.
     */
    private readonly projector?: PageProjector,
  ) {}

  async initialize(): Promise<'loaded' | 'reset-corrupt'> {
    try {
      this.derived = await this.derivedStore.load();
      return 'loaded';
    } catch {
      await this.derivedStore.clear();
      this.derived = emptyDerived();
      return 'reset-corrupt';
    }
  }

  async buildPage(
    notebooks: readonly LiveNotebookDocV2[],
    pageId: string,
    signal?: AbortSignal,
    options: BuildPageOptions = {},
  ): Promise<SearchPageSource> {
    if (signal?.aborted) throw new DOMException('Search projection cancelled.', 'AbortError');
    const projected = this.takeDeferred(pageId)
      ?? await this.projectInWorker(pageId)
      ?? await this.runtime.readPage(pageId, (document) => ({
        ...searchablePage(document),
        heads: getAutomergeHeads(document),
      }));
    const { page, pdfRequests, heads } = projected;
    const notebook = notebooks.find((candidate) => candidate.notebookId === page.notebookId);
    if (!notebook) throw new Error(`Search page ${page.documentId} has no notebook.`);
    const ocrTextByAssetId = new Map<string, string>();
    for (const element of Object.values(page.elementsById)) {
      for (const ref of assetRefs(element)) {
        const derived = this.derived.ocrByAssetId[ref.assetId];
        if (derived) ocrTextByAssetId.set(ref.assetId, derived.text);
      }
    }
    const source = buildSearchPageSource({ notebook, page, pageHeads: heads, ocrTextByAssetId });
    if (options.deferPdfText && pdfRequests.length > 0) {
      this.deferred.set(pageId, projected);
      return { ...source, pdfText: [], pdfTextPending: true };
    }
    // PDF text extraction is asynchronous, so it runs after the page was
    // released, from the asset references collected while reading it. A PDF
    // that cannot be read (damaged, password protected, its asset not here
    // yet) must not take the page's other text and printouts with it: the page
    // is indexed without that PDF and marked, so the next session tries again.
    const pdfText: string[] = [];
    let unreadable = false;
    for (const request of pdfRequests) {
      if (signal?.aborted) throw new DOMException('Search projection cancelled.', 'AbortError');
      let derived: PdfDerivedText;
      try {
        derived = await this.ensurePdfText(request.ref, signal);
      } catch (error) {
        if (signal?.aborted) throw error;
        unreadable = true;
        continue;
      }
      const text = request.sourcePageNumber ? derived.pages[request.sourcePageNumber - 1] : derived.pages.join('\n');
      if (text) pdfText.push(text);
    }
    return { ...source, pdfText, ...(unreadable ? { pdfTextPending: true as const } : {}) };
  }

  /** The page as read for an earlier deferred build, unless it changed since. */
  private takeDeferred(pageId: string): ProjectedPage | undefined {
    const cached = this.deferred.get(pageId);
    if (!cached) return undefined;
    this.deferred.delete(pageId);
    const current = this.runtime.getDocumentHeads?.(cached.page.documentId);
    if (!current || current.length !== cached.heads.length) return undefined;
    const held = new Set(cached.heads);
    return current.every((head) => held.has(head)) ? cached : undefined;
  }

  /**
   * A page that is not open is projected from its stored bytes in the
   * worker. Open pages are read in place (no load), and any worker failure
   * falls back to reading on the main thread.
   */
  private async projectInWorker(pageId: string): Promise<ProjectedPage | undefined> {
    const { projector, runtime } = this;
    if (!projector || !runtime.isPageLoaded || !runtime.getPageSummary || !runtime.readDocumentBytes) return undefined;
    if (runtime.isPageLoaded(pageId)) return undefined;
    const documentId = runtime.getPageSummary(pageId)?.documentId;
    if (!documentId) return undefined;
    try {
      return await projector.project(documentId, await runtime.readDocumentBytes(documentId));
    } catch {
      return undefined;
    }
  }

  async recognizePage(
    pageId: string,
    languageTag: string,
    signal?: AbortSignal,
  ): Promise<{ recognizedAssets: number; textCharacters: number }> {
    let candidates: Map<string, AssetRef>;
    try {
      candidates = await this.runtime.readPage(pageId, (document) => {
        const found = new Map<string, AssetRef>();
        for (const element of Object.values(document.elementsById)) {
          if (element.kind === 'image' && element.asset.mimeType.startsWith('image/')) {
            found.set(element.asset.assetId, { ...element.asset });
          }
          if (element.kind === 'pdf' && element.previewAsset.mimeType.startsWith('image/')) {
            found.set(element.previewAsset.assetId, { ...element.previewAsset });
          }
        }
        return found;
      });
    } catch {
      throw new Error('Die aktive Seite ist für OCR nicht verfügbar.');
    }
    if (candidates.size === 0) throw new Error('Diese Seite enthält kein lokales Bild und keine gerenderte Scan-Vorschau.');
    let textCharacters = 0;
    for (const ref of candidates.values()) {
      if (signal?.aborted) throw new DOMException('OCR cancelled.', 'AbortError');
      const asset = await this.assets.getAsset(ref.assetId);
      if (!asset) throw new Error(`OCR-Asset ${ref.assetId} fehlt.`);
      const result = await this.ocr.recognize(asset.bytes, languageTag, signal);
      this.derived.ocrByAssetId[ref.assetId] = {
        checksum: ref.assetId,
        languageTag: result.languageTag,
        engine: result.engine,
        text: result.text,
      };
      textCharacters += result.text.length;
    }
    await this.derivedStore.save(this.derived);
    return { recognizedAssets: candidates.size, textCharacters };
  }

  async diagnoseAsset(assetId: Sha256Checksum, languageTag?: string, signal?: AbortSignal): Promise<OcrRecognitionResult> {
    const asset = await this.assets.getAsset(assetId);
    if (!asset) throw new Error(`OCR diagnostic asset ${assetId} is unavailable.`);
    return this.ocr.recognize(asset.bytes, languageTag, signal);
  }

  private async ensurePdfText(ref: AssetRef, signal?: AbortSignal): Promise<PdfDerivedText> {
    const existing = this.derived.pdfByAssetId[ref.assetId];
    if (existing) return existing;
    const asset = await this.assets.getAsset(ref.assetId);
    if (!asset) throw new Error(`PDF asset ${ref.assetId} is unavailable for local indexing.`);
    if (signal?.aborted) throw new DOMException('PDF extraction cancelled.', 'AbortError');
    const inspected = await inspectPdf(asset.bytes);
    if (signal?.aborted) throw new DOMException('PDF extraction cancelled.', 'AbortError');
    const derived: PdfDerivedText = { checksum: ref.assetId, pages: inspected.pages.map((page) => page.text) };
    this.derived.pdfByAssetId[ref.assetId] = derived;
    await this.derivedStore.save(this.derived);
    return derived;
  }
}

/** Projection records kept in memory for searching and persisted one per page. */
export interface SearchProjectionBackend {
  open(): Promise<{ discarded: number }>;
  get(documentId: string): SearchProjectionRecord | undefined;
  values(): IterableIterator<SearchProjectionRecord>;
  readonly size: number;
  put(record: SearchProjectionRecord): Promise<void>;
  remove(documentId: string): Promise<void>;
  search(query: string, limit?: number): SearchResult[];
  /** Prepares stored records for searching for at most `sliceMs`; true when none is left. */
  warm(sliceMs: number): boolean;
}

/**
 * Searches in memory over persisted per-page records. On the desktop it also
 * keeps the native SQLite FTS table in step: rebuilt from the records when
 * the index opens, then updated record by record. The mirror is derived, so
 * a failed native write only schedules a resync.
 */
export class LocalProjectionBackend implements SearchProjectionBackend {
  private readonly index: RebuildableSearchIndex;
  private nativeQueue: Promise<void> = Promise.resolve();
  private nativeResyncQueued = false;

  constructor(adapter: SearchProjectionAdapter, private readonly native?: TauriSqliteSearchIndex) {
    this.index = new RebuildableSearchIndex(adapter);
  }

  async open(): Promise<{ discarded: number }> {
    const opened = await this.index.open();
    this.resyncNative();
    return opened;
  }

  get(documentId: string) { return this.index.get(documentId); }
  values() { return this.index.values(); }
  get size() { return this.index.size; }
  search(query: string, limit?: number) { return this.index.search(query, limit); }
  warm(sliceMs: number) { return this.index.warm(sliceMs); }

  async put(record: SearchProjectionRecord): Promise<void> {
    await this.index.put(record);
    this.mirror((native) => native.upsertRecord(record));
  }

  async remove(documentId: string): Promise<void> {
    await this.index.remove(documentId);
    this.mirror((native) => native.remove(documentId));
  }

  /** Resolves when queued native mirror writes, including resyncs they triggered, have finished. */
  async nativeSettled(): Promise<void> {
    let current: Promise<void>;
    do {
      current = this.nativeQueue;
      await current;
    } while (current !== this.nativeQueue);
  }

  private mirror(task: (native: TauriSqliteSearchIndex) => Promise<void>): void {
    const native = this.native;
    if (!native) return;
    this.nativeQueue = this.nativeQueue.then(() => task(native)).catch(() => this.resyncNative());
  }

  /** Clears the native table and writes the records one at a time, so no single IPC payload holds the whole index. */
  private resyncNative(): void {
    const native = this.native;
    if (!native || this.nativeResyncQueued) return;
    this.nativeResyncQueued = true;
    this.nativeQueue = this.nativeQueue.then(async () => {
      this.nativeResyncQueued = false;
      await native.clear();
      for (const documentId of [...this.index.values()].map((record) => record.documentId)) {
        const record = this.index.get(documentId);
        if (record) await native.upsertRecord(record);
      }
    }).catch(() => undefined);
  }
}

function projectionTags(record: SearchProjectionRecord): string[] {
  return record.fields.tags.split(/\s+/u).filter(Boolean);
}

/**
 * Folds the dropdown filters into the same `tag:`/`is:` syntax the query bar
 * accepts. An empty result means nothing was asked for, which stays an empty
 * result list rather than the whole workspace.
 */
function composeSearchQuery(query: string, filters: SearchFilters): string {
  return [
    query.trim(),
    filters.taskState ? `is:${filters.taskState}` : '',
    filters.tag ? `tag:${filters.tag}` : '',
  ].filter(Boolean).join(' ');
}

/** Filters that cut the ranked matches down by where a page lives. */
function hasLocationFilter(filters: SearchFilters): boolean {
  return Boolean(
    filters.notebookId || filters.sectionId || filters.pageId
    || filters.notebookIds?.length || filters.sectionIds?.length
    || filters.excludeSectionIds?.size,
  );
}

function inLocation(
  filters: SearchFilters,
  record: { notebookId: string; sectionId: string; pageId: string },
): boolean {
  if (filters.notebookId && record.notebookId !== filters.notebookId) return false;
  if (filters.sectionId && record.sectionId !== filters.sectionId) return false;
  if (filters.pageId && record.pageId !== filters.pageId) return false;
  if (filters.notebookIds?.length && !filters.notebookIds.includes(record.notebookId)) return false;
  if (filters.sectionIds?.length && !filters.sectionIds.includes(record.sectionId)) return false;
  return !filters.excludeSectionIds?.has(record.sectionId);
}

function badges(fields: readonly SearchField[]): SearchSourceBadge[] {
  const output = new Set<SearchSourceBadge>();
  fields.forEach((field) => {
    if (field === 'pageTitle' || field === 'notebookTitle' || field === 'sectionTitle') output.add('title');
    else if (field === 'tags') output.add('tag');
    else if (field === 'checkItems') output.add('checklist');
    else if (field === 'pdfText') output.add('pdf');
    else if (field === 'ocrText') output.add('ocr');
    else output.add('text');
  });
  return [...output];
}

export interface WorkspaceSearchControllerOptions {
  backend?: SearchProjectionBackend;
  sourceBuilder?: SearchSourceBuilder;
  ocrAdapter?: OcrAdapter;
  derivedStore?: DerivedTextStore;
  /** Quiet time before a changed page is projected again. */
  liveUpdateDelayMs?: number;
  /** Projects pages that are not open off the main thread; defaults to a worker where available. */
  pageProjector?: PageProjector | null;
}

/**
 * A background pass checks pages one at a time: `startup` after opening,
 * `rebuild` when asked to re-project everything, `check` for pages that
 * reconciliation or a burst of changes marked.
 */
interface BackgroundPass {
  kind: 'startup' | 'rebuild' | 'check';
  total: number;
  done: number;
  projected: number;
  failed: number;
  firstError?: unknown;
}

type SearchRuntimePort = Pick<
  WorkspaceV2Runtime,
  'readPage' | 'getDocumentHeads' | 'subscribeToDocumentChanges' | 'subscribeToState' | 'getState' | 'getAsset'
> & Partial<Pick<WorkspaceV2Runtime, 'isPageLoaded' | 'getPageSummary' | 'readDocumentBytes' | 'isDocumentAvailable'>>;

/**
 * Keeps the local search index in step with the workspace without holding
 * page documents: records are persisted per page with the heads they were
 * projected from, stale pages are re-read one at a time through
 * `runtime.readPage`, and every write goes through one sequential worker.
 */
export class WorkspaceSearchController {
  private readonly listeners = new Set<(snapshot: SearchRuntimeSnapshot) => void>();
  private readonly backend: SearchProjectionBackend;
  private readonly builder: SearchSourceBuilder;
  private readonly ocrAdapter: OcrAdapter;
  private readonly liveUpdateDelayMs: number;
  private readonly projector?: PageProjector;
  private snapshotState: SearchRuntimeSnapshot = {
    phase: 'idle', message: 'Lokaler Suchindex ist noch nicht geöffnet.', recordCount: 0, rebuiltBecauseCorrupt: false, revision: 0,
  };
  private workspace?: V2RuntimeState;
  private pagesByDocumentId = new Map<string, PageSummary>();
  private notebooksById = new Map<string, LiveNotebookDocV2>();
  /** Pages changed live, projected after a quiet period. */
  private readonly pending = new Set<string>();
  private liveDue = false;
  private liveTimer?: ReturnType<typeof setTimeout>;
  private warmTimer?: ReturnType<typeof setTimeout>;
  private liveFirstChangeAt?: number;
  /** Pages a background pass still has to check, in order. */
  private readonly backlog = new Set<string>();
  /** Pages an explicit rebuild re-projects even when their record is current. */
  private readonly forced = new Set<string>();
  /**
   * Pages that are searchable but whose PDF printouts are not read yet. They
   * follow once the backlog is empty, so every page's own text is searchable
   * long before the slowest part of indexing is done.
   */
  private readonly pdfBacklog = new Set<string>();
  private readonly removals = new Set<string>();
  /**
   * Heads each page had when it was last read, also when the read failed or
   * produced a record under other heads. Reconciliation treats such a page as
   * checked, so a page that cannot be projected is not read again on every
   * state change; any new change moves its heads and queues it again.
   */
  private readonly checkedHeads = new Map<string, string>();
  private titlesDirty = false;
  private pass?: BackgroundPass;
  private working = false;
  private writeChain: Promise<unknown> = Promise.resolve();
  private idleWaiters: Array<() => void> = [];
  private lastProgressPublish = 0;
  private detach?: () => void;
  private initialized = false;
  private initializing?: Promise<void>;
  private active = false;

  constructor(private readonly runtime: SearchRuntimePort, options: WorkspaceSearchControllerOptions = {}) {
    const tauri = typeof window !== 'undefined' && typeof window.__TAURI_INTERNALS__ !== 'undefined';
    this.ocrAdapter = options.ocrAdapter
      ?? (typeof window !== 'undefined' ? window.__CANVINK_LOCAL_OCR_TEST_ADAPTER__ : undefined)
      ?? (tauri ? new TauriWindowsOcrAdapter() : new UnsupportedBrowserOcrAdapter());
    this.backend = options.backend
      ?? new LocalProjectionBackend(new IndexedDbSearchAdapter(), tauri ? new TauriSqliteSearchIndex() : undefined);
    this.projector = options.sourceBuilder ? undefined : (options.pageProjector === null ? undefined : options.pageProjector ?? createDefaultPageProjector());
    this.builder = options.sourceBuilder ?? new RuntimeSearchSourceBuilder(
      runtime,
      { getAsset: (assetId) => runtime.getAsset(assetId), putAsset: async () => { throw new Error('Search cannot write assets.'); } },
      options.derivedStore ?? new IndexedDbDerivedTextStore(),
      new OcrQueue(this.ocrAdapter),
      this.projector,
    );
    this.liveUpdateDelayMs = Math.max(0, options.liveUpdateDelayMs ?? LIVE_UPDATE_DELAY_MS);
  }

  getSnapshot(): SearchRuntimeSnapshot { return structuredClone(this.snapshotState); }
  subscribe(listener: (snapshot: SearchRuntimeSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => this.listeners.delete(listener);
  }

  /**
   * Opens the persisted records and returns as soon as the current ones are
   * searchable. Pages without a current record are projected afterwards in
   * the background; `whenIdle` resolves when that work is done.
   */
  initialize(workspace: V2RuntimeState): Promise<void> {
    this.active = true;
    if (this.initialized) {
      this.updateWorkspace(workspace);
      this.attach();
      this.kick();
      return Promise.resolve();
    }
    this.acceptWorkspace(workspace);
    if (this.initializing) return this.initializing;
    const initialization = this.initializeOnce();
    this.initializing = initialization;
    return initialization.finally(() => {
      if (this.initializing === initialization) this.initializing = undefined;
    });
  }

  private async initializeOnce(): Promise<void> {
    this.publish({ phase: 'opening', message: 'Lokaler Suchindex wird geprüft.', error: undefined });
    try {
      const derivedStatus = await this.builder.initialize();
      const { discarded } = await this.backend.open();
      this.initialized = true;
      const stale = this.reconcile(true);
      if (stale > 0 || this.pdfBacklog.size > 0) this.startPass('startup');
      this.publish({
        ...(this.pass
          ? { phase: 'rebuilding' as const, message: 'Lokaler Suchindex wird geprüft.', progress: this.progressOf(this.pass) }
          : { phase: 'ready' as const, message: 'Lokaler Suchindex ist bereit.', progress: undefined }),
        recordCount: this.backend.size,
        rebuiltBecauseCorrupt: derivedStatus === 'reset-corrupt' || discarded > 0,
        error: undefined,
      });
      // React StrictMode intentionally tears down and re-runs effects while an
      // asynchronous open is in flight. Only attach live resources when a UI
      // subscriber still owns this controller; a second setup coalesces onto
      // the same initialization promise.
      if (this.active) {
        this.attach();
        this.installDiagnosticHook();
        this.kick();
        this.scheduleWarm();
      }
    } catch (error) {
      this.publish({ phase: 'error', message: 'Lokaler Suchindex konnte nicht geöffnet werden.', error: errorMessage(error) });
    }
  }

  /**
   * Reconciles page additions, removals and notebook or section titles from
   * page summaries. It never reads a page; stale pages are queued for the
   * worker.
   */
  updateWorkspace(workspace: V2RuntimeState): void {
    if (workspace === this.workspace) return;
    this.acceptWorkspace(workspace);
    if (!this.initialized) return;
    if (this.reconcile(false) > 0 && !this.pass) this.startPass('check');
    this.kick();
  }

  /** Re-projects every page, one at a time. Resolves when the pass ends. */
  async rebuild(): Promise<void> {
    if (!this.initialized) return;
    this.reconcile(false);
    for (const documentId of this.pagesByDocumentId.keys()) {
      this.backlog.add(documentId);
      this.forced.add(documentId);
    }
    this.pass = { kind: 'rebuild', total: this.backlog.size, done: 0, projected: 0, failed: 0 };
    this.publish({
      phase: 'rebuilding',
      message: 'Suchindex wird vollständig neu aufgebaut.',
      progress: { done: 0, total: this.pass.total },
      error: undefined,
    });
    this.kick();
    await this.whenIdle();
  }

  /** Stops the current background pass after the page being read. */
  cancelRebuild(): void {
    if (!this.pass) return;
    this.backlog.clear();
    this.forced.clear();
    this.pdfBacklog.clear();
    this.pass = undefined;
    this.publish({ phase: 'ready', message: 'Neuaufbau des Suchindex wurde abgebrochen.', progress: undefined, error: undefined });
  }

  /** Resolves once no page is waiting to be projected. */
  whenIdle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise((resolve) => { this.idleWaiters.push(resolve); });
  }

  search(query: string, filters: SearchFilters = {}): SearchUiResult[] {
    const composed = composeSearchQuery(query, filters);
    if (!composed) return [];
    // The query bar renders this inside a React useMemo, so a thrown
    // SearchLimitError would unwind the whole tree. An over-long or over-tagged
    // query must degrade to no matches; describeQueryLimit explains why.
    let matches: SearchResult[];
    try {
      // Location filters cut the ranked list afterwards, so a scoped search
      // ranks deeper to still fill the list.
      matches = this.backend.search(composed, hasLocationFilter(filters) ? SCOPED_RESULT_LIMIT : RESULT_LIMIT);
    } catch (error) {
      if (error instanceof SearchLimitError) return [];
      throw error;
    }
    return matches.flatMap((result) => {
      const record = this.backend.get(result.documentId);
      if (!record) return [];
      const sourceBadges = badges(result.matchedFields);
      if (!inLocation(filters, record) || (filters.source && !sourceBadges.includes(filters.source))) return [];
      return [{
        ...result,
        sectionId: record.sectionId,
        notebookTitle: record.fields.notebookTitle,
        sectionTitle: record.fields.sectionTitle,
        sourceBadges,
        tags: projectionTags(record),
        ...(record.taskState ? { taskState: record.taskState } : {}),
      }];
    });
  }

  /**
   * Non-throwing probe of the query limits, for a soft inline hint. Returns the
   * limit message when the composed query would be rejected, otherwise null.
   */
  describeQueryLimit(query: string, filters: SearchFilters = {}): string | null {
    const composed = composeSearchQuery(query, filters);
    if (!composed) return null;
    try {
      this.backend.search(composed, 1);
      return null;
    } catch (error) {
      if (error instanceof SearchLimitError) return error.message;
      throw error;
    }
  }

  /**
   * Cross-page review of every page marked as a task. It reuses the same
   * operator engine as the query bar, so a typed `is:open` and the review list
   * can never disagree about which pages are open.
   */
  taskReview(filters: SearchFilters = {}): SearchUiResult[] {
    return this.search(filters.taskState ? '' : 'is:task', filters);
  }

  /** Tags currently present in the local index, for the tag filter control. */
  availableTags(): string[] {
    const tags = new Set<string>();
    for (const record of this.backend.values()) {
      for (const tag of projectionTags(record)) tags.add(tag);
    }
    return [...tags].sort((left, right) => left.localeCompare(right));
  }

  availableLanguages(): Promise<string[]> { return this.ocrAdapter.availableLanguages(); }

  async recognizePage(pageId: string, languageTag: string, signal?: AbortSignal): Promise<void> {
    if (!this.initialized) return;
    this.publish({ phase: 'ocr', message: 'Lokale Windows-OCR läuft. Es werden keine Bilddaten hochgeladen.', error: undefined });
    try {
      await this.builder.recognizePage(pageId, languageTag, signal);
      const summary = [...this.pagesByDocumentId.values()].find((candidate) => candidate.pageId === pageId);
      if (summary) await this.exclusive(() => this.refresh(summary.documentId, true));
      this.publish({ phase: 'ready', message: 'OCR-Text wurde lokal erkannt und indexiert.', recordCount: this.backend.size, error: undefined });
    } catch (error) {
      if (error instanceof OcrCancelledError || (error instanceof DOMException && error.name === 'AbortError')) {
        this.publish({ phase: 'ready', message: 'Lokale OCR wurde abgebrochen.', error: undefined });
        throw error;
      }
      this.publish({ phase: 'error', message: 'Lokale OCR ist fehlgeschlagen.', error: errorMessage(error) });
      throw error;
    }
  }

  dispose(): void {
    this.active = false;
    if (this.liveTimer !== undefined) clearTimeout(this.liveTimer);
    this.liveTimer = undefined;
    if (this.warmTimer !== undefined) clearTimeout(this.warmTimer);
    this.warmTimer = undefined;
    this.liveFirstChangeAt = undefined;
    // Changes that arrived before a StrictMode re-setup are processed when
    // the controller is initialized again.
    this.liveDue = this.pending.size > 0;
    this.detach?.();
    this.detach = undefined;
    this.projector?.dispose();
    this.listeners.clear();
    this.resolveIdleWaiters();
    if (typeof window !== 'undefined') delete window.__CANVINK_LOCAL_OCR_DIAGNOSTIC__;
  }

  /** Prepares the stored records for searching a few at a time, so the first query does not have to. */
  private scheduleWarm(): void {
    if (this.warmTimer !== undefined) return;
    this.warmTimer = setTimeout(() => {
      this.warmTimer = undefined;
      if (!this.active || this.backend.warm(WARM_SLICE_MS)) return;
      this.scheduleWarm();
    }, 0);
  }

  private acceptWorkspace(workspace: V2RuntimeState): void {
    const notebooksChanged = workspace.notebooks !== this.workspace?.notebooks;
    this.workspace = workspace;
    this.pagesByDocumentId = new Map(workspace.pages.map((page) => [page.documentId, page]));
    if (notebooksChanged) {
      this.notebooksById = new Map(workspace.notebooks.map((notebook) => [notebook.notebookId, notebook]));
      this.titlesDirty = true;
    }
  }

  /**
   * Queues removed pages for deletion and pages without a current record for
   * the worker. Returns how many pages were newly queued for projection.
   */
  private reconcile(includeTitles: boolean): number {
    if (includeTitles) this.titlesDirty = true;
    for (const record of this.backend.values()) {
      if (!this.pagesByDocumentId.has(record.documentId)) this.removals.add(record.documentId);
    }
    let queued = 0;
    for (const documentId of this.pagesByDocumentId.keys()) {
      if (this.pending.has(documentId) || this.backlog.has(documentId)) continue;
      // A page the device lists but has not downloaded is indexed once it arrives (its
      // `added` event queues it); reading it now would download every page one by one.
      if (this.runtime.isDocumentAvailable && !this.runtime.isDocumentAvailable(documentId)) continue;
      if (this.isFresh(documentId)) {
        if (this.awaitsPdfText(documentId)) this.pdfBacklog.add(documentId);
        continue;
      }
      this.backlog.add(documentId);
      queued += 1;
    }
    if (this.pass && queued > 0) this.pass.total += queued;
    this.prioritizeBacklog();
    return queued;
  }

  /**
   * Puts the page being viewed first in the backlog, then the pages of its
   * section, then those of its notebook: a search typed while a long pass
   * runs finds what the user is working on before anything else.
   */
  private prioritizeBacklog(): void {
    const active = this.workspace?.active;
    if (!active || this.backlog.size < 2) return;
    const rank = (documentId: string): number => {
      const page = this.pagesByDocumentId.get(documentId);
      if (page?.pageId === active.pageId) return 0;
      if (page?.sectionId === active.sectionId) return 1;
      if (page?.notebookId === active.notebookId) return 2;
      return 3;
    };
    const ordered = [...this.backlog].sort((left, right) => rank(left) - rank(right));
    this.backlog.clear();
    for (const documentId of ordered) this.backlog.add(documentId);
  }

  /** The page's record is current except for PDF text that no attempt has read yet in this session. */
  private awaitsPdfText(documentId: string): boolean {
    const record = this.backend.get(documentId);
    if (!record?.pdfTextPending) return false;
    const heads = this.runtime.getDocumentHeads(documentId);
    return heads !== undefined && projectedFromHeads(record, heads) && this.checkedHeads.get(documentId) !== headsKey(heads);
  }

  private isFresh(documentId: string): boolean {
    const heads = this.runtime.getDocumentHeads(documentId);
    const record = this.backend.get(documentId);
    if (record !== undefined && projectedFromHeads(record, heads)) return true;
    return heads !== undefined && this.checkedHeads.get(documentId) === headsKey(heads);
  }

  private startPass(kind: BackgroundPass['kind']): void {
    const pass: BackgroundPass = { kind, total: this.backlog.size, done: 0, projected: 0, failed: 0 };
    this.pass = pass;
    // A pass a user could wait for (after an import or a migration) shows
    // its progress from the start, so a search meanwhile is marked incomplete.
    if (this.initialized && (kind !== 'check' || pass.total >= LARGE_CHECK_PASS)) {
      this.publish({
        phase: 'rebuilding',
        message: kind === 'rebuild' ? 'Suchindex wird vollständig neu aufgebaut.' : 'Lokaler Suchindex wird geprüft.',
        progress: this.progressOf(pass),
      });
    }
  }

  private attach(): void {
    if (this.detach) return;
    const stopDocuments = this.runtime.subscribeToDocumentChanges((event) => this.onDocumentChange(event));
    const stopState = this.runtime.subscribeToState((state) => {
      if (state.schemaVersion !== 1) this.updateWorkspace(state);
    });
    this.detach = () => { stopDocuments(); stopState(); };
    try {
      const state = this.runtime.getState();
      if (state.schemaVersion !== 1) this.updateWorkspace(state);
    } catch {
      // The runtime is not open; the state subscription reconciles later.
    }
  }

  private onDocumentChange(event: DocumentChangeEvent): void {
    if (!this.active || !this.initialized) return;
    if (event.kind === 'notebook') {
      this.titlesDirty = true;
      this.scheduleLive();
      return;
    }
    const { documentId } = event;
    if (this.pending.has(documentId)) {
      this.scheduleLive();
      return;
    }
    // A page the running pass has not reached yet is checked by its heads then.
    if (this.backlog.has(documentId)) return;
    if (this.pending.size >= MAX_PENDING_UPDATES) {
      // Too many distinct pages changed at once (an import, a sync burst).
      // Check every page instead, still one at a time; current records are
      // recognised by their heads and skipped.
      for (const pendingId of this.pending) this.backlog.add(pendingId);
      this.pending.clear();
      this.backlog.add(documentId);
      this.reconcile(false);
      if (!this.pass) this.startPass('check');
      this.kick();
      return;
    }
    this.pending.add(documentId);
    this.scheduleLive();
  }

  /** Debounces live changes: projection starts after a quiet period, but never later than the maximum delay. */
  private scheduleLive(): void {
    const now = Date.now();
    this.liveFirstChangeAt ??= now;
    if (this.liveTimer !== undefined) clearTimeout(this.liveTimer);
    const delay = Math.max(0, Math.min(this.liveUpdateDelayMs, this.liveFirstChangeAt + LIVE_UPDATE_MAX_DELAY_MS - now));
    this.liveTimer = setTimeout(() => {
      this.liveTimer = undefined;
      this.liveFirstChangeAt = undefined;
      this.liveDue = true;
      this.kick();
    }, delay);
  }

  private hasReadyWork(): boolean {
    return this.removals.size > 0
      || this.titlesDirty
      || (this.liveDue && this.pending.size > 0)
      || this.backlog.size > 0
      || this.pdfBacklog.size > 0;
  }

  private isIdle(): boolean {
    return !this.working && !this.hasReadyWork() && this.pending.size === 0;
  }

  private kick(): void {
    if (this.working || !this.active || !this.initialized) return;
    if (!this.hasReadyWork()) {
      if (this.isIdle()) this.resolveIdleWaiters();
      return;
    }
    this.working = true;
    void this.work().finally(() => {
      this.working = false;
      if (this.active && this.hasReadyWork()) this.kick();
      else if (this.isIdle() || !this.active) this.resolveIdleWaiters();
    });
  }

  private resolveIdleWaiters(): void {
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    waiters.forEach((resolve) => resolve());
  }

  /** Serialises index writes between the worker and explicit OCR updates. */
  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.writeChain.then(task, task);
    this.writeChain = run.catch(() => undefined);
    return run;
  }

  private async work(): Promise<void> {
    let liveProjected = 0;
    let liveError: unknown;
    let titlesPatched = 0;
    let removed = 0;
    while (this.active) {
      try {
        const removal = first(this.removals);
        if (removal !== undefined) {
          this.removals.delete(removal);
          if (!this.pagesByDocumentId.has(removal) && this.backend.get(removal)) {
            await this.exclusive(() => this.backend.remove(removal));
            removed += 1;
          }
          continue;
        }
        if (this.titlesDirty) {
          this.titlesDirty = false;
          titlesPatched += await this.exclusive(() => this.patchTitles());
          continue;
        }
        const live = this.liveDue ? first(this.pending) : undefined;
        if (live !== undefined) {
          this.pending.delete(live);
          if (this.pending.size === 0) this.liveDue = false;
          try {
            if (await this.exclusive(() => this.refresh(live, false))) liveProjected += 1;
          } catch (error) {
            liveError ??= error;
          }
          continue;
        }
        if (this.pending.size === 0) this.liveDue = false;
        const next = first(this.backlog);
        if (next === undefined) {
          const withPdf = first(this.pdfBacklog);
          if (withPdf === undefined) break;
          this.pdfBacklog.delete(withPdf);
          const pass = this.pass;
          try {
            await this.exclusive(() => this.completePdfText(withPdf));
          } catch (error) {
            if (pass) {
              pass.failed += 1;
              pass.firstError ??= error;
            } else liveError ??= error;
          }
          if (pass && this.pass === pass) this.publishProgress(pass);
          await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
          continue;
        }
        this.backlog.delete(next);
        const force = this.forced.delete(next);
        const pass = this.pass;
        try {
          const projected = await this.exclusive(() => this.refresh(next, force, true));
          if (pass && projected) pass.projected += 1;
        } catch (error) {
          if (pass) {
            pass.failed += 1;
            pass.firstError ??= error;
          } else liveError ??= error;
        }
        if (pass && this.pass === pass) {
          pass.done += 1;
          this.publishProgress(pass);
        }
        // Let rendering and input run between pages of a long pass.
        await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
      } catch (error) {
        liveError ??= error;
      }
    }
    if (!this.active) return;
    if (this.pass && this.backlog.size === 0) this.finishPass(this.pass, liveError);
    else if (liveError !== undefined) {
      this.publish({ phase: 'error', message: 'Inkrementelle Suchaktualisierung ist fehlgeschlagen.', recordCount: this.backend.size, error: errorMessage(liveError) });
    } else if (!this.pass && liveProjected + titlesPatched + removed > 0 && this.snapshotState.phase !== 'ocr') {
      this.publish({ phase: 'ready', message: 'Suchindex ist aktuell.', recordCount: this.backend.size, progress: undefined, error: undefined });
    }
  }

  private finishPass(pass: BackgroundPass, liveError: unknown): void {
    this.pass = undefined;
    const failure = pass.firstError ?? liveError;
    if (failure !== undefined) {
      this.publish({
        phase: 'error',
        message: pass.kind === 'rebuild' ? 'Neuaufbau des Suchindex ist fehlgeschlagen.' : 'Inkrementelle Suchaktualisierung ist fehlgeschlagen.',
        recordCount: this.backend.size,
        progress: undefined,
        error: errorMessage(failure),
      });
      return;
    }
    const message = pass.kind === 'rebuild'
      ? 'Suchindex wurde neu aufgebaut.'
      : pass.kind === 'startup' && pass.projected === 0 ? 'Lokaler Suchindex ist bereit.' : 'Suchindex ist aktuell.';
    this.publish({ phase: 'ready', message, recordCount: this.backend.size, progress: undefined, error: undefined });
  }

  private publishProgress(pass: BackgroundPass): void {
    const now = Date.now();
    if (now - this.lastProgressPublish < PROGRESS_PUBLISH_INTERVAL_MS) return;
    this.lastProgressPublish = now;
    // Small reconciliation passes stay quiet; only passes a user would wait for show progress.
    if (pass.kind === 'check' && pass.total < LARGE_CHECK_PASS) {
      this.publish({ recordCount: this.backend.size });
      return;
    }
    this.publish({
      phase: 'rebuilding',
      message: pass.kind === 'rebuild' ? 'Suchindex wird vollständig neu aufgebaut.' : 'Lokaler Suchindex wird geprüft.',
      recordCount: this.backend.size,
      progress: this.progressOf(pass),
    });
  }

  private progressOf(pass: BackgroundPass): SearchIndexProgress {
    return {
      done: pass.done,
      total: pass.total,
      ...(this.pdfBacklog.size > 0 ? { pdfPending: this.pdfBacklog.size } : {}),
    };
  }

  /** Reads the PDF printouts of a page whose record was written without them. */
  private async completePdfText(documentId: string): Promise<void> {
    const record = this.backend.get(documentId);
    if (!record?.pdfTextPending || !this.pagesByDocumentId.has(documentId)) return;
    // A page that changed since is read again, complete, by the path that noticed the change.
    if (!projectedFromHeads(record, this.runtime.getDocumentHeads(documentId))) return;
    await this.refresh(documentId, true, false);
  }

  /**
   * Brings one page's record up to date. Returns whether the page was read.
   * A page that no longer exists loses its record; a record projected from
   * the current heads is kept unless `force` is set. With `deferPdf` the
   * page's PDF printouts are read later (see `pdfBacklog`).
   */
  private async refresh(documentId: string, force: boolean, deferPdf = false): Promise<boolean> {
    const summary = this.pagesByDocumentId.get(documentId);
    if (!summary) {
      this.checkedHeads.delete(documentId);
      if (this.backend.get(documentId)) await this.backend.remove(documentId);
      return false;
    }
    if (!force && this.isFresh(documentId)) return false;
    const heads = this.runtime.getDocumentHeads(documentId);
    if (heads) this.checkedHeads.set(documentId, headsKey(heads));
    const source = await this.builder.buildPage([...this.notebooksById.values()], summary.pageId, undefined, { deferPdfText: deferPdf });
    // The page may have been removed while it was read.
    if (!this.pagesByDocumentId.has(documentId)) return true;
    await this.backend.put(projectSearchPage(source));
    // A record marked because a PDF was unreadable is tried again at the next
    // start; queueing it now would read the same PDF again and again.
    if (source.pdfTextPending && deferPdf) this.pdfBacklog.add(documentId);
    return true;
  }

  private async patchTitles(): Promise<number> {
    let patched = 0;
    for (const record of [...this.backend.values()]) {
      const notebook = this.notebooksById.get(record.notebookId);
      if (!notebook) continue;
      const section = notebook.sections.find((candidate) => candidate.id === record.sectionId);
      const next = withLocationTitles(record, notebook.title, section?.title ?? '');
      if (next === record) continue;
      await this.backend.put(next);
      patched += 1;
    }
    return patched;
  }

  private publish(update: Partial<SearchRuntimeSnapshot>): void {
    const next = { ...this.snapshotState, ...update, revision: this.snapshotState.revision + 1 };
    if (next.progress === undefined) delete next.progress;
    if (next.error === undefined) delete next.error;
    this.snapshotState = next;
    this.listeners.forEach((listener) => listener(this.getSnapshot()));
  }

  private installDiagnosticHook(): void {
    if (typeof window === 'undefined') return;
    window.__CANVINK_LOCAL_OCR_DIAGNOSTIC__ = async ({ assetId, languageTag }) => {
      const result = await this.builder.diagnoseAsset(assetId as Sha256Checksum, languageTag);
      return { engine: result.engine, languageTag: result.languageTag, text: result.text, lines: result.lines.length };
    };
  }
}

function headsKey(heads: readonly string[]): string {
  return [...heads].sort().join(',');
}

function first<T>(values: Set<T>): T | undefined {
  const next = values.values().next();
  return next.done ? undefined : next.value;
}

function errorMessage(error: unknown): string {
  if (error instanceof OcrBackpressureError) return 'Die lokale OCR-Warteschlange ist voll. Warte kurz und versuche es erneut.';
  if (error instanceof OcrCancelledError || (error instanceof DOMException && error.name === 'AbortError')) return 'Der lokale Vorgang wurde abgebrochen.';
  if (error instanceof RangeError) return 'Ein lokales Grössen- oder Mengenlimit wurde überschritten.';
  if (error instanceof TypeError) return 'Das lokale Bild- oder Indexformat wird nicht unterstützt.';
  return 'Die lokale Projektion konnte nicht verarbeitet werden. Quelldokumente wurden nicht verändert.';
}

declare global {
  interface Window {
    __CANVINK_LOCAL_OCR_DIAGNOSTIC__?: (input: { assetId: string; languageTag?: string }) => Promise<{
      engine: string; languageTag: string; text: string; lines: number;
    }>;
    /** Explicit automated-acceptance seam. Normal builds never assign it. */
    __CANVINK_LOCAL_OCR_TEST_ADAPTER__?: OcrAdapter;
  }
}
