import * as Automerge from '@automerge/automerge';
import { pmDocFromSpans, pmNodeToSpans } from '@automerge/prosemirror';
import type { Node as ProseMirrorNode } from 'prosemirror-model';
import type { RichTextDocument } from '../domain/v2';
import {
  portableToProseMirror,
  proseMirrorToPortable,
} from '../editor/richText/projections';
import { canvinkSchemaAdapter } from '../editor/richText/schema';
import {
  normalizePersistentTables,
  repairLegacyTableSpans,
} from '../editor/richText/tablePersistence';
import type { LivePageDocV2, PageAutomergeDoc } from './types';

export type LiveRichTextPath = ['elementsById', string, 'text'];

export function liveRichTextPath(elementId: string): LiveRichTextPath {
  if (!elementId) throw new Error('A rich-text element ID must be non-empty.');
  return ['elementsById', elementId, 'text'];
}

export function portableRichTextToSpans(content: RichTextDocument): Automerge.Span[] {
  return pmNodeToSpans(canvinkSchemaAdapter, portableToProseMirror(content));
}

export function seedPortableRichText(
  draft: LivePageDocV2,
  elementId: string,
  content: RichTextDocument,
): void {
  Automerge.updateSpans(
    draft,
    liveRichTextPath(elementId),
    portableRichTextToSpans(content),
    canvinkSchemaAdapter.updateSpansConfig(),
  );
}

export function proseMirrorFromLiveRichText(
  document: PageAutomergeDoc,
  elementId: string,
): ProseMirrorNode {
  const element = document.elementsById[elementId];
  if (!element || element.kind !== 'richText') {
    throw new Error(`Page element ${elementId} is not rich text.`);
  }
  const repaired = repairLegacyTableSpans(
    Automerge.spans(document, liveRichTextPath(elementId)),
  );
  const loaded = pmDocFromSpans(canvinkSchemaAdapter, repaired.spans);
  return normalizePersistentTables(loaded).doc;
}

export function projectLiveRichText(
  document: PageAutomergeDoc,
  elementId: string,
): RichTextDocument {
  return proseMirrorToPortable(proseMirrorFromLiveRichText(document, elementId));
}

export function assertPortableRichTextRoundTrip(
  document: PageAutomergeDoc,
  elementId: string,
  expected: RichTextDocument,
): void {
  const expectedDoc = portableToProseMirror(expected);
  const actualDoc = proseMirrorFromLiveRichText(document, elementId);
  const expectedProjection = proseMirrorToPortable(expectedDoc);
  const actualProjection = proseMirrorToPortable(actualDoc);
  if (JSON.stringify(actualProjection) !== JSON.stringify(expectedProjection)) {
    throw new Error(`Rich-text element ${elementId} failed semantic Automerge round-trip verification.`);
  }
}
