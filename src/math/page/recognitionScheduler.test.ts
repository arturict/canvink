import { DEFAULT_MATH_PAGE_SETTINGS, type MathElementV3 } from '../../domain/v3';
import {
  RecognitionError,
  normalizeExplicitMathSelection,
  type ExplicitMathRecognitionSelection,
  type RecognitionProvider,
  type RecognitionResult,
} from '../recognition';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MATH_RECOGNITION_PAUSE_MS,
  MathRecognitionScheduler,
  attestLocalMathGesture,
  type RecognitionUpdateReason,
} from './recognitionScheduler';
import { inkMathElement } from './testFixtures';

const OPERATION = 'operation_12345678';
const REQUEST = 'request_123456789';

describe('MathRecognitionScheduler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('waits exactly 900ms after an explicitly attested local Math gesture', async () => {
    const provider = successfulProvider('x+1');
    const scheduler = new MathRecognitionScheduler();
    const updates: Array<{ element: MathElementV3; reason: RecognitionUpdateReason }> = [];
    const element: MathElementV3 = {
      ...inkMathElement(),
      recognizedLatex: 'stale-recognition',
      correctedLatex: 'manual-correction',
    };
    const scheduled = scheduler.schedule({
      element,
      pageSettings: { ...DEFAULT_MATH_PAGE_SETTINGS },
      attestation: attest(element),
      provider,
      onUpdate: (next, reason) => updates.push({ element: next, reason }),
    });
    expect(scheduled.recognition.state).toBe('scheduled');
    expect(updates.map((update) => update.reason)).toEqual(['scheduled']);
    expect(scheduled.recognizedLatex).toBe('stale-recognition');
    expect(scheduled.correctedLatex).toBe('manual-correction');
    expect(scheduled.rawInk).toBe(element.rawInk);
    await vi.advanceTimersByTimeAsync(MATH_RECOGNITION_PAUSE_MS - 1);
    expect(provider.recognize).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(provider.recognize).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(updates.at(-1)?.reason).toBe('recognized'));
    expect(updates.map((update) => update.reason)).toEqual(['scheduled', 'pending', 'recognized']);
    expect(updates.at(-1)?.element.recognizedLatex).toBe('x+1');
    expect(updates.at(-1)?.element.result).toEqual({ state: 'none', diagnostics: [] });
    expect(updates.at(-1)?.element.dependencies).toEqual({
      defines: [], references: [], dependsOnElementIds: [], state: 'valid',
    });
    expect(updates.at(-1)?.element.correctedLatex).toBe('manual-correction');
    expect(updates.at(-1)?.element.rawInk).toBe(element.rawInk);
  });

  it('aborts the previous revision and discards its stale response', async () => {
    const calls: Array<{
      selection: ExplicitMathRecognitionSelection;
      resolve: (result: RecognitionResult) => void;
      signal?: AbortSignal;
    }> = [];
    const provider: RecognitionProvider = {
      kind: 'compatible',
      status: async () => ({ provider: 'compatible', configured: true, networkScope: 'private' }),
      recognize: vi.fn((selection, options) => new Promise<RecognitionResult>((resolve) => {
        calls.push({ selection, resolve, signal: options?.signal });
      })),
    };
    const scheduler = new MathRecognitionScheduler();
    const updates: Array<{ element: MathElementV3; reason: RecognitionUpdateReason }> = [];
    const element: MathElementV3 = {
      ...inkMathElement(),
      recognizedLatex: 'x+2',
      result: { state: 'valid', exactLatex: '3', diagnostics: [] },
      dependencies: { defines: ['y'], references: ['x'], dependsOnElementIds: ['source'], state: 'valid' },
    };
    const firstScheduled = scheduler.schedule({
      element,
      pageSettings: { ...DEFAULT_MATH_PAGE_SETTINGS },
      attestation: attest(element, REQUEST),
      provider,
      onUpdate: (next, reason) => updates.push({ element: next, reason }),
    });
    await vi.advanceTimersByTimeAsync(900);
    expect(calls).toHaveLength(1);

    scheduler.schedule({
      element: firstScheduled,
      pageSettings: { ...DEFAULT_MATH_PAGE_SETTINGS },
      attestation: attest(firstScheduled, 'request_987654321'),
      provider,
      onUpdate: (next, reason) => updates.push({ element: next, reason }),
    });
    expect(calls[0].signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(900);
    expect(calls).toHaveLength(2);

    calls[0].resolve(await responseFor(calls[0].selection, 'stale'));
    calls[1].resolve(await responseFor(calls[1].selection, 'fresh'));
    await vi.waitFor(() => expect(updates.at(-1)?.element.recognizedLatex).toBe('fresh'));
    expect(updates.some((update) => update.element.recognizedLatex === 'stale')).toBe(false);
    expect(updates.at(-1)?.element.recognizedLatex).toBe('fresh');
  });

  it('never schedules disabled blocks or inherited-disabled pages', async () => {
    const provider = successfulProvider('1');
    const scheduler = new MathRecognitionScheduler();
    const disabled = { ...inkMathElement('disabled'), autoRecognition: 'disabled' as const };
    expect(scheduler.schedule({
      element: disabled,
      pageSettings: { ...DEFAULT_MATH_PAGE_SETTINGS },
      attestation: attest(disabled),
      provider,
      onUpdate: vi.fn(),
    })).toBe(disabled);
    const inherited = inkMathElement('inherited');
    expect(scheduler.schedule({
      element: inherited,
      pageSettings: { ...DEFAULT_MATH_PAGE_SETTINGS, autoRecognition: false },
      attestation: attest(inherited, 'request_inherited1'),
      provider,
      onUpdate: vi.fn(),
    })).toBe(inherited);
    await vi.runAllTimersAsync();
    expect(provider.recognize).not.toHaveBeenCalled();
  });

  it('rejects forged/reused attestations and external observations never request recognition', async () => {
    const provider = successfulProvider('1');
    const scheduler = new MathRecognitionScheduler();
    const element: MathElementV3 = {
      ...inkMathElement(),
      recognizedLatex: 'x+2',
      result: { state: 'valid', exactLatex: '3', diagnostics: [] },
      dependencies: { defines: ['y'], references: ['x'], dependsOnElementIds: ['source'], state: 'valid' },
    };
    expect(() => scheduler.schedule({
      element,
      pageSettings: { ...DEFAULT_MATH_PAGE_SETTINGS },
      attestation: { kind: 'local-math-gesture-attestation', elementId: element.id },
      provider,
      onUpdate: vi.fn(),
    })).toThrow(/attestation/);

    const capability = attest(element);
    scheduler.schedule({
      element,
      pageSettings: { ...DEFAULT_MATH_PAGE_SETTINGS },
      attestation: capability,
      provider,
      onUpdate: vi.fn(),
    });
    expect(() => scheduler.schedule({
      element,
      pageSettings: { ...DEFAULT_MATH_PAGE_SETTINGS },
      attestation: capability,
      provider,
      onUpdate: vi.fn(),
    })).toThrow(/fresh/);
    scheduler.observeExternal(element.id, 'import');
    scheduler.observeExternal('restored', 'restore');
    scheduler.observeExternal('synced', 'sync');
    scheduler.observeExternal('reloaded', 'reload');
    scheduler.observeExternal('ordinary', 'ordinary-stroke');
    await vi.runAllTimersAsync();
    expect(provider.recognize).not.toHaveBeenCalled();
  });

  it('keeps offline/provider failures safely pending', async () => {
    const provider: RecognitionProvider = {
      kind: 'compatible',
      status: async () => ({ provider: 'compatible', configured: false, networkScope: 'private' }),
      recognize: vi.fn(async () => {
        throw new RecognitionError('network-error', 'offline', true);
      }),
    };
    const scheduler = new MathRecognitionScheduler();
    const updates: Array<{ element: MathElementV3; reason: RecognitionUpdateReason }> = [];
    const element: MathElementV3 = {
      ...inkMathElement(),
      recognizedLatex: 'x+2',
      result: { state: 'valid', exactLatex: '3', diagnostics: [] },
      dependencies: { defines: ['y'], references: ['x'], dependsOnElementIds: ['source'], state: 'valid' },
    };
    scheduler.schedule({
      element,
      pageSettings: { ...DEFAULT_MATH_PAGE_SETTINGS },
      attestation: attest(element),
      provider,
      onUpdate: (next, reason) => updates.push({ element: next, reason }),
    });
    await vi.advanceTimersByTimeAsync(900);
    await vi.waitFor(() => expect(updates.at(-1)?.reason).toBe('provider-error'));
    expect(updates.at(-1)?.reason).toBe('provider-error');
    expect(updates.at(-1)?.element.recognition).toEqual({
      state: 'pending',
      alternatives: [],
      warnings: ['provider-error:network-error'],
    });
    expect(updates.at(-1)?.element.recognizedLatex).toBe('x+2');
    expect(updates.at(-1)?.element.result).toEqual(element.result);
    expect(updates.at(-1)?.element.dependencies).toEqual(element.dependencies);
  });

  it('maps alternatives to ambiguous and empty output to unrecognized', async () => {
    for (const scenario of [
      { latex: 'x', candidates: [{ latex: 'y', confidence: 0.4 }], expected: 'ambiguous' as const },
      { latex: '', candidates: [], expected: 'unrecognized' as const },
    ]) {
      const provider = successfulProvider(scenario.latex, scenario.candidates);
      const scheduler = new MathRecognitionScheduler();
      const updates: Array<{ element: MathElementV3; reason: RecognitionUpdateReason }> = [];
      const element = inkMathElement(`math-${scenario.expected}`);
      scheduler.schedule({
        element,
        pageSettings: { ...DEFAULT_MATH_PAGE_SETTINGS },
        attestation: attest(element, `request_${scenario.expected}_1234`),
        provider,
        onUpdate: (next, reason) => updates.push({ element: next, reason }),
      });
      await vi.advanceTimersByTimeAsync(900);
      await vi.waitFor(() => expect(updates.at(-1)?.reason).toBe(scenario.expected));
      expect(updates.at(-1)?.reason).toBe(scenario.expected);
      expect(updates.at(-1)?.element.recognition.state).toBe(scenario.expected);
    }
  });

  it('rejects a response with the wrong revision without applying its LaTeX', async () => {
    const provider = successfulProvider('malicious', [], '0'.repeat(64));
    const scheduler = new MathRecognitionScheduler();
    const updates: Array<{ element: MathElementV3; reason: RecognitionUpdateReason }> = [];
    const element = inkMathElement();
    scheduler.schedule({
      element,
      pageSettings: { ...DEFAULT_MATH_PAGE_SETTINGS },
      attestation: attest(element),
      provider,
      onUpdate: (next, reason) => updates.push({ element: next, reason }),
    });
    await vi.advanceTimersByTimeAsync(900);
    await vi.waitFor(() => expect(updates.at(-1)?.reason).toBe('provider-error'));
    expect(updates.at(-1)?.reason).toBe('provider-error');
    expect(updates.at(-1)?.element.recognizedLatex).toBeUndefined();
    expect(updates.at(-1)?.element.recognition.state).toBe('pending');
  });
});

