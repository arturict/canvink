import type { SegmentRemote } from '../ink/segmentStore';
import { credentialHeaders, type CollabHttpConfig, type RoomMetaCredential } from './http';

/**
 * Ink segments of a shared notebook travel through the room, not through the personal space:
 * content-addressed blobs at `/rooms/:roomId/assets/:sha256`, readable with any credential the
 * room accepts and writable by its owner and editors (see the Worker's `handleRoomAsset`).
 */
export interface RoomSegmentClient {
  /** Fetches a segment for the segment store; undefined when the room does not hold it (yet). */
  remote: SegmentRemote;
  head(hash: string): Promise<boolean>;
  /** Stores a segment; the Worker verifies the hash. Resolves on stored and on already-stored. */
  put(hash: string, bytes: Uint8Array): Promise<void>;
}

export const RoomSegmentRefusedError = class RoomSegmentRefusedError extends Error {
  constructor(readonly status: number) {
    super(`The room refused the ink segment (status ${status}).`);
  }
};

export function createRoomSegmentClient(
  config: CollabHttpConfig,
  roomId: string,
  credential: () => RoomMetaCredential | Promise<RoomMetaCredential>,
): RoomSegmentClient {
  const fetchImpl = (): typeof fetch => {
    const impl = config.fetchImpl ?? globalThis.fetch;
    if (!impl) throw new Error('No fetch implementation is available; pass config.fetchImpl.');
    return impl;
  };
  const url = (hash: string): string =>
    `${config.syncUrl.replace(/\/+$/, '')}/api/v1/rooms/${encodeURIComponent(roomId)}/assets/${hash}`;
  const headers = async (extra: Record<string, string> = {}): Promise<Record<string, string>> => ({
    ...credentialHeaders(await credential()),
    ...extra,
  });

  return {
    remote: {
      fetch: async (hash) => {
        const response = await fetchImpl()(url(hash), { headers: await headers() });
        // 204: the room does not hold it (yet).
        if (response.status === 204 || response.status === 404) return undefined;
        if (!response.ok) throw new Error(`Fetching an ink segment failed with status ${response.status}.`);
        return new Uint8Array(await response.arrayBuffer());
      },
    },
    head: async (hash) => {
      const response = await fetchImpl()(url(hash), { method: 'HEAD', headers: await headers() });
      if (response.status === 204 || response.status === 404) return false;
      if (!response.ok) throw new RoomSegmentRefusedError(response.status);
      return true;
    },
    put: async (hash, bytes) => {
      const response = await fetchImpl()(url(hash), {
        method: 'PUT',
        headers: await headers({ 'content-type': 'application/vnd.canvink.ink-segment' }),
        body: bytes as unknown as BodyInit,
      });
      if (!response.ok) throw new RoomSegmentRefusedError(response.status);
    },
  };
}
