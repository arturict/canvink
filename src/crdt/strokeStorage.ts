import type { StrokeElementV2, StrokePointV2 } from '../domain/v2';
import type { PageElementV3 } from '../domain/v3';
import { quantizeFrame } from '../ink/segmentCodec';
import { packStrokePoints, unpackStrokePoints } from './packedStrokePoints';

/**
 * How the samples of a stroke are held inside an Automerge page document.
 *
 * - `points`: a list with one map of seven fields per sample. Every field is
 *   its own Automerge operation, so a page with 7,000 handwriting strokes of
 *   ten samples carries about half a million operations.
 * - `packed`: one byte string (`packedPoints`, see `packStrokePoints`) per
 *   stroke, a single operation.
 *
 * Readers accept both forms in every build that contains this module; the
 * decoded element (a `points` list, the shape the editor, renderer, export
 * and search code know) is all they ever see. Only the writers choose.
 */
export type StrokeStorageFormat = 'points' | 'packed';

/**
 * The one switch. It decides what new writes produce: created strokes, whole
 * stroke rewrites (move, scale, erase) and freshly built documents such as an
 * import. Existing data is never rewritten just because the switch changed.
 *
 * Packed since 2026-09-30: the implementation uses the
 * faster format over compatibility with builds that only read `points`
 * (docs/stroke-storage.md).
 */
export const STROKE_WRITE_FORMAT: StrokeStorageFormat = 'packed';

/** A stroke element as it is stored: samples as a list or packed, never both. */
export type StoredStrokeElement = Omit<StrokeElementV2, 'points'> & (
  | { points: StrokePointV2[]; packedPoints?: undefined }
  | { points?: undefined; packedPoints: Uint8Array }
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPointList(value: unknown): value is StrokePointV2[] {
  return Array.isArray(value);
}

/** Whether a stored page element is a stroke whose samples are packed. */
export function hasPackedPoints(element: unknown): element is Record<string, unknown> & {
  kind: 'stroke';
  packedPoints: Uint8Array;
} {
  return isRecord(element)
    && element.kind === 'stroke'
    && element.packedPoints instanceof Uint8Array;
}

/**
 * The element in the form that is written to Automerge under `format`. A
 * stroke whose samples the packed form cannot hold within its documented
 * precision stays a plain list, so nothing is ever lost by packing.
 */
export function storedElement(
  element: PageElementV3,
  format: StrokeStorageFormat = STROKE_WRITE_FORMAT,
): PageElementV3 | StoredStrokeElement {
  if (format !== 'packed' || element.kind !== 'stroke') return element;
  const packedPoints = packStrokePoints(element.points);
  if (!packedPoints) return element;
  const { points: _points, ...rest } = element;
  void _points;
  // The box of the frame is held at the precision of an ink segment, so a
  // stroke reads the same wherever it is stored (document, segment, journal).
  return { ...rest, frame: quantizeFrame(rest.frame), packedPoints };
}

/**
 * The samples of one packed stroke. Throws an error naming the stroke when
 * the bytes are not a packed sample list this build understands.
 */
export function revealedPoints(bytes: Uint8Array, strokeId: unknown, freeze = false): StrokePointV2[] {
  try {
    const points = unpackStrokePoints(bytes);
    if (freeze) {
      for (const point of points) Object.freeze(point);
      Object.freeze(points);
    }
    return points;
  } catch (error) {
    throw new Error(`Stroke ${String(strokeId)} holds packed points this build cannot read.`, { cause: error });
  }
}

/**
 * The element as readers see it: a stroke with packed samples gets its
 * `points` list back. Anything else is returned as it is.
 */
export function revealedElement(element: Record<string, unknown>): Record<string, unknown> {
  if (!hasPackedPoints(element)) return element;
  const { packedPoints, ...rest } = element;
  return { ...rest, points: revealedPoints(packedPoints, rest.id) };
}

function isStrokeSampleList(value: unknown): value is StrokePointV2[] {
  return Array.isArray(value) && value.every((point) => isRecord(point)
    && typeof point.x === 'number' && typeof point.y === 'number'
    && typeof point.pressure === 'number' && typeof point.tiltX === 'number'
    && typeof point.tiltY === 'number' && typeof point.time === 'number'
    && typeof point.pointerType === 'string');
}

/**
 * The fields of an element (or of a partial element, as history patches
 * hold them) with stroke samples at the precision the stored form keeps.
 *
 * Local undo only reverts an element that still equals what the command
 * wrote, so a command must remember the samples the document will actually
 * hold, not the unrounded ones the pointer produced. Other fields, shape
 * points and samples the packed form declines pass through unchanged.
 */
export function withStoredPrecision<T extends object | null>(
  fields: T,
  format: StrokeStorageFormat = STROKE_WRITE_FORMAT,
): T {
  if (format !== 'packed' || fields === null || !('points' in fields) || !isStrokeSampleList(fields.points)) {
    return fields;
  }
  const packed = packStrokePoints(fields.points);
  if (!packed) return fields;
  const frame = (fields as { frame?: unknown }).frame;
  const quantizedFrame = typeof frame === 'object' && frame !== null && !Array.isArray(frame)
    ? { frame: quantizeFrame(frame as StrokeElementV2['frame']) }
    : {};
  return { ...fields, points: unpackStrokePoints(packed), ...quantizedFrame };
}

/**
 * Restores the `points` list of every packed stroke of a plain, mutable page
 * snapshot in place. Other documents are left alone.
 */
export function revealPageStrokes<T>(snapshot: T): T {
  if (!isRecord(snapshot) || snapshot.kind !== 'page' || !isRecord(snapshot.elementsById)) return snapshot;
  const elements = snapshot.elementsById;
  for (const id of Object.keys(elements)) {
    const element = elements[id];
    if (hasPackedPoints(element)) elements[id] = revealedElement(element);
  }
  return snapshot;
}

/**
 * Rewrites every stroke of a page draft to `format` inside an Automerge
 * change, and returns how many strokes were rewritten. This is the lazy
 * migration in both directions: forwards after the switch is turned on,
 * backwards to roll a page back to the list form. Strokes already in the
 * requested form, and strokes packing cannot represent, are not touched.
 *
 * Automerge keeps the operations of the replaced form in the document
 * history, so converting a legacy page in place does not make its file
 * smaller; only documents built fresh in the packed form are.
 */
export function convertPageStrokes(
  draft: { elementsById: Record<string, unknown> },
  format: StrokeStorageFormat,
): number {
  let converted = 0;
  for (const element of Object.values(draft.elementsById)) {
    if (!isRecord(element) || element.kind !== 'stroke') continue;
    if (format === 'packed' && isPointList(element.points)) {
      const packedPoints = packStrokePoints(element.points);
      if (!packedPoints) continue;
      element.packedPoints = packedPoints;
      delete element.points;
      converted += 1;
    } else if (format === 'points' && element.packedPoints instanceof Uint8Array) {
      element.points = unpackStrokePoints(element.packedPoints);
      delete element.packedPoints;
      converted += 1;
    }
  }
  return converted;
}
