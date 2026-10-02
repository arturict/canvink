import { canonicalJson, sha256Canonical } from '../../domain/v2';
import {
  mathPageSettings,
  type MathDependenciesV1,
  type MathElementV3,
  type MathResultV1,
  type PageDocV3,
} from '../../domain/v3';
import {
  LocalMathEngine,
  normalizeEngineError,
  type InspectedMathExpression,
  type MathEvaluationSuccess,
  type SafeMathJson,
} from '../engine';
import { loadComputeEngine } from '../runtime';
import { effectiveLatex } from './effectiveLatex';

export interface MathPageEnginePort {
  inspect(latex: string, angleMode?: 'degrees' | 'radians'): InspectedMathExpression;
  evaluateOrThrow(
    latex: string,
    options?: {
      angleMode?: 'degrees' | 'radians';
      variables?: Readonly<Record<string, SafeMathJson | number>>;
    },
  ): MathEvaluationSuccess;
}

export interface MathPageRecomputeResult {
  readonly page: PageDocV3;
  readonly updatedElementIds: readonly string[];
  readonly recomputedElementIds: readonly string[];
  readonly reusedElementIds: readonly string[];
}

interface InspectedElement {
  readonly element: MathElementV3;
  readonly latex?: string;
  readonly inspected?: InspectedMathExpression;
  readonly inspectionError?: ReturnType<typeof normalizeEngineError>;
  readonly baseFingerprint: string;
}

// The +canvink suffix tracks local evaluation-behavior fixes (for example the
// non-finite-result guard); bumping it invalidates results cached under the
// older behavior even though the upstream engine version is unchanged.
const ENGINE_VERSION = '@cortex-js/compute-engine@0.100.1+canvink.1';

export class MathPageController {
  // Created on first use: building the local Compute Engine costs about
  // 100 ms, and every page mounts a controller, math or not.
  #engineInstance: MathPageEnginePort | undefined;
  readonly #now: () => string;
  readonly #assignmentValueCache = new Map<string, SafeMathJson>();

  constructor(options: {
    readonly engine?: MathPageEnginePort;
    readonly now?: () => string;
  } = {}) {
    this.#engineInstance = options.engine;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  get #engine(): MathPageEnginePort {
    this.#engineInstance ??= new LocalMathEngine();
    return this.#engineInstance;
  }

