import { projectLiveRichText } from '../crdt/richText';
import type { PageAutomergeDoc } from '../crdt/types';
import type { AssetRef, RichTextElementV2 } from '../domain/v2';
import type { PageElementV3 } from '../domain/v3';
import type { SearchablePage } from './types';

export interface PdfTextRequest {
  ref: AssetRef;
  sourcePageNumber?: number;
}

/**
 * The searchable part of a live page document. Rich text is projected from
 * its Automerge spans; ink, shapes and other elements without text are left
 * out, so nothing large is copied. Runs inside `readPage` or in the page
 * projection worker: the document may be freed right after, so only detached
 * values leave this function.
 */
export function searchablePage(document: PageAutomergeDoc): { page: SearchablePage; pdfRequests: PdfTextRequest[] } {
  const elementsById: Record<string, PageElementV3> = {};
  const zOrder: string[] = [];
  const pdfRequests: PdfTextRequest[] = [];
  for (const elementId of document.zOrder) {
    const element = document.elementsById[elementId];
    if (!element) continue;
    if (element.kind === 'richText') {
      const { text: _text, ...metadata } = element;
      void _text;
      const projected: RichTextElementV2 = { ...metadata, content: projectLiveRichText(document, elementId) };
      elementsById[elementId] = projected;
    } else if (element.kind === 'math' || element.kind === 'image' || element.kind === 'attachment') {
      elementsById[elementId] = element;
    } else if (element.kind === 'pdf') {
      elementsById[elementId] = element;
      if (element.originalAsset?.mimeType === 'application/pdf') {
        pdfRequests.push({
          ref: { ...element.originalAsset },
          ...(element.sourcePageNumber ? { sourcePageNumber: element.sourcePageNumber } : {}),
        });
      }
    } else continue;
    zOrder.push(elementId);
  }
  return {
    page: {
      documentId: document.documentId,
      notebookId: document.notebookId,
      pageId: document.pageId,
      sectionId: document.sectionId,
      title: document.title,
      tags: document.tags,
      ...(document.taskState ? { taskState: document.taskState } : {}),
      updatedAt: document.updatedAt,
      ...(document.mathSettings ? { mathSettings: document.mathSettings } : {}),
      ...(document.pageContent ? { pageContent: document.pageContent } : {}),
      schemaVersion: document.schemaVersion,
      zOrder,
      elementsById,
    },
    pdfRequests,
  };
}
