import { describe, expect, it } from "vitest";
import type { EncryptedAssetEnvelope } from "../crypto";
import { SYNC_PROTOCOL_VERSION, type PendingSyncEnvelope } from "../types";
import {
  MAX_ENCRYPTED_ASSET_CIPHERTEXT_BYTES,
  MAX_ENCRYPTED_ASSET_WIRE_BYTES,
  MAX_FUNCTION_CHANGE_CIPHERTEXT_BYTES,
  packEncryptedAsset,
  pendingChangeToJson,
} from "./wire";

function bytes(length: number, fill = 1): Uint8Array {
  return new Uint8Array(length).fill(fill);
}

function pending(ciphertext: Uint8Array): PendingSyncEnvelope {
  return {
    protocolVersion: SYNC_PROTOCOL_VERSION,
    notebookId: "notebook",
    documentId: "document",
    deviceId: "device",
    keyEpoch: 1,
    sequence: null,
    changeHash: bytes(32),
    nonce: bytes(24),
    ciphertext,
    signature: bytes(64),
  };
}

function asset(ciphertext: Uint8Array): EncryptedAssetEnvelope {
  return {
    protocolVersion: SYNC_PROTOCOL_VERSION,
    notebookId: "notebook",
    assetId: "asset",
    mimeType: "application/octet-stream",
    uploaderDeviceId: "device",
    keyEpoch: 1,
    plaintextSize: 1,
    plaintextHash: bytes(32),
    nonce: bytes(24),
    ciphertext,
    signature: bytes(64),
  };
}

describe("sync wire size boundaries", () => {
  it("accepts an exact 4 MiB encrypted atomic change and requires larger logical operations to split before encryption", () => {
    expect(() =>
      pendingChangeToJson(pending(bytes(MAX_FUNCTION_CHANGE_CIPHERTEXT_BYTES))),
    ).not.toThrow();
    expect(() =>
      pendingChangeToJson(
        pending(bytes(MAX_FUNCTION_CHANGE_CIPHERTEXT_BYTES + 1)),
      ),
    ).toThrow(/split at the operation source before encryption/);
  });

  it("packs an exact 64 MiB encrypted asset frame and rejects one extra byte without committed fixtures", () => {
    const packed = packEncryptedAsset(
      asset(bytes(MAX_ENCRYPTED_ASSET_CIPHERTEXT_BYTES)),
    );
    expect(packed.byteLength).toBe(MAX_ENCRYPTED_ASSET_WIRE_BYTES);
    expect(() =>
      packEncryptedAsset(
        asset(bytes(MAX_ENCRYPTED_ASSET_CIPHERTEXT_BYTES + 1)),
      ),
    ).toThrow(/exceeds the sync service limit/);
  });
});
