import { describe, expect, it } from 'vitest';
import {
  desiredDepth,
  gapFromMidpoints,
  indentTarget,
  isNoopDrop,
  outdentTarget,
  resolvePageDrop,
  visiblePageRows,
} from './pageTreeDrop';

// A           depth 0
//   A1        depth 1
//     A1a     depth 2
// B           depth 0
const rows = [
  { id: 'A', depth: 0 },
  { id: 'A1', depth: 1 },
  { id: 'A1a', depth: 2 },
  { id: 'B', depth: 0 },
];

describe('resolvePageDrop', () => {
  it('drops above the first page only at the top level', () => {
    expect(resolvePageDrop(rows, 0, 3)).toEqual({ gap: 0, depth: 0, targetPageId: 'A', placement: 'before' });
  });

  it('makes the page a subpage of the row above when dragged to the right', () => {
    expect(resolvePageDrop(rows, 4, 1)).toEqual({ gap: 4, depth: 1, targetPageId: 'B', placement: 'inside' });
  });

  it('keeps a gap inside a subtree from reparenting the following rows', () => {
    // Between A1 and A1a the level cannot be above A1a's.
    expect(resolvePageDrop(rows, 2, 0)).toMatchObject({ depth: 2, targetPageId: 'A1', placement: 'inside' });
  });

  it('places the page after the nearest row at the chosen level', () => {
    expect(resolvePageDrop(rows, 3, 0)).toEqual({ gap: 3, depth: 0, targetPageId: 'A', placement: 'after' });
    expect(resolvePageDrop(rows, 3, 1)).toEqual({ gap: 3, depth: 1, targetPageId: 'A1', placement: 'after' });
  });

  it('drops into an empty list at the root', () => {
    expect(resolvePageDrop([], 0, 2)).toEqual({ gap: 0, depth: 0, placement: 'root' });
  });

  it('recognises a drop back into the starting place', () => {
    expect(isNoopDrop({ gap: 1, depth: 1 }, { gap: 1, depth: 1 })).toBe(true);
    expect(isNoopDrop({ gap: 1, depth: 0 }, { gap: 1, depth: 1 })).toBe(false);
  });
});

describe('drag gesture helpers', () => {
  it('maps the pointer to a gap between row midpoints', () => {
    expect(gapFromMidpoints([10, 30, 50], 5)).toBe(0);
    expect(gapFromMidpoints([10, 30, 50], 31)).toBe(2);
    expect(gapFromMidpoints([10, 30, 50], 90)).toBe(3);
  });

  it('turns horizontal travel into levels', () => {
    expect(desiredDepth(0, 30)).toBe(1);
    expect(desiredDepth(1, -30)).toBe(0);
    expect(desiredDepth(0, -80)).toBe(0);
  });
});

describe('visiblePageRows', () => {
  const pages = [
    { id: 'A' },
    { id: 'B' },
    { id: 'A1', parentPageId: 'A' },
    { id: 'orphan', parentPageId: 'missing' },
  ];

  it('lists pages depth-first in section order', () => {
    expect(visiblePageRows(pages)).toEqual([
      { id: 'A', depth: 0 },
      { id: 'A1', depth: 1 },
      { id: 'B', depth: 0 },
      { id: 'orphan', depth: 0 },
    ]);
  });

  it('hides the subpages of collapsed pages', () => {
    expect(visiblePageRows(pages, new Set(['A'])).map((row) => row.id)).toEqual(['A', 'B', 'orphan']);
  });
});

describe('indent and outdent', () => {
  const pages = [
    { id: 'A' },
    { id: 'A1', parentPageId: 'A' },
    { id: 'B' },
    { id: 'C' },
  ];

  it('indents under the sibling above, after its existing subpages', () => {
    expect(indentTarget(pages, 'B')).toEqual({ targetPageId: 'A1', placement: 'after' });
    expect(indentTarget(pages, 'C')).toEqual({ targetPageId: 'B', placement: 'inside' });
    expect(indentTarget(pages, 'A')).toBeUndefined();
  });

  it('outdents a subpage to just after its parent', () => {
    expect(outdentTarget(pages, 'A1')).toEqual({ targetPageId: 'A', placement: 'after' });
    expect(outdentTarget(pages, 'B')).toBeUndefined();
  });
});
