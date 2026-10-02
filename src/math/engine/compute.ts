import type { ComputeEngine, Expression } from '@cortex-js/compute-engine';
import { computeEngineConstructor } from '../runtime';
import type { MathJsonExpression } from '@cortex-js/compute-engine/math-json';
import {
  assertBoundedExactEvaluation,
  assertSafeLatex,
  assertSafeMathJson,
  collectVariables,
  isSafeVariableName,
  mergeMathEngineLimits,
} from './policy';
import {
  MathEngineError,
  type AngleMode,
  type EvaluateMathOptions,
  type MathEngineLimits,
  type MathEvaluationResult,
  type MathEvaluationSuccess,
  type MathSolution,
  type MathValue,
  type SafeMathJson,
} from './types';

export interface InspectedMathExpression {
  readonly sourceLatex: string;
  readonly mathJson: SafeMathJson;
  readonly dependencies: readonly string[];
  readonly kind: 'assignment' | 'expression' | 'equation';
  readonly assignmentVariable?: string;
}

interface ParsedExpression extends InspectedMathExpression {
  readonly expression: Expression;
}

let sharedEngine: LocalMathEngine | undefined;

/**
 * The engine for callers that do not bring their own. Building one bootstraps
 * the Compute Engine's whole library twice (degrees and radians), which takes
 * tens of milliseconds; a default parameter that built a new engine made every
 * keystroke in a Math block and every graph redraw pay for it. Every call
 * pushes and pops its own scope, so sharing is safe.
 */
export function sharedMathEngine(): LocalMathEngine {
  sharedEngine ??= new LocalMathEngine();
  return sharedEngine;
}

export class LocalMathEngine {
  readonly limits: MathEngineLimits;
  readonly #engines: Readonly<Record<AngleMode, ComputeEngine>>;

