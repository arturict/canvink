import {
  SYNC_PROTOCOL_VERSION,
  type CatchUpPage,
  type DevicePublicIdentity,
  type DocumentHeads,
  type HeadsAcknowledgement,
  type KeyEnvelopeRecipient,
  type NotebookKeyEnvelope,
  type OutboxAcknowledgement,
  type PendingSyncEnvelope,
  type SequenceCursor,
  type SyncEnvelope,
} from './types';

const MAX_ID_BYTES = 256;
const HASH_BYTES = 32;
const NONCE_BYTES = 24;
const PUBLIC_KEY_BYTES = 32;
const SIGNATURE_BYTES = 64;
const MAX_CIPHERTEXT_BYTES = 16 * 1024 * 1024 + 16;
const MAX_DOCUMENTS_PER_ACK = 100_000;
const MAX_HEADS_PER_DOCUMENT = 10_000;
const MAX_CATCH_UP_PAGE_SIZE = 10_000;

type JsonRecord = Record<string, unknown>;

export class SyncProtocolValidationError extends Error {
  constructor(message: string) {
    super(`Invalid sync protocol value: ${message}`);
    this.name = 'SyncProtocolValidationError';
  }
}

function invalid(message: string): never {
  throw new SyncProtocolValidationError(message);
}

function record(value: unknown, path: string): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalid(`${path} must be an object`);
  }
  return value as JsonRecord;
}

function exactKeys(value: JsonRecord, path: string, expected: readonly string[]): void {
  const expectedSet = new Set(expected);
  for (const key of Object.keys(value)) {
    if (!expectedSet.has(key)) invalid(`${path}.${key} is not allowed`);
  }
  for (const key of expected) {
    if (!Object.hasOwn(value, key)) invalid(`${path}.${key} is required`);
  }
}

function protocolVersion(value: unknown, path: string): typeof SYNC_PROTOCOL_VERSION {
  if (value !== SYNC_PROTOCOL_VERSION) {
    invalid(`${path} must be ${SYNC_PROTOCOL_VERSION}`);
  }
  return SYNC_PROTOCOL_VERSION;
}

function boundedInteger(value: unknown, path: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    invalid(`${path} must be a safe integer greater than or equal to ${minimum}`);
  }
  return value as number;
}

function opaqueId(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    invalid(`${path} must be a non-empty opaque identifier`);
  }
  if (new TextEncoder().encode(value).byteLength > MAX_ID_BYTES) {
    invalid(`${path} exceeds ${MAX_ID_BYTES} UTF-8 bytes`);
  }
  return value;
}

export function parseOpaqueId(value: unknown, path = 'identifier'): string {
  return opaqueId(value, path);
}

function opaqueBytes(
  value: unknown,
  path: string,
  maximum: number,
): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength === 0) {
    invalid(`${path} must be a non-empty Uint8Array`);
  }
  if (value.byteLength > maximum) invalid(`${path} exceeds ${maximum} bytes`);
  return value.slice();
}

function exactOpaqueBytes(value: unknown, path: string, length: number): Uint8Array {
  const bytes = opaqueBytes(value, path, length);
  if (bytes.byteLength !== length) invalid(`${path} must be exactly ${length} bytes`);
  return bytes;
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') invalid(`${path} must be a boolean`);
  return value;
}

function parseEncryptedFields(value: JsonRecord, path: string) {
  return {
    protocolVersion: protocolVersion(value.protocolVersion, `${path}.protocolVersion`),
    notebookId: opaqueId(value.notebookId, `${path}.notebookId`),
    documentId: opaqueId(value.documentId, `${path}.documentId`),
    deviceId: opaqueId(value.deviceId, `${path}.deviceId`),
    keyEpoch: boundedInteger(value.keyEpoch, `${path}.keyEpoch`, 1),
    changeHash: exactOpaqueBytes(value.changeHash, `${path}.changeHash`, HASH_BYTES),
    nonce: exactOpaqueBytes(value.nonce, `${path}.nonce`, NONCE_BYTES),
    ciphertext: opaqueBytes(
      value.ciphertext,
      `${path}.ciphertext`,
      MAX_CIPHERTEXT_BYTES,
    ),
    signature: exactOpaqueBytes(
      value.signature,
      `${path}.signature`,
      SIGNATURE_BYTES,
    ),
  };
}

const ENCRYPTED_FIELDS = [
  'protocolVersion',
  'notebookId',
  'documentId',
  'deviceId',
  'keyEpoch',
  'changeHash',
  'nonce',
  'ciphertext',
  'signature',
] as const;

export function parseSyncEnvelope(value: unknown): SyncEnvelope {
  const envelope = record(value, 'envelope');
  exactKeys(envelope, 'envelope', [...ENCRYPTED_FIELDS, 'sequence']);
  return {
    ...parseEncryptedFields(envelope, 'envelope'),
    sequence: boundedInteger(envelope.sequence, 'envelope.sequence', 1),
  };
}

