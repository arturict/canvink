import * as Automerge from '@automerge/automerge';
import { amSpanToSpan } from '@automerge/prosemirror/dist/types.js';
import { Fragment, type Node as ProseMirrorNode } from 'prosemirror-model';
import { Plugin, type Transaction } from 'prosemirror-state';
import {
  TABLE_BLOCK,
  TABLE_CELL_BLOCK,
  TABLE_HEADER_BLOCK,
  TABLE_ROW_BLOCK,
} from './schema';

const TABLE_NODE_NAMES = new Set(['table', 'table_row', 'table_cell', 'table_header']);

export function createRichTextBlockId(prefix = 'block'): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function spanBlockType(span: Automerge.Span): string | null {
  const normalized = amSpanToSpan(span);
  return normalized.type === 'block' ? normalized.value.type.val : null;
}

function legacyCellMarker(span: Automerge.Span): boolean {
  const normalized = amSpanToSpan(span);
  if (normalized.type !== 'block') return false;
  const type = normalized.value.type.val;
  if (type !== TABLE_CELL_BLOCK && type !== TABLE_HEADER_BLOCK) return false;
  return normalized.value.parents.length === 2
    && normalized.value.parents.every(
      (parent, index) => parent.val === [TABLE_BLOCK, TABLE_ROW_BLOCK][index],
    );
}

function explicitBlock(
  type: string,
  parents: string[],
  blockId: string,
): Automerge.Span {
  return {
    type: 'block',
    value: {
      type: new Automerge.ImmutableString(type),
      parents: parents.map((parent) => new Automerge.ImmutableString(parent)),
      attrs: { blockId },
      isEmbed: false,
    },
  };
}

/** Adds missing table/row boundaries to pre-explicit Canvink table spans. */
export function repairLegacyTableSpans(input: Automerge.Span[]): {
  spans: Automerge.Span[];
  changed: boolean;
} {
  const spans: Automerge.Span[] = [];
  let changed = false;
  let explicitTable = false;
  let index = 0;
  while (index < input.length) {
    const span = input[index];
    const normalizedSpan = amSpanToSpan(span);
    const type = spanBlockType(span);
    if (type === TABLE_BLOCK) explicitTable = true;
    else if (normalizedSpan.type === 'block' && normalizedSpan.value.parents.length === 0) {
      explicitTable = false;
    }

    if (explicitTable || !legacyCellMarker(span)) {
      spans.push(span);
      index += 1;
      continue;
    }

    const segments: Automerge.Span[][] = [];
    while (index < input.length && legacyCellMarker(input[index])) {
      const segment: Automerge.Span[] = [input[index]];
      index += 1;
      while (index < input.length && input[index].type === 'text') {
        segment.push(input[index]);
        index += 1;
      }
      segments.push(segment);
    }
    if (segments.length === 0) continue;

    const fingerprint = segments.flatMap((segment) => segment)
      .map((item) => item.type === 'text' ? item.value : spanBlockType(item) ?? '')
      .join('|');
    const tableId = `legacy-table-${stableHash(`${spans.length}|${fingerprint}`)}`;
    let headerWidth = 0;
    while (headerWidth < segments.length && spanBlockType(segments[headerWidth][0]) === TABLE_HEADER_BLOCK) {
      headerWidth += 1;
    }
    const bodyCount = segments.length - headerWidth;
    const width = headerWidth > 0 && bodyCount > 0 && bodyCount % headerWidth === 0
      ? headerWidth
      : segments.length;

    spans.push(explicitBlock(TABLE_BLOCK, [], tableId));
    for (let start = 0, rowIndex = 0; start < segments.length; start += width, rowIndex += 1) {
      const rowId = `${tableId}-row-${rowIndex + 1}`;
      spans.push(explicitBlock(TABLE_ROW_BLOCK, [TABLE_BLOCK], rowId));
      segments.slice(start, start + width).forEach((segment, columnIndex) => {
        const marker = segment[0];
        const normalizedMarker = amSpanToSpan(marker);
        if (normalizedMarker.type !== 'block') return;
        const cellType = normalizedMarker.value.type.val === TABLE_HEADER_BLOCK
          ? TABLE_HEADER_BLOCK
          : TABLE_CELL_BLOCK;
        spans.push({
          type: 'block',
          value: {
            type: new Automerge.ImmutableString(cellType),
            parents: [TABLE_BLOCK, TABLE_ROW_BLOCK].map(
              (parent) => new Automerge.ImmutableString(parent),
            ),
            attrs: {
              ...normalizedMarker.value.attrs,
              blockId: `${rowId}-cell-${columnIndex + 1}`,
            },
            isEmbed: false,
          },
        });
        spans.push(...segment.slice(1));
      });
    }
    changed = true;
    explicitTable = true;
  }
  return { spans, changed };
}

function currentBlockId(node: ProseMirrorNode): string | null {
  return typeof node.attrs.blockId === 'string' && node.attrs.blockId.trim()
    ? node.attrs.blockId
    : null;
}

