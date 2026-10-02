/**
 * Owner/editor glue between a room session and the app's live document
 * store. Deliberately does not import `workspaceV2Runtime`; callers wire a
 * `LocalDocsPort` themselves to keep this module decoupled from the runtime.
 */

import { createRoom, type CollabHttpConfig } from './http';
import type { DocKind } from './protocol';
import { attachAckCompaction, openRoomSession, type RoomSession, type WebSocketFactory } from './session';

export interface OwnerBridgeDoc {
  docId: string;
  kind: DocKind;
  /**
   * The full Automerge save, or a reader that produces it when the doc is
   * uploaded. Readers run one after the other, so a notebook with many pages
   * that are not loaded is uploaded with one page in memory at a time.
   */
  bytes: Uint8Array | (() => Promise<Uint8Array | undefined>);
}

export interface CreateRoomFromDocsResult {
  roomId: string;
  ownerToken: string;
}

export interface CreateRoomFromDocsOptions {
  webSocketFactory?: WebSocketFactory;
}

/**
 * Creates a room and uploads every doc as an initial snapshot (`announce` then `snapshot` with
 * `covers: 0`) over a short-lived owner session. The room starts restricted: nobody gets in until
 * the owner invites a person or switches the read-only link on.
 */
export async function createRoomFromDocs(
  http: CollabHttpConfig,
  docs: OwnerBridgeDoc[],
  notebookTitle: string,
  options: CreateRoomFromDocsOptions = {},
): Promise<CreateRoomFromDocsResult> {
  const { roomId, ownerToken } = await createRoom(http, notebookTitle);
  await uploadInitialDocs(http.syncUrl, roomId, ownerToken, docs, options.webSocketFactory);
  return { roomId, ownerToken };
}

function uploadInitialDocs(
  syncUrl: string,
  roomId: string,
  ownerToken: string,
  docs: OwnerBridgeDoc[],
  webSocketFactory?: WebSocketFactory,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let uploading = false;
    let waitForLive: (() => void) | undefined;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      session.close();
      reject(error);
    };
    const upload = async (): Promise<void> => {
      for (const doc of docs) {
        const bytes = typeof doc.bytes === 'function' ? await doc.bytes() : doc.bytes;
        if (settled) return;
        if (!bytes) continue;
        session.announceDoc(doc.docId, doc.kind);
        session.sendSnapshot(doc.docId, bytes, 0);
      }
      // Frames sent while a reconnect was pending sit in the session's queue
      // until the next catch-up; close only once they went out.
      if (session.getStatus() !== 'live') await new Promise<void>((done) => { waitForLive = done; });
      if (settled) return;
      settled = true;
      session.close();
      resolve();
    };
    const session = openRoomSession({
      syncUrl,
      roomId,
      auth: { kind: 'owner', ownerToken },
      ...(webSocketFactory ? { webSocketFactory } : {}),
      callbacks: {
        onStatus: (status) => {
          if (settled) return;
          if (status === 'live') {
            const waiting = waitForLive;
            waitForLive = undefined;
            waiting?.();
            if (uploading) return;
            uploading = true;
            upload().catch((error: unknown) => fail(error instanceof Error ? error : new Error(String(error))));
          } else if (status === 'closed' || status === 'error') {
            fail(new Error('The owner session closed before the initial upload completed.'));
          }
        },
        onError: (error) => {
          if (settled || error.code !== 'unauthorized') return;
          fail(new Error(`Uploading initial room docs was unauthorized: ${error.detail ?? ''}`));
        },
      },
    });
  });
}

type MaybePromise<T> = T | Promise<T>;

export interface LocalDocRef {
  docId: string;
  kind: DocKind;
}

/**
 * Port the integrator implements over its own document store. Every method
 * that reads document contents may answer asynchronously: a page that is not
 * loaded is read from storage for the call and freed again, so callers work
 * through documents one at a time.
 */
