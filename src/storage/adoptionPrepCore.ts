import type { LiveNotebookDocV2, PageAutomergeDoc } from '../crdt';
import { readSavedDocumentHeads } from '../crdt/documentHeads';
import { getAutomergeHeads, getSharedAutomergeSnapshot, loadAutomergeDocument } from '../crdt';
import * as Automerge from '@automerge/automerge';
import { summarizePageDocument, type PageSummary } from './pageIndex';

export interface AdoptionPrepRequest {
  id: number;
  documentId: string;
  kind: 'notebook' | 'page';
  schemaVersion: 2 | 3;
  bytes: Uint8Array;
}

export interface PreparedAdoption {
  /** A canonical save of the document, present when the input was not one document chunk. */
  saved?: Uint8Array;
  heads: string[];
  summary?: PageSummary;
  notebook?: LiveNotebookDocV2;
}

export type AdoptionPrepResponse =
  | { id: number; ok: true; prepared: PreparedAdoption }
  | { id: number; ok: false; message: string };

/**
 * Everything the delta commit needs to know about an adopted document, read
 * from its bytes: validated identity, heads, and the page summary or the
 * notebook snapshot. Loading a large page is the expensive part of adopting a
 * notebook, so this runs in worker threads (see adoptionPrep.ts).
 */
export function prepareAdoptedDocument(
  request: Pick<AdoptionPrepRequest, 'documentId' | 'kind' | 'schemaVersion' | 'bytes'>,
): PreparedAdoption {
  const document = loadAutomergeDocument(request.bytes, {
    expectedDocumentId: request.documentId,
    expectedKind: request.kind,
    expectedSchemaVersion: request.schemaVersion,
  });
  try {
    const heads = getAutomergeHeads(document);
    const savedHeads = readSavedDocumentHeads(request.bytes);
    // Bytes that are not one document chunk (a save followed by change chunks) are stored as a fresh save.
    const saved = savedHeads && savedHeads.length === heads.length && heads.every((head) => savedHeads.includes(head))
      ? undefined
      : Automerge.save(document as Automerge.Doc<unknown>);
    return document.kind === 'page'
      ? { heads, ...(saved ? { saved } : {}), summary: summarizePageDocument(document as PageAutomergeDoc) }
      : { heads, ...(saved ? { saved } : {}), notebook: getSharedAutomergeSnapshot(document) as LiveNotebookDocV2 };
  } finally {
    Automerge.free(document as Automerge.Doc<unknown>);
  }
}
