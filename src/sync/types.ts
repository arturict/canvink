export const SYNC_PROTOCOL_VERSION = 1 as const;

export type OpaqueBytes = Uint8Array;

export interface EncryptedChangePayload {
  protocolVersion: typeof SYNC_PROTOCOL_VERSION;
  notebookId: string;
  documentId: string;
  deviceId: string;
  keyEpoch: number;
  changeHash: OpaqueBytes;
  nonce: OpaqueBytes;
  ciphertext: OpaqueBytes;
  signature: OpaqueBytes;
}

/** A server-committed encrypted change with a notebook-global sequence. */
export interface SyncEnvelope extends EncryptedChangePayload {
  sequence: number;
}

/** A locally durable change which has not received a server sequence yet. */
export interface PendingSyncEnvelope extends EncryptedChangePayload {
  sequence: null;
}

export interface DevicePublicIdentity {
  protocolVersion: typeof SYNC_PROTOCOL_VERSION;
  accountId: string;
  deviceId: string;
  encryptionPublicKey: OpaqueBytes;
  signingPublicKey: OpaqueBytes;
}

export type KeyEnvelopeRecipient =
  | { kind: 'device'; deviceId: string }
  | { kind: 'account'; accountId: string }
  | { kind: 'recovery'; recoveryKeyId: string };

/** An opaque wrapped notebook key. This type does not perform key wrapping. */
export interface NotebookKeyEnvelope {
  protocolVersion: typeof SYNC_PROTOCOL_VERSION;
  notebookId: string;
  keyEpoch: number;
  senderDeviceId: string;
  recipient: KeyEnvelopeRecipient;
  senderEncryptionPublicKey: OpaqueBytes;
  recipientEncryptionPublicKey: OpaqueBytes;
  /** Required only for recovery recipients; authorizes server-side recovery activation. */
  recoverySigningPublicKey?: OpaqueBytes;
  nonce: OpaqueBytes;
  ciphertext: OpaqueBytes;
  signature: OpaqueBytes;
}

export interface DocumentHeads {
  documentId: string;
  heads: readonly OpaqueBytes[];
}

export interface HeadsAcknowledgement {
  protocolVersion: typeof SYNC_PROTOCOL_VERSION;
  notebookId: string;
  deviceId: string;
  sequence: number;
  documents: readonly DocumentHeads[];
}

export interface SequenceCursor {
  notebookId: string;
  contiguousSequence: number;
}

export interface AppliedChangeReceipt {
  sequence: number;
  changeHashHex: string;
}

export interface InboundSyncState extends SequenceCursor {
  /** Envelopes not yet committed as applied, kept in ascending sequence order. */
  buffered: readonly SyncEnvelope[];
  /** Exact sequence/hash receipts for changes already committed locally. */
  applied: readonly AppliedChangeReceipt[];
}

export type InboundRejectionReason =
  | 'wrong-notebook'
  | 'duplicate'
  | 'replay'
  | 'sequence-conflict'
  | 'buffer-full';

export type InboundIngestResult =
  | {
      accepted: true;
      state: InboundSyncState;
      ready: readonly SyncEnvelope[];
    }
  | {
      accepted: false;
      state: InboundSyncState;
      reason: InboundRejectionReason;
    };

export interface OutboxEntry {
  operationId: string;
  localOrder: number;
  envelope: PendingSyncEnvelope;
}

export interface OutboxReceipt {
  operationId: string;
  /** Retained in full so a later acknowledgement can be compared byte-for-byte. */
  envelope: SyncEnvelope;
}

export interface OutboxState {
  nextLocalOrder: number;
  pending: readonly OutboxEntry[];
  acknowledged: readonly OutboxReceipt[];
}

/** The server response used to remove exactly one matching outbox operation. */
export interface OutboxAcknowledgement {
  operationId: string;
  envelope: SyncEnvelope;
}

export interface CatchUpPage {
  notebookId: string;
  afterSequence: number;
  snapshotSequence: number;
  hasMore: boolean;
  envelopes: readonly SyncEnvelope[];
}

export type CatchUpState =
  | {
      status: 'idle' | 'caught-up';
      notebookId: string;
      requestedAfterSequence: null;
      pageLastSequence: null;
      snapshotSequence: number | null;
      pageHasMore: null;
    }
  | {
      status: 'requesting';
      notebookId: string;
      requestedAfterSequence: number;
      pageLastSequence: null;
      snapshotSequence: number | null;
      pageHasMore: null;
    }
  | {
      status: 'applying';
      notebookId: string;
      requestedAfterSequence: number;
      pageLastSequence: number;
      snapshotSequence: number;
      pageHasMore: boolean;
    };
