import type { AssetRepository } from '../../assets';
import { sha256Bytes } from '../../domain/v2';
import type { AssetBlob, Sha256Checksum } from '../../domain/v2';
import type { WorkspaceV2Runtime } from '../../storage/workspaceV2Runtime';
import type { AssetSyncQueue } from '../../personal-space/assets/assetSyncQueue';

/**
 * Operation-local asset stage. Bytes are not published until callers include
 * `pendingAssets()` in the same workspace graph transaction as their refs.
 */
export class StagedRuntimeAssetRepository implements AssetRepository {
  private readonly pending = new Map<Sha256Checksum, AssetBlob>();

  constructor(private readonly runtime: WorkspaceV2Runtime) {}

  async getAsset(assetId: Sha256Checksum): Promise<AssetBlob | undefined> {
    const pending = this.pending.get(assetId);
    return pending ? structuredClone(pending) : this.runtime.getAsset(assetId);
  }

  async putAsset(asset: AssetBlob): Promise<'stored' | 'deduplicated'> {
    if (
      asset.assetId !== asset.checksum
      || asset.size !== asset.bytes.byteLength
      || await sha256Bytes(asset.bytes) !== asset.assetId
    ) throw new Error(`Asset ${asset.assetId} failed staging integrity verification.`);
    const existing = await this.getAsset(asset.assetId);
    if (existing) return 'deduplicated';
    this.pending.set(asset.assetId, structuredClone(asset));
    return 'stored';
  }

  pendingAssets(): AssetBlob[] {
    return [...this.pending.values()].map((asset) => structuredClone(asset));
  }
}

export function runtimeAssetRepository(runtime: WorkspaceV2Runtime): AssetRepository {
  return {
    getAsset: (assetId) => runtime.getAsset(assetId),
    putAsset: async () => {
      throw new Error('Direct asset writes are disabled; use an atomic staged workspace transaction.');
    },
  };
}

/**
 * §5.7 rendering integration. Like `runtimeAssetRepository`, reads go straight
 * to the local activation; the difference is what happens on a miss: rather
 * than returning `undefined` outright, it kicks off a lazy, coalesced remote
 * download via `queue.requestAsset` (fire-and-forget — this call does not
 * await the download) so a later batched `commitWorkspaceGraphRevision`
 * adopts the bytes and the UI can re-render once that commit lands. Direct
 * asset writes stay disabled, exactly like `runtimeAssetRepository`.
 */
export function personalSpaceAssetRepository(
  runtime: WorkspaceV2Runtime,
  queue: Pick<AssetSyncQueue, 'requestAsset'>,
): AssetRepository {
  return {
    getAsset: async (assetId, options) => {
      const local = await runtime.getAsset(assetId);
      if (local) return local;
      // The bytes are handed straight to the reader that asked (it verifies them
      // against `assetId`); the queue adopts them into the workspace in a later
      // batch. Waiting for that batch made every picture appear seconds late.
      // Rejects when withdrawn, resolves without bytes when the cloud has none.
      const bytes = await queue.requestAsset(assetId, options).catch((error: unknown) => {
        if (options?.signal?.aborted) throw error;
        return undefined;
      });
      if (!bytes) return undefined;
      return { assetId, checksum: assetId, size: bytes.byteLength, bytes };
    },
    putAsset: async () => {
      throw new Error('Direct asset writes are disabled; use an atomic staged workspace transaction.');
    },
  };
}
