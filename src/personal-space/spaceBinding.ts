/**
 * Binds the personal room session to the local workspace port
 * (`createRuntimeSpacePort`), the document half of `usePersonalSpaceSync`
 * (PERSONAL-SYNC.md §5.6). Kept free of React so it can be exercised against
 * real runtimes in tests.
 *
 * - Local changes of every workspace document, loaded or not, are forwarded
 *   as they happen (the port reads the runtime's document change feed).
 * - Remote changes of a document this device has are merged through the
 *   port, also when the page is not open: the runtime loads it for the merge,
 *   persists it and frees it again. "Has" is answered by the runtime's
 *   document list, never by which pages happen to be loaded.
 * - A remote document this device does not have yet is reported for
 *   adoption (`onRemoteDocAdded`); the catch-up commit adopts it.
 * - `pushLocal` announces local documents the room lacks and sends local
 *   changes the room does not hold yet (edits made before the session opened
 *   or while it was closed). It runs after every catch-up (`synced`) and
 *   when the local document set changes, and only while `mayPushLocal()`
 *   allows it (not before a pulling device finished its first catch-up).
 *
 * Remote applies, subscriptions and pushes run through one serial queue, so
 * only one unloaded page is in memory at a time and a push never runs before
 * the remote changes received ahead of it were merged.
 */

import { SerialTaskQueue, type EditorLocalDocsPort } from '../collab';
import type { PersonalSpaceSession } from './spaceSession';
import { isWorkspaceDocId } from './spaceSession';

export type PersonalSpaceBindingSession = Pick<
  PersonalSpaceSession,
  | 'isLive'
  | 'getDocBytes'
  | 'getConfirmedHeads'
  | 'getDocs'
  | 'awaitsFetch'
  | 'sendLocalChange'
  | 'sendSnapshot'
  | 'announceDoc'
  | 'subscribeDocsChanged'
  | 'subscribeSynced'
>;

export interface PersonalSpaceBindingOptions {
  session: PersonalSpaceBindingSession;
  port: EditorLocalDocsPort;
  /** `workspace:root` changed in the room; the owner reads what arrived from the session (`takeDocUpdates`). */
  onWorkspaceDoc(): void;
  /** Remote bytes were merged into a local document. */
  onRemoteDocApplied?(docId: string): void;
  /** Whether local documents may be announced and pushed now. */
  mayPushLocal(): boolean;
  /**
   * Documents this device already announced to the room. Owned by the
   * caller so a reopened session does not announce them a second time.
   */
  announced: Set<string>;
}

export interface PersonalSpaceBinding {
  /** Queues a push of local documents and changes the room lacks. */
  pushLocal(): Promise<void>;
  /** Resolves once everything received or queued so far was processed. */
  idle(): Promise<void>;
  dispose(): void;
}

function sameHeads(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const set = new Set(left);
  return right.every((head) => set.has(head));
}

