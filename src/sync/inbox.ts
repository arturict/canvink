import type {
  InboundIngestResult,
  InboundSyncState,
  SyncEnvelope,
} from "./types";
import {
  bytesToHex,
  opaqueBytesEqual,
  parseOpaqueId,
  parseSyncEnvelope,
} from "./validation";

export const DEFAULT_MAX_BUFFERED_ENVELOPES = 2_048;

export function createInboundSyncState(
  notebookId: string,
  contiguousSequence = 0,
): InboundSyncState {
  const validatedNotebookId = parseOpaqueId(notebookId, "notebookId");
  if (!Number.isSafeInteger(contiguousSequence) || contiguousSequence < 0) {
    throw new Error("contiguousSequence must be a non-negative safe integer");
  }
  return {
    notebookId: validatedNotebookId,
    contiguousSequence,
    buffered: [],
    applied: [],
  };
}

export function getReadyEnvelopes(
  state: InboundSyncState,
): readonly SyncEnvelope[] {
  const ready: SyncEnvelope[] = [];
  let nextSequence = state.contiguousSequence + 1;
  for (const envelope of state.buffered) {
    if (envelope.sequence < nextSequence) continue;
    if (envelope.sequence !== nextSequence) break;
    ready.push(envelope);
    nextSequence += 1;
  }
  return ready;
}

export function ingestSyncEnvelope(
  state: InboundSyncState,
  input: unknown,
  maxBufferedEnvelopes = DEFAULT_MAX_BUFFERED_ENVELOPES,
): InboundIngestResult {
  const envelope = parseSyncEnvelope(input);
  if (envelope.notebookId !== state.notebookId) {
    return { accepted: false, state, reason: "wrong-notebook" };
  }

  const hash = bytesToHex(envelope.changeHash);
  const existingSequence = state.buffered.find(
    (candidate) => candidate.sequence === envelope.sequence,
  );
  if (existingSequence) {
    return {
      accepted: false,
      state,
      reason:
        bytesToHex(existingSequence.changeHash) === hash
          ? "duplicate"
          : "sequence-conflict",
    };
  }

  const bufferedHash = state.buffered.find(
    (candidate) => bytesToHex(candidate.changeHash) === hash,
  );
  if (bufferedHash) {
    return { accepted: false, state, reason: "replay" };
  }

  const appliedAtSequence = state.applied.find(
    (receipt) => receipt.sequence === envelope.sequence,
  );
  if (appliedAtSequence) {
    return {
      accepted: false,
      state,
      reason:
        appliedAtSequence.changeHashHex === hash
          ? "duplicate"
          : "sequence-conflict",
    };
  }
  if (state.applied.some((receipt) => receipt.changeHashHex === hash)) {
    return { accepted: false, state, reason: "replay" };
  }
  if (envelope.sequence <= state.contiguousSequence) {
    return { accepted: false, state, reason: "replay" };
  }
  if (
    !Number.isSafeInteger(maxBufferedEnvelopes) ||
    maxBufferedEnvelopes < 1 ||
    state.buffered.length >= maxBufferedEnvelopes
  ) {
    return { accepted: false, state, reason: "buffer-full" };
  }

  const buffered = [...state.buffered, envelope].sort(
    (left, right) => left.sequence - right.sequence,
  );
  const nextState = { ...state, buffered };
  return {
    accepted: true,
    state: nextState,
    ready: getReadyEnvelopes(nextState),
  };
}

/**
 * Advances the cursor only across the exact current contiguous prefix. Call this
 * after signature verification, decryption, and CRDT application all succeed.
 */
export function commitAppliedEnvelopes(
  state: InboundSyncState,
  applied: readonly SyncEnvelope[],
): InboundSyncState {
  if (applied.length === 0) return state;
  const ready = getReadyEnvelopes(state);
  if (applied.length > ready.length) {
    throw new Error(
      "Cannot commit beyond the ready contiguous envelope prefix",
    );
  }
  for (let index = 0; index < applied.length; index += 1) {
    const expected = ready[index];
    const actual = applied[index];
    if (!envelopesEqual(actual, expected)) {
      throw new Error(
        "Applied envelopes do not match the ready contiguous prefix",
      );
    }
  }

  const appliedReceipts = applied.map((envelope) => ({
    sequence: envelope.sequence,
    changeHashHex: bytesToHex(envelope.changeHash),
  }));
  const lastAppliedSequence = applied[applied.length - 1].sequence;
  return {
    ...state,
    contiguousSequence: lastAppliedSequence,
    buffered: state.buffered.filter(
      (envelope) => envelope.sequence > lastAppliedSequence,
    ),
    applied: [...state.applied, ...appliedReceipts],
  };
}

function envelopesEqual(left: SyncEnvelope, right: SyncEnvelope): boolean {
  return (
    left.protocolVersion === right.protocolVersion &&
    left.notebookId === right.notebookId &&
    left.documentId === right.documentId &&
    left.deviceId === right.deviceId &&
    left.keyEpoch === right.keyEpoch &&
    left.sequence === right.sequence &&
    opaqueBytesEqual(left.changeHash, right.changeHash) &&
    opaqueBytesEqual(left.nonce, right.nonce) &&
    opaqueBytesEqual(left.ciphertext, right.ciphertext) &&
    opaqueBytesEqual(left.signature, right.signature)
  );
}
