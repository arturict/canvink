import { SchemaAdapter, type MappedNodeSpec, type MappedSchemaSpec } from '@automerge/prosemirror';
import type { Mark, Node as ProseMirrorNode } from 'prosemirror-model';
import { tableNodes } from 'prosemirror-tables';

export const INLINE_CODE_MARK = '__ext__canvink_inline-code' as const;
export const UNDERLINE_MARK = '__ext__canvink_underline' as const;
export const STRIKE_MARK = '__ext__canvink_strike' as const;
export const CHECK_ITEM_BLOCK = '__ext__canvink_check-item' as const;
export const TABLE_BLOCK = '__ext__canvink_table' as const;
export const TABLE_ROW_BLOCK = '__ext__canvink_table-row' as const;
export const TABLE_CELL_BLOCK = '__ext__canvink_table-cell' as const;
export const TABLE_HEADER_BLOCK = '__ext__canvink_table-header' as const;

const MAX_LINK_LENGTH = 2_048;
const MAX_LINK_TITLE_LENGTH = 1_024;

export interface SafeLink {
  href: string;
  title: string | null;
}

export function safeLink(href: unknown, title: unknown = null): SafeLink | null {
  if (typeof href !== 'string') return null;
  const trimmed = href.trim();
  if (!trimmed || trimmed.length > MAX_LINK_LENGTH) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:' && parsed.protocol !== 'mailto:') {
    return null;
  }

  return {
    href: parsed.href,
    title:
      typeof title === 'string' && title.length <= MAX_LINK_TITLE_LENGTH
        ? title
        : null,
  };
}

function linkFromAutomerge(value: unknown): SafeLink {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === 'object' && parsed !== null) {
        const record = parsed as Record<string, unknown>;
        return safeLink(record.href, record.title) ?? { href: '', title: null };
      }
    } catch {
      // Invalid external marks remain visible as text without a clickable target.
    }
  }
  return { href: '', title: null };
}

function linkToAutomerge(mark: Mark): string {
  const parsed = safeLink(mark.attrs.href, mark.attrs.title);
  if (!parsed) throw new Error('Canvink refused an unsafe or malformed link.');
  return JSON.stringify(parsed);
}

function boundedHeadingLevel(value: unknown): 1 | 2 | 3 | 4 | 5 | 6 {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 6
    ? (value as 1 | 2 | 3 | 4 | 5 | 6)
    : 1;
}

function cellAttrsFromProseMirror(node: ProseMirrorNode) {
  const colwidth = Array.isArray(node.attrs.colwidth)
    ? node.attrs.colwidth.filter((value: unknown): value is number =>
        typeof value === 'number' && Number.isFinite(value) && value > 0,
      )
    : null;
  return {
    blockId: typeof node.attrs.blockId === 'string' ? node.attrs.blockId : '',
    colspan: Math.max(1, Number(node.attrs.colspan) || 1),
    rowspan: Math.max(1, Number(node.attrs.rowspan) || 1),
    colwidth,
  };
}

const generatedTableNodes = tableNodes({
  tableGroup: 'block',
  cellContent: 'block+',
  cellAttributes: {},
});

const mappedTableNodes: Record<string, MappedNodeSpec> = {
  table: {
    ...generatedTableNodes.table,
    attrs: { ...generatedTableNodes.table.attrs, blockId: { default: '' } },
    automerge: {
      block: TABLE_BLOCK,
      attrParsers: {
        fromAutomerge: (block) => ({
          blockId: typeof block.attrs.blockId === 'string' ? block.attrs.blockId : '',
        }),
        fromProsemirror: (node) => ({
          blockId: typeof node.attrs.blockId === 'string' ? node.attrs.blockId : '',
        }),
      },
    },
  },
  table_row: {
    ...generatedTableNodes.table_row,
    attrs: { ...generatedTableNodes.table_row.attrs, blockId: { default: '' } },
    automerge: {
      block: TABLE_ROW_BLOCK,
      attrParsers: {
        fromAutomerge: (block) => ({
          blockId: typeof block.attrs.blockId === 'string' ? block.attrs.blockId : '',
        }),
        fromProsemirror: (node) => ({
          blockId: typeof node.attrs.blockId === 'string' ? node.attrs.blockId : '',
        }),
      },
    },
  },
  table_cell: {
    ...generatedTableNodes.table_cell,
    attrs: { ...generatedTableNodes.table_cell.attrs, blockId: { default: '' } },
    automerge: {
      block: TABLE_CELL_BLOCK,
      attrParsers: {
        fromAutomerge: (block) => ({
          blockId: typeof block.attrs.blockId === 'string' ? block.attrs.blockId : '',
          colspan: block.attrs.colspan,
          rowspan: block.attrs.rowspan,
          colwidth: block.attrs.colwidth,
        }),
        fromProsemirror: cellAttrsFromProseMirror,
      },
    },
  },
  table_header: {
    ...generatedTableNodes.table_header,
    attrs: { ...generatedTableNodes.table_header.attrs, blockId: { default: '' } },
    automerge: {
      block: TABLE_HEADER_BLOCK,
      attrParsers: {
        fromAutomerge: (block) => ({
          blockId: typeof block.attrs.blockId === 'string' ? block.attrs.blockId : '',
          colspan: block.attrs.colspan,
          rowspan: block.attrs.rowspan,
          colwidth: block.attrs.colwidth,
        }),
        fromProsemirror: cellAttrsFromProseMirror,
      },
    },
  },
};

