import type { NotebookNewPageDefaults, NotebookSettings, NotebookSortKey } from './v2/types';

/**
 * The settings of one notebook ("Notizbuch-Einstellungen"), stored in the
 * notebook document so they sync to every device and to collaborators.
 *
 * Stored values are optional and untrusted (a collaborator or an old export
 * wrote them), so readers go through `resolveNotebookSettings`, which falls
 * back to the built-in default for anything missing or malformed. A notebook
 * that never had settings resolves to exactly what it always did: new pages
 * are A4 portrait sheets with squares on white paper, sections and pages stay
 * in the order the user gave them.
 */

export type PaperSizeName = 'a4' | 'a5' | 'letter';
export type RulingName = 'plain' | 'lined' | 'grid' | 'millimeter';
export type LineStrengthName = 'light' | 'medium' | 'strong';

export const NOTEBOOK_SORT_KEYS: readonly NotebookSortKey[] = ['manual', 'title', 'created', 'updated'];
export const NOTEBOOK_TEXT_SIZES: readonly number[] = [14, 16, 18, 20, 24];
/** Longest stored symbol; one emoji with joiners and modifiers fits well within it. */
export const NOTEBOOK_ICON_MAX_LENGTH = 16;
export const MIN_SPACING = 8;
export const MAX_SPACING = 160;

export const DEFAULT_PAPER_COLOR = '#ffffff';
export const DEFAULT_TEXT_COLOR = '#111827';
export const DEFAULT_TEXT_SIZE = 16;

const PAPER_SIZES: readonly PaperSizeName[] = ['a4', 'a5', 'letter'];
const RULINGS: readonly RulingName[] = ['plain', 'lined', 'grid', 'millimeter'];
const STRENGTHS: readonly LineStrengthName[] = ['light', 'medium', 'strong'];
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const TEMPLATE_REFERENCE = /^(builtin:[a-z][a-z0-9-]{0,48}|page:[A-Za-z0-9_.:-]{1,200})$/;

export type TemplateReference =
  | { kind: 'builtin'; id: string }
  | { kind: 'page'; pageId: string };

export interface ResolvedNewPageDefaults {
  pageType: 'free' | 'a4';
  paper: { size: PaperSizeName; orientation: 'portrait' | 'landscape' };
  ruling: RulingName;
  /** Only for lines and squares; missing means the default spacing of the ruling. */
  spacing?: number;
  paperColor: string;
  lineColor?: string;
  lineStrength?: LineStrengthName;
  template?: TemplateReference;
  textSize: number;
  textColor: string;
}

export interface ResolvedNotebookSettings {
  icon?: string;
  newPage: ResolvedNewPageDefaults;
  sort: { sections: NotebookSortKey; pages: NotebookSortKey };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? value as T : undefined;
}

function hexColor(value: unknown): string | undefined {
  return typeof value === 'string' && HEX_COLOR.test(value) ? value.toLowerCase() : undefined;
}

function spacing(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(MAX_SPACING, Math.max(MIN_SPACING, Math.round(value)))
    : undefined;
}

/** The symbol when it is one short grapheme cluster (an emoji), else `undefined`. */
export function normalizeNotebookIcon(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const symbol = value.trim();
  if (!symbol || symbol.length > NOTEBOOK_ICON_MAX_LENGTH) return undefined;
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    const segments = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(symbol)];
    if (segments.length !== 1) return undefined;
  }
  // Letters and digits are text, not a symbol: the field is for pictographs.
  return /^[\p{L}\p{N}]+$/u.test(symbol) ? undefined : symbol;
}

export function parseTemplateReference(value: unknown): TemplateReference | undefined {
  if (typeof value !== 'string' || !TEMPLATE_REFERENCE.test(value)) return undefined;
  return value.startsWith('builtin:')
    ? { kind: 'builtin', id: value.slice('builtin:'.length) }
    : { kind: 'page', pageId: value.slice('page:'.length) };
}

export function templateReferenceString(reference: TemplateReference): string {
  return reference.kind === 'builtin' ? `builtin:${reference.id}` : `page:${reference.pageId}`;
}

export const DEFAULT_NEW_PAGE_DEFAULTS: Readonly<ResolvedNewPageDefaults> = Object.freeze({
  pageType: 'a4',
  paper: Object.freeze({ size: 'a4', orientation: 'portrait' }),
  ruling: 'grid',
  paperColor: DEFAULT_PAPER_COLOR,
  textSize: DEFAULT_TEXT_SIZE,
  textColor: DEFAULT_TEXT_COLOR,
} as const);

export function sortKey(value: unknown): NotebookSortKey {
  return oneOf(value, NOTEBOOK_SORT_KEYS) ?? 'manual';
}

