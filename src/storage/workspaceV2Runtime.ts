import {
  Repo,
  type AutomergeUrl,
  type DocHandle,
  type DocumentId,
} from '@automerge/automerge-repo';
import * as Automerge from '@automerge/automerge';
import { readSavedDocumentHeads } from '../crdt/documentHeads';
import { pendingInk } from '../ink/pendingInk';
import { referencedInkSegments, type PlainInkPage } from '../ink/projection';
import { compactPageInk, sealPendingInk, sealProjection, type InkPageTarget } from '../ink/seal';
import { inkSegments, isInkSegmentHash } from '../ink/segmentStore';
import { sharedPlainSnapshot } from '../crdt/sharedSnapshot';
import { prepareAdoptedDocuments } from './adoptionPrep';
import {
  WorkerAutomergeMigrationMaterializer,
  WorkerAutomergeRepoMigrationAdapter,
  stageSchemaV3UpgradeInWorker,
} from './automergeTaskClient';
import type { ChangeFn } from '@automerge/automerge';
import {
  assertCanvinkAutomergeDocument,
  createAutomergeDocument,
  createAutomergeDocumentV3,
  documentHasHeads,
  getAutomergeHeads,
  getSharedAutomergeSnapshot,
  loadAutomergeDocument,
  saveAutomergeDocument,
  type CanvinkAutomergeDoc,
  type LiveCanvinkDocumentV2,
  type LiveNotebookDocV2,
  type LivePageDocV2,
  type PageAutomergeDoc,
} from '../crdt';
import {
  CanvinkStorageAdapter,
  type CanvinkStorageAdapterOptions,
  type CanvinkStorageBridge,
  type CanvinkStorageMutation,
} from '../crdt/canvinkStorageAdapter';
import type { WorkspaceState } from '../domain/types';
import { assertWorkspaceShape } from '../domain/validation';
import type {
  AssetBlob,
  MigrationManifestV2,
  NotebookDoc,
  NotebookSectionRef,
  PageDoc,
  Sha256Checksum,
} from '../domain/v2';
import { sha256Bytes, sha256Canonical } from '../domain/v2';
import {
  assertV3ManifestMathData,
  upgradeManifestV2ToV3,
  type CanvinkDocument,
  type NotebookDocV3,
  type PageDocV3,
  type WorkspaceManifest,
  type WorkspaceManifestV3,
} from '../domain/v3';
import {
  BrowserV2WorkspaceActivationStore,
  createBrowserV2WorkspaceMigrationOrchestrator,
  type ActivatedDocumentV2,
  type MigrationProgress,
  type RepoChunkDescriptorV2,
  type V1BackupRecord,
  type V1WorkspaceMigrationSource,
  type V2ActivationRecord,
  type V2WorkspaceMigrationOrchestrator,
  type V2WorkspaceActivationStore,
  type V2WorkspaceImportReceipt,
  type WorkspaceStorageEntry,
} from './v2WorkspaceStorage';
import {
  acquireWorkspaceWriteAccess,
  hasTauriRuntime,
  loadWorkspace,
  type StorageBackend,
} from './workspaceStorage';
import { loadRecoveryDraft } from './recoveryJournal';
import { assertDocumentWritable, isDocumentReadOnly } from './readOnlyDocuments';
import { SerialTaskQueue } from './serialTaskQueue';
import {
  TauriCanvinkStorageBridge,
  TauriV2WorkspaceActivationStore,
  createTauriV2WorkspaceMigrationOrchestrator,
  type TauriInvoke,
} from './tauriV2WorkspaceStorage';
import {
  DIRTY_NAMESPACE,
  PAGE_INDEX_NAMESPACE,
  PAGE_INDEX_VERSION,
  decodePageIndexEntry,
  encodePageIndexEntry,
  sameHeadSet,
  samePageSummary,
  summarizePage,
  summarizePageDocument,
  type PageIndexEntry,
  type PageSummary,
} from './pageIndex';
import {
  REPO_NAMESPACE,
  chunkHash,
  freeDocument,
  headsHash,
  loadDocumentFromStorage,
  newDocumentUrl,
  randomActorId,
  isValidDocumentUrl,
  storageIdOfUrl,
  type WorkspaceDocumentStorage,
} from './workspaceDocuments';

export type { PageSummary } from './pageIndex';

export type WorkspaceV2RecoveryCode =
  | 'activation-unreadable'
  | 'activation-invalid'
  | 'committed-payload-corrupt'
  | 'document-unavailable'
  | 'document-invalid';

/** A page is listed but its document could not be downloaded (offline, or the account no longer has it). */
export class PageNotDownloadedError extends Error {
  constructor(readonly documentId: string, message: string) {
    super(message);
    this.name = 'PageNotDownloadedError';
  }
}

/** Provides the documents of placeholder pages; `request` starts fetching one and a later commit adopts it. */
export interface DocumentContentSource {
  request(documentId: string): void;
}

/** How long a read waits for a placeholder page to be downloaded before it fails. */
const CONTENT_WAIT_MS = 45_000;

export class WorkspaceV2RecoveryRequiredError extends Error {
  constructor(
    public readonly code: WorkspaceV2RecoveryCode,
    message: string,
    options: { cause?: unknown; activation?: V2ActivationRecord } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'WorkspaceV2RecoveryRequiredError';
    this.activation = options.activation ? structuredClone(options.activation) : undefined;
  }

  readonly activation?: V2ActivationRecord;
}

export interface PersistentRepoSession {
  repo: Repo;
  /**
   * Direct access to the Repo's storage for pages that are not loaded, the
   * derived page index, and atomic chunk plus index writes.
   */
  storage: WorkspaceDocumentStorage;
  /** Complete logical Repo image after `repo.flush()`. Only the legacy schema-v2 upgrade needs it. */
  readChunks?: () => Promise<Array<{ key: string[]; bytes: Uint8Array }>>;
  close?: () => void | Promise<void>;
}

export type PersistentRepoFactory = () => PersistentRepoSession | Promise<PersistentRepoSession>;

export interface V2NavigationTarget {
  notebookId: string;
  sectionId: string;
  pageId: string;
}

export interface PageChangeOptions {
  message: string;
  /** Unix seconds; omit for wall-clock-independent changes. */
  time?: number;
}

/** Runtime consumers may observe Repo documents but cannot bypass schema-gated writers. */
export type ReadonlyDocHandle<T> = Omit<DocHandle<T>, 'change'>;

export interface PageWriteSession {
  readonly pageId: string;
  readonly activationArtifactFingerprint: Sha256Checksum;
  readonly handle: ReadonlyDocHandle<LivePageDocV2>;
  change(options: PageChangeOptions, change: ChangeFn<LivePageDocV2>): LivePageDocV2;
}

export interface ActiveV2Context {
  notebook: LiveNotebookDocV2;
  section: NotebookSectionRef;
  page: LivePageDocV2;
  notebookHandle: ReadonlyDocHandle<LiveNotebookDocV2>;
  pageHandle: ReadonlyDocHandle<LivePageDocV2>;
}

export interface V1RuntimeState {
  schemaVersion: 1;
  authoritative: 'v1';
  backend: StorageBackend;
  workspace: WorkspaceState;
}

export interface V2RuntimeState {
  schemaVersion: 2 | 3;
  authoritative: 'v2' | 'v3';
  activation: V2ActivationRecord;
  active: V2NavigationTarget;
  notebooks: readonly LiveNotebookDocV2[];
  /**
   * One summary per page document, in activation order. Page contents are
   * not part of the state; `readPage`, `loadPage` and the active context
   * provide them on demand.
   */
  pages: readonly PageSummary[];
}

export type WorkspaceV2RuntimeState = V1RuntimeState | V2RuntimeState;

export interface WorkspaceV2RuntimeOptions {
  source: V1WorkspaceMigrationSource;
  activationStore: V2WorkspaceActivationStore;
  repoFactory: PersistentRepoFactory;
  migrationFactory?: () => V2WorkspaceMigrationOrchestrator;
  acquireWriteAccess?: () => Promise<StorageBackend>;
  /** Pages kept in memory besides the active one (least recently used are evicted). Default 4. */
  pageCacheSize?: number;
  /**
   * Automerge operations the cached pages (not counting the active one) may
   * add up to, so that pages with thousands of strokes (about a million
   * operations, a hundred megabytes and more each) leave earlier than small
   * ones. The most recently used page is always kept. Default 1,500,000.
   */
  pageCacheOperations?: number;
  /** Delay before a loaded page's index entry is rewritten after a change. Default 1500 ms. */
  indexWriteDelayMs?: number;
  /**
   * Reports the one-time page index build when a workspace written before
   * lazy loading (or after a crash) opens: every page without a current index
   * entry is read once, one after the other.
   */
  onProgress?: (progress: MigrationProgress) => void;
  /**
   * The page to open when the app starts, instead of the page the workspace
   * stored with its last structural change: the page last viewed on this
   * device (per-device state, see v2WorkspaceView). Ignored when the page is
   * gone, in the trash or in a trashed notebook.
   */
  startPageId?: () => string | undefined;
}

export interface ExtendActiveWorkspaceRequest {
  importId: string;
  importArtifactFingerprint: Sha256Checksum;
  expectedActivationArtifactFingerprint: Sha256Checksum;
  notebook: NotebookDoc | NotebookDocV3;
  pages: Array<PageDoc | PageDocV3>;
  assets: AssetBlob[];
  preparedAt: string;
}

export interface ExtendActiveWorkspaceResult {
  status: 'committed' | 'already-committed';
  importId: string;
  artifactFingerprint: Sha256Checksum;
  backupId: string;
  notebookDocumentId: string;
  pageDocumentIds: string[];
  assetIds: Sha256Checksum[];
}

export interface AdditiveImportOptions {
  importId: string;
  preparedAt: string;
  /**
   * The notebook the import adds. Its sections must list every page the
   * import will add, so each page can be validated as it arrives.
   */
  notebook: NotebookDoc | NotebookDocV3;
  /**
   * When set, the commit fails if another commit changed the workspace
   * after this fingerprint (the preview semantics of `extendActiveWorkspace`).
   * Without it the import is published on top of whatever is current, since
   * adding a new notebook cannot conflict with other changes.
   */
  expectedActivationArtifactFingerprint?: Sha256Checksum;
  /** Bytes staged per storage write. Default 16 MiB. */
  batchBytes?: number;
}

export interface AdditiveImportProgress {
  pages: number;
  assets: number;
  stagedBytes: number;
}

/**
 * Writes an imported notebook page by page with bounded memory. Pages and
 * assets are staged as unreferenced storage entries; `commit` publishes
 * them with one small delta commit. `abort` removes what was staged.
 */
export interface AdditiveImportWriter {
  addAssets(assets: readonly AssetBlob[]): Promise<void>;
  addPage(page: PageDoc | PageDocV3): Promise<void>;
  progress(): AdditiveImportProgress;
  commit(importArtifactFingerprint: Sha256Checksum): Promise<ExtendActiveWorkspaceResult>;
  abort(): Promise<void>;
}

export interface WorkspaceGraphDocumentChange {
  documentId: string;
  change: ChangeFn<LiveCanvinkDocumentV2>;
}

export interface WorkspaceGraphRevisionRequest {
  operationId: string;
  /** The activation the caller built the request from; see `onConflict`. */
  expectedActivationArtifactFingerprint: Sha256Checksum;
  /**
   * What happens when another commit (typically a sync adoption) published a
   * newer activation after the caller read `expectedActivationArtifactFingerprint`.
   * `rebase` (the default) applies the request to the current workspace: the
   * change functions and `updateManifest` run against the live documents, and a
   * removal of a document that is already gone is a no-op. `fail` throws, for
   * callers that derived the request from the old state and re-plan themselves.
   */
  onConflict?: 'rebase' | 'fail';
  message: string;
  changes?: WorkspaceGraphDocumentChange[];
  newDocuments?: CanvinkDocument[];
  /**
   * Documents adopted from a remote peer WITH their Automerge history intact.
   * Unlike `newDocuments` (JSON projections re-materialised into brand-new
   * Automerge documents), these bytes are stored as they are, which
   * preserves the shared history that makes later merges converge.
   */
  adoptedDocuments?: Array<{
    documentId: string;
    kind: 'notebook' | 'page';
    bytes: Uint8Array;
    /** The summary the account published for the page; see `AdoptionPrepInput.expectedSummary`. */
    expectedSummary?: PageSummary;
  }>;
  removedDocumentIds?: string[];
  /**
   * Pages the workspace lists with their published summary but whose
   * documents this device has not downloaded (personal-space pages a fresh
   * device shows before it holds them). They appear in the sidebar and
   * search results; the first read of one asks the content source (see
   * `setDocumentContentSource`) for it, and a later commit adopts the
   * downloaded bytes in place of the placeholder (`adoptedDocuments` together
   * with `removedDocumentIds` for the same document).
   */
  placeholderPages?: Array<{ documentId: string; summary: PageSummary }>;
  assets?: AssetBlob[];
  updateManifest?: (manifest: WorkspaceManifest) => void;
  replacementManifest?: WorkspaceManifest;
  activatedAt?: string;
}

export type DocumentChangeOrigin =
  | { kind: 'local' }
  | { kind: 'remote'; source: string }
  | { kind: 'topology' };

export interface DocumentChangeEvent {
  documentId: string;
  kind: 'notebook' | 'page';
  beforeHeads: readonly string[];
  heads: readonly string[];
  origin: DocumentChangeOrigin;
  /**
   * The document after the change. It may be a transient copy that is freed
   * right after the listeners ran, so listeners must use it synchronously.
   * Absent for documents a commit added; read them with `readDocument`.
   */
  document?: CanvinkAutomergeDoc;
  /** Set when a commit added the document to the workspace. */
  added?: boolean;
}

export type RemoteApplyResult = 'applied' | 'unchanged' | 'rejected' | 'unknown';

export interface RuntimeMemoryDiagnostics {
  loadedPages: number;
  loadedNotebooks: number;
  pageDocuments: number;
}

interface LoadedDocument {
  documentId: string;
  kind: 'notebook' | 'page';
  storageId: string;
  handle: DocHandle<LiveCanvinkDocumentV2>;
  heads: string[];
  retain: number;
  lastUsed: number;
  indexTimer?: ReturnType<typeof setTimeout>;
  indexDirty: boolean;
  /** The index write in flight or queued; later writes and flushes wait for it. */
  indexWriting?: Promise<void>;
  detach: () => void;
}

interface OpenV2State {
  activation: V2ActivationRecord;
  session: PersistentRepoSession;
  documents: Map<string, ActivatedDocumentV2>;
  storageIds: Map<string, string>;
  loaded: Map<string, LoadedDocument>;
  summaries: Map<string, PageSummary>;
  /** Pages listed by their summary whose documents are not stored on this device yet. */
  placeholders: Set<string>;
  pageDocuments: Map<string, string>;
  active: V2NavigationTarget;
}

interface StagedDocument {
  documentId: string;
  kind: 'notebook' | 'page';
  storageId: string;
  url: string;
  heads: string[];
  /** Bytes written for this document by the commit (snapshot or incremental). */
  entry?: { key: string[]; bytes: Uint8Array };
  document?: CanvinkAutomergeDoc;
  summary?: PageSummary;
  notebook?: LiveNotebookDocV2;
  isNew: boolean;
  /** Listed by its summary only; no document is stored. */
  placeholder?: boolean;
}

/** How long the pen rests before drawn strokes are sealed into a segment, and the count that seals at once. */
const INK_SEAL_DELAY_MS = 1500;
const INK_SEAL_BATCH = 200;
const INK_COMPACTION_DELAY_MS = 8000;
/** How long opening a page waits for ink segments that are not on this device. */
const INK_OPEN_WAIT_MS = 4000;
const DEFAULT_PAGE_CACHE_SIZE = 4;
const DEFAULT_PAGE_CACHE_OPERATIONS = 1_500_000;
const DEFAULT_INDEX_WRITE_DELAY_MS = 1500;
const DEFAULT_IMPORT_BATCH_BYTES = 16 * 1024 * 1024;

