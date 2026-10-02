import type { ElementFrame, ShapeElementV2, StrokePointV2 } from "../domain/v2";
import type { Point } from "./operations";

export const INK_SHAPE_HOLD_MS = 600;

export interface HeldInkShapeCandidate {
  shape: "line" | "rectangle" | "ellipse";
  frame: ElementFrame;
  points?: [Point, Point];
  confidence: number;
}

interface Bounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

const MIN_SHAPE_SIZE = 24;

export function recognizeHeldInkShape(
  rawPoints: readonly StrokePointV2[],
): HeldInkShapeCandidate | undefined {
  const points = deduplicatePoints(rawPoints);
  if (points.length < 4) return undefined;
  const bounds = pointBounds(points);
  const diagonal = Math.hypot(bounds.width, bounds.height);
  if (diagonal < MIN_SHAPE_SIZE) return undefined;
  const length = pathLength(points);
  if (length < MIN_SHAPE_SIZE) return undefined;

  const line = recognizeLine(points, bounds, length, diagonal);
  if (line) return line;

  const closureDistance = distance(points[0], points[points.length - 1]);
  if (
    closureDistance > Math.max(20, diagonal * 0.28) ||
    Math.min(bounds.width, bounds.height) < MIN_SHAPE_SIZE ||
    length < diagonal * 2
  ) {
    return undefined;
  }

  const rectangle = recognizeRectangle(points, diagonal);
  const ellipse = recognizeEllipse(points, bounds, diagonal);
  if (rectangle && ellipse) {
    return rectangle.confidence >= ellipse.confidence ? rectangle : ellipse;
  }
  return rectangle ?? ellipse;
}

export function createHeldInkShapeElement(options: {
  candidate: HeldInkShapeCandidate;
  id: string;
  timestamp: string;
  color: string;
  strokeWidth: number;
}): ShapeElementV2 {
  const { candidate } = options;
  return {
    id: options.id,
    kind: "shape",
    shape: candidate.shape,
    frame: { ...candidate.frame },
    createdAt: options.timestamp,
    updatedAt: options.timestamp,
    locked: false,
    strokeColor: options.color,
    strokeWidth: Math.max(1, options.strokeWidth),
    ...(candidate.points
      ? { points: candidate.points.map((point) => ({ ...point })) }
      : {}),
  };
}

function recognizeLine(
  points: readonly Point[],
  bounds: Bounds,
  length: number,
  diagonal: number,
): HeldInkShapeCandidate | undefined {
  const start = points[0];
  const end = points[points.length - 1];
  const direct = distance(start, end);
  if (direct / length < 0.92) return undefined;
  const maximumDeviation = points.reduce(
    (maximum, point) => Math.max(maximum, distanceToSegment(point, start, end)),
    0,
  );
  const tolerance = Math.max(4, diagonal * 0.07);
  if (maximumDeviation > tolerance) return undefined;
  return {
    shape: "line",
    frame: frameFromBounds(bounds),
    points: [
      { x: start.x, y: start.y },
      { x: end.x, y: end.y },
    ],
    confidence: clampConfidence(1 - maximumDeviation / tolerance),
  };
}

function recognizeRectangle(
  points: readonly Point[],
  diagonal: number,
): HeldInkShapeCandidate | undefined {
  const corners = polygonCorners(points, 4, diagonal * 0.075);
  if (corners.length !== 4) return undefined;
  const sides = corners.map((corner, index) => ({
    x: corners[(index + 1) % corners.length].x - corner.x,
    y: corners[(index + 1) % corners.length].y - corner.y,
  }));
  const lengths = sides.map((side) => Math.hypot(side.x, side.y));
  if (Math.min(...lengths) < MIN_SHAPE_SIZE * 0.7) return undefined;

  const rightAngleErrors = sides.map((side, index) => {
    const next = sides[(index + 1) % sides.length];
    return Math.abs(side.x * next.x + side.y * next.y)
      / (lengths[index] * lengths[(index + 1) % lengths.length]);
  });
  const maximumRightAngleError = Math.max(...rightAngleErrors);
  const oppositeWidthError = relativeDifference(lengths[0], lengths[2]);
  const oppositeHeightError = relativeDifference(lengths[1], lengths[3]);
  if (
    maximumRightAngleError > 0.38 ||
    oppositeWidthError > 0.42 ||
    oppositeHeightError > 0.42
  ) {
    return undefined;
  }

  const edgeError = averageDistanceToPolygon(points, corners) / diagonal;
  if (edgeError > 0.07) return undefined;
  const center = corners.reduce(
    (sum, corner) => ({ x: sum.x + corner.x / 4, y: sum.y + corner.y / 4 }),
    { x: 0, y: 0 },
  );
  const width = (lengths[0] + lengths[2]) / 2;
  const height = (lengths[1] + lengths[3]) / 2;
  const rotation = Math.atan2(sides[0].y, sides[0].x) * 180 / Math.PI;
  return {
    shape: "rectangle",
    frame: {
      x: center.x - width / 2,
      y: center.y - height / 2,
      width,
      height,
      rotation,
    },
    confidence: clampConfidence(
      1 - edgeError * 5 - maximumRightAngleError * 0.45,
    ),
  };
}

