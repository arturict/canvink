import { canonicalJson } from '../../domain/v2';
import type { MathElementV3, MathPageSettingsV1 } from '../../domain/v3';
import {
  MATH_RECOGNITION_LIMITS,
  RecognitionError,
  normalizeExplicitMathSelection,
  type ExplicitMathRecognitionSelection,
  type RecognitionProvider,
  type RecognitionProviderKind,
  type RecognitionResult,
} from '../recognition';

export const MATH_RECOGNITION_PAUSE_MS = 900 as const;

export interface LocalMathRecognitionAttestation {
  readonly kind: 'local-math-gesture-attestation';
  readonly elementId: string;
}

interface AttestationDetails {
  readonly elementId: string;
  readonly rawInkCanonical: string;
  readonly trigger: ExplicitMathRecognitionSelection['trigger'];
  readonly operationId: string;
  readonly requestId: string;
  readonly provider: RecognitionProviderKind;
  readonly locale: string;
  readonly decimalSeparator: 'dot' | 'comma';
}

export type RecognitionUpdateReason =
  | 'scheduled'
  | 'pending'
  | 'recognized'
  | 'ambiguous'
  | 'unrecognized'
  | 'provider-error';

export interface ScheduleMathRecognitionOptions {
  readonly element: MathElementV3;
  readonly pageSettings: MathPageSettingsV1;
  readonly attestation: LocalMathRecognitionAttestation;
  readonly provider: RecognitionProvider;
  readonly onUpdate: (element: MathElementV3, reason: RecognitionUpdateReason) => void;
}

type ExternalObservationOrigin = 'ordinary-stroke' | 'import' | 'restore' | 'sync' | 'reload';

interface ActiveJob {
  readonly generation: number;
  readonly abort: AbortController;
  readonly timer: ReturnType<typeof setTimeout>;
  element: MathElementV3;
}

const attestations = new WeakMap<object, AttestationDetails>();
const consumedAttestations = new WeakSet<object>();
const SAFE_ID = /^[A-Za-z0-9_-]{16,128}$/;

export function attestLocalMathGesture(options: {
  readonly element: MathElementV3;
  readonly trigger: ExplicitMathRecognitionSelection['trigger'];
  readonly operationId: string;
  readonly requestId: string;
  readonly provider: RecognitionProviderKind;
  readonly locale: string;
  readonly decimalSeparator: 'dot' | 'comma';
}): LocalMathRecognitionAttestation {
  if (options.element.inputKind === 'typed' || !options.element.rawInk) {
    throw new Error('Only a locally active ink Math block can be attested for recognition.');
  }
  if (!SAFE_ID.test(options.operationId) || !SAFE_ID.test(options.requestId)) {
    throw new Error('Recognition attestation IDs are invalid.');
  }
  if (options.trigger !== 'activeLocalMathBlock' && options.trigger !== 'explicitUserSelection') {
    throw new Error('Recognition attestation requires an explicit local gesture.');
  }
  const attestation: LocalMathRecognitionAttestation = Object.freeze({
    kind: 'local-math-gesture-attestation',
    elementId: options.element.id,
  });
  attestations.set(attestation, {
    elementId: options.element.id,
    rawInkCanonical: canonicalJson(options.element.rawInk),
    trigger: options.trigger,
    operationId: options.operationId,
    requestId: options.requestId,
    provider: options.provider,
    locale: options.locale,
    decimalSeparator: options.decimalSeparator,
  });
  return attestation;
}

export class MathRecognitionScheduler {
  readonly #jobs = new Map<string, ActiveJob>();
  #generation = 0;

  schedule(options: ScheduleMathRecognitionOptions): MathElementV3 {
    const details = attestations.get(options.attestation);
    if (!details || consumedAttestations.has(options.attestation)) {
      throw new Error('Recognition requires a fresh local Math gesture attestation.');
    }
    consumedAttestations.add(options.attestation);
    if (
      details.elementId !== options.element.id
      || !options.element.rawInk
      || canonicalJson(options.element.rawInk) !== details.rawInkCanonical
    ) throw new Error('Recognition attestation does not match the current ink revision.');
    if (details.provider !== options.provider.kind) throw new Error('Attested provider does not match the scheduled provider.');

    this.cancel(options.element.id);
    if (!autoRecognitionEnabled(options.element, options.pageSettings)) return options.element;

    const generation = ++this.#generation;
    const abort = new AbortController();
    const scheduled = withRecognition(options.element, {
      state: 'scheduled',
      alternatives: [],
      warnings: [],
    });
    options.onUpdate(scheduled, 'scheduled');
    const timer = setTimeout(() => {
      void this.#run(generation, details, options, abort);
    }, MATH_RECOGNITION_PAUSE_MS);
    this.#jobs.set(options.element.id, { generation, abort, timer, element: scheduled });
    return scheduled;
  }

  cancel(elementId: string): void {
    const job = this.#jobs.get(elementId);
    if (!job) return;
    clearTimeout(job.timer);
    job.abort.abort();
    this.#jobs.delete(elementId);
  }

  observeExternal(elementId: string, origin: ExternalObservationOrigin): void {
    void origin;
    this.cancel(elementId);
  }

