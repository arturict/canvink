import type { StrokeElementV2 } from '../domain/v2';
import { InkWriteContext, type InkDraft } from './pageWrites';
import { inkRefKey, inkRefsOf, inkSlotHash, inkSlotId, type InkSegmentRefs, type PlainInkPage } from './projection';
import type { PendingInk } from './pendingInk';
import { encodeInkSegment, isSegmentStroke } from './segmentCodec';
import { peekInkSegment, type InkSegmentStore } from './segmentStore';

/**
 * Sealing turns the strokes a page holds as ordinary CRDT elements into
 * immutable segments, and compaction rewrites segments that lost most of their
 * strokes. Both are idle-time jobs of the page's owner; neither changes what a
 * snapshot shows.
 */
export interface SealOptions {
  /** Runs shorter than this stay elements (a few strokes are cheaper as elements than as a blob). */
  minRun: number;
  /** The most strokes in one segment. */
  maxStrokes: number;
}

export const DEFAULT_SEAL_OPTIONS: SealOptions = { minRun: 24, maxStrokes: 1000 };

export interface SealRun {
  /** Position of the first id in the raw zOrder the plan was made from. */
  start: number;
  ids: string[];
  strokes: StrokeElementV2[];
}

function sealable(element: unknown): element is StrokeElementV2 {
  return typeof element === 'object' && element !== null
    && (element as { kind?: unknown }).kind === 'stroke'
    && (element as { tombstonedAt?: unknown }).tombstonedAt === undefined
    && Array.isArray((element as { points?: unknown }).points)
    && isSegmentStroke(element as StrokeElementV2);
}

/**
 * The runs of consecutive strokes in a page's raw draw order that should be
 * sealed. `page` is the plain document (segments not expanded), so strokes
 * that already live in a segment are not in it. Runs longer than
 * `maxStrokes` are cut into pieces; a piece below `minRun` stays as elements
 * unless it is the only one of its run.
 */
export function planSeal(page: PlainInkPage, options: SealOptions = DEFAULT_SEAL_OPTIONS): SealRun[] {
  const runs: SealRun[] = [];
  let ids: string[] = [];
  let strokes: StrokeElementV2[] = [];
  let start = 0;
  const flush = (): void => {
    if (ids.length === 0) return;
    for (let offset = 0; offset < ids.length; offset += options.maxStrokes) {
      const piece = ids.slice(offset, offset + options.maxStrokes);
      if (piece.length < options.minRun) continue;
      runs.push({ start: start + offset, ids: piece, strokes: strokes.slice(offset, offset + options.maxStrokes) });
    }
    ids = [];
    strokes = [];
  };
  page.zOrder.forEach((id, index) => {
    const element = page.elementsById[id];
    if (sealable(element) && element.id === id) {
      if (ids.length === 0) start = index;
      ids.push(id);
      strokes.push(element);
    } else flush();
  });
  flush();
  return runs;
}

export interface CompactionOptions {
  /** A segment is rewritten when at least this share of its strokes is hidden. */
  deadShare: number;
  /** ... and at least this many strokes are hidden. */
  minDead: number;
  /** Adjacent segments each below this many live strokes are merged when together they stay below `maxStrokes`. */
  smallSegment: number;
  maxStrokes: number;
}

export const DEFAULT_COMPACTION_OPTIONS: CompactionOptions = {
  deadShare: 0.3,
  minDead: 8,
  smallSegment: 128,
  maxStrokes: 1000,
};

export interface CompactionGroup {
  /** Hashes of the adjacent segments to rewrite as one, in draw order. */
  hashes: string[];
  /** The strokes that stay visible, in draw order. */
  strokes: StrokeElementV2[];
}

/**
 * Groups of adjacent segment slots to rewrite: segments that lost a large
 * share of their strokes, and runs of small segments that fit into one.
 */
