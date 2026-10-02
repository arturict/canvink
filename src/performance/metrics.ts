export const PERFORMANCE_GATES = Object.freeze({
  penPreviewP95Ms: 20,
  cachedNavigationP95Ms: 300,
  penSoakMinutes: 45,
  collaborationSoakMinutes: 60,
});

export type PerformanceMetric = 'pen-preview' | 'cached-navigation' | 'storage-flush';

export interface PerformanceSample {
  readonly metric: PerformanceMetric;
  readonly durationMs: number;
  readonly recordedAt: string;
}

export interface PerformanceSummary {
  readonly metric: PerformanceMetric;
  readonly samples: number;
  readonly minimumMs: number;
  readonly medianMs: number;
  readonly p95Ms: number;
  readonly maximumMs: number;
}

export interface PerformanceEvidence {
  readonly version: 1;
  readonly generatedAt: string;
  readonly contentFree: true;
  readonly gates: typeof PERFORMANCE_GATES;
  readonly summaries: PerformanceSummary[];
  readonly samples: PerformanceSample[];
}

export interface PerformanceEvidenceBinding {
  readonly repositoryCommit: string;
  readonly packageVersion: string;
}

export interface PenPerformanceEvidenceSample {
  readonly durationMs: number;
  readonly recordedAt: string;
}

export interface PenPerformanceAcceptanceEvidence {
  readonly schemaVersion: 1;
  readonly kind: 'pen-performance';
  readonly contentFree: true;
  readonly repositoryCommit: string;
  readonly packageVersion: string;
  readonly recordedAt: string;
  readonly status: 'passed';
  readonly producer: 'canvink-performance-recorder';
  readonly results: {
    readonly sampleCount: number;
    readonly p95Ms: number;
    readonly thresholdMs: 20;
    readonly durationMinutes: 45;
    readonly sessionStartedAt: string;
    readonly sessionEndedAt: string;
    readonly sessionObservedThrough: string;
    readonly samples: PenPerformanceEvidenceSample[];
  };
}

const EXACT_COMMIT = /^[0-9a-f]{40}$/;
const MAX_PACKAGE_VERSION_LENGTH = 128;
const PEN_SESSION_DURATION_MS = PERFORMANCE_GATES.penSoakMinutes * 60_000;

const MAX_SAMPLES_PER_METRIC = 20_000;
const MAX_SAMPLE_DURATION_MS = 60_000;
const PEN_ACCEPTANCE_BUCKET_MS = 1_000;

/**
 * Bounded, content-free performance evidence. No page, notebook, element, or
 * account identifier is accepted so diagnostic exports cannot leak notes.
 */
export class LocalPerformanceRecorder {
  readonly #samples = new Map<PerformanceMetric, PerformanceSample[]>();
  readonly #penAcceptanceSamples = new Map<number, PenPerformanceEvidenceSample>();
  #penSessionStartedAtMs: number | null = null;
  #penSessionObservedThroughMs: number | null = null;

