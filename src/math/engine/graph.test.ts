import { describe, expect, it, vi } from 'vitest';
import { graphMathJsonForTesting, prepareGraphExpression, sampleGraphExpression, splitExplicitGraphPoints } from './graph';
import { loadComputeEngine } from '../runtime';

// The engine loads on demand in the app; these tests evaluate formulas at once.
await loadComputeEngine();

// These tests check the sampled geometry, not the speed. The default 100 ms
// sampling deadline is missed on a machine under parallel load, so the tests
// that expect a result pass the largest allowed deadline and keep the wall
// clock out of it. The budget itself is still tested below.
describe('safe graph sampling', () => {
  it('samples an explicit y=f(x) equation without an expression string callback', () => {
    const prepared = prepareGraphExpression('y=x^2');
    const result = sampleGraphExpression(prepared, { minX: -2, maxX: 2, samples: 5 });
    expect(result.points).toEqual([
      { x: -2, y: 4 },
      { x: -1, y: 1 },
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 4 },
    ]);
  });

  it('uses degree angle mode in the checked AST interpreter', () => {
    const prepared = prepareGraphExpression('y=\\sin(x)', { angleMode: 'degrees' });
    const result = sampleGraphExpression(prepared, { minX: 0, maxX: 180, samples: 3 });
    expect(result.points[0].y).toBeCloseTo(0, 14);
    expect(result.points[1].y).toBeCloseTo(1, 14);
    expect(result.points[2].y).toBeCloseTo(0, 14);
  });

  it('requires all referenced page variables', () => {
    const prepared = prepareGraphExpression('y=a x+1');
    expect(() => sampleGraphExpression(prepared, { minX: 0, maxX: 1, samples: 2 })).toThrow(/Undefined graph variable/);
    const result = sampleGraphExpression(prepared, {
      minX: 0,
      maxX: 1,
      samples: 2,
      variables: { a: 2 },
    });
    expect(result.points.map((point) => point.y)).toEqual([1, 3]);
  });

  it('marks discontinuities instead of returning non-finite coordinates', () => {
    const prepared = prepareGraphExpression('y=\\frac{1}{x}');
    const result = sampleGraphExpression(prepared, { minX: -1, maxX: 1, samples: 3 });
    expect(result.points[1]).toEqual({ x: 0, y: null });
    expect(result.invalidPointCount).toBe(1);
  });

  it('does not connect an off-grid pole between two finite samples', () => {
    const sampled = sampleGraphExpression(prepareGraphExpression('y=1/(x-0.03)'), {
      minX: -1,
      maxX: 1,
      samples: 258,
      maxEvaluationMs: 5_000,
    });
    if (sampled.kind !== 'explicit') throw new Error('Expected explicit samples.');
    const lines = splitExplicitGraphPoints(sampled.points, { minY: -10, maxY: 10 });
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines.every((line) => line.every((point) => point.y >= -10 && point.y <= 10))).toBe(true);
    expect(lines.some((line) => line.some((point) => point.x < 0.03) && line.some((point) => point.x > 0.03))).toBe(false);
  });

  it('rejects forged prepared objects', () => {
    expect(() => sampleGraphExpression({
      kind: 'explicit',
      sourceLatex: 'x',
      independentVariable: 'x',
      dependentVariable: 'y',
      dependencies: [],
      angleMode: 'radians',
    }, { minX: 0, maxX: 1 })).toThrow(/not prepared/);
  });

  it('enforces sample and operation budgets', () => {
    const prepared = prepareGraphExpression('y=x^2');
    expect(() => sampleGraphExpression(prepared, { minX: 0, maxX: 1, samples: 10_000 })).toThrow(/sample count/);
    expect(() => sampleGraphExpression(prepared, {
      minX: 0,
      maxX: 1,
      samples: 100,
      maxOperations: 100,
    })).toThrow(/operation budget|exceeded its budget/);
  });

  it('samples a circle as finite implicit paths close to the checked equation', () => {
    const prepared = prepareGraphExpression('x^2+y^2=1');
    expect(prepared.kind).toBe('implicit');
    expect(graphMathJsonForTesting(prepared)).toEqual([
      'Subtract',
      ['Add', ['Power', 'x', 2], ['Power', 'y', 2]],
      1,
    ]);
    const result = sampleGraphExpression(prepared, {
      minX: -1.5,
      maxX: 1.5,
      minY: -1.5,
      maxY: 1.5,
      gridSize: 65,
      maxEvaluationMs: 5_000,
    });
    expect(result.kind).toBe('implicit');
    if (result.kind !== 'implicit') throw new Error('Expected implicit result.');
    expect(result.paths.length).toBe(1);
    expect(result.paths[0].length).toBeGreaterThan(80);
    for (const point of result.paths[0]) {
      expect(Number.isFinite(point.x) && Number.isFinite(point.y)).toBe(true);
      expect(point.x ** 2 + point.y ** 2).toBeCloseTo(1, 2);
    }
  });

  it('samples a diagonal line and supports variables on either side of an ellipse equation', () => {
    const line = sampleGraphExpression(prepareGraphExpression('x+y=0'), {
      minX: -2,
      maxX: 2,
      minY: -2,
      maxY: 2,
      gridSize: 33,
      maxEvaluationMs: 5_000,
    });
    if (line.kind !== 'implicit') throw new Error('Expected implicit result.');
    expect(line.paths).toHaveLength(1);
    for (const point of line.paths[0]) expect(point.x + point.y).toBeCloseTo(0, 10);

    const vertical = sampleGraphExpression(prepareGraphExpression('x=1'), {
      minX: -2,
      maxX: 2,
      minY: -2,
      maxY: 2,
      gridSize: 33,
      maxEvaluationMs: 5_000,
    });
    if (vertical.kind !== 'implicit') throw new Error('Expected implicit result.');
    expect(vertical.paths).toHaveLength(1);
    for (const point of vertical.paths[0]) expect(point.x).toBeCloseTo(1, 10);

    const ellipse = sampleGraphExpression(prepareGraphExpression('x^2/a^2+y^2/b^2=r^2'), {
      minX: -4,
      maxX: 4,
      minY: -3,
      maxY: 3,
      gridSize: 65,
      maxEvaluationMs: 5_000,
      variables: { a: 3, b: 2, r: 1 },
    });
    if (ellipse.kind !== 'implicit') throw new Error('Expected implicit result.');
    expect(ellipse.paths).toHaveLength(1);
    for (const point of ellipse.paths[0]) {
      expect(point.x ** 2 / 9 + point.y ** 2 / 4).toBeCloseTo(1, 2);
    }
  });

  it('returns multiple stable paths for multiple contours', () => {
    const prepared = prepareGraphExpression('(x^2+y^2-1)(x^2+y^2-4)=0');
    // The test checks the contours, not the speed: the default 100 ms
    // deadline of a 97 x 97 grid is missed on a machine under parallel load,
    // so the largest allowed deadline keeps the wall clock out of it.
    const options = {
      minX: -2.5,
      maxX: 2.5,
      minY: -2.5,
      maxY: 2.5,
      gridSize: 97,
      maxEvaluationMs: 5_000,
    };
    const first = sampleGraphExpression(prepared, options);
    const second = sampleGraphExpression(prepared, options);
    if (first.kind !== 'implicit' || second.kind !== 'implicit') throw new Error('Expected implicit result.');
    expect(first.paths).toHaveLength(2);
    expect(second.paths).toEqual(first.paths);
  });

  it('rejects equations with no graph axis and undefined or invalid variables', () => {
    expect(() => prepareGraphExpression('a=b')).toThrow(/must reference x or y/);
    const prepared = prepareGraphExpression('x^2+y^2=r^2');
    expect(() => sampleGraphExpression(prepared, {
      minX: -2,
      maxX: 2,
      minY: -2,
      maxY: 2,
    })).toThrow(/Undefined graph variable: r/);
    expect(() => sampleGraphExpression(prepared, {
      minX: -2,
      maxX: 2,
      minY: -2,
      maxY: 2,
      variables: { r: Number.NaN },
    })).toThrow(/Invalid graph variable/);
  });

  it('bounds implicit grids, viewports, operations, and wall-clock time', () => {
    const prepared = prepareGraphExpression('x^2+y^2=1');
    expect(() => sampleGraphExpression(prepared, {
      minX: -2,
      maxX: 2,
      minY: -2,
      maxY: 2,
      gridSize: 130,
    })).toThrow(/grid size/);
    expect(() => sampleGraphExpression(prepared, {
      minX: -2_000_000,
      maxX: 2,
      minY: -2,
      maxY: 2,
    })).toThrow(/viewport/);
    expect(() => sampleGraphExpression(prepared, {
      minX: -2,
      maxX: 2,
      minY: -2,
      maxY: 2,
      gridSize: 33,
      maxOperations: 1,
    })).toThrow(/operation budget/);

    let now = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now++);
    try {
      expect(() => sampleGraphExpression(prepared, {
        minX: -2,
        maxX: 2,
        minY: -2,
        maxY: 2,
        gridSize: 3,
        maxEvaluationMs: 1,
      })).toThrow(/budget|time/i);
    } finally {
      clock.mockRestore();
    }
  });

  it('skips non-finite cells and rejects malformed or unsafe formulas without code generation', () => {
    const discontinuous = sampleGraphExpression(prepareGraphExpression('1/x=y'), {
      minX: -1,
      maxX: 1,
      minY: -2,
      maxY: 2,
      gridSize: 3,
    });
    if (discontinuous.kind !== 'implicit') throw new Error('Expected implicit result.');
    expect(discontinuous.invalidPointCount).toBe(3);
    expect(discontinuous.paths).toEqual([]);
    expect(() => prepareGraphExpression('x^2+y^2=')).toThrow();
    expect(() => prepareGraphExpression('x+\\operatorname{alert}(y)=0')).toThrow(/Unsupported LaTeX command/);

    const residual = graphMathJsonForTesting(prepareGraphExpression('x+y=0'));
    expect(Array.isArray(residual)).toBe(true);
    expect(typeof residual).not.toBe('function');
  });
});
