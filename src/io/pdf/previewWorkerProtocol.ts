import type { RenderedImage } from './importPlan';

/**
 * The worker has no i18n catalog; it reports these two failures with fixed
 * English texts and `browserPdfPreview` shows the translated equivalent.
 */
export const PIXEL_LIMIT_MESSAGE = 'The PDF preview exceeds the pixel limit.';
export const NO_CANVAS_MESSAGE = 'The browser provides no PDF canvas.';

/** Messages between `browserPdfPreview` and `previewWorker`. */
export type PreviewWorkerRequest =
  | { type: 'open'; documentId: number; bytes: ArrayBuffer }
  | {
      type: 'render';
      id: number;
      documentId: number;
      pageNumber: number;
      /** Pixels per PDF point; the worker also honours the limits below. */
      scale: number;
      maxWidth: number;
      maxPixels: number;
      /** Exact pixel width wanted instead of `scale`; the worker still honours `maxPixels`. */
      targetWidth?: number;
      /** Width of the low-resolution copy; 0 for none. */
      thumbnailWidth: number;
      quality: number;
    }
  | { type: 'close'; documentId: number };

export type PreviewWorkerResponse =
  | { type: 'rendered'; id: number; image: RenderedImage; thumbnail?: RenderedImage }
  | { type: 'failed'; id: number; message: string };

export const PREVIEW_DPI = 150;
/** PDF points per inch. */
export const POINTS_PER_INCH = 72;
