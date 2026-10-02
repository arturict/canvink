import { describe, expect, it } from 'vitest';
import type { LivePageDocV2 } from '../crdt';
import { DEFAULT_NEW_PAGE_DEFAULTS, resolveNotebookSettings } from '../domain/notebookSettings';
import { applyPageLook, pageLookForDefaults } from './newPageDefaults';

const TIME = '2026-10-01T08:00:00.000Z';
const LATER = '2026-10-01T09:00:00.000Z';

function page(overrides: Partial<LivePageDocV2> = {}): LivePageDocV2 {
  return {
    schemaVersion: 3,
    documentId: 'page:p',
    kind: 'page',
    notebookId: 'n',
    sectionId: 's',
    pageId: 'p',
    title: 'Page',
    tags: [],
    pageType: 'a4',
    background: { type: 'grid', color: '#ffffff' },
    createdAt: TIME,
    updatedAt: TIME,
    elementsById: {},
    zOrder: [],
    ...overrides,
  } as LivePageDocV2;
}

describe('the look of new pages', () => {
  it('is the look new pages always had when a notebook has no settings', () => {
    const look = pageLookForDefaults(resolveNotebookSettings({ defaultPageType: 'free' }).newPage);
    expect(look).toEqual({ pageType: 'a4', background: { type: 'grid', color: '#ffffff' } });
    expect(look).toEqual(pageLookForDefaults(DEFAULT_NEW_PAGE_DEFAULTS));
  });

  it('follows the notebook defaults', () => {
    const look = pageLookForDefaults(resolveNotebookSettings({
      defaultPageType: 'a4',
      newPage: {
        pageType: 'a4',
        paper: { size: 'a5', orientation: 'landscape' },
        ruling: 'lined',
        spacing: 28,
        paperColor: '#fdf6e3',
        lineColor: '#e11d48',
        lineStrength: 'medium',
      },
    }).newPage);
    expect(look).toEqual({
      pageType: 'a4',
      paper: { size: 'a5', orientation: 'landscape' },
      background: { type: 'lined', color: '#fdf6e3', spacing: 28, lineColor: '#e11d48', lineStrength: 'medium' },
    });
  });

  it('gives a free page no sheet and plain paper no line style', () => {
    const look = pageLookForDefaults(resolveNotebookSettings({
      newPage: { pageType: 'free', ruling: 'plain', lineColor: '#e11d48', paper: { size: 'a5', orientation: 'portrait' } },
    }).newPage);
    expect(look.pageType).toBe('free');
    expect(look.paper).toBeUndefined();
    expect(look.background).toEqual({ type: 'plain', color: '#ffffff' });
  });
});

describe('applying the notebook defaults to existing pages', () => {
  const lined = pageLookForDefaults(resolveNotebookSettings({
    newPage: { pageType: 'free', ruling: 'lined', spacing: 32, paperColor: '#fdf6e3', lineColor: '#16a34a' },
  }).newPage);

  it('changes paper and sheet, leaves content alone and bumps the page once', () => {
    const document = page({
      title: 'Keep me',
      tags: ['x'],
      background: { type: 'grid', color: '#ffffff', lineStrength: 'strong' },
      paper: { size: 'a5', orientation: 'landscape' },
    });
    expect(applyPageLook(document, lined, LATER)).toBe(true);
    expect(document.pageType).toBe('free');
    expect(document.background).toEqual({ type: 'lined', color: '#fdf6e3', spacing: 32, lineColor: '#16a34a' });
    expect(document.title).toBe('Keep me');
    expect(document.tags).toEqual(['x']);
    expect(document.updatedAt).toBe(LATER);
  });

  it('is a no-op for a page that already matches', () => {
    const document = page();
    applyPageLook(document, lined, LATER);
    expect(applyPageLook(document, lined, '2026-10-02T00:00:00.000Z')).toBe(false);
    expect(document.updatedAt).toBe(LATER);
  });

  it('sets a fixed sheet again on a free page', () => {
    const sheet = pageLookForDefaults(resolveNotebookSettings({
      newPage: { pageType: 'a4', paper: { size: 'letter', orientation: 'portrait' } },
    }).newPage);
    const document = page({ pageType: 'free' });
    expect(applyPageLook(document, sheet, LATER)).toBe(true);
    expect(document.pageType).toBe('a4');
    expect(document.paper).toEqual({ size: 'letter', orientation: 'portrait' });
  });
});
