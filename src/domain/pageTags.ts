/**
 * Page tags are a small, bounded, content-free vocabulary shared by manual
 * editing, OneNote acquisition, and the local search index. Keeping one
 * normalizer means a tag typed by hand and a tag normalized from a OneNote
 * `data-tag` collapse onto the same stored slug instead of two near-duplicates.
 */

/** Tags Canvink offers by default; any other normalized slug stays valid. */
export const SUGGESTED_PAGE_TAGS = Object.freeze([
  'important',
  'todo',
  'question',
  'idea',
  'definition',
  'highlight',
  'source',
] as const);

/** Upper bound on tags per page so a single document cannot grow unbounded. */
export const PAGE_TAG_LIMIT = 24;

/** Longest stored slug, matching the OneNote acquisition boundary. */
export const PAGE_TAG_MAX_LENGTH = 64;

const IMPORTED_TAG_PREFIX = 'onenote:';

function normalizeSlug(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replaceAll('ß', 'ss')
    // Fold diacritics before dropping non-ASCII so "Prüfung" becomes
    // "prufung" instead of losing the vowel entirely.
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, PAGE_TAG_MAX_LENGTH);
}

/**
 * Normalizes one tag to its stored form, preserving the `onenote:` namespace
 * that acquisition uses for source tags Canvink does not model itself.
 * Returns `undefined` when nothing printable remains.
 */
export function normalizePageTag(value: string): string | undefined {
  const trimmed = value.normalize('NFKC').trim().toLowerCase();
  if (trimmed.startsWith(IMPORTED_TAG_PREFIX)) {
    const slug = normalizeSlug(trimmed.slice(IMPORTED_TAG_PREFIX.length));
    return slug ? `${IMPORTED_TAG_PREFIX}${slug}` : undefined;
  }
  return normalizeSlug(trimmed) || undefined;
}

/** Normalizes, deduplicates, and bounds a whole tag list. */
export function normalizePageTags(values: readonly string[]): string[] {
  const tags: string[] = [];
  for (const value of values) {
    const tag = normalizePageTag(value);
    if (!tag || tags.includes(tag)) continue;
    tags.push(tag);
    if (tags.length === PAGE_TAG_LIMIT) break;
  }
  return tags;
}
