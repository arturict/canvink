import { describe, expect, it } from 'vitest';
import { normalizePageTag } from '../domain/pageTags';
import { PIN_TAG, isPinnedPage, quickAccessEntries, setPagePinned, visibleTags } from './pagePins';

describe('page pins', () => {
  it('pins and unpins a page through its tags without touching other tags', () => {
    const page = { tags: ['todo'] };
    expect(setPagePinned(page, true)).toBe(true);
    expect(setPagePinned(page, true)).toBe(false);
    expect(isPinnedPage(page)).toBe(true);
    expect(visibleTags(page.tags)).toEqual(['todo']);
    expect(setPagePinned(page, false)).toBe(true);
    expect(page.tags).toEqual(['todo']);
  });

  it('uses a tag that typing a tag by hand can never produce', () => {
    expect(normalizePageTag(PIN_TAG)).not.toBe(PIN_TAG);
  });

  it('lists pinned pages in navigation order across notebooks', () => {
    const notebooks = [
      {
        id: 'n1',
        title: 'Lösungen',
        sections: [{ id: 's1', title: 'Mathe', color: '#123456', pages: [{ id: 'p1', title: 'Serie 1' }, { id: 'p2', title: 'Serie 2' }] }],
      },
      { id: 'n2', title: 'Eigene', sections: [{ id: 's2', title: 'Mathe', pages: [{ id: 'p3', title: 'Versuch' }] }] },
    ];
    const entries = quickAccessEntries(notebooks, new Set(['p3', 'p2', 'gone']));
    expect(entries.map((entry) => entry.pageId)).toEqual(['p2', 'p3']);
    expect(entries[0]).toMatchObject({ notebookTitle: 'Lösungen', sectionTitle: 'Mathe', sectionColor: '#123456' });
  });
});
