import type { MathJsonExpression } from '@cortex-js/compute-engine/math-json';
import { sharedMathEngine, type LocalMathEngine } from './compute';
import { collectVariables, evaluateSafeMathJson, isSafeVariableName } from './policy';
import {
  MathEngineError,
  type AngleMode,
  type GraphSampleOptions,
  type GraphSampleResult,
  type ImplicitGraphPoint,
  type SafeMathJson,
} from './types';

interface PreparedGraphExpressionBase {
  readonly sourceLatex: string;
  readonly independentVariable: string;
  readonly dependentVariable: string;
  readonly dependencies: readonly string[];
  readonly angleMode: AngleMode;
}

export interface PreparedExplicitGraphExpression extends PreparedGraphExpressionBase {
  readonly kind: 'explicit';
}

export interface PreparedImplicitGraphExpression extends PreparedGraphExpressionBase {
  readonly kind: 'implicit';
}

export type PreparedGraphExpression = PreparedExplicitGraphExpression | PreparedImplicitGraphExpression;

const preparedExpressions = new WeakMap<object, SafeMathJson>();

export function prepareGraphExpression(
  latex: string,
  options: {
    readonly independentVariable?: string;
    readonly dependentVariable?: string;
    readonly angleMode?: AngleMode;
  } = {},
  engine: LocalMathEngine = sharedMathEngine(),
): PreparedGraphExpression {
  const independentVariable = options.independentVariable ?? 'x';
  const dependentVariable = options.dependentVariable ?? 'y';
  if (!isSafeVariableName(independentVariable) || !isSafeVariableName(dependentVariable)) {
    throw new MathEngineError('unsupported-expression', 'Graph variable name is outside the safe identifier policy.');
  }
  if (independentVariable === dependentVariable) {
    throw new MathEngineError('unsupported-expression', 'Graph axes must use different variable names.');
  }
  const angleMode = options.angleMode ?? 'radians';
  const inspected = engine.inspect(latex, angleMode);
  let graphJson: SafeMathJson = inspected.mathJson;
  let kind: PreparedGraphExpression['kind'] = 'explicit';

  if (inspected.kind === 'assignment' && inspected.assignmentVariable === dependentVariable) {
    if (!Array.isArray(inspected.mathJson)) throw new MathEngineError('unsupported-equation', 'Malformed graph equation.');
    graphJson = inspected.mathJson[2];
  } else if (inspected.kind === 'equation' || inspected.kind === 'assignment') {
    if (!isSingleEquation(inspected.mathJson)) {
      throw new MathEngineError('unsupported-equation', 'Only one two-dimensional equation can be graphed at a time.');
    }
    const equationVariables = collectVariables(inspected.mathJson);
    if (!equationVariables.includes(independentVariable) && !equationVariables.includes(dependentVariable)) {
      throw new MathEngineError(
        'unsupported-equation',
        `Implicit equations must reference ${independentVariable} or ${dependentVariable}.`,
      );
    }
    kind = 'implicit';
    graphJson = ['Subtract', inspected.mathJson[1], inspected.mathJson[2]];
  }

  const dependencies = collectVariables(graphJson)
    .filter((variable) => variable !== independentVariable && (kind !== 'implicit' || variable !== dependentVariable));
  const prepared: PreparedGraphExpression = Object.freeze({
    kind,
    sourceLatex: latex,
    independentVariable,
    dependentVariable,
    dependencies,
    angleMode,
  });
  preparedExpressions.set(prepared, graphJson);
  return prepared;
}

