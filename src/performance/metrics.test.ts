import { describe, expect, it } from 'vitest';
import {
  LocalPerformanceRecorder,
  passesPerformanceGate,
  percentile,
} from './metrics';

describe('local performance evidence', () => {
  it('uses nearest-rank percentiles and keeps diagnostic samples content-free', () => {
    const recorder = new LocalPerformanceRecorder();
    for (let duration = 1; duration <= 100; duration += 1) {
      recorder.record('pen-preview', duration, '2026-08-03T12:00:00.000Z');
    }
    expect(recorder.summary('pen-preview')).toMatchObject({
      samples: 100,
      minimumMs: 1,
      medianMs: 50,
      p95Ms: 95,
      maximumMs: 100,
    });
    expect(Object.keys(recorder.samples('pen-preview')[0]).sort()).toEqual([
      'durationMs',
      'metric',
      'recordedAt',
    ]);
  });

  it('enforces the strict product gates only after a meaningful sample count', () => {
    const recorder = new LocalPerformanceRecorder();
    for (let index = 0; index < 19; index += 1) recorder.record('pen-preview', 10);
    expect(passesPerformanceGate(recorder.summary('pen-preview')!)).toBe(false);
    recorder.record('pen-preview', 19.9);
    expect(passesPerformanceGate(recorder.summary('pen-preview')!)).toBe(true);

    const navigation = new LocalPerformanceRecorder();
    for (let index = 0; index < 20; index += 1) navigation.record('cached-navigation', 299.9);
    expect(passesPerformanceGate(navigation.summary('cached-navigation')!)).toBe(true);
    const slowNavigation = new LocalPerformanceRecorder();
    for (let index = 0; index < 20; index += 1) slowNavigation.record('cached-navigation', 300);
    expect(passesPerformanceGate(slowNavigation.summary('cached-navigation')!)).toBe(false);
  });

  it('rejects invalid samples and unsorted percentile input', () => {
    const recorder = new LocalPerformanceRecorder();
    expect(() => recorder.record('storage-flush', Number.NaN)).toThrow(RangeError);
    recorder.record('cached-navigation', 95_000);
    expect(recorder.samples('cached-navigation').at(-1)?.durationMs).toBe(60_000);
    expect(() => recorder.record('storage-flush', 1, 'invalid')).toThrow(TypeError);
    expect(() => percentile([2, 1], 0.95)).toThrow(RangeError);
    expect(() => percentile([], 0.95)).toThrow(RangeError);
  });

  it('exports only measured passing pen samples for an exact 45-minute acceptance window', () => {
    const recorder = new LocalPerformanceRecorder();
    const startedAt = Date.parse('2026-08-03T12:00:00.000Z');
    for (let index = 0; index < 20; index += 1) {
      recorder.record('pen-preview', index + 0.25, new Date(startedAt + index * 1_000).toISOString());
    }
    recorder.record('pen-preview', 19.75, new Date(startedAt + 45 * 60_000).toISOString());

    const evidence = recorder.exportPenPerformanceAcceptanceEvidence({
      repositoryCommit: 'a'.repeat(40),
      packageVersion: '0.1.0',
    }, '2026-08-03T12:45:01.000Z');

    expect(evidence).toMatchObject({
      schemaVersion: 1,
      kind: 'pen-performance',
      contentFree: true,
      status: 'passed',
      producer: 'canvink-performance-recorder',
      results: {
        sampleCount: 21,
        p95Ms: 19.25,
        thresholdMs: 20,
        durationMinutes: 45,
        sessionStartedAt: '2026-08-03T12:00:00.000Z',
        sessionEndedAt: '2026-08-03T12:45:00.000Z',
        sessionObservedThrough: '2026-08-03T12:45:00.000Z',
      },
    });
    expect(evidence.results.samples).toHaveLength(21);
    expect(Object.keys(evidence.results.samples[0]).sort()).toEqual(['durationMs', 'recordedAt']);
  });

  it('fails closed before 45 minutes, below 20 samples, above the p95 gate, or without exact provenance', () => {
    const binding = { repositoryCommit: 'b'.repeat(40), packageVersion: '0.1.0' };
    const startedAt = Date.parse('2026-08-03T12:00:00.000Z');
    const recorder = new LocalPerformanceRecorder();
    for (let index = 0; index < 20; index += 1) {
      recorder.record('pen-preview', 10, new Date(startedAt + index * 1_000).toISOString());
    }
    expect(() => recorder.exportPenPerformanceAcceptanceEvidence(
      binding,
      '2026-08-03T12:45:00.000Z',
    )).toThrow(/45-minute/i);
    recorder.record('pen-preview', 10, '2026-08-03T12:45:00.000Z');
    expect(() => recorder.exportPenPerformanceAcceptanceEvidence(
      { ...binding, repositoryCommit: 'local' },
      '2026-08-03T12:45:00.000Z',
    )).toThrow(/40-hex/i);

    const slow = new LocalPerformanceRecorder();
    for (let index = 0; index < 20; index += 1) {
      slow.record('pen-preview', 20, new Date(startedAt + index * 1_000).toISOString());
    }
    slow.record('pen-preview', 20, '2026-08-03T12:45:00.000Z');
    expect(() => slow.exportPenPerformanceAcceptanceEvidence(
      binding,
      '2026-08-03T12:45:00.000Z',
    )).toThrow(/p95/i);
  });

  it('keeps a bounded time-distributed 45-minute sample across dense pointer input', () => {
    const recorder = new LocalPerformanceRecorder();
    const startedAt = Date.parse('2026-08-03T12:00:00.000Z');
    for (let offsetMs = 0; offsetMs <= 45 * 60_000; offsetMs += 100) {
      recorder.record('pen-preview', 5 + (offsetMs / 100) % 10, new Date(startedAt + offsetMs).toISOString());
    }
    const evidence = recorder.exportPenPerformanceAcceptanceEvidence({
      repositoryCommit: 'c'.repeat(40),
      packageVersion: '0.1.0',
    }, '2026-08-03T12:45:00.000Z');

    expect(recorder.samples('pen-preview')).toHaveLength(20_000);
    expect(evidence.results.samples).toHaveLength(2_701);
    expect(evidence.results.samples.slice(0, -1).every((sample) => sample.durationMs === 5)).toBe(true);
    expect(evidence.results.samples.at(-1)?.durationMs).toBe(5);
    expect(evidence.results.p95Ms).toBe(5);
  });
});
