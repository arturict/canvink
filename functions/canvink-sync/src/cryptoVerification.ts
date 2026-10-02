import {
  createHash,
  createPublicKey,
  timingSafeEqual,
  verify,
} from "node:crypto";
import { Buffer } from "node:buffer";

import type {
  DeviceApprovalChallenge,
  DeviceApprovalProof,
  BeginAssetUpload,
  NotebookKeyEnvelope,
  PendingChangeEnvelope,
  RecoveryDeviceApprovalProof,
} from "./contracts.js";
import { ApiError } from "./errors.js";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function u32(value: number): Buffer {
  const bytes = Buffer.allocUnsafe(4);
  bytes.writeUInt32BE(value);
  return bytes;
}

function integer(value: number): Buffer {
  const bytes = Buffer.allocUnsafe(8);
  bytes.writeBigUInt64BE(BigInt(value));
  return bytes;
}

function text(value: string): Buffer {
  return Buffer.from(value, "utf8");
}

function bytes(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

function canonical(
  domain: string,
  fields: ReadonlyArray<readonly [string, Uint8Array]>,
): Buffer {
  const domainBytes = text(domain);
  const encodedFields = fields.flatMap(([name, value]) => {
    const nameBytes = text(name);
    const fieldBytes = Buffer.from(value);
    return [
      u32(nameBytes.length),
      nameBytes,
      u32(fieldBytes.length),
      fieldBytes,
    ];
  });
  return Buffer.concat([
    u32(domainBytes.length),
    domainBytes,
    u32(fields.length),
    ...encodedFields,
  ]);
}

function signaturePayload(
  domain: string,
  aad: Uint8Array,
  nonce: string,
  ciphertext: string,
): Buffer {
  return canonical(domain, [
    ["aad", aad],
    ["nonce", bytes(nonce)],
    ["ciphertext", bytes(ciphertext)],
  ]);
}

function verifyEd25519(
  signature: string,
  payload: Uint8Array,
  rawPublicKey: string,
): void {
  const publicKey = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, bytes(rawPublicKey)]),
    format: "der",
    type: "spki",
  });
  if (!verify(null, payload, publicKey, bytes(signature))) {
    throw new ApiError(
      400,
      "invalid_signature",
      "Cryptographic signature is invalid.",
    );
  }
}

export function changeSignaturePayload(
  envelope: Omit<PendingChangeEnvelope, "signature">,
): Buffer {
  const aad = canonical("canvink/change-aad/v1", [
    ["protocolVersion", integer(envelope.protocolVersion)],
    ["notebookId", text(envelope.notebookId)],
    ["documentId", text(envelope.documentId)],
    ["deviceId", text(envelope.deviceId)],
    ["keyEpoch", integer(envelope.keyEpoch)],
    ["changeHash", bytes(envelope.changeHash)],
  ]);
  return signaturePayload(
    "canvink/change-signature/v1",
    aad,
    envelope.nonce,
    envelope.ciphertext,
  );
}

export function verifyChangeSignature(
  envelope: PendingChangeEnvelope,
  signingPublicKey: string,
): void {
  const { signature, ...unsigned } = envelope;
  verifyEd25519(signature, changeSignaturePayload(unsigned), signingPublicKey);
}

export function assetUploadAuthorizationPayload(
  request: Omit<BeginAssetUpload, "uploadSignature">,
): Buffer {
  return canonical("canvink/asset-upload-authorization/v1", [
    ["protocolVersion", integer(request.protocolVersion)],
    ["notebookId", text(request.notebookId)],
    ["deviceId", text(request.deviceId)],
    ["encryptedHash", bytes(request.encryptedHash)],
    ["encryptedSize", integer(request.encryptedSize)],
  ]);
}

export function verifyAssetUploadAuthorization(
  request: BeginAssetUpload,
  signingPublicKey: string,
): void {
  const { uploadSignature, ...unsigned } = request;
  verifyEd25519(
    uploadSignature,
    assetUploadAuthorizationPayload(unsigned),
    signingPublicKey,
  );
}