export function bindPersonalSpace(options: PersonalSpaceBindingOptions): PersonalSpaceBinding {
  const { session, port } = options;
  const queue = new SerialTaskQueue((error) => {
    console.warn('[personal-space] sync task failed', error);
  });
  let disposed = false;
  const subscriptions = new Map<string, () => void>();
  const pendingRemote = new Set<string>();
  let pushPending = false;
  let docSetPending = false;

  const isLocal = (docId: string): boolean => (port.hasDoc ? port.hasDoc(docId) : subscriptions.has(docId));

  const subscribeLocalDocs = async (): Promise<void> => {
    const docs = await port.listDocs();
    if (disposed) return;
    const current = new Set(docs.map((doc) => doc.docId));
    for (const doc of docs) {
      if (subscriptions.has(doc.docId)) continue;
      subscriptions.set(doc.docId, port.subscribe(doc.docId, (bytes) => session.sendLocalChange(doc.docId, bytes)));
    }
    for (const [docId, unsubscribe] of [...subscriptions]) {
      if (current.has(docId)) continue;
      unsubscribe();
      subscriptions.delete(docId);
    }
  };

  const pushLocalNow = async (): Promise<void> => {
    if (disposed || !options.mayPushLocal() || !session.isLive()) return;
    const docs = await port.listDocs();
    for (const doc of docs) {
      // A dropped connection stops the pass; the next `synced` runs it again.
      if (disposed || !session.isLive()) return;
      const known = session.getDocs().has(doc.docId);
      if (!known && options.announced.has(doc.docId)) continue;
      // The room has the document and has not sent it: what it holds is unknown, so neither an
      // upload of the whole document nor a diff against its heads is possible yet. The catch-up
      // requests it (see `usePersonalSpaceSync`) and the push runs again once it arrived.
      if (known && session.awaitsFetch(doc.docId)) continue;
      const roomHeads = session.getConfirmedHeads(doc.docId);
      if (!known || !roomHeads || roomHeads.length === 0) {
        // The room lacks the doc, or knows it without content (a snapshot
        // that never arrived): upload the whole document.
        const bytes = await port.getSnapshotBytes(doc.docId);
        if (disposed || !session.isLive()) return;
        if (!bytes) continue;
        if (!known) session.announceDoc(doc.docId, doc.kind);
        session.sendSnapshot(doc.docId, bytes, 0);
        options.announced.add(doc.docId);
        continue;
      }
      const localHeads = port.getHeads?.(doc.docId);
      if (localHeads && sameHeads(localHeads, roomHeads)) continue;
      // Undefined when the local copy lacks some of the room's heads: an
      // unrelated history the port refused. Sending it would graft that
      // history onto the account's copy, so it is left alone.
      const bytes = await port.takeChangesSince?.(doc.docId, [...roomHeads]);
      if (disposed) return;
      if (bytes && bytes.byteLength > 0) session.sendLocalChange(doc.docId, bytes);
    }
  };

  const schedulePush = (): Promise<void> => {
    if (pushPending) return queue.idle();
    pushPending = true;
    return queue.enqueue(async () => {
      pushPending = false;
      await pushLocalNow();
    });
  };

  void queue.enqueue(subscribeLocalDocs);

  const unsubscribeRemote = session.subscribeDocsChanged((docId) => {
    if (disposed) return;
    if (isWorkspaceDocId(docId)) {
      options.onWorkspaceDoc();
      return;
    }
    if (pendingRemote.has(docId)) return;
    pendingRemote.add(docId);
    void queue.enqueue(async () => {
      pendingRemote.delete(docId);
      if (disposed) return;
      const bytes = session.getDocBytes(docId);
      if (!bytes) return;
      if (!isLocal(docId)) {
        port.onRemoteDocAdded(docId, session.getDocs().get(docId)?.kind === 'notebook' ? 'notebook' : 'page', bytes);
        return;
      }
      // The usual case on a device that has synced before: its copy is the room's. Merging would
      // load both documents only to find nothing to add.
      const localHeads = port.getHeads?.(docId);
      const roomHeads = session.getConfirmedHeads(docId);
      if (localHeads && roomHeads && sameHeads(localHeads, roomHeads)) return;
      await port.applyRemote(docId, bytes);
      options.onRemoteDocApplied?.(docId);
    });
  });

  const unsubscribeDocSet = port.subscribeDocSet?.(() => {
    if (docSetPending) return;
    docSetPending = true;
    void queue.enqueue(async () => {
      docSetPending = false;
      if (disposed) return;
      await subscribeLocalDocs();
      await pushLocalNow();
    });
  }) ?? (() => undefined);

  const unsubscribeSynced = session.subscribeSynced(() => { void schedulePush(); });

  return {
    pushLocal: schedulePush,
    idle: () => queue.idle(),
    dispose: () => {
      disposed = true;
      for (const unsubscribe of subscriptions.values()) unsubscribe();
      subscriptions.clear();
      unsubscribeRemote();
      unsubscribeDocSet();
      unsubscribeSynced();
    },
  };
}
