import goldenCases from '../../../tests/fixtures/math/golden.json';
import { ComputeEngine } from '@cortex-js/compute-engine';
import { describe, expect, it, vi } from 'vitest';
import { LocalMathEngine, sharedMathEngine } from './compute';
import type { AngleMode } from './types';
import { loadComputeEngine } from '../runtime';

// The engine loads on demand in the app; these tests evaluate formulas at once.
await loadComputeEngine();

interface GoldenCase {
  readonly id: string;
  readonly latex: string;
  readonly angleMode: AngleMode;
  readonly decimal: number;
  readonly exactLatex?: string;
}

describe('LocalMathEngine golden calculations', () => {
  // These cases check results, not speed. The production limit (2 s) is a
  // wall-clock deadline that the engine's first evaluations, which load its
  // function library, miss on a machine that runs other test files in
  // parallel. The deadline itself is covered by its own tests below.
  const engine = new LocalMathEngine({ maxEvaluationMs: 30_000 });

  for (const golden of goldenCases as GoldenCase[]) {
    it(golden.id, () => {
      const result = engine.evaluate(golden.latex, { angleMode: golden.angleMode });
      expect(result).toMatchObject({ status: 'ok' });
      if (result.status !== 'ok') return;
      expect(result.value?.decimalValue).toBeCloseTo(golden.decimal, 12);
      if (golden.exactLatex) expect(result.value?.exactLatex).toBe(golden.exactLatex);
    });
  }

  it('reports division by zero as an error instead of a valid infinity', () => {
    // 1/0 must not surface as an insertable "valid" ∞̃ result in school math.
    for (const latex of ['\\frac{1}{0}', '\\frac{5}{0}', '\\frac{0}{0}', '1+\\frac{1}{0}']) {
      const result = engine.evaluate(latex);
      expect(result.status, latex).toBe('error');
      if (result.status === 'error') expect(result.error.code).toBe('undefined-result');
    }
  });

  it('keeps exact and decimal forms separate', () => {
    const result = engine.evaluate('\\frac{1}{3}');
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.value?.exactMathJson).toEqual(['Rational', 1, 3]);
    expect(result.value?.decimalValue).toBeCloseTo(1 / 3, 14);
  });

  it('solves a linear equation', () => {
    const result = engine.evaluate('2x+4=10');
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.solutions).toHaveLength(1);
    expect(result.solutions[0].variables.x.decimalValue).toBe(3);
  });

  it('solves a quadratic equation without relying on root order', () => {
    const result = engine.evaluate('x^2-5x+6=0');
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    const roots = result.solutions.map((solution) => solution.variables.x.decimalValue).sort();
    expect(roots).toEqual([2, 3]);
  });

  it('solves a two-by-two linear system', () => {
    const result = engine.evaluate('\\begin{cases}x+y=5\\\\x-y=1\\end{cases}');
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.solutions).toHaveLength(1);
    expect(result.solutions[0].variables.x.decimalValue).toBe(3);
    expect(result.solutions[0].variables.y.decimalValue).toBe(2);
  });

  it('evaluates scoped variables exactly', () => {
    const result = engine.evaluate('a+\\frac{1}{3}', { variables: { a: ['Rational', 2, 3] } });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.value?.exactMathJson).toBe(1);
  });

  it('does not require eval or Function compilation', () => {
    const evalSpy = vi.spyOn(globalThis, 'eval').mockImplementation(() => {
      throw new Error('eval must not run');
    });
    const functionSpy = vi.spyOn(globalThis, 'Function').mockImplementation(() => {
      throw new Error('Function constructor must not run');
    });
    try {
      const isolated = new LocalMathEngine();
      const result = isolated.evaluate('2+2');
      expect(result.status).toBe('ok');
      if (result.status === 'ok') expect(result.value?.decimalValue).toBe(4);
      expect(evalSpy).not.toHaveBeenCalled();
      expect(functionSpy).not.toHaveBeenCalled();
    } finally {
      evalSpy.mockRestore();
      functionSpy.mockRestore();
    }
  });

  it('keeps exact evaluation and decimal conversion inside labeled request deadline spans', () => {
    const spans = vi.spyOn(ComputeEngine.prototype, 'withTimeLimit');
    try {
      const isolated = new LocalMathEngine();
      expect(isolated.evaluate('\\frac{1}{3}').status).toBe('ok');
      expect(isolated.evaluate('a=2', { variables: {} }).status).toBe('ok');
      expect(isolated.evaluate('x^2-1=0').status).toBe('ok');
      const labels = spans.mock.calls.map(([limit]) => typeof limit === 'number' ? undefined : limit.label);
      expect(labels).toContain('canvink:request');
      expect(labels).toContain('canvink:expression-exact');
      expect(labels).toContain('canvink:expression-decimal');
      expect(labels).toContain('canvink:assignment-exact');
      expect(labels).toContain('canvink:assignment-decimal');
      expect(labels).toContain('canvink:solution-exact');
      expect(labels).toContain('canvink:solution-decimal');
    } finally {
      spans.mockRestore();
    }
  });
});

