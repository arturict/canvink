import type { NotebookDoc, PageDoc, RichTextDocument } from '../domain/v2/types';
import { expect, test } from 'vitest';
import { InMemorySearchAdapter } from './adapters';
import { RebuildableSearchIndex } from './index';
import {
  CorruptSearchIndexError,
  SearchLimitError,
  isEmptySearchQueryExpression,
  parseSearchQueryExpression,
  tokenizeSearchText,
  utf8Length,
} from './normalize';
import { buildSearchPageSource, projectedFromHeads, projectSearchPage, withLocationTitles } from './projection';
import { SEARCH_INDEX_VERSION, SEARCH_LIMITS, type SearchPageSource } from './types';

function richText(): RichTextDocument {
  return {
    type: 'doc',
    blocks: [
      { id: 'h', type: 'heading', level: 2, spans: [{ text: 'Kräfte & Impuls', marks: [{ type: 'bold' }] }] },
      { id: 'p', type: 'paragraph', spans: [{ text: 'Die Größe ist Δp = F · Δt.', marks: [{ type: 'italic' }] }] },
      { id: 'c1', type: 'checkItem', checked: false, spans: [{ text: 'Versuch auswerten', marks: [] }] },
      { id: 'c2', type: 'checkItem', checked: true, spans: [{ text: 'Messwerte prüfen', marks: [] }] },
      {
        id: 't',
        type: 'table',
        rows: [[[{ text: 'Zeit', marks: [] }], [{ text: 'Impuls', marks: [{ type: 'inlineCode' }] }]]],
      },
    ],
  };
}

function source(overrides: Partial<SearchPageSource> = {}): SearchPageSource {
  return {
    documentId: 'page:1',
    notebookId: 'notebook:physics',
    pageId: 'page-1',
    sectionId: 'section-1',
    notebookTitle: 'Physik',
    sectionTitle: 'Mechanik',
    pageTitle: 'Impulserhaltung',
    tags: ['prüfung', 'todo'],
    taskState: 'open',
    updatedAt: '2026-08-03T12:00:00.000Z',
    pageHeads: ['head-1'],
    richTextDocuments: [richText()],
    mathText: [],
    pdfText: ['Arbeitsblatt: Stoß zweier Wagen'],
    ocrText: ['Federkraft größer als Gewichtskraft'],
    ...overrides,
  };
}

test('projects titles, marked rich text, checklists, tags, PDF text, and OCR text deterministically', () => {
  const first = projectSearchPage(source());
  const second = projectSearchPage(source());
  expect(first).toEqual(second);
  expect(first.fields).toMatchObject({
    pageTitle: 'Impulserhaltung',
    notebookTitle: 'Physik',
    sectionTitle: 'Mechanik',
    tags: 'prüfung todo',
    checkItems: 'open Versuch auswerten\ndone Messwerte prüfen',
    pdfText: 'Arbeitsblatt: Stoß zweier Wagen',
    ocrText: 'Federkraft größer als Gewichtskraft',
  });
  expect(first.fields.richText).toContain('Kräfte & Impuls');
  expect(first.fields.richText).toContain('Zeit | Impuls');
});

test('indexes normalized OneNote tags and task state for local search', async () => {
  const adapter = new InMemorySearchAdapter();
  const index = new RebuildableSearchIndex(adapter);
  await index.rebuild([
    source({
      tags: ['important', 'onenote:customer-follow-up', 'todo'],
      taskState: 'open',
    }),
  ]);
  expect(index.search('customer-follow-up')).toEqual([
    expect.objectContaining({ pageId: 'page-1' }),
  ]);
  expect(index.search('important')).toEqual([
    expect.objectContaining({ pageId: 'page-1' }),
  ]);
});

