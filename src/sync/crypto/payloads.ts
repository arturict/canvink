import { SYNC_PROTOCOL_VERSION, type PendingSyncEnvelope, type SyncEnvelope } from '../types';
import { parsePendingSyncEnvelope, parseSyncEnvelope } from '../validation';
import { canonicalEncode, canonicalInteger, canonicalText } from './encoding';
import {
  AEAD_TAG_BYTES,
  type AssetDecryptionInput,
  type AssetEncryptionInput,
  type ChangeDecryptionInput,
  type ChangeEncryptionInput,
  CryptoProtocolError,
  ED25519_PRIVATE_KEY_BYTES,
  ED25519_PUBLIC_KEY_BYTES,
  ED25519_SIGNATURE_BYTES,
  type EncryptedAssetEnvelope,
  MAX_ASSET_PLAINTEXT_BYTES,
  MAX_CHANGE_PLAINTEXT_BYTES,
  NOTEBOOK_KEY_BYTES,
  SHA256_BYTES,
  XCHACHA_NONCE_BYTES,
} from './types';
import {
  assertBoundedBytes,
  assertEpoch,
  assertExactBytes,
  assertId,
  constantTimeEqual,
  decryptAead,
  encryptAead,
  randomBytes,
  sha256,
  signDetached,
  sodiumWipe,
  verifyDetached,
} from './sodium';

function assertSecretDevice(input: ChangeEncryptionInput['sender']): void {
  if (input.destroyed) throw new CryptoProtocolError('destroyed-secret', 'Device identity was destroyed.');
  if (input.encryptionPrivateKey.byteLength !== 32) {
    throw new CryptoProtocolError('invalid-input', 'Device encryption private key must be exactly 32 bytes.');
  }
  if (input.signingPrivateKey.byteLength !== ED25519_PRIVATE_KEY_BYTES) {
    throw new CryptoProtocolError('invalid-input', 'Device signing private key must be exactly 64 bytes.');
  }
  if (input.publicIdentity.encryptionPublicKey.byteLength !== 32) {
    throw new CryptoProtocolError('invalid-input', 'Device encryption public key must be exactly 32 bytes.');
  }
  if (input.publicIdentity.signingPublicKey.byteLength !== ED25519_PUBLIC_KEY_BYTES) {
    throw new CryptoProtocolError('invalid-input', 'Device signing public key must be exactly 32 bytes.');
  }
}

function changeAad(metadata: {
  notebookId: string;
  documentId: string;
  deviceId: string;
  keyEpoch: number;
  changeHash: Uint8Array;
}): Uint8Array {
  return canonicalEncode('canvink/change-aad/v1', [
    ['protocolVersion', canonicalInteger(SYNC_PROTOCOL_VERSION)],
    ['notebookId', canonicalText(metadata.notebookId)],
    ['documentId', canonicalText(metadata.documentId)],
    ['deviceId', canonicalText(metadata.deviceId)],
    ['keyEpoch', canonicalInteger(metadata.keyEpoch)],
    ['changeHash', metadata.changeHash],
  ]);
}

function signedPayload(domain: string, aad: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  return canonicalEncode(domain, [
    ['aad', aad],
    ['nonce', nonce],
    ['ciphertext', ciphertext],
  ]);
}

export async function encryptChange(input: ChangeEncryptionInput): Promise<PendingSyncEnvelope> {
  assertSecretDevice(input.sender);
  const notebookId = assertId(input.notebookId, 'Notebook ID');
  const documentId = assertId(input.documentId, 'Document ID');
  if (input.notebookKey.notebookId !== notebookId) {
    throw new CryptoProtocolError('invalid-input', 'Notebook key belongs to another notebook.');
  }
  const keyEpoch = assertEpoch(input.notebookKey.epoch);
  const key = assertExactBytes(input.notebookKey.key, NOTEBOOK_KEY_BYTES, 'Notebook key');
  let plaintext: Uint8Array | undefined;
  let aad: Uint8Array | undefined;
  let signBytes: Uint8Array | undefined;
  try {
    plaintext = assertBoundedBytes(input.plaintext, MAX_CHANGE_PLAINTEXT_BYTES, 'Change plaintext');
    const nonce = input.nonce
      ? assertExactBytes(input.nonce, XCHACHA_NONCE_BYTES, 'Change nonce')
      : await randomBytes(XCHACHA_NONCE_BYTES);
    const changeHash = await sha256(plaintext);
    const metadata = {
      notebookId,
      documentId,
      deviceId: assertId(input.sender.publicIdentity.deviceId, 'Device ID'),
      keyEpoch,
      changeHash,
    };
    aad = changeAad(metadata);
    const ciphertext = await encryptAead(plaintext, aad, nonce, key);
    signBytes = signedPayload('canvink/change-signature/v1', aad, nonce, ciphertext);
    return {
      protocolVersion: SYNC_PROTOCOL_VERSION,
      ...metadata,
      sequence: null,
      nonce: Uint8Array.from(nonce),
      ciphertext,
      signature: await signDetached(signBytes, input.sender.signingPrivateKey),
    };
  } finally {
    await sodiumWipe(key, plaintext, aad, signBytes);
  }
}

