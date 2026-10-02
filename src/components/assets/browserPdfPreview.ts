import type { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { translateNow } from '../../i18n/current';
import type { PdfPreviewRenderer, RenderedPdfPage } from '../../io/pdf';
import {
  NO_CANVAS_MESSAGE,
  PIXEL_LIMIT_MESSAGE,
  PREVIEW_DPI,
  POINTS_PER_INCH,
  type PreviewWorkerRequest,
  type PreviewWorkerResponse,
} from '../../io/pdf/previewWorkerProtocol';

function workerFailureMessage(message: string): string {
  if (message === PIXEL_LIMIT_MESSAGE) return translateNow('error.pdfPreview.pixelLimit');
  if (message === NO_CANVAS_MESSAGE) return translateNow('error.pdfPreview.noCanvas');
  return message;
}
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

function canvasPng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error(translateNow('error.pdfPreview.encode')));
        return;
      }
      void blob.arrayBuffer().then((buffer) => resolve(new Uint8Array(buffer)), reject);
    }, 'image/png');
  });
}

type LoadingTask = ReturnType<typeof getDocument>;
type LoadedDocument = Awaited<LoadingTask['promise']>;

/** The PDF the renderer holds open: pdf.js parses it once however many pages are rendered from it. */
interface OpenPdf {
  bytes: Uint8Array;
  task: LoadingTask;
  document: Promise<LoadedDocument>;
}

/**
 * Renders PDF pages on the main thread. Only used where workers or
 * OffscreenCanvas are missing, or when a worker fails.
 */
function createMainThreadPdfPreviewRenderer(): PdfPreviewRenderer {
  let open: OpenPdf | undefined;

  async function close(): Promise<void> {
    const closing = open;
    open = undefined;
    if (!closing) return;
    await closing.document.then((document) => document.cleanup(), () => undefined);
    await closing.task.destroy().catch(() => undefined);
  }

  async function documentFor(pdfBytes: Uint8Array): Promise<LoadedDocument> {
    if (open?.bytes === pdfBytes) return open.document;
    await close();
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
    // pdf.js takes ownership of the buffer it is given, so it gets a copy.
    const task = pdfjs.getDocument({
      data: pdfBytes.slice(),
      stopAtErrors: true,
      disableAutoFetch: true,
      disableStream: true,
      useSystemFonts: true,
    });
    const opening = { bytes: pdfBytes, task, document: task.promise };
    open = opening;
    try {
      return await opening.document;
    } catch (error) {
      if (open === opening) await close();
      throw error;
    }
  }

  return {
    async renderPage({ pdfBytes, pageNumber, maxWidth, maxPixels, targetWidth }) {
      const document = await documentFor(pdfBytes);
      const page = await document.getPage(pageNumber);
      try {
        const base = page.getViewport({ scale: 1 });
        const scale = Math.min(targetWidth ? targetWidth / base.width : 2, maxWidth / base.width, Math.sqrt(maxPixels / (base.width * base.height)));
        const viewport = page.getViewport({ scale });
        const canvas = globalThis.document.createElement('canvas');
        canvas.width = Math.max(1, Math.ceil(viewport.width));
        canvas.height = Math.max(1, Math.ceil(viewport.height));
        if (canvas.width * canvas.height > maxPixels) {
          throw new Error(translateNow('error.pdfPreview.pixelLimit'));
        }
        const context = canvas.getContext('2d', { alpha: false });
        if (!context) throw new Error(translateNow('error.pdfPreview.noCanvas'));
        await page.render({ canvas, canvasContext: context, viewport }).promise;
        return {
          bytes: await canvasPng(canvas),
          mimeType: 'image/png',
          width: canvas.width,
          height: canvas.height,
        };
      } finally {
        page.cleanup();
      }
    },
    release: close,
  };
}

interface Slot {
  worker: Worker;
  opened: Set<number>;
  busy: number;
  pending: Map<number, { resolve(response: PreviewWorkerResponse): void; reject(error: Error): void }>;
}

const THUMBNAIL_WIDTH = 200;
const PREVIEW_QUALITY = 0.82;

