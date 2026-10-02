import * as Automerge from '@automerge/automerge';
import type { SchemaAdapter } from '@automerge/prosemirror';
import pmToAutomerge from '@automerge/prosemirror/dist/pmToAm.js';
import { pmRangeToAmRange } from '@automerge/prosemirror/dist/traversal.js';
import { Plugin, PluginKey, type EditorState, type Transaction } from 'prosemirror-state';
import { Slice, type Node as ProseMirrorNode } from 'prosemirror-model';
import { pmDocFromSpans, pmNodeToSpans } from '@automerge/prosemirror';
import type { RichTextDocHandle, RichTextWriter } from './RichTextEditor';
import { RICH_TEXT_EDIT_MESSAGE } from './editStamp';

export const canvinkSyncPluginKey = new PluginKey('canvink-automerge-sync');
const RECONCILE_META = 'canvink-automerge-reconcile';

function reconciledTransaction(
  state: EditorState,
  canonicalDoc: ProseMirrorNode,
): Transaction | null {
  const start = state.doc.content.findDiffStart(canonicalDoc.content);
  if (start === null) return null;
  const end = state.doc.content.findDiffEnd(canonicalDoc.content);
  if (end === null) return null;
  const transaction = state.tr.replace(start, end.a, canonicalDoc.slice(start, end.b));
  try {
    transaction.setSelection(state.selection.map(transaction.doc, transaction.mapping));
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
  }
  transaction.setStoredMarks(state.storedMarks);
  transaction.setMeta('addToHistory', false);
  transaction.setMeta(RECONCILE_META, true);
  return transaction;
}

/**
 * Whether the rich-text field still exists. A remote collaborator, an undo or
 * the discarding of an empty container can delete the element while its
 * editor is still mounted; reading spans from the vanished path would throw.
 */
function pathResolves(document: unknown, path: readonly Automerge.Prop[]): boolean {
  let current: unknown = document;
  for (const key of path) {
    if (current === null || typeof current !== 'object') return false;
    current = (current as Record<string | number, unknown>)[key];
  }
  return current !== undefined;
}

