import type { AssetBlob, AssetRef, Sha256Checksum } from '../domain/v2';

/** How urgently a reader needs an asset that may still have to come from the cloud. */
export interface AssetReadOptions {
  /** Lower is more urgent; a repository that fetches remotely serves lower values first. */
  priority?: number;
  /** Withdraws the request, so a download nobody waits for is not started. */
  signal?: AbortSignal;
}

export interface AssetRepository {
  getAsset(assetId: Sha256Checksum, options?: AssetReadOptions): Promise<AssetBlob | undefined>;
  /** Must be idempotent when the same verified bytes already exist. */
  putAsset(asset: AssetBlob): Promise<'stored' | 'deduplicated'>;
}

export type OriginalAssetKind = 'pdf' | 'image' | 'attachment';

export interface OriginalAssetInput {
  bytes: Uint8Array;
  mimeType: string;
  fileName?: string;
  kind: OriginalAssetKind;
}

export interface StoredOriginalAsset {
  ref: AssetRef;
  disposition: 'stored' | 'deduplicated';
  imageDimensions?: { width: number; height: number };
}

export interface AttachmentAccess {
  fileName: string;
  mimeType: string;
  size: number;
  bytes: Uint8Array;
  /** Bytes are returned to the platform; this module never executes them. */
  disposition: 'open' | 'download';
}

