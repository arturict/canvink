import type { StrokeElementV2, StrokePointV2 } from '../v2/types';
import { MAX_TEXT_CHARS } from '../limits';
import type {
  GraphElementV3,
  GraphSeriesV1,
  GraphViewportV1,
  MathDependenciesV1,
  MathElementV3,
  MathPageSettingsV1,
  MathRawInkV1,
  MathRecognitionProviderV1,
  MathRecognitionV1,
  MathResultV1,
  PageContentV1,
} from './types';

export const MATH_SCHEMA_LIMITS = Object.freeze({
  idBytes: 256,
  latexBytes: 32 * 1024,
  resultTextBytes: 32 * 1024,
  diagnosticBytes: 512,
  diagnostics: 64,
  alternatives: 8,
  warnings: 32,
  symbols: 256,
  symbolBytes: 256,
  rawStrokes: 256,
  rawPointsPerStroke: 50_000,
  rawPointsTotal: 200_000,
  graphSeries: 32,
  viewportMagnitude: 1e12,
  providerDurationMs: 5 * 60 * 1000,
});

const encoder = new TextEncoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
}

function assertKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unexpected) throw new Error(`${label} contains unsupported field ${unexpected}.`);
}

function assertString(value: unknown, label: string, maxBytes: number, allowEmpty = false): asserts value is string {
  if (
    typeof value !== 'string'
    || (!allowEmpty && value.length === 0)
    || encoder.encode(value).byteLength > maxBytes
    || Array.from(value).some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 0x1f || code === 0x7f;
    })
  ) throw new Error(`${label} must be a bounded control-free string.`);
}

function assertOptionalString(value: unknown, label: string, maxBytes: number): void {
  if (value !== undefined) assertString(value, label, maxBytes, true);
}

function assertEnum<T extends string>(value: unknown, allowed: readonly T[], label: string): asserts value is T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(`${label} has an unsupported value.`);
  }
}

function assertFinite(value: unknown, label: string, min?: number, max?: number): asserts value is number {
  if (
    typeof value !== 'number'
    || !Number.isFinite(value)
    || (min !== undefined && value < min)
    || (max !== undefined && value > max)
  ) throw new Error(`${label} must be a bounded finite number.`);
}

function assertTimestamp(value: unknown, label: string): void {
  assertString(value, label, 64);
  if (Number.isNaN(Date.parse(value))) throw new Error(`${label} must be a valid timestamp.`);
}

function assertStringList(value: unknown, label: string, count: number, bytes: number): asserts value is string[] {
  if (!Array.isArray(value) || value.length > count) throw new Error(`${label} exceeds its item limit.`);
  const unique = new Set<string>();
  value.forEach((item, index) => {
    assertString(item, `${label}[${index}]`, bytes, true);
    if (unique.has(item)) throw new Error(`${label} must not contain duplicates.`);
    unique.add(item);
  });
}

function assertFrame(value: unknown, label: string): void {
  assertRecord(value, label);
  assertKeys(value, ['x', 'y', 'width', 'height', 'rotation'], label);
  assertFinite(value.x, `${label}.x`, -MATH_SCHEMA_LIMITS.viewportMagnitude, MATH_SCHEMA_LIMITS.viewportMagnitude);
  assertFinite(value.y, `${label}.y`, -MATH_SCHEMA_LIMITS.viewportMagnitude, MATH_SCHEMA_LIMITS.viewportMagnitude);
  assertFinite(value.width, `${label}.width`, 0, MATH_SCHEMA_LIMITS.viewportMagnitude);
  assertFinite(value.height, `${label}.height`, 0, MATH_SCHEMA_LIMITS.viewportMagnitude);
  assertFinite(value.rotation, `${label}.rotation`, -360_000, 360_000);
}