/** Reads stored settings of any age or origin into complete, valid values. */
export function resolveNotebookSettings(raw: unknown): ResolvedNotebookSettings {
  const settings = isRecord(raw) ? raw : {};
  const stored = isRecord(settings.newPage) ? settings.newPage : {};
  const paper = isRecord(stored.paper) ? stored.paper : {};
  const ruling = oneOf(stored.ruling, RULINGS) ?? DEFAULT_NEW_PAGE_DEFAULTS.ruling;
  const hasSpacing = ruling === 'lined' || ruling === 'grid';
  const template = parseTemplateReference(stored.template);
  const lineColor = hexColor(stored.lineColor);
  const lineStrength = oneOf(stored.lineStrength, STRENGTHS);
  const icon = normalizeNotebookIcon(settings.icon);
  const sort = isRecord(settings.sort) ? settings.sort : {};
  return {
    ...(icon ? { icon } : {}),
    newPage: {
      pageType: oneOf(stored.pageType, ['free', 'a4'] as const) ?? DEFAULT_NEW_PAGE_DEFAULTS.pageType,
      paper: {
        size: oneOf(paper.size, PAPER_SIZES) ?? DEFAULT_NEW_PAGE_DEFAULTS.paper.size,
        orientation: paper.orientation === 'landscape' ? 'landscape' : 'portrait',
      },
      ruling,
      ...(hasSpacing && spacing(stored.spacing) !== undefined ? { spacing: spacing(stored.spacing) } : {}),
      paperColor: hexColor(stored.paperColor) ?? DEFAULT_PAPER_COLOR,
      ...(lineColor ? { lineColor } : {}),
      ...(lineStrength ? { lineStrength } : {}),
      ...(template ? { template } : {}),
      textSize: typeof stored.textSize === 'number' && NOTEBOOK_TEXT_SIZES.includes(stored.textSize)
        ? stored.textSize
        : DEFAULT_TEXT_SIZE,
      textColor: hexColor(stored.textColor) ?? DEFAULT_TEXT_COLOR,
    },
    sort: { sections: sortKey(sort.sections), pages: sortKey(sort.pages) },
  };
}

/**
 * What changes in the stored settings; `null` removes a key (back to its
 * default). Keys are written one by one, never as a replaced object.
 */
export interface NotebookSettingsPatch {
  icon?: string | null;
  newPage?: { [K in keyof NotebookNewPageDefaults]?: NotebookNewPageDefaults[K] | null };
  sort?: { sections?: NotebookSortKey | null; pages?: NotebookSortKey | null };
}

type MutableRecord = Record<string, unknown>;

function assign(target: MutableRecord, key: string, value: unknown): boolean {
  if (value === null || value === undefined) {
    if (!(key in target)) return false;
    delete target[key];
    return true;
  }
  if (typeof value === 'object') {
    // Nested values (the paper) are compared by content so an unchanged choice is no revision.
    if (JSON.stringify(target[key]) === JSON.stringify(value)) return false;
  } else if (target[key] === value) {
    return false;
  }
  target[key] = value;
  return true;
}

/**
 * Applies a patch to the notebook's settings (an Automerge draft or a plain
 * object). Values are validated like reads are, so a bad value never reaches
 * the document. Returns whether anything changed.
 */
export function applyNotebookSettingsPatch(settings: NotebookSettings, patch: NotebookSettingsPatch): boolean {
  const target = settings as unknown as MutableRecord;
  let changed = false;
  if ('icon' in patch) {
    const icon = patch.icon === null ? null : normalizeNotebookIcon(patch.icon);
    if (patch.icon === null || icon !== undefined) changed = assign(target, 'icon', icon) || changed;
  }
  if (patch.newPage) {
    const page = isRecord(target.newPage) ? target.newPage : null;
    const draft: MutableRecord = page ?? {};
    let pageChanged = false;
    for (const [key, value] of Object.entries(patch.newPage)) {
      const clean = cleanNewPageValue(key, value);
      if (clean === undefined) continue;
      pageChanged = assign(draft, key, clean) || pageChanged;
      if (key === 'pageType') {
        // Older readers only know this mirror.
        changed = assign(target, 'defaultPageType', clean === 'free' ? 'free' : 'a4') || changed;
      }
    }
    if (pageChanged) {
      if (!page) target.newPage = draft;
      changed = true;
    }
  }
  if (patch.sort) {
    const sort = isRecord(target.sort) ? target.sort : null;
    const draft: MutableRecord = sort ?? {};
    let sortChanged = false;
    for (const key of ['sections', 'pages'] as const) {
      if (!(key in patch.sort)) continue;
      const value = patch.sort[key];
      // Manual is the default: it is stored as a missing key.
      sortChanged = assign(draft, key, value === null || value === 'manual' ? null : oneOf(value, NOTEBOOK_SORT_KEYS) ?? null) || sortChanged;
    }
    if (sortChanged) {
      if (!sort) target.sort = draft;
      changed = true;
    }
  }
  return changed;
}

/** `null` clears a key, `undefined` rejects the value. */
function cleanNewPageValue(key: string, value: unknown): unknown {
  if (value === null) return null;
  switch (key) {
    case 'pageType': return oneOf(value, ['free', 'a4'] as const);
    case 'paper': {
      if (!isRecord(value)) return undefined;
      const size = oneOf(value.size, PAPER_SIZES);
      return size ? { size, orientation: value.orientation === 'landscape' ? 'landscape' : 'portrait' } : undefined;
    }
    case 'ruling': return oneOf(value, RULINGS);
    case 'spacing': return spacing(value);
    case 'paperColor':
    case 'lineColor':
    case 'textColor': return hexColor(value);
    case 'lineStrength': return oneOf(value, STRENGTHS);
    case 'template': return parseTemplateReference(value) ? value : undefined;
    case 'textSize': return typeof value === 'number' && NOTEBOOK_TEXT_SIZES.includes(value) ? value : undefined;
    default: return undefined;
  }
}

