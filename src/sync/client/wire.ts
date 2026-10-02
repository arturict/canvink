import type {
  DeviceApprovalChallenge,
  EncryptedAssetEnvelope,
} from "../crypto";
import {
  SYNC_PROTOCOL_VERSION,
  type CatchUpPage,
  type HeadsAcknowledgement,
  type NotebookKeyEnvelope,
  type PendingSyncEnvelope,
  type SyncEnvelope,
} from "../types";
import {
  parseCatchUpPage,
  parseDevicePublicIdentity,
  parseNotebookKeyEnvelope,
  parsePendingSyncEnvelope,
  parseSyncEnvelope,
} from "../validation";
import { SyncClientError } from "./errors";
import type { SyncRegisteredDevice } from "./types";

const encoder = new TextEncoder();
const ASSET_MAGIC = encoder.encode("CNVKAST1");
export const MAX_FUNCTION_CHANGE_CIPHERTEXT_BYTES = 4 * 1024 * 1024;
export const MAX_ENCRYPTED_ASSET_WIRE_BYTES = 64 * 1024 * 1024;
export const ENCRYPTED_ASSET_FRAME_BYTES = ASSET_MAGIC.byteLength + 24 + 64;
export const MAX_ENCRYPTED_ASSET_CIPHERTEXT_BYTES =
  MAX_ENCRYPTED_ASSET_WIRE_BYTES - ENCRYPTED_ASSET_FRAME_BYTES;

export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export function decodeBase64Url(value: unknown, label: string): Uint8Array {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new SyncClientError("protocol-error", `${label} is invalid.`);
  }
  const padded =
    value.replaceAll("-", "+").replaceAll("_", "/") +
    "=".repeat((4 - (value.length % 4)) % 4);
  try {
    return Uint8Array.from(atob(padded), (character) =>
      character.charCodeAt(0),
    );
  } catch (error) {
    throw new SyncClientError("protocol-error", `${label} is invalid.`, {
      cause: error,
    });
  }
}

export function pendingChangeToJson(
  value: PendingSyncEnvelope,
): Record<string, unknown> {
  if (
    value.ciphertext.byteLength < 1 ||
    value.ciphertext.byteLength > MAX_FUNCTION_CHANGE_CIPHERTEXT_BYTES
  ) {
    throw new SyncClientError(
      "protocol-error",
      "Encrypted change exceeds the sync service limit and must be split at the operation source before encryption.",
    );
  }
  return {
    protocolVersion: value.protocolVersion,
    notebookId: value.notebookId,
    documentId: value.documentId,
    deviceId: value.deviceId,
    keyEpoch: value.keyEpoch,
    changeHash: encodeBase64Url(value.changeHash),
    nonce: encodeBase64Url(value.nonce),
    ciphertext: encodeBase64Url(value.ciphertext),
    signature: encodeBase64Url(value.signature),
  };
}

export function syncEnvelopeFromJson(input: unknown): SyncEnvelope {
  const value = object(input, "change envelope");
  return parseSyncEnvelope({
    protocolVersion: value.protocolVersion,
    notebookId: value.notebookId,
    documentId: value.documentId,
    deviceId: value.deviceId,
    keyEpoch: value.keyEpoch,
    sequence: value.sequence,
    changeHash: decodeBase64Url(value.changeHash, "change hash"),
    nonce: decodeBase64Url(value.nonce, "change nonce"),
    ciphertext: decodeBase64Url(value.ciphertext, "change ciphertext"),
    signature: decodeBase64Url(value.signature, "change signature"),
  });
}

export function pendingChangeFromJson(input: unknown): PendingSyncEnvelope {
  const value = object(input, "pending change envelope");
  return parsePendingSyncEnvelope({
    protocolVersion: value.protocolVersion,
    notebookId: value.notebookId,
    documentId: value.documentId,
    deviceId: value.deviceId,
    keyEpoch: value.keyEpoch,
    sequence: null,
    changeHash: decodeBase64Url(value.changeHash, "change hash"),
    nonce: decodeBase64Url(value.nonce, "change nonce"),
    ciphertext: decodeBase64Url(value.ciphertext, "change ciphertext"),
    signature: decodeBase64Url(value.signature, "change signature"),
  });
}

export function catchUpPageFromJson(input: unknown): CatchUpPage {
  const value = object(input, "catch-up page");
  if (!Array.isArray(value.envelopes))
    throw new SyncClientError(
      "protocol-error",
      "Catch-up envelopes are invalid.",
    );
  return parseCatchUpPage({
    notebookId: value.notebookId,
    afterSequence: value.afterSequence,
    snapshotSequence: value.snapshotSequence,
    hasMore: value.hasMore,
    envelopes: value.envelopes.map(syncEnvelopeFromJson),
  });
}

export function headsToJson(
  value: HeadsAcknowledgement,
): Record<string, unknown> {
  return {
    ...value,
    documents: value.documents.map((document) => ({
      documentId: document.documentId,
      heads: document.heads.map(encodeBase64Url),
    })),
  };
}

