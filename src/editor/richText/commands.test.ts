import { EditorState, TextSelection, type Command } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import {
  listCommands,
  richTextKeyBindings,
  removeLink,
  richTextTableCommands,
  setHeading,
  setLink,
  toggleStrong,
} from './commands';
import { richTextToolbarSnapshot } from './RichTextToolbar';
import { canvinkRichTextSchema as schema } from './schema';

function run(state: EditorState, command: Command): EditorState {
  return runCommand(state, command);
}

function runCommand(state: EditorState, command: Command): EditorState {
  let next = state;
  expect(command(state, (transaction) => { next = state.apply(transaction); })).toBe(true);
  return next;
}

function selectedParagraph(text = 'Newton'): EditorState {
  const doc = schema.nodes.doc.create(null, schema.nodes.paragraph.create(null, schema.text(text)));
  const state = EditorState.create({ doc });
  return state.apply(state.tr.setSelection(TextSelection.create(doc, 1, text.length + 1)));
}

describe('rich-text formatting commands', () => {
  it('applies and updates only safe links, then removes them', () => {
    let state = selectedParagraph();
    state = run(state, setLink(schema, 'https://example.ch/labor', 'Labor'));
    expect(state.doc.rangeHasMark(1, 7, schema.marks.link)).toBe(true);
    expect(richTextToolbarSnapshot(state).link).toEqual({
      href: 'https://example.ch/labor',
      title: 'Labor',
    });

    state = run(state, setLink(schema, 'mailto:team@example.ch'));
    expect(state.doc.nodeAt(1)?.marks.filter((mark) => mark.type === schema.marks.link)).toHaveLength(1);
    expect(state.doc.nodeAt(1)?.marks.find((mark) => mark.type === schema.marks.link)?.attrs.href).toBe(
      'mailto:team@example.ch',
    );
    expect(setLink(schema, 'javascript:alert(1)')(state)).toBe(false);
    state = run(state, removeLink(schema));
    expect(state.doc.rangeHasMark(1, 7, schema.marks.link)).toBe(false);
  });

  it('reports active mark and heading state for accessible pressed feedback', () => {
    let state = selectedParagraph();
    state = run(state, toggleStrong(schema));
    state = run(state, setHeading(schema, 2));
    expect(richTextToolbarSnapshot(state)).toMatchObject({
      block: 'heading-2',
      strong: true,
      hasTextSelection: true,
    });
  });

  it('toggles bullet lists off and converts between bullet and numbered lists', () => {
    let state = selectedParagraph('Liste');
    const lists = listCommands(schema);
    state = run(state, lists.bullet);
    expect(state.doc.firstChild?.type).toBe(schema.nodes.bullet_list);
    expect(richTextToolbarSnapshot(state).bulletList).toBe(true);

    state = run(state, lists.ordered);
    expect(state.doc.firstChild?.type).toBe(schema.nodes.ordered_list);
    expect(richTextToolbarSnapshot(state).orderedList).toBe(true);

    state = run(state, lists.ordered);
    expect(state.doc.firstChild?.type).toBe(schema.nodes.paragraph);
  });

  it('adds and removes rows and columns only from a table selection', () => {
    const paragraph = schema.nodes.paragraph.create(null, schema.text('Zelle'));
    const cell = schema.nodes.table_cell.create(null, paragraph);
    const row = schema.nodes.table_row.create(null, [cell, cell]);
    const doc = schema.nodes.doc.create(null, schema.nodes.table.create({ blockId: 'table-1' }, [row, row]));
    let state = EditorState.create({ doc });
    state = state.apply(state.tr.setSelection(TextSelection.create(doc, 4)));

    state = run(state, richTextTableCommands.addRowAfter);
    expect(state.doc.firstChild?.childCount).toBe(3);
    state = run(state, richTextTableCommands.addColumnAfter);
    expect(state.doc.firstChild?.firstChild?.childCount).toBe(3);
    state = run(state, richTextTableCommands.deleteRow);
    expect(state.doc.firstChild?.childCount).toBe(2);
    state = run(state, richTextTableCommands.deleteColumn);
    expect(state.doc.firstChild?.firstChild?.childCount).toBe(2);
  });

  it('leaves a list when Enter is pressed in an empty item, like OneNote', () => {
    const item = (text?: string) => schema.nodes.list_item.create(
      null,
      schema.nodes.paragraph.create(null, text ? schema.text(text) : undefined),
    );
    const doc = schema.nodes.doc.create(null, schema.nodes.bullet_list.create(null, [item('Milch'), item()]));
    const initial = EditorState.create({ doc });
    // Caret in the empty second item: bullet_list(0) > item(1+) > paragraph.
    const emptyParagraphStart = doc.child(0).child(0).nodeSize + 3;
    const state = initial.apply(initial.tr.setSelection(TextSelection.create(doc, emptyParagraphStart)));

    const next = run(state, richTextKeyBindings(schema).Enter);

    expect(next.doc.childCount).toBe(2);
    expect(next.doc.child(0).type).toBe(schema.nodes.bullet_list);
    expect(next.doc.child(0).childCount).toBe(1);
    expect(next.doc.child(1).type).toBe(schema.nodes.paragraph);
  });
});

describe('note-taking keys', () => {
  it('turns an empty to-do back into a paragraph on Enter', () => {
    const doc = schema.nodes.doc.create(null, [
      schema.nodes.check_item.create({ checked: false, blockId: 'a' }, schema.text('Übungen')),
      schema.nodes.check_item.create({ checked: false, blockId: 'b' }),
    ]);
    const initial = EditorState.create({ doc });
    const state = initial.apply(initial.tr.setSelection(TextSelection.create(doc, doc.child(0).nodeSize + 1)));
    const next = run(state, richTextKeyBindings(schema).Enter);
    expect(next.doc.child(1).type).toBe(schema.nodes.paragraph);
  });

  it('moves through table cells with Tab and adds a row after the last cell', () => {
    const cell = (value: string) => schema.nodes.table_cell.create(null, schema.nodes.paragraph.create(null, value ? schema.text(value) : undefined));
    const doc = schema.nodes.doc.create(null, schema.nodes.table.create(null, [
      schema.nodes.table_row.create(null, [cell('Fach'), cell('Aufgabe')]),
    ]));
    const initial = EditorState.create({ doc });
    let state = initial.apply(initial.tr.setSelection(TextSelection.create(doc, 4)));
    state = run(state, richTextKeyBindings(schema).Tab);
    expect(state.selection.$from.parent.textContent).toBe('Aufgabe');
    state = run(state, richTextKeyBindings(schema).Tab);
    expect(state.doc.child(0).childCount).toBe(2);
    expect(state.selection.$from.parent.textContent).toBe('');
  });
});

describe('OneNote shortcuts', () => {
  it('toggles the current line between text and a to-do with Ctrl+1', () => {
    const doc = schema.nodes.doc.create(null, schema.nodes.paragraph.create(null, schema.text('Aufsatz verbessern')));
    const initial = EditorState.create({ doc });
    let state = initial.apply(initial.tr.setSelection(TextSelection.create(doc, 3)));
    state = run(state, richTextKeyBindings(schema)['Mod-1']);
    expect(state.doc.child(0).type).toBe(schema.nodes.check_item);
    expect(state.doc.textContent).toBe('Aufsatz verbessern');
    state = run(state, richTextKeyBindings(schema)['Mod-1']);
    expect(state.doc.child(0).type).toBe(schema.nodes.paragraph);
  });
});