  constructor(limits?: Partial<MathEngineLimits>) {
    this.limits = mergeMathEngineLimits(limits);
    this.#engines = Object.freeze({
      degrees: createComputeEngine('degrees', this.limits),
      radians: createComputeEngine('radians', this.limits),
    });
  }

  inspect(latex: string, angleMode: AngleMode = 'radians'): InspectedMathExpression {
    const engine = this.#engines[angleMode];
    return this.#bounded(engine, 'inspect', () => this.#withScope(engine, {}, () => {
      const parsed = this.#parse(engine, latex);
      return {
        sourceLatex: parsed.sourceLatex,
        mathJson: parsed.mathJson,
        dependencies: parsed.dependencies,
        kind: parsed.kind,
        ...(parsed.assignmentVariable ? { assignmentVariable: parsed.assignmentVariable } : {}),
      };
    }));
  }

  evaluate(latex: string, options: EvaluateMathOptions = {}): MathEvaluationResult {
    try {
      return this.evaluateOrThrow(latex, options);
    } catch (error) {
      const normalized = normalizeEngineError(error);
      return {
        status: 'error',
        sourceLatex: latex,
        dependencies: [],
        error: { code: normalized.code, message: normalized.message },
      };
    }
  }

  evaluateOrThrow(latex: string, options: EvaluateMathOptions = {}): MathEvaluationSuccess {
    const angleMode = options.angleMode ?? 'radians';
    const engine = this.#engines[angleMode];
    const variables = options.variables ?? {};
    return this.#bounded(engine, 'request', () => this.#withScope(engine, variables, () => {
      const parsed = this.#parse(engine, latex);
      const unknownVariables = parsed.dependencies.filter((name) => !(name in variables));

      if (parsed.kind === 'assignment') {
        const json = parsed.mathJson as readonly MathJsonExpression[];
        const valueExpression = engine.expr(json[2]);
        return success(parsed, this.#toValue(engine, valueExpression, 'assignment'), []);
      }

      if (parsed.kind === 'equation') {
        if (unknownVariables.length === 0) {
          return success(parsed, this.#toValue(engine, parsed.expression, 'equation-check'), []);
        }
        const solutions = this.#solveEquation(engine, parsed, unknownVariables);
        return success(parsed, null, solutions);
      }

      if (unknownVariables.length > 0) {
        throw new MathEngineError('undefined-variable', `Undefined variable: ${unknownVariables.join(', ')}`);
      }
      return success(parsed, this.#toValue(engine, parsed.expression, 'expression'), []);
    }));
  }

  #parse(engine: ComputeEngine, latex: string): ParsedExpression {
    assertSafeLatex(latex, this.limits);
    const raw = this.#bounded(engine, 'parse-raw', () => engine.parse(latex, { diagnostics: true, form: 'raw' }));
    const rejectedDiagnostic = raw.parseDiagnostics?.find((diagnostic) => diagnostic.code !== 'undeclared-symbol');
    if (rejectedDiagnostic) {
      throw new MathEngineError('unsafe-latex', `LaTeX parser rejected input: ${rejectedDiagnostic.code}`);
    }
    assertSafeMathJson(raw.json, this.limits);
    assertBoundedExactEvaluation(raw.json, this.limits);

    // Parse a second time only after the raw tree passed policy. This lets the
    // engine bind scoped variables without asking it to canonicalize unsafe input.
    const canonical = this.#bounded(engine, 'parse-canonical', () => engine.parse(latex));
    assertSafeMathJson(canonical.json, this.limits);
    assertBoundedExactEvaluation(canonical.json, this.limits);
    const classification = classifyExpression(raw.json);
    const dependencies = classification.kind === 'assignment' && Array.isArray(raw.json)
      ? collectVariables(raw.json[2])
      : collectVariables(raw.json);
    return {
      sourceLatex: latex,
      expression: canonical,
      mathJson: canonical.json,
      dependencies,
      ...classification,
    };
  }

  #solveEquation(
    engine: ComputeEngine,
    parsed: ParsedExpression,
    unknownVariables: readonly string[],
  ): readonly MathSolution[] {
    if (unknownVariables.length === 1 && isSingleEquation(parsed.mathJson)) {
      const variable = unknownVariables[0];
      const degree = polynomialDegreeFor(parsed.mathJson, new Set([variable]));
      if (degree === null || degree > 2) {
        throw new MathEngineError('unsupported-equation', 'Only linear and quadratic equations are supported.');
      }
      const solved = this.#bounded(engine, 'solve-equation', () => parsed.expression.solve(variable));
      if (!Array.isArray(solved)) {
        throw new MathEngineError('evaluation-failed', 'The equation solver returned an unexpected result.');
      }
      return solved.map((solution) => {
        if (!solution || typeof solution !== 'object' || !('json' in solution)) {
          throw new MathEngineError('evaluation-failed', 'The equation solver returned an unexpected solution.');
        }
        return { variables: { [variable]: this.#toValue(engine, solution as unknown as Expression, 'solution') } };
      });
    }

    if (unknownVariables.length === 2 && isTwoEquationSystem(parsed.mathJson)) {
      const unknowns = new Set(unknownVariables);
      const equations = parsed.mathJson.slice(1);
      if (equations.some((equation) => polynomialDegreeFor(equation, unknowns) !== 1)) {
        throw new MathEngineError('unsupported-equation', 'Only linear systems with two equations and two variables are supported.');
      }
      const solved = this.#bounded(engine, 'solve-system', () => parsed.expression.solve(unknownVariables));
      return this.#normalizeSystemSolutions(engine, solved, unknownVariables);
    }

    throw new MathEngineError('unsupported-equation', 'Equation shape is outside the released local scope.');
  }

  #normalizeSystemSolutions(
    engine: ComputeEngine,
    solved: ReturnType<Expression['solve']>,
    variables: readonly string[],
  ): readonly MathSolution[] {
    if (!solved) return [];
    const records = Array.isArray(solved) ? solved : [solved];
    return records.map((record) => {
      if (!record || Array.isArray(record) || typeof record !== 'object' || 'json' in record) {
        throw new MathEngineError('evaluation-failed', 'The system solver returned an unexpected result.');
      }
      const values: Record<string, MathValue> = {};
      for (const variable of variables) {
        const expression = (record as Record<string, Expression>)[variable];
        if (!expression) throw new MathEngineError('evaluation-failed', `Missing solution for ${variable}.`);
        values[variable] = this.#toValue(engine, expression, 'system-solution');
      }
      return { variables: values };
    });
  }

  #toValue(engine: ComputeEngine, expression: Expression, label: string): MathValue {
    assertSafeMathJson(expression.json, this.limits);
    assertBoundedExactEvaluation(expression.json, this.limits);
    const exact = this.#bounded(engine, `${label}-exact`, () => expression.evaluate());
    assertSafeMathJson(exact.json, this.limits);
    assertBoundedExactEvaluation(exact.json, this.limits);
    const decimal = this.#bounded(engine, `${label}-decimal`, () => exact.N());
    assertSafeMathJson(decimal.json, this.limits);
    assertFiniteResult(exact.json);
    assertFiniteResult(decimal.json);
    return {
      exactLatex: exact.latex,
      decimalLatex: decimal.latex,
      exactMathJson: exact.json,
      decimalMathJson: decimal.json,
      decimalValue: mathJsonNumber(decimal.json),
    };
  }

  #withScope<T>(
    engine: ComputeEngine,
    variables: Readonly<Record<string, SafeMathJson | number>>,
    callback: () => T,
  ): T {
    engine.pushScope();
    try {
      for (const [name, value] of Object.entries(variables)) {
        if (!isSafeVariableName(name)) throw new MathEngineError('unsupported-expression', `Unsafe variable name: ${name}`);
        if (typeof value === 'number' && !Number.isFinite(value)) {
          throw new MathEngineError('invalid-number', `Variable ${name} is not finite.`);
        }
        if (typeof value !== 'number') {
          assertSafeMathJson(value, this.limits);
          assertBoundedExactEvaluation(value, this.limits);
        }
        engine.assign(name, value);
      }
      return callback();
    } finally {
      engine.popScope();
    }
  }

  #bounded<T>(engine: ComputeEngine, label: string, callback: () => T): T {
    const startedAt = Date.now();
    const inheritedDeadline = engine.deadline;
    if (inheritedDeadline !== undefined && startedAt > inheritedDeadline) {
      throw new MathEngineError('budget-exceeded', `Math operation exceeded ${this.limits.maxEvaluationMs} ms.`);
    }
    const effectiveDeadline = Math.min(inheritedDeadline ?? Number.POSITIVE_INFINITY, startedAt + this.limits.maxEvaluationMs);
    try {
      const result = engine.withTimeLimit(
        { ms: this.limits.maxEvaluationMs, label: `canvink:${label}` },
        callback as () => T extends Promise<unknown> ? never : T,
      ) as T;
      // Compute Engine deadlines are cooperative. JavaScript cannot preempt a
      // synchronous third-party frame on this thread, so this post-check turns
      // a non-cooperative overrun into a budget failure after that frame returns.
      // Raw-AST exact-complexity checks and the engine caps below bound known
      // expensive work before entering such a frame. Hard preemption would
      // require moving the complete scoped engine request behind a Worker.
      if (Date.now() > effectiveDeadline) {
        throw new MathEngineError('budget-exceeded', `Math operation exceeded ${this.limits.maxEvaluationMs} ms.`);
      }
      return result;
    } catch (error) {
      if (isCancellationError(error)) {
        throw new MathEngineError('budget-exceeded', `Math operation exceeded ${this.limits.maxEvaluationMs} ms.`, {
          cause: error,
        });
      }
      throw error;
    }
  }
}

