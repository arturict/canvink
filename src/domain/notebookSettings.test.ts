import * as Automerge from '@automerge/automerge';
import { describe, expect, it } from 'vitest';
import type { NotebookSettings } from './v2';
import {
  DEFAULT_NEW_PAGE_DEFAULTS,
  applyNotebookSettingsPatch,
  isValidStoredNotebookSettings,
  migrateNotebookSettings,
  normalizeNotebookIcon,
  parseTemplateReference,
  resolveNotebookSettings,
  sortPages,
  sortSections,
} from './notebookSettings';

describe('notebook settings resolve', () => {
  it('gives a notebook from before the settings the pages it always produced', () => {
    // Notebooks written by earlier versions carry only the page type, and the free ones were
    // still given A4 grid pages: nothing about them may change.
    for (const legacy of [{ defaultPageType: 'a4' }, { defaultPageType: 'free' }, undefined, null, 'x', {}]) {
      const resolved = resolveNotebookSettings(legacy);
      expect(resolved.newPage).toEqual(DEFAULT_NEW_PAGE_DEFAULTS);
      expect(resolved.sort).toEqual({ sections: 'manual', pages: 'manual' });
      expect(resolved.icon).toBeUndefined();
    }
  });

  it('reads stored choices and replaces anything malformed with the default', () => {
    const resolved = resolveNotebookSettings({
      defaultPageType: 'a4',
      icon: '📘',
      newPage: {
        pageType: 'free',
        paper: { size: 'a5', orientation: 'landscape' },
        ruling: 'lined',
        spacing: 28,
        paperColor: '#FDF6E3',
        lineColor: '#16A34A',
        lineStrength: 'strong',
        template: 'builtin:lesson-notes',
        textSize: 20,
        textColor: '#1e3a8a',
      },
      sort: { sections: 'title', pages: 'updated' },
    });
    expect(resolved).toEqual({
      icon: '📘',
      newPage: {
        pageType: 'free',
        paper: { size: 'a5', orientation: 'landscape' },
        ruling: 'lined',
        spacing: 28,
        paperColor: '#fdf6e3',
        lineColor: '#16a34a',
        lineStrength: 'strong',
        template: { kind: 'builtin', id: 'lesson-notes' },
        textSize: 20,
        textColor: '#1e3a8a',
      },
      sort: { sections: 'title', pages: 'updated' },
    });

    const hostile = resolveNotebookSettings({
      icon: 'abc',
      newPage: {
        pageType: 'wide',
        paper: { size: 'folio', orientation: 'diagonal' },
        ruling: 'dotted',
        spacing: 'wide',
        paperColor: 'red; background: url(x)',
        lineStrength: 'neon',
        template: 'javascript:alert(1)',
        textSize: 999,
        textColor: 'rgb(0,0,0)',
      },
      sort: { sections: 'random', pages: 7 },
    });
    expect(hostile.icon).toBeUndefined();
    expect(hostile.newPage).toEqual(DEFAULT_NEW_PAGE_DEFAULTS);
    expect(hostile.sort).toEqual({ sections: 'manual', pages: 'manual' });
  });

  it('keeps spacing only where paper has lines and clamps it', () => {
    expect(resolveNotebookSettings({ newPage: { ruling: 'plain', spacing: 40 } }).newPage.spacing).toBeUndefined();
    expect(resolveNotebookSettings({ newPage: { ruling: 'grid', spacing: 5000 } }).newPage.spacing).toBe(160);
    expect(resolveNotebookSettings({ newPage: { ruling: 'lined', spacing: 1 } }).newPage.spacing).toBe(8);
  });

  it('accepts one symbol only', () => {
    expect(normalizeNotebookIcon('🎓')).toBe('🎓');
    expect(normalizeNotebookIcon('👩‍🔬')).toBe('👩‍🔬');
    expect(normalizeNotebookIcon('✈️')).toBe('✈️');
    expect(normalizeNotebookIcon('ab')).toBeUndefined();
    expect(normalizeNotebookIcon('A')).toBeUndefined();
    expect(normalizeNotebookIcon('📘📗')).toBeUndefined();
    expect(normalizeNotebookIcon('')).toBeUndefined();
    expect(normalizeNotebookIcon('x'.repeat(40))).toBeUndefined();
  });

  it('parses template references', () => {
    expect(parseTemplateReference('builtin:homework-week')).toEqual({ kind: 'builtin', id: 'homework-week' });
    expect(parseTemplateReference('page:page-1234')).toEqual({ kind: 'page', pageId: 'page-1234' });
    expect(parseTemplateReference('page:')).toBeUndefined();
    expect(parseTemplateReference('other:1')).toBeUndefined();
    expect(parseTemplateReference(3)).toBeUndefined();
  });
});

