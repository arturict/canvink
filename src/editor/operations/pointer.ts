import type { StrokePointV2 } from '../../domain/v2/types';

export const MAX_COALESCED_SAMPLES = 4_096;
/** Touch stays ignored this long after the pen was last seen in range or on the glass. */
export const PEN_PROXIMITY_GRACE_MS = 500;
/** A touch contact wider or taller than this (CSS px) is a palm, not a fingertip. */
export const PALM_CONTACT_PX = 40;
const MAX_COORDINATE = 10_000_000;

export type PointerKind = 'pen' | 'touch' | 'mouse' | 'unknown';
export type PointerPhase = 'down' | 'move' | 'up' | 'cancel' | 'enter' | 'leave';

export interface PointerSampleLike {
  pointerId: number;
  pointerType: string;
  x: number;
  y: number;
  pressure: number;
  tiltX?: number;
  tiltY?: number;
  time: number;
  buttons?: number;
  /** Contact size in CSS pixels; touch only. */
  width?: number;
  height?: number;
}

export interface PalmRejectionState {
  activePenPointerIds: readonly number[];
  penProximityUntil: number;
}

export function createPalmRejectionState(): PalmRejectionState {
  return { activePenPointerIds: [], penProximityUntil: Number.NEGATIVE_INFINITY };
}

export function updatePalmRejection(
  state: PalmRejectionState,
  phase: PointerPhase,
  sample: PointerSampleLike,
): { state: PalmRejectionState; accepted: boolean } {
  if (!Number.isSafeInteger(sample.pointerId) || !Number.isFinite(sample.time)) {
    throw new Error('Palm rejection requires a valid pointer ID and timestamp');
  }
  const kind = normalizePointerKind(sample.pointerType);
  const activePens = new Set(state.activePenPointerIds);
  let proximityUntil = state.penProximityUntil;

  if (kind === 'pen') {
    proximityUntil = Math.max(proximityUntil, sample.time + PEN_PROXIMITY_GRACE_MS);
    if (phase === 'down') activePens.add(sample.pointerId);
    if (phase === 'up' || phase === 'cancel' || phase === 'leave') {
      activePens.delete(sample.pointerId);
    }
  }

  const nextState = {
    activePenPointerIds: [...activePens].sort((left, right) => left - right),
    penProximityUntil: proximityUntil,
  };
  if (kind === 'mouse' || kind === 'pen') return { state: nextState, accepted: true };
  if (kind === 'touch') {
    const palm = Math.max(sample.width ?? 0, sample.height ?? 0) > PALM_CONTACT_PX;
    return {
      state: nextState,
      accepted: !palm && activePens.size === 0 && sample.time > proximityUntil,
    };
  }
  return { state: nextState, accepted: true };
}

export function normalizePointerSamples(
  primary: PointerSampleLike,
  coalesced: readonly PointerSampleLike[] = [],
): StrokePointV2[] {
  if (coalesced.length + 1 > MAX_COALESCED_SAMPLES) {
    throw new Error(`Pointer sample batch exceeds ${MAX_COALESCED_SAMPLES} samples`);
  }
  const source = [...coalesced, primary];
  const points: StrokePointV2[] = [];
  let previousTime = Number.NEGATIVE_INFINITY;
  for (const sample of source) {
    assertFinite(sample.x, 'x', -MAX_COORDINATE, MAX_COORDINATE);
    assertFinite(sample.y, 'y', -MAX_COORDINATE, MAX_COORDINATE);
    assertFinite(sample.time, 'time', -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    const time = Math.max(previousTime, sample.time);
    const point: StrokePointV2 = {
      x: sample.x,
      y: sample.y,
      pressure: clampFinite(sample.pressure, 0, 1, 0.5),
      tiltX: clampFinite(sample.tiltX ?? 0, -90, 90, 0),
      tiltY: clampFinite(sample.tiltY ?? 0, -90, 90, 0),
      time,
      pointerType: normalizePointerKind(sample.pointerType),
    };
    const previous = points.at(-1);
    if (
      previous &&
      previous.x === point.x &&
      previous.y === point.y &&
      previous.time === point.time &&
      previous.pressure === point.pressure &&
      previous.tiltX === point.tiltX &&
      previous.tiltY === point.tiltY &&
      previous.pointerType === point.pointerType
    ) {
      continue;
    }
    points.push(point);
    previousTime = time;
  }
  return points;
}

function normalizePointerKind(pointerType: string): PointerKind {
  if (pointerType === 'pen' || pointerType === 'touch' || pointerType === 'mouse') {
    return pointerType;
  }
  return 'unknown';
}

function assertFinite(value: number, name: string, minimum: number, maximum: number): void {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`Pointer ${name} is outside the supported range`);
  }
}

function clampFinite(
  value: number,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, value));
}
