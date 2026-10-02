import type { DevicePublicIdentity } from '../types';
import { parseDevicePublicIdentity } from '../validation';
import { canonicalEncode, canonicalInteger, canonicalText } from './encoding';
import {
  CRYPTO_PROTOCOL_VERSION,
  CryptoProtocolError,
  type DeviceApprovalChallenge,
  type DeviceApprovalProof,
  type DeviceSecretIdentity,
  ED25519_PRIVATE_KEY_BYTES,
  ED25519_PUBLIC_KEY_BYTES,
  ED25519_SIGNATURE_BYTES,
  SHA256_BYTES,
  type RecoveryDeviceActivationProof,
  type RecoveryPublicIdentity,
  type RecoverySecretIdentity,
} from './types';
import {
  assertExactBytes,
  assertId,
  constantTimeEqual,
  randomBytes,
  sha256,
  signDetached,
  sodiumWipe,
  verifyDetached,
} from './sodium';

export const DEFAULT_APPROVAL_LIFETIME_MS = 5 * 60 * 1000;
export const MAX_APPROVAL_LIFETIME_MS = 10 * 60 * 1000;

function challengeBytes(challenge: DeviceApprovalChallenge): Uint8Array {
  return canonicalEncode('canvink/device-approval-challenge/v1', [
    ['protocolVersion', canonicalInteger(challenge.protocolVersion)],
    ['notebookId', canonicalText(challenge.notebookId)],
    ['accountId', canonicalText(challenge.accountId)],
    ['requestingDeviceId', canonicalText(challenge.requestingDeviceId)],
    ['requestingEncryptionPublicKey', challenge.requestingEncryptionPublicKey],
    ['requestingSigningPublicKey', challenge.requestingSigningPublicKey],
    ['nonce', challenge.nonce],
    ['issuedAt', canonicalInteger(challenge.issuedAt)],
    ['expiresAt', canonicalInteger(challenge.expiresAt)],
  ]);
}

function proofBytes(approverDeviceId: string, challengeHash: Uint8Array): Uint8Array {
  return canonicalEncode('canvink/device-approval-proof/v1', [
    ['protocolVersion', canonicalInteger(CRYPTO_PROTOCOL_VERSION)],
    ['approverDeviceId', canonicalText(approverDeviceId)],
    ['challengeHash', challengeHash],
  ]);
}

function recoveryProofBytes(recoveryKeyId: string, challengeHash: Uint8Array): Uint8Array {
  return canonicalEncode('canvink/recovery-device-activation-proof/v1', [
    ['protocolVersion', canonicalInteger(CRYPTO_PROTOCOL_VERSION)],
    ['recoveryKeyId', canonicalText(recoveryKeyId)],
    ['challengeHash', challengeHash],
  ]);
}

function validateChallenge(challenge: DeviceApprovalChallenge): DeviceApprovalChallenge {
  if (challenge.protocolVersion !== CRYPTO_PROTOCOL_VERSION) {
    throw new CryptoProtocolError('approval-invalid', 'Approval protocol version is unsupported.');
  }
  if (
    !Number.isSafeInteger(challenge.issuedAt) ||
    challenge.issuedAt < 0 ||
    !Number.isSafeInteger(challenge.expiresAt) ||
    challenge.expiresAt <= challenge.issuedAt ||
    challenge.expiresAt - challenge.issuedAt > MAX_APPROVAL_LIFETIME_MS
  ) {
    throw new CryptoProtocolError('approval-invalid', 'Approval validity window is invalid.');
  }
  return {
    protocolVersion: CRYPTO_PROTOCOL_VERSION,
    notebookId: assertId(challenge.notebookId, 'Notebook ID'),
    accountId: assertId(challenge.accountId, 'Account ID'),
    requestingDeviceId: assertId(challenge.requestingDeviceId, 'Requesting device ID'),
    requestingEncryptionPublicKey: assertExactBytes(
      challenge.requestingEncryptionPublicKey,
      32,
      'Requesting encryption public key',
    ),
    requestingSigningPublicKey: assertExactBytes(
      challenge.requestingSigningPublicKey,
      ED25519_PUBLIC_KEY_BYTES,
      'Requesting signing public key',
    ),
    nonce: assertExactBytes(challenge.nonce, SHA256_BYTES, 'Approval nonce'),
    issuedAt: challenge.issuedAt,
    expiresAt: challenge.expiresAt,
  };
}

