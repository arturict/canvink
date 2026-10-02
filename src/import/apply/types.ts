import type { AssetBlob, Sha256Checksum } from '../../domain/v2';
import type { NotebookDocV3, PageDocV3 } from '../../domain/v3';
import type {
  PageFidelityReport,
  PlannedPageImport,
  PlannedSectionImport,
} from '../types';

export type OneNoteApplyPhase =
  | 'validating'
  | 'staging-assets'
  | 'staging-documents'
  | 'awaiting-review'
  | 'writing-pages'
  | 'committing'
  | 'verifying'
  | 'completed'
  | 'rolling-back'
  | 'rolled-back';

export interface OneNoteApplyProgress {
  phase: OneNoteApplyPhase;
  completed: number;
  total: number;
  message: string;
  /** Page and asset bytes written to storage so far (apply phase only). */
  stagedBytes?: number;
  /** Milliseconds since the apply started (apply phase only). */
  elapsedMs?: number;
}

export interface OneNoteApplyTargetSnapshot {
  schemaVersion: 3;
  activationArtifactFingerprint: Sha256Checksum;
  notebookDocumentIds: string[];
  pageDocumentIds: string[];
}

export interface OneNoteApplyBeginRequest {
  importId: string;
  preparedAt: string;
  /** Lists every page the import adds, before the first page is written. */
  notebook: NotebookDocV3;
}

export interface OneNoteApplyWriterProgress {
  pages: number;
  assets: number;
  stagedBytes: number;
}

/**
 * Receives one converted page at a time. Nothing becomes visible before
 * `commit`; `abort` discards what was staged and leaves the workspace unchanged.
 */
export interface OneNoteApplyWriter {
  addAssets(assets: readonly AssetBlob[]): Promise<void>;
  addPage(page: PageDocV3): Promise<void>;
  progress(): OneNoteApplyWriterProgress;
  commit(importArtifactFingerprint: Sha256Checksum): Promise<OneNoteApplyCommitResult>;
  abort(): Promise<void>;
}

export interface OneNoteApplyCommitResult {
  status: 'committed' | 'already-committed';
  importId: string;
  artifactFingerprint: Sha256Checksum;
  backupId: string;
  notebookDocumentId: string;
  pageDocumentIds: string[];
  assetIds: Sha256Checksum[];
}

export interface OneNoteApplyTarget {
  inspect(): Promise<OneNoteApplyTargetSnapshot>;
  begin(request: OneNoteApplyBeginRequest): Promise<OneNoteApplyWriter>;
  verify(result: OneNoteApplyCommitResult): Promise<void>;
  rollback(importId: string): Promise<'rolled-back' | 'already-rolled-back'>;
}

/** A page as the review knows it: structure only, no content. */
export interface PlannedPageOutline {
  sourceId: string;
  title: string;
  order: number;
  level: number;
  /** Known before apply only when the source converted the page already (Graph). */
  fidelity?: PageFidelityReport;
}

export interface PlannedSectionOutline extends Omit<PlannedSectionImport, 'pages'> {
  pages: PlannedPageOutline[];
}

export interface PlannedNotebookOutline {
  sourceId: string;
  displayName: string;
  sections: PlannedSectionOutline[];
}

/**
 * What the review screen needs of an import source. Page content is read one
 * page at a time through `OneNoteImportPageSource` while the import is applied.
 */
export interface OneNoteImportOutline {
  kind: 'onenote-import-outline';
  version: 1;
  source: 'graph' | 'desktop-export';
  createdAt: string;
  notebooks: PlannedNotebookOutline[];
  /**
   * Identity of the source content (manifest checksum and file sizes for a
   * desktop export, the converted plan for Graph). The approval binds to it.
   */
  sourceRevision: string;
  /** Resource totals known before the pages are read. */
  resources: { count: number; bytes: number; exact: boolean };
  /** Problems known before the pages are read (for example pages OneNote did not export). */
  warnings: OneNoteImportWarning[];
}

export interface OneNoteImportWarning {
  /** OneNote page the warning is about; absent for the whole export. */
  pageId?: string;
  message: string;
}

export interface OneNoteImportResourceBody {
  bytes: Uint8Array;
  mediaType: string;
  fileName?: string;
}

export interface OneNoteImportPageSource {
  /** Reads and converts one page. The result is dropped once the page is written. */
  readPage(outline: PlannedPageOutline, signal?: AbortSignal): Promise<PlannedPageImport>;
  /** Reads one resource and verifies it against the source's recorded size and checksum. */
  readResource(resourceId: string, signal?: AbortSignal): Promise<OneNoteImportResourceBody>;
}

export interface OneNoteImportApplicationReview {
  importId: string;
  /** Fingerprint of the reviewed structure and source revision; apply requires it verbatim. */
  approvalArtifactFingerprint: Sha256Checksum;
  expectedActivationArtifactFingerprint: Sha256Checksum;
  notebookTitle: string;
  sectionCount: number;
  pageCount: number;
  resourceCount: number;
  resourceBytes: number;
  /** False when the resource totals are an upper bound (all files of a desktop export). */
  resourceTotalsExact: boolean;
  /** Page reports known before apply (Graph); a desktop export reports them after apply. */
  fidelity: PageFidelityReport[];
  pageTitles: Record<string, string>;
  warnings: string[];
}

export interface StagedOneNoteImportPage {
  outline: PlannedPageOutline;
  sectionId: string;
  pageId: string;
  documentId: string;
  parentPageId?: string;
}

export interface StagedOneNoteImportApplication {
  kind: 'staged-onenote-import';
  version: 2;
  preparedAt: string;
  sourceRevision: string;
  review: OneNoteImportApplicationReview;
  /** The notebook projection; its sections already list every page. */
  notebook: NotebookDocV3;
  pages: StagedOneNoteImportPage[];
  source: OneNoteImportPageSource;
}

export interface ApplyOneNoteImportOptions {
  approvalArtifactFingerprint: Sha256Checksum;
  signal?: AbortSignal;
  onProgress?: (progress: OneNoteApplyProgress) => void;
  /** Clock for the timing report; defaults to `performance.now`. */
  now?: () => number;
}

/** Where apply time went, in milliseconds. Phases overlap nothing and add up to about `totalMs`. */
export interface OneNoteImportTiming {
  totalMs: number;
  /** Reading and parsing page files (XML, ink) into the import plan. */
  readPagesMs: number;
  /** Reading and verifying resource files (pictures, PDFs, attachments). */
  readResourcesMs: number;
  /** Building Canvink page documents and hashing them for the artifact fingerprint. */
  convertMs: number;
  /** Handing pages and assets to the workspace writer (Automerge encoding and storage). */
  writeMs: number;
  commitMs: number;
  verifyMs: number;
}

export interface OneNoteImportStats {
  pages: number;
  elements: number;
  strokes: number;
  inkPoints: number;
  assets: number;
  assetBytes: number;
  stagedBytes: number;
}

export interface OneNoteImportApplicationResult extends OneNoteApplyCommitResult {
  fidelity: PageFidelityReport[];
  /** Imported page titles by OneNote page ID, for the import report. */
  pageTitles: Record<string, string>;
  timing: OneNoteImportTiming;
  stats: OneNoteImportStats;
}