function assertPoint(value: unknown, label: string): asserts value is StrokePointV2 {
  assertRecord(value, label);
  assertKeys(value, ['x', 'y', 'pressure', 'tiltX', 'tiltY', 'time', 'pointerType'], label);
  assertFinite(value.x, `${label}.x`, -MATH_SCHEMA_LIMITS.viewportMagnitude, MATH_SCHEMA_LIMITS.viewportMagnitude);
  assertFinite(value.y, `${label}.y`, -MATH_SCHEMA_LIMITS.viewportMagnitude, MATH_SCHEMA_LIMITS.viewportMagnitude);
  assertFinite(value.pressure, `${label}.pressure`, 0, 1);
  assertFinite(value.tiltX, `${label}.tiltX`, -90, 90);
  assertFinite(value.tiltY, `${label}.tiltY`, -90, 90);
  assertFinite(value.time, `${label}.time`, 0, Number.MAX_SAFE_INTEGER);
  assertString(value.pointerType, `${label}.pointerType`, 32);
}

function assertRawStroke(value: unknown, label: string): asserts value is StrokeElementV2 {
  assertRecord(value, label);
  assertKeys(value, [
    'id', 'kind', 'frame', 'createdAt', 'updatedAt', 'locked', 'tool', 'points',
    'color', 'size', 'opacity', 'tombstonedAt', 'sourceStrokeId',
  ], label);
  assertString(value.id, `${label}.id`, MATH_SCHEMA_LIMITS.idBytes);
  if (value.kind !== 'stroke') throw new Error(`${label}.kind must be stroke.`);
  assertFrame(value.frame, `${label}.frame`);
  assertTimestamp(value.createdAt, `${label}.createdAt`);
  assertTimestamp(value.updatedAt, `${label}.updatedAt`);
  if (typeof value.locked !== 'boolean') throw new Error(`${label}.locked must be boolean.`);
  assertEnum(value.tool, ['pen', 'highlighter'], `${label}.tool`);
  if (!Array.isArray(value.points) || value.points.length > MATH_SCHEMA_LIMITS.rawPointsPerStroke) {
    throw new Error(`${label}.points exceeds its limit.`);
  }
  value.points.forEach((point, index) => assertPoint(point, `${label}.points[${index}]`));
  assertString(value.color, `${label}.color`, 64);
  assertFinite(value.size, `${label}.size`, 0.01, 1024);
  assertFinite(value.opacity, `${label}.opacity`, 0, 1);
  if (value.tombstonedAt !== undefined) assertTimestamp(value.tombstonedAt, `${label}.tombstonedAt`);
  assertOptionalString(value.sourceStrokeId, `${label}.sourceStrokeId`, MATH_SCHEMA_LIMITS.idBytes);
}

function assertRawInk(value: unknown, label: string): asserts value is MathRawInkV1 {
  assertRecord(value, label);
  assertKeys(value, ['captureFrame', 'sourceStrokes'], label);
  assertFrame(value.captureFrame, `${label}.captureFrame`);
  if (!Array.isArray(value.sourceStrokes) || value.sourceStrokes.length === 0 || value.sourceStrokes.length > MATH_SCHEMA_LIMITS.rawStrokes) {
    throw new Error(`${label}.sourceStrokes exceeds its limit.`);
  }
  let points = 0;
  const ids = new Set<string>();
  value.sourceStrokes.forEach((stroke, index) => {
    assertRawStroke(stroke, `${label}.sourceStrokes[${index}]`);
    points += stroke.points.length;
    if (points > MATH_SCHEMA_LIMITS.rawPointsTotal) throw new Error(`${label} exceeds its aggregate point limit.`);
    if (ids.has(stroke.id)) throw new Error(`${label} contains duplicate source stroke IDs.`);
    ids.add(stroke.id);
  });
}

function assertProvider(value: unknown, label: string): asserts value is MathRecognitionProviderV1 {
  assertRecord(value, label);
  assertKeys(value, ['kind', 'apiVersion', 'modelVersion', 'durationMs'], label);
  assertEnum(value.kind, ['compatible-endpoint', 'mathpix'], `${label}.kind`);
  assertOptionalString(value.apiVersion, `${label}.apiVersion`, 256);
  assertOptionalString(value.modelVersion, `${label}.modelVersion`, 256);
  if (value.durationMs !== undefined) {
    assertFinite(value.durationMs, `${label}.durationMs`, 0, MATH_SCHEMA_LIMITS.providerDurationMs);
  }
}

