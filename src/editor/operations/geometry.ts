import type { ElementFrame } from '../../domain/v2/types';
import type { PageElementV3 as PageElementV2 } from '../../domain/v3';

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SelectionTransform {
  translateX?: number;
  translateY?: number;
  scaleX?: number;
  scaleY?: number;
  rotationDegrees?: number;
  origin?: Point;
}

export type SelectionResizeHandle = 'north-west' | 'north-east' | 'south-east' | 'south-west';

export const MAX_LASSO_POINTS = 4_096;

export function resizeSelectionFromCorner(
  bounds: Rect,
  handle: SelectionResizeHandle,
  point: Point,
): SelectionTransform {
  const corners: Record<SelectionResizeHandle, Point> = {
    'north-west': { x: bounds.x, y: bounds.y },
    'north-east': { x: bounds.x + bounds.width, y: bounds.y },
    'south-east': { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
    'south-west': { x: bounds.x, y: bounds.y + bounds.height },
  };
  const opposites: Record<SelectionResizeHandle, SelectionResizeHandle> = {
    'north-west': 'south-east',
    'north-east': 'south-west',
    'south-east': 'north-west',
    'south-west': 'north-east',
  };
  const start = corners[handle];
  const origin = corners[opposites[handle]];
  const initial = { x: start.x - origin.x, y: start.y - origin.y };
  const current = { x: point.x - origin.x, y: point.y - origin.y };
  const lengthSquared = initial.x * initial.x + initial.y * initial.y;
  if (lengthSquared === 0 || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    return { scaleX: 1, scaleY: 1, origin };
  }
  const projectedScale = (current.x * initial.x + current.y * initial.y) / lengthSquared;
  const scale = Math.min(8, Math.max(0.1, projectedScale));
  return { scaleX: scale, scaleY: scale, origin };
}

export function selectElementsInRect(
  elements: Readonly<Record<string, PageElementV2>>,
  rect: Rect,
): string[] {
  const polygon = rectToPolygon(normalizeRect(rect));
  return selectElementsInPolygon(elements, polygon);
}

export function selectElementsInPolygon(
  elements: Readonly<Record<string, PageElementV2>>,
  polygon: readonly Point[],
): string[] {
  if (polygon.length < 3) return [];
  if (polygon.length > MAX_LASSO_POINTS) {
    throw new Error(`Lasso exceeds ${MAX_LASSO_POINTS} points`);
  }
  polygon.forEach(assertPoint);
  return Object.values(elements)
    .filter((element) => polygonsIntersect(polygon, frameToPolygon(element.frame)))
    .map((element) => element.id)
    .sort();
}

export function selectionBounds(
  elements: Readonly<Record<string, PageElementV2>>,
  selectedIds: readonly string[],
): Rect | null {
  const points = selectedIds.flatMap((id) => {
    const element = elements[id];
    return element ? frameToPolygon(element.frame) : [];
  });
  if (points.length === 0) return null;
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  return { x: left, y: top, width: Math.max(...xs) - left, height: Math.max(...ys) - top };
}

export function transformSelection(
  elements: Readonly<Record<string, PageElementV2>>,
  selectedIds: readonly string[],
  transform: SelectionTransform,
  updatedAt: string,
): Record<string, PageElementV2> {
  const bounds = selectionBounds(elements, selectedIds);
  if (!bounds) return { ...elements };
  const origin = transform.origin ?? {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
  };
  const selected = new Set(selectedIds);
  const result: Record<string, PageElementV2> = { ...elements };
  for (const [id, element] of Object.entries(elements)) {
    if (!selected.has(id) || element.locked) continue;
    const frame = transformFrame(element.frame, origin, transform);
    let next: PageElementV2 = { ...element, frame, updatedAt };
    if (element.kind === 'stroke') {
      next = {
        ...element,
        frame,
        updatedAt,
        points: element.points.map((point) => ({
          ...point,
          ...transformPoint(point, origin, transform),
        })),
      };
    } else if (element.kind === 'shape' && element.points) {
      next = {
        ...element,
        frame,
        updatedAt,
        points: element.points.map((point) => transformPoint(point, origin, transform)),
      };
    }
    result[id] = next;
  }
  return result;
}

function transformPoint(point: Point, origin: Point, transform: SelectionTransform): Point {
  const scaleX = transform.scaleX ?? 1;
  const scaleY = transform.scaleY ?? 1;
  const radians = ((transform.rotationDegrees ?? 0) * Math.PI) / 180;
  const scaledX = (point.x - origin.x) * scaleX;
  const scaledY = (point.y - origin.y) * scaleY;
  return {
    x:
      origin.x +
      scaledX * Math.cos(radians) -
      scaledY * Math.sin(radians) +
      (transform.translateX ?? 0),
    y:
      origin.y +
      scaledX * Math.sin(radians) +
      scaledY * Math.cos(radians) +
      (transform.translateY ?? 0),
  };
}

function frameToPolygon(frame: ElementFrame): Point[] {
  const center = { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 };
  const radians = (frame.rotation * Math.PI) / 180;
  return rectToPolygon(frame).map((point) => rotate(point, center, radians));
}

function rectToPolygon(rect: Rect): Point[] {
  return [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x + rect.width, y: rect.y + rect.height },
    { x: rect.x, y: rect.y + rect.height },
  ];
}

