/**
 * `EditorLocalDocsPort` over the *whole* active workspace, for the
 * personal-space session (PERSONAL-SYNC.md §5.6). Unlike
 * `createRuntimeEditorPort` (`src/components/collab/runtimeEditorPort.ts`),
 * which is scoped to one notebook and treats `onRemoteDocAdded` as a
 * deliberate no-op, this port:
 *
 * - covers every document in the active workspace, loaded or not;
 * - implements `onRemoteDocAdded`, handing the bytes to the catch-up
 *   planner instead of discarding them;
 * - refuses remote bytes whose history is unrelated to the local copy
 *   (`sharesHistory`).
 *
 * Both are built on `createDocumentFeedPort`: outgoing changes come from the
 * runtime's document change feed and incoming ones go through
 * `applyRemoteDocumentChanges`, so a page does not have to be open to sync.
 */

import * as Automerge from "@automerge/automerge";
import { documentHasHeads } from "../crdt/document";
import { createDocumentFeedPort, type DocumentFeedRuntime, type EditorLocalDocsPort } from "../collab";

/** Source string of the personal room's remote applies in the runtime's change feed. */
export const PERSONAL_SPACE_SOURCE = "personal-space";

/**
 * Whether `bytes` (a full Automerge save, as the personal-space session sends it) continue this
 * device's copy of the document rather than an independently created one. Every fresh install
 * creates the bundled start page under the same fixed documentId; merging another device's copy
 * into the local one joins two unrelated histories, and the conflicting root fields (notebook,
 * section, element order) leave a page the workspace graph rejects on the next start.
 */
export function sharesHistory(local: Automerge.Doc<object>, bytes: Uint8Array): boolean {
  let remote: Automerge.Doc<object>;
  try {
    remote = Automerge.load<object>(bytes);
  } catch {
    // Not a complete save: plain changes whose dependencies are unknown here are queued by
    // Automerge instead of applied, so they cannot graft a foreign history onto this copy.
    return true;
  }
  try {
    const localHeads = Automerge.getHeads(local);
    const remoteHeads = Automerge.getHeads(remote);
    if (localHeads.length === 0 || remoteHeads.length === 0) return true;
    // The usual cases: one side already contains everything the other has.
    if (documentHasHeads(remote, localHeads) || documentHasHeads(local, remoteHeads)) return true;
    // Both sides changed since they last met: a related copy still contains this copy's first change.
    const [firstChange] = Automerge.getAllChanges(local);
    return firstChange !== undefined && documentHasHeads(remote, [Automerge.decodeChange(firstChange).hash]);
  } finally {
    // The remote copy is only inspected; free it now instead of waiting for the garbage collector.
    Automerge.free(remote);
  }
}

export interface RuntimeSpacePortOptions {
  /**
   * A doc that exists in the room but not yet locally. `kind` is always
   * `'notebook'` or `'page'` here — the workspace doc itself (`kind:
   * 'workspace'`) is handled outside any port (§5.6) and never reaches this
   * callback.
   */
  onRemoteDocAdded(docId: string, kind: "notebook" | "page", bytes: Uint8Array): void;
}

/**
 * Creates the port over every document in the active workspace. The
 * document set follows the workspace (commits that add or remove documents);
 * `subscribeDocSet` reports those changes.
 */
export function createRuntimeSpacePort(
  runtime: DocumentFeedRuntime,
  options: RuntimeSpacePortOptions,
): EditorLocalDocsPort {
  return createDocumentFeedPort(runtime, {
    source: PERSONAL_SPACE_SOURCE,
    accept: (local, bytes) => sharesHistory(local as Automerge.Doc<object>, bytes),
    onRejected: (docId) => {
      // Keep the local copy intact; the first catch-up of a fresh device replaces its
      // pristine start page with the account's copy instead (usePersonalSpaceSync).
      console.warn(`[personal-space] ignored the account's copy of ${docId}: it has an unrelated history`);
    },
    onRemoteDocAdded: (docId, kind, bytes) => {
      if (kind === "workspace") return;
      options.onRemoteDocAdded(docId, kind, bytes);
    },
  });
}
