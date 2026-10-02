import type { Doc } from '@automerge/automerge';
import { getAutomergeSnapshot, type CanvinkAutomergeDoc, type LivePageDocV2, type PageAutomergeDoc } from '../../../crdt';
import { referencedInkSegments } from '../../../ink/projection';
import { inkSegments } from '../../../ink/segmentStore';
import type { AssetBlob } from '../../../domain/v2';

/** How long the preview waits for ink segments it does not hold yet before it paints what it has. */
const INK_WAIT_MS = 6_000;
/** Longest side of an image kept for the preview, in pixels. */
const IMAGE_SIDE = 320;
const MAX_IMAGES = 10;
const MAX_IMAGE_BYTES = 6_000_000;

/** What a preview paints: the page with its ink, and the pictures of its images that this device holds. */
export interface PreviewContent {
  page: LivePageDocV2;
  images: ReadonlyMap<string, CanvasImageSource>;
}

/** Reads a document the way the workspace runtime hands it out (`WorkspaceV2Runtime.readDocument`). */
export type ReadDocument = <T>(documentId: string, reader: (document: CanvinkAutomergeDoc) => T | Promise<T>) => Promise<T>;

function imageAssetIds(page: LivePageDocV2): string[] {
  const ids: string[] = [];
  for (const element of Object.values(page.elementsById)) {
    if (element.kind === 'image') ids.push(element.asset.assetId);
    else if (element.kind === 'pdf') ids.push(element.previewAsset.assetId);
  }
  return [...new Set(ids)].slice(0, MAX_IMAGES);
}

async function decodeImages(
  page: LivePageDocV2,
  loadAsset: (assetId: string) => Promise<AssetBlob | undefined>,
): Promise<Map<string, CanvasImageSource>> {
  const images = new Map<string, CanvasImageSource>();
  if (typeof createImageBitmap !== 'function') return images;
  await Promise.all(imageAssetIds(page).map(async (assetId) => {
    try {
      const asset = await loadAsset(assetId);
      if (!asset || asset.bytes.byteLength > MAX_IMAGE_BYTES) return;
      const full = await createImageBitmap(new Blob([asset.bytes.slice().buffer as ArrayBuffer]));
      const scale = Math.min(1, IMAGE_SIDE / Math.max(full.width, full.height));
      if (scale >= 1) {
        images.set(assetId, full);
        return;
      }
      const small = await createImageBitmap(full, {
        resizeWidth: Math.max(1, Math.round(full.width * scale)),
        resizeHeight: Math.max(1, Math.round(full.height * scale)),
        resizeQuality: 'medium',
      });
      full.close();
      images.set(assetId, small);
    } catch {
      // An image this device cannot read stays a grey box in the preview.
    }
  }));
  return images;
}

/**
 * The page for a presence preview, with its ink. A page's strokes live in ink
 * segments that are only resident for pages that were opened, so a page the
 * viewer never opened would otherwise be painted without its handwriting (and,
 * for an imported notebook, as an almost empty sheet). The segments are
 * fetched from this device or the room first, then the page is read.
 *
 * Reading a page the device does not hold yet (a placeholder of the personal
 * space) downloads it; the caller shows a placeholder until that finished.
 */
export async function loadPreviewContent(
  documentId: string,
  readDocument: ReadDocument,
  loadAsset: (assetId: string) => Promise<AssetBlob | undefined>,
): Promise<PreviewContent> {
  const hashes = await readDocument(documentId, (document: Doc<unknown>) => referencedInkSegments(document));
  if (hashes.length > 0) await inkSegments().ensure(hashes, { remoteWaitMs: INK_WAIT_MS });
  const page = await readDocument(documentId, (document) => getAutomergeSnapshot<LivePageDocV2>(document as PageAutomergeDoc));
  return { page, images: await decodeImages(page, loadAsset) };
}