export function assignServerSequence(
  envelope: PendingSyncEnvelope,
  sequence: number,
): SyncEnvelope {
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new CryptoProtocolError('invalid-input', 'Server sequence must be positive.');
  }
  const pending = parsePendingSyncEnvelope(envelope);
  return { ...pending, sequence };
}

export async function verifyAndDecryptChange(input: ChangeDecryptionInput): Promise<Uint8Array> {
  const envelope = input.envelope.sequence === null
    ? parsePendingSyncEnvelope(input.envelope)
    : parseSyncEnvelope(input.envelope);
  if (envelope.deviceId !== input.sender.deviceId) {
    throw new CryptoProtocolError('wrong-device', 'Change sender device does not match its identity.');
  }
  if (envelope.notebookId !== input.notebookKey.notebookId) {
    throw new CryptoProtocolError('invalid-input', 'Change belongs to another notebook.');
  }
  if (envelope.keyEpoch !== input.notebookKey.epoch) {
    throw new CryptoProtocolError('wrong-epoch', 'Change requires another notebook key epoch.');
  }
  const signingPublicKey = assertExactBytes(
    input.sender.signingPublicKey,
    ED25519_PUBLIC_KEY_BYTES,
    'Sender signing public key',
  );
  const key = assertExactBytes(input.notebookKey.key, NOTEBOOK_KEY_BYTES, 'Notebook key');
  const aad = changeAad(envelope);
  const signBytes = signedPayload(
    'canvink/change-signature/v1',
    aad,
    envelope.nonce,
    envelope.ciphertext,
  );
  try {
    await verifyDetached(
      assertExactBytes(envelope.signature, ED25519_SIGNATURE_BYTES, 'Change signature'),
      signBytes,
      signingPublicKey,
    );
    const plaintext = await decryptAead(envelope.ciphertext, aad, envelope.nonce, key);
    if (plaintext.byteLength > MAX_CHANGE_PLAINTEXT_BYTES) {
      await sodiumWipe(plaintext);
      throw new CryptoProtocolError('limit-exceeded', 'Decrypted change exceeds its byte limit.');
    }
    const actualHash = await sha256(plaintext);
    if (!(await constantTimeEqual(actualHash, envelope.changeHash))) {
      await sodiumWipe(plaintext, actualHash);
      throw new CryptoProtocolError('hash-mismatch', 'Decrypted change hash does not match metadata.');
    }
    await sodiumWipe(actualHash);
    return plaintext;
  } finally {
    await sodiumWipe(key, aad, signBytes, signingPublicKey);
  }
}

function normalizeMime(value: string): string {
  const mime = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/.test(mime)) {
    throw new CryptoProtocolError('invalid-input', 'Asset MIME type is invalid.');
  }
  return mime;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function assetAad(value: Omit<EncryptedAssetEnvelope, 'nonce' | 'ciphertext' | 'signature'>): Uint8Array {
  return canonicalEncode('canvink/asset-aad/v1', [
    ['protocolVersion', canonicalInteger(value.protocolVersion)],
    ['notebookId', canonicalText(value.notebookId)],
    ['assetId', canonicalText(value.assetId)],
    ['mimeType', canonicalText(value.mimeType)],
    ['uploaderDeviceId', canonicalText(value.uploaderDeviceId)],
    ['keyEpoch', canonicalInteger(value.keyEpoch)],
    ['plaintextSize', canonicalInteger(value.plaintextSize)],
    ['plaintextHash', value.plaintextHash],
  ]);
}

