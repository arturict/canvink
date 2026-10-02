import { describe, expect, it, vi } from 'vitest';
import { MemoryAssetRepository, storeOriginalAsset } from '../../assets';
import type { AssetRef } from '../../domain/v2';
import { createImageSourceCache, type ImageUrls } from './imageSourceCache';

const PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='),
  (character) => character.charCodeAt(0),
);

/** The 1x1 PNG with another declared height, which makes the bytes, and so the asset, differ. */
async function store(repository: MemoryAssetRepository, variant: number): Promise<AssetRef> {
  const bytes = PNG.slice();
  const view = new DataView(bytes.buffer);
  view.setUint32(20, 1 + variant);
  let crc = 0xffff_ffff;
  for (const byte of bytes.subarray(12, 29)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) === 1 ? 0xedb8_8320 ^ (crc >>> 1) : crc >>> 1;
  }
  view.setUint32(29, (crc ^ 0xffff_ffff) >>> 0);
  const stored = await storeOriginalAsset(repository, {
    bytes,
    mimeType: 'image/png',
    fileName: `bild-${variant}.png`,
    kind: 'image',
  });
  return stored.ref;
}

function fakeUrls() {
  let next = 0;
  const live = new Set<string>();
  const urls: ImageUrls = {
    create: () => {
      const url = `blob:test/${next += 1}`;
      live.add(url);
      return url;
    },
    revoke: (url) => {
      live.delete(url);
    },
  };
  return { urls, live };
}

describe('image source cache', () => {
  it('reads an asset once for concurrent leases and keeps its URL for the next visit', async () => {
    const repository = new MemoryAssetRepository();
    const ref = await store(repository, 1);
    const getAsset = vi.spyOn(repository, 'getAsset');
    const { urls, live } = fakeUrls();
    const cache = createImageSourceCache({ urls });

    const [first, second] = await Promise.all([cache.lease(repository, ref), cache.lease(repository, ref)]);
    expect(getAsset).toHaveBeenCalledTimes(1);
    expect(second.url).toBe(first.url);
    expect(live.size).toBe(1);

    first.release();
    first.release();
    expect(live.has(first.url)).toBe(true);
    second.release();
    // Unused, but kept for the next visit.
    expect(live.has(second.url)).toBe(true);
    const again = await cache.lease(repository, ref);
    expect(again.url).toBe(first.url);
    expect(getAsset).toHaveBeenCalledTimes(1);
    again.release();

    cache.trim();
    expect(live.size).toBe(0);
    const reread = await cache.lease(repository, ref);
    expect(getAsset).toHaveBeenCalledTimes(2);
    reread.release();
  });

  it('keeps a URL valid while leased even when the budget drops its entry', async () => {
    const repository = new MemoryAssetRepository();
    const first = await store(repository, 1);
    const second = await store(repository, 2);
    const { urls, live } = fakeUrls();
    const cache = createImageSourceCache({ urls, idleByteBudget: 0 });

    const held = await cache.lease(repository, first);
    const other = await cache.lease(repository, second);
    other.release();
    // The budget is zero, so the released entry goes at once; the held one stays.
    expect(live.has(other.url)).toBe(false);
    expect(live.has(held.url)).toBe(true);
    cache.trim();
    expect(live.has(held.url)).toBe(true);
    held.release();
    expect(live.size).toBe(0);
  });

  it('evicts the least recently used unused entries first', async () => {
    const repository = new MemoryAssetRepository();
    const refs = [await store(repository, 1), await store(repository, 2), await store(repository, 3)];
    const { urls, live } = fakeUrls();
    const cache = createImageSourceCache({ urls, idleByteBudget: refs[0].size * 2 });
    const leases = [];
    for (const ref of refs) leases.push(await cache.lease(repository, ref));
    const [a, b, c] = leases;
    a.release();
    b.release();
    c.release();
    expect(live.has(a.url)).toBe(false);
    expect(live.has(b.url)).toBe(true);
    expect(live.has(c.url)).toBe(true);
    expect(cache.stats().idleEntries).toBe(2);
  });

  it('keeps assets of different repositories apart', async () => {
    const first = new MemoryAssetRepository();
    const second = new MemoryAssetRepository();
    const ref = await store(first, 1);
    const { urls } = fakeUrls();
    const cache = createImageSourceCache({ urls });
    (await cache.lease(first, ref)).release();
    // The second repository does not hold the asset, so it must not be served from the first one's entry.
    await expect(cache.lease(second, ref)).rejects.toThrow(/missing/);
  });

  it('rejects a missing asset and reads it again on the next attempt', async () => {
    const source = new MemoryAssetRepository();
    const ref = await store(source, 1);
    const empty = new MemoryAssetRepository();
    const { urls } = fakeUrls();
    const cache = createImageSourceCache({ urls });
    await expect(cache.lease(empty, ref)).rejects.toThrow(/missing/);
    await store(empty, 1);
    const lease = await cache.lease(empty, ref);
    lease.release();
  });
});

describe('an asset whose bytes have not arrived yet', () => {
  it('rejects with AssetMissingError and leases once the bytes are stored', async () => {
    const { AssetMissingError } = await import('../../assets');
    const source = new MemoryAssetRepository();
    const ref = await store(source, 7);
    const later = new MemoryAssetRepository();
    const { urls } = fakeUrls();
    const cache = createImageSourceCache({ urls });

    await expect(cache.lease(later, ref)).rejects.toBeInstanceOf(AssetMissingError);
    await later.putAsset((await source.getAsset(ref.assetId))!);
    const lease = await cache.lease(later, ref);
    expect(lease.url).toMatch(/^blob:/);
    lease.release();
  });

  it('stops a read nobody waits for any more, and keeps one that another caller still wants', async () => {
    const real = new MemoryAssetRepository();
    const ref = await store(real, 7);
    const seen: Array<AbortSignal | undefined> = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const repository = {
      putAsset: real.putAsset.bind(real),
      getAsset: async (assetId: Parameters<typeof real.getAsset>[0], options?: { signal?: AbortSignal }) => {
        seen.push(options?.signal);
        await gate;
        if (options?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        return real.getAsset(assetId);
      },
    };
    const { urls } = fakeUrls();
    const cache = createImageSourceCache({ urls });

    const only = new AbortController();
    const withdrawn = cache.lease(repository, ref, { signal: only.signal });
    only.abort();
    await expect(withdrawn).rejects.toThrow();
    expect(seen[0]?.aborted).toBe(true);
    release();

    const first = new AbortController();
    const second = new AbortController();
    const kept = cache.lease(repository, ref, { signal: first.signal });
    const stays = cache.lease(repository, ref, { signal: second.signal });
    first.abort();
    await expect(kept).rejects.toThrow();
    const lease = await stays;
    expect(lease.url).toMatch(/^blob:/);
    lease.release();
  });
});
