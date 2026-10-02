import { describe, expect, it } from 'vitest';
import {
  acceptCatchUpPage,
  beginCatchUp,
  commitCatchUpPage,
  createCatchUpState,
} from './catchUp';
import { createInboundSyncState, getReadyEnvelopes, ingestSyncEnvelope } from './inbox';
import { syncEnvelope } from './testFixtures';

describe('change catch-up state', () => {
  it('walks deterministic pages from the committed cursor to a snapshot', () => {
    let inbox = createInboundSyncState('notebook-1');
    let catchUp = beginCatchUp(createCatchUpState('notebook-1'), inbox);
    let accepted = acceptCatchUpPage(catchUp, inbox, {
      notebookId: 'notebook-1',
      afterSequence: 0,
      snapshotSequence: 3,
      hasMore: true,
      envelopes: [syncEnvelope(1), syncEnvelope(2)],
    });
    ({ inbox, catchUp } = commitCatchUpPage(
      accepted.catchUp,
      accepted.inbox,
      getReadyEnvelopes(accepted.inbox),
    ));
    expect(catchUp).toMatchObject({ status: 'requesting', requestedAfterSequence: 2 });

    accepted = acceptCatchUpPage(catchUp, inbox, {
      notebookId: 'notebook-1',
      afterSequence: 2,
      snapshotSequence: 3,
      hasMore: false,
      envelopes: [syncEnvelope(3)],
    });
    ({ inbox, catchUp } = commitCatchUpPage(
      accepted.catchUp,
      accepted.inbox,
      getReadyEnvelopes(accepted.inbox),
    ));

    expect(inbox.contiguousSequence).toBe(3);
    expect(catchUp).toMatchObject({ status: 'caught-up', snapshotSequence: 3 });
  });

  it('tolerates a byte-identical envelope already buffered from realtime', () => {
    const realtime = ingestSyncEnvelope(
      createInboundSyncState('notebook-1'),
      syncEnvelope(2),
    );
    if (!realtime.accepted) throw new Error('expected realtime acceptance');
    const catchUp = beginCatchUp(createCatchUpState('notebook-1'), realtime.state);

    const accepted = acceptCatchUpPage(catchUp, realtime.state, {
      notebookId: 'notebook-1',
      afterSequence: 0,
      snapshotSequence: 2,
      hasMore: false,
      envelopes: [syncEnvelope(1), syncEnvelope(2)],
    });

    expect(getReadyEnvelopes(accepted.inbox).map((item) => item.sequence)).toEqual([
      1, 2,
    ]);
  });

  it('rejects pages for a stale requested cursor', () => {
    const inbox = createInboundSyncState('notebook-1');
    const catchUp = beginCatchUp(createCatchUpState('notebook-1'), inbox);

    expect(() =>
      acceptCatchUpPage(catchUp, inbox, {
        notebookId: 'notebook-1',
        afterSequence: 1,
        snapshotSequence: 1,
        hasMore: false,
        envelopes: [],
      }),
    ).toThrow(/requested cursor/);
  });
});

