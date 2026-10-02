import { EditorState, Selection, type Command } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { describe, expect, it } from 'vitest';
import { history } from 'prosemirror-history';
import { filterSlashItems, runSlashItem, slashMenuKey, slashMenuPlugin, slashMenuState } from '../richText/slashMenu';
import { parseMarkdown, serializeMarkdown } from './markdownConvert';
import {
  MARKDOWN_SLASH_ITEMS,
  markdownInputRules,
  markdownKeyBindings,
  markdownKeymap,
  markdownPastePlugin,
  trailingParagraphPlugin,
} from './markdownCommands';
import { markdownSchema as schema } from './markdownSchema';

function newState(source = ''): EditorState {
  const doc = parseMarkdown(source);
  const state = EditorState.create({
    doc,
    plugins: [
      history(),
      slashMenuPlugin(MARKDOWN_SLASH_ITEMS),
      ...markdownInputRules(schema),
      markdownKeymap(schema),
      trailingParagraphPlugin(),
    ],
  });
  return state.apply(state.tr.setSelection(Selection.atStart(doc)));
}

/** Types characters the way the browser does: input rules and the slash menu see each one first. */
function type(initial: EditorState, text: string): EditorState {
  let state = initial;
  const view = {
    get state() { return state; },
    dispatch: (transaction: Parameters<EditorView['dispatch']>[0]) => { state = state.apply(transaction); },
    composing: false,
    focus: () => undefined,
  } as unknown as EditorView;
  for (const char of text) {
    const { from, to } = state.selection;
    const handled = state.plugins.some((plugin) => plugin.props.handleTextInput?.call(plugin, view, from, to, char, () => state.tr.insertText(char, from, to)));
    if (!handled) state = state.apply(state.tr.insertText(char, from, to));
  }
  return state;
}

function press(state: EditorState, key: string): EditorState {
  let next = state;
  const view = {
    get state() { return next; },
    dispatch: (transaction: Parameters<EditorView['dispatch']>[0]) => { next = next.apply(transaction); },
    focus: () => undefined,
    endOfTextblock: () => true,
  } as unknown as EditorView;
  // The plugins read only `key`; the node test environment has no KeyboardEvent.
  const event = { key } as unknown as KeyboardEvent;
  const handled = state.plugins.some((plugin) => plugin.props.handleKeyDown?.call(plugin, view, event));
  if (!handled) {
    const command = markdownKeyBindings(schema)[key];
    command?.(next, (transaction) => { next = next.apply(transaction); }, view);
  }
  return next;
}

function run(state: EditorState, command: Command): EditorState {
  let next = state;
  command(state, (transaction) => { next = state.apply(transaction); });
  return next;
}

