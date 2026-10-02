import * as Automerge from '@automerge/automerge';
import { Repo } from '@automerge/automerge-repo';
import { pmDocFromSpans, pmNodeToSpans } from '@automerge/prosemirror';
import { undo } from 'prosemirror-history';
import { EditorState, TextSelection, type Command } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import {
  CanvinkStorageAdapter,
  MemoryCanvinkStorageBridge,
} from '../../crdt/canvinkStorageAdapter';
import {
  createRichTextEditorState,
  type RichTextDocHandle,
  type RichTextWriter,
} from './RichTextEditor';
import {
  insertCheckItem,
  insertTable,
  richTextKeyBindings,
  richTextTableCommands,
  setHeading,
  setLink,
  toggleStrong,
} from './commands';
import {
  TABLE_ROW_BLOCK,
  UNDERLINE_MARK,
  canvinkRichTextSchema as schema,
  canvinkSchemaAdapter,
} from './schema';
import { repairLegacyTableSpans } from './tablePersistence';

interface TestDocument {
  [key: string]: unknown;
  text: string;
}

type MutableTestHandle<T> = RichTextDocHandle<T> & {
  change(callback: (document: Automerge.Doc<T>) => void): void;
};

function testWriter<T>(handle: RichTextDocHandle<T>): RichTextWriter<T> {
  return (change) => (handle as MutableTestHandle<T>).change(change);
}

function richTextEditorState<T>(
  handle: RichTextDocHandle<T>,
  path: readonly Automerge.Prop[],
): EditorState {
  return createRichTextEditorState(handle, path, testWriter(handle));
}

function changeHandle<T>(
  handle: RichTextDocHandle<T>,
  change: (document: Automerge.Doc<T>) => void,
): void {
  (handle as MutableTestHandle<T>).change(change);
}

function runCommand(state: EditorState, command: Command): EditorState {
  let next = state;
  expect(command(state, (transaction) => { next = state.apply(transaction); })).toBe(true);
  return next;
}

function firstTableCellTextPosition(state: EditorState): number {
  let result: number | null = null;
  state.doc.descendants((node, position) => {
    if (result !== null) return false;
    if (node.type.name === 'table_cell' || node.type.name === 'table_header') {
      result = position + 2;
      return false;
    }
    return true;
  });
  if (result === null) throw new Error('Expected a table cell.');
  return result;
}

function tableShape(state: EditorState): { rows: number; columns: number; text: string[] } {
  const table = state.doc.children.find((node) => node.type.name === 'table');
  if (!table) throw new Error('Expected a table.');
  const text: string[] = [];
  table.forEach((row) => row.forEach((cell) => text.push(cell.textContent)));
  return {
    rows: table.childCount,
    columns: table.firstChild?.childCount ?? 0,
    text,
  };
}

