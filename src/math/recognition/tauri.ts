import { encodeBase64Strict } from '../../crdt/tauriStorageBridge';
import { normalizeExplicitMathSelection } from './normalize';
import {
  MATH_RECOGNITION_LIMITS,
  MATH_RECOGNITION_PROTOCOL_VERSION,
  RecognitionError,
  type ExplicitMathRecognitionSelection,
  type RecognitionErrorCode,
  type RecognitionNetworkScope,
  type RecognitionProvider,
  type RecognitionProviderKind,
  type RecognitionProviderStatus,
  type RecognitionResult,
} from './types';

export type MathRecognitionInvoke = <T>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && typeof window.__TAURI_INTERNALS__ !== 'undefined';
}

async function defaultInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(command, args);
}

function opaqueNativeError(error: unknown): RecognitionError {
  const source = error && typeof error === 'object' && !Array.isArray(error)
    ? error as Record<string, unknown>
    : {};
  const allowed: ReadonlySet<RecognitionErrorCode> = new Set([
    'invalid-input', 'payload-too-large', 'provider-unavailable', 'secret-unavailable',
    'unsafe-endpoint', 'network-error', 'timeout', 'http-error', 'invalid-response', 'aborted',
  ]);
  const code = typeof source.code === 'string' && allowed.has(source.code as RecognitionErrorCode)
    ? source.code as RecognitionErrorCode
    : 'provider-unavailable';
  return new RecognitionError(code, 'Math recognition could not be completed.', source.retryable === true);
}

function assertStatus(value: unknown, provider: RecognitionProviderKind): RecognitionProviderStatus {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RecognitionError('invalid-response', 'Recognition provider status is invalid.');
  }
  const status = value as Partial<RecognitionProviderStatus>;
  if (
    status.provider !== provider || typeof status.configured !== 'boolean'
    || (status.networkScope !== 'public' && status.networkScope !== 'private')
    || (status.updatedAt !== undefined && typeof status.updatedAt !== 'string')
  ) throw new RecognitionError('invalid-response', 'Recognition provider status is invalid.');
  return { ...status } as RecognitionProviderStatus;
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function assertResult(value: unknown, provider: RecognitionProviderKind): RecognitionResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RecognitionError('invalid-response', 'Recognition response is invalid.');
  }
  const result = value as Partial<RecognitionResult>;
  if (
    result.protocolVersion !== MATH_RECOGNITION_PROTOCOL_VERSION
    || result.provider !== provider
    || typeof result.requestId !== 'string'
    || typeof result.revisionSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(result.revisionSha256)
    || typeof result.latex !== 'string' || utf8Length(result.latex) > MATH_RECOGNITION_LIMITS.maxLatexBytes
    || !Array.isArray(result.candidates) || result.candidates.length > MATH_RECOGNITION_LIMITS.maxCandidates
    || !result.candidates.every((candidate) => candidate && typeof candidate.latex === 'string'
      && utf8Length(candidate.latex) <= MATH_RECOGNITION_LIMITS.maxLatexBytes
      && (candidate.confidence === undefined || (Number.isFinite(candidate.confidence)
        && candidate.confidence >= 0 && candidate.confidence <= 1)))
    || !Array.isArray(result.warnings) || result.warnings.length > 32
    || !result.warnings.every((warning) => typeof warning === 'string' && utf8Length(warning) <= 128)
    || (result.modelVersion !== undefined
      && (typeof result.modelVersion !== 'string' || utf8Length(result.modelVersion) > 128))
    || (result.apiVersion !== undefined
      && (typeof result.apiVersion !== 'string' || utf8Length(result.apiVersion) > 128))
    || (result.processingDurationMs !== undefined
      && (!Number.isSafeInteger(result.processingDurationMs)
        || result.processingDurationMs < 0 || result.processingDurationMs > 120_000))
  ) throw new RecognitionError('invalid-response', 'Recognition response is invalid.');
  return structuredClone(result as RecognitionResult);
}

function consumeSecret(value: Uint8Array, label: string): string {
  if (!(value instanceof Uint8Array) || value.byteLength === 0 || value.byteLength > 8_192) {
    value?.fill(0);
    throw new RecognitionError('invalid-input', `${label} is invalid.`);
  }
  const copy = value.slice();
  value.fill(0);
  try {
    return encodeBase64Strict(copy);
  } finally {
    copy.fill(0);
  }
}

export class TauriMathProviderConfiguration {
  private readonly invoke: MathRecognitionInvoke;
  private readonly injected: boolean;

  constructor(invoke?: MathRecognitionInvoke) {
    this.invoke = invoke ?? defaultInvoke;
    this.injected = invoke !== undefined;
  }

