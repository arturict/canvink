import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Notebook } from '../domain/types';
import { translate } from '../i18n/core';
import Sidebar from './Sidebar';

const TIME = '2026-08-03T00:00:00.000Z';
const notebooks: Notebook[] = [{
  id: 'notebook-1',
  title: 'Schule',
  color: '#123456',
  createdAt: TIME,
  updatedAt: TIME,
  sections: [{
    id: 'section-1',
    title: 'Physik',
    createdAt: TIME,
    updatedAt: TIME,
    pages: [{
      id: 'root',
      title: 'Vektoren',
      mode: 'a4',
      createdAt: TIME,
      updatedAt: TIME,
      elements: [],
    }, {
      id: 'child',
      parentPageId: 'root',
      title: 'Übung',
      mode: 'a4',
      createdAt: TIME,
      updatedAt: TIME,
      elements: [],
    }],
  }],
}, {
  id: 'notebook-2',
  title: 'Archiv',
  color: '#654321',
  createdAt: TIME,
  updatedAt: TIME,
  sections: [{ id: 'section-2', title: 'Alt', createdAt: TIME, updatedAt: TIME, pages: [] }],
}];

function markup(options: {
  pageTransfer?: boolean;
  structureTransfer?: boolean;
  readOnly?: boolean;
} = {}): string {
  const {
    pageTransfer = true,
    structureTransfer = false,
    readOnly = false,
  } = options;
  const noop = vi.fn();
  return renderToStaticMarkup(createElement(Sidebar, {
    notebooks,
    activeNotebookId: 'notebook-1',
    activeSectionId: 'section-1',
    activePageId: 'root',
    trashCount: 0,
    onClose: noop,
    onActivatePage: noop,
    onActivateNotebook: noop,
    onAddNotebook: noop,
    onRenameNotebook: noop,
    onAddSection: noop,
    onRenameSection: noop,
    onAddPage: noop,
    onTrashNotebook: noop,
    onTrashSection: noop,
    onTrashPage: noop,
    onDuplicatePage: noop,
    onReorderPage: noop,
    onTransferPage: pageTransfer ? noop : undefined,
    onTransferNotebook: structureTransfer ? noop : undefined,
    onTransferSection: structureTransfer ? noop : undefined,
    onOpenTrash: noop,
    capabilities: readOnly ? {
      transferPage: false,
      reorderNotebook: false,
      duplicateNotebook: false,
      reorderSection: false,
      duplicateSection: false,
      transferSection: false,
    } : {
      transferPage: pageTransfer,
      reorderNotebook: structureTransfer,
      duplicateNotebook: structureTransfer,
      reorderSection: structureTransfer,
      duplicateSection: structureTransfer,
      transferSection: structureTransfer,
    },
  }));
}

