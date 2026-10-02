import type { PageElementV3 as PageElementV2 } from '../domain/v3';
import { framesOverlap, selectByLasso, strokeBounds } from './inkGeometry';
import type { Point, Rect } from './operations';

/** Below this many page pixels on a side a dragged rectangle is a tap, not a region. */
const MIN_REGION_SIDE = 4;

/** The rectangle between the two corners of a drag, whichever way it was dragged. */
export function rectBetween(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  };
}

export function isUsableRegion(rect: Rect): boolean {
  return rect.width >= MIN_REGION_SIDE && rect.height >= MIN_REGION_SIDE;
}

/**
 * Rectangle selection takes what a lasso around the same rectangle would:
 * ink that lies mostly inside, boxes whose centre is inside, and placed
 * images and documents only when fully enclosed.
 */
export function selectByRect(
  elements: Readonly<Record<string, PageElementV2>>,
  rect: Rect,
): string[] {
  if (!isUsableRegion(rect)) return [];
  return selectByLasso(elements, [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x + rect.width, y: rect.y + rect.height },
    { x: rect.x, y: rect.y + rect.height },
  ]);
}

/**
 * What a rectangle screenshot shows: every live element that touches the
 * region, in page order (so ink keeps lying over the PDF it was written on).
 * Locked elements such as printouts are included, unlike in a selection,
 * because the picture shows what is on the page.
 */
export function elementIdsInRegion(
  elements: Readonly<Record<string, PageElementV2>>,
  zOrder: readonly string[],
  region: Rect,
): string[] {
  return zOrder.filter((id) => {
    const element = elements[id];
    if (!element) return false;
    if (element.kind === 'stroke') {
      return !element.tombstonedAt && framesOverlap(strokeBounds(element), region, element.size / 2);
    }
    return framesOverlap(element.frame, region);
  });
}
