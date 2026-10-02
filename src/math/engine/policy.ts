import type { MathJsonExpression } from '@cortex-js/compute-engine/math-json';
import {
  DEFAULT_MATH_ENGINE_LIMITS,
  MathEngineError,
  type AngleMode,
  type MathEngineLimits,
  type SafeMathJson,
} from './types';

const ALLOWED_COMMANDS = new Set([
  'alpha',
  'arccos',
  'arcsin',
  'arctan',
  'begin',
  'beta',
  'cdot',
  'cos',
  'delta',
  'end',
  'exp',
  'frac',
  'gamma',
  'lambda',
  'left',
  'ln',
  'log',
  'mathrm',
  'mu',
  'omega',
  'phi',
  'pi',
  'right',
  'sigma',
  'sin',
  'sqrt',
  'tan',
  'theta',
  'times',
]);

const CONSTANT_SYMBOLS = new Set(['Pi', 'ExponentialE', 'True', 'False', 'e']);
const VARIABLE_NAME = /^(?:[A-Za-z][A-Za-z0-9_]{0,31}|alpha|beta|gamma|delta|theta|lambda|mu|sigma|phi|omega)$/;

const ARITIES: Readonly<Record<string, readonly [min: number, max: number]>> = Object.freeze({
  Abs: [1, 1],
  Add: [2, 32],
  Arccos: [1, 1],
  Arcsin: [1, 1],
  Arctan: [1, 1],
  Cos: [1, 1],
  Delimiter: [1, 1],
  Divide: [2, 2],
  Equal: [2, 2],
  Exp: [1, 1],
  Factorial: [1, 1],
  InvisibleOperator: [2, 32],
  List: [1, 2],
  Ln: [1, 1],
  Log: [1, 2],
  Multiply: [2, 32],
  Negate: [1, 1],
  Power: [2, 2],
  Rational: [2, 2],
  Root: [2, 2],
  Sin: [1, 1],
  Sqrt: [1, 1],
  Subtract: [2, 2],
  Tan: [1, 1],
});

const ALLOWED_SINGLE_CHARACTER_COMMANDS = new Set(['%', ',', ';', ':', '!', ' ', '\\', '{', '}', '(', ')', '[', ']']);

export function mergeMathEngineLimits(overrides?: Partial<MathEngineLimits>): MathEngineLimits {
  const merged = { ...DEFAULT_MATH_ENGINE_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(merged)) {
    if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
      throw new MathEngineError('invalid-number', `Invalid positive integer limit: ${name}`);
    }
  }
  return Object.freeze(merged);
}