function assertActivationShape(activation: V2ActivationRecord): void {
  const isV2 = activation.schemaVersion === 2
    && activation.format === 'canvink-automerge-v2'
    && activation.manifest.schemaVersion === 2
    && activation.manifest.format === 'canvink-schema-v2';
  const isV3 = activation.schemaVersion === 3
    && activation.format === 'canvink-automerge-v3'
    && activation.manifest.schemaVersion === 3
    && activation.manifest.format === 'canvink-schema-v3';
  if (
    activation.version !== 1
    || (!isV2 && !isV3)
    || !activation.migrationId
    || !activation.sourceFingerprint
    || !activation.artifactFingerprint
    || !Array.isArray(activation.documents)
    || !Array.isArray(activation.chunks)
    || !Array.isArray(activation.assetIds)
    || typeof activation.manifest !== 'object'
    || activation.manifest === null
  ) {
    throw new Error('The Automerge activation is malformed or mixes schema versions.');
  }
  if (isV3) {
    const upgrade = (activation.manifest as WorkspaceManifestV3).upgrade;
    if (
      upgrade?.name !== 'workspace-v2-to-v3'
      || upgrade.version !== 1
      || !/^sha256:[0-9a-f]{64}$/.test(upgrade.sourceArtifactFingerprint)
      || upgrade.upgradeId !== `workspace-v2-to-v3:${upgrade.sourceArtifactFingerprint.slice(7)}`
      || Number.isNaN(Date.parse(upgrade.preparedAt))
    ) throw new Error('The schema-v3 activation has invalid upgrade provenance.');
    assertV3ManifestMathData(activation.manifest);
  }
  const documentIds = new Set<string>();
  const urls = new Set<string>();
  for (const document of activation.documents) {
    if (
      !document.documentId
      || (document.kind !== 'notebook' && document.kind !== 'page')
      || !isValidDocumentUrl(document.url)
      || !Array.isArray(document.heads)
      || document.heads.length === 0
      || document.heads.some((head) => typeof head !== 'string' || !head)
      || documentIds.has(document.documentId)
      || urls.has(document.url)
    ) throw new Error('The schema-v2 activation document map is malformed or duplicated.');
    documentIds.add(document.documentId);
    urls.add(document.url);
  }
  const manifestIds = [
    ...activation.manifest.notebookDocumentIds,
    ...activation.manifest.pageDocumentIds,
  ];
  if (
    manifestIds.length !== activation.documents.length
    || manifestIds.some((documentId) => !documentIds.has(documentId))
  ) throw new Error('The activation document map does not match the manifest roots and pages.');
}

/**
 * The workspace graph, checked from the notebook documents and the page
 * summaries alone: every page a section lists is a page document of the
 * activation whose own location names that notebook and section.
 */
function validateWorkspaceGraph(
  activation: V2ActivationRecord,
  notebooks: ReadonlyMap<string, LiveNotebookDocV2>,
  summaries: ReadonlyMap<string, PageSummary>,
): void {
  const documents = new Map(activation.documents.map((document) => [document.documentId, document]));
  for (const documentId of activation.manifest.notebookDocumentIds) {
    const notebook = notebooks.get(documentId);
    if (documents.get(documentId)?.kind !== 'notebook' || notebook?.kind !== 'notebook') {
      throw new Error(`Notebook root ${documentId} is missing or has the wrong kind.`);
    }
    if (notebook.schemaVersion !== activation.schemaVersion) {
      throw new Error(`Document ${documentId} does not match activation schema v${activation.schemaVersion}.`);
    }
  }
  for (const documentId of activation.manifest.pageDocumentIds) {
    const summary = summaries.get(documentId);
    if (documents.get(documentId)?.kind !== 'page' || !summary) {
      throw new Error(`Page document ${documentId} is missing or has the wrong kind.`);
    }
    if (summary.schemaVersion !== activation.schemaVersion) {
      throw new Error(`Document ${documentId} does not match activation schema v${activation.schemaVersion}.`);
    }
  }
  for (const notebook of notebooks.values()) {
    for (const section of notebook.sections) {
      for (const pageDocumentId of section.pageDocumentIds) {
        const page = summaries.get(pageDocumentId);
        if (
          !page
          || page.notebookId !== notebook.notebookId
          || page.sectionId !== section.id
        ) throw new Error(`Notebook ${notebook.documentId} references invalid page ${pageDocumentId}.`);
      }
    }
  }
}

function assertImportedNotebook(
  notebook: NotebookDoc | NotebookDocV3,
  activation: V2ActivationRecord,
): { pageDocumentIds: Set<string>; sectionIds: Set<string> } {
  if (notebook.schemaVersion !== 2 && notebook.schemaVersion !== 3) {
    throw new Error('Imported notebook schema is unsupported.');
  }
  if (notebook.documentId !== `notebook:${notebook.notebookId}`) {
    throw new Error('The imported notebook document ID is not canonical.');
  }
  const sectionIds = new Set(notebook.sections.map((section) => section.id));
  if (sectionIds.size !== notebook.sections.length) {
    throw new Error('The imported notebook contains duplicate section IDs.');
  }
  const existingIds = new Set(activation.documents.map((document) => document.documentId));
  const referenced = notebook.sections.flatMap((section) => section.pageDocumentIds);
  const pageDocumentIds = new Set(referenced);
  if (
    existingIds.has(notebook.documentId)
    || referenced.some((documentId) => existingIds.has(documentId))
    || pageDocumentIds.size !== referenced.length
    || pageDocumentIds.has(notebook.documentId)
  ) throw new Error('Imported document IDs collide with the active workspace.');
  if (referenced.length === 0) throw new Error('An imported notebook requires at least one page.');
  return { pageDocumentIds, sectionIds };
}

function elementAssetIds(page: PageDoc | PageDocV3): Sha256Checksum[] {
  return Object.values(page.elementsById).flatMap((element) => {
    if (element.kind === 'image' || element.kind === 'attachment') return [element.asset.assetId];
    if (element.kind === 'pdf') {
      return [element.previewAsset.assetId, ...(element.originalAsset ? [element.originalAsset.assetId] : [])];
    }
    return [];
  });
}

function toPhysical(key: readonly string[]): string[] {
  return [REPO_NAMESPACE, ...key];
}

function indexKey(storageId: string): string[] {
  return [PAGE_INDEX_NAMESPACE, storageId];
}

function documentPrefixes(storageId: string): string[][] {
  return [[REPO_NAMESPACE, storageId], [PAGE_INDEX_NAMESPACE, storageId], [DIRTY_NAMESPACE, storageId]];
}

async function createDocumentBytes(
  projection: CanvinkDocument,
  expectedSchemaVersion: 2 | 3,
  actorId: string,
  upgradeV2: boolean,
): Promise<{ bytes: Uint8Array; heads: string[]; summary?: PageSummary; notebook?: LiveNotebookDocV2 }> {
  if (!upgradeV2 && projection.schemaVersion !== expectedSchemaVersion) {
    throw new Error(`Document ${projection.documentId} does not match schema v${expectedSchemaVersion}.`);
  }
  // Ink goes into segments before the document exists, so a page built from
  // thousands of strokes (an import, a copy) starts without their history.
  const prepared = projection.kind === 'page'
    ? await sealProjection(projection as unknown as PlainInkPage, inkSegments()) as unknown as CanvinkDocument
    : projection;
  const document = (upgradeV2 ? createAutomergeDocumentV3 : createAutomergeDocument)(prepared, { actorId });
  try {
    if (document.schemaVersion !== expectedSchemaVersion) {
      throw new Error(`Document ${projection.documentId} does not match schema v${expectedSchemaVersion}.`);
    }
    const bytes = saveAutomergeDocument(document);
    const heads = getAutomergeHeads<LiveCanvinkDocumentV2>(document);
    return {
      bytes,
      heads,
      ...(document.kind === 'page'
        ? { summary: summarizePageDocument(document as PageAutomergeDoc) }
        : { notebook: getSharedAutomergeSnapshot<LiveCanvinkDocumentV2>(document) as LiveNotebookDocV2 }),
    };
  } finally {
    // Only the saved bytes are kept. Freeing the WebAssembly document now,
    // instead of waiting for garbage collection, keeps a large import (a
    // whole OneNote notebook full of ink) from exhausting WebAssembly memory.
    freeDocument(document);
  }
}

