import type { ResidentSegment } from './segmentStore';

/**
 * How ink segments appear inside a page document, and how a snapshot turns
 * them back into ordinary strokes.
 *
 * A page document holds, next to `elementsById` and `zOrder`:
 *
 * - one root field `ink:<hash>` per segment, `{ strokes, bytes, dead }`. Every
 *   segment is a field of its own, not an entry of a shared map, because two
 *   devices that add their first segment at the same time would otherwise
 *   create two competing maps and one of them would win. The key makes adding
 *   a segment idempotent under merge: two devices that seal the same strokes
 *   produce the same bytes and so the same key. `dead` lists ids of strokes of
 *   that segment that were erased or replaced; it is created together with
 *   the segment, so devices that hide strokes concurrently both keep theirs.
 * - `zOrder` entries `ink:<hash>` (a slot): the segment's strokes are drawn
 *   at that place, in the segment's own order.
 * - ordinary stroke elements in `elementsById` (an override): a stroke that
 *   was moved or restyled after it was sealed, or that was drawn since. An
 *   element with the id of a segment stroke replaces that stroke.
 *
 * Readers never see any of this: `projectPageInk` returns the page as it was
 * before ink was sealed, with every stroke an element of `elementsById` and
 * listed in `zOrder`.
 */
export const INK_SLOT_PREFIX = 'ink:';

export interface InkSegmentRef {
  strokes: number;
  bytes: number;
  dead?: Record<string, true>;
}

export type InkSegmentRefs = Record<string, InkSegmentRef>;

/** The page fields that reference segments, as a type for the stored document. */
export type InkRefFields = { [key in `ink:${string}`]?: InkSegmentRef };

export function inkRefKey(hash: string): string {
  return `${INK_SLOT_PREFIX}${hash}`;
}

/** The segment references of a page document (or draft) as plain data: hash to reference. */
export function inkRefsOf(page: object): InkSegmentRefs {
  const refs: InkSegmentRefs = {};
  const record = page as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!key.startsWith(INK_SLOT_PREFIX)) continue;
    const ref = record[key] as InkSegmentRef | undefined;
    if (typeof ref !== 'object' || ref === null) continue;
    refs[key.slice(INK_SLOT_PREFIX.length)] = ref;
  }
  return refs;
}

export function inkSlotId(hash: string): string {
  return `${INK_SLOT_PREFIX}${hash}`;
}

/** The segment hash of a zOrder slot id, or undefined for any other id. */
export function inkSlotHash(id: string): string | undefined {
  return id.startsWith(INK_SLOT_PREFIX) ? id.slice(INK_SLOT_PREFIX.length) : undefined;
}

export interface PlainInkPage {
  kind?: string;
  elementsById: Record<string, unknown>;
  zOrder: readonly string[];
}

export type SegmentLookup = (hash: string) => ResidentSegment | undefined;

/** Hashes of the segments a page document references, in hash order. */
export function referencedInkSegments(page: object): string[] {
  return Object.keys(inkRefsOf(page)).sort();
}

export interface ExpandedInk {
  /** The strokes of resident segments, by id, that are visible. */
  strokes: Map<string, ResidentSegment['strokes'][number]>;
  /** Draw order with every slot replaced by its visible strokes. */
  order: string[];
  /** For each visible segment stroke, the slot that shows it. */
  slotOf: Map<string, string>;
  /** Referenced segments that are not resident, so their ink is not shown yet. */
  missing: string[];
}

/**
 * The visible strokes of a page's segments and the draw order with slots
 * expanded. A stroke is visible when its segment is resident and does not list
 * it as dead, no element overrides it, and no earlier slot already shows it.
 * Referenced segments without a slot in `zOrder` come after the listed
 * entries in hash order, so a list merge can never hide sealed ink.
 */
export function expandInk(
  page: PlainInkPage,
  lookup: SegmentLookup,
  refs: InkSegmentRefs = inkRefsOf(page),
): ExpandedInk {
  const strokes = new Map<string, ResidentSegment['strokes'][number]>();
  const order: string[] = [];
  const slotOf = new Map<string, string>();
  const missing: string[] = [];
  const slotted = new Set<string>();
  const shown = new Set<string>();

  const expandSegment = (hash: string): void => {
    const ref = refs[hash];
    if (!ref || slotted.has(hash)) return;
    slotted.add(hash);
    const segment = lookup(hash);
    if (!segment) {
      missing.push(hash);
      return;
    }
    const dead = ref.dead;
    const slot = inkSlotId(hash);
    for (const stroke of segment.strokes) {
      const id = stroke.id;
      if (dead && Object.hasOwn(dead, id)) continue;
      if (Object.hasOwn(page.elementsById, id) || shown.has(id)) continue;
      shown.add(id);
      strokes.set(id, stroke);
      slotOf.set(id, slot);
      order.push(id);
    }
  };

  for (const id of page.zOrder) {
    const hash = inkSlotHash(id);
    if (hash === undefined) order.push(id);
    else expandSegment(hash);
  }
  for (const hash of Object.keys(refs).sort()) expandSegment(hash);
  return { strokes, order, slotOf, missing };
}