export function sampleGraphExpression(
  prepared: PreparedGraphExpression,
  options: GraphSampleOptions,
): GraphSampleResult {
  const expression = preparedExpressions.get(prepared);
  if (!expression) {
    throw new MathEngineError('unsafe-latex', 'Graph expression was not prepared by the local math engine.');
  }
  if (prepared.kind === 'implicit') return sampleImplicitGraphExpression(prepared, expression, options);
  if (!Number.isFinite(options.minX) || !Number.isFinite(options.maxX) || options.minX >= options.maxX) {
    throw new MathEngineError('invalid-number', 'Graph range must contain two increasing finite values.');
  }
  if (Math.abs(options.minX) > 1_000_000 || Math.abs(options.maxX) > 1_000_000) {
    throw new MathEngineError('budget-exceeded', 'Graph range exceeds the released viewport limit.');
  }
  const samples = options.samples ?? 257;
  if (!Number.isInteger(samples) || samples < 2 || samples > 2_001) {
    throw new MathEngineError('budget-exceeded', 'Graph sample count must be between 2 and 2001.');
  }
  const variables = { ...(options.variables ?? {}) };
  for (const [name, value] of Object.entries(variables)) {
    if (!isSafeVariableName(name) || !Number.isFinite(value)) {
      throw new MathEngineError('invalid-number', `Invalid graph variable: ${name}`);
    }
  }
  const missing = prepared.dependencies.filter((variable) => !Object.hasOwn(variables, variable));
  if (missing.length > 0) throw new MathEngineError('undefined-variable', `Undefined graph variable: ${missing.join(', ')}`);

  const totalOperationBudget = options.maxOperations ?? 200_000;
  const maxEvaluationMs = options.maxEvaluationMs ?? 100;
  if (!Number.isInteger(totalOperationBudget) || totalOperationBudget < samples || totalOperationBudget > 2_000_000) {
    throw new MathEngineError('budget-exceeded', 'Invalid graph operation budget.');
  }
  if (!Number.isInteger(maxEvaluationMs) || maxEvaluationMs < 1 || maxEvaluationMs > 5_000) {
    throw new MathEngineError('budget-exceeded', 'Invalid graph time budget.');
  }
  const perPointOperations = Math.floor(totalOperationBudget / samples);
  const deadline = Date.now() + maxEvaluationMs;
  const step = (options.maxX - options.minX) / (samples - 1);
  let invalidPointCount = 0;
  const points = Array.from({ length: samples }, (_, index) => {
    const x = index === samples - 1 ? options.maxX : options.minX + step * index;
    try {
      const y = evaluateSafeMathJson(
        expression,
        { ...variables, [prepared.independentVariable]: x },
        prepared.angleMode,
        { maxOperations: perPointOperations, deadline },
      );
      return { x, y };
    } catch (error) {
      if (error instanceof MathEngineError && (error.code === 'invalid-number' || error.code === 'undefined-variable')) {
        invalidPointCount += 1;
        return { x, y: null };
      }
      throw error;
    }
  });
  return { kind: 'explicit', points, invalidPointCount };
}

export function graphMathJsonForTesting(prepared: PreparedGraphExpression): MathJsonExpression | undefined {
  return preparedExpressions.get(prepared);
}

export interface ExplicitGraphSplitOptions {
  readonly minY: number;
  readonly maxY: number;
  readonly maxViewportJumpRatio?: number;
}

/** Shared numeric-only discontinuity guard for UI and static exports. */
export function splitExplicitGraphPoints(
  points: readonly { readonly x: number; readonly y: number | null }[],
  options: ExplicitGraphSplitOptions,
): Array<Array<{ x: number; y: number }>> {
  if (!Number.isFinite(options.minY) || !Number.isFinite(options.maxY) || options.minY >= options.maxY) {
    throw new MathEngineError('invalid-number', 'Explicit graph split bounds must be increasing and finite.');
  }
  const jumpRatio = options.maxViewportJumpRatio ?? 0.6;
  if (!Number.isFinite(jumpRatio) || jumpRatio <= 0 || jumpRatio > 2) {
    throw new MathEngineError('invalid-number', 'Explicit graph jump ratio is outside the safe range.');
  }
  const maximumJump = (options.maxY - options.minY) * jumpRatio;
  const lines: Array<Array<{ x: number; y: number }>> = [];
  let current: Array<{ x: number; y: number }> = [];
  let previousY: number | undefined;
  const flush = () => {
    if (current.length >= 2) lines.push(current);
    current = [];
    previousY = undefined;
  };
  for (const point of points) {
    const y = point.y;
    const visible = y !== null && Number.isFinite(point.x) && Number.isFinite(y)
      && y >= options.minY && y <= options.maxY;
    if (!visible) {
      flush();
      continue;
    }
    if (previousY !== undefined && Math.abs(y - previousY) > maximumJump) flush();
    current.push({ x: point.x, y });
    previousY = y;
  }
  flush();
  return lines;
}