async function deterministicActor(namespace: string, scope: string, documentId: string): Promise<string> {
  const checksum = await sha256Canonical({ namespace, scope, documentId });
  return checksum.slice('sha256:'.length);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

export class WorkspaceV2Runtime {
  private state?: WorkspaceV2RuntimeState;
  private openV2?: OpenV2State;
  private readonly subscriptions = new Set<() => void>();
  private readonly stateListeners = new Set<(state: WorkspaceV2RuntimeState) => void>();
  private readonly documentListeners = new Set<(event: DocumentChangeEvent) => void>();
  private readonly listenerFailureListeners = new Set<(error: unknown) => void>();
  private readonly documentLocks = new Map<string, Promise<void>>();
  private contentSource?: DocumentContentSource;
  private readonly contentWaiters = new Map<string, Array<{ resolve(): void; reject(error: Error): void }>>();
  private readonly inkTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly inkRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly inkCompactionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly inkArrivalListeners = new Set<(documentId: string) => void>();
  private unsubscribePendingInk: (() => void) | undefined;
  private writeAccess?: StorageBackend;
  private starting?: Promise<WorkspaceV2RuntimeState>;
  private shuttingDown = false;
  private stateNotificationScheduled = false;
  private pendingOrigin?: DocumentChangeOrigin;
  private useCounter = 0;
  private navigationTicket = 0;
  private readonly pageCacheSize: number;
  private readonly pageCacheOperations: number;
  private readonly indexWriteDelayMs: number;

  constructor(private readonly options: WorkspaceV2RuntimeOptions) {
    this.pageCacheSize = Math.max(0, options.pageCacheSize ?? DEFAULT_PAGE_CACHE_SIZE);
    this.pageCacheOperations = Math.max(0, options.pageCacheOperations ?? DEFAULT_PAGE_CACHE_OPERATIONS);
    this.indexWriteDelayMs = Math.max(0, options.indexWriteDelayMs ?? DEFAULT_INDEX_WRITE_DELAY_MS);
  }

  /**
   * Serializes every mutating workspace operation. The compare-and-swap that
   * guards a topology transaction spans many awaits, so two overlapping
   * operations could each read the same activation and both commit. Running
   * mutations one at a time makes the second see the first's new
   * fingerprint and fail as a conflict. Code already inside a mutation calls
   * the `...Locked` variants; the public methods always wait their turn, so
   * a caller arriving while a migration or upgrade runs (the editor asking
   * for a writer as soon as the first state is published) cannot start a
   * second upgrade next to it.
   */
  private readonly mutationQueue = new SerialTaskQueue();

  private runMutation<T>(task: () => Promise<T>): Promise<T> {
    return this.mutationQueue.enqueue(task);
  }

  /** Runs `task` exclusively for one document: loading, evicting and direct writes never overlap. */
  private async withDocumentLock<T>(documentId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.documentLocks.get(documentId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const chained = previous.then(() => current);
    this.documentLocks.set(documentId, chained);
    await previous;
    try {
      return await task();
    } finally {
      release();
      if (this.documentLocks.get(documentId) === chained) this.documentLocks.delete(documentId);
    }
  }

  startup(): Promise<WorkspaceV2RuntimeState> {
    if (this.state) return Promise.resolve(this.getState());
    if (this.starting) return this.starting;
    if (this.shuttingDown) return Promise.reject(new Error('Workspace runtime is shutting down.'));
    this.starting = this.startupOnce().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  /** The current state. It is frozen and shared; derive new values instead of mutating it. */
  getState(): WorkspaceV2RuntimeState {
    if (!this.state) throw new Error('Workspace runtime has not started.');
    return this.state;
  }

  /** Notified (coalesced per microtask) whenever notebooks, page summaries, activation or navigation change. */
  subscribeToState(listener: (state: WorkspaceV2RuntimeState) => void): () => void {
    this.stateListeners.add(listener);
    return () => { this.stateListeners.delete(listener); };
  }

  /**
   * Every change of any workspace document, loaded or not: local edits,
   * remote changes applied through `applyRemoteDocumentChanges`, and topology
   * commits. Sync ports use it instead of handle events, whose identity
   * changes when a page is evicted and loaded again.
   */
  subscribeToDocumentChanges(listener: (event: DocumentChangeEvent) => void): () => void {
    this.documentListeners.add(listener);
    return () => { this.documentListeners.delete(listener); };
  }

  /**
   * A document change listener (sync, search) threw. The document itself is
   * saved, but the listener's view of it has diverged, so the app reports it
   * instead of letting sync or search fall behind silently.
   */
  subscribeToListenerFailures(listener: (error: unknown) => void): () => void {
    this.listenerFailureListeners.add(listener);
    return () => { this.listenerFailureListeners.delete(listener); };
  }

  getActiveContext(): ActiveV2Context {
    const open = this.requireV2();
    return this.resolveLoadedContext(open, open.active);
  }

  /** Loads the target page if needed and makes it active. */
  async navigateTo(target: V2NavigationTarget): Promise<ActiveV2Context> {
    const open = this.requireV2();
    const documentId = this.resolveTarget(open, target);
    const ticket = ++this.navigationTicket;
    try {
      await this.loadDocument(open, documentId);
    } catch (error) {
      // A sync adoption or topology commit removed the page while it loaded: the
      // navigation ends where that commit left the workspace instead of failing.
      if (this.openV2 === open && !open.documents.has(documentId)) {
        return this.resolveLoadedContext(open, open.active);
      }
      throw error;
    }
    if (this.openV2 !== open) throw new Error('The workspace was reopened during navigation.');
    // A later navigation that finished first wins; this one only loaded its page.
    if (ticket !== this.navigationTicket) return this.resolveLoadedContext(open, open.active);
    // The page was deleted, moved or its notebook removed while it loaded
    // (a topology commit does not wait for a navigation): opening it now
    // would leave a target outside the graph, so the navigation ends where
    // the commit left the workspace.
    try {
      this.resolveTarget(open, target);
    } catch {
      return this.resolveLoadedContext(open, open.active);
    }
    open.active = structuredClone(target);
    this.touch(open, documentId);
    this.publishState(open);
    void this.evictPages(open);
    return this.resolveLoadedContext(open, open.active);
  }

  /**
   * Sets who downloads pages this device lists but does not hold. Without a
   * source, reading such a page fails at once instead of waiting.
   */
  setDocumentContentSource(source: DocumentContentSource | undefined): void {
    this.contentSource = source;
    if (!source) this.rejectContentWaiters('The account is not connected, so the page cannot be downloaded.');
  }

  /** Whether the device stores the document (false for a placeholder page and for unknown ids). */
  isDocumentAvailable(documentId: string): boolean {
    const open = this.openV2;
    return Boolean(open && open.documents.has(documentId) && !open.placeholders.has(documentId));
  }

  /** Placeholder pages, as document ids in activation order. */
  listPlaceholderDocuments(): string[] {
    const open = this.openV2;
    if (!open) return [];
    return open.activation.documents.filter((document) => open.placeholders.has(document.documentId)).map((document) => document.documentId);
  }

  /**
   * Waits until a placeholder page is stored, asking the content source for
   * it. Never called from inside a mutation: the commit that adopts the
   * downloaded page has to run in the mutation queue.
   */
  private async ensureContent(documentId: string): Promise<void> {
    const open = this.openV2;
    if (!open || !open.placeholders.has(documentId)) return;
    const source = this.contentSource;
    if (!source) {
      throw new PageNotDownloadedError(documentId, `Page ${documentId} is not downloaded and the account is not connected.`);
    }
    await new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve: () => { clearTimeout(timer); resolve(); },
        reject: (error: Error) => { clearTimeout(timer); reject(error); },
      };
      const timer = setTimeout(() => {
        const waiters = this.contentWaiters.get(documentId)?.filter((candidate) => candidate !== waiter) ?? [];
        if (waiters.length > 0) this.contentWaiters.set(documentId, waiters);
        else this.contentWaiters.delete(documentId);
        reject(new PageNotDownloadedError(documentId, `Page ${documentId} could not be downloaded in time.`));
      }, CONTENT_WAIT_MS);
      const waiters = this.contentWaiters.get(documentId) ?? [];
      waiters.push(waiter);
      this.contentWaiters.set(documentId, waiters);
      try {
        source.request(documentId);
      } catch (error) {
        waiter.reject(new PageNotDownloadedError(documentId, error instanceof Error ? error.message : String(error)));
      }
    });
  }

  /** The content source could not get a page (the connection dropped): readers waiting for it fail now instead of at the timeout. */
  abandonContentRequest(documentId: string, message: string): void {
    const waiters = this.contentWaiters.get(documentId);
    if (!waiters) return;
    this.contentWaiters.delete(documentId);
    for (const waiter of waiters) waiter.reject(new PageNotDownloadedError(documentId, message));
  }

  private resolveContentWaiters(open: OpenV2State): void {
    for (const [documentId, waiters] of [...this.contentWaiters]) {
      if (open.placeholders.has(documentId) && open.documents.has(documentId)) continue;
      this.contentWaiters.delete(documentId);
      for (const waiter of waiters) waiter.resolve();
    }
  }

  private rejectContentWaiters(message: string): void {
    for (const [documentId, waiters] of [...this.contentWaiters]) {
      this.contentWaiters.delete(documentId);
      for (const waiter of waiters) waiter.reject(new PageNotDownloadedError(documentId, message));
    }
  }

  /** Summary of one page, current even when it changed since the last published state. */
  getPageSummary(pageId: string): PageSummary | undefined {
    const open = this.openV2;
    if (!open) return undefined;
    const documentId = open.pageDocuments.get(pageId);
    return documentId ? open.summaries.get(documentId) : undefined;
  }

  isPageLoaded(pageId: string): boolean {
    const open = this.openV2;
    const documentId = open?.pageDocuments.get(pageId);
    return Boolean(documentId && open?.loaded.has(documentId));
  }

  /** Loads a page into memory (it stays until evicted) and returns its handle. */
  async loadPage(pageId: string): Promise<ReadonlyDocHandle<LivePageDocV2>> {
    const open = this.requireV2();
    const documentId = this.pageDocumentId(open, pageId);
    const loaded = await this.loadDocument(open, documentId);
    this.touch(open, documentId);
    void this.evictPages(open);
    return loaded.handle as unknown as ReadonlyDocHandle<LivePageDocV2>;
  }

  /** Keeps a page loaded until the returned release function is called. */
  async retainPage(pageId: string): Promise<() => void> {
    const open = this.requireV2();
    const documentId = this.pageDocumentId(open, pageId);
    const loaded = await this.loadDocument(open, documentId);
    loaded.retain += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      loaded.retain = Math.max(0, loaded.retain - 1);
      if (this.openV2 === open) void this.evictPages(open);
    };
  }

  /** Handle of a page that is loaded (the active page always is). */
  getPageHandle(pageId: string): ReadonlyDocHandle<LivePageDocV2> {
    return this.getLoadedPageHandle(pageId) as unknown as ReadonlyDocHandle<LivePageDocV2>;
  }

  private getLoadedPageHandle(pageId: string): DocHandle<LivePageDocV2> {
    const open = this.requireV2();
    const documentId = this.pageDocumentId(open, pageId);
    const loaded = open.loaded.get(documentId);
    if (!loaded) throw new Error(`Page ${pageId} is not loaded; load it with loadPage or readPage.`);
    return loaded.handle as unknown as DocHandle<LivePageDocV2>;
  }

  getNotebookHandle(notebookId: string): ReadonlyDocHandle<LiveNotebookDocV2> {
    const open = this.requireV2();
    const loaded = open.loaded.get(`notebook:${notebookId}`)
      ?? [...open.loaded.values()].find((candidate) =>
        candidate.kind === 'notebook'
        && (candidate.handle.doc() as LiveNotebookDocV2).notebookId === notebookId);
    if (!loaded) throw new Error(`Notebook ${notebookId} is not part of the active workspace.`);
    return loaded.handle as unknown as ReadonlyDocHandle<LiveNotebookDocV2>;
  }

  /**
   * Runs `reader` with the current Automerge document of a page. A loaded
   * page is read in place; any other page is loaded from storage for the
   * reader only and freed afterwards, so reading every page one after the
   * other needs memory for one page at a time.
   */
  readPage<T>(pageId: string, reader: (document: PageAutomergeDoc) => T | Promise<T>): Promise<T> {
    const open = this.requireV2();
    return this.readDocument(this.pageDocumentId(open, pageId), (document) => reader(document as PageAutomergeDoc));
  }

  async readDocument<T>(
    documentId: string,
    reader: (document: CanvinkAutomergeDoc) => T | Promise<T>,
  ): Promise<T> {
    await this.ensureContent(documentId);
    const open = this.requireV2();
    const loaded = open.loaded.get(documentId);
    if (loaded) return reader(loaded.handle.doc() as CanvinkAutomergeDoc);
    return this.withDocumentLock(documentId, async () => {
      const current = open.loaded.get(documentId);
      if (current) return reader(current.handle.doc() as CanvinkAutomergeDoc);
      const document = await this.loadDetached(open, documentId);
      try {
        return await reader(document);
      } finally {
        freeDocument(document);
      }
    });
  }

  /**
   * The document as Automerge bytes that `Automerge.load` accepts, without
   * loading it: a loaded document is saved, any other document is its stored
   * chunks (snapshot first, then incremental changes) concatenated. Exports
   * use this; readers verify the bytes when they load them.
   */
  async readDocumentBytes(documentId: string): Promise<Uint8Array> {
    await this.ensureContent(documentId);
    const open = this.requireV2();
    // Ink drawn a moment ago joins the document before its bytes are taken.
    if (pendingInk().count(documentId) > 0) await this.sealPendingInk(documentId).catch(() => 0);
    const loaded = open.loaded.get(documentId);
    if (loaded) return Automerge.save(loaded.handle.doc() as Automerge.Doc<unknown>);
    return this.withDocumentLock(documentId, async () => {
      const current = open.loaded.get(documentId);
      if (current) return Automerge.save(current.handle.doc() as Automerge.Doc<unknown>);
      const storageId = this.requireStorageId(open, documentId);
      const chunks = [
        ...await open.session.storage.loadRange([storageId, 'snapshot']),
        ...await open.session.storage.loadRange([storageId, 'incremental']),
      ].flatMap((chunk) => chunk.data ? [chunk.data] : []);
      if (chunks.length === 0) {
        throw new WorkspaceV2RecoveryRequiredError(
          'document-unavailable',
          `Activated Automerge document ${documentId} is unavailable.`,
          { activation: open.activation },
        );
      }
      const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return bytes;
    });
  }

  /** Current heads of a document: live for loaded documents, from the page index otherwise. */
  getDocumentHeads(documentId: string): readonly string[] | undefined {
    const open = this.openV2;
    if (!open || open.placeholders.has(documentId)) return undefined;
    const loaded = open.loaded.get(documentId);
    if (loaded) return loaded.heads;
    return open.summaries.get(documentId)?.heads ?? open.documents.get(documentId)?.heads;
  }

  /** Documents this device stores: id and kind, without loading anything. Placeholder pages are not among them. */
  listDocuments(): Array<{ documentId: string; kind: 'notebook' | 'page' }> {
    const open = this.requireV2();
    return [...open.documents.values()]
      .filter(({ documentId }) => !open.placeholders.has(documentId))
      .map(({ documentId, kind }) => ({ documentId, kind }));
  }

  /**
   * Merges remote Automerge bytes (a full save or `saveSince` output) into a
   * document. A loaded document is updated in place; any other document is
   * loaded, updated, persisted with its index entry and freed again, so
   * sync keeps working for pages that are not open. `accept` can refuse
   * bytes after inspecting the local copy.
   */
  async applyRemoteDocumentChanges(
    documentId: string,
    bytes: Uint8Array,
    options: {
      source: string;
      accept?: (local: CanvinkAutomergeDoc, bytes: Uint8Array) => boolean;
    },
  ): Promise<RemoteApplyResult> {
    const open = this.requireV2();
    if (!open.documents.has(documentId) || open.placeholders.has(documentId)) return 'unknown';
    return this.withDocumentLock(documentId, async () => {
      if (this.openV2 !== open || !open.documents.has(documentId) || open.placeholders.has(documentId)) return 'unknown';
      const loaded = open.loaded.get(documentId);
      if (loaded) {
        const local = loaded.handle.doc() as CanvinkAutomergeDoc;
        if (options.accept && !options.accept(local, bytes)) return 'rejected';
        const before = getAutomergeHeads<LiveCanvinkDocumentV2>(local);
        this.pendingOrigin = { kind: 'remote', source: options.source };
        try {
          loaded.handle.update((doc) => Automerge.loadIncremental(doc, bytes));
        } finally {
          this.pendingOrigin = undefined;
        }
        return sameHeadSet(before, getAutomergeHeads<LiveCanvinkDocumentV2>(loaded.handle.doc() as CanvinkAutomergeDoc))
          ? 'unchanged'
          : 'applied';
      }
      const storageId = this.requireStorageId(open, documentId);
      let document: CanvinkAutomergeDoc | undefined = await this.loadDetached(open, documentId);
      try {
        if (options.accept && !options.accept(document, bytes)) return 'rejected';
        const before = getAutomergeHeads<LiveCanvinkDocumentV2>(document);
        document = Automerge.loadIncremental<LiveCanvinkDocumentV2>(document, bytes) as CanvinkAutomergeDoc;
        assertCanvinkAutomergeDocument(document);
        if (document.documentId !== documentId) {
          throw new Error(`Remote bytes changed the identity of ${documentId}.`);
        }
        const after = getAutomergeHeads<LiveCanvinkDocumentV2>(document);
        if (sameHeadSet(before, after)) return 'unchanged';
        const delta = Automerge.saveSince(document, before);
        const key = [storageId, 'incremental', await chunkHash(delta)];
        const shared: CanvinkStorageMutation[] = [];
        let summary: PageSummary | undefined;
        if (document.kind === 'page') {
          summary = summarizePageDocument(document as PageAutomergeDoc);
          shared.push(...await this.indexWriteMutations(open, documentId, storageId, summary));
        }
        await open.session.storage.commitAtomically({
          repo: [{ type: 'save', key, data: delta }],
          shared,
        });
        if (this.openV2 === open && summary) this.updateSummary(open, summary);
        // Fetch the page's ink in the background, so opening it later needs no download.
        if (document.kind === 'page') {
          const referenced = referencedInkSegments(document);
          if (referenced.length > 0) void inkSegments().ensure(referenced).catch(() => undefined);
        }
        this.emitDocumentChange({
          documentId,
          kind: document.kind,
          beforeHeads: before,
          heads: after,
          origin: { kind: 'remote', source: options.source },
          document,
        });
        return 'applied';
      } finally {
        freeDocument(document);
      }
    });
  }

  async getAsset(assetId: Sha256Checksum): Promise<AssetBlob | undefined> {
    const open = this.requireV2();
    if (!open.activation.assetIds.includes(assetId)) {
      // Ink segments travel through exports and backups as assets, but are kept by the segment store.
      const hash = assetId.slice('sha256:'.length);
      if (!isInkSegmentHash(hash)) return undefined;
      const bytes = await inkSegments().read(hash);
      return bytes
        ? { assetId, checksum: assetId, size: bytes.byteLength, bytes: bytes.slice() } as AssetBlob
        : undefined;
    }
    const asset = await this.readAsset(open, assetId);
    if (!asset) {
      throw new WorkspaceV2RecoveryRequiredError(
        'committed-payload-corrupt',
        `Activated asset ${assetId} is missing.`,
        { activation: open.activation },
      );
    }
    if (
      asset.assetId !== asset.checksum
      || asset.size !== asset.bytes.byteLength
      || await sha256Bytes(asset.bytes) !== asset.assetId
    ) throw new WorkspaceV2RecoveryRequiredError(
      'committed-payload-corrupt',
      `Activated asset ${assetId} failed integrity verification.`,
      { activation: open.activation },
    );
    return structuredClone(asset);
  }

  async listAssets(): Promise<AssetBlob[]> {
    const open = this.requireV2();
    const assets: AssetBlob[] = [];
    for (const assetId of open.activation.assetIds) {
      const verified = await this.getAsset(assetId);
      if (verified) assets.push(verified);
    }
    return assets;
  }

  private async readAsset(open: OpenV2State, assetId: Sha256Checksum): Promise<AssetBlob | undefined> {
    const store = this.options.activationStore;
    if (store.readAsset) return store.readAsset(assetId);
    const payload = await store.readCommitted(open.activation);
    return payload.assets.find((candidate) => candidate.assetId === assetId);
  }

  async changePage(
    pageId: string,
    options: PageChangeOptions,
    change: ChangeFn<LivePageDocV2>,
  ): Promise<LivePageDocV2> {
    if (!options.message.trim()) throw new Error('A page change requires a message.');
    const session = await this.preparePageWrite(pageId);
    return session.change(options, change);
  }

  /**
   * Performs the one asynchronous schema gate before an editor binding starts
   * and loads the page. The returned synchronous writer fails closed once the
   * page was evicted or the workspace was reopened.
   */
  async preparePageWrite(pageId: string): Promise<PageWriteSession> {
    await this.ensureSchemaV3();
    const authority = this.requireV2();
    if (authority.activation.schemaVersion !== 3) throw new Error('Schema-v3 write authority is unavailable.');
    const authorityFingerprint = authority.activation.artifactFingerprint;
    const documentId = this.pageDocumentId(authority, pageId);
    const loaded = await this.loadDocument(authority, documentId);
    this.touch(authority, documentId);
    const handle = loaded.handle as unknown as DocHandle<LivePageDocV2>;
    return Object.freeze({
      pageId,
      activationArtifactFingerprint: authorityFingerprint,
      handle: handle as ReadonlyDocHandle<LivePageDocV2>,
      change: (options: PageChangeOptions, change: ChangeFn<LivePageDocV2>) => {
        if (!options.message.trim()) throw new Error('A page change requires a message.');
        assertDocumentWritable(documentId);
        const fresh = this.openV2;
        if (
          fresh !== authority
          || this.state?.schemaVersion !== 3
          || fresh.loaded.get(documentId)?.handle !== loaded.handle
        ) throw new Error('The prepared page writer is stale; reacquire it from the active workspace.');
        handle.change(change, { message: options.message, time: options.time });
        return getSharedAutomergeSnapshot<LivePageDocV2>(handle.doc() as PageAutomergeDoc);
      },
    });
  }

  /**
   * Calls `listener` with the page snapshot after every change of a loaded
   * page. The page stays loaded while the subscription exists.
   */
  subscribeToPageChanges(
    pageId: string,
    listener: (page: LivePageDocV2) => void,
  ): () => void {
    const open = this.requireV2();
    const documentId = this.pageDocumentId(open, pageId);
    const loaded = open.loaded.get(documentId);
    if (!loaded) throw new Error(`Page ${pageId} is not loaded; load it before subscribing.`);
    loaded.retain += 1;
    const unsubscribeEvents = this.subscribeToDocumentChanges((event) => {
      if (event.documentId !== documentId || this.openV2 !== open) return;
      const current = open.loaded.get(documentId);
      if (!current) return;
      const snapshot = getSharedAutomergeSnapshot<LivePageDocV2>(current.handle.doc() as PageAutomergeDoc);
      if (snapshot.kind !== 'page' || snapshot.pageId !== pageId) {
        throw new Error(`Page change subscription for ${pageId} received another document.`);
      }
      listener(snapshot);
    });
    // Ink segments that reach this device after the page (from the cloud)
    // change what the page shows without changing its document.
    const onInkArrival = (arrived: string): void => {
      if (arrived !== documentId || this.openV2 !== open) return;
      const current = open.loaded.get(documentId);
      if (!current) return;
      listener(getSharedAutomergeSnapshot<LivePageDocV2>(current.handle.doc() as PageAutomergeDoc));
    };
    this.inkArrivalListeners.add(onInkArrival);
    let active = true;
    const unsubscribe = (): void => {
      if (!active) return;
      active = false;
      unsubscribeEvents();
      this.inkArrivalListeners.delete(onInkArrival);
      loaded.retain = Math.max(0, loaded.retain - 1);
      this.subscriptions.delete(unsubscribe);
      if (this.openV2 === open) void this.evictPages(open);
    };
    this.subscriptions.add(unsubscribe);
    return unsubscribe;
  }

  /**
   * Makes the ink segments a page references resident (memory, local store,
   * else the cloud) and, for a loaded page, keeps them resident. Resolves
   * with the segments that could not be found anywhere yet.
   */
  private async hydrateInk(document: CanvinkAutomergeDoc, pinOwner?: string): Promise<string[]> {
    if (document.kind !== 'page') return [];
    const hashes = referencedInkSegments(document);
    if (pinOwner) inkSegments().pin(pinOwner, hashes);
    if (hashes.length === 0) return [];
    // A page that is about to be shown does not wait long for the cloud: it opens with the ink it
    // has, and the rest is announced when it arrives. Readers that need everything wait for it.
    return inkSegments().ensure(hashes, pinOwner ? { remoteWaitMs: INK_OPEN_WAIT_MS } : {});
  }

  /** Tells the editors of loaded pages that segments they reference have arrived. */
  private announceArrivedSegments(open: OpenV2State, hashes: readonly string[]): void {
    if (this.openV2 !== open) return;
    const arrived = new Set(hashes);
    for (const loaded of open.loaded.values()) {
      if (loaded.kind !== 'page') continue;
      if (referencedInkSegments(loaded.handle.doc() as object).some((hash) => arrived.has(hash))) {
        this.announceInkArrival(loaded.documentId);
      }
    }
  }

  /** Retries segments the cloud did not have yet (the device that sealed them is still uploading). */
  private retryMissingInk(open: OpenV2State, documentId: string, hashes: readonly string[], attempt = 0): void {
    const delays = [1000, 3000, 8000, 20000, 60000, 120000];
    if (attempt >= delays.length || hashes.length === 0) return;
    const previous = this.inkRetryTimers.get(documentId);
    if (previous !== undefined) clearTimeout(previous);
    this.inkRetryTimers.set(documentId, setTimeout(() => {
      this.inkRetryTimers.delete(documentId);
      if (this.openV2 !== open || !open.loaded.has(documentId)) return;
      void inkSegments().ensure(hashes, { remoteWaitMs: INK_OPEN_WAIT_MS })
        .then((missing) => this.retryMissingInk(open, documentId, missing, attempt + 1))
        .catch(() => this.retryMissingInk(open, documentId, hashes, attempt + 1));
    }, delays[attempt]));
  }

  private announceInkArrival(documentId: string): void {
    for (const listener of [...this.inkArrivalListeners]) listener(documentId);
  }

  /** The page document as a target for sealing and compaction jobs. */
  private inkTarget(loaded: LoadedDocument): InkPageTarget {
    const handle = loaded.handle as unknown as DocHandle<LivePageDocV2>;
    return {
      read: () => {
        const document = handle.doc() as PageAutomergeDoc;
        return {
          page: sharedPlainSnapshot(document) as unknown as PlainInkPage,
          version: getAutomergeHeads<LiveCanvinkDocumentV2>(document).join(),
        };
      },
      change: (message, change) => {
        // Sealing and compacting ink rewrites the page; a reader's copy is only ever changed by the room.
        if (isDocumentReadOnly(loaded.documentId)) return false;
        try {
          handle.change((draft) => change(draft as never), { message });
          return true;
        } catch {
          return false;
        }
      },
    };
  }

  /**
   * Seals the strokes of a loaded page that were drawn but are not yet part
   * of its document, and waits until the reference is stored. A page that is
   * not loaded but has a journal (the app closed within the sealing delay)
   * is loaded for the purpose.
   */
  async sealPendingInk(documentId: string): Promise<number> {
    const open = this.openV2;
    if (!open || !open.documents.has(documentId)) return 0;
    let loaded = open.loaded.get(documentId);
    if (!loaded && pendingInk().count(documentId) > 0) loaded = await this.loadDocument(open, documentId);
    if (!loaded || loaded.kind !== 'page') return 0;
    const target = loaded;
    return this.withDocumentLock(documentId, async () => {
      if (this.openV2 !== open || open.loaded.get(documentId) !== target) return 0;
      const sealed = await sealPendingInk(this.inkTarget(target), documentId, inkSegments(), pendingInk());
      if (sealed > 0) {
        await open.session.repo.flush([target.storageId as DocumentId]);
        // The journal record stays until the document holding the segment reference is durable.
        await pendingInk().writeJournal(documentId);
      }
      return sealed;
    });
  }

  /** Seals every page's pending ink; called before saves, exports and shutdown. */
  async sealAllPendingInk(): Promise<void> {
    for (const documentId of pendingInk().documentsWithPendingInk()) {
      await this.sealPendingInk(documentId).catch(() => undefined);
    }
    await pendingInk().flushJournals();
  }

  private onPendingInk(documentId: string, count: number): void {
    const open = this.openV2;
    if (!open || !open.documents.has(documentId)) return;
    const previous = this.inkTimers.get(documentId);
    if (previous !== undefined) clearTimeout(previous);
    if (count === 0) {
      this.inkTimers.delete(documentId);
      return;
    }
    // Seal after the pen rests, or at once when a lot of ink is waiting.
    this.inkTimers.set(documentId, setTimeout(() => {
      this.inkTimers.delete(documentId);
      void this.runInkMaintenance(open, documentId);
    }, count >= INK_SEAL_BATCH ? 0 : INK_SEAL_DELAY_MS));
  }

  /** Looks at a page's segments again a while after it changed (erased strokes leave hidden ones behind). */
  private scheduleInkCompaction(open: OpenV2State, documentId: string): void {
    const previous = this.inkCompactionTimers.get(documentId);
    if (previous !== undefined) clearTimeout(previous);
    this.inkCompactionTimers.set(documentId, setTimeout(() => {
      this.inkCompactionTimers.delete(documentId);
      void this.runInkMaintenance(open, documentId);
    }, INK_COMPACTION_DELAY_MS));
  }

  /** Idle-time upkeep of a page's ink: seal what was drawn, rewrite segments that lost most of their strokes. */
  private async runInkMaintenance(open: OpenV2State, documentId: string): Promise<void> {
    if (this.openV2 !== open) return;
    try {
      await this.sealPendingInk(documentId);
      const loaded = open.loaded.get(documentId);
      if (!loaded || loaded.kind !== 'page') return;
      const target = this.inkTarget(loaded);
      const result = await this.withDocumentLock(documentId, () => compactPageInk(target, inkSegments()));
      if (result.rewritten > 0) await open.session.repo.flush([loaded.storageId as DocumentId]);
    } catch (error) {
      console.error('[workspace] ink maintenance failed', error);
    }
  }

  getMemoryDiagnostics(): RuntimeMemoryDiagnostics {
    const open = this.openV2;
    if (!open) return { loadedPages: 0, loadedNotebooks: 0, pageDocuments: 0 };
    const loaded = [...open.loaded.values()];
    return {
      loadedPages: loaded.filter((document) => document.kind === 'page').length,
      loadedNotebooks: loaded.filter((document) => document.kind === 'notebook').length,
      pageDocuments: open.summaries.size,
    };
  }

  migrateV1ToV2(): Promise<V2RuntimeState> {
    return this.runMutation(() => this.migrateV1ToV2Locked());
  }

  private async migrateV1ToV2Locked(): Promise<V2RuntimeState> {
    if (!this.state) await this.startup();
    if (this.state?.schemaVersion !== 1) return this.ensureSchemaV3Locked();
    if (!this.options.migrationFactory) {
      throw new Error('Schema-v2 migration is not configured for this runtime.');
    }
    try {
      await this.options.migrationFactory().run();
    } catch (migrationError) {
      // A native commit may have succeeded even when IPC lost its acknowledgement.
      // Re-read authority before leaving the caller in writable v1 mode.
      let reconciled: V2ActivationRecord | undefined;
      try {
        reconciled = await this.readActivationFirst();
      } catch (authorityError) {
        this.state = undefined;
        throw authorityError;
      }
      if (!reconciled) throw migrationError;
      try {
        await this.reopen(reconciled);
        return this.ensureSchemaV3Locked();
      } catch (activationError) {
        this.state = undefined;
        throw activationError;
      }
    }
    const activation = await this.readActivationFirst();
    if (!activation) throw new Error('Migration completed without schema-v2 activation.');
    await this.reopen(activation);
    return this.ensureSchemaV3Locked();
  }

  /**
   * Pure startup keeps a legacy v2 authority untouched. The first v0.2 write
   * calls this method and publishes all document version changes plus the
   * manifest/activation selector in one checked revision.
   */
  ensureSchemaV3(): Promise<V2RuntimeState> {
    return this.runMutation(() => this.ensureSchemaV3Locked());
  }

  private async ensureSchemaV3Locked(): Promise<V2RuntimeState> {
    if (!this.state) await this.startup();
    if (this.state?.schemaVersion === 1) return this.migrateV1ToV2Locked();
    const open = this.requireV2();
    if (open.activation.schemaVersion === 3) return this.getState() as V2RuntimeState;
    return this.upgradeLegacyV2Workspace(open);
  }

  /**
   * Writes every loaded document. `seal: false` leaves unsealed ink in its
   * journal: sealing deletes the journal record once the segment is stored,
   * and a page that is closing can be cut off before the document that
   * refers to the segment is written, which would lose the strokes.
   */
  async flush(options: { seal?: boolean } = {}): Promise<void> {
    const open = this.openV2;
    if (!open) return;
    if (options.seal !== false) await this.sealAllPendingInk();
    await this.flushLoaded(open);
    for (const loaded of [...open.loaded.values()]) {
      if (loaded.kind === 'page') await this.writeLoadedIndex(open, loaded);
    }
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    try {
      await this.closeV2Session();
      this.state = undefined;
      this.writeAccess = undefined;
    } finally {
      this.shuttingDown = false;
    }
  }

  /**
   * The schema-v1 rollback backup, read and verified on demand: opening the
   * workspace no longer reads it, so a damaged backup only blocks the
   * rollback copy, not the notes.
   */
  async getV1Backup(): Promise<V1BackupRecord | null> {
    const open = this.openV2;
    if (!open) return null;
    const store = this.options.activationStore;
    try {
      if (store.readBackup) return structuredClone(await store.readBackup(open.activation));
      return structuredClone((await store.readCommitted(open.activation)).backup);
    } catch (error) {
      throw new WorkspaceV2RecoveryRequiredError(
        'committed-payload-corrupt',
        'The schema-v1 rollback backup of this workspace is missing or corrupt.',
        { cause: error, activation: open.activation },
      );
    }
  }

  async createV1RollbackCopy(): Promise<WorkspaceState> {
    const backup = await this.getV1Backup();
    if (!backup) throw new Error('No activated schema-v1 rollback backup is available.');
    const copy = structuredClone(backup.workspace);
    assertWorkspaceShape(copy);
    return copy;
  }

  /**
   * Adds a notebook with all its pages in one additive commit. It is the
   * compatibility entry point for callers that hold every page in memory;
   * large imports use `beginAdditiveImport` to hand over one page at a time.
   */
  extendActiveWorkspace(
    request: ExtendActiveWorkspaceRequest,
  ): Promise<ExtendActiveWorkspaceResult> {
    return this.runMutation(async () => {
      await this.ensureSchemaV3Locked();
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(request.importId)) {
        throw new Error('An import ID must be a bounded canonical identifier.');
      }
      if (request.pages.length === 0) throw new Error('An imported notebook requires at least one page.');
      const existing = await this.existingImportResult(request.importId, request.importArtifactFingerprint);
      if (existing) return existing;
      const writer = await this.createImportWriter({
        importId: request.importId,
        preparedAt: request.preparedAt,
        notebook: request.notebook,
        expectedActivationArtifactFingerprint: request.expectedActivationArtifactFingerprint,
      });
      try {
        await writer.addAssets(request.assets);
        for (const page of request.pages) await writer.addPage(page);
        return await writer.commitLocked(request.importArtifactFingerprint);
      } catch (error) {
        await writer.abort().catch(() => undefined);
        throw error;
      }
    });
  }

  /**
   * Starts a streaming additive import. Staging runs outside the mutation
   * queue so the workspace stays usable; `commit` takes the queue for the
   * short delta commit.
   */
  async beginAdditiveImport(options: AdditiveImportOptions): Promise<AdditiveImportWriter> {
    await this.ensureSchemaV3();
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(options.importId)) {
      throw new Error('An import ID must be a bounded canonical identifier.');
    }
    const writer = await this.createImportWriter(options);
    return {
      addAssets: (assets) => writer.addAssets(assets),
      addPage: (page) => writer.addPage(page),
      progress: () => writer.progress(),
      commit: (fingerprint) => this.runMutation(async () => {
        const existing = await this.existingImportResult(options.importId, fingerprint);
        if (existing) {
          await writer.abort().catch(() => undefined);
          return existing;
        }
        return writer.commitLocked(fingerprint);
      }),
      abort: () => writer.abort(),
    };
  }

  /**
   * The result of an import that was already committed under this ID, for
   * a retry whose acknowledgement was lost. Undefined when there is none;
   * throws when the ID belongs to another artifact or was rolled back.
   */
  findCommittedImport(
    importId: string,
    importArtifactFingerprint: Sha256Checksum,
  ): Promise<ExtendActiveWorkspaceResult | undefined> {
    return this.existingImportResult(importId, importArtifactFingerprint);
  }

  private async existingImportResult(
    importId: string,
    importArtifactFingerprint: Sha256Checksum,
  ): Promise<ExtendActiveWorkspaceResult | undefined> {
    const existingReceipt = await this.options.activationStore.getWorkspaceImportReceipt?.(importId);
    if (!existingReceipt) return undefined;
    if (existingReceipt.importArtifactFingerprint !== importArtifactFingerprint) {
      throw new Error(`Import ID ${importId} was already used for another artifact.`);
    }
    if (existingReceipt.status === 'rolled-back') {
      throw new Error(`Import ${importId} was rolled back and cannot be replayed.`);
    }
    return {
      status: 'already-committed',
      importId: existingReceipt.importId,
      artifactFingerprint: existingReceipt.committedActivationArtifactFingerprint,
      backupId: existingReceipt.backupId,
      notebookDocumentId: existingReceipt.notebookDocumentId,
      pageDocumentIds: structuredClone(existingReceipt.pageDocumentIds),
      assetIds: structuredClone(existingReceipt.assetIds),
    };
  }

  private async createImportWriter(options: AdditiveImportOptions) {
    const store = this.options.activationStore;
    if (!store.commitWorkspaceDelta || !store.stageWorkspaceEntries) {
      throw new Error('This platform has no delta workspace commit.');
    }
    const stageEntries = store.stageWorkspaceEntries.bind(store);
    const startOpen = this.requireV2();
    if (startOpen.activation.schemaVersion !== 3) throw new Error('Imports require schema v3.');
    if (
      options.expectedActivationArtifactFingerprint
      && options.expectedActivationArtifactFingerprint !== startOpen.activation.artifactFingerprint
    ) throw new Error('The active workspace changed after the import preview was prepared.');
    const { pageDocumentIds, sectionIds } = assertImportedNotebook(options.notebook, startOpen.activation);
    const notebookProjection = structuredClone(options.notebook);
    const batchBytes = options.batchBytes ?? DEFAULT_IMPORT_BATCH_BYTES;
    const added = new Map<string, { storageId: string; url: string; heads: string[]; summary: PageSummary; descriptor: RepoChunkDescriptorV2 }>();
    const knownAssets = new Set<string>(startOpen.activation.assetIds);
    const addedAssets = new Set<Sha256Checksum>();
    const stagedPrefixes: string[][] = [];
    let pending: WorkspaceStorageEntry[] = [];
    let pendingBytes = 0;
    let stagedBytes = 0;
    let finished = false;

    const flushPending = async (): Promise<void> => {
      if (pending.length === 0) return;
      const batch = pending;
      pending = [];
      pendingBytes = 0;
      await stageEntries(batch, []);
    };
    const assertOpen = (): void => {
      if (finished) throw new Error('This import was already committed or aborted.');
    };

    const writer = {
      progress: (): AdditiveImportProgress => ({ pages: added.size, assets: addedAssets.size, stagedBytes }),
      addAssets: async (assets: readonly AssetBlob[]): Promise<void> => {
        assertOpen();
        const fresh = assets.filter((asset) => !knownAssets.has(asset.assetId));
        if (fresh.length === 0) return;
        for (const asset of fresh) {
          if (
            asset.assetId !== asset.checksum
            || asset.size !== asset.bytes.byteLength
            || await sha256Bytes(asset.bytes) !== asset.assetId
          ) throw new Error(`Imported asset ${asset.assetId} failed integrity verification.`);
        }
        await stageEntries([], [...fresh]);
        for (const asset of fresh) {
          knownAssets.add(asset.assetId);
          addedAssets.add(asset.assetId);
          stagedBytes += asset.bytes.byteLength;
        }
      },
      addPage: async (page: PageDoc | PageDocV3): Promise<void> => {
        assertOpen();
        if (page.schemaVersion !== notebookProjection.schemaVersion) {
          throw new Error('Imported notebook and pages must use one matching schema version.');
        }
        if (
          page.documentId !== `page:${page.pageId}`
          || page.notebookId !== notebookProjection.notebookId
          || !sectionIds.has(page.sectionId)
          || !pageDocumentIds.has(page.documentId)
          || !notebookProjection.sections.find((section) => section.id === page.sectionId)
            ?.pageDocumentIds.includes(page.documentId)
          || added.has(page.documentId)
        ) throw new Error(`Imported page ${page.documentId} has an invalid notebook graph.`);
        if (elementAssetIds(page).some((assetId) => !knownAssets.has(assetId))) {
          throw new Error(`Imported page ${page.documentId} references an unavailable asset.`);
        }
        const { url, storageId } = newDocumentUrl();
        const created = await createDocumentBytes(
          page,
          3,
          await deterministicActor('canvink-v2-additive-import-actor', options.importId, page.documentId),
          true,
        );
        if (!created.summary) throw new Error(`Imported page ${page.documentId} is not a page.`);
        const logicalKey = [storageId, 'snapshot', await headsHash(created.heads)];
        const entry: PageIndexEntry = {
          version: PAGE_INDEX_VERSION,
          storageId,
          documentId: page.documentId,
          activationHeads: created.heads,
          summary: created.summary,
        };
        stagedPrefixes.push(...documentPrefixes(storageId));
        pending.push(
          { key: toPhysical(logicalKey), bytes: created.bytes },
          { key: indexKey(storageId), bytes: encodePageIndexEntry(entry) },
        );
        pendingBytes += created.bytes.byteLength;
        stagedBytes += created.bytes.byteLength;
        added.set(page.documentId, {
          storageId,
          url,
          heads: created.heads,
          summary: created.summary,
          descriptor: {
            key: logicalKey,
            checksum: await sha256Bytes(created.bytes),
            size: created.bytes.byteLength,
          },
        });
        if (pendingBytes >= batchBytes) await flushPending();
      },
      abort: async (): Promise<void> => {
        if (finished) return;
        finished = true;
        pending = [];
        const open = this.openV2;
        if (!open || stagedPrefixes.length === 0) return;
        // Staged documents are unreferenced; removing them only reclaims space.
        await this.removeStagedPrefixes(open, stagedPrefixes).catch(() => undefined);
      },
      commitLocked: async (importArtifactFingerprint: Sha256Checksum): Promise<ExtendActiveWorkspaceResult> => {
        assertOpen();
        for (const documentId of pageDocumentIds) {
          if (!added.has(documentId)) {
            throw new Error('The imported notebook must reference every imported page exactly once.');
          }
        }
        await flushPending();
        const open = this.requireV2();
        if (
          options.expectedActivationArtifactFingerprint
          && options.expectedActivationArtifactFingerprint !== open.activation.artifactFingerprint
        ) throw new Error('The active workspace changed after the import preview was prepared.');
        assertImportedNotebook(notebookProjection, open.activation);
        const notebookUrl = newDocumentUrl();
        const notebookCreated = await createDocumentBytes(
          notebookProjection,
          3,
          await deterministicActor('canvink-v2-additive-import-actor', options.importId, notebookProjection.documentId),
          true,
        );
        const notebookKey = [notebookUrl.storageId, 'snapshot', await headsHash(notebookCreated.heads)];
        const pageIds = notebookProjection.sections.flatMap((section) => section.pageDocumentIds);
        const newDocuments: ActivatedDocumentV2[] = [
          { documentId: notebookProjection.documentId, kind: 'notebook', url: notebookUrl.url, heads: notebookCreated.heads },
          ...pageIds.map((documentId) => {
            const page = added.get(documentId)!;
            return { documentId, kind: 'page' as const, url: page.url, heads: page.heads };
          }),
        ];
        const assetIds = [...new Set([...open.activation.assetIds, ...addedAssets])].sort();
        const chunks = [
          ...open.activation.chunks,
          {
            key: notebookKey,
            checksum: await sha256Bytes(notebookCreated.bytes),
            size: notebookCreated.bytes.byteLength,
          },
          ...pageIds.map((documentId) => added.get(documentId)!.descriptor),
        ];
        const documents = [...open.activation.documents, ...newDocuments];
        const manifest = {
          ...structuredClone(open.activation.manifest),
          notebookDocumentIds: [...open.activation.manifest.notebookDocumentIds, notebookProjection.documentId],
          pageDocumentIds: [...open.activation.manifest.pageDocumentIds, ...pageIds],
          assetIds,
        } as WorkspaceManifest;
        const artifactFingerprint = await sha256Canonical({
          namespace: 'canvink-v2-additive-workspace-import',
          priorArtifactFingerprint: open.activation.artifactFingerprint,
          importId: options.importId,
          importArtifactFingerprint,
          documents,
          chunks,
          assetIds,
        });
        const activation: V2ActivationRecord = {
          ...structuredClone(open.activation),
          layout: 'repo-live',
          artifactFingerprint,
          activatedAt: options.preparedAt,
          manifest,
          documents,
          chunks,
          assetIds,
        };
        const notebooks = this.loadedNotebooks(open);
        notebooks.set(notebookProjection.documentId, notebookCreated.notebook!);
        const summaries = new Map(open.summaries);
        for (const [documentId, page] of added) summaries.set(documentId, page.summary);
        validateWorkspaceGraph(activation, notebooks, summaries);
        const receipt: V2WorkspaceImportReceipt = {
          version: 1,
          importId: options.importId,
          importArtifactFingerprint,
          priorActivationArtifactFingerprint: open.activation.artifactFingerprint,
          committedActivationArtifactFingerprint: artifactFingerprint,
          backupId: `import-backup:${options.importId}`,
          notebookDocumentId: notebookProjection.documentId,
          pageDocumentIds: pageIds,
          assetIds: [...addedAssets],
          preparedAt: options.preparedAt,
          status: 'committed',
          rollback: {
            mode: 'remove-prefixes',
            prefixes: [...stagedPrefixes, ...documentPrefixes(notebookUrl.storageId)],
          },
        };
        let status: ExtendActiveWorkspaceResult['status'];
        try {
          status = await store.commitWorkspaceDelta!({
            expectedActivation: open.activation,
            activation,
            assets: [],
            entries: [{ key: toPhysical(notebookKey), bytes: notebookCreated.bytes }],
            removedPrefixes: [],
            receipt,
          });
        } catch (error) {
          const reconciled = await this.readActivationFirst().catch(() => undefined);
          if (!reconciled || reconciled.artifactFingerprint !== artifactFingerprint) throw error;
          status = 'already-committed';
        }
        finished = true;
        await this.adoptCommittedActivation(open, activation, {
          newNotebooks: [{ documentId: notebookProjection.documentId, url: notebookUrl.url }],
          summaries: [...added.values()].map((page) => page.summary),
          origin: { kind: 'topology' },
          added: newDocuments,
        });
        return {
          status,
          importId: options.importId,
          artifactFingerprint,
          backupId: receipt.backupId,
          notebookDocumentId: notebookProjection.documentId,
          pageDocumentIds: pageIds,
          assetIds: [...addedAssets],
        };
      },
    };
    return writer;
  }

  private async removeStagedPrefixes(open: OpenV2State, prefixes: readonly string[][]): Promise<void> {
    for (const prefix of prefixes) {
      if (prefix[0] === REPO_NAMESPACE) {
        const chunks = await open.session.storage.loadRange(prefix.slice(1));
        if (chunks.length > 0) {
          await open.session.storage.commitAtomically({
            repo: chunks.map((chunk) => ({ type: 'remove' as const, key: chunk.key })),
          });
        }
      } else {
        const records = await open.session.storage.loadShared(prefix);
        if (records.length > 0) {
          await open.session.storage.commitAtomically({
            shared: records.map((record) => ({ type: 'remove' as const, key: record.key })),
          });
        }
      }
    }
  }

  rollbackWorkspaceImport(
    importId: string,
  ): Promise<'rolled-back' | 'already-rolled-back'> {
    return this.runMutation(() => this.rollbackWorkspaceImportLocked(importId));
  }

  private async rollbackWorkspaceImportLocked(
    importId: string,
  ): Promise<'rolled-back' | 'already-rolled-back'> {
    await this.ensureSchemaV3Locked();
    const open = this.requireV2();
    if (!this.options.activationStore.rollbackWorkspaceImport) {
      throw new Error('This platform has no atomic schema-v2 import rollback transaction.');
    }
    await this.closeV2Session();
    let status: 'rolled-back' | 'already-rolled-back';
    try {
      status = await this.options.activationStore.rollbackWorkspaceImport(importId);
    } catch (error) {
      const restoredActivation = await this.readActivationFirst() ?? open.activation;
      await this.reopen(restoredActivation);
      throw error;
    }
    const activation = await this.readActivationFirst();
    if (!activation) {
      this.state = undefined;
      throw new WorkspaceV2RecoveryRequiredError(
        'activation-invalid',
        'Import rollback removed schema-v2 authority.',
      );
    }
    await this.reopen(activation);
    return status;
  }

  async commitWorkspaceGraphRevision(
    request: WorkspaceGraphRevisionRequest,
  ): Promise<V2RuntimeState> {
    // A notebook shared read-only is changed by the room alone (adopted and removed documents come
    // from there); an edit of this device is refused here, whatever UI or job asked for it.
    for (const change of request.changes ?? []) assertDocumentWritable(change.documentId);
    // A page this revision changes must be stored first. Downloading it needs the
    // mutation queue for its own commit, so it happens before this one takes its turn.
    for (const change of request.changes ?? []) await this.ensureContent(change.documentId);
    return this.runMutation(async () => {
      await this.ensureSchemaV3Locked();
      return this.commitDeltaRevision(request);
    });
  }

  /**
   * A topology transaction that touches only the documents it names. Changed
   * documents are updated on detached copies (loaded from storage when they
   * are not in memory) and stored as one incremental chunk each; new and
   * adopted documents get a snapshot chunk; removed documents lose all
   * their keys. The activation is published with those writes in one
   * compare-and-swap storage transaction. Nothing else is read or reloaded.
   */
  private async commitDeltaRevision(request: WorkspaceGraphRevisionRequest): Promise<V2RuntimeState> {
    const open = this.requireV2();
    const store = this.options.activationStore;
    if (!store.commitWorkspaceDelta) {
      throw new Error('This platform has no atomic delta topology transaction.');
    }
    if (!request.message.trim() || !request.operationId.trim()) {
      throw new Error('A topology transaction requires an operation ID and message.');
    }
    const rebased = request.expectedActivationArtifactFingerprint !== open.activation.artifactFingerprint;
    if (rebased && request.onConflict === 'fail') {
      throw new Error('The active workspace changed before the topology transaction.');
    }
    const schemaVersion = open.activation.schemaVersion;
    // A rebased removal of a document another commit already removed has nothing left to do.
    const removed = new Set((request.removedDocumentIds ?? []).filter(
      (documentId) => !rebased || open.documents.has(documentId),
    ));
    for (const documentId of removed) {
      if (!open.documents.has(documentId)) throw new Error(`Revision removes unknown document ${documentId}.`);
    }
    const changeIds = (request.changes ?? []).map((change) => change.documentId);
    if (new Set(changeIds).size !== changeIds.length) {
      throw new Error('A document may change only once per revision.');
    }
    for (const documentId of changeIds) {
      if (!open.documents.has(documentId)) throw new Error(`Revision targets unknown document ${documentId}.`);
    }
    const staged = new Map<string, StagedDocument>();
    const addedDocuments: StagedDocument[] = [];
    try {
      await this.flushLoaded(open);
      for (const change of request.changes ?? []) {
        const expected = open.documents.get(change.documentId)!;
        const storageId = this.requireStorageId(open, change.documentId);
        const base = await this.checkoutDocument(open, change.documentId);
        const before = getAutomergeHeads<LiveCanvinkDocumentV2>(base);
        let after: CanvinkAutomergeDoc;
        try {
          after = Automerge.change(base, { message: request.message }, change.change);
        } catch (error) {
          freeDocument(base);
          throw error;
        }
        assertCanvinkAutomergeDocument(after);
        if (after.documentId !== expected.documentId || after.kind !== expected.kind) {
          freeDocument(after);
          throw new Error(`Revision changed identity of ${expected.documentId}.`);
        }
        const heads = getAutomergeHeads<LiveCanvinkDocumentV2>(after);
        const record: StagedDocument = {
          documentId: change.documentId,
          kind: expected.kind,
          storageId,
          url: expected.url,
          heads,
          document: after,
          isNew: false,
        };
        if (!sameHeadSet(before, heads)) {
          const delta = Automerge.saveSince(after, before);
          record.entry = { key: [storageId, 'incremental', await chunkHash(delta)], bytes: delta };
        }
        if (after.kind === 'page') record.summary = summarizePageDocument(after as PageAutomergeDoc);
        else record.notebook = getSharedAutomergeSnapshot<LiveCanvinkDocumentV2>(after) as LiveNotebookDocV2;
        staged.set(change.documentId, record);
      }
      const newProjections = assertGraphRevisionDocumentSchemas(request.newDocuments ?? [], schemaVersion);
      const actorScope = await sha256Canonical({
        namespace: 'canvink-v2-workspace-revision-materialization',
        operationId: request.operationId,
        priorArtifactFingerprint: open.activation.artifactFingerprint,
      });
      for (const projection of newProjections) {
        if (open.documents.has(projection.documentId) && !removed.has(projection.documentId)) {
          throw new Error(`New document ${projection.documentId} collides with an existing root.`);
        }
        const created = await createDocumentBytes(
          projection,
          schemaVersion,
          await deterministicActor('canvink-v2-additive-import-actor', actorScope, projection.documentId),
          false,
        );
        const { url, storageId } = newDocumentUrl();
        addedDocuments.push({
          documentId: projection.documentId,
          kind: projection.kind,
          storageId,
          url,
          heads: created.heads,
          entry: { key: [storageId, 'snapshot', await headsHash(created.heads)], bytes: created.bytes },
          summary: created.summary,
          notebook: created.notebook,
          isNew: true,
        });
      }
      for (const adopted of request.adoptedDocuments ?? []) {
        if (open.documents.has(adopted.documentId) && !removed.has(adopted.documentId)) {
          throw new Error(`New document ${adopted.documentId} collides with an existing root.`);
        }
      }
      // Loading and summarising an adopted page is the expensive part, so it
      // runs in worker threads; a document the workers could not prepare is
      // loaded here as before, which also reports it if it is broken.
      const prepared = await prepareAdoptedDocuments(request.adoptedDocuments ?? [], schemaVersion);
      for (const adopted of request.adoptedDocuments ?? []) {
        const ready = prepared.get(adopted.documentId);
        if (ready) {
          // Bytes that are one complete save of exactly the prepared heads are stored as they are.
          const savedHeads = ready.saved ? undefined : readSavedDocumentHeads(adopted.bytes);
          const bytes = ready.saved ?? (savedHeads && sameHeadSet(savedHeads, ready.heads) ? adopted.bytes : undefined);
          if (bytes) {
            const { url, storageId } = newDocumentUrl();
            addedDocuments.push({
              documentId: adopted.documentId,
              kind: adopted.kind,
              storageId,
              url,
              heads: ready.heads,
              entry: { key: [storageId, 'snapshot', await headsHash(ready.heads)], bytes },
              ...(ready.summary ? { summary: deepFreeze(ready.summary) } : {}),
              ...(ready.notebook ? { notebook: deepFreeze(ready.notebook) } : {}),
              isNew: true,
            });
            continue;
          }
        }
        const document = loadAutomergeDocument(adopted.bytes, {
          expectedDocumentId: adopted.documentId,
          expectedKind: adopted.kind,
          expectedSchemaVersion: schemaVersion,
        });
        try {
          const heads = getAutomergeHeads<LiveCanvinkDocumentV2>(document);
          const bytes = Automerge.save(document);
          const { url, storageId } = newDocumentUrl();
          addedDocuments.push({
            documentId: adopted.documentId,
            kind: adopted.kind,
            storageId,
            url,
            heads,
            entry: { key: [storageId, 'snapshot', await headsHash(heads)], bytes },
            ...(document.kind === 'page'
              ? { summary: summarizePageDocument(document as PageAutomergeDoc) }
              : { notebook: getSharedAutomergeSnapshot<LiveCanvinkDocumentV2>(document) as LiveNotebookDocV2 }),
            isNew: true,
          });
        } finally {
          freeDocument(document);
        }
      }
      for (const placeholder of request.placeholderPages ?? []) {
        if (open.documents.has(placeholder.documentId) && !removed.has(placeholder.documentId)) {
          throw new Error(`Placeholder page ${placeholder.documentId} collides with an existing root.`);
        }
        if (placeholder.summary.documentId !== placeholder.documentId || placeholder.summary.heads.length === 0) {
          throw new Error(`Placeholder page ${placeholder.documentId} has no usable summary.`);
        }
        const { url, storageId } = newDocumentUrl();
        addedDocuments.push({
          documentId: placeholder.documentId,
          kind: 'page',
          storageId,
          url,
          heads: [...placeholder.summary.heads],
          summary: deepFreeze(placeholder.summary),
          isNew: true,
          placeholder: true,
        });
      }
      const addedIds = addedDocuments.map((document) => document.documentId);
      if (new Set(addedIds).size !== addedIds.length) {
        throw new Error('A revision adds the same document twice.');
      }
      for (const documentId of changeIds) {
        if (removed.has(documentId)) throw new Error(`Revision both changes and removes ${documentId}.`);
      }

      const manifest = request.replacementManifest
        ? structuredClone(request.replacementManifest)
        : structuredClone(open.activation.manifest);
      request.updateManifest?.(manifest);
      if (manifest.schemaVersion !== schemaVersion) {
        throw new Error(`A topology transaction cannot change active schema v${schemaVersion} to v${manifest.schemaVersion}; downgrade and implicit upgrade are refused.`);
      }
      const assetIds = [...new Set([
        ...open.activation.assetIds,
        ...(request.assets ?? []).map((asset) => asset.assetId),
      ])].sort();
      manifest.assetIds = assetIds;

      const touchedStorageIds = new Set<string>([
        ...[...staged.values()].filter((document) => document.entry).map((document) => document.storageId),
        ...[...removed].map((documentId) => this.requireStorageId(open, documentId)),
      ]);
      // The open activation is deeply frozen, so its entries are shared instead of copied: copying
      // every document of a notebook with hundreds of pages made each commit cost as much as the
      // whole notebook.
      const documents: ActivatedDocumentV2[] = [];
      for (const document of open.activation.documents) {
        if (removed.has(document.documentId)) continue;
        const changed = staged.get(document.documentId);
        documents.push(changed ? { ...document, heads: [...changed.heads] } : document);
      }
      for (const document of addedDocuments) {
        documents.push({ documentId: document.documentId, kind: document.kind, url: document.url, heads: [...document.heads] });
      }
      const writes = [...staged.values(), ...addedDocuments].filter((document) => document.entry);
      const chunks: RepoChunkDescriptorV2[] = [
        ...open.activation.chunks.filter((chunk) => !touchedStorageIds.has(chunk.key[0] ?? '')),
      ];
      for (const document of writes) {
        chunks.push({
          key: [...document.entry!.key],
          checksum: await sha256Bytes(document.entry!.bytes),
          size: document.entry!.bytes.byteLength,
        });
      }
      // The fingerprint chains from the prior one, so it commits to what this revision adds,
      // changes and removes instead of hashing the whole workspace again.
      const { notebookDocumentIds, pageDocumentIds, ...manifestRest } = manifest;
      const artifactFingerprint = await sha256Canonical({
        namespace: 'canvink-v3-workspace-revision-delta',
        operationId: request.operationId,
        priorArtifactFingerprint: open.activation.artifactFingerprint,
        changed: [...staged.values()].map((document) => ({ documentId: document.documentId, heads: document.heads })),
        added: addedDocuments.map((document) => ({ documentId: document.documentId, url: document.url, heads: document.heads })),
        removed: [...removed].sort(),
        written: writes.map((document) => document.entry!.key),
        manifest: { ...manifestRest, notebookCount: notebookDocumentIds.length, pageCount: pageDocumentIds.length },
        assetCount: assetIds.length,
      });
      const activation: V2ActivationRecord = {
        ...open.activation,
        layout: 'repo-live',
        artifactFingerprint,
        activatedAt: request.activatedAt ?? new Date().toISOString(),
        manifest,
        documents,
        chunks,
        assetIds,
      };
      assertActivationShape(activation);

      const notebooks = this.loadedNotebooks(open);
      const summaries = new Map(open.summaries);
      for (const documentId of removed) {
        notebooks.delete(documentId);
        summaries.delete(documentId);
      }
      for (const document of [...staged.values(), ...addedDocuments]) {
        if (document.notebook) notebooks.set(document.documentId, document.notebook);
        if (document.summary) summaries.set(document.documentId, document.summary);
      }
      // A notebook another device changed lists pages this device has not adopted yet (the
      // notebook arrives as a remote change, its pages with the next adoption). That is sync's
      // state, not this commit's: a listed page that was already dangling before the commit is
      // left out of the check, while anything the commit itself lists must exist.
      const danglingBefore = new Set<string>();
      for (const notebook of this.loadedNotebooks(open).values()) {
        for (const section of notebook.sections) {
          for (const pageId of section.pageDocumentIds) if (!open.summaries.has(pageId)) danglingBefore.add(pageId);
        }
      }
      if (danglingBefore.size > 0) {
        for (const [documentId, notebook] of notebooks) {
          notebooks.set(documentId, {
            ...notebook,
            sections: notebook.sections.map((section) => ({
              ...section,
              pageDocumentIds: section.pageDocumentIds.filter((pageId) => summaries.has(pageId) || !danglingBefore.has(pageId)),
            })),
          });
        }
      }
      validateWorkspaceGraph(activation, notebooks, summaries);

      const entries: WorkspaceStorageEntry[] = [];
      for (const document of writes) {
        entries.push({ key: toPhysical(document.entry!.key), bytes: document.entry!.bytes });
      }
      const removedPrefixes: string[][] = [];
      for (const documentId of removed) removedPrefixes.push(...documentPrefixes(this.requireStorageId(open, documentId)));
      for (const document of [...staged.values(), ...addedDocuments]) {
        if (!document.summary) continue;
        if (!document.isNew && open.loaded.has(document.documentId)) continue;
        entries.push({
          key: indexKey(document.storageId),
          bytes: encodePageIndexEntry({
            version: PAGE_INDEX_VERSION,
            storageId: document.storageId,
            documentId: document.documentId,
            activationHeads: document.heads,
            ...(document.placeholder ? { placeholder: true as const } : {}),
            summary: document.summary,
          }),
        });
        // A detached copy was built from every stored chunk, so its fresh
        // index entry covers every dirty marker the document had.
        if (!document.isNew) removedPrefixes.push([DIRTY_NAMESPACE, document.storageId]);
      }
      // Removed documents leave the Repo before their keys are deleted, so a
      // pending save cannot write them back afterwards.
      for (const documentId of removed) await this.evictDocument(open, documentId, { flush: false });

      try {
        await store.commitWorkspaceDelta({
          expectedActivation: open.activation,
          activation,
          assets: request.assets ?? [],
          entries,
          removedPrefixes,
        });
      } catch (error) {
        const reconciled = await this.readActivationFirst().catch(() => undefined);
        if (!reconciled || reconciled.artifactFingerprint !== artifactFingerprint) throw error;
      }

      // Loaded documents catch up with the committed change in memory; the
      // Repo stores the merged change again as an ordinary incremental save.
      for (const document of staged.values()) {
        const loaded = open.loaded.get(document.documentId);
        if (!loaded || !document.entry || !document.document) continue;
        const stagedDocument = document.document;
        this.pendingOrigin = { kind: 'topology' };
        try {
          loaded.handle.update((current) => Automerge.merge(current, stagedDocument));
        } finally {
          this.pendingOrigin = undefined;
        }
      }
      const unloadedChanges = [...staged.values()].filter((document) =>
        document.entry && !open.loaded.has(document.documentId));
      await this.adoptCommittedActivation(open, activation, {
        newNotebooks: addedDocuments
          .filter((document) => document.kind === 'notebook')
          .map((document) => ({ documentId: document.documentId, url: document.url })),
        summaries: [...staged.values(), ...addedDocuments].flatMap((document) =>
          document.summary && !open.loaded.has(document.documentId) ? [document.summary] : []),
        origin: { kind: 'topology' },
        emitted: unloadedChanges,
        added: addedDocuments.filter((document) => !document.placeholder),
        placeholderIds: addedDocuments.filter((document) => document.placeholder).map((document) => document.documentId),
        storedIds: addedDocuments.filter((document) => document.entry).map((document) => document.documentId),
        ownsActivation: true,
      });
      return this.getState() as V2RuntimeState;
    } finally {
      for (const document of staged.values()) freeDocument(document.document);
    }
  }

  /**
   * Replaces the in-memory activation after a delta commit without reopening
   * anything: new notebooks are loaded, summaries of written pages replace
   * the old ones, removed documents disappear, navigation stays where it was
   * unless the commit moved it or removed the page.
   */
  private async adoptCommittedActivation(
    open: OpenV2State,
    activation: V2ActivationRecord,
    changes: {
      newNotebooks: Array<{ documentId: string; url: string }>;
      summaries: PageSummary[];
      origin: DocumentChangeOrigin;
      emitted?: StagedDocument[];
      added?: Array<{ documentId: string; kind: 'notebook' | 'page'; heads: readonly string[] }>;
      /** Documents this commit added as placeholders; the others it added are stored. */
      placeholderIds?: string[];
      storedIds?: string[];
      /** The caller built `activation` from frozen parts and keeps no reference to change it, so it is frozen as it is. */
      ownsActivation?: boolean;
    },
  ): Promise<void> {
    const previousActive = open.activation.manifest.active;
    open.activation = deepFreeze(changes.ownsActivation ? activation : structuredClone(activation));
    open.documents = new Map(activation.documents.map((document) => [document.documentId, document]));
    for (const documentId of [...open.placeholders]) {
      if (!open.documents.has(documentId)) open.placeholders.delete(documentId);
    }
    for (const documentId of changes.storedIds ?? []) open.placeholders.delete(documentId);
    for (const documentId of changes.placeholderIds ?? []) open.placeholders.add(documentId);
    // Looked up through the URL cache, so a commit does not decode and hash every page's URL again.
    open.storageIds = new Map(activation.documents.map((document) => [document.documentId, storageIdOfUrl(document.url)]));
    for (const documentId of [...open.summaries.keys()]) {
      if (!open.documents.has(documentId)) open.summaries.delete(documentId);
    }
    for (const summary of changes.summaries) open.summaries.set(summary.documentId, summary);
    for (const [documentId, loaded] of [...open.loaded]) {
      if (!open.documents.has(documentId)) {
        loaded.detach();
        open.loaded.delete(documentId);
      }
    }
    for (const notebook of changes.newNotebooks) {
      await this.loadDocument(open, notebook.documentId, { waitForContent: false });
    }
    this.rebuildPageLookup(open);
    for (const document of changes.emitted ?? []) {
      if (!document.document) continue;
      this.emitDocumentChange({
        documentId: document.documentId,
        kind: document.kind,
        beforeHeads: [],
        heads: document.heads,
        origin: changes.origin,
        document: document.document,
      });
    }
    for (const document of changes.added ?? []) {
      this.emitDocumentChange({
        documentId: document.documentId,
        kind: document.kind,
        beforeHeads: [],
        heads: document.heads,
        origin: changes.origin,
        added: true,
      });
    }
    const storedTargetChanged = JSON.stringify(previousActive) !== JSON.stringify(activation.manifest.active);
    let target = open.active;
    if (storedTargetChanged) target = structuredClone(activation.manifest.active);
    try {
      this.resolveTarget(open, target);
    } catch {
      target = structuredClone(activation.manifest.active);
    }
    let documentId = this.resolveTarget(open, target);
    if (open.placeholders.has(documentId)) {
      // The commit left the workspace pointing at a page that is only listed. A commit inside
      // the mutation queue cannot wait for its download, so the view goes to a page that is stored.
      const fallback = this.firstAvailableTarget(open);
      if (!fallback) throw new PageNotDownloadedError(documentId, 'The workspace has no downloaded page to open.');
      target = fallback;
      documentId = this.resolveTarget(open, target);
    }
    await this.loadDocument(open, documentId, { waitForContent: false });
    open.active = structuredClone(target);
    this.touch(open, documentId);
    this.publishState(open);
    this.resolveContentWaiters(open);
    void this.evictPages(open);
  }

  /** A stored page in a visible notebook and section, for when the intended page is only a placeholder. */
  private firstAvailableTarget(open: OpenV2State): V2NavigationTarget | undefined {
    const notebooks = this.loadedNotebooks(open);
    for (const notebookDocumentId of open.activation.manifest.notebookDocumentIds) {
      const notebook = notebooks.get(notebookDocumentId);
      if (!notebook) continue;
      for (const section of notebook.sections) {
        for (const pageDocumentId of section.pageDocumentIds) {
          const summary = open.summaries.get(pageDocumentId);
          if (summary && !open.placeholders.has(pageDocumentId) && open.documents.has(pageDocumentId)) {
            return { notebookId: notebook.notebookId, sectionId: section.id, pageId: summary.pageId };
          }
        }
      }
    }
    return undefined;
  }

  /**
   * Legacy path for workspaces still on schema v2: one complete-image
   * revision changes every document to v3. It runs once per workspace and
   * reopens the workspace afterwards.
   */
  private async upgradeLegacyV2Workspace(open: OpenV2State): Promise<V2RuntimeState> {
    const store = this.options.activationStore;
    if (!store.commitActiveWorkspaceRevision) {
      throw new Error('This platform cannot atomically upgrade the workspace to schema v3.');
    }
    if (!open.session.readChunks) {
      throw new Error('The active Repo cannot provide a checked image for the schema upgrade.');
    }
    const sourceFingerprint = open.activation.artifactFingerprint;
    const manifest = upgradeManifestV2ToV3(
      open.activation.manifest as MigrationManifestV2,
      sourceFingerprint,
      open.activation.activatedAt,
    );
    await this.flushLoaded(open);
    const chunks = await open.session.readChunks();
    // The whole image is loaded and rewritten, which is far too long for the main thread.
    const staged = await stageSchemaV3UpgradeInWorker(chunks, open.activation.documents);
    const descriptors = await Promise.all(staged.chunks.map(async (chunk) => ({
      key: [...chunk.key],
      checksum: await sha256Bytes(chunk.bytes),
      size: chunk.bytes.byteLength,
    })));
    manifest.assetIds = [...open.activation.assetIds].sort();
    const operationId = `workspace-v2-to-v3:${sourceFingerprint.slice('sha256:'.length)}`;
    const artifactFingerprint = await sha256Canonical({
      namespace: 'canvink-v2-workspace-revision',
      operationId,
      priorArtifactFingerprint: sourceFingerprint,
      documents: staged.documents,
      chunks: descriptors,
      manifest,
      assetIds: manifest.assetIds,
    });
    const activation: V2ActivationRecord = {
      ...structuredClone(open.activation),
      schemaVersion: 3,
      format: 'canvink-automerge-v3',
      artifactFingerprint,
      activatedAt: open.activation.activatedAt,
      manifest,
      documents: staged.documents,
      chunks: descriptors,
      assetIds: manifest.assetIds,
    };
    delete activation.layout;
    const previous = open.active;
    await this.closeV2Session();
    try {
      await store.commitActiveWorkspaceRevision({
        expectedActivation: open.activation,
        activation,
        assets: [],
        chunks: staged.chunks,
      });
    } catch (error) {
      const reconciled = await this.readActivationFirst();
      if (!reconciled || reconciled.artifactFingerprint !== artifactFingerprint) {
        await this.reopen(open.activation);
        throw error;
      }
    }
    const committed = await this.readActivationFirst();
    if (!committed || committed.artifactFingerprint !== artifactFingerprint) {
      this.state = undefined;
      throw new WorkspaceV2RecoveryRequiredError(
        'activation-invalid',
        'The schema upgrade committed without its matching activation.',
        { activation: committed },
      );
    }
    await this.reopen(committed, previous);
    return this.getState() as V2RuntimeState;
  }

  private async startupOnce(): Promise<WorkspaceV2RuntimeState> {
    this.writeAccess = await (
      this.options.acquireWriteAccess?.() ?? Promise.resolve('indexeddb' as const)
    );
    const activation = await this.readActivationFirst();
    if (activation) {
      await this.reopen(activation, undefined, true);
      return this.getState();
    }
    const loaded = await this.options.source.loadWorkspace();
    assertWorkspaceShape(loaded.workspace);
    this.state = {
      schemaVersion: 1,
      authoritative: 'v1',
      backend: loaded.backend,
      workspace: structuredClone(loaded.workspace),
    };
    this.notifyState();
    return this.getState();
  }

  private async reopen(activation: V2ActivationRecord, keepTarget?: V2NavigationTarget, starting = false): Promise<void> {
    await this.closeV2Session();
    const open = await this.openActivatedV2(activation, keepTarget, starting);
    this.openV2 = open;
    this.unsubscribePendingInk?.();
    const stopPending = pendingInk().subscribe((documentId, count) => this.onPendingInk(documentId, count));
    const stopArrivals = inkSegments().onLoaded((hashes) => this.announceArrivedSegments(open, hashes));
    this.unsubscribePendingInk = () => { stopPending(); stopArrivals(); };
    this.publishState(open);
    // Ink drawn in a session that ended before it was sealed (journal records)
    // rejoins its pages now, without waiting for the pages to be opened.
    void this.recoverJournaledInk(open);
  }

  private async recoverJournaledInk(open: OpenV2State): Promise<void> {
    try {
      for (const documentId of await pendingInk().journaledDocuments()) {
        if (this.openV2 !== open) return;
        if (!open.documents.has(documentId)) continue;
        const loaded = await this.loadDocument(open, documentId);
        if (loaded.kind !== 'page') continue;
        const shown = getSharedAutomergeSnapshot<LivePageDocV2>(loaded.handle.doc() as PageAutomergeDoc).elementsById;
        await pendingInk().recover(documentId, (strokeId) => Object.hasOwn(shown, strokeId));
        if (pendingInk().count(documentId) > 0) await this.sealPendingInk(documentId);
      }
    } catch (error) {
      console.error('[workspace] recovering unsealed ink failed', error);
    }
  }

  private async readActivationFirst(): Promise<V2ActivationRecord | undefined> {
    let activation: V2ActivationRecord | undefined;
    try {
      activation = await this.options.activationStore.getActivation();
    } catch (error) {
      throw new WorkspaceV2RecoveryRequiredError(
        'activation-unreadable',
        'Schema-v2 activation could not be read. Recovery is required before opening a workspace.',
        { cause: error },
      );
    }
    if (!activation) return undefined;
    try {
      assertActivationShape(activation);
    } catch (error) {
      throw new WorkspaceV2RecoveryRequiredError(
        'activation-invalid',
        'Schema-v2 activation is malformed. Recovery is required; v1 was not opened.',
        { cause: error, activation },
      );
    }
    return activation;
  }

  /**
   * Opens a workspace lazily: notebook documents and the active page are
   * loaded into the Repo; every other page is represented by its index
   * summary. Summaries the index cannot vouch for (missing, written for
   * other activation heads, or with dirty markers left by a later write)
   * are rebuilt from the page document, one page at a time.
   */
  private async openActivatedV2(
    activation: V2ActivationRecord,
    keepTarget?: V2NavigationTarget,
    starting = false,
  ): Promise<OpenV2State> {
    const session = await this.options.repoFactory();
    if (!session.storage) throw new Error('The Repo session provides no document storage.');
    const open: OpenV2State = {
      activation: deepFreeze(structuredClone(activation)),
      session,
      documents: new Map(activation.documents.map((document) => [document.documentId, document])),
      storageIds: new Map(),
      loaded: new Map(),
      summaries: new Map(),
      placeholders: new Set(),
      pageDocuments: new Map(),
      active: structuredClone(activation.manifest.active),
    };
    try {
      for (const document of activation.documents) {
        open.storageIds.set(document.documentId, storageIdOfUrl(document.url));
      }
      for (const document of activation.documents) {
        if (document.kind === 'notebook') await this.loadDocument(open, document.documentId, { waitForContent: false });
      }
      await this.loadPageIndex(open);
      validateWorkspaceGraph(activation, this.loadedNotebooks(open), open.summaries);
      this.rebuildPageLookup(open);
      const startTarget = keepTarget ? undefined : starting ? this.startTarget(open) : undefined;
      let target = keepTarget ?? startTarget ?? open.active;
      try {
        this.resolveTarget(open, target);
      } catch {
        target = structuredClone(activation.manifest.active);
      }
      let activeDocumentId = this.resolveTarget(open, target);
      if (open.placeholders.has(activeDocumentId)) {
        // The last viewed page (or the stored active one) is only listed on this device so far.
        const stored = structuredClone(activation.manifest.active);
        try {
          if (open.placeholders.has(this.resolveTarget(open, stored))) throw new Error('placeholder');
          target = stored;
        } catch {
          target = this.firstAvailableTarget(open) ?? target;
        }
        activeDocumentId = this.resolveTarget(open, target);
      }
      try {
        await this.loadDocument(open, activeDocumentId, { waitForContent: false });
      } catch (error) {
        // The page last viewed on this device is unreadable: start on the
        // workspace's own page instead of failing the whole startup, so the
        // rest of the workspace stays reachable.
        if (!startTarget || target !== startTarget) throw error;
        target = structuredClone(activation.manifest.active);
        activeDocumentId = this.resolveTarget(open, target);
        await this.loadDocument(open, activeDocumentId, { waitForContent: false });
      }
      open.active = structuredClone(target);
      this.touch(open, activeDocumentId);
      return open;
    } catch (error) {
      for (const loaded of open.loaded.values()) loaded.detach();
      await session.repo.shutdown().catch(() => undefined);
      await session.close?.();
      if (error instanceof WorkspaceV2RecoveryRequiredError) throw error;
      throw new WorkspaceV2RecoveryRequiredError(
        'document-invalid',
        'Activated Automerge workspace graph failed validation.',
        { cause: error, activation },
      );
    }
  }

  private async loadPageIndex(open: OpenV2State): Promise<void> {
    const storage = open.session.storage;
    const entries = new Map<string, PageIndexEntry>();
    const obsolete: CanvinkStorageMutation[] = [];
    const pageStorageIds = new Map<string, string>();
    for (const document of open.activation.documents) {
      if (document.kind === 'page') pageStorageIds.set(this.requireStorageId(open, document.documentId), document.documentId);
    }
    for (const record of await storage.loadShared([PAGE_INDEX_NAMESPACE])) {
      const storageId = record.key[1];
      const entry = decodePageIndexEntry(record.data);
      if (!storageId || !pageStorageIds.has(storageId) || !entry || entry.storageId !== storageId) {
        obsolete.push({ type: 'remove', key: record.key });
        continue;
      }
      entries.set(storageId, entry);
    }
    const dirty = new Set<string>();
    for (const record of await storage.loadShared([DIRTY_NAMESPACE])) {
      const storageId = record.key[1];
      if (!storageId || !pageStorageIds.has(storageId)) {
        obsolete.push({ type: 'remove', key: record.key });
        continue;
      }
      dirty.add(storageId);
    }
    const stale: string[] = [];
    for (const [storageId, documentId] of pageStorageIds) {
      const entry = entries.get(storageId);
      const expected = open.documents.get(documentId)!;
      if (
        entry
        && entry.documentId === documentId
        && !dirty.has(storageId)
        && sameHeadSet(entry.activationHeads, expected.heads)
        && entry.summary.schemaVersion === open.activation.schemaVersion
      ) {
        open.summaries.set(documentId, entry.summary);
        if (entry.placeholder) open.placeholders.add(documentId);
      } else stale.push(documentId);
    }
    const writes: CanvinkStorageMutation[] = [...obsolete];
    const report = (completed: number): void => this.options.onProgress?.({
      phase: completed < stale.length ? 'indexing-pages' : 'active-v2',
      completed,
      total: stale.length,
      authoritative: 'v2',
      resumed: false,
      message: 'Building the page index.',
    });
    if (stale.length > 0) report(0);
    for (const [position, documentId] of stale.entries()) {
      const storageId = this.requireStorageId(open, documentId);
      const markers = await storage.loadShared([DIRTY_NAMESPACE, storageId]);
      const document = await this.loadDetached(open, documentId);
      try {
        const summary = summarizePageDocument(document as PageAutomergeDoc);
        open.summaries.set(documentId, summary);
        writes.push(
          { type: 'save', key: indexKey(storageId), data: encodePageIndexEntry(this.indexEntry(open, documentId, storageId, summary)) },
          ...markers.map((marker) => ({ type: 'remove' as const, key: marker.key })),
        );
      } finally {
        freeDocument(document);
      }
      if (writes.length >= 2000) await storage.commitAtomically({ shared: writes.splice(0) });
      report(position + 1);
    }
    if (writes.length > 0) await storage.commitAtomically({ shared: writes });
  }

  private indexEntry(open: OpenV2State, documentId: string, storageId: string, summary: PageSummary): PageIndexEntry {
    return {
      version: PAGE_INDEX_VERSION,
      storageId,
      documentId,
      activationHeads: [...(open.documents.get(documentId)?.heads ?? [])],
      summary,
    };
  }

  private async indexWriteMutations(
    open: OpenV2State,
    documentId: string,
    storageId: string,
    summary: PageSummary,
  ): Promise<CanvinkStorageMutation[]> {
    const markers = await open.session.storage.loadShared([DIRTY_NAMESPACE, storageId]);
    return [
      { type: 'save', key: indexKey(storageId), data: encodePageIndexEntry(this.indexEntry(open, documentId, storageId, summary)) },
      ...markers.map((marker) => ({ type: 'remove' as const, key: marker.key })),
    ];
  }

  /** Loads a document from storage outside the Repo and checks it against the activation. */
  private async loadDetached(open: OpenV2State, documentId: string): Promise<CanvinkAutomergeDoc> {
    const expected = open.documents.get(documentId);
    if (!expected) throw new Error(`Document ${documentId} is not part of the active workspace.`);
    if (open.placeholders.has(documentId)) throw new PageNotDownloadedError(documentId, `Page ${documentId} is not downloaded yet.`);
    let document: CanvinkAutomergeDoc | undefined;
    try {
      document = await loadDocumentFromStorage(open.session.storage, this.requireStorageId(open, documentId));
    } catch (error) {
      throw new WorkspaceV2RecoveryRequiredError(
        'document-unavailable',
        `Activated Automerge document ${documentId} is unavailable.`,
        { cause: error, activation: open.activation },
      );
    }
    if (!document) {
      throw new WorkspaceV2RecoveryRequiredError(
        'document-unavailable',
        `Activated Automerge document ${documentId} is unavailable.`,
        { activation: open.activation },
      );
    }
    try {
      this.assertDocumentMatches(open, expected, document);
      // A reader takes snapshots of the document right away, so its ink is made resident first.
      await this.hydrateInk(document);
    } catch (error) {
      freeDocument(document);
      throw error;
    }
    return document;
  }

  private assertDocumentMatches(
    open: OpenV2State,
    expected: ActivatedDocumentV2,
    document: CanvinkAutomergeDoc,
  ): void {
    try {
      assertCanvinkAutomergeDocument(document);
      if (document.documentId !== expected.documentId || document.kind !== expected.kind) {
        throw new Error('Document identity does not match activation.');
      }
      if (document.schemaVersion !== open.activation.schemaVersion) {
        throw new Error(`Document ${expected.documentId} does not match activation schema v${open.activation.schemaVersion}.`);
      }
      if (!documentHasHeads(document, expected.heads)) {
        throw new Error('Activation heads do not belong to the expected document.');
      }
    } catch (error) {
      throw new WorkspaceV2RecoveryRequiredError(
        'document-invalid',
        `Activated Automerge document ${expected.documentId} failed validation.`,
        { cause: error, activation: open.activation },
      );
    }
  }

  /**
   * A detached, independently writable copy of a document: cloned from the
   * loaded copy (with a fresh actor, so its changes cannot collide with live
   * edits) or loaded from storage.
   */
  private async checkoutDocument(open: OpenV2State, documentId: string): Promise<CanvinkAutomergeDoc> {
    const loaded = open.loaded.get(documentId);
    if (loaded) {
      return Automerge.clone<LiveCanvinkDocumentV2>(loaded.handle.doc() as CanvinkAutomergeDoc, { actor: randomActorId() });
    }
    return this.withDocumentLock(documentId, () => this.loadDetached(open, documentId));
  }

  private async loadDocument(
    open: OpenV2State,
    documentId: string,
    options: { waitForContent: boolean } = { waitForContent: true },
  ): Promise<LoadedDocument> {
    const existing = open.loaded.get(documentId);
    if (existing) return existing;
    if (open.placeholders.has(documentId)) {
      // Waiting happens before the document lock is taken: the commit that stores the
      // download evicts the placeholder under that lock.
      if (!options.waitForContent) throw new PageNotDownloadedError(documentId, `Page ${documentId} is not downloaded yet.`);
      await this.ensureContent(documentId);
      if (this.openV2 !== open) throw new Error('The workspace was reopened while the page downloaded.');
    }
    return this.withDocumentLock(documentId, async () => {
      const current = open.loaded.get(documentId);
      if (current) return current;
      const expected = open.documents.get(documentId);
      if (!expected) throw new Error(`Document ${documentId} is not part of the active workspace.`);
      let handle: DocHandle<LiveCanvinkDocumentV2>;
      try {
        handle = await open.session.repo.find<LiveCanvinkDocumentV2>(expected.url as AutomergeUrl);
      } catch (error) {
        throw new WorkspaceV2RecoveryRequiredError(
          'document-unavailable',
          `Activated Automerge document ${documentId} is unavailable.`,
          { cause: error, activation: open.activation },
        );
      }
      const document = handle.doc() as CanvinkAutomergeDoc;
      // The ink a page references is made resident before the page is shown.
      let missingInk: string[] = [];
      try {
        missingInk = await this.hydrateInk(document, documentId);
      } catch (error) {
        console.error('[workspace] loading ink segments failed', error);
      }
      try {
        this.assertDocumentMatches(open, expected, document);
        getSharedAutomergeSnapshot<LiveCanvinkDocumentV2>(document);
      } catch (error) {
        await open.session.repo.removeFromCache(handle.documentId).catch(() => undefined);
        if (error instanceof WorkspaceV2RecoveryRequiredError) throw error;
        throw new WorkspaceV2RecoveryRequiredError(
          'document-invalid',
          `Activated Automerge document ${documentId} failed validation.`,
          { cause: error, activation: open.activation },
        );
      }
      const loaded: LoadedDocument = {
        documentId,
        kind: expected.kind,
        storageId: handle.documentId,
        handle,
        heads: getAutomergeHeads<LiveCanvinkDocumentV2>(document),
        retain: 0,
        lastUsed: ++this.useCounter,
        indexDirty: false,
        detach: () => undefined,
      };
      const onHeadsChanged = ({ doc }: { doc: unknown }): void => this.onLoadedDocumentChanged(open, loaded, doc as CanvinkAutomergeDoc);
      handle.on('heads-changed', onHeadsChanged);
      loaded.detach = () => {
        handle.off('heads-changed', onHeadsChanged);
        if (loaded.indexTimer) clearTimeout(loaded.indexTimer);
      };
      open.loaded.set(documentId, loaded);
      if (missingInk.length > 0) this.retryMissingInk(open, documentId, missingInk);
      if (loaded.kind === 'page') {
        if (pendingInk().count(documentId) > 0) this.onPendingInk(documentId, pendingInk().count(documentId));
        const summary = summarizePageDocument(document as PageAutomergeDoc);
        const previous = open.summaries.get(documentId);
        if (!samePageSummary(previous, summary)) {
          open.summaries.set(documentId, summary);
          this.scheduleIndexWrite(open, loaded);
          if (this.openV2 === open && !sameVisibleSummary(previous, summary)) this.publishState(open);
        }
      }
      return loaded;
    });
  }

  private onLoadedDocumentChanged(open: OpenV2State, loaded: LoadedDocument, document: CanvinkAutomergeDoc): void {
    if (this.openV2 !== open || open.loaded.get(loaded.documentId) !== loaded) return;
    const beforeHeads = loaded.heads;
    loaded.heads = getAutomergeHeads<LiveCanvinkDocumentV2>(document);
    let visibleChange = false;
    if (loaded.kind === 'page') {
      // Keep the page's segments resident, and fetch ones a change brought that this device lacks.
      const referenced = referencedInkSegments(document);
      inkSegments().pin(loaded.documentId, referenced);
      if (referenced.length > 0 && !this.pendingOrigin) this.scheduleInkCompaction(open, loaded.documentId);
      const absent = referenced.filter((hash) => !inkSegments().peek(hash));
      if (absent.length > 0) {
        void inkSegments().ensure(absent, { remoteWaitMs: INK_OPEN_WAIT_MS })
          .then((missing) => this.retryMissingInk(open, loaded.documentId, missing))
          .catch(() => this.retryMissingInk(open, loaded.documentId, absent));
      }
      const summary = summarizePageDocument(document as PageAutomergeDoc);
      const previous = open.summaries.get(loaded.documentId);
      open.summaries.set(loaded.documentId, summary);
      if (!sameVisibleSummary(previous, summary)) {
        visibleChange = true;
        if (previous?.pageId !== summary.pageId) this.rebuildPageLookup(open);
      }
      this.scheduleIndexWrite(open, loaded);
    } else visibleChange = true;
    this.emitDocumentChange({
      documentId: loaded.documentId,
      kind: loaded.kind,
      beforeHeads,
      heads: loaded.heads,
      origin: this.pendingOrigin ?? { kind: 'local' },
      document,
    });
    if (visibleChange) this.publishState(open);
  }

  private scheduleIndexWrite(open: OpenV2State, loaded: LoadedDocument): void {
    loaded.indexDirty = true;
    if (loaded.indexTimer) clearTimeout(loaded.indexTimer);
    loaded.indexTimer = setTimeout(() => {
      loaded.indexTimer = undefined;
      if (this.openV2 === open && open.loaded.get(loaded.documentId) === loaded) {
        void this.writeLoadedIndex(open, loaded).catch(() => undefined);
      }
    }, this.indexWriteDelayMs);
  }

  /**
   * Writes the page's index entry. Writes of one page run one after the other:
   * two overlapping writes could commit out of order and leave the older
   * summary (an old title) in the index with the dirty markers already gone.
   * Returns once every write started before this call has finished, also when
   * this call found nothing dirty, so a flush never returns ahead of a write
   * the timer has in flight.
   */
  private writeLoadedIndex(open: OpenV2State, loaded: LoadedDocument): Promise<void> {
    const previous = loaded.indexWriting ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.writeLoadedIndexNow(open, loaded));
    loaded.indexWriting = next;
    const clear = (): void => {
      if (loaded.indexWriting === next) loaded.indexWriting = undefined;
    };
    next.then(clear, clear);
    return next;
  }

  private async writeLoadedIndexNow(open: OpenV2State, loaded: LoadedDocument): Promise<void> {
    if (!loaded.indexDirty) return;
    loaded.indexDirty = false;
    if (loaded.indexTimer) {
      clearTimeout(loaded.indexTimer);
      loaded.indexTimer = undefined;
    }
    // Markers are read before the summary is taken from memory: the loaded
    // document already contains every change those markers stand for.
    const markers = await open.session.storage.loadShared([DIRTY_NAMESPACE, loaded.storageId]);
    const summary = summarizePageDocument(loaded.handle.doc() as PageAutomergeDoc);
    await open.session.storage.commitAtomically({
      shared: [
        {
          type: 'save',
          key: indexKey(loaded.storageId),
          data: encodePageIndexEntry(this.indexEntry(open, loaded.documentId, loaded.storageId, summary)),
        },
        ...markers.map((marker) => ({ type: 'remove' as const, key: marker.key })),
      ],
    });
  }

  /**
   * Writes every loaded document. `Repo.flush()` without arguments would
   * also touch handles that are still loading and fail on them.
   */
  private async flushLoaded(open: OpenV2State): Promise<void> {
    const ids = [...open.loaded.values()].map((loaded) => loaded.storageId as DocumentId);
    if (ids.length > 0) await open.session.repo.flush(ids);
  }

  private touch(open: OpenV2State, documentId: string): void {
    const loaded = open.loaded.get(documentId);
    if (loaded) loaded.lastUsed = ++this.useCounter;
  }

  /**
   * Keeps the active page plus the most recently used pages in memory, as
   * many as the count and the operation budget allow. A page leaves only
   * after the Repo wrote it and its index entry is current, and never while
   * something retains it (an editor subscription, a sync apply).
   */
  private async evictPages(open: OpenV2State): Promise<void> {
    const activeDocumentId = open.pageDocuments.get(open.active.pageId);
    const candidates = [...open.loaded.values()]
      .filter((loaded) => loaded.kind === 'page' && loaded.documentId !== activeDocumentId)
      .sort((left, right) => right.lastUsed - left.lastUsed);
    let budget = this.pageCacheOperations;
    const excess: LoadedDocument[] = [];
    candidates.forEach((loaded, position) => {
      const operations = Automerge.stats(loaded.handle.doc() as Automerge.Doc<unknown>).numOps;
      // Going back to the page just left stays instant however large it is.
      if (position < this.pageCacheSize && (position === 0 || operations <= budget)) budget -= operations;
      else if (loaded.retain === 0) excess.push(loaded);
    });
    for (const loaded of excess) {
      if (this.openV2 !== open) return;
      await this.evictDocument(open, loaded.documentId, { flush: true }).catch(() => undefined);
    }
  }

  private async evictDocument(open: OpenV2State, documentId: string, options: { flush: boolean }): Promise<void> {
    await this.withDocumentLock(documentId, async () => {
      const loaded = open.loaded.get(documentId);
      if (!loaded) return;
      if (options.flush) {
        if (loaded.retain > 0) return;
        if (loaded.kind === 'page' && pendingInk().count(documentId) > 0) {
          await sealPendingInk(this.inkTarget(loaded), documentId, inkSegments(), pendingInk());
          await pendingInk().writeJournal(documentId);
        }
        await open.session.repo.flush([loaded.storageId as DocumentId]);
        if (loaded.kind === 'page') await this.writeLoadedIndex(open, loaded);
        if (loaded.retain > 0 || open.pageDocuments.get(open.active.pageId) === documentId) return;
      }
      loaded.detach();
      open.loaded.delete(documentId);
      inkSegments().unpin(documentId);
      // Automerge Repo 2.5.6 unloads a handle by replacing its document with
      // an empty one, and its own `heads-changed` save listener then stores
      // that empty document as a compacted snapshot, deleting the real
      // chunks. The document was written above, so every save listener is
      // removed before the handle is unloaded.
      for (const listener of loaded.handle.listeners('heads-changed')) {
        loaded.handle.off('heads-changed', listener);
      }
      await open.session.repo.removeFromCache(loaded.storageId as DocumentId);
    });
  }

  private emitDocumentChange(event: DocumentChangeEvent): void {
    for (const listener of [...this.documentListeners]) {
      try {
        listener(event);
      } catch (error) {
        console.error('[workspace] document change listener failed', error);
        for (const report of [...this.listenerFailureListeners]) report(error);
      }
    }
  }

  private loadedNotebooks(open: OpenV2State): Map<string, LiveNotebookDocV2> {
    const notebooks = new Map<string, LiveNotebookDocV2>();
    for (const loaded of open.loaded.values()) {
      if (loaded.kind !== 'notebook') continue;
      notebooks.set(loaded.documentId, getSharedAutomergeSnapshot<LiveCanvinkDocumentV2>(loaded.handle.doc() as CanvinkAutomergeDoc) as LiveNotebookDocV2);
    }
    return notebooks;
  }

  private rebuildPageLookup(open: OpenV2State): void {
    // While a page is being replaced by a rebuilt document, both documents carry its page id. The
    // one a notebook lists is the page; the other is waiting to be dropped.
    const listed = new Set<string>();
    for (const notebook of this.loadedNotebooks(open).values()) {
      for (const section of notebook.sections) for (const documentId of section.pageDocumentIds) listed.add(documentId);
    }
    const lookup = new Map<string, string>();
    for (const summary of open.summaries.values()) {
      const current = lookup.get(summary.pageId);
      if (current === undefined || (listed.has(summary.documentId) && !listed.has(current))) {
        lookup.set(summary.pageId, summary.documentId);
      }
    }
    open.pageDocuments = lookup;
  }

  /**
   * The size of a document as stored (snapshot and incremental chunks), read without loading it. A
   * page's stored size tracks how long it takes to open, which is what decides whether a page is
   * worth rebuilding.
   */
  async storedDocumentBytes(documentId: string): Promise<number> {
    const open = this.requireV2();
    const storageId = this.requireStorageId(open, documentId);
    const chunks = [
      ...await open.session.storage.loadRange([storageId, 'snapshot']),
      ...await open.session.storage.loadRange([storageId, 'incremental']),
    ];
    return chunks.reduce((total, chunk) => total + (chunk.data?.byteLength ?? 0), 0);
  }

  private pageDocumentId(open: OpenV2State, pageId: string): string {
    const documentId = open.pageDocuments.get(pageId);
    if (!documentId || !open.documents.has(documentId)) {
      throw new Error(`Page ${pageId} is not part of the active workspace.`);
    }
    return documentId;
  }

  private requireStorageId(open: OpenV2State, documentId: string): string {
    const storageId = open.storageIds.get(documentId);
    if (!storageId) throw new Error(`Document ${documentId} is not part of the active workspace.`);
    return storageId;
  }

  /** Where the device's last viewed page is, when it still is a visible page. */
  private startTarget(open: OpenV2State): V2NavigationTarget | undefined {
    let pageId: string | undefined;
    try {
      pageId = this.options.startPageId?.();
    } catch {
      return undefined;
    }
    const documentId = pageId ? open.pageDocuments.get(pageId) : undefined;
    const summary = documentId ? open.summaries.get(documentId) : undefined;
    if (!pageId || !documentId || !summary) return undefined;
    const manifest = open.activation.manifest;
    const notebook = [...this.loadedNotebooks(open).values()].find((candidate) => candidate.notebookId === summary.notebookId);
    if (!notebook || !manifest.notebookDocumentIds.includes(notebook.documentId)) return undefined;
    const trashed = manifest.trash.some((entry) =>
      (entry.kind === 'notebook' && entry.notebookDocumentId === notebook.documentId)
      || (entry.kind === 'page' && entry.pageDocumentId === documentId));
    if (trashed) return undefined;
    return { notebookId: summary.notebookId, sectionId: summary.sectionId, pageId };
  }

  private resolveTarget(open: OpenV2State, target: V2NavigationTarget): string {
    const notebook = this.loadedNotebooks(open).get(`notebook:${target.notebookId}`)
      ?? [...this.loadedNotebooks(open).values()].find((candidate) => candidate.notebookId === target.notebookId);
    const section = notebook?.sections.find((candidate) => candidate.id === target.sectionId);
    const documentId = open.pageDocuments.get(target.pageId)
      ?? [...open.summaries.values()].find((summary) => summary.pageId === target.pageId)?.documentId;
    const summary = documentId ? open.summaries.get(documentId) : undefined;
    if (
      !notebook
      || !section
      || !documentId
      || !summary
      || summary.notebookId !== target.notebookId
      || summary.sectionId !== target.sectionId
      || !section.pageDocumentIds.includes(documentId)
    ) {
      throw new Error('The requested active notebook, section, and page do not form a valid context.');
    }
    return documentId;
  }

  private resolveLoadedContext(open: OpenV2State, target: V2NavigationTarget): ActiveV2Context {
    const documentId = this.resolveTarget(open, target);
    const pageLoaded = open.loaded.get(documentId);
    const notebookLoaded = [...open.loaded.values()].find((loaded) =>
      loaded.kind === 'notebook'
      && (loaded.handle.doc() as LiveNotebookDocV2).notebookId === target.notebookId);
    if (!pageLoaded || !notebookLoaded) throw new Error('The active Automerge handles are unavailable.');
    const notebook = getSharedAutomergeSnapshot<LiveCanvinkDocumentV2>(notebookLoaded.handle.doc() as CanvinkAutomergeDoc) as LiveNotebookDocV2;
    const section = notebook.sections.find((candidate) => candidate.id === target.sectionId);
    const page = getSharedAutomergeSnapshot<LiveCanvinkDocumentV2>(pageLoaded.handle.doc() as CanvinkAutomergeDoc) as LivePageDocV2;
    if (!section) throw new Error('The requested active notebook, section, and page do not form a valid context.');
    return {
      notebook,
      section,
      page,
      notebookHandle: notebookLoaded.handle as unknown as ReadonlyDocHandle<LiveNotebookDocV2>,
      pageHandle: pageLoaded.handle as unknown as ReadonlyDocHandle<LivePageDocV2>,
    };
  }

  private updateSummary(open: OpenV2State, summary: PageSummary): void {
    const previous = open.summaries.get(summary.documentId);
    open.summaries.set(summary.documentId, summary);
    if (previous?.pageId !== summary.pageId) this.rebuildPageLookup(open);
    if (!sameVisibleSummary(previous, summary)) this.publishState(open);
  }

  private publishState(open: OpenV2State): void {
    if (this.openV2 !== open && this.openV2 !== undefined) return;
    const notebooks = open.activation.manifest.notebookDocumentIds.flatMap((documentId) => {
      const loaded = open.loaded.get(documentId);
      return loaded ? [getSharedAutomergeSnapshot<LiveCanvinkDocumentV2>(loaded.handle.doc() as CanvinkAutomergeDoc) as LiveNotebookDocV2] : [];
    });
    const pages = open.activation.manifest.pageDocumentIds.flatMap((documentId) => {
      const summary = open.summaries.get(documentId);
      return summary ? [summary] : [];
    });
    this.state = Object.freeze({
      schemaVersion: open.activation.schemaVersion,
      authoritative: open.activation.schemaVersion === 3 ? 'v3' : 'v2',
      activation: open.activation,
      active: Object.freeze(structuredClone(open.active)),
      notebooks: Object.freeze(notebooks),
      pages: Object.freeze(pages),
    }) as V2RuntimeState;
    this.notifyState();
  }

  private notifyState(): void {
    if (this.stateNotificationScheduled) return;
    this.stateNotificationScheduled = true;
    queueMicrotask(() => {
      this.stateNotificationScheduled = false;
      const state = this.state;
      if (!state) return;
      for (const listener of [...this.stateListeners]) listener(state);
    });
  }

  private requireV2(): OpenV2State {
    if (!this.openV2 || this.state?.schemaVersion === 1) {
      throw new Error('The workspace runtime has no active Automerge authority.');
    }
    return this.openV2;
  }

  private async closeV2Session(): Promise<void> {
    this.rejectContentWaiters('The workspace was closed before the page was downloaded.');
    for (const unsubscribe of [...this.subscriptions]) unsubscribe();
    const open = this.openV2;
    this.openV2 = undefined;
    if (!open) return;
    let failure: unknown;
    this.unsubscribePendingInk?.();
    this.unsubscribePendingInk = undefined;
    for (const timer of [...this.inkTimers.values(), ...this.inkRetryTimers.values(), ...this.inkCompactionTimers.values()]) clearTimeout(timer);
    this.inkTimers.clear();
    this.inkRetryTimers.clear();
    this.inkCompactionTimers.clear();
    try {
      // Ink drawn in the last moments joins its page before the documents are saved. `openV2`
      // is already cleared, so this runs against the session being closed.
      for (const documentId of pendingInk().documentsWithPendingInk()) {
        const loaded = open.loaded.get(documentId);
        if (loaded?.kind === 'page') {
          await sealPendingInk(this.inkTarget(loaded), documentId, inkSegments(), pendingInk()).catch(() => 0);
        }
      }
      await pendingInk().flushJournals();
      await this.flushLoaded(open);
      for (const loaded of [...open.loaded.values()]) {
        if (loaded.kind === 'page') await this.writeLoadedIndex(open, loaded);
      }
    } catch (error) {
      failure = error;
    }
    for (const loaded of open.loaded.values()) loaded.detach();
    open.loaded.clear();
    try {
      await open.session.repo.shutdown();
    } catch (error) {
      // Shutdown flushes every handle, including ones a cancelled load left
      // behind; loaded documents were already written above.
      if (!(error instanceof Error && /not ready/i.test(error.message))) failure ??= error;
    }
    try {
      await open.session.close?.();
    } catch (error) {
      failure ??= error;
    }
    if (failure !== undefined) throw failure;
  }
}

