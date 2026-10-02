import {
  CorruptSearchIndexError,
  foldSearchToken,
  isEmptySearchQueryExpression,
  normalizeSearchText,
  parseSearchQueryExpression,
  tokenizeSearchText,
  type SearchQueryExpression,
} from './normalize';
import { normalizePageTag } from '../domain/pageTags';
import { projectSearchPage } from './projection';
import {
  SEARCH_LIMITS,
  type SearchField,
  type SearchPageSource,
  type SearchProjectionAdapter,
  type SearchProjectionRecord,
  type SearchResult,
} from './types';

const FIELD_WEIGHTS: Record<SearchField, number> = {
  pageTitle: 12,
  notebookTitle: 5,
  sectionTitle: 5,
  tags: 8,
  checkItems: 6,
  richText: 3,
  math: 4,
  pdfText: 2,
  ocrText: 1,
};

function occurrences(value: string, token: string): number {
  let count = 0;
  let offset = 0;
  while ((offset = value.indexOf(token, offset)) !== -1) {
    count += 1;
    offset += Math.max(token.length, 1);
  }
  return count;
}

function fieldTokens(value: string): Set<string> {
  return new Set(tokenizeSearchText(value));
}

function snippet(value: string, queryTokens: readonly string[]): string {
  const compact = value.replace(/\s+/gu, ' ').trim();
  if (!compact) return '';
  const normalized = normalizeSearchText(compact);
  const offset = queryTokens.reduce((best, token) => {
    const candidate = normalized.indexOf(token);
    return candidate === -1 ? best : Math.min(best, candidate);
  }, Number.MAX_SAFE_INTEGER);
  const start = offset === Number.MAX_SAFE_INTEGER
    ? 0
    : Math.max(0, offset - Math.floor(SEARCH_LIMITS.snippetCharacters / 3));
  const valueSlice = compact.slice(start, start + SEARCH_LIMITS.snippetCharacters);
  return `${start > 0 ? '…' : ''}${valueSlice}${start + valueSlice.length < compact.length ? '…' : ''}`;
}

/**
 * Token sets per field, computed once per record. Records are replaced, never
 * changed, so a record object keys its tokens for as long as it is indexed.
 * Tokenizing every page's text again on each keystroke took most of a second
 * for a notebook with a few hundred pages and printouts.
 */
const recordTokens = new WeakMap<SearchProjectionRecord, Map<SearchField, Set<string>>>();

function tokensOf(record: SearchProjectionRecord): Map<SearchField, Set<string>> {
  let tokensByField = recordTokens.get(record);
  if (!tokensByField) {
    tokensByField = new Map();
    for (const [field, value] of Object.entries(record.fields) as Array<[SearchField, string]>) {
      tokensByField.set(field, fieldTokens(value));
    }
    recordTokens.set(record, tokensByField);
  }
  return tokensByField;
}

/** Whether the record's token sets were computed already. */
function isTokenized(record: SearchProjectionRecord): boolean {
  return recordTokens.has(record);
}

function rankRecord(record: SearchProjectionRecord, queryTokens: readonly string[]): SearchResult | null {
  const tokensByField = tokensOf(record);
  const everyTokenMatches = queryTokens.every((token) =>
    [...tokensByField.values()].some((tokens) => tokens.has(token) || tokens.has(foldSearchToken(token))));
  if (!everyTokenMatches) return null;

  let score = 0;
  const matchedFields: SearchField[] = [];
  for (const [field, value] of Object.entries(record.fields) as Array<[SearchField, string]>) {
    const normalized = normalizeSearchText(value);
    const tokens = tokensByField.get(field) ?? new Set<string>();
    const fieldScore = queryTokens.reduce((sum, token) => {
      if (!tokens.has(token) && !tokens.has(foldSearchToken(token))) return sum;
      return sum + Math.max(1, occurrences(normalized, token));
    }, 0) * FIELD_WEIGHTS[field];
    if (fieldScore > 0) {
      score += fieldScore;
      matchedFields.push(field);
    }
  }
  if (queryTokens.length > 0 && normalizeSearchText(record.fields.pageTitle).includes(queryTokens.join(' '))) score += 20;
  const snippetField = matchedFields.find((field) => field !== 'pageTitle') ?? 'pageTitle';
  return {
    documentId: record.documentId,
    notebookId: record.notebookId,
    pageId: record.pageId,
    score,
    title: record.fields.pageTitle,
    snippet: snippet(record.fields[snippetField], queryTokens),
    matchedFields,
  };
}

function recordTags(record: SearchProjectionRecord): string[] {
  return record.fields.tags.split(/\s+/u).filter(Boolean);
}

function matchesOperators(record: SearchProjectionRecord, expression: SearchQueryExpression): boolean {
  if (expression.taskStates.length > 0
    && (!record.taskState || !expression.taskStates.includes(record.taskState))) return false;
  if (expression.tags.length === 0) return true;
  // Tags stored before normalization existed still match their normalized
  // query form, so an older `Prüfung` tag answers `tag:prüfung`.
  const tags = new Set(recordTags(record).flatMap((tag) => {
    const normalized = normalizePageTag(tag);
    return normalized ? [tag, normalized] : [tag];
  }));
  return expression.tags.every((tag) => tags.has(tag));
}

