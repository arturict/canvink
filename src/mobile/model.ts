import type { LiveNotebookDocV2 } from '../crdt';
import type { PageSummary } from '../storage/workspaceV2Runtime';
import { isPinnedPage } from '../components/pagePins';
import { buildSectionTree, sectionsInDisplayOrder, type SectionTree } from '../domain/sectionGroups';
import { sectionColor } from '../components/sectionColors';

/**
 * What the phone's lists show, derived from the workspace's notebooks and
 * page summaries (no page document is loaded for any of it).
 */

type NotebookSection = LiveNotebookDocV2['sections'][number];
type NotebookGroup = NonNullable<LiveNotebookDocV2['sectionGroups']>[number];

export interface PageEntry {
  page: PageSummary;
  notebookId: string;
  notebookTitle: string;
  sectionId: string;
  sectionTitle: string;
  sectionColor: string;
}

export interface SectionPage {
  page: PageSummary;
  /** Subpage level: 0 for a page, 1 and 2 for subpages. */
  depth: number;
}

export function pagesByDocumentId(pages: readonly PageSummary[]): Map<string, PageSummary> {
  return new Map(pages.map((page) => [page.documentId, page]));
}

/** The pages of a section in their order, with each subpage's level. */
export function sectionPages(section: NotebookSection, byDocumentId: ReadonlyMap<string, PageSummary>): SectionPage[] {
  const pages = section.pageDocumentIds
    .map((documentId) => byDocumentId.get(documentId))
    .filter((page): page is PageSummary => page !== undefined);
  const inSection = new Map(pages.map((page) => [page.pageId, page]));
  const depthOf = (page: PageSummary, seen = new Set<string>()): number => {
    const parent = page.parentPageId ? inSection.get(page.parentPageId) : undefined;
    if (!parent || seen.has(parent.pageId)) return 0;
    seen.add(page.pageId);
    return Math.min(2, depthOf(parent, seen) + 1);
  };
  return pages.map((page) => ({ page, depth: depthOf(page) }));
}

export function notebookTree(notebook: LiveNotebookDocV2): SectionTree<NotebookSection, NotebookGroup> {
  return buildSectionTree(notebook.sections, notebook.sectionGroups ?? []);
}

/** Sections in the order the notebook shows them, groups unfolded. */
export function orderedSections(notebook: LiveNotebookDocV2): NotebookSection[] {
  return sectionsInDisplayOrder(notebookTree(notebook));
}

/** Every page the person can reach (not in the trash), with where it lives. */
export function reachablePages(notebooks: readonly LiveNotebookDocV2[], pages: readonly PageSummary[]): PageEntry[] {
  const byDocumentId = pagesByDocumentId(pages);
  const entries: PageEntry[] = [];
  for (const notebook of notebooks) {
    for (const section of orderedSections(notebook)) {
      for (const documentId of section.pageDocumentIds) {
        const page = byDocumentId.get(documentId);
        if (!page) continue;
        entries.push({
          page,
          notebookId: notebook.notebookId,
          notebookTitle: notebook.title,
          sectionId: section.id,
          sectionTitle: section.title,
          sectionColor: sectionColor(section),
        });
      }
    }
  }
  return entries;
}

export function pinnedEntries(entries: readonly PageEntry[]): PageEntry[] {
  return entries.filter((entry) => isPinnedPage(entry.page));
}

export type RecencyGroup = 'today' | 'yesterday' | 'week' | 'earlier';

/**
 * Pages most recently changed, on any device, newest first, grouped like a
 * phone's file list: today, yesterday, the last seven days, earlier.
 */
export function recentlyChanged(
  entries: readonly PageEntry[],
  now: Date,
  limit = 30,
): Array<{ group: RecencyGroup; entries: PageEntry[] }> {
  const sorted = [...entries]
    .filter((entry) => Number.isFinite(Date.parse(entry.page.updatedAt)))
    .sort((left, right) => Date.parse(right.page.updatedAt) - Date.parse(left.page.updatedAt))
    .slice(0, limit);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = 24 * 60 * 60 * 1000;
  const groupOf = (entry: PageEntry): RecencyGroup => {
    const at = Date.parse(entry.page.updatedAt);
    if (at >= startOfToday) return 'today';
    if (at >= startOfToday - day) return 'yesterday';
    if (at >= startOfToday - 6 * day) return 'week';
    return 'earlier';
  };
  const groups: Array<{ group: RecencyGroup; entries: PageEntry[] }> = [];
  for (const entry of sorted) {
    const group = groupOf(entry);
    const last = groups[groups.length - 1];
    if (last?.group === group) last.entries.push(entry);
    else groups.push({ group, entries: [entry] });
  }
  return groups;
}

/** The page this device showed last, when it still exists. */
export function continueEntry(entries: readonly PageEntry[], recentPageIds: readonly string[]): PageEntry | null {
  const byPageId = new Map(entries.map((entry) => [entry.page.pageId, entry]));
  for (const pageId of recentPageIds) {
    const entry = byPageId.get(pageId);
    if (entry) return entry;
  }
  return null;
}

/** Pages viewed on this device, most recent first, without the one to continue with. */
export function viewedEntries(entries: readonly PageEntry[], recentPageIds: readonly string[], limit = 8): PageEntry[] {
  const byPageId = new Map(entries.map((entry) => [entry.page.pageId, entry]));
  return recentPageIds
    .map((pageId) => byPageId.get(pageId))
    .filter((entry): entry is PageEntry => entry !== undefined)
    .slice(0, limit);
}

/** The neighbours of a page in its section, for turning pages. */
export function neighbours(
  section: NotebookSection | undefined,
  pageDocumentId: string,
  byDocumentId: ReadonlyMap<string, PageSummary>,
): { previous: PageSummary | null; next: PageSummary | null; index: number; count: number } {
  if (!section) return { previous: null, next: null, index: 0, count: 0 };
  const ids = section.pageDocumentIds.filter((documentId) => byDocumentId.has(documentId));
  const index = ids.indexOf(pageDocumentId);
  return {
    previous: index > 0 ? byDocumentId.get(ids[index - 1]) ?? null : null,
    next: index >= 0 && index < ids.length - 1 ? byDocumentId.get(ids[index + 1]) ?? null : null,
    index: Math.max(0, index),
    count: ids.length,
  };
}

/** A relative time for list rows: "vor 5 Min.", "14:20", "gestern", "12. Sep.". */
export function relativeTime(iso: string, now: Date, locale: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const minutes = Math.round((now.getTime() - at.getTime()) / 60_000);
  if (minutes < 1) return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(0, 'second');
  if (minutes < 60) return new Intl.RelativeTimeFormat(locale, { numeric: 'always', style: 'short' }).format(-minutes, 'minute');
  const sameDay = at.toDateString() === now.toDateString();
  if (sameDay) return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(at);
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (at.toDateString() === yesterday.toDateString()) {
    return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(-1, 'day');
  }
  const sameYear = at.getFullYear() === now.getFullYear();
  return new Intl.DateTimeFormat(locale, sameYear ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' }).format(at);
}
