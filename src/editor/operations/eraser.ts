import type { StrokeElementV2, StrokePointV2 } from '../../domain/v2/types';
import type { Point } from './geometry';

export interface StrokeEraseResult {
  source: StrokeElementV2;
  segments: readonly StrokeElementV2[];
  changed: boolean;
}

export function eraseWholeStroke(
  stroke: StrokeElementV2,
  erasedAt: string,
): StrokeEraseResult {
  if (stroke.tombstonedAt) return { source: stroke, segments: [], changed: false };
  return {
    source: { ...stroke, tombstonedAt: erasedAt, updatedAt: erasedAt },
    segments: [],
    changed: true,
  };
}

export function eraseStrokePoints(
  stroke: StrokeElementV2,
  eraserPath: readonly Point[],
  radius: number,
  erasedAt: string,
  createSegmentId: (
    sourceStrokeId: string,
    erasedStrokeId: string,
    segmentIndex: number,
  ) => string,
  minimumPoints = 2,
): StrokeEraseResult {
  if (stroke.tombstonedAt) return { source: stroke, segments: [], changed: false };
  if (eraserPath.length === 0 || !Number.isFinite(radius) || radius <= 0) {
    return { source: stroke, segments: [], changed: false };
  }
  if (!Number.isSafeInteger(minimumPoints) || minimumPoints < 1) {
    throw new Error('minimumPoints must be a positive safe integer');
  }
  eraserPath.forEach((point) => {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      throw new Error('Eraser path points must be finite');
    }
  });

  // Only the parts of the eraser's path near this stroke can touch it; a long
  // scribble would otherwise be measured against every point of every stroke.
  const nearby = segmentsNear(eraserPath, stroke.points, radius);
  if (nearby.length === 0) return { source: stroke, segments: [], changed: false };

  const runs: StrokePointV2[][] = [];
  let run: StrokePointV2[] = [];
  let changed = false;
  for (let index = 0; index < stroke.points.length; index += 1) {
    const point = stroke.points[index];
    const erased = distanceToSegments(point, nearby) <= radius;
    const crosses =
      index > 0 &&
      segmentsDistance(stroke.points[index - 1], point, nearby) <= radius;
    if (erased || (crosses && run.length > 0)) {
      changed = true;
      if (run.length >= minimumPoints) runs.push(run);
      run = [];
      if (erased) continue;
    }
    run.push({ ...point });
  }
  if (run.length >= minimumPoints) runs.push(run);
  if (!changed) return { source: stroke, segments: [], changed: false };

  const rootSourceId = stroke.sourceStrokeId ?? stroke.id;
  const segmentBase = structuredClone(stroke);
  delete segmentBase.tombstonedAt;
  const segments = runs.map((points, index): StrokeElementV2 => ({
    ...segmentBase,
    id: createSegmentId(rootSourceId, stroke.id, index),
    sourceStrokeId: rootSourceId,
    points,
    frame: frameForPoints(points, stroke.frame.rotation),
    createdAt: erasedAt,
    updatedAt: erasedAt,
  }));
  return {
    source: { ...stroke, tombstonedAt: erasedAt, updatedAt: erasedAt },
    segments,
    changed: true,
  };
}

/** Tombstones are monotonic: merging an older live copy can never resurrect a stroke. */
export function reconcileStrokeTombstone(
  left: StrokeElementV2,
  right: StrokeElementV2,
): StrokeElementV2 {
  if (left.id !== right.id) throw new Error('Only versions of the same stroke can be reconciled');
  const tombstones = [left.tombstonedAt, right.tombstonedAt].filter(
    (value): value is string => Boolean(value),
  );
  const newer = left.updatedAt >= right.updatedAt ? left : right;
  if (tombstones.length === 0) return structuredClone(newer);
  const tombstonedAt = tombstones.sort().at(-1);
  return { ...structuredClone(newer), tombstonedAt };
}

function frameForPoints(points: readonly StrokePointV2[], rotation: number) {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y, rotation };
}

type PathSegment = readonly [Point, Point];

/**
 * The segments of `path` (a single point counts as a zero-length one) whose
 * box lies within `radius` of the box of `points`. A segment farther away is
 * farther than `radius` from every point and every segment between them.
 */
function segmentsNear(
  path: readonly Point[],
  points: readonly Point[],
  radius: number,
): PathSegment[] {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    if (point.x < minX) minX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.x > maxX) maxX = point.x;
    if (point.y > maxY) maxY = point.y;
  }
  const near = (start: Point, end: Point) =>
    Math.min(start.x, end.x) - radius <= maxX && Math.max(start.x, end.x) + radius >= minX
    && Math.min(start.y, end.y) - radius <= maxY && Math.max(start.y, end.y) + radius >= minY;
  if (path.length === 1) return near(path[0], path[0]) ? [[path[0], path[0]]] : [];
  const segments: PathSegment[] = [];
  for (let index = 1; index < path.length; index += 1) {
    if (near(path[index - 1], path[index])) segments.push([path[index - 1], path[index]]);
  }
  return segments;
}

function distanceToSegments(point: Point, segments: readonly PathSegment[]): number {
  let distance = Number.POSITIVE_INFINITY;
  for (const [start, end] of segments) {
    distance = Math.min(distance, distancePointToSegment(point, start, end));
  }
  return distance;
}

function segmentsDistance(start: Point, end: Point, segments: readonly PathSegment[]): number {
  let distance = Number.POSITIVE_INFINITY;
  for (const [from, to] of segments) {
    distance = Math.min(distance, segmentDistance(start, end, from, to));
  }
  return distance;
}

function segmentDistance(a: Point, b: Point, c: Point, d: Point): number {
  if (segmentsIntersect(a, b, c, d)) return 0;
  return Math.min(
    distancePointToSegment(a, c, d),
    distancePointToSegment(b, c, d),
    distancePointToSegment(c, a, b),
    distancePointToSegment(d, a, b),
  );
}

function distancePointToSegment(point: Point, start: Point, end: Point): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (dx === 0 && dy === 0) return Math.hypot(point.x - start.x, point.y - start.y);
  const ratio = Math.max(
    0,
    Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy)),
  );
  return Math.hypot(point.x - (start.x + ratio * dx), point.y - (start.y + ratio * dy));
}

function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const cross = (p: Point, q: Point, r: Point) =>
    (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  return (
    Math.sign(cross(a, b, c)) !== Math.sign(cross(a, b, d)) &&
    Math.sign(cross(c, d, a)) !== Math.sign(cross(c, d, b))
  );
}