/** Title, location and flags; heads alone changing does not republish the workspace state. */
function sameVisibleSummary(left: PageSummary | undefined, right: PageSummary): boolean {
  if (!left) return false;
  const { heads: _leftHeads, ...leftRest } = left;
  const { heads: _rightHeads, ...rightRest } = right;
  void _leftHeads;
  void _rightHeads;
  return JSON.stringify(leftRest) === JSON.stringify(rightRest);
}

function assertGraphRevisionDocumentSchemas(
  documents: readonly CanvinkDocument[],
  activeSchemaVersion: 2 | 3,
): CanvinkDocument[] {
  for (const document of documents) {
    if (document.schemaVersion !== activeSchemaVersion) {
      throw new Error(
        `Topology transaction document ${document.documentId} uses schema v${document.schemaVersion}; active workspace requires schema v${activeSchemaVersion}. Downgrade or implicit upgrade is refused.`,
      );
    }
  }
  return documents.map((document) => structuredClone(document));
}

export function createCanvinkPersistentRepoFactory(
  options: CanvinkStorageAdapterOptions = {},
): PersistentRepoFactory {
  return () => {
    const storage = new CanvinkStorageAdapter({
      ...options,
      databaseName: options.databaseName ?? 'canvink-v2',
      objectStoreName: options.objectStoreName ?? 'documents-assets',
      databaseVersion: options.databaseVersion ?? 1,
      namespace: options.namespace ?? [REPO_NAMESPACE],
      dirtyNamespace: options.dirtyNamespace ?? DIRTY_NAMESPACE,
    });
    return {
      repo: new Repo({ storage, network: [], isEphemeral: false }),
      storage,
      readChunks: async () => (await storage.loadRange([])).map(({ key, data }) => {
        if (!data) throw new Error('The active Repo returned a chunk without bytes.');
        return { key: [...key], bytes: Uint8Array.from(data) };
      }),
      close: () => storage.close(),
    };
  };
}

