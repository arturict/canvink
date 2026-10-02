import type {
  RichTextBlock,
  RichTextDocument,
  RichTextMark,
  RichTextSpan,
} from '../../domain/v2/types';
import { Fragment, type Mark, type Node as ProseMirrorNode, type Schema } from 'prosemirror-model';
import { tableNodeTypes } from 'prosemirror-tables';
import {
  INLINE_CODE_MARK,
  STRIKE_MARK,
  UNDERLINE_MARK,
  canvinkRichTextSchema,
  safeLink,
} from './schema';
import { createRichTextBlockId } from './tablePersistence';

export interface UnknownBlockSnapshot {
  /** Top-level PM block index. Unknown nested content remains inside this JSON snapshot. */
  index: number;
  json: Record<string, unknown>;
}

export interface PortableRichTextProjection {
  content: RichTextDocument;
  unknownBlocks: UnknownBlockSnapshot[];
}

function portableMark(mark: Mark): RichTextMark | null {
  if (mark.type.name === 'strong') return { type: 'bold' };
  if (mark.type.name === 'em') return { type: 'italic' };
  if (mark.type.name === INLINE_CODE_MARK) return { type: 'inlineCode' };
  if (mark.type.name === UNDERLINE_MARK) return { type: 'underline' };
  if (mark.type.name === STRIKE_MARK) return { type: 'strike' };
  if (mark.type.name === 'link') {
    const link = safeLink(mark.attrs.href, mark.attrs.title);
    return link ? { type: 'link', href: link.href } : null;
  }
  return null;
}