function attest(element: MathElementV3, requestId = REQUEST) {
  return attestLocalMathGesture({
    element,
    trigger: 'activeLocalMathBlock',
    operationId: OPERATION,
    requestId,
    provider: 'compatible',
    locale: 'de-CH',
    decimalSeparator: 'comma',
  });
}

function successfulProvider(
  latex: string,
  candidates: RecognitionResult['candidates'] = [],
  forcedRevision?: string,
): RecognitionProvider & { recognize: ReturnType<typeof vi.fn> } {
  return {
    kind: 'compatible',
    status: async () => ({ provider: 'compatible', configured: true, networkScope: 'private' }),
    recognize: vi.fn(async (selection: ExplicitMathRecognitionSelection) => {
      const response = await responseFor(selection, latex, candidates);
      return forcedRevision ? { ...response, revisionSha256: forcedRevision } : response;
    }),
  };
}

async function responseFor(
  selection: ExplicitMathRecognitionSelection,
  latex: string,
  candidates: RecognitionResult['candidates'] = [],
): Promise<RecognitionResult> {
  const normalized = await normalizeExplicitMathSelection(selection);
  return {
    protocolVersion: 1,
    requestId: selection.requestId,
    revisionSha256: normalized.revisionSha256,
    latex,
    candidates,
    provider: selection.provider,
    warnings: [],
  };
}
