import { commitAppliedEnvelopes, ingestSyncEnvelope } from './inbox';
import type {
  CatchUpPage,
  CatchUpState,
  InboundSyncState,
  SyncEnvelope,
} from './types';
import { parseCatchUpPage, parseOpaqueId } from './validation';

export function createCatchUpState(notebookId: string): CatchUpState {
  const validatedNotebookId = parseOpaqueId(notebookId, 'notebookId');
  return {
    status: 'idle',
    notebookId: validatedNotebookId,
    requestedAfterSequence: null,
    pageLastSequence: null,
    snapshotSequence: null,
    pageHasMore: null,
  };
}

export function beginCatchUp(
  state: CatchUpState,
  inbox: InboundSyncState,
): CatchUpState {
  if (state.notebookId !== inbox.notebookId) {
    throw new Error('Catch-up and inbox notebook IDs must match');
  }
  if (state.status === 'requesting' || state.status === 'applying') {
    throw new Error('Catch-up is already in progress');
  }
  return {
    status: 'requesting',
    notebookId: state.notebookId,
    requestedAfterSequence: inbox.contiguousSequence,
    pageLastSequence: null,
    snapshotSequence: null,
    pageHasMore: null,
  };
}

export function acceptCatchUpPage(
  state: CatchUpState,
  inbox: InboundSyncState,
  input: unknown,
): { catchUp: CatchUpState; inbox: InboundSyncState; page: CatchUpPage } {
  if (state.status !== 'requesting') {
    throw new Error('Catch-up is not waiting for a page');
  }
  const page = parseCatchUpPage(input);
  if (
    page.notebookId !== state.notebookId ||
    page.notebookId !== inbox.notebookId
  ) {
    throw new Error('Catch-up page belongs to another notebook');
  }
  if (page.afterSequence !== state.requestedAfterSequence) {
    throw new Error('Catch-up page does not match the requested cursor');
  }
  if (
    state.snapshotSequence !== null &&
    page.snapshotSequence !== state.snapshotSequence
  ) {
    throw new Error('Catch-up page changed the in-progress snapshot sequence');
  }
  if (inbox.contiguousSequence !== state.requestedAfterSequence) {
    throw new Error('Inbox cursor changed while the catch-up page was in flight');
  }

  let nextInbox = inbox;
  for (const envelope of page.envelopes) {
    const result = ingestSyncEnvelope(nextInbox, envelope);
    if (!result.accepted) {
      if (result.reason === 'duplicate') continue;
      throw new Error(`Catch-up page envelope was rejected: ${result.reason}`);
    }
    nextInbox = result.state;
  }

  return {
    page,
    inbox: nextInbox,
    catchUp: {
      status: 'applying',
      notebookId: state.notebookId,
      requestedAfterSequence: state.requestedAfterSequence,
      pageLastSequence:
        page.envelopes.at(-1)?.sequence ?? state.requestedAfterSequence,
      snapshotSequence: page.snapshotSequence,
      pageHasMore: page.hasMore,
    },
  };
}

/** Commits one accepted catch-up page after the caller applies its ready batch. */
export function commitCatchUpPage(
  state: CatchUpState,
  inbox: InboundSyncState,
  applied: readonly SyncEnvelope[],
): { catchUp: CatchUpState; inbox: InboundSyncState } {
  if (state.status !== 'applying') {
    throw new Error('Catch-up does not have a page awaiting application');
  }
  const nextInbox = commitAppliedEnvelopes(inbox, applied);
  if (nextInbox.contiguousSequence !== state.pageLastSequence) {
    throw new Error('The complete catch-up page must be applied before continuing');
  }

  if (state.pageHasMore) {
    return {
      inbox: nextInbox,
      catchUp: {
        status: 'requesting',
        notebookId: state.notebookId,
        requestedAfterSequence: nextInbox.contiguousSequence,
        pageLastSequence: null,
        snapshotSequence: state.snapshotSequence,
        pageHasMore: null,
      },
    };
  }
  if (nextInbox.contiguousSequence !== state.snapshotSequence) {
    throw new Error('Final catch-up page did not reach its snapshot sequence');
  }
  return {
    inbox: nextInbox,
    catchUp: {
      status: 'caught-up',
      notebookId: state.notebookId,
      requestedAfterSequence: null,
      pageLastSequence: null,
      snapshotSequence: state.snapshotSequence,
      pageHasMore: null,
    },
  };
}
