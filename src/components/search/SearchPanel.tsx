import {
  useCallback,
  useDeferredValue,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type UIEvent as ReactUIEvent,
} from 'react';
import {
  ArrowLeft,
  CheckSquare,
  ChevronRight,
  Ellipsis,
  FileSearch,
  History,
  ImagePlus,
  RefreshCw,
  Search,
  Tag,
  X,
} from 'lucide-react';
import { useI18n, type TranslationKey } from '../../i18n';
import type { SearchTaskState } from '../../search/normalize';
import type { PageSummary, V2RuntimeState, WorkspaceV2Runtime } from '../../storage/workspaceV2Runtime';
import { AppMenuButton, menuGroups } from '../../ui/AppMenuButton';
import SearchChoiceChip from './SearchChoiceChip';
import SearchPicker, { type PickerGroup, type PickerOption } from './SearchPicker';
import SearchResultRow, { sourceLabelKeys } from './SearchResultRow';
import {
  WorkspaceSearchController,
  type SearchFilters,
  type SearchRuntimeSnapshot,
  type SearchSourceBadge,
  type SearchUiResult,
} from './searchRuntime';
import {
  forgetSearches,
  recentPageIds,
  recentSearches,
  rememberPage,
  rememberSearch,
} from './searchRecents';
import { scopeFilters, searchLocations, type NotebookOption, type SearchScope } from './searchScope';
import './searchPanel.css';

export interface SearchPanelProps {
  runtime: WorkspaceV2Runtime;
  workspace: V2RuntimeState;
  activePageId: string;
  onNavigate(notebookId: string, sectionId: string, pageId: string): void;
  controller?: WorkspaceSearchController;
}

const statusMessageKeys: Readonly<Record<string, TranslationKey>> = {
  'Lokaler Suchindex wird vorbereitet.': 'search.status.preparing',
  'Lokaler Suchindex ist noch nicht geöffnet.': 'search.status.notOpened',
  'Lokaler Suchindex wird geprüft.': 'search.status.checking',
  'Lokaler Suchindex ist bereit.': 'search.status.ready',
  'Lokaler Suchindex wurde neu aufgebaut.': 'search.status.built',
  'Lokaler Suchindex konnte nicht geöffnet werden.': 'search.status.openFailed',
  'Suchindex wird vollständig neu aufgebaut.': 'search.status.rebuilding',
  'Suchindex wurde neu aufgebaut.': 'search.status.rebuilt',
  'Neuaufbau des Suchindex wurde abgebrochen.': 'search.status.cancelled',
  'Neuaufbau des Suchindex ist fehlgeschlagen.': 'search.status.rebuildFailed',
  'Lokale Windows-OCR läuft. Es werden keine Bilddaten hochgeladen.': 'search.status.ocrRunning',
  'OCR-Text wurde lokal erkannt und indexiert.': 'search.status.ocrDone',
  'Lokale OCR wurde abgebrochen.': 'search.status.ocrCancelled',
  'Lokale OCR ist fehlgeschlagen.': 'search.status.ocrFailed',
  'Suchindex ist aktuell.': 'search.status.current',
  'Inkrementelle Suchaktualisierung ist fehlgeschlagen.': 'search.status.incrementalFailed',
};

/** Messages that say nothing the user needs: the index is fine and quiet. */
const QUIET_MESSAGES: ReadonlySet<TranslationKey> = new Set([
  'search.status.preparing',
  'search.status.notOpened',
  'search.status.checking',
  'search.status.ready',
  'search.status.current',
]);

/** Outcomes of something the user asked for; the panel shows them until they are dismissed. */
const OUTCOME_MESSAGES: ReadonlySet<TranslationKey> = new Set([
  'search.status.rebuilt',
  'search.status.cancelled',
  'search.status.ocrDone',
  'search.status.ocrCancelled',
]);

const initialSnapshot: SearchRuntimeSnapshot = {
  phase: 'idle',
  message: 'Lokaler Suchindex wird vorbereitet.',
  recordCount: 0,
  rebuiltBecauseCorrupt: false,
  revision: 0,
};

const SCOPES: ReadonlyArray<{ id: SearchScope; label: TranslationKey }> = [
  { id: 'page', label: 'search.scope.page' },
  { id: 'section', label: 'search.scope.section' },
  { id: 'notebook', label: 'search.scope.notebook' },
  { id: 'all', label: 'search.scope.all' },
];

const SOURCES: readonly SearchSourceBadge[] = ['text', 'title', 'tag', 'checklist', 'pdf', 'ocr'];

/** Rows rendered before the list is scrolled; every scroll to the end adds as many again. */
const ROW_BATCH = 40;

