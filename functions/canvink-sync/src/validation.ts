import { Buffer } from "node:buffer";
import {
  LIMITS,
  SYNC_PROTOCOL_VERSION,
  type BeginAssetUpload,
  type ActivateDeviceRequest,
  type ActivateDeviceWithRecoveryRequest,
  type CompleteAssetUpload,
  type CreateDeviceApprovalChallengeRequest,
  type HeadsAcknowledgement,
  type ListKeyEnvelopesRequest,
  type ListMyDevicesRequest,
  type ListNotebookDevicesRequest,
  type NotebookKeyEnvelope,
  type PendingChangeEnvelope,
  type RegisterDeviceRequest,
  type RecipientKind,
  type RevokeDeviceRequest,
  type UploadAssetChunk,
} from "./contracts.js";
import { badRequest } from "./errors.js";

type JsonRecord = Record<string, unknown>;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;

function record(value: unknown, path: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    badRequest(`${path} must be an object.`);
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    badRequest(`${path} must be a plain object.`);
  }
  return value as JsonRecord;
}

function exactKeys(
  value: JsonRecord,
  path: string,
  expected: readonly string[],
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    badRequest(`${path} has unsupported or missing fields.`);
  }
}

function integer(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    badRequest(`${path} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value as number;
}

function opaqueId(value: unknown, path: string, maximumLength = 128): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumLength ||
    !SAFE_ID.test(value)
  ) {
    badRequest(
      `${path} must be an opaque identifier of at most ${maximumLength} characters.`,
    );
  }
  return value;
}

function notebookId(value: unknown, path = "notebookId"): string {
  return opaqueId(value, path, 36);
}

function canonicalBase64Url(
  value: unknown,
  path: string,
  minimumBytes: number,
  maximumBytes: number,
): string {
  if (typeof value !== "string" || !BASE64URL.test(value))
    badRequest(`${path} must be unpadded base64url.`);
  const bytes = Buffer.from(value, "base64url");
  if (
    bytes.toString("base64url") !== value ||
    bytes.byteLength < minimumBytes ||
    bytes.byteLength > maximumBytes
  ) {
    badRequest(`${path} has an invalid encoded length.`);
  }
  return value;
}

function protocolVersion(
  value: unknown,
  path: string,
): typeof SYNC_PROTOCOL_VERSION {
  if (value !== SYNC_PROTOCOL_VERSION) badRequest(`${path} is unsupported.`);
  return SYNC_PROTOCOL_VERSION;
}

function optionalCursor(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return opaqueId(value, "cursor", 36);
}

export function parseRegisterDevice(value: unknown): RegisterDeviceRequest {
  const request = record(value, "request");
  exactKeys(request, "request", [
    "protocolVersion",
    "deviceId",
    "encryptionPublicKey",
    "signingPublicKey",
  ]);
  return {
    protocolVersion: protocolVersion(
      request.protocolVersion,
      "protocolVersion",
    ),
    deviceId: opaqueId(request.deviceId, "deviceId"),
    encryptionPublicKey: canonicalBase64Url(
      request.encryptionPublicKey,
      "encryptionPublicKey",
      32,
      32,
    ),
    signingPublicKey: canonicalBase64Url(
      request.signingPublicKey,
      "signingPublicKey",
      32,
      32,
    ),
  };
}

export function parseListMyDevices(value: unknown): ListMyDevicesRequest {
  const request = record(value, "request");
  const allowed = new Set(["cursor", "limit"]);
  if (Object.keys(request).some((key) => !allowed.has(key)))
    badRequest("request has unsupported fields.");
  const cursor = optionalCursor(request.cursor);
  return {
    ...(cursor === undefined ? {} : { cursor }),
    limit:
      request.limit === undefined
        ? LIMITS.directoryPage
        : integer(request.limit, "limit", 1, LIMITS.directoryPage),
  };
}

export function parseListNotebookDevices(
  value: unknown,
): ListNotebookDevicesRequest {
  const request = record(value, "request");
  const allowed = new Set(["notebookId", "cursor", "limit"]);
  if (
    Object.keys(request).some((key) => !allowed.has(key)) ||
    !Object.hasOwn(request, "notebookId")
  ) {
    badRequest("request has unsupported or missing fields.");
  }
  const cursor = optionalCursor(request.cursor);
  return {
    notebookId: notebookId(request.notebookId),
    ...(cursor === undefined ? {} : { cursor }),
    limit:
      request.limit === undefined
        ? LIMITS.directoryPage
        : integer(request.limit, "limit", 1, LIMITS.directoryPage),
  };
}

export function parseRevokeDevice(value: unknown): RevokeDeviceRequest {
  const request = record(value, "request");
  const allowed = new Set(["deviceId", "notebookId"]);
  if (
    Object.keys(request).some((key) => !allowed.has(key)) ||
    !Object.hasOwn(request, "deviceId")
  ) {
    badRequest("request has unsupported or missing fields.");
  }
  return {
    deviceId: opaqueId(request.deviceId, "deviceId"),
    ...(request.notebookId === undefined
      ? {}
      : { notebookId: notebookId(request.notebookId) }),
  };
}

export function parseCreateDeviceApprovalChallenge(
  value: unknown,
): CreateDeviceApprovalChallengeRequest {
  const request = record(value, "request");
  exactKeys(request, "request", [
    "protocolVersion",
    "notebookId",
    "requestingDeviceId",
  ]);
  return {
    protocolVersion: protocolVersion(
      request.protocolVersion,
      "protocolVersion",
    ),
    notebookId: notebookId(request.notebookId),
    requestingDeviceId: opaqueId(
      request.requestingDeviceId,
      "requestingDeviceId",
    ),
  };
}

export function parseActivateDevice(value: unknown): ActivateDeviceRequest {
  const request = record(value, "request");
  exactKeys(request, "request", ["challengeId", "proof"]);
  const proof = record(request.proof, "proof");
  exactKeys(proof, "proof", [
    "protocolVersion",
    "approverDeviceId",
    "challengeHash",
    "signature",
  ]);
  return {
    challengeId: opaqueId(request.challengeId, "challengeId", 36),
    proof: {
      protocolVersion: protocolVersion(
        proof.protocolVersion,
        "proof.protocolVersion",
      ),
      approverDeviceId: opaqueId(
        proof.approverDeviceId,
        "proof.approverDeviceId",
      ),
      challengeHash: canonicalBase64Url(
        proof.challengeHash,
        "proof.challengeHash",
        32,
        32,
      ),
      signature: canonicalBase64Url(proof.signature, "proof.signature", 64, 64),
    },
  };
}

export function parseActivateDeviceWithRecovery(
  value: unknown,
): ActivateDeviceWithRecoveryRequest {
  const request = record(value, "request");
  exactKeys(request, "request", ["challengeId", "proof"]);
  const proof = record(request.proof, "proof");
  exactKeys(proof, "proof", [
    "protocolVersion",
    "recoveryKeyId",
    "challengeHash",
    "signature",
  ]);
  return {
    challengeId: opaqueId(request.challengeId, "challengeId", 36),
    proof: {
      protocolVersion: protocolVersion(
        proof.protocolVersion,
        "proof.protocolVersion",
      ),
      recoveryKeyId: opaqueId(proof.recoveryKeyId, "proof.recoveryKeyId"),
      challengeHash: canonicalBase64Url(
        proof.challengeHash,
        "proof.challengeHash",
        32,
        32,
      ),
      signature: canonicalBase64Url(proof.signature, "proof.signature", 64, 64),
    },
  };
}

export function parseListKeyEnvelopes(value: unknown): ListKeyEnvelopesRequest {
  const request = record(value, "request");
  const allowed = new Set(["notebookId", "recipient", "cursor", "limit"]);
  if (
    Object.keys(request).some((key) => !allowed.has(key)) ||
    !Object.hasOwn(request, "notebookId") ||
    !Object.hasOwn(request, "recipient")
  ) {
    badRequest("request has unsupported or missing fields.");
  }
  const candidate = record(request.recipient, "recipient");
  exactKeys(candidate, "recipient", ["kind", "id"]);
  if (
    candidate.kind !== "account" &&
    candidate.kind !== "device" &&
    candidate.kind !== "recovery"
  ) {
    badRequest("recipient.kind must be account, device, or recovery.");
  }
  const cursor = optionalCursor(request.cursor);
  return {
    notebookId: notebookId(request.notebookId),
    recipient: {
      kind: candidate.kind,
      id: opaqueId(candidate.id, "recipient.id"),
    },
    ...(cursor === undefined ? {} : { cursor }),
    limit:
      request.limit === undefined
        ? LIMITS.directoryPage
        : integer(request.limit, "limit", 1, LIMITS.directoryPage),
  };
}

export function parsePendingChange(value: unknown): PendingChangeEnvelope {
  const envelope = record(value, "envelope");
  exactKeys(envelope, "envelope", [
    "protocolVersion",
    "notebookId",
    "documentId",
    "deviceId",
    "keyEpoch",
    "changeHash",
    "nonce",
    "ciphertext",
    "signature",
  ]);
  return {
    protocolVersion: protocolVersion(
      envelope.protocolVersion,
      "envelope.protocolVersion",
    ),
    notebookId: notebookId(envelope.notebookId, "envelope.notebookId"),
    documentId: opaqueId(envelope.documentId, "envelope.documentId"),
    deviceId: opaqueId(envelope.deviceId, "envelope.deviceId"),
    keyEpoch: integer(envelope.keyEpoch, "envelope.keyEpoch", 1, 2_147_483_647),
    changeHash: canonicalBase64Url(
      envelope.changeHash,
      "envelope.changeHash",
      32,
      32,
    ),
    nonce: canonicalBase64Url(envelope.nonce, "envelope.nonce", 24, 24),
    ciphertext: canonicalBase64Url(
      envelope.ciphertext,
      "envelope.ciphertext",
      1,
      LIMITS.ciphertextBytes,
    ),
    signature: canonicalBase64Url(
      envelope.signature,
      "envelope.signature",
      64,
      64,
    ),
  };
}

export function parseListChangesAfter(value: unknown): {
  notebookId: string;
  afterSequence: number;
  limit: number;
} {
  const request = record(value, "request");
  const allowed = new Set(["notebookId", "afterSequence", "limit"]);
  if (Object.keys(request).some((key) => !allowed.has(key)))
    badRequest("request has unsupported fields.");
  if (
    !Object.hasOwn(request, "notebookId") ||
    !Object.hasOwn(request, "afterSequence")
  ) {
    badRequest("request has missing fields.");
  }
  return {
    notebookId: notebookId(request.notebookId),
    afterSequence: integer(
      request.afterSequence,
      "afterSequence",
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    limit:
      request.limit === undefined
        ? LIMITS.catchUpPage
        : integer(request.limit, "limit", 1, LIMITS.catchUpPage),
  };
}

export function parseHeadsAcknowledgement(
  value: unknown,
): HeadsAcknowledgement {
  const ack = record(value, "acknowledgement");
  exactKeys(ack, "acknowledgement", [
    "protocolVersion",
    "notebookId",
    "deviceId",
    "sequence",
    "documents",
  ]);
  if (
    !Array.isArray(ack.documents) ||
    ack.documents.length > LIMITS.acknowledgementDocuments
  ) {
    badRequest(
      `acknowledgement.documents must contain at most ${LIMITS.acknowledgementDocuments} entries.`,
    );
  }
  const documents = ack.documents.map((candidate, index) => {
    const document = record(candidate, `acknowledgement.documents[${index}]`);
    exactKeys(document, `acknowledgement.documents[${index}]`, [
      "documentId",
      "heads",
    ]);
    if (
      !Array.isArray(document.heads) ||
      document.heads.length > LIMITS.headsPerDocument
    ) {
      badRequest(
        `acknowledgement.documents[${index}].heads exceeds its limit.`,
      );
    }
    const heads = document.heads.map((head, headIndex) =>
      canonicalBase64Url(
        head,
        `acknowledgement.documents[${index}].heads[${headIndex}]`,
        32,
        32,
      ),
    );
    if (new Set(heads).size !== heads.length)
      badRequest("acknowledgement contains duplicate heads.");
    return {
      documentId: opaqueId(
        document.documentId,
        `acknowledgement.documents[${index}].documentId`,
      ),
      heads,
    };
  });
  if (
    new Set(documents.map((document) => document.documentId)).size !==
    documents.length
  ) {
    badRequest("acknowledgement contains duplicate documents.");
  }
  return {
    protocolVersion: protocolVersion(
      ack.protocolVersion,
      "acknowledgement.protocolVersion",
    ),
    notebookId: notebookId(ack.notebookId, "acknowledgement.notebookId"),
    deviceId: opaqueId(ack.deviceId, "acknowledgement.deviceId"),
    sequence: integer(
      ack.sequence,
      "acknowledgement.sequence",
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    documents,
  };
}

function recipient(value: unknown): { kind: RecipientKind; id: string } {
  const candidate = record(value, "keyEnvelope.recipient");
  exactKeys(candidate, "keyEnvelope.recipient", ["kind", "id"]);
  if (
    candidate.kind !== "account" &&
    candidate.kind !== "device" &&
    candidate.kind !== "recovery"
  ) {
    badRequest("keyEnvelope.recipient.kind is unsupported.");
  }
  return {
    kind: candidate.kind,
    id: opaqueId(candidate.id, "keyEnvelope.recipient.id"),
  };
}

export function parseKeyEnvelope(value: unknown): NotebookKeyEnvelope {
  const envelope = record(value, "keyEnvelope");
  const parsedRecipient = recipient(envelope.recipient);
  const keys = [
    "protocolVersion",
    "notebookId",
    "keyEpoch",
    "senderDeviceId",
    "recipient",
    "senderEncryptionPublicKey",
    "recipientEncryptionPublicKey",
    "nonce",
    "ciphertext",
    "signature",
    "envelopeHash",
  ];
  if (parsedRecipient.kind === "recovery")
    keys.push("recoverySigningPublicKey");
  exactKeys(envelope, "keyEnvelope", keys);
  return {
    protocolVersion: protocolVersion(
      envelope.protocolVersion,
      "keyEnvelope.protocolVersion",
    ),
    notebookId: notebookId(envelope.notebookId, "keyEnvelope.notebookId"),
    keyEpoch: integer(
      envelope.keyEpoch,
      "keyEnvelope.keyEpoch",
      1,
      2_147_483_647,
    ),
    senderDeviceId: opaqueId(
      envelope.senderDeviceId,
      "keyEnvelope.senderDeviceId",
    ),
    recipient: parsedRecipient,
    senderEncryptionPublicKey: canonicalBase64Url(
      envelope.senderEncryptionPublicKey,
      "keyEnvelope.senderEncryptionPublicKey",
      32,
      32,
    ),
    recipientEncryptionPublicKey: canonicalBase64Url(
      envelope.recipientEncryptionPublicKey,
      "keyEnvelope.recipientEncryptionPublicKey",
      32,
      32,
    ),
    ...(parsedRecipient.kind === "recovery"
      ? {
          recoverySigningPublicKey: canonicalBase64Url(
            envelope.recoverySigningPublicKey,
            "keyEnvelope.recoverySigningPublicKey",
            32,
            32,
          ),
        }
      : {}),
    nonce: canonicalBase64Url(envelope.nonce, "keyEnvelope.nonce", 24, 24),
    ciphertext: canonicalBase64Url(
      envelope.ciphertext,
      "keyEnvelope.ciphertext",
      1,
      LIMITS.keyEnvelopeBytes,
    ),
    signature: canonicalBase64Url(
      envelope.signature,
      "keyEnvelope.signature",
      64,
      64,
    ),
    envelopeHash: canonicalBase64Url(
      envelope.envelopeHash,
      "keyEnvelope.envelopeHash",
      32,
      32,
    ),
  };
}

export function parseBeginAssetUpload(value: unknown): BeginAssetUpload {
  const request = record(value, "request");
  exactKeys(request, "request", [
    "protocolVersion",
    "notebookId",
    "deviceId",
    "encryptedHash",
    "encryptedSize",
    "uploadSignature",
  ]);
  return {
    protocolVersion: protocolVersion(
      request.protocolVersion,
      "protocolVersion",
    ),
    notebookId: notebookId(request.notebookId),
    deviceId: opaqueId(request.deviceId, "deviceId"),
    encryptedHash: canonicalBase64Url(
      request.encryptedHash,
      "encryptedHash",
      32,
      32,
    ),
    encryptedSize: integer(
      request.encryptedSize,
      "encryptedSize",
      1,
      LIMITS.assetBytes,
    ),
    uploadSignature: canonicalBase64Url(
      request.uploadSignature,
      "uploadSignature",
      64,
      64,
    ),
  };
}

export function parseCompleteAssetUpload(value: unknown): CompleteAssetUpload {
  const request = record(value, "request");
  exactKeys(request, "request", [
    "protocolVersion",
    "notebookId",
    "deviceId",
    "assetId",
    "fileId",
    "encryptedHash",
    "encryptedSize",
    "uploadSignature",
  ]);
  return {
    protocolVersion: protocolVersion(
      request.protocolVersion,
      "protocolVersion",
    ),
    notebookId: notebookId(request.notebookId),
    deviceId: opaqueId(request.deviceId, "deviceId"),
    assetId: opaqueId(request.assetId, "assetId", 36),
    fileId: opaqueId(request.fileId, "fileId", 36),
    encryptedHash: canonicalBase64Url(
      request.encryptedHash,
      "encryptedHash",
      32,
      32,
    ),
    encryptedSize: integer(
      request.encryptedSize,
      "encryptedSize",
      1,
      LIMITS.assetBytes,
    ),
    uploadSignature: canonicalBase64Url(
      request.uploadSignature,
      "uploadSignature",
      64,
      64,
    ),
  };
}

export function parseUploadAssetChunk(value: unknown): UploadAssetChunk {
  const request = record(value, "request");
  exactKeys(request, "request", [
    "protocolVersion",
    "notebookId",
    "deviceId",
    "assetId",
    "fileId",
    "encryptedHash",
    "encryptedSize",
    "uploadSignature",
    "chunkIndex",
    "chunkCount",
    "chunkHash",
    "chunkBytes",
  ]);
  const authorization = parseBeginAssetUpload({
    protocolVersion: request.protocolVersion,
    notebookId: request.notebookId,
    deviceId: request.deviceId,
    encryptedHash: request.encryptedHash,
    encryptedSize: request.encryptedSize,
    uploadSignature: request.uploadSignature,
  });
  return {
    ...authorization,
    assetId: opaqueId(request.assetId, "assetId", 36),
    fileId: opaqueId(request.fileId, "fileId", 36),
    chunkIndex: integer(
      request.chunkIndex,
      "chunkIndex",
      0,
      Math.ceil(LIMITS.assetBytes / LIMITS.assetChunkBytes) - 1,
    ),
    chunkCount: integer(
      request.chunkCount,
      "chunkCount",
      1,
      Math.ceil(LIMITS.assetBytes / LIMITS.assetChunkBytes),
    ),
    chunkHash: canonicalBase64Url(request.chunkHash, "chunkHash", 32, 32),
    chunkBytes: canonicalBase64Url(
      request.chunkBytes,
      "chunkBytes",
      1,
      LIMITS.assetChunkBytes,
    ),
  };
}