function assertRecognition(value: unknown, label: string): asserts value is MathRecognitionV1 {
  assertRecord(value, label);
  assertKeys(value, ['state', 'alternatives', 'warnings', 'provider'], label);
  assertEnum(value.state, ['idle', 'scheduled', 'pending', 'recognized', 'ambiguous', 'unrecognized'], `${label}.state`);
  assertStringList(value.alternatives, `${label}.alternatives`, MATH_SCHEMA_LIMITS.alternatives, MATH_SCHEMA_LIMITS.latexBytes);
  assertStringList(value.warnings, `${label}.warnings`, MATH_SCHEMA_LIMITS.warnings, MATH_SCHEMA_LIMITS.diagnosticBytes);
  if (value.provider !== undefined) assertProvider(value.provider, `${label}.provider`);
}

function assertResult(value: unknown, label: string): asserts value is MathResultV1 {
  assertRecord(value, label);
  assertKeys(value, [
    'state', 'sourceFingerprint', 'engineVersion', 'exactLatex', 'decimalText',
    'unit', 'currencyRate', 'diagnostics',
  ], label);
  assertEnum(value.state, ['none', 'valid', 'error'], `${label}.state`);
  assertOptionalString(value.sourceFingerprint, `${label}.sourceFingerprint`, 256);
  assertOptionalString(value.engineVersion, `${label}.engineVersion`, 256);
  assertOptionalString(value.exactLatex, `${label}.exactLatex`, MATH_SCHEMA_LIMITS.latexBytes);
  assertOptionalString(value.decimalText, `${label}.decimalText`, MATH_SCHEMA_LIMITS.resultTextBytes);
  assertOptionalString(value.unit, `${label}.unit`, 256);
  assertStringList(value.diagnostics, `${label}.diagnostics`, MATH_SCHEMA_LIMITS.diagnostics, MATH_SCHEMA_LIMITS.diagnosticBytes);
  if (value.currencyRate !== undefined) {
    assertRecord(value.currencyRate, `${label}.currencyRate`);
    assertKeys(value.currencyRate, ['base', 'quote', 'asOf', 'source', 'status', 'snapshotVersion'], `${label}.currencyRate`);
    assertString(value.currencyRate.base, `${label}.currencyRate.base`, 16);
    assertString(value.currencyRate.quote, `${label}.currencyRate.quote`, 16);
    assertTimestamp(value.currencyRate.asOf, `${label}.currencyRate.asOf`);
    assertString(value.currencyRate.source, `${label}.currencyRate.source`, 256);
    assertEnum(value.currencyRate.status, ['current', 'stale'], `${label}.currencyRate.status`);
    if (value.currencyRate.snapshotVersion !== 1) throw new Error(`${label}.currencyRate.snapshotVersion must be 1.`);
  }
}

function assertDependencies(value: unknown, label: string): asserts value is MathDependenciesV1 {
  assertRecord(value, label);
  assertKeys(value, ['sourceFingerprint', 'defines', 'references', 'dependsOnElementIds', 'state'], label);
  assertOptionalString(value.sourceFingerprint, `${label}.sourceFingerprint`, 256);
  assertStringList(value.defines, `${label}.defines`, MATH_SCHEMA_LIMITS.symbols, MATH_SCHEMA_LIMITS.symbolBytes);
  assertStringList(value.references, `${label}.references`, MATH_SCHEMA_LIMITS.symbols, MATH_SCHEMA_LIMITS.symbolBytes);
  assertStringList(value.dependsOnElementIds, `${label}.dependsOnElementIds`, MATH_SCHEMA_LIMITS.symbols, MATH_SCHEMA_LIMITS.idBytes);
  assertEnum(value.state, ['valid', 'undefined', 'cycle'], `${label}.state`);
}

function assertElementBase(value: Record<string, unknown>, label: string): void {
  assertString(value.id, `${label}.id`, MATH_SCHEMA_LIMITS.idBytes);
  assertFrame(value.frame, `${label}.frame`);
  assertTimestamp(value.createdAt, `${label}.createdAt`);
  assertTimestamp(value.updatedAt, `${label}.updatedAt`);
  if (typeof value.locked !== 'boolean') throw new Error(`${label}.locked must be boolean.`);
}

