/**
 * Quick access ("Schnellzugriff"): pinned pages.
 *
 * A pin is stored as a reserved tag on the page document itself. Page
 * documents are what Canvink syncs between devices, so a pin follows the
 * page to every device, survives moving the page and needs no schema change.
 * The tag contains a colon, which `normalizePageTag` never produces for a
 * typed tag, so a user cannot create or collide with it by hand; the tag
 * editor and the search index hide it.
 */

export const PIN_TAG = 'canvink:pinned';

/** Tags only the app writes; they are not shown or searched as user tags. */
export function isSystemTag(tag: string): boolean {
  return tag === PIN_TAG;
}

export function visibleTags(tags: readonly string[]): string[] {
  return tags.filter((tag) => !isSystemTag(tag));
}

export function isPinnedPage(page: { tags: readonly string[] }): boolean {
  return page.tags.includes(PIN_TAG);
}

/** Adds or removes the pin in a page document draft; returns whether it changed. */
export function setPagePinned(document: { tags: string[] }, pinned: boolean): boolean {
  const index = document.tags.indexOf(PIN_TAG);
  if (pinned && index === -1) {
    document.tags.push(PIN_TAG);
    return true;
  }
  if (!pinned && index !== -1) {
    document.tags.splice(index, 1);
    return true;
  }
  return false;
}

export interface QuickAccessNotebook {
  id: string;
  title: string;
  sections: ReadonlyArray<{
    id: string;
    title: string;
    color?: string;
    pages: ReadonlyArray<{ id: string; title: string }>;
  }>;
}

export interface QuickAccessEntry {
  pageId: string;
  title: string;
  notebookId: string;
  notebookTitle: string;
  sectionId: string;
  sectionTitle: string;
  sectionColor?: string;
}

/**
 * Pinned pages in navigation order (notebook, section, page), limited to the
 * notebooks shown, so pages in the trash never appear.
 */
export function quickAccessEntries(
  notebooks: readonly QuickAccessNotebook[],
  pinnedPageIds: ReadonlySet<string>,
): QuickAccessEntry[] {
  if (pinnedPageIds.size === 0) return [];
  const entries: QuickAccessEntry[] = [];
  for (const notebook of notebooks) {
    for (const section of notebook.sections) {
      for (const page of section.pages) {
        if (!pinnedPageIds.has(page.id)) continue;
        entries.push({
          pageId: page.id,
          title: page.title,
          notebookId: notebook.id,
          notebookTitle: notebook.title,
          sectionId: section.id,
          sectionTitle: section.title,
          ...(section.color ? { sectionColor: section.color } : {}),
        });
      }
    }
  }
  return entries;
}