  record(metric: PerformanceMetric, durationMs: number, recordedAt = new Date().toISOString()): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) {
      throw new RangeError('Performance duration must be a finite, non-negative number of milliseconds.');
    }
    // A real measurement over a minute (a flush behind a first cloud sync) is
    // kept at the one-minute ceiling instead of throwing: callers record right
    // after the work they timed, and diagnostics must never fail that work.
    durationMs = Math.min(durationMs, MAX_SAMPLE_DURATION_MS);
    if (!Number.isFinite(Date.parse(recordedAt))) {
      throw new TypeError('Performance sample requires an ISO timestamp.');
    }
    const current = this.#samples.get(metric) ?? [];
    current.push({ metric, durationMs, recordedAt });
    if (current.length > MAX_SAMPLES_PER_METRIC) {
      current.splice(0, current.length - MAX_SAMPLES_PER_METRIC);
    }
    this.#samples.set(metric, current);
    if (metric === 'pen-preview') this.#recordPenAcceptanceSample(durationMs, recordedAt);
  }

  samples(metric: PerformanceMetric): readonly PerformanceSample[] {
    return (this.#samples.get(metric) ?? []).map((sample) => ({ ...sample }));
  }

  summary(metric: PerformanceMetric): PerformanceSummary | null {
    const durations = (this.#samples.get(metric) ?? [])
      .map((sample) => sample.durationMs)
      .sort((left, right) => left - right);
    if (durations.length === 0) return null;
    return {
      metric,
      samples: durations.length,
      minimumMs: durations[0],
      medianMs: percentile(durations, 0.5),
      p95Ms: percentile(durations, 0.95),
      maximumMs: durations[durations.length - 1],
    };
  }

  clear(): void {
    this.#samples.clear();
    this.#penAcceptanceSamples.clear();
    this.#penSessionStartedAtMs = null;
    this.#penSessionObservedThroughMs = null;
  }

  exportEvidence(generatedAt = new Date().toISOString()): PerformanceEvidence {
    if (!Number.isFinite(Date.parse(generatedAt))) {
      throw new TypeError('Performance evidence requires an ISO timestamp.');
    }
    const metrics: PerformanceMetric[] = ['pen-preview', 'cached-navigation', 'storage-flush'];
    return {
      version: 1,
      generatedAt,
      contentFree: true,
      gates: PERFORMANCE_GATES,
      summaries: metrics.flatMap((metric) => {
        const summary = this.summary(metric);
        return summary ? [summary] : [];
      }),
      samples: metrics.flatMap((metric) => this.samples(metric)),
    };
  }

  exportPenPerformanceAcceptanceEvidence(
    binding: PerformanceEvidenceBinding,
    recordedAt = new Date().toISOString(),
  ): PenPerformanceAcceptanceEvidence {
    if (!EXACT_COMMIT.test(binding.repositoryCommit)) {
      throw new TypeError('Pen performance evidence requires an exact lowercase 40-hex repository commit.');
    }
    if (
      !binding.packageVersion
      || binding.packageVersion.length > MAX_PACKAGE_VERSION_LENGTH
      || [...binding.packageVersion].some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint < 32 || codePoint === 127;
      })
    ) {
      throw new TypeError('Pen performance evidence requires a bounded package version.');
    }
    const generatedMs = Date.parse(recordedAt);
    if (!Number.isFinite(generatedMs)) {
      throw new TypeError('Pen performance evidence requires an ISO timestamp.');
    }

    const sessionStartedMs = this.#penSessionStartedAtMs;
    const observedThroughMs = this.#penSessionObservedThroughMs;
    if (sessionStartedMs === null || observedThroughMs === null) {
      throw new Error('Pen performance evidence requires real pen-preview samples.');
    }
    const sessionEndedMs = sessionStartedMs + PEN_SESSION_DURATION_MS;
    if (observedThroughMs < sessionEndedMs || generatedMs < sessionEndedMs || observedThroughMs > generatedMs) {
      throw new Error('Pen performance evidence requires an observed 45-minute pen session.');
    }

    const sessionSamples = [...this.#penAcceptanceSamples.values()]
      .sort((left, right) => Date.parse(left.recordedAt) - Date.parse(right.recordedAt));
    const durations = sessionSamples.map((sample) => sample.durationMs).sort((left, right) => left - right);
    if (durations.length < 20) {
      throw new Error('Pen performance evidence requires at least 20 real pen-preview samples in the 45-minute session.');
    }
    const p95Ms = percentile(durations, 0.95);
    if (p95Ms >= PERFORMANCE_GATES.penPreviewP95Ms) {
      throw new Error('Pen performance evidence does not pass the strict p95 threshold.');
    }

    return {
      schemaVersion: 1,
      kind: 'pen-performance',
      contentFree: true,
      repositoryCommit: binding.repositoryCommit,
      packageVersion: binding.packageVersion,
      recordedAt,
      status: 'passed',
      producer: 'canvink-performance-recorder',
      results: {
        sampleCount: sessionSamples.length,
        p95Ms,
        thresholdMs: PERFORMANCE_GATES.penPreviewP95Ms,
        durationMinutes: PERFORMANCE_GATES.penSoakMinutes,
        sessionStartedAt: new Date(sessionStartedMs).toISOString(),
        sessionEndedAt: new Date(sessionEndedMs).toISOString(),
        sessionObservedThrough: new Date(observedThroughMs).toISOString(),
        samples: sessionSamples,
      },
    };
  }

  #recordPenAcceptanceSample(durationMs: number, recordedAt: string): void {
    const timestampMs = Date.parse(recordedAt);
    if (this.#penSessionStartedAtMs === null) this.#penSessionStartedAtMs = timestampMs;
    if (timestampMs < this.#penSessionStartedAtMs) return;
    this.#penSessionObservedThroughMs = Math.max(this.#penSessionObservedThroughMs ?? timestampMs, timestampMs);
    const offsetMs = timestampMs - this.#penSessionStartedAtMs;
    if (offsetMs > PEN_SESSION_DURATION_MS) return;
    const bucket = Math.floor(offsetMs / PEN_ACCEPTANCE_BUCKET_MS);
    if (!this.#penAcceptanceSamples.has(bucket)) {
      this.#penAcceptanceSamples.set(bucket, { durationMs, recordedAt });
    }
  }
}

export function performanceEvidenceBinding(): PerformanceEvidenceBinding {
  return {
    repositoryCommit: __CANVINK_COMMIT__,
    packageVersion: __CANVINK_VERSION__,
  };
}

export function percentile(sortedDurations: readonly number[], ratio: number): number {
  if (sortedDurations.length === 0) throw new RangeError('A percentile requires at least one sample.');
  if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) throw new RangeError('Percentile ratio must be between 0 and 1.');
  for (let index = 0; index < sortedDurations.length; index += 1) {
    const value = sortedDurations[index];
    if (!Number.isFinite(value) || value < 0) throw new RangeError('Percentile samples must be finite and non-negative.');
    if (index > 0 && value < sortedDurations[index - 1]) throw new RangeError('Percentile samples must be sorted.');
  }
  const rank = Math.max(0, Math.ceil(ratio * sortedDurations.length) - 1);
  return sortedDurations[rank];
}

export function passesPerformanceGate(summary: PerformanceSummary): boolean {
  if (summary.samples < 20) return false;
  if (summary.metric === 'pen-preview') return summary.p95Ms < PERFORMANCE_GATES.penPreviewP95Ms;
  if (summary.metric === 'cached-navigation') return summary.p95Ms < PERFORMANCE_GATES.cachedNavigationP95Ms;
  return true;
}