interface GridValue {
  readonly x: number;
  readonly y: number;
  readonly value: number | null;
}

interface ContourSegment {
  readonly start: ImplicitGraphPoint;
  readonly end: ImplicitGraphPoint;
}

const MAX_VIEWPORT_COORDINATE = 1_000_000;
const MAX_IMPLICIT_GRID_SIZE = 129;
const MAX_GRAPH_OPERATIONS = 2_000_000;

function sampleImplicitGraphExpression(
  prepared: PreparedImplicitGraphExpression,
  expression: SafeMathJson,
  options: GraphSampleOptions,
): GraphSampleResult {
  assertImplicitViewport(options);
  const minY = options.minY as number;
  const maxY = options.maxY as number;
  const gridSize = options.gridSize ?? 65;
  if (!Number.isInteger(gridSize) || gridSize < 3 || gridSize > MAX_IMPLICIT_GRID_SIZE) {
    throw new MathEngineError('budget-exceeded', `Implicit graph grid size must be between 3 and ${MAX_IMPLICIT_GRID_SIZE}.`);
  }
  const variables = checkedGraphVariables(options.variables);
  const missing = prepared.dependencies.filter((variable) => !Object.hasOwn(variables, variable));
  if (missing.length > 0) throw new MathEngineError('undefined-variable', `Undefined graph variable: ${missing.join(', ')}`);

  const maxEvaluationMs = options.maxEvaluationMs ?? 100;
  if (!Number.isInteger(maxEvaluationMs) || maxEvaluationMs < 1 || maxEvaluationMs > 5_000) {
    throw new MathEngineError('budget-exceeded', 'Invalid graph time budget.');
  }
  const evaluationCount = gridSize * gridSize;
  const operationsPerEvaluation = countMathJsonNodes(expression);
  const requiredOperations = evaluationCount * operationsPerEvaluation;
  const totalOperationBudget = options.maxOperations ?? 500_000;
  if (
    !Number.isInteger(totalOperationBudget)
    || totalOperationBudget < requiredOperations
    || totalOperationBudget > MAX_GRAPH_OPERATIONS
  ) {
    throw new MathEngineError(
      'budget-exceeded',
      `Implicit graph operation budget must cover ${requiredOperations} bounded interpreter operations.`,
    );
  }

  const deadline = Date.now() + maxEvaluationMs;
  const stepX = (options.maxX - options.minX) / (gridSize - 1);
  const stepY = (maxY - minY) / (gridSize - 1);
  let invalidPointCount = 0;
  const grid: GridValue[][] = [];
  for (let row = 0; row < gridSize; row += 1) {
    if (Date.now() > deadline) throw new MathEngineError('budget-exceeded', 'Implicit graph sampling exceeded its time budget.');
    const y = row === gridSize - 1 ? maxY : minY + stepY * row;
    const values: GridValue[] = [];
    for (let column = 0; column < gridSize; column += 1) {
      const x = column === gridSize - 1 ? options.maxX : options.minX + stepX * column;
      let value: number | null;
      try {
        value = evaluateSafeMathJson(
          expression,
          { ...variables, [prepared.independentVariable]: x, [prepared.dependentVariable]: y },
          prepared.angleMode,
          { maxOperations: operationsPerEvaluation, deadline },
        );
      } catch (error) {
        if (error instanceof MathEngineError && error.code === 'invalid-number') {
          invalidPointCount += 1;
          value = null;
        } else {
          throw error;
        }
      }
      values.push({ x, y, value });
    }
    grid.push(values);
  }

  const segments: ContourSegment[] = [];
  for (let row = 0; row < gridSize - 1; row += 1) {
    if (Date.now() > deadline) throw new MathEngineError('budget-exceeded', 'Implicit contour extraction exceeded its time budget.');
    for (let column = 0; column < gridSize - 1; column += 1) {
      segments.push(...contourCell(
        grid[row][column],
        grid[row][column + 1],
        grid[row + 1][column + 1],
        grid[row + 1][column],
        row,
        column,
      ));
    }
  }

  return {
    kind: 'implicit',
    points: [],
    paths: joinContourSegments(segments, options.minX, minY, stepX, stepY),
    invalidPointCount,
    gridSize,
  };
}

