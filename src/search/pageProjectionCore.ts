import * as Automerge from '@automerge/automerge';
import type { PageAutomergeDoc } from '../crdt/types';
import type { PageProjectionRequest, PageProjectionResponse } from './pageProjector';
import { searchablePage } from './searchablePage';

/**
 * Loads one page document from its stored bytes, returns its searchable part
 * and frees the document again. Runs in the page projection worker.
 */
export function projectStoredPage({ id, documentId, bytes }: PageProjectionRequest): PageProjectionResponse {
  let document: Automerge.Doc<unknown> | undefined;
  try {
    document = Automerge.load(bytes);
    const page = document as PageAutomergeDoc;
    if (page.kind !== 'page' || page.documentId !== documentId) {
      throw new Error(`Stored bytes are not page document ${documentId}.`);
    }
    const { page: searchable, pdfRequests } = searchablePage(page);
    return { id, ok: true, page: searchable, pdfRequests, heads: [...Automerge.getHeads(document)] };
  } catch (error) {
    return { id, ok: false, message: error instanceof Error ? error.message : String(error) };
  } finally {
    if (document) Automerge.free(document);
  }
}