export function assertSafeLatex(latex: string, limits: MathEngineLimits): void {
  if (latex.length === 0) throw new MathEngineError('unsafe-latex', 'The formula is empty.');
  if (latex.length > limits.maxLatexLength) {
    throw new MathEngineError('input-too-long', `Formula exceeds ${limits.maxLatexLength} characters.`);
  }
  for (const char of latex) {
    const code = char.charCodeAt(0);
    if (code !== 9 && code !== 10 && code !== 13 && (code < 32 || code > 126)) {
      throw new MathEngineError('unsafe-latex', 'Only normalized ASCII LaTeX is accepted by the local engine.');
    }
  }
  if (/[<>"'`|@#$]/.test(latex)) {
    throw new MathEngineError('unsafe-latex', 'The formula contains forbidden markup or control characters.');
  }
  if (/(^|[^\\])%/.test(latex)) {
    throw new MathEngineError('unsafe-latex', 'Unescaped LaTeX comments are not accepted.');
  }
  if (/!!/.test(latex)) {
    throw new MathEngineError('unsupported-expression', 'Double factorial is outside the supported scope.');
  }

  let braceDepth = 0;
  for (let index = 0; index < latex.length; index += 1) {
    const char = latex[index];
    if (char === '{') {
      braceDepth += 1;
      if (braceDepth > limits.maxAstDepth) {
        throw new MathEngineError('budget-exceeded', 'LaTeX nesting exceeds the configured depth budget.');
      }
    } else if (char === '}') {
      braceDepth -= 1;
      if (braceDepth < 0) throw new MathEngineError('unsafe-latex', 'Unbalanced LaTeX braces.');
    }
    if (char !== '\\') continue;

    const remainder = latex.slice(index + 1);
    const named = remainder.match(/^([A-Za-z]+)/);
    if (named) {
      const command = named[1];
      if (!ALLOWED_COMMANDS.has(command)) {
        throw new MathEngineError('unsafe-latex', `Unsupported LaTeX command: \\${command}`);
      }
      index += command.length;
      continue;
    }
    const escaped = latex[index + 1];
    if (!escaped || !ALLOWED_SINGLE_CHARACTER_COMMANDS.has(escaped)) {
      throw new MathEngineError('unsafe-latex', 'Unsupported LaTeX escape sequence.');
    }
    index += 1;
  }
  if (braceDepth !== 0) throw new MathEngineError('unsafe-latex', 'Unbalanced LaTeX braces.');

  for (const match of latex.matchAll(/\d+/g)) {
    if (match[0].length > limits.maxNumericDigits) {
      throw new MathEngineError('budget-exceeded', 'A numeric literal exceeds the digit budget.');
    }
  }

  for (const match of latex.matchAll(/\^\s*(?:\{\s*([+-]?\d+)\s*\}|([+-]?\d+))/g)) {
    const exponent = Number(match[1] ?? match[2]);
    if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > limits.maxLiteralExponent) {
      throw new MathEngineError('budget-exceeded', `Literal exponents are limited to ${limits.maxLiteralExponent}.`);
    }
  }
  if (/\^\s*\{[^{}]*\^/.test(latex) || /\^\s*[A-Za-z0-9.]+\s*\^/.test(latex)) {
    throw new MathEngineError('budget-exceeded', 'Exponent towers are not accepted.');
  }

  for (const match of latex.matchAll(/(\d+)\s*!/g)) {
    const operand = Number(match[1]);
    if (!Number.isSafeInteger(operand) || operand > limits.maxFactorial) {
      throw new MathEngineError('budget-exceeded', `Factorials are limited to ${limits.maxFactorial}.`);
    }
  }
}

interface AstBudget {
  nodes: number;
  operations: number;
}

export function assertSafeMathJson(
  expression: MathJsonExpression,
  limits: MathEngineLimits,
): asserts expression is SafeMathJson {
  const budget: AstBudget = { nodes: 0, operations: 0 };
  visitMathJson(expression, limits, budget, 1);
}

/**
 * Reject exact-arithmetic shapes whose known integer result can exceed the
 * configured numeric digit budget. This runs on the raw tree, before the
 * Compute Engine gets an opportunity to canonicalize or evaluate it.
 */
export function assertBoundedExactEvaluation(
  expression: MathJsonExpression,
  limits: MathEngineLimits,
): void {
  estimateExactIntegerDigits(expression, limits);
}

function estimateExactIntegerDigits(
  expression: MathJsonExpression,
  limits: MathEngineLimits,
): number | null {
  const atom = numericAtom(expression);
  if (atom !== null) return Number.isInteger(atom) ? finiteIntegerDigits(atom) : null;
  if (!Array.isArray(expression) || typeof expression[0] !== 'string') return null;
  const operands = Array.from(expression).slice(1) as MathJsonExpression[];
  const operandDigits = operands.map((operand) => estimateExactIntegerDigits(operand, limits));
  let estimated: number | null;
  switch (expression[0]) {
    case 'Delimiter':
    case 'Negate':
      estimated = operandDigits[0];
      break;
    case 'Add':
    case 'Subtract':
      estimated = operandDigits.every((digits) => digits !== null)
        ? Math.max(...(operandDigits as number[])) + Math.ceil(Math.log10(Math.max(2, operands.length)))
        : null;
      break;
    case 'InvisibleOperator':
    case 'Multiply':
      estimated = operandDigits.every((digits) => digits !== null)
        ? (operandDigits as number[]).reduce((sum, digits) => sum + digits, 0) - Math.max(0, operands.length - 1)
        : null;
      break;
    case 'Power': {
      const exponent = staticIntegerValue(operands[1]);
      if (exponent !== null && Math.abs(exponent) > limits.maxLiteralExponent) {
        throw new MathEngineError('budget-exceeded', `Exact exponents are limited to ${limits.maxLiteralExponent}.`);
      }
      estimated = operandDigits[0] !== null && exponent !== null && Number.isInteger(exponent)
        ? Math.max(1, operandDigits[0] * Math.abs(exponent))
        : null;
      break;
    }
    case 'Factorial': {
      const operand = staticIntegerValue(operands[0]);
      if (operand === null) {
        throw new MathEngineError('budget-exceeded', 'Exact factorial evaluation requires a bounded literal operand.');
      }
      if (operand < 0 || operand > limits.maxFactorial) {
        throw new MathEngineError('budget-exceeded', `Factorials are limited to integers from 0 to ${limits.maxFactorial}.`);
      }
      estimated = factorialDigits(operand);
      break;
    }
    default:
      estimated = null;
  }
  if (estimated !== null && estimated > limits.maxNumericDigits) {
    throw new MathEngineError(
      'budget-exceeded',
      `Exact arithmetic can exceed the ${limits.maxNumericDigits}-digit numeric budget.`,
    );
  }
  return estimated;
}

function staticIntegerValue(expression: MathJsonExpression): number | null {
  const atom = numericAtom(expression);
  if (atom !== null) return Number.isSafeInteger(atom) ? atom : null;
  if (!Array.isArray(expression) || typeof expression[0] !== 'string') return null;
  const operands = Array.from(expression).slice(1) as MathJsonExpression[];
  const values = operands.map(staticIntegerValue);
  if (values.some((value) => value === null)) return null;
  const integers = values as number[];
  let result: number;
  switch (expression[0]) {
    case 'Delimiter': result = integers[0]; break;
    case 'Negate': result = -integers[0]; break;
    case 'Add': result = integers.reduce((sum, value) => sum + value, 0); break;
    case 'Subtract': result = integers[0] - integers[1]; break;
    case 'InvisibleOperator':
    case 'Multiply': result = integers.reduce((product, value) => product * value, 1); break;
    default: return null;
  }
  return Number.isSafeInteger(result) ? result : null;
}

function finiteIntegerDigits(value: number): number {
  if (value === 0) return 1;
  return Math.max(1, Math.floor(Math.log10(Math.abs(value))) + 1);
}

function factorialDigits(value: number): number | null {
  if (!Number.isInteger(value) || value < 0) return null;
  let logarithm = 0;
  for (let factor = 2; factor <= value; factor += 1) logarithm += Math.log10(factor);
  return Math.floor(logarithm) + 1;
}

function visitMathJson(
  expression: MathJsonExpression,
  limits: MathEngineLimits,
  budget: AstBudget,
  depth: number,
): void {
  budget.nodes += 1;
  if (budget.nodes > limits.maxAstNodes) {
    throw new MathEngineError('budget-exceeded', 'Expression exceeds the AST node budget.');
  }
  if (depth > limits.maxAstDepth) {
    throw new MathEngineError('budget-exceeded', 'Expression exceeds the AST depth budget.');
  }

  if (typeof expression === 'number') {
    if (!Number.isFinite(expression)) throw new MathEngineError('invalid-number', 'Non-finite numbers are not accepted.');
    return;
  }
  if (typeof expression === 'string') {
    if (!CONSTANT_SYMBOLS.has(expression) && !isSafeVariableName(expression)) {
      throw new MathEngineError('unsupported-expression', `Unsupported symbol: ${expression}`);
    }
    return;
  }
  if (Array.isArray(expression)) {
    const [head, ...operands] = expression;
    if (typeof head !== 'string' || !(head in ARITIES)) {
      throw new MathEngineError('unsupported-expression', `Unsupported expression operator: ${String(head)}`);
    }
    const [min, max] = ARITIES[head];
    if (operands.length < min || operands.length > max) {
      throw new MathEngineError('unsupported-expression', `Invalid operand count for ${head}.`);
    }
    budget.operations += 1;
    if (budget.operations > limits.maxOperations) {
      throw new MathEngineError('budget-exceeded', 'Expression exceeds the operation budget.');
    }
    for (const operand of operands) visitMathJson(operand, limits, budget, depth + 1);
    assertOperatorSpecificLimits(head, operands, limits);
    return;
  }
  if (expression && typeof expression === 'object' && 'num' in expression) {
    const keys = Object.keys(expression);
    const numeric = String(expression.num);
    if (keys.some((key) => key !== 'num') || numeric.length > limits.maxNumericDigits || !isFiniteNumericString(numeric)) {
      throw new MathEngineError('invalid-number', 'Invalid or oversized numeric object.');
    }
    return;
  }
  throw new MathEngineError('unsupported-expression', 'MathJSON object form is outside the supported scope.');
}

function assertOperatorSpecificLimits(
  head: string,
  operands: readonly MathJsonExpression[],
  limits: MathEngineLimits,
): void {
  if (head === 'Factorial') {
    const operand = numericAtom(operands[0]);
    if (operand !== null && (!Number.isInteger(operand) || operand < 0 || operand > limits.maxFactorial)) {
      throw new MathEngineError('budget-exceeded', `Factorials are limited to integers from 0 to ${limits.maxFactorial}.`);
    }
  }
  if (head === 'Power') {
    const exponent = numericAtom(operands[1]);
    if (exponent !== null && Math.abs(exponent) > limits.maxLiteralExponent) {
      throw new MathEngineError('budget-exceeded', `Exponents are limited to ${limits.maxLiteralExponent}.`);
    }
  }
  if (head === 'Root') {
    const degree = numericAtom(operands[1]);
    if (degree !== null && (!Number.isInteger(degree) || degree < 1 || degree > 16)) {
      throw new MathEngineError('unsupported-expression', 'Root degree must be an integer from 1 to 16.');
    }
  }
  if (head === 'List' && operands.length > limits.maxCollectionSize) {
    throw new MathEngineError('budget-exceeded', 'Collection exceeds the configured size budget.');
  }
}

function isFiniteNumericString(value: string): boolean {
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) return false;
  return Number.isFinite(Number(value));
}

