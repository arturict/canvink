import * as Automerge from '@automerge/automerge';
import { pmDocFromSpans, pmNodeToSpans } from '@automerge/prosemirror';
import pmToAutomerge from '@automerge/prosemirror/dist/pmToAm.js';
import type { Node as ProseMirrorNode } from 'prosemirror-model';
import { EditorState, TextSelection, type Transaction } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { canvinkRichTextSchema as schema, canvinkSchemaAdapter as adapter } from './schema';
import { plainTextEdit, writeTransactionToAutomerge } from './syncPluginCompat';

interface TextDocument {
  [key: string]: unknown;
  text: string;
}

const PATH = ['text'];

function startingDocument(): ProseMirrorNode {
  const strong = schema.marks.strong.create();
  const paragraph = (...content: ProseMirrorNode[]) => schema.nodes.paragraph.create(null, content);
  return schema.nodes.doc.create(null, [
    schema.nodes.heading.create({ level: 2 }, schema.text('Impulserhaltung')),
    paragraph(schema.text('Der Impuls ist eine '), schema.text('Erhaltungsgrösse', [strong]), schema.text(' der Mechanik.')),
    schema.nodes.bullet_list.create(null, [
      schema.nodes.list_item.create(null, paragraph(schema.text('elastischer Stoss'))),
      schema.nodes.list_item.create(null, paragraph(schema.text('unelastischer Stoss'))),
    ]),
    paragraph(schema.text('p = m · v')),
    paragraph(),
  ]);
}

/** Two documents holding the same text, one per writer, and the editor state they mirror. */
function fixture() {
  const seeded = Automerge.change(Automerge.from<TextDocument>({ text: '' }), (draft) => {
    Automerge.updateSpans(draft, PATH, pmNodeToSpans(adapter, startingDocument()), adapter.updateSpansConfig());
  });
  const state = EditorState.create({
    schema,
    doc: pmDocFromSpans(adapter, Automerge.spans(seeded, PATH)),
  });
  return { stock: seeded, direct: Automerge.clone(seeded), state };
}

function seededRandom(seed: number): () => number {
  let value = seed;
  return () => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    return value / 2 ** 32;
  };
}

/** The text and formatting of a document, as the editor would show it. */
function shown(document: Automerge.Doc<TextDocument>): unknown {
  return pmDocFromSpans(adapter, Automerge.spans(document, PATH)).toJSON();
}

describe('writing text edits into Automerge', () => {
  it('splices an edit of unformatted text and leaves everything else to the stock writer', () => {
    const { state } = fixture();
    const inHeading = 4;
    const typed = state.tr.insertText('x', inHeading);
    expect(plainTextEdit(typed.steps[0], typed.docs[0])).toEqual({ from: inHeading, to: inHeading, text: 'x' });

    const backspace = state.tr.delete(inHeading - 1, inHeading);
    expect(plainTextEdit(backspace.steps[0], backspace.docs[0])).toEqual({ from: inHeading - 1, to: inHeading, text: '' });

    // Text typed at the edge of bold text gets marks the writer must reconcile.
    let boldStart = -1;
    state.doc.descendants((node, position) => {
      if (node.isText && node.marks.length > 0 && boldStart < 0) boldStart = position;
      return true;
    });
    const atBoldEdge = state.tr.insertText('x', boldStart);
    expect(plainTextEdit(atBoldEdge.steps[0], atBoldEdge.docs[0])).toBeNull();

    // Splitting a block is not a text edit.
    const split = state.tr.split(inHeading);
    expect(plainTextEdit(split.steps[0], split.docs[0])).toBeNull();
    // Nor is a deletion across blocks.
    const across = state.tr.delete(inHeading, state.doc.child(0).nodeSize + 6);
    expect(across.steps.every((step, index) => plainTextEdit(step, across.docs[index]) === null)).toBe(true);
  });

  it.each([1, 2, 3, 4])('writes the same text and formatting as the stock writer (random edits, seed %i)', (seed) => {
    const random = seededRandom(seed);
    let { stock, direct, state } = fixture();
    const words = ['Impuls', 'Kraft', ' und ', 'ä', '  ', 'x=1', 'Energie'];
    const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
    const position = () => {
      const near = TextSelection.near(state.doc.resolve(Math.floor(random() * (state.doc.content.size - 1)) + 1));
      return near.from;
    };

    let plainEdits = 0;
    for (let step = 0; step < 120; step += 1) {
      const transaction: Transaction = state.tr;
      const at = position();
      const $at = state.doc.resolve(at);
      const kind = random();
      if (kind < 0.45) {
        transaction.insertText(pick(words), at);
      } else if (kind < 0.7) {
        const to = Math.min(at + 1 + Math.floor(random() * 4), $at.end());
        if (to > at) transaction.delete(at, to);
      } else if (kind < 0.8) {
        const from = Math.max($at.start(), at - 1 - Math.floor(random() * 3));
        if (at > from) transaction.delete(from, at);
      } else if (kind < 0.86) {
        const to = Math.min(at + 2 + Math.floor(random() * 6), $at.end());
        if (to > at) transaction.addMark(at, to, schema.marks.em.create());
      } else if (kind < 0.9) {
        const to = Math.min(at + 2 + Math.floor(random() * 6), $at.end());
        if (to > at) transaction.removeMark(at, to, schema.marks.strong);
      } else if (kind < 0.95) {
        const to = Math.min(at + 1 + Math.floor(random() * 5), $at.end());
        if (to > at) transaction.insertText(pick(words), at, to);
      } else if ($at.parent.isTextblock && $at.parentOffset > 0 && $at.parentOffset < $at.parent.content.size) {
        transaction.split(at);
      }
      if (!transaction.docChanged) continue;

      const applied = transaction;
      stock = Automerge.change(stock, (draft) => {
        pmToAutomerge(adapter, Automerge.spans(draft, PATH), applied.steps, draft, applied.docs[0], PATH);
      });
      direct = Automerge.change(direct, (draft) => writeTransactionToAutomerge(adapter, draft, PATH, applied));
      plainEdits += applied.steps.filter((edit, index) => plainTextEdit(edit, applied.docs[index])).length;
      state = state.apply(applied);

      expect(shown(direct)).toEqual(shown(stock));
    }
    // The random edits reach the direct path often enough to compare it.
    expect(plainEdits).toBeGreaterThan(30);
    // The Automerge text still mirrors what the editor shows.
    expect(pmDocFromSpans(adapter, Automerge.spans(direct, PATH)).textContent).toBe(state.doc.textContent);
  }, 60_000);
});
