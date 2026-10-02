import { describe, expect, it } from 'vitest';
import {
  backgroundGridSpacing,
  clampZoom,
  shapeGeometryFromDrag,
  snapPointToGrid,
  snapVectorToAngle,
} from './shapes';

describe('school editor geometry', () => {
  it('maps paper templates to useful snap spacing', () => {
    expect(backgroundGridSpacing('blank')).toBeNull();
    expect(backgroundGridSpacing('lined')).toBe(32);
    expect(backgroundGridSpacing('grid')).toBe(40);
    expect(backgroundGridSpacing('millimeter')).toBe(10);
  });

  it('snaps points to the nearest grid intersection', () => {
    expect(snapPointToGrid({ x: 37, y: 64 }, 10)).toEqual({ x: 40, y: 60 });
    expect(snapPointToGrid({ x: 37, y: 64 }, null)).toEqual({ x: 37, y: 64 });
  });

  it('snaps line angles without changing their length', () => {
    const start = { x: 10, y: 10 };
    const end = { x: 108, y: 19 };
    const snapped = snapVectorToAngle(start, end);

    expect(Math.hypot(snapped.x - start.x, snapped.y - start.y)).toBeCloseTo(
      Math.hypot(end.x - start.x, end.y - start.y),
    );
    expect(snapped.y).toBeCloseTo(start.y);
  });

  it('preserves line direction but normalizes closed-shape bounds', () => {
    const options = { angleSnap: false, gridSpacing: 10 };
    expect(shapeGeometryFromDrag({ x: 63, y: 52 }, { x: 18, y: 14 }, 'arrow', options)).toEqual({
      x: 60,
      y: 50,
      width: -40,
      height: -40,
    });
    expect(shapeGeometryFromDrag({ x: 63, y: 52 }, { x: 18, y: 14 }, 'rectangle', options)).toEqual({
      x: 20,
      y: 10,
      width: 40,
      height: 40,
    });
  });

  it('clamps zoom to the supported range', () => {
    expect(clampZoom(0.1)).toBe(0.25);
    expect(clampZoom(1.237)).toBe(1.24);
    expect(clampZoom(4)).toBe(2.5);
  });
});