function numericAtom(expression: MathJsonExpression): number | null {
  if (typeof expression === 'number') return expression;
  if (expression && !Array.isArray(expression) && typeof expression === 'object' && 'num' in expression) {
    const value = Number(expression.num);
    return Number.isFinite(value) ? value : null;
  }
  return null;
}

export function isSafeVariableName(value: string): boolean {
  return VARIABLE_NAME.test(value) && !CONSTANT_SYMBOLS.has(value);
}

export function collectVariables(expression: MathJsonExpression): string[] {
  const variables = new Set<string>();
  const visit = (node: MathJsonExpression): void => {
    if (typeof node === 'string') {
      if (!CONSTANT_SYMBOLS.has(node) && isSafeVariableName(node)) variables.add(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const operand of node.slice(1)) visit(operand);
    }
  };
  visit(expression);
  return [...variables].sort((left, right) => left.localeCompare(right, 'en'));
}

interface NumericBudget {
  operations: number;
  readonly maxOperations: number;
  readonly deadline: number;
}

export function evaluateSafeMathJson(
  expression: SafeMathJson,
  variables: Readonly<Record<string, number>>,
  angleMode: AngleMode,
  options: { readonly maxOperations: number; readonly deadline: number },
): number {
  const budget: NumericBudget = { operations: 0, ...options };
  return evaluateNode(expression, variables, angleMode, budget);
}

