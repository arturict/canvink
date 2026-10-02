import type { LivePageDocV2 } from '../crdt';
import type { PagePaperV1 } from '../domain/v3';
import { PAGE_TAG_LIMIT, normalizePageTag } from '../domain/pageTags';
import { pagePaper, samePaper } from '../editor/paper';

export function applyPageBackground(
  document: LivePageDocV2,
  background: LivePageDocV2['background']['type'],
  updatedAt: string,
): void {
  document.background.type = background;
  document.updatedAt = updatedAt;
}

/**
 * Sets the rule lines of the page (OneNote's "Linien"): the type and, for
 * lines and squares, their spacing. Returns `false` when nothing changes.
 */
export function applyPageRuling(
  document: LivePageDocV2,
  ruling: { type: LivePageDocV2['background']['type']; spacing?: number },
  updatedAt: string,
): boolean {
  const background = document.background;
  const spacing = ruling.type === 'lined' || ruling.type === 'grid' ? ruling.spacing : undefined;
  if (background.type === ruling.type && background.spacing === spacing) return false;
  background.type = ruling.type;
  if (spacing === undefined) delete background.spacing;
  else background.spacing = spacing;
  document.updatedAt = updatedAt;
  return true;
}

/** Sets the colour and strength of the rule lines. */
export function applyRuleStyle(
  document: LivePageDocV2,
  style: { lineColor?: string; lineStrength?: NonNullable<LivePageDocV2['background']['lineStrength']> },
  updatedAt: string,
): boolean {
  const background = document.background;
  let changed = false;
  if (style.lineColor !== undefined && background.lineColor !== style.lineColor) {
    background.lineColor = style.lineColor;
    changed = true;
  }
  if (style.lineStrength !== undefined && background.lineStrength !== style.lineStrength) {
    background.lineStrength = style.lineStrength;
    changed = true;
  }
  if (changed) document.updatedAt = updatedAt;
  return changed;
}

/**
 * Makes the page free (`null`) or a sheet of the given paper. Fixed sheets
 * keep `pageType: 'a4'` so older app versions still show a fixed page.
 */
export function applyPagePaper(
  document: LivePageDocV2,
  paper: PagePaperV1 | null,
  updatedAt: string,
): boolean {
  if (paper === null) {
    if (document.pageType === 'free') return false;
    document.pageType = 'free';
    document.updatedAt = updatedAt;
    return true;
  }
  if (document.pageType === 'a4' && samePaper(pagePaper(document), paper)) return false;
  document.pageType = 'a4';
  if (paper.size === 'a4' && paper.orientation === 'portrait') delete document.paper;
  else document.paper = { size: paper.size, orientation: paper.orientation };
  document.updatedAt = updatedAt;
  return true;
}

export class PageTagLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PageTagLimitError';
  }
}

/**
 * Adds a normalized tag to the page. Returns `false` when the tag is already
 * present or normalizes to nothing, so the caller can skip a no-op revision.
 */
export function addPageTag(
  document: LivePageDocV2,
  rawTag: string,
  updatedAt: string,
): boolean {
  const tag = normalizePageTag(rawTag);
  if (!tag || document.tags.includes(tag)) return false;
  if (document.tags.length >= PAGE_TAG_LIMIT) {
    throw new PageTagLimitError(`A page cannot carry more than ${PAGE_TAG_LIMIT} tags.`);
  }
  document.tags.push(tag);
  document.updatedAt = updatedAt;
  return true;
}

/** Removes an exact stored tag, including imported `onenote:` source tags. */
export function removePageTag(
  document: LivePageDocV2,
  tag: string,
  updatedAt: string,
): boolean {
  const index = document.tags.indexOf(tag);
  if (index === -1) return false;
  document.tags.splice(index, 1);
  document.updatedAt = updatedAt;
  return true;
}

/**
 * Marks the page as an open or completed task, or clears the mark entirely.
 * Task state stays page-level metadata; individual checklist items keep their
 * own checked state inside the canvas.
 */
export function setPageTaskState(
  document: LivePageDocV2,
  taskState: 'open' | 'done' | undefined,
  updatedAt: string,
): boolean {
  if ((document.taskState ?? undefined) === taskState) return false;
  if (taskState) document.taskState = taskState;
  else delete document.taskState;
  document.updatedAt = updatedAt;
  return true;
}
