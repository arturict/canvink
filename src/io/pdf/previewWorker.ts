/// <reference lib="webworker" />
import type { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { RenderedImage } from './importPlan';
import {
  NO_CANVAS_MESSAGE,
  PIXEL_LIMIT_MESSAGE,
  type PreviewWorkerRequest,
  type PreviewWorkerResponse,
} from './previewWorkerProtocol';

/**
 * Renders PDF pages to WebP off the main thread. pdf.js does the drawing on an
 * OffscreenCanvas in this worker, so a few hundred pages never block the UI.
 * Glyphs are drawn as paths (`disableFontFace`): a worker has no document to
 * attach font faces to.
 */
const scope = self as unknown as DedicatedWorkerGlobalScope;
type LoadingTask = ReturnType<typeof getDocument>;
type PDFDocumentProxy = Awaited<LoadingTask['promise']>;
const documents = new Map<number, { task: Promise<LoadingTask>; document: Promise<PDFDocumentProxy> }>();

/** pdf.js asks its canvas factory for canvases; a worker only has OffscreenCanvas. */
class OffscreenCanvasFactory {
  create(width: number, height: number) {
    const canvas = new OffscreenCanvas(width, height);
    return { canvas, context: canvas.getContext('2d') };
  }
  reset(target: { canvas: OffscreenCanvas }, width: number, height: number) {
    target.canvas.width = width;
    target.canvas.height = height;
  }
  destroy(target: { canvas: OffscreenCanvas | null; context: unknown }) {
    if (target.canvas) {
      target.canvas.width = 0;
      target.canvas.height = 0;
    }
    target.canvas = null;
    target.context = null;
  }
}

async function open(bytes: ArrayBuffer): Promise<LoadingTask> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    stopAtErrors: true,
    disableAutoFetch: true,
    disableStream: true,
    disableFontFace: true,
    useSystemFonts: true,
    CanvasFactory: OffscreenCanvasFactory,
  } as Parameters<typeof pdfjs.getDocument>[0]);
  return task;
}

async function encode(canvas: OffscreenCanvas, quality: number): Promise<RenderedImage> {
  let blob = await canvas.convertToBlob({ type: 'image/webp', quality });
  // A browser that cannot encode WebP answers with PNG; text stays cleaner as JPEG than as a huge PNG.
  if (blob.type !== 'image/webp') blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: Math.min(0.92, quality + 0.08) });
  const mimeType = blob.type === 'image/webp' ? 'image/webp' : blob.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
  return { bytes: new Uint8Array(await blob.arrayBuffer()), mimeType, width: canvas.width, height: canvas.height };
}

async function render(request: Extract<PreviewWorkerRequest, { type: 'render' }>): Promise<PreviewWorkerResponse> {
  const opening = documents.get(request.documentId);
  if (!opening) throw new Error('PDF is not open in the preview worker.');
  const document = await opening.document;
  const page = await document.getPage(request.pageNumber);
  try {
    const base = page.getViewport({ scale: 1 });
    const wanted = request.targetWidth ? request.targetWidth / base.width : request.scale;
    const scale = Math.min(wanted, request.maxWidth / base.width, Math.sqrt(request.maxPixels / (base.width * base.height)));
    const viewport = page.getViewport({ scale });
    const canvas = new OffscreenCanvas(Math.max(1, Math.ceil(viewport.width)), Math.max(1, Math.ceil(viewport.height)));
    if (canvas.width * canvas.height > request.maxPixels) throw new Error(PIXEL_LIMIT_MESSAGE);
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error(NO_CANVAS_MESSAGE);
    await page.render({ canvas: canvas as unknown as HTMLCanvasElement, canvasContext: context as unknown as CanvasRenderingContext2D, viewport }).promise;
    const image = await encode(canvas, request.quality);
    let thumbnail: RenderedImage | undefined;
    if (request.thumbnailWidth > 0 && request.thumbnailWidth < canvas.width) {
      const width = request.thumbnailWidth;
      const height = Math.max(1, Math.round((canvas.height * width) / canvas.width));
      const small = new OffscreenCanvas(width, height);
      const smallContext = small.getContext('2d', { alpha: false });
      if (smallContext) {
        smallContext.imageSmoothingQuality = 'high';
        smallContext.drawImage(canvas, 0, 0, width, height);
        thumbnail = await encode(small, 0.6);
      }
    }
    canvas.width = 0;
    canvas.height = 0;
    return { type: 'rendered', id: request.id, image, ...(thumbnail ? { thumbnail } : {}) };
  } finally {
    page.cleanup();
  }
}

scope.onmessage = (event: MessageEvent<PreviewWorkerRequest>) => {
  const request = event.data;
  if (request.type === 'open') {
    const task = open(request.bytes);
    const document = task.then((loading) => loading.promise);
    // A failure surfaces on the first render that uses the document.
    document.catch(() => undefined);
    documents.set(request.documentId, { task, document });
    return;
  }
  if (request.type === 'close') {
    const opening = documents.get(request.documentId);
    documents.delete(request.documentId);
    void opening?.task.then((loading) => loading.destroy(), () => undefined);
    return;
  }
  void render(request).then(
    (response) => {
      const transfer = response.type === 'rendered'
        ? [response.image.bytes.buffer, response.thumbnail?.bytes.buffer].filter((buffer): buffer is ArrayBuffer => buffer instanceof ArrayBuffer)
        : [];
      scope.postMessage(response, transfer);
    },
    (error: unknown) => {
      scope.postMessage({ type: 'failed', id: request.id, message: error instanceof Error ? error.message : String(error) } satisfies PreviewWorkerResponse);
    },
  );
};
