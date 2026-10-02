import { Schema, type MarkSpec, type NodeSpec } from 'prosemirror-model';
import { tableNodes } from 'prosemirror-tables';
import {
  INLINE_CODE_MARK,
  STRIKE_MARK,
  safeLink,
} from '../richText/schema';

/**
 * The ProseMirror schema of the Markdown page. Node and mark names match the
 * canvas text schema (paragraph, heading, bullet_list, check_item, table, the
 * inline-code mark, ...) so the shared slash menu, input rules and keymap work
 * on both. Markdown pages are persisted as a plain string, so unlike the canvas
 * schema this one has no Automerge mapping and no block ids.
 */

export type MarkdownColumnAlign = 'left' | 'center' | 'right' | null;

const generatedTableNodes = tableNodes({
  tableGroup: 'block',
  // A GFM cell holds one line of inline content.
  cellContent: 'paragraph',
  cellAttributes: {
    align: {
      default: null,
      getFromDOM: (dom) => {
        const align = dom.getAttribute('data-align');
        return align === 'left' || align === 'center' || align === 'right' ? align : null;
      },
      setDOMAttr: (value, attrs) => {
        if (typeof value === 'string') attrs['data-align'] = value;
      },
    },
  },
});

const nodes: Record<string, NodeSpec> = {
  doc: { content: 'block+' },
  paragraph: {
    content: 'inline*',
    group: 'block',
    parseDOM: [{ tag: 'p' }],
    toDOM: () => ['p', 0],
  },
  heading: {
    attrs: { level: { default: 1 } },
    content: 'inline*',
    group: 'block',
    defining: true,
    parseDOM: [1, 2, 3, 4, 5, 6].map((level) => ({ tag: `h${level}`, attrs: { level } })),
    toDOM: (node) => [`h${Math.min(6, Math.max(1, Number(node.attrs.level) || 1))}`, 0],
  },
  blockquote: {
    content: 'block+',
    group: 'block',
    defining: true,
    parseDOM: [{ tag: 'blockquote' }],
    toDOM: () => ['blockquote', 0],
  },
  code_block: {
    attrs: { params: { default: '' } },
    content: 'text*',
    marks: '',
    group: 'block',
    code: true,
    defining: true,
    parseDOM: [{
      tag: 'pre',
      preserveWhitespace: 'full',
      getAttrs: (element) => ({ params: element.getAttribute('data-params') ?? '' }),
    }],
    toDOM: (node) => [
      'pre',
      node.attrs.params ? { 'data-params': node.attrs.params } : {},
      ['code', 0],
    ],
  },
  horizontal_rule: {
    group: 'block',
    parseDOM: [{ tag: 'hr' }],
    toDOM: () => ['div', { class: 'markdown-rule' }, ['hr']],
  },
  bullet_list: {
    attrs: { tight: { default: true }, bullet: { default: '-' } },
    content: 'list_item+',
    group: 'block',
    parseDOM: [{ tag: 'ul' }],
    toDOM: () => ['ul', 0],
  },
  ordered_list: {
    attrs: { order: { default: 1 }, tight: { default: true } },
    content: 'list_item+',
    group: 'block',
    parseDOM: [{
      tag: 'ol',
      getAttrs: (element) => ({ order: element.hasAttribute('start') ? Number(element.getAttribute('start')) : 1 }),
    }],
    toDOM: (node) => (node.attrs.order === 1 ? ['ol', 0] : ['ol', { start: node.attrs.order }, 0]),
  },
  list_item: {
    content: 'paragraph block*',
    defining: true,
    parseDOM: [{ tag: 'li' }],
    toDOM: () => ['li', 0],
  },
  check_item: {
    attrs: { checked: { default: false } },
    content: 'inline*',
    group: 'block',
    defining: true,
    parseDOM: [{
      tag: '[data-canvink-check-item]',
      getAttrs: (element) => ({ checked: element.getAttribute('data-checked') === 'true' }),
    }],
    toDOM: (node) => [
      'div',
      {
        'data-canvink-check-item': 'true',
        'data-checked': String(node.attrs.checked === true),
        class: `canvink-check-item${node.attrs.checked ? ' is-checked' : ''}`,
      },
      ['span', { contenteditable: 'false', class: 'canvink-check-item__box', 'aria-hidden': 'true' }, node.attrs.checked ? '☑' : '☐'],
      ['span', { class: 'canvink-check-item__text' }, 0],
    ],
  },
  ...generatedTableNodes,
  /**
   * Markdown this editor does not model (HTML blocks, link reference
   * definitions, footnote definitions). It is shown as inert text and written
   * back byte for byte.
   */
  raw_block: {
    attrs: { text: { default: '' } },
    group: 'block',
    atom: true,
    selectable: true,
    parseDOM: [{
      tag: 'pre[data-raw-block]',
      getAttrs: (element) => ({ text: element.textContent ?? '' }),
    }],
    toDOM: (node) => ['pre', { 'data-raw-block': 'true', class: 'markdown-raw-block' }, String(node.attrs.text)],
  },
  text: { group: 'inline' },
  hard_break: {
    inline: true,
    group: 'inline',
    selectable: false,
    parseDOM: [{ tag: 'br' }],
    toDOM: () => ['br'],
  },
  /** Images stay a reference: nothing is fetched while writing notes. */
  image: {
    inline: true,
    group: 'inline',
    atom: true,
    attrs: { src: { default: '' }, alt: { default: '' }, title: { default: '' } },
    parseDOM: [{
      tag: 'span[data-markdown-image]',
      getAttrs: (element) => ({
        src: element.getAttribute('data-src') ?? '',
        alt: element.getAttribute('data-alt') ?? '',
        title: element.getAttribute('title') ?? '',
      }),
    }],
    toDOM: (node) => [
      'span',
      {
        'data-markdown-image': 'true',
        'data-src': String(node.attrs.src),
        'data-alt': String(node.attrs.alt),
        title: String(node.attrs.title) || String(node.attrs.src),
        class: 'markdown-image',
      },
      String(node.attrs.alt) || String(node.attrs.src),
    ],
  },
  /** Inline HTML is kept as inert literal text. */
  html_inline: {
    inline: true,
    group: 'inline',
    atom: true,
    attrs: { html: { default: '' } },
    parseDOM: [{
      tag: 'span[data-markdown-html]',
      getAttrs: (element) => ({ html: element.textContent ?? '' }),
    }],
    toDOM: (node) => ['span', { 'data-markdown-html': 'true', class: 'markdown-html-inline' }, String(node.attrs.html)],
  },
};

