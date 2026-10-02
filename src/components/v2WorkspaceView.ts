import type { Notebook, Page, Section, SectionGroup } from '../domain/types';
import type { MigrationManifestV2 } from '../domain/v2';
import type { WorkspaceManifestV3 } from '../domain/v3';
import type { LivePageDocV2, LiveNotebookDocV2 } from '../crdt';
import type { PageSummary } from '../storage/pageIndex';
import { resolveNotebookSettings, sortPages, sortSections } from '../domain/notebookSettings';
import { visibleTags } from './pagePins';

const V2_UI_STATE_KEY = 'canvink:v2-ui-state:v1';
const V2_DEVICE_ID_KEY = 'canvink:v2-device-id:v1';
const MAX_RECENT_PAGES = 12;

export interface V2UiState {
  schemaVersion: 1;
  /**
   * Stars from before pins were synced. Kept only so they can be turned
   * into pins once; see `V2NotebookApp`.
   */
  favoritePageIds: string[];
  recentPageIds: string[];
  /**
   * The page last open in each notebook, so switching notebooks returns to
   * exactly that page. Device-local on purpose: where you were is a
   * property of this device, not of the notebook.
   */
  lastPageByNotebook?: Record<string, string>;
  /** The notebook open before the current one, for a quick switch back. */
  previousNotebookId?: string;
}

export interface LiveSearchResult {
  pageId: string;
  notebookId: string;
  sectionId: string;
  title: string;
  excerpt: string;
}

export const DEFAULT_V2_UI_STATE: Readonly<V2UiState> = Object.freeze({
  schemaVersion: 1,
  favoritePageIds: [],
  recentPageIds: [],
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item)) {
    return null;
  }
  return [...new Set(value)];
}

export function parseV2UiState(value: unknown): V2UiState | null {
  if (!isRecord(value) || value.schemaVersion !== 1) return null;
  const favoritePageIds = stringList(value.favoritePageIds);
  const recentPageIds = stringList(value.recentPageIds);
  if (!favoritePageIds || !recentPageIds) return null;
  const lastPageByNotebook = stringRecord(value.lastPageByNotebook);
  return {
    schemaVersion: 1,
    favoritePageIds,
    recentPageIds: recentPageIds.slice(0, MAX_RECENT_PAGES),
    ...(lastPageByNotebook ? { lastPageByNotebook } : {}),
    ...(typeof value.previousNotebookId === 'string' && value.previousNotebookId
      ? { previousNotebookId: value.previousNotebookId }
      : {}),
  };
}

const MAX_REMEMBERED_NOTEBOOKS = 64;

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value)
    .filter((entry): entry is [string, string] => Boolean(entry[0]) && typeof entry[1] === 'string' && Boolean(entry[1]))
    .slice(-MAX_REMEMBERED_NOTEBOOKS);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/**
 * Records a navigation: the page becomes its notebook's last page, and
 * leaving another notebook makes that one the "previous" notebook.
 */
export function rememberNavigation(
  state: V2UiState,
  fromNotebookId: string | undefined,
  to: { notebookId: string; pageId: string },
): V2UiState {
  const { [to.notebookId]: _previousPage, ...others } = state.lastPageByNotebook ?? {};
  void _previousPage;
  const lastPageByNotebook = { ...others, [to.notebookId]: to.pageId };
  const keys = Object.keys(lastPageByNotebook);
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_REMEMBERED_NOTEBOOKS))) {
    delete lastPageByNotebook[key];
  }
  const previousNotebookId = fromNotebookId && fromNotebookId !== to.notebookId
    ? fromNotebookId
    : state.previousNotebookId;
  const { previousNotebookId: _stale, ...rest } = touchRecentPage(state, to.pageId);
  void _stale;
  return {
    ...rest,
    lastPageByNotebook,
    ...(previousNotebookId && previousNotebookId !== to.notebookId ? { previousNotebookId } : {}),
  };
}

export function loadV2UiState(storage: Pick<Storage, 'getItem'> | null): V2UiState {
  if (!storage) return { ...DEFAULT_V2_UI_STATE, favoritePageIds: [], recentPageIds: [] };
  try {
    const raw = storage.getItem(V2_UI_STATE_KEY);
    if (raw === null) return { ...DEFAULT_V2_UI_STATE, favoritePageIds: [], recentPageIds: [] };
    return parseV2UiState(JSON.parse(raw))
      ?? { ...DEFAULT_V2_UI_STATE, favoritePageIds: [], recentPageIds: [] };
  } catch {
    return { ...DEFAULT_V2_UI_STATE, favoritePageIds: [], recentPageIds: [] };
  }
}

