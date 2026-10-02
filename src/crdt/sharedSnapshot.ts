import { assertCanvinkAutomergeDocument, withInkSegments, withPageDrawOrder } from './document';
import { pendingInkVersion } from '../ink/pendingInk';
import { referencedInkSegments } from '../ink/projection';
import { peekInkSegment } from '../ink/segmentStore';
import { hasPackedPoints, revealedPoints } from './strokeStorage';
import type { CanvinkAutomergeDoc, LiveCanvinkDocumentV2 } from './types';

/**
 * Plain, frozen snapshots of Automerge documents that share unchanged parts.
 *
 * Automerge materialises a document as copy-on-write JS objects: a change,
 * merge or sync replaces only the objects on the path to what changed, and
 * every untouched subtree keeps its identity in the next document version.
 * `Automerge.toJS` ignores that and rebuilds the whole tree from wasm, which
 * takes seconds for a page with thousands of ink strokes.
 *
 * This projection remembers the plain copy of every materialised object it
 * has converted, so the snapshot after a one-stroke change costs one shallow
 * pass over the element map plus a copy of the new stroke. Strokes whose
 * samples are stored packed come out with their `points` list, so consumers
 * never see the storage form. Because copies are
 * shared between snapshots and consumers, they are frozen; a consumer that
 * needs to mutate one clones it first.
 */
const plainCopies = new WeakMap<object, unknown>();
const decodedPoints = new WeakMap<Uint8Array, readonly unknown[]>();

function sharedPoints(bytes: Uint8Array, strokeId: unknown): readonly unknown[] {
  let points = decodedPoints.get(bytes);
  if (!points) {
    points = revealedPoints(bytes, strokeId, true);
    decodedPoints.set(bytes, points);
  }
  return points;
}

export function sharedPlainSnapshot<T>(value: T): T {
  return plainCopy(value) as T;
}

function plainCopy(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  const cached = plainCopies.get(value);
  if (cached !== undefined) return cached;
  let copy: unknown;
  if (Array.isArray(value)) {
    const items = new Array<unknown>(value.length);
    for (let index = 0; index < value.length; index += 1) items[index] = plainCopy(value[index]);
    copy = Object.freeze(items);
  } else if (value instanceof Date) {
    copy = new Date(value.getTime());
  } else if (value instanceof Uint8Array) {
    // Typed arrays cannot be frozen; a fresh copy per version keeps them private.
    return value.slice();
  } else {
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) return value;
    const source = value as Record<string, unknown>;
    const record: Record<string, unknown> = {};
    const packed = hasPackedPoints(source);
    for (const key of Object.keys(source)) {
      if (packed && key === 'packedPoints') continue;
      record[key] = plainCopy(source[key]);
    }
    // A stroke with packed samples is revealed as its `points` list, decoded
    // once per stored byte string: a stroke that only changed colour or
    // position keeps sharing its list with the earlier snapshot.
    if (packed) record.points = sharedPoints(source.packedPoints, source.id);
    copy = Object.freeze(record);
  }
  plainCopies.set(value, copy);
  return copy;
}

const validatedSnapshots = new WeakMap<object, { snapshot: LiveCanvinkDocumentV2; pending: number }>();

/**
 * The validated, shared snapshot of one document version. Repeated calls for
 * the same version are free; a new version pays only for what changed plus
 * the shallow integrity check of its root.
 */
export function getSharedAutomergeSnapshot<T extends LiveCanvinkDocumentV2>(
  document: CanvinkAutomergeDoc<T>,
): T {
  const cached = validatedSnapshots.get(document);
  // Strokes drawn since the last seal are not part of the document; the
  // snapshot is only reused while they are the same.
  if (cached && cached.pending === pendingInkVersion(document.documentId)) return cached.snapshot as T;
  const plain = sharedPlainSnapshot(document as T);
  assertCanvinkAutomergeDocument(plain);
  const snapshot = withPageDrawOrder(withInkSegments(plain));
  // A snapshot that lacks segments not yet resident is not remembered: the
  // next call, after they arrived, must show their ink.
  if (referencedInkSegments(plain).every((hash) => peekInkSegment(hash))) {
    validatedSnapshots.set(document, { snapshot, pending: pendingInkVersion(document.documentId) });
  }
  return snapshot;
}
