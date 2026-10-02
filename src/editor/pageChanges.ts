import {
  STROKE_WRITE_FORMAT,
  seedPortableRichText,
  storedElement,
  type LivePageDocV2,
  type StrokeStorageFormat,
} from "../crdt";
import type { PageElementV3 as PageElementV2 } from "../domain/v3";
import { hasInkSegments, InkWriteContext, type InkDraft } from "../ink/pageWrites";
import { pendingInk } from "../ink/pendingInk";
import { VIEWER_APP } from "../platform/viewerApp";
import { isDocumentReadOnly } from "../storage/readOnlyDocuments";
import { isSegmentStroke } from "../ink/segmentCodec";

/**
 * What one editor command changes on a page. Callers always know which
 * elements they touch, so a commit never has to diff the whole page: the
 * Automerge change it produces is proportional to the touched elements, not to
 * the page size. That keeps saving a stroke cheap on a page with thousands of
 * strokes.
 */
export interface PageElementChanges {
  /** Created or updated elements in their complete new state. */
  readonly upserts?: readonly PageElementV2[];
  /** Removed element ids. */
  readonly removals?: readonly string[];
  /**
   * Where a created element goes in the z-order: directly above the given
   * element, or on top of the page when the anchor is absent or null.
   */
  readonly anchors?: Readonly<Record<string, string | null>>;
  /**
   * A complete requested order, only for the rare commands that reorder
   * existing elements. It is applied as a minimal list edit, so ids a remote
   * device added meanwhile keep their place.
   */
  readonly zOrder?: readonly string[];
}

export interface ApplyPageChangesOptions {
  /**
   * Hold strokes created by this change outside the document until they are
   * sealed into an ink segment (see src/ink/pendingInk.ts). The editor sets
   * it; without it a created stroke is written into the document at once.
   */
  readonly holdNewInk?: boolean;
  /**
   * Drops every change to ink strokes (create, edit, remove). The phone app
   * views ink and never writes it; this is the last line of defence behind the
   * hidden tools and the ignored pen. Defaults to the build's viewer flag and to pages of a notebook
   * that was shared with the device read-only (`src/storage/readOnlyDocuments.ts`).
   */
  readonly readOnlyInk?: boolean;
}

/**
 * The part of a change set that leaves ink alone. Strokes can sit in an ink
 * segment instead of `elementsById`, so a removal only passes when the element
 * is a plain, non-stroke element of the draft.
 */
export function withoutInkChanges(
  draft: Pick<LivePageDocV2, "elementsById">,
  changes: PageElementChanges,
): PageElementChanges {
  const isStroke = (id: string) => draft.elementsById[id]?.kind === "stroke";
  const upserts = changes.upserts?.filter((element) => element.kind !== "stroke" && !isStroke(element.id));
  const removals = changes.removals?.filter((id) => draft.elementsById[id] !== undefined && !isStroke(id));
  const droppedIds = new Set((changes.upserts ?? []).filter((element) => !upserts?.includes(element)).map((element) => element.id));
  const anchors = changes.anchors
    ? Object.fromEntries(Object.entries(changes.anchors).filter(([id]) => !droppedIds.has(id)))
    : undefined;
  // A complete reorder may name strokes; ink keeps its place, so it is not applied.
  return { upserts, removals, anchors };
}

/**
 * Applies a change set inside an Automerge change callback.
 *
 * `before` is the plain page state the command was computed from. For updated
 * elements only the fields that differ from it are written, so a concurrent
 * remote edit of another field of the same element survives the merge.
 */