describe('slash menu for Markdown pages', () => {
  const ids = (query: string) => filterSlashItems(query, MARKDOWN_SLASH_ITEMS).map((item) => item.id);

  it('filters the blocks the request names', () => {
    expect(ids('h1')).toEqual(['h1']);
    expect(ids('h2')).toEqual(['h2']);
    expect(ids('h3')).toEqual(['h3']);
    expect(ids('liste')).toEqual(['bullet', 'numbered']);
    expect(ids('todo')).toEqual(['todo']);
    expect(ids('zitat')).toEqual(['quote']);
    expect(ids('code')).toEqual(['code']);
    expect(ids('tabelle')).toEqual(['table']);
    expect(ids('trennlinie')).toEqual(['divider']);
    expect(ids('text')).toEqual(['text']);
    expect(ids('xyz')).toEqual([]);
  });

  it('offers the shared blocks in the shared order, with the Markdown blocks before the table', () => {
    expect(MARKDOWN_SLASH_ITEMS.map((item) => item.id)).toEqual(
      ['text', 'h1', 'h2', 'h3', 'bullet', 'numbered', 'todo', 'quote', 'code', 'table', 'divider', 'date'],
    );
  });

  function slash(query: string, after = ''): EditorState {
    let state = type(newState(after), `/${query}`);
    expect(slashMenuState(state).active).toBe(true);
    const matches = filterSlashItems(slashMenuState(state).query, MARKDOWN_SLASH_ITEMS);
    const view = {
      get state() { return state; },
      dispatch: (transaction: Parameters<EditorView['dispatch']>[0]) => { state = state.apply(transaction); },
      focus: () => undefined,
    } as unknown as EditorView;
    runSlashItem(view, matches[0]);
    expect(slashMenuKey.getState(state)?.active).toBe(false);
    return state;
  }

  it.each([
    ['h1', 'heading', '# '],
    ['h2', 'heading', '## '],
    ['h3', 'heading', '### '],
    ['liste', 'bullet_list', '- '],
    ['todo', 'check_item', '- [ ] '],
    ['zitat', 'blockquote', '> '],
    ['code', 'code_block', '```\n'],
    ['trennlinie', 'horizontal_rule', '---'],
  ])('applies /%s', (query, nodeName, markdown) => {
    let state = slash(query);
    expect(state.doc.firstChild?.type.name).toBe(nodeName);
    state = type(state, 'Text');
    // The caret stays in the new block, or on the line below a rule.
    expect(serializeMarkdown(state.doc)).toContain(nodeName === 'horizontal_rule' ? '---\n\nText' : `${markdown}Text`);
  });

  it('applies /text back to a paragraph and /tabelle as a table', () => {
    const heading = slash('h1');
    expect(run(heading, MARKDOWN_SLASH_ITEMS[0].command(schema)).doc.firstChild?.type.name).toBe('paragraph');
    const table = slash('tabelle');
    expect(table.doc.firstChild?.type.name).toBe('table');
    expect(serializeMarkdown(table.doc)).toMatch(/^\| {2}\| {2}\| {2}\|\n\| --- \| --- \| --- \|\n/);
  });
});

describe('Markdown shortcuts while typing', () => {
  const nodeAfter = (typed: string) => type(newState(), typed).doc.firstChild;

  it.each([
    ['# ', 'heading', 1],
    ['## ', 'heading', 2],
    ['### ', 'heading', 3],
  ])('%j starts a heading', (typed, name, level) => {
    const node = nodeAfter(typed);
    expect(node?.type.name).toBe(name);
    expect(node?.attrs.level).toBe(level);
  });

  it.each([['- '], ['* ']])('%j starts a bullet list', (typed) => {
    expect(nodeAfter(typed)?.type.name).toBe('bullet_list');
  });

  it('starts a numbered list with "1. "', () => {
    expect(nodeAfter('1. ')?.type.name).toBe('ordered_list');
  });

  it.each([['[] ', false], ['[ ] ', false], ['[x] ', true]])('%j starts a to-do', (typed, checked) => {
    const node = nodeAfter(typed);
    expect(node?.type.name).toBe('check_item');
    expect(node?.attrs.checked).toBe(checked);
  });

  it('starts a quote with ">"', () => {
    expect(nodeAfter('> ')?.type.name).toBe('blockquote');
  });

  it('starts a code block with three backticks', () => {
    const state = type(newState(), '```');
    expect(state.doc.firstChild?.type.name).toBe('code_block');
    expect(serializeMarkdown(type(state, 'a = 1').doc)).toBe('```\na = 1\n```\n');
  });

  it('turns "---" into a rule with a line below', () => {
    const state = type(newState(), '---');
    expect(state.doc.child(0).type.name).toBe('horizontal_rule');
    expect(state.doc.child(1).type.name).toBe('paragraph');
    expect(state.selection.$from.parent).toBe(state.doc.child(1));
  });

  it('marks text inline with **bold**, *italic* and `code`', () => {
    const state = type(newState(), '**fett** und *kursiv* und `code`');
    expect(serializeMarkdown(state.doc)).toBe('**fett** und *kursiv* und `code`\n');
    expect(state.doc.firstChild?.child(0).marks.map((mark) => mark.type.name)).toEqual(['strong']);
  });

  it('types a list, continues it with Enter and leaves it with a second Enter', () => {
    let state = type(newState(), '- eins');
    state = press(state, 'Enter');
    state = type(state, 'zwei');
    state = press(state, 'Enter');
    state = press(state, 'Enter');
    state = type(state, 'danach');
    expect(serializeMarkdown(state.doc)).toBe('- eins\n- zwei\n\ndanach\n');
  });

  it('types to-dos that stay one list in the file', () => {
    let state = type(newState(), '[] eins');
    state = press(state, 'Enter');
    state = type(state, 'zwei');
    expect(serializeMarkdown(state.doc)).toBe('- [ ] eins\n- [ ] zwei\n');
  });

  it('adds a line inside a code block on Enter instead of splitting it', () => {
    let state = type(newState(), '```');
    state = type(state, 'a');
    state = press(state, 'Enter');
    state = type(state, 'b');
    expect(serializeMarkdown(state.doc)).toBe('```\na\nb\n```\n');
  });

  it('undoes a shortcut with Backspace and keeps the typed characters', () => {
    let state = type(newState(), '# ');
    state = press(state, 'Backspace');
    expect(state.doc.firstChild?.type.name).toBe('paragraph');
    expect(state.doc.firstChild?.textContent).toBe('# ');
  });
});

