import { summarizePage } from '../storage/pageIndex';
import { describe, expect, it, vi } from 'vitest';
import type { LiveNotebookDocV2, LivePageDocV2 } from '../crdt';
import {
  createNotebookProjector,
  loadV2UiState,
  localDeviceId,
  parseV2UiState,
  projectLiveNotebooks,
  rememberNavigation,
  searchLivePages,
  subpageParentCandidates,
  toggleFavoritePage,
  touchRecentPage,
} from './v2WorkspaceView';

const TIME = '2026-08-03T08:00:00.000Z';

function liveNotebook(): LiveNotebookDocV2 {
  return {
    schemaVersion: 2,
    documentId: 'notebook:notebook-1',
    kind: 'notebook',
    notebookId: 'notebook-1',
    title: 'School',
    color: '#123456',
    createdAt: TIME,
    updatedAt: TIME,
    sections: [{
      id: 'section-1',
      title: 'Physics',
      createdAt: TIME,
      updatedAt: TIME,
      pageDocumentIds: ['page:page-1'],
    }],
    settings: { defaultPageType: 'a4' },
  };
}

function livePage(): LivePageDocV2 {
  return {
    schemaVersion: 2,
    documentId: 'page:page-1',
    kind: 'page',
    notebookId: 'notebook-1',
    sectionId: 'section-1',
    pageId: 'page-1',
    title: 'Vectors',
    tags: ['important'],
    pageType: 'a4',
    background: { type: 'grid', color: '#fff' },
    createdAt: TIME,
    updatedAt: TIME,
    elementsById: {},
    zOrder: [],
  };
}