export const canvinkMappedSchema: MappedSchemaSpec = {
  nodes: {
    doc: { content: 'block+' },
    paragraph: {
      automerge: {
        block: 'paragraph',
        attrParsers: {
          fromAutomerge: (block) => ({
            blockId: typeof block.attrs.blockId === 'string' ? block.attrs.blockId : '',
          }),
          fromProsemirror: (node) => ({
            blockId: typeof node.attrs.blockId === 'string' ? node.attrs.blockId : '',
          }),
        },
      },
      attrs: { blockId: { default: '' } },
      content: 'inline*',
      group: 'block',
      parseDOM: [{ tag: 'p' }],
      toDOM: () => ['p', 0],
    },
    heading: {
      automerge: {
        block: 'heading',
        attrParsers: {
          fromAutomerge: (block) => ({
            level: boundedHeadingLevel(block.attrs.level),
            blockId: typeof block.attrs.blockId === 'string' ? block.attrs.blockId : '',
          }),
          fromProsemirror: (node) => ({
            level: boundedHeadingLevel(node.attrs.level),
            blockId: typeof node.attrs.blockId === 'string' ? node.attrs.blockId : '',
          }),
        },
      },
      attrs: { level: { default: 1 }, blockId: { default: '' } },
      content: 'inline*',
      group: 'block',
      defining: true,
      parseDOM: [1, 2, 3, 4, 5, 6].map((level) => ({ tag: `h${level}`, attrs: { level } })),
      toDOM: (node) => [`h${boundedHeadingLevel(node.attrs.level)}`, 0],
    },
    ordered_list: {
      content: 'list_item+',
      group: 'block',
      attrs: { order: { default: 1 } },
      parseDOM: [{ tag: 'ol' }],
      toDOM: (node) =>
        node.attrs.order === 1 ? ['ol', 0] : ['ol', { start: node.attrs.order }, 0],
    },
    bullet_list: {
      content: 'list_item+',
      group: 'block',
      parseDOM: [{ tag: 'ul' }],
      toDOM: () => ['ul', 0],
    },
    list_item: {
      automerge: {
        block: {
          within: {
            ordered_list: 'ordered-list-item',
            bullet_list: 'unordered-list-item',
          },
        },
      },
      content: 'paragraph block*',
      defining: true,
      parseDOM: [{ tag: 'li' }],
      toDOM: () => ['li', 0],
    },
    check_item: {
      automerge: {
        block: CHECK_ITEM_BLOCK,
        attrParsers: {
          fromAutomerge: (block) => ({
            checked: block.attrs.checked === true,
            blockId: typeof block.attrs.blockId === 'string' ? block.attrs.blockId : '',
          }),
          fromProsemirror: (node) => ({
            checked: node.attrs.checked === true,
            blockId: typeof node.attrs.blockId === 'string' ? node.attrs.blockId : '',
          }),
        },
      },
      attrs: {
        checked: { default: false },
        blockId: { default: '' },
      },
      content: 'inline*',
      group: 'block',
      defining: true,
      parseDOM: [
        {
          tag: '[data-canvink-check-item]',
          getAttrs: (element) => ({
            checked: element.getAttribute('data-checked') === 'true',
            blockId: element.getAttribute('data-block-id') ?? '',
          }),
        },
      ],
      toDOM: (node) => [
        'div',
        {
          'data-canvink-check-item': 'true',
          'data-checked': String(node.attrs.checked === true),
          'data-block-id': node.attrs.blockId,
          class: `canvink-check-item${node.attrs.checked ? ' is-checked' : ''}`,
        },
        ['span', { contenteditable: 'false', 'aria-hidden': 'true' }, node.attrs.checked ? '☑' : '☐'],
        ['span', 0],
      ],
    },
    ...mappedTableNodes,
    unknown_block: {
      automerge: { unknownBlock: true },
      group: 'block',
      content: 'block+',
      parseDOM: [{ tag: 'div[data-unknown-block]' }],
      toDOM: () => ['div', { 'data-unknown-block': 'true' }, 0],
    },
    text: { group: 'inline' },
  },
  marks: {
    strong: {
      automerge: { markName: 'strong' },
      parseDOM: [{ tag: 'strong' }, { tag: 'b' }],
      toDOM: () => ['strong', 0],
    },
    em: {
      automerge: { markName: 'em' },
      parseDOM: [{ tag: 'em' }, { tag: 'i' }],
      toDOM: () => ['em', 0],
    },
    link: {
      automerge: {
        markName: 'link',
        parsers: {
          fromAutomerge: linkFromAutomerge,
          fromProsemirror: linkToAutomerge,
        },
      },
      attrs: { href: {}, title: { default: null } },
      inclusive: false,
      parseDOM: [
        {
          tag: 'a[href]',
          getAttrs: (element) => safeLink(element.getAttribute('href'), element.getAttribute('title')) || false,
        },
      ],
      toDOM: (mark) => {
        const parsed = safeLink(mark.attrs.href, mark.attrs.title);
        return parsed
          ? ['a', { href: parsed.href, title: parsed.title, rel: 'noopener noreferrer' }, 0]
          : ['span', { 'data-invalid-link': 'true' }, 0];
      },
    },
    [INLINE_CODE_MARK]: {
      automerge: { markName: INLINE_CODE_MARK },
      parseDOM: [{ tag: 'code' }],
      toDOM: () => ['code', 0],
    },
    [UNDERLINE_MARK]: {
      automerge: { markName: UNDERLINE_MARK },
      parseDOM: [{ tag: 'u' }],
      toDOM: () => ['u', 0],
    },
    [STRIKE_MARK]: {
      automerge: { markName: STRIKE_MARK },
      parseDOM: [{ tag: 's' }, { tag: 'del' }],
      toDOM: () => ['s', 0],
    },
  },
};

export const canvinkSchemaAdapter = new SchemaAdapter(canvinkMappedSchema);
export const canvinkRichTextSchema = canvinkSchemaAdapter.schema;