export async function createDeviceApprovalChallenge(input: {
  notebookId: string;
  requestingDevice: DevicePublicIdentity;
  now?: number;
  lifetimeMs?: number;
  nonce?: Uint8Array;
}): Promise<DeviceApprovalChallenge> {
  const now = input.now ?? Date.now();
  const lifetime = input.lifetimeMs ?? DEFAULT_APPROVAL_LIFETIME_MS;
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    !Number.isSafeInteger(lifetime) ||
    lifetime < 1 ||
    lifetime > MAX_APPROVAL_LIFETIME_MS ||
    !Number.isSafeInteger(now + lifetime)
  ) {
    throw new CryptoProtocolError('invalid-input', 'Approval lifetime is invalid.');
  }
  const device = parseDevicePublicIdentity(input.requestingDevice);
  return {
    protocolVersion: CRYPTO_PROTOCOL_VERSION,
    notebookId: assertId(input.notebookId, 'Notebook ID'),
    accountId: device.accountId,
    requestingDeviceId: device.deviceId,
    requestingEncryptionPublicKey: Uint8Array.from(device.encryptionPublicKey),
    requestingSigningPublicKey: Uint8Array.from(device.signingPublicKey),
    nonce: input.nonce
      ? assertExactBytes(input.nonce, SHA256_BYTES, 'Approval nonce')
      : await randomBytes(SHA256_BYTES),
    issuedAt: now,
    expiresAt: now + lifetime,
  };
}

export async function hashDeviceApprovalChallenge(challengeInput: DeviceApprovalChallenge): Promise<Uint8Array> {
  const encoded = challengeBytes(validateChallenge(challengeInput));
  try { return await sha256(encoded); } finally { await sodiumWipe(encoded); }
}

export async function createRecoveryDeviceActivationProof(
  challengeInput: DeviceApprovalChallenge,
  recovery: RecoverySecretIdentity,
  now = Date.now(),
): Promise<RecoveryDeviceActivationProof> {
  const challenge = validateChallenge(challengeInput);
  if (recovery.destroyed || recovery.signingPrivateKey.byteLength !== ED25519_PRIVATE_KEY_BYTES) {
    throw new CryptoProtocolError('destroyed-secret', 'Recovery signing identity is unavailable.');
  }
  if (!Number.isSafeInteger(now) || now < challenge.issuedAt || now > challenge.expiresAt) {
    throw new CryptoProtocolError('approval-invalid', 'Recovery activation challenge is outside its validity window.');
  }
  const challengeHash = await hashDeviceApprovalChallenge(challenge);
  const encodedProof = recoveryProofBytes(assertId(recovery.recoveryKeyId, 'Recovery key ID'), challengeHash);
  try {
    return {
      protocolVersion: CRYPTO_PROTOCOL_VERSION,
      recoveryKeyId: recovery.recoveryKeyId,
      challengeHash,
      signature: await signDetached(encodedProof, recovery.signingPrivateKey),
    };
  } finally {
    await sodiumWipe(encodedProof);
  }
}

export async function verifyRecoveryDeviceActivationProof(input: {
  challenge: DeviceApprovalChallenge;
  proof: RecoveryDeviceActivationProof;
  recovery: RecoveryPublicIdentity;
  now?: number;
}): Promise<void> {
  const challenge = validateChallenge(input.challenge);
  const now = input.now ?? Date.now();
  if (!Number.isSafeInteger(now) || now < challenge.issuedAt || now > challenge.expiresAt) {
    throw new CryptoProtocolError('approval-invalid', 'Recovery activation challenge is outside its validity window.');
  }
  if (input.proof.protocolVersion !== CRYPTO_PROTOCOL_VERSION || input.proof.recoveryKeyId !== input.recovery.recoveryKeyId) {
    throw new CryptoProtocolError('approval-invalid', 'Recovery activation identity does not match.');
  }
  const suppliedHash = assertExactBytes(input.proof.challengeHash, SHA256_BYTES, 'Challenge hash');
  const expectedHash = await hashDeviceApprovalChallenge(challenge);
  const signature = assertExactBytes(input.proof.signature, ED25519_SIGNATURE_BYTES, 'Recovery signature');
  const signingPublicKey = assertExactBytes(input.recovery.signingPublicKey, ED25519_PUBLIC_KEY_BYTES, 'Recovery signing public key');
  const encodedProof = recoveryProofBytes(input.recovery.recoveryKeyId, suppliedHash);
  try {
    if (!(await constantTimeEqual(suppliedHash, expectedHash))) throw new CryptoProtocolError('approval-invalid', 'Recovery challenge hash does not match.');
    await verifyDetached(signature, encodedProof, signingPublicKey);
  } catch (error) {
    if (error instanceof CryptoProtocolError) throw error;
    throw new CryptoProtocolError('approval-invalid', 'Recovery activation signature is invalid.', { cause: error });
  } finally {
    await sodiumWipe(suppliedHash, expectedHash, signature, signingPublicKey, encodedProof);
  }
}

