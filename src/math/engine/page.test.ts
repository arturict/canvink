import { describe, expect, it } from 'vitest';
import { LocalMathEngine } from './compute';
import { evaluateMathPage } from './page';
import { loadComputeEngine } from '../runtime';

// The engine loads on demand in the app; these tests evaluate formulas at once.
await loadComputeEngine();

describe('evaluateMathPage', () => {
  const engine = new LocalMathEngine();

  it('sorts by y, then x, then id and evaluates variables sequentially', () => {
    const results = evaluateMathPage([
      { id: 'result', x: 0, y: 20, latex: 'b+1' },
      { id: 'b', x: 20, y: 10, latex: 'b=a+3' },
      { id: 'a', x: 10, y: 10, latex: 'a=2' },
    ], {}, engine);
    expect(results.map((result) => result.id)).toEqual(['a', 'b', 'result']);
    expect(results.map((result) => result.status)).toEqual(['ok', 'ok', 'ok']);
    expect(results[1].value?.decimalValue).toBe(5);
    expect(results[2].value?.decimalValue).toBe(6);
    expect(results[2].dependencyElementIds).toEqual(['b']);
  });

  it('marks a forward reference undefined without reordering it', () => {
    const results = evaluateMathPage([
      { id: 'use', x: 0, y: 0, latex: 'a+1' },
      { id: 'definition', x: 0, y: 10, latex: 'a=2' },
    ], {}, engine);
    expect(results[0].status).toBe('undefined');
    expect(results[0].error?.code).toBe('undefined-variable');
    expect(results[1].status).toBe('ok');
  });

  it('marks all members of a variable cycle', () => {
    const results = evaluateMathPage([
      { id: 'a', x: 0, y: 0, latex: 'a=b+1' },
      { id: 'b', x: 0, y: 10, latex: 'b=a+1' },
      { id: 'use', x: 0, y: 20, latex: 'a+b' },
    ], {}, engine);
    expect(results.map((result) => result.status)).toEqual(['cycle', 'cycle', 'cycle']);
    expect(results.every((result) => result.error?.code === 'cyclic-dependency')).toBe(true);
  });

  it('uses a later assignment only for later blocks', () => {
    const results = evaluateMathPage([
      { id: 'a-one', x: 0, y: 0, latex: 'a=1' },
      { id: 'first', x: 0, y: 10, latex: 'a+1' },
      { id: 'a-five', x: 0, y: 20, latex: 'a=5' },
      { id: 'second', x: 0, y: 30, latex: 'a+1' },
    ], {}, engine);
    expect(results[1].value?.decimalValue).toBe(2);
    expect(results[3].value?.decimalValue).toBe(6);
    expect(results[3].dependencyElementIds).toEqual(['a-five']);
  });

  it('solves equations while treating their unknown as an intentional solve variable', () => {
    const [result] = evaluateMathPage([{ id: 'equation', x: 0, y: 0, latex: 'x^2-5x+6=0' }], {}, engine);
    expect(result.status).toBe('ok');
    expect(result.solutions.map((solution) => solution.variables.x.decimalValue).sort()).toEqual([2, 3]);
  });
});