describe('Backspace at the start of a block', () => {
  function caretAtStartOf(source: string, index: number): EditorState {
    const doc = parseMarkdown(source);
    let position = 0;
    doc.forEach((node, offset, childIndex) => {
      if (childIndex === index) position = offset + 1;
    });
    const state = EditorState.create({ doc, plugins: [markdownKeymap(schema)] });
    return state.apply(state.tr.setSelection(Selection.near(doc.resolve(position), 1)));
  }

  it.each([
    ['# Titel\n', 0],
    ['- [ ] Aufgabe\n', 0],
    ['```\ncode\n```\n', 0],
  ])('turns %j back into a paragraph', (source, index) => {
    const state = press(caretAtStartOf(source, index), 'Backspace');
    expect(state.doc.child(index).type.name).toBe('paragraph');
  });

  it('steps out of a quote and a list item', () => {
    const quote = press(caretAtStartOf('> Zitat\n', 0), 'Backspace');
    expect(quote.doc.firstChild?.type.name).toBe('paragraph');
    const list = press(caretAtStartOf('- eins\n- zwei\n', 0), 'Backspace');
    expect(list.doc.firstChild?.type.name).toBe('paragraph');
    expect(serializeMarkdown(list.doc, { keepSource: false })).toBe('eins\n\n- zwei\n');
  });
});

describe('editing keeps the rest of the file as it was', () => {
  it('rewrites only the edited block', () => {
    const source = '# Titel\n\n\n\nAlt   mit  Abstand\n\n* stern\n* liste\n';
    let state = EditorState.create({ doc: parseMarkdown(source) });
    state = state.apply(state.tr.insertText('!', 6));
    expect(serializeMarkdown(state.doc)).toBe('# Titel!\n\nAlt   mit  Abstand\n\n* stern\n* liste\n');
  });
});

describe('pasting Markdown', () => {
  it('reads plain text as Markdown blocks', () => {
    const plugin = markdownPastePlugin(schema);
    const slice = plugin.props.clipboardTextParser?.call(plugin, '# Titel\n\n- a\n- b\n', schema.nodes.doc.create(null, schema.nodes.paragraph.create()).resolve(1), false, {} as EditorView);
    expect(slice?.content.child(0).type.name).toBe('heading');
    expect(slice?.content.child(1).type.name).toBe('bullet_list');
  });

  it('keeps a single pasted line inline', () => {
    const plugin = markdownPastePlugin(schema);
    const slice = plugin.props.clipboardTextParser?.call(plugin, 'nur **eine** Zeile', schema.nodes.doc.create(null, schema.nodes.paragraph.create()).resolve(1), false, {} as EditorView);
    expect(slice?.openStart).toBe(1);
    expect(slice?.content.child(0).textContent).toBe('nur eine Zeile');
  });
});
