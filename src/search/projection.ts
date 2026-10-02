import type {
  RichTextBlock,
  RichTextDocument,
  RichTextSpan,
} from '../domain/v2/types';
import { mathPageSettings, pageContent, type MathElementV3, type PageElementV3 } from '../domain/v3';
import { preferredMathLatex, visibleMathResult } from '../io/mathStaticRender';
import { boundedText, joinExtractedText, normalizeSearchText, SearchLimitError, utf8Length } from './normalize';
import {
  SEARCH_INDEX_VERSION,
  SEARCH_LIMITS,
  type BuildSearchSourceOptions,
  type SearchField,
  type SearchPageSource,
  type SearchProjectionRecord,
} from './types';

function spansText(spans: readonly RichTextSpan[]): string {
  return spans.map((span) => span.text).join('');
}

function blockText(block: RichTextBlock): string {
  if (block.type === 'table') {
    return block.rows.map((row) => row.map((cell) => spansText(cell)).join(' | ')).join('\n');
  }
  return spansText(block.spans);
}

function projectRichText(documents: readonly RichTextDocument[]): { richText: string; checkItems: string } {
  const body: string[] = [];
  const checks: string[] = [];
  for (const document of documents) {
    for (const block of document.blocks) {
      const text = blockText(block).trim();
      if (!text) continue;
      if (block.type === 'checkItem') checks.push(`${block.checked ? 'done' : 'open'} ${text}`);
      else body.push(text);
    }
  }
  return { richText: body.join('\n'), checkItems: checks.join('\n') };
}

function assetIds(element: PageElementV3): string[] {
  if (element.kind === 'image' || element.kind === 'attachment') return [element.asset.assetId];
  if (element.kind === 'pdf') {
    const ids: string[] = [element.previewAsset.assetId];
    if (element.originalAsset) ids.unshift(element.originalAsset.assetId);
    return ids;
  }
  return [];
}

export function buildSearchPageSource(options: BuildSearchSourceOptions): SearchPageSource {
  const section = options.notebook.sections.find((candidate) => candidate.id === options.page.sectionId);
  const richTextDocuments: RichTextDocument[] = [];
  const pdfText: string[] = [];
  const ocrText: string[] = [];
  const mathText: string[] = [];
  const settings = options.page.schemaVersion === 3 ? mathPageSettings(options.page) : undefined;
  const content = options.page.schemaVersion === 3 ? pageContent(options.page) : undefined;
  for (const elementId of options.page.zOrder) {
    const element = options.page.elementsById[elementId];
    if (!element) continue;
    if (element.kind === 'richText') richTextDocuments.push(element.content);
    if (element.kind === 'pdf') {
      const extracted = options.pdfTextByElementId?.get(elementId);
      if (extracted) pdfText.push(extracted);
    }
    if (element.kind === 'math') {
      mathText.push(projectMathText(element, settings?.resultMode === 'off' ? undefined : settings?.numberMode ?? 'exact'));
    }
    for (const assetId of assetIds(element)) {
      const recognized = options.ocrTextByAssetId?.get(assetId);
      if (recognized) ocrText.push(recognized);
    }
  }
  return {
    documentId: options.page.documentId,
    notebookId: options.page.notebookId,
    pageId: options.page.pageId,
    sectionId: options.page.sectionId,
    notebookTitle: options.notebook.title,
    sectionTitle: section?.title ?? '',
    pageTitle: options.page.title,
    tags: [...options.page.tags],
    ...(options.page.taskState ? { taskState: options.page.taskState } : {}),
    updatedAt: options.page.updatedAt,
    pageHeads: [...(options.pageHeads ?? [])],
    richTextDocuments,
    ...(content?.kind === 'markdown'
      ? { markdownSource: content.source }
      : {}),
    mathText,
    pdfText,
    ocrText,
  };
}

type FingerprintInput = Pick<
  SearchProjectionRecord,
  'documentId' | 'notebookId' | 'sectionId' | 'updatedAt' | 'taskState' | 'fields'
>;