/**
 * Brings stored settings of any age into the current stored shape: unknown or
 * invalid keys are dropped, valid ones are kept as written, and
 * `defaultPageType` is present. Notebooks written before per-notebook settings
 * (`{ defaultPageType }` only) come out unchanged apart from that; they keep
 * resolving to the built-in defaults, so no page changes.
 */
export function migrateNotebookSettings(raw: unknown): NotebookSettings {
  const source = isRecord(raw) ? raw : {};
  const migrated: NotebookSettings = {
    defaultPageType: source.defaultPageType === 'free' ? 'free' : 'a4',
  };
  const patch: NotebookSettingsPatch = {};
  const icon = normalizeNotebookIcon(source.icon);
  if (icon) patch.icon = icon;
  if (isRecord(source.newPage)) patch.newPage = source.newPage as NotebookSettingsPatch['newPage'];
  if (isRecord(source.sort)) patch.sort = source.sort as NotebookSettingsPatch['sort'];
  // A mirror that disagrees with the legacy value must not override it when no `pageType` is stored.
  const legacyType = migrated.defaultPageType;
  applyNotebookSettingsPatch(migrated, patch);
  if (!(isRecord(source.newPage) && 'pageType' in source.newPage)) migrated.defaultPageType = legacyType;
  return migrated;
}

/** Whether the stored settings are valid as written; for the strict import validators. */
export function isValidStoredNotebookSettings(raw: unknown): boolean {
  if (!isRecord(raw)) return false;
  if (raw.defaultPageType !== 'free' && raw.defaultPageType !== 'a4') return false;
  const allowed = new Set(['defaultPageType', 'icon', 'newPage', 'sort']);
  if (Object.keys(raw).some((key) => !allowed.has(key))) return false;
  if ('icon' in raw && normalizeNotebookIcon(raw.icon) !== raw.icon) return false;
  if ('newPage' in raw) {
    if (!isRecord(raw.newPage)) return false;
    for (const [key, value] of Object.entries(raw.newPage)) {
      const clean = cleanNewPageValue(key, value);
      if (clean === undefined || clean === null) return false;
      // `cleanNewPageValue` normalises (clamps, lower-cases); a stored value must already be normal.
      if (JSON.stringify(clean) !== JSON.stringify(value)) return false;
    }
  }
  if ('sort' in raw) {
    if (!isRecord(raw.sort)) return false;
    for (const [key, value] of Object.entries(raw.sort)) {
      if ((key !== 'sections' && key !== 'pages') || oneOf(value, NOTEBOOK_SORT_KEYS) === undefined) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Ordering

interface Sortable {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function compareBy(key: Exclude<NotebookSortKey, 'manual'>) {
  return (left: Sortable, right: Sortable): number => {
    if (key === 'title') return collator.compare(left.title, right.title);
    // Dates sort newest first; equal dates fall back to the title for a stable result.
    const byDate = key === 'created'
      ? right.createdAt.localeCompare(left.createdAt)
      : right.updatedAt.localeCompare(left.updatedAt);
    return byDate || collator.compare(left.title, right.title);
  };
}

/** Sections in the given order; `manual` keeps the stored order. Groups keep their members by order. */
export function sortSections<T extends Sortable>(sections: readonly T[], key: NotebookSortKey): T[] {
  if (key === 'manual') return [...sections];
  return [...sections].sort(compareBy(key));
}

/**
 * Pages in the given order. Sub-pages stay under their parent: the order
 * applies among the pages of each level, and a page whose parent is not in
 * the list counts as a top-level page.
 */
export function sortPages<T extends Sortable & { parentPageId?: string }>(pages: readonly T[], key: NotebookSortKey): T[] {
  if (key === 'manual') return [...pages];
  const ids = new Set(pages.map((page) => page.id));
  const children = new Map<string | undefined, T[]>();
  for (const page of pages) {
    const parent = page.parentPageId && ids.has(page.parentPageId) && page.parentPageId !== page.id
      ? page.parentPageId
      : undefined;
    const siblings = children.get(parent);
    if (siblings) siblings.push(page);
    else children.set(parent, [page]);
  }
  const compare = compareBy(key);
  const ordered: T[] = [];
  const visited = new Set<string>();
  const visit = (parent: string | undefined): void => {
    for (const page of [...(children.get(parent) ?? [])].sort(compare)) {
      if (visited.has(page.id)) continue;
      visited.add(page.id);
      ordered.push(page);
      visit(page.id);
    }
  };
  visit(undefined);
  // A parent cycle leaves its pages unreachable from the top; they keep their stored order at the end.
  for (const page of pages) if (!visited.has(page.id)) ordered.push(page);
  return ordered;
}
