import sodium from 'libsodium-wrappers-sumo';
import { CryptoProtocolError } from './types';

const encoder = new TextEncoder();

export async function readySodium(): Promise<typeof sodium> {
  try {
    await sodium.ready;
    return sodium;
  } catch (error) {
    throw new CryptoProtocolError('not-ready', 'The cryptographic runtime could not initialize.', {
      cause: error,
    });
  }
}

export function assertId(value: string, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\0') ||
    encoder.encode(value).byteLength > 256
  ) {
    throw new CryptoProtocolError('invalid-input', `${label} is invalid.`);
  }
  return value;
}

export function assertEpoch(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new CryptoProtocolError('invalid-input', 'Key epoch must be a positive safe integer.');
  }
  return value;
}

export function assertExactBytes(
  value: Uint8Array,
  length: number,
  label: string,
): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength !== length) {
    throw new CryptoProtocolError('invalid-input', `${label} must be exactly ${length} bytes.`);
  }
  return Uint8Array.from(value);
}

export function assertBoundedBytes(
  value: Uint8Array,
  maximum: number,
  label: string,
): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new CryptoProtocolError('invalid-input', `${label} must be binary data.`);
  }
  if (value.byteLength > maximum) {
    throw new CryptoProtocolError('limit-exceeded', `${label} exceeds its byte limit.`);
  }
  return Uint8Array.from(value);
}

export async function randomBytes(length: number): Promise<Uint8Array> {
  const crypto = await readySodium();
  return crypto.randombytes_buf(length);
}

export async function sha256(value: Uint8Array): Promise<Uint8Array> {
  const crypto = await readySodium();
  return crypto.crypto_hash_sha256(value);
}

export async function constantTimeEqual(
  left: Uint8Array,
  right: Uint8Array,
): Promise<boolean> {
  if (!(left instanceof Uint8Array) || !(right instanceof Uint8Array)) return false;
  if (left.byteLength !== right.byteLength) return false;
  const crypto = await readySodium();
  return crypto.memcmp(left, right);
}

export function wipeBytes(...values: Array<Uint8Array | undefined>): void {
  for (const value of values) value?.fill(0);
}

export async function sodiumWipe(...values: Array<Uint8Array | undefined>): Promise<void> {
  const crypto = await readySodium();
  for (const value of values) if (value) crypto.memzero(value);
}

export async function encryptAead(
  plaintext: Uint8Array,
  aad: Uint8Array,
  nonce: Uint8Array,
  key: Uint8Array,
): Promise<Uint8Array> {
  const crypto = await readySodium();
  return crypto.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plaintext,
    aad,
    null,
    nonce,
    key,
  );
}

export async function decryptAead(
  ciphertext: Uint8Array,
  aad: Uint8Array,
  nonce: Uint8Array,
  key: Uint8Array,
): Promise<Uint8Array> {
  const crypto = await readySodium();
  try {
    return crypto.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      ciphertext,
      aad,
      nonce,
      key,
    );
  } catch (error) {
    throw new CryptoProtocolError(
      'authentication-failed',
      'Encrypted payload authentication failed.',
      { cause: error },
    );
  }
}

export async function signDetached(
  value: Uint8Array,
  privateKey: Uint8Array,
): Promise<Uint8Array> {
  const crypto = await readySodium();
  return crypto.crypto_sign_detached(value, privateKey);
}

export async function verifyDetached(
  signature: Uint8Array,
  value: Uint8Array,
  publicKey: Uint8Array,
): Promise<void> {
  const crypto = await readySodium();
  let valid: boolean;
  try {
    valid = crypto.crypto_sign_verify_detached(signature, value, publicKey);
  } catch {
    valid = false;
  }
  if (!valid) {
    throw new CryptoProtocolError('signature-invalid', 'Detached signature verification failed.');
  }
}