export interface EditorLocalDocsPort {
  /**
   * The local documents this port covers: ids and kinds only, nothing is
   * loaded. Seeds each listed doc's change-tracking baseline (the heads
   * already sent) when it has none yet.
   */
  listDocs(): MaybePromise<LocalDocRef[]>;
  /**
   * Whether `docId` is a local document, loaded or not. When absent, the
   * binding treats the docs it subscribed as the local ones.
   */
  hasDoc?(docId: string): boolean;
  /** Current heads of a local doc without loading it (lets a reconcile skip unchanged docs). */
  getHeads?(docId: string): readonly string[] | undefined;
  /**
   * Registers a listener for local incremental change bytes (every change
   * since the baseline, also for documents that are not loaded); returns an
   * unsubscribe.
   */
  subscribe(docId: string, callback: (bytes: Uint8Array) => void): () => void;
  /** Fires when the set of documents `listDocs` reports may have changed. */
  subscribeDocSet?(listener: () => void): () => void;
  /** A doc already known locally received remote bytes; the port merges them in. */
  applyRemote(docId: string, bytes: Uint8Array): MaybePromise<void>;
  /** A doc that exists in the room but not yet locally. */
  onRemoteDocAdded(docId: string, kind: DocKind, bytes: Uint8Array): void;
  /**
   * The current full Automerge save for `docId`, read WITHOUT any side effect
   * on the port's change-tracking baseline. Compaction
   * (`attachAckCompaction`) must be able to read a doc's bytes at any time
   * without moving that baseline, or a local change made right after this
   * read could compute an empty diff against the wrong baseline and get
   * silently dropped instead of sent.
   */
  getSnapshotBytes(docId: string): MaybePromise<Uint8Array | undefined>;
  /**
   * The local changes not covered by `heads` (Automerge `saveSince`), and
   * moves the change-tracking baseline past them so they are not sent a
   * second time. Undefined when `heads` are not all known locally. Used to
   * resend offline work after a reconnect or a reload (`'reconcile'`).
   */
  takeChangesSince?(docId: string, heads: string[]): MaybePromise<Uint8Array | undefined>;
}

/** Runs tasks one after the other; a failing task is reported and does not stop the queue. */
export class SerialTaskQueue {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly onError: (error: unknown) => void = (error) => {
    console.warn('[collab] sync task failed', error);
  }) {}

  enqueue(task: () => MaybePromise<void>): Promise<void> {
    const run = this.tail.then(task).catch(this.onError);
    this.tail = run;
    return run;
  }

  /** Resolves once every task enqueued so far has finished. */
  idle(): Promise<void> {
    return this.tail;
  }
}

export interface EditorSessionBinding {
  (): void;
  /** Resolves once the binding processed everything received or queued so far (tests, shutdown). */
  idle(): Promise<void>;
}

function sameHeads(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const set = new Set(left);
  return right.every((head) => set.has(head));
}

/**
 * Wires a live session to a local document store. Forwards local changes as
 * `append` frames and hands incoming room docs to the port as full Automerge
 * saves (`session.getDocBytes`; the port merges them idempotently).
 *
 * Remote applies, document-set updates and reconciles run through one serial
 * queue: only one document is read or written at a time (an unloaded page is
 * in memory for its own step only), a reconcile never runs before the remote
 * changes received ahead of it were applied, and several frames for the same
 * doc that arrive while earlier work is pending are applied once.
 *
 * When the port reports document-set changes, a doc that appears locally is
 * subscribed and, while the session is live and the room lacks it, announced
 * and uploaded as a snapshot before any append; a doc that leaves the local
 * set is removed from the room. Returns an unsubscribe that detaches every
 * listener.
 */
