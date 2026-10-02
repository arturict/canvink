import { describe, expect, it, vi } from 'vitest';
import {
  AssetSyncQueue,
  computeAssetUploadDiff,
  type AssetAdoptEntry,
  type AssetBytesFetch,
  type AssetSyncHttpPort,
  type AssetSyncRuntimePort,
  type AssetUploadEntry,
} from './assetSyncQueue';

function bytesOf(length: number): Uint8Array {
  return new Uint8Array(length).fill(1);
}

function makeHttp(overrides: Partial<AssetSyncHttpPort> = {}): AssetSyncHttpPort & {
  headCalls: string[];
  putCalls: string[];
} {
  const headCalls: string[] = [];
  const putCalls: string[] = [];
  return {
    headCalls,
    putCalls,
    headAsset: overrides.headAsset ?? (async (assetId) => {
      headCalls.push(assetId);
      return false;
    }),
    putAsset: overrides.putAsset ?? (async (assetId) => {
      putCalls.push(assetId);
    }),
    getAsset: overrides.getAsset ?? (async () => undefined),
  };
}

function makeRuntime(overrides: Partial<AssetSyncRuntimePort> = {}): AssetSyncRuntimePort & {
  recorded: string[];
  adopted: AssetAdoptEntry[][];
} {
  const recorded: string[] = [];
  const adopted: AssetAdoptEntry[][] = [];
  return {
    recorded,
    adopted,
    recordUploadedAsset: overrides.recordUploadedAsset ?? ((entry) => {
      recorded.push(entry.assetId);
    }),
    adoptDownloadedAssets: overrides.adoptDownloadedAssets ?? (async (assets) => {
      adopted.push([...assets]);
    }),
  };
}

describe('computeAssetUploadDiff', () => {
  it('computes exactly the missing hashes', () => {
    expect(computeAssetUploadDiff(['a', 'b', 'c'], ['b'])).toEqual(['a', 'c']);
  });

  it('skips hashes the workspace doc already lists, accepting a Set or an array', () => {
    expect(computeAssetUploadDiff(['a', 'b'], new Set(['a', 'b']))).toEqual([]);
    expect(computeAssetUploadDiff(['a', 'b'], [])).toEqual(['a', 'b']);
  });

  it('is stable and de-duplicates repeated local ids', () => {
    expect(computeAssetUploadDiff(['a', 'a', 'b'], ['b'])).toEqual(['a']);
  });
});

describe('AssetSyncQueue uploads', () => {
  it('HEAD-dedupes: skips PUT when the object already exists, still records the entry', async () => {
    const headCalls: string[] = [];
    const http = makeHttp({
      headAsset: async (assetId) => {
        headCalls.push(assetId);
        return true;
      },
    });
    const runtime = makeRuntime();
    const queue = new AssetSyncQueue({ http, runtime });
    const asset: AssetUploadEntry = { assetId: 'sha256:a', bytes: bytesOf(4), mimeType: 'image/png', size: 4 };

    await queue.syncUploads([asset], []);

    expect(headCalls).toEqual(['sha256:a']);
    expect(http.putCalls).toEqual([]);
    expect(runtime.recorded).toEqual(['sha256:a']);
  });

  it('PUTs when HEAD reports the object absent', async () => {
    const http = makeHttp({ headAsset: async () => false });
    const runtime = makeRuntime();
    const queue = new AssetSyncQueue({ http, runtime });
    const asset: AssetUploadEntry = { assetId: 'sha256:a', bytes: bytesOf(4), mimeType: 'image/png', size: 4 };

    await queue.syncUploads([asset], []);

    expect(http.putCalls).toEqual(['sha256:a']);
    expect(runtime.recorded).toEqual(['sha256:a']);
  });

  it('skips assets the workspace doc already lists', async () => {
    const http = makeHttp();
    const runtime = makeRuntime();
    const queue = new AssetSyncQueue({ http, runtime });
    const asset: AssetUploadEntry = { assetId: 'sha256:a', bytes: bytesOf(4), mimeType: 'image/png', size: 4 };

    await queue.syncUploads([asset], ['sha256:a']);

    expect(http.headCalls).toEqual([]);
    expect(runtime.recorded).toEqual([]);
  });

  it('never runs more than maxConcurrentUploads uploads in parallel', async () => {
    let inFlight = 0;
    let maxObserved = 0;
    const http = makeHttp({
      headAsset: async () => {
        inFlight += 1;
        maxObserved = Math.max(maxObserved, inFlight);
        await Promise.resolve();
        inFlight -= 1;
        return false;
      },
    });
    const runtime = makeRuntime();
    const queue = new AssetSyncQueue({ http, runtime }, { maxConcurrentUploads: 2 });
    const assets: AssetUploadEntry[] = Array.from({ length: 6 }, (_, index) => ({
      assetId: `sha256:${index}`,
      bytes: bytesOf(1),
      mimeType: 'image/png',
      size: 1,
    }));

    await queue.syncUploads(assets, []);

    expect(maxObserved).toBeLessThanOrEqual(2);
    expect(runtime.recorded).toHaveLength(6);
  });

  it('retries a failing upload with backoff and gives up after maxUploadAttempts', async () => {
    let calls = 0;
    const http = makeHttp({
      headAsset: async () => {
        calls += 1;
        throw new Error('network down');
      },
    });
    const runtime = makeRuntime();
    const queue = new AssetSyncQueue(
      { http, runtime },
      { maxUploadAttempts: 3, minRetryBackoffMs: 1, maxRetryBackoffMs: 1, random: () => 0 },
    );
    const asset: AssetUploadEntry = { assetId: 'sha256:a', bytes: bytesOf(4), mimeType: 'image/png', size: 4 };

    await expect(queue.syncUploads([asset], [])).rejects.toThrow('network down');
    expect(calls).toBe(3);
  });
});

