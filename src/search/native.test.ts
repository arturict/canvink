import { expect, test } from 'vitest';

import { TauriSqliteSearchIndex, type NativeInvoke } from './native';
import type { SearchPageSource } from './types';

function source(overrides: Partial<SearchPageSource> = {}): SearchPageSource {
  return {
    documentId: 'page:one',
    notebookId: 'notebook-one',
    pageId: 'page-one',
    sectionId: 'section-one',
    notebookTitle: 'Schule',
    sectionTitle: 'Physik',
    pageTitle: 'Impuls',
    tags: ['prüfung'],
    updatedAt: '2026-08-03T12:00:00.000Z',
    pageHeads: ['head-1'],
    richTextDocuments: [{ type: 'doc', blocks: [{ id: 'paragraph-one', type: 'paragraph', spans: [{ text: 'Erhaltungssatz', marks: [] }] }] }],
    pdfText: ['Textbook layer'],
    ocrText: ['Scan layer'],
    ...overrides,
  };
}

test('projects deterministic bounded rows into native Tauri commands', async () => {
  const calls: Array<[string, Record<string, unknown> | undefined]> = [];
  const call: NativeInvoke = async <T>(command: string, args?: Record<string, unknown>) => {
    calls.push([command, args]);
    return undefined as T;
  };
  const index = new TauriSqliteSearchIndex(call);
  await index.rebuild([source()]);
  expect(calls).toEqual([['search_v2_replace', {
    rows: [{
      documentId: 'page:one',
      pageId: 'page-one',
      title: 'Impuls',
      body: 'Schule\nPhysik\nErhaltungssatz\nTextbook layer\nScan layer',
      tags: 'prüfung',
    }],
  }]]);
});

test('bounds native query limits and routes destructive projection-only operations', async () => {
  const calls: Array<[string, Record<string, unknown> | undefined]> = [];
  const call: NativeInvoke = async <T>(command: string, args?: Record<string, unknown>) => {
    calls.push([command, args]);
    return undefined as T;
  };
  const index = new TauriSqliteSearchIndex(call);
  await index.search('Impuls', 1_000);
  await index.remove('page:one');
  await index.clear();
  expect(calls).toEqual([
    ['search_v2_query', { query: 'Impuls', limit: 100 }],
    ['search_v2_remove', { documentId: 'page:one' }],
    ['search_v2_clear', undefined],
  ]);
});
