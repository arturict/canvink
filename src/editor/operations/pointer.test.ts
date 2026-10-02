import { describe, expect, it } from 'vitest';
import {
  createPalmRejectionState,
  MAX_COALESCED_SAMPLES,
  normalizePointerSamples,
  updatePalmRejection,
  type PointerSampleLike,
} from './pointer';

const sample = (overrides: Partial<PointerSampleLike> = {}): PointerSampleLike => ({
  pointerId: 1,
  pointerType: 'pen',
  x: 10,
  y: 20,
  pressure: 0.5,
  time: 100,
  ...overrides,
});

describe('pointer normalization and palm rejection', () => {
  it('suppresses touch during pen proximity while always preserving mouse input', () => {
    const pen = updatePalmRejection(createPalmRejectionState(), 'enter', sample());
    const touch = updatePalmRejection(
      pen.state,
      'down',
      sample({ pointerId: 2, pointerType: 'touch', time: 200 }),
    );
    const mouse = updatePalmRejection(
      touch.state,
      'down',
      sample({ pointerId: 3, pointerType: 'mouse', time: 201 }),
    );
    const laterTouch = updatePalmRejection(
      mouse.state,
      'down',
      sample({ pointerId: 4, pointerType: 'touch', time: 601 }),
    );

    expect(touch.accepted).toBe(false);
    expect(mouse.accepted).toBe(true);
    expect(laterTouch.accepted).toBe(true);
  });

  it('rejects a touch contact larger than a fingertip even without a pen', () => {
    const fresh = createPalmRejectionState();
    const palm = updatePalmRejection(fresh, 'down', sample({ pointerType: 'touch', width: 90, height: 120 }));
    const finger = updatePalmRejection(fresh, 'down', sample({ pointerType: 'touch', width: 22, height: 24 }));
    expect(palm.accepted).toBe(false);
    expect(finger.accepted).toBe(true);
  });

  it('keeps ignoring touch while the pen hovers, since every hover move renews the window', () => {
    let state = createPalmRejectionState();
    for (let time = 0; time <= 5_000; time += 16) {
      state = updatePalmRejection(state, 'move', sample({ time })).state;
    }
    const touch = updatePalmRejection(state, 'down', sample({ pointerType: 'touch', pointerId: 2, time: 5_300 }));
    expect(touch.accepted).toBe(false);
  });

  it('keeps active pen contact suppressing touch after the proximity window', () => {
    const pen = updatePalmRejection(createPalmRejectionState(), 'down', sample());
    const touch = updatePalmRejection(
      pen.state,
      'down',
      sample({ pointerType: 'touch', pointerId: 2, time: 10_000 }),
    );
    expect(touch.accepted).toBe(false);
  });

  it('normalizes clamped, monotonic, deduplicated coalesced samples', () => {
    const points = normalizePointerSamples(
      sample({ x: 11, pressure: Number.NaN, pointerType: 'other', time: 1 }),
      [
      sample({ pressure: 2, tiltX: 120, time: 3 }),
      sample({ pressure: 2, tiltX: 120, time: 2 }),
      sample({ x: 11, pressure: Number.NaN, pointerType: 'other', time: 1 }),
      ],
    );
    expect(points).toHaveLength(2);
    expect(points[0]).toMatchObject({ pressure: 1, tiltX: 90, time: 3 });
    expect(points[1]).toMatchObject({ pressure: 0.5, pointerType: 'unknown', time: 3 });
  });

  it('rejects non-finite coordinates and huge coalesced batches', () => {
    expect(() => normalizePointerSamples(sample({ x: Number.NaN }))).toThrow(/x/);
    expect(() =>
      updatePalmRejection(createPalmRejectionState(), 'down', sample({ time: Number.NaN })),
    ).toThrow(/timestamp/);
    expect(() =>
      normalizePointerSamples(sample(), Array.from({ length: MAX_COALESCED_SAMPLES + 1 }, () => sample())),
    ).toThrow(/exceeds/);
  });
});
