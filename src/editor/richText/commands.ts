import {
  baseKeymap,
  chainCommands,
  setBlockType,
  splitBlockAs,
  toggleMark,
} from 'prosemirror-commands';
import { redo, undo } from 'prosemirror-history';
import {
  InputRule,
  inputRules,
  textblockTypeInputRule,
  undoInputRule,
  wrappingInputRule,
} from 'prosemirror-inputrules';
import { keymap } from 'prosemirror-keymap';
import {
  liftListItem,
  sinkListItem,
  splitListItem,
  wrapInList,
} from 'prosemirror-schema-list';
import type { MarkType, Schema } from 'prosemirror-model';
import { TextSelection, type Command, type Plugin, type Transaction } from 'prosemirror-state';
import {
  addColumnAfter,
  addColumnBefore,
  addRowAfter,
  addRowBefore,
  deleteColumn,
  deleteRow,
  deleteTable,
  goToNextCell,
  isInTable,
  mergeCells,
  selectedRect,
  TableMap,
  splitCell,
  tableEditing,
  tableNodeTypes,
  toggleHeaderCell,
  toggleHeaderColumn,
  toggleHeaderRow,
} from 'prosemirror-tables';
import {
  INLINE_CODE_MARK,
  STRIKE_MARK,
  UNDERLINE_MARK,
  safeLink,
} from './schema';
import { createRichTextBlockId } from './tablePersistence';

function createBlockId(): string {
  return createRichTextBlockId('check');
}

function markCommand(schema: Schema, name: string): Command {
  const mark = schema.marks[name];
  if (!mark) return () => false;
  return toggleMark(mark);
}

export function setParagraph(schema: Schema): Command {
  return setBlockType(schema.nodes.paragraph);
}

export function setHeading(schema: Schema, level: 1 | 2 | 3 | 4 | 5 | 6): Command {
  return setBlockType(schema.nodes.heading, { level });
}

export function toggleStrong(schema: Schema): Command {
  return markCommand(schema, 'strong');
}

export function toggleEmphasis(schema: Schema): Command {
  return markCommand(schema, 'em');
}

export function toggleInlineCode(schema: Schema): Command {
  return markCommand(schema, INLINE_CODE_MARK);
}

export function toggleUnderline(schema: Schema): Command {
  return markCommand(schema, UNDERLINE_MARK);
}

export function toggleStrike(schema: Schema): Command {
  return markCommand(schema, STRIKE_MARK);
}

export function setLink(schema: Schema, href: string, title: string | null = null): Command {
  const parsed = safeLink(href, title);
  if (!parsed) return () => false;
  const link = schema.marks.link;
  return (state, dispatch) => {
    if (state.selection.empty) return false;
    if (dispatch) {
      dispatch(
        state.tr
          .removeMark(state.selection.from, state.selection.to, link)
          .addMark(state.selection.from, state.selection.to, link.create(parsed))
          .scrollIntoView(),
      );
    }
    return true;
  };
}

export function removeLink(schema: Schema): Command {
  const link = schema.marks.link;
  return (state, dispatch) => {
    if (state.selection.empty) return false;
    if (dispatch) dispatch(state.tr.removeMark(state.selection.from, state.selection.to, link));
    return true;
  };
}

export const toggleCurrentCheckItem: Command = (state, dispatch) => {
  const checkItem = state.schema.nodes.check_item;
  for (let depth = state.selection.$from.depth; depth > 0; depth -= 1) {
    const node = state.selection.$from.node(depth);
    if (node.type !== checkItem) continue;
    if (dispatch) {
      dispatch(
        state.tr.setNodeMarkup(state.selection.$from.before(depth), checkItem, {
          ...node.attrs,
          checked: node.attrs.checked !== true,
        }),
      );
    }
    return true;
  }
  return false;
};

export function insertCheckItem(schema: Schema, text = ''): Command {
  return (state, dispatch) => {
    const marks = state.storedMarks ?? state.selection.$from.marks();
    const content = text ? schema.text(text, marks) : undefined;
    const node = schema.nodes.check_item.create(
      { checked: false, blockId: createBlockId() },
      content,
    );
    if (dispatch) dispatch(state.tr.replaceSelectionWith(node).scrollIntoView());
    return true;
  };
}

export function insertTable(
  schema: Schema,
  rows = 2,
  columns = 2,
  headerRow = true,
): Command {
  return (state, dispatch) => {
    const safeRows = Math.min(50, Math.max(1, Math.trunc(rows)));
    const safeColumns = Math.min(20, Math.max(1, Math.trunc(columns)));
    const types = tableNodeTypes(schema);
    const rowNodes = Array.from({ length: safeRows }, (_, rowIndex) => {
      const cellType = headerRow && rowIndex === 0 ? types.header_cell : types.cell;
      return types.row.create(
        { blockId: createBlockId(), isAmgBlock: true },
        Array.from({ length: safeColumns }, () =>
          cellType.create(
            { blockId: createBlockId(), isAmgBlock: true },
            schema.nodes.paragraph.create(),
          ),
        ),
      );
    });
    const table = types.table.create(
      { blockId: createBlockId(), isAmgBlock: true },
      rowNodes,
    );
    if (dispatch) {
      const position = state.selection.$from.depth >= 1
        ? state.selection.$from.after(1)
        : state.selection.to;
      dispatch(state.tr.insert(position, table).scrollIntoView());
    }
    return true;
  };
}

