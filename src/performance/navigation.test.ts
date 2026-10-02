import { describe, expect, it } from 'vitest';
import { LocalPerformanceRecorder } from './metrics';
import {
  MIN_CACHED_NAVIGATION_SAMPLES,
  evaluateCachedNavigationGate,
  recordCachedNavigation,
} from './navigation';

describe('cached navigation performance gate', () => {
  it('records content-free completed navigation durations', () => {
    const recorder = new LocalPerformanceRecorder();
    recordCachedNavigation(recorder, 100, () => 112.5, '2026-08-03T12:00:00.000Z');
    expect(recorder.samples('cached-navigation')).toEqual([{
      metric: 'cached-navigation',
      durationMs: 12.5,
      recordedAt: '2026-08-03T12:00:00.000Z',
    }]);
  });

  it('requires twenty samples and a strict p95 below 300 ms', () => {
    const recorder = new LocalPerformanceRecorder();
    for (let index = 0; index < MIN_CACHED_NAVIGATION_SAMPLES - 2; index += 1) {
      recorder.record('cached-navigation', 10);
    }
    recorder.record('cached-navigation', 299.99);
    expect(evaluateCachedNavigationGate(recorder).passes).toBe(false);
    recorder.record('cached-navigation', 299.99);
    expect(evaluateCachedNavigationGate(recorder)).toMatchObject({
      gateMs: 300,
      requiredSamples: 20,
      passes: true,
      summary: { samples: 20, p95Ms: 299.99 },
    });

    recorder.clear();
    for (let index = 0; index < 20; index += 1) recorder.record('cached-navigation', 300);
    expect(evaluateCachedNavigationGate(recorder).passes).toBe(false);
  });

  it('rejects invalid start timestamps', () => {
    expect(() => recordCachedNavigation(new LocalPerformanceRecorder(), -1, () => 1))
      .toThrow(RangeError);
  });
});
