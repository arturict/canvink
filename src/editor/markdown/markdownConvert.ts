import MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';
import type StateCore from 'markdown-it/lib/rules_core/state_core.mjs';
import {
  MarkdownParser,
  MarkdownSerializer,
  defaultMarkdownSerializer,
  type ParseSpec,
} from 'prosemirror-markdown';
import { Fragment, type Node as ProseMirrorNode } from 'prosemirror-model';
import type { EditorState, Transaction } from 'prosemirror-state';
import { INLINE_CODE_MARK, STRIKE_MARK } from '../richText/schema';
import { markdownSchema, type MarkdownColumnAlign } from './markdownSchema';

/**
 * Markdown <-> ProseMirror for Markdown pages.
 *
 * The stored page is the Markdown string. Parsing splits it into top-level
 * blocks and remembers, per block node, the exact source text and the blank
 * lines that followed it. Serializing writes a block that was not edited back
 * from that memory and only re-renders blocks the user changed, so opening a
 * page never rewrites it and editing one paragraph leaves the rest of the
 * file byte-for-byte alone. Markdown the schema cannot model (HTML blocks,
 * link reference and footnote definitions) becomes an inert `raw_block` that
 * is written back unchanged.
 */

interface SourceChunk {
  /** The block's source text without surrounding blank lines. */
  text: string;
  /** The line breaks that followed the block in the source. */
  gap: string;
  /** Blank lines before the very first block. */
  lead: string;
  /** The block that followed this one in the source, if any. */
  next: ProseMirrorNode | null;
}

const sourceChunks = new WeakMap<ProseMirrorNode, SourceChunk>();

const TASK_MARKER = /^\[([ xX])\](?:\s+|$)/;

function listIsTight(tokens: Token[], index: number): boolean {
  for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
    if (tokens[cursor].type !== 'list_item_open') return tokens[cursor].hidden;
  }
  return false;
}

function alignOf(token: Token): MarkdownColumnAlign {
  const style = token.attrGet('style') ?? '';
  const match = /text-align:\s*(left|center|right)/.exec(style);
  return match ? (match[1] as MarkdownColumnAlign) : null;
}

/** A soft line break stays a newline inside the text, so a paragraph keeps its lines. */
function softBreaksToText(state: StateCore): void {
  for (const token of state.tokens) {
    if (token.type !== 'inline' || !token.children) continue;
    for (const child of token.children) {
      if (child.type === 'softbreak') {
        child.type = 'text';
        child.content = '\n';
      }
    }
  }
}

const FOOTNOTE_REFERENCE = /\[\^[^\]\s]+\]/g;
const FOOTNOTE_DEFINITION = /^\[\^[^\]\s]+\]:/;

/**
 * Footnote markers such as `[^1]` are kept as inline atoms. As plain text the
 * serializer would escape the brackets and break the footnote.
 */
function footnoteReferencesToAtoms(state: StateCore): void {
  for (const token of state.tokens) {
    if (token.type !== 'inline' || !token.children) continue;
    const children: Token[] = [];
    for (const child of token.children) {
      if (child.type !== 'text' || !child.content.includes('[^')) {
        children.push(child);
        continue;
      }
      let last = 0;
      for (const match of child.content.matchAll(FOOTNOTE_REFERENCE)) {
        if (match.index > last) {
          const text = new state.Token('text', '', 0);
          text.content = child.content.slice(last, match.index);
          children.push(text);
        }
        const atom = new state.Token('html_inline', '', 0);
        atom.content = match[0];
        children.push(atom);
        last = match.index + match[0].length;
      }
      if (last < child.content.length) {
        const text = new state.Token('text', '', 0);
        text.content = child.content.slice(last);
        children.push(text);
      }
    }
    token.children = children;
  }
}

/** GFM cells hold inline content only; wrap it in a paragraph so the schema's cell content is valid. */
function wrapCellContent(state: StateCore): void {
  const wrapped: Token[] = [];
  for (const token of state.tokens) {
    if (token.type === 'th_close' || token.type === 'td_close') {
      wrapped.push(new state.Token('paragraph_close', 'p', -1));
    }
    wrapped.push(token);
    if (token.type === 'th_open' || token.type === 'td_open') {
      wrapped.push(new state.Token('paragraph_open', 'p', 1));
    }
  }
  state.tokens = wrapped;
}

/**
 * A top-level bullet list whose items are all `[ ]` / `[x]` tasks becomes a run
 * of check items, the block the slash menu and the `[] ` shortcut create. Other
 * lists keep the marker as literal text.
 */