describe('OneNote-style navigation', () => {
  it('consolidates creation into one footer menu with canvas and Markdown choices', () => {
    const html = markup();
    expect(html.match(/class="sidebar-create-menu"/g)).toHaveLength(1);
    expect(html).toContain('data-page-kind="canvas"');
    expect(html).toContain('data-page-kind="markdown"');
    expect(html).not.toContain('class="add-page"');
  });

  it('keeps rows free of always-visible action buttons; commands open with right-click or Shift+F10', () => {
    const html = markup({ structureTransfer: true });
    expect(html).not.toContain('Aktionen für');
    expect(html).not.toContain('<details class="page-row__menu"');
    expect(html).not.toContain('<details class="section-row__menu"');
    expect(html.match(/aria-keyshortcuts="Shift\+F10"/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it('marks subpage levels and offers collapsing a page with subpages', () => {
    const html = markup();
    expect(html).toContain('data-page-row-id="child" data-depth="1"');
    expect(html).toContain('--page-depth:1');
    expect(html).toContain('aria-label="Unterseiten von Vektoren ausblenden"');
    expect(html).toContain('aria-expanded="true"');
  });

  it('makes pages draggable only when they can be moved', () => {
    expect(markup()).toContain('draggable="true"');
    expect(markup({ pageTransfer: false })).not.toContain('draggable="true"');
  });

  it('disables every structural drag in viewer mode', () => {
    const html = markup({ pageTransfer: false, structureTransfer: true, readOnly: true });
    expect(html).not.toContain('draggable="true"');
  });

  it('shows pinned pages under quick access and a chosen section colour', () => {
    const noop = vi.fn();
    const html = renderToStaticMarkup(createElement(Sidebar, {
      notebooks: [{
        ...notebooks[0],
        sections: [{ ...notebooks[0].sections[0], color: '#d13438' }],
      }],
      activeNotebookId: 'notebook-1',
      activeSectionId: 'section-1',
      activePageId: 'root',
      trashCount: 0,
      layout: 'panes',
      onClose: noop,
      onActivatePage: noop,
      onAddSection: noop,
      onRenameSection: noop,
      onAddPage: noop,
      onTrashSection: noop,
      onTrashPage: noop,
      onDuplicatePage: noop,
      onReorderPage: noop,
      onOpenTrash: noop,
      pinnedPageIds: new Set(['child']),
      quickAccess: [{
        pageId: 'child',
        title: 'Übung',
        notebookId: 'notebook-1',
        notebookTitle: 'Schule',
        sectionId: 'section-1',
        sectionTitle: 'Physik',
        sectionColor: '#d13438',
      }],
    }));
    expect(html).toContain('Schnellzugriff');
    expect(html).toContain('Schule › Physik');
    expect(html).toContain('aria-label="angeheftet"');
    expect(html).toContain('background:#d13438');
  });

  it('shows section groups as folding folders after the top-level sections', () => {
    const noop = vi.fn();
    const html = renderToStaticMarkup(createElement(Sidebar, {
      notebooks: [{
        ...notebooks[0],
        sections: [
          { ...notebooks[0].sections[0], id: 'algebra', title: 'Algebra', groupId: 'math' },
          { ...notebooks[0].sections[0], id: 'husi', title: 'Husi', pages: [] },
          { ...notebooks[0].sections[0], id: 'lost', title: 'Verwaist', groupId: 'deleted', pages: [] },
        ],
        sectionGroups: [{ id: 'math', title: 'Mathematik' }],
      }],
      activeNotebookId: 'notebook-1',
      activeSectionId: 'algebra',
      activePageId: 'root',
      trashCount: 0,
      layout: 'panes',
      onClose: noop,
      onActivatePage: noop,
      onAddSection: noop,
      onAddSectionGroup: noop,
      onRenameSection: noop,
      onAddPage: noop,
      onTrashSection: noop,
      onTrashPage: noop,
      onDuplicatePage: noop,
      onReorderPage: noop,
      onOpenTrash: noop,
    }));
    const order = ['Husi', 'Verwaist', 'Mathematik', 'Algebra'].map((title) => html.indexOf(`>${title}</span>`));
    expect(order.every((position) => position > 0)).toBe(true);
    expect([...order].sort((left, right) => left - right)).toEqual(order);
    expect(html).toMatch(/class="section-group__button"[^>]*aria-expanded="true"/);
    expect(html).toContain('role="list" aria-label="Mathematik"');
    expect(html).toContain('--nav-depth:1');
    expect(html).toContain('Neue Abschnittsgruppe');
  });

  it('keeps the template menu to names: no descriptions, no empty "Meine Vorlagen"', () => {
    const noop = vi.fn();
    const props = {
      notebooks,
      activeNotebookId: 'notebook-1',
      activeSectionId: 'section-1',
      activePageId: 'root',
      trashCount: 0,
      layout: 'panes' as const,
      onClose: noop,
      onActivatePage: noop,
      onAddSection: noop,
      onRenameSection: noop,
      onAddPage: noop,
      onAddPageFromTemplate: noop,
      onTrashSection: noop,
      onTrashPage: noop,
      onDuplicatePage: noop,
      onReorderPage: noop,
      onOpenTrash: noop,
    };
    const empty = renderToStaticMarkup(createElement(Sidebar, props));
    expect(empty).toContain('>Leere Seite</button>');
    expect(empty).toContain('>Hausaufgaben-Woche</button>');
    expect(empty).not.toContain('Meine Vorlagen');
    const popover = empty.slice(empty.indexOf('page-template-menu__popover'), empty.indexOf('</details>'));
    expect(popover).not.toContain('<small>');
    expect(popover).not.toContain('<p class="page-template-menu__hint"');
    const mine = renderToStaticMarkup(createElement(Sidebar, {
      ...props,
      templates: [{ pageId: 'child', title: 'Husi-Woche', sectionId: 'section-2' }],
    }));
    expect(mine).toContain('Meine Vorlagen');
    expect(mine).toContain('>Husi-Woche</button>');
  });

  it('keeps the matching English vocabulary for the new commands', () => {
    expect(translate('en', 'menu.moveOrCopy')).toBe('Move or copy…');
    expect(translate('en', 'menu.indentPage')).toBe('Make subpage');
    expect(translate('de', 'menu.outdentPage')).toBe('Unterseite heraufstufen');
  });
});
