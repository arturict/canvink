import { MAX_IMAGE_PIXELS, MAX_PDF_FILE_BYTES, MAX_PDF_PAGES } from '../../domain/limits';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

export const MAX_PDF_TEXT_BYTES_PER_PAGE = 2 * 1024 * 1024;

export interface InspectedPdfPage {
  pageNumber: number;
  width: number;
  height: number;
  rotation: number;
  text: string;
  hasExtractableText: boolean;
}

export interface InspectedPdf {
  pageCount: number;
  pages: readonly InspectedPdfPage[];
}

export interface InspectPdfOptions {
  /**
   * Extract every page's text. A printout that is only drawn on has no use for
   * it, and reading the text of a few hundred pages is most of the inspection.
   */
  text?: boolean;
}

export async function inspectPdf(bytes: Uint8Array, options: InspectPdfOptions = {}): Promise<InspectedPdf> {
  const withText = options.text !== false;
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 8 || bytes.byteLength > MAX_PDF_FILE_BYTES) {
    throw new Error('PDF exceeds the supported byte limits.');
  }
  if (String.fromCharCode(...bytes.slice(0, 5)) !== '%PDF-') {
    throw new Error('PDF header is invalid.');
  }
  assertPdfEndsAtEof(bytes);
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  if (typeof window !== 'undefined') pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    stopAtErrors: true,
    disableAutoFetch: true,
    disableStream: true,
    useSystemFonts: true,
  });
  try {
    const document = await task.promise;
    try {
      if (document.numPages < 1 || document.numPages > MAX_PDF_PAGES) {
        throw new Error(`PDF must contain between 1 and ${MAX_PDF_PAGES} pages.`);
      }
      const pages: InspectedPdfPage[] = [];
      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
        const page = await document.getPage(pageNumber);
        try {
          const viewport = page.getViewport({ scale: 1 });
          if (
            !Number.isFinite(viewport.width) ||
            !Number.isFinite(viewport.height) ||
            viewport.width <= 0 ||
            viewport.height <= 0 ||
            viewport.width * viewport.height > MAX_IMAGE_PIXELS
          ) {
            throw new Error(`PDF page ${pageNumber} has unsafe dimensions.`);
          }
          const pageText = withText
            ? boundedPageText((await page.getTextContent({ disableNormalization: false })).items, pageNumber)
            : '';
          pages.push({
            pageNumber,
            width: viewport.width,
            height: viewport.height,
            rotation: viewport.rotation,
            text: pageText,
            hasExtractableText: pageText.length > 0,
          });
        } finally {
          page.cleanup();
        }
      }
      return { pageCount: document.numPages, pages };
    } finally {
      document.cleanup();
    }
  } catch (error) {
    throw normalizePdfError(error);
  } finally {
    await task.destroy().catch(() => undefined);
  }
}

function assertPdfEndsAtEof(bytes: Uint8Array): void {
  let end = bytes.byteLength;
  while (end > 0 && isPdfTrailingWhitespace(bytes[end - 1])) end -= 1;
  const eof = [0x25, 0x25, 0x45, 0x4f, 0x46];
  if (end < eof.length || !eof.every((value, index) => bytes[end - eof.length + index] === value)) {
    throw new Error('PDF is corrupt, truncated, or contains trailing data after its final EOF marker.');
  }
}

function isPdfTrailingWhitespace(byte: number): boolean {
  return byte === 0x00 || byte === 0x09 || byte === 0x0a || byte === 0x0c || byte === 0x0d || byte === 0x20;
}

function boundedPageText(items: readonly unknown[], pageNumber: number): string {
  const encoder = new TextEncoder();
  const segments: string[] = [];
  let byteLength = 0;
  for (const item of items) {
    if (typeof item !== 'object' || item === null || !('str' in item) || typeof item.str !== 'string') continue;
    const segment = item.str.replace(/\s+/g, ' ').trim();
    if (!segment) continue;
    byteLength += encoder.encode(segment).byteLength + (segments.length > 0 ? 1 : 0);
    if (byteLength > MAX_PDF_TEXT_BYTES_PER_PAGE) {
      throw new Error(`PDF page ${pageNumber} exceeds the local text extraction limit.`);
    }
    segments.push(segment);
  }
  return segments.join(' ');
}

export function normalizePdfError(error: unknown): Error {
  const name = typeof error === 'object' && error !== null && 'name' in error ? String(error.name) : '';
  if (name === 'PasswordException') {
    return new Error('Password-protected PDFs are not supported. Remove the password before import.');
  }
  if (error instanceof Error && /^PDF /.test(error.message)) return error;
  return new Error(`PDF is corrupt, truncated, or unsupported: ${error instanceof Error ? error.message : String(error)}`);
}