export function createBrowserWorkspaceV2Runtime(options: {
  activationStore?: V2WorkspaceActivationStore;
  repoStorage?: CanvinkStorageAdapterOptions;
  migrationFactory?: () => V2WorkspaceMigrationOrchestrator;
  pageCacheSize?: number;
  onProgress?: (progress: MigrationProgress) => void;
  startPageId?: () => string | undefined;
} = {}): WorkspaceV2Runtime {
  const activationStore = options.activationStore ?? new BrowserV2WorkspaceActivationStore();
  return new WorkspaceV2Runtime({
    source: { loadWorkspace, loadRecoveryDraft },
    activationStore,
    repoFactory: createCanvinkPersistentRepoFactory(options.repoStorage),
    migrationFactory: options.migrationFactory ?? (() =>
      createBrowserV2WorkspaceMigrationOrchestrator({
        activationStore,
        repo: new WorkerAutomergeRepoMigrationAdapter(),
        materializer: new WorkerAutomergeMigrationMaterializer(),
      })),
    acquireWriteAccess: acquireWorkspaceWriteAccess,
    pageCacheSize: options.pageCacheSize,
    onProgress: options.onProgress,
    startPageId: options.startPageId,
  });
}

/** Native/Tauri composition point; command serialization stays in the injected bridge/store. */
export function createBridgeBackedWorkspaceV2Runtime(options: {
  source: V1WorkspaceMigrationSource;
  activationStore: V2WorkspaceActivationStore;
  bridge: CanvinkStorageBridge;
  migrationFactory?: () => V2WorkspaceMigrationOrchestrator;
  acquireWriteAccess?: () => Promise<StorageBackend>;
  pageCacheSize?: number;
}): WorkspaceV2Runtime {
  return new WorkspaceV2Runtime({
    source: options.source,
    activationStore: options.activationStore,
    repoFactory: createCanvinkPersistentRepoFactory({ bridge: options.bridge }),
    migrationFactory: options.migrationFactory,
    acquireWriteAccess: options.acquireWriteAccess ?? (async () => 'tauri'),
    pageCacheSize: options.pageCacheSize,
  });
}

