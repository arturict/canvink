import type { Schema } from 'prosemirror-model';
import { Plugin, PluginKey, TextSelection, type Command, type EditorState } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import type { TranslationKey } from '../../i18n/catalog';
import {
  insertCheckItem,
  insertTable,
  listCommands,
  setHeading,
  setParagraph,
} from './commands';
import { createRichTextBlockId } from './tablePersistence';

/**
 * Notion-style block menu: typing "/" at the start of a line or after a space
 * opens a filterable list of block types. The plugin owns the open state, the
 * query and the highlighted entry so keyboard handling stays inside the
 * editor; RichTextEditor renders the list from that state.
 */
export interface SlashItem {
  id: string;
  labelKey: TranslationKey;
  /** Markdown shortcut or key hint shown next to the label. */
  hint?: string;
  /** Lower-case search terms in German and English. */
  keywords: readonly string[];
  command: (schema: Schema) => Command;
}

export interface SlashMenuState {
  active: boolean;
  /** Document position of the "/" that opened the menu. */
  from: number;
  query: string;
  index: number;
}

type SlashMeta = { open: number } | { close: true } | { index: number };

const INACTIVE: SlashMenuState = { active: false, from: 0, query: '', index: 0 };
const MAX_QUERY_LENGTH = 24;

export const slashMenuKey = new PluginKey<SlashMenuState>('canvink-slash-menu');

function toCheckItem(schema: Schema): Command {
  return (state, dispatch, view) => {
    const { $from } = state.selection;
    // Check items are top-level blocks in the stored format.
    if ($from.parent.type === schema.nodes.paragraph && $from.depth === 1) {
      if (dispatch) {
        dispatch(state.tr.setBlockType($from.before(), $from.after(), schema.nodes.check_item, {
          checked: false,
          blockId: createRichTextBlockId('check'),
        }));
      }
      return true;
    }
    return insertCheckItem(schema)(state, dispatch, view);
  };
}

/** Inserts a table and puts the caret into its first cell, ready to type. */
function tableWithCaret(schema: Schema): Command {
  return (state, dispatch, view) => {
    const start = state.selection.from;
    return insertTable(schema, 3, 3, true)(state, dispatch && ((tr) => {
      let cellPos = -1;
      tr.doc.nodesBetween(Math.max(0, start - 1), tr.doc.content.size, (node, pos) => {
        if (cellPos >= 0) return false;
        if (node.type.spec.tableRole === 'cell' || node.type.spec.tableRole === 'header_cell') {
          cellPos = pos;
          return false;
        }
        return true;
      });
      if (cellPos >= 0) tr.setSelection(TextSelection.near(tr.doc.resolve(cellPos + 1)));
      dispatch(tr.scrollIntoView());
    }), view);
  };
}

