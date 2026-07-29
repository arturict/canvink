import { getStroke } from 'perfect-freehand';
import type { InkPoint, StrokeElement } from '../domain/types';

export type OutlinePoint = [number, number];

export function getStrokeOutline(
  points: InkPoint[],
  size: number,
  simulatePressure = true,
): OutlinePoint[] {
  if (points.length === 0) return [];

  return getStroke(
    points.map((point) => [point.x, point.y, point.pressure]),
    {
      size,
      thinning: 0.62,
      smoothing: 0.62,
      streamline: 0.42,
      easing: (value) => value,
      simulatePressure,
      start: {
        cap: true,
        taper: 0,
      },
      end: {
        cap: true,
        taper: 0,
      },
    },
  ) as OutlinePoint[];
}

const round = (value: number) => Math.round(value * 100) / 100;

export function outlineToSvgPath(points: OutlinePoint[]): string {
  if (points.length < 2) return '';
  const first = points[0];
  let path = `M ${round(first[0])} ${round(first[1])}`;

  for (let index = 1; index < points.length; index += 1) {
    const point = points[index];
    const next = points[(index + 1) % points.length];
    path += ` Q ${round(point[0])} ${round(point[1])} ${round((point[0] + next[0]) / 2)} ${round((point[1] + next[1]) / 2)}`;
  }

  return `${path} Z`;
}

export function strokeToSvgPath(stroke: Pick<StrokeElement, 'points' | 'size'>): string {
  const pointerIsPen = stroke.points.some((point) => point.pointerType === 'pen');
  return outlineToSvgPath(getStrokeOutline(stroke.points, stroke.size, !pointerIsPen));
}
