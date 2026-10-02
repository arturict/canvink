import { describe, expect, it } from 'vitest';
import { filterSlashItems, formatShortDate } from './slashMenu';

describe('slash menu', () => {
  it('filters block types by German and English terms', () => {
    expect(filterSlashItems('').length).toBeGreaterThan(5);
    expect(filterSlashItems('übers').map((item) => item.id)).toEqual(['h1', 'h2', 'h3']);
    expect(filterSlashItems('todo').map((item) => item.id)).toEqual(['todo']);
    expect(filterSlashItems('tabelle').map((item) => item.id)).toEqual(['table']);
    expect(filterSlashItems('h').map((item) => item.id).slice(0, 3)).toEqual(['h1', 'h2', 'h3']);
    expect(filterSlashItems('h').map((item) => item.id)).not.toContain('text');
    expect(filterSlashItems('xyz')).toEqual([]);
  });

  it('formats dates like the weekly page titles', () => {
    expect(formatShortDate(new Date(2026, 3, 2))).toBe('02.04.2026');
  });
});
