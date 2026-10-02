import assert from "node:assert/strict";
import { test } from "node:test";
import { LIMITS } from "../src/contracts.js";
import { ApiError } from "../src/errors.js";
import {
  parseBeginAssetUpload,
  parseActivateDevice,
  parseActivateDeviceWithRecovery,
  parseCreateDeviceApprovalChallenge,
  parseHeadsAcknowledgement,
  parseKeyEnvelope,
  parseListKeyEnvelopes,
  parseListMyDevices,
  parsePendingChange,
  parseRegisterDevice,
  parseRevokeDevice,
  parseUploadAssetChunk,
} from "../src/validation.js";
import { bytes, change } from "./helpers.js";

test("accepts canonical opaque envelope fields without interpreting ciphertext", () => {
  assert.deepEqual(parsePendingChange(change()), change());
});

test("rejects unknown fields, sequence injection, padded base64, and malformed IDs", () => {
  for (const candidate of [
    { ...change(), title: "clear text" },
    { ...change(), sequence: 7 },
    { ...change(), keyEpoch: 0 },
    { ...change(), nonce: `${bytes(24)}=` },
    { ...change(), notebookId: "team:unsupported" },
  ]) {
    assert.throws(() => parsePendingChange(candidate), ApiError);
  }
});

test("requires change epochs and both X25519 public keys in wrapped-key envelopes", () => {
  const pending = change();
  const withoutEpoch: Record<string, unknown> = { ...pending };
  delete withoutEpoch.keyEpoch;
  assert.throws(() => parsePendingChange(withoutEpoch), ApiError);

  const keyEnvelope = {
    protocolVersion: 1,
    notebookId: "notebook-1",
    keyEpoch: 2,
    senderDeviceId: "device-1",
    recipient: { kind: "device", id: "device-2" },
    senderEncryptionPublicKey: bytes(32, 1),
    recipientEncryptionPublicKey: bytes(32, 2),
    nonce: bytes(24, 3),
    ciphertext: bytes(48, 4),
    signature: bytes(64, 5),
    envelopeHash: bytes(32, 6),
  };
  assert.deepEqual(parseKeyEnvelope(keyEnvelope), keyEnvelope);
  const withoutRecipientKey: Record<string, unknown> = { ...keyEnvelope };
  delete withoutRecipientKey.recipientEncryptionPublicKey;
  assert.throws(() => parseKeyEnvelope(withoutRecipientKey), ApiError);
  assert.throws(
    () =>
      parseKeyEnvelope({
        ...keyEnvelope,
        recipientEncryptionPublicKey: bytes(31, 7),
      }),
    ApiError,
  );
  const recoveryEnvelope = {
    ...keyEnvelope,
    recipient: { kind: "recovery", id: "recovery-1" },
    recoverySigningPublicKey: bytes(32, 8),
  };
  assert.deepEqual(parseKeyEnvelope(recoveryEnvelope), recoveryEnvelope);
  const withoutRecoverySigningKey: Record<string, unknown> = {
    ...recoveryEnvelope,
  };
  delete withoutRecoverySigningKey.recoverySigningPublicKey;
  assert.throws(() => parseKeyEnvelope(withoutRecoverySigningKey), ApiError);
  assert.throws(
    () =>
      parseKeyEnvelope({
        ...keyEnvelope,
        recoverySigningPublicKey: bytes(32, 8),
      }),
    ApiError,
  );
});

test("enforces ciphertext, asset, acknowledgement, and head limits", () => {
  assert.throws(
    () =>
      parsePendingChange({
        ...change(),
        ciphertext: bytes(LIMITS.ciphertextBytes + 1),
      }),
    ApiError,
  );
  assert.throws(
    () =>
      parseBeginAssetUpload({
        protocolVersion: 1,
        notebookId: "notebook-1",
        deviceId: "device-1",
        encryptedHash: bytes(32),
        encryptedSize: LIMITS.assetBytes + 1,
        uploadSignature: bytes(64),
      }),
    ApiError,
  );
  assert.throws(
    () =>
      parseHeadsAcknowledgement({
        protocolVersion: 1,
        notebookId: "notebook-1",
        deviceId: "device-1",
        sequence: 0,
        documents: Array.from(
          { length: LIMITS.acknowledgementDocuments + 1 },
          (_, index) => ({
            documentId: `page-${index}`,
            heads: [],
          }),
        ),
      }),
    ApiError,
  );
  assert.throws(
    () =>
      parseHeadsAcknowledgement({
        protocolVersion: 1,
        notebookId: "notebook-1",
        deviceId: "device-1",
        sequence: 0,
        documents: [{ documentId: "page-1", heads: [bytes(32), bytes(32)] }],
      }),
    ApiError,
  );
});