type Entry =
  | { kind: 'result'; id: string; result: SearchUiResult }
  | { kind: 'query'; id: string; text: string }
  | { kind: 'page'; id: string; page: PageSummary };

interface Block {
  key: string;
  label: string;
  /** Section colour for a result group. */
  color?: string;
  breadcrumb?: readonly string[];
  entries: Array<{ entry: Entry; index: number }>;
}

/** Results of one section sit together; sections keep the order of their best match. */
function groupResults(results: readonly SearchUiResult[]): SearchUiResult[][] {
  const groups = new Map<string, SearchUiResult[]>();
  for (const result of results) {
    const key = `${result.notebookId}\u0000${result.sectionId}`;
    const group = groups.get(key);
    if (group) group.push(result);
    else groups.set(key, [result]);
  }
  return [...groups.values()];
}

interface ActiveFilterChip {
  id: string;
  label: string;
  color?: string;
  icon?: 'tag' | 'task' | 'source';
  remove(): void;
}

export default function SearchPanel({
  runtime,
  workspace,
  activePageId,
  onNavigate,
  controller: injectedController,
}: SearchPanelProps) {
  const { t, plural, language } = useI18n();
  const controller = useMemo(
    () => injectedController ?? new WorkspaceSearchController(runtime),
    [injectedController, runtime],
  );
  const listId = `${useId()}-results`;
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const [open, setOpen] = useState(false);
  // A shortcut follows the page that is open; "custom" means the pickers chose places.
  const [scope, setScope] = useState<SearchScope | 'custom'>('all');
  const [filters, setFilters] = useState<SearchFilters>({});
  const [includeRecycled, setIncludeRecycled] = useState(false);
  const [tasksOpen, setTasksOpen] = useState(false);
  const [languages, setLanguages] = useState<string[]>([]);
  const [ocrLanguage, setOcrLanguage] = useState('');
  const [ocrOpen, setOcrOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [visibleRows, setVisibleRows] = useState(ROW_BATCH);
  const [searches, setSearches] = useState<string[]>(recentSearches);
  const [dismissedNotice, setDismissedNotice] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLElement>(null);
  const ocrController = useRef<AbortController | null>(null);
  const initialWorkspace = useRef(workspace);

  useEffect(() => {
    const unsubscribe = controller.subscribe(setSnapshot);
    void controller.initialize(initialWorkspace.current).then(async () => {
      const installed = await controller.availableLanguages().catch(() => []);
      setLanguages(installed);
      setOcrLanguage((current) => current || installed[0] || '');
    });
    return () => {
      unsubscribe();
      ocrController.current?.abort();
      if (!injectedController) controller.dispose();
    };
  }, [controller, injectedController]);

  useEffect(() => {
    controller.updateWorkspace(workspace);
  }, [controller, workspace]);

  useEffect(() => {
    rememberPage(activePageId);
  }, [activePageId]);
  // Read when the surface opens: the list lives in storage, not in state.
  const openedPages = useMemo(
    () => (open ? recentPageIds().filter((pageId) => pageId !== activePageId) : []),
    [open, activePageId],
  );

  const openSearch = useCallback(() => {
    setOpen(true);
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        openSearch();
      }
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, [openSearch]);

  useEffect(() => {
    if (!open) return undefined;
    const outside = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || rootRef.current?.contains(event.target)) return;
      // The shared menus (chips, "...") open in the body, outside this panel.
      if (event.target.closest('.context-menu')) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [open]);

  const locations = useMemo(() => searchLocations(workspace), [workspace]);
  const active = useMemo(() => ({
    notebookId: workspace.active.notebookId,
    sectionId: workspace.active.sectionId,
    pageId: activePageId,
  }), [activePageId, workspace.active.notebookId, workspace.active.sectionId]);

  const effectiveFilters = useMemo<SearchFilters>(() => ({
    ...filters,
    ...(scope === 'custom' ? {} : scopeFilters(scope, active)),
    ...(!includeRecycled && locations.recycledSectionIds.size > 0 ? { excludeSectionIds: locations.recycledSectionIds } : {}),
  }), [active, filters, includeRecycled, locations.recycledSectionIds, scope]);

  const hasContentFilter = Boolean(filters.tag || filters.taskState);
  const searching = deferredQuery.trim() !== '' || hasContentFilter;
  const results = useMemo(
    () => {
      void snapshot.revision;
      return controller.search(deferredQuery, effectiveFilters);
    },
    [controller, deferredQuery, effectiveFilters, snapshot.revision],
  );
  const taskResults = useMemo(
    () => {
      void snapshot.revision;
      return tasksOpen && !searching ? controller.taskReview(effectiveFilters) : [];
    },
    [controller, effectiveFilters, searching, snapshot.revision, tasksOpen],
  );
  const tagOptions = useMemo(
    () => {
      void snapshot.revision;
      return controller.availableTags();
    },
    [controller, snapshot.revision],
  );
  const queryLimit = useMemo(
    () => controller.describeQueryLimit(deferredQuery, effectiveFilters),
    [controller, deferredQuery, effectiveFilters],
  );

  const view: 'results' | 'tasks' | 'recent' = searching ? 'results' : tasksOpen ? 'tasks' : 'recent';
  const sectionColors = useMemo(() => new Map(
    locations.notebooks.flatMap((notebook) => notebook.sections.map((section) => [section.id, section.color] as const)),
  ), [locations]);

  const entries = useMemo<Entry[]>(() => {
    if (view === 'recent') {
      const byId = new Map(workspace.pages.map((page) => [page.pageId, page] as const));
      return [
        ...searches.map((text, index): Entry => ({ kind: 'query', id: `${listId}-q${index}`, text })),
        ...openedPages
          .flatMap((pageId) => {
            const page = byId.get(pageId);
            return page ? [page] : [];
          })
          .slice(0, 6)
          .map((page, index): Entry => ({ kind: 'page', id: `${listId}-p${index}`, page })),
      ];
    }
    const source = view === 'tasks' ? taskResults : results;
    return groupResults(source).flat().map((result, index): Entry => ({ kind: 'result', id: `${listId}-r${index}`, result }));
  }, [listId, openedPages, results, searches, taskResults, view, workspace.pages]);

  // A new list starts at its first row and its first screenful.
  const listKey = `${view}|${entries.length}|${entries[0]?.id ?? ''}|${query}`;
  const [shownKey, setShownKey] = useState(listKey);
  if (shownKey !== listKey) {
    setShownKey(listKey);
    setActiveIndex(0);
    setVisibleRows(ROW_BATCH);
  }

  const current = entries.length === 0 ? -1 : Math.min(activeIndex, entries.length - 1);
  const activeEntry = current >= 0 ? entries[current] : undefined;

  useEffect(() => {
    if (open && activeEntry) document.getElementById(activeEntry.id)?.scrollIntoView?.({ block: 'nearest' });
  }, [activeEntry, open]);

  const moveActive = (delta: number) => {
    if (entries.length === 0) return;
    const next = (current + delta + entries.length) % entries.length;
    if (next >= visibleRows - 3) setVisibleRows((rows) => Math.max(rows, next + ROW_BATCH));
    setActiveIndex(next);
  };

  const blocks = useMemo<Block[]>(() => {
    const shown = entries.slice(0, visibleRows).map((entry, index) => ({ entry, index }));
    if (view === 'recent') {
      const searchBlock = shown.filter(({ entry }) => entry.kind === 'query');
      const pageBlock = shown.filter(({ entry }) => entry.kind === 'page');
      return [
        ...(searchBlock.length > 0 ? [{ key: 'searches', label: t('search.recent.searches'), entries: searchBlock }] : []),
        ...(pageBlock.length > 0 ? [{ key: 'pages', label: t('search.recent.pages'), entries: pageBlock }] : []),
      ];
    }
    const grouped: Block[] = [];
    for (const item of shown) {
      if (item.entry.kind !== 'result') continue;
      const { result } = item.entry;
      const key = `${result.notebookId}\u0000${result.sectionId}`;
      const last = grouped.at(-1);
      if (last?.key === key) last.entries.push(item);
      else {
        grouped.push({
          key,
          label: result.sectionTitle,
          color: sectionColors.get(result.sectionId),
          breadcrumb: [result.notebookTitle, result.sectionTitle],
          entries: [item],
        });
      }
    }
    return grouped;
  }, [entries, sectionColors, t, view, visibleRows]);

  const navigateTo = (notebookId: string, sectionId: string, pageId: string) => {
    if (query.trim()) setSearches(rememberSearch(query));
    onNavigate(notebookId, sectionId, pageId);
    setQuery('');
    setTasksOpen(false);
    setOpen(false);
    inputRef.current?.blur();
  };

  const activate = (entry: Entry | undefined) => {
    if (!entry) return;
    if (entry.kind === 'result') navigateTo(entry.result.notebookId, entry.result.sectionId, entry.result.pageId);
    else if (entry.kind === 'page') navigateTo(entry.page.notebookId, entry.page.sectionId, entry.page.pageId);
    else {
      setQuery(entry.text);
      inputRef.current?.focus();
    }
  };

  const inputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) setOpen(true);
      else moveActive(event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'Enter') {
      if (open && activeEntry) {
        event.preventDefault();
        activate(activeEntry);
      } else if (query.trim()) setSearches(rememberSearch(query));
    } else if (event.key === 'Escape') {
      event.preventDefault();
      if (open) setOpen(false);
      else {
        setQuery('');
        inputRef.current?.blur();
      }
    }
  };

  // Escape on a chip or button inside the surface closes it and returns to the field.
  const surfaceKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape' && event.target !== inputRef.current && !event.defaultPrevented) {
      event.preventDefault();
      setOpen(false);
      inputRef.current?.focus();
    }
  };

  const scrolled = (event: ReactUIEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    if (element.scrollTop + element.clientHeight >= element.scrollHeight - 240) {
      setVisibleRows((rows) => (rows < entries.length ? rows + ROW_BATCH : rows));
    }
  };

  // ---- filters ----

  const placeFilters = (): SearchFilters => ({
    notebookIds: effectiveFilters.notebookIds,
    sectionIds: effectiveFilters.sectionIds,
  });

  const chooseNotebooks = (ids: string[]) => {
    const kept = (effectiveFilters.sectionIds ?? []).filter((sectionId) => ids.length === 0
      || locations.notebooks.some((notebook) => ids.includes(notebook.id) && notebook.sections.some((section) => section.id === sectionId)));
    setFilters({ ...filters, ...placeFilters(), pageId: undefined, notebookIds: ids.length > 0 ? ids : undefined, sectionIds: kept.length > 0 ? kept : undefined });
    setScope('custom');
  };
  const chooseSections = (ids: string[]) => {
    setFilters({ ...filters, ...placeFilters(), pageId: undefined, sectionIds: ids.length > 0 ? ids : undefined });
    setScope('custom');
  };
  const chooseScope = (next: SearchScope) => {
    setScope(next);
    setFilters({ ...filters, notebookIds: undefined, sectionIds: undefined, pageId: undefined });
  };

  const joinHint = (...parts: Array<string | undefined>) => parts.filter(Boolean).join(' · ');
  // Namesakes get their place among them, and a notebook also its creation date.
  const duplicateHint = (total: number, index: number, createdAt?: string) => {
    if (total <= 1) return undefined;
    const created = createdAt ? new Date(createdAt) : undefined;
    return joinHint(
      t('search.pick.sameTitle', { index, total }),
      created && !Number.isNaN(created.getTime())
        ? t('search.pick.created', { date: new Intl.DateTimeFormat(language, { day: 'numeric', month: 'numeric', year: '2-digit' }).format(created) })
        : undefined,
    );
  };

  const notebookHint = (notebook: NotebookOption) => joinHint(
    duplicateHint(notebook.sameTitleTotal, notebook.sameTitleIndex, notebook.createdAt),
    plural(notebook.sectionCount, { one: 'search.pick.sections.one', other: 'search.pick.sections.other' }),
  );

  const notebookOptions: PickerOption[] = locations.notebooks.map((notebook) => ({
    id: notebook.id,
    label: notebook.title,
    color: notebook.color,
    hint: notebookHint(notebook),
  }));

  const sectionNotebooks = locations.notebooks.filter((notebook) => !effectiveFilters.notebookIds?.length
    || effectiveFilters.notebookIds.includes(notebook.id));
  const sectionGroups: PickerGroup[] = sectionNotebooks.flatMap((notebook): PickerGroup[] => {
    const sections = notebook.sections.filter((section) => includeRecycled || !section.recycled);
    if (sections.length === 0) return [];
    return [{
      id: notebook.id,
      label: notebook.title,
      color: notebook.color,
      hint: duplicateHint(notebook.sameTitleTotal, notebook.sameTitleIndex, notebook.createdAt),
      options: sections.map((section) => ({
        id: section.id,
        label: section.title,
        color: section.color,
        hint: joinHint(
          duplicateHint(section.sameTitleTotal, section.sameTitleIndex),
          plural(section.pageCount, { one: 'search.pick.pages.one', other: 'search.pick.pages.other' }),
        ),
      })),
    }];
  });

  const taskOptions: PickerOption[] = [
    { id: 'open', label: t('search.filter.taskOpen') },
    { id: 'done', label: t('search.filter.taskDone') },
  ];
  const sourceOptions: PickerOption[] = SOURCES.map((source) => ({
    id: source,
    label: t(source === 'ocr' ? 'search.source.ocrLong' : sourceLabelKeys[source]),
  }));

  const activeChips: ActiveFilterChip[] = [];
  for (const id of effectiveFilters.notebookIds ?? []) {
    const notebook = locations.notebooks.find((item) => item.id === id);
    if (notebook && scope === 'custom') {
      activeChips.push({ id: `nb-${id}`, label: notebook.title, color: notebook.color, remove: () => chooseNotebooks((effectiveFilters.notebookIds ?? []).filter((item) => item !== id)) });
    }
  }
  for (const id of effectiveFilters.sectionIds ?? []) {
    const section = locations.notebooks.flatMap((notebook) => notebook.sections).find((item) => item.id === id);
    if (section && scope === 'custom') {
      activeChips.push({ id: `sec-${id}`, label: section.title, color: section.color, remove: () => chooseSections((effectiveFilters.sectionIds ?? []).filter((item) => item !== id)) });
    }
  }
  if (filters.tag) {
    const tag = filters.tag;
    activeChips.push({ id: 'tag', label: tag, icon: 'tag', remove: () => setFilters({ ...filters, tag: undefined }) });
  }
  if (filters.taskState) {
    activeChips.push({
      id: 'task',
      label: t(filters.taskState === 'done' ? 'search.filter.taskDone' : 'search.filter.taskOpen'),
      icon: 'task',
      remove: () => setFilters({ ...filters, taskState: undefined }),
    });
  }
  if (filters.source) {
    const source = filters.source;
    activeChips.push({
      id: 'source',
      label: t(source === 'ocr' ? 'search.source.ocrLong' : sourceLabelKeys[source]),
      icon: 'source',
      remove: () => setFilters({ ...filters, source: undefined }),
    });
  }
  const filtersActive = activeChips.length > 0 || scope !== 'all';
  const clearFilters = () => {
    setScope('all');
    setFilters({});
  };

  // ---- index and OCR state ----

  const messageKey: TranslationKey = statusMessageKeys[snapshot.message] ?? 'search.status.current';
  const message = t(messageKey);
  const failed = snapshot.phase === 'error';
  const rebuilding = snapshot.phase === 'rebuilding';
  const recognizing = snapshot.phase === 'ocr';
  // While a background pass indexes pages, searches cover the pages done so
  // far; the panel says so and shows how far it is, and only then.
  const indexing = snapshot.progress && (snapshot.progress.total > 0 || (snapshot.progress.pdfPending ?? 0) > 0)
    ? snapshot.progress
    : undefined;
  // Once every page's own text is in, the remaining wait is for PDF printouts.
  const pagesDone = indexing !== undefined && indexing.done >= indexing.total;
  const noticeKey = `${snapshot.message}|${snapshot.rebuiltBecauseCorrupt}`;
  const showNotice = !failed && !rebuilding && !recognizing
    && (OUTCOME_MESSAGES.has(messageKey) || snapshot.rebuiltBecauseCorrupt)
    && dismissedNotice !== noticeKey;
  // The spoken status: everything the index reports except its quiet states.
  const spokenStatus = failed ? '' : [
    QUIET_MESSAGES.has(messageKey) ? '' : message,
    snapshot.rebuiltBecauseCorrupt ? t('search.corruptDiscarded') : '',
  ].filter(Boolean).join(' ');

  const recognize = async () => {
    if (!ocrLanguage) return;
    ocrController.current?.abort();
    const operation = new AbortController();
    ocrController.current = operation;
    try {
      await controller.recognizePage(activePageId, ocrLanguage, operation.signal);
    } catch {
      // The controller publishes the bounded local error for the status region.
    } finally {
      if (ocrController.current === operation) ocrController.current = null;
    }
  };

  const retry = () => {
    if (messageKey === 'search.status.ocrFailed') void recognize();
    else void controller.rebuild();
  };

  // ---- render ----

  const listLabel = view === 'results' ? t('search.results.label') : view === 'tasks' ? t('search.tasks.label') : t('search.recent.label');
  const showList = entries.length > 0 && !(view === 'results' && queryLimit);
  const countLabel = view === 'recent' ? '' : plural(entries.length, { one: 'search.results.count.one', other: 'search.results.count.other' });

  return (
    <section
      ref={rootRef}
      className="search-panel"
      aria-label={t('search.label')}
      data-search-indexing={indexing ? 'true' : undefined}
      data-open={open ? 'true' : undefined}
      onKeyDown={surfaceKeyDown}
    >
      <div className="search-panel__bar">
        {indexing ? (
          <span
            className="search-panel__indexing"
            aria-hidden="true"
            style={{ transform: `scaleX(${indexing.total > 0 ? Math.min(1, indexing.done / indexing.total) : 1})` }}
          />
        ) : null}
        <button type="button" className="search-panel__back" aria-label={t('search.close')} onClick={() => setOpen(false)}>
          <ArrowLeft size={18} aria-hidden="true" />
        </button>
        <Search size={16} aria-hidden="true" className="search-panel__glass" />
        <input
          ref={inputRef}
          type="search"
          role="combobox"
          aria-label={t('search.input.label')}
          aria-haspopup="listbox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={open && showList ? listId : undefined}
          aria-activedescendant={open && showList ? activeEntry?.id : undefined}
          placeholder={t('search.input.placeholder')}
          value={query}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => { setQuery(event.target.value); setOpen(true); }}
          onClick={() => setOpen(true)}
          onKeyDown={inputKeyDown}
        />
        {query ? (
          <button type="button" className="search-panel__clear" aria-label={t('search.input.clear')} onClick={() => { setQuery(''); inputRef.current?.focus(); }}>
            <X size={14} aria-hidden="true" />
          </button>
        ) : null}
        <kbd>Ctrl K</kbd>
      </div>

      <p className="sr-only" role="status">{spokenStatus}</p>

      {open ? (
        <div className="search-surface">
          <div className="search-surface__controls">
            <div className="search-surface__top">
              <div
                className="search-scope"
                role="radiogroup"
                aria-label={t('search.scope.label')}
                onKeyDown={(event) => {
                  if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
                  event.preventDefault();
                  const index = SCOPES.findIndex((item) => item.id === scope);
                  const next = SCOPES[(Math.max(index, 0) + (event.key === 'ArrowRight' ? 1 : -1) + SCOPES.length) % SCOPES.length];
                  chooseScope(next.id);
                  event.currentTarget.querySelector<HTMLButtonElement>(`[data-scope="${next.id}"]`)?.focus();
                }}
              >
                {SCOPES.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    role="radio"
                    data-scope={item.id}
                    aria-checked={scope === item.id}
                    tabIndex={scope === item.id || (scope === 'custom' && item.id === 'all') ? 0 : -1}
                    className="search-scope__option"
                    onClick={() => chooseScope(item.id)}
                  >
                    {t(item.label)}
                  </button>
                ))}
              </div>
              <AppMenuButton
                className="search-more__button"
                label={t('search.more')}
                items={() => menuGroups([
                  [
                    {
                      id: 'rebuild',
                      label: t('search.rebuild'),
                      icon: <RefreshCw size={14} aria-hidden="true" />,
                      disabled: rebuilding,
                      onSelect: () => { void controller.rebuild(); },
                    },
                    {
                      id: 'ocr',
                      label: t('search.ocr.local'),
                      icon: <ImagePlus size={14} aria-hidden="true" />,
                      onSelect: () => setOcrOpen(true),
                    },
                  ],
                  [{ id: 'index', label: t('search.index.summary', { count: snapshot.recordCount }), disabled: true }],
                ], 'search-more')}
              >
                <Ellipsis size={16} aria-hidden="true" />
              </AppMenuButton>
            </div>
            <div className="search-filters" role="group" aria-label={t('search.filters.label')}>
              <SearchPicker
                label={t('search.chip.notebook')}
                menuLabel={t('search.filter.notebook')}
                options={notebookOptions}
                selected={effectiveFilters.notebookIds ?? []}
                searchable={notebookOptions.length > 8}
                emptyText={t('search.pick.empty')}
                onChange={chooseNotebooks}
              />
              <SearchPicker
                label={t('search.chip.section')}
                menuLabel={t('search.filter.section')}
                groups={sectionGroups}
                selected={effectiveFilters.sectionIds ?? []}
                searchable
                emptyText={t('search.pick.empty')}
                onChange={chooseSections}
                footer={locations.recycledSectionIds.size > 0 ? (
                  <button
                    type="button"
                    role="switch"
                    aria-checked={includeRecycled}
                    className="search-switch"
                    onClick={() => setIncludeRecycled((value) => !value)}
                  >
                    <span className="search-switch__track" aria-hidden="true"><span /></span>
                    {t('search.pick.recycle')}
                  </button>
                ) : null}
              />
              <SearchChoiceChip
                label={t('search.chip.tag')}
                options={tagOptions.map((tag) => ({ id: tag, label: tag }))}
                disabled={tagOptions.length === 0}
                value={filters.tag}
                anyLabel={t('search.filter.allTags')}
                onChange={(tag) => setFilters({ ...filters, tag })}
              />
              <SearchChoiceChip
                label={t('search.chip.task')}
                options={taskOptions}
                value={filters.taskState}
                anyLabel={t('search.filter.allTasks')}
                onChange={(state) => setFilters({ ...filters, taskState: state as SearchTaskState | undefined })}
              />
              <SearchChoiceChip
                label={t('search.chip.source')}
                options={sourceOptions}
                value={filters.source}
                anyLabel={t('search.filter.allSources')}
                onChange={(source) => setFilters({ ...filters, source: source as SearchSourceBadge | undefined })}
              />
            </div>
            {activeChips.length > 0 ? (
              <ul className="search-active" aria-label={t('search.filters.active')}>
                {activeChips.map((chip) => (
                  <li key={chip.id}>
                    <span className="search-chip search-chip--active">
                      {chip.color ? <span className="search-dot" style={{ background: chip.color }} aria-hidden="true" /> : null}
                      {chip.icon === 'tag' ? <Tag size={12} aria-hidden="true" /> : null}
                      {chip.icon === 'task' ? <CheckSquare size={12} aria-hidden="true" /> : null}
                      <span>{chip.label}</span>
                      <button type="button" aria-label={t('search.filters.remove', { name: chip.label })} onClick={chip.remove}>
                        <X size={12} aria-hidden="true" />
                      </button>
                    </span>
                  </li>
                ))}
                <li>
                  <button type="button" className="search-link" onClick={clearFilters}>{t('search.filters.clear')}</button>
                </li>
              </ul>
            ) : filtersActive ? (
              <ul className="search-active" aria-label={t('search.filters.active')}>
                <li>
                  <button type="button" className="search-link" onClick={clearFilters}>{t('search.filters.clear')}</button>
                </li>
              </ul>
            ) : null}
          </div>

          <div className="search-surface__scroll" onScroll={scrolled}>
            {failed ? (
              <div className="search-banner search-banner--error" role="alert">
                <span>{message}</span>
                <button type="button" className="search-link" onClick={retry}>{t('search.retry')}</button>
              </div>
            ) : rebuilding ? (
              <div className="search-banner">
                <RefreshCw size={14} aria-hidden="true" className="search-spin" />
                <span>
                  {snapshot.progress && snapshot.progress.total > 0
                    ? t('search.index.progress', { done: snapshot.progress.done, total: snapshot.progress.total })
                    : t('search.index.building')}
                </span>
                <button type="button" className="search-link" onClick={() => controller.cancelRebuild()}>{t('search.cancel')}</button>
              </div>
            ) : recognizing ? (
              <div className="search-banner">
                <FileSearch size={14} aria-hidden="true" />
                <span>{t('search.ocr.running')}</span>
                <button type="button" className="search-link" onClick={() => ocrController.current?.abort()}>{t('search.ocr.cancel')}</button>
              </div>
            ) : indexing && view !== 'results' ? (
              <div className="search-banner">
                <RefreshCw size={14} aria-hidden="true" className="search-spin" />
                <span>
                  {pagesDone && indexing.pdfPending
                    ? t('search.incomplete.pdf', { count: indexing.pdfPending })
                    : t('search.index.progress', { done: indexing.done, total: indexing.total })}
                </span>
              </div>
            ) : showNotice ? (
              <div className="search-banner search-banner--note">
                <span>{[QUIET_MESSAGES.has(messageKey) ? '' : message, snapshot.rebuiltBecauseCorrupt ? t('search.corruptDiscarded') : ''].filter(Boolean).join(' ')}</span>
                <button type="button" className="search-banner__close" aria-label={t('search.notice.dismiss')} onClick={() => setDismissedNotice(noticeKey)}>
                  <X size={13} aria-hidden="true" />
                </button>
              </div>
            ) : null}

            {ocrOpen ? (
              <div className="search-ocr">
                <div className="search-ocr__head">
                  <FileSearch size={18} aria-hidden="true" />
                  <div>
                    <strong>{t('search.ocr.title')}</strong>
                    <p>{t('search.ocr.help')}</p>
                  </div>
                  <button type="button" className="search-banner__close" aria-label={t('search.notice.dismiss')} onClick={() => setOcrOpen(false)}>
                    <X size={14} aria-hidden="true" />
                  </button>
                </div>
                <div className="search-ocr__row">
                  <div className="search-scope" role="radiogroup" aria-label={t('search.ocr.language')}>
                    {languages.length === 0 ? <span className="search-ocr__missing">{t('search.ocr.languageRequired')}</span> : languages.map((tag) => (
                      <button
                        key={tag}
                        type="button"
                        role="radio"
                        aria-checked={ocrLanguage === tag}
                        className="search-scope__option"
                        onClick={() => setOcrLanguage(tag)}
                      >
                        {tag}
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    className="search-button"
                    disabled={!ocrLanguage || recognizing}
                    onClick={() => { setOcrOpen(false); void recognize(); }}
                  >
                    {t('search.ocr.recognize')}
                  </button>
                </div>
              </div>
            ) : null}

            {view === 'results' && indexing && !queryLimit ? (
              <p className="search-panel__incomplete">
                <strong>{t('search.incomplete')}</strong>
                <span>{pagesDone && indexing.pdfPending
                  ? t('search.incomplete.pdf', { count: indexing.pdfPending })
                  : t('search.incomplete.progress', { done: indexing.done, total: indexing.total })}</span>
              </p>
            ) : null}

            {view === 'results' && queryLimit ? <p className="search-empty">{t('search.results.tooComplex')}</p> : null}

            {view === 'tasks' ? (
              <div className="search-group__head search-group__head--tasks">
                <strong>{t('search.tasks.label')}</strong>
                <button type="button" className="search-banner__close" aria-label={t('search.tasks.close')} onClick={() => setTasksOpen(false)}>
                  <X size={14} aria-hidden="true" />
                </button>
              </div>
            ) : null}

            {view === 'results' && !queryLimit && entries.length === 0 ? (
              <p className="search-empty">{t('search.results.empty')}</p>
            ) : null}
            {view === 'tasks' && entries.length === 0 ? <p className="search-empty">{t('search.tasks.empty')}</p> : null}
            {view === 'recent' && entries.length === 0 ? <p className="search-empty">{t('search.empty.hint')}</p> : null}

            {showList ? (
              <div
                id={listId}
                className={view === 'tasks' ? 'search-list search-panel__tasks' : 'search-list'}
                role="listbox"
                aria-label={listLabel}
              >
                {blocks.map((block, blockIndex) => {
                  const headId = `${listId}-h-${blockIndex}`;
                  return (
                    <div key={block.key} className="search-group" role="group" aria-labelledby={headId}>
                      <div className="search-group__head" id={headId}>
                        {block.color ? <span className="search-dot" style={{ background: block.color }} aria-hidden="true" /> : null}
                        {block.breadcrumb ? (
                          <span className="search-crumbs">
                            <span>{block.breadcrumb[0]}</span>
                            <ChevronRight size={11} aria-hidden="true" />
                            <span className="sr-only"> / </span>
                            <strong>{block.breadcrumb[1]}</strong>
                          </span>
                        ) : <span>{block.label}</span>}
                        {block.key === 'searches' ? (
                          <button
                            type="button"
                            className="search-link"
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => setSearches(forgetSearches())}
                          >
                            {t('search.recent.clear')}
                          </button>
                        ) : null}
                      </div>
                      {block.entries.map(({ entry, index }) => {
                        if (entry.kind === 'result') {
                          return (
                            <SearchResultRow
                              key={entry.id}
                              id={entry.id}
                              result={entry.result}
                              query={deferredQuery}
                              active={index === current}
                              onHover={() => setActiveIndex(index)}
                              onActivate={() => activate(entry)}
                            />
                          );
                        }
                        const isQuery = entry.kind === 'query';
                        const page = entry.kind === 'page' ? entry.page : undefined;
                        const section = page ? locations.notebooks.find((item) => item.id === page.notebookId)?.sections.find((item) => item.id === page.sectionId) : undefined;
                        return (
                          <div
                            key={entry.id}
                            id={entry.id}
                            role="option"
                            aria-selected={index === current}
                            className="search-result search-result--recent"
                            data-active={index === current ? 'true' : undefined}
                            onMouseDown={(event) => event.preventDefault()}
                            onMouseMove={() => setActiveIndex(index)}
                            onClick={() => activate(entry)}
                          >
                            <span className="search-result__icon" aria-hidden="true">
                              {isQuery ? <History size={15} /> : <span className="search-dot search-dot--large" style={{ background: section?.color }} />}
                            </span>
                            <span className="search-result__body">
                              <span className="search-result__title">{entry.kind === 'query' ? entry.text : page?.title || t('workspace.page.untitled')}</span>
                              {page && section ? <span className="search-result__snippet">{section.title}</span> : null}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            ) : null}

            {view === 'recent' ? (
              <button type="button" className="search-shortcut" onClick={() => setTasksOpen(true)}>
                <CheckSquare size={14} aria-hidden="true" />
                {t('search.tasks.showAll')}
              </button>
            ) : null}
          </div>

          <div className="search-surface__footer">
            <span>{countLabel}</span>
            <span className="search-keys" aria-hidden="true">
              <span><kbd>↑</kbd><kbd>↓</kbd> {t('search.keys.navigate')}</span>
              <span><kbd>↵</kbd> {t('search.keys.open')}</span>
              <span><kbd>Esc</kbd> {t('search.keys.close')}</span>
            </span>
          </div>
        </div>
      ) : null}
    </section>
  );
}
