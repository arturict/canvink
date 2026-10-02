import { useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowUpLeft, CircleCheck, FileText, History, Search, X } from 'lucide-react';
import { useI18n } from '../../i18n';
import { formatLocale } from '../../i18n/core';
import { sectionColor } from '../../components/sectionColors';
import type { SearchFilters, SearchRuntimeSnapshot, SearchUiResult } from '../../components/search/searchRuntime';
import { relativeTime } from '../model';
import { SectionDot } from '../ui';
import type { MobileWorkspace } from '../useMobileWorkspace';

const RECENT_KEY = 'canvink:mobile-recent-searches';
const RECENT_LIMIT = 8;

function loadRecent(): string[] {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string').slice(0, RECENT_LIMIT) : [];
  } catch {
    return [];
  }
}

function saveRecent(entries: readonly string[]): void {
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(entries.slice(0, RECENT_LIMIT)));
  } catch {
    // Recent searches are a convenience on this device only.
  }
}

/** The words of a query a result is highlighted for (operators such as is:open are not text). */
export function highlightTerms(query: string): string[] {
  return query
    .split(/\s+/)
    .map((term) => term.replace(/^["'«»“”]+|["'«»“”]+$/g, ''))
    .filter((term) => term.length > 0 && !/^[a-z]+:/i.test(term))
    .sort((left, right) => right.length - left.length);
}

/** Splits `text` into plain and matching parts, case-insensitively. */
export function highlightParts(text: string, terms: readonly string[]): Array<{ text: string; match: boolean }> {
  if (terms.length === 0 || !text) return [{ text, match: false }];
  const lower = text.toLocaleLowerCase();
  const lowerTerms = terms.map((term) => term.toLocaleLowerCase());
  const parts: Array<{ text: string; match: boolean }> = [];
  let index = 0;
  let plainFrom = 0;
  while (index < text.length) {
    const term = lowerTerms.find((candidate) => lower.startsWith(candidate, index));
    if (term) {
      if (plainFrom < index) parts.push({ text: text.slice(plainFrom, index), match: false });
      parts.push({ text: text.slice(index, index + term.length), match: true });
      index += term.length;
      plainFrom = index;
    } else {
      index += 1;
    }
  }
  if (plainFrom < text.length) parts.push({ text: text.slice(plainFrom), match: false });
  return parts;
}

function Highlighted({ text, terms }: { text: string; terms: readonly string[] }): ReactNode {
  return highlightParts(text, terms).map((part, index) => (part.match ? <mark key={index}>{part.text}</mark> : part.text));
}

type Chip = { id: string; label: string; color?: string; filters: SearchFilters };

/**
 * Full-screen search, as on a phone: the field is focused at once, results
 * appear while typing with the matching words marked, recent searches wait
 * below an empty field, and chips narrow the results to a notebook, open
 * tasks or PDF printouts.
 */
export function SearchScreen({
  ws,
  active,
  now,
  onOpen,
}: {
  ws: MobileWorkspace;
  active: boolean;
  now: Date;
  onOpen: (result: SearchUiResult) => void;
}) {
  const { t, plural, language } = useI18n();
  const locale = formatLocale(language);
  const controller = ws.searchController;
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const [chipId, setChipId] = useState('all');
  const [recent, setRecent] = useState(loadRecent);
  const [snapshot, setSnapshot] = useState<SearchRuntimeSnapshot | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => controller?.subscribe(setSnapshot), [controller]);
  const { requestSearch } = ws;
  useEffect(() => {
    if (!active) return;
    requestSearch();
    inputRef.current?.focus({ preventScroll: true });
  }, [active, requestSearch]);

  const chips = useMemo<Chip[]>(() => [
    { id: 'all', label: t('mobile.search.filter.all'), filters: {} },
    { id: 'open', label: t('mobile.search.filter.open'), filters: { taskState: 'open' } },
    { id: 'pdf', label: t('mobile.search.filter.pdf'), filters: { source: 'pdf' } },
    ...ws.notebooks.map((notebook) => ({
      id: `notebook:${notebook.notebookId}`,
      label: notebook.title,
      color: notebook.color || undefined,
      filters: { notebookId: notebook.notebookId },
    })),
  ], [t, ws.notebooks]);
  const chip = chips.find((candidate) => candidate.id === chipId) ?? chips[0];

  const results = useMemo(() => {
    void snapshot?.revision;
    if (!controller) return [];
    const text = deferredQuery.trim();
    if (!text && chip.filters.taskState === 'open') return controller.taskReview(chip.filters);
    return text ? controller.search(text, chip.filters) : [];
  }, [chip, controller, deferredQuery, snapshot?.revision]);
  const terms = useMemo(() => highlightTerms(deferredQuery), [deferredQuery]);
  const sections = useMemo(() => {
    const colors = new Map<string, string>();
    for (const notebook of ws.notebooks) for (const section of notebook.sections) colors.set(section.id, sectionColor(section));
    return colors;
  }, [ws.notebooks]);
  const updatedAt = useMemo(() => new Map((ws.workspace?.pages ?? []).map((page) => [page.pageId, page.updatedAt])), [ws.workspace?.pages]);

  const remember = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const next = [trimmed, ...recent.filter((entry) => entry !== trimmed)].slice(0, RECENT_LIMIT);
    setRecent(next);
    saveRecent(next);
  };

  const indexing = snapshot?.progress && snapshot.progress.total > 0 && snapshot.progress.done < snapshot.progress.total
    ? snapshot.progress
    : null;
  const showRecent = !query.trim() && chip.filters.taskState !== 'open';

  return (
    <section className="m-search" aria-label={t('mobile.tab.search')} data-testid="mobile-search">
      <header className="m-search__bar">
        <form
          className="m-search__field"
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            remember(query);
            inputRef.current?.blur();
          }}
        >
          <Search size={20} aria-hidden="true" />
          <input
            ref={inputRef}
            type="search"
            enterKeyHint="search"
            autoComplete="off"
            spellCheck={false}
            aria-label={t('mobile.search.placeholder')}
            placeholder={t('mobile.search.placeholder')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query ? (
            <button type="button" className="m-icon-button m-ripple" aria-label={t('mobile.search.clear')} onClick={() => {
              setQuery('');
              inputRef.current?.focus();
            }}>
              <X size={20} aria-hidden="true" />
            </button>
          ) : null}
        </form>
        <div className="m-chips" role="radiogroup" aria-label={t('mobile.search.filters')}>
          {chips.map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              role="radio"
              aria-checked={candidate.id === chip.id}
              className="m-chip m-ripple"
              onClick={() => setChipId(candidate.id)}
            >
              {candidate.id === 'open' ? <CircleCheck size={14} aria-hidden="true" /> : null}
              {candidate.id === 'pdf' ? <FileText size={14} aria-hidden="true" /> : null}
              {candidate.color ? <SectionDot color={candidate.color} size={8} /> : null}
              {candidate.label}
            </button>
          ))}
        </div>
        {indexing ? (
          <p className="m-search__indexing" role="status">
            <span style={{ transform: `scaleX(${indexing.done / indexing.total})` }} aria-hidden="true" />
            {t('mobile.search.indexing', { done: indexing.done, total: indexing.total })}
          </p>
        ) : null}
      </header>
      <div className="m-scroll m-search__results">
        {showRecent ? (
          recent.length > 0 ? (
            <section aria-labelledby="m-search-recent">
              <div className="m-search__recent-head">
                <h2 id="m-search-recent" className="m-overline">{t('mobile.search.recent')}</h2>
                <button type="button" className="m-text-button m-ripple" onClick={() => {
                  setRecent([]);
                  saveRecent([]);
                }}>{t('mobile.search.clearRecent')}</button>
              </div>
              <ul className="m-list" role="list">
                {recent.map((entry) => (
                  <li key={entry}>
                    <button type="button" className="m-row m-row--compact m-ripple" onClick={() => setQuery(entry)}>
                      <span className="m-row__lead" aria-hidden="true"><History size={20} /></span>
                      <span className="m-row__text"><span className="m-row__title">{entry}</span></span>
                      <ArrowUpLeft size={18} aria-hidden="true" className="m-row__chevron" />
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : (
            <p className="m-hint m-search__hint">{t('mobile.search.hint')}</p>
          )
        ) : results.length === 0 ? (
          <p className="m-hint m-search__hint" role="status">
            {query.trim() ? t('mobile.search.none', { query: query.trim() }) : t('mobile.search.noTasks')}
          </p>
        ) : (
          <>
            <p className="m-search__count" role="status">
              {plural(results.length, { one: 'mobile.search.results.one', other: 'mobile.search.results.other' })}
            </p>
            <ul className="m-list" role="list">
              {results.map((result) => (
                <li key={result.documentId}>
                  <button
                    type="button"
                    className="m-result m-ripple"
                    data-testid="mobile-search-result"
                    onClick={() => {
                      remember(query);
                      onOpen(result);
                    }}
                  >
                    <span className="m-result__title">
                      <Highlighted text={result.title || t('workspace.page.untitled')} terms={terms} />
                    </span>
                    {result.snippet ? (
                      <span className="m-result__snippet"><Highlighted text={result.snippet} terms={terms} /></span>
                    ) : null}
                    <span className="m-location">
                      <SectionDot color={sections.get(result.sectionId) ?? '#8a8f98'} size={8} />
                      {result.notebookTitle} · {result.sectionTitle}
                      {updatedAt.get(result.pageId) ? ` · ${relativeTime(updatedAt.get(result.pageId) ?? '', now, locale)}` : ''}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </section>
  );
}