function recognizeEllipse(
  points: readonly Point[],
  bounds: Bounds,
  diagonal: number,
): HeldInkShapeCandidate | undefined {
  const radiusX = bounds.width / 2;
  const radiusY = bounds.height / 2;
  const centerX = bounds.left + radiusX;
  const centerY = bounds.top + radiusY;
  const radialErrors = points.map((point) => Math.abs(
    Math.hypot((point.x - centerX) / radiusX, (point.y - centerY) / radiusY) - 1,
  ));
  const averageError = radialErrors.reduce((sum, error) => sum + error, 0)
    / radialErrors.length;
  if (averageError > 0.17 || Math.max(...radialErrors) > 0.48) return undefined;

  const quadrants = new Set(points.map((point) => (
    `${point.x >= centerX ? 1 : 0}:${point.y >= centerY ? 1 : 0}`
  )));
  if (quadrants.size < 4) return undefined;
  const closurePenalty = distance(points[0], points[points.length - 1]) / diagonal;
  return {
    shape: "ellipse",
    frame: frameFromBounds(bounds),
    confidence: clampConfidence(1 - averageError * 3 - closurePenalty * 0.25),
  };
}

function polygonCorners(
  points: readonly Point[],
  targetCount: number,
  epsilon: number,
): Point[] {
  const open = distance(points[0], points[points.length - 1]) <= epsilon
    ? points.slice(0, -1)
    : [...points];
  if (open.length < targetCount) return [];
  const centroid = open.reduce(
    (sum, point) => ({ x: sum.x + point.x / open.length, y: sum.y + point.y / open.length }),
    { x: 0, y: 0 },
  );
  const firstIndex = farthestPointIndex(open, centroid);
  const secondIndex = farthestPointIndex(open, open[firstIndex]);
  const firstChain = cyclicSlice(open, firstIndex, secondIndex);
  const secondChain = cyclicSlice(open, secondIndex, firstIndex);
  const simplified = [
    ...simplifyPolyline(firstChain, epsilon).slice(0, -1),
    ...simplifyPolyline(secondChain, epsilon).slice(0, -1),
  ];
  const corners = deduplicatePoints(simplified, epsilon * 0.35);
  while (corners.length > targetCount) {
    let smallestArea = Number.POSITIVE_INFINITY;
    let removeIndex = -1;
    corners.forEach((corner, index) => {
      const previous = corners[(index - 1 + corners.length) % corners.length];
      const next = corners[(index + 1) % corners.length];
      const area = Math.abs(cross(previous, corner, next));
      if (area < smallestArea) {
        smallestArea = area;
        removeIndex = index;
      }
    });
    if (removeIndex < 0) break;
    corners.splice(removeIndex, 1);
  }
  return corners;
}

function simplifyPolyline(points: readonly Point[], epsilon: number): Point[] {
  if (points.length <= 2) return points.map((point) => ({ ...point }));
  const start = points[0];
  const end = points[points.length - 1];
  let maximumDistance = 0;
  let maximumIndex = 0;
  for (let index = 1; index < points.length - 1; index += 1) {
    const candidateDistance = distanceToSegment(points[index], start, end);
    if (candidateDistance > maximumDistance) {
      maximumDistance = candidateDistance;
      maximumIndex = index;
    }
  }
  if (maximumDistance <= epsilon) return [{ ...start }, { ...end }];
  return [
    ...simplifyPolyline(points.slice(0, maximumIndex + 1), epsilon).slice(0, -1),
    ...simplifyPolyline(points.slice(maximumIndex), epsilon),
  ];
}

function cyclicSlice(points: readonly Point[], start: number, end: number): Point[] {
  const result = [{ ...points[start] }];
  for (let index = start; index !== end;) {
    index = (index + 1) % points.length;
    result.push({ ...points[index] });
  }
  return result;
}

function farthestPointIndex(points: readonly Point[], origin: Point): number {
  let index = 0;
  let maximumDistance = -1;
  points.forEach((point, pointIndex) => {
    const candidateDistance = distance(point, origin);
    if (candidateDistance > maximumDistance) {
      maximumDistance = candidateDistance;
      index = pointIndex;
    }
  });
  return index;
}

function averageDistanceToPolygon(points: readonly Point[], corners: readonly Point[]): number {
  const total = points.reduce((sum, point) => {
    let minimum = Number.POSITIVE_INFINITY;
    corners.forEach((corner, index) => {
      minimum = Math.min(
        minimum,
        distanceToSegment(point, corner, corners[(index + 1) % corners.length]),
      );
    });
    return sum + minimum;
  }, 0);
  return total / points.length;
}

function pointBounds(points: readonly Point[]): Bounds {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  const right = Math.max(...xs);
  const bottom = Math.max(...ys);
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

function frameFromBounds(bounds: Bounds): ElementFrame {
  return {
    x: bounds.left,
    y: bounds.top,
    width: Math.max(1, bounds.width),
    height: Math.max(1, bounds.height),
    rotation: 0,
  };
}

function deduplicatePoints<T extends Point>(
  points: readonly T[],
  tolerance = 1.25,
): T[] {
  const result: T[] = [];
  points.forEach((point) => {
    const previous = result[result.length - 1];
    if (!previous || distance(previous, point) > tolerance) result.push(point);
  });
  return result;
}

function pathLength(points: readonly Point[]): number {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    total += distance(points[index - 1], points[index]);
  }
  return total;
}

function distance(left: Point, right: Point): number {
  return Math.hypot(right.x - left.x, right.y - left.y);
}

function distanceToSegment(point: Point, start: Point, end: Point): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return distance(point, start);
  const projection = Math.max(0, Math.min(1,
    ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared,
  ));
  return distance(point, {
    x: start.x + projection * dx,
    y: start.y + projection * dy,
  });
}

function cross(first: Point, middle: Point, last: Point): number {
  return (middle.x - first.x) * (last.y - first.y)
    - (middle.y - first.y) * (last.x - first.x);
}

function relativeDifference(left: number, right: number): number {
  return Math.abs(left - right) / Math.max(left, right, 1);
}

function clampConfidence(value: number): number {
  return Math.max(0, Math.min(1, value));
}
