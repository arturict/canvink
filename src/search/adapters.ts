import { clear, createStore, del, entries, set } from 'idb-keyval';
import { CorruptSearchIndexError, utf8Length } from './normalize';
import {
  SEARCH_INDEX_VERSION,
  SEARCH_LIMITS,
  type SearchProjectionAdapter,
  type SearchProjectionLoadResult,
  type SearchProjectionRecord,
} from './types';

const RECORD_DATABASE = 'canvink-search-v3';
const RECORD_STORE = 'records';
/** Version 2 kept every record in one value; it is derived and only deleted. */
const LEGACY_DATABASE = 'canvink-search-v2';

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

export function validateSearchRecord(value: unknown): SearchProjectionRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CorruptSearchIndexError('Search projection record is not an object.');
  }
  const candidate = value as Partial<SearchProjectionRecord>;
  if (
    candidate.version !== SEARCH_INDEX_VERSION
    || typeof candidate.documentId !== 'string'
    || !candidate.documentId
    || typeof candidate.notebookId !== 'string'
    || typeof candidate.pageId !== 'string'
    || typeof candidate.sectionId !== 'string'
    || typeof candidate.updatedAt !== 'string'
    || typeof candidate.sourceFingerprint !== 'string'
    || !isStringArray(candidate.pageHeads)
    || typeof candidate.fields !== 'object'
    || candidate.fields === null
  ) {
    throw new CorruptSearchIndexError('Search projection record has an invalid shape.');
  }
  const fields = candidate.fields as Record<string, unknown>;
  let total = 0;
  for (const key of ['pageTitle', 'notebookTitle', 'sectionTitle', 'tags', 'checkItems', 'richText', 'math', 'pdfText', 'ocrText']) {
    const field = fields[key];
    if (typeof field !== 'string' || utf8Length(field) > SEARCH_LIMITS.fieldUtf8Bytes) {
      throw new CorruptSearchIndexError(`Search projection field ${key} is invalid.`);
    }
    total += utf8Length(field);
  }
  if (total > SEARCH_LIMITS.recordUtf8Bytes) {
    throw new CorruptSearchIndexError('Search projection record is oversized.');
  }
  if (candidate.taskState !== undefined && candidate.taskState !== 'open' && candidate.taskState !== 'done') {
    throw new CorruptSearchIndexError('Search projection task state is invalid.');
  }
  if (candidate.pdfTextPending !== undefined && candidate.pdfTextPending !== true) {
    throw new CorruptSearchIndexError('Search projection PDF marker is invalid.');
  }
  return structuredClone(candidate as SearchProjectionRecord);
}

/**
 * Validates stored values one by one. A record that fails validation (an
 * older format, a damaged value, a key that does not match its document) is
 * reported for deletion; the page is simply projected again.
 */
function validateStored(values: Iterable<readonly [unknown, unknown]>): {
  records: SearchProjectionRecord[];
  invalidKeys: unknown[];
} {
  const records: SearchProjectionRecord[] = [];
  const invalidKeys: unknown[] = [];
  for (const [key, value] of values) {
    try {
      const record = validateSearchRecord(value);
      if (record.documentId !== key || records.length >= SEARCH_LIMITS.records) throw new CorruptSearchIndexError('Search record key mismatch.');
      records.push(record);
    } catch (error) {
      if (!(error instanceof CorruptSearchIndexError)) throw error;
      invalidKeys.push(key);
    }
  }
  return { records, invalidKeys };
}

export class InMemorySearchAdapter implements SearchProjectionAdapter {
  private values = new Map<unknown, unknown>();

  /** Stores a raw value under a key, as damaged or outdated storage would. */
  putRaw(key: unknown, value: unknown): void {
    this.values.set(key, structuredClone(value));
  }

  async load(): Promise<SearchProjectionLoadResult> {
    const { records, invalidKeys } = validateStored(this.values.entries());
    invalidKeys.forEach((key) => this.values.delete(key));
    return { records, discarded: invalidKeys.length };
  }

  async upsert(record: SearchProjectionRecord): Promise<void> {
    const checked = validateSearchRecord(record);
    this.values.set(checked.documentId, checked);
  }

  async remove(documentId: string): Promise<void> {
    this.values.delete(documentId);
  }

  async clear(): Promise<void> {
    this.values.clear();
  }
}

/**
 * One IndexedDB value per page document, so an edit rewrites one record
 * instead of the whole index. The Tauri webview uses it too.
 */
export class IndexedDbSearchAdapter implements SearchProjectionAdapter {
  private readonly store = createStore(RECORD_DATABASE, RECORD_STORE);

  async load(): Promise<SearchProjectionLoadResult> {
    deleteLegacyDatabase();
    const { records, invalidKeys } = validateStored(await entries<IDBValidKey, unknown>(this.store));
    for (const key of invalidKeys) await del(key as IDBValidKey, this.store);
    return { records, discarded: invalidKeys.length };
  }

  async upsert(record: SearchProjectionRecord): Promise<void> {
    const checked = validateSearchRecord(record);
    await set(checked.documentId, checked, this.store);
  }

  async remove(documentId: string): Promise<void> {
    await del(documentId, this.store);
  }

  async clear(): Promise<void> {
    await clear(this.store);
  }
}

let legacyDeletionRequested = false;

function deleteLegacyDatabase(): void {
  if (legacyDeletionRequested || typeof indexedDB === 'undefined') return;
  legacyDeletionRequested = true;
  try {
    indexedDB.deleteDatabase(LEGACY_DATABASE);
  } catch {
    // Best effort: the old snapshot is unused derived data.
  }
}
