export const MATH_RECOGNITION_PROTOCOL_VERSION = 1 as const;
export const MATH_RECOGNITION_LIMITS = Object.freeze({
  maxRequestBytes: 512 * 1024,
  maxResponseBytes: 256 * 1024,
  maxStrokes: 256,
  maxPointsPerStroke: 4_096,
  maxTotalPoints: 16_384,
  maxBound: 8_192,
  maxLatexBytes: 64 * 1024,
  maxCandidates: 5,
});

export type RecognitionProviderKind = 'compatible' | 'mathpix';
export type RecognitionNetworkScope = 'public' | 'private';

export interface MathSelectionPoint {
  x: number;
  y: number;
  pressure?: number;
}

export interface MathSelectionStroke {
  points: readonly MathSelectionPoint[];
}

/**
 * This value may only be created from an active local Math block or an
 * explicit user selection. Restored, imported, or remotely received blocks do
 * not satisfy this contract merely by existing in a page document.
 */
export interface ExplicitMathRecognitionSelection {
  kind: 'explicitMathSelection';
  trigger: 'activeLocalMathBlock' | 'explicitUserSelection';
  userInitiated: true;
  operationId: string;
  requestId: string;
  provider: RecognitionProviderKind;
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  strokes: readonly MathSelectionStroke[];
  locale: string;
  settings: {
    angleMode: 'degree' | 'radian';
    decimalSeparator: 'dot' | 'comma';
  };
}

export interface NormalizedRecognitionPoint {
  x: number;
  y: number;
  pressure?: number;
}

export interface NormalizedRecognitionRequest {
  protocolVersion: typeof MATH_RECOGNITION_PROTOCOL_VERSION;
  selectionKind: 'explicitMathSelection';
  trigger: ExplicitMathRecognitionSelection['trigger'];
  userInitiated: true;
  provider: RecognitionProviderKind;
  operationId: string;
  requestId: string;
  revisionSha256: string;
  strokes: Array<{ points: NormalizedRecognitionPoint[] }>;
  boundingBox: {
    width: number;
    height: number;
  };
  locale: string;
  settings: {
    angleMode: 'degree' | 'radian';
    decimalSeparator: 'dot' | 'comma';
  };
}

export interface RecognitionCandidate {
  latex: string;
  confidence?: number;
}

export interface RecognitionResult {
  protocolVersion: typeof MATH_RECOGNITION_PROTOCOL_VERSION;
  requestId: string;
  revisionSha256: string;
  latex: string;
  candidates: RecognitionCandidate[];
  provider: RecognitionProviderKind;
  modelVersion?: string;
  apiVersion?: string;
  processingDurationMs?: number;
  warnings: string[];
}

export interface RecognitionProviderStatus {
  provider: RecognitionProviderKind;
  configured: boolean;
  networkScope: RecognitionNetworkScope;
  updatedAt?: string;
}

export interface RecognitionProvider {
  readonly kind: RecognitionProviderKind;
  status(): Promise<RecognitionProviderStatus>;
  recognize(
    selection: ExplicitMathRecognitionSelection,
    options?: { signal?: AbortSignal },
  ): Promise<RecognitionResult>;
}

export type RecognitionErrorCode =
  | 'aborted'
  | 'invalid-input'
  | 'payload-too-large'
  | 'provider-unavailable'
  | 'secret-unavailable'
  | 'unsafe-endpoint'
  | 'network-error'
  | 'timeout'
  | 'http-error'
  | 'invalid-response';

export class RecognitionError extends Error {
  constructor(
    public readonly code: RecognitionErrorCode,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = 'RecognitionError';
  }
}
