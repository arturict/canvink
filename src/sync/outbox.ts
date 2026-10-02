import type {
  OutboxAcknowledgement,
  OutboxEntry,
  OutboxReceipt,
  OutboxState,
  PendingSyncEnvelope,
} from './types';
import {
  bytesToHex,
  opaqueBytesEqual,
  parseOpaqueId,
  parseOutboxAcknowledgement,
  parsePendingSyncEnvelope,
} from './validation';

export function createOutboxState(): OutboxState {
  return { nextLocalOrder: 1, pending: [], acknowledged: [] };
}

export function enqueueOutbox(
  state: OutboxState,
  operationId: string,
  input: unknown,
): OutboxState {
  const validatedOperationId = parseOpaqueId(operationId, 'operationId');
  const envelope = parsePendingSyncEnvelope(input);
  if (
    state.pending.some((entry) => entry.operationId === validatedOperationId) ||
    state.acknowledged.some((receipt) => receipt.operationId === validatedOperationId)
  ) {
    throw new Error(`Outbox operation ${validatedOperationId} already exists`);
  }
  const hash = bytesToHex(envelope.changeHash);
  if (
    state.pending.some((entry) => bytesToHex(entry.envelope.changeHash) === hash) ||
    state.acknowledged.some(
      (receipt) => bytesToHex(receipt.envelope.changeHash) === hash,
    )
  ) {
    throw new Error('Outbox change hash already exists');
  }
  const entry: OutboxEntry = {
    operationId: validatedOperationId,
    localOrder: state.nextLocalOrder,
    envelope,
  };
  return {
    ...state,
    nextLocalOrder: state.nextLocalOrder + 1,
    pending: [...state.pending, entry],
  };
}

export function selectOutboxBatch(
  state: OutboxState,
  limit: number,
): readonly OutboxEntry[] {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error('Outbox batch limit must be a positive safe integer');
  }
  return [...state.pending]
    .sort((left, right) => left.localOrder - right.localOrder)
    .slice(0, limit);
}

function committedEnvelopeMatches(
  pending: PendingSyncEnvelope,
  acknowledgement: OutboxAcknowledgement,
): boolean {
  const committed = acknowledgement.envelope;
  return (
    pending.protocolVersion === committed.protocolVersion &&
    pending.notebookId === committed.notebookId &&
    pending.documentId === committed.documentId &&
    pending.deviceId === committed.deviceId &&
    pending.keyEpoch === committed.keyEpoch &&
    opaqueBytesEqual(pending.changeHash, committed.changeHash) &&
    opaqueBytesEqual(pending.nonce, committed.nonce) &&
    opaqueBytesEqual(pending.ciphertext, committed.ciphertext) &&
    opaqueBytesEqual(pending.signature, committed.signature)
  );
}

/**
 * Applies acknowledgements in canonical operation-ID order, so input ordering
 * cannot alter the resulting persisted state.
 */
export function acknowledgeOutbox(
  state: OutboxState,
  inputs: readonly unknown[],
): OutboxState {
  const acknowledgements = inputs
    .map(parseOutboxAcknowledgement)
    .sort((left, right) => compareIds(left.operationId, right.operationId));
  const duplicateOperations = new Set<string>();
  for (const acknowledgement of acknowledgements) {
    if (duplicateOperations.has(acknowledgement.operationId)) {
      throw new Error(`Duplicate acknowledgement for ${acknowledgement.operationId}`);
    }
    duplicateOperations.add(acknowledgement.operationId);
  }

  const pending = [...state.pending];
  const acknowledged = [...state.acknowledged];
  for (const acknowledgement of acknowledgements) {
    const existingReceipt = acknowledged.find(
      (receipt) => receipt.operationId === acknowledgement.operationId,
    );
    if (existingReceipt) {
      if (!committedEnvelopesEqual(existingReceipt.envelope, acknowledgement.envelope)) {
        throw new Error(`Conflicting acknowledgement for ${acknowledgement.operationId}`);
      }
      continue;
    }

    const index = pending.findIndex(
      (entry) => entry.operationId === acknowledgement.operationId,
    );
    if (index < 0) {
      throw new Error(`Unknown outbox operation ${acknowledgement.operationId}`);
    }
    const entry = pending[index];
    if (!committedEnvelopeMatches(entry.envelope, acknowledgement)) {
      throw new Error(`Acknowledgement payload mismatch for ${acknowledgement.operationId}`);
    }
    pending.splice(index, 1);
    const receipt: OutboxReceipt = {
      operationId: acknowledgement.operationId,
      envelope: acknowledgement.envelope,
    };
    const sequenceOwner = acknowledged.find(
      (candidate) =>
        candidate.envelope.notebookId === receipt.envelope.notebookId &&
        candidate.envelope.sequence === receipt.envelope.sequence,
    );
    if (sequenceOwner) {
      throw new Error(
        `Sequence ${receipt.envelope.sequence} was already acknowledged for another operation`,
      );
    }
    acknowledged.push(receipt);
  }

  acknowledged.sort((left, right) => compareIds(left.operationId, right.operationId));
  return { ...state, pending, acknowledged };
}

function committedEnvelopesEqual(
  left: OutboxAcknowledgement['envelope'],
  right: OutboxAcknowledgement['envelope'],
): boolean {
  return (
    left.sequence === right.sequence &&
    left.protocolVersion === right.protocolVersion &&
    left.notebookId === right.notebookId &&
    left.documentId === right.documentId &&
    left.deviceId === right.deviceId &&
    left.keyEpoch === right.keyEpoch &&
    opaqueBytesEqual(left.changeHash, right.changeHash) &&
    opaqueBytesEqual(left.nonce, right.nonce) &&
    opaqueBytesEqual(left.ciphertext, right.ciphertext) &&
    opaqueBytesEqual(left.signature, right.signature)
  );
}

function compareIds(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