function splitCheckItem(schema: Schema): Command {
  return splitBlockAs((node) =>
    node.type === schema.nodes.check_item
      ? {
          type: node.type,
          attrs: { ...node.attrs, checked: false, blockId: createBlockId() },
        }
      : null,
  );
}

/**
 * OneNote's Ctrl+1 "To Do" tag: turns the current line into a checkbox, or
 * back into a plain line when it already is one.
 */
function toggleToDo(schema: Schema): Command {
  return (state, dispatch, view) => {
    const { $from } = state.selection;
    if ($from.parent.type === schema.nodes.check_item) {
      if (dispatch) dispatch(state.tr.setBlockType($from.before(), $from.after(), schema.nodes.paragraph));
      return true;
    }
    if ($from.parent.type === schema.nodes.paragraph && $from.depth === 1) {
      if (dispatch) {
        dispatch(state.tr.setBlockType($from.before(), $from.after(), schema.nodes.check_item, {
          checked: false,
          blockId: createBlockId(),
        }));
      }
      return true;
    }
    return insertCheckItem(schema)(state, dispatch, view);
  };
}

/** Tab in a table moves to the next cell and, in the last cell, adds a row, as in Word. */
const nextCellOrNewRow: Command = (state, dispatch, view) => {
  if (!isInTable(state)) return false;
  if (goToNextCell(1)(state, dispatch, view)) return true;
  if (!dispatch) return true;
  let rowTransaction: Transaction | undefined;
  addRowAfter(state, (tr) => { rowTransaction = tr; });
  if (!rowTransaction) return false;
  const tr: Transaction = rowTransaction;
  // One transaction: add the row and put the caret into its first cell.
  const rect = selectedRect(state);
  const table = tr.doc.nodeAt(rect.tableStart - 1);
  if (!table) return false;
  const cellPos = rect.tableStart + TableMap.get(table).positionAt(rect.bottom, 0, table);
  dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(cellPos + 1))).scrollIntoView());
  return true;
};

/**
 * Enter in an empty list item or to-do leaves the list instead of adding a
 * blank entry to it.
 */
function exitEmptyListItem(schema: Schema): Command {
  const listItem = schema.nodes.list_item;
  return (state, dispatch, view) => {
    const { $from, empty } = state.selection;
    if (!empty || $from.parent.content.size > 0) return false;
    if ($from.parent.type === schema.nodes.check_item) {
      if (dispatch) dispatch(state.tr.setBlockType($from.before(), $from.after(), schema.nodes.paragraph));
      return true;
    }
    if ($from.depth < 2 || $from.node(-1).type !== listItem) return false;
    return liftListItem(listItem)(state, dispatch, view);
  };
}

export function richTextKeyBindings(schema: Schema): Record<string, Command> {
  const listItem = schema.nodes.list_item;
  const lists = listCommands(schema);
  return {
    ...baseKeymap,
    'Mod-b': toggleStrong(schema),
    'Mod-i': toggleEmphasis(schema),
    'Mod-u': toggleUnderline(schema),
    'Mod-`': toggleInlineCode(schema),
    'Mod-Shift-x': toggleStrike(schema),
    'Mod-Shift-7': lists.ordered,
    'Mod-Shift-8': lists.bullet,
    'Mod-Shift-9': insertCheckItem(schema),
    // OneNote's own shortcuts, so muscle memory from OneNote carries over.
    'Mod-1': toggleToDo(schema),
    'Mod-.': lists.bullet,
    'Mod-/': lists.ordered,
    'Mod-Alt-1': setHeading(schema, 1),
    'Mod-Alt-2': setHeading(schema, 2),
    'Mod-Alt-3': setHeading(schema, 3),
    'Mod-Shift-n': setParagraph(schema),
    'Mod-Enter': toggleCurrentCheckItem,
    'Mod-z': undo,
    'Mod-y': redo,
    'Mod-Shift-z': redo,
    Enter: chainCommands(
      exitEmptyListItem(schema),
      splitListItem(listItem),
      splitCheckItem(schema),
      baseKeymap.Enter,
    ),
    // Backspace right after a typing shortcut restores the literal characters.
    Backspace: chainCommands(undoInputRule, baseKeymap.Backspace),
    Tab: chainCommands(nextCellOrNewRow, sinkListItem(listItem)),
    'Shift-Tab': chainCommands(goToNextCell(-1), liftListItem(listItem)),
  };
}

export function richTextKeymap(schema: Schema): Plugin {
  return keymap(richTextKeyBindings(schema));
}

/**
 * Inline Markdown: typing the closing delimiter of `**bold**`, `*italic*`,
 * `_italic_`, `~~strike~~` or `` `code` `` formats the enclosed text and
 * drops the delimiters, as Notion does. Each pattern captures the opening
 * delimiter and the content; content may not start or end with a space.
 */