export async function keyEnvelopeToJson(
  value: NotebookKeyEnvelope,
): Promise<Record<string, unknown>> {
  const recipient =
    value.recipient.kind === "device"
      ? { kind: value.recipient.kind, id: value.recipient.deviceId }
      : value.recipient.kind === "account"
        ? { kind: value.recipient.kind, id: value.recipient.accountId }
        : { kind: value.recipient.kind, id: value.recipient.recoveryKeyId };
  const body = {
    protocolVersion: value.protocolVersion,
    notebookId: value.notebookId,
    keyEpoch: value.keyEpoch,
    senderDeviceId: value.senderDeviceId,
    recipient,
    senderEncryptionPublicKey: encodeBase64Url(value.senderEncryptionPublicKey),
    recipientEncryptionPublicKey: encodeBase64Url(
      value.recipientEncryptionPublicKey,
    ),
    ...(value.recipient.kind === "recovery" && value.recoverySigningPublicKey
      ? {
          recoverySigningPublicKey: encodeBase64Url(
            value.recoverySigningPublicKey,
          ),
        }
      : {}),
    nonce: encodeBase64Url(value.nonce),
    ciphertext: encodeBase64Url(value.ciphertext),
    signature: encodeBase64Url(value.signature),
  };
  const canonical = encoder.encode(JSON.stringify(body));
  return { ...body, envelopeHash: encodeBase64Url(await sha256(canonical)) };
}

export function keyEnvelopeFromJson(input: unknown): NotebookKeyEnvelope {
  const value = object(input, "key envelope");
  const recipientValue = object(value.recipient, "key envelope recipient");
  const recipient =
    recipientValue.kind === "device"
      ? { kind: "device" as const, deviceId: recipientValue.id }
      : recipientValue.kind === "account"
        ? { kind: "account" as const, accountId: recipientValue.id }
        : { kind: "recovery" as const, recoveryKeyId: recipientValue.id };
  return parseNotebookKeyEnvelope({
    protocolVersion: value.protocolVersion,
    notebookId: value.notebookId,
    keyEpoch: value.keyEpoch,
    senderDeviceId: value.senderDeviceId,
    recipient,
    senderEncryptionPublicKey: decodeBase64Url(
      value.senderEncryptionPublicKey,
      "sender encryption public key",
    ),
    recipientEncryptionPublicKey: decodeBase64Url(
      value.recipientEncryptionPublicKey,
      "recipient encryption public key",
    ),
    ...(recipient.kind === "recovery"
      ? {
          recoverySigningPublicKey: decodeBase64Url(
            value.recoverySigningPublicKey,
            "recovery signing public key",
          ),
        }
      : {}),
    nonce: decodeBase64Url(value.nonce, "key envelope nonce"),
    ciphertext: decodeBase64Url(value.ciphertext, "key envelope ciphertext"),
    signature: decodeBase64Url(value.signature, "key envelope signature"),
  });
}

export function storedKeyEnvelopeFromJson(input: unknown): {
  envelopeId: string;
  envelope: NotebookKeyEnvelope;
  senderSigningPublicKey: Uint8Array;
} {
  const value = object(input, "stored key envelope");
  if (
    typeof value.envelopeId !== "string" ||
    value.envelopeId.length < 1 ||
    value.envelopeId.length > 256
  ) {
    throw new SyncClientError(
      "protocol-error",
      "Stored key envelope ID is invalid.",
    );
  }
  const envelopeHash = decodeBase64Url(value.envelopeHash, "key envelope hash");
  if (envelopeHash.byteLength !== 32)
    throw new SyncClientError(
      "protocol-error",
      "Key envelope hash is invalid.",
    );
  const senderSigningPublicKey = decodeBase64Url(
    value.senderSigningPublicKey,
    "key envelope sender signing public key",
  );
  if (senderSigningPublicKey.byteLength !== 32)
    throw new SyncClientError(
      "protocol-error",
      "Key envelope sender signing public key is invalid.",
    );
  return {
    envelopeId: value.envelopeId,
    envelope: keyEnvelopeFromJson(value),
    senderSigningPublicKey,
  };
}

export function registeredDeviceFromJson(input: unknown): SyncRegisteredDevice {
  const value = object(input, "registered device");
  const publicIdentity = parseDevicePublicIdentity({
    protocolVersion: value.protocolVersion,
    accountId: "directory-account",
    deviceId: value.deviceId,
    encryptionPublicKey: decodeBase64Url(
      value.encryptionPublicKey,
      "device encryption public key",
    ),
    signingPublicKey: decodeBase64Url(
      value.signingPublicKey,
      "device signing public key",
    ),
  });
  if (
    value.status !== "pending" &&
    value.status !== "active" &&
    value.status !== "revoked"
  )
    throw new SyncClientError("protocol-error", "Device status is invalid.");
  for (const key of ["createdAt", "updatedAt"] as const) {
    if (
      typeof value[key] !== "string" ||
      !Number.isFinite(Date.parse(value[key] as string))
    )
      throw new SyncClientError("protocol-error", `Device ${key} is invalid.`);
  }
  if (
    value.revokedAt !== undefined &&
    (typeof value.revokedAt !== "string" ||
      !Number.isFinite(Date.parse(value.revokedAt)))
  ) {
    throw new SyncClientError("protocol-error", "Device revokedAt is invalid.");
  }
  return {
    protocolVersion: 1,
    deviceId: publicIdentity.deviceId,
    encryptionPublicKey: publicIdentity.encryptionPublicKey,
    signingPublicKey: publicIdentity.signingPublicKey,
    status: value.status,
    createdAt: value.createdAt as string,
    updatedAt: value.updatedAt as string,
    ...(typeof value.revokedAt === "string"
      ? { revokedAt: value.revokedAt }
      : {}),
  };
}

