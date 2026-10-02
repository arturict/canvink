import {
  PERFORMANCE_GATES,
  passesPerformanceGate,
  type LocalPerformanceRecorder,
  type PerformanceSummary,
} from './metrics';

export type FrameScheduler = (callback: () => void) => void;

/**
 * Records pointer-to-next-frame latency only. The callback accepts no content,
 * identifiers, coordinates, or pointer data, keeping evidence content-free.
 */
export function recordPenPreviewOnNextFrame(
  recorder: LocalPerformanceRecorder,
  startedAt: number,
  schedule: FrameScheduler,
  now: () => number,
  recordedAt?: string,
): void {
  if (!Number.isFinite(startedAt) || startedAt < 0) {
    throw new RangeError('Pen preview start time must be finite and non-negative.');
  }
  schedule(() => recorder.record('pen-preview', Math.max(0, now() - startedAt), recordedAt));
}

export interface PenPreviewGateEvidence {
  readonly gateMs: number;
  readonly summary: PerformanceSummary | null;
  readonly passes: boolean;
}

export function evaluatePenPreviewGate(
  recorder: LocalPerformanceRecorder,
): PenPreviewGateEvidence {
  const summary = recorder.summary('pen-preview');
  return {
    gateMs: PERFORMANCE_GATES.penPreviewP95Ms,
    summary,
    passes: summary ? passesPerformanceGate(summary) : false,
  };
}