describe('notebook settings patches', () => {
  it('writes single keys, mirrors the page type for older readers and removes keys on null', () => {
    const settings: NotebookSettings = { defaultPageType: 'a4' };
    expect(applyNotebookSettingsPatch(settings, { newPage: { ruling: 'lined', spacing: 28 } })).toBe(true);
    expect(settings).toEqual({ defaultPageType: 'a4', newPage: { ruling: 'lined', spacing: 28 } });

    expect(applyNotebookSettingsPatch(settings, { newPage: { pageType: 'free' } })).toBe(true);
    expect(settings.defaultPageType).toBe('free');
    expect(settings.newPage).toEqual({ ruling: 'lined', spacing: 28, pageType: 'free' });

    expect(applyNotebookSettingsPatch(settings, { newPage: { spacing: null } })).toBe(true);
    expect(settings.newPage).toEqual({ ruling: 'lined', pageType: 'free' });

    expect(applyNotebookSettingsPatch(settings, { icon: '🎓', sort: { pages: 'title' } })).toBe(true);
    expect(settings).toMatchObject({ icon: '🎓', sort: { pages: 'title' } });
    expect(applyNotebookSettingsPatch(settings, { icon: null, sort: { pages: 'manual' } })).toBe(true);
    expect(settings.icon).toBeUndefined();
    // Manual is the default and is stored as no key.
    expect(settings.sort).toEqual({});
  });

  it('reports no change for a value that is already set', () => {
    const settings: NotebookSettings = { defaultPageType: 'a4', newPage: { paper: { size: 'a5', orientation: 'portrait' } } };
    expect(applyNotebookSettingsPatch(settings, { newPage: { paper: { size: 'a5', orientation: 'portrait' } } })).toBe(false);
    expect(applyNotebookSettingsPatch(settings, { newPage: { template: null }, icon: null })).toBe(false);
  });

  it('never stores an invalid value', () => {
    const settings: NotebookSettings = { defaultPageType: 'a4' };
    const bad = { paperColor: 'blue', textSize: 13, ruling: 'dotted', template: 'x', spacing: Number.NaN } as never;
    expect(applyNotebookSettingsPatch(settings, { newPage: bad, icon: 'abc' })).toBe(false);
    expect(settings).toEqual({ defaultPageType: 'a4' });
  });

  it('merges concurrent changes of different keys on two devices', () => {
    const base = Automerge.from<{ settings: NotebookSettings }>({ settings: { defaultPageType: 'a4' } });
    // Once the settings object exists, each key is its own value in the document.
    const withObject = Automerge.change(base, (draft) => {
      applyNotebookSettingsPatch(draft.settings, { newPage: { ruling: 'grid' } });
    });
    const left = Automerge.change(Automerge.clone(withObject), (draft) => {
      applyNotebookSettingsPatch(draft.settings, { newPage: { ruling: 'lined' } });
    });
    const right = Automerge.change(Automerge.clone(withObject), (draft) => {
      applyNotebookSettingsPatch(draft.settings, { newPage: { paperColor: '#fdf6e3' }, icon: '🎓' });
    });
    const merged = Automerge.merge(Automerge.clone(left), right);
    expect(resolveNotebookSettings(merged.settings).newPage).toMatchObject({ ruling: 'lined', paperColor: '#fdf6e3' });
    expect(merged.settings.icon).toBe('🎓');
  });
});

