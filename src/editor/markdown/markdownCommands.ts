import {
  chainCommands,
  exitCode,
  lift,
  liftEmptyBlock,
  newlineInCode,
  setBlockType,
  wrapIn,
} from 'prosemirror-commands';
import { InputRule, inputRules, textblockTypeInputRule, undoInputRule, wrappingInputRule } from 'prosemirror-inputrules';
import { keymap } from 'prosemirror-keymap';
import { Slice, type Node as ProseMirrorNode, type Schema } from 'prosemirror-model';
import { liftListItem } from 'prosemirror-schema-list';
import {
  Plugin,
  Selection,
  TextSelection,
  type Command,
  type Transaction,
} from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import {
  richTextInputRules,
  richTextKeyBindings,
  richTextTablePlugin,
} from '../richText/commands';
import { SLASH_ITEMS, type SlashItem } from '../richText/slashMenu';
import { needsTrailingParagraph, parseMarkdown } from './markdownConvert';

/**
 * The Markdown page reuses the canvas text editor's slash menu, input rules and
 * keymap. Here are the parts only Markdown has: quotes, code blocks and rules.
 */

function wrapInQuote(schema: Schema): Command {
  return wrapIn(schema.nodes.blockquote);
}

function toCodeBlock(schema: Schema): Command {
  return setBlockType(schema.nodes.code_block);
}

/**
 * Turns an empty line into a rule, or adds one after the current block, and
 * leaves the caret on a fresh line below it.
 */
function insertRule(schema: Schema): Command {
  return (state, dispatch) => {
    const { $from } = state.selection;
    if ($from.depth < 1) return false;
    if (dispatch) {
      const rule = schema.nodes.horizontal_rule.create();
      const paragraph = schema.nodes.paragraph.create();
      const emptyLine = $from.depth === 1 && $from.parent.type === schema.nodes.paragraph && $from.parent.content.size === 0;
      const from = emptyLine ? $from.before(1) : $from.after(1);
      const to = emptyLine ? $from.after(1) : from;
      const tr = state.tr.replaceWith(from, to, [rule, paragraph]);
      dispatch(tr.setSelection(TextSelection.create(tr.doc, from + rule.nodeSize + 1)).scrollIntoView());
    }
    return true;
  };
}

const markdownOnlyItems: readonly SlashItem[] = [
  {
    id: 'quote',
    labelKey: 'richText.slash.quote',
    hint: '>',
    keywords: ['zitat', 'quote', 'blockquote', 'zitatblock'],
    command: wrapInQuote,
  },
  {
    id: 'code',
    labelKey: 'richText.slash.code',
    hint: '```',
    keywords: ['code', 'codeblock', 'programmcode'],
    command: toCodeBlock,
  },
  {
    id: 'divider',
    labelKey: 'richText.slash.divider',
    hint: '---',
    keywords: ['trennlinie', 'linie', 'divider', 'rule', 'horizontal'],
    command: insertRule,
  },
];

/**
 * The canvas inserts a table below the current line. On a Markdown page the
 * empty line the "/" was typed on is the place for it, so it is dropped.
 */
function replacingEmptyLine(item: SlashItem): SlashItem {
  return {
    ...item,
    command: (schema) => (state, dispatch, view) => {
      const { $from } = state.selection;
      const emptyLine = $from.depth === 1 && $from.parent.type === schema.nodes.paragraph && $from.parent.content.size === 0;
      const from = emptyLine ? $from.before(1) : 0;
      const to = emptyLine ? $from.after(1) : 0;
      return item.command(schema)(state, dispatch && ((tr) => {
        if (emptyLine) tr.delete(from, to);
        dispatch(tr);
      }), view);
    },
  };
}

/** The canvas block menu with the Markdown-only blocks slotted in before the table. */
export const MARKDOWN_SLASH_ITEMS: readonly SlashItem[] = SLASH_ITEMS.flatMap((item) =>
  item.id === 'table'
    ? [markdownOnlyItems[0], markdownOnlyItems[1], replacingEmptyLine(item), markdownOnlyItems[2]]
    : [item]);