function taskListsToCheckItems(state: StateCore): void {
  const out: Token[] = [];
  const tokens = state.tokens;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type !== 'bullet_list_open' || token.level !== 0) {
      out.push(token);
      continue;
    }
    let end = index + 1;
    while (end < tokens.length && !(tokens[end].type === 'bullet_list_close' && tokens[end].level === 0)) end += 1;
    const converted = tryConvertTaskList(state, tokens.slice(index + 1, end));
    if (converted) out.push(...converted);
    else out.push(...tokens.slice(index, end + 1));
    index = end;
  }
  state.tokens = out;
}

function tryConvertTaskList(state: StateCore, body: Token[]): Token[] | null {
  const result: Token[] = [];
  for (let cursor = 0; cursor < body.length; cursor += 5) {
    const [open, paragraphOpen, inline, paragraphClose, close] = body.slice(cursor, cursor + 5);
    if (!close || open.type !== 'list_item_open' || paragraphOpen.type !== 'paragraph_open'
      || inline.type !== 'inline' || paragraphClose.type !== 'paragraph_close'
      || close.type !== 'list_item_close') return null;
    const first = inline.children?.[0];
    const marker = first?.type === 'text' ? TASK_MARKER.exec(first.content) : null;
    if (!first || !marker) return null;
    const item = new state.Token('check_item_open', '', 1);
    item.map = open.map;
    item.meta = { checked: marker[1] !== ' ' };
    const text = new state.Token('inline', '', 0);
    text.content = inline.content.replace(TASK_MARKER, '');
    first.content = first.content.replace(TASK_MARKER, '');
    text.children = first.content === '' ? (inline.children ?? []).slice(1) : (inline.children ?? []);
    result.push(item, text, new state.Token('check_item_close', '', -1));
  }
  return result.length > 0 ? result : null;
}

function createTokenizer(): MarkdownIt {
  const tokenizer = new MarkdownIt('commonmark', { html: true, linkify: false, typographer: false });
  tokenizer.enable(['table', 'strikethrough']);
  tokenizer.core.ruler.push('canvink_soft_breaks', softBreaksToText);
  tokenizer.core.ruler.push('canvink_footnote_references', footnoteReferencesToAtoms);
  tokenizer.core.ruler.push('canvink_table_cells', wrapCellContent);
  tokenizer.core.ruler.push('canvink_task_lists', taskListsToCheckItems);
  return tokenizer;
}

const tokenizer = createTokenizer();

const tokenSpecs: Record<string, ParseSpec> = {
  blockquote: { block: 'blockquote' },
  paragraph: { block: 'paragraph' },
  list_item: { block: 'list_item' },
  bullet_list: {
    block: 'bullet_list',
    getAttrs: (token, tokens, index) => ({ tight: listIsTight(tokens, index), bullet: token.markup || '-' }),
  },
  ordered_list: {
    block: 'ordered_list',
    getAttrs: (token, tokens, index) => ({
      order: Number(token.attrGet('start') ?? 1),
      tight: listIsTight(tokens, index),
    }),
  },
  heading: { block: 'heading', getAttrs: (token) => ({ level: Number(token.tag.slice(1)) }) },
  code_block: { block: 'code_block', noCloseToken: true },
  fence: { block: 'code_block', noCloseToken: true, getAttrs: (token) => ({ params: token.info }) },
  hr: { node: 'horizontal_rule' },
  image: {
    node: 'image',
    getAttrs: (token) => ({
      src: token.attrGet('src') ?? '',
      title: token.attrGet('title') ?? '',
      alt: token.content,
    }),
  },
  hardbreak: { node: 'hard_break' },
  html_block: { node: 'raw_block', getAttrs: (token) => ({ text: token.content.replace(/\n+$/, '') }) },
  html_inline: { node: 'html_inline', getAttrs: (token) => ({ html: token.content }) },
  em: { mark: 'em' },
  strong: { mark: 'strong' },
  s: { mark: STRIKE_MARK },
  link: {
    mark: 'link',
    getAttrs: (token) => ({ href: token.attrGet('href') ?? '', title: token.attrGet('title') }),
  },
  code_inline: { mark: INLINE_CODE_MARK, noCloseToken: true },
  table: { block: 'table' },
  thead: { ignore: true },
  tbody: { ignore: true },
  tr: { block: 'table_row' },
  th: { block: 'table_header', getAttrs: (token) => ({ align: alignOf(token) }) },
  td: { block: 'table_cell', getAttrs: (token) => ({ align: alignOf(token) }) },
  check_item: { block: 'check_item', getAttrs: (token) => ({ checked: token.meta?.checked === true }) },
};

