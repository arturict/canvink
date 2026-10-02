import { describe, expect, it } from 'vitest';
import { applyBuiltinTemplate, isTemplatePage, titleFromTemplate } from './pageTemplates';
import type { PageDocV3 } from '../domain/v3';

const blankPage = { title: 'x', tags: [], createdAt: '2026-09-24T10:00:00.000Z', elementsById: {}, zOrder: [] } as unknown as PageDocV3;

describe('page templates', () => {
  it('titles new pages with the date, filling a {datum} placeholder', () => {
    const now = new Date(2026, 8, 24);
    expect(titleFromTemplate('Husi {datum}', now)).toBe('Husi 24.09.2026');
    expect(titleFromTemplate('{date} Physik', now)).toBe('24.09.2026 Physik');
    expect(titleFromTemplate('Wochenplan', now)).toBe('24.09.2026');
  });

  it('recognises pages tagged as templates', () => {
    expect(isTemplatePage({ tags: ['todo', 'vorlage'] })).toBe(true);
    expect(isTemplatePage({ tags: ['todo'] })).toBe(false);
  });

  it('builds the weekly homework table with one row per subject', () => {
    const page = applyBuiltinTemplate('homework-week', blankPage, (key) => key.split('.').at(-1) ?? key);
    const [element] = Object.values(page.elementsById);
    expect(page.zOrder).toEqual([element.id]);
    if (element.kind !== 'richText') throw new Error('Expected a text container.');
    const [table] = element.content.blocks;
    if (table.type !== 'table') throw new Error('Expected a table.');
    expect(table.rows.map((row) => row[0].map((span) => span.text).join(''))).toEqual(['subject', 'De', 'Wr', 'Mt', 'Gp']);
    expect(table.rows.every((row) => row.length === 4)).toBe(true);
  });
});
