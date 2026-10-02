import { describe, expect, it } from 'vitest';
import type { StrokePointV2 } from '../domain/v2';
import { smoothCenterline } from './inkPath';
import { LiveStrokePath, widthRuns } from './liveStrokePainter';
import { naturalPressure } from './penInput';

const shape = { size: 3, thinning: 0.62 };

function sample(x: number, y: number, pressure = 0.5): StrokePointV2 {
  return { x, y, pressure, tiltX: 0, tiltY: 0, time: 0, pointerType: 'pen' };
}

const handwriting = Array.from({ length: 60 }, (_, index) =>
  sample(index * 7 + Math.sin(index / 4) * 5, 40 + Math.cos(index / 3) * 18, 0.3 + (index % 7) / 20),
);

describe('LiveStrokePath', () => {
  it('grows to the same path the finished stroke is drawn along', () => {
    const live = new LiveStrokePath(shape);
    const taken = [];
    // The samples arrive a few at a time, as coalesced events do.
    for (let end = 3; end <= handwriting.length; end += 3) taken.push(...live.take(handwriting.slice(0, end)));
    taken.push(...live.take(handwriting));
    const finished = smoothCenterline(
      handwriting.map((point) => ({ x: point.x, y: point.y, pressure: naturalPressure(point.pressure) })),
      live.spacing,
    );
    // The settled part is a prefix of the finished path.
    expect(live.settled.length).toBeGreaterThan(finished.length * 0.9);
    live.settled.forEach((point, index) => {
      expect(point.x).toBeCloseTo(finished[index].x, 6);
      expect(point.y).toBeCloseTo(finished[index].y, 6);
    });
    expect(taken).toEqual(live.settled);
  });

  it('draws the provisional end through the newest sample and the prediction, without keeping the prediction', () => {
    const live = new LiveStrokePath(shape);
    live.take(handwriting.slice(0, 20));
    const settledBefore = live.settled.length;
    const last = handwriting[19];
    const predicted = [sample(last.x + 12, last.y + 3), sample(last.x + 26, last.y + 9)];
    const tail = live.tail(predicted);
    expect(tail.at(-1)).toMatchObject({ x: predicted[1].x, y: predicted[1].y });
    expect(tail.some((point) => Math.hypot(point.x - last.x, point.y - last.y) < 0.01)).toBe(true);
    expect(live.settled).toHaveLength(settledBefore);
    // Without a prediction the tail ends where the pen is.
    expect(live.tail([]).at(-1)).toMatchObject({ x: last.x, y: last.y });
  });

  it('shows the first sample at once, so a tap leaves a dot', () => {
    const live = new LiveStrokePath(shape);
    live.take([sample(10, 10)]);
    expect(live.settled).toHaveLength(1);
    expect(live.tail([])).toHaveLength(1);
  });

  it('uses the last real pressure where the pen reports none, and never a predicted one', () => {
    const live = new LiveStrokePath(shape);
    live.take([sample(0, 0, 0.8), sample(10, 0, 0), sample(20, 0, 0)]);
    live.tail([sample(30, 0, 0.1)]);
    live.take([sample(0, 0, 0.8), sample(10, 0, 0), sample(20, 0, 0), sample(30, 0, 0), sample(40, 0, 0)]);
    const pressures = live.settled.map((point) => point.pressure);
    expect(Math.min(...pressures)).toBeCloseTo(naturalPressure(0.8), 6);
  });

  it('skips repeated samples', () => {
    const live = new LiveStrokePath(shape);
    live.take([sample(5, 5), sample(5, 5), sample(5.01, 5)]);
    expect(live.sampleCount).toBe(1);
  });
});

describe('widthRuns', () => {
  it('cuts a path where the width changes and joins the runs without a gap', () => {
    const path = Array.from({ length: 30 }, (_, index) => ({ x: index, y: 0, pressure: index < 15 ? 0.2 : 0.9 }));
    const runs = widthRuns(path, shape);
    expect(runs).toHaveLength(2);
    expect(runs[1].diameter).toBeGreaterThan(runs[0].diameter);
    expect(runs[1].points[0]).toEqual(runs[0].points.at(-1));
  });

  it('keeps an even stroke in a single run', () => {
    const path = Array.from({ length: 200 }, (_, index) => ({ x: index, y: 0, pressure: 0.5 }));
    expect(widthRuns(path, shape)).toHaveLength(1);
  });
});
