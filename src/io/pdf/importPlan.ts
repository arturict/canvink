import { reopenAsset, storeOriginalAsset, type AssetRepository } from '../../assets';
import type { AssetRef, PageDoc, PdfElementV2 } from '../../domain/v2';
import {
  DEFAULT_MATH_PAGE_SETTINGS,
  type PageDocV3,
} from '../../domain/v3';
import { inspectPdf, type InspectPdfOptions, type InspectedPdf, type InspectedPdfPage } from './inspect';

export interface LazyPdfPreview {
  sourceAssetId: AssetRef['assetId'];
  pageNumber: number;
  status: 'lazy';
}

export interface PlannedPdfPage {
  kind: 'pdf-page';
  order: number;
  pageId: string;
  pageDocumentId: string;
  sourcePage: InspectedPdfPage;
  element: Omit<PdfElementV2, 'originalAsset' | 'previewAsset'> & {
    originalAsset: AssetRef;
    previewAsset?: AssetRef;
  };
  lazyPreview: LazyPdfPreview;
}

export interface PlannedBlankPage {
  kind: 'blank-page';
  order: number;
  pageId: string;
  pageDocumentId: string;
  width: number;
  height: number;
}

export interface PdfImportPlan {
  originalAsset: AssetRef;
  inspection: InspectedPdf;
  pages: ReadonlyArray<PlannedPdfPage | PlannedBlankPage>;
}

export interface RenderedImage {
  bytes: Uint8Array;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  width: number;
  height: number;
}

export interface RenderedPdfPage extends RenderedImage {
  /** A small copy for the low-resolution first look while the sharp one loads. */
  thumbnail?: RenderedImage;
}

export interface PdfPreviewRenderer {
  /**
   * Renders one page. A renderer may keep the PDF open while successive calls
   * pass the same `pdfBytes` object, so a multi-page import parses it once.
   */
  renderPage(input: {
    pdfBytes: Uint8Array;
    pageNumber: number;
    maxWidth: number;
    maxPixels: number;
    /** Render exactly this wide (within the limits) instead of at the preview resolution, and without a thumbnail. */
    targetWidth?: number;
  }): Promise<RenderedPdfPage>;
  /** How many `renderPage` calls make progress at the same time; callers may keep that many in flight. */
  readonly concurrency?: number;
  /** Lets go of a PDF kept open by `renderPage`. Callers that render several pages call it when done. */
  release?(): Promise<void>;
}

export interface PdfImportPageDocumentInput {
  pageId: string;
  notebookId: string;
  sectionId: string;
  title: string;
  pageType: PageDoc['pageType'];
  background: PageDoc['background'];
  createdAt: string;
  element?: PdfElementV2;
}

export function createPdfImportPageDocument(
  input: PdfImportPageDocumentInput,
): PageDocV3;
export function createPdfImportPageDocument(
  input: PdfImportPageDocumentInput,
): PageDocV3 {
  const elementsById = input.element
    ? { [input.element.id]: structuredClone(input.element) }
    : {};
  const page = {
    documentId: `page:${input.pageId}`,
    kind: 'page' as const,
    notebookId: input.notebookId,
    sectionId: input.sectionId,
    pageId: input.pageId,
    title: input.title,
    tags: [],
    pageType: input.pageType,
    background: structuredClone(input.background),
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    elementsById,
    zOrder: input.element ? [input.element.id] : [],
    version: { protocol: 'uninitialized' as const, heads: [] },
  };
  return {
    ...page,
    schemaVersion: 3,
    mathSettings: { ...DEFAULT_MATH_PAGE_SETTINGS },
  };
}