describe('notebook settings migration', () => {
  it('brings a notebook from before the settings into the current shape without changing its pages', () => {
    const migrated = migrateNotebookSettings({ defaultPageType: 'free' });
    expect(migrated).toEqual({ defaultPageType: 'free' });
    expect(resolveNotebookSettings(migrated).newPage).toEqual(DEFAULT_NEW_PAGE_DEFAULTS);
    expect(isValidStoredNotebookSettings(migrated)).toBe(true);
  });

  it('adds the page type to settings that lack it and drops what it does not know', () => {
    expect(migrateNotebookSettings(undefined)).toEqual({ defaultPageType: 'a4' });
    expect(migrateNotebookSettings({ defaultPageType: 'wide', extra: 1 })).toEqual({ defaultPageType: 'a4' });
    const kept = migrateNotebookSettings({
      defaultPageType: 'a4',
      icon: '📘',
      newPage: { ruling: 'lined', textSize: 18, bogus: true, paperColor: 'nope' },
      sort: { pages: 'created', sections: 'bogus' },
    });
    expect(kept).toEqual({
      defaultPageType: 'a4',
      icon: '📘',
      newPage: { ruling: 'lined', textSize: 18 },
      sort: { pages: 'created' },
    });
    expect(isValidStoredNotebookSettings(kept)).toBe(true);
    // Migrating again changes nothing.
    expect(migrateNotebookSettings(kept)).toEqual(kept);
  });

  it('validates stored settings strictly for imports', () => {
    expect(isValidStoredNotebookSettings({ defaultPageType: 'a4' })).toBe(true);
    expect(isValidStoredNotebookSettings({ defaultPageType: 'a4', newPage: { ruling: 'grid', spacing: 40 } })).toBe(true);
    expect(isValidStoredNotebookSettings({})).toBe(false);
    expect(isValidStoredNotebookSettings({ defaultPageType: 'a4', surprise: 1 })).toBe(false);
    expect(isValidStoredNotebookSettings({ defaultPageType: 'a4', newPage: { ruling: 'dotted' } })).toBe(false);
    expect(isValidStoredNotebookSettings({ defaultPageType: 'a4', newPage: { paperColor: '#FFF' } })).toBe(false);
    expect(isValidStoredNotebookSettings({ defaultPageType: 'a4', sort: { pages: 'random' } })).toBe(false);
    expect(isValidStoredNotebookSettings({ defaultPageType: 'a4', icon: 'abc' })).toBe(false);
  });
});

describe('notebook ordering', () => {
  const at = (id: string, title: string, createdAt: string, updatedAt = createdAt, parentPageId?: string) => ({
    id, title, createdAt, updatedAt, ...(parentPageId ? { parentPageId } : {}),
  });

  it('sorts sections by title with numbers in order and by date newest first', () => {
    const sections = [
      at('b', 'Physik 10', '2026-02-01', '2026-05-01'),
      at('a', 'physik 2', '2026-03-01', '2026-04-01'),
      at('c', 'Chemie', '2026-01-01', '2026-06-01'),
    ];
    expect(sortSections(sections, 'manual').map((s) => s.id)).toEqual(['b', 'a', 'c']);
    expect(sortSections(sections, 'title').map((s) => s.id)).toEqual(['c', 'a', 'b']);
    expect(sortSections(sections, 'created').map((s) => s.id)).toEqual(['a', 'b', 'c']);
    expect(sortSections(sections, 'updated').map((s) => s.id)).toEqual(['c', 'b', 'a']);
  });

  it('keeps subpages under their page and orders each level', () => {
    const pages = [
      at('z', 'Zebra', '2026-01-01'),
      at('z2', 'B sub', '2026-01-03', '2026-01-03', 'z'),
      at('z1', 'A sub', '2026-01-02', '2026-01-02', 'z'),
      at('a', 'Apfel', '2026-01-04'),
    ];
    expect(sortPages(pages, 'manual').map((p) => p.id)).toEqual(['z', 'z2', 'z1', 'a']);
    expect(sortPages(pages, 'title').map((p) => p.id)).toEqual(['a', 'z', 'z1', 'z2']);
    expect(sortPages(pages, 'created').map((p) => p.id)).toEqual(['a', 'z', 'z2', 'z1']);
  });

  it('treats a page whose parent is missing as top level and survives a parent cycle', () => {
    const orphan = [at('o', 'Orphan', '2026-01-01', '2026-01-01', 'gone'), at('p', 'Parent', '2026-01-02')];
    expect(sortPages(orphan, 'title').map((p) => p.id)).toEqual(['o', 'p']);
    const cycle = [at('x', 'X', '2026-01-01', '2026-01-01', 'y'), at('y', 'Y', '2026-01-02', '2026-01-02', 'x'), at('r', 'R', '2026-01-03')];
    expect(sortPages(cycle, 'title').map((p) => p.id).sort()).toEqual(['r', 'x', 'y']);
  });
});
