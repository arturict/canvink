import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { V2RuntimeState, WorkspaceV2Runtime } from '../../storage/workspaceV2Runtime';
import SearchPanel from './SearchPanel';
import type { WorkspaceSearchController } from './searchRuntime';

describe('SearchPanel', () => {
  it('renders one labelled search field, and no filter form or maintenance button until it is opened', () => {
    const controller = {
      getSnapshot: () => ({ phase: 'ready', message: 'Bereit', recordCount: 1, rebuiltBecauseCorrupt: false, revision: 1 }),
      subscribe: vi.fn(() => vi.fn()),
      initialize: vi.fn(async () => undefined),
      updateWorkspace: vi.fn(),
      availableLanguages: vi.fn(async () => ['de-DE']),
      search: vi.fn(() => []),
      taskReview: vi.fn(() => []),
      describeQueryLimit: vi.fn(() => null),
      availableTags: vi.fn(() => ['prufung', 'todo']),
      rebuild: vi.fn(async () => undefined),
      cancelRebuild: vi.fn(),
      recognizePage: vi.fn(async () => undefined),
      dispose: vi.fn(),
    } as unknown as WorkspaceSearchController;
    const workspace = {
      notebooks: [{ notebookId: 'school', title: 'Schule', sections: [{ id: 'physics', title: 'Physik' }] }],
      pages: [],
      active: { notebookId: 'school', sectionId: 'physics', pageId: 'page-one' },
    } as unknown as V2RuntimeState;
    const markup = renderToStaticMarkup(createElement(SearchPanel, {
      runtime: {} as WorkspaceV2Runtime,
      workspace,
      activePageId: 'page-one',
      onNavigate: vi.fn(),
      controller,
    }));
    expect(markup).toContain('aria-label="Lokale Suche"');
    expect(markup).toContain('role="combobox"');
    expect(markup).toContain('aria-label="Arbeitsbereich lokal durchsuchen"');
    expect(markup).toContain('Ctrl K');
    expect(markup).not.toContain('<select');
    expect(markup).not.toContain('Index neu aufbauen');
    expect(markup).not.toContain('search-surface');
  });
});
