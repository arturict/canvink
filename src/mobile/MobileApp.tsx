import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, BookOpen, Home, Library, Search } from 'lucide-react';
import { useI18n } from '../i18n';
import { onInkPainted } from '../editor/inkRaster';
import type { SearchUiResult } from '../components/search/searchRuntime';
import { safeAvatarUrl } from '../collab/presence';
import {
  INITIAL_NAV,
  backDepth,
  currentStack,
  pop,
  push,
  replaceTop,
  routeKey,
  selectTab,
  topRoute,
  type MobileNavState,
  type MobileRoute,
  type MobileTab,
} from './navigation';
import { useBackNavigation, closeAllLayers, type BackProgress } from './backStack';
import { haptic, installNativeInsets, nativeReady, setSystemBarsLight } from './nativeBridge';
import { pagesByDocumentId, reachablePages, type PageEntry } from './model';
import { useMobileWorkspace, type MobileWorkspace } from './useMobileWorkspace';
import { HomeScreen } from './screens/HomeScreen';
import { NotebookScreen, NotebooksScreen, SectionScreen } from './screens/NotebookScreens';
import { PageScreen, type PageRoute } from './screens/PageScreen';
import { SearchScreen } from './screens/SearchScreen';
import { AccountSheet, LinkSheet, SignInSheet, useAndroidUpdate } from './AccountSheet';
import { installRipple } from './ui';
import { finishPageOpen, reportFirstScreen, startPageOpen } from './metrics';
import './mobile.css';

/**
 * The Android app's shell (and, later, the web app on phones): a native
 * phone hierarchy of Start, Notebooks and Search in a bottom bar, with
 * notebook → section → page stacks above them, Android's back gesture with
 * its predictive animation, and the reading view of LiveCanvasEditor. It
 * reuses the workspace runtime, sync, search and renderers of the notebook
 * shell; none of the desktop shell is loaded (App.tsx picks this chunk).
 */
export default function MobileApp() {
  const ws = useMobileWorkspace();
  const { t } = useI18n();

  useEffect(() => installNativeInsets(), []);
  // The system splash screen goes once something real is on screen; a slow
  // start shows the loading screen below rather than a frozen splash.
  const ready = ws.phase === 'ready' && ws.workspace !== null;
  useEffect(() => {
    if (ready) {
      requestAnimationFrame(() => requestAnimationFrame(() => nativeReady()));
      return undefined;
    }
    const timer = window.setTimeout(nativeReady, 900);
    return () => window.clearTimeout(timer);
  }, [ready]);

  if (ws.phase === 'recovery-required' || ws.phase === 'failed') {
    return (
      <main className="m-app m-boot" data-testid="mobile-recovery">
        <AlertTriangle size={32} aria-hidden="true" />
        <h1>{t('workspace.recovery.title')}</h1>
        <p role="alert">{ws.error?.message ?? t('workspace.error.open')}</p>
        <p>{t('workspace.recovery.description')}</p>
        <button type="button" className="m-button m-button--filled m-ripple" onClick={ws.retry}>{t('workspace.recovery.retry')}</button>
      </main>
    );
  }
  if (!ready) {
    const migrating = ws.progress && ws.progress.phase !== 'idle' && ws.progress.phase !== 'active-v2';
    return (
      <main className="m-app m-boot" aria-live="polite" data-testid="mobile-loading">
        <span className="m-boot__mark" aria-hidden="true"><BookOpen size={28} /></span>
        <p>{migrating ? t('workspace.migration.title') : t('app.loading')}</p>
        {migrating && ws.progress ? (
          <progress aria-label={t('workspace.migration.progress')} max={Math.max(1, ws.progress.total ?? 1)} value={ws.progress.completed ?? 0} />
        ) : null}
      </main>
    );
  }
  return <MobileShell ws={ws} />;
}

const TABS: ReadonlyArray<{ id: MobileTab; icon: typeof Home; label: 'mobile.tab.home' | 'mobile.tab.notebooks' | 'mobile.tab.search' }> = [
  { id: 'home', icon: Home, label: 'mobile.tab.home' },
  { id: 'notebooks', icon: Library, label: 'mobile.tab.notebooks' },
  { id: 'search', icon: Search, label: 'mobile.tab.search' },
];

/**
 * The time relative dates are shown against: it moves every 30 seconds, when
 * the app becomes visible again and whenever the page summaries change, so a
 * page edited just now never reads as "6 min. ago" next to a newer clock.
 */
function useNow(pages: unknown): Date {
  const [now, setNow] = useState(() => new Date());
  const [seenPages, setSeenPages] = useState(pages);
  if (seenPages !== pages) {
    setSeenPages(pages);
    setNow(new Date());
  }
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') setNow(new Date());
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
  return now;
}

