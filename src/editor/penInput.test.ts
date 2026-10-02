import { describe, expect, it } from 'vitest';
import { naturalPressure, smoothPressures, tiltPressure } from './penInput';

describe('pen pressure and tilt', () => {
  it('is thin but visible at light pressure, monotonic, and capped at 1', () => {
    expect(naturalPressure(0)).toBeGreaterThan(0.03);
    expect(naturalPressure(0.05)).toBeLessThan(0.25);
    expect(naturalPressure(1)).toBeCloseTo(1, 10);
    expect(naturalPressure(3)).toBe(1);
    let previous = -1;
    for (let raw = 0; raw <= 1; raw += 0.05) {
      const value = naturalPressure(raw);
      expect(value).toBeGreaterThan(previous);
      previous = value;
    }
  });

  it('falls back to a neutral value for a missing reading', () => {
    expect(naturalPressure(Number.NaN)).toBe(0.5);
  });

  it('smooths a pressure spike and keeps the length', () => {
    const smoothed = smoothPressures([0.2, 0.2, 1, 0.2, 0.2]);
    expect(smoothed).toHaveLength(5);
    expect(smoothed[2]).toBeLessThan(1);
    expect(smoothed[2]).toBeGreaterThan(smoothed[1]);
    expect(smoothPressures([0.4, 0.6])).toEqual([0.4, 0.6]);
  });

  it('widens the highlighter with tilt and stays nominal for an upright or tilt-less pen', () => {
    expect(tiltPressure(0, 0)).toBe(0.5);
    expect(tiltPressure(45, 0)).toBeCloseTo(0.75, 10);
    expect(tiltPressure(90, 90)).toBe(1);
    expect(tiltPressure(Number.NaN, 0)).toBe(0.5);
  });
});
