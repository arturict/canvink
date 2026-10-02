import type {
  DevicePublicIdentity,
  KeyEnvelopeRecipient,
  NotebookKeyEnvelope,
  PendingSyncEnvelope,
  SyncEnvelope,
} from '../types';

export const CRYPTO_PROTOCOL_VERSION = 1 as const;
export const X25519_KEY_BYTES = 32;
export const ED25519_PUBLIC_KEY_BYTES = 32;
export const ED25519_PRIVATE_KEY_BYTES = 64;
export const ED25519_SIGNATURE_BYTES = 64;
export const NOTEBOOK_KEY_BYTES = 32;
export const XCHACHA_NONCE_BYTES = 24;
export const AEAD_TAG_BYTES = 16;
export const SHA256_BYTES = 32;
export const MAX_CHANGE_PLAINTEXT_BYTES = 16 * 1024 * 1024;
export const MAX_ASSET_PLAINTEXT_BYTES = 64 * 1024 * 1024;

export type CryptoFailureCode =
  | 'not-ready'
  | 'invalid-input'
  | 'limit-exceeded'
  | 'signature-invalid'
  | 'authentication-failed'
  | 'hash-mismatch'
  | 'wrong-device'
  | 'wrong-recipient'
  | 'wrong-epoch'
  | 'key-unavailable'
  | 'recovery-code-invalid'
  | 'recovery-code-consumed'
  | 'approval-invalid'
  | 'destroyed-secret';

export class CryptoProtocolError extends Error {
  constructor(
    public readonly code: CryptoFailureCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'CryptoProtocolError';
  }
}

export interface DeviceSecretIdentity {
  publicIdentity: DevicePublicIdentity;
  encryptionPrivateKey: Uint8Array;
  signingPrivateKey: Uint8Array;
  destroyed: boolean;
  toJSON(): DevicePublicIdentity;
}

export interface NotebookEpochKey {
  notebookId: string;
  epoch: number;
  key: Uint8Array;
}

export interface EncryptedAssetEnvelope {
  protocolVersion: typeof CRYPTO_PROTOCOL_VERSION;
  notebookId: string;
  assetId: string;
  mimeType: string;
  uploaderDeviceId: string;
  keyEpoch: number;
  plaintextSize: number;
  plaintextHash: Uint8Array;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  signature: Uint8Array;
}

export interface RecoveryPublicIdentity {
  kind: 'recovery';
  recoveryKeyId: string;
  encryptionPublicKey: Uint8Array;
  signingPublicKey: Uint8Array;
}

export interface RecoverySecretIdentity extends RecoveryPublicIdentity {
  encryptionPrivateKey: Uint8Array;
  signingPrivateKey: Uint8Array;
  destroyed: boolean;
  toJSON(): RecoveryPublicIdentity;
}

export type NotebookKeyRecipientInput =
  | { kind: 'device'; identity: DevicePublicIdentity }
  | { kind: 'account'; identity: DevicePublicIdentity }
  | { kind: 'recovery'; identity: RecoveryPublicIdentity };

export type NotebookKeyRecipientSecret = DeviceSecretIdentity | RecoverySecretIdentity;

export interface RecoveryKit {
  recipient: RecoveryPublicIdentity;
  reveal(): string;
  destroy(): void;
  toJSON(): RecoveryPublicIdentity;
}

export interface DeviceApprovalChallenge {
  protocolVersion: typeof CRYPTO_PROTOCOL_VERSION;
  notebookId: string;
  accountId: string;
  requestingDeviceId: string;
  requestingEncryptionPublicKey: Uint8Array;
  requestingSigningPublicKey: Uint8Array;
  nonce: Uint8Array;
  issuedAt: number;
  expiresAt: number;
}

export interface DeviceApprovalProof {
  protocolVersion: typeof CRYPTO_PROTOCOL_VERSION;
  approverDeviceId: string;
  challengeHash: Uint8Array;
  signature: Uint8Array;
}

export interface RecoveryDeviceActivationProof {
  protocolVersion: typeof CRYPTO_PROTOCOL_VERSION;
  recoveryKeyId: string;
  challengeHash: Uint8Array;
  signature: Uint8Array;
}

export interface ChangeEncryptionInput {
  notebookId: string;
  documentId: string;
  plaintext: Uint8Array;
  notebookKey: NotebookEpochKey;
  sender: DeviceSecretIdentity;
  nonce?: Uint8Array;
}

export interface ChangeDecryptionInput {
  envelope: PendingSyncEnvelope | SyncEnvelope;
  notebookKey: NotebookEpochKey;
  sender: DevicePublicIdentity;
}

export interface AssetEncryptionInput {
  notebookId: string;
  assetId?: string;
  mimeType: string;
  plaintext: Uint8Array;
  notebookKey: NotebookEpochKey;
  sender: DeviceSecretIdentity;
  nonce?: Uint8Array;
}

export interface AssetDecryptionInput {
  envelope: EncryptedAssetEnvelope;
  notebookKey: NotebookEpochKey;
  sender: DevicePublicIdentity;
}

export interface NotebookKeyEnvelopeInput {
  notebookKey: NotebookEpochKey;
  sender: DeviceSecretIdentity;
  recipient: NotebookKeyRecipientInput;
  nonce?: Uint8Array;
}

export interface NotebookKeyEnvelopeOpenInput {
  envelope: NotebookKeyEnvelope;
  sender: DevicePublicIdentity;
  recipient: NotebookKeyRecipientSecret;
}

export function recipientMetadata(input: NotebookKeyRecipientInput): {
  recipient: KeyEnvelopeRecipient;
  encryptionPublicKey: Uint8Array;
} {
  if (input.kind === 'device') {
    return {
      recipient: { kind: 'device', deviceId: input.identity.deviceId },
      encryptionPublicKey: input.identity.encryptionPublicKey,
    };
  }
  if (input.kind === 'account') {
    return {
      recipient: { kind: 'account', accountId: input.identity.accountId },
      encryptionPublicKey: input.identity.encryptionPublicKey,
    };
  }
  return {
    recipient: { kind: 'recovery', recoveryKeyId: input.identity.recoveryKeyId },
    encryptionPublicKey: input.identity.encryptionPublicKey,
  };
}