function normalizeRect(rect: Rect): Rect {
  return {
    x: Math.min(rect.x, rect.x + rect.width),
    y: Math.min(rect.y, rect.y + rect.height),
    width: Math.abs(rect.width),
    height: Math.abs(rect.height),
  };
}

function rotate(point: Point, center: Point, radians: number): Point {
  const x = point.x - center.x;
  const y = point.y - center.y;
  return {
    x: center.x + x * Math.cos(radians) - y * Math.sin(radians),
    y: center.y + x * Math.sin(radians) + y * Math.cos(radians),
  };
}

function transformFrame(
  frame: ElementFrame,
  origin: Point,
  transform: SelectionTransform,
): ElementFrame {
  const center = transformPoint(
    { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 },
    origin,
    transform,
  );
  const width = Math.abs(frame.width * (transform.scaleX ?? 1));
  const height = Math.abs(frame.height * (transform.scaleY ?? 1));
  return {
    x: center.x - width / 2,
    y: center.y - height / 2,
    width,
    height,
    rotation: frame.rotation + (transform.rotationDegrees ?? 0),
  };
}

function polygonsIntersect(left: readonly Point[], right: readonly Point[]): boolean {
  if (left.some((point) => pointInPolygon(point, right))) return true;
  if (right.some((point) => pointInPolygon(point, left))) return true;
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    const leftStart = left[leftIndex];
    const leftEnd = left[(leftIndex + 1) % left.length];
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      const rightStart = right[rightIndex];
      const rightEnd = right[(rightIndex + 1) % right.length];
      if (segmentsIntersect(leftStart, leftEnd, rightStart, rightEnd)) return true;
    }
  }
  return false;
}

function pointInPolygon(point: Point, polygon: readonly Point[]): boolean {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const currentPoint = polygon[index];
    const previousPoint = polygon[previous];
    if (pointOnSegment(point, previousPoint, currentPoint)) return true;
    const crosses =
      currentPoint.y > point.y !== previousPoint.y > point.y &&
      point.x <
        ((previousPoint.x - currentPoint.x) * (point.y - currentPoint.y)) /
          (previousPoint.y - currentPoint.y) +
          currentPoint.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const abC = cross(a, b, c);
  const abD = cross(a, b, d);
  const cdA = cross(c, d, a);
  const cdB = cross(c, d, b);
  if (abC === 0 && pointOnSegment(c, a, b)) return true;
  if (abD === 0 && pointOnSegment(d, a, b)) return true;
  if (cdA === 0 && pointOnSegment(a, c, d)) return true;
  if (cdB === 0 && pointOnSegment(b, c, d)) return true;
  return Math.sign(abC) !== Math.sign(abD) && Math.sign(cdA) !== Math.sign(cdB);
}

function cross(a: Point, b: Point, c: Point): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function pointOnSegment(point: Point, start: Point, end: Point): boolean {
  const epsilon = 1e-9;
  return (
    Math.abs(cross(start, end, point)) <= epsilon &&
    point.x >= Math.min(start.x, end.x) - epsilon &&
    point.x <= Math.max(start.x, end.x) + epsilon &&
    point.y >= Math.min(start.y, end.y) - epsilon &&
    point.y <= Math.max(start.y, end.y) + epsilon
  );
}

function assertPoint(point: Point): void {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new Error('Lasso points must be finite');
  }
}