export function parsePendingSyncEnvelope(value: unknown): PendingSyncEnvelope {
  const envelope = record(value, 'envelope');
  exactKeys(envelope, 'envelope', [...ENCRYPTED_FIELDS, 'sequence']);
  if (envelope.sequence !== null) invalid('envelope.sequence must be null');
  return {
    ...parseEncryptedFields(envelope, 'envelope'),
    sequence: null,
  };
}

export function parseSequenceCursor(value: unknown): SequenceCursor {
  const cursor = record(value, 'cursor');
  exactKeys(cursor, 'cursor', ['notebookId', 'contiguousSequence']);
  return {
    notebookId: opaqueId(cursor.notebookId, 'cursor.notebookId'),
    contiguousSequence: boundedInteger(
      cursor.contiguousSequence,
      'cursor.contiguousSequence',
      0,
    ),
  };
}

export function parseDevicePublicIdentity(value: unknown): DevicePublicIdentity {
  const device = record(value, 'device');
  exactKeys(device, 'device', [
    'protocolVersion',
    'accountId',
    'deviceId',
    'encryptionPublicKey',
    'signingPublicKey',
  ]);
  return {
    protocolVersion: protocolVersion(device.protocolVersion, 'device.protocolVersion'),
    accountId: opaqueId(device.accountId, 'device.accountId'),
    deviceId: opaqueId(device.deviceId, 'device.deviceId'),
    encryptionPublicKey: exactOpaqueBytes(
      device.encryptionPublicKey,
      'device.encryptionPublicKey',
      PUBLIC_KEY_BYTES,
    ),
    signingPublicKey: exactOpaqueBytes(
      device.signingPublicKey,
      'device.signingPublicKey',
      PUBLIC_KEY_BYTES,
    ),
  };
}

function parseRecipient(value: unknown): KeyEnvelopeRecipient {
  const recipient = record(value, 'keyEnvelope.recipient');
  const kind = recipient.kind;
  if (kind === 'device') {
    exactKeys(recipient, 'keyEnvelope.recipient', ['kind', 'deviceId']);
    return { kind, deviceId: opaqueId(recipient.deviceId, 'keyEnvelope.recipient.deviceId') };
  }
  if (kind === 'account') {
    exactKeys(recipient, 'keyEnvelope.recipient', ['kind', 'accountId']);
    return { kind, accountId: opaqueId(recipient.accountId, 'keyEnvelope.recipient.accountId') };
  }
  if (kind === 'recovery') {
    exactKeys(recipient, 'keyEnvelope.recipient', ['kind', 'recoveryKeyId']);
    return {
      kind,
      recoveryKeyId: opaqueId(
        recipient.recoveryKeyId,
        'keyEnvelope.recipient.recoveryKeyId',
      ),
    };
  }
  invalid('keyEnvelope.recipient.kind is unsupported');
}

export function parseNotebookKeyEnvelope(value: unknown): NotebookKeyEnvelope {
  const envelope = record(value, 'keyEnvelope');
  const recipient = parseRecipient(envelope.recipient);
  exactKeys(envelope, 'keyEnvelope', [
    'protocolVersion',
    'notebookId',
    'keyEpoch',
    'senderDeviceId',
    'recipient',
    'senderEncryptionPublicKey',
    'recipientEncryptionPublicKey',
    ...(recipient.kind === 'recovery' ? ['recoverySigningPublicKey'] : []),
    'nonce',
    'ciphertext',
    'signature',
  ]);
  return {
    protocolVersion: protocolVersion(
      envelope.protocolVersion,
      'keyEnvelope.protocolVersion',
    ),
    notebookId: opaqueId(envelope.notebookId, 'keyEnvelope.notebookId'),
    keyEpoch: boundedInteger(envelope.keyEpoch, 'keyEnvelope.keyEpoch', 1),
    senderDeviceId: opaqueId(
      envelope.senderDeviceId,
      'keyEnvelope.senderDeviceId',
    ),
    recipient,
    senderEncryptionPublicKey: exactOpaqueBytes(
      envelope.senderEncryptionPublicKey,
      'keyEnvelope.senderEncryptionPublicKey',
      PUBLIC_KEY_BYTES,
    ),
    recipientEncryptionPublicKey: exactOpaqueBytes(
      envelope.recipientEncryptionPublicKey,
      'keyEnvelope.recipientEncryptionPublicKey',
      PUBLIC_KEY_BYTES,
    ),
    ...(recipient.kind === 'recovery'
      ? {
          recoverySigningPublicKey: exactOpaqueBytes(
            envelope.recoverySigningPublicKey,
            'keyEnvelope.recoverySigningPublicKey',
            PUBLIC_KEY_BYTES,
          ),
        }
      : {}),
    nonce: exactOpaqueBytes(envelope.nonce, 'keyEnvelope.nonce', NONCE_BYTES),
    ciphertext: opaqueBytes(
      envelope.ciphertext,
      'keyEnvelope.ciphertext',
      MAX_CIPHERTEXT_BYTES,
    ),
    signature: exactOpaqueBytes(
      envelope.signature,
      'keyEnvelope.signature',
      SIGNATURE_BYTES,
    ),
  };
}

