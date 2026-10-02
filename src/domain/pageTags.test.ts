import { describe, expect, it } from 'vitest';
import {
  PAGE_TAG_LIMIT,
  PAGE_TAG_MAX_LENGTH,
  normalizePageTag,
  normalizePageTags,
} from './pageTags';

describe('page tag normalization', () => {
  it('folds case, diacritics, and separators into one stored slug', () => {
    expect(normalizePageTag('  Prüfung  ')).toBe('prufung');
    expect(normalizePageTag('Zu Erledigen')).toBe('zu-erledigen');
    expect(normalizePageTag('zu_erledigen')).toBe('zu-erledigen');
    expect(normalizePageTag('Straße')).toBe('strasse');
    expect(normalizePageTag('--idea--')).toBe('idea');
    expect(normalizePageTag('a---b')).toBe('a-b');
  });

  it('keeps the imported OneNote namespace instead of flattening it', () => {
    expect(normalizePageTag('onenote:Client Request')).toBe('onenote:client-request');
    expect(normalizePageTag('onenote:')).toBeUndefined();
  });

  it('rejects tags with nothing printable left', () => {
    expect(normalizePageTag('')).toBeUndefined();
    expect(normalizePageTag('   ')).toBeUndefined();
    expect(normalizePageTag('***')).toBeUndefined();
  });

  it('bounds slug length', () => {
    expect(normalizePageTag('a'.repeat(200))).toHaveLength(PAGE_TAG_MAX_LENGTH);
  });

  it('deduplicates equivalent tags and stops at the page limit', () => {
    expect(normalizePageTags(['Idee', 'idee', 'IDEE'])).toEqual(['idee']);
    const many = Array.from({ length: PAGE_TAG_LIMIT + 5 }, (_, index) => `tag-${index}`);
    expect(normalizePageTags(many)).toHaveLength(PAGE_TAG_LIMIT);
  });
});
