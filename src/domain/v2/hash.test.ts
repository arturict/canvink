import { describe, expect, it } from 'vitest';
import { canonicalJson, sameCanonicalJson } from './hash';

describe('sameCanonicalJson', () => {
  const samples: unknown[] = [
    null,
    0,
    'a',
    [],
    {},
    [1, 2, 3],
    [1, 2],
    { a: 1, b: [1, { c: 2 }] },
    { b: [1, { c: 2 }], a: 1 },
    { a: 1, b: [1, { c: 3 }] },
    { a: 1, b: undefined },
    { a: 1 },
    { a: [] },
    { a: {} },
    new Uint8Array([1, 2, 3]),
    new Uint8Array([1, 2]),
    { heads: ['x'], nested: { list: [{ id: 1 }, { id: 2 }] } },
    { nested: { list: [{ id: 1 }, { id: 2 }] }, heads: ['x'] },
    { nested: { list: [{ id: 2 }, { id: 1 }] }, heads: ['x'] },
  ];

  it('agrees with comparing the canonical JSON strings for every pair of samples', () => {
    for (const left of samples) {
      for (const right of samples) {
        expect(sameCanonicalJson(left, right), `${canonicalJson(left)} vs ${canonicalJson(right)}`)
          .toBe(canonicalJson(left) === canonicalJson(right));
      }
    }
  });

  it('ignores key order and undefined members, but not values or array order', () => {
    expect(sameCanonicalJson({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(sameCanonicalJson({ a: 1, b: undefined }, { a: 1 })).toBe(true);
    expect(sameCanonicalJson({ a: 1 }, { a: 2 })).toBe(false);
    expect(sameCanonicalJson([1, 2], [2, 1])).toBe(false);
  });
});
