import { describe, expect, it } from 'vitest';
import { LocalMathEngine } from '../engine';
import { effectiveLatex } from './effectiveLatex';
import { MathPageController, type MathPageEnginePort } from './recompute';
import { inkMathElement, mathElement, page, TEST_TIME } from './testFixtures';

describe('effectiveLatex', () => {
  it('uses corrected, then recognized, then typed LaTeX', () => {
    expect(effectiveLatex({ correctedLatex: 'c', recognizedLatex: 'r', typedLatex: 't' })).toBe('c');
    expect(effectiveLatex({ recognizedLatex: 'r', typedLatex: 't' })).toBe('r');
    expect(effectiveLatex({ typedLatex: 't' })).toBe('t');
    expect(effectiveLatex({ correctedLatex: ' ', recognizedLatex: '', typedLatex: 't' })).toBe('t');
  });
});

describe('MathPageController', () => {
  it('evaluates in y/x/id order and writes complete results and dependencies', async () => {
    const source = page([
      mathElement('result', 'b+1', { y: 20 }),
      mathElement('b', 'b=a+3', { x: 20, y: 10 }),
      mathElement('a', 'a=2', { x: 10, y: 10 }),
    ]);
    const controller = new MathPageController({ now: () => TEST_TIME });
    const recomputed = await controller.recompute(source);
    expect(recomputed.recomputedElementIds).toEqual(['a', 'b', 'result']);
    const result = recomputed.page.elementsById.result;
    if (result.kind !== 'math') throw new Error('expected Math result');
    expect(result.result).toMatchObject({ state: 'valid', exactLatex: '6', decimalText: '6' });
    expect(result.result.sourceFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.dependencies).toMatchObject({
      references: ['b'],
      dependsOnElementIds: ['b'],
      state: 'valid',
    });
    expect(result.dependencies.sourceFingerprint).toBe(result.result.sourceFingerprint);
  });

  it('does not report a blank valid result for an equation with no solution', async () => {
    const controller = new MathPageController({ now: () => TEST_TIME });
    const recomputed = await controller.recompute(page([mathElement('e', 'x+1=x+2')]));
    const element = recomputed.page.elementsById.e;
    if (element.kind !== 'math') throw new Error('expected Math result');
    // An empty solution set must not surface as a blank, seemingly-valid result.
    expect(element.result.state).not.toBe('valid');
    expect(element.result.state).toBe('error');
    expect(element.result.diagnostics.join(' ')).toMatch(/solution/i);
  });

  it('marks undefined variables and cycles deterministically', async () => {
    const controller = new MathPageController({ now: () => TEST_TIME });
    const undefinedResult = await controller.recompute(page([
      mathElement('use', 'a+1', { y: 0 }),
      mathElement('a', 'a=2', { y: 10 }),
    ]));
    const use = undefinedResult.page.elementsById.use;
    if (use.kind !== 'math') throw new Error('expected Math use');
    expect(use.dependencies.state).toBe('undefined');
    expect(use.result.diagnostics[0]).toMatch(/^undefined-variable:/);

    const cycleResult = await controller.recompute(page([
      mathElement('a', 'a=b+1', { y: 0 }),
      mathElement('b', 'b=a+1', { y: 10 }),
      mathElement('use', 'a+b', { y: 20 }),
    ]));
    for (const id of ['a', 'b', 'use']) {
      const element = cycleResult.page.elementsById[id];
      if (element.kind !== 'math') throw new Error('expected Math cycle member');
      expect(element.dependencies.state).toBe('cycle');
      expect(element.result.diagnostics[0]).toMatch(/^cyclic-dependency:/);
    }
  });

  it('never modifies original ink while deriving results', async () => {
    const ink = { ...inkMathElement(), recognizedLatex: '2+2' };
    const rawInk = ink.rawInk;
    const result = await new MathPageController({ now: () => TEST_TIME }).recompute(page([ink]));
    const derived = result.page.elementsById[ink.id];
    if (derived.kind !== 'math') throw new Error('expected ink Math element');
    expect(derived.rawInk).toBe(rawInk);
    expect(derived.result.exactLatex).toBe('4');
  });

  it('recomputes a stored result from an older engine version instead of reusing it', async () => {
    const controller = new MathPageController({ now: () => TEST_TIME });
    const first = await controller.recompute(page([mathElement('e', '2+2')]));
    const element = first.page.elementsById.e;
    if (element.kind !== 'math') throw new Error('expected Math element');
    // A result cached by an older engine build may carry a defect that the
    // current engine fixes; the fingerprint alone must not keep it alive.
    const stale = {
      ...first.page,
      elementsById: {
        ...first.page.elementsById,
        e: { ...element, result: { ...element.result, engineVersion: 'obsolete-engine@0' } },
      },
    };
    const second = await controller.recompute(stale);
    expect(second.reusedElementIds).not.toContain('e');
    expect(second.recomputedElementIds).toContain('e');
    const recomputed = second.page.elementsById.e;
    if (recomputed.kind !== 'math') throw new Error('expected recomputed Math element');
    expect(recomputed.result.engineVersion).not.toBe('obsolete-engine@0');
  });

  it('reuses stable fingerprints and recomputes only the changed independent branch', async () => {
    const real = new LocalMathEngine();
    let evaluations = 0;
    const counting: MathPageEnginePort = {
      inspect: (latex, angleMode) => real.inspect(latex, angleMode),
      evaluateOrThrow: (latex, options) => {
        evaluations += 1;
        return real.evaluateOrThrow(latex, options);
      },
    };
    const controller = new MathPageController({ engine: counting, now: () => TEST_TIME });
    const first = await controller.recompute(page([
      mathElement('a', 'a=2', { y: 0 }),
      mathElement('dependent', 'a+1', { y: 10 }),
      mathElement('independent', '7', { y: 20 }),
    ]));
    expect(evaluations).toBe(3);
    const second = await controller.recompute(first.page);
    expect(evaluations).toBe(3);
    expect(second.reusedElementIds).toEqual(['a', 'dependent', 'independent']);

    const independent = second.page.elementsById.independent;
    if (independent.kind !== 'math') throw new Error('expected independent Math element');
    const changedPage = {
      ...second.page,
      elementsById: {
        ...second.page.elementsById,
        independent: { ...independent, typedLatex: '8' },
      },
    };
    const third = await controller.recompute(changedPage);
    expect(evaluations).toBe(4);
    expect(third.reusedElementIds).toEqual(['a', 'dependent']);
    expect(third.recomputedElementIds).toEqual(['independent']);
  });
});