test('builds source data in stable z-order from portable notebook/page documents', () => {
  const notebook: NotebookDoc = {
    schemaVersion: 2,
    documentId: 'notebook:1',
    kind: 'notebook',
    notebookId: 'notebook-1',
    title: 'Physik',
    color: '#fff',
    createdAt: '2026-08-03T00:00:00Z',
    updatedAt: '2026-08-03T00:00:00Z',
    sections: [{ id: 'section-1', title: 'Mechanik', createdAt: '2026-08-03T00:00:00Z', updatedAt: '2026-08-03T00:00:00Z', pageDocumentIds: ['page:1'] }],
    settings: { defaultPageType: 'free' },
    version: { protocol: 'automerge', heads: [] },
  };
  const common = {
    frame: { x: 0, y: 0, width: 100, height: 100, rotation: 0 },
    createdAt: '2026-08-03T00:00:00Z',
    updatedAt: '2026-08-03T00:00:00Z',
    locked: false,
  };
  const page: PageDoc = {
    schemaVersion: 2,
    documentId: 'page:1',
    kind: 'page',
    notebookId: 'notebook-1',
    sectionId: 'section-1',
    pageId: 'page-1',
    title: 'Kräfte',
    tags: ['schule'],
    pageType: 'free',
    background: { type: 'grid', color: '#fff' },
    createdAt: common.createdAt,
    updatedAt: common.updatedAt,
    elementsById: {
      rich: { id: 'rich', kind: 'richText', ...common, content: richText(), style: { color: '#000', fontFamily: 'sans', fontSize: 16, textAlign: 'left' } },
      pdf: { id: 'pdf', kind: 'pdf', ...common, previewAsset: { assetId: 'sha256:preview', checksum: 'sha256:preview', mimeType: 'image/png', size: 4, role: 'preview' }, pageCount: 1, sourceAvailability: 'preview-only' },
    },
    zOrder: ['rich', 'pdf'],
    version: { protocol: 'automerge', heads: [] },
  };
  const built = buildSearchPageSource({
    notebook,
    page,
    pdfTextByElementId: new Map([['pdf', 'PDF Layer']]),
    ocrTextByAssetId: new Map([['sha256:preview', 'Scan OCR']]),
  });
  expect(built.sectionTitle).toBe('Mechanik');
  expect(built.pdfText).toEqual(['PDF Layer']);
  expect(built.ocrText).toEqual(['Scan OCR']);
});

test('indexes corrected Math Canvas text, visible results, definitions, and references without raw ink or provider warnings', () => {
  const notebook = {
    schemaVersion: 3 as const, documentId: 'notebook:math', kind: 'notebook' as const,
    notebookId: 'notebook-math', title: 'Mathematik', color: '#fff',
    createdAt: '2026-08-03T00:00:00Z', updatedAt: '2026-08-03T00:00:00Z',
    sections: [{ id: 'section-1', title: 'Algebra', createdAt: '2026-08-03T00:00:00Z', updatedAt: '2026-08-03T00:00:00Z', pageDocumentIds: ['page:math'] }],
    settings: { defaultPageType: 'free' as const }, version: { protocol: 'automerge' as const, heads: [] },
  };
  const rawSentinel = 'raw-stroke-secret';
  const page = {
    schemaVersion: 3 as const, documentId: 'page:math', kind: 'page' as const,
    notebookId: notebook.notebookId, sectionId: 'section-1', pageId: 'math', title: 'Variablen', tags: [],
    pageType: 'free' as const, background: { type: 'plain' as const, color: '#fff' },
    createdAt: notebook.createdAt, updatedAt: notebook.updatedAt,
    mathSettings: { version: 1 as const, resultMode: 'suggest' as const, numberMode: 'decimal' as const, angleMode: 'degrees' as const, autoRecognition: true },
    pageContent: { version: 1 as const, kind: 'markdown' as const, source: '# Binomische Formeln\n\nQuadrat ergänzen' },
    elementsById: {
      math: {
        id: 'math', kind: 'math' as const, frame: { x: 0, y: 0, width: 100, height: 50, rotation: 0 },
        createdAt: notebook.createdAt, updatedAt: notebook.updatedAt, locked: false,
        inputKind: 'converted-ink' as const, autoRecognition: 'inherit' as const,
        rawInk: { captureFrame: { x: 0, y: 0, width: 10, height: 10, rotation: 0 }, sourceStrokes: [{
          id: rawSentinel, kind: 'stroke' as const, frame: { x: 0, y: 0, width: 10, height: 10, rotation: 0 },
          createdAt: notebook.createdAt, updatedAt: notebook.updatedAt, locked: false, tool: 'pen' as const,
          points: [{ x: 0, y: 0, pressure: 0.5, tiltX: 0, tiltY: 0, time: 0, pointerType: 'pen' }],
          color: '#000', size: 1, opacity: 1,
        }] },
        recognizedLatex: 'recognized-sentinel', correctedLatex: 'a=x^2',
        recognition: { state: 'recognized' as const, alternatives: [], warnings: ['provider-warning-secret'] },
        result: { state: 'valid' as const, exactLatex: '1/3', decimalText: '0.333', diagnostics: [] },
        dependencies: { defines: ['a'], references: ['x'], dependsOnElementIds: [], state: 'valid' as const },
      },
    },
    zOrder: ['math'], version: { protocol: 'automerge' as const, heads: [] },
  };
  const projected = projectSearchPage(buildSearchPageSource({ notebook, page }));
  expect(projected.version).toBe(SEARCH_INDEX_VERSION);
  expect(projected.fields.math).toContain('a=x^2');
  expect(projected.fields.math).toContain('0.333');
  expect(projected.fields.math).toContain('defines a');
  expect(projected.fields.math).toContain('references x');
  expect(projected.fields.math).not.toContain(rawSentinel);
  expect(projected.fields.math).not.toContain('provider-warning-secret');
  expect(projected.fields.math).not.toContain('recognized-sentinel');
  expect(projected.fields.richText).toContain('Binomische Formeln');
  expect(projected.fields.richText).toContain('Quadrat ergänzen');
});

