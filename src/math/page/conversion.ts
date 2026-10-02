import { canonicalJson, type StrokeElementV2 } from '../../domain/v2';
import {
  MATH_SCHEMA_LIMITS,
  type MathElementV3,
  type MathRawInkV1,
  type PageDocV3,
  type PageElementV3,
} from '../../domain/v3';
import { MATH_RECOGNITION_LIMITS } from '../recognition';

export interface StrokeToMathConversionOperation {
  readonly kind: 'convert-strokes-to-math';
  readonly operationId: string;
  readonly selectedStrokeIds: readonly string[];
  readonly sourceStrokes: readonly StrokeElementV2[];
  readonly mathElement: MathElementV3;
  readonly zOrderBefore: readonly string[];
  readonly zOrderAfter: readonly string[];
}

export interface StrokeToMathConversionResult {
  readonly page: PageDocV3;
  readonly operation: StrokeToMathConversionOperation;
}

export function convertSelectedStrokesToMath(
  page: PageDocV3,
  options: {
    readonly selectedStrokeIds: readonly string[];
    readonly mathElementId: string;
    readonly operationId: string;
    readonly timestamp: string;
    readonly autoRecognition?: MathElementV3['autoRecognition'];
  },
): StrokeToMathConversionResult {
  const operation = prepareStrokeToMathConversion(page, options);
  return { page: applyStrokeToMathConversion(page, operation), operation };
}

export function prepareStrokeToMathConversion(
  page: PageDocV3,
  options: {
    readonly selectedStrokeIds: readonly string[];
    readonly mathElementId: string;
    readonly operationId: string;
    readonly timestamp: string;
    readonly autoRecognition?: MathElementV3['autoRecognition'];
  },
): StrokeToMathConversionOperation {
  if (!options.operationId || !options.mathElementId) throw new Error('Conversion IDs must not be empty.');
  if (Number.isNaN(Date.parse(options.timestamp))) throw new Error('Conversion timestamp is invalid.');
  if (page.elementsById[options.mathElementId]) throw new Error('The Math element ID already exists.');
  const selectedIds = [...options.selectedStrokeIds];
  if (selectedIds.length === 0 || selectedIds.length > MATH_RECOGNITION_LIMITS.maxStrokes) {
    throw new Error('Stroke selection exceeds its count limit.');
  }
  if (new Set(selectedIds).size !== selectedIds.length) throw new Error('Stroke selection contains duplicate IDs.');

  let totalPoints = 0;
  const selected = selectedIds.map((id) => {
    const candidate = page.elementsById[id];
    if (!candidate || candidate.kind !== 'stroke') throw new Error(`Selected element ${id} is not a stroke.`);
    if (candidate.locked) throw new Error(`Selected stroke ${id} is locked.`);
    if (candidate.points.length === 0 || candidate.points.length > MATH_RECOGNITION_LIMITS.maxPointsPerStroke) {
      throw new Error(`Selected stroke ${id} exceeds its point limit.`);
    }
    totalPoints += candidate.points.length;
    if (totalPoints > MATH_RECOGNITION_LIMITS.maxTotalPoints) {
      throw new Error('Selected strokes exceed the aggregate point limit.');
    }
    return candidate;
  });
  if (selected.length > MATH_SCHEMA_LIMITS.rawStrokes || totalPoints > MATH_SCHEMA_LIMITS.rawPointsTotal) {
    throw new Error('Selected ink exceeds the workspace raw-ink limit.');
  }

  const positions = selectedIds.map((id) => page.zOrder.indexOf(id));
  if (positions.some((position) => position < 0)) throw new Error('Every selected stroke must have a stable z-order position.');
  if (new Set(page.zOrder).size !== page.zOrder.length) throw new Error('Page z-order contains duplicate IDs.');
  const insertionIndex = Math.min(...positions);
  const selectedSet = new Set(selectedIds);
  const withoutSelected = page.zOrder.filter((id) => !selectedSet.has(id));
  const zOrderAfter = [...withoutSelected];
  zOrderAfter.splice(insertionIndex, 0, options.mathElementId);

  const sourceStrokes = immutableClone(selected) as unknown as readonly StrokeElementV2[];
  const captureFrame = captureFrameFor(selected);
  const rawInk = immutableClone({ captureFrame, sourceStrokes }) as unknown as MathRawInkV1;
  const mathElement = immutableClone({
    id: options.mathElementId,
    kind: 'math',
    frame: captureFrame,
    createdAt: options.timestamp,
    updatedAt: options.timestamp,
    locked: false,
    inputKind: 'converted-ink',
    autoRecognition: options.autoRecognition ?? 'inherit',
    rawInk,
    recognition: { state: 'idle', alternatives: [], warnings: [] },
    result: { state: 'none', diagnostics: [] },
    dependencies: {
      defines: [],
      references: [],
      dependsOnElementIds: [],
      state: 'valid',
    },
  } satisfies MathElementV3) as unknown as MathElementV3;

  return immutableClone({
    kind: 'convert-strokes-to-math',
    operationId: options.operationId,
    selectedStrokeIds: selectedIds,
    sourceStrokes,
    mathElement,
    zOrderBefore: [...page.zOrder],
    zOrderAfter,
  } satisfies StrokeToMathConversionOperation) as unknown as StrokeToMathConversionOperation;
}

