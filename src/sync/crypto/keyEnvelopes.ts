import type { DevicePublicIdentity, KeyEnvelopeRecipient, NotebookKeyEnvelope } from '../types';
import { parseDevicePublicIdentity, parseNotebookKeyEnvelope } from '../validation';
import { canonicalEncode, canonicalInteger, canonicalText, recipientFields } from './encoding';
import {
  AEAD_TAG_BYTES,
  CryptoProtocolError,
  ED25519_PRIVATE_KEY_BYTES,
  ED25519_PUBLIC_KEY_BYTES,
  ED25519_SIGNATURE_BYTES,
  NOTEBOOK_KEY_BYTES,
  type NotebookKeyEnvelopeInput,
  type NotebookKeyEnvelopeOpenInput,
  type NotebookKeyRecipientSecret,
  type RecoverySecretIdentity,
  X25519_KEY_BYTES,
  XCHACHA_NONCE_BYTES,
  recipientMetadata,
} from './types';
import {
  assertEpoch,
  assertExactBytes,
  assertId,
  constantTimeEqual,
  decryptAead,
  encryptAead,
  randomBytes,
  readySodium,
  signDetached,
  sodiumWipe,
  verifyDetached,
} from './sodium';

const WRAPPED_NOTEBOOK_KEY_BYTES = NOTEBOOK_KEY_BYTES + AEAD_TAG_BYTES;

function recipientIdentifier(recipient: KeyEnvelopeRecipient): string {
  if (recipient.kind === 'device') return recipient.deviceId;
  if (recipient.kind === 'account') return recipient.accountId;
  return recipient.recoveryKeyId;
}

function envelopeAad(value: {
  protocolVersion: number;
  notebookId: string;
  keyEpoch: number;
  senderDeviceId: string;
  recipient: KeyEnvelopeRecipient;
  senderEncryptionPublicKey: Uint8Array;
  recipientEncryptionPublicKey: Uint8Array;
  recoverySigningPublicKey?: Uint8Array;
}): Uint8Array {
  return canonicalEncode('canvink/notebook-key-envelope-aad/v1', [
    ['protocolVersion', canonicalInteger(value.protocolVersion)],
    ['notebookId', canonicalText(value.notebookId)],
    ['keyEpoch', canonicalInteger(value.keyEpoch)],
    ['senderDeviceId', canonicalText(value.senderDeviceId)],
    ...recipientFields(value.recipient),
    ['senderEncryptionPublicKey', value.senderEncryptionPublicKey],
    ['recipientEncryptionPublicKey', value.recipientEncryptionPublicKey],
    ...(value.recoverySigningPublicKey
      ? [['recoverySigningPublicKey', value.recoverySigningPublicKey] as const]
      : []),
  ]);
}

function envelopeSignatureBytes(
  aad: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
): Uint8Array {
  return canonicalEncode('canvink/notebook-key-envelope-signature/v1', [
    ['aad', aad],
    ['nonce', nonce],
    ['ciphertext', ciphertext],
  ]);
}

async function deriveWrappingKey(
  privateKey: Uint8Array,
  publicKey: Uint8Array,
  aad: Uint8Array,
): Promise<{ sharedSecret: Uint8Array; wrappingKey: Uint8Array }> {
  const crypto = await readySodium();
  let sharedSecret: Uint8Array;
  try {
    sharedSecret = crypto.crypto_scalarmult(privateKey, publicKey);
  } catch (error) {
    throw new CryptoProtocolError('wrong-recipient', 'X25519 key agreement failed.', {
      cause: error,
    });
  }
  return {
    sharedSecret,
    wrappingKey: crypto.crypto_generichash(NOTEBOOK_KEY_BYTES, aad, sharedSecret),
  };
}

function assertSenderSecret(input: NotebookKeyEnvelopeInput['sender']): void {
  if (input.destroyed) {
    throw new CryptoProtocolError('destroyed-secret', 'Device identity was destroyed.');
  }
  if (input.encryptionPrivateKey.byteLength !== X25519_KEY_BYTES) {
    throw new CryptoProtocolError('invalid-input', 'Device encryption private key has an invalid size.');
  }
  if (input.signingPrivateKey.byteLength !== ED25519_PRIVATE_KEY_BYTES) {
    throw new CryptoProtocolError('invalid-input', 'Device signing private key has an invalid size.');
  }
}

