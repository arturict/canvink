import { invoke } from '@tauri-apps/api/core';

import { projectSearchPage } from './projection';
import { SEARCH_LIMITS, type SearchPageSource, type SearchProjectionRecord } from './types';

interface NativeProjectionRow {
  documentId: string;
  pageId: string;
  title: string;
  body: string;
  tags: string;
}

export interface NativeSearchResult {
  documentId: string;
  pageId: string;
  title: string;
  titleSnippet: string;
  bodySnippet: string;
  tagsSnippet: string;
  score: number;
}

export type NativeInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

function nativeRow(record: SearchProjectionRecord): NativeProjectionRow {
  return {
    documentId: record.documentId,
    pageId: record.pageId,
    title: record.fields.pageTitle,
    body: [
      record.fields.notebookTitle,
      record.fields.sectionTitle,
      record.fields.checkItems,
      record.fields.richText,
      record.fields.pdfText,
      record.fields.ocrText,
    ].filter(Boolean).join('\n'),
    tags: record.fields.tags,
  };
}

/**
 * Rebuildable SQLite FTS projection used by the desktop shell. The Automerge
 * documents and local asset-derived text remain the only source of authority.
 */
export class TauriSqliteSearchIndex {
  constructor(private readonly call: NativeInvoke = invoke) {}

  async rebuild(sources: readonly SearchPageSource[]): Promise<void> {
    await this.replaceRecords(sources.map(projectSearchPage));
  }

  /** Replaces the mirror with rows derived from stored projection records. */
  async replaceRecords(records: readonly SearchProjectionRecord[]): Promise<void> {
    if (records.length > SEARCH_LIMITS.records) {
      throw new RangeError(`Search rebuild exceeds ${SEARCH_LIMITS.records} pages.`);
    }
    const rows = records
      .map(nativeRow)
      .sort((left, right) => left.documentId.localeCompare(right.documentId));
    if (new Set(rows.map((row) => row.documentId)).size !== rows.length) {
      throw new Error('Search rebuild contains duplicate documents.');
    }
    await this.call<void>('search_v2_replace', { rows });
  }

  async upsert(source: SearchPageSource): Promise<void> {
    await this.upsertRecord(projectSearchPage(source));
  }

  async upsertRecord(record: SearchProjectionRecord): Promise<void> {
    await this.call<void>('search_v2_upsert', { row: nativeRow(record) });
  }

  async remove(documentId: string): Promise<void> {
    await this.call<void>('search_v2_remove', { documentId });
  }

  async clear(): Promise<void> {
    await this.call<void>('search_v2_clear');
  }

  async search(query: string, limit = 25): Promise<NativeSearchResult[]> {
    return this.call<NativeSearchResult[]>('search_v2_query', {
      query,
      limit: Math.max(1, Math.min(Math.trunc(limit), 100)),
    });
  }
}

