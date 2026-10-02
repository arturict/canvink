import { describe, expect, it } from 'vitest';
import type { V2RuntimeState } from '../../storage/workspaceV2Runtime';
import { scopeFilters, searchLocations } from './searchScope';

type Workspace = Pick<V2RuntimeState, 'notebooks' | 'pages'>;

const section = (id: string, title: string, groupId?: string) => ({
  id, title, createdAt: '2026-09-30T08:00:00.000Z', updatedAt: '2026-09-30T08:00:00.000Z', pageDocumentIds: [], ...(groupId ? { groupId } : {}),
});

const notebook = (id: string, title: string, sections: ReturnType<typeof section>[], groups: Array<{ id: string; title: string; parentGroupId?: string }> = []) => ({
  schemaVersion: 3, documentId: `notebook:${id}`, kind: 'notebook', notebookId: id, title, color: '#7a4fa0',
  createdAt: id === 'nb-2' ? '2026-09-30T08:00:00.000Z' : '2026-09-01T08:00:00.000Z', updatedAt: '2026-09-30T08:00:00.000Z',
  sections, sectionGroups: groups.map((group) => ({ ...group, createdAt: '2026-09-01T08:00:00.000Z', updatedAt: '2026-09-01T08:00:00.000Z' })),
  settings: { defaultPageType: 'free' },
});

const workspace = {
  notebooks: [
    notebook('nb-1', 'Notizbuch', [section('a', 'Neuer Abschnitt'), section('b', 'Neuer Abschnitt'), section('c', 'Test')]),
    notebook('nb-2', 'Notizbuch', [section('d', 'Notizen', 'bin-child'), section('e', 'Gelöschte Seiten', 'bin')], [
      { id: 'bin', title: 'OneNote_RecycleBin' },
      { id: 'bin-child', title: 'Alt', parentGroupId: 'bin' },
    ]),
  ],
  pages: [{ sectionId: 'a' }, { sectionId: 'a' }, { sectionId: 'c' }, { sectionId: 'e' }],
} as unknown as Workspace;

describe('searchLocations', () => {
  const { notebooks, recycledSectionIds } = searchLocations(workspace);

  it('tells namesake notebooks apart by their place among them', () => {
    expect(notebooks.map((item) => [item.title, item.sameTitleIndex, item.sameTitleTotal])).toEqual([['Notizbuch', 1, 2], ['Notizbuch', 2, 2]]);
  });

  it('tells namesake sections of one notebook apart and counts their pages', () => {
    const [first, second, third] = notebooks[0].sections;
    expect([first.sameTitleIndex, second.sameTitleIndex, first.sameTitleTotal]).toEqual([1, 2, 2]);
    expect(third.sameTitleTotal).toBe(1);
    expect([first.pageCount, second.pageCount, third.pageCount]).toEqual([2, 0, 1]);
  });

  it('marks sections inside an imported OneNote recycle bin, however deep, and keeps them out of the counts', () => {
    expect([...recycledSectionIds].sort()).toEqual(['d', 'e']);
    expect(notebooks[1].sectionCount).toBe(0);
    expect(notebooks[0].sectionCount).toBe(3);
  });
});

describe('scopeFilters', () => {
  const active = { notebookId: 'nb-1', sectionId: 'b', pageId: 'p-9' };

  it('maps each shortcut onto the page that is open', () => {
    expect(scopeFilters('page', active)).toEqual({ pageId: 'p-9' });
    expect(scopeFilters('section', active)).toEqual({ sectionIds: ['b'] });
    expect(scopeFilters('notebook', active)).toEqual({ notebookIds: ['nb-1'] });
    expect(scopeFilters('all', active)).toEqual({});
  });
});
