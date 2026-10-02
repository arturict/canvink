/**
 * OneNote-style page dragging: the vertical position picks the gap between
 * two rows, the horizontal offset from where the drag started picks the
 * subpage level. These pure helpers turn that gesture into a transfer
 * request; `Sidebar` only measures rows.
 */

/** Horizontal pointer travel that changes the subpage level by one. */
export const PAGE_DRAG_INDENT_STEP = 24;

export interface VisiblePageRow {
  id: string;
  depth: number;
}

export interface PageDropTarget {
  /** Gap index: 0 is above the first row, `rows.length` below the last. */
  gap: number;
  depth: number;
  targetPageId?: string;
  placement: 'root' | 'before' | 'inside' | 'after';
}

/** The gap under a pointer, from the vertical midpoints of the rows. */
export function gapFromMidpoints(midpoints: readonly number[], y: number): number {
  const index = midpoints.findIndex((midpoint) => y < midpoint);
  return index === -1 ? midpoints.length : index;
}

/** The levels a page may take in a gap without reparenting its neighbours. */
export function depthRange(rows: readonly VisiblePageRow[], gap: number): { min: number; max: number } {
  const previous = rows[gap - 1];
  const next = rows[gap];
  const max = previous ? previous.depth + 1 : 0;
  const min = next ? Math.min(next.depth, max) : 0;
  return { min, max };
}

export function desiredDepth(startDepth: number, deltaX: number): number {
  return Math.max(0, startDepth + Math.round(deltaX / PAGE_DRAG_INDENT_STEP));
}

/**
 * Resolves a gap and a wanted level into a drop target. `rows` must be the
 * visible rows in display order without the dragged page and its subpages.
 */
export function resolvePageDrop(
  rows: readonly VisiblePageRow[],
  gap: number,
  wantedDepth: number,
): PageDropTarget {
  const clampedGap = Math.min(Math.max(0, gap), rows.length);
  const { min, max } = depthRange(rows, clampedGap);
  const depth = Math.min(Math.max(wantedDepth, min), max);
  const previous = rows[clampedGap - 1];
  if (!previous) {
    const next = rows[clampedGap];
    return next
      ? { gap: clampedGap, depth, targetPageId: next.id, placement: 'before' }
      : { gap: clampedGap, depth, placement: 'root' };
  }
  if (depth === previous.depth + 1) {
    return { gap: clampedGap, depth, targetPageId: previous.id, placement: 'inside' };
  }
  // The page becomes the next sibling of the nearest row above at its level;
  // that row's own subpages stay under it.
  for (let index = clampedGap - 1; index >= 0; index -= 1) {
    if (rows[index].depth === depth) {
      return { gap: clampedGap, depth, targetPageId: rows[index].id, placement: 'after' };
    }
  }
  return { gap: clampedGap, depth, targetPageId: previous.id, placement: 'after' };
}

/** Whether a drop would leave the page exactly where it already is. */
export function isNoopDrop(
  target: Pick<PageDropTarget, 'gap' | 'depth'>,
  origin: { gap: number; depth: number },
): boolean {
  return target.gap === origin.gap && target.depth === origin.depth;
}

export interface TreePage {
  id: string;
  parentPageId?: string;
}

/**
 * The rows a page list shows, depth-first in section order, skipping the
 * subpages of collapsed pages. Pages whose parent is missing count as roots.
 */
export function visiblePageRows(
  pages: readonly TreePage[],
  collapsed: ReadonlySet<string> = new Set(),
): VisiblePageRow[] {
  const ids = new Set(pages.map((page) => page.id));
  const childrenOf = new Map<string | undefined, TreePage[]>();
  for (const page of pages) {
    const parent = page.parentPageId && ids.has(page.parentPageId) && page.parentPageId !== page.id
      ? page.parentPageId
      : undefined;
    const list = childrenOf.get(parent) ?? [];
    list.push(page);
    childrenOf.set(parent, list);
  }
  const rows: VisiblePageRow[] = [];
  const seen = new Set<string>();
  const visit = (parent: string | undefined, depth: number) => {
    for (const page of childrenOf.get(parent) ?? []) {
      if (seen.has(page.id)) continue;
      seen.add(page.id);
      rows.push({ id: page.id, depth });
      if (!collapsed.has(page.id)) visit(page.id, depth + 1);
    }
  };
  visit(undefined, 0);
  return rows;
}

/**
 * Where "Unterseite erstellen" (indent) puts a page: under the sibling above
 * it, as that sibling's last subpage. Returns undefined when there is no
 * sibling above.
 */
export function indentTarget(
  pages: readonly TreePage[],
  pageId: string,
): { targetPageId: string; placement: 'inside' | 'after' } | undefined {
  const page = pages.find((candidate) => candidate.id === pageId);
  if (!page) return undefined;
  const siblings = pages.filter((candidate) => (candidate.parentPageId ?? undefined) === (page.parentPageId ?? undefined));
  const index = siblings.findIndex((candidate) => candidate.id === pageId);
  const above = siblings[index - 1];
  if (!above) return undefined;
  const children = pages.filter((candidate) => candidate.parentPageId === above.id);
  const last = children.at(-1);
  return last ? { targetPageId: last.id, placement: 'after' } : { targetPageId: above.id, placement: 'inside' };
}

/** Where "Unterseite heraufstufen" (outdent) puts a page: right after its parent. */
export function outdentTarget(
  pages: readonly TreePage[],
  pageId: string,
): { targetPageId: string; placement: 'after' } | undefined {
  const page = pages.find((candidate) => candidate.id === pageId);
  if (!page?.parentPageId || !pages.some((candidate) => candidate.id === page.parentPageId)) return undefined;
  return { targetPageId: page.parentPageId, placement: 'after' };
}
