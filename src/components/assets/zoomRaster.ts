import { readAssetBytes, type AssetRepository } from '../../assets';
import type { AssetRef } from '../../domain/v2';
import type { PdfPreviewRenderer } from '../../io/pdf';
import { createBrowserPdfPreviewRenderer } from './browserPdfPreview';

/**
 * Sharper pictures of printout pages while the canvas is zoomed in.
 *
 * The stored preview is rendered for about 150 dpi; past that the page blurs.
 * Once a zoom has settled, the page on screen is rendered again from the
 * original PDF at the pixel size it now has, in the preview workers, and only
 * kept in memory. The workers and the PDF's bytes go away after a quiet spell.
 */

const MAX_WIDTH = 4_096;
const MAX_PIXELS = 24_000_000;
const IDLE_CLOSE_MS = 30_000;

let renderer: PdfPreviewRenderer | undefined;
let closeTimer: ReturnType<typeof setTimeout> | undefined;
/** The last PDF read: one object, so a worker that has it open keeps it open. */
let held: { assetId: string; bytes: Promise<Uint8Array> } | undefined;

function closeLater(): void {
  if (closeTimer !== undefined) clearTimeout(closeTimer);
  closeTimer = setTimeout(() => {
    const closing = renderer;
    renderer = undefined;
    held = undefined;
    void closing?.release?.();
  }, IDLE_CLOSE_MS);
}

export interface ZoomedPicture {
  url: string;
  width: number;
  release(): void;
}

/** A picture of one PDF page `width` pixels wide; rejects when the original PDF is missing. */
export async function renderZoomedPage(
  repository: AssetRepository,
  original: AssetRef,
  pageNumber: number,
  width: number,
): Promise<ZoomedPicture> {
  const reading = held?.assetId === original.assetId ? held : { assetId: original.assetId, bytes: readAssetBytes(repository, original) };
  held = reading;
  const bytes = await reading.bytes.catch((error: unknown) => {
    if (held === reading) held = undefined;
    throw error;
  });
  renderer ??= createBrowserPdfPreviewRenderer();
  closeLater();
  const rendered = await renderer.renderPage({
    pdfBytes: bytes,
    pageNumber,
    maxWidth: MAX_WIDTH,
    maxPixels: MAX_PIXELS,
    targetWidth: Math.min(MAX_WIDTH, Math.round(width)),
  });
  closeLater();
  const url = URL.createObjectURL(new Blob([rendered.bytes.slice().buffer], { type: rendered.mimeType }));
  let released = false;
  return {
    url,
    width: rendered.width,
    release() {
      if (released) return;
      released = true;
      URL.revokeObjectURL(url);
    },
  };
}