/**
 * Renders pages in a small pool of workers (see `previewWorker`): 150 dpi,
 * WebP, plus a 200 px thumbnail per page. Each worker opens a PDF once and
 * keeps it while pages are rendered from it.
 */
export function createBrowserPdfPreviewRenderer(): PdfPreviewRenderer {
  if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') {
    return createMainThreadPdfPreviewRenderer();
  }
  const size = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 2));
  const slots: Slot[] = [];
  const documentIds = new WeakMap<Uint8Array, number>();
  let nextDocumentId = 1;
  let nextRequestId = 1;
  let fallback: PdfPreviewRenderer | undefined;
  let failed = false;
  const bytesOfDocument = new Map<number, Uint8Array>();

  function slotFor(): Slot {
    if (slots.length < size && (slots.length === 0 || slots.every((slot) => slot.busy > 0))) {
      const worker = new Worker(new URL('../../io/pdf/previewWorker.ts', import.meta.url), { type: 'module' });
      const slot: Slot = { worker, opened: new Set(), busy: 0, pending: new Map() };
      worker.onmessage = (event: MessageEvent<PreviewWorkerResponse>) => {
        const waiter = slot.pending.get(event.data.id);
        slot.pending.delete(event.data.id);
        waiter?.resolve(event.data);
      };
      worker.onerror = (event) => {
        for (const waiter of slot.pending.values()) waiter.reject(new Error(event.message || 'PDF preview worker failed.'));
        slot.pending.clear();
      };
      slots.push(slot);
    }
    return slots.reduce((least, slot) => (slot.busy < least.busy ? slot : least));
  }

  return {
    concurrency: size,
    async renderPage(input) {
      if (failed) return (fallback ??= createMainThreadPdfPreviewRenderer()).renderPage(input);
      let documentId = documentIds.get(input.pdfBytes);
      if (documentId === undefined) {
        documentId = nextDocumentId;
        nextDocumentId += 1;
        documentIds.set(input.pdfBytes, documentId);
        bytesOfDocument.set(documentId, input.pdfBytes);
      }
      const slot = slotFor();
      if (!slot.opened.has(documentId)) {
        slot.opened.add(documentId);
        // Each worker parses its own copy; the caller keeps its bytes.
        const copy = input.pdfBytes.slice().buffer;
        slot.worker.postMessage({ type: 'open', documentId, bytes: copy } satisfies PreviewWorkerRequest, [copy]);
      }
      const id = nextRequestId;
      nextRequestId += 1;
      slot.busy += 1;
      try {
        const response = await new Promise<PreviewWorkerResponse>((resolve, reject) => {
          slot.pending.set(id, { resolve, reject });
          slot.worker.postMessage({
            type: 'render',
            id,
            documentId,
            pageNumber: input.pageNumber,
            scale: PREVIEW_DPI / POINTS_PER_INCH,
            ...(input.targetWidth ? { targetWidth: input.targetWidth } : {}),
            maxWidth: input.maxWidth,
            maxPixels: input.maxPixels,
            thumbnailWidth: input.targetWidth ? 0 : THUMBNAIL_WIDTH,
            quality: PREVIEW_QUALITY,
          } satisfies PreviewWorkerRequest);
        });
        if (response.type === 'failed') throw new Error(workerFailureMessage(response.message));
        const rendered: RenderedPdfPage = { ...response.image, ...(response.thumbnail ? { thumbnail: response.thumbnail } : {}) };
        return rendered;
      } catch (error) {
        // A worker that cannot start (blocked, unsupported module workers) must not lose the import.
        if (error instanceof Error && /worker/i.test(error.message) && slots.every((candidate) => candidate.pending.size === 0)) {
          failed = true;
          return (fallback ??= createMainThreadPdfPreviewRenderer()).renderPage(input);
        }
        throw error;
      } finally {
        slot.busy -= 1;
      }
    },
    async release() {
      for (const slot of slots) {
        for (const documentId of slot.opened) slot.worker.postMessage({ type: 'close', documentId } satisfies PreviewWorkerRequest);
        slot.worker.terminate();
      }
      slots.length = 0;
      bytesOfDocument.clear();
      await fallback?.release?.();
    },
  };
}