function createComputeEngine(angleMode: AngleMode, limits: MathEngineLimits): ComputeEngine {
  const engine = new (computeEngineConstructor())();
  engine.jit = 'off';
  engine.precision = Math.min(100, limits.maxNumericDigits);
  engine.angularUnit = angleMode === 'degrees' ? 'deg' : 'rad';
  engine.iterationLimit = limits.maxOperations;
  engine.recursionLimit = limits.maxAstDepth;
  engine.maxCollectionSize = limits.maxCollectionSize;
  return engine;
}

function classifyExpression(expression: MathJsonExpression): Pick<ParsedExpression, 'kind' | 'assignmentVariable'> {
  if (Array.isArray(expression) && expression[0] === 'Equal' && typeof expression[1] === 'string' && isSafeVariableName(expression[1])) {
    return { kind: 'assignment', assignmentVariable: expression[1] };
  }
  if (isSingleEquation(expression) || isTwoEquationSystem(expression)) return { kind: 'equation' };
  return { kind: 'expression' };
}

function isSingleEquation(expression: MathJsonExpression): expression is [string, MathJsonExpression, MathJsonExpression] {
  return Array.isArray(expression) && expression[0] === 'Equal' && expression.length === 3;
}

function isTwoEquationSystem(expression: MathJsonExpression): expression is [string, MathJsonExpression, MathJsonExpression] {
  const operands = Array.isArray(expression) ? (Array.from(expression).slice(1) as MathJsonExpression[]) : [];
  return Array.isArray(expression)
    && expression[0] === 'List'
    && expression.length === 3
    && operands.every(isSingleEquation);
}

