import { describe, expect, it } from 'vitest';
import {
  acknowledgeOutbox,
  createOutboxState,
  enqueueOutbox,
  selectOutboxBatch,
} from './outbox';
import { pendingEnvelope, syncEnvelope } from './testFixtures';

describe('deterministic sync outbox', () => {
  it('assigns durable local order and selects oldest entries first', () => {
    let state = createOutboxState();
    state = enqueueOutbox(state, 'operation-b', pendingEnvelope(2));
    state = enqueueOutbox(state, 'operation-a', pendingEnvelope(1));

    expect(selectOutboxBatch(state, 2).map((entry) => entry.operationId)).toEqual([
      'operation-b',
      'operation-a',
    ]);
  });

  it('removes only acknowledgements whose complete committed payload matches', () => {
    const state = enqueueOutbox(
      createOutboxState(),
      'operation-1',
      pendingEnvelope(1),
    );

    expect(() =>
      acknowledgeOutbox(state, [
        { operationId: 'operation-1', envelope: syncEnvelope(8, 1, { deviceId: 'other' }) },
      ]),
    ).toThrow(/payload mismatch/);
    expect(() =>
      acknowledgeOutbox(state, [
        { operationId: 'operation-1', envelope: syncEnvelope(8, 1, { keyEpoch: 2 }) },
      ]),
    ).toThrow(/payload mismatch/);
    expect(state.pending).toHaveLength(1);
  });

  it('produces the same state regardless of acknowledgement order', () => {
    let state = createOutboxState();
    state = enqueueOutbox(state, 'operation-b', pendingEnvelope(2));
    state = enqueueOutbox(state, 'operation-a', pendingEnvelope(1));
    const a = { operationId: 'operation-a', envelope: syncEnvelope(6, 1) };
    const b = { operationId: 'operation-b', envelope: syncEnvelope(5, 2) };

    expect(acknowledgeOutbox(state, [a, b])).toEqual(
      acknowledgeOutbox(state, [b, a]),
    );
  });

  it('is idempotent for the same durable receipt but rejects conflicting replay', () => {
    const state = enqueueOutbox(
      createOutboxState(),
      'operation-1',
      pendingEnvelope(1),
    );
    const acknowledgement = {
      operationId: 'operation-1',
      envelope: syncEnvelope(5, 1),
    };
    const acknowledged = acknowledgeOutbox(state, [acknowledgement]);

    expect(acknowledgeOutbox(acknowledged, [acknowledgement])).toEqual(acknowledged);
    expect(() =>
      acknowledgeOutbox(acknowledged, [
        { ...acknowledgement, envelope: syncEnvelope(6, 1) },
      ]),
    ).toThrow(/Conflicting acknowledgement/);
  });

  it('rejects reuse of one notebook sequence for different operations', () => {
    let state = createOutboxState();
    state = enqueueOutbox(state, 'operation-1', pendingEnvelope(1));
    state = enqueueOutbox(state, 'operation-2', pendingEnvelope(2));

    expect(() =>
      acknowledgeOutbox(state, [
        { operationId: 'operation-1', envelope: syncEnvelope(5, 1) },
        { operationId: 'operation-2', envelope: syncEnvelope(5, 2) },
      ]),
    ).toThrow(/already acknowledged/);
  });
});