  async recompute(page: PageDocV3): Promise<MathPageRecomputeResult> {
    const settings = mathPageSettings(page);
    const ordered = mathElementsInPageOrder(page);
    if (ordered.length > 0) await loadComputeEngine();
    const inspected = await Promise.all(ordered.map(async (element): Promise<InspectedElement> => {
      const latex = effectiveLatex(element);
      let parsed: InspectedMathExpression | undefined;
      let inspectionError: ReturnType<typeof normalizeEngineError> | undefined;
      if (latex) {
        try {
          parsed = this.#engine.inspect(latex, settings.angleMode);
        } catch (error) {
          inspectionError = normalizeEngineError(error);
        }
      }
      const baseFingerprint = await sha256Canonical({
        version: 1,
        id: element.id,
        x: element.frame.x,
        y: element.frame.y,
        latex: latex ?? null,
        angleMode: settings.angleMode,
        numberMode: settings.numberMode,
        resultMode: settings.resultMode,
        inspection: parsed
          ? { kind: parsed.kind, assignmentVariable: parsed.assignmentVariable, dependencies: parsed.dependencies }
          : { error: inspectionError?.code ?? 'missing-latex' },
      });
      return { element, latex, inspected: parsed, inspectionError, baseFingerprint };
    }));

    const firstDefinitions = firstVariableDefinitions(inspected);
    const cycleVariables = findCycleVariables(firstDefinitions);
    const cycleSignature = await sha256Canonical([...cycleVariables].sort().map((variable) => ({
      variable,
      elementId: firstDefinitions.get(variable)?.element.id,
      fingerprint: firstDefinitions.get(variable)?.baseFingerprint,
    })));
    const values: Record<string, SafeMathJson | number> = {};
    const latestDefinitions = new Map<string, { id: string; sourceFingerprint: string }>();
    const sourceFingerprintById = new Map<string, string>();
    const nextElements = { ...page.elementsById };
    const updatedElementIds: string[] = [];
    const recomputedElementIds: string[] = [];
    const reusedElementIds: string[] = [];

    for (const item of inspected) {
      const formula = item.inspected;
      const references = formula?.dependencies ?? [];
      const dependencyElementIds = references
        .map((variable) => latestDefinitions.get(variable)?.id ?? firstDefinitions.get(variable)?.element.id)
        .filter((id): id is string => Boolean(id));
      const upstreamFingerprints = dependencyElementIds.map((id) =>
        sourceFingerprintById.get(id)
        ?? inspected.find((candidate) => candidate.element.id === id)?.baseFingerprint
        ?? 'missing',
      );
      const ownCycle = formula?.assignmentVariable && cycleVariables.has(formula.assignmentVariable);
      const cyclicReference = references.find((variable) => cycleVariables.has(variable));
      const undefinedVariables = formula?.kind === 'equation'
        ? []
        : references.filter((variable) => !(variable in values));
      const semanticState = ownCycle || cyclicReference
        ? 'cycle'
        : undefinedVariables.length > 0
          ? 'undefined'
          : item.inspectionError
            ? `error:${item.inspectionError.code}`
            : item.latex
              ? 'evaluate'
              : 'missing-latex';
      const sourceFingerprint = await sha256Canonical({
        version: 1,
        baseFingerprint: item.baseFingerprint,
        semanticState,
        dependencyElementIds,
        upstreamFingerprints,
        ...(ownCycle || cyclicReference ? { cycleSignature } : {}),
      });
      sourceFingerprintById.set(item.element.id, sourceFingerprint);

      const expectedDependencyState: MathDependenciesV1['state'] = ownCycle || cyclicReference
        ? 'cycle'
        : undefinedVariables.length > 0
          ? 'undefined'
          : 'valid';
      const canReuse =
        item.element.result.sourceFingerprint === sourceFingerprint
        && item.element.result.engineVersion === ENGINE_VERSION
        && item.element.dependencies.sourceFingerprint === sourceFingerprint
        && item.element.dependencies.state === expectedDependencyState
        && (!formula?.assignmentVariable || this.#assignmentValueCache.has(sourceFingerprint));

      if (canReuse) {
        reusedElementIds.push(item.element.id);
        if (formula?.assignmentVariable) {
          const cached = this.#assignmentValueCache.get(sourceFingerprint);
          if (cached !== undefined) {
            values[formula.assignmentVariable] = cached;
            latestDefinitions.set(formula.assignmentVariable, { id: item.element.id, sourceFingerprint });
          }
        }
        continue;
      }

      recomputedElementIds.push(item.element.id);
      const dependencies: MathDependenciesV1 = {
        sourceFingerprint,
        defines: formula?.assignmentVariable ? [formula.assignmentVariable] : [],
        references: [...references],
        dependsOnElementIds: [...new Set(dependencyElementIds.filter((id) => id !== item.element.id))],
        state: expectedDependencyState,
      };
      let result: MathResultV1;

      if (!item.latex) {
        result = errorResult(sourceFingerprint, 'missing-latex', 'The Math block has no effective formula.');
      } else if (item.inspectionError) {
        result = errorResult(sourceFingerprint, item.inspectionError.code, item.inspectionError.message);
      } else if (ownCycle || cyclicReference) {
        result = errorResult(sourceFingerprint, 'cyclic-dependency', 'The formula participates in a variable cycle.');
      } else if (undefinedVariables.length > 0) {
        result = errorResult(sourceFingerprint, 'undefined-variable', `Undefined variable: ${undefinedVariables.join(', ')}`);
      } else {
        try {
          const evaluated = this.#engine.evaluateOrThrow(item.latex, {
            angleMode: settings.angleMode,
            variables: values,
          });
          result = resultFromEvaluation(evaluated, sourceFingerprint, settings.resultMode);
          if (formula?.assignmentVariable && evaluated.value) {
            values[formula.assignmentVariable] = evaluated.value.exactMathJson;
            this.#assignmentValueCache.set(sourceFingerprint, evaluated.value.exactMathJson);
            latestDefinitions.set(formula.assignmentVariable, { id: item.element.id, sourceFingerprint });
          }
        } catch (error) {
          const normalized = normalizeEngineError(error);
          result = errorResult(sourceFingerprint, normalized.code, normalized.message);
        }
      }

      const nextElement: MathElementV3 = {
        ...item.element,
        updatedAt: this.#now(),
        result,
        dependencies,
      };
      if (canonicalJson(item.element.result) !== canonicalJson(result)
        || canonicalJson(item.element.dependencies) !== canonicalJson(dependencies)) {
        nextElements[item.element.id] = nextElement;
        updatedElementIds.push(item.element.id);
      }
    }