const parser = new MarkdownParser(markdownSchema, tokenizer, tokenSpecs);

interface SourceItem {
  kind: 'block' | 'raw';
  start: number;
  end: number;
}

function isBlankLine(line: string): boolean {
  return line.trim() === '';
}

/** Line ranges of the top-level blocks, plus the non-blank lines between them (definitions the tokenizer drops). */
function sourceItems(lines: string[], tokens: Token[]): SourceItem[] {
  const blocks = tokens
    .filter((token) => token.level === 0 && token.nesting !== -1 && token.map !== null)
    .map((token) => ({ start: token.map![0], end: Math.min(lines.length, token.map![1]) }))
    .sort((a, b) => a.start - b.start);
  const items: SourceItem[] = [];
  let cursor = 0;
  const addRaw = (from: number, to: number) => {
    let run = -1;
    for (let line = from; line <= to; line += 1) {
      const blank = line === to || isBlankLine(lines[line]);
      if (!blank && run < 0) run = line;
      if (blank && run >= 0) {
        items.push({ kind: 'raw', start: run, end: line });
        run = -1;
      }
    }
  };
  for (const block of blocks) {
    if (block.start < cursor) continue;
    addRaw(cursor, block.start);
    let end = block.end;
    while (end > block.start + 1 && isBlankLine(lines[end - 1])) end -= 1;
    items.push({ kind: 'block', start: block.start, end });
    cursor = end;
  }
  addRaw(cursor, lines.length);
  return items;
}

function rawBlock(text: string): ProseMirrorNode {
  return markdownSchema.nodes.raw_block.create({ text });
}

function parseBlockText(text: string, env: object): ProseMirrorNode {
  // Footnote definitions read as paragraphs; as text their brackets would be escaped.
  if (FOOTNOTE_DEFINITION.test(text)) return rawBlock(text);
  try {
    const parsed = parser.parse(text, env);
    if (parsed.childCount === 1) return parsed.child(0);
  } catch {
    // A block the converter cannot read stays as inert source text.
  }
  return rawBlock(text);
}

export function emptyMarkdownDoc(): ProseMirrorNode {
  return markdownSchema.topNodeType.createAndFill() as ProseMirrorNode;
}

/**
 * Blocks with no way to continue below them: a rule, table, raw block or filled
 * code block needs an empty paragraph after it so there is a line to type on.
 * (An empty code block, which the fence shortcut has just made, does not, so
 * Backspace can still undo the shortcut.)
 */
export function needsTrailingParagraph(last: ProseMirrorNode | null): boolean {
  if (!last) return true;
  const { horizontal_rule: rule, table, raw_block: raw, code_block: code } = markdownSchema.nodes;
  return last.type === rule || last.type === table || last.type === raw
    || (last.type === code && last.content.size > 0);
}

export function withTrailingParagraph(doc: ProseMirrorNode): ProseMirrorNode {
  if (!needsTrailingParagraph(doc.lastChild)) return doc;
  return doc.copy(doc.content.append(Fragment.from(markdownSchema.nodes.paragraph.create())));
}

export function parseMarkdown(source: string): ProseMirrorNode {
  const text = source.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  const lines = text.split('\n');
  let items: SourceItem[];
  const env: { references?: unknown } = {};
  try {
    items = sourceItems(lines, tokenizer.parse(text, env));
  } catch {
    items = [{ kind: 'raw', start: 0, end: lines.length }];
  }
  if (items.length === 0) return withTrailingParagraph(emptyMarkdownDoc());

  const nodes = items.map((item) => {
    const itemText = lines.slice(item.start, item.end).join('\n');
    return item.kind === 'raw' ? rawBlock(itemText) : parseBlockText(itemText, env);
  });
  items.forEach((item, index) => {
    const following = items[index + 1];
    sourceChunks.set(nodes[index], {
      text: lines.slice(item.start, item.end).join('\n'),
      gap: '\n'.repeat(following ? following.start - item.end + 1 : lines.length - item.end),
      lead: index === 0 ? '\n'.repeat(item.start) : '',
      next: nodes[index + 1] ?? null,
    });
  });
  return withTrailingParagraph(markdownSchema.topNodeType.create(null, nodes));
}

/**
 * After the editor has taken over `parsed` by a minimal diff, its own top-level
 * nodes are reused ones, not the parsed objects. Hand the source memory of
 * `parsed` to the nodes that are now in `current`.
 */