export function applyPageElementChanges(
  draft: LivePageDocV2,
  changes: PageElementChanges,
  before: Readonly<Record<string, PageElementV2>>,
  timestamp: string,
  orderHint: readonly string[] = [],
  strokeFormat: StrokeStorageFormat = STROKE_WRITE_FORMAT,
  options: ApplyPageChangesOptions = {},
): void {
  if (options.readOnlyInk ?? (VIEWER_APP || isDocumentReadOnly(draft.documentId))) changes = withoutInkChanges(draft, changes);
  const hintIndex = orderHint.length > 0 ? indexById(orderHint) : undefined;
  // Ink that was sealed into a segment is not an element of the draft. A
  // removal hides its segment copy with a marker, an update of it leaves the
  // segment (below), and z-order commands see the segment's slot. The context
  // is only built when a change reaches such a stroke.
  const inkDraft = draft as unknown as InkDraft;
  const segmented = hasInkSegments(inkDraft);
  let ink: InkWriteContext | undefined;
  const inkContext = (): InkWriteContext => (ink ??= new InkWriteContext(inkDraft));

  // Strokes drawn now are held outside the document until they are sealed
  // into a segment, so a stroke never puts its own operations into the
  // document's history. A change that only touches such strokes leaves the
  // document alone.
  const pending = pendingInk();
  const documentId = draft.documentId;
  let touched = false;

  const removals = [...new Set(changes.removals ?? [])];
  if (removals.length > 0) {
    // Remove from the highest position down so earlier hints stay valid.
    const positioned = removals
      .map((id) => ({ id, hint: hintIndex?.get(id) ?? -1 }))
      .sort((left, right) => right.hint - left.hint);
    for (const { id, hint } of positioned) {
      if (pending.remove(documentId, id) && !draft.elementsById[id]) continue;
      touched = true;
      if (draft.elementsById[id]) {
        delete draft.elementsById[id];
        const index = listIndexOf(draft.zOrder, id, hint);
        if (index >= 0) draft.zOrder.splice(index, 1);
      } else if (!segmented) {
        const index = listIndexOf(draft.zOrder, id, hint);
        if (index >= 0) draft.zOrder.splice(index, 1);
      }
      if (segmented && inkContext().markDead(id)) touched = true;
    }
  }

  const created: string[] = [];
  const anchors: Record<string, string | null> = { ...(changes.anchors ?? {}) };
  for (const next of changes.upserts ?? []) {
    if (next.kind === "stroke" && pending.has(documentId, next.id)) {
      // A z-order command names the stroke's position, which the document
      // carries; otherwise the stroke stays pending with its new state.
      if (!changes.zOrder) {
        pending.upsert(documentId, next);
        continue;
      }
      pending.remove(documentId, next.id);
    }
    const current = draft.elementsById[next.id];
    if (!current) {
      if (options.holdNewInk && next.kind === "stroke" && isSegmentStroke(next) && !changes.zOrder) {
        // A stroke a segment holds (moved, restyled, or brought back by undo)
        // leaves that segment and is drawn again as pending ink, which
        // becomes part of a new segment; the old copy is hidden.
        if (segmented && inkContext().markDead(next.id)) touched = true;
        pending.upsert(documentId, next);
        continue;
      }
      touched = true;
      if (next.kind === "richText") {
        const { content, ...metadata } = automergeValue(next) as typeof next;
        draft.elementsById[next.id] = { ...metadata, text: "" };
        seedPortableRichText(draft, next.id, content);
      } else {
        draft.elementsById[next.id] = automergeValue(storedElement(next, strokeFormat)) as typeof next;
        // Without `holdNewInk` a stroke a segment holds (moved, restyled, or
        // brought back by undo) is written as an element that replaces the
        // segment's copy, drawn at the segment's place unless the command
        // names a spot.
        if (segmented && next.kind === "stroke" && inkContext().holds(next.id) && anchors[next.id] === undefined) {
          anchors[next.id] = inkContext().holdingSlot(next.id) ?? null;
        }
      }
      created.push(next.id);
      continue;
    }
    touched = true;
    updateElementFields(
      current as unknown as Record<string, unknown>,
      next,
      before[next.id],
      strokeFormat,
    );
  }
  if (segmented) {
    // An anchor that is a stroke inside a segment stands for the segment's slot.
    for (const id of Object.keys(anchors)) {
      const anchor = anchors[id];
      if (anchor && !draft.elementsById[anchor] && !inkContext().isReferencedSlot(anchor)) {
        anchors[id] = inkContext().holdingSlot(anchor) ?? null;
      }
    }
  }
  placeCreated(draft.zOrder, created, anchors, hintIndex);

  if (changes.zOrder) {
    touched = true;
    if (segmented) applyZOrderWithInk(draft, changes.zOrder, inkContext(), strokeFormat);
    else syncListOrder(draft.zOrder, changes.zOrder, (id) => Boolean(draft.elementsById[id]));
  }
  if (touched) draft.updatedAt = timestamp;
}