    return {
      page: updatedElementIds.length === 0 ? page : { ...page, elementsById: nextElements, updatedAt: this.#now() },
      updatedElementIds,
      recomputedElementIds,
      reusedElementIds,
    };
  }
}

function resultFromEvaluation(
  evaluated: MathEvaluationSuccess,
  sourceFingerprint: string,
  resultMode: 'suggest' | 'insert' | 'off',
): MathResultV1 {
  if (resultMode === 'off') {
    return { state: 'none', sourceFingerprint, engineVersion: ENGINE_VERSION, diagnostics: [] };
  }
  if (evaluated.value) {
    return {
      state: 'valid',
      sourceFingerprint,
      engineVersion: ENGINE_VERSION,
      exactLatex: evaluated.value.exactLatex,
      decimalText: evaluated.value.decimalLatex,
      diagnostics: [],
    };
  }
  if (evaluated.solutions.length === 0) {
    // An empty solution set would otherwise render as a blank, seemingly-valid
    // result. The engine cannot distinguish "no solution exists" from "no
    // solution the supported scope can express", so report it honestly instead
    // of asserting an unqualified mathematical fact.
    return errorResult(
      sourceFingerprint,
      'no-solution',
      'The equation has no solution the local engine can express.',
    );
  }
  const exactLatex = evaluated.solutions.map((solution) => Object.entries(solution.variables)
    .map(([variable, value]) => `${variable}=${value.exactLatex}`).join(', ')).join('; ');
  const decimalText = evaluated.solutions.map((solution) => Object.entries(solution.variables)
    .map(([variable, value]) => `${variable}=${value.decimalLatex}`).join(', ')).join('; ');
  return {
    state: 'valid',
    sourceFingerprint,
    engineVersion: ENGINE_VERSION,
    exactLatex,
    decimalText,
    diagnostics: [],
  };
}

function errorResult(sourceFingerprint: string, code: string, message: string): MathResultV1 {
  return {
    state: 'error',
    sourceFingerprint,
    engineVersion: ENGINE_VERSION,
    diagnostics: [`${code}: ${message}`],
  };
}

function mathElementsInPageOrder(page: PageDocV3): MathElementV3[] {
  return Object.values(page.elementsById)
    .filter((element): element is MathElementV3 => element.kind === 'math')
    .sort((left, right) => left.frame.y - right.frame.y
      || left.frame.x - right.frame.x
      || left.id.localeCompare(right.id, 'en'));
}

function firstVariableDefinitions(items: readonly InspectedElement[]): ReadonlyMap<string, InspectedElement> {
  const result = new Map<string, InspectedElement>();
  for (const item of items) {
    const variable = item.inspected?.assignmentVariable;
    if (variable && !result.has(variable)) result.set(variable, item);
  }
  return result;
}

function findCycleVariables(definitions: ReadonlyMap<string, InspectedElement>): ReadonlySet<string> {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const cyclic = new Set<string>();
  const visit = (variable: string): void => {
    if (visited.has(variable)) return;
    if (visiting.has(variable)) {
      const start = stack.lastIndexOf(variable);
      for (const member of stack.slice(start)) cyclic.add(member);
      return;
    }
    visiting.add(variable);
    stack.push(variable);
    for (const dependency of definitions.get(variable)?.inspected?.dependencies ?? []) {
      if (definitions.has(dependency)) visit(dependency);
    }
    stack.pop();
    visiting.delete(variable);
    visited.add(variable);
  };
  for (const variable of definitions.keys()) visit(variable);
  return cyclic;
}
