import type { PageBackground, ShapeType } from '../domain/types';

export interface CanvasPoint {
  x: number;
  y: number;
}

export interface ShapeGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const ANGLE_SNAP_DEGREES = 15;

export function backgroundGridSpacing(background: PageBackground): number | null {
  if (background === 'millimeter') return 10;
  if (background === 'grid') return 40;
  if (background === 'lined') return 32;
  return null;
}

export function snapPointToGrid(point: CanvasPoint, spacing: number | null): CanvasPoint {
  if (!spacing || spacing <= 0) return point;
  return {
    x: Math.round(point.x / spacing) * spacing,
    y: Math.round(point.y / spacing) * spacing,
  };
}

export function snapVectorToAngle(
  start: CanvasPoint,
  end: CanvasPoint,
  stepDegrees = ANGLE_SNAP_DEGREES,
): CanvasPoint {
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  const length = Math.hypot(deltaX, deltaY);
  if (length === 0 || stepDegrees <= 0) return end;
  const step = (stepDegrees * Math.PI) / 180;
  const angle = Math.round(Math.atan2(deltaY, deltaX) / step) * step;
  return {
    x: start.x + Math.cos(angle) * length,
    y: start.y + Math.sin(angle) * length,
  };
}

export function shapeGeometryFromDrag(
  start: CanvasPoint,
  end: CanvasPoint,
  shapeType: ShapeType,
  options: { angleSnap: boolean; gridSpacing: number | null },
): ShapeGeometry {
  const snappedStart = snapPointToGrid(start, options.gridSpacing);
  let snappedEnd = snapPointToGrid(end, options.gridSpacing);
  if (
    options.angleSnap &&
    (shapeType === 'line' || shapeType === 'arrow' || shapeType === 'axes')
  ) {
    snappedEnd = snapVectorToAngle(snappedStart, snappedEnd);
  }

  const width = snappedEnd.x - snappedStart.x;
  const height = snappedEnd.y - snappedStart.y;
  if (shapeType === 'line' || shapeType === 'arrow') {
    return { x: snappedStart.x, y: snappedStart.y, width, height };
  }

  return {
    x: Math.min(snappedStart.x, snappedEnd.x),
    y: Math.min(snappedStart.y, snappedEnd.y),
    width: Math.abs(width),
    height: Math.abs(height),
  };
}

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(2.5, Math.max(0.25, Math.round(zoom * 100) / 100));
}