export function planCompaction(
  page: PlainInkPage,
  refs: InkSegmentRefs,
  options: CompactionOptions = DEFAULT_COMPACTION_OPTIONS,
): CompactionGroup[] {
  const groups: CompactionGroup[] = [];
  let current: { hashes: string[]; strokes: StrokeElementV2[]; wasteful: boolean; total: number } | undefined;
  const emit = (): void => {
    if (!current) return;
    const worthIt = current.wasteful || current.hashes.length >= 2;
    if (worthIt) groups.push({ hashes: current.hashes, strokes: current.strokes });
    current = undefined;
  };
  const seen = new Set<string>();
  for (const id of page.zOrder) {
    const hash = inkSlotHash(id);
    const ref = hash === undefined ? undefined : refs[hash];
    if (hash === undefined || !ref || seen.has(hash)) {
      emit();
      continue;
    }
    seen.add(hash);
    const segment = peekInkSegment(hash);
    if (!segment) {
      emit();
      continue;
    }
    const dead = ref.dead ?? {};
    const live = segment.strokes.filter((stroke) => !Object.hasOwn(dead, stroke.id)
      && !Object.hasOwn(page.elementsById, stroke.id));
    const hidden = segment.strokes.length - live.length;
    const wasteful = hidden >= options.minDead && hidden / segment.strokes.length >= options.deadShare;
    const small = live.length < options.smallSegment;
    if (!wasteful && !small) {
      emit();
      continue;
    }
    if (current && current.total + live.length > options.maxStrokes) emit();
    current ??= { hashes: [], strokes: [], wasteful: false, total: 0 };
    current.hashes.push(hash);
    current.strokes.push(...live);
    current.total += live.length;
    current.wasteful ||= wasteful;
  }
  emit();
  return groups;
}

/** The page document a sealing or compaction pass works on. */
export interface InkPageTarget {
  /** The raw (segments not expanded) plain document and an opaque token that changes when the document does. */
  read(): { page: PlainInkPage; version: string };
  /** Runs `change` as one document change and returns whether it was written. */
  change(message: string, change: (draft: InkDraft) => void): boolean;
}

export interface InkJobResult {
  sealed: number;
  segments: number;
  rewritten: number;
}

const MAX_ATTEMPTS = 3;

/**
 * Seals the page's loose strokes. Segment bytes are durable before the
 * document references them; if the document changed meanwhile the plan is
 * made again, so the change never removes a stroke it did not seal.
 */
export async function sealPageInk(
  target: InkPageTarget,
  store: InkSegmentStore,
  options: SealOptions = DEFAULT_SEAL_OPTIONS,
): Promise<InkJobResult> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const { page, version } = target.read();
    const runs = planSeal(page, options);
    if (runs.length === 0) return { sealed: 0, segments: 0, rewritten: 0 };
    const built: Array<{ run: SealRun; hash: string; bytes: number }> = [];
    for (const run of runs) {
      const bytes = encodeInkSegment(run.strokes);
      built.push({ run, hash: await store.put(bytes), bytes: bytes.byteLength });
    }
    if (target.read().version !== version) continue;
    const written = target.change('Seal ink into segments', (draft) => {
      const context = new InkWriteContext(draft);
      // Highest position first, so the positions of the plan stay valid.
      for (const { run, hash, bytes } of [...built].sort((left, right) => right.run.start - left.run.start)) {
        const { start, ids } = run;
        if (draft.zOrder[start] !== ids[0] || draft.zOrder[start + ids.length - 1] !== ids[ids.length - 1]) {
          throw new Error('The page changed while its ink was being sealed.');
        }
        // A stroke that overrode an older segment copy takes over: hide the copy.
        for (const id of ids) {
          if (context.holds(id)) context.markDead(id);
          delete draft.elementsById[id];
        }
        draft.zOrder.splice(start, ids.length, inkSlotId(hash));
        draft[inkRefKey(hash)] = { strokes: ids.length, bytes, dead: {} };
      }
    });
    if (written) {
      return {
        sealed: built.reduce((total, { run }) => total + run.ids.length, 0),
        segments: built.length,
        rewritten: 0,
      };
    }
  }
  return { sealed: 0, segments: 0, rewritten: 0 };
}

/**
 * Rewrites segments that lost most of their strokes and merges small
 * neighbours. A rewrite replaces the old slot by the new one in one change;
 * the old segment's bytes stay in the store, so history and older snapshots
 * of the page still resolve.
 */