export async function encryptAsset(input: AssetEncryptionInput): Promise<EncryptedAssetEnvelope> {
  assertSecretDevice(input.sender);
  const notebookId = assertId(input.notebookId, 'Notebook ID');
  if (input.notebookKey.notebookId !== notebookId) {
    throw new CryptoProtocolError('invalid-input', 'Notebook key belongs to another notebook.');
  }
  const key = assertExactBytes(input.notebookKey.key, NOTEBOOK_KEY_BYTES, 'Notebook key');
  let plaintext: Uint8Array | undefined;
  let aad: Uint8Array | undefined;
  let signBytes: Uint8Array | undefined;
  try {
    plaintext = assertBoundedBytes(input.plaintext, MAX_ASSET_PLAINTEXT_BYTES, 'Asset plaintext');
    const plaintextHash = await sha256(plaintext);
    const expectedAssetId = `sha256:${hex(plaintextHash)}`;
    if (input.assetId !== undefined && input.assetId !== expectedAssetId) {
      throw new CryptoProtocolError('hash-mismatch', 'Asset ID does not match its plaintext hash.');
    }
    const metadata = {
      protocolVersion: 1 as const,
      notebookId,
      assetId: expectedAssetId,
      mimeType: normalizeMime(input.mimeType),
      uploaderDeviceId: assertId(input.sender.publicIdentity.deviceId, 'Device ID'),
      keyEpoch: assertEpoch(input.notebookKey.epoch),
      plaintextSize: plaintext.byteLength,
      plaintextHash,
    };
    const nonce = input.nonce
      ? assertExactBytes(input.nonce, XCHACHA_NONCE_BYTES, 'Asset nonce')
      : await randomBytes(XCHACHA_NONCE_BYTES);
    aad = assetAad(metadata);
    const ciphertext = await encryptAead(plaintext, aad, nonce, key);
    signBytes = signedPayload('canvink/asset-signature/v1', aad, nonce, ciphertext);
    return {
      ...metadata,
      nonce: Uint8Array.from(nonce),
      ciphertext,
      signature: await signDetached(signBytes, input.sender.signingPrivateKey),
    };
  } finally {
    await sodiumWipe(key, plaintext, aad, signBytes);
  }
}

export async function verifyAndDecryptAsset(input: AssetDecryptionInput): Promise<Uint8Array> {
  const envelope = input.envelope;
  if (envelope.protocolVersion !== 1) throw new CryptoProtocolError('invalid-input', 'Asset protocol version is unsupported.');
  assertId(envelope.notebookId, 'Notebook ID');
  assertId(envelope.assetId, 'Asset ID');
  normalizeMime(envelope.mimeType);
  assertId(envelope.uploaderDeviceId, 'Uploader device ID');
  if (envelope.uploaderDeviceId !== input.sender.deviceId) {
    throw new CryptoProtocolError('wrong-device', 'Asset uploader does not match its identity.');
  }
  if (envelope.notebookId !== input.notebookKey.notebookId) {
    throw new CryptoProtocolError('invalid-input', 'Asset belongs to another notebook.');
  }
  if (envelope.keyEpoch !== input.notebookKey.epoch) {
    throw new CryptoProtocolError('wrong-epoch', 'Asset requires another notebook key epoch.');
  }
  if (!Number.isSafeInteger(envelope.plaintextSize) || envelope.plaintextSize < 0 || envelope.plaintextSize > MAX_ASSET_PLAINTEXT_BYTES) {
    throw new CryptoProtocolError('limit-exceeded', 'Asset size metadata is invalid.');
  }
  const hash = assertExactBytes(envelope.plaintextHash, SHA256_BYTES, 'Asset hash');
  if (envelope.assetId !== `sha256:${hex(hash)}`) {
    throw new CryptoProtocolError('hash-mismatch', 'Asset ID does not match hash metadata.');
  }
  const nonce = assertExactBytes(envelope.nonce, XCHACHA_NONCE_BYTES, 'Asset nonce');
  const ciphertext = assertBoundedBytes(
    envelope.ciphertext,
    MAX_ASSET_PLAINTEXT_BYTES + AEAD_TAG_BYTES,
    'Asset ciphertext',
  );
  const signature = assertExactBytes(envelope.signature, ED25519_SIGNATURE_BYTES, 'Asset signature');
  const signingKey = assertExactBytes(input.sender.signingPublicKey, ED25519_PUBLIC_KEY_BYTES, 'Signing public key');
  const key = assertExactBytes(input.notebookKey.key, NOTEBOOK_KEY_BYTES, 'Notebook key');
  const aad = assetAad({ ...envelope, plaintextHash: hash });
  const signBytes = signedPayload('canvink/asset-signature/v1', aad, nonce, ciphertext);
  try {
    await verifyDetached(signature, signBytes, signingKey);
    const plaintext = await decryptAead(ciphertext, aad, nonce, key);
    if (plaintext.byteLength !== envelope.plaintextSize) {
      await sodiumWipe(plaintext);
      throw new CryptoProtocolError('hash-mismatch', 'Decrypted asset size does not match metadata.');
    }
    const actualHash = await sha256(plaintext);
    if (!(await constantTimeEqual(actualHash, hash))) {
      await sodiumWipe(plaintext, actualHash);
      throw new CryptoProtocolError('hash-mismatch', 'Decrypted asset hash does not match metadata.');
    }
    await sodiumWipe(actualHash);
    return plaintext;
  } finally {
    await sodiumWipe(hash, nonce, ciphertext, signature, signingKey, key, aad, signBytes);
  }
}