/** "24.09.2026", the weekly page date format. */
export function formatShortDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()}`;
}

export const SLASH_ITEMS: readonly SlashItem[] = [
  { id: 'text', labelKey: 'richText.slash.text', keywords: ['text', 'absatz', 'paragraph', 'normal'], command: setParagraph },
  { id: 'h1', labelKey: 'richText.slash.heading1', hint: '#', keywords: ['h1', 'überschrift 1', 'heading 1', 'titel', 'title'], command: (schema) => setHeading(schema, 1) },
  { id: 'h2', labelKey: 'richText.slash.heading2', hint: '##', keywords: ['h2', 'überschrift 2', 'heading 2', 'untertitel'], command: (schema) => setHeading(schema, 2) },
  { id: 'h3', labelKey: 'richText.slash.heading3', hint: '###', keywords: ['h3', 'überschrift 3', 'heading 3'], command: (schema) => setHeading(schema, 3) },
  { id: 'bullet', labelKey: 'richText.slash.bullet', hint: '-', keywords: ['liste', 'aufzählung', 'bullet', 'list', 'punkte'], command: (schema) => listCommands(schema).bullet },
  { id: 'numbered', labelKey: 'richText.slash.numbered', hint: '1.', keywords: ['nummeriert', 'nummer', 'numbered', 'ordered', 'liste'], command: (schema) => listCommands(schema).ordered },
  { id: 'todo', labelKey: 'richText.slash.todo', hint: '[]', keywords: ['aufgabe', 'todo', 'to-do', 'checkbox', 'check', 'task', 'hausaufgabe'], command: toCheckItem },
  { id: 'table', labelKey: 'richText.slash.table', keywords: ['tabelle', 'table', 'raster'], command: tableWithCaret },
  {
    id: 'date',
    labelKey: 'richText.slash.date',
    keywords: ['datum', 'date', 'heute', 'today'],
    command: () => (state, dispatch) => {
      if (dispatch) dispatch(state.tr.insertText(formatShortDate(new Date())).scrollIntoView());
      return true;
    },
  },
];

export function filterSlashItems(query: string, items: readonly SlashItem[] = SLASH_ITEMS): SlashItem[] {
  const needle = query.trim().toLocaleLowerCase('de');
  if (!needle) return [...items];
  // Like Notion, a query matches the start of a word, and blocks whose id or a
  // whole keyword starts with it come first: "/h" lists the headings before
  // anything that merely has an "h" somewhere ("paragraph").
  const rank = (item: SlashItem): number => {
    if (item.id.startsWith(needle) || item.keywords.some((keyword) => keyword.startsWith(needle))) return 0;
    const words = item.keywords.flatMap((keyword) => keyword.split(/[\s-]+/));
    return words.some((word) => word.startsWith(needle)) ? 1 : 2;
  };
  return items
    .map((item, order) => ({ item, order, rank: rank(item) }))
    .filter((entry) => entry.rank < 2)
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .map((entry) => entry.item);
}

export function slashMenuState(state: EditorState): SlashMenuState {
  return slashMenuKey.getState(state) ?? INACTIVE;
}

/** Removes the typed "/query" and applies the chosen block command. */
export function runSlashItem(view: EditorView, item: SlashItem): void {
  const menu = slashMenuState(view.state);
  if (!menu.active) return;
  const head = view.state.selection.head;
  view.dispatch(view.state.tr.delete(menu.from, head).setMeta(slashMenuKey, { close: true } satisfies SlashMeta));
  item.command(view.state.schema)(view.state, view.dispatch, view);
  view.focus();
}

export function closeSlashMenu(view: EditorView): void {
  if (!slashMenuState(view.state).active) return;
  view.dispatch(view.state.tr.setMeta(slashMenuKey, { close: true } satisfies SlashMeta));
}

function opensMenu(state: EditorState, from: number, to: number): boolean {
  if (from !== to) return false;
  const $from = state.doc.resolve(from);
  if (!$from.parent.isTextblock) return false;
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, '￼');
  return before.length === 0 || /\s$/.test(before);
}

export function slashMenuPlugin(items: readonly SlashItem[] = SLASH_ITEMS): Plugin<SlashMenuState> {
  return new Plugin<SlashMenuState>({
    key: slashMenuKey,
    state: {
      init: () => INACTIVE,
      apply: (tr, previous, _oldState, newState) => {
        const meta = tr.getMeta(slashMenuKey) as SlashMeta | undefined;
        if (meta && 'close' in meta) return INACTIVE;
        if (meta && 'open' in meta) return { active: true, from: meta.open, query: '', index: 0 };
        if (!previous.active) return previous;
        const from = tr.mapping.map(previous.from);
        const { selection } = newState;
        if (!selection.empty || selection.head <= from) return INACTIVE;
        const $from = newState.doc.resolve(from);
        if (!$from.sameParent(selection.$head)) return INACTIVE;
        const typed = newState.doc.textBetween(from, selection.head, undefined, '￼');
        if (!typed.startsWith('/') || /\s/.test(typed) || typed.length > MAX_QUERY_LENGTH + 1) return INACTIVE;
        const query = typed.slice(1);
        const index = meta && 'index' in meta ? meta.index : query === previous.query ? previous.index : 0;
        return { active: true, from, query, index };
      },
    },
    props: {
      handleTextInput: (view, from, to, text) => {
        if (text !== '/' || slashMenuState(view.state).active || !opensMenu(view.state, from, to)) return false;
        view.dispatch(view.state.tr.insertText('/', from, to).setMeta(slashMenuKey, { open: from } satisfies SlashMeta));
        return true;
      },
      handleKeyDown: (view, event) => {
        const menu = slashMenuState(view.state);
        if (!menu.active) return false;
        const matches = filterSlashItems(menu.query, items);
        if (event.key === 'Escape') {
          closeSlashMenu(view);
          return true;
        }
        if (matches.length === 0) return false;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          const step = event.key === 'ArrowDown' ? 1 : -1;
          const index = (menu.index + step + matches.length) % matches.length;
          view.dispatch(view.state.tr.setMeta(slashMenuKey, { index } satisfies SlashMeta));
          return true;
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          runSlashItem(view, matches[Math.min(menu.index, matches.length - 1)]);
          return true;
        }
        return false;
      },
    },
  });
}
