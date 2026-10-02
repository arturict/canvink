import { describe, expect, it } from 'vitest';
import type { LivePageDocV2 } from '../crdt';
import {
  createStablePageIdRemap,
  insertionIndex,
  invalidPageTransferCycle,
  moveIdByPlacement,
  pageSubtree,
  remappedParentPageId,
} from './pageTransfer';

const TIME = '2026-08-03T00:00:00.000Z';

function page(pageId: string, parentPageId?: string): LivePageDocV2 {
  return {
    schemaVersion: 2,
    documentId: `page:${pageId}`,
    kind: 'page',
    notebookId: 'notebook-1',
    sectionId: 'section-1',
    pageId,
    ...(parentPageId ? { parentPageId } : {}),
    title: pageId,
    tags: [],
    pageType: 'a4',
    background: { type: 'plain', color: '#fff' },
    createdAt: TIME,
    updatedAt: TIME,
    elementsById: {},
    zOrder: [],
  };
}

describe('page tree transfers', () => {
  it('collects a complete subtree independent of flat storage order', () => {
    const pages = [page('grandchild', 'child'), page('sibling'), page('root'), page('child', 'root')];
    expect(pageSubtree(pages, 'root').map((candidate) => candidate.pageId)).toEqual([
      'grandchild', 'root', 'child',
    ]);
  });

  it('rejects moves into self or descendants while allowing unrelated roots', () => {
    const pages = [page('root'), page('child', 'root'), page('grandchild', 'child'), page('sibling')];
    expect(invalidPageTransferCycle(pages, 'root', 'root')).toBe(true);
    expect(invalidPageTransferCycle(pages, 'root', 'grandchild')).toBe(true);
    expect(invalidPageTransferCycle(pages, 'root', 'sibling')).toBe(false);
    expect(invalidPageTransferCycle(pages, 'root', undefined)).toBe(false);
  });

  it('calculates before, inside, and after insertion without off-by-one moves', () => {
    expect(insertionIndex(['a', 'b', 'c'], 'b', 'before')).toBe(1);
    expect(insertionIndex(['a', 'b', 'c'], 'b', 'after')).toBe(2);
    expect(insertionIndex(['a', 'b', 'c'], 'b', 'inside')).toBe(3);
    expect(moveIdByPlacement(['a', 'b', 'c'], 'a', 'c', 'after')).toEqual(['b', 'c', 'a']);
    expect(moveIdByPlacement(['a', 'b', 'c'], 'c', 'a', 'before')).toEqual(['c', 'a', 'b']);
    expect(moveIdByPlacement(['a', 'b'], 'a', 'a', 'after')).toEqual(['a', 'b']);
  });

  it('creates stable unique copy IDs and remaps only parents inside the copied set', () => {
    const pages = [page('root'), page('child', 'root'), page('outside-child', 'outside')];
    const remap = createStablePageIdRemap(pages, (source) => `copy-${source.pageId}`);
    expect(remap.pageIdBySourceId.get('root')).toBe('copy-root');
    expect(remap.documentIdBySourceId.get('child')).toBe('page:copy-child');
    expect(remappedParentPageId(pages[1], remap)).toBe('copy-root');
    expect(remappedParentPageId(pages[2], remap)).toBeUndefined();
    expect(() => createStablePageIdRemap(pages, () => 'same')).toThrow(/unique/i);
  });
});
