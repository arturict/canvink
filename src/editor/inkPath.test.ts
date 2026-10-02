import { describe, expect, it } from 'vitest';
import {
  appendSegment,
  contactPressures,
  pathSpacing,
  penOutline,
  radiusForPressure,
  smoothCenterline,
  type OutlinePoint,
  type PathPoint,
} from './inkPath';

const at = (x: number, y: number, pressure = 0.5): PathPoint => ({ x, y, pressure });

function distanceToPolyline(point: { x: number; y: number }, line: readonly PathPoint[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (let index = 0; index + 1 < line.length; index += 1) {
    const a = line[index];
    const b = line[index + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared));
    best = Math.min(best, Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy)));
  }
  return best;
}

function bounds(outline: readonly OutlinePoint[]) {
  const xs = outline.map(([x]) => x);
  const ys = outline.map(([, y]) => y);
  return { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) };
}

/** A small loop written fast: the samples are `step` page units apart. */
function circle(radius: number, step: number): PathPoint[] {
  const count = Math.round((2 * Math.PI * radius) / step);
  return Array.from({ length: count + 1 }, (_, index) => {
    const angle = (index / count) * Math.PI * 2;
    return at(50 + Math.cos(angle) * radius, 50 + Math.sin(angle) * radius);
  });
}

describe('smoothCenterline', () => {
  it('goes through every sample, so a corner stays where the pen turned', () => {
    const zigzag = [at(0, 0), at(9, 40), at(18, 0), at(27, 40), at(36, 0)];
    const path = smoothCenterline(zigzag, 0.9);
    for (const sample of zigzag) expect(distanceToPolyline(sample, path)).toBeLessThan(0.01);
  });

  it('follows a curve between fast samples instead of cutting a chord', () => {
    const radius = 14;
    const path = smoothCenterline(circle(radius, 9), pathSpacing(3));
    // The two end segments have no neighbour on one side, so the loop is judged without them.
    const inner = path.slice(Math.ceil(9 / 0.9) + 1, path.length - Math.ceil(9 / 0.9) - 1);
    const worst = Math.max(...inner.map((point) => Math.abs(Math.hypot(point.x - 50, point.y - 50) - radius)));
    // A polyline through the same samples is 0.74 off the circle in the middle of each chord.
    expect(worst).toBeLessThan(0.15);
  });

  it('keeps the dense steps within the requested spacing', () => {
    const path = smoothCenterline([at(0, 0), at(60, 5), at(61, 40), at(10, 41)], 0.9);
    for (let index = 1; index < path.length; index += 1) {
      expect(Math.hypot(path[index].x - path[index - 1].x, path[index].y - path[index - 1].y)).toBeLessThan(1.5);
    }
  });

  it('does not overshoot after a long flick into a short sample', () => {
    const samples = [at(0, 0), at(80, 0), at(82, 10), at(83, 20)];
    const path = smoothCenterline(samples, 0.9);
    expect(Math.max(...path.map((point) => point.x))).toBeLessThan(83.5);
    expect(Math.min(...path.map((point) => point.y))).toBeGreaterThan(-0.5);
    // A turn of more than 80 degrees stays a corner.
    const corner = smoothCenterline([at(0, 0), at(40, 0), at(40, 40)], 0.9);
    expect(Math.max(...corner.map((point) => point.x))).toBeLessThanOrEqual(40 + 1e-9);
    expect(Math.min(...corner.map((point) => point.y))).toBeGreaterThanOrEqual(-1e-9);
  });

  it('ends exactly on the last sample and starts on the first', () => {
    const path = smoothCenterline([at(3, 4), at(30, 9), at(41, 40)], 0.9);
    expect(path[0]).toMatchObject({ x: 3, y: 4 });
    expect(path.at(-1)).toMatchObject({ x: 41, y: 40 });
  });

  it('merges repeated samples and calms sub-pixel jitter without moving real samples', () => {
    const jittery = [at(0, 0), at(0.4, 0.5), at(0.2, 0.9), at(0.7, 1.2), at(10, 20)];
    const path = smoothCenterline(jittery, 0.9);
    expect(path.at(-1)).toMatchObject({ x: 10, y: 20 });
    expect(smoothCenterline([at(5, 5), at(5, 5), at(5, 5)], 0.9)).toHaveLength(1);
    expect(smoothCenterline([], 0.9)).toEqual([]);
  });

  it('interpolates pressure along the path', () => {
    const path = smoothCenterline([at(0, 0, 0.2), at(30, 0, 0.8)], 0.9);
    const middle = path[Math.floor(path.length / 2)];
    expect(middle.pressure).toBeGreaterThan(0.45);
    expect(middle.pressure).toBeLessThan(0.55);
  });
});