function assertImplicitViewport(options: GraphSampleOptions): void {
  const values = [options.minX, options.maxX, options.minY, options.maxY];
  if (values.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
    throw new MathEngineError('invalid-number', 'Implicit graph viewport requires finite x and y bounds.');
  }
  if (options.minX >= options.maxX || (options.minY as number) >= (options.maxY as number)) {
    throw new MathEngineError('invalid-number', 'Implicit graph viewport bounds must be increasing.');
  }
  if (values.some((value) => Math.abs(value as number) > MAX_VIEWPORT_COORDINATE)) {
    throw new MathEngineError('budget-exceeded', 'Implicit graph viewport exceeds the released coordinate limit.');
  }
}

function checkedGraphVariables(input: GraphSampleOptions['variables']): Record<string, number> {
  const variables = { ...(input ?? {}) };
  for (const [name, value] of Object.entries(variables)) {
    if (!isSafeVariableName(name) || !Number.isFinite(value)) {
      throw new MathEngineError('invalid-number', `Invalid graph variable: ${name}`);
    }
  }
  return variables;
}

function countMathJsonNodes(expression: MathJsonExpression): number {
  if (!Array.isArray(expression)) return 1;
  const operands = Array.from(expression).slice(1) as MathJsonExpression[];
  return 1 + operands.reduce<number>((sum, operand) => sum + countMathJsonNodes(operand), 0);
}

function contourCell(
  bottomLeft: GridValue,
  bottomRight: GridValue,
  topRight: GridValue,
  topLeft: GridValue,
  row: number,
  column: number,
): ContourSegment[] {
  const values = [bottomLeft.value, bottomRight.value, topRight.value, topLeft.value];
  if (values.some((value) => value === null)) return [];
  const numeric = values as number[];
  const cellCase = numeric.reduce((mask, value, index) => mask | (value >= 0 ? 1 << index : 0), 0);
  if (cellCase === 0 || cellCase === 15) return [];
  const corners = [bottomLeft, bottomRight, topRight, topLeft];
  const edgeCorners = [[0, 1], [1, 2], [2, 3], [3, 0]] as const;
  const edgePoint = (edge: number): ImplicitGraphPoint => {
    const [startIndex, endIndex] = edgeCorners[edge];
    return interpolateZero(corners[startIndex], corners[endIndex]);
  };
  const make = (startEdge: number, endEdge: number): ContourSegment | null => {
    const start = edgePoint(startEdge);
    const end = edgePoint(endEdge);
    return start.x === end.x && start.y === end.y ? null : { start, end };
  };
  const pairs = contourEdgePairs(cellCase, numeric, row, column);
  return pairs.map(([start, end]) => make(start, end)).filter((segment): segment is ContourSegment => segment !== null);
}

