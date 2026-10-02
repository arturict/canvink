import type { NotebookDoc, RichTextDocument } from '../domain/v2/types';
import type { PageDocV3, PageElementV3 } from '../domain/v3';

/**
 * Version 3 stores one record per page together with the page heads it was
 * projected from. Records of any other version are discarded and rebuilt:
 * the index is derived data.
 */
export const SEARCH_INDEX_VERSION = 3 as const;

export const SEARCH_LIMITS = Object.freeze({
  fieldUtf8Bytes: 512 * 1024,
  recordUtf8Bytes: 2 * 1024 * 1024,
  records: 100_000,
  queryUtf8Bytes: 512,
  queryTokens: 24,
  tokenLength: 96,
  snippetCharacters: 180,
});

export type SearchField =
  | 'pageTitle'
  | 'notebookTitle'
  | 'sectionTitle'
  | 'tags'
  | 'checkItems'
  | 'richText'
  | 'math'
  | 'pdfText'
  | 'ocrText';

export interface SearchPageSource {
  documentId: string;
  notebookId: string;
  pageId: string;
  sectionId: string;
  notebookTitle: string;
  sectionTitle: string;
  pageTitle: string;
  tags: string[];
  taskState?: 'open' | 'done';
  updatedAt: string;
  /** Heads of the page document this source was read from. */
  pageHeads: string[];
  richTextDocuments: RichTextDocument[];
  markdownSource?: string;
  mathText?: string[];
  pdfText: string[];
  ocrText: string[];
  /** The page has PDF printouts whose text was not read yet (see `deferPdfText`) or could not be read. */
  pdfTextPending?: true;
}

export interface SearchProjectionRecord {
  version: typeof SEARCH_INDEX_VERSION;
  documentId: string;
  notebookId: string;
  pageId: string;
  sectionId: string;
  updatedAt: string;
  taskState?: 'open' | 'done';
  /**
   * Heads of the page document the record was projected from. The record is
   * current while they equal the document's heads; notebook and section
   * titles are patched separately because they live in the notebook document.
   */
  pageHeads: string[];
  sourceFingerprint: string;
  fields: Record<SearchField, string>;
  /**
   * Set while the page's PDF printouts are not read yet, or after one could
   * not be read: the record is searchable by everything else, and its PDF text
   * follows later or at the next start.
   */
  pdfTextPending?: true;
}

export interface SearchResult {
  documentId: string;
  notebookId: string;
  pageId: string;
  score: number;
  title: string;
  snippet: string;
  matchedFields: SearchField[];
}

export interface SearchProjectionLoadResult {
  records: SearchProjectionRecord[];
  /** Stored records that failed validation and were deleted. */
  discarded: number;
}

/** Persists projection records one per page document. */
export interface SearchProjectionAdapter {
  load(): Promise<SearchProjectionLoadResult>;
  upsert(record: SearchProjectionRecord): Promise<void>;
  remove(documentId: string): Promise<void>;
  clear(): Promise<void>;
}

/** The page fields search reads; portable page documents and live Automerge pages both provide them. */
export type SearchablePage = Pick<
  PageDocV3,
  'documentId' | 'notebookId' | 'pageId' | 'sectionId' | 'title' | 'tags' | 'taskState' | 'updatedAt'
  | 'zOrder' | 'mathSettings' | 'pageContent'
> & {
  schemaVersion: 2 | 3;
  elementsById: Readonly<Record<string, PageElementV3>>;
};

export interface BuildSearchSourceOptions {
  notebook: Pick<NotebookDoc, 'title' | 'sections'>;
  page: SearchablePage;
  /** Heads of the page document; empty for portable documents without live history. */
  pageHeads?: readonly string[];
  pdfTextByElementId?: ReadonlyMap<string, string>;
  ocrTextByAssetId?: ReadonlyMap<string, string>;
}