const marks: Record<string, MarkSpec> = {
  strong: {
    parseDOM: [{ tag: 'strong' }, { tag: 'b' }],
    toDOM: () => ['strong', 0],
  },
  em: {
    parseDOM: [{ tag: 'em' }, { tag: 'i' }],
    toDOM: () => ['em', 0],
  },
  link: {
    attrs: { href: {}, title: { default: null } },
    inclusive: false,
    parseDOM: [{
      tag: 'a[href]',
      getAttrs: (element) => safeLink(element.getAttribute('href'), element.getAttribute('title')) ?? false,
    }],
    toDOM: (mark) => {
      const parsed = safeLink(mark.attrs.href, mark.attrs.title);
      return parsed
        ? ['a', { href: parsed.href, title: parsed.title, rel: 'noopener noreferrer' }, 0]
        : ['span', { 'data-invalid-link': 'true' }, 0];
    },
  },
  [STRIKE_MARK]: {
    parseDOM: [{ tag: 's' }, { tag: 'del' }],
    toDOM: () => ['s', 0],
  },
  // Last, so it ranks innermost: the serializer writes code text unescaped.
  [INLINE_CODE_MARK]: {
    parseDOM: [{ tag: 'code' }],
    toDOM: () => ['code', 0],
  },
};

export const markdownSchema = new Schema({ nodes, marks });