test('normalizes German words, mathematical Unicode, and compatibility forms without locale drift', () => {
  expect(tokenizeSearchText('GRÖSSE Straße ∑ √ π 𝟚')).toEqual([
    'grösse', 'grosse', 'straße', 'strasse', '∑', '√', 'π', '2',
  ]);
});

test('ranks exact titles above rich text, PDF, and OCR while returning bounded snippets', async () => {
  const adapter = new InMemorySearchAdapter();
  const index = new RebuildableSearchIndex(adapter);
  await index.rebuild([
    source(),
    source({ documentId: 'page:2', pageId: 'page-2', pageTitle: 'Andere Seite', richTextDocuments: [], pdfText: [], ocrText: ['Impulserhaltung im Scan'] }),
  ]);
  const results = index.search('Impulserhaltung');
  expect(results.map((result) => result.pageId)).toEqual(['page-1', 'page-2']);
  expect(results[0]?.score).toBeGreaterThan(results[1]?.score ?? 0);
  expect(results.every((result) => result.snippet.length <= SEARCH_LIMITS.snippetCharacters + 2)).toBe(true);
});

test('incremental updates converge to the exact deterministic full rebuild', async () => {
  const updated = source({ pageTitle: 'Aktualisierte Impulserhaltung', updatedAt: '2026-08-03T13:00:00.000Z' });
  const incremental = new RebuildableSearchIndex(new InMemorySearchAdapter());
  await incremental.rebuild([source()]);
  await incremental.upsert(updated);

  const rebuilt = new RebuildableSearchIndex(new InMemorySearchAdapter());
  await rebuilt.rebuild([updated]);
  expect(incremental.snapshot()).toEqual(rebuilt.snapshot());
});

test('prepares stored records for searching in slices and answers the same before and after', async () => {
  const adapter = new InMemorySearchAdapter();
  const stored = new RebuildableSearchIndex(adapter);
  const pages = Array.from({ length: 30 }, (_, index) => source({
    documentId: `page:${index}`, pageId: `page-${index}`, pageTitle: `Seite ${index}`, ocrText: [`Wort${index}`],
  }));
  await stored.rebuild(pages);

  const reopened = new RebuildableSearchIndex(adapter);
  await reopened.open();
  const before = new RebuildableSearchIndex(adapter);
  await before.open();
  // A zero budget still prepares one record per call, so the loop ends.
  let slices = 0;
  while (!reopened.warm(0)) slices += 1;
  expect(slices).toBeGreaterThan(1);
  expect(reopened.warm(0)).toBe(true);
  expect(reopened.search('Wort7')).toEqual(before.search('Wort7'));
});

test('keeps valid stored records and discards invalid or outdated ones individually', async () => {
  const adapter = new InMemorySearchAdapter();
  const stored = new RebuildableSearchIndex(adapter);
  await stored.rebuild([source(), source({ documentId: 'page:2', pageId: 'page-2', pageTitle: 'Zweite Seite' })]);
  adapter.putRaw('page:old', { version: 2, documentId: 'page:old', title: 'stale authority' });
  const { pageHeads: _heads, ...withoutHeads } = projectSearchPage(source({ documentId: 'page:3', pageId: 'page-3' }));
  void _heads;
  adapter.putRaw('page:3', withoutHeads);
  adapter.putRaw('page:elsewhere', projectSearchPage(source({ documentId: 'page:4', pageId: 'page-4' })));

  const reopened = new RebuildableSearchIndex(adapter);
  await expect(reopened.open()).resolves.toEqual({ discarded: 3 });
  expect(reopened.snapshot().map((record) => record.documentId)).toEqual(['page:1', 'page:2']);
  expect(reopened.get('page:1')?.pageHeads).toEqual(['head-1']);
  expect(reopened.search('Impulserhaltung').map((result) => result.pageId)).toContain('page-1');
  await expect(adapter.load()).resolves.toMatchObject({ discarded: 0 });
});

