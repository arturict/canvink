import { describe, expect, it } from 'vitest';
import { pmDocFromSpans, pmNodeToSpans } from '@automerge/prosemirror';
import type { RichTextDocument } from '../../domain/v2/types';
import {
  portableProjectionToProseMirror,
  portableToProseMirror,
  proseMirrorToMarkdown,
  proseMirrorToPlainText,
  proseMirrorToPortable,
  proseMirrorToPortableProjection,
  proseMirrorToSearchProjection,
} from './projections';
import { canvinkRichTextSchema as schema, canvinkSchemaAdapter } from './schema';

const portable: RichTextDocument = {
  type: 'doc',
  blocks: [
    {
      id: 'heading-1',
      type: 'heading',
      level: 2,
      spans: [{ text: 'Mechanics', marks: [{ type: 'bold' }] }],
    },
    {
      id: 'list-1',
      type: 'paragraph',
      list: 'bullet',
      spans: [{ text: 'Draw force diagram', marks: [] }],
    },
    {
      id: 'check-1',
      type: 'checkItem',
      checked: true,
      spans: [{ text: 'Submit worksheet', marks: [{ type: 'strike' }] }],
    },
    {
      id: 'table-1',
      type: 'table',
      rows: [
        [[{ text: 't', marks: [{ type: 'inlineCode' }] }], [{ text: 'v', marks: [] }]],
        [[{ text: '1', marks: [] }], [{ text: '5', marks: [] }]],
      ],
    },
  ],
};

const portableTable = portable.blocks[3];
if (portableTable.type !== 'table') throw new Error('Expected table fixture.');

describe('rich-text projections', () => {
  it('round trips the portable v2 model including checklists and tables', () => {
    const doc = portableToProseMirror(portable);
    const persisted = pmDocFromSpans(
      canvinkSchemaAdapter,
      pmNodeToSpans(canvinkSchemaAdapter, doc),
    );
    const restored = proseMirrorToPortable(persisted);

    expect(restored.blocks.map((block) => block.type)).toEqual([
      'heading',
      'paragraph',
      'checkItem',
      'table',
    ]);
    expect(restored.blocks[0]).toMatchObject({ type: 'heading', level: 2 });
    expect(restored.blocks[0].id).toBe('heading-1');
    expect(restored.blocks[1]).toMatchObject({ id: 'list-1', type: 'paragraph', list: 'bullet' });
    expect(restored.blocks[2]).toMatchObject({ id: 'check-1', type: 'checkItem', checked: true });
    expect(restored.blocks[3]).toMatchObject({ id: 'table-1', type: 'table', rows: portableTable.rows });
    const table = persisted.children.find((node) => node.type.name === 'table');
    expect(table?.childCount).toBe(2);
    expect(table?.firstChild?.childCount).toBe(2);
  });

  it('creates readable plain-text, Markdown, and normalized search projections', () => {
    const doc = portableToProseMirror(portable);
    expect(proseMirrorToPlainText(doc)).toContain('Draw force diagram');
    expect(proseMirrorToMarkdown(doc)).toContain('## **Mechanics**');
    expect(proseMirrorToMarkdown(doc)).toContain('- [x] ~~Submit worksheet~~');
    expect(proseMirrorToMarkdown(doc)).toContain('| `t` | v |');
    expect(proseMirrorToSearchProjection(doc)).toBe(
      'Mechanics Draw force diagram Submit worksheet t v 1 5',
    );
  });

  it('keeps unknown top-level PM blocks in a portable sidecar', () => {
    const unknown = schema.nodes.unknown_block.create(
      {
        unknownBlock: {
          type: { val: '__ext__future' },
          parents: [],
          attrs: { future: true },
          isEmbed: false,
        },
      },
      schema.nodes.paragraph.create(null, schema.text('Future content')),
    );
    const doc = schema.nodes.doc.create(null, [unknown, schema.nodes.paragraph.create()]);
    const projection = proseMirrorToPortableProjection(doc);

    expect(projection.unknownBlocks).toHaveLength(1);
    const restored = portableProjectionToProseMirror(projection);
    expect(restored.child(0).type.name).toBe('unknown_block');
    expect(restored.child(0).textContent).toBe('Future content');
  });
});
