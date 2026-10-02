import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import MoveCopyDialog, { type MoveCopyNotebook } from './MoveCopyDialog';

const notebooks: MoveCopyNotebook[] = [{
  id: 'bm',
  title: 'bm',
  color: '#7719aa',
  sections: [
    { id: 'husi', title: 'Husi' },
    { id: 'algebra', title: 'Algebra', groupId: 'math' },
    { id: 'nw', title: 'Naturwissenschaft', groupId: 'done' },
  ],
  sectionGroups: [
    { id: 'math', title: 'Mathematik' },
    { id: 'done', title: 'z_Abgeschlossen' },
    { id: 'sem1', title: '1. Semester', parentGroupId: 'done' },
  ],
}];

function render(kind: 'page' | 'section' | 'group', extra: Record<string, unknown> = {}) {
  return renderToStaticMarkup(createElement(MoveCopyDialog, {
    kind,
    subjectTitle: 'Subject',
    notebooks,
    current: { notebookId: 'bm' },
    onMove: vi.fn(),
    onCopy: kind === 'group' ? undefined : vi.fn(),
    onClose: vi.fn(),
    ...extra,
  }));
}

const optionLabels = (html: string) => [...html.matchAll(/role="option"[^>]*>(?:<svg.*?<\/svg>|<span class="move-copy-dialog__swatch"[^>]*><\/span>)<span>([^<]*)<\/span>/g)]
  .map((match) => match[1]);

describe('move or copy with section groups', () => {
  it('lets a page choose any section, with groups as indented headings', () => {
    const html = render('page', { current: { notebookId: 'bm', sectionId: 'husi' } });
    expect(optionLabels(html)).toEqual(['Husi', 'Algebra', 'Naturwissenschaft']);
    expect(html).toContain('Mathematik');
    expect(html).toContain('Kopieren');
  });

  it('lets a section choose the notebook top level or any group', () => {
    const html = render('section');
    expect(optionLabels(html)).toEqual(['bm', 'Mathematik', 'z_Abgeschlossen', '1. Semester']);
  });

  it('never offers a group itself or its descendants, and only moves groups', () => {
    const html = render('group', { excludedGroupIds: new Set(['done', 'sem1']), current: { notebookId: 'bm' } });
    expect(optionLabels(html)).toEqual(['bm', 'Mathematik']);
    expect(html).not.toContain('Kopieren');
  });
});
