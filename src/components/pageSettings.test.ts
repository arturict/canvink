import * as Automerge from '@automerge/automerge';
import { describe, expect, it } from 'vitest';
import type { LivePageDocV2 } from '../crdt';
import { backgroundGridSpacing } from '../editor/shapes';
import { PAGE_TAG_LIMIT } from '../domain/pageTags';
import {
  PageTagLimitError,
  addPageTag,
  applyPageBackground,
  applyPagePaper,
  applyPageRuling,
  applyRuleStyle,
  removePageTag,
  setPageTaskState,
} from './pageSettings';

const TIME = '2026-08-03T20:40:00.000Z';

describe('current page settings writes', () => {
  it('persists millimeter background on a schema-v3 page and retains 10px snapping', () => {
    const page = {
      schemaVersion: 3,
      documentId: 'page:school',
      kind: 'page',
      notebookId: 'notebook-1',
      sectionId: 'section-1',
      pageId: 'school',
      title: 'School',
      tags: [],
      pageType: 'a4',
      background: { type: 'grid', color: '#ffffff' },
      createdAt: TIME,
      updatedAt: TIME,
      elementsById: {},
      zOrder: [],
      version: { protocol: 'uninitialized', heads: [] },
    } as unknown as LivePageDocV2;

    applyPageBackground(page, 'millimeter', '2026-08-03T20:41:00.000Z');

    expect(page.schemaVersion).toBe(3);
    expect(page.background.type).toBe('millimeter');
    if (page.background.type === 'plain') throw new Error('Expected a ruled school background.');
    expect(backgroundGridSpacing(page.background.type)).toBe(10);
    expect(page.updatedAt).toBe('2026-08-03T20:41:00.000Z');
  });
});

function taskPage(overrides: Partial<LivePageDocV2> = {}): LivePageDocV2 {
  return {
    schemaVersion: 3,
    documentId: 'page:tags',
    kind: 'page',
    notebookId: 'notebook-1',
    sectionId: 'section-1',
    pageId: 'tags',
    title: 'Hausaufgaben',
    tags: [],
    pageType: 'a4',
    background: { type: 'plain', color: '#ffffff' },
    createdAt: TIME,
    updatedAt: TIME,
    elementsById: {},
    zOrder: [],
    version: { protocol: 'uninitialized', heads: [] },
    ...overrides,
  } as unknown as LivePageDocV2;
}

describe('manual page tag editing', () => {
  it('stores a normalized tag once and reports the no-op repeat', () => {
    const page = taskPage();

    expect(addPageTag(page, '  Prüfung ', '2026-08-31T09:00:00.000Z')).toBe(true);
    expect(page.tags).toEqual(['prufung']);
    expect(page.updatedAt).toBe('2026-08-31T09:00:00.000Z');

    expect(addPageTag(page, 'PRÜFUNG', '2026-08-31T09:05:00.000Z')).toBe(false);
    expect(page.tags).toEqual(['prufung']);
    expect(page.updatedAt).toBe('2026-08-31T09:00:00.000Z');
  });

  it('refuses a tag with nothing printable and leaves the page untouched', () => {
    const page = taskPage();
    expect(addPageTag(page, '***', '2026-08-31T09:00:00.000Z')).toBe(false);
    expect(page.tags).toEqual([]);
    expect(page.updatedAt).toBe(TIME);
  });

  it('refuses to grow a page beyond the tag limit', () => {
    const page = taskPage({
      tags: Array.from({ length: PAGE_TAG_LIMIT }, (_, index) => `tag-${index}`),
    });
    expect(() => addPageTag(page, 'overflow', '2026-08-31T09:00:00.000Z'))
      .toThrow(PageTagLimitError);
    expect(page.tags).toHaveLength(PAGE_TAG_LIMIT);
  });

  it('removes an exact stored tag, including an imported source tag', () => {
    const page = taskPage({ tags: ['todo', 'onenote:client-request'] });

    expect(removePageTag(page, 'onenote:client-request', '2026-08-31T10:00:00.000Z')).toBe(true);
    expect(page.tags).toEqual(['todo']);
    expect(removePageTag(page, 'missing', '2026-08-31T11:00:00.000Z')).toBe(false);
    expect(page.updatedAt).toBe('2026-08-31T10:00:00.000Z');
  });
});

