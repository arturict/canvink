import { describe, expect, it } from 'vitest';
import type { StrokePointV2 } from '../domain/v2';
import {
  PACKED_STROKE_VERSION,
  POSITION_STEPS,
  PRESSURE_STEPS,
  packStrokePoints,
  unpackStrokePoints,
} from './packedStrokePoints';

function point(overrides: Partial<StrokePointV2> = {}): StrokePointV2 {
  return { x: 10, y: 20, pressure: 0.5, tiltX: 0, tiltY: 0, time: 0, pointerType: 'pen', ...overrides };
}

/** Deterministic pseudo-random numbers, so a failure reproduces. */
function generator(seed: number): () => number {
  let state = seed;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function pack(points: StrokePointV2[]): Uint8Array {
  const packed = packStrokePoints(points);
  if (!packed) throw new Error('Expected the samples to be representable.');
  return packed;
}

describe('packed stroke points', () => {
  it('returns samples on the documented grid and is stable when packed again', () => {
    const random = generator(0x5eed);
    const points = Array.from({ length: 300 }, (_, index) => point({
      x: 400 + random() * 300 - 150 * Math.sin(index),
      y: -50 + random() * 900,
      pressure: random(),
      tiltX: Math.round(random() * 180 - 90) + 0,
      tiltY: Math.round(random() * 180 - 90) + 0,
      time: 1_234_567.25 + index * 8.5,
    }));

    const restored = unpackStrokePoints(pack(points));

    expect(restored).toHaveLength(points.length);
    restored.forEach((sample, index) => {
      const original = points[index];
      expect(Math.abs(sample.x - original.x)).toBeLessThanOrEqual(0.5 / POSITION_STEPS + 1e-9);
      expect(Math.abs(sample.y - original.y)).toBeLessThanOrEqual(0.5 / POSITION_STEPS + 1e-9);
      expect(Math.abs(sample.pressure - original.pressure)).toBeLessThanOrEqual(0.5 / PRESSURE_STEPS + 1e-9);
      expect(sample.tiltX).toBe(original.tiltX);
      expect(sample.tiltY).toBe(original.tiltY);
      expect(Math.abs(sample.time - original.time)).toBeLessThanOrEqual(0.5);
      expect(sample.pointerType).toBe('pen');
    });
    // Packing what was unpacked changes nothing, so repeated writes cannot drift.
    expect(pack(restored)).toEqual(pack(points));
    expect(unpackStrokePoints(pack(restored))).toEqual(restored);
  });

  it('keeps the values mice, touch and imports report exactly', () => {
    const points = [
      point({ x: 0, y: 0, pressure: 0, pointerType: 'mouse' }),
      point({ x: 12.5, y: -3.25, pressure: 0.5, pointerType: 'mouse' }),
      point({ x: 100, y: 200.75, pressure: 1, pointerType: 'mouse' }),
    ];

    expect(unpackStrokePoints(pack(points))).toEqual(points);
  });

  it('stores constant pressure, absent tilt and absent time in a few bytes', () => {
    const points = Array.from({ length: 10 }, (_, index) => point({ x: 100 + index * 2, y: 200 + index }));

    const packed = pack(points);

    expect(packed[0]).toBe(PACKED_STROKE_VERSION);
    expect(packed.length).toBeLessThan(60);
    expect(unpackStrokePoints(packed)).toEqual(points);
  });

  it('round-trips an empty stroke and a single dot', () => {
    expect(unpackStrokePoints(pack([]))).toEqual([]);
    expect(unpackStrokePoints(pack([point({ x: -0.003, y: 1e5 })]))).toEqual([point({ x: 0, y: 1e5 })]);
  });

  it('handles negative coordinates, large timestamps and custom pointer types', () => {
    const points = [
      point({ x: -1234.5, y: -0.5, time: 9_000_000_000, pointerType: 'pen-eraser' }),
      point({ x: -1234, y: -0.75, time: 9_000_000_016, pointerType: 'pen-eraser', tiltX: -90, tiltY: 90 }),
    ];

    expect(unpackStrokePoints(pack(points))).toEqual(points);
  });

  it('declines samples it cannot hold within its precision', () => {
    expect(packStrokePoints([point({ pressure: 1.5 })])).toBeNull();
    expect(packStrokePoints([point({ pressure: -0.1 })])).toBeNull();
    expect(packStrokePoints([point({ x: Number.NaN })])).toBeNull();
    expect(packStrokePoints([point({ y: Number.POSITIVE_INFINITY })])).toBeNull();
    expect(packStrokePoints([point({ x: 1e12 })])).toBeNull();
    expect(packStrokePoints([point({ tiltX: 150 })])).toBeNull();
    expect(packStrokePoints([point({ time: Number.NaN })])).toBeNull();
    expect(packStrokePoints([point(), point({ pointerType: 'mouse' })])).toBeNull();
    expect(packStrokePoints([point({ pointerType: 'x'.repeat(65) })])).toBeNull();
  });

  it('rejects malformed bytes instead of returning invented samples', () => {
    const valid = pack([point(), point({ x: 30 })]);

    expect(() => unpackStrokePoints(new Uint8Array())).toThrow(RangeError);
    expect(() => unpackStrokePoints(valid.slice(0, valid.length - 1))).toThrow(/truncated/);
    expect(() => unpackStrokePoints(new Uint8Array([...valid, 0]))).toThrow(/trailing/);
    expect(() => unpackStrokePoints(Uint8Array.from(valid, (byte, index) => (index === 0 ? 2 : byte)))).toThrow(/version/);
    expect(() => unpackStrokePoints(Uint8Array.from(valid, (byte, index) => (index === 1 ? 0x80 : byte)))).toThrow(/flags/);
    expect(() => unpackStrokePoints(Uint8Array.from(valid, (byte, index) => (index === 2 ? 9 : byte)))).toThrow(/pointer type/);
    expect(() => unpackStrokePoints(new Uint8Array([1, 0, 0, ...Array(9).fill(0xff)]))).toThrow(/oversized/);
  });

  it('is several times smaller than the plain samples of a typical stroke', () => {
    const random = generator(7);
    const points = Array.from({ length: 10 }, (_, index) => point({
      x: 300 + index * 1.8 + random(),
      y: 500 + random() * 4,
      pressure: 0.3 + random() * 0.4,
    }));

    expect(pack(points).length).toBeLessThan(JSON.stringify(points).length / 8);
  });
});