describe('schema-v2 workspace view projections', () => {
  it('projects live notebook/page roots without inventing mutable element copies', () => {
    const projected = projectLiveNotebooks([liveNotebook()], [summarizePage(livePage(), ['head'])]);
    expect(projected[0].sections[0].pages[0]).toMatchObject({
      id: 'page-1', title: 'Vectors', mode: 'a4', background: 'grid', elements: [],
    });
  });

  it('keeps the objects of everything an edit did not touch', () => {
    const project = createNotebookProjector();
    const second = livePage();
    second.documentId = 'page:page-2';
    second.pageId = 'page-2';
    second.title = 'Forces';
    const notebook = liveNotebook();
    notebook.sections[0].pageDocumentIds.push('page:page-2');

    const first = project([notebook], [summarizePage(livePage(), ['a']), summarizePage(second, ['b'])]);
    // The republished workspace holds new summary objects for the same pages.
    const unchanged = project([{ ...notebook }], [summarizePage(livePage(), ['a']), summarizePage(second, ['b'])]);
    expect(unchanged[0]).toBe(first[0]);

    // Renaming one page replaces that page, its section and the notebook, and no other page.
    const renamed = { ...second, title: 'Forces and motion', updatedAt: '2026-08-04T08:00:00.000Z' };
    const edited = project([notebook], [summarizePage(livePage(), ['a']), summarizePage(renamed, ['c'])]);
    expect(edited[0]).not.toBe(first[0]);
    expect(edited[0].sections[0]).not.toBe(first[0].sections[0]);
    expect(edited[0].sections[0].pages[0]).toBe(first[0].sections[0].pages[0]);
    expect(edited[0].sections[0].pages[1]).not.toBe(first[0].sections[0].pages[1]);
    expect(edited[0].sections[0].pages[1].title).toBe('Forces and motion');
  });

  it('orders pages and sections by the notebook settings and carries its icon', () => {
    const second = { ...livePage(), documentId: 'page:page-2', pageId: 'page-2', title: 'Acceleration' };
    const notebook = liveNotebook();
    notebook.sections[0].pageDocumentIds.push('page:page-2');
    const summaries = [summarizePage(livePage(), ['a']), summarizePage(second, ['b'])];
    const project = createNotebookProjector();

    const manual = project([notebook], summaries)[0];
    expect(manual.sections[0].pages.map((page) => page.title)).toEqual(['Vectors', 'Acceleration']);
    expect(manual.sort).toBeUndefined();
    expect(manual.icon).toBeUndefined();

    const sorted = project([{ ...notebook, settings: { defaultPageType: 'a4', icon: '📘', sort: { pages: 'title' } } }], summaries)[0];
    expect(sorted.sections[0].pages.map((page) => page.title)).toEqual(['Acceleration', 'Vectors']);
    expect(sorted.sort).toEqual({ sections: 'manual', pages: 'title' });
    expect(sorted.icon).toBe('📘');
    // Going back to manual brings the stored order back.
    expect(project([notebook], summaries)[0].sections[0].pages.map((page) => page.title)).toEqual(['Vectors', 'Acceleration']);
  });

  it('searches derived live text and page metadata', () => {
    expect(searchLivePages(
      [livePage()],
      new Map([['page-1', 'Newton and vector addition']]),
      'vector',
    )).toMatchObject([{ pageId: 'page-1', title: 'Vectors' }]);
  });

  it('offers only cycle-safe parents for subpage moves', () => {
    const root = livePage();
    const child = { ...livePage(), documentId: 'page:child', pageId: 'child', parentPageId: 'page-1' };
    const grandchild = {
      ...livePage(),
      documentId: 'page:grandchild',
      pageId: 'grandchild',
      parentPageId: 'child',
    };
    const sibling = { ...livePage(), documentId: 'page:sibling', pageId: 'sibling' };
    expect(subpageParentCandidates([root, child, grandchild, sibling], 'page-1')
      .map((page) => page.pageId)).toEqual(['sibling']);
  });

  it('bounds recents, toggles favorites, and rejects malformed device-local state', () => {
    let state = loadV2UiState(null);
    for (let index = 0; index < 20; index += 1) state = touchRecentPage(state, `page-${index}`);
    expect(state.recentPageIds).toHaveLength(12);
    state = toggleFavoritePage(state, 'page-4');
    expect(state.favoritePageIds).toContain('page-4');
    expect(parseV2UiState({ schemaVersion: 1, favoritePageIds: ['x'], recentPageIds: [3] }))
      .toBeNull();
  });

  it('remembers the last page per notebook and the notebook left behind', () => {
    let state = loadV2UiState(null);
    state = rememberNavigation(state, undefined, { notebookId: 'solutions', pageId: 'task-3' });
    state = rememberNavigation(state, 'solutions', { notebookId: 'mine', pageId: 'attempt' });
    expect(state.lastPageByNotebook).toEqual({ solutions: 'task-3', mine: 'attempt' });
    expect(state.previousNotebookId).toBe('solutions');
    state = rememberNavigation(state, 'mine', { notebookId: 'mine', pageId: 'attempt-2' });
    expect(state.previousNotebookId).toBe('solutions');
    state = rememberNavigation(state, 'mine', { notebookId: 'solutions', pageId: 'task-3' });
    expect(state.previousNotebookId).toBe('mine');
    expect(state.recentPageIds[0]).toBe('task-3');

    const restored = parseV2UiState(JSON.parse(JSON.stringify(state)));
    expect(restored?.lastPageByNotebook).toEqual({ solutions: 'task-3', mine: 'attempt-2' });
    expect(restored?.previousNotebookId).toBe('mine');
    // State written before these fields existed still loads.
    expect(parseV2UiState({ schemaVersion: 1, favoritePageIds: [], recentPageIds: [] }))
      .toEqual({ schemaVersion: 1, favoritePageIds: [], recentPageIds: [] });
  });

  it('reuses a stable accountless local device identifier', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
    };
    const first = localDeviceId(storage);
    expect(localDeviceId(storage)).toBe(first);
    expect(storage.setItem).toHaveBeenCalledOnce();
  });
});