describe('manual page task state', () => {
  it('marks, completes, and clears the page task state', () => {
    const page = taskPage();

    expect(setPageTaskState(page, 'open', '2026-08-31T09:00:00.000Z')).toBe(true);
    expect(page.taskState).toBe('open');

    expect(setPageTaskState(page, 'open', '2026-08-31T09:30:00.000Z')).toBe(false);
    expect(page.updatedAt).toBe('2026-08-31T09:00:00.000Z');

    expect(setPageTaskState(page, 'done', '2026-08-31T10:00:00.000Z')).toBe(true);
    expect(page.taskState).toBe('done');

    expect(setPageTaskState(page, undefined, '2026-08-31T11:00:00.000Z')).toBe(true);
    expect('taskState' in page).toBe(false);
    expect(page.updatedAt).toBe('2026-08-31T11:00:00.000Z');
  });
});

describe('OneNote paper settings', () => {
  it('sets rule lines with their spacing and clears the spacing again for plain paper', () => {
    const page = taskPage();

    expect(applyPageRuling(page, { type: 'grid', spacing: 19 }, '2026-09-24T08:00:00.000Z')).toBe(true);
    expect(page.background).toEqual({ type: 'grid', color: '#ffffff', spacing: 19 });
    expect(applyPageRuling(page, { type: 'grid', spacing: 19 }, '2026-09-24T08:01:00.000Z')).toBe(false);
    expect(page.updatedAt).toBe('2026-09-24T08:00:00.000Z');

    applyPageRuling(page, { type: 'plain', spacing: 40 }, '2026-09-24T08:02:00.000Z');
    expect(page.background).toEqual({ type: 'plain', color: '#ffffff' });
  });

  it('stores line colour and strength only when they change', () => {
    const page = taskPage({ background: { type: 'lined', color: '#ffffff' } });

    expect(applyRuleStyle(page, { lineStrength: 'strong' }, '2026-09-24T08:00:00.000Z')).toBe(true);
    expect(applyRuleStyle(page, { lineColor: '#16a34a', lineStrength: 'strong' }, '2026-09-24T08:01:00.000Z')).toBe(true);
    expect(applyRuleStyle(page, { lineColor: '#16a34a' }, '2026-09-24T08:02:00.000Z')).toBe(false);
    expect(page.background).toEqual({ type: 'lined', color: '#ffffff', lineColor: '#16a34a', lineStrength: 'strong' });
    expect(page.updatedAt).toBe('2026-09-24T08:01:00.000Z');
  });

  it('keeps fixed sheets on the a4 page type that older versions understand', () => {
    const initial = Automerge.from(structuredClone(taskPage({ pageType: 'free' })) as unknown as Record<string, unknown>);
    const landscape = Automerge.change(initial, (draft) => {
      applyPagePaper(draft as unknown as LivePageDocV2, { size: 'a5', orientation: 'landscape' }, '2026-09-24T08:00:00.000Z');
    }) as unknown as LivePageDocV2;
    expect(landscape.pageType).toBe('a4');
    expect(landscape.paper).toEqual({ size: 'a5', orientation: 'landscape' });

    const portrait = Automerge.change(landscape as unknown as Automerge.Doc<Record<string, unknown>>, (draft) => {
      applyPagePaper(draft as unknown as LivePageDocV2, { size: 'a4', orientation: 'portrait' }, '2026-09-24T08:01:00.000Z');
    }) as unknown as LivePageDocV2;
    expect(portrait.pageType).toBe('a4');
    expect('paper' in portrait).toBe(false);

    const free = Automerge.change(portrait as unknown as Automerge.Doc<Record<string, unknown>>, (draft) => {
      applyPagePaper(draft as unknown as LivePageDocV2, null, '2026-09-24T08:02:00.000Z');
    }) as unknown as LivePageDocV2;
    expect(free.pageType).toBe('free');
  });
});