describe('AssetSyncQueue downloads', () => {
  it('coalesces duplicate requestAsset calls for the same id into one fetch', async () => {
    let fetches = 0;
    const http = makeHttp({
      getAsset: async (): Promise<AssetBytesFetch> => {
        fetches += 1;
        return { bytes: bytesOf(4), mimeType: 'image/png' };
      },
    });
    const runtime = makeRuntime();
    const queue = new AssetSyncQueue({ http, runtime });

    const [first, second] = await Promise.all([queue.requestAsset('sha256:a'), queue.requestAsset('sha256:a')]);

    expect(fetches).toBe(1);
    expect(first).toBe(second);
  });

  it('returns undefined for an asset the server does not have', async () => {
    const http = makeHttp({ getAsset: async () => undefined });
    const runtime = makeRuntime();
    const queue = new AssetSyncQueue({ http, runtime });

    await expect(queue.requestAsset('sha256:missing')).resolves.toBeUndefined();
    expect(runtime.adopted).toEqual([]);
  });

  it('flushes a download batch once for N assets, not N times', async () => {
    vi.useFakeTimers();
    try {
      const http = makeHttp({
        getAsset: async (assetId): Promise<AssetBytesFetch> => ({ bytes: bytesOf(4), mimeType: `mime/${assetId}` }),
      });
      const runtime = makeRuntime();
      const queue = new AssetSyncQueue({ http, runtime }, { batchMs: 2_000 });

      const requests = Promise.all([
        queue.requestAsset('sha256:a'),
        queue.requestAsset('sha256:b'),
        queue.requestAsset('sha256:c'),
      ]);
      await vi.advanceTimersByTimeAsync(0);
      await requests;

      expect(runtime.adopted).toEqual([]);
      await vi.advanceTimersByTimeAsync(2_000);

      expect(runtime.adopted).toHaveLength(1);
      expect(runtime.adopted[0]?.map((entry) => entry.assetId).sort()).toEqual(['sha256:a', 'sha256:b', 'sha256:c']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('flushes immediately once the batch reaches maxBatchCount, without waiting for the timer', async () => {
    const http = makeHttp({
      getAsset: async (assetId): Promise<AssetBytesFetch> => ({ bytes: bytesOf(4), mimeType: `mime/${assetId}` }),
    });
    const runtime = makeRuntime();
    const queue = new AssetSyncQueue({ http, runtime }, { batchMs: 60_000, maxBatchCount: 2 });

    await Promise.all([queue.requestAsset('sha256:a'), queue.requestAsset('sha256:b')]);
    await Promise.resolve();
    await Promise.resolve();

    expect(runtime.adopted).toHaveLength(1);
    expect(runtime.adopted[0]).toHaveLength(2);
  });

  it('flushes immediately once the batch reaches maxBatchBytes', async () => {
    const http = makeHttp({
      getAsset: async (): Promise<AssetBytesFetch> => ({ bytes: bytesOf(10), mimeType: 'image/png' }),
    });
    const runtime = makeRuntime();
    const queue = new AssetSyncQueue({ http, runtime }, { batchMs: 60_000, maxBatchBytes: 15 });

    await Promise.all([queue.requestAsset('sha256:a'), queue.requestAsset('sha256:b')]);
    await Promise.resolve();
    await Promise.resolve();

    expect(runtime.adopted).toHaveLength(1);
  });

  it('rejects an asset over SPACE_MAX_ASSET_BYTES rather than adopting it', async () => {
    const oversized = new Uint8Array(64 * 1024 * 1024 + 1);
    const http = makeHttp({ getAsset: async (): Promise<AssetBytesFetch> => ({ bytes: oversized, mimeType: 'application/pdf' }) });
    const runtime = makeRuntime();
    const queue = new AssetSyncQueue({ http, runtime });

    await expect(queue.requestAsset('sha256:huge')).rejects.toThrow(/exceeds/);
    expect(runtime.adopted).toEqual([]);
  });

  it('flushAdoption is a no-op when nothing is pending', async () => {
    const http = makeHttp();
    const runtime = makeRuntime();
    const queue = new AssetSyncQueue({ http, runtime });

    await expect(queue.flushAdoption()).resolves.toBeUndefined();
    expect(runtime.adopted).toEqual([]);
  });
});

describe('AssetSyncQueue download priority', () => {
  /** A port whose downloads finish only when the test says so. */
  function gatedHttp() {
    const started: string[] = [];
    const gates = new Map<string, () => void>();
    const http = makeHttp({
      getAsset: (assetId): Promise<AssetBytesFetch | undefined> => {
        started.push(assetId);
        return new Promise((resolve) => {
          gates.set(assetId, () => resolve({ bytes: bytesOf(3), mimeType: 'image/png' }));
        });
      },
    });
    return { http, started, finish: (assetId: string) => gates.get(assetId)?.() };
  }

  it('serves the closest requests first and keeps to the concurrent limit', async () => {
    const { http, started, finish } = gatedHttp();
    const queue = new AssetSyncQueue({ http, runtime: makeRuntime() }, { maxConcurrentDownloads: 1, batchMs: 1_000_000 });
    const first = queue.requestAsset('sha256:first', { priority: 50 });
    const far = queue.requestAsset('sha256:far', { priority: 90 });
    const near = queue.requestAsset('sha256:near', { priority: 0 });
    await Promise.resolve();
    expect(started).toEqual(['sha256:first']);
    finish('sha256:first');
    await first;
    await vi.waitFor(() => expect(started).toEqual(['sha256:first', 'sha256:near']));
    finish('sha256:near');
    await near;
    await vi.waitFor(() => expect(started).toEqual(['sha256:first', 'sha256:near', 'sha256:far']));
    finish('sha256:far');
    await far;
  });

  it('drops a waiting download that nobody wants any more', async () => {
    const { http, started, finish } = gatedHttp();
    const queue = new AssetSyncQueue({ http, runtime: makeRuntime() }, { maxConcurrentDownloads: 1, batchMs: 1_000_000 });
    const running = queue.requestAsset('sha256:running');
    const controller = new AbortController();
    const waiting = queue.requestAsset('sha256:waiting', { signal: controller.signal });
    controller.abort();
    await expect(waiting).rejects.toThrow();
    finish('sha256:running');
    await running;
    await Promise.resolve();
    expect(started).toEqual(['sha256:running']);
  });

  it('keeps a download for a caller that stays when another one withdraws', async () => {
    const { http, started, finish } = gatedHttp();
    const queue = new AssetSyncQueue({ http, runtime: makeRuntime() }, { maxConcurrentDownloads: 1, batchMs: 1_000_000 });
    const running = queue.requestAsset('sha256:running');
    const controller = new AbortController();
    const withdrawn = queue.requestAsset('sha256:shared', { signal: controller.signal });
    const stays = queue.requestAsset('sha256:shared');
    controller.abort();
    await expect(withdrawn).rejects.toThrow();
    finish('sha256:running');
    await running;
    await vi.waitFor(() => expect(started).toContain('sha256:shared'));
    finish('sha256:shared');
    await expect(stays).resolves.toEqual(bytesOf(3));
  });
});

describe('AssetSyncQueue uploads across calls', () => {
  it('holds the concurrency limit when several sync calls overlap', async () => {
    let active = 0;
    let most = 0;
    const http = makeHttp({
      putAsset: async () => {
        active += 1;
        most = Math.max(most, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
      },
    });
    const queue = new AssetSyncQueue({ http, runtime: makeRuntime() }, { maxConcurrentUploads: 2 });
    const entry = (id: string): AssetUploadEntry => ({ assetId: id, bytes: bytesOf(4), mimeType: 'image/png', size: 4 });
    await Promise.all([
      queue.syncUploads([entry('a'), entry('b'), entry('c')], []),
      queue.syncUploads([entry('d'), entry('e'), entry('f')], []),
      queue.syncUploads([entry('g'), entry('h')], []),
    ]);
    expect(most).toBe(2);
  });
});