function parseDocumentHeads(value: unknown, path: string): DocumentHeads {
  const document = record(value, path);
  exactKeys(document, path, ['documentId', 'heads']);
  if (!Array.isArray(document.heads) || document.heads.length > MAX_HEADS_PER_DOCUMENT) {
    invalid(`${path}.heads must be a bounded array`);
  }
  const heads = document.heads.map((head, index) =>
    opaqueBytes(head, `${path}.heads[${index}]`, 128),
  );
  const uniqueHeads = new Set(heads.map(bytesToHex));
  if (uniqueHeads.size !== heads.length) invalid(`${path}.heads contains duplicates`);
  return { documentId: opaqueId(document.documentId, `${path}.documentId`), heads };
}

export function parseHeadsAcknowledgement(value: unknown): HeadsAcknowledgement {
  const acknowledgement = record(value, 'headsAcknowledgement');
  exactKeys(acknowledgement, 'headsAcknowledgement', [
    'protocolVersion',
    'notebookId',
    'deviceId',
    'sequence',
    'documents',
  ]);
  if (
    !Array.isArray(acknowledgement.documents) ||
    acknowledgement.documents.length > MAX_DOCUMENTS_PER_ACK
  ) {
    invalid('headsAcknowledgement.documents must be a bounded array');
  }
  const documents = acknowledgement.documents.map((document, index) =>
    parseDocumentHeads(document, `headsAcknowledgement.documents[${index}]`),
  );
  const documentIds = new Set(documents.map((document) => document.documentId));
  if (documentIds.size !== documents.length) {
    invalid('headsAcknowledgement.documents contains duplicate document IDs');
  }
  return {
    protocolVersion: protocolVersion(
      acknowledgement.protocolVersion,
      'headsAcknowledgement.protocolVersion',
    ),
    notebookId: opaqueId(
      acknowledgement.notebookId,
      'headsAcknowledgement.notebookId',
    ),
    deviceId: opaqueId(acknowledgement.deviceId, 'headsAcknowledgement.deviceId'),
    sequence: boundedInteger(
      acknowledgement.sequence,
      'headsAcknowledgement.sequence',
      0,
    ),
    documents,
  };
}

export function parseOutboxAcknowledgement(value: unknown): OutboxAcknowledgement {
  const acknowledgement = record(value, 'outboxAcknowledgement');
  exactKeys(acknowledgement, 'outboxAcknowledgement', ['operationId', 'envelope']);
  return {
    operationId: opaqueId(
      acknowledgement.operationId,
      'outboxAcknowledgement.operationId',
    ),
    envelope: parseSyncEnvelope(acknowledgement.envelope),
  };
}

export function parseCatchUpPage(value: unknown): CatchUpPage {
  const page = record(value, 'catchUpPage');
  exactKeys(page, 'catchUpPage', [
    'notebookId',
    'afterSequence',
    'snapshotSequence',
    'hasMore',
    'envelopes',
  ]);
  const notebookId = opaqueId(page.notebookId, 'catchUpPage.notebookId');
  const afterSequence = boundedInteger(
    page.afterSequence,
    'catchUpPage.afterSequence',
    0,
  );
  const snapshotSequence = boundedInteger(
    page.snapshotSequence,
    'catchUpPage.snapshotSequence',
    afterSequence,
  );
  const hasMore = booleanValue(page.hasMore, 'catchUpPage.hasMore');
  if (!Array.isArray(page.envelopes) || page.envelopes.length > MAX_CATCH_UP_PAGE_SIZE) {
    invalid('catchUpPage.envelopes must be a bounded array');
  }
  const envelopes = page.envelopes.map(parseSyncEnvelope);
  let expectedSequence = afterSequence + 1;
  for (const envelope of envelopes) {
    if (envelope.notebookId !== notebookId) {
      invalid('catchUpPage contains an envelope for another notebook');
    }
    if (envelope.sequence !== expectedSequence) {
      invalid('catchUpPage envelopes must be contiguous and ascending');
    }
    if (envelope.sequence > snapshotSequence) {
      invalid('catchUpPage envelope exceeds its snapshot sequence');
    }
    expectedSequence += 1;
  }
  const lastSequence = expectedSequence - 1;
  if (hasMore) {
    if (envelopes.length === 0 || lastSequence >= snapshotSequence) {
      invalid('catchUpPage.hasMore requires a non-final page with progress');
    }
  } else if (lastSequence !== snapshotSequence) {
    invalid('a final catchUpPage must end at its snapshot sequence');
  }
  return { notebookId, afterSequence, snapshotSequence, hasMore, envelopes };
}

export function bytesToHex(bytes: Uint8Array): string {
  let result = '';
  for (const byte of bytes) result += byte.toString(16).padStart(2, '0');
  return result;
}

export function opaqueBytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}