describe('appendSegment', () => {
  it('can be built one segment at a time, which is how the live stroke grows', () => {
    const samples = [at(0, 0), at(9, 6), at(20, 4), at(31, 12), at(40, 30)];
    const whole = smoothCenterline(samples, 0.9);
    const grown: PathPoint[] = [{ ...samples[0] }];
    for (let index = 0; index + 1 < samples.length; index += 1) appendSegment(samples, index, 0.9, grown);
    expect(grown).toEqual(whole);
  });
});

describe('contactPressures', () => {
  it('replaces the zero pressure some digitizers report on the first samples', () => {
    expect(contactPressures([0, 0, 0.3, 0.6])).toEqual([0.3, 0.3, 0.3, 0.6]);
  });

  it('draws a pen that never reports pressure at half', () => {
    expect(contactPressures([0, 0, 0])).toEqual([0.5, 0.5, 0.5]);
    expect(contactPressures([Number.NaN])).toEqual([0.5]);
  });
});

describe('penOutline', () => {
  const shape = { size: 3, thinning: 0.62 };

  it('draws a tap as a dot of the line width', () => {
    for (const samples of [[at(20, 20)], [at(20, 20), at(20.3, 20.2)], [at(20, 20), at(20, 20), at(20, 20)]]) {
      const outline = penOutline(samples, shape);
      const box = bounds(outline);
      const radius = radiusForPressure(shape, 0.5);
      expect(outline.length).toBeGreaterThan(8);
      expect(box.right - box.left).toBeCloseTo(2 * radius, 0);
      expect(box.bottom - box.top).toBeCloseTo(2 * radius, 0);
    }
  });

  it('reaches the end of a short quick stroke on both sides', () => {
    const outline = penOutline([at(10, 10), at(14, 10.5), at(19, 11)], shape);
    const box = bounds(outline);
    expect(box.left).toBeLessThan(10);
    expect(box.right).toBeGreaterThan(19);
  });

  it('keeps the tip of a sharp turn instead of rounding it off', () => {
    // A letter stroke up and down with 9 unit samples, tip at (18, 0).
    const outline = penOutline([at(0, 40), at(9, 20), at(18, 0), at(27, 20), at(36, 40)], { size: 4, thinning: 0 });
    expect(bounds(outline).top).toBeLessThan(-1.2);
    expect(bounds(outline).top).toBeGreaterThan(-3.2);
  });

  it('is thicker where the pen pressed harder', () => {
    const light = penOutline([at(0, 0, 0.1), at(40, 0, 0.1), at(80, 0, 0.1)], shape);
    const firm = penOutline([at(0, 0, 0.9), at(40, 0, 0.9), at(80, 0, 0.9)], shape);
    const thickness = (outline: OutlinePoint[]) => bounds(outline).bottom - bounds(outline).top;
    expect(thickness(firm)).toBeGreaterThan(thickness(light) * 1.5);
  });

  it('draws a hundred fast samples without dropping the shape', () => {
    const wave = Array.from({ length: 100 }, (_, index) => at(index * 7, Math.sin(index / 3) * 15));
    const outline = penOutline(wave, shape);
    const box = bounds(outline);
    expect(box.right).toBeGreaterThan(99 * 7);
    expect(box.top).toBeLessThan(-14);
    expect(box.bottom).toBeGreaterThan(14);
  });
});
