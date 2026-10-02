/**
 * What the empty search shows: the last searches and the pages opened most
 * recently. Both stay in this browser (localStorage) and hold only the query
 * text and page ids.
 */
const SEARCHES_KEY = 'canvink-recent-searches';
const PAGES_KEY = 'canvink-recent-pages';
const MAX_SEARCHES = 6;
const MAX_PAGES = 8;

function read(key: string): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(key) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function write(key: string, values: readonly string[]): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(values));
  } catch {
    // Storage is full or blocked; the lists are a convenience.
  }
}

export const recentSearches = (): string[] => read(SEARCHES_KEY);

export function rememberSearch(query: string): string[] {
  const trimmed = query.trim().slice(0, 120);
  if (!trimmed) return recentSearches();
  const next = [trimmed, ...read(SEARCHES_KEY).filter((item) => item !== trimmed)].slice(0, MAX_SEARCHES);
  write(SEARCHES_KEY, next);
  return next;
}

export function forgetSearches(): string[] {
  write(SEARCHES_KEY, []);
  return [];
}

export const recentPageIds = (): string[] => read(PAGES_KEY);

export function rememberPage(pageId: string): string[] {
  const next = [pageId, ...read(PAGES_KEY).filter((item) => item !== pageId)].slice(0, MAX_PAGES);
  write(PAGES_KEY, next);
  return next;
}