/** Production desktop composition. Every v2 byte is read through SQLite-backed Tauri commands. */
export function createTauriWorkspaceV2Runtime(options: {
  invoke?: TauriInvoke;
  source?: V1WorkspaceMigrationSource;
  now?: () => string;
  onMigrationProgress?: (progress: MigrationProgress) => void;
  startPageId?: () => string | undefined;
} = {}): WorkspaceV2Runtime {
  if (!options.invoke && !hasTauriRuntime()) {
    throw new Error('The Tauri schema-v2 runtime cannot be created outside the desktop app.');
  }
  const source = options.source ?? { loadWorkspace, loadRecoveryDraft };
  const activationStore = new TauriV2WorkspaceActivationStore(options.invoke);
  const bridge = new TauriCanvinkStorageBridge(options.invoke);
  return new WorkspaceV2Runtime({
    source,
    activationStore,
    repoFactory: createCanvinkPersistentRepoFactory({ bridge }),
    migrationFactory: () => createTauriV2WorkspaceMigrationOrchestrator({
      invoke: options.invoke,
      now: options.now,
      onProgress: options.onMigrationProgress,
      activationStore,
      source,
    }),
    acquireWriteAccess: async () => {
      if (!options.invoke && !hasTauriRuntime()) {
        throw new Error('Tauri write access is unavailable; IndexedDB fallback is disabled.');
      }
      return 'tauri';
    },
    onProgress: options.onMigrationProgress,
    startPageId: options.startPageId,
  });
}

export { summarizePage };
