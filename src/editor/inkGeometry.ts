import type { StrokeElementV2 } from "../domain/v2";
import type { PageElementV3 as PageElementV2 } from "../domain/v3";
import type { Point, Rect } from "./operations";

/**
 * Geometry for ink that is painted on canvas layers instead of one DOM node
 * per stroke: selection, erasing and the lasso ask "which ink is here?" with
 * distances to the stroke's centre line, not with DOM hit targets.
 *
 * A stroke's points are its truth. Its `frame` can lag behind after a
 * rotation, so bounds are derived from the points and cached per stroke
 * version (snapshots are immutable and shared between renders).
 */
const boundsCache = new WeakMap<object, Rect>();

export function strokeBounds(stroke: Pick<StrokeElementV2, "points">): Rect {
  const cached = boundsCache.get(stroke);
  if (cached) return cached;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const point of stroke.points) {
    if (point.x < minX) minX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.x > maxX) maxX = point.x;
    if (point.y > maxY) maxY = point.y;
  }
  const bounds = stroke.points.length === 0
    ? { x: 0, y: 0, width: 0, height: 0 }
    : { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  boundsCache.set(stroke, bounds);
  return bounds;
}

export function pathBounds(path: readonly Point[], padding = 0): Rect {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const point of path) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  if (path.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  return {
    x: minX - padding,
    y: minY - padding,
    width: maxX - minX + padding * 2,
    height: maxY - minY + padding * 2,
  };
}

export function framesOverlap(
  left: Rect,
  right: Rect,
  padding = 0,
): boolean {
  return left.x - padding <= right.x + right.width
    && left.x + left.width + padding >= right.x
    && left.y - padding <= right.y + right.height
    && left.y + left.height + padding >= right.y;
}

export function distanceToSegment(point: Point, start: Point, end: Point): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(point.x - start.x, point.y - start.y);
  const ratio = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (start.x + ratio * dx), point.y - (start.y + ratio * dy));
}

export function distanceToPolyline(point: Point, polyline: readonly Point[]): number {
  if (polyline.length === 0) return Number.POSITIVE_INFINITY;
  if (polyline.length === 1) return Math.hypot(point.x - polyline[0].x, point.y - polyline[0].y);
  let distance = Number.POSITIVE_INFINITY;
  for (let index = 1; index < polyline.length; index += 1) {
    distance = Math.min(distance, distanceToSegment(point, polyline[index - 1], polyline[index]));
    if (distance === 0) return 0;
  }
  return distance;
}

function cross(origin: Point, a: Point, b: Point): number {
  return (a.x - origin.x) * (b.y - origin.y) - (a.y - origin.y) * (b.x - origin.x);
}

export function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const abC = cross(a, b, c);
  const abD = cross(a, b, d);
  const cdA = cross(c, d, a);
  const cdB = cross(c, d, b);
  return ((abC > 0 && abD < 0) || (abC < 0 && abD > 0))
    && ((cdA > 0 && cdB < 0) || (cdA < 0 && cdB > 0));
}

export function segmentDistance(a: Point, b: Point, c: Point, d: Point): number {
  if (segmentsIntersect(a, b, c, d)) return 0;
  return Math.min(
    distanceToSegment(a, c, d),
    distanceToSegment(b, c, d),
    distanceToSegment(c, a, b),
    distanceToSegment(d, a, b),
  );
}

/** Half the drawn width: the ink reaches this far from its centre line. */
function inkReach(stroke: Pick<StrokeElementV2, "size">): number {
  return Math.max(0.5, stroke.size / 2);
}

/** Whether the point lies on the stroke's ink, allowing `tolerance` page units. */
export function strokeHitAt(
  stroke: Pick<StrokeElementV2, "points" | "size">,
  point: Point,
  tolerance: number,
): boolean {
  const reach = inkReach(stroke) + tolerance;
  if (!framesOverlap(strokeBounds(stroke), { x: point.x, y: point.y, width: 0, height: 0 }, reach)) {
    return false;
  }
  return distanceToPolyline(point, stroke.points) <= reach;
}