function deterministicBlockId(node: ProseMirrorNode, path: string): string {
  return `legacy-${node.type.name}-${stableHash(`${path}|${node.textContent}|${node.childCount}`)}`;
}

function inferLegacyRows(table: ProseMirrorNode): ProseMirrorNode[] {
  if (table.childCount !== 1) return table.content.content.slice();
  const row = table.firstChild;
  if (!row || row.attrs.isAmgBlock === true || row.childCount < 2) {
    return table.content.content.slice();
  }

  let headerWidth = 0;
  while (headerWidth < row.childCount && row.child(headerWidth).type.name === 'table_header') {
    headerWidth += 1;
  }
  const bodyCellCount = row.childCount - headerWidth;
  if (headerWidth === 0 || bodyCellCount === 0 || bodyCellCount % headerWidth !== 0) {
    return table.content.content.slice();
  }

  const rows: ProseMirrorNode[] = [];
  rows.push(row.type.create(row.attrs, Fragment.fromArray(row.content.content.slice(0, headerWidth))));
  for (let start = headerWidth; start < row.childCount; start += headerWidth) {
    rows.push(row.type.create(
      { ...row.attrs, blockId: '', isAmgBlock: false },
      Fragment.fromArray(row.content.content.slice(start, start + headerWidth)),
    ));
  }
  return rows;
}

function normalizeTable(table: ProseMirrorNode, path: string): ProseMirrorNode {
  const tableId = currentBlockId(table) ?? deterministicBlockId(table, path);
  const usedIds = new Set<string>([tableId]);
  const rows = inferLegacyRows(table).map((row, rowIndex) => {
    let rowId = currentBlockId(row) ?? deterministicBlockId(row, `${path}/row-${rowIndex}`);
    if (usedIds.has(rowId)) rowId = `${rowId}-${rowIndex + 1}`;
    usedIds.add(rowId);
    const cells = row.content.content.map((cell, columnIndex) => {
      let cellId = currentBlockId(cell)
        ?? deterministicBlockId(cell, `${path}/row-${rowIndex}/cell-${columnIndex}`);
      if (usedIds.has(cellId)) cellId = `${cellId}-${columnIndex + 1}`;
      usedIds.add(cellId);
      return cell.type.create(
        { ...cell.attrs, blockId: cellId, isAmgBlock: true },
        cell.content,
        cell.marks,
      );
    });
    return row.type.create(
      { ...row.attrs, blockId: rowId, isAmgBlock: true },
      Fragment.fromArray(cells),
      row.marks,
    );
  });
  return table.type.create(
    { ...table.attrs, blockId: tableId, isAmgBlock: true },
    Fragment.fromArray(rows),
    table.marks,
  );
}

function normalizeNode(node: ProseMirrorNode, path: string): ProseMirrorNode {
  if (node.type.name === 'table') return normalizeTable(node, path);
  if (node.isLeaf) return node;
  let changed = false;
  const children = node.content.content.map((child, index) => {
    const normalized = normalizeNode(child, `${path}/${child.type.name}-${index}`);
    if (normalized !== child) changed = true;
    return normalized;
  });
  return changed ? node.copy(Fragment.fromArray(children)) : node;
}

/**
 * Repairs legacy table spans before an editor is mounted. Header-first legacy
 * tables are split deterministically using their header width; truly
 * ambiguous all-body-cell tables retain every cell in one row. The next write
 * persists explicit table, row, and cell markers so the repair runs once.
 */
export function normalizePersistentTables(doc: ProseMirrorNode): {
  doc: ProseMirrorNode;
  changed: boolean;
} {
  const normalized = normalizeNode(doc, 'doc');
  return { doc: normalized, changed: !normalized.eq(doc) };
}

function addMissingTableIdentities(transaction: Transaction): boolean {
  const seen = new Set<string>();
  let changed = false;
  transaction.doc.descendants((node, position) => {
    if (!TABLE_NODE_NAMES.has(node.type.name)) return true;
    const existing = currentBlockId(node);
    const blockId = existing && !seen.has(existing)
      ? existing
      : createRichTextBlockId(node.type.name);
    seen.add(blockId);
    if (node.attrs.isAmgBlock === true && existing === blockId) return true;
    transaction.setNodeMarkup(position, node.type, {
      ...node.attrs,
      blockId,
      isAmgBlock: true,
    }, node.marks);
    changed = true;
    return true;
  });
  return changed;
}

/** Ensures pasted and prosemirror-tables-created nodes become explicit blocks. */
export function richTextTableIdentityPlugin(): Plugin {
  return new Plugin({
    appendTransaction: (transactions, _oldState, newState) => {
      if (!transactions.some((transaction) => transaction.docChanged)) return null;
      const transaction = newState.tr;
      if (!addMissingTableIdentities(transaction)) return null;
      transaction.setMeta('addToHistory', false);
      return transaction;
    },
  });
}
