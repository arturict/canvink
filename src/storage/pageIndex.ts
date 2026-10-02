import * as Automerge from '@automerge/automerge';
import type { LivePageDocV2 } from '../crdt';
import type { PageDoc } from '../domain/v2';
import type { PageDocV3 } from '../domain/v3';
import { inkRefsOf } from '../ink/projection';

/**
 * What the workspace shows about a page without loading its document: the
 * sidebar, page pins, templates, page locations and the move and copy
 * dialogs read these fields for every page. Everything else (elements, rich
 * text, math) stays in the page document, which the runtime loads on demand.
 */
export interface PageSummary {
  readonly documentId: string;
  readonly pageId: string;
  readonly notebookId: string;
  readonly sectionId: string;
  readonly parentPageId?: string;
  readonly title: string;
  readonly tags: readonly string[];
  readonly taskState?: 'open' | 'done';
  readonly pageType: 'free' | 'a4';
  readonly background: { readonly type: LivePageDocV2['background']['type'] };
  readonly pageContentKind: 'canvas' | 'markdown';
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly schemaVersion: 2 | 3;
  /**
   * Assets the page's images, PDFs and attachments reference, with the MIME
   * type and file name of the reference (exports need them without loading
   * the page).
   */
  readonly assets: readonly PageAssetReference[];
  /** Heads of the page document the summary was derived from. */
  readonly heads: readonly string[];
}

export interface PageAssetReference {
  readonly assetId: string;
  readonly mimeType: string;
  readonly fileName?: string;
}

export const PAGE_INDEX_NAMESPACE = 'canvink-page-index';
/**
 * Every Repo chunk write of a document also writes a marker under
 * `[DIRTY_NAMESPACE, storageId, chunk]` in the same atomic storage commit
 * (see `CanvinkStorageAdapter`). A page's index entry is only trusted when no
 * marker is left for it; writing a fresh entry removes the markers it covers.
 */
export const DIRTY_NAMESPACE = 'canvink-dirty';
export const PAGE_INDEX_VERSION = 2 as const;

export interface PageIndexEntry {
  version: typeof PAGE_INDEX_VERSION;
  storageId: string;
  documentId: string;
  /**
   * The page is listed with its published summary but this device holds no
   * document for it yet (a personal-space page still to be downloaded). The
   * flag lives with the index entry that stands for the page in that state.
   */
  placeholder?: true;
  /**
   * The activation heads of the document when the entry was written. A
   * commit that rewrote the document changes them, so an entry that does not
   * match the current activation is stale even without dirty markers.
   */
  activationHeads: string[];
  summary: PageSummary;
}

type SummarySource = Pick<
  LivePageDocV2 | PageDoc | PageDocV3,
  | 'documentId'
  | 'pageId'
  | 'notebookId'
  | 'sectionId'
  | 'parentPageId'
  | 'title'
  | 'tags'
  | 'taskState'
  | 'pageType'
  | 'background'
  | 'createdAt'
  | 'updatedAt'
> & {
  schemaVersion: 2 | 3;
  pageContent?: PageDocV3['pageContent'];
  elementsById?: Readonly<Record<string, unknown>>;
};

/** Assets referenced by a page's elements, one per asset ID, sorted by ID. */
/** The MIME type an ink segment carries where it travels like an asset (exports, backups, the cloud). */
export const INK_SEGMENT_MIME_TYPE = 'application/vnd.canvink.ink-segment';

export function pageAssetReferences(
  elementsById: Readonly<Record<string, unknown>> | undefined,
  inkSegments?: Readonly<Record<string, unknown>>,
): PageAssetReference[] {
  const references = new Map<string, PageAssetReference>();
  const add = (ref: { assetId?: string; mimeType?: string; fileName?: string } | undefined): void => {
    if (!ref?.assetId || references.has(ref.assetId)) return;
    references.set(ref.assetId, {
      assetId: ref.assetId,
      mimeType: ref.mimeType ?? 'application/octet-stream',
      ...(ref.fileName ? { fileName: ref.fileName } : {}),
    });
  };
  for (const value of Object.values(elementsById ?? {})) {
    const element = value as {
      kind?: string;
      asset?: { assetId?: string; mimeType?: string; fileName?: string };
      previewAsset?: { assetId?: string; mimeType?: string; fileName?: string };
      originalAsset?: { assetId?: string; mimeType?: string; fileName?: string };
    };
    if (element.kind === 'image' || element.kind === 'attachment') add(element.asset);
    else if (element.kind === 'pdf') {
      add(element.previewAsset);
      add(element.originalAsset);
    }
  }
  // Ink segments are content-addressed blobs like assets; exports need them without loading the page.
  for (const hash of Object.keys(inkSegments ?? {})) {
    references.set(`sha256:${hash}`, { assetId: `sha256:${hash}`, mimeType: INK_SEGMENT_MIME_TYPE });
  }
  return [...references.values()].sort((left, right) => left.assetId.localeCompare(right.assetId));
}

