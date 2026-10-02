/**
 * Documents this device may read but not change: the notebook and the pages of a notebook that was
 * shared with a reader ("Lesen"). The sharing layer sets them from the role the room grants; the
 * storage runtime and the page writers consult them as the last line of defence, so that no UI path,
 * background job or restored draft can put a local edit into a notebook the room would refuse
 * (the room refuses it too, see services/collab-sync).
 *
 * Remote changes are not edits of this device: applying what the room sends, and adopting its pages,
 * never ask this registry.
 */

const readOnly = new Set<string>();

export class ReadOnlyDocumentError extends Error {
  constructor(readonly documentId: string) {
    super(`The document ${documentId} belongs to a notebook shared read-only.`);
    this.name = 'ReadOnlyDocumentError';
  }
}

/** Replaces the set of read-only documents. */
export function setReadOnlyDocuments(documentIds: Iterable<string>): void {
  readOnly.clear();
  for (const documentId of documentIds) readOnly.add(documentId);
}

export function isDocumentReadOnly(documentId: string): boolean {
  return readOnly.has(documentId);
}

export function assertDocumentWritable(documentId: string): void {
  if (readOnly.has(documentId)) throw new ReadOnlyDocumentError(documentId);
}