/** Light or dark system bar icons, following the shell's theme (the system's). */
function useSystemBars(): void {
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => setSystemBarsLight(!query.matches);
    apply();
    query.addEventListener('change', apply);
    return () => query.removeEventListener('change', apply);
  }, []);
}

interface ExitingLayer {
  tab: MobileTab;
  index: number;
  route: MobileRoute;
}

function layerKey(route: MobileRoute): string {
  // The page screen stays one instance while pages are turned (it animates itself).
  return route.kind === 'page' ? 'page' : routeKey(route);
}

function MobileShell({ ws }: { ws: MobileWorkspace }) {
  const { t } = useI18n();
  const now = useNow(ws.workspace?.pages);
  useSystemBars();
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => (rootRef.current ? installRipple(rootRef.current) : undefined), []);
  useEffect(() => reportFirstScreen('home'), []);

  const [nav, setNav] = useState<MobileNavState>(INITIAL_NAV);
  const [visited, setVisited] = useState<ReadonlySet<MobileTab>>(() => new Set(['home']));
  const [exiting, setExiting] = useState<ExitingLayer[]>([]);
  const [entering, setEntering] = useState<string | null>(null);
  const [accountOpen, setAccountOpen] = useState(false);
  const update = useAndroidUpdate();

  const workspace = ws.workspace;
  const byDocumentId = useMemo(() => pagesByDocumentId(workspace?.pages ?? []), [workspace?.pages]);
  const entries = useMemo(() => reachablePages(ws.notebooks, workspace?.pages ?? []), [workspace?.pages, ws.notebooks]);

  // Navigation runs from events; the latest state is kept beside React's so
  // a change and its animations are decided once, outside any updater.
  const navRef = useRef(nav);
  // The first page a person opens after a start paid for warming up the page
  // loader (1.6 s on the emulator against tens of milliseconds afterwards).
  // Once the start screen has settled, the two pages most likely to be
  // opened next are loaded quietly, so that cost is gone before the tap.
  const runtime = ws.runtime;
  const prefetchRef = useRef({ entries, recent: ws.uiState.recentPageIds });
  useEffect(() => {
    prefetchRef.current = { entries, recent: ws.uiState.recentPageIds };
  });
  useEffect(() => {
    if (!runtime) return undefined;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      const { entries: all, recent } = prefetchRef.current;
      const byRecency = [...all].sort((left, right) => Date.parse(right.page.updatedAt) - Date.parse(left.page.updatedAt));
      const candidates = [...recent.map((pageId) => all.find((entry) => entry.page.pageId === pageId)), ...byRecency]
        .filter((entry): entry is PageEntry => entry !== undefined)
        .filter((entry, index, list) => list.findIndex((other) => other.page.pageId === entry.page.pageId) === index)
        .filter((entry) => ws.isAvailable(entry.page.documentId) && !runtime.isPageLoaded(entry.page.pageId))
        .slice(0, 2);
      void candidates.reduce<Promise<unknown>>((previous, entry) => previous.then(() => {
        if (cancelled) return undefined;
        return runtime.loadPage(entry.page.pageId).catch(() => undefined);
      }), Promise.resolve());
    }, 2_500);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // Once per start: later changes do not schedule it again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime]);

  const navigate = useCallback((change: (state: MobileNavState) => MobileNavState) => {
    const current = navRef.current;
    const next = change(current);
    if (next === current) return;
    navRef.current = next;
    const before = currentStack(current);
    const after = currentStack(next);
    if (next.tab === current.tab && after.length > before.length) {
      const key = layerKey(after[after.length - 1]);
      // A screen still leaving under the same key (back, then at once forward) makes way.
      setExiting((list) => list.filter((entry) => !(entry.tab === current.tab && layerKey(entry.route) === key)));
      setEntering(key);
    } else if (next.tab === current.tab && after.length < before.length) {
      // The screens that leave stay a moment for their exit animation.
      const leaving = before.slice(after.length).map((route, offset) => ({ tab: current.tab, index: after.length + offset + 1, route }));
      setExiting((list) => [
        ...list.filter((entry) => !leaving.some((gone) => gone.tab === entry.tab && layerKey(gone.route) === layerKey(entry.route))),
        ...leaving,
      ]);
    }
    if (next.tab !== current.tab) setVisited((tabs) => (tabs.has(next.tab) ? tabs : new Set([...tabs, next.tab])));
    setNav(next);
  }, []);

  useEffect(() => {
    if (!entering) return undefined;
    const timer = window.setTimeout(() => setEntering(null), 400);
    return () => window.clearTimeout(timer);
  }, [entering]);

  const back = useCallback(() => {
    navigate((current) => pop(current) ?? current);
  }, [navigate]);

  // Predictive back: the top screen follows the gesture before it is committed.
  const topLayerRef = useRef<HTMLElement | null>(null);
  const [peeking, setPeeking] = useState(false);
  const onBackProgress = useCallback((event: BackProgress) => {
    const layer = topLayerRef.current;
    if (!layer) return;
    if (event.phase === 'started') setPeeking(true);
    if (event.phase === 'cancelled') {
      layer.style.transition = 'transform 220ms cubic-bezier(0.2, 0, 0, 1), border-radius 220ms';
      layer.style.transform = '';
      layer.style.borderRadius = '';
      window.setTimeout(() => {
        layer.style.transition = '';
        setPeeking(false);
      }, 230);
      return;
    }
    // Material's predictive back: the screen shrinks toward the gesture's
    // edge with rounded corners; Android's progress rises slowly, so it is eased.
    const progress = 1 - Math.pow(1 - event.progress, 2);
    const shift = (event.edge === 'left' ? 1 : -1) * progress * 40;
    layer.style.transition = 'none';
    layer.style.transform = `translateX(${shift}px) scale(${1 - progress * 0.12})`;
    layer.style.borderRadius = `${Math.round(progress * 32)}px`;
  }, []);
  useBackNavigation({ depth: backDepth(nav), onBack: back, onProgress: onBackProgress });

  const openEntry = useCallback((entry: { notebookId: string; sectionId: string; pageId: string }) => {
    startPageOpen(entry.pageId);
    closeAllLayers();
    navigate((current) => push(current, { kind: 'page', notebookId: entry.notebookId, sectionId: entry.sectionId, pageId: entry.pageId }));
  }, [navigate]);
  const openPageEntry = useCallback((entry: PageEntry) => openEntry({ notebookId: entry.notebookId, sectionId: entry.sectionId, pageId: entry.page.pageId }), [openEntry]);
  const openSearchResult = useCallback((result: SearchUiResult) => openEntry(result), [openEntry]);
  const turnPage = useCallback((page: PageRoute) => {
    startPageOpen(page.pageId);
    navigate((current) => replaceTop(current, { kind: 'page', ...page }));
  }, [navigate]);
  const chooseTab = useCallback((tab: MobileTab) => {
    haptic('tick');
    navigate((current) => selectTab(current, tab));
  }, [navigate]);

  const refresh = useCallback(() => {
    ws.personalSpace.syncNow();
  }, [ws.personalSpace]);

  const pageRoute = topRoute(nav);
  useEffect(() => {
    if (pageRoute?.kind !== 'page') return undefined;
    return onInkPainted((pageId) => {
      if (pageId === pageRoute.pageId) finishPageOpen(pageId);
    });
  }, [pageRoute]);

  const renderRoute = (route: MobileRoute): ReactNode => {
    const notebook = ws.notebooks.find((candidate) => candidate.notebookId === route.notebookId);
    switch (route.kind) {
      case 'notebook':
        return (
          <NotebookScreen
            notebook={notebook}
            onBack={back}
            onRefresh={refresh}
            onOpenSection={(sectionId) => navigate((current) => push(current, { kind: 'section', notebookId: route.notebookId, sectionId }))}
          />
        );
      case 'section':
        return (
          <SectionScreen
            ws={ws}
            notebook={notebook}
            sectionId={route.sectionId}
            byDocumentId={byDocumentId}
            now={now}
            onBack={back}
            onRefresh={refresh}
            onSwitchSection={(sectionId) => navigate((current) => replaceTop(current, { kind: 'section', notebookId: route.notebookId, sectionId }))}
            onOpenPage={openPageEntry}
          />
        );
      case 'page':
        return <PageScreen ws={ws} route={route} byDocumentId={byDocumentId} now={now} onBack={back} onTurn={turnPage} />;
    }
  };

  const renderRoot = (tab: MobileTab): ReactNode => {
    switch (tab) {
      case 'home':
        return (
          <HomeScreen
            ws={ws}
            entries={entries}
            now={now}
            onOpen={openPageEntry}
            onAccount={() => setAccountOpen(true)}
            onRefresh={refresh}
            avatar={ws.auth.available && ws.auth.isSignedIn ? safeAvatarUrl(ws.auth.user?.imageUrl ?? undefined) ?? null : null}
          />
        );
      case 'notebooks':
        return (
          <NotebooksScreen
            ws={ws}
            onRefresh={refresh}
            onOpen={(notebookId) => navigate((current) => push(current, { kind: 'notebook', notebookId }))}
          />
        );
      case 'search':
        return <SearchScreen ws={ws} active={nav.tab === 'search' && currentStack(nav).length === 0} now={now} onOpen={openSearchResult} />;
    }
  };

  const readerOpen = pageRoute?.kind === 'page';
  return (
    <div ref={rootRef} className="m-app" data-reader={readerOpen ? 'open' : undefined}>
      <div className="m-stage">
        {TABS.filter((tab) => visited.has(tab.id)).map(({ id }) => {
          const stack = nav.stacks[id];
          const active = nav.tab === id;
          const layers: Array<{ key: string; index: number; node: ReactNode; leaving?: boolean }> = [
            { key: 'root', index: 0, node: renderRoot(id) },
            ...stack.map((route, offset) => ({ key: layerKey(route), index: offset + 1, node: renderRoute(route) })),
            ...exiting.filter((layer) => layer.tab === id).map((layer) => ({
              key: layerKey(layer.route),
              index: layer.index,
              node: renderRoute(layer.route),
              leaving: true,
            })),
          ];
          const top = stack.length;
          return (
            <div key={id} className="m-tab" data-active={active ? 'true' : 'false'} aria-hidden={active ? undefined : true} inert={!active}>
              {layers.map((layer) => (
                <Layer
                  key={layer.key}
                  depth={layer.index}
                  state={layer.leaving ? 'leaving' : layer.index === top ? 'top' : layer.index === top - 1 && (peeking || exiting.length > 0 || entering !== null) ? 'below-visible' : layer.index < top ? 'below' : 'top'}
                  entering={!layer.leaving && layer.index === top && entering === layer.key}
                  topRef={active && !layer.leaving && layer.index === top ? topLayerRef : undefined}
                  onLeft={() => {
                    setExiting((list) => list.filter((entry) => !(entry.tab === id && layerKey(entry.route) === layer.key)));
                    setPeeking(false);
                  }}
                >
                  {layer.node}
                </Layer>
              ))}
            </div>
          );
        })}
      </div>

      <nav className="m-navbar" aria-label={t('mobile.nav.label')} data-hidden={readerOpen ? 'true' : undefined}>
        {TABS.map(({ id, icon: Icon, label }) => (
          <button
            key={id}
            type="button"
            className="m-navbar__item"
            aria-current={nav.tab === id ? 'page' : undefined}
            onClick={() => chooseTab(id)}
          >
            <span className="m-navbar__indicator m-ripple" aria-hidden="true"><Icon size={22} /></span>
            <span className="m-navbar__label">{t(label)}</span>
          </button>
        ))}
      </nav>

      {ws.notice ? (
        <div className="m-snackbar" role="status" data-raised={readerOpen ? undefined : 'true'}>
          <span>{ws.notice}</span>
          <button type="button" className="m-text-button m-ripple" onClick={() => ws.setNotice(null)}>{t('workspace.notice.close')}</button>
        </div>
      ) : null}

      <AccountSheet ws={ws} open={accountOpen} onClose={() => setAccountOpen(false)} now={now} update={update} />
      <SignInSheet ws={ws} />
      <LinkSheet ws={ws} />
    </div>
  );
}

