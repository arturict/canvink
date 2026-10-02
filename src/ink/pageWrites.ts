import { expandInk, inkRefKey, inkRefsOf, inkSlotHash, inkSlotId, type ExpandedInk, type InkSegmentRefs } from './projection';
import { peekInkSegment, type ResidentSegment } from './segmentStore';

/** The parts of a page draft that ink writes touch. */
export interface InkDraft {
  elementsById: Record<string, unknown>;
  zOrder: string[];
  /** Also holds one `ink:<hash>` field per segment (see projection.ts). */
  [key: string]: unknown;
}

/** The segment references as plain data: `dead` maps are copied so lookups need no Automerge reads. */
export function plainInkRefs(draft: object): InkSegmentRefs {
  const refs: InkSegmentRefs = {};
  for (const [hash, ref] of Object.entries(inkRefsOf(draft))) {
    refs[hash] = {
      strokes: ref.strokes,
      bytes: ref.bytes,
      ...(ref.dead ? { dead: Object.fromEntries(Object.keys(ref.dead).map((id) => [id, true as const])) } : {}),
    };
  }
  return refs;
}

export function hasInkSegments(draft: object): boolean {
  return Object.keys(draft).some((key) => key.startsWith(inkRefKey('')));
}

/**
 * What a write needs to know about the segments of a draft: which slot shows
 * each visible segment stroke, and which strokes any referenced segment holds.
 */
export class InkWriteContext {
  readonly refs: InkSegmentRefs;
  private readonly segments = new Map<string, ResidentSegment>();
  private expandedInk: ExpandedInk | undefined;

  constructor(private readonly draft: InkDraft) {
    this.refs = plainInkRefs(draft);
    for (const hash of Object.keys(this.refs)) {
      const segment = peekInkSegment(hash);
      if (segment) this.segments.set(hash, segment);
    }
  }

  /**
   * The visible strokes and draw order. Built on first use: it walks every
   * stroke of every segment, which a plain new stroke never needs.
   */
  get expanded(): ExpandedInk {
    this.expandedInk ??= expandInk(
      {
        // Only the keys matter, and reading them once avoids one Automerge read per stroke.
        elementsById: Object.fromEntries(Object.keys(this.draft.elementsById).map((key) => [key, true])),
        zOrder: [...this.draft.zOrder],
      },
      (hash) => this.segments.get(hash),
      this.refs,
    );
    return this.expandedInk;
  }

  /** Whether any referenced segment holds a stroke with this id, visible or not. */
  holds(id: string): boolean {
    for (const segment of this.segments.values()) if (segment.ids.has(id)) return true;
    return false;
  }

  /** The visible segment stroke with this id, if a segment (not an element) is what shows it. */
  visibleStroke(id: string): ResidentSegment['strokes'][number] | undefined {
    return this.expanded.strokes.get(id);
  }

  /** The zOrder slot that stands in for `id`: its segment's slot when a segment shows it. */
  slotFor(id: string): string | undefined {
    return this.expanded.slotOf.get(id);
  }

  /** A slot for a stroke a segment holds even though it is hidden (erased): where an undo puts it back. */
  holdingSlot(id: string): string | undefined {
    const visible = this.slotFor(id);
    if (visible) return visible;
    for (const [hash, segment] of this.segments) if (segment.ids.has(id)) return inkSlotId(hash);
    return undefined;
  }

  /** Whether `id` names a slot of a segment this page references. */
  isReferencedSlot(id: string): boolean {
    const hash = inkSlotHash(id);
    return hash !== undefined && this.refs[hash] !== undefined;
  }

  /**
   * Hides every segment copy of the stroke. Called when a stroke is removed:
   * an override element that is deleted must not let the segment's older copy
   * show through.
   */
  markDead(id: string): boolean {
    let changed = false;
    for (const [hash, segment] of this.segments) {
      if (!segment.ids.has(id) || this.refs[hash]?.dead?.[id]) continue;
      const ref = this.draft[inkRefKey(hash)] as InkSegmentRefs[string] | undefined;
      if (!ref) continue;
      // Segments are created with their `dead` map; only one from an older build lacks it.
      ref.dead ??= {};
      ref.dead[id] = true;
      changed = true;
    }
    return changed;
  }
}
