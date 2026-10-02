import { describe, expect, it } from 'vitest';
import { listScrubbableNumbers, replaceScrubbableNumber } from './numberScrubber';
import { loadComputeEngine } from '../runtime';

// The engine loads on demand in the app; these tests evaluate formulas at once.
await loadComputeEngine();

describe('number scrubber contract', () => {
  it.each([
    ['5', [5]],
    ['a=5', [5]],
    ['2*x+3', [2, 3]],
  ])('tokenizes supported formula %s', (latex, values) => {
    expect(listScrubbableNumbers(latex).literals.map((literal) => literal.value)).toEqual(values);
  });

  it.each([
    ['5', 6, '6'],
    ['a=5', 7, 'a=7'],
  ])('commits one fingerprint-bound replacement for %s', (latex, value, expected) => {
    const listed = listScrubbableNumbers(latex);
    const replacement = replaceScrubbableNumber(latex, {
      targetId: listed.literals[0].id,
      sourceFingerprint: listed.sourceFingerprint,
      value,
    });
    expect(replacement.latex).toBe(expected);
  });

  it('requires an explicit stable target ID when multiple literals exist', () => {
    const latex = '2*x+3';
    const listed = listScrubbableNumbers(latex);
    expect(() => replaceScrubbableNumber(latex, {
      targetId: '', sourceFingerprint: listed.sourceFingerprint, value: 4,
    })).toThrow(/explicit/);
    const replaced = replaceScrubbableNumber(latex, {
      targetId: listed.literals[1].id,
      sourceFingerprint: listed.sourceFingerprint,
      value: 4,
    });
    expect(replaced.latex).toBe('2*x+4');
    expect(() => replaceScrubbableNumber('20*x+3', {
      targetId: listed.literals[1].id,
      sourceFingerprint: listed.sourceFingerprint,
      value: 4,
    })).toThrow(/source changed/);
  });

  it('preserves percent and exponent syntax', () => {
    const percent = listScrubbableNumbers('25\\%');
    expect(percent.literals[0].role).toBe('percent');
    expect(replaceScrubbableNumber('25\\%', {
      targetId: percent.literals[0].id, sourceFingerprint: percent.sourceFingerprint, value: 50,
    }).latex).toBe('50\\%');

    const exponent = listScrubbableNumbers('x^2');
    expect(exponent.literals[0].role).toBe('exponent');
    expect(replaceScrubbableNumber('x^2', {
      targetId: exponent.literals[0].id, sourceFingerprint: exponent.sourceFingerprint, value: -3,
    }).latex).toBe('x^{-3}');
    expect(() => replaceScrubbableNumber('x^2', {
      targetId: exponent.literals[0].id, sourceFingerprint: exponent.sourceFingerprint, value: 101,
    })).toThrow(/bounded integers/);
    expect(() => replaceScrubbableNumber('x^2', {
      targetId: exponent.literals[0].id, sourceFingerprint: exponent.sourceFingerprint, value: 1.5,
    })).toThrow(/bounded integers/);
  });

  it('handles negative literals without creating a double sign', () => {
    const listed = listScrubbableNumbers('-5+2');
    expect(listed.literals[0].source).toBe('-5');
    expect(replaceScrubbableNumber('-5+2', {
      targetId: listed.literals[0].id, sourceFingerprint: listed.sourceFingerprint, value: 4,
    }).latex).toBe('4+2');
    expect(replaceScrubbableNumber('-5+2', {
      targetId: listed.literals[1].id, sourceFingerprint: listed.sourceFingerprint, value: -3,
    }).latex).toBe('-5+(-3)');
  });

  it('rejects injection, non-finite values, oversized input and oversized values', () => {
    expect(() => listScrubbableNumbers('<script>1</script>')).toThrow();
    const listed = listScrubbableNumbers('1');
    const target = listed.literals[0].id;
    expect(() => replaceScrubbableNumber('1', {
      targetId: target, sourceFingerprint: listed.sourceFingerprint, value: Number.NaN,
    })).toThrow(/finite/);
    expect(() => replaceScrubbableNumber('1', {
      targetId: target, sourceFingerprint: listed.sourceFingerprint, value: 1_000_000_001,
    })).toThrow(/bound/);
    expect(() => listScrubbableNumbers('1+'.repeat(3_000) + '1')).toThrow();
  });
});
