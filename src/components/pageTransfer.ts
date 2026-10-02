
export type CollectionDropPlacement = 'before' | 'inside' | 'after';

export interface StablePageIdRemap {
  pageIdBySourceId: ReadonlyMap<string, string>;
  documentIdBySourceId: ReadonlyMap<string, string>;
}

export function insertionIndex(
  orderedIds: readonly string[],
  targetId: string | undefined,
  placement: CollectionDropPlacement,
): number {
  if (placement === 'inside' || !targetId) return orderedIds.length;
  const targetIndex = orderedIds.indexOf(targetId);
  if (targetIndex < 0) return orderedIds.length;
  return targetIndex + (placement === 'after' ? 1 : 0);
}

export function moveIdByPlacement(
  orderedIds: readonly string[],
  sourceId: string,
  targetId: string,
  placement: Exclude<CollectionDropPlacement, 'inside'>,
): string[] {
  if (sourceId === targetId) return [...orderedIds];
  const withoutSource = orderedIds.filter((id) => id !== sourceId);
  const at = insertionIndex(withoutSource, targetId, placement);
  withoutSource.splice(at, 0, sourceId);
  return withoutSource;
}

/** The part of a page the tree helpers need; page summaries and live pages both qualify. */
export interface PageTreeNode {
  pageId: string;
  parentPageId?: string;
}

export function createStablePageIdRemap<T extends PageTreeNode>(
  pages: readonly T[],
  createPageId: (source: T) => string,
): StablePageIdRemap {
  const pageIdBySourceId = new Map<string, string>();
  const documentIdBySourceId = new Map<string, string>();
  const generated = new Set<string>();
  for (const page of pages) {
    if (pageIdBySourceId.has(page.pageId)) {
      throw new Error(`Duplicate source page ID: ${page.pageId}`);
    }
    const nextPageId = createPageId(page);
    if (!nextPageId || generated.has(nextPageId)) {
      throw new Error('Page copy IDs must be non-empty and unique.');
    }
    generated.add(nextPageId);
    pageIdBySourceId.set(page.pageId, nextPageId);
    documentIdBySourceId.set(page.pageId, `page:${nextPageId}`);
  }
  return { pageIdBySourceId, documentIdBySourceId };
}

export function remappedParentPageId(
  page: PageTreeNode,
  remap: StablePageIdRemap,
): string | undefined {
  if (!page.parentPageId) return undefined;
  return remap.pageIdBySourceId.get(page.parentPageId);
}

export function pageSubtree<T extends PageTreeNode>(
  pages: readonly T[],
  rootPageId: string,
): T[] {
  const ids = new Set([rootPageId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const page of pages) {
      if (page.parentPageId && ids.has(page.parentPageId) && !ids.has(page.pageId)) {
        ids.add(page.pageId);
        changed = true;
      }
    }
  }
  return pages.filter((page) => ids.has(page.pageId));
}

export function invalidPageTransferCycle(
  pages: readonly PageTreeNode[],
  sourcePageId: string,
  targetPageId: string | undefined,
): boolean {
  if (!targetPageId) return false;
  return pageSubtree(pages, sourcePageId).some((page) => page.pageId === targetPageId);
}