/**
 * A complete requested order on a page with ink segments. Strokes a segment
 * shows are represented by its slot, so reordering the page's other elements
 * keeps ink where it is; a stroke whose own place changed (brought forward,
 * sent back) leaves its segment and becomes an element that carries its
 * position.
 */
function applyZOrderWithInk(
  draft: LivePageDocV2,
  desired: readonly string[],
  ink: InkWriteContext,
  strokeFormat: StrokeStorageFormat,
): void {
  const current = ink.expanded.order;
  const desiredSet = new Set(desired);
  const keep = longestOrderedSubsequence(current.filter((id) => desiredSet.has(id)), desired);
  const raw: string[] = [];
  const slotted = new Set<string>();
  for (const id of desired) {
    if (draft.elementsById[id]) {
      raw.push(id);
      continue;
    }
    const stroke = ink.visibleStroke(id);
    if (!stroke) continue;
    if (!keep.has(id)) {
      draft.elementsById[id] = automergeValue(storedElement(stroke, strokeFormat)) as LivePageDocV2["elementsById"][string];
      raw.push(id);
      continue;
    }
    const slot = ink.slotFor(id);
    if (slot && !slotted.has(slot)) {
      slotted.add(slot);
      raw.push(slot);
    }
  }
  // Slots the request does not mention (its ink is hidden or empty) keep their place.
  syncListOrder(draft.zOrder, raw, (id) => Boolean(draft.elementsById[id]) || ink.isReferencedSlot(id));
}

/**
 * Puts created ids into the z-order: above their anchor when it is still on
 * the page, otherwise above the anchor's own anchor, and on top when no
 * anchor survives. An anchor created in the same change is placed first.
 */
function placeCreated(
  list: string[],
  created: readonly string[],
  anchors: Readonly<Record<string, string | null>>,
  hintIndex: ReadonlyMap<string, number> | undefined,
): void {
  const pending = new Set(created);
  // Reading an Automerge list costs a WebAssembly call per item, so a lookup
  // that misses its hint (every anchor placed in this change does: the hints
  // describe the page before it) would cost a whole scan of the page. The list
  // is copied once, on the first miss, and kept in step with each insertion.
  let mirror: string[] | undefined;
  // Ids restored in their original order anchor on each other; the position of
  // the one placed last is known without a search.
  let last: { id: string; index: number } | undefined;
  const indexOfAnchor = (anchor: string): number => {
    if (last?.id === anchor) return last.index;
    const hint = hintIndex?.get(anchor) ?? -1;
    if (hint >= 0 && hint < list.length && list[hint] === anchor) return hint;
    mirror ??= [...list];
    return mirror.indexOf(anchor);
  };
  const placeOne = (id: string): void => {
    if (listIndexOf(list, id, hintIndex?.get(id) ?? -1, false) >= 0) return;
    let anchor = anchors[id] ?? null;
    let index = -1;
    for (let hops = 0; anchor && hops <= created.length + 1; hops += 1) {
      index = indexOfAnchor(anchor);
      if (index >= 0) break;
      anchor = anchors[anchor] ?? null;
    }
    const at = index >= 0 ? index + 1 : list.length;
    list.splice(at, 0, id);
    mirror?.splice(at, 0, id);
    last = { id, index: at };
  };
  for (const id of created) {
    // An anchor created in the same change goes in first: walk up the chain
    // of pending anchors, then place it from the top down.
    const chain: string[] = [];
    for (let current: string | null = id; current && pending.delete(current);) {
      chain.push(current);
      const anchor: string | null = anchors[current] ?? null;
      current = anchor !== null && pending.has(anchor) ? anchor : null;
    }
    for (let position = chain.length - 1; position >= 0; position -= 1) placeOne(chain[position]);
  }
}

