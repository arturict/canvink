import { projectLiveRichText, type LivePageDocV2, type PageAutomergeDoc } from '../crdt';
import type { RichTextDocument } from '../domain/v2';
import type { Rect } from '../editor/operations/geometry';

/**
 * The "Gliederung" of a long page: its headings, PDF printout pages and
 * pictures from top to bottom, so a long page can be jumped through. A page
 * without headings lists its text boxes by their first line instead.
 */

export type OutlineItem =
  | { kind: 'heading'; level: number; text: string; frame: Rect }
  | { kind: 'text'; text: string; frame: Rect }
  | { kind: 'pdf'; page: number; frame: Rect }
  | { kind: 'image'; frame: Rect };

const MAX_ITEMS = 80;
const MAX_TEXT = 90;

function plain(spans: ReadonlyArray<{ text: string }>): string {
  return spans.map((span) => span.text).join('').replace(/\s+/g, ' ').trim();
}

function clip(text: string): string {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text;
}

export function pageOutline(
  page: Pick<LivePageDocV2, 'elementsById' | 'zOrder'>,
  readText: (elementId: string) => RichTextDocument | null,
): OutlineItem[] {
  const elements = page.zOrder
    .map((id) => page.elementsById[id])
    .filter((element) => element && element.kind !== 'stroke')
    .sort((left, right) => left.frame.y - right.frame.y || left.frame.x - right.frame.x);
  const headings: OutlineItem[] = [];
  const texts: OutlineItem[] = [];
  const media: OutlineItem[] = [];
  for (const element of elements) {
    const frame = { x: element.frame.x, y: element.frame.y, width: element.frame.width, height: element.frame.height };
    if (element.kind === 'richText') {
      const content = readText(element.id);
      if (!content) continue;
      let first = '';
      for (const block of content.blocks) {
        if (block.type === 'table') continue;
        const text = plain(block.spans);
        if (!text) continue;
        if (block.type === 'heading' && (block.level ?? 1) <= 3) {
          headings.push({ kind: 'heading', level: block.level ?? 1, text: clip(text), frame });
        }
        first ||= text;
      }
      if (first) texts.push({ kind: 'text', text: clip(first), frame });
    } else if (element.kind === 'pdf') {
      media.push({ kind: 'pdf', page: element.sourcePageNumber ?? 1, frame });
    } else if (element.kind === 'image') {
      media.push({ kind: 'image', frame });
    }
  }
  const items = [...(headings.length > 0 ? headings : texts), ...media]
    .sort((left, right) => left.frame.y - right.frame.y || left.frame.x - right.frame.x);
  return items.slice(0, MAX_ITEMS);
}

/** Reads the rich text of a page's text box from its document, or null when it cannot. */
export function richTextReader(document: PageAutomergeDoc): (elementId: string) => RichTextDocument | null {
  return (elementId) => {
    try {
      return projectLiveRichText(document, elementId);
    } catch {
      return null;
    }
  };
}