describe('LocalMathEngine adversarial policy', () => {
  const engine = new LocalMathEngine();

  it.each([
    ['macro', '\\href{https://example.test}{x}'],
    ['HTML', '<script>alert(1)</script>'],
    ['URL text', 'https://example.test/x'],
    ['Unicode confusable', '１+１'],
    ['unescaped comment', '1+1% ignored'],
    ['double factorial', '5!!'],
    ['huge factorial', '10000!'],
    ['huge power', '2^1000'],
    ['power tower', '9^9^9'],
    ['unknown command', '\\includegraphics{x}'],
  ])('rejects %s', (_label, latex) => {
    const result = engine.evaluate(latex);
    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(['unsafe-latex', 'budget-exceeded', 'unsupported-expression']).toContain(result.error.code);
    }
  });

  it('rejects oversized input before parsing', () => {
    const result = engine.evaluate('1+'.repeat(3_000) + '1');
    expect(result.status).toBe('error');
    if (result.status === 'error') expect(result.error.code).toBe('input-too-long');
  });

  it('rejects non-finite variable values', () => {
    const result = engine.evaluate('x+1', { variables: { x: Number.POSITIVE_INFINITY } });
    expect(result.status).toBe('error');
    if (result.status === 'error') expect(result.error.code).toBe('invalid-number');
  });

  it('enforces a configured AST budget', () => {
    const constrained = new LocalMathEngine({ maxAstNodes: 5 });
    const result = constrained.evaluate('1+2+3+4+5+6');
    expect(result.status).toBe('error');
    if (result.status === 'error') expect(result.error.code).toBe('budget-exceeded');
  });

  it('rejects known exact-arithmetic explosions during raw inspection', () => {
    const hugeInteger = '9'.repeat(200);
    expect(() => engine.inspect(`${hugeInteger}^2`)).toThrow(/digit numeric budget/);
    expect(() => engine.inspect('170!')).toThrow(/digit numeric budget/);
    expect(() => engine.inspect('x!')).toThrow(/bounded literal operand/);
    expect(() => engine.inspect('2^{50+51}')).toThrow(/exponents are limited/);
  });

  it('does not let exact work bypass configured numeric or operation limits', () => {
    const numericConstrained = new LocalMathEngine({ maxNumericDigits: 32 });
    const numeric = numericConstrained.evaluate('99999999999999999999^2');
    expect(numeric.status).toBe('error');
    if (numeric.status === 'error') expect(numeric.error.code).toBe('budget-exceeded');
    const scopedNumeric = numericConstrained.evaluate('x', {
      variables: { x: ['Power', { num: '99999999999999999999' }, 2] },
    });
    expect(scopedNumeric.status).toBe('error');
    if (scopedNumeric.status === 'error') expect(scopedNumeric.error.code).toBe('budget-exceeded');

    const operationConstrained = new LocalMathEngine({ maxOperations: 3 });
    const operations = operationConstrained.evaluate('(1+2)(3+4)(5+6)');
    expect(operations.status).toBe('error');
    if (operations.status === 'error') expect(operations.error.code).toBe('budget-exceeded');
  });

  it('does not release general cubic solving', () => {
    const result = engine.evaluate('x^3-1=0');
    expect(result.status).toBe('error');
    if (result.status === 'error') expect(result.error.code).toBe('unsupported-equation');
  });

  it('does not misclassify transcendental equations as degree-zero polynomials', () => {
    const result = engine.evaluate('\\sin(x)=0');
    expect(result.status).toBe('error');
    if (result.status === 'error') expect(result.error.code).toBe('unsupported-equation');
  });
});

describe('sharedMathEngine', () => {
  it('is one instance that keeps no variables from earlier calls', () => {
    const engine = sharedMathEngine();
    expect(sharedMathEngine()).toBe(engine);

    expect(engine.evaluate('x+1', { variables: { x: 2 } })).toMatchObject({ status: 'ok' });
    expect(engine.evaluate('x+1')).toMatchObject({ status: 'error', error: { code: 'undefined-variable' } });
  });
});