test('patches notebook and section titles without the page and recognises the projected heads', () => {
  const record = projectSearchPage(source());
  expect(withLocationTitles(record, 'Physik', 'Mechanik')).toBe(record);
  const renamed = withLocationTitles(record, 'Naturwissenschaften', 'Dynamik');
  expect(renamed.fields).toMatchObject({ notebookTitle: 'Naturwissenschaften', sectionTitle: 'Dynamik', pageTitle: 'Impulserhaltung' });
  expect(renamed).toEqual(projectSearchPage(source({ notebookTitle: 'Naturwissenschaften', sectionTitle: 'Dynamik' })));
  expect(projectedFromHeads(record, ['head-1'])).toBe(true);
  expect(projectedFromHeads(record, ['head-2'])).toBe(false);
  expect(projectedFromHeads(record, [])).toBe(false);
  expect(projectedFromHeads(record, undefined)).toBe(false);
});

test('rejects duplicate source identities and huge extracted/OCR inputs without affecting source data', async () => {
  const index = new RebuildableSearchIndex(new InMemorySearchAdapter());
  await expect(index.rebuild([source(), source()])).rejects.toBeInstanceOf(CorruptSearchIndexError);
  const oversized = 'x'.repeat(SEARCH_LIMITS.fieldUtf8Bytes + 1);
  expect(() => projectSearchPage(source({ ocrText: [oversized] }))).toThrow(SearchLimitError);
});

/** The text of one printed worksheet page: a shared task text and one word only this page has. */
function worksheetPageText(index: number): string {
  const lines = Array.from({ length: 40 }, (_, line) => `${line + 1}. Berechne die Ableitung der Funktion mit Parameter ${line}`);
  return `Seite ${index} arbeitsblattwort${index} ${lines.join(' ')}`;
}

test('keeps every word of a page with hundreds of printouts instead of rejecting the page', async () => {
  const pdfText = Array.from({ length: 486 }, (_, index) => worksheetPageText(index));
  expect(pdfText.join('\n').length).toBeGreaterThan(SEARCH_LIMITS.fieldUtf8Bytes);

  const record = projectSearchPage(source({ pdfText, ocrText: [] }));
  expect(utf8Length(record.fields.pdfText)).toBeLessThanOrEqual(SEARCH_LIMITS.fieldUtf8Bytes);
  // Whole texts stay in order while they fit; later ones contribute their words.
  expect(record.fields.pdfText.startsWith(pdfText[0])).toBe(true);

  const index = new RebuildableSearchIndex(new InMemorySearchAdapter());
  await index.put(record);
  for (const printout of [0, 1, 250, 485]) {
    expect(index.search(`arbeitsblattwort${printout}`).map((result) => result.documentId)).toEqual(['page:1']);
  }
  expect(index.search('arbeitsblattwort486')).toEqual([]);
});

test('keeps the words of many recognised images on one page and stores identical texts once', () => {
  const ocrText = Array.from({ length: 300 }, (_, index) => `Scan ${index} ocrwort${index} ${'Text '.repeat(600)}`);
  const record = projectSearchPage(source({ pdfText: [], ocrText }));
  expect(utf8Length(record.fields.ocrText)).toBeLessThanOrEqual(SEARCH_LIMITS.fieldUtf8Bytes);
  const tokens = new Set(tokenizeSearchText(record.fields.ocrText));
  expect(tokens.has('ocrwort0') && tokens.has('ocrwort299')).toBe(true);

  const repeated = projectSearchPage(source({ pdfText: ['Gleiches Blatt', 'Gleiches Blatt', 'Anderes Blatt'], ocrText: [] }));
  expect(repeated.fields.pdfText).toBe('Gleiches Blatt\nAnderes Blatt');
});

function taskSource(overrides: Partial<SearchPageSource>): SearchPageSource {
  return source({
    richTextDocuments: [],
    pdfText: [],
    ocrText: [],
    ...overrides,
  });
}

test('parses tag and task operators, and keeps unknown operator values as free text', () => {
  expect(parseSearchQueryExpression('Impuls tag:Prüfung is:open')).toEqual({
    tokens: ['impuls'],
    tags: ['prufung'],
    taskStates: ['open'],
  });
  expect(parseSearchQueryExpression('is:task')).toEqual({
    tokens: [],
    tags: [],
    taskStates: ['open', 'done'],
  });
  expect(parseSearchQueryExpression('is:vielleicht')).toMatchObject({
    tokens: ['is', 'vielleicht'],
    tags: [],
    taskStates: [],
  });
  expect(parseSearchQueryExpression('tag:***')).toMatchObject({ tags: [] });
  expect(isEmptySearchQueryExpression(parseSearchQueryExpression('   '))).toBe(true);
  expect(() => parseSearchQueryExpression('tag:a tag:b tag:c tag:d tag:e tag:f tag:g tag:h tag:i'))
    .toThrow(SearchLimitError);
});