/**
 * Keys that never change in place: identity, and rich text whose live value
 * is the collaborative string written by the text editor itself.
 */
const FIXED_KEYS = new Set(["id", "kind", "content", "text"]);

function updateElementFields(
  current: Record<string, unknown>,
  next: PageElementV2,
  previous: PageElementV2 | undefined,
  strokeFormat: StrokeStorageFormat,
): void {
  // Both sides are compared in stored form, so a stroke is only rewritten
  // when its samples changed, whatever form the document holds them in.
  const nextRecord = storedElement(next, strokeFormat) as unknown as Record<string, unknown>;
  const previousRecord = (previous ? storedElement(previous, strokeFormat) : undefined) as
    | Record<string, unknown>
    | undefined;
  const keys = new Set([...Object.keys(nextRecord), ...Object.keys(previousRecord ?? current)]);
  for (const key of keys) {
    if (FIXED_KEYS.has(key)) continue;
    // Automerge has no `undefined`; a key holding it is an absent key.
    const hasNext = nextRecord[key] !== undefined;
    if (previousRecord) {
      // Three-way: only what this command changed is written.
      const hadPrevious = previousRecord[key] !== undefined;
      if (hasNext && hadPrevious && valuesEqual(previousRecord[key], nextRecord[key])) continue;
      if (!hasNext && !hadPrevious) continue;
    } else if (hasNext && valuesEqual(current[key], nextRecord[key])) {
      continue;
    }
    if (hasNext) current[key] = automergeValue(nextRecord[key]);
    else if (Object.hasOwn(current, key)) delete current[key];
    if (SAMPLE_KEYS.includes(key) && hasNext) {
      // The samples changed form or content: drop the other representation,
      // so a stroke never holds both.
      const other = key === "points" ? "packedPoints" : "points";
      if (Object.hasOwn(current, other)) delete current[other];
    }
  }
}

/** The two stored representations of a stroke's samples. */
const SAMPLE_KEYS: readonly string[] = ["points", "packedPoints"];

/** A deep copy Automerge accepts: object keys holding `undefined` are dropped. */
function automergeValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => (item === undefined ? null : automergeValue(item)));
  if (value instanceof Date || value instanceof Uint8Array) return structuredClone(value);
  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) copy[key] = automergeValue(item);
  }
  return copy;
}

/**
 * Finds an id in an Automerge list. The hint is its position in the plain
 * snapshot the command started from, which is right unless a remote change
 * moved things meanwhile; only then is the list scanned.
 */
function listIndexOf(
  list: string[],
  id: string,
  hint: number,
  scan = true,
): number {
  if (hint >= 0 && hint < list.length && list[hint] === id) return hint;
  if (!scan) return -1;
  return list.indexOf(id);
}

function indexById(order: readonly string[]): Map<string, number> {
  const result = new Map<string, number>();
  order.forEach((id, index) => result.set(id, index));
  return result;
}

/**
 * Edits `list` towards `desired` with removals and insertions only, keeping
 * ids that `desired` does not mention (added remotely) next to their old
 * neighbours. Existing ids whose relative order differs are moved.
 */
