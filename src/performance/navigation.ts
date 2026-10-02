import {
  PERFORMANCE_GATES,
  passesPerformanceGate,
  type LocalPerformanceRecorder,
  type PerformanceSummary,
} from './metrics';

export const MIN_CACHED_NAVIGATION_SAMPLES = 20;

export interface CachedNavigationGateEvidence {
  readonly gateMs: number;
  readonly requiredSamples: number;
  readonly summary: PerformanceSummary | null;
  readonly passes: boolean;
}

export function recordCachedNavigation(
  recorder: LocalPerformanceRecorder,
  startedAt: number,
  now: () => number,
  recordedAt?: string,
): void {
  if (!Number.isFinite(startedAt) || startedAt < 0) {
    throw new RangeError('Cached navigation start time must be finite and non-negative.');
  }
  recorder.record('cached-navigation', Math.max(0, now() - startedAt), recordedAt);
}

export function evaluateCachedNavigationGate(
  recorder: LocalPerformanceRecorder,
): CachedNavigationGateEvidence {
  const summary = recorder.summary('cached-navigation');
  return {
    gateMs: PERFORMANCE_GATES.cachedNavigationP95Ms,
    requiredSamples: MIN_CACHED_NAVIGATION_SAMPLES,
    summary,
    passes: summary ? passesPerformanceGate(summary) : false,
  };
}
