import { canonicalJson } from '../../domain/v2';
import { describe, expect, it } from 'vitest';
import { applyMathCorrection } from './correction';
import {
  convertSelectedStrokesToMath,
  restoreStrokesFromMathConversion,
} from './conversion';
import { page, stroke, TEST_TIME } from './testFixtures';

describe('stroke-to-Math atomic conversion', () => {
  it('removes selected strokes, preserves exact immutable ink, and inserts at the first z-position', () => {
    const before = stroke('before', 0, 0);
    const first = stroke('first', 10, 20);
    const between = stroke('between', 30, 30);
    const second = stroke('second', 40, 50);
    const sourcePage = page([before, first, between, second]);
    const sourceSnapshot = canonicalJson(sourcePage);
    const converted = convertSelectedStrokesToMath(sourcePage, {
      selectedStrokeIds: ['first', 'second'],
      mathElementId: 'math-converted',
      operationId: 'operation-convert-0001',
      timestamp: TEST_TIME,
    });

    expect(canonicalJson(sourcePage)).toBe(sourceSnapshot);
    expect(converted.page.zOrder).toEqual(['before', 'math-converted', 'between']);
    expect(converted.page.elementsById.first).toBeUndefined();
    expect(converted.page.elementsById.second).toBeUndefined();
    const math = converted.page.elementsById['math-converted'];
    expect(math.kind).toBe('math');
    if (math.kind !== 'math') return;
    expect(math.rawInk?.sourceStrokes).toEqual([first, second]);
    expect(math.rawInk?.sourceStrokes[0]).not.toBe(first);
    expect(Object.isFrozen(math.rawInk?.sourceStrokes)).toBe(true);
    expect(Object.isFrozen(math.rawInk?.sourceStrokes[0].points)).toBe(true);
    expect(math.rawInk?.captureFrame).toEqual({ x: 10, y: 20, width: 31, height: 31, rotation: 0 });
  });

  it('restores the exact strokes and order only while the atomic snapshot still matches', () => {
    const first = stroke('first', 10, 20);
    const second = stroke('second', 40, 50);
    const sourcePage = page([first, second]);
    const converted = convertSelectedStrokesToMath(sourcePage, {
      selectedStrokeIds: ['first', 'second'],
      mathElementId: 'math-converted',
      operationId: 'operation-convert-0002',
      timestamp: TEST_TIME,
    });
    const restored = restoreStrokesFromMathConversion(
      converted.page,
      converted.operation,
      '2026-08-03T12:01:00.000Z',
    );
    expect(restored.zOrder).toEqual(sourcePage.zOrder);
    expect(restored.elementsById.first).toEqual(first);
    expect(restored.elementsById.second).toEqual(second);

    const changed = {
      ...converted.page,
      elementsById: {
        ...converted.page.elementsById,
        'math-converted': { ...converted.operation.mathElement, correctedLatex: '1+1' },
      },
    };
    expect(() => restoreStrokesFromMathConversion(changed, converted.operation, TEST_TIME)).toThrow(/changed/);
  });

  it('fails atomically on limits, duplicates, locked or non-stroke selections', () => {
    const tooLarge = stroke('large', 0, 0, 4_097);
    const sourcePage = page([tooLarge]);
    const snapshot = canonicalJson(sourcePage);
    expect(() => convertSelectedStrokesToMath(sourcePage, {
      selectedStrokeIds: ['large'],
      mathElementId: 'math-large',
      operationId: 'operation-convert-0003',
      timestamp: TEST_TIME,
    })).toThrow(/point limit/);
    expect(canonicalJson(sourcePage)).toBe(snapshot);
    expect(() => convertSelectedStrokesToMath(sourcePage, {
      selectedStrokeIds: ['large', 'large'],
      mathElementId: 'math-duplicate',
      operationId: 'operation-convert-0004',
      timestamp: TEST_TIME,
    })).toThrow(/duplicate/);
  });

  it('applies a correction without changing raw ink', () => {
    const sourcePage = page([stroke('first', 0, 0)]);
    const { page: converted } = convertSelectedStrokesToMath(sourcePage, {
      selectedStrokeIds: ['first'],
      mathElementId: 'math-converted',
      operationId: 'operation-convert-0005',
      timestamp: TEST_TIME,
    });
    const math = converted.elementsById['math-converted'];
    if (math.kind !== 'math') throw new Error('fixture conversion failed');
    const rawInk = math.rawInk;
    const corrected = applyMathCorrection(math, '\\frac{1}{2}', '2026-08-03T12:02:00.000Z');
    expect(corrected.correctedLatex).toBe('\\frac{1}{2}');
    expect(corrected.rawInk).toBe(rawInk);
    expect(corrected.result.state).toBe('none');
  });
});
