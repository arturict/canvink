import { describe, expect, it } from 'vitest';
import { createDefaultWorkspace } from './sample';
import {
  activatePage,
  addPageElement,
  appendPage,
  createPage,
  getActiveContext,
  normalizeStoredWorkspace,
  normalizeWorkspace,
  pageToMarkdown,
  renameNotebook,
  renameSection,
  restoreTrashEntry,
  searchWorkspace,
  trashElement,
  trashPage,
} from './workspace';

function activateDefaultExample() {
  const workspace = createDefaultWorkspace();
  const notebook = workspace.notebooks[0];
  const section = notebook.sections.find((item) => item.title === 'Examples')!;
  const page = section.pages.find((item) => item.title === 'Start here')!;
  return activatePage(workspace, notebook.id, section.id, page.id);
}

describe('workspace model', () => {
  it('creates a usable nested default workspace', () => {
    const workspace = createDefaultWorkspace();
    const context = getActiveContext(workspace);

    expect(context?.notebook.title).toBe('My notebook');
    expect(context?.section.title).toBe('Notes');
    expect(context?.page.title).toBe('Quick note');
    expect(context?.page.elements).toEqual([]);
    expect(workspace.notebooks[0].sections.map((section) => section.title)).toEqual([
      'Notes',
      'Examples',
      'Templates',
    ]);
  });

  it('renames notebooks and sections without changing their identities', () => {
    const workspace = createDefaultWorkspace();
    const context = getActiveContext(workspace)!;
    const renamedNotebook = renameNotebook(
      workspace,
      context.notebook.id,
      '  Product notes  ',
    );
    const renamedSection = renameSection(
      renamedNotebook,
      context.notebook.id,
      context.section.id,
      '  Research  ',
    );
    const renamedContext = getActiveContext(renamedSection)!;

    expect(renamedContext.notebook.id).toBe(context.notebook.id);
    expect(renamedContext.notebook.title).toBe('Product notes');
    expect(renamedContext.section.id).toBe(context.section.id);
    expect(renamedContext.section.title).toBe('Research');
  });

  it('distinguishes a missing or canonical empty first-run store from existing data', () => {
    const missing = normalizeStoredWorkspace(undefined);
    const canonicalEmpty = normalizeStoredWorkspace({
      schemaVersion: 1,
      updatedAt: '1970-01-01T00:00:00.000Z',
      notebooks: [],
      trash: [],
      activeNotebookId: '',
      activeSectionId: '',
      activePageId: '',
    });
    const existing = normalizeStoredWorkspace(createDefaultWorkspace());

    expect(missing.storageState).toBe('uninitialized');
    expect(getActiveContext(missing.workspace)?.page.title).toBe('Quick note');
    expect(canonicalEmpty.storageState).toBe('uninitialized');
    expect(getActiveContext(canonicalEmpty.workspace)?.page.title).toBe('Quick note');
    expect(existing.storageState).toBe('existing');
  });

  it('rejects null and non-canonical empty records instead of initializing over them', () => {
    expect(() => normalizeStoredWorkspace(null)).toThrow(/malformed/);
    expect(() =>
      normalizeStoredWorkspace({
        schemaVersion: 1,
        updatedAt: '2026-07-29T00:00:00.000Z',
        notebooks: [],
        trash: [],
        activeNotebookId: '',
        activeSectionId: '',
        activePageId: '',
      }),
    ).toThrow(/non-empty/);
  });

  it('rejects a newer schema instead of replacing it', () => {
    const newerData = { schemaVersion: 2, notebooks: [{ future: 'preserve me' }] };
    expect(() => normalizeWorkspace(newerData)).toThrow(/Unsupported Canvink schema 2/);
    expect(newerData).toEqual({
      schemaVersion: 2,
      notebooks: [{ future: 'preserve me' }],
    });
  });

  it('rejects malformed non-empty records instead of replacing them', () => {
    const malformed = {
      schemaVersion: 1,
      notebooks: [{ id: 'notebook-1', title: 'Keep me', sections: 'broken' }],
    };
    expect(() => normalizeWorkspace(malformed)).toThrow(/malformed/);
    expect(malformed.notebooks[0].title).toBe('Keep me');
  });

  it('never treats retained trash or extension data as an empty first run', () => {
    const withTrash = {
      schemaVersion: 1,
      updatedAt: '2026-07-29T00:00:00.000Z',
      notebooks: [],
      trash: [{ preserve: 'deleted content' }],
      activeNotebookId: '',
      activeSectionId: '',
      activePageId: '',
    };
    const withExtension = {
      schemaVersion: 1,
      updatedAt: '2026-07-29T00:00:00.000Z',
      notebooks: [],
      trash: [],
      activeNotebookId: '',
      activeSectionId: '',
      activePageId: '',
      futureSyncState: { preserve: true },
    };

    expect(() => normalizeWorkspace(withTrash)).toThrow(/non-empty/);
    expect(() => normalizeWorkspace(withExtension)).toThrow(/non-empty/);
  });

  it('rejects a non-empty notebook without its required section', () => {
    const nonEmptyUnknown = {
      schemaVersion: 1,
      updatedAt: '2026-07-29T00:00:00.000Z',
      notebooks: [
        {
          id: 'notebook-future',
          title: 'Preserve me',
          color: '#000000',
          createdAt: '2026-07-29T00:00:00.000Z',
          updatedAt: '2026-07-29T00:00:00.000Z',
          sections: [],
        },
      ],
      trash: [],
      activeNotebookId: 'notebook-future',
      activeSectionId: '',
      activePageId: '',
    };

    expect(() => normalizeWorkspace(nonEmptyUnknown)).toThrow(
      /must contain at least one section/,
    );
    expect(nonEmptyUnknown.notebooks[0].title).toBe('Preserve me');
  });

  it('searches titles and text content case-insensitively', () => {
    const workspace = createDefaultWorkspace();
    const textResults = searchWorkspace(workspace, 'LOCAL-FIRST');
    const notebookResults = searchWorkspace(workspace, 'MY NOTEBOOK');
    const sectionResults = searchWorkspace(workspace, 'NOTES');

    expect(textResults.some((result) => result.kind === 'text')).toBe(true);
    expect(notebookResults.filter((result) => result.kind === 'notebook')).toHaveLength(1);
    expect(sectionResults.filter((result) => result.kind === 'section')).toHaveLength(1);
  });

  it('adds one element and can move it to and from trash', () => {
    const workspace = createDefaultWorkspace();
    const context = getActiveContext(workspace)!;
    const textElement = {
      id: 'text-test',
      kind: 'text' as const,
      x: 1,
      y: 2,
      width: 100,
      height: 50,
      text: 'Remember this',
      color: '#000',
      fontSize: 18,
      fontFamily: 'sans-serif',
      fontWeight: 400 as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const added = addPageElement(workspace, context.page.id, textElement);
    const trashed = trashElement(added, context.page.id, textElement.id);

    expect(getActiveContext(trashed)?.page.elements.some((item) => item.id === textElement.id)).toBe(false);
    expect(trashed.trash).toHaveLength(1);

    const restored = restoreTrashEntry(trashed, trashed.trash[0].id);
    expect(getActiveContext(restored)?.page.elements.some((item) => item.id === textElement.id)).toBe(true);
  });

  it('restores an element at its original canvas stacking position', () => {
    const workspace = activateDefaultExample();
    const context = getActiveContext(workspace)!;
    const originalIds = context.page.elements.map((element) => element.id);
    const target = context.page.elements[1];
    const trashed = trashElement(workspace, context.page.id, target.id);
    const restored = restoreTrashEntry(trashed, trashed.trash.at(-1)!.id);

    expect(getActiveContext(restored)!.page.elements.map((element) => element.id)).toEqual(
      originalIds,
    );
  });

  it('restores sibling stacking order for every three-item permutation', () => {
    const permutations = <T,>(items: T[]): T[][] =>
      items.length <= 1
        ? [items]
        : items.flatMap((item, index) =>
            permutations(items.filter((_, candidate) => candidate !== index)).map(
              (rest) => [item, ...rest],
            ),
          );
    const seed = activateDefaultExample();
    const seedContext = getActiveContext(seed)!;
    const originalIds = seedContext.page.elements.map((element) => element.id);
    const targetIds = originalIds.slice(0, 3);
    expect(targetIds).toHaveLength(3);

    for (const deleteOrder of permutations(targetIds)) {
      let trashed = seed;
      for (const elementId of deleteOrder) {
        trashed = trashElement(trashed, seedContext.page.id, elementId);
      }
      for (const restoreOrder of permutations(targetIds)) {
        let restored = trashed;
        for (const elementId of restoreOrder) {
          const entry = restored.trash.find(
            (candidate) =>
              candidate.kind === 'element' && candidate.item.id === elementId,
          )!;
          restored = restoreTrashEntry(restored, entry.id);
        }
        expect(
          getActiveContext(restored)!.page.elements.map((element) => element.id),
          `delete ${deleteOrder.join(',')} then restore ${restoreOrder.join(',')}`,
        ).toEqual(originalIds);
      }
    }
  });

  it('restores an original stack below elements added while it was trashed', () => {
    const seed = activateDefaultExample();
    const context = getActiveContext(seed)!;
    const originalIds = context.page.elements.map((element) => element.id);
    expect(originalIds.length).toBeGreaterThan(0);
    let emptied = seed;
    for (const elementId of originalIds) {
      emptied = trashElement(emptied, context.page.id, elementId);
    }
    const addedAt = new Date().toISOString();
    const lateElement = {
      ...structuredClone(context.page.elements[0]),
      id: 'late-element',
      createdAt: addedAt,
      updatedAt: addedAt,
    };
    let restored = addPageElement(emptied, context.page.id, lateElement);
    for (const elementId of [...originalIds].reverse()) {
      const entry = restored.trash.find(
        (candidate) =>
          candidate.kind === 'element' && candidate.item.id === elementId,
      )!;
      restored = restoreTrashEntry(restored, entry.id);
    }

    expect(
      getActiveContext(restored)!.page.elements.map((element) => element.id),
    ).toEqual([...originalIds, lateElement.id]);
  });

  it('keeps a trashed element when its destination page is unavailable', () => {
    const workspace = activateDefaultExample();
    const context = getActiveContext(workspace)!;
    const element = context.page.elements[0];
    const withoutElement = trashElement(workspace, context.page.id, element.id);
    const withoutPage = trashPage(
      withoutElement,
      context.notebook.id,
      context.section.id,
      context.page.id,
    );
    const elementEntry = withoutPage.trash.find((entry) => entry.kind === 'element')!;

    expect(restoreTrashEntry(withoutPage, elementEntry.id)).toBe(withoutPage);
    expect(withoutPage.trash).toContain(elementEntry);
  });

  it('keeps a subpage in trash until its parent page is restored', () => {
    const workspace = createDefaultWorkspace();
    const context = getActiveContext(workspace)!;
    const parent = createPage('Parent');
    const child = createPage('Child', 'free', parent.id);
    const withParent = appendPage(
      workspace,
      context.notebook.id,
      context.section.id,
      parent,
    );
    const withChild = appendPage(
      withParent,
      context.notebook.id,
      context.section.id,
      child,
    );
    const withoutChild = trashPage(
      withChild,
      context.notebook.id,
      context.section.id,
      child.id,
    );
    const withoutParent = trashPage(
      withoutChild,
      context.notebook.id,
      context.section.id,
      parent.id,
    );
    const childEntry = withoutParent.trash.find(
      (entry) => entry.kind === 'page' && 'title' in entry.item && entry.item.title === 'Child',
    )!;

    expect(restoreTrashEntry(withoutParent, childEntry.id)).toBe(withoutParent);
  });

  it('reattaches direct child pages when their parent is restored', () => {
    const workspace = createDefaultWorkspace();
    const context = getActiveContext(workspace)!;
    const parent = createPage('Parent');
    const child = createPage('Child', 'free', parent.id);
    const withParent = appendPage(
      workspace,
      context.notebook.id,
      context.section.id,
      parent,
    );
    const withChild = appendPage(
      withParent,
      context.notebook.id,
      context.section.id,
      child,
    );
    const withoutParent = trashPage(
      withChild,
      context.notebook.id,
      context.section.id,
      parent.id,
    );
    const parentEntry = withoutParent.trash.find(
      (entry) => entry.kind === 'page' && entry.item.id === parent.id,
    )!;
    const restored = restoreTrashEntry(withoutParent, parentEntry.id);
    const restoredSection = getActiveContext(restored)!.section;

    expect(restoredSection.pages.find((page) => page.id === child.id)?.parentPageId).toBe(
      parent.id,
    );
  });

  it('preserves a child parent when both are trashed parent-first', () => {
    const workspace = createDefaultWorkspace();
    const context = getActiveContext(workspace)!;
    const parent = createPage('Parent');
    const child = createPage('Child', 'free', parent.id);
    const withParent = appendPage(
      workspace,
      context.notebook.id,
      context.section.id,
      parent,
    );
    const withChild = appendPage(
      withParent,
      context.notebook.id,
      context.section.id,
      child,
    );
    const withoutParent = trashPage(
      withChild,
      context.notebook.id,
      context.section.id,
      parent.id,
    );
    const withoutBoth = trashPage(
      withoutParent,
      context.notebook.id,
      context.section.id,
      child.id,
    );
    const parentEntry = withoutBoth.trash.find(
      (entry) => entry.kind === 'page' && entry.item.id === parent.id,
    )!;
    const childEntry = withoutBoth.trash.find(
      (entry) => entry.kind === 'page' && entry.item.id === child.id,
    )!;
    const parentRestored = restoreTrashEntry(withoutBoth, parentEntry.id);
    const bothRestored = restoreTrashEntry(parentRestored, childEntry.id);
    const restoredSection = getActiveContext(bothRestored)!.section;

    expect(restoredSection.pages.find((page) => page.id === child.id)?.parentPageId).toBe(
      parent.id,
    );
  });

  it('rejects malformed element payloads and non-finite geometry', () => {
    const invalid = structuredClone(createDefaultWorkspace()) as unknown as {
      notebooks: Array<{ sections: Array<{ pages: Array<{ elements: unknown[] }> }> }>;
    };
    invalid.notebooks[0].sections[0].pages[0].elements[0] = {
      id: 'bad-element',
      kind: 'text',
      x: Number.NaN,
      y: 0,
      width: 100,
      height: 50,
      text: 'Do not persist',
      color: '#000000',
      fontSize: 16,
      fontFamily: 'sans-serif',
      fontWeight: 400,
      createdAt: '2026-07-29T00:00:00.000Z',
      updatedAt: '2026-07-29T00:00:00.000Z',
    };

    expect(() => normalizeWorkspace(invalid)).toThrow(/finite number/);
  });

  it('rejects titles that exceed the desktop UTF-8 byte limit', () => {
    const workspace = structuredClone(createDefaultWorkspace());
    workspace.notebooks[0].title = '😀'.repeat(5_000);

    expect(() => normalizeWorkspace(workspace)).toThrow(/UTF-8 limit/);
  });

  it('rejects page hierarchies deeper than the supported navigation limit', () => {
    const workspace = structuredClone(createDefaultWorkspace());
    const section = workspace.notebooks[0].sections[0];
    let parentPageId: string | undefined;
    for (let index = 0; index < 66; index += 1) {
      const page = createPage(`Depth ${index}`, 'free', parentPageId);
      section.pages.push(page);
      parentPageId = page.id;
    }

    expect(() => normalizeWorkspace(workspace)).toThrow(/64-level/);
  });

  it('refuses a user-created subpage beyond depth 64 before changing state', () => {
    const workspace = createDefaultWorkspace();
    const context = getActiveContext(workspace)!;
    let current = appendPage(
      workspace,
      context.notebook.id,
      context.section.id,
      createPage('Depth 0'),
    );
    let parentPageId = current.activePageId;
    for (let depth = 1; depth <= 64; depth += 1) {
      const next = appendPage(
        current,
        context.notebook.id,
        context.section.id,
        createPage(`Depth ${depth}`, 'free', parentPageId),
      );
      expect(next).not.toBe(current);
      current = next;
      parentPageId = next.activePageId;
    }

    expect(
      appendPage(
        current,
        context.notebook.id,
        context.section.id,
        createPage('Depth 65', 'free', parentPageId),
      ),
    ).toBe(current);
  });

  it('rejects a deepest-first oversized hierarchy without recursive traversal', () => {
    const workspace = structuredClone(createDefaultWorkspace());
    const section = workspace.notebooks[0].sections[0];
    let parentPageId: string | undefined;
    const chain = [];
    for (let index = 0; index < 256; index += 1) {
      const page = createPage(`Depth ${index}`, 'free', parentPageId);
      chain.push(page);
      parentPageId = page.id;
    }
    section.pages.push(...chain.reverse());

    expect(() => normalizeWorkspace(workspace)).toThrow(/64-level/);
  });

  it('rejects active IDs that do not reference one nested page', () => {
    const workspace = structuredClone(createDefaultWorkspace());
    workspace.activePageId = 'page-missing';

    expect(() => normalizeWorkspace(workspace)).toThrow(/active notebook, section, and page/);
  });

  it('rejects inactive empty notebooks and sections that domain actions cannot use', () => {
    const emptyNotebook = structuredClone(createDefaultWorkspace());
    emptyNotebook.notebooks.push({
      id: 'notebook-empty',
      title: 'Empty',
      color: '#000000',
      createdAt: '2026-07-29T00:00:00.000Z',
      updatedAt: '2026-07-29T00:00:00.000Z',
      sections: [],
    });
    const emptySection = structuredClone(createDefaultWorkspace());
    emptySection.notebooks[0].sections.push({
      id: 'section-empty',
      title: 'Empty',
      createdAt: '2026-07-29T00:00:00.000Z',
      updatedAt: '2026-07-29T00:00:00.000Z',
      pages: [],
    });

    expect(() => normalizeWorkspace(emptyNotebook)).toThrow(/at least one section/);
    expect(() => normalizeWorkspace(emptySection)).toThrow(/at least one page/);
  });

  it('does not mutate or retarget a workspace when an append destination disappeared', () => {
    const workspace = activateDefaultExample();
    const page = createPage('Late import');
    const existingElement = getActiveContext(workspace)!.page.elements[0];

    expect(addPageElement(workspace, 'page-missing', existingElement)).toBe(workspace);
    expect(appendPage(workspace, 'notebook-missing', 'section-missing', page)).toBe(
      workspace,
    );
  });

  it('never trashes the final page in a section', () => {
    let workspace = createDefaultWorkspace();
    const first = getActiveContext(workspace)!;
    const onlyPageSection = first.notebook.sections.find((section) => section.pages.length === 1)!;
    workspace = activatePage(
      workspace,
      first.notebook.id,
      onlyPageSection.id,
      onlyPageSection.pages[0].id,
    );

    const result = trashPage(
      workspace,
      first.notebook.id,
      onlyPageSection.id,
      onlyPageSection.pages[0].id,
    );
    expect(result).toBe(workspace);
  });

  it('moves a page to trash when a sibling exists', () => {
    const workspace = createDefaultWorkspace();
    const context = getActiveContext(workspace)!;
    const added = appendPage(
      workspace,
      context.notebook.id,
      context.section.id,
      createPage('Temporary'),
    );
    const result = trashPage(
      added,
      context.notebook.id,
      context.section.id,
      added.activePageId,
    );

    expect(result.trash.at(-1)?.kind).toBe('page');
    expect(result.activePageId).not.toBe(added.activePageId);
  });

  it('exports readable markdown from text objects', () => {
    const context = getActiveContext(activateDefaultExample())!;
    const markdown = pageToMarkdown(context);

    expect(markdown).toContain('# Start here');
    expect(markdown).toContain('Welcome to Canvink');
  });
});
