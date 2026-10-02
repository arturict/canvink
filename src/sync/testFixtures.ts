import {
  SYNC_PROTOCOL_VERSION,
  type PendingSyncEnvelope,
  type SyncEnvelope,
} from './types';

export function bytes(...values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

export function pendingEnvelope(
  marker: number,
  overrides: Partial<PendingSyncEnvelope> = {},
): PendingSyncEnvelope {
  return {
    protocolVersion: SYNC_PROTOCOL_VERSION,
    notebookId: 'notebook-1',
    documentId: 'document-1',
    deviceId: 'device-1',
    keyEpoch: 1,
    sequence: null,
    changeHash: new Uint8Array(32).fill(marker),
    nonce: new Uint8Array(24).fill(marker),
    ciphertext: bytes(marker, 2),
    signature: new Uint8Array(64).fill(marker),
    ...overrides,
  };
}

export function syncEnvelope(
  sequence: number,
  marker = sequence,
  overrides: Partial<SyncEnvelope> = {},
): SyncEnvelope {
  return {
    ...pendingEnvelope(marker),
    sequence,
    ...overrides,
  };
}