/** Whether an eraser moving from `start` to `end` with `radius` touches the stroke. */
export function strokeCrossedBy(
  stroke: Pick<StrokeElementV2, "points" | "size">,
  start: Point,
  end: Point,
  radius: number,
  sweep: Rect = pathBounds([start, end]),
): boolean {
  const reach = inkReach(stroke) + radius;
  if (!framesOverlap(strokeBounds(stroke), sweep, reach)) return false;
  const points = stroke.points;
  if (points.length === 1) return distanceToSegment(points[0], start, end) <= reach;
  for (let index = 1; index < points.length; index += 1) {
    if (segmentDistance(points[index - 1], points[index], start, end) <= reach) return true;
  }
  return false;
}

export function pointInPolygon(point: Point, polygon: readonly Point[]): boolean {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const a = polygon[index];
    const b = polygon[previous];
    if ((a.y > point.y) !== (b.y > point.y)
      && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * A lasso takes a stroke when most of its ink lies inside the loop, like
 * OneNote: circling a word takes the word even if a descender pokes out, and
 * a stroke that merely crosses the loop stays put.
 */
export function strokeInsideLasso(
  stroke: Pick<StrokeElementV2, "points">,
  polygon: readonly Point[],
  fraction = 0.5,
  loop: Rect = pathBounds(polygon),
): boolean {
  if (polygon.length < 3 || stroke.points.length === 0) return false;
  if (!framesOverlap(strokeBounds(stroke), loop)) return false;
  let inside = 0;
  for (const point of stroke.points) {
    if (pointInPolygon(point, polygon)) inside += 1;
  }
  return inside / stroke.points.length > fraction;
}

function frameCorners(frame: PageElementV2["frame"]): Point[] {
  const center = { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 };
  const radians = (frame.rotation * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return [
    { x: frame.x, y: frame.y },
    { x: frame.x + frame.width, y: frame.y },
    { x: frame.x + frame.width, y: frame.y + frame.height },
    { x: frame.x, y: frame.y + frame.height },
  ].map((corner) => ({
    x: center.x + (corner.x - center.x) * cos - (corner.y - center.y) * sin,
    y: center.y + (corner.x - center.x) * sin + (corner.y - center.y) * cos,
  }));
}

/**
 * Lasso selection by what the user actually circled. Ink counts by its
 * points; boxes (text, shapes, Math) by their centre; placed documents and
 * images only when fully enclosed, so lassoing handwriting on a worksheet
 * never grabs the worksheet. Locked elements (printouts, raw Math ink) and
 * erased strokes are skipped.
 */
export function selectByLasso(
  elements: Readonly<Record<string, PageElementV2>>,
  polygon: readonly Point[],
): string[] {
  if (polygon.length < 3) return [];
  const loop = pathBounds(polygon);
  const selected: string[] = [];
  for (const id in elements) {
    const element = elements[id];
    if (element.locked) continue;
    if (element.kind === "stroke") {
      if (!element.tombstonedAt && strokeInsideLasso(element, polygon, 0.5, loop)) selected.push(id);
      continue;
    }
    if (!framesOverlap(element.frame, loop)) continue;
    if (element.kind === "pdf" || element.kind === "image" || element.kind === "attachment") {
      if (frameCorners(element.frame).every((corner) => pointInPolygon(corner, polygon))) selected.push(id);
      continue;
    }
    const center = { x: element.frame.x + element.frame.width / 2, y: element.frame.y + element.frame.height / 2 };
    if (pointInPolygon(center, polygon)) selected.push(id);
  }
  return selected.sort();
}

/**
 * The topmost live stroke under a point, searching `order` from the top down
 * and stopping at `floorIndex` (the z-index of a DOM element already hit, so
 * ink below that element is not reachable through it).
 */
export function topmostStrokeAt(
  elements: Readonly<Record<string, PageElementV2>>,
  order: readonly string[],
  point: Point,
  tolerance: number,
  floorIndex = -1,
): string | undefined {
  for (let index = order.length - 1; index > floorIndex; index -= 1) {
    const element = elements[order[index]];
    if (element?.kind !== "stroke" || element.tombstonedAt) continue;
    if (strokeHitAt(element, point, tolerance)) return element.id;
  }
  return undefined;
}

/** Every live, unlocked stroke the eraser segment touches. */
export function strokesCrossedBy(
  elements: Readonly<Record<string, PageElementV2>>,
  start: Point,
  end: Point,
  radius: number,
): string[] {
  const sweep = pathBounds([start, end]);
  const crossed: Array<{ position: number; id: string }> = [];
  strokeIndexFor(elements).forEachNear(sweep, radius, (stroke, position) => {
    if (!stroke.tombstonedAt && !stroke.locked && strokeCrossedBy(stroke, start, end, radius, sweep)) {
      crossed.push({ position, id: stroke.id });
    }
  });
  // The snapshot's own order, whatever order the grid found them in.
  return crossed.sort((left, right) => left.position - right.position).map((entry) => entry.id);
}

/** Page units per grid cell of the stroke index. */
const INDEX_CELL = 128;
/** A stroke spanning more cells than this is checked on every query instead of being listed in each cell. */
const INDEX_MAX_CELLS = 64;

/**
 * A uniform grid over a page's strokes, so that an eraser or a hit test looks
 * at the few strokes near it instead of every stroke on the page. Built once
 * per page snapshot (snapshots are immutable), on the first query.
 */
class StrokeIndex {
  private readonly strokes: StrokeElementV2[] = [];
  private readonly cells = new Map<number, number[]>();
  /** Strokes too large for the grid, by position in `strokes`. */
  private readonly large: number[] = [];
  private readonly visited: Uint32Array;
  private generation = 0;
  /** The widest stroke, which decides how far a query has to look beyond its own area. */
  private maxReach = 0;

  constructor(elements: Readonly<Record<string, PageElementV2>>) {
    for (const id in elements) {
      const element = elements[id];
      if (element.kind === "stroke") this.strokes.push(element);
    }
    this.visited = new Uint32Array(this.strokes.length);
    this.strokes.forEach((stroke, position) => {
      const reach = inkReach(stroke);
      this.maxReach = Math.max(this.maxReach, reach);
      const bounds = strokeBounds(stroke);
      const firstColumn = Math.floor((bounds.x - reach) / INDEX_CELL);
      const lastColumn = Math.floor((bounds.x + bounds.width + reach) / INDEX_CELL);
      const firstRow = Math.floor((bounds.y - reach) / INDEX_CELL);
      const lastRow = Math.floor((bounds.y + bounds.height + reach) / INDEX_CELL);
      if ((lastColumn - firstColumn + 1) * (lastRow - firstRow + 1) > INDEX_MAX_CELLS) {
        this.large.push(position);
        return;
      }
      for (let row = firstRow; row <= lastRow; row += 1) {
        for (let column = firstColumn; column <= lastColumn; column += 1) {
          const key = cellKey(column, row);
          const cell = this.cells.get(key);
          if (cell) cell.push(position);
          else this.cells.set(key, [position]);
        }
      }
    });
  }

  /**
   * Calls `visit` once for every stroke whose bounds, grown by its ink reach
   * and `radius`, can touch `area`, with the stroke's position among the
   * snapshot's strokes; callers still test the ink itself.
   */
  forEachNear(area: Rect, radius: number, visit: (stroke: StrokeElementV2, position: number) => void): void {
    this.generation += 1;
    const seen = (position: number): boolean => {
      if (this.visited[position] === this.generation) return true;
      this.visited[position] = this.generation;
      return false;
    };
    const look = this.maxReach + radius;
    const firstColumn = Math.floor((area.x - look) / INDEX_CELL);
    const lastColumn = Math.floor((area.x + area.width + look) / INDEX_CELL);
    const firstRow = Math.floor((area.y - look) / INDEX_CELL);
    const lastRow = Math.floor((area.y + area.height + look) / INDEX_CELL);
    for (const position of this.large) visit(this.strokes[position], position);
    for (let row = firstRow; row <= lastRow; row += 1) {
      for (let column = firstColumn; column <= lastColumn; column += 1) {
        const cell = this.cells.get(cellKey(column, row));
        if (!cell) continue;
        for (const position of cell) {
          if (!seen(position)) visit(this.strokes[position], position);
        }
      }
    }
  }
}

/** Grid cells are keyed by one number: rows and columns stay far below 2^20 on any page. */
function cellKey(column: number, row: number): number {
  return (row + 1_048_576) * 2_097_152 + (column + 1_048_576);
}

const indexCache = new WeakMap<object, StrokeIndex>();

function strokeIndexFor(elements: Readonly<Record<string, PageElementV2>>): StrokeIndex {
  let index = indexCache.get(elements);
  if (!index) {
    index = new StrokeIndex(elements);
    indexCache.set(elements, index);
  }
  return index;
}