export function saveV2UiState(
  storage: Pick<Storage, 'setItem'> | null,
  state: V2UiState,
): void {
  if (!storage) return;
  const parsed = parseV2UiState(state);
  if (!parsed) return;
  try {
    storage.setItem(V2_UI_STATE_KEY, JSON.stringify(parsed));
  } catch {
    // Optional device-local navigation metadata never blocks note editing.
  }
}

export function touchRecentPage(state: V2UiState, pageId: string): V2UiState {
  return {
    ...state,
    recentPageIds: [pageId, ...state.recentPageIds.filter((id) => id !== pageId)]
      .slice(0, MAX_RECENT_PAGES),
  };
}

export function toggleFavoritePage(state: V2UiState, pageId: string): V2UiState {
  const favoritePageIds = state.favoritePageIds.includes(pageId)
    ? state.favoritePageIds.filter((id) => id !== pageId)
    : [...state.favoritePageIds, pageId];
  return { ...state, favoritePageIds };
}

export function localDeviceId(storage: Pick<Storage, 'getItem' | 'setItem'> | null): string {
  if (storage) {
    try {
      const existing = storage.getItem(V2_DEVICE_ID_KEY);
      if (existing) return existing;
    } catch {
      // Continue with an in-memory device ID.
    }
  }
  const generated = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `device-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  try {
    storage?.setItem(V2_DEVICE_ID_KEY, generated);
  } catch {
    // Private mode may deny storage; the session ID still remains usable.
  }
  return generated;
}

type NotebookProjector = (
  notebooks: readonly LiveNotebookDocV2[],
  pages: readonly PageSummary[],
) => Notebook[];

/**
 * Projects the workspace into the notebooks the navigation shows, keeping the
 * object of every page, section, group list and notebook that did not change
 * since the last call. Every edit republishes the workspace, and with fresh
 * objects each time the whole page list re-rendered for a keystroke in one
 * title; with shared ones only the row that changed does.
 */
export function createNotebookProjector(): NotebookProjector {
  const pageCache = new Map<string, Page>();
  const sectionCache = new Map<string, Section>();
  const groupCache = new Map<string, SectionGroup[]>();
  const notebookCache = new Map<string, Notebook>();

  const projectPage = (summary: PageSummary): Page => {
    const background = summary.background.type === 'plain' ? 'blank' : summary.background.type;
    const cached = pageCache.get(summary.pageId);
    if (
      cached
      && cached.parentPageId === summary.parentPageId
      && cached.title === summary.title
      && cached.taskState === summary.taskState
      && cached.mode === summary.pageType
      && cached.background === background
      && cached.createdAt === summary.createdAt
      && cached.updatedAt === summary.updatedAt
    ) return cached;
    const page: Page = {
      id: summary.pageId,
      ...(summary.parentPageId ? { parentPageId: summary.parentPageId } : {}),
      title: summary.title,
      ...(summary.taskState ? { taskState: summary.taskState } : {}),
      mode: summary.pageType,
      background,
      createdAt: summary.createdAt,
      updatedAt: summary.updatedAt,
      elements: [],
    };
    pageCache.set(summary.pageId, page);
    return page;
  };

  const sameItems = <T,>(left: readonly T[], right: readonly T[]): boolean =>
    left.length === right.length && left.every((item, index) => item === right[index]);

  return (notebooks, pages) => {
    const pagesByDocumentId = new Map(pages.map((page) => [page.documentId, page]));
    const seenPages = new Set<string>();
    const seenSections = new Set<string>();
    const seenGroups = new Set<string>();
    const seenNotebooks = new Set<string>();
    const projected = notebooks.map((notebook) => {
      const settings = resolveNotebookSettings(notebook.settings);
      const sortedBy = settings.sort.sections !== 'manual' || settings.sort.pages !== 'manual'
        ? settings.sort
        : undefined;
      const sections = sortSections(notebook.sections.map((source) => {
        const storedPages = source.pageDocumentIds.flatMap((documentId) => {
          const summary = pagesByDocumentId.get(documentId);
          if (!summary) return [];
          seenPages.add(summary.pageId);
          return [projectPage(summary)];
        });
        const sectionPages = sortPages(storedPages, settings.sort.pages);
        const key = `${notebook.notebookId}\u0000${source.id}`;
        seenSections.add(key);
        const cached = sectionCache.get(key);
        if (
          cached
          && cached.title === source.title
          && cached.color === source.color
          && cached.groupId === source.groupId
          && cached.createdAt === source.createdAt
          && cached.updatedAt === source.updatedAt
          && sameItems(cached.pages, sectionPages)
        ) return cached;
        const section: Section = {
          id: source.id,
          title: source.title,
          ...(source.color ? { color: source.color } : {}),
          ...(source.groupId ? { groupId: source.groupId } : {}),
          createdAt: source.createdAt,
          updatedAt: source.updatedAt,
          pages: sectionPages,
        };
        sectionCache.set(key, section);
        return section;
      }), settings.sort.sections);

      let sectionGroups: SectionGroup[] | undefined;
      if (notebook.sectionGroups?.length) {
        const groups = notebook.sectionGroups.map((group): SectionGroup => ({
          id: group.id,
          title: group.title,
          ...(group.parentGroupId ? { parentGroupId: group.parentGroupId } : {}),
        }));
        seenGroups.add(notebook.notebookId);
        const cached = groupCache.get(notebook.notebookId);
        sectionGroups = cached
          && cached.length === groups.length
          && cached.every((group, index) => (
            group.id === groups[index].id
            && group.title === groups[index].title
            && group.parentGroupId === groups[index].parentGroupId
          ))
          ? cached
          : groups;
        groupCache.set(notebook.notebookId, sectionGroups);
      }

      seenNotebooks.add(notebook.notebookId);
      const cached = notebookCache.get(notebook.notebookId);
      if (
        cached
        && cached.title === notebook.title
        && cached.color === notebook.color
        && cached.createdAt === notebook.createdAt
        && cached.updatedAt === notebook.updatedAt
        && cached.icon === settings.icon
        && cached.sort?.sections === sortedBy?.sections
        && cached.sort?.pages === sortedBy?.pages
        && cached.sectionGroups === sectionGroups
        && sameItems(cached.sections, sections)
      ) return cached;
      const result: Notebook = {
        id: notebook.notebookId,
        title: notebook.title,
        color: notebook.color,
        createdAt: notebook.createdAt,
        updatedAt: notebook.updatedAt,
        sections,
        ...(sectionGroups ? { sectionGroups } : {}),
        ...(settings.icon ? { icon: settings.icon } : {}),
        ...(sortedBy ? { sort: sortedBy } : {}),
      };
      notebookCache.set(notebook.notebookId, result);
      return result;
    });

    // Forget what left the workspace, so the caches do not outlive it.
    for (const key of pageCache.keys()) if (!seenPages.has(key)) pageCache.delete(key);
    for (const key of sectionCache.keys()) if (!seenSections.has(key)) sectionCache.delete(key);
    for (const key of groupCache.keys()) if (!seenGroups.has(key)) groupCache.delete(key);
    for (const key of notebookCache.keys()) if (!seenNotebooks.has(key)) notebookCache.delete(key);
    return projected;
  };
}

export function projectLiveNotebooks(
  notebooks: readonly LiveNotebookDocV2[],
  pages: readonly PageSummary[],
): Notebook[] {
  return createNotebookProjector()(notebooks, pages);
}

export function searchLivePages(
  pages: readonly LivePageDocV2[],
  textByPageId: ReadonlyMap<string, string>,
  query: string,
): LiveSearchResult[] {
  const normalizedQuery = query.normalize('NFKC').trim().toLocaleLowerCase();
  if (!normalizedQuery) return [];
  const results: LiveSearchResult[] = [];
  for (const page of pages) {
    const text = textByPageId.get(page.pageId) ?? '';
    const haystack = `${page.title}\n${visibleTags(page.tags).join(' ')}\n${text}`.normalize('NFKC').toLocaleLowerCase();
    const match = haystack.indexOf(normalizedQuery);
    if (match === -1) continue;
    const excerptSource = `${page.title} · ${text}`.replace(/\s+/g, ' ').trim();
    const excerptMatch = excerptSource.toLocaleLowerCase().indexOf(normalizedQuery);
    const start = Math.max(0, excerptMatch - 36);
    results.push({
      pageId: page.pageId,
      notebookId: page.notebookId,
      sectionId: page.sectionId,
      title: page.title,
      excerpt: excerptSource.slice(start, start + 120),
    });
  }
  return results.sort((left, right) => left.title.localeCompare(right.title));
}

export function subpageParentCandidates<T extends { pageId: string; parentPageId?: string }>(
  pages: readonly T[],
  pageId: string,
): T[] {
  const descendants = new Set<string>();
  const visit = (parentPageId: string): void => {
    for (const page of pages) {
      if (page.parentPageId !== parentPageId || descendants.has(page.pageId)) continue;
      descendants.add(page.pageId);
      visit(page.pageId);
    }
  };
  visit(pageId);
  return pages.filter((page) => page.pageId !== pageId && !descendants.has(page.pageId));
}

export function migrationTrashCount(manifest: MigrationManifestV2 | WorkspaceManifestV3): number {
  return manifest.trash.length;
}
