import { isOneNoteRecycleBinGroupName } from '../../domain/oneNoteRecycleBin';
import type { V2RuntimeState } from '../../storage/workspaceV2Runtime';
import { sectionColor } from '../sectionColors';
import type { SearchFilters } from './searchRuntime';

export interface SectionOption {
  id: string;
  notebookId: string;
  title: string;
  color: string;
  pageCount: number;
  /** 1-based place among the notebook's sections that share this title. */
  sameTitleIndex: number;
  sameTitleTotal: number;
  /** In OneNote's recycle bin: left out of searches unless asked for. */
  recycled: boolean;
}

export interface NotebookOption {
  id: string;
  title: string;
  color: string;
  createdAt: string;
  sectionCount: number;
  pageCount: number;
  /** 1-based place among the notebooks that share this title, in workspace order. */
  sameTitleIndex: number;
  sameTitleTotal: number;
  sections: SectionOption[];
}

export interface SearchLocations {
  notebooks: NotebookOption[];
  /** Sections that came in with OneNote's recycle bin, however deeply nested. */
  recycledSectionIds: ReadonlySet<string>;
}

function ordinals<T>(items: readonly T[], title: (item: T) => string): Array<{ index: number; total: number }> {
  const totals = new Map<string, number>();
  for (const item of items) totals.set(title(item), (totals.get(title(item)) ?? 0) + 1);
  const seen = new Map<string, number>();
  return items.map((item) => {
    const key = title(item);
    const index = (seen.get(key) ?? 0) + 1;
    seen.set(key, index);
    return { index, total: totals.get(key) ?? 1 };
  });
}

/**
 * The notebooks and sections a search can be narrowed to. Titles repeat (two
 * notebooks called "Notizbuch", sections called "Neuer Abschnitt"), so every
 * option carries its position among its namesakes and their number; the
 * picker turns those into a hint that tells them apart.
 */
export function searchLocations(workspace: Pick<V2RuntimeState, 'notebooks' | 'pages'>): SearchLocations {
  const pagesBySection = new Map<string, number>();
  for (const page of workspace.pages) pagesBySection.set(page.sectionId, (pagesBySection.get(page.sectionId) ?? 0) + 1);
  const recycledSectionIds = new Set<string>();
  const notebookOrdinals = ordinals(workspace.notebooks, (notebook) => notebook.title);
  const notebooks = workspace.notebooks.map((notebook, notebookIndex): NotebookOption => {
    const groups = new Map((notebook.sectionGroups ?? []).map((group) => [group.id, group]));
    const inRecycleBin = (groupId: string | undefined): boolean => {
      const visited = new Set<string>();
      for (
        let current = groupId ? groups.get(groupId) : undefined;
        current && !visited.has(current.id);
        current = current.parentGroupId ? groups.get(current.parentGroupId) : undefined
      ) {
        if (isOneNoteRecycleBinGroupName(current.title)) return true;
        visited.add(current.id);
      }
      return false;
    };
    const sectionOrdinals = ordinals(notebook.sections, (section) => section.title);
    const sections = notebook.sections.map((section, index): SectionOption => {
      const recycled = inRecycleBin(section.groupId);
      if (recycled) recycledSectionIds.add(section.id);
      return {
        id: section.id,
        notebookId: notebook.notebookId,
        title: section.title,
        color: sectionColor(section),
        pageCount: pagesBySection.get(section.id) ?? 0,
        sameTitleIndex: sectionOrdinals[index].index,
        sameTitleTotal: sectionOrdinals[index].total,
        recycled,
      };
    });
    const live = sections.filter((section) => !section.recycled);
    return {
      id: notebook.notebookId,
      title: notebook.title,
      color: notebook.color,
      createdAt: notebook.createdAt,
      sectionCount: live.length,
      pageCount: live.reduce((sum, section) => sum + section.pageCount, 0),
      sameTitleIndex: notebookOrdinals[notebookIndex].index,
      sameTitleTotal: notebookOrdinals[notebookIndex].total,
      sections,
    };
  });
  return { notebooks, recycledSectionIds };
}

export type SearchScope = 'page' | 'section' | 'notebook' | 'all';

export interface ActiveLocation {
  notebookId: string;
  sectionId: string;
  pageId: string;
}

/** The place filters a scope shortcut stands for, relative to what is open now. */
export function scopeFilters(
  scope: SearchScope,
  active: ActiveLocation,
): Pick<SearchFilters, 'pageId' | 'notebookIds' | 'sectionIds'> {
  if (scope === 'page') return { pageId: active.pageId };
  if (scope === 'section') return { sectionIds: [active.sectionId] };
  if (scope === 'notebook') return { notebookIds: [active.notebookId] };
  return {};
}