export function assertMathPageSettings(value: unknown, label = 'mathSettings'): asserts value is MathPageSettingsV1 {
  assertRecord(value, label);
  assertKeys(value, ['version', 'resultMode', 'numberMode', 'angleMode', 'autoRecognition'], label);
  if (value.version !== 1) throw new Error(`${label}.version is unsupported.`);
  assertEnum(value.resultMode, ['suggest', 'insert', 'off'], `${label}.resultMode`);
  assertEnum(value.numberMode, ['exact', 'decimal'], `${label}.numberMode`);
  assertEnum(value.angleMode, ['degrees', 'radians'], `${label}.angleMode`);
  if (typeof value.autoRecognition !== 'boolean') throw new Error(`${label}.autoRecognition must be boolean.`);
}

export function assertPageContent(value: unknown, label = 'pageContent'): asserts value is PageContentV1 {
  assertRecord(value, label);
  if (value.kind === 'canvas') {
    assertKeys(value, ['version', 'kind'], label);
  } else if (value.kind === 'markdown') {
    assertKeys(value, ['version', 'kind', 'source'], label);
    if (typeof value.source !== 'string' || value.source.length > MAX_TEXT_CHARS) {
      throw new Error(`${label}.source must be a bounded string.`);
    }
  } else {
    throw new Error(`${label}.kind has an unsupported value.`);
  }
  if (value.version !== 1) throw new Error(`${label}.version is unsupported.`);
}

export function assertMathElement(value: unknown, label = 'math element'): asserts value is MathElementV3 {
  assertRecord(value, label);
  assertKeys(value, [
    'id', 'kind', 'frame', 'createdAt', 'updatedAt', 'locked', 'inputKind',
    'autoRecognition', 'rawInk', 'typedLatex', 'recognizedLatex', 'correctedLatex',
    'recognition', 'result', 'dependencies',
  ], label);
  assertElementBase(value, label);
  if (value.kind !== 'math') throw new Error(`${label}.kind must be math.`);
  assertEnum(value.inputKind, ['typed', 'ink', 'converted-ink'], `${label}.inputKind`);
  assertEnum(value.autoRecognition, ['inherit', 'enabled', 'disabled'], `${label}.autoRecognition`);
  if (value.rawInk !== undefined) assertRawInk(value.rawInk, `${label}.rawInk`);
  if (value.inputKind === 'typed' && value.rawInk !== undefined) throw new Error(`${label} typed input cannot contain raw ink.`);
  if (value.inputKind !== 'typed' && value.rawInk === undefined) throw new Error(`${label} ink input requires raw ink.`);
  assertOptionalString(value.typedLatex, `${label}.typedLatex`, MATH_SCHEMA_LIMITS.latexBytes);
  assertOptionalString(value.recognizedLatex, `${label}.recognizedLatex`, MATH_SCHEMA_LIMITS.latexBytes);
  assertOptionalString(value.correctedLatex, `${label}.correctedLatex`, MATH_SCHEMA_LIMITS.latexBytes);
  if (value.inputKind === 'typed' && value.typedLatex === undefined) throw new Error(`${label} typed input requires typedLatex.`);
  assertRecognition(value.recognition, `${label}.recognition`);
  assertResult(value.result, `${label}.result`);
  assertDependencies(value.dependencies, `${label}.dependencies`);
}

function assertSeries(value: unknown, label: string): asserts value is GraphSeriesV1 {
  assertRecord(value, label);
  assertKeys(value, ['id', 'sourceMathElementId', 'color', 'visible'], label);
  assertString(value.id, `${label}.id`, MATH_SCHEMA_LIMITS.idBytes);
  assertString(value.sourceMathElementId, `${label}.sourceMathElementId`, MATH_SCHEMA_LIMITS.idBytes);
  assertString(value.color, `${label}.color`, 64);
  if (typeof value.visible !== 'boolean') throw new Error(`${label}.visible must be boolean.`);
}