function evaluateNode(
  expression: MathJsonExpression,
  variables: Readonly<Record<string, number>>,
  angleMode: AngleMode,
  budget: NumericBudget,
): number {
  budget.operations += 1;
  if (budget.operations > budget.maxOperations || Date.now() > budget.deadline) {
    throw new MathEngineError('budget-exceeded', 'Numeric evaluation exceeded its budget.');
  }
  if (typeof expression === 'number') return checkedFinite(expression);
  if (typeof expression === 'string') {
    if (expression === 'Pi') return Math.PI;
    if (expression === 'ExponentialE') return Math.E;
    const value = variables[expression];
    if (!Number.isFinite(value)) throw new MathEngineError('undefined-variable', `Undefined variable: ${expression}`);
    return value;
  }
  if (expression && !Array.isArray(expression) && typeof expression === 'object' && 'num' in expression) {
    return checkedFinite(Number(expression.num));
  }
  if (!Array.isArray(expression) || typeof expression[0] !== 'string') {
    throw new MathEngineError('unsupported-expression', 'Unsupported numeric expression.');
  }
  const head = expression[0];
  const operands = expression.slice(1);
  const value = (index: number): number => evaluateNode(operands[index], variables, angleMode, budget);
  const values = (): number[] => operands.map((operand) => evaluateNode(operand, variables, angleMode, budget));
  const toRadians = (input: number): number => (angleMode === 'degrees' ? (input * Math.PI) / 180 : input);
  const fromRadians = (input: number): number => (angleMode === 'degrees' ? (input * 180) / Math.PI : input);

  switch (head) {
    case 'Abs':
      return checkedFinite(Math.abs(value(0)));
    case 'Add':
      return checkedFinite(values().reduce((sum, operand) => sum + operand, 0));
    case 'Arccos':
      return checkedFinite(fromRadians(Math.acos(value(0))));
    case 'Arcsin':
      return checkedFinite(fromRadians(Math.asin(value(0))));
    case 'Arctan':
      return checkedFinite(fromRadians(Math.atan(value(0))));
    case 'Cos':
      return checkedFinite(Math.cos(toRadians(value(0))));
    case 'Delimiter':
      return value(0);
    case 'Divide':
    case 'Rational':
      return checkedFinite(value(0) / value(1));
    case 'Exp':
      return checkedFinite(Math.exp(value(0)));
    case 'Factorial': {
      const operand = value(0);
      if (!Number.isInteger(operand) || operand < 0 || operand > DEFAULT_MATH_ENGINE_LIMITS.maxFactorial) {
        throw new MathEngineError('budget-exceeded', 'Factorial operand is outside the safe range.');
      }
      let result = 1;
      for (let factor = 2; factor <= operand; factor += 1) result *= factor;
      return checkedFinite(result);
    }
    case 'InvisibleOperator':
    case 'Multiply':
      return checkedFinite(values().reduce((product, operand) => product * operand, 1));
    case 'Ln':
      return checkedFinite(Math.log(value(0)));
    case 'Log':
      return checkedFinite(operands.length === 2 ? Math.log(value(0)) / Math.log(value(1)) : Math.log10(value(0)));
    case 'Negate':
      return checkedFinite(-value(0));
    case 'Power':
      return checkedFinite(Math.pow(value(0), value(1)));
    case 'Root': {
      const radicand = value(0);
      const degree = value(1);
      const rooted = radicand < 0 && Number.isInteger(degree) && Math.abs(degree % 2) === 1
        ? -Math.pow(-radicand, 1 / degree)
        : Math.pow(radicand, 1 / degree);
      return checkedFinite(rooted);
    }
    case 'Sin':
      return checkedFinite(Math.sin(toRadians(value(0))));
    case 'Sqrt':
      return checkedFinite(Math.sqrt(value(0)));
    case 'Subtract':
      return checkedFinite(value(0) - value(1));
    case 'Tan':
      return checkedFinite(Math.tan(toRadians(value(0))));
    default:
      throw new MathEngineError('unsupported-expression', `Operator cannot be sampled numerically: ${head}`);
  }
}

function checkedFinite(value: number): number {
  if (!Number.isFinite(value)) throw new MathEngineError('invalid-number', 'The numeric result is not finite.');
  return Object.is(value, -0) ? 0 : value;
}