function secretRecipientMetadata(secret: NotebookKeyRecipientSecret): {
  publicKey: Uint8Array;
  signingPublicKey?: Uint8Array;
  destroyed: boolean;
  matches(recipient: KeyEnvelopeRecipient): boolean;
} {
  if ('publicIdentity' in secret) {
    return {
      publicKey: secret.publicIdentity.encryptionPublicKey,
      destroyed: secret.destroyed,
      matches: (recipient) =>
        (recipient.kind === 'device' && recipient.deviceId === secret.publicIdentity.deviceId) ||
        (recipient.kind === 'account' && recipient.accountId === secret.publicIdentity.accountId),
    };
  }
  const recovery = secret as RecoverySecretIdentity;
  return {
    publicKey: recovery.encryptionPublicKey,
    signingPublicKey: recovery.signingPublicKey,
    destroyed: recovery.destroyed,
    matches: (recipient) =>
      recipient.kind === 'recovery' && recipient.recoveryKeyId === recovery.recoveryKeyId,
  };
}

export async function createNotebookKeyEnvelope(
  input: NotebookKeyEnvelopeInput,
): Promise<NotebookKeyEnvelope> {
  assertSenderSecret(input.sender);
  const sender = parseDevicePublicIdentity(input.sender.publicIdentity);
  const notebookId = assertId(input.notebookKey.notebookId, 'Notebook ID');
  const keyEpoch = assertEpoch(input.notebookKey.epoch);
  const notebookKey = assertExactBytes(input.notebookKey.key, NOTEBOOK_KEY_BYTES, 'Notebook key');
  let aad: Uint8Array | undefined;
  let sharedSecret: Uint8Array | undefined;
  let wrappingKey: Uint8Array | undefined;
  let signatureBytes: Uint8Array | undefined;
  try {
    const recipientInput = input.recipient.kind === 'recovery'
      ? {
          kind: 'recovery' as const,
          identity: {
            ...input.recipient.identity,
            recoveryKeyId: assertId(input.recipient.identity.recoveryKeyId, 'Recovery key ID'),
            encryptionPublicKey: assertExactBytes(
              input.recipient.identity.encryptionPublicKey,
              X25519_KEY_BYTES,
              'Recovery encryption public key',
            ),
            signingPublicKey: assertExactBytes(
              input.recipient.identity.signingPublicKey,
              ED25519_PUBLIC_KEY_BYTES,
              'Recovery signing public key',
            ),
          },
        }
      : { kind: input.recipient.kind, identity: parseDevicePublicIdentity(input.recipient.identity) };
    const metadata = recipientMetadata(recipientInput);
    const recipientPublicKey = assertExactBytes(
      metadata.encryptionPublicKey,
      X25519_KEY_BYTES,
      'Recipient encryption public key',
    );
    const senderPublicKey = assertExactBytes(
      sender.encryptionPublicKey,
      X25519_KEY_BYTES,
      'Sender encryption public key',
    );
    const nonce = input.nonce
      ? assertExactBytes(input.nonce, XCHACHA_NONCE_BYTES, 'Key envelope nonce')
      : await randomBytes(XCHACHA_NONCE_BYTES);
    const header = {
      protocolVersion: 1 as const,
      notebookId,
      keyEpoch,
      senderDeviceId: sender.deviceId,
      recipient: metadata.recipient,
      senderEncryptionPublicKey: senderPublicKey,
      recipientEncryptionPublicKey: recipientPublicKey,
      ...(recipientInput.kind === 'recovery'
        ? { recoverySigningPublicKey: Uint8Array.from(recipientInput.identity.signingPublicKey) }
        : {}),
    };
    aad = envelopeAad(header);
    ({ sharedSecret, wrappingKey } = await deriveWrappingKey(
      input.sender.encryptionPrivateKey,
      recipientPublicKey,
      aad,
    ));
    const ciphertext = await encryptAead(notebookKey, aad, nonce, wrappingKey);
    signatureBytes = envelopeSignatureBytes(aad, nonce, ciphertext);
    return {
      ...header,
      nonce: Uint8Array.from(nonce),
      ciphertext,
      signature: await signDetached(signatureBytes, input.sender.signingPrivateKey),
    };
  } finally {
    await sodiumWipe(
      notebookKey,
      aad,
      sharedSecret,
      wrappingKey,
      signatureBytes,
    );
  }
}

