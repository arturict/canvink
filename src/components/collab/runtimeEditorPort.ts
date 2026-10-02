/**
 * `EditorLocalDocsPort` (see `src/collab/ownerBridge.ts`) for one shared
 * notebook of a `WorkspaceV2Runtime`: the notebook root plus every page its
 * sections list, loaded or not. Built on `createDocumentFeedPort`, so the
 * owner's edits to any page of the notebook reach the room, and remote
 * changes for a page that is not open are merged into storage without the
 * page staying in memory.
 */

import type { DocKind, EditorLocalDocsPort } from '../../collab';
import { createDocumentFeedPort, type DocumentFeedRuntime } from '../../collab';
import type { WorkspaceV2Runtime } from '../../storage/workspaceV2Runtime';

export type RuntimeEditorPortSource = DocumentFeedRuntime & Pick<WorkspaceV2Runtime, 'getState'>;

/** Source string of the sharing room's remote applies for `notebookId`. */
export function collabSource(notebookId: string): string {
  return `collab:${notebookId}`;
}

/**
 * Creates the port for `notebookId`. The document set follows the notebook
 * as it changes (pages added, moved away or removed); `bindEditorSession`
 * picks those changes up through `subscribeDocSet`, so the port lives as
 * long as the room binding.
 */
export function createRuntimeEditorPort(
  runtime: RuntimeEditorPortSource,
  notebookId: string,
  options: {
    /**
     * A document the room has and this workspace lacks: a page another
     * member created. The workspace has to adopt it with its history in a
     * topology transaction that also lists it in the manifest, which only the
     * caller (it owns the runtime's commit rules) can do.
     */
    onRemoteDocAdded?(docId: string, kind: DocKind, bytes: Uint8Array): void;
  } = {},
): EditorLocalDocsPort {
  let cachedState: unknown;
  let cachedIds = new Set<string>();
  const notebookDocumentIds = (): ReadonlySet<string> => {
    const state = runtime.getState();
    if (state === cachedState) return cachedIds;
    cachedState = state;
    cachedIds = new Set();
    if (state.schemaVersion !== 1) {
      const notebook = state.notebooks.find((candidate) => candidate.notebookId === notebookId);
      if (notebook) {
        cachedIds.add(notebook.documentId);
        for (const section of notebook.sections) for (const pageDocumentId of section.pageDocumentIds) cachedIds.add(pageDocumentId);
      }
    }
    return cachedIds;
  };

  return createDocumentFeedPort(runtime, {
    source: collabSource(notebookId),
    includes: (documentId) => notebookDocumentIds().has(documentId),
    onRemoteDocAdded: (docId, kind, bytes) => options.onRemoteDocAdded?.(docId, kind, bytes),
  });
}
