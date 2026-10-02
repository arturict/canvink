import {
  MATH_RECOGNITION_LIMITS,
  MATH_RECOGNITION_PROTOCOL_VERSION,
  RecognitionError,
  type ExplicitMathRecognitionSelection,
  type NormalizedRecognitionPoint,
  type NormalizedRecognitionRequest,
} from './types';

const SAFE_ID = /^[A-Za-z0-9_-]{16,128}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const LOCALE = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8}){0,3}$/;
const encoder = new TextEncoder();

function invalid(message: string): never {
  throw new RecognitionError('invalid-input', message);
}

function finite(value: number, label: string): number {
  if (!Number.isFinite(value)) invalid(`${label} must be finite.`);
  return value;
}

function quantize(value: number): number {
  return Math.round(value * 100_000) / 100_000;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

async function sha256(value: string): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new RecognitionError('provider-unavailable', 'Local request hashing is unavailable.');
  }
  const digest = await globalThis.crypto.subtle.digest('SHA-256', encoder.encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function assertExplicitSelection(value: ExplicitMathRecognitionSelection): void {
  if (
    !value || value.kind !== 'explicitMathSelection' || value.userInitiated !== true
    || !['activeLocalMathBlock', 'explicitUserSelection'].includes(value.trigger)
  ) invalid('Recognition requires an explicit local Math selection.');
  if (!SAFE_ID.test(value.operationId) || !SAFE_ID.test(value.requestId)) {
    invalid('Recognition operation identifiers are invalid.');
  }
  if (value.provider !== 'compatible' && value.provider !== 'mathpix') {
    invalid('Recognition provider is invalid.');
  }
  if (!LOCALE.test(value.locale) || value.locale.length > 35) invalid('Recognition locale is invalid.');
  if (!['degree', 'radian'].includes(value.settings.angleMode)) invalid('Angle mode is invalid.');
  if (!['dot', 'comma'].includes(value.settings.decimalSeparator)) invalid('Decimal separator is invalid.');
}

export async function normalizeExplicitMathSelection(
  selection: ExplicitMathRecognitionSelection,
): Promise<NormalizedRecognitionRequest> {
  assertExplicitSelection(selection);
  const { x, y, width, height } = selection.bounds;
  finite(x, 'Selection x');
  finite(y, 'Selection y');
  finite(width, 'Selection width');
  finite(height, 'Selection height');
  if (
    width <= 0 || height <= 0
    || width > MATH_RECOGNITION_LIMITS.maxBound
    || height > MATH_RECOGNITION_LIMITS.maxBound
  ) invalid('Recognition bounds are outside the supported range.');
  if (selection.strokes.length === 0 || selection.strokes.length > MATH_RECOGNITION_LIMITS.maxStrokes) {
    invalid('Recognition stroke count is outside the supported range.');
  }

  let totalPoints = 0;
  const strokes = selection.strokes.map((stroke, strokeIndex) => {
    if (!stroke || !Array.isArray(stroke.points) || stroke.points.length === 0) {
      invalid(`Recognition stroke ${strokeIndex + 1} is empty.`);
    }
    if (stroke.points.length > MATH_RECOGNITION_LIMITS.maxPointsPerStroke) {
      throw new RecognitionError('payload-too-large', 'A recognition stroke has too many points.');
    }
    totalPoints += stroke.points.length;
    if (totalPoints > MATH_RECOGNITION_LIMITS.maxTotalPoints) {
      throw new RecognitionError('payload-too-large', 'Recognition contains too many points.');
    }
    const points = stroke.points.map((point, pointIndex): NormalizedRecognitionPoint => {
      const pointX = finite(point.x, `Stroke ${strokeIndex + 1} point ${pointIndex + 1} x`);
      const pointY = finite(point.y, `Stroke ${strokeIndex + 1} point ${pointIndex + 1} y`);
      const normalizedX = (pointX - x) / width;
      const normalizedY = (pointY - y) / height;
      if (normalizedX < 0 || normalizedX > 1 || normalizedY < 0 || normalizedY > 1) {
        invalid('A recognition point falls outside the explicit selection bounds.');
      }
      const pressure = point.pressure;
      if (pressure !== undefined && (!Number.isFinite(pressure) || pressure < 0 || pressure > 1)) {
        invalid('Recognition pressure is outside the supported range.');
      }
      return {
        x: quantize(normalizedX),
        y: quantize(normalizedY),
        ...(pressure === undefined ? {} : { pressure: quantize(pressure) }),
      };
    });
    return { points };
  });

  const revisionInput = {
    strokes,
    boundingBox: { width: quantize(width), height: quantize(height) },
    locale: selection.locale,
    settings: selection.settings,
  };
  const revisionSha256 = await sha256(canonicalJson(revisionInput));
  if (!SHA256.test(revisionSha256)) invalid('Recognition revision hash is invalid.');
  const request: NormalizedRecognitionRequest = {
    protocolVersion: MATH_RECOGNITION_PROTOCOL_VERSION,
    selectionKind: 'explicitMathSelection',
    trigger: selection.trigger,
    userInitiated: true,
    provider: selection.provider,
    operationId: selection.operationId,
    requestId: selection.requestId,
    revisionSha256,
    strokes,
    boundingBox: revisionInput.boundingBox,
    locale: selection.locale,
    settings: { ...selection.settings },
  };
  if (encoder.encode(canonicalJson(request)).byteLength > MATH_RECOGNITION_LIMITS.maxRequestBytes) {
    throw new RecognitionError('payload-too-large', 'Recognition request exceeds the byte limit.');
  }
  return request;
}