test("validates the fixed encrypted asset chunk budget", () => {
  const request = {
    protocolVersion: 1,
    notebookId: "notebook-1",
    deviceId: "device-1",
    assetId: "asset-1",
    fileId: "file-1",
    encryptedHash: bytes(32),
    encryptedSize: LIMITS.assetBytes,
    uploadSignature: bytes(64),
    chunkIndex: 21,
    chunkCount: 22,
    chunkHash: bytes(32, 2),
    chunkBytes: bytes(1024, 3),
  };
  assert.deepEqual(parseUploadAssetChunk(request), request);
  assert.throws(
    () => parseUploadAssetChunk({ ...request, chunkCount: 23 }),
    ApiError,
  );
  assert.throws(
    () => parseUploadAssetChunk({ ...request, chunkIndex: 22 }),
    ApiError,
  );
});

test("strictly validates device directory and recipient-safe envelope listing requests", () => {
  assert.deepEqual(
    parseRegisterDevice({
      protocolVersion: 1,
      deviceId: "device-1",
      encryptionPublicKey: bytes(32, 1),
      signingPublicKey: bytes(32, 2),
    }),
    {
      protocolVersion: 1,
      deviceId: "device-1",
      encryptionPublicKey: bytes(32, 1),
      signingPublicKey: bytes(32, 2),
    },
  );
  assert.throws(
    () =>
      parseRegisterDevice({
        protocolVersion: 1,
        accountId: "forged-user",
        deviceId: "device-1",
        encryptionPublicKey: bytes(32, 1),
        signingPublicKey: bytes(32, 2),
      }),
    ApiError,
  );
  assert.throws(
    () =>
      parseRegisterDevice({
        protocolVersion: 1,
        deviceId: "device-1",
        encryptionPublicKey: bytes(31, 1),
        signingPublicKey: bytes(32, 2),
      }),
    ApiError,
  );
  assert.deepEqual(parseListMyDevices({ limit: 1 }), { limit: 1 });
  assert.deepEqual(
    parseRevokeDevice({ deviceId: "device-1", notebookId: "notebook-1" }),
    {
      deviceId: "device-1",
      notebookId: "notebook-1",
    },
  );
  assert.deepEqual(
    parseListKeyEnvelopes({
      notebookId: "notebook-1",
      recipient: { kind: "device", id: "device-1" },
      limit: 10,
    }),
    {
      notebookId: "notebook-1",
      recipient: { kind: "device", id: "device-1" },
      limit: 10,
    },
  );
  assert.deepEqual(
    parseListKeyEnvelopes({
      notebookId: "notebook-1",
      recipient: { kind: "recovery", id: "recovery-1" },
      limit: 10,
    }),
    {
      notebookId: "notebook-1",
      recipient: { kind: "recovery", id: "recovery-1" },
      limit: 10,
    },
  );
  assert.throws(
    () => parseListMyDevices({ limit: LIMITS.directoryPage + 1 }),
    ApiError,
  );
  assert.deepEqual(
    parseCreateDeviceApprovalChallenge({
      protocolVersion: 1,
      notebookId: "notebook-1",
      requestingDeviceId: "device-2",
    }),
    {
      protocolVersion: 1,
      notebookId: "notebook-1",
      requestingDeviceId: "device-2",
    },
  );
  assert.deepEqual(
    parseActivateDevice({
      challengeId: "challenge-1",
      proof: {
        protocolVersion: 1,
        approverDeviceId: "device-1",
        challengeHash: bytes(32, 3),
        signature: bytes(64, 4),
      },
    }),
    {
      challengeId: "challenge-1",
      proof: {
        protocolVersion: 1,
        approverDeviceId: "device-1",
        challengeHash: bytes(32, 3),
        signature: bytes(64, 4),
      },
    },
  );
  assert.throws(
    () =>
      parseActivateDevice({
        challengeId: "challenge-1",
        proof: {
          protocolVersion: 1,
          approverDeviceId: "device-1",
          challengeHash: bytes(31, 3),
          signature: bytes(64, 4),
        },
      }),
    ApiError,
  );
  assert.deepEqual(
    parseActivateDeviceWithRecovery({
      challengeId: "challenge-1",
      proof: {
        protocolVersion: 1,
        recoveryKeyId: "recovery-1",
        challengeHash: bytes(32, 3),
        signature: bytes(64, 4),
      },
    }),
    {
      challengeId: "challenge-1",
      proof: {
        protocolVersion: 1,
        recoveryKeyId: "recovery-1",
        challengeHash: bytes(32, 3),
        signature: bytes(64, 4),
      },
    },
  );
});