export function summarizePage(
  page: SummarySource,
  heads: readonly string[],
  assets: readonly PageAssetReference[] = pageAssetReferences(
    page.elementsById,
    inkRefsOf(page),
  ),
): PageSummary {
  return Object.freeze({
    documentId: page.documentId,
    pageId: page.pageId,
    notebookId: page.notebookId,
    sectionId: page.sectionId,
    ...(page.parentPageId ? { parentPageId: page.parentPageId } : {}),
    title: page.title,
    tags: Object.freeze([...page.tags]),
    ...(page.taskState ? { taskState: page.taskState } : {}),
    pageType: page.pageType,
    background: Object.freeze({ type: page.background.type }),
    pageContentKind: page.pageContent?.kind === 'markdown' ? 'markdown' : 'canvas',
    createdAt: page.createdAt,
    updatedAt: page.updatedAt,
    schemaVersion: page.schemaVersion,
    assets: Object.freeze(assets.map((asset) => Object.freeze({ ...asset }))),
    heads: Object.freeze([...heads]),
  });
}

/** Summary of a live Automerge page document, read without materialising its elements. */
export function summarizePageDocument(document: Automerge.Doc<LivePageDocV2>): PageSummary {
  return summarizePage(document as unknown as SummarySource, Automerge.getHeads(document));
}

export function samePageSummary(left: PageSummary | undefined, right: PageSummary): boolean {
  return left !== undefined && JSON.stringify(left) === JSON.stringify(right);
}

export function encodePageIndexEntry(entry: PageIndexEntry): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(entry));
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/**
 * Validates a summary read from storage or from the personal space's workspace
 * document and rebuilds it in its frozen form; anything unexpected is
 * undefined, since summaries are derived data. The workspace document carries
 * summaries without their asset references (see `summaryPublishing.ts`), so a
 * missing list reads as empty.
 */
export function parsePageSummary(value: unknown, documentId: string): PageSummary | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const summary = value as Partial<PageSummary>;
  if (
    summary.documentId !== documentId
    || typeof summary.pageId !== 'string'
    || typeof summary.notebookId !== 'string'
    || typeof summary.sectionId !== 'string'
    || typeof summary.title !== 'string'
    || !isStringArray(summary.tags)
    || (summary.pageType !== 'free' && summary.pageType !== 'a4')
    || typeof summary.background?.type !== 'string'
    || typeof summary.createdAt !== 'string'
    || typeof summary.updatedAt !== 'string'
    || (summary.schemaVersion !== 2 && summary.schemaVersion !== 3)
    || !isStringArray(summary.heads)
    || summary.heads.length === 0
    || (summary.assets !== undefined && (
      !Array.isArray(summary.assets)
      || summary.assets.some((asset) => typeof asset?.assetId !== 'string' || typeof asset.mimeType !== 'string')
    ))
  ) return undefined;
  return summarizePage({
    ...(summary as PageSummary),
    tags: [...summary.tags],
    background: { ...summary.background } as LivePageDocV2['background'],
    pageContent: summary.pageContentKind === 'markdown'
      ? { version: 1, kind: 'markdown', source: '' }
      : { version: 1, kind: 'canvas' },
  } as SummarySource, summary.heads, summary.assets ?? []);
}

/**
 * The summary an account's workspace document publishes for a page. It is stored as one immutable
 * string of JSON: every character of a plain string in an Automerge document is an operation of its
 * own, so a summary written as nested text fields made the workspace document of a 450-page account
 * several times slower to load than the same summary as a single value. A map of fields, which older
 * builds published, is still read.
 */
export function parsePublishedSummary(value: unknown, documentId: string): PageSummary | undefined {
  const text = typeof value === 'string' ? value : Automerge.isImmutableString(value) ? value.toString() : undefined;
  if (text === undefined) return parsePageSummary(value, documentId);
  try {
    return parsePageSummary(JSON.parse(text) as unknown, documentId);
  } catch {
    return undefined;
  }
}

/** Parses a stored entry; anything unexpected is treated as missing, since the index is derived. */
export function decodePageIndexEntry(bytes: Uint8Array): PageIndexEntry | undefined {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const entry = value as Partial<PageIndexEntry>;
  if (
    entry.version !== PAGE_INDEX_VERSION
    || typeof entry.storageId !== 'string'
    || typeof entry.documentId !== 'string'
    || !isStringArray(entry.activationHeads)
    || (entry.placeholder !== undefined && entry.placeholder !== true)
  ) return undefined;
  const summary = parsePageSummary(entry.summary, entry.documentId);
  if (!summary) return undefined;
  return {
    version: PAGE_INDEX_VERSION,
    storageId: entry.storageId,
    documentId: entry.documentId,
    activationHeads: [...entry.activationHeads],
    ...(entry.placeholder ? { placeholder: true as const } : {}),
    summary,
  };
}

export function sameHeadSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const set = new Set(left);
  return right.every((head) => set.has(head));
}