export function syncListOrder(
  list: string[],
  desired: readonly string[],
  exists: (id: string) => boolean = () => true,
): void {
  const wantedSet = new Set<string>();
  const wanted: string[] = [];
  for (const id of desired) {
    if (wantedSet.has(id) || !exists(id)) continue;
    wantedSet.add(id);
    wanted.push(id);
  }
  // One read of the Automerge list; every later lookup uses this mirror.
  const mirror = [...list];
  const keep = longestOrderedSubsequence(mirror.filter((id) => wantedSet.has(id)), wanted);
  const firstPosition = new Map<string, number>();
  mirror.forEach((id, index) => {
    if (!firstPosition.has(id)) firstPosition.set(id, index);
  });
  for (let index = mirror.length - 1; index >= 0; index -= 1) {
    const id = mirror[index];
    if (firstPosition.get(id) !== index || !exists(id) || (wantedSet.has(id) && !keep.has(id))) {
      list.splice(index, 1);
      mirror.splice(index, 1);
    }
  }
  let cursor = -1;
  for (const id of wanted) {
    if (keep.has(id)) {
      let position = cursor + 1;
      while (position < mirror.length && mirror[position] !== id) position += 1;
      cursor = position;
      continue;
    }
    list.splice(cursor + 1, 0, id);
    mirror.splice(cursor + 1, 0, id);
    cursor += 1;
  }
}

/** Ids of `sequence` that already appear in `target` order and can stay put. */
function longestOrderedSubsequence(
  sequence: readonly string[],
  target: readonly string[],
): Set<string> {
  const rank = indexById(target);
  const ranks = sequence.map((id) => rank.get(id) ?? -1);
  // Patience sorting for the longest increasing subsequence of ranks.
  const tails: number[] = [];
  const tailIndex: number[] = [];
  const previous: number[] = new Array<number>(ranks.length).fill(-1);
  ranks.forEach((value, index) => {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (tails[middle] < value) low = middle + 1;
      else high = middle;
    }
    tails[low] = value;
    tailIndex[low] = index;
    previous[index] = low > 0 ? tailIndex[low - 1] : -1;
  });
  const result = new Set<string>();
  let index = tailIndex[tails.length - 1] ?? -1;
  while (index >= 0) {
    result.add(sequence[index]);
    index = previous[index];
  }
  return result;
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left instanceof Uint8Array || right instanceof Uint8Array) {
    return left instanceof Uint8Array && right instanceof Uint8Array
      && left.length === right.length
      && left.every((byte, index) => byte === right[index]);
  }
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) {
    return false;
  }
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left)) {
    const rightArray = right as unknown[];
    return left.length === rightArray.length
      && left.every((value, index) => valuesEqual(value, rightArray[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  return leftKeys.length === Object.keys(rightRecord).length
    && leftKeys.every((key) => Object.hasOwn(rightRecord, key) && valuesEqual(leftRecord[key], rightRecord[key]));
}

/**
 * The change set that moves `current` to `next` for the given ids, used by
 * undo and redo, whose history patches name exactly the elements they touch.
 */
export function changesForIds(
  current: Readonly<Record<string, PageElementV2>>,
  next: Readonly<Record<string, PageElementV2>>,
  ids: Iterable<string>,
  anchors?: Readonly<Record<string, string | null>>,
): PageElementChanges {
  const upserts: PageElementV2[] = [];
  const removals: string[] = [];
  for (const id of new Set(ids)) {
    const after = next[id];
    const before = current[id];
    if (!after) {
      if (before) removals.push(id);
    } else if (after !== before) {
      upserts.push(after);
    }
  }
  return { upserts, removals, ...(anchors ? { anchors } : {}) };
}

/**
 * The element directly below each id in `order`, for re-inserting at the same
 * depth. Anchors may themselves be anchored ids; placement follows the chain.
 */
export function zOrderAnchors(
  order: readonly string[],
  ids: Iterable<string>,
): Record<string, string | null> {
  const wanted = new Set(ids);
  const anchors: Record<string, string | null> = {};
  let previous: string | null = null;
  for (const id of order) {
    if (wanted.has(id)) anchors[id] = previous;
    previous = id;
  }
  return anchors;
}
