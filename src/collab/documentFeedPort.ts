/**
 * `EditorLocalDocsPort` over a lazily loading document runtime (the shape of
 * `WorkspaceV2Runtime`'s document API, declared structurally here so
 * `src/collab/` stays independent of the storage layer).
 *
 * Nothing here keeps a document in memory. Outgoing changes come from the
 * runtime's document change feed, which reports changes of every document,
 * loaded or not (local edits, topology commits, remote changes applied by
 * other sync channels). Incoming bytes go through
 * `applyRemoteDocumentChanges`, which merges into a loaded page in place and
 * loads, updates, persists and frees any other page. Snapshots and reconcile
 * diffs read one document at a time through `readDocument`.
 *
 * The change-tracking baseline is a map of heads per document (what this
 * port already sent), so it survives a page being evicted and loaded again.
 */

import * as Automerge from '@automerge/automerge';
import { documentHasHeads } from '../crdt/document';
import type { DocKind } from './protocol';
import type { EditorLocalDocsPort, LocalDocRef } from './ownerBridge';

export type DocumentFeedOrigin =
  | { kind: 'local' }
  | { kind: 'remote'; source: string }
  | { kind: 'topology' };

export interface DocumentFeedEvent {
  documentId: string;
  kind: 'notebook' | 'page';
  beforeHeads: readonly string[];
  heads: readonly string[];
  origin: DocumentFeedOrigin;
  /** The document after the change; valid only while the listener runs. */
  document?: Automerge.Doc<unknown>;
  added?: boolean;
}

export type DocumentFeedApplyResult = 'applied' | 'unchanged' | 'rejected' | 'unknown';

/** The part of `WorkspaceV2Runtime` a sync port needs. */
export interface DocumentFeedRuntime {
  listDocuments(): Array<{ documentId: string; kind: 'notebook' | 'page' }>;
  getDocumentHeads(documentId: string): readonly string[] | undefined;
  subscribeToDocumentChanges(listener: (event: DocumentFeedEvent) => void): () => void;
  subscribeToState(listener: () => void): () => void;
  readDocument<T>(documentId: string, reader: (document: Automerge.Doc<unknown>) => T | Promise<T>): Promise<T>;
  applyRemoteDocumentChanges(
    documentId: string,
    bytes: Uint8Array,
    options: { source: string; accept?: (local: Automerge.Doc<unknown>, bytes: Uint8Array) => boolean },
  ): Promise<DocumentFeedApplyResult>;
}

export interface DocumentFeedPortOptions {
  /**
   * Names this port's remote applies. Changes the runtime reports with this
   * source are the port's own and never sent back; remote changes of any
   * other source (another room, another sync channel) are forwarded once,
   * like local edits.
   */
  source: string;
  /** Which workspace documents the port covers; all when absent. */
  includes?(documentId: string): boolean;
  /** Can refuse remote bytes after inspecting the local copy. */
  accept?(local: Automerge.Doc<unknown>, bytes: Uint8Array): boolean;
  onRejected?(documentId: string): void;
  onRemoteDocAdded(docId: string, kind: DocKind, bytes: Uint8Array): void;
}

function sameHeads(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const set = new Set(left);
  return right.every((head) => set.has(head));
}

/** `saveSince`, or the whole document when the baseline is unknown to it. */
function changesSince(document: Automerge.Doc<unknown>, heads: readonly string[]): Uint8Array {
  try {
    if (documentHasHeads(document, heads)) return Automerge.saveSince(document, [...heads]);
  } catch {
    // Fall through to a full save, which peers load like any incremental change.
  }
  return Automerge.save(document);
}

