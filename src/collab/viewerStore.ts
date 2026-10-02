/**
 * Read-only projection of a room session's doc set for the viewer surface.
 * Reads the notebook doc's `sections[].pageDocumentIds` to resolve page
 * titles; never mutates anything in the session's Automerge doc set.
 */

import type * as Automerge from '@automerge/automerge';
import type { RoomSession } from './session';

export interface ViewerPageRef {
  docId: string;
  pageId: string;
  title: string;
}

export interface ViewerSection {
  id: string;
  title: string;
  pages: ViewerPageRef[];
}

export interface NotebookView {
  title: string;
  sections: ViewerSection[];
}

interface MinimalNotebookDoc {
  kind: 'notebook';
  title: string;
  sections: Array<{ id: string; title: string; pageDocumentIds: string[] }>;
}

interface MinimalPageDoc {
  kind: 'page';
  pageId: string;
  title: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isMinimalNotebookDoc(value: unknown): value is MinimalNotebookDoc {
  if (!isRecord(value) || value.kind !== 'notebook' || typeof value.title !== 'string') return false;
  if (!Array.isArray(value.sections)) return false;
  return value.sections.every((section) =>
    isRecord(section)
    && typeof section.id === 'string'
    && typeof section.title === 'string'
    && Array.isArray(section.pageDocumentIds)
    && section.pageDocumentIds.every((id) => typeof id === 'string'));
}

function isMinimalPageDoc(value: unknown): value is MinimalPageDoc {
  return isRecord(value)
    && value.kind === 'page'
    && typeof value.pageId === 'string'
    && typeof value.title === 'string';
}

export interface ViewerStore {
  getNotebookView(): NotebookView | undefined;
  getPageDoc(docId: string): Automerge.Doc<unknown> | undefined;
}

export function createViewerStore(session: RoomSession): ViewerStore {
  return {
    getNotebookView: () => {
      const docs = session.getDocs();
      let notebookDoc: unknown;
      for (const entry of docs.values()) {
        if (entry.kind === 'notebook' && entry.doc !== undefined) {
          notebookDoc = entry.doc;
          break;
        }
      }
      if (!isMinimalNotebookDoc(notebookDoc)) return undefined;
      const sections: ViewerSection[] = notebookDoc.sections.map((section) => ({
        id: section.id,
        title: section.title,
        pages: section.pageDocumentIds.flatMap((docId): ViewerPageRef[] => {
          const pageDoc = docs.get(docId)?.doc;
          if (!isMinimalPageDoc(pageDoc)) return [];
          return [{ docId, pageId: pageDoc.pageId, title: pageDoc.title }];
        }),
      }));
      return { title: notebookDoc.title, sections };
    },
    getPageDoc: (docId) => session.getDoc(docId),
  };
}
