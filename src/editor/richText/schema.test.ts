import * as Automerge from '@automerge/automerge';
import { pmDocFromSpans, pmNodeToSpans } from '@automerge/prosemirror';
import { describe, expect, it } from 'vitest';
import type { Mark } from 'prosemirror-model';
import {
  CHECK_ITEM_BLOCK,
  INLINE_CODE_MARK,
  STRIKE_MARK,
  TABLE_BLOCK,
  TABLE_CELL_BLOCK,
  TABLE_HEADER_BLOCK,
  TABLE_ROW_BLOCK,
  UNDERLINE_MARK,
  canvinkRichTextSchema as schema,
  canvinkSchemaAdapter,
  safeLink,
} from './schema';
import { proseMirrorToPortable } from './projections';
import { normalizePersistentTables } from './tablePersistence';

function markedText(text: string, marks: Mark[] = []) {
  return schema.text(text, marks);
}

describe('Canvink Automerge ProseMirror schema adapter', () => {
  it('round trips headings, paragraphs, lists, and standard marks', () => {
    const doc = schema.nodes.doc.create(null, [
      schema.nodes.heading.create(
        { level: 2 },
        markedText('School notes', [schema.marks.strong.create()]),
      ),
      schema.nodes.paragraph.create(
        null,
        markedText('Physics', [schema.marks.em.create()]),
      ),
      schema.nodes.bullet_list.create(null, [
        schema.nodes.list_item.create(
          null,
          schema.nodes.paragraph.create(null, markedText('Vectors')),
        ),
      ]),
    ]);

    const spans = pmNodeToSpans(canvinkSchemaAdapter, doc);
    const restored = pmDocFromSpans(canvinkSchemaAdapter, spans);

    expect(proseMirrorToPortable(restored)).toEqual(proseMirrorToPortable(doc));
    expect(restored.child(0).attrs.level).toBe(2);
    expect(restored.child(2).type.name).toBe('bullet_list');
  });

  it('uses exact __ext__ mark names through PM to Automerge and back', () => {
    expect([INLINE_CODE_MARK, UNDERLINE_MARK, STRIKE_MARK]).toEqual([
      '__ext__canvink_inline-code',
      '__ext__canvink_underline',
      '__ext__canvink_strike',
    ]);
    const marks = [INLINE_CODE_MARK, UNDERLINE_MARK, STRIKE_MARK].map((name) =>
      schema.marks[name].create(),
    );
    const doc = schema.nodes.doc.create(null, [
      schema.nodes.paragraph.create(null, markedText('x = 42', marks)),
    ]);

    const spans = pmNodeToSpans(canvinkSchemaAdapter, doc);
    const textSpan = spans.find((span) => span.type === 'text');
    expect(textSpan?.type).toBe('text');
    if (textSpan?.type !== 'text') throw new Error('Expected text span.');
    expect(textSpan.marks).toEqual({
      [INLINE_CODE_MARK]: true,
      [UNDERLINE_MARK]: true,
      [STRIKE_MARK]: true,
    });

    const restored = pmDocFromSpans(canvinkSchemaAdapter, spans);
    expect(restored.firstChild?.firstChild?.marks.map((mark) => mark.type.name)).toEqual(
      expect.arrayContaining([INLINE_CODE_MARK, UNDERLINE_MARK, STRIKE_MARK]),
    );
  });

  it('round trips checklist attributes and table hierarchy', () => {
    expect([
      CHECK_ITEM_BLOCK,
      TABLE_BLOCK,
      TABLE_ROW_BLOCK,
      TABLE_CELL_BLOCK,
      TABLE_HEADER_BLOCK,
    ]).toEqual([
      '__ext__canvink_check-item',
      '__ext__canvink_table',
      '__ext__canvink_table-row',
      '__ext__canvink_table-cell',
      '__ext__canvink_table-header',
    ]);
    const paragraph = schema.nodes.paragraph.create(null, markedText('Value'));
    const table = schema.nodes.table.create(null, [
      schema.nodes.table_row.create(null, [
        schema.nodes.table_header.create(null, paragraph),
        schema.nodes.table_header.create(null, paragraph),
      ]),
      schema.nodes.table_row.create(null, [
        schema.nodes.table_cell.create(null, paragraph),
        schema.nodes.table_cell.create(null, paragraph),
      ]),
    ]);
    const doc = schema.nodes.doc.create(null, [
      schema.nodes.check_item.create(
        { checked: true, blockId: 'check-physics-1' },
        markedText('Finish worksheet'),
      ),
      table,
    ]);

    const spans = pmNodeToSpans(canvinkSchemaAdapter, doc);
    const blockNames = spans
      .filter((span) => span.type === 'block')
      .map((span) => span.value.type.val);
    expect(blockNames).toEqual(
      expect.arrayContaining([CHECK_ITEM_BLOCK, TABLE_CELL_BLOCK, TABLE_HEADER_BLOCK]),
    );
    const tableCell = spans.find(
      (span) => span.type === 'block' && span.value.type.val === TABLE_CELL_BLOCK,
    );
    if (tableCell?.type !== 'block') throw new Error('Expected table cell block.');
    expect(tableCell.value.parents.map((parent) => parent.val)).toEqual([
      TABLE_BLOCK,
      TABLE_ROW_BLOCK,
    ]);

    const legacyRestored = pmDocFromSpans(canvinkSchemaAdapter, spans);
    const normalized = normalizePersistentTables(legacyRestored);
    expect(normalized.changed).toBe(true);
    const canonicalSpans = pmNodeToSpans(canvinkSchemaAdapter, normalized.doc);
    const canonicalBlockNames = canonicalSpans
      .filter((span) => span.type === 'block')
      .map((span) => span.value.type.val);
    expect(canonicalBlockNames.filter((name) => name === TABLE_BLOCK)).toHaveLength(1);
    expect(canonicalBlockNames.filter((name) => name === TABLE_ROW_BLOCK)).toHaveLength(2);
    expect(canonicalBlockNames.filter((name) => (
      name === TABLE_CELL_BLOCK || name === TABLE_HEADER_BLOCK
    ))).toHaveLength(4);

    const restored = pmDocFromSpans(canvinkSchemaAdapter, canonicalSpans);
    expect(restored.child(0).attrs).toMatchObject({ checked: true, blockId: 'check-physics-1' });
    expect(restored.child(1).type.name).toBe('table');
    expect(restored.child(1).childCount).toBe(2);
    expect(restored.child(1).child(1).childCount).toBe(2);
    expect(restored.child(1).child(0).child(0).type.name).toBe('table_header');
  });

  it('preserves unknown blocks and attributes instead of flattening them', () => {
    const spans: Automerge.Span[] = [
      {
        type: 'block',
        value: {
          type: new Automerge.ImmutableString('__ext__future-diagram'),
          parents: [],
          attrs: { version: 7, vendor: new Automerge.ImmutableString('future-app') },
          isEmbed: false,
        },
      },
      { type: 'text', value: 'Preserve me' },
    ];

    const doc = pmDocFromSpans(canvinkSchemaAdapter, spans);
    expect(doc.firstChild?.type.name).toBe('unknown_block');
    const roundTrip = pmNodeToSpans(canvinkSchemaAdapter, doc);
    const unknown = roundTrip.find((span) => span.type === 'block');
    if (unknown?.type !== 'block') throw new Error('Expected unknown block.');
    expect(unknown.value.type.val).toBe('__ext__future-diagram');
    expect(unknown.value.attrs.version).toBe(7);
  });

  it('preserves unknown attributes on explicit table, row, and cell blocks', () => {
    const paragraph = schema.nodes.paragraph.create(null, schema.text('Future cell'));
    const cell = schema.nodes.table_cell.create(
      {
        blockId: 'cell-future',
        isAmgBlock: true,
        unknownAttrs: { futureCell: new Automerge.ImmutableString('cell-value') },
      },
      paragraph,
    );
    const row = schema.nodes.table_row.create(
      {
        blockId: 'row-future',
        isAmgBlock: true,
        unknownAttrs: { futureRow: 7 },
      },
      cell,
    );
    const table = schema.nodes.table.create(
      {
        blockId: 'table-future',
        isAmgBlock: true,
        unknownAttrs: { futureTable: true },
      },
      row,
    );
    const spans = pmNodeToSpans(
      canvinkSchemaAdapter,
      schema.nodes.doc.create(null, table),
    );
    const restored = pmDocFromSpans(canvinkSchemaAdapter, spans).firstChild;

    expect(restored?.attrs.unknownAttrs).toMatchObject({ futureTable: true });
    expect(restored?.firstChild?.attrs.unknownAttrs).toMatchObject({ futureRow: 7 });
    expect(restored?.firstChild?.firstChild?.attrs.unknownAttrs.futureCell).toBe('cell-value');
  });

  it('rejects malicious links and materializes invalid remote links as inert marks', () => {
    expect(safeLink('javascript:alert(1)')).toBeNull();
    expect(safeLink('data:text/html,boom')).toBeNull();
    expect(safeLink('https://school.example/lesson')).toMatchObject({
      href: 'https://school.example/lesson',
    });

    const spans: Automerge.Span[] = [
      {
        type: 'text',
        value: 'unsafe',
        marks: { link: JSON.stringify({ href: 'javascript:alert(1)', title: 'bad' }) },
      },
    ];
    const doc = pmDocFromSpans(canvinkSchemaAdapter, spans);
    expect(doc.firstChild?.firstChild?.marks[0].attrs.href).toBe('');
  });
});
