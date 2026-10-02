import type { LivePageDocV2 } from '../crdt';
import type { ResolvedNewPageDefaults } from '../domain/notebookSettings';
import type { PageDocV3, PagePaperV1 } from '../domain/v3';
import { applyPagePaper } from './pageSettings';

/**
 * How a new page of a notebook looks: the part of the notebook settings that
 * belongs to the page document itself (paper and sheet). The text style and
 * the template are applied where text is created and where the page is added.
 */
export interface PageLook {
  pageType: 'free' | 'a4';
  /** The sheet of a fixed page; absent for the A4 portrait default and for free pages. */
  paper?: PagePaperV1;
  background: PageDocV3['background'];
}

export function pageLookForDefaults(defaults: ResolvedNewPageDefaults): PageLook {
  const background: PageDocV3['background'] = { type: defaults.ruling, color: defaults.paperColor };
  if (defaults.spacing !== undefined) background.spacing = defaults.spacing;
  if (defaults.ruling !== 'plain') {
    if (defaults.lineColor) background.lineColor = defaults.lineColor;
    if (defaults.lineStrength) background.lineStrength = defaults.lineStrength;
  }
  const paper = defaults.pageType === 'a4'
    && !(defaults.paper.size === 'a4' && defaults.paper.orientation === 'portrait')
    ? { size: defaults.paper.size, orientation: defaults.paper.orientation }
    : undefined;
  return { pageType: defaults.pageType, ...(paper ? { paper } : {}), background };
}

/**
 * Gives an existing page the paper and sheet of the notebook defaults
 * ("Auf alle Seiten anwenden"). Content, text and the template stay as they
 * are. Returns whether the page changed.
 */
export function applyPageLook(document: LivePageDocV2, look: PageLook, updatedAt: string): boolean {
  let changed = false;
  const background = document.background;
  const target = look.background;
  if (background.type !== target.type) { background.type = target.type; changed = true; }
  if (background.color !== target.color) { background.color = target.color; changed = true; }
  for (const key of ['spacing', 'lineColor', 'lineStrength'] as const) {
    if (background[key] === target[key]) continue;
    if (target[key] === undefined) delete background[key];
    else (background as Record<string, unknown>)[key] = target[key];
    changed = true;
  }
  const sheet: PagePaperV1 | null = look.pageType === 'free'
    ? null
    : look.paper ?? { size: 'a4', orientation: 'portrait' };
  if (applyPagePaper(document, sheet, updatedAt)) changed = true;
  if (changed) document.updatedAt = updatedAt;
  return changed;
}