export function createDocumentFeedPort(
  runtime: DocumentFeedRuntime,
  options: DocumentFeedPortOptions,
): EditorLocalDocsPort {
  const includes = (documentId: string): boolean => options.includes?.(documentId) ?? true;
  /** Heads already sent (or received from the room) per document. */
  const lastSyncedHeads = new Map<string, string[]>();
  const callbacks = new Map<string, (bytes: Uint8Array) => void>();
  let unsubscribeFeed: (() => void) | undefined;

  const listIncluded = (): LocalDocRef[] => runtime.listDocuments()
    .filter((document) => includes(document.documentId))
    .map((document) => ({ docId: document.documentId, kind: document.kind }));

  const onEvent = (event: DocumentFeedEvent): void => {
    const { documentId } = event;
    if (!includes(documentId)) return;
    if (event.added) {
      // A commit created it: a local page gets announced with a snapshot
      // that contains these heads, an adopted one came from the room.
      if (!lastSyncedHeads.has(documentId)) lastSyncedHeads.set(documentId, [...event.heads]);
      return;
    }
    const baseline = lastSyncedHeads.get(documentId);
    if (event.origin.kind === 'remote' && event.origin.source === options.source) {
      // Our own apply: the room has these changes. Advance only when nothing
      // unsent was pending, otherwise the next diff would skip local work.
      if (!baseline || sameHeads(baseline, event.beforeHeads)) lastSyncedHeads.set(documentId, [...event.heads]);
      return;
    }
    const callback = callbacks.get(documentId);
    if (!callback || !event.document) return;
    const bytes = changesSince(event.document, baseline ?? event.beforeHeads);
    lastSyncedHeads.set(documentId, [...event.heads]);
    if (bytes.byteLength > 0) callback(bytes);
  };

  const ensureFeed = (): void => {
    unsubscribeFeed ??= runtime.subscribeToDocumentChanges(onEvent);
  };

  const releaseFeedIfIdle = (): void => {
    if (callbacks.size > 0 || !unsubscribeFeed) return;
    unsubscribeFeed();
    unsubscribeFeed = undefined;
  };

  const isLocal = (docId: string): boolean =>
    includes(docId) && runtime.listDocuments().some((document) => document.documentId === docId);

  return {
    listDocs: () => {
      const docs = listIncluded();
      for (const doc of docs) {
        if (!lastSyncedHeads.has(doc.docId)) lastSyncedHeads.set(doc.docId, [...(runtime.getDocumentHeads(doc.docId) ?? [])]);
      }
      return docs;
    },

    hasDoc: isLocal,

    getHeads: (docId) => (includes(docId) ? runtime.getDocumentHeads(docId) : undefined),

    subscribe: (docId, callback) => {
      if (!includes(docId)) return () => undefined;
      callbacks.set(docId, callback);
      ensureFeed();
      return () => {
        if (callbacks.get(docId) !== callback) return;
        callbacks.delete(docId);
        releaseFeedIfIdle();
      };
    },

    subscribeDocSet: (listener) => {
      let key = listIncluded().map((doc) => doc.docId).join('\n');
      const check = (): void => {
        const next = listIncluded().map((doc) => doc.docId).join('\n');
        if (next === key) return;
        key = next;
        listener();
      };
      const unsubscribeState = runtime.subscribeToState(check);
      const unsubscribeAdded = runtime.subscribeToDocumentChanges((event) => {
        if (event.added) check();
      });
      return () => {
        unsubscribeState();
        unsubscribeAdded();
      };
    },

    applyRemote: async (docId, bytes) => {
      if (!includes(docId)) return;
      const result = await runtime.applyRemoteDocumentChanges(docId, bytes, {
        source: options.source,
        ...(options.accept ? { accept: options.accept } : {}),
      });
      if (result === 'rejected') options.onRejected?.(docId);
    },

    // Side-effect-free: never touches `lastSyncedHeads` (see the port contract).
    getSnapshotBytes: async (docId) => {
      if (!isLocal(docId)) return undefined;
      return runtime.readDocument(docId, (document) => Automerge.save(document));
    },

    takeChangesSince: async (docId, heads) => {
      if (!isLocal(docId)) return undefined;
      return runtime.readDocument(docId, (document) => {
        if (!documentHasHeads(document, heads)) return undefined;
        const bytes = Automerge.saveSince(document, heads);
        lastSyncedHeads.set(docId, Automerge.getHeads(document));
        return bytes;
      });
    },

    onRemoteDocAdded: (docId, kind, bytes) => options.onRemoteDocAdded(docId, kind, bytes),
  };
}