export function keyEnvelopeSignaturePayload(
  envelope: Omit<NotebookKeyEnvelope, "signature" | "envelopeHash">,
): Buffer {
  const aadFields: Array<readonly [string, Uint8Array]> = [
    ["protocolVersion", integer(envelope.protocolVersion)],
    ["notebookId", text(envelope.notebookId)],
    ["keyEpoch", integer(envelope.keyEpoch)],
    ["senderDeviceId", text(envelope.senderDeviceId)],
    ["recipientKind", text(envelope.recipient.kind)],
    ["recipientId", text(envelope.recipient.id)],
    ["senderEncryptionPublicKey", bytes(envelope.senderEncryptionPublicKey)],
    [
      "recipientEncryptionPublicKey",
      bytes(envelope.recipientEncryptionPublicKey),
    ],
  ];
  if (envelope.recoverySigningPublicKey !== undefined) {
    aadFields.push([
      "recoverySigningPublicKey",
      bytes(envelope.recoverySigningPublicKey),
    ]);
  }
  const aad = canonical("canvink/notebook-key-envelope-aad/v1", aadFields);
  return signaturePayload(
    "canvink/notebook-key-envelope-signature/v1",
    aad,
    envelope.nonce,
    envelope.ciphertext,
  );
}

export function verifyKeyEnvelopeSignature(
  envelope: NotebookKeyEnvelope,
  signingPublicKey: string,
): void {
  verifyEd25519(
    envelope.signature,
    keyEnvelopeSignaturePayload({
      protocolVersion: envelope.protocolVersion,
      notebookId: envelope.notebookId,
      keyEpoch: envelope.keyEpoch,
      senderDeviceId: envelope.senderDeviceId,
      recipient: envelope.recipient,
      senderEncryptionPublicKey: envelope.senderEncryptionPublicKey,
      recipientEncryptionPublicKey: envelope.recipientEncryptionPublicKey,
      ...(envelope.recoverySigningPublicKey === undefined
        ? {}
        : { recoverySigningPublicKey: envelope.recoverySigningPublicKey }),
      nonce: envelope.nonce,
      ciphertext: envelope.ciphertext,
    }),
    signingPublicKey,
  );
}

export function recoveryApprovalProofPayload(
  recoveryKeyId: string,
  challengeHash: string,
): Buffer {
  return canonical("canvink/recovery-device-activation-proof/v1", [
    ["protocolVersion", integer(1)],
    ["recoveryKeyId", text(recoveryKeyId)],
    ["challengeHash", bytes(challengeHash)],
  ]);
}

export function verifyRecoveryApprovalProof(
  challenge: DeviceApprovalChallenge,
  proof: RecoveryDeviceApprovalProof,
  recoverySigningPublicKey: string,
): void {
  const expected = approvalChallengeHash(challenge);
  const supplied = bytes(proof.challengeHash);
  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  ) {
    throw new ApiError(
      400,
      "invalid_approval",
      "Approval challenge hash does not match.",
    );
  }
  verifyEd25519(
    proof.signature,
    recoveryApprovalProofPayload(proof.recoveryKeyId, proof.challengeHash),
    recoverySigningPublicKey,
  );
}

export function approvalChallengePayload(
  challenge: DeviceApprovalChallenge,
): Buffer {
  return canonical("canvink/device-approval-challenge/v1", [
    ["protocolVersion", integer(challenge.protocolVersion)],
    ["notebookId", text(challenge.notebookId)],
    ["accountId", text(challenge.accountId)],
    ["requestingDeviceId", text(challenge.requestingDeviceId)],
    [
      "requestingEncryptionPublicKey",
      bytes(challenge.requestingEncryptionPublicKey),
    ],
    ["requestingSigningPublicKey", bytes(challenge.requestingSigningPublicKey)],
    ["nonce", bytes(challenge.nonce)],
    ["issuedAt", integer(challenge.issuedAt)],
    ["expiresAt", integer(challenge.expiresAt)],
  ]);
}

export function approvalChallengeHash(
  challenge: DeviceApprovalChallenge,
): Buffer {
  return createHash("sha256")
    .update(approvalChallengePayload(challenge))
    .digest();
}

export function approvalProofPayload(
  approverDeviceId: string,
  challengeHash: string,
): Buffer {
  return canonical("canvink/device-approval-proof/v1", [
    ["protocolVersion", integer(1)],
    ["approverDeviceId", text(approverDeviceId)],
    ["challengeHash", bytes(challengeHash)],
  ]);
}

export function verifyApprovalProof(
  challenge: DeviceApprovalChallenge,
  proof: DeviceApprovalProof,
  approverSigningPublicKey: string,
): void {
  const expected = approvalChallengeHash(challenge);
  const supplied = bytes(proof.challengeHash);
  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  ) {
    throw new ApiError(
      400,
      "invalid_approval",
      "Approval challenge hash does not match.",
    );
  }
  verifyEd25519(
    proof.signature,
    approvalProofPayload(proof.approverDeviceId, proof.challengeHash),
    approverSigningPublicKey,
  );
}