  async configureCompatible(options: {
    endpoint: string;
    networkScope: RecognitionNetworkScope;
    allowInsecurePrivateHttp: boolean;
    bearerToken: Uint8Array;
  }): Promise<RecognitionProviderStatus> {
    this.assertDesktop();
    const bearerTokenBase64 = consumeSecret(options.bearerToken, 'Compatible provider token');
    try {
      return assertStatus(await this.invoke('math_provider_configure', {
        request: {
          kind: 'compatible', endpoint: options.endpoint, networkScope: options.networkScope,
          allowInsecurePrivateHttp: options.allowInsecurePrivateHttp, bearerTokenBase64,
        },
      }).catch((error: unknown) => { throw opaqueNativeError(error); }), 'compatible');
    } finally {
      // JavaScript strings cannot be zeroized. This encoded copy is deliberately
      // scoped to this call and is never stored by the bridge.
    }
  }

  async configureMathpix(options: {
    appId: Uint8Array;
    appKey: Uint8Array;
  }): Promise<RecognitionProviderStatus> {
    this.assertDesktop();
    const appIdBase64 = consumeSecret(options.appId, 'Mathpix app ID');
    const appKeyBase64 = consumeSecret(options.appKey, 'Mathpix app key');
    return assertStatus(await this.invoke('math_provider_configure', {
      request: { kind: 'mathpix', appIdBase64, appKeyBase64 },
    }).catch((error: unknown) => { throw opaqueNativeError(error); }), 'mathpix');
  }

  async status(provider: RecognitionProviderKind): Promise<RecognitionProviderStatus> {
    this.assertDesktop();
    return assertStatus(await this.invoke('math_provider_status', { provider })
      .catch((error: unknown) => { throw opaqueNativeError(error); }), provider);
  }

  async delete(provider: RecognitionProviderKind): Promise<void> {
    this.assertDesktop();
    await this.invoke('math_provider_delete', { provider })
      .catch((error: unknown) => { throw opaqueNativeError(error); });
  }

  private assertDesktop(): void {
    if (!this.injected && !isTauriRuntime()) {
      throw new RecognitionError(
        'provider-unavailable',
        'External recognition providers are available only in the desktop app.',
      );
    }
  }
}

export class TauriRecognitionProvider implements RecognitionProvider {
  constructor(
    readonly kind: RecognitionProviderKind,
    private readonly invoke: MathRecognitionInvoke = defaultInvoke,
    private readonly injected = false,
  ) {}

  static compatible(invoke?: MathRecognitionInvoke): TauriRecognitionProvider {
    return new TauriRecognitionProvider('compatible', invoke ?? defaultInvoke, invoke !== undefined);
  }

  static mathpix(invoke?: MathRecognitionInvoke): TauriRecognitionProvider {
    return new TauriRecognitionProvider('mathpix', invoke ?? defaultInvoke, invoke !== undefined);
  }

  async status(): Promise<RecognitionProviderStatus> {
    this.assertDesktop();
    return assertStatus(await this.invoke('math_provider_status', { provider: this.kind })
      .catch((error: unknown) => { throw opaqueNativeError(error); }), this.kind);
  }

  async recognize(
    selection: ExplicitMathRecognitionSelection,
    options: { signal?: AbortSignal } = {},
  ): Promise<RecognitionResult> {
    this.assertDesktop();
    if (selection.provider !== this.kind) {
      throw new RecognitionError('invalid-input', 'Selection and recognition provider do not match.');
    }
    if (options.signal?.aborted) throw new RecognitionError('aborted', 'Recognition was cancelled.');
    const request = await normalizeExplicitMathSelection(selection);
    if (options.signal?.aborted) throw new RecognitionError('aborted', 'Recognition was cancelled.');
    let cancelSent = false;
    const cancel = (): void => {
      if (cancelSent) return;
      cancelSent = true;
      void this.invoke('math_recognition_cancel', {
        request: { requestId: request.requestId, revisionSha256: request.revisionSha256 },
      }).catch(() => undefined);
    };
    options.signal?.addEventListener('abort', cancel, { once: true });
    let response: unknown;
    try {
      response = await this.invoke('math_recognize', { request });
    } catch (error) {
      if (options.signal?.aborted) {
        throw new RecognitionError('aborted', 'Recognition was cancelled.');
      }
      throw opaqueNativeError(error);
    } finally {
      options.signal?.removeEventListener('abort', cancel);
    }
    if (options.signal?.aborted) throw new RecognitionError('aborted', 'Recognition was cancelled.');
    const result = assertResult(response, this.kind);
    if (result.requestId !== request.requestId || result.revisionSha256 !== request.revisionSha256) {
      throw new RecognitionError('invalid-response', 'Recognition response does not match the active revision.');
    }
    return result;
  }

  private assertDesktop(): void {
    if (!this.injected && !isTauriRuntime()) {
      throw new RecognitionError(
        'provider-unavailable',
        'External recognition providers are available only in the desktop app.',
      );
    }
  }
}

/** The web build intentionally has no external recognition or persistent secret path. */
export class BrowserUnavailableRecognitionProvider implements RecognitionProvider {
  constructor(readonly kind: RecognitionProviderKind) {}

  async status(): Promise<RecognitionProviderStatus> {
    return { provider: this.kind, configured: false, networkScope: this.kind === 'mathpix' ? 'public' : 'private' };
  }

  async recognize(): Promise<RecognitionResult> {
    throw new RecognitionError(
      'provider-unavailable',
      'The web app supports typed local mathematics but not external handwriting recognition.',
    );
  }
}