export function adoptSourceChunks(current: ProseMirrorNode, parsed: ProseMirrorNode): void {
  if (!current.eq(parsed)) return;
  for (let index = 0; index < parsed.childCount; index += 1) {
    const chunk = sourceChunks.get(parsed.child(index));
    if (!chunk) continue;
    const following = parsed.maybeChild(index + 1);
    const followingChunk = following ? sourceChunks.get(following) : undefined;
    sourceChunks.set(current.child(index), {
      ...chunk,
      next: chunk.next && followingChunk && following ? current.child(index + 1) : null,
    });
  }
}

function escapePipes(text: string): string {
  let out = '';
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '\\' && index + 1 < text.length) {
      out += char + text[index + 1];
      index += 1;
    } else out += char === '|' ? '\\|' : char;
  }
  return out;
}

function cellText(cell: ProseMirrorNode): string {
  const paragraph = cell.firstChild;
  if (!paragraph) return '';
  return serializeNode(paragraph)
    .replaceAll('\\\n', '<br>')
    .replaceAll('\n', ' ')
    .trim();
}

function delimiterCell(align: MarkdownColumnAlign): string {
  if (align === 'left') return ':---';
  if (align === 'right') return '---:';
  if (align === 'center') return ':---:';
  return '---';
}

const serializer = new MarkdownSerializer(
  {
    ...defaultMarkdownSerializer.nodes,
    check_item: (state, node) => {
      state.write(node.attrs.checked === true ? '- [x] ' : '- [ ] ');
      state.renderInline(node, false);
      state.closeBlock(node);
    },
    raw_block: (state, node) => {
      state.text(String(node.attrs.text), false);
      state.closeBlock(node);
    },
    html_inline: (state, node) => state.text(String(node.attrs.html), false),
    table: (state, node) => {
      const rows: ProseMirrorNode[][] = [];
      node.forEach((row) => {
        const cells: ProseMirrorNode[] = [];
        row.forEach((cell) => cells.push(cell));
        rows.push(cells);
      });
      const width = Math.max(1, ...rows.map((row) => row.length));
      const first = rows[0] ?? [];
      const firstIsHeader = first.length > 0 && first.every((cell) => cell.type === markdownSchema.nodes.table_header);
      const line = (cells: string[]) => `| ${Array.from({ length: width }, (_, column) => cells[column] ?? '').join(' | ')} |`;
      const lines = [
        line(firstIsHeader ? first.map((cell) => escapePipes(cellText(cell))) : []),
        `| ${Array.from({ length: width }, (_, column) => delimiterCell((first[column]?.attrs.align as MarkdownColumnAlign) ?? null)).join(' | ')} |`,
        ...(firstIsHeader ? rows.slice(1) : rows).map((row) => line(row.map((cell) => escapePipes(cellText(cell))))),
      ];
      lines.forEach((text, index) => {
        if (index > 0) state.ensureNewLine();
        state.write(text);
      });
      state.closeBlock(node);
    },
  },
  {
    strong: defaultMarkdownSerializer.marks.strong,
    em: defaultMarkdownSerializer.marks.em,
    [STRIKE_MARK]: { open: '~~', close: '~~', mixable: true, expelEnclosingWhitespace: true },
    link: defaultMarkdownSerializer.marks.link,
    [INLINE_CODE_MARK]: defaultMarkdownSerializer.marks.code,
  },
  {
    // Text that would otherwise read as inline HTML or a character reference.
    escapeExtraCharacters: /<(?=[A-Za-z/!?])|&(?=#?\w+;)/g,
  },
);

function serializeNode(node: ProseMirrorNode): string {
  return serializer.serialize(markdownSchema.topNodeType.create(null, node)).replace(/\n+$/, '');
}

export interface SerializeOptions {
  /** Reuse the original text of blocks that were not edited. Off only to test the serializer itself. */
  keepSource?: boolean;
}

interface Entry {
  node: ProseMirrorNode;
  text: string;
  chunk: SourceChunk | undefined;
  /** The bullet character of a list or to-do run, when the block is one. */
  marker: string | null;
}

const BULLET_MARKERS = ['-', '*', '+'];

function isBlankParagraph(node: ProseMirrorNode): boolean {
  if (node.type !== markdownSchema.nodes.paragraph) return false;
  return node.content.size === 0 || (node.childCount === 1 && node.firstChild?.isText === true && node.textContent.trim() === '');
}

function isBulletBlock(node: ProseMirrorNode): boolean {
  return node.type === markdownSchema.nodes.bullet_list || node.type === markdownSchema.nodes.check_item;
}

/**
 * Two bullet lists (or a list and a run of to-dos) written one after the other
 * would read back as one list. Blocks that were written fresh therefore avoid
 * the bullet character of their neighbours; unedited blocks keep their own.
 */
function assignBulletMarkers(entries: Entry[]): void {
  const { bullet_list: bulletList, check_item: checkItem } = markdownSchema.nodes;
  entries.forEach((entry, index) => {
    if (!isBulletBlock(entry.node)) return;
    if (entry.chunk) {
      entry.marker = entry.chunk.text.trimStart()[0] ?? null;
      return;
    }
    const previous = entries[index - 1];
    if (entry.node.type === checkItem && previous?.node.type === checkItem && previous.marker) {
      entry.marker = previous.marker;
      return;
    }
    let runEnd = index;
    while (entry.node.type === checkItem && entries[runEnd + 1]?.node.type === checkItem) runEnd += 1;
    const following = entries[runEnd + 1];
    const taken = new Set<string | undefined>([
      previous && isBulletBlock(previous.node) ? previous.marker ?? undefined : undefined,
      following?.chunk && isBulletBlock(following.node) ? following.text.trimStart()[0] : undefined,
    ]);
    const preferred = entry.node.type === bulletList ? String(entry.node.attrs.bullet) : '-';
    entry.marker = [preferred, ...BULLET_MARKERS].find((marker) => !taken.has(marker)) ?? preferred;
  });
}

function renderEntry(node: ProseMirrorNode, marker: string | null): string {
  if (marker === null) return serializeNode(node);
  if (node.type === markdownSchema.nodes.bullet_list) {
    return serializeNode(node.type.create({ ...node.attrs, bullet: marker }, node.content));
  }
  return serializeNode(node).replace(/^- /, `${marker} `);
}

export function serializeMarkdown(doc: ProseMirrorNode, { keepSource = true }: SerializeOptions = {}): string {
  const entries: Entry[] = [];
  doc.forEach((node) => {
    const chunk = keepSource ? sourceChunks.get(node) : undefined;
    // Markdown cannot hold an empty paragraph; it is what the editor keeps at the end and between blocks being typed.
    if (!chunk && isBlankParagraph(node)) return;
    entries.push({ node, text: chunk ? chunk.text : '', chunk, marker: null });
  });
  if (entries.length === 0) return '';
  assignBulletMarkers(entries);
  for (const entry of entries) {
    if (!entry.chunk) entry.text = renderEntry(entry.node, entry.marker);
  }

  const checkItem = markdownSchema.nodes.check_item;
  let out = entries[0].chunk?.lead ?? '';
  entries.forEach((entry, index) => {
    out += entry.text;
    const following = entries[index + 1];
    if (!following) {
      out += entry.chunk && entry.chunk.next === null ? entry.chunk.gap : '\n';
    } else if (entry.chunk && entry.chunk.next === following.node) {
      out += entry.chunk.gap;
    } else {
      out += entry.node.type === checkItem && following.node.type === checkItem ? '\n' : '\n\n';
    }
  });
  return out;
}

/** Marks the transaction that loads a changed source, so it is not written back as an edit. */
export const SOURCE_LOADED = 'markdown-source-loaded';

/**
 * Loads a source that came from elsewhere (a remote change, an undo, a
 * restore) into the editor by replacing only the part of the document that
 * differs, so the caret and the undo history of the rest are not disturbed.
 * `transaction` is null when the document already shows this source.
 */
export function loadSourceTransaction(state: EditorState, source: string): { transaction: Transaction | null; parsed: ProseMirrorNode } {
  const parsed = parseMarkdown(source);
  const current = state.doc;
  const start = current.content.findDiffStart(parsed.content);
  const end = start === null ? null : current.content.findDiffEnd(parsed.content);
  if (start === null || !end) return { transaction: null, parsed };
  let { a: endCurrent, b: endParsed } = end;
  // The ends may overlap the start when the change is a pure insertion or deletion.
  const overlap = start - Math.min(endCurrent, endParsed);
  if (overlap > 0) {
    endCurrent += overlap;
    endParsed += overlap;
  }
  const transaction = state.tr
    .replace(start, endCurrent, parsed.slice(start, endParsed))
    .setMeta(SOURCE_LOADED, true)
    .setMeta('addToHistory', false);
  return { transaction, parsed };
}
