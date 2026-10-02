import type { LivePageDocV2 } from "../crdt";
import type { Point } from "./operations";

/** Space kept above and left of the content the page scrolls to. */
const CONTENT_MARGIN = 24;

export interface InitialViewport {
  zoom: 1;
  panX: number;
  panY: number;
}

/**
 * Where a free page opens. A page starts at its top-left corner (a fresh
 * page has nothing else), but OneNote pages keep content wherever it was
 * written: 1,300 or 30,000 pixels down, or far to the right of the first
 * screen. Opening such a page at the corner shows bare paper and reads as an
 * empty page, so when none of the content lies in the first screen the page
 * opens scrolled to its topmost content instead.
 *
 * Anything counts as content, a printout too: a page whose first screen shows
 * a printout is not empty, and opening it at the top is how OneNote shows a
 * worksheet with notes further down. A fixed sheet keeps the plain start.
 */
export function initialViewportFor(
  page: Pick<LivePageDocV2, "pageType" | "elementsById">,
  view: { width: number; height: number },
  surfaceOffset: Point,
  margin = CONTENT_MARGIN,
): InitialViewport | null {
  if (page.pageType === "a4") return null;
  const visibleWidth = view.width - surfaceOffset.x;
  const visibleHeight = view.height - surfaceOffset.y;
  if (visibleWidth <= 0 || visibleHeight <= 0) return null;
  let top: { x: number; y: number; width: number } | null = null;
  for (const id in page.elementsById) {
    const element = page.elementsById[id];
    // Erased ink stays in the document as a tombstone but is never drawn.
    if (element.kind === "stroke" && element.tombstonedAt) continue;
    const { x, y, width, height } = element.frame;
    if (![x, y, width, height].every(Number.isFinite)) continue;
    if (x < visibleWidth && y < visibleHeight && x + width > 0 && y + height > 0) return null;
    if (!top || y < top.y || (y === top.y && x < top.x)) top = { x, y, width };
  }
  if (!top) return null;
  return {
    zoom: 1,
    panX: top.x + top.width <= visibleWidth ? 0 : -Math.max(0, top.x - margin),
    panY: -Math.max(0, top.y - margin),
  };
}
