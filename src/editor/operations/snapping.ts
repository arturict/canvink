import type { Point } from './geometry';

export function snapPointToGrid(point: Point, spacing: number): Point {
  if (!Number.isFinite(spacing) || spacing <= 0) return { ...point };
  return {
    x: Math.round(point.x / spacing) * spacing,
    y: Math.round(point.y / spacing) * spacing,
  };
}

export function snapPointToAngle(
  start: Point,
  end: Point,
  stepDegrees = 15,
): Point {
  const length = Math.hypot(end.x - start.x, end.y - start.y);
  if (length === 0 || !Number.isFinite(stepDegrees) || stepDegrees <= 0) return { ...end };
  const step = (stepDegrees * Math.PI) / 180;
  const angle = Math.round(Math.atan2(end.y - start.y, end.x - start.x) / step) * step;
  return { x: start.x + Math.cos(angle) * length, y: start.y + Math.sin(angle) * length };
}

export function snapPointToRuler(point: Point, rulerStart: Point, rulerEnd: Point): Point {
  const dx = rulerEnd.x - rulerStart.x;
  const dy = rulerEnd.y - rulerStart.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return { ...rulerStart };
  const ratio = ((point.x - rulerStart.x) * dx + (point.y - rulerStart.y) * dy) / lengthSquared;
  return { x: rulerStart.x + ratio * dx, y: rulerStart.y + ratio * dy };
}

export interface RulerEdgeGeometry {
  center: Point;
  angleDegrees: number;
  length: number;
  edgeOffset: number;
}

export function rulerEdgePoints(ruler: RulerEdgeGeometry): [Point, Point] {
  const angle = (ruler.angleDegrees * Math.PI) / 180;
  const tangent = { x: Math.cos(angle), y: Math.sin(angle) };
  const normal = { x: -tangent.y, y: tangent.x };
  const edgeCenter = {
    x: ruler.center.x + normal.x * ruler.edgeOffset,
    y: ruler.center.y + normal.y * ruler.edgeOffset,
  };
  const halfLength = Math.max(1, ruler.length) / 2;
  return [
    {
      x: edgeCenter.x - tangent.x * halfLength,
      y: edgeCenter.y - tangent.y * halfLength,
    },
    {
      x: edgeCenter.x + tangent.x * halfLength,
      y: edgeCenter.y + tangent.y * halfLength,
    },
  ];
}

export function distanceToRulerEdge(point: Point, ruler: RulerEdgeGeometry): number {
  const [start, end] = rulerEdgePoints(ruler);
  const snapped = projectPointToSegment(point, start, end);
  return Math.hypot(point.x - snapped.x, point.y - snapped.y);
}

export function snapPointToRulerEdge(
  point: Point,
  ruler: RulerEdgeGeometry,
  threshold = 32,
): Point {
  if (Number.isNaN(threshold) || threshold < 0) return { ...point };
  const [start, end] = rulerEdgePoints(ruler);
  const snapped = projectPointToSegment(point, start, end);
  return Math.hypot(point.x - snapped.x, point.y - snapped.y) <= threshold
    ? snapped
    : { ...point };
}

function projectPointToSegment(point: Point, start: Point, end: Point): Point {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return { ...start };
  const ratio = Math.min(1, Math.max(0,
    ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared,
  ));
  return { x: start.x + ratio * dx, y: start.y + ratio * dy };
}
