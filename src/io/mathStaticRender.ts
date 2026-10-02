import type { GraphElementV3, MathElementV3, PageElementV3 } from '../domain/v3';
import { evaluateMathPage, prepareGraphExpression, sampleGraphExpression, splitExplicitGraphPoints } from '../math/engine';

export const MATH_STATIC_RENDER_LIMITS = Object.freeze({
  latexCharacters: 4_096,
  resultCharacters: 4_096,
  visibleSeries: 8,
  samplesPerSeries: 96,
  totalPoints: 768,
});

export interface StaticPoint {
  x: number;
  y: number;
}

export interface StaticMathRenderPlan {
  kind: 'math';
  latex: string;
  result?: string;
}

export interface StaticGraphSeriesRenderPlan {
  id: string;
  color: string;
  label: string;
  polylines: StaticPoint[][];
}

export interface StaticGraphRenderPlan {
  kind: 'graph';
  viewport: GraphElementV3['viewport'];
  series: StaticGraphSeriesRenderPlan[];
}

export function preferredMathLatex(element: MathElementV3): string {
  return bounded(element.correctedLatex ?? element.recognizedLatex ?? element.typedLatex ?? '', MATH_STATIC_RENDER_LIMITS.latexCharacters);
}

export function visibleMathResult(element: MathElementV3, numberMode: 'exact' | 'decimal' = 'exact'): string | undefined {
  if (element.result.state !== 'valid') return undefined;
  const preferred = numberMode === 'decimal'
    ? element.result.decimalText ?? element.result.exactLatex
    : element.result.exactLatex ?? element.result.decimalText;
  return preferred === undefined ? undefined : bounded(preferred, MATH_STATIC_RENDER_LIMITS.resultCharacters);
}

export function buildStaticMathRenderPlan(
  element: MathElementV3,
  numberMode: 'exact' | 'decimal' = 'exact',
): StaticMathRenderPlan {
  const result = visibleMathResult(element, numberMode);
  return { kind: 'math', latex: preferredMathLatex(element), ...(result ? { result } : {}) };
}

export function buildStaticGraphRenderPlan(
  graph: GraphElementV3,
  elementsById: Readonly<Record<string, PageElementV3>>,
  angleMode: 'degrees' | 'radians' = 'degrees',
): StaticGraphRenderPlan {
  const variables = pageVariables(elementsById, angleMode);
  let totalPoints = 0;
  const series: StaticGraphSeriesRenderPlan[] = [];
  for (const candidate of graph.series) {
    if (!candidate.visible || series.length >= MATH_STATIC_RENDER_LIMITS.visibleSeries) continue;
    const source = elementsById[candidate.sourceMathElementId];
    if (!source || source.kind !== 'math') continue;
    const label = preferredMathLatex(source);
    const polylines: StaticPoint[][] = [];
    try {
      const prepared = prepareGraphExpression(label, { angleMode });
      const sampled = sampleGraphExpression(prepared, {
        minX: graph.viewport.xMin,
        maxX: graph.viewport.xMax,
        minY: graph.viewport.yMin,
        maxY: graph.viewport.yMax,
        samples: MATH_STATIC_RENDER_LIMITS.samplesPerSeries,
        gridSize: 33,
        variables,
        maxOperations: 500_000,
        maxEvaluationMs: 100,
      });
      const sampledLines = sampled.kind === 'implicit'
        ? sampled.paths
        : splitExplicitGraphPoints(sampled.points, {
          minY: graph.viewport.yMin,
          maxY: graph.viewport.yMax,
        });
      for (const line of sampledLines) {
        const remaining = MATH_STATIC_RENDER_LIMITS.totalPoints - totalPoints;
        if (remaining < 2) break;
        const finite = line.slice(0, remaining)
          .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
        if (finite.length >= 2) {
          polylines.push(finite);
          totalPoints += finite.length;
        }
      }
    } catch {
      // Unsupported, undefined, or over-budget sources remain passive empty series.
    }
    series.push({ id: candidate.id, color: safeColor(candidate.color), label, polylines });
  }
  return { kind: 'graph', viewport: structuredClone(graph.viewport), series };
}

function pageVariables(
  elementsById: Readonly<Record<string, PageElementV3>>,
  angleMode: 'degrees' | 'radians',
): Record<string, number> {
  const inputs = Object.values(elementsById)
    .filter((element): element is MathElementV3 => element.kind === 'math')
    .map((element) => ({
      id: element.id,
      x: element.frame.x,
      y: element.frame.y,
      latex: preferredMathLatex(element),
    }));
  const variables: Record<string, number> = {};
  for (const result of evaluateMathPage(inputs, { angleMode })) {
    const decimal = result.value?.decimalValue;
    if (result.status === 'ok' && result.variable && decimal !== null && decimal !== undefined && Number.isFinite(decimal)) {
      variables[result.variable] = decimal;
    }
  }
  return variables;
}

function safeColor(value: string): string {
  return /^#[0-9a-f]{6}$/i.test(value) ? value : '#1f5eff';
}

function bounded(value: string, maximum: number): string {
  return Array.from(value).slice(0, maximum).join('');
}