export function deviceApprovalChallengeFromJson(
  input: unknown,
): DeviceApprovalChallenge {
  const value = object(input, "device approval challenge");
  if (
    value.protocolVersion !== 1 ||
    typeof value.notebookId !== "string" ||
    typeof value.accountId !== "string" ||
    typeof value.requestingDeviceId !== "string" ||
    !Number.isSafeInteger(value.issuedAt) ||
    !Number.isSafeInteger(value.expiresAt) ||
    (value.expiresAt as number) <= (value.issuedAt as number) ||
    (value.expiresAt as number) - (value.issuedAt as number) > 10 * 60_000
  )
    throw new SyncClientError(
      "protocol-error",
      "Device approval challenge is invalid.",
    );
  const encryptionPublicKey = decodeBase64Url(
    value.requestingEncryptionPublicKey,
    "requesting encryption public key",
  );
  const signingPublicKey = decodeBase64Url(
    value.requestingSigningPublicKey,
    "requesting signing public key",
  );
  const nonce = decodeBase64Url(value.nonce, "device approval nonce");
  if (
    encryptionPublicKey.byteLength !== 32 ||
    signingPublicKey.byteLength !== 32 ||
    nonce.byteLength !== 32
  ) {
    throw new SyncClientError(
      "protocol-error",
      "Device approval challenge key material is invalid.",
    );
  }
  return {
    protocolVersion: 1,
    notebookId: value.notebookId,
    accountId: value.accountId,
    requestingDeviceId: value.requestingDeviceId,
    requestingEncryptionPublicKey: encryptionPublicKey,
    requestingSigningPublicKey: signingPublicKey,
    nonce,
    issuedAt: value.issuedAt as number,
    expiresAt: value.expiresAt as number,
  };
}

export function packEncryptedAsset(value: EncryptedAssetEnvelope): Uint8Array {
  if (
    value.protocolVersion !== SYNC_PROTOCOL_VERSION ||
    value.nonce.byteLength !== 24 ||
    value.signature.byteLength !== 64
  ) {
    throw new SyncClientError(
      "protocol-error",
      "Encrypted asset framing is invalid.",
    );
  }
  if (value.ciphertext.byteLength > MAX_ENCRYPTED_ASSET_CIPHERTEXT_BYTES) {
    throw new SyncClientError(
      "protocol-error",
      "Encrypted asset exceeds the sync service limit.",
    );
  }
  const output = new Uint8Array(
    ENCRYPTED_ASSET_FRAME_BYTES + value.ciphertext.byteLength,
  );
  output.set(ASSET_MAGIC);
  output.set(value.nonce, ASSET_MAGIC.byteLength);
  output.set(value.signature, ASSET_MAGIC.byteLength + 24);
  output.set(value.ciphertext, ASSET_MAGIC.byteLength + 24 + 64);
  return output;
}

export function unpackEncryptedAsset(
  bytes: Uint8Array,
  metadata: Omit<EncryptedAssetEnvelope, "nonce" | "ciphertext" | "signature">,
): EncryptedAssetEnvelope {
  const prefix = bytes.slice(0, ASSET_MAGIC.byteLength);
  if (
    bytes.byteLength <= ASSET_MAGIC.byteLength + 24 + 64 ||
    bytes.byteLength > MAX_ENCRYPTED_ASSET_WIRE_BYTES ||
    !prefix.every((byte, index) => byte === ASSET_MAGIC[index])
  ) {
    throw new SyncClientError(
      "protocol-error",
      "Encrypted asset framing is invalid.",
    );
  }
  return {
    ...metadata,
    nonce: bytes.slice(ASSET_MAGIC.byteLength, ASSET_MAGIC.byteLength + 24),
    signature: bytes.slice(
      ASSET_MAGIC.byteLength + 24,
      ASSET_MAGIC.byteLength + 24 + 64,
    ),
    ciphertext: bytes.slice(ASSET_MAGIC.byteLength + 24 + 64),
  };
}

export async function encryptedHash(bytes: Uint8Array): Promise<string> {
  return encodeBase64Url(await sha256(bytes));
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SyncClientError("protocol-error", `${label} is invalid.`);
  }
  return value as Record<string, unknown>;
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  if (!globalThis.crypto?.subtle)
    throw new SyncClientError("protocol-error", "SHA-256 is unavailable.");
  return new Uint8Array(
    await globalThis.crypto.subtle.digest("SHA-256", bytes.slice().buffer),
  );
}

export function responseObject(
  value: unknown,
  label: string,
): Record<string, unknown> {
  return object(value, label);
}