export async function openNotebookKeyEnvelope(
  input: NotebookKeyEnvelopeOpenInput,
): Promise<{ notebookId: string; epoch: number; key: Uint8Array }> {
  const envelope = parseNotebookKeyEnvelope(input.envelope);
  const sender: DevicePublicIdentity = parseDevicePublicIdentity(input.sender);
  if (sender.deviceId !== envelope.senderDeviceId) {
    throw new CryptoProtocolError('wrong-device', 'Key envelope sender does not match its identity.');
  }
  const recipient = secretRecipientMetadata(input.recipient);
  if (recipient.destroyed) {
    throw new CryptoProtocolError('destroyed-secret', 'Recipient secret was destroyed.');
  }
  if (!recipient.matches(envelope.recipient)) {
    throw new CryptoProtocolError(
      'wrong-recipient',
      `Key envelope is addressed to another ${envelope.recipient.kind} recipient.`,
    );
  }
  if (
    !(await constantTimeEqual(sender.encryptionPublicKey, envelope.senderEncryptionPublicKey)) ||
    !(await constantTimeEqual(recipient.publicKey, envelope.recipientEncryptionPublicKey))
  ) {
    throw new CryptoProtocolError('wrong-recipient', 'Key envelope public-key metadata does not match.');
  }
  if (
    envelope.recipient.kind === 'recovery' &&
    (!recipient.signingPublicKey || !envelope.recoverySigningPublicKey ||
      !(await constantTimeEqual(recipient.signingPublicKey, envelope.recoverySigningPublicKey)))
  ) {
    throw new CryptoProtocolError('wrong-recipient', 'Recovery signing public key does not match.');
  }
  const senderSigningKey = assertExactBytes(
    sender.signingPublicKey,
    ED25519_PUBLIC_KEY_BYTES,
    'Sender signing public key',
  );
  const recipientPrivateKey = assertExactBytes(
    input.recipient.encryptionPrivateKey,
    X25519_KEY_BYTES,
    'Recipient encryption private key',
  );
  const aad = envelopeAad(envelope);
  const signatureBytes = envelopeSignatureBytes(aad, envelope.nonce, envelope.ciphertext);
  let sharedSecret: Uint8Array | undefined;
  let wrappingKey: Uint8Array | undefined;
  try {
    if (envelope.ciphertext.byteLength !== WRAPPED_NOTEBOOK_KEY_BYTES) {
      throw new CryptoProtocolError('invalid-input', 'Wrapped notebook key has an invalid size.');
    }
    await verifyDetached(
      assertExactBytes(envelope.signature, ED25519_SIGNATURE_BYTES, 'Key envelope signature'),
      signatureBytes,
      senderSigningKey,
    );
    ({ sharedSecret, wrappingKey } = await deriveWrappingKey(
      recipientPrivateKey,
      envelope.senderEncryptionPublicKey,
      aad,
    ));
    const key = await decryptAead(envelope.ciphertext, aad, envelope.nonce, wrappingKey);
    if (key.byteLength !== NOTEBOOK_KEY_BYTES) {
      await sodiumWipe(key);
      throw new CryptoProtocolError('authentication-failed', 'Wrapped notebook key has an invalid plaintext size.');
    }
    return { notebookId: envelope.notebookId, epoch: envelope.keyEpoch, key };
  } finally {
    await sodiumWipe(
      senderSigningKey,
      recipientPrivateKey,
      aad,
      signatureBytes,
      sharedSecret,
      wrappingKey,
    );
  }
}

export function describeKeyEnvelopeRecipient(recipient: KeyEnvelopeRecipient): string {
  return `${recipient.kind}:${recipientIdentifier(recipient)}`;
}