function sameMarks(left: RichTextMark[], right: RichTextMark[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function spansFromNode(node: ProseMirrorNode): RichTextSpan[] {
  const spans: RichTextSpan[] = [];
  node.descendants((child) => {
    if (!child.isText || !child.text) return;
    const marks = child.marks
      .map(portableMark)
      .filter((mark): mark is RichTextMark => mark !== null);
    const previous = spans.at(-1);
    if (previous && sameMarks(previous.marks, marks)) {
      previous.text += child.text;
    } else {
      spans.push({ text: child.text, marks });
    }
  });
  return spans;
}

function listBlocks(node: ProseMirrorNode, style: 'bullet' | 'ordered'): RichTextBlock[] {
  const blocks: RichTextBlock[] = [];
  node.forEach((item) => {
    const first = item.firstChild;
    if (first) {
      blocks.push({
        id: String(
          first.attrs.blockId
          || item.attrs.blockId
          || item.attrs.unknownAttrs?.blockId
          || `list-${blocks.length}`,
        ),
        type: 'paragraph',
        list: style,
        spans: spansFromNode(first),
      });
    }
    item.forEach((child, _offset, index) => {
      if (index === 0) return;
      if (child.type.name === 'bullet_list') blocks.push(...listBlocks(child, 'bullet'));
      if (child.type.name === 'ordered_list') blocks.push(...listBlocks(child, 'ordered'));
    });
  });
  return blocks;
}

function tableBlock(node: ProseMirrorNode, id: string): Extract<RichTextBlock, { type: 'table' }> {
  const rows: RichTextSpan[][][] = [];
  node.forEach((row) => {
    const cells: RichTextSpan[][] = [];
    row.forEach((cell) => cells.push(spansFromNode(cell)));
    rows.push(cells);
  });
  return { id, type: 'table', rows };
}

export function proseMirrorToPortableProjection(
  doc: ProseMirrorNode,
): PortableRichTextProjection {
  const blocks: RichTextBlock[] = [];
  const unknownBlocks: UnknownBlockSnapshot[] = [];

  doc.forEach((node, _offset, index) => {
    if (node.type.name === 'paragraph') {
      blocks.push({ id: String(node.attrs.blockId || `paragraph-${index}`), type: 'paragraph', spans: spansFromNode(node) });
    } else if (node.type.name === 'heading') {
      blocks.push({
        id: String(node.attrs.blockId || `heading-${index}`),
        type: 'heading',
        level: Math.min(6, Math.max(1, Number(node.attrs.level) || 1)) as 1 | 2 | 3 | 4 | 5 | 6,
        spans: spansFromNode(node),
      });
    } else if (node.type.name === 'bullet_list') {
      blocks.push(...listBlocks(node, 'bullet'));
    } else if (node.type.name === 'ordered_list') {
      blocks.push(...listBlocks(node, 'ordered'));
    } else if (node.type.name === 'check_item') {
      blocks.push({
        id: String(node.attrs.blockId || `check-${index}`),
        type: 'checkItem',
        checked: node.attrs.checked === true,
        spans: spansFromNode(node),
      });
    } else if (node.type.name === 'table') {
      blocks.push(tableBlock(node, String(node.attrs.blockId || `table-${index}`)));
    } else if (node.type.name === 'unknown_block') {
      const json: unknown = node.toJSON();
      if (typeof json === 'object' && json !== null) {
        unknownBlocks.push({ index, json: { ...json } });
      }
    }
  });

  return { content: { type: 'doc', blocks }, unknownBlocks };
}

export function proseMirrorToPortable(doc: ProseMirrorNode): RichTextDocument {
  return proseMirrorToPortableProjection(doc).content;
}

function marksFromPortable(schema: Schema, marks: RichTextMark[]): Mark[] {
  const result: Mark[] = [];
  marks.forEach((mark) => {
    if (mark.type === 'bold') result.push(schema.marks.strong.create());
    if (mark.type === 'italic') result.push(schema.marks.em.create());
    if (mark.type === 'inlineCode') result.push(schema.marks[INLINE_CODE_MARK].create());
    if (mark.type === 'underline') result.push(schema.marks[UNDERLINE_MARK].create());
    if (mark.type === 'strike') result.push(schema.marks[STRIKE_MARK].create());
    if (mark.type === 'link') {
      const link = safeLink(mark.href);
      if (link) result.push(schema.marks.link.create(link));
    }
  });
  return result;
}

function inlineFromSpans(schema: Schema, spans: RichTextSpan[]): ProseMirrorNode[] {
  return spans
    .filter((span) => span.text.length > 0)
    .map((span) => schema.text(span.text, marksFromPortable(schema, span.marks)));
}

function tableFromPortable(
  schema: Schema,
  block: Extract<RichTextBlock, { type: 'table' }>,
): ProseMirrorNode {
  const types = tableNodeTypes(schema);
  const rows = block.rows.length ? block.rows : [[[]]];
  const width = Math.max(1, ...rows.map((row) => row.length));
  const rowNodes = rows.map((row) =>
    types.row.create(
      { blockId: createRichTextBlockId('table-row'), isAmgBlock: true },
      Array.from({ length: width }, (_, column) =>
        types.cell.create(
          { blockId: createRichTextBlockId('table-cell'), isAmgBlock: true },
          schema.nodes.paragraph.create(null, inlineFromSpans(schema, row[column] ?? [])),
        ),
      ),
    ),
  );
  return types.table.create({ blockId: block.id, isAmgBlock: true }, rowNodes);
}

function simpleBlock(schema: Schema, block: RichTextBlock): ProseMirrorNode {
  if (block.type === 'heading') {
    return schema.nodes.heading.create(
      { level: block.level ?? 1, blockId: block.id, isAmgBlock: true },
      inlineFromSpans(schema, block.spans),
    );
  }
  if (block.type === 'checkItem') {
    return schema.nodes.check_item.create(
      { checked: block.checked, blockId: block.id, isAmgBlock: true },
      inlineFromSpans(schema, block.spans),
    );
  }
  if (block.type === 'table') return tableFromPortable(schema, block);
  return schema.nodes.paragraph.create(
    { blockId: block.id, isAmgBlock: true },
    inlineFromSpans(schema, block.spans),
  );
}

export function portableToProseMirror(
  portable: RichTextDocument,
  schema = canvinkRichTextSchema,
): ProseMirrorNode {
  const children: ProseMirrorNode[] = [];
  let index = 0;
  while (index < portable.blocks.length) {
    const block = portable.blocks[index];
    if (
      block.type === 'paragraph' &&
      (block.list === 'bullet' || block.list === 'ordered')
    ) {
      const style = block.list;
      const items: ProseMirrorNode[] = [];
      while (index < portable.blocks.length) {
        const candidate = portable.blocks[index];
        if (candidate.type !== 'paragraph' || candidate.list !== style) break;
        items.push(
          schema.nodes.list_item.create(
            { isAmgBlock: true, unknownAttrs: { blockId: candidate.id } },
            schema.nodes.paragraph.create(
              { blockId: candidate.id },
              inlineFromSpans(schema, candidate.spans),
            ),
          ),
        );
        index += 1;
      }
      children.push(
        schema.nodes[style === 'bullet' ? 'bullet_list' : 'ordered_list'].create(null, items),
      );
      continue;
    }
    children.push(simpleBlock(schema, block));
    index += 1;
  }
  return schema.nodes.doc.create(null, children.length ? children : [schema.nodes.paragraph.create()]);
}

export function portableProjectionToProseMirror(
  projection: PortableRichTextProjection,
  schema = canvinkRichTextSchema,
): ProseMirrorNode {
  let children = portableToProseMirror(projection.content, schema).content.content.slice();
  for (const snapshot of [...projection.unknownBlocks].sort((a, b) => a.index - b.index)) {
    const restored = schema.nodeFromJSON(snapshot.json);
    const at = Math.min(children.length, Math.max(0, snapshot.index));
    children = [...children.slice(0, at), restored, ...children.slice(at)];
  }
  return schema.nodes.doc.create(null, Fragment.from(children));
}

export function proseMirrorToPlainText(doc: ProseMirrorNode): string {
  return doc.textBetween(0, doc.content.size, '\n', '');
}

function markdownText(spans: RichTextSpan[]): string {
  return spans
    .map((span) => {
      let text = span.text.replaceAll('\\', '\\\\').replace(/([*_`[\]])/g, '\\$1');
      for (const mark of span.marks) {
        if (mark.type === 'inlineCode') text = `\`${text.replaceAll('`', '\\`')}\``;
        if (mark.type === 'bold') text = `**${text}**`;
        if (mark.type === 'italic') text = `_${text}_`;
        if (mark.type === 'strike') text = `~~${text}~~`;
        if (mark.type === 'underline') text = `<u>${text}</u>`;
        if (mark.type === 'link' && mark.href && safeLink(mark.href)) text = `[${text}](${mark.href})`;
      }
      return text;
    })
    .join('');
}

export function portableToMarkdown(portable: RichTextDocument): string {
  const lines: string[] = [];
  portable.blocks.forEach((block) => {
    if (block.type === 'heading') {
      lines.push(`${'#'.repeat(block.level ?? 1)} ${markdownText(block.spans)}`);
    } else if (block.type === 'checkItem') {
      lines.push(`- [${block.checked ? 'x' : ' '}] ${markdownText(block.spans)}`);
    } else if (block.type === 'table') {
      const rows = block.rows.map((row) => row.map(markdownText));
      const width = Math.max(1, ...rows.map((row) => row.length));
      const normalized = rows.map((row) => Array.from({ length: width }, (_, index) => row[index] ?? ''));
      const first = normalized[0] ?? Array.from({ length: width }, () => '');
      lines.push(`| ${first.join(' | ')} |`);
      lines.push(`| ${Array.from({ length: width }, () => '---').join(' | ')} |`);
      normalized.slice(1).forEach((row) => lines.push(`| ${row.join(' | ')} |`));
    } else {
      const prefix = block.list === 'bullet' ? '- ' : block.list === 'ordered' ? '1. ' : '';
      lines.push(`${prefix}${markdownText(block.spans)}`);
    }
  });
  return lines.join('\n\n').trim();
}

export function proseMirrorToMarkdown(doc: ProseMirrorNode): string {
  return portableToMarkdown(proseMirrorToPortable(doc));
}

export function proseMirrorToSearchProjection(doc: ProseMirrorNode): string {
  return proseMirrorToPlainText(doc).normalize('NFKC').replace(/\s+/g, ' ').trim();
}
