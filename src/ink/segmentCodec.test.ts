import { describe, expect, it } from 'vitest';
import type { StrokeElementV2 } from '../domain/v2';
import { decodeInkSegment, encodeInkSegment, isSegmentStroke, quantizeStroke } from './segmentCodec';

function stroke(index: number, overrides: Partial<StrokeElementV2> = {}): StrokeElementV2 {
  const points = Array.from({ length: 10 }, (_, point) => ({
    x: 60.123456 + index * 3 + point * 1.37,
    y: 90.987654 + Math.sin(point + index) * 5,
    pressure: 0.3 + ((point * 37 + index) % 60) / 100,
    tiltX: point % 3,
    tiltY: -(point % 2),
    time: 1_700_000_000_000 + index * 1000 + point * 8,
    pointerType: 'pen',
  }));
  return {
    id: `stroke-3f2b8e1c-0a4d-4c7e-9b1a-${String(index).padStart(12, '0')}`,
    kind: 'stroke',
    frame: { x: 60.123456, y: 85.5, width: 12.345678, height: 10, rotation: 0 },
    createdAt: new Date(1_700_000_000_000 + index * 1000).toISOString(),
    updatedAt: new Date(1_700_000_000_000 + index * 1000).toISOString(),
    locked: false,
    tool: index % 7 === 0 ? 'highlighter' : 'pen',
    color: index % 5 === 0 ? '#e11d48' : '#1b1b8f',
    size: 1.5,
    opacity: index % 7 === 0 ? 0.35 : 1,
    points,
    ...overrides,
  };
}

describe('ink segment codec', () => {
  it('round trips strokes at the stored precision', () => {
    const strokes = Array.from({ length: 50 }, (_, index) => stroke(index));
    const decoded = decodeInkSegment(encodeInkSegment(strokes));
    expect(decoded).toEqual(strokes.map((item) => quantizeStroke(item)));
    expect(decoded.map((item) => item.id)).toEqual(strokes.map((item) => item.id));
  });

  it('quantising is idempotent, so a rewrite does not drift', () => {
    const once = quantizeStroke(stroke(3));
    expect(quantizeStroke(once)).toEqual(once);
    const again = decodeInkSegment(encodeInkSegment([once]))[0];
    expect(again).toEqual(once);
  });

  it('is deterministic and compact', () => {
    const strokes = Array.from({ length: 200 }, (_, index) => stroke(index));
    const first = encodeInkSegment(strokes);
    expect(Array.from(encodeInkSegment(strokes))).toEqual(Array.from(first));
    // One point list of ten samples is about 45 bytes; ids, times and frame add a few tens more.
    expect(first.length / strokes.length).toBeLessThan(160);
  });

  it('keeps ids that are not uuids, odd timestamps, optional fields and unknown fields', () => {
    const odd = stroke(1, {
      id: 'legacy-stroke-7',
      createdAt: '2026-09-25T08:00:00Z',
      updatedAt: '2026-09-26T09:30:00.123Z',
      tombstonedAt: '2026-09-27T00:00:00.000Z',
      sourceStrokeId: 'stroke-origin',
      locked: true,
    });
    (odd as unknown as Record<string, unknown>).futureField = { nested: [1, 'two', null] };
    const [decoded] = decodeInkSegment(encodeInkSegment([odd]));
    expect(decoded).toMatchObject({
      id: 'legacy-stroke-7',
      createdAt: '2026-09-25T08:00:00Z',
      updatedAt: '2026-09-26T09:30:00.123Z',
      tombstonedAt: '2026-09-27T00:00:00.000Z',
      sourceStrokeId: 'stroke-origin',
      locked: true,
      futureField: { nested: [1, 'two', null] },
    });
  });

  it('keeps frame values that do not fit the quantised form exactly', () => {
    const wide = stroke(2, { frame: { x: 2 ** 45 + 0.5, y: -0.1, width: 1e-9, height: 3, rotation: 0.7853981633974483 } });
    const [decoded] = decodeInkSegment(encodeInkSegment([wide]));
    expect(decoded.frame.rotation).toBe(0.7853981633974483);
    expect(decoded.frame.x).toBe(2 ** 45 + 0.5);
    expect(decoded.frame.y).toBe(-0.1015625);
  });

  it('returns frozen, shareable strokes', () => {
    const [decoded] = decodeInkSegment(encodeInkSegment([stroke(0)]));
    expect(Object.isFrozen(decoded)).toBe(true);
    expect(Object.isFrozen(decoded.points)).toBe(true);
    expect(Object.isFrozen(decoded.points[0])).toBe(true);
    expect(Object.isFrozen(decoded.frame)).toBe(true);
  });

  it('refuses samples it cannot hold and reports them to the caller', () => {
    const loud = stroke(0);
    loud.points = [{ ...loud.points[0], pressure: 4 }];
    expect(isSegmentStroke(loud)).toBe(false);
    expect(() => encodeInkSegment([loud])).toThrow(/cannot be held/);
  });

  it('rejects malformed bytes without returning partial strokes', () => {
    const bytes = encodeInkSegment(Array.from({ length: 5 }, (_, index) => stroke(index)));
    expect(() => decodeInkSegment(bytes.slice(0, bytes.length - 3))).toThrow(RangeError);
    expect(() => decodeInkSegment(new Uint8Array([1, 2, 3, 4]))).toThrow(RangeError);
    const trailing = new Uint8Array(bytes.length + 1);
    trailing.set(bytes);
    expect(() => decodeInkSegment(trailing)).toThrow(/trailing/);
  });

  it('holds an empty segment', () => {
    expect(decodeInkSegment(encodeInkSegment([]))).toEqual([]);
  });
});