function fingerprint(input: FingerprintInput): string {
  const serialized = JSON.stringify([
    input.documentId,
    input.notebookId,
    input.sectionId,
    input.updatedAt,
    input.taskState ?? '',
    input.fields,
  ]);
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(serialized)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0');
}

export function projectSearchPage(source: SearchPageSource): SearchProjectionRecord {
  const rich = projectRichText(source.richTextDocuments);
  const fields: Record<SearchField, string> = {
    pageTitle: boundedText(source.pageTitle, 'page title'),
    notebookTitle: boundedText(source.notebookTitle, 'notebook title'),
    sectionTitle: boundedText(source.sectionTitle, 'section title'),
    tags: boundedText(source.tags.join(' '), 'tags'),
    checkItems: boundedText(rich.checkItems, 'check items'),
    richText: boundedText([source.markdownSource, rich.richText].filter(Boolean).join('\n'), 'rich text'),
    math: boundedText((source.mathText ?? []).join('\n'), 'math'),
    pdfText: joinExtractedText(source.pdfText, 'PDF text'),
    ocrText: joinExtractedText(source.ocrText, 'OCR text'),
  };
  const total = Object.values(fields).reduce((sum, value) => sum + utf8Length(value), 0);
  if (total > SEARCH_LIMITS.recordUtf8Bytes) {
    throw new SearchLimitError(`Search projection exceeds ${SEARCH_LIMITS.recordUtf8Bytes} UTF-8 bytes.`);
  }
  const record = {
    documentId: source.documentId,
    notebookId: source.notebookId,
    sectionId: source.sectionId,
    updatedAt: source.updatedAt,
    ...(source.taskState ? { taskState: source.taskState } : {}),
    fields,
  };
  return {
    version: SEARCH_INDEX_VERSION,
    ...record,
    pageId: source.pageId,
    pageHeads: [...source.pageHeads],
    sourceFingerprint: fingerprint(record),
    ...(source.pdfTextPending ? { pdfTextPending: true as const } : {}),
  };
}

/**
 * Notebook and section titles live in the notebook document, so renaming
 * them does not change the page heads. This patches them into a record
 * without reading the page again; it returns the record itself when the
 * titles already match.
 */
export function withLocationTitles(
  record: SearchProjectionRecord,
  notebookTitle: string,
  sectionTitle: string,
): SearchProjectionRecord {
  const nextNotebook = boundedText(notebookTitle, 'notebook title');
  const nextSection = boundedText(sectionTitle, 'section title');
  if (record.fields.notebookTitle === nextNotebook && record.fields.sectionTitle === nextSection) return record;
  const patched = {
    ...record,
    fields: { ...record.fields, notebookTitle: nextNotebook, sectionTitle: nextSection },
  };
  return { ...patched, sourceFingerprint: fingerprint(patched) };
}

/** Whether a record was projected from exactly these page heads (order does not matter). */
export function projectedFromHeads(record: SearchProjectionRecord, heads: readonly string[] | undefined): boolean {
  if (!heads || heads.length === 0 || heads.length !== record.pageHeads.length) return false;
  const stored = new Set(record.pageHeads);
  return heads.every((head) => stored.has(head));
}

export function normalizedProjectionBody(record: SearchProjectionRecord): string {
  return normalizeSearchText([
    record.fields.notebookTitle,
    record.fields.sectionTitle,
    record.fields.pageTitle,
    record.fields.richText,
    record.fields.math,
    record.fields.checkItems,
    record.fields.tags,
    record.fields.pdfText,
    record.fields.ocrText,
  ].join('\n'));
}

function projectMathText(
  element: MathElementV3,
  numberMode: 'exact' | 'decimal' | undefined,
): string {
  const lines = [preferredMathLatex(element)];
  if (numberMode) {
    const result = visibleMathResult(element, numberMode);
    if (result) lines.push(result);
  }
  if (element.dependencies.defines.length > 0) lines.push(`defines ${element.dependencies.defines.join(' ')}`);
  if (element.dependencies.references.length > 0) lines.push(`references ${element.dependencies.references.join(' ')}`);
  return lines.filter(Boolean).join('\n');
}