function assertViewport(value: unknown, label: string): asserts value is GraphViewportV1 {
  assertRecord(value, label);
  assertKeys(value, ['xMin', 'xMax', 'yMin', 'yMax', 'equalScale', 'axesVisible', 'gridVisible'], label);
  for (const key of ['xMin', 'xMax', 'yMin', 'yMax'] as const) {
    assertFinite(value[key], `${label}.${key}`, -MATH_SCHEMA_LIMITS.viewportMagnitude, MATH_SCHEMA_LIMITS.viewportMagnitude);
  }
  if ((value.xMin as number) >= (value.xMax as number) || (value.yMin as number) >= (value.yMax as number)) {
    throw new Error(`${label} minima must be smaller than maxima.`);
  }
  for (const key of ['equalScale', 'axesVisible', 'gridVisible'] as const) {
    if (typeof value[key] !== 'boolean') throw new Error(`${label}.${key} must be boolean.`);
  }
}

export function assertGraphElement(value: unknown, label = 'graph element'): asserts value is GraphElementV3 {
  assertRecord(value, label);
  assertKeys(value, ['id', 'kind', 'frame', 'createdAt', 'updatedAt', 'locked', 'series', 'viewport'], label);
  assertElementBase(value, label);
  if (value.kind !== 'graph') throw new Error(`${label}.kind must be graph.`);
  if (!Array.isArray(value.series) || value.series.length === 0 || value.series.length > MATH_SCHEMA_LIMITS.graphSeries) {
    throw new Error(`${label}.series exceeds its limit.`);
  }
  const ids = new Set<string>();
  value.series.forEach((series, index) => {
    assertSeries(series, `${label}.series[${index}]`);
    if (ids.has(series.id)) throw new Error(`${label}.series IDs must be unique.`);
    ids.add(series.id);
  });
  assertViewport(value.viewport, `${label}.viewport`);
}

export function assertV3PageMathGraph(page: {
  elementsById: Record<string, unknown>;
  mathSettings?: unknown;
  pageContent?: unknown;
}): void {
  if (page.mathSettings !== undefined) assertMathPageSettings(page.mathSettings);
  if (page.pageContent !== undefined) assertPageContent(page.pageContent);
  const mathIds = new Set<string>();
  for (const [id, candidate] of Object.entries(page.elementsById)) {
    assertRecord(candidate, `elementsById.${id}`);
    const element = candidate;
    if (element.kind === 'math') {
      assertMathElement(element, `elementsById.${id}`);
      mathIds.add(id);
    } else if (element.kind === 'graph') {
      assertGraphElement(element, `elementsById.${id}`);
    }
  }
  for (const [id, candidate] of Object.entries(page.elementsById)) {
    assertRecord(candidate, `elementsById.${id}`);
    const element = candidate;
    if (element.kind === 'math') {
      const math = element as unknown as MathElementV3;
      if (math.dependencies.dependsOnElementIds.some((sourceId) => !mathIds.has(sourceId))) {
        throw new Error(`Math element ${id} references a missing or non-math dependency.`);
      }
      if (math.dependencies.dependsOnElementIds.includes(id)) {
        throw new Error(`Math element ${id} cannot depend directly on itself.`);
      }
    } else if (element.kind === 'graph') {
      const graph = element as unknown as GraphElementV3;
      if (graph.series.some((series) => !mathIds.has(series.sourceMathElementId))) {
        throw new Error(`Graph element ${id} references a missing or non-math source.`);
      }
    }
  }
}

/** Validates detached Math Canvas payloads kept in the workspace trash. */
export function assertV3ManifestMathData(value: unknown): void {
  assertRecord(value, 'schema-v3 manifest');
  if (value.schemaVersion !== 3 || value.format !== 'canvink-schema-v3') {
    throw new Error('The schema-v3 manifest selector is invalid.');
  }
  if (!Array.isArray(value.trash)) throw new Error('The schema-v3 manifest trash must be an array.');
  value.trash.forEach((record, index) => {
    assertRecord(record, `manifest.trash[${index}]`);
    if (record.element === undefined) return;
    assertRecord(record.element, `manifest.trash[${index}].element`);
    if (record.element.kind === 'math') {
      assertMathElement(record.element, `manifest.trash[${index}].element`);
    } else if (record.element.kind === 'graph') {
      assertGraphElement(record.element, `manifest.trash[${index}].element`);
    }
  });
}
