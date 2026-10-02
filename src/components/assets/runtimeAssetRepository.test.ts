import { describe, expect, it, vi } from 'vitest';
import { personalSpaceAssetRepository } from './runtimeAssetRepository';
import type { AssetBlob, Sha256Checksum } from '../../domain/v2';
import type { WorkspaceV2Runtime } from '../../storage/workspaceV2Runtime';
import type { AssetSyncQueue } from '../../personal-space/assets/assetSyncQueue';

function makeRuntime(asset: AssetBlob | undefined): Pick<WorkspaceV2Runtime, 'getAsset'> {
  return { getAsset: vi.fn(async () => asset) };
}

describe('personalSpaceAssetRepository', () => {
  it('returns the local asset without touching the queue on a hit', async () => {
    const blob: AssetBlob = {
      assetId: 'sha256:a' as Sha256Checksum,
      checksum: 'sha256:a' as Sha256Checksum,
      size: 3,
      bytes: new Uint8Array([1, 2, 3]),
    };
    const runtime = makeRuntime(blob);
    const requestAsset = vi.fn(async () => undefined);
    const repository = personalSpaceAssetRepository(
      runtime as WorkspaceV2Runtime,
      { requestAsset } as Pick<AssetSyncQueue, 'requestAsset'>,
    );

    await expect(repository.getAsset(blob.assetId)).resolves.toEqual(blob);
    expect(requestAsset).not.toHaveBeenCalled();
  });

  it('hands the bytes the queue downloaded straight to the reader that asked', async () => {
    const runtime = makeRuntime(undefined);
    const requestAsset = vi.fn(async () => new Uint8Array([9]));
    const repository = personalSpaceAssetRepository(
      runtime as WorkspaceV2Runtime,
      { requestAsset } as Pick<AssetSyncQueue, 'requestAsset'>,
    );
    const options = { priority: 3 };

    await expect(repository.getAsset('sha256:missing' as Sha256Checksum, options)).resolves.toEqual({
      assetId: 'sha256:missing',
      checksum: 'sha256:missing',
      size: 1,
      bytes: new Uint8Array([9]),
    });
    expect(requestAsset).toHaveBeenCalledWith('sha256:missing', options);
  });

  it('returns undefined while the cloud has no bytes for the asset', async () => {
    const runtime = makeRuntime(undefined);
    const requestAsset = vi.fn(async () => undefined);
    const repository = personalSpaceAssetRepository(
      runtime as WorkspaceV2Runtime,
      { requestAsset } as Pick<AssetSyncQueue, 'requestAsset'>,
    );

    await expect(repository.getAsset('sha256:missing' as Sha256Checksum)).resolves.toBeUndefined();
  });

  it('does not reject when the queue request fails', async () => {
    const runtime = makeRuntime(undefined);
    const requestAsset = vi.fn(async () => {
      throw new Error('network down');
    });
    const repository = personalSpaceAssetRepository(
      runtime as WorkspaceV2Runtime,
      { requestAsset } as Pick<AssetSyncQueue, 'requestAsset'>,
    );

    await expect(repository.getAsset('sha256:missing' as Sha256Checksum)).resolves.toBeUndefined();
  });

  it('keeps direct asset writes disabled', async () => {
    const runtime = makeRuntime(undefined);
    const repository = personalSpaceAssetRepository(
      runtime as WorkspaceV2Runtime,
      { requestAsset: vi.fn(async () => undefined) } as Pick<AssetSyncQueue, 'requestAsset'>,
    );

    await expect(repository.putAsset({
      assetId: 'sha256:a' as Sha256Checksum,
      checksum: 'sha256:a' as Sha256Checksum,
      size: 1,
      bytes: new Uint8Array([1]),
    })).rejects.toThrow(/Direct asset writes/);
  });
});