/** Typing shortcuts on top of the shared ones: `>` quote, three backticks code, `---` rule. */
function markdownBlockInputRules(schema: Schema): Plugin {
  const rule = new InputRule(/^(?:---|\*\*\*|___)$/, (state, _match, start, end) => {
    const $start = state.doc.resolve(start);
    if ($start.depth !== 1 || $start.parent.type !== schema.nodes.paragraph) return null;
    const tr = state.tr.delete(start, end);
    const before = tr.doc.resolve(start).before(1);
    const replaced = tr.replaceWith(before, before + 2, [schema.nodes.horizontal_rule.create(), schema.nodes.paragraph.create()]);
    return replaced.setSelection(TextSelection.create(replaced.doc, before + 2));
  });
  return inputRules({
    rules: [
      wrappingInputRule(/^\s*>\s$/, schema.nodes.blockquote),
      textblockTypeInputRule(/^```$/, schema.nodes.code_block),
      rule,
    ],
  });
}

export function markdownInputRules(schema: Schema): Plugin[] {
  return [markdownBlockInputRules(schema), richTextInputRules(schema)];
}

/**
 * Notion's Backspace: at the very start of a heading, to-do or code block it
 * turns the block back into a paragraph; at the start of a list item or quote
 * it steps out of the list or quote instead of merging into the block above.
 */
function backspaceOutOfBlock(schema: Schema): Command {
  const { heading, check_item: checkItem, code_block: codeBlock, paragraph, list_item: listItem, blockquote } = schema.nodes;
  return (state, dispatch, view) => {
    const { $from, empty } = state.selection;
    if (!empty || $from.parentOffset !== 0) return false;
    const type = $from.parent.type;
    if (type === heading || type === checkItem || type === codeBlock) {
      if (dispatch) dispatch(state.tr.setBlockType($from.before(), $from.after(), paragraph).scrollIntoView());
      return true;
    }
    if (type !== paragraph || $from.depth < 2 || $from.index($from.depth - 1) !== 0) return false;
    const container = $from.node($from.depth - 1).type;
    if (container === listItem) return liftListItem(listItem)(state, dispatch, view);
    if (container === blockquote) return lift(state, dispatch);
    return false;
  };
}

/**
 * Enter on an empty line inside a quote leaves the quote, as Notion does. The
 * shared Enter would split the empty line again, so this comes first.
 */
function leaveQuoteOnEmptyLine(schema: Schema): Command {
  return (state, dispatch) => {
    const { $from, empty } = state.selection;
    if (!empty || $from.depth < 2 || $from.parent.content.size > 0) return false;
    if ($from.node($from.depth - 1).type !== schema.nodes.blockquote) return false;
    return liftEmptyBlock(state, dispatch);
  };
}

export function markdownKeyBindings(schema: Schema): Record<string, Command> {
  const shared = richTextKeyBindings(schema);
  const { Enter: enter, Backspace: backspace } = shared;
  return {
    ...shared,
    // The shared Enter would split a code block; inside code it adds a line.
    Enter: chainCommands(newlineInCode, leaveQuoteOnEmptyLine(schema), enter),
    Backspace: chainCommands(undoInputRule, backspaceOutOfBlock(schema), backspace),
    'Mod-Enter': chainCommands(shared['Mod-Enter'], exitCode),
  };
}

export function markdownKeymap(schema: Schema): Plugin {
  return keymap(markdownKeyBindings(schema));
}

export function markdownTablePlugin(): Plugin {
  return richTextTablePlugin();
}

/** Keeps a paragraph after a last block that has no way to continue below it. */
export function trailingParagraphPlugin(): Plugin {
  return new Plugin({
    appendTransaction: (transactions, _oldState, newState): Transaction | null => {
      if (!transactions.some((transaction) => transaction.docChanged)) return null;
      if (!needsTrailingParagraph(newState.doc.lastChild)) return null;
      return newState.tr.insert(newState.doc.content.size, newState.schema.nodes.paragraph.create());
    },
  });
}

/** Marks the empty line the caret is on, for the "Tippe / für Blöcke" hint; the hint text comes from CSS. */
export function placeholderPlugin(): Plugin {
  return new Plugin({
    props: {
      decorations: (state) => {
        const { doc, selection } = state;
        if (doc.childCount === 1 && doc.firstChild?.type.name === 'paragraph' && doc.firstChild.content.size === 0) {
          return DecorationSet.create(doc, [Decoration.node(0, doc.firstChild.nodeSize, { class: 'is-empty-page' })]);
        }
        const { $from } = selection;
        if (!selection.empty || $from.parent.type.name !== 'paragraph' || $from.parent.content.size > 0) return null;
        return DecorationSet.create(doc, [Decoration.node($from.before(), $from.after(), { class: 'is-empty-line' })]);
      },
    },
  });
}

/**
 * Puts the caret on an empty line at the end of the page, adding one when the
 * page ends in another block. Clicking below the last block does this in Notion.
 */
export function focusPageEnd(view: EditorView): void {
  const { state } = view;
  const { paragraph } = state.schema.nodes;
  const last = state.doc.lastChild;
  let tr = state.tr;
  if (!last || last.type !== paragraph || last.content.size > 0) tr = tr.insert(state.doc.content.size, paragraph.create());
  view.dispatch(tr.setSelection(Selection.atEnd(tr.doc)).scrollIntoView());
  view.focus();
}

/** Clicks in the empty space of the editor, below the last block, land on the end of the page. */
export function pageEndClickPlugin(): Plugin {
  return new Plugin({
    props: {
      handleClick: (view, _pos, event) => {
        if (event.target !== view.dom || !view.editable) return false;
        focusPageEnd(view);
        return true;
      },
    },
  });
}

/** Ticking the box of a to-do with the mouse or finger, as in Notion. */
export function checkItemClickPlugin(): Plugin {
  return new Plugin({
    props: {
      handleClickOn: (view, _pos, node, nodePos, event) => {
        if (node.type.name !== 'check_item' || !(event.target instanceof Element)) return false;
        if (!event.target.closest('.canvink-check-item__box')) return false;
        if (!view.editable) return true;
        view.dispatch(view.state.tr.setNodeMarkup(nodePos, undefined, { ...node.attrs, checked: node.attrs.checked !== true }));
        return true;
      },
    },
  });
}

/**
 * Pasted plain text is read as Markdown, so a copied note or README arrives as
 * headings, lists and code, as it does in Notion. Shift-paste keeps plain lines.
 */
export function markdownPastePlugin(schema: Schema): Plugin {
  return new Plugin({
    props: {
      clipboardTextParser: (text, _context, plain) => {
        const paragraph = schema.nodes.paragraph;
        if (plain) {
          const lines = text.replaceAll('\r\n', '\n').split('\n');
          return new Slice(schema.nodes.doc.create(null, lines.map((line) => paragraph.create(null, line ? schema.text(line) : null))).content, 1, 1);
        }
        const parsed: ProseMirrorNode = parseMarkdown(text);
        const blocks = parsed.lastChild?.content.size === 0 && parsed.childCount > 1
          ? parsed.content.cut(0, parsed.content.size - parsed.lastChild.nodeSize)
          : parsed.content;
        const single = blocks.childCount === 1 && blocks.firstChild?.type === paragraph;
        return new Slice(blocks, single ? 1 : 0, single ? 1 : 0);
      },
    },
  });
}