export function applyStrokeToMathConversion(
  page: PageDocV3,
  operation: StrokeToMathConversionOperation,
): PageDocV3 {
  if (canonicalJson(page.zOrder) !== canonicalJson(operation.zOrderBefore)) {
    throw new Error('Conversion no longer matches the page z-order.');
  }
  if (page.elementsById[operation.mathElement.id]) throw new Error('Conversion target already exists.');
  for (const stroke of operation.sourceStrokes) {
    if (canonicalJson(page.elementsById[stroke.id]) !== canonicalJson(stroke)) {
      throw new Error(`Source stroke ${stroke.id} changed before conversion.`);
    }
  }
  const elements: Record<string, PageElementV3> = { ...page.elementsById };
  for (const id of operation.selectedStrokeIds) delete elements[id];
  elements[operation.mathElement.id] = immutableClone(operation.mathElement) as unknown as MathElementV3;
  return {
    ...page,
    elementsById: elements,
    zOrder: [...operation.zOrderAfter],
    updatedAt: operation.mathElement.updatedAt,
  };
}

export function restoreStrokesFromMathConversion(
  page: PageDocV3,
  operation: StrokeToMathConversionOperation,
  restoredAt: string,
): PageDocV3 {
  if (Number.isNaN(Date.parse(restoredAt))) throw new Error('Restore timestamp is invalid.');
  if (canonicalJson(page.zOrder) !== canonicalJson(operation.zOrderAfter)) {
    throw new Error('Restore no longer matches the converted page z-order.');
  }
  if (canonicalJson(page.elementsById[operation.mathElement.id]) !== canonicalJson(operation.mathElement)) {
    throw new Error('Converted Math element changed before restore.');
  }
  for (const stroke of operation.sourceStrokes) {
    if (page.elementsById[stroke.id]) throw new Error(`Cannot restore over existing element ${stroke.id}.`);
  }
  const elements: Record<string, PageElementV3> = { ...page.elementsById };
  delete elements[operation.mathElement.id];
  for (const stroke of operation.sourceStrokes) {
    elements[stroke.id] = immutableClone(stroke) as unknown as StrokeElementV2;
  }
  return {
    ...page,
    elementsById: elements,
    zOrder: [...operation.zOrderBefore],
    updatedAt: restoredAt,
  };
}

function captureFrameFor(strokes: readonly StrokeElementV2[]): StrokeElementV2['frame'] {
  const x = Math.min(...strokes.map((stroke) => stroke.frame.x));
  const y = Math.min(...strokes.map((stroke) => stroke.frame.y));
  const right = Math.max(...strokes.map((stroke) => stroke.frame.x + stroke.frame.width));
  const bottom = Math.max(...strokes.map((stroke) => stroke.frame.y + stroke.frame.height));
  return { x, y, width: right - x, height: bottom - y, rotation: 0 };
}

function immutableClone<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}
