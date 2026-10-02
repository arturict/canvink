import { describe, expect, it } from 'vitest';
import { emptyCollapseState, parseCollapseState } from './navigationCollapse';

describe('stored navigation folds', () => {
  it('reads what was stored and ignores malformed entries', () => {
    expect(parseCollapseState(JSON.stringify({
      groups: ['g1', 7],
      pages: ['p1'],
      sections: { s1: false, s2: 'yes' },
    }))).toEqual({ groups: ['g1'], pages: ['p1'], sections: { s1: false } });
  });

  it('falls back to nothing folded for missing or broken storage', () => {
    expect(parseCollapseState(null)).toEqual(emptyCollapseState());
    expect(parseCollapseState('{not json')).toEqual(emptyCollapseState());
    expect(parseCollapseState('[1,2]')).toEqual(emptyCollapseState());
  });
});
