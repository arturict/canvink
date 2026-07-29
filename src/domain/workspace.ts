import { createId } from './ids';
import { MAX_PAGE_DEPTH, MAX_TITLE_BYTES } from './limits';
import { createDefaultWorkspace } from './sample';
import { truncateUtf8 } from './strings';
import { assertWorkspaceShape } from './validation';
import {
  WORKSPACE_SCHEMA_VERSION,
  type ActiveContext,
  type Notebook,
  type Page,
  type PageElement,
  type Section,
  type TrashEntry,
  type WorkspaceSearchResult,
  type WorkspaceState,
} from './types';

const SEARCH_LIMIT = 40;
const EMPTY_WORKSPACE_FIELDS = new Set([
  'schemaVersion',
  'updatedAt',
  'notebooks',
  'trash',
  'activeNotebookId',
  'activeSectionId',
  'activePageId',
]);

function now(): string {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function getActiveContext(workspace: WorkspaceState): ActiveContext | null {
  const notebook =
    workspace.notebooks.find((item) => item.id === workspace.activeNotebookId) ??
    workspace.notebooks[0];
  const section =
    notebook?.sections.find((item) => item.id === workspace.activeSectionId) ??
    notebook?.sections[0];
  const page =
    section?.pages.find((item) => item.id === workspace.activePageId) ??
    section?.pages[0];

  return notebook && section && page ? { notebook, section, page } : null;
}

export function normalizeWorkspace(value: unknown): WorkspaceState {
  if (value === undefined || value === null) {
    return createDefaultWorkspace();
  }

  if (!isRecord(value)) {
    throw new Error('Stored Canvink data is malformed and was not changed.');
  }
  if (value.schemaVersion !== WORKSPACE_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported Canvink schema ${String(value.schemaVersion)}. Stored data was not changed.`,
    );
  }
  if (!Array.isArray(value.notebooks)) {
    throw new Error('Stored Canvink notebooks are malformed and were not changed.');
  }
  if (value.notebooks.length === 0) {
    const hasEmptyTrash = Array.isArray(value.trash) && value.trash.length === 0;
    const hasUnknownFields = Object.keys(value).some(
      (key) => !EMPTY_WORKSPACE_FIELDS.has(key),
    );
    const hasValidEmptySelection = [
      value.activeNotebookId,
      value.activeSectionId,
      value.activePageId,
    ].every((id) => id === '');
    const hasTimestamp = typeof value.updatedAt === 'string';

    if (
      !hasEmptyTrash ||
      hasUnknownFields ||
      !hasValidEmptySelection ||
      !hasTimestamp
    ) {
      throw new Error(
        'Stored Canvink data is non-empty but has no usable notebook. It was not changed.',
      );
    }
    return createDefaultWorkspace();
  }

  assertWorkspaceShape(value);
  const candidate = value;
  const context = getActiveContext(candidate);
  if (!context) {
    throw new Error('Stored Canvink data is non-empty but has no usable page. It was not changed.');
  }

  return {
    ...candidate,
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    trash: Array.isArray(candidate.trash) ? candidate.trash : [],
    activeNotebookId: context.notebook.id,
    activeSectionId: context.section.id,
    activePageId: context.page.id,
  };
}

export function activatePage(
  workspace: WorkspaceState,
  notebookId: string,
  sectionId: string,
  pageId: string,
): WorkspaceState {
  return {
    ...workspace,
    activeNotebookId: notebookId,
    activeSectionId: sectionId,
    activePageId: pageId,
  };
}

export function updatePage(
  workspace: WorkspaceState,
  pageId: string,
  updater: (page: Page) => Page,
): WorkspaceState {
  const pageExists = workspace.notebooks.some((notebook) =>
    notebook.sections.some((section) =>
      section.pages.some((page) => page.id === pageId),
    ),
  );
  if (!pageExists) return workspace;

  const updatedAt = now();
  return {
    ...workspace,
    updatedAt,
    notebooks: workspace.notebooks.map((notebook) => ({
      ...notebook,
      updatedAt: notebook.sections.some((section) => section.pages.some((page) => page.id === pageId))
        ? updatedAt
        : notebook.updatedAt,
      sections: notebook.sections.map((section) => ({
        ...section,
        updatedAt: section.pages.some((page) => page.id === pageId) ? updatedAt : section.updatedAt,
        pages: section.pages.map((page) =>
          page.id === pageId ? { ...updater(page), updatedAt } : page,
        ),
      })),
    })),
  };
}

export function addPageElement(
  workspace: WorkspaceState,
  pageId: string,
  element: PageElement,
): WorkspaceState {
  return updatePage(workspace, pageId, (page) => ({
    ...page,
    elements: [...page.elements, element],
  }));
}

export function updatePageElement(
  workspace: WorkspaceState,
  pageId: string,
  elementId: string,
  patch: Partial<PageElement>,
): WorkspaceState {
  return updatePage(workspace, pageId, (page) => ({
    ...page,
    elements: page.elements.map((element) =>
      element.id === elementId
        ? ({ ...element, ...patch, id: element.id, kind: element.kind, updatedAt: now() } as PageElement)
        : element,
    ),
  }));
}

export function createPage(
  title = 'Untitled page',
  mode: Page['mode'] = 'free',
  parentPageId?: string,
): Page {
  const createdAt = now();
  return {
    id: createId('page'),
    ...(parentPageId ? { parentPageId } : {}),
    title,
    mode,
    createdAt,
    updatedAt: createdAt,
    elements: [],
  };
}

export function createSection(title = 'New section'): Section {
  const createdAt = now();
  return {
    id: createId('section'),
    title,
    createdAt,
    updatedAt: createdAt,
    pages: [createPage()],
  };
}

export function createNotebook(title = 'New notebook'): Notebook {
  const createdAt = now();
  return {
    id: createId('notebook'),
    title,
    color: '#4e7d6b',
    createdAt,
    updatedAt: createdAt,
    sections: [createSection()],
  };
}

export function appendNotebook(workspace: WorkspaceState, notebook: Notebook): WorkspaceState {
  const section = notebook.sections[0];
  const page = section.pages[0];
  return {
    ...workspace,
    updatedAt: now(),
    notebooks: [...workspace.notebooks, notebook],
    activeNotebookId: notebook.id,
    activeSectionId: section.id,
    activePageId: page.id,
  };
}

export function renameNotebook(
  workspace: WorkspaceState,
  notebookId: string,
  title: string,
): WorkspaceState {
  const trimmedTitle = truncateUtf8(title.trim(), MAX_TITLE_BYTES);
  if (!trimmedTitle) return workspace;
  const updatedAt = now();
  return {
    ...workspace,
    updatedAt,
    notebooks: workspace.notebooks.map((notebook) =>
      notebook.id === notebookId
        ? { ...notebook, title: trimmedTitle, updatedAt }
        : notebook,
    ),
  };
}

export function renameSection(
  workspace: WorkspaceState,
  notebookId: string,
  sectionId: string,
  title: string,
): WorkspaceState {
  const trimmedTitle = truncateUtf8(title.trim(), MAX_TITLE_BYTES);
  if (!trimmedTitle) return workspace;
  const updatedAt = now();
  return {
    ...workspace,
    updatedAt,
    notebooks: workspace.notebooks.map((notebook) =>
      notebook.id === notebookId
        ? {
            ...notebook,
            updatedAt,
            sections: notebook.sections.map((section) =>
              section.id === sectionId
                ? { ...section, title: trimmedTitle, updatedAt }
                : section,
            ),
          }
        : notebook,
    ),
  };
}

export function appendSection(
  workspace: WorkspaceState,
  notebookId: string,
  section: Section,
): WorkspaceState {
  const updatedAt = now();
  const notebook = workspace.notebooks.find((item) => item.id === notebookId);
  if (!notebook) return workspace;

  return {
    ...workspace,
    updatedAt,
    notebooks: workspace.notebooks.map((item) =>
      item.id === notebookId
        ? { ...item, updatedAt, sections: [...item.sections, section] }
        : item,
    ),
    activeNotebookId: notebookId,
    activeSectionId: section.id,
    activePageId: section.pages[0].id,
  };
}

export function appendPage(
  workspace: WorkspaceState,
  notebookId: string,
  sectionId: string,
  page: Page,
): WorkspaceState {
  const notebook = workspace.notebooks.find((item) => item.id === notebookId);
  const section = notebook?.sections.find((item) => item.id === sectionId);
  if (
    !section ||
    (page.parentPageId &&
      !section.pages.some((existingPage) => existingPage.id === page.parentPageId))
  ) {
    return workspace;
  }
  if (page.parentPageId) {
    const pagesById = new Map(section.pages.map((existingPage) => [existingPage.id, existingPage]));
    let depth = 1;
    let ancestorId: string | undefined = page.parentPageId;
    const visited = new Set<string>();
    while (ancestorId) {
      if (visited.has(ancestorId)) return workspace;
      visited.add(ancestorId);
      const ancestor = pagesById.get(ancestorId);
      if (!ancestor) return workspace;
      ancestorId = ancestor.parentPageId;
      if (ancestorId) depth += 1;
      if (depth > MAX_PAGE_DEPTH) return workspace;
    }
  }

  const updatedAt = now();
  return {
    ...workspace,
    updatedAt,
    notebooks: workspace.notebooks.map((notebook) =>
      notebook.id === notebookId
        ? {
            ...notebook,
            updatedAt,
            sections: notebook.sections.map((section) =>
              section.id === sectionId
                ? { ...section, updatedAt, pages: [...section.pages, page] }
                : section,
            ),
          }
        : notebook,
    ),
    activeNotebookId: notebookId,
    activeSectionId: sectionId,
    activePageId: page.id,
  };
}

function trashEntry(
  kind: TrashEntry['kind'],
  item: TrashEntry['item'],
  origin: TrashEntry['origin'],
): TrashEntry {
  return {
    id: createId('trash'),
    kind,
    deletedAt: now(),
    origin,
    item,
  };
}

function insertAt<T>(items: T[], item: T, index?: number): T[] {
  const next = [...items];
  const target = Number.isSafeInteger(index)
    ? Math.min(Math.max(index ?? next.length, 0), next.length)
    : next.length;
  next.splice(target, 0, item);
  return next;
}

function siblingOrigin<T extends { id: string }>(
  items: T[],
  index: number,
  trash: TrashEntry[],
  kind: TrashEntry['kind'],
): Pick<TrashEntry['origin'], 'index' | 'previousSiblingId' | 'nextSiblingId'> {
  const itemId = items[index]?.id;
  const previousTrashedSibling = trash.find(
    (entry) =>
      entry.kind === kind &&
      itemId !== undefined &&
      entry.origin.nextSiblingId === itemId,
  );
  const nextTrashedSibling = trash.find(
    (entry) =>
      entry.kind === kind &&
      itemId !== undefined &&
      entry.origin.previousSiblingId === itemId,
  );
  return {
    index,
    previousSiblingId: previousTrashedSibling?.item.id ?? items[index - 1]?.id,
    nextSiblingId: nextTrashedSibling?.item.id ?? items[index + 1]?.id,
  };
}

function findLiveSiblingIndex(
  liveSiblingIndices: Map<string, number>,
  siblingId: string | undefined,
  direction: 'previousSiblingId' | 'nextSiblingId',
  trashedSiblings: Map<string, TrashEntry>,
): number {
  const visited = new Set<string>();
  let candidateId = siblingId;
  while (candidateId && !visited.has(candidateId)) {
    visited.add(candidateId);
    const liveIndex = liveSiblingIndices.get(candidateId);
    if (liveIndex !== undefined) return liveIndex;
    const trashed = trashedSiblings.get(candidateId);
    candidateId = trashed?.origin[direction];
  }
  return -1;
}

function insertAtOrigin<T extends { id: string }>(
  items: T[],
  item: T,
  origin: TrashEntry['origin'],
  trash: TrashEntry[],
  kind: TrashEntry['kind'],
): T[] {
  const liveSiblingIndices = new Map(
    items.map((candidate, index) => [candidate.id, index]),
  );
  const trashedSiblings = new Map<string, TrashEntry>();
  for (const entry of trash) {
    if (entry.kind === kind) trashedSiblings.set(entry.item.id, entry);
  }
  const nextSiblingIndex = findLiveSiblingIndex(
    liveSiblingIndices,
    origin.nextSiblingId,
    'nextSiblingId',
    trashedSiblings,
  );
  if (nextSiblingIndex >= 0) return insertAt(items, item, nextSiblingIndex);

  const previousSiblingIndex = findLiveSiblingIndex(
    liveSiblingIndices,
    origin.previousSiblingId,
    'previousSiblingId',
    trashedSiblings,
  );
  if (previousSiblingIndex >= 0) {
    return insertAt(items, item, previousSiblingIndex + 1);
  }

  let earliestOriginalIndex = origin.index;
  const visited = new Set<string>();
  let previousId = origin.previousSiblingId;
  while (previousId && !visited.has(previousId)) {
    visited.add(previousId);
    const previousEntry = trashedSiblings.get(previousId);
    if (!previousEntry) break;
    if (Number.isSafeInteger(previousEntry.origin.index)) {
      earliestOriginalIndex = Math.min(
        earliestOriginalIndex ?? previousEntry.origin.index!,
        previousEntry.origin.index!,
      );
    }
    previousId = previousEntry.origin.previousSiblingId;
  }

  return insertAt(items, item, earliestOriginalIndex);
}

export function trashElement(
  workspace: WorkspaceState,
  pageId: string,
  elementId: string,
): WorkspaceState {
  const context = getActiveContext(workspace);
  const page = context?.page.id === pageId
    ? context.page
    : workspace.notebooks
        .flatMap((notebook) => notebook.sections)
        .flatMap((section) => section.pages)
        .find((item) => item.id === pageId);
  if (!page) return workspace;
  const element = page.elements.find((item) => item.id === elementId);
  if (!element) return workspace;
  const index = page.elements.findIndex((item) => item.id === elementId);

  const position = siblingOrigin(page.elements, index, workspace.trash, 'element');
  const origin = context && context.page.id === pageId
    ? {
        notebookId: context.notebook.id,
        sectionId: context.section.id,
        pageId,
        ...position,
      }
    : { pageId, ...position };

  const withoutElement = updatePage(workspace, pageId, (item) => ({
    ...item,
    elements: item.elements.filter((candidate) => candidate.id !== elementId),
  }));

  return {
    ...withoutElement,
    trash: [...withoutElement.trash, trashEntry('element', element, origin)],
  };
}

export function trashPage(
  workspace: WorkspaceState,
  notebookId: string,
  sectionId: string,
  pageId: string,
): WorkspaceState {
  const notebook = workspace.notebooks.find((item) => item.id === notebookId);
  const section = notebook?.sections.find((item) => item.id === sectionId);
  const page = section?.pages.find((item) => item.id === pageId);
  if (!notebook || !section || !page || section.pages.length === 1) return workspace;
  const pageIndex = section.pages.findIndex((item) => item.id === pageId);
  const position = siblingOrigin(section.pages, pageIndex, workspace.trash, 'page');
  const childPageIds = section.pages
    .filter((item) => item.parentPageId === pageId)
    .map((item) => item.id);

  const pages = section.pages
    .filter((item) => item.id !== pageId)
    .map((item) =>
      item.parentPageId === pageId ? { ...item, parentPageId: page.parentPageId } : item,
    );
  const fallbackPage = pages[0];
  const updatedAt = now();
  const originalParentPageId =
    page.parentPageId ??
    workspace.trash.find(
      (entry) =>
        entry.kind === 'page' &&
        'elements' in entry.item &&
        entry.origin.childPageIds?.includes(page.id),
    )?.item.id;

  return {
    ...workspace,
    updatedAt,
    notebooks: workspace.notebooks.map((item) =>
      item.id === notebookId
        ? {
            ...item,
            updatedAt,
            sections: item.sections.map((candidate) =>
              candidate.id === sectionId
                ? { ...candidate, updatedAt, pages }
                : candidate,
            ),
          }
        : item,
    ),
    trash: [
      ...workspace.trash,
      trashEntry('page', page, {
        notebookId,
        sectionId,
        ...position,
        originalParentPageId,
        childPageIds,
      }),
    ],
    activePageId: workspace.activePageId === pageId ? fallbackPage.id : workspace.activePageId,
  };
}

export function trashSection(
  workspace: WorkspaceState,
  notebookId: string,
  sectionId: string,
): WorkspaceState {
  const notebook = workspace.notebooks.find((item) => item.id === notebookId);
  const section = notebook?.sections.find((item) => item.id === sectionId);
  if (!notebook || !section || notebook.sections.length === 1) return workspace;
  const sectionIndex = notebook.sections.findIndex((item) => item.id === sectionId);
  const position = siblingOrigin(
    notebook.sections,
    sectionIndex,
    workspace.trash,
    'section',
  );

  const sections = notebook.sections.filter((item) => item.id !== sectionId);
  const fallbackSection = sections[0];
  const updatedAt = now();
  const removingActive = workspace.activeSectionId === sectionId;

  return {
    ...workspace,
    updatedAt,
    notebooks: workspace.notebooks.map((item) =>
      item.id === notebookId ? { ...item, updatedAt, sections } : item,
    ),
    trash: [
      ...workspace.trash,
      trashEntry('section', section, { notebookId, ...position }),
    ],
    activeSectionId: removingActive ? fallbackSection.id : workspace.activeSectionId,
    activePageId: removingActive ? fallbackSection.pages[0].id : workspace.activePageId,
  };
}

export function trashNotebook(
  workspace: WorkspaceState,
  notebookId: string,
): WorkspaceState {
  const notebook = workspace.notebooks.find((item) => item.id === notebookId);
  if (!notebook || workspace.notebooks.length === 1) return workspace;
  const notebookIndex = workspace.notebooks.findIndex((item) => item.id === notebookId);
  const position = siblingOrigin(
    workspace.notebooks,
    notebookIndex,
    workspace.trash,
    'notebook',
  );

  const notebooks = workspace.notebooks.filter((item) => item.id !== notebookId);
  const fallbackNotebook = notebooks[0];
  const fallbackSection = fallbackNotebook.sections[0];
  const removingActive = workspace.activeNotebookId === notebookId;

  return {
    ...workspace,
    updatedAt: now(),
    notebooks,
    trash: [
      ...workspace.trash,
      trashEntry('notebook', notebook, position),
    ],
    activeNotebookId: removingActive ? fallbackNotebook.id : workspace.activeNotebookId,
    activeSectionId: removingActive ? fallbackSection.id : workspace.activeSectionId,
    activePageId: removingActive ? fallbackSection.pages[0].id : workspace.activePageId,
  };
}

export function restoreTrashEntry(workspace: WorkspaceState, entryId: string): WorkspaceState {
  const entry = workspace.trash.find((item) => item.id === entryId);
  if (!entry) return workspace;

  let notebooks = workspace.notebooks;
  if (entry.kind === 'element' && 'kind' in entry.item && entry.origin.pageId) {
    const targetExists = notebooks.some((notebook) =>
      notebook.sections.some((section) =>
        section.pages.some((page) => page.id === entry.origin.pageId),
      ),
    );
    if (!targetExists) return workspace;

    notebooks = notebooks.map((notebook) => ({
      ...notebook,
      sections: notebook.sections.map((section) => ({
        ...section,
        pages: section.pages.map((page) =>
          page.id === entry.origin.pageId
            ? {
                ...page,
                elements: insertAtOrigin(
                  page.elements,
                  entry.item as PageElement,
                  entry.origin,
                  workspace.trash,
                  entry.kind,
                ),
              }
            : page,
        ),
      })),
    }));
  } else if (entry.kind === 'page' && 'elements' in entry.item && entry.origin.sectionId) {
    const targetSection = notebooks
      .flatMap((notebook) => notebook.sections)
      .find((section) => section.id === entry.origin.sectionId);
    const parentPageId =
      entry.origin.originalParentPageId ?? entry.item.parentPageId;
    const targetExists =
      targetSection !== undefined &&
      (!parentPageId ||
        targetSection.pages.some((page) => page.id === parentPageId));
    if (!targetExists) return workspace;

    notebooks = notebooks.map((notebook) => ({
      ...notebook,
      sections: notebook.sections.map((section) =>
        section.id === entry.origin.sectionId
          ? {
              ...section,
              pages: insertAtOrigin(
                section.pages.map((page) =>
                  entry.origin.childPageIds?.includes(page.id)
                    ? { ...page, parentPageId: entry.item.id }
                    : page,
                ),
                parentPageId
                  ? { ...(entry.item as Page), parentPageId }
                  : entry.item as Page,
                entry.origin,
                workspace.trash,
                entry.kind,
              ),
            }
          : section,
      ),
    }));
  } else if (entry.kind === 'section' && 'pages' in entry.item && entry.origin.notebookId) {
    const targetExists = notebooks.some(
      (notebook) => notebook.id === entry.origin.notebookId,
    );
    if (!targetExists) return workspace;

    notebooks = notebooks.map((notebook) =>
      notebook.id === entry.origin.notebookId
        ? {
            ...notebook,
            sections: insertAtOrigin(
              notebook.sections,
              entry.item as Section,
              entry.origin,
              workspace.trash,
              entry.kind,
            ),
          }
        : notebook,
    );
  } else if (entry.kind === 'notebook' && 'sections' in entry.item) {
    if (notebooks.some((notebook) => notebook.id === entry.item.id)) {
      return workspace;
    }
    notebooks = insertAtOrigin(
      notebooks,
      entry.item as Notebook,
      entry.origin,
      workspace.trash,
      entry.kind,
    );
  } else {
    return workspace;
  }

  return {
    ...workspace,
    notebooks,
    updatedAt: now(),
    trash: workspace.trash.filter((item) => item.id !== entryId),
  };
}

export function searchWorkspace(
  workspace: WorkspaceState,
  rawQuery: string,
): WorkspaceSearchResult[] {
  const query = rawQuery.trim().toLocaleLowerCase();
  if (!query) return [];

  const results: WorkspaceSearchResult[] = [];
  const matches = (value: string) => value.toLocaleLowerCase().includes(query);
  const push = (result: WorkspaceSearchResult) => {
    if (results.length < SEARCH_LIMIT) results.push(result);
  };

  for (const notebook of workspace.notebooks) {
    const firstSection = notebook.sections.find((section) => section.pages.length > 0);
    const firstNotebookPage = firstSection?.pages[0];
    if (matches(notebook.title) && firstSection && firstNotebookPage) {
      push({
        id: `notebook:${notebook.id}`,
        kind: 'notebook',
        title: notebook.title,
        excerpt: `${firstSection.title} / ${firstNotebookPage.title}`,
        notebookId: notebook.id,
        sectionId: firstSection.id,
        pageId: firstNotebookPage.id,
      });
    }

    for (const section of notebook.sections) {
      const firstSectionPage = section.pages[0];
      if (matches(section.title) && firstSectionPage) {
        push({
          id: `section:${section.id}`,
          kind: 'section',
          title: section.title,
          excerpt: `${notebook.title} / ${firstSectionPage.title}`,
          notebookId: notebook.id,
          sectionId: section.id,
          pageId: firstSectionPage.id,
        });
      }

      for (const page of section.pages) {
        if (matches(page.title)) {
          push({
            id: `page:${page.id}`,
            kind: 'page',
            title: page.title,
            excerpt: `${notebook.title} / ${section.title}`,
            notebookId: notebook.id,
            sectionId: section.id,
            pageId: page.id,
          });
        }
        for (const element of page.elements) {
          if (element.kind === 'text' && matches(element.text)) {
            const excerpt = element.text.replace(/\s+/g, ' ').slice(0, 110);
            push({
              id: `text:${element.id}`,
              kind: 'text',
              title: page.title,
              excerpt,
              notebookId: notebook.id,
              sectionId: section.id,
              pageId: page.id,
              elementId: element.id,
            });
          }
        }
      }
    }
  }

  return results;
}

export function pageToMarkdown(context: ActiveContext): string {
  const text = context.page.elements
    .filter((element): element is Extract<PageElement, { kind: 'text' }> => element.kind === 'text')
    .map((element) => element.text.trim())
    .filter(Boolean)
    .join('\n\n');
  const assets = context.page.elements.filter(
    (element) => element.kind === 'image' || element.kind === 'pdf',
  );
  const assetLines = assets.map((element) =>
    element.kind === 'image'
      ? `- Image: ${element.name}`
      : `- PDF: ${element.sourceName} (${element.pageCount} pages)`,
  );

  return [
    `# ${context.page.title}`,
    '',
    `Notebook: ${context.notebook.title}`,
    `Section: ${context.section.title}`,
    '',
    text,
    assetLines.length ? '\n## Attachments\n\n' + assetLines.join('\n') : '',
    '',
  ]
    .filter((line, index, lines) => line !== '' || lines[index - 1] !== '')
    .join('\n');
}
