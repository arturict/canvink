import { describe, expect, it } from 'vitest';
import { getStrokeOutline, inkOutline, outlineToSvgPath } from './ink';
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

describe('pressure-shaped ink outlines', () => {
  const line = (
    pointerType: string,
    pressureAt: (x: number) => number,
  ) => Array.from({ length: 41 }, (_, index) => ({
    x: index * 5, y: 0, pressure: pressureAt(index * 5), tiltX: 0, tiltY: 0, time: index * 8, pointerType,
  }));
  /** Thickness of an outline around x, measured across the (horizontal) stroke. */
  const thicknessNear = (outline: Array<[number, number]>, x: number) => {
    const ys = outline.filter(([px]) => Math.abs(px - x) < 6).map(([, py]) => py);
    return Math.max(...ys) - Math.min(...ys);
  };
  const lightThenFirm = (x: number) => (x < 100 ? 0.15 : 0.95);

  it('draws a pen stroke thicker where it was pressed harder', () => {
    const outline = inkOutline({ tool: 'pen', color: '#000', opacity: 1, size: 6, points: line('pen', lightThenFirm) });

    expect(thicknessNear(outline, 160)).toBeGreaterThan(thicknessNear(outline, 40) * 1.5);
  });

  it('ignores the constant pressure a mouse reports', () => {
    const light = inkOutline({ tool: 'pen', color: '#000', opacity: 1, size: 6, points: line('mouse', () => 0.1) });
    const firm = inkOutline({ tool: 'pen', color: '#000', opacity: 1, size: 6, points: line('mouse', () => 1) });

    expect(firm).toEqual(light);
    expect(thicknessNear(light, 100)).toBeGreaterThan(6 * 0.5);
  });

  it('keeps a highlighter band even whatever the pressure', () => {
    const outline = inkOutline({ tool: 'highlighter', color: '#ff0', opacity: 0.4, size: 14, points: line('pen', lightThenFirm) });

    expect(thicknessNear(outline, 160)).toBeCloseTo(thicknessNear(outline, 40), 0);
  });

  it('draws a single pen tap as a dot even when the digitizer reports zero pressure', () => {
    const tap = { x: 20, y: 20, pressure: 0, tiltX: 0, tiltY: 0, time: 1, pointerType: 'pen' };
    const outline = inkOutline({ tool: 'pen', color: '#000', opacity: 1, size: 6, points: [tap] });

    const xs = outline.map(([x]) => x);
    expect(outline.length).toBeGreaterThan(8);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(6 * 0.5);
  });

  it('keeps the tip of a sharp turn in a pen stroke, which streamlining used to cut off', () => {
    const turn = [[0, 40], [9, 20], [18, 0], [27, 20], [36, 40]].map(([x, y], index) => ({
      x, y, pressure: 0.5, tiltX: 0, tiltY: 0, time: index * 8, pointerType: 'pen',
    }));
    const outline = inkOutline({ tool: 'pen', color: '#000', opacity: 1, size: 4, points: turn });

    expect(Math.min(...outline.map(([, y]) => y))).toBeLessThan(-0.5);
  });
});