  dispose(): void {
    for (const elementId of [...this.#jobs.keys()]) this.cancel(elementId);
  }

  async #run(
    generation: number,
    details: AttestationDetails,
    options: ScheduleMathRecognitionOptions,
    abort: AbortController,
  ): Promise<void> {
    const active = this.#jobs.get(options.element.id);
    if (!active || active.generation !== generation || abort.signal.aborted) return;
    const pending = withRecognition(active.element, {
      state: 'pending',
      alternatives: [],
      warnings: [],
    });
    active.element = pending;
    options.onUpdate(pending, 'pending');

    try {
      const selection = selectionFrom(details, pending, options.pageSettings);
      // Both operations start only after the 900 ms timer. Starting the provider
      // call before awaiting hashing also makes the pause contract exact rather
      // than adding crypto scheduling latency to it.
      const normalizedPromise = normalizeExplicitMathSelection(selection);
      const responsePromise = options.provider.recognize(selection, { signal: abort.signal });
      const [normalized, response] = await Promise.all([normalizedPromise, responsePromise]);
      if (!this.#isCurrent(options.element.id, generation, abort)) return;
      if (response.requestId !== details.requestId || response.revisionSha256 !== normalized.revisionSha256) {
        this.#publishProviderError(options, generation, 'invalid-response');
        return;
      }
      this.#publishResult(options, generation, response);
    } catch (error) {
      if (!this.#isCurrent(options.element.id, generation, abort)) return;
      if (error instanceof RecognitionError && error.code === 'aborted') return;
      const code = error instanceof RecognitionError ? error.code : 'provider-unavailable';
      this.#publishProviderError(options, generation, code);
    }
  }

  #publishResult(
    options: ScheduleMathRecognitionOptions,
    generation: number,
    response: RecognitionResult,
  ): void {
    const active = this.#jobs.get(options.element.id);
    if (!active || active.generation !== generation) return;
    const alternatives = [...new Set(response.candidates.map((candidate) => candidate.latex)
      .filter((latex) => latex.length > 0 && latex !== response.latex))]
      .slice(0, MATH_RECOGNITION_LIMITS.maxCandidates);
    const state = response.latex.trim().length === 0
      ? 'unrecognized'
      : alternatives.length > 0
        ? 'ambiguous'
        : 'recognized';
    const next: MathElementV3 = {
      ...invalidateRecognitionDerived(active.element, {
        state,
        alternatives,
        warnings: [...new Set(response.warnings)],
        provider: {
          kind: response.provider === 'compatible' ? 'compatible-endpoint' : 'mathpix',
          ...(response.apiVersion === undefined ? {} : { apiVersion: response.apiVersion }),
          ...(response.modelVersion === undefined ? {} : { modelVersion: response.modelVersion }),
          ...(response.processingDurationMs === undefined ? {} : { durationMs: response.processingDurationMs }),
        },
      }),
      ...(response.latex.trim().length > 0 ? { recognizedLatex: response.latex } : {}),
    };
    this.#jobs.delete(options.element.id);
    options.onUpdate(next, state);
  }

  #publishProviderError(
    options: ScheduleMathRecognitionOptions,
    generation: number,
    code: string,
  ): void {
    const active = this.#jobs.get(options.element.id);
    if (!active || active.generation !== generation) return;
    const next = withRecognition(active.element, {
      state: 'pending',
      alternatives: [],
      warnings: [`provider-error:${code}`],
    });
    this.#jobs.delete(options.element.id);
    options.onUpdate(next, 'provider-error');
  }

  #isCurrent(elementId: string, generation: number, abort: AbortController): boolean {
    return !abort.signal.aborted && this.#jobs.get(elementId)?.generation === generation;
  }
}

function autoRecognitionEnabled(element: MathElementV3, settings: MathPageSettingsV1): boolean {
  return element.autoRecognition === 'enabled'
    || (element.autoRecognition === 'inherit' && settings.autoRecognition);
}

function selectionFrom(
  details: AttestationDetails,
  element: MathElementV3,
  settings: MathPageSettingsV1,
): ExplicitMathRecognitionSelection {
  if (!element.rawInk) throw new RecognitionError('invalid-input', 'Recognition ink is missing.');
  const points = element.rawInk.sourceStrokes.flatMap((stroke) => stroke.points);
  const minX = Math.min(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxX = Math.max(...points.map((point) => point.x));
  const maxY = Math.max(...points.map((point) => point.y));
  const width = maxX - minX;
  const height = maxY - minY;
  const bounds = {
    x: width === 0 ? minX - 0.5 : minX,
    y: height === 0 ? minY - 0.5 : minY,
    width: width === 0 ? 1 : width,
    height: height === 0 ? 1 : height,
  };
  return {
    kind: 'explicitMathSelection',
    trigger: details.trigger,
    userInitiated: true,
    operationId: details.operationId,
    requestId: details.requestId,
    provider: details.provider,
    bounds,
    strokes: element.rawInk.sourceStrokes.map((stroke) => ({
      points: stroke.points.map((point) => ({ x: point.x, y: point.y, pressure: point.pressure })),
    })),
    locale: details.locale,
    settings: {
      angleMode: settings.angleMode === 'degrees' ? 'degree' : 'radian',
      decimalSeparator: details.decimalSeparator,
    },
  };
}

function invalidateRecognitionDerived(
  element: MathElementV3,
  recognition: MathElementV3['recognition'],
): MathElementV3 {
  const withoutRecognition = { ...element };
  delete withoutRecognition.recognizedLatex;
  return {
    ...withoutRecognition,
    recognition,
    result: { state: 'none', diagnostics: [] },
    dependencies: { defines: [], references: [], dependsOnElementIds: [], state: 'valid' },
  };
}

function withRecognition(
  element: MathElementV3,
  recognition: MathElementV3['recognition'],
): MathElementV3 {
  return { ...element, recognition };
}
