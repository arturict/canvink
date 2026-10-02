import { inkRefsOf } from '../ink/projection';

export interface NotebookCounts {
  sections: number;
  /** Pages of the notebook, whether or not this device holds their documents. */
  pages: number;
  /** Pages whose documents are on this device. */
  pagesOnDevice: number;
}

export function notebookCounts(
  notebook: { notebookId: string; sections: ReadonlyArray<{ pageDocumentIds: readonly string[] }> },
  isOnDevice: (documentId: string) => boolean,
): NotebookCounts {
  const documentIds = notebook.sections.flatMap((section) => section.pageDocumentIds);
  return {
    sections: notebook.sections.length,
    pages: documentIds.length,
    pagesOnDevice: documentIds.filter(isOnDevice).length,
  };
}

/** Ink and files a page references, read from its document; sizes are the stored byte lengths. */
export interface PageFootprint {
  inkBytes: number;
  /** File sizes by asset id, so a file used twice counts once. */
  assets: ReadonlyMap<string, number>;
}

interface AssetLike {
  assetId?: unknown;
  size?: unknown;
}

function collectAsset(assets: Map<string, number>, ref: unknown): void {
  if (typeof ref !== 'object' || ref === null) return;
  const { assetId, size } = ref as AssetLike;
  if (typeof assetId === 'string' && typeof size === 'number' && Number.isFinite(size)) assets.set(assetId, size);
}

export function pageFootprint(page: { elementsById?: Record<string, unknown> }): PageFootprint {
  const inkBytes = Object.values(inkRefsOf(page)).reduce(
    (total, ref) => total + (typeof ref.bytes === 'number' ? ref.bytes : 0),
    0,
  );
  const assets = new Map<string, number>();
  for (const element of Object.values(page.elementsById ?? {})) {
    if (typeof element !== 'object' || element === null) continue;
    const { asset, originalAsset, previewAsset } = element as Record<string, unknown>;
    collectAsset(assets, asset);
    collectAsset(assets, originalAsset);
    collectAsset(assets, previewAsset);
  }
  return { inkBytes, assets };
}

export interface StorageReader {
  /** Stored size of a document, or 0 when this device does not hold it. */
  documentBytes(documentId: string): Promise<number>;
  /** The footprint of a page, or `null` when the device does not hold its document. */
  pageFootprint(documentId: string): Promise<PageFootprint | null>;
}

export interface StorageMeasure {
  bytes: number;
  /** Pages measured so far; the sum is final once it equals the notebook's pages on this device. */
  measuredPages: number;
}

/**
 * The size of a notebook on this device: its document, its page documents,
 * the ink segments and the files its pages reference. Pages are read one at a
 * time so a long notebook never sits in memory at once, and `isCancelled`
 * stops the pass when the dialog closes.
 */
export async function measureNotebookStorage(
  notebook: { documentId: string; sections: ReadonlyArray<{ pageDocumentIds: readonly string[] }> },
  reader: StorageReader,
  onProgress: (measure: StorageMeasure) => void,
  isCancelled: () => boolean = () => false,
): Promise<StorageMeasure> {
  let bytes = await reader.documentBytes(notebook.documentId);
  let measuredPages = 0;
  const seenAssets = new Set<string>();
  onProgress({ bytes, measuredPages });
  for (const documentId of new Set(notebook.sections.flatMap((section) => section.pageDocumentIds))) {
    if (isCancelled()) break;
    const footprint = await reader.pageFootprint(documentId);
    if (!footprint) continue;
    bytes += await reader.documentBytes(documentId) + footprint.inkBytes;
    for (const [assetId, size] of footprint.assets) {
      if (seenAssets.has(assetId)) continue;
      seenAssets.add(assetId);
      bytes += size;
    }
    measuredPages += 1;
    onProgress({ bytes, measuredPages });
  }
  return { bytes, measuredPages };
}

/** "3.4 MB" / "820 KB": one decimal below 10 units, none above. */
export function formatBytes(bytes: number, locale: string): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 10 ? 0 : 1;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: digits, minimumFractionDigits: 0 }).format(value)} ${units[unit]}`;
}
