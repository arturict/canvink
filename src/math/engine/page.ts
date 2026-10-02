import { normalizeEngineError, sharedMathEngine, type InspectedMathExpression, type LocalMathEngine } from './compute';
import {
  MathEngineError,
  type PageEvaluationOptions,
  type PageMathInput,
  type PageMathResult,
  type SafeMathJson,
} from './types';

interface InspectedPageElement {
  readonly input: PageMathInput;
  readonly inspected?: InspectedMathExpression;
  readonly error?: MathEngineError;
}

export function evaluateMathPage(
  inputs: readonly PageMathInput[],
  options: PageEvaluationOptions = {},
  engine: LocalMathEngine = sharedMathEngine(),
): readonly PageMathResult[] {
  const ordered = [...inputs].sort(comparePagePosition);
  const inspected = ordered.map((input): InspectedPageElement => {
    try {
      return { input, inspected: engine.inspect(input.latex, options.angleMode) };
    } catch (error) {
      return { input, error: normalizeEngineError(error) };
    }
  });
  const firstDefinition = firstVariableDefinitions(inspected);
  const cycleVariables = findCycleVariables(firstDefinition);
  const values: Record<string, SafeMathJson | number> = {};
  const sourceElementIds = new Map<string, string>();

  return inspected.map((element) => {
    if (!element.inspected) {
      const error = element.error ?? new MathEngineError('evaluation-failed', 'Formula inspection failed.');
      return failureResult(element.input.id, 'expression', [], [], 'error', error);
    }

    const formula = element.inspected;
    const dependencyElementIds = formula.dependencies
      .map((variable) => sourceElementIds.get(variable) ?? firstDefinition.get(variable)?.input.id)
      .filter((id): id is string => Boolean(id));
    const cyclicDependency = formula.dependencies.find((dependency) => cycleVariables.has(dependency));
    const ownCycle = formula.assignmentVariable && cycleVariables.has(formula.assignmentVariable);
    if (ownCycle || cyclicDependency) {
      const variable = ownCycle ? formula.assignmentVariable : cyclicDependency;
      return failureResult(
        element.input.id,
        formula.kind,
        formula.dependencies,
        dependencyElementIds,
        'cycle',
        new MathEngineError('cyclic-dependency', `Cyclic variable dependency: ${variable}`),
        formula.assignmentVariable,
      );
    }

    const undefinedVariables = formula.kind === 'equation'
      ? []
      : formula.dependencies.filter((dependency) => !(dependency in values));
    if (undefinedVariables.length > 0) {
      return failureResult(
        element.input.id,
        formula.kind,
        formula.dependencies,
        dependencyElementIds,
        'undefined',
        new MathEngineError('undefined-variable', `Undefined variable: ${undefinedVariables.join(', ')}`),
        formula.assignmentVariable,
      );
    }

    try {
      const evaluated = engine.evaluateOrThrow(element.input.latex, {
        angleMode: options.angleMode,
        variables: values,
      });
      if (formula.kind === 'assignment' && formula.assignmentVariable && evaluated.value) {
        values[formula.assignmentVariable] = evaluated.value.exactMathJson;
        sourceElementIds.set(formula.assignmentVariable, element.input.id);
      }
      return {
        id: element.input.id,
        kind: formula.kind,
        status: 'ok',
        ...(formula.assignmentVariable ? { variable: formula.assignmentVariable } : {}),
        dependencies: formula.dependencies,
        dependencyElementIds: [...new Set(dependencyElementIds)],
        value: evaluated.value,
        solutions: evaluated.solutions,
      };
    } catch (error) {
      return failureResult(
        element.input.id,
        formula.kind,
        formula.dependencies,
        dependencyElementIds,
        'error',
        normalizeEngineError(error),
        formula.assignmentVariable,
      );
    }
  });
}

function comparePagePosition(left: PageMathInput, right: PageMathInput): number {
  const leftY = Number.isFinite(left.y) ? left.y : Number.POSITIVE_INFINITY;
  const rightY = Number.isFinite(right.y) ? right.y : Number.POSITIVE_INFINITY;
  if (leftY !== rightY) return leftY - rightY;
  const leftX = Number.isFinite(left.x) ? left.x : Number.POSITIVE_INFINITY;
  const rightX = Number.isFinite(right.x) ? right.x : Number.POSITIVE_INFINITY;
  if (leftX !== rightX) return leftX - rightX;
  return left.id.localeCompare(right.id, 'en');
}

function firstVariableDefinitions(
  elements: readonly InspectedPageElement[],
): ReadonlyMap<string, InspectedPageElement & { readonly inspected: InspectedMathExpression }> {
  const definitions = new Map<string, InspectedPageElement & { readonly inspected: InspectedMathExpression }>();
  for (const element of elements) {
    const variable = element.inspected?.assignmentVariable;
    if (variable && !definitions.has(variable)) {
      definitions.set(variable, element as InspectedPageElement & { readonly inspected: InspectedMathExpression });
    }
  }
  return definitions;
}

function findCycleVariables(
  definitions: ReadonlyMap<string, InspectedPageElement & { readonly inspected: InspectedMathExpression }>,
): ReadonlySet<string> {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const cyclic = new Set<string>();

  const visit = (variable: string): void => {
    if (visited.has(variable)) return;
    if (visiting.has(variable)) {
      const cycleStart = stack.lastIndexOf(variable);
      for (const item of stack.slice(cycleStart)) cyclic.add(item);
      return;
    }
    visiting.add(variable);
    stack.push(variable);
    const dependencies = definitions.get(variable)?.inspected.dependencies ?? [];
    for (const dependency of dependencies) {
      if (definitions.has(dependency)) visit(dependency);
    }
    stack.pop();
    visiting.delete(variable);
    visited.add(variable);
  };

  for (const variable of definitions.keys()) visit(variable);
  return cyclic;
}

function failureResult(
  id: string,
  kind: PageMathResult['kind'],
  dependencies: readonly string[],
  dependencyElementIds: readonly string[],
  status: 'error' | 'undefined' | 'cycle',
  error: MathEngineError,
  variable?: string,
): PageMathResult {
  return {
    id,
    kind,
    status,
    ...(variable ? { variable } : {}),
    dependencies,
    dependencyElementIds: [...new Set(dependencyElementIds)],
    value: null,
    solutions: [],
    error: { code: error.code, message: error.message },
  };
}
