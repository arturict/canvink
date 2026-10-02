import { describe, expect, it } from 'vitest';
import { LocalPerformanceRecorder } from './metrics';
import { evaluatePenPreviewGate, recordPenPreviewOnNextFrame } from './penPreview';

describe('pen preview performance evidence', () => {
  it('records content-free pointer-to-frame samples and passes only with p95 below 20ms', () => {
    const recorder = new LocalPerformanceRecorder();
    let frame: (() => void) | undefined;
    for (let index = 0; index < 20; index += 1) {
      recordPenPreviewOnNextFrame(
        recorder,
        100,
        (callback) => { frame = callback; },
        () => 119.99,
        '2026-08-03T12:00:00.000Z',
      );
      frame?.();
    }
    const evaluated = evaluatePenPreviewGate(recorder);
    expect(evaluated).toMatchObject({
      gateMs: 20,
      passes: true,
      summary: { samples: 20 },
    });
    expect(evaluated.summary?.p95Ms).toBeCloseTo(19.99, 6);
    const evidence = recorder.exportEvidence('2026-08-03T12:01:00.000Z');
    expect(evidence).toEqual({
      version: 1,
      generatedAt: '2026-08-03T12:01:00.000Z',
      contentFree: true,
      gates: expect.objectContaining({ penPreviewP95Ms: 20 }),
      summaries: [expect.objectContaining({ metric: 'pen-preview' })],
      samples: expect.arrayContaining([
        expect.objectContaining({
          metric: 'pen-preview',
          recordedAt: '2026-08-03T12:00:00.000Z',
        }),
      ]),
    });
    expect(evidence.summaries[0].p95Ms).toBeCloseTo(19.99, 6);
    expect(evidence.samples[0].durationMs).toBeCloseTo(19.99, 6);
  });

  it('fails the strict gate at exactly 20ms and before twenty samples', () => {
    const recorder = new LocalPerformanceRecorder();
    for (let index = 0; index < 19; index += 1) recorder.record('pen-preview', 1);
    expect(evaluatePenPreviewGate(recorder).passes).toBe(false);
    recorder.record('pen-preview', 20);
    expect(evaluatePenPreviewGate(recorder)).toMatchObject({
      passes: true,
      summary: { p95Ms: 1, maximumMs: 20 },
    });

    const boundary = new LocalPerformanceRecorder();
    for (let index = 0; index < 20; index += 1) boundary.record('pen-preview', 20);
    expect(evaluatePenPreviewGate(boundary)).toMatchObject({
      passes: false,
      summary: { p95Ms: 20 },
    });
  });
});
