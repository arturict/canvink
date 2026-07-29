import { describe, expect, it } from 'vitest';
import { getStrokeOutline, outlineToSvgPath } from './ink';
import type { InkPoint } from '../domain/types';

const points: InkPoint[] = [
  { x: 1, y: 2, pressure: 0.2, tiltX: 0, tiltY: 0, time: 1, pointerType: 'pen' },
  { x: 20, y: 22, pressure: 0.8, tiltX: 1, tiltY: 2, time: 2, pointerType: 'pen' },
];

describe('ink geometry', () => {
  it('turns raw pressure samples into a closed outline', () => {
    const outline = getStrokeOutline(points, 8, false);
    const path = outlineToSvgPath(outline);

    expect(outline.length).toBeGreaterThan(2);
    expect(path.startsWith('M ')).toBe(true);
    expect(path.endsWith(' Z')).toBe(true);
  });

  it('returns an empty path for insufficient outline points', () => {
    expect(outlineToSvgPath([])).toBe('');
  });
});
