import { describe, expect, it } from 'vitest';
import type { GraphElementV3, MathElementV3, PageElementV3 } from '../domain/v3';
import {
  MATH_STATIC_RENDER_LIMITS,
  buildStaticGraphRenderPlan,
  buildStaticMathRenderPlan,
  preferredMathLatex,
} from './mathStaticRender';
import { loadComputeEngine } from '../math/runtime';

// The engine loads on demand in the app; these plans evaluate formulas at once.
await loadComputeEngine();

const base = {
  frame: { x: 0, y: 0, width: 200, height: 100, rotation: 0 },
  createdAt: '2026-08-03T00:00:00Z', updatedAt: '2026-08-03T00:00:00Z', locked: false,
};

function math(overrides: Partial<MathElementV3> = {}): MathElementV3 {
  return {
    ...base, id: 'math', kind: 'math', inputKind: 'typed', autoRecognition: 'inherit',
    typedLatex: 'typed', recognizedLatex: 'recognized', correctedLatex: 'y=x^2',
    recognition: { state: 'recognized', alternatives: [], warnings: [] },
    result: { state: 'valid', exactLatex: '\\frac{1}{3}', decimalText: '0.333', diagnostics: [] },
    dependencies: { defines: [], references: ['x'], dependsOnElementIds: [], state: 'valid' },
    ...overrides,
  };
}

function graph(seriesCount = 1): GraphElementV3 {
  return {
    ...base, id: 'graph', kind: 'graph',
    series: Array.from({ length: seriesCount }, (_, index) => ({
      id: `series-${index}`, sourceMathElementId: `math-${index}`, color: '#3366cc', visible: true,
    })),
    viewport: { xMin: -2, xMax: 2, yMin: -1, yMax: 4, equalScale: false, axesVisible: true, gridVisible: true },
  };
}

describe('safe static Math Canvas render plans', () => {
  it('uses corrected, recognized, then typed LaTeX and the requested visible result', () => {
    const value = math();
    expect(preferredMathLatex(value)).toBe('y=x^2');
    expect(preferredMathLatex({ ...value, correctedLatex: undefined })).toBe('recognized');
    expect(preferredMathLatex({ ...value, correctedLatex: undefined, recognizedLatex: undefined })).toBe('typed');
    expect(buildStaticMathRenderPlan(value, 'decimal')).toEqual({ kind: 'math', latex: 'y=x^2', result: '0.333' });
  });

  it('samples bounded finite polylines through the local AST engine without executable markup', () => {
    const source = math({ id: 'math-0' });
    const plan = buildStaticGraphRenderPlan(graph(), { 'math-0': source });
    expect(plan.series).toHaveLength(1);
    expect(plan.series[0].polylines.flat().length).toBeGreaterThan(2);
    expect(plan.series[0].polylines.flat().every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))).toBe(true);
    expect(plan.series[0].polylines.flat().length).toBeLessThanOrEqual(MATH_STATIC_RENDER_LIMITS.samplesPerSeries);
  });

  it('samples implicit equations into bounded finite contour paths', () => {
    const source = math({ id: 'math-0', correctedLatex: 'x^2+y^2=4' });
    const plan = buildStaticGraphRenderPlan(graph(), { 'math-0': source }, 'radians');
    const points = plan.series[0].polylines.flat();

    expect(plan.series[0].polylines.length).toBeGreaterThan(0);
    expect(points.length).toBeGreaterThan(8);
    expect(points.length).toBeLessThanOrEqual(MATH_STATIC_RENDER_LIMITS.totalPoints);
    expect(points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))).toBe(true);
    expect(points.every((point) => Math.abs(point.x ** 2 + point.y ** 2 - 4) < 0.08)).toBe(true);
  });

  it('evaluates page variables in spatial order before sampling dependent graphs', () => {
    const definition = math({
      id: 'definition',
      frame: { ...base.frame, x: 10, y: 10 },
      correctedLatex: 'a=2',
    });
    const source = math({
      id: 'math-0',
      frame: { ...base.frame, x: 10, y: 20 },
      correctedLatex: 'y=a x',
    });
    const plan = buildStaticGraphRenderPlan(graph(), { definition, 'math-0': source }, 'radians');
    const points = plan.series[0].polylines.flat();

    expect(points.length).toBeGreaterThan(20);
    expect(points.every((point) => Math.abs(point.y - 2 * point.x) < 1e-9)).toBe(true);

    const undefinedPlan = buildStaticGraphRenderPlan(graph(), { 'math-0': source }, 'radians');
    expect(undefinedPlan.series[0].polylines).toEqual([]);
  });

  it('caps visible series and returns no executable fallback for hostile or unsupported input', () => {
    const many = graph(12);
    const elements: Record<string, PageElementV3> = {};
    for (let index = 0; index < 12; index += 1) {
      elements[`math-${index}`] = math({ id: `math-${index}`, correctedLatex: '<script>alert(1)</script>' });
    }
    const plan = buildStaticGraphRenderPlan(many, elements);
    expect(plan.series).toHaveLength(MATH_STATIC_RENDER_LIMITS.visibleSeries);
    expect(plan.series.every((series) => series.polylines.length === 0)).toBe(true);
    expect(JSON.stringify(plan)).not.toContain('<svg');
  });
});
