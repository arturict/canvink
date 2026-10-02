import type { MathJsonExpression } from '@cortex-js/compute-engine/math-json';

export type AngleMode = 'radians' | 'degrees';

export type MathEngineErrorCode =
  | 'input-too-long'
  | 'unsafe-latex'
  | 'unsupported-expression'
  | 'budget-exceeded'
  | 'invalid-number'
  | 'undefined-variable'
  | 'cyclic-dependency'
  | 'evaluation-failed'
  | 'unsupported-equation'
  | 'undefined-result'
  | 'unit-engine-unavailable';

export class MathEngineError extends Error {
  readonly code: MathEngineErrorCode;

  constructor(code: MathEngineErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'MathEngineError';
    this.code = code;
  }
}

export interface MathEngineLimits {
  readonly maxLatexLength: number;
  readonly maxAstNodes: number;
  readonly maxAstDepth: number;
  readonly maxOperations: number;
  readonly maxEvaluationMs: number;
  readonly maxNumericDigits: number;
  readonly maxFactorial: number;
  readonly maxLiteralExponent: number;
  readonly maxCollectionSize: number;
}

export const DEFAULT_MATH_ENGINE_LIMITS: MathEngineLimits = Object.freeze({
  maxLatexLength: 4_096,
  maxAstNodes: 512,
  maxAstDepth: 32,
  maxOperations: 1_024,
  // A wall-clock guard behind the operation and AST limits, which bound the
  // actual work. It counts time the core spends elsewhere too, so it is wide
  // enough that a first evaluation (loading the function library) on a busy
  // tablet still finishes instead of showing a formula error.
  maxEvaluationMs: 2_000,
  maxNumericDigits: 256,
  maxFactorial: 170,
  maxLiteralExponent: 100,
  maxCollectionSize: 32,
});

export type SafeMathJson = MathJsonExpression;

export interface MathValue {
  readonly exactLatex: string;
  readonly decimalLatex: string;
  readonly exactMathJson: SafeMathJson;
  readonly decimalMathJson: SafeMathJson;
  readonly decimalValue: number | null;
}

export interface MathSolution {
  readonly variables: Readonly<Record<string, MathValue>>;
}

export interface MathEvaluationSuccess {
  readonly status: 'ok';
  readonly sourceLatex: string;
  readonly dependencies: readonly string[];
  readonly value: MathValue | null;
  readonly solutions: readonly MathSolution[];
}

export interface MathEvaluationFailure {
  readonly status: 'error';
  readonly sourceLatex: string;
  readonly dependencies: readonly string[];
  readonly error: {
    readonly code: MathEngineErrorCode;
    readonly message: string;
  };
}

export type MathEvaluationResult = MathEvaluationSuccess | MathEvaluationFailure;

export interface EvaluateMathOptions {
  readonly angleMode?: AngleMode;
  readonly variables?: Readonly<Record<string, SafeMathJson | number>>;
}

export interface PageMathInput {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly latex: string;
}

export type PageMathElementKind = 'assignment' | 'expression' | 'equation';

export interface PageMathResult {
  readonly id: string;
  readonly kind: PageMathElementKind;
  readonly status: 'ok' | 'error' | 'undefined' | 'cycle';
  readonly variable?: string;
  readonly dependencies: readonly string[];
  readonly dependencyElementIds: readonly string[];
  readonly value: MathValue | null;
  readonly solutions: readonly MathSolution[];
  readonly error?: {
    readonly code: MathEngineErrorCode;
    readonly message: string;
  };
}

export interface PageEvaluationOptions {
  readonly angleMode?: AngleMode;
}

export interface GraphPoint {
  readonly x: number;
  readonly y: number | null;
}

export interface GraphSampleOptions {
  readonly minX: number;
  readonly maxX: number;
  /** Required for implicit equations. Explicit graphs ignore these bounds. */
  readonly minY?: number;
  readonly maxY?: number;
  readonly samples?: number;
  /** Number of vertices per axis for implicit sampling (3 through 129). */
  readonly gridSize?: number;
  readonly variables?: Readonly<Record<string, number>>;
  readonly maxOperations?: number;
  readonly maxEvaluationMs?: number;
}

export interface ExplicitGraphSampleResult {
  readonly kind: 'explicit';
  readonly points: readonly GraphPoint[];
  readonly invalidPointCount: number;
}

export interface ImplicitGraphPoint {
  readonly x: number;
  readonly y: number;
}

export interface ImplicitGraphSampleResult {
  readonly kind: 'implicit';
  /** Kept empty so existing explicit renderers fail closed until they handle `paths`. */
  readonly points: readonly [];
  readonly paths: readonly (readonly ImplicitGraphPoint[])[];
  readonly invalidPointCount: number;
  readonly gridSize: number;
}

export type GraphSampleResult = ExplicitGraphSampleResult | ImplicitGraphSampleResult;