function pathsIntersect(left: readonly Automerge.Prop[], right: readonly Automerge.Prop[]): boolean {
  const sharedLength = Math.min(left.length, right.length);
  for (let index = 0; index < sharedLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

type ProseMirrorStep = Transaction['steps'][number];

interface PlainTextEdit {
  from: number;
  to: number;
  /** The inserted text; empty for a deletion. */
  text: string;
}

/**
 * A step that only inserts, deletes or replaces unformatted text inside one
 * text block: a keystroke, a backspace, typing over a selection. Nothing in
 * it joins or splits blocks, and no mark can start or end at its edges, so it
 * is one splice of the Automerge text.
 */
export function plainTextEdit(step: ProseMirrorStep, before: ProseMirrorNode): PlainTextEdit | null {
  const json: unknown = step.toJSON();
  if (typeof json !== 'object' || json === null) return null;
  const { stepType, from, to, slice: sliceJson, structure } = json as Record<string, unknown>;
  if (stepType !== 'replace' || structure === true) return null;
  if (typeof from !== 'number' || typeof to !== 'number') return null;
  try {
    const slice = sliceJson === undefined ? Slice.empty : Slice.fromJSON(before.type.schema, sliceJson);
    if (slice.openStart !== 0 || slice.openEnd !== 0 || slice.content.childCount > 1) return null;
    const inserted = slice.content.firstChild;
    if (inserted && (!inserted.isText || inserted.marks.length > 0)) return null;
    const $from = before.resolve(from);
    const $to = before.resolve(to);
    if (!$from.parent.isTextblock || !$from.sameParent($to)) return null;
    // Automerge widens a mark over text typed at its edge, while the editor has
    // its own idea of the marks the text gets, which the stock writer then
    // reconciles. Inserting between unmarked text needs no reconciling.
    if (inserted && (($from.nodeBefore?.marks.length ?? 0) > 0 || ($to.nodeAfter?.marks.length ?? 0) > 0)) return null;
    return { from, to, text: inserted?.text ?? '' };
  } catch (error) {
    // A step this function cannot read is one the stock writer handles.
    if (error instanceof RangeError) return null;
    throw error;
  }
}

/**
 * Writes one transaction into the Automerge text at `path`. The stock writer
 * reads all spans of the text before the first step and again after every
 * step, and reads the marks at the insertion point, each of which takes time
 * proportional to the text: a keystroke in a text box with a few hundred
 * paragraphs cost tens of milliseconds. Plain text edits are spliced in
 * directly, with their position taken from the editor's own document (which
 * the text mirrors), and every other step goes through the stock writer.
 */
export function writeTransactionToAutomerge<T>(
  adapter: SchemaAdapter,
  document: Automerge.Doc<T>,
  path: readonly Automerge.Prop[],
  transaction: Transaction,
): void {
  const { steps, docs } = transaction;
  const edits = steps.map((step, index) => plainTextEdit(step, docs[index]));
  let index = 0;
  while (index < steps.length) {
    const edit = edits[index];
    if (edit) {
      const range = pmRangeToAmRange(adapter, pmNodeToSpans(adapter, docs[index]), edit);
      if (range) {
        const start = Math.min(range.start, range.end);
        const end = Math.max(range.start, range.end);
        Automerge.splice(document, [...path], start, end - start, edit.text);
        index += 1;
        continue;
      }
    }
    // The stock writer takes the run of steps up to the next plain text edit
    // (it groups mark steps and reads the spans again after each step).
    let end = index + 1;
    while (end < steps.length && !edits[end]) end += 1;
    pmToAutomerge(
      adapter,
      Automerge.spans(document as unknown as Automerge.Doc<unknown>, [...path]),
      steps.slice(index, end),
      document,
      docs[index],
      [...path],
    );
    index = end;
  }
}

/**
 * Compatibility wrapper for @automerge/prosemirror 0.2.0.
 *
 * Its stock patch reconciler tries to `delete` character indexes from cached
 * immutable-string block names when a paragraph becomes a heading. We retain
 * the package's granular PM-step-to-Automerge writer, but reconcile from the
 * canonical spans document so block-type changes and remote patches stay safe.
 */
export function canvinkSyncPlugin<T>({
  adapter,
  handle,
  write,
  path,
  onWriteError,
}: {
  adapter: SchemaAdapter;
  handle: RichTextDocHandle<T>;
  write: RichTextWriter<T>;
  path: readonly Automerge.Prop[];
  onWriteError?: (error: Error) => void;
}): Plugin {
  const stablePath = [...path];
  let writingToAutomerge = false;
  let applyingFromAutomerge = false;
  let observedSynchronousWrite = false;
  const locallyWrittenHeads = new Set<string>();
  const headsKey = (document: Automerge.Doc<T>) =>
    JSON.stringify([...Automerge.getHeads(document)].sort());

  return new Plugin({
    key: canvinkSyncPluginKey,
    view: (view) => {
      const onChange = (payload: { doc: Automerge.Doc<T>; patches: Automerge.Patch[] }) => {
        if (writingToAutomerge) {
          observedSynchronousWrite = true;
          return;
        }
        if (locallyWrittenHeads.delete(headsKey(payload.doc))) return;
        if (!payload.patches.some((patch) => pathsIntersect(patch.path, stablePath))) return;
        if (!pathResolves(payload.doc, stablePath)) return;
        const canonicalDoc = pmDocFromSpans(adapter, Automerge.spans(payload.doc, stablePath));
        const transaction = reconciledTransaction(view.state, canonicalDoc);
        if (!transaction) return;
        applyingFromAutomerge = true;
        try {
          view.dispatch(transaction);
        } finally {
          applyingFromAutomerge = false;
        }
      };
      handle.on('change', onChange);
      return { destroy: () => handle.off('change', onChange) };
    },
    appendTransaction: (transactions) => {
      if (applyingFromAutomerge) return null;
      const changed = transactions.filter(
        (transaction) => transaction.docChanged && transaction.getMeta(RECONCILE_META) !== true,
      );
      if (changed.length === 0) return null;

      writingToAutomerge = true;
      observedSynchronousWrite = false;
      let writeSucceeded = false;
      try {
        const committed = write((document) => {
          for (const transaction of changed) {
            writeTransactionToAutomerge(adapter, document, stablePath, transaction);
          }
        }, { message: RICH_TEXT_EDIT_MESSAGE });
        if (committed === false) throw new Error('Rich-text persistence was rejected.');
        writeSucceeded = true;
      } catch (error) {
        onWriteError?.(error instanceof Error ? error : new Error(String(error)));
      } finally {
        writingToAutomerge = false;
      }
      if (writeSucceeded && !observedSynchronousWrite) locallyWrittenHeads.add(headsKey(handle.doc()));
      return null;
    },
  });
}