/**
 * One screen of a stack. A new screen slides in over the one below (Material's
 * shared axis), a closed one slides out, and the screens below stay mounted
 * (scroll positions kept) without being painted.
 */
function Layer({
  depth,
  state,
  entering,
  topRef,
  onLeft,
  children,
}: {
  depth: number;
  state: 'top' | 'below' | 'below-visible' | 'leaving';
  entering: boolean;
  topRef?: { current: HTMLElement | null };
  onLeft: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (topRef) topRef.current = ref.current;
  });
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || !entering || typeof node.animate !== 'function') return;
    node.animate(
      [{ transform: 'translateX(28%)', opacity: 0 }, { transform: 'translateX(0)', opacity: 1 }],
      { duration: 320, easing: 'cubic-bezier(0.05, 0.7, 0.1, 1)' },
    );
  }, [entering]);
  const onLeftRef = useRef(onLeft);
  useEffect(() => {
    onLeftRef.current = onLeft;
  });
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || state !== 'leaving') return undefined;
    if (typeof node.animate !== 'function') {
      onLeftRef.current();
      return undefined;
    }
    const from = node.style.transform || 'translateX(0)';
    node.style.transition = '';
    const animation = node.animate(
      [{ transform: from, opacity: 1 }, { transform: 'translateX(30%) scale(0.98)', opacity: 0 }],
      { duration: 220, easing: 'cubic-bezier(0.3, 0, 0.8, 0.15)', fill: 'forwards' },
    );
    animation.onfinish = () => onLeftRef.current();
    return () => animation.cancel();
  }, [state]);
  return (
    <section ref={ref} className="m-layer" data-state={state} style={{ zIndex: depth + (state === 'leaving' ? 50 : 0) }} inert={state === 'below' || state === 'leaving'}>
      {children}
    </section>
  );
}