describe('Automerge rich-text binding', () => {
  it('accepts a real Repo DocHandle and synchronizes local PM transactions', () => {
    const repo = new Repo({ network: [] });
    const handle: RichTextDocHandle<TestDocument> = repo.create<TestDocument>({ text: '' });
    let state = richTextEditorState(handle, ['text']);

    state = state.apply(
      state.tr
        .setSelection(TextSelection.atEnd(state.doc))
        .insertText('Newton'),
    );

    expect(handle.doc().text).toBe('Newton');
    expect(pmDocFromSpans(canvinkSchemaAdapter, Automerge.spans(handle.doc(), ['text'])).textContent).toBe(
      'Newton',
    );

    let undoTransaction = state.tr;
    expect(undo(state, (transaction) => { undoTransaction = transaction; })).toBe(true);
    state = state.apply(undoTransaction);
    expect(state.doc.textContent).toBe('');
    expect(handle.doc().text).toBe('');
  });

  it('merges concurrent text and distinct formatting marks without loss', () => {
    const base = Automerge.from<TestDocument>({ text: 'force' });
    let alice = Automerge.clone(base);
    let bob = Automerge.clone(base);

    alice = Automerge.change(alice, (doc) => {
      Automerge.splice(doc, ['text'], 0, 0, 'left ');
      Automerge.mark(doc, ['text'], { start: 0, end: 10, expand: 'both' }, 'strong', true);
    });
    bob = Automerge.change(bob, (doc) => {
      Automerge.splice(doc, ['text'], 5, 0, ' right');
      Automerge.mark(doc, ['text'], { start: 0, end: 11, expand: 'both' }, UNDERLINE_MARK, true);
    });

    const merged = Automerge.merge(alice, bob);
    const mergedPm = pmDocFromSpans(canvinkSchemaAdapter, Automerge.spans(merged, ['text']));
    expect(mergedPm.textContent).toContain('left');
    expect(mergedPm.textContent).toContain('force');
    expect(mergedPm.textContent).toContain('right');
    const markNames = new Set<string>();
    mergedPm.descendants((node) => node.marks.forEach((mark) => markNames.add(mark.type.name)));
    expect(markNames).toEqual(new Set(['strong', UNDERLINE_MARK]));
  });

  it('provides safe checklist/table commands and rejects a malicious link command', () => {
    const repo = new Repo({ network: [] });
    const handle: RichTextDocHandle<TestDocument> = repo.create<TestDocument>({ text: '' });
    let state = richTextEditorState(handle, ['text']);

    let transaction = state.tr;
    expect(insertCheckItem(schema, 'Complete lab')(state, (next) => { transaction = next; })).toBe(true);
    state = state.apply(transaction);
    expect(state.doc.firstChild?.type.name).toBe('check_item');
    expect(state.doc.firstChild?.attrs.blockId).toMatch(/^.{8,}$/);

    transaction = state.tr;
    expect(insertTable(schema, 2, 3, true)(state, (next) => { transaction = next; })).toBe(true);
    state = state.apply(transaction);
    const table = state.doc.children.find((node) => node.type.name === 'table');
    expect(table?.childCount).toBe(2);
    expect(table?.child(0).childCount).toBe(3);

    expect(setLink(schema, 'javascript:alert(1)')(state)).toBe(false);
  });

  it('runs the checklist Enter command before the base keymap fallback', () => {
    const blockId = 'check-original';
    const doc = schema.nodes.doc.create(null, [
      schema.nodes.check_item.create(
        { checked: true, blockId },
        schema.text('Finish lab'),
      ),
    ]);
    let state = EditorState.create({ doc });
    state = state.apply(state.tr.setSelection(TextSelection.atEnd(state.doc)));

    expect(richTextKeyBindings(schema).Enter(state, (transaction) => {
      state = state.apply(transaction);
    })).toBe(true);
    expect(state.doc.childCount).toBe(2);
    expect(state.doc.child(0).attrs).toMatchObject({ checked: true, blockId });
    expect(state.doc.child(1).attrs.checked).toBe(false);
    expect(state.doc.child(1).attrs.blockId).not.toBe(blockId);
  });

  it('persists toolbar mark and block commands through the Automerge binding', () => {
    const repo = new Repo({ network: [] });
    const handle: RichTextDocHandle<TestDocument> = repo.create<TestDocument>({ text: 'Newton' });
    let state = richTextEditorState(handle, ['text']);
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1, 7)));
    let transaction = state.tr;
    expect(toggleStrong(schema)(state, (next) => { transaction = next; })).toBe(true);
    state = state.apply(transaction);
    expect(handle.doc().text).toBe('Newton');
    expect(Automerge.spans(handle.doc(), ['text']).some(
      (span) => span.type === 'text' && span.marks?.strong === true,
    )).toBe(true);

    expect(setHeading(schema, 2)(state, (next) => { transaction = next; })).toBe(true);
    state = state.apply(transaction);
    expect(state.doc.firstChild?.type).toBe(schema.nodes.heading);
    expect(state.doc.firstChild?.attrs.level).toBe(2);
  });

  it('changes an explicitly seeded paragraph block into a heading', () => {
    const repo = new Repo({ network: [] });
    const handle: RichTextDocHandle<TestDocument> = repo.create<TestDocument>({ text: '' });
    changeHandle(handle, (document) => {
      const paragraph = schema.nodes.doc.create(null, schema.nodes.paragraph.create(
        { blockId: 'paragraph-1' },
        schema.text('Laborbericht'),
      ));
      Automerge.updateSpans(
        document,
        ['text'],
        pmNodeToSpans(canvinkSchemaAdapter, paragraph),
        canvinkSchemaAdapter.updateSpansConfig(),
      );
    });
    let state = richTextEditorState(handle, ['text']);
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1, 13)));
    let transaction = state.tr;
    expect(setHeading(schema, 2)(state, (next) => { transaction = next; })).toBe(true);
    state = state.apply(transaction);
    expect(state.doc.firstChild?.type).toBe(schema.nodes.heading);
  });

  it('changes a paragraph block at the stable nested live element path', () => {
    interface NestedDocument { [key: string]: unknown; elementsById: Record<string, { text: string }> }
    const repo = new Repo({ network: [] });
    const handle: RichTextDocHandle<NestedDocument> = repo.create<NestedDocument>({
      elementsById: { 'text-1': { text: '' } },
    });
    const path: Automerge.Prop[] = ['elementsById', 'text-1', 'text'];
    changeHandle(handle, (document) => {
      const paragraph = schema.nodes.doc.create(null, schema.nodes.paragraph.create(
        { blockId: 'paragraph-1' },
        schema.text('Laborbericht'),
      ));
      Automerge.updateSpans(
        document,
        path,
        pmNodeToSpans(canvinkSchemaAdapter, paragraph),
        canvinkSchemaAdapter.updateSpansConfig(),
      );
    });
    let state = richTextEditorState(handle, path);
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1, 13)));
    let transaction = state.tr;
    expect(toggleStrong(schema)(state, (next) => { transaction = next; })).toBe(true);
    state = state.apply(transaction);
    expect(setHeading(schema, 2)(state, (next) => { transaction = next; })).toBe(true);
    state = state.apply(transaction);
    expect(state.doc.firstChild?.type).toBe(schema.nodes.heading);
  });

  it('retains an edited 3x3 table exactly after a persisted Repo close and reopen', async () => {
    const bridge = new MemoryCanvinkStorageBridge();
    const firstRepo = new Repo({
      storage: new CanvinkStorageAdapter({ bridge }),
      network: [],
      isEphemeral: false,
    });
    const firstHandle = firstRepo.create<TestDocument>({ text: '' });
    const documentUrl = firstHandle.url;
    let state = richTextEditorState(
      firstHandle as RichTextDocHandle<TestDocument>,
      ['text'],
    );
    state = runCommand(state, insertTable(schema, 2, 2, true));
    state = state.apply(state.tr.setSelection(TextSelection.create(
      state.doc,
      firstTableCellTextPosition(state),
    )));
    state = runCommand(state, richTextTableCommands.addRowAfter);
    state = runCommand(state, richTextTableCommands.addColumnAfter);

    const paragraphPositions: number[] = [];
    state.doc.descendants((node, position, parent) => {
      if (node.type.name === 'paragraph' && parent?.type.name.match(/^table_(cell|header)$/)) {
        paragraphPositions.push(position + 1);
      }
      return true;
    });
    let transaction = state.tr;
    [...paragraphPositions].reverse().forEach((position, index) => {
      transaction = transaction.insertText(`cell-${paragraphPositions.length - index}`, position);
    });
    state = state.apply(transaction);
    expect(tableShape(state)).toEqual({
      rows: 3,
      columns: 3,
      text: Array.from({ length: 9 }, (_, index) => `cell-${index + 1}`),
    });
    await firstRepo.flush();
    await firstRepo.shutdown();

    const reopenedRepo = new Repo({
      storage: new CanvinkStorageAdapter({ bridge }),
      network: [],
      isEphemeral: false,
    });
    const reopenedHandle = await reopenedRepo.find<TestDocument>(documentUrl);
    await reopenedHandle.whenReady();
    const reopened = richTextEditorState(
      reopenedHandle as RichTextDocHandle<TestDocument>,
      ['text'],
    );
    expect(tableShape(reopened)).toEqual(tableShape(state));
    const table = reopened.doc.children.find((node) => node.type.name === 'table');
    const identities = new Set<string>();
    table?.descendants((node) => {
      if (node.type.name.startsWith('table_')) identities.add(String(node.attrs.blockId));
      return true;
    });
    expect(identities.size).toBe(12);
    await reopenedRepo.shutdown();
  });

  it('repairs legacy header-first table spans once without losing cell content', () => {
    const repo = new Repo({ network: [] });
    const handle: RichTextDocHandle<TestDocument> = repo.create<TestDocument>({ text: '' });
    const paragraph = (text: string) => schema.nodes.paragraph.create(null, schema.text(text));
    const legacyTable = schema.nodes.table.create(null, schema.nodes.table_row.create(null, [
      schema.nodes.table_header.create(null, paragraph('H1')),
      schema.nodes.table_header.create(null, paragraph('H2')),
      schema.nodes.table_cell.create(null, paragraph('A1')),
      schema.nodes.table_cell.create(null, paragraph('A2')),
      schema.nodes.table_cell.create(null, paragraph('B1')),
      schema.nodes.table_cell.create(null, paragraph('B2')),
    ]));
    changeHandle(handle, (document) => {
      Automerge.updateSpans(
        document,
        ['text'],
        pmNodeToSpans(
          canvinkSchemaAdapter,
          schema.nodes.doc.create(null, [schema.nodes.paragraph.create(), legacyTable]),
        ),
        canvinkSchemaAdapter.updateSpansConfig(),
      );
    });

    const repairedLegacySpans = repairLegacyTableSpans(Automerge.spans(handle.doc(), ['text']));
    expect(repairedLegacySpans.changed).toBe(true);
    expect(repairedLegacySpans.spans.filter(
      (span) => span.type === 'block'
        && Automerge.isImmutableString(span.value.type)
        && span.value.type.val === TABLE_ROW_BLOCK,
    )).toHaveLength(3);
    const repaired = richTextEditorState(handle, ['text']);
    expect(tableShape(repaired)).toEqual({
      rows: 3,
      columns: 2,
      text: ['H1', 'H2', 'A1', 'A2', 'B1', 'B2'],
    });
    const repairedHeads = Automerge.getHeads(handle.doc());
    const rowMarkers = Automerge.spans(handle.doc(), ['text']).filter(
      (span) => span.type === 'block'
        && Automerge.isImmutableString(span.value.type)
        && span.value.type.val === TABLE_ROW_BLOCK,
    );
    expect(rowMarkers).toHaveLength(3);

    const reopened = richTextEditorState(handle, ['text']);
    expect(tableShape(reopened)).toEqual(tableShape(repaired));
    expect(Automerge.getHeads(handle.doc())).toEqual(repairedHeads);
  });

  it('converges concurrent edits in cells on different rows without changing table shape', () => {
    const table = schema.nodes.table.create(
      { blockId: 'table-concurrent', isAmgBlock: true },
      Array.from({ length: 2 }, (_, rowIndex) => schema.nodes.table_row.create(
        { blockId: `row-${rowIndex}`, isAmgBlock: true },
        Array.from({ length: 2 }, (_, columnIndex) => schema.nodes.table_cell.create(
          { blockId: `cell-${rowIndex}-${columnIndex}`, isAmgBlock: true },
          schema.nodes.paragraph.create(null, schema.text(`${rowIndex}:${columnIndex}`)),
        )),
      )),
    );
    const base = Automerge.from<TestDocument>({ text: '' });
    const seeded = Automerge.change(base, (document) => {
      Automerge.updateSpans(
        document,
        ['text'],
        pmNodeToSpans(canvinkSchemaAdapter, schema.nodes.doc.create(null, table)),
        canvinkSchemaAdapter.updateSpansConfig(),
      );
    });
    const spans = Automerge.spans(seeded, ['text']);
    const textOffsets = new Map<string, number>();
    let offset = 0;
    spans.forEach((span) => {
      if (span.type === 'block') {
        offset += 1;
      } else {
        textOffsets.set(span.value, offset);
        offset += span.value.length;
      }
    });

    let alice = Automerge.clone(seeded);
    let bob = Automerge.clone(seeded);
    alice = Automerge.change(alice, (document) => {
      Automerge.splice(document, ['text'], textOffsets.get('0:0') ?? 0, 3, 'Alice');
    });
    bob = Automerge.change(bob, (document) => {
      Automerge.splice(document, ['text'], textOffsets.get('1:1') ?? 0, 3, 'Bob');
    });
    const aliceMerged = Automerge.merge(alice, bob);
    const bobMerged = Automerge.merge(bob, alice);
    const aliceDoc = pmDocFromSpans(
      canvinkSchemaAdapter,
      Automerge.spans(aliceMerged, ['text']),
    );
    const bobDoc = pmDocFromSpans(
      canvinkSchemaAdapter,
      Automerge.spans(bobMerged, ['text']),
    );
    expect(aliceDoc.toJSON()).toEqual(bobDoc.toJSON());
    const mergedState = EditorState.create({ doc: aliceDoc });
    expect(tableShape(mergedState)).toEqual({
      rows: 2,
      columns: 2,
      text: ['Alice', '0:1', '1:0', 'Bob'],
    });
  });
});