test('narrows results by task state and tag without any free-text term', async () => {
  const index = new RebuildableSearchIndex(new InMemorySearchAdapter());
  await index.rebuild([
    taskSource({ documentId: 'page:a', pageId: 'a', pageTitle: 'Offene Aufgabe', tags: ['todo'], taskState: 'open' }),
    taskSource({ documentId: 'page:b', pageId: 'b', pageTitle: 'Erledigte Aufgabe', tags: ['todo'], taskState: 'done' }),
    taskSource({ documentId: 'page:c', pageId: 'c', pageTitle: 'Keine Aufgabe', tags: ['idee'], taskState: undefined }),
  ]);

  expect(index.search('is:open').map((result) => result.pageId)).toEqual(['a']);
  expect(index.search('is:done').map((result) => result.pageId)).toEqual(['b']);
  expect(index.search('is:task').map((result) => result.pageId).sort()).toEqual(['a', 'b']);
  expect(index.search('tag:idee').map((result) => result.pageId)).toEqual(['c']);
  expect(index.search('tag:todo is:open').map((result) => result.pageId)).toEqual(['a']);
  expect(index.search('tag:todo tag:idee')).toEqual([]);
  expect(index.search('is:open')[0]?.matchedFields).toEqual(['checkItems']);
});

test('combines operators with free text and matches tags stored before normalization', async () => {
  const index = new RebuildableSearchIndex(new InMemorySearchAdapter());
  await index.rebuild([
    taskSource({ documentId: 'page:a', pageId: 'a', pageTitle: 'Impulserhaltung', tags: ['Prüfung'], taskState: 'open' }),
    taskSource({ documentId: 'page:b', pageId: 'b', pageTitle: 'Impulserhaltung', tags: ['idee'], taskState: 'open' }),
  ]);

  expect(index.search('Impulserhaltung tag:prüfung').map((result) => result.pageId)).toEqual(['a']);
  expect(index.search('Impulserhaltung is:done')).toEqual([]);
  expect(index.search('Wärmelehre is:open')).toEqual([]);
});

/** The straightforward definitions the faster ones must agree with. */
function referenceUtf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function referenceTokens(value: string): string[] {
  const normalize = (text: string) => text.normalize('NFKC').toLocaleLowerCase('und').replace(/\s+/gu, ' ').trim();
  const fold = (text: string) => normalize(text).normalize('NFKD').replace(/\p{M}+/gu, '').replaceAll('ß', 'ss');
  const tokens: string[] = [];
  const seen = new Set<string>();
  for (const match of normalize(value).matchAll(/[\p{L}\p{N}]+(?:[.'’_-][\p{L}\p{N}]+)*|[\p{Sm}]/gu)) {
    const token = match[0];
    if (referenceUtf8Length(token) > SEARCH_LIMITS.tokenLength) continue;
    for (const candidate of [token, fold(token)]) {
      if (candidate && !seen.has(candidate)) {
        seen.add(candidate);
        tokens.push(candidate);
      }
    }
  }
  return tokens;
}

test('measures UTF-8 length and tokenizes exactly like the reference definitions', () => {
  const pieces = [
    'Impuls', 'Größe', 'STRASSE', 'Straße', 'ẞ', 'ﬁnal', 'x²', 'ℌilbert', 'Å', 'é', 'ǅ', 'İstanbul', 'ΣΊΣΥΦΟΣ', 'ς',
    '日本語', '😀', '\ud83d', '\ude00', 'a-b', "l'été", '3.14', '∑', '√', '𝟚', ' ', '\n', '\t', 'ａｂｃ', 'ⅷ', '½',
    'x'.repeat(70),
  ];
  let state = 0x1234_5678;
  const next = (limit: number): number => {
    state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
    return state % limit;
  };
  for (let round = 0; round < 3000; round += 1) {
    const text = Array.from({ length: 1 + next(12) }, () => pieces[next(pieces.length)]).join(next(3) === 0 ? '' : ' ');
    expect(utf8Length(text)).toBe(referenceUtf8Length(text));
    expect(tokenizeSearchText(text)).toEqual(referenceTokens(text));
  }
});