function polynomialDegreeFor(expression: MathJsonExpression, variables: ReadonlySet<string>): number | null {
  if (typeof expression === 'number') return 0;
  if (typeof expression === 'string') return variables.has(expression) ? 1 : 0;
  if (expression && !Array.isArray(expression) && typeof expression === 'object' && 'num' in expression) return 0;
  if (!Array.isArray(expression) || typeof expression[0] !== 'string') return null;
  const operands = expression.slice(1);
  switch (expression[0]) {
    case 'Equal': {
      const left = polynomialDegreeFor(operands[0], variables);
      const right = polynomialDegreeFor(operands[1], variables);
      return left === null || right === null ? null : Math.max(left, right);
    }
    case 'Add':
    case 'Subtract': {
      const degrees = operands.map((operand) => polynomialDegreeFor(operand, variables));
      return degrees.some((degree) => degree === null) ? null : Math.max(...(degrees as number[]));
    }
    case 'Negate':
    case 'Delimiter':
      return polynomialDegreeFor(operands[0], variables);
    case 'Multiply':
    case 'InvisibleOperator': {
      const degrees = operands.map((operand) => polynomialDegreeFor(operand, variables));
      return degrees.some((degree) => degree === null) ? null : (degrees as number[]).reduce((sum, degree) => sum + degree, 0);
    }
    case 'Divide':
    case 'Rational': {
      const numerator = polynomialDegreeFor(operands[0], variables);
      const denominator = polynomialDegreeFor(operands[1], variables);
      return numerator === null || denominator !== 0 ? null : numerator;
    }
    case 'Power': {
      const base = polynomialDegreeFor(operands[0], variables);
      const exponent = mathJsonNumber(operands[1]);
      return base === null || exponent === null || !Number.isInteger(exponent) || exponent < 0
        ? null
        : base * exponent;
    }
    default:
      return operands.some((operand) => containsAnyVariable(operand, variables)) ? null : 0;
  }
}

function containsAnyVariable(expression: MathJsonExpression, variables: ReadonlySet<string>): boolean {
  if (typeof expression === 'string') return variables.has(expression);
  if (!Array.isArray(expression)) return false;
  return (Array.from(expression).slice(1) as MathJsonExpression[])
    .some((operand) => containsAnyVariable(operand, variables));
}

const NON_FINITE_SYMBOLS = new Set(['ComplexInfinity', 'PositiveInfinity', 'NegativeInfinity', 'NaN', 'Undefined']);

/**
 * Rejects evaluation results that contain a non-finite marker anywhere in the
 * tree. Without this, division by zero surfaces as a seemingly valid ∞̃ or NaN
 * result, which is wrong for the school-math scope of the local engine.
 */
function assertFiniteResult(expression: MathJsonExpression): void {
  const nonFinite = (node: MathJsonExpression): boolean => {
    if (typeof node === 'string') return NON_FINITE_SYMBOLS.has(node);
    if (typeof node === 'number') return !Number.isFinite(node);
    if (Array.isArray(node)) return (Array.from(node) as MathJsonExpression[]).some(nonFinite);
    if (node && typeof node === 'object') {
      if ('num' in node) return !/^[-+]?[0-9.]/.test(String(node.num)) || !Number.isFinite(Number(String(node.num).replace(/[({].*$/, '')));
      if ('sym' in node) return NON_FINITE_SYMBOLS.has(String(node.sym));
      if ('fn' in node) return (node.fn as MathJsonExpression[]).some(nonFinite);
    }
    return false;
  };
  if (nonFinite(expression)) {
    throw new MathEngineError('undefined-result', 'The result is undefined (for example a division by zero).');
  }
}

function mathJsonNumber(expression: MathJsonExpression): number | null {
  if (typeof expression === 'number') return Number.isFinite(expression) ? expression : null;
  if (expression && !Array.isArray(expression) && typeof expression === 'object' && 'num' in expression) {
    const parsed = Number(expression.num);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function success(
  parsed: InspectedMathExpression,
  value: MathValue | null,
  solutions: readonly MathSolution[],
): MathEvaluationSuccess {
  return {
    status: 'ok',
    sourceLatex: parsed.sourceLatex,
    dependencies: parsed.dependencies,
    value,
    solutions,
  };
}

function isCancellationError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'CancellationError' || error.message.toLowerCase().includes('time limit'));
}

export function normalizeEngineError(error: unknown): MathEngineError {
  if (error instanceof MathEngineError) return error;
  return new MathEngineError('evaluation-failed', error instanceof Error ? error.message : 'Unknown math engine failure.', {
    cause: error,
  });
}