export async function approveDeviceChallenge(
  challengeInput: DeviceApprovalChallenge,
  approver: DeviceSecretIdentity,
  now = Date.now(),
): Promise<DeviceApprovalProof> {
  if (approver.destroyed) {
    throw new CryptoProtocolError('destroyed-secret', 'Approver device identity was destroyed.');
  }
  if (approver.signingPrivateKey.byteLength !== ED25519_PRIVATE_KEY_BYTES) {
    throw new CryptoProtocolError('invalid-input', 'Approver signing private key has an invalid size.');
  }
  const challenge = validateChallenge(challengeInput);
  const approverPublic = parseDevicePublicIdentity(approver.publicIdentity);
  if (approverPublic.accountId !== challenge.accountId) {
    throw new CryptoProtocolError('approval-invalid', 'Approver belongs to another account.');
  }
  if (!Number.isSafeInteger(now) || now < challenge.issuedAt || now > challenge.expiresAt) {
    throw new CryptoProtocolError('approval-invalid', 'Approval challenge is outside its validity window.');
  }
  const encodedChallenge = challengeBytes(challenge);
  const challengeHash = await sha256(encodedChallenge);
  const encodedProof = proofBytes(approverPublic.deviceId, challengeHash);
  try {
    return {
      protocolVersion: CRYPTO_PROTOCOL_VERSION,
      approverDeviceId: approverPublic.deviceId,
      challengeHash,
      signature: await signDetached(encodedProof, approver.signingPrivateKey),
    };
  } finally {
    await sodiumWipe(encodedChallenge, encodedProof);
  }
}

export async function verifyDeviceApprovalProof(input: {
  challenge: DeviceApprovalChallenge;
  proof: DeviceApprovalProof;
  approver: DevicePublicIdentity;
  now?: number;
}): Promise<void> {
  const challenge = validateChallenge(input.challenge);
  const approver = parseDevicePublicIdentity(input.approver);
  const now = input.now ?? Date.now();
  if (!Number.isSafeInteger(now) || now < challenge.issuedAt || now > challenge.expiresAt) {
    throw new CryptoProtocolError('approval-invalid', 'Approval challenge is outside its validity window.');
  }
  if (
    input.proof.protocolVersion !== CRYPTO_PROTOCOL_VERSION ||
    input.proof.approverDeviceId !== approver.deviceId ||
    approver.accountId !== challenge.accountId
  ) {
    throw new CryptoProtocolError('approval-invalid', 'Approval identity metadata does not match.');
  }
  const suppliedHash = assertExactBytes(input.proof.challengeHash, SHA256_BYTES, 'Challenge hash');
  const signature = assertExactBytes(
    input.proof.signature,
    ED25519_SIGNATURE_BYTES,
    'Approval signature',
  );
  const signingPublicKey = assertExactBytes(
    approver.signingPublicKey,
    ED25519_PUBLIC_KEY_BYTES,
    'Approver signing public key',
  );
  const encodedChallenge = challengeBytes(challenge);
  const expectedHash = await sha256(encodedChallenge);
  let encodedProof: Uint8Array | undefined;
  try {
    if (!(await constantTimeEqual(suppliedHash, expectedHash))) {
      throw new CryptoProtocolError('approval-invalid', 'Approval challenge hash does not match.');
    }
    encodedProof = proofBytes(approver.deviceId, suppliedHash);
    try {
      await verifyDetached(signature, encodedProof, signingPublicKey);
    } catch (error) {
      throw new CryptoProtocolError('approval-invalid', 'Approval signature is invalid.', {
        cause: error,
      });
    }
  } finally {
    await sodiumWipe(
      suppliedHash,
      signature,
      signingPublicKey,
      encodedChallenge,
      expectedHash,
      encodedProof,
    );
  }
}