interface Memo {
  elements: object;
  refs: Readonly<Record<string, object>>;
  version: string;
  page: object;
  missing: readonly string[];
}

/** The reference objects by hash; frozen shared snapshots keep the same objects while a segment is unchanged. */
function refsSnapshot(refs: InkSegmentRefs): Readonly<Record<string, object>> {
  return { ...refs };
}

function sameRefs(left: Readonly<Record<string, object>>, right: InkSegmentRefs): boolean {
  const keys = Object.keys(right);
  return keys.length === Object.keys(left).length && keys.every((key) => left[key] === right[key]);
}

/** Keyed by the raw zOrder list, which a frozen shared snapshot keeps for as long as the order is unchanged. */
const memo = new WeakMap<object, Memo>();

/**
 * The page with its ink segments expanded into ordinary strokes. Pages
 * without segments come back as they are (the same object). The result shares
 * the frozen stroke objects of the resident segments and is frozen when the
 * input is. `missing` receives the hashes of referenced segments that are not
 * resident.
 */
export function projectPageInk<T extends PlainInkPage>(
  page: T,
  lookup: SegmentLookup,
  missing?: string[],
): T {
  const refs = inkRefsOf(page);
  if (Object.keys(refs).length === 0) return page;
  // The stored reference fields are not part of the page readers see.
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(page)) if (!key.startsWith(INK_SLOT_PREFIX)) rest[key] = value;

  const frozen = Object.isFrozen(page);
  // The same raw page and the same resident segments always give the same projection.
  const version = Object.keys(refs).sort().map((hash) => (lookup(hash) ? hash : `~${hash}`)).join(',');
  const cached = frozen ? memo.get(page.zOrder) : undefined;
  if (cached && cached.version === version && cached.elements === page.elementsById && sameRefs(cached.refs, refs)) {
    if (missing) missing.push(...cached.missing);
    const shared = cached.page as T;
    return Object.freeze({ ...rest, elementsById: shared.elementsById, zOrder: shared.zOrder }) as unknown as T;
  }

  const expanded = expandInk(page, lookup, refs);
  if (missing) missing.push(...expanded.missing);
  const elementsById: Record<string, unknown> = { ...page.elementsById };
  for (const [id, stroke] of expanded.strokes) elementsById[id] = stroke;
  const projected = {
    ...rest,
    elementsById: frozen ? Object.freeze(elementsById) : elementsById,
    zOrder: frozen ? Object.freeze(expanded.order) : expanded.order,
  } as unknown as T;
  const result = frozen ? Object.freeze(projected) : projected;
  if (frozen) {
    memo.set(page.zOrder, { elements: page.elementsById, refs: refsSnapshot(refs), version, page: result, missing: expanded.missing });
  }
  return result;
}

const pendingMemo = new WeakMap<object, { pending: readonly unknown[]; elements: object; page: object }>();

/**
 * The page with strokes that are drawn but not yet sealed (see pendingInk.ts)
 * added on top of everything, in drawing order. A pending stroke whose id the
 * page already shows (a journal recovered after its segment was written) is
 * left out.
 */
export function withPendingStrokes<T extends PlainInkPage>(
  page: T,
  pending: readonly { id: string }[],
): T {
  if (pending.length === 0) return page;
  const frozen = Object.isFrozen(page);
  const cached = frozen ? pendingMemo.get(page.zOrder) : undefined;
  if (cached && cached.pending === pending && cached.elements === page.elementsById) {
    const shared = cached.page as T;
    return Object.freeze({ ...page, elementsById: shared.elementsById, zOrder: shared.zOrder });
  }
  const elementsById: Record<string, unknown> = { ...page.elementsById };
  const zOrder = [...page.zOrder];
  for (const stroke of pending) {
    if (Object.hasOwn(elementsById, stroke.id)) continue;
    elementsById[stroke.id] = stroke;
    zOrder.push(stroke.id);
  }
  const merged = {
    ...page,
    elementsById: frozen ? Object.freeze(elementsById) : elementsById,
    zOrder: frozen ? Object.freeze(zOrder) : zOrder,
  } as T;
  const result = frozen ? Object.freeze(merged) : merged;
  if (frozen) pendingMemo.set(page.zOrder, { pending, elements: page.elementsById, page: result });
  return result;
}