const INLINE_MARKDOWN: ReadonlyArray<{ pattern: RegExp; mark: (schema: Schema) => MarkType | undefined }> = [
  { pattern: /(?:^|[^*])(\*\*)([^\s*](?:[^*]*[^\s*])?)\*\*$/, mark: (schema) => schema.marks.strong },
  { pattern: /(?:^|[^~])(~~)([^\s~](?:[^~]*[^\s~])?)~~$/, mark: (schema) => schema.marks[STRIKE_MARK] },
  { pattern: /(?:^|[^`])(`)([^\s`](?:[^`]*[^\s`])?)`$/, mark: (schema) => schema.marks[INLINE_CODE_MARK] },
  { pattern: /(?:^|[^*])(\*)([^\s*](?:[^*]*[^\s*])?)\*$/, mark: (schema) => schema.marks.em },
  { pattern: /(?:^|[^_\p{L}\p{N}])(_)([^\s_](?:[^_]*[^\s_])?)_$/u, mark: (schema) => schema.marks.em },
];

function inlineMarkdownRules(schema: Schema): InputRule[] {
  return INLINE_MARKDOWN.flatMap(({ pattern, mark }) => {
    const markType = mark(schema);
    if (!markType) return [];
    return [new InputRule(pattern, (state, match, _start, end) => {
      const delimiter = match[1];
      const content = match[2];
      // The final typed character is not in the document yet: only the
      // closing delimiter minus that character precedes `end`.
      const contentEnd = end - (delimiter.length - 1);
      const contentStart = contentEnd - content.length;
      const openStart = contentStart - delimiter.length;
      return state.tr
        .delete(contentEnd, end)
        .delete(openStart, contentStart)
        .addMark(openStart, openStart + content.length, markType.create())
        .removeStoredMark(markType);
    })];
  });
}

/**
 * Typing shortcuts at the start of a line, as OneNote and most note apps
 * offer them: "- " or "* " starts a bullet list, "1. " a numbered list,
 * "[] " a to-do checkbox and "# " to "### " a heading.
 */
export function richTextInputRules(schema: Schema): Plugin {
  const checkItem = new InputRule(/^\[( |x|X)?\]\s$/, (state, match, start, end) => {
    const $start = state.doc.resolve(start);
    // Check items are top-level blocks in the stored format; inside a list
    // item they could not be persisted.
    if ($start.parent.type !== schema.nodes.paragraph || $start.depth !== 1) return null;
    return state.tr
      .delete(start, end)
      .setBlockType(start, start, schema.nodes.check_item, {
        checked: match[1] === 'x' || match[1] === 'X',
        blockId: createBlockId(),
      });
  });
  return inputRules({
    rules: [
      wrappingInputRule(/^\s*([-*•])\s$/, schema.nodes.bullet_list),
      wrappingInputRule(
        /^(\d+)\.\s$/,
        schema.nodes.ordered_list,
        (match) => ({ order: Number(match[1]) }),
        (match, node) => node.childCount + Number(node.attrs.order) === Number(match[1]),
      ),
      checkItem,
      textblockTypeInputRule(/^(#{1,3})\s$/, schema.nodes.heading, (match) => ({
        level: match[1].length,
      })),
      ...inlineMarkdownRules(schema),
    ],
  });
}

export function richTextTablePlugin(): Plugin {
  return tableEditing({ allowTableNodeSelection: true });
}

export function listCommands(schema: Schema): {
  bullet: Command;
  ordered: Command;
} {
  const toggleList = (listName: 'bullet_list' | 'ordered_list'): Command => {
    const list = schema.nodes[listName];
    const item = schema.nodes.list_item;
    return (state, dispatch, view) => {
      for (let depth = state.selection.$from.depth; depth > 0; depth -= 1) {
        const ancestor = state.selection.$from.node(depth);
        if (ancestor.type === list) return liftListItem(item)(state, dispatch, view);
        if (ancestor.type === schema.nodes.bullet_list || ancestor.type === schema.nodes.ordered_list) {
          if (dispatch) dispatch(state.tr.setNodeMarkup(state.selection.$from.before(depth), list));
          return true;
        }
      }
      return wrapInList(list)(state, dispatch, view);
    };
  };
  return {
    bullet: toggleList('bullet_list'),
    ordered: toggleList('ordered_list'),
  };
}

export interface RichTextTableCommands {
  addColumnBefore: Command;
  addColumnAfter: Command;
  deleteColumn: Command;
  addRowBefore: Command;
  addRowAfter: Command;
  deleteRow: Command;
  mergeCells: Command;
  splitCell: Command;
  toggleHeaderRow: Command;
  toggleHeaderColumn: Command;
  toggleHeaderCell: Command;
  deleteTable: Command;
}

export const richTextTableCommands: RichTextTableCommands = {
  addColumnBefore,
  addColumnAfter,
  deleteColumn,
  addRowBefore,
  addRowAfter,
  deleteRow,
  mergeCells,
  splitCell,
  toggleHeaderRow,
  toggleHeaderColumn,
  toggleHeaderCell,
  deleteTable,
};