export async function compactPageInk(
  target: InkPageTarget,
  store: InkSegmentStore,
  options: CompactionOptions = DEFAULT_COMPACTION_OPTIONS,
): Promise<InkJobResult> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const { page, version } = target.read();
    const refs = inkRefsOf(page);
    const groups = planCompaction(page, refs, options);
    if (groups.length === 0) return { sealed: 0, segments: 0, rewritten: 0 };
    const built: Array<{ group: CompactionGroup; hash?: string; bytes: number }> = [];
    for (const group of groups) {
      if (group.strokes.length === 0) {
        built.push({ group, bytes: 0 });
        continue;
      }
      const bytes = encodeInkSegment(group.strokes);
      built.push({ group, hash: await store.put(bytes), bytes: bytes.byteLength });
    }
    if (target.read().version !== version) continue;
    const written = target.change('Compact ink segments', (draft) => {
      for (const { group, hash, bytes } of built) {
        const first = draft.zOrder.indexOf(inkSlotId(group.hashes[0]));
        if (first < 0) throw new Error('The page changed while its ink was being compacted.');
        for (const old of group.hashes) {
          const at = draft.zOrder.indexOf(inkSlotId(old));
          if (at >= 0) {
            draft.zOrder.splice(at, 1);
          }
          delete draft[inkRefKey(old)];
        }
        if (hash) {
          draft.zOrder.splice(Math.min(first, draft.zOrder.length), 0, inkSlotId(hash));
          draft[inkRefKey(hash)] = { strokes: group.strokes.length, bytes, dead: {} };
        }
      }
    });
    if (written) {
      return { sealed: 0, segments: built.length, rewritten: groups.reduce((total, group) => total + group.hashes.length, 0) };
    }
  }
  return { sealed: 0, segments: 0, rewritten: 0 };
}

/**
 * A portable page (imports, copies, new documents) with its loose strokes
 * moved into segments, ready for `createAutomergeDocument`. The segments are
 * durable in `store` when this resolves. A page without enough ink comes back
 * unchanged. Encoding is deterministic, so building the same page twice gives
 * the same segments and the same document.
 */
export async function sealProjection<T extends PlainInkPage>(
  projection: T,
  store: InkSegmentStore,
  options: SealOptions = DEFAULT_SEAL_OPTIONS,
): Promise<T> {
  if (projection.kind !== 'page') return projection;
  const runs = planSeal(projection, options);
  if (runs.length === 0) return projection;
  const elementsById = { ...projection.elementsById };
  const zOrder = [...projection.zOrder];
  const refFields: Record<string, unknown> = {};
  for (const { start, ids, strokes } of [...runs].sort((left, right) => right.start - left.start)) {
    const bytes = encodeInkSegment(strokes);
    const hash = await store.put(bytes);
    for (const id of ids) delete elementsById[id];
    zOrder.splice(start, ids.length, inkSlotId(hash));
    refFields[inkRefKey(hash)] = { strokes: ids.length, bytes: bytes.byteLength, dead: {} };
  }
  return { ...projection, ...refFields, elementsById, zOrder };
}

/**
 * Moves a page's pending strokes (drawn, not yet part of the document) into
 * segments on top of the page, in drawing order. The bytes are durable before
 * the document references them, and the pending strokes are only dropped once
 * the reference is written; if strokes were drawn or erased meanwhile the plan
 * is made again. Returns how many strokes were sealed.
 */
export async function sealPendingInk(
  target: Pick<InkPageTarget, 'change'>,
  documentId: string,
  store: InkSegmentStore,
  pending: PendingInk,
  options: { maxStrokes: number; now?: () => string } = { maxStrokes: DEFAULT_SEAL_OPTIONS.maxStrokes },
): Promise<number> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const strokes = pending.strokes(documentId);
    if (strokes.length === 0) return 0;
    const version = pending.version(documentId);
    const built: Array<{ ids: string[]; hash: string; bytes: number }> = [];
    for (let offset = 0; offset < strokes.length; offset += options.maxStrokes) {
      const chunk = strokes.slice(offset, offset + options.maxStrokes);
      const bytes = encodeInkSegment(chunk);
      built.push({ ids: chunk.map((stroke) => stroke.id), hash: await store.put(bytes), bytes: bytes.byteLength });
    }
    if (pending.version(documentId) !== version) continue;
    const timestamp = (options.now ?? (() => new Date().toISOString()))();
    const written = target.change('Seal ink into segments', (draft) => {
      for (const { ids, hash, bytes } of built) {
        const existing = draft[inkRefKey(hash)] as InkSegmentRefs[string] | undefined;
        if (existing) {
          // The same strokes, byte for byte, are already a segment of this page (an undone move or
          // erase restores them exactly): bring them back by lifting their hidden markers.
          for (const id of ids) if (existing.dead && Object.hasOwn(existing.dead, id)) delete existing.dead[id];
          const slot = inkSlotId(hash);
          if (!draft.zOrder.includes(slot)) draft.zOrder.push(slot);
          continue;
        }
        draft[inkRefKey(hash)] = { strokes: ids.length, bytes, dead: {} };
        draft.zOrder.push(inkSlotId(hash));
      }
      (draft as unknown as { updatedAt: string }).updatedAt = timestamp;
    });
    if (written) {
      pending.clear(documentId, built.flatMap(({ ids }) => ids));
      return built.reduce((total, { ids }) => total + ids.length, 0);
    }
  }
  return 0;
}