/**
 * Result for a query that only narrows by operators. There is no matched term
 * to rank or highlight, so ordering falls back to the recency tiebreaker and
 * the snippet shows the start of the page body.
 */
function operatorOnlyResult(
  record: SearchProjectionRecord,
  expression: SearchQueryExpression,
): SearchResult {
  const matchedFields: SearchField[] = [];
  if (expression.tags.length > 0) matchedFields.push('tags');
  if (expression.taskStates.length > 0) matchedFields.push('checkItems');
  const body = [record.fields.richText, record.fields.checkItems, record.fields.math]
    .find((value) => value.trim().length > 0) ?? '';
  return {
    documentId: record.documentId,
    notebookId: record.notebookId,
    pageId: record.pageId,
    score: 0,
    title: record.fields.pageTitle,
    snippet: snippet(body, []),
    matchedFields,
  };
}

/**
 * In-memory search over persisted per-page projection records. The adapter
 * is only written through this class, so memory and storage stay aligned.
 */
export class RebuildableSearchIndex {
  private readonly records = new Map<string, SearchProjectionRecord>();

  constructor(private readonly adapter: SearchProjectionAdapter) {}

  /** Loads the stored records; invalid ones are deleted and counted. */
  async open(): Promise<{ discarded: number }> {
    const { records, discarded } = await this.adapter.load();
    this.records.clear();
    for (const record of records) this.records.set(record.documentId, record);
    return { discarded };
  }

  /** Replaces every record with the projection of `sources`. */
  async rebuild(sources: readonly SearchPageSource[]): Promise<void> {
    if (sources.length > SEARCH_LIMITS.records) throw new Error(`Search rebuild exceeds ${SEARCH_LIMITS.records} pages.`);
    const projected = sources.map(projectSearchPage).sort((left, right) => left.documentId.localeCompare(right.documentId));
    if (new Set(projected.map((record) => record.documentId)).size !== projected.length) {
      throw new CorruptSearchIndexError('Search rebuild contains duplicate documents.');
    }
    await this.adapter.clear();
    this.records.clear();
    for (const record of projected) await this.put(record);
  }

  async upsert(source: SearchPageSource): Promise<SearchProjectionRecord> {
    const projected = projectSearchPage(source);
    await this.put(projected);
    return projected;
  }

  /** Stores an already projected record (for example one with patched titles). */
  async put(record: SearchProjectionRecord): Promise<void> {
    if (!this.records.has(record.documentId) && this.records.size >= SEARCH_LIMITS.records) {
      throw new RangeError(`Search index exceeds ${SEARCH_LIMITS.records} pages.`);
    }
    await this.adapter.upsert(record);
    this.records.set(record.documentId, record);
    // Tokenizing costs about a millisecond per page; doing it here, one record
    // at a time, keeps a query from paying for every record that changed
    // since the last one (a background pass replaces dozens per second).
    tokensOf(record);
  }

  /**
   * Computes the token sets of records that were loaded from storage, for at
   * most `sliceMs` (at least one record). Returns whether every record is
   * done, so a caller can spread the work over idle moments instead of
   * letting the first query tokenize the whole index.
   */
  warm(sliceMs: number): boolean {
    const deadline = performance.now() + sliceMs;
    for (const record of this.records.values()) {
      if (isTokenized(record)) continue;
      tokensOf(record);
      if (performance.now() >= deadline) return this.allTokenized();
    }
    return true;
  }

  private allTokenized(): boolean {
    for (const record of this.records.values()) if (!isTokenized(record)) return false;
    return true;
  }

  async remove(documentId: string): Promise<void> {
    await this.adapter.remove(documentId);
    this.records.delete(documentId);
  }

  get(documentId: string): SearchProjectionRecord | undefined {
    return this.records.get(documentId);
  }

  get size(): number {
    return this.records.size;
  }

  /** Live records without copying; callers must not mutate them. */
  values(): IterableIterator<SearchProjectionRecord> {
    return this.records.values();
  }

  search(query: string, limit = 50): SearchResult[] {
    const expression = parseSearchQueryExpression(query);
    if (isEmptySearchQueryExpression(expression)) return [];
    const { tokens } = expression;
    return [...this.records.values()]
      .filter((record) => matchesOperators(record, expression))
      .map((record) => ({
        record,
        result: tokens.length === 0
          ? operatorOnlyResult(record, expression)
          : rankRecord(record, tokens),
      }))
      .filter((entry): entry is { record: SearchProjectionRecord; result: SearchResult } => entry.result !== null)
      .sort((left, right) =>
        right.result.score - left.result.score
        || right.record.updatedAt.localeCompare(left.record.updatedAt)
        || left.record.pageId.localeCompare(right.record.pageId))
      .slice(0, Math.max(0, Math.min(limit, 100)))
      .map((entry) => entry.result);
  }

  snapshot(): SearchProjectionRecord[] {
    return [...this.records.values()]
      .sort((left, right) => left.documentId.localeCompare(right.documentId))
      .map((record) => structuredClone(record));
  }
}