export function bindEditorSession(session: RoomSession, port: EditorLocalDocsPort): EditorSessionBinding {
  let disposed = false;
  const queue = new SerialTaskQueue();
  const bound = new Map<string, { kind: DocKind; unsubscribe: () => void }>();
  const remoteOnly = new Set<string>();
  const pendingRemote = new Set<string>();
  let docSetPending = false;
  let reconcilePending = false;

  const isLocal = (docId: string): boolean => (port.hasDoc ? port.hasDoc(docId) : bound.has(docId));

  const syncDocSet = async (maintainRoom: boolean): Promise<void> => {
    const docs = await port.listDocs();
    if (disposed) return;
    const current = new Set(docs.map((doc) => doc.docId));
    for (const doc of docs) {
      if (bound.has(doc.docId)) continue;
      bound.set(doc.docId, {
        kind: doc.kind,
        unsubscribe: port.subscribe(doc.docId, (bytes) => session.sendLocalChange(doc.docId, bytes)),
      });
      remoteOnly.delete(doc.docId);
      // Before the first catch-up the room's doc list is unknown; the
      // reconcile after `synced` announces what the room lacks instead.
      if (!maintainRoom || session.getStatus() !== 'live' || session.getDocs().has(doc.docId)) continue;
      session.announceDoc(doc.docId, doc.kind);
      const bytes = await port.getSnapshotBytes(doc.docId);
      if (disposed) return;
      if (bytes) session.sendSnapshot(doc.docId, bytes, 0);
    }
    for (const [docId, entry] of [...bound]) {
      if (current.has(docId)) continue;
      entry.unsubscribe();
      bound.delete(docId);
      if (maintainRoom && session.getDocs().has(docId)) session.removeDoc(docId);
    }
  };

  void queue.enqueue(() => syncDocSet(false));

  const unsubscribeRemote = session.subscribeDocsChanged((docId) => {
    if (pendingRemote.has(docId)) return;
    pendingRemote.add(docId);
    void queue.enqueue(async () => {
      pendingRemote.delete(docId);
      if (disposed) return;
      const bytes = session.getDocBytes(docId);
      if (!bytes) return;
      if (!isLocal(docId)) {
        if (remoteOnly.has(docId)) return;
        remoteOnly.add(docId);
        port.onRemoteDocAdded(docId, session.getDocs().get(docId)?.kind ?? 'page', bytes);
        return;
      }
      await port.applyRemote(docId, bytes);
    });
  });

  const unsubscribeDocSet = port.subscribeDocSet?.(() => {
    if (docSetPending) return;
    docSetPending = true;
    void queue.enqueue(async () => {
      docSetPending = false;
      if (!disposed) await syncDocSet(true);
    });
  }) ?? (() => undefined);

  // B1c: real compaction. `port.getSnapshotBytes(docId)` reads the doc's
  // *current* full state at snapshot time — including local edits this
  // session has sent but that never round-trip back into `session`'s own doc
  // map (the server never echoes a frame back to its sender). Deliberately
  // not `port.listDocs()`, whose baseline seeding is only meant for binding.
  const unsubscribeCompaction = attachAckCompaction(session, (docId) =>
    port.getSnapshotBytes(docId));

  const unsubscribeSynced = port.takeChangesSince
    ? session.subscribeSynced(() => {
      if (reconcilePending) return;
      reconcilePending = true;
      void queue.enqueue(async () => {
        reconcilePending = false;
        if (!disposed) await reconcileWithRoom(session, port);
      });
    })
    : () => undefined;

  const unbind = (): void => {
    disposed = true;
    for (const entry of bound.values()) entry.unsubscribe();
    bound.clear();
    unsubscribeRemote();
    unsubscribeDocSet();
    unsubscribeCompaction();
    unsubscribeSynced();
  };
  return Object.assign(unbind, { idle: () => queue.idle() });
}

/**
 * After a catch-up, sends every local change the room does not hold yet:
 * work done offline (also across a reload, since the local store persisted
 * it), and appends whose fate was unknown when the connection dropped. A doc
 * the room does not know at all (a page created offline) is announced and
 * uploaded as a snapshot. Resending a change the room already has is
 * harmless, Automerge ignores duplicates.
 *
 * Documents are handled one after the other, and a doc whose local heads
 * equal the room's is skipped without being read, so a reconnect does not
 * load every page of a large notebook.
 */
export async function reconcileWithRoom(session: RoomSession, port: EditorLocalDocsPort): Promise<void> {
  const docs = await port.listDocs();
  for (const doc of docs) {
    if (session.getStatus() !== 'live') return; // The next `synced` reconciles again.
    const roomDocs = session.getDocs();
    if (!roomDocs.has(doc.docId)) {
      const bytes = await port.getSnapshotBytes(doc.docId);
      if (!bytes || session.getStatus() !== 'live') continue;
      session.announceDoc(doc.docId, doc.kind);
      session.sendSnapshot(doc.docId, bytes, 0);
      continue;
    }
    const heads = session.getConfirmedHeads(doc.docId) ?? [];
    const localHeads = port.getHeads?.(doc.docId);
    if (localHeads && heads.length > 0 && sameHeads(localHeads, heads)) continue;
    let bytes: Uint8Array | undefined;
    try {
      bytes = await port.takeChangesSince?.(doc.docId, heads);
    } catch {
      bytes = undefined;
    }
    // Heads the local copy does not know (should not happen after the
    // catch-up merged them): fall back to the whole document, which peers
    // load like any incremental change.
    if (bytes === undefined) bytes = await port.getSnapshotBytes(doc.docId);
    if (bytes && bytes.byteLength > 0) session.sendLocalChange(doc.docId, bytes);
  }
}