export async function importOriginalPdf(
  repository: AssetRepository,
  input: { bytes: Uint8Array; fileName?: string },
  createId: (scope: string) => string,
  appendedBlankPages = 0,
  now: () => string = () => new Date().toISOString(),
  inspectOptions: InspectPdfOptions = {},
): Promise<PdfImportPlan> {
  if (!Number.isSafeInteger(appendedBlankPages) || appendedBlankPages < 0 || appendedBlankPages > 500) {
    throw new Error('Appended blank-page count is invalid.');
  }
  const inspection = await inspectPdf(input.bytes, inspectOptions);
  const stored = await storeOriginalAsset(repository, {
    bytes: input.bytes,
    mimeType: 'application/pdf',
    fileName: input.fileName,
    kind: 'pdf',
  });
  const timestamp = now();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(timestamp) || Number.isNaN(Date.parse(timestamp))) {
    throw new Error('PDF import timestamp is invalid.');
  }
  const pages: Array<PlannedPdfPage | PlannedBlankPage> = inspection.pages.map((page, index) => ({
    kind: 'pdf-page',
    order: index,
    pageId: createId(`pdf-page-${page.pageNumber}`),
    pageDocumentId: createId(`pdf-document-${page.pageNumber}`),
    sourcePage: page,
    element: {
      id: createId(`pdf-background-${page.pageNumber}`),
      kind: 'pdf',
      frame: { x: 0, y: 0, width: page.width, height: page.height, rotation: 0 },
      createdAt: timestamp,
      updatedAt: timestamp,
      locked: true,
      originalAsset: stored.ref,
      pageCount: inspection.pageCount,
      sourcePageNumber: page.pageNumber,
      sourceAvailability: 'original',
    },
    lazyPreview: {
      sourceAssetId: stored.ref.assetId,
      pageNumber: page.pageNumber,
      status: 'lazy',
    },
  }));
  const fallback = inspection.pages.at(-1) ?? { width: 595, height: 842 };
  for (let index = 0; index < appendedBlankPages; index += 1) {
    pages.push({
      kind: 'blank-page',
      order: pages.length,
      pageId: createId(`blank-page-${index + 1}`),
      pageDocumentId: createId(`blank-document-${index + 1}`),
      width: fallback.width,
      height: fallback.height,
    });
  }
  return { originalAsset: stored.ref, inspection, pages };
}

const PREVIEW_EXTENSION = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' } as const;

export async function materializePdfPreview(
  repository: AssetRepository,
  renderer: PdfPreviewRenderer,
  page: PlannedPdfPage,
  /**
   * The verified bytes of `page.element.originalAsset`, when the caller already
   * read them for an earlier page. Reading them again per page copies and
   * hashes the whole PDF each time, and a renderer can only keep a PDF open
   * across pages when it is passed the same bytes.
   */
  pdfBytes?: Uint8Array,
): Promise<{ page: PlannedPdfPage; previewAsset: AssetRef; thumbnail?: RenderedImage }> {
  const source = pdfBytes ?? await reopenAsset(repository, page.element.originalAsset);
  const rendered = await renderer.renderPage({
    pdfBytes: source,
    pageNumber: page.sourcePage.pageNumber,
    maxWidth: 1_600,
    maxPixels: 16_000_000,
  });
  if (
    !Number.isSafeInteger(rendered.width) ||
    !Number.isSafeInteger(rendered.height) ||
    rendered.width < 1 ||
    rendered.height < 1 ||
    rendered.width > 1_600 ||
    rendered.width * rendered.height > 16_000_000
  ) {
    throw new Error('PDF preview renderer returned unsafe dimensions.');
  }
  const preview = await storeOriginalAsset(repository, {
    bytes: rendered.bytes,
    mimeType: rendered.mimeType,
    fileName: `page-${page.sourcePage.pageNumber}.${PREVIEW_EXTENSION[rendered.mimeType]}`,
    kind: 'image',
  });
  if (
    !preview.imageDimensions ||
    preview.imageDimensions.width !== rendered.width ||
    preview.imageDimensions.height !== rendered.height
  ) {
    throw new Error('PDF preview metadata does not match its encoded image.');
  }
  const previewAsset = { ...preview.ref, role: 'preview' as const };
  return {
    previewAsset,
    ...(rendered.thumbnail ? { thumbnail: rendered.thumbnail } : {}),
    page: { ...page, element: { ...page.element, previewAsset } },
  };
}