function contourEdgePairs(
  cellCase: number,
  values: readonly number[],
  row: number,
  column: number,
): readonly (readonly [number, number])[] {
  switch (cellCase) {
    case 1: return [[3, 0]];
    case 2: return [[0, 1]];
    case 3: return [[3, 1]];
    case 4: return [[1, 2]];
    case 5: return ambiguousPairs(values, row, column);
    case 6: return [[0, 2]];
    case 7: return [[3, 2]];
    case 8: return [[2, 3]];
    case 9: return [[0, 2]];
    case 10: return ambiguousPairs(values, row, column);
    case 11: return [[1, 2]];
    case 12: return [[3, 1]];
    case 13: return [[0, 1]];
    case 14: return [[3, 0]];
    default: return [];
  }
}

function ambiguousPairs(
  values: readonly number[],
  row: number,
  column: number,
): readonly (readonly [number, number])[] {
  // The bilinear asymptotic decider prevents a sampling-order-dependent choice
  // in saddle cells. Exact ties use fixed cell parity, so reruns are identical.
  const determinant = values[0] * values[2] - values[1] * values[3];
  const chooseFirstPairing = determinant === 0 ? (row + column) % 2 === 0 : determinant > 0;
  return chooseFirstPairing ? [[0, 1], [2, 3]] : [[3, 0], [1, 2]];
}

function interpolateZero(start: GridValue, end: GridValue): ImplicitGraphPoint {
  const startValue = start.value as number;
  const endValue = end.value as number;
  if (startValue === 0) return { x: start.x, y: start.y };
  if (endValue === 0) return { x: end.x, y: end.y };
  const fraction = Math.min(1, Math.max(0, startValue / (startValue - endValue)));
  return {
    x: start.x + (end.x - start.x) * fraction,
    y: start.y + (end.y - start.y) * fraction,
  };
}

function joinContourSegments(
  segments: readonly ContourSegment[],
  minX: number,
  minY: number,
  stepX: number,
  stepY: number,
): readonly (readonly ImplicitGraphPoint[])[] {
  const keyFor = (point: ImplicitGraphPoint): string => {
    const column = Math.round(((point.x - minX) / stepX) * 1_000_000_000);
    const row = Math.round(((point.y - minY) / stepY) * 1_000_000_000);
    return `${column}:${row}`;
  };
  const adjacency = new Map<string, number[]>();
  for (let index = 0; index < segments.length; index += 1) {
    for (const point of [segments[index].start, segments[index].end]) {
      const key = keyFor(point);
      const attached = adjacency.get(key) ?? [];
      attached.push(index);
      adjacency.set(key, attached);
    }
  }
  const used = new Set<number>();
  const paths: ImplicitGraphPoint[][] = [];
  const trace = (firstSegment: number, firstPoint: ImplicitGraphPoint): ImplicitGraphPoint[] => {
    const path = [firstPoint];
    let currentSegment = firstSegment;
    let currentKey = keyFor(firstPoint);
    while (!used.has(currentSegment)) {
      used.add(currentSegment);
      const segment = segments[currentSegment];
      const nextPoint = keyFor(segment.start) === currentKey ? segment.end : segment.start;
      path.push(nextPoint);
      currentKey = keyFor(nextPoint);
      const nextSegment = (adjacency.get(currentKey) ?? []).find((candidate) => !used.has(candidate));
      if (nextSegment === undefined) break;
      currentSegment = nextSegment;
    }
    return path;
  };
  for (let index = 0; index < segments.length; index += 1) {
    if (used.has(index)) continue;
    const segment = segments[index];
    const startDegree = adjacency.get(keyFor(segment.start))?.length ?? 0;
    const endDegree = adjacency.get(keyFor(segment.end))?.length ?? 0;
    const firstPoint = startDegree !== 2 ? segment.start : endDegree !== 2 ? segment.end : segment.start;
    const path = trace(index, firstPoint);
    if (path.length >= 2 && path.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))) paths.push(path);
  }
  return paths;
}

function isSingleEquation(expression: MathJsonExpression): expression is [string, MathJsonExpression, MathJsonExpression] {
  return Array.isArray(expression) && expression[0] === 'Equal' && expression.length === 3;
}
