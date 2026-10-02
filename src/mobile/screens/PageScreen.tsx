import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  ArrowLeft,
  ArrowUpToLine,
  ChevronLeft,
  ChevronRight,
  CloudOff,
  FileQuestion,
  FileText,
  Image as ImageIcon,
  ListTree,
  LoaderCircle,
  MoreVertical,
  Pin,
  Share2,
  TextCursorInput,
  Rows3,
} from 'lucide-react';
import { useI18n } from '../../i18n';
import { formatLocale } from '../../i18n/core';
import LiveCanvasEditor, { type LiveCanvasController, type LiveCanvasReading } from '../../editor/LiveCanvasEditor';
import { holdsMathElements, isMathRuntimeLoaded, loadMathRuntime } from '../../math/runtime';
import { pageContent } from '../../domain/v3';
import { isPinnedPage } from '../../components/pagePins';
import { sectionColor } from '../../components/sectionColors';
import { retryableLazy } from '../../components/retryableLazy';
import { formatPageDate } from '../../ui/dates';
import type { PageSummary } from '../../storage/workspaceV2Runtime';
import { neighbours, relativeTime, sectionPages } from '../model';
import { pageOutline, richTextReader, type OutlineItem } from '../outline';
import { useSafeArea } from '../safeArea';
import { haptic, shareFile } from '../nativeBridge';
import { EmptyState, IconButton, SectionDot, Sheet, SheetAction } from '../ui';
import type { MobileWorkspace } from '../useMobileWorkspace';

const MarkdownPageEditor = retryableLazy(() => import('../../editor/markdown/MarkdownPageEditor'));

// The editor's props change only with the page, its writer and the reading
// options, so the shell's other state (the bars, a sheet) never re-renders it.
const PageEditor = memo(LiveCanvasEditor);

/** The editor is rebuilt when the document behind it is replaced, not for every revision. */
const handleIds = new WeakMap<object, number>();
let handleCount = 0;
function handleKey(handle: object): number {
  let id = handleIds.get(handle);
  if (id === undefined) {
    handleCount += 1;
    id = handleCount;
    handleIds.set(handle, id);
  }
  return id;
}

/** Height of the floating top bar and the page bar below it, without the system bars. */
const TOP_BAR = 64;
const BOTTOM_BAR = 72;

export interface PageRoute {
  notebookId: string;
  sectionId: string;
  pageId: string;
}

export interface PageScreenProps {
  ws: MobileWorkspace;
  route: PageRoute;
  byDocumentId: ReadonlyMap<string, PageSummary>;
  now: Date;
  onBack: () => void;
  /** Turns to another page of the section (replaces this screen, no back step). */
  onTurn: (page: PageRoute, direction: 'next' | 'previous') => void;
}

/**
 * Reading a page: the page fills the screen, fitted to its width, with a
 * floating bar on top (back, title, pin, more) and a page bar at the bottom
 * (position in the section, previous and next). Both step aside while
 * reading down the page and come back when scrolling up or with a tap.
 * A swipe past the page's side turns to the next or previous page.
 */
export function PageScreen({ ws, route, byDocumentId, now, onBack, onTurn }: PageScreenProps) {
  const { t, language } = useI18n();
  const locale = formatLocale(language);
  const safe = useSafeArea();
  const context = ws.activeContext;
  const shown = context && context.page.pageId === route.pageId ? context : null;
  const summary = useMemo(() => [...byDocumentId.values()].find((page) => page.pageId === route.pageId), [byDocumentId, route.pageId]);
  const notebook = ws.notebooks.find((candidate) => candidate.notebookId === route.notebookId);
  const section = notebook?.sections.find((candidate) => candidate.id === route.sectionId);
  const color = section ? sectionColor(section) : '#8a8f98';
  const around = useMemo(
    () => neighbours(section, summary?.documentId ?? '', byDocumentId),
    [byDocumentId, section, summary?.documentId],
  );

  // Opening: the runtime loads the page (a heavy one takes a moment).
  const { openPage } = ws;
  const opening = ws.openingPageId === route.pageId;
  const error = ws.openError?.pageId === route.pageId ? ws.openError : null;
  const [attempt, setAttempt] = useState(0);
  const activePageId = context?.page.pageId;
  useEffect(() => {
    if (activePageId === route.pageId) return;
    void openPage(route);
    // A new attempt (retry) or another page opens it; the active page changing back does not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.pageId, attempt]);

  const [chromeHidden, setChromeHidden] = useState(false);
  const [swipe, setSwipe] = useState(0);
  const [enter, setEnter] = useState<'next' | 'previous' | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [pagesOpen, setPagesOpen] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [formatHost, setFormatHost] = useState<HTMLDivElement | null>(null);
  const controllerRef = useRef<LiveCanvasController | null>(null);
  const onControllerReady = useCallback((controller: LiveCanvasController) => {
    controllerRef.current = controller;
  }, []);
  useEffect(() => {
    if (!enter) return undefined;
    const timer = window.setTimeout(() => setEnter(null), 360);
    return () => window.clearTimeout(timer);
  }, [enter]);

  const turn = useCallback((direction: 'next' | 'previous') => {
    const target = direction === 'next' ? around.next : around.previous;
    if (!target) return;
    haptic('tick');
    setEnter(direction);
    setChromeHidden(false);
    onTurn({ notebookId: route.notebookId, sectionId: route.sectionId, pageId: target.pageId }, direction);
  }, [around.next, around.previous, onTurn, route.notebookId, route.sectionId]);

  // The reading view's options, stable while nothing they carry changes.
  const latest = useRef({ turn });
  useEffect(() => {
    latest.current = { turn };
  });
  const canPrevious = Boolean(around.previous);
  const canNext = Boolean(around.next);
  const reading = useMemo<LiveCanvasReading>(() => ({
    insets: { top: safe.top + TOP_BAR, bottom: safe.bottom + BOTTOM_BAR },
    canSwipe: { previous: canPrevious, next: canNext },
    onTap: () => setChromeHidden((hidden) => !hidden),
    onScroll: (direction) => setChromeHidden(direction === 'down'),
    onSwipeProgress: setSwipe,
    onSwipe: (direction) => latest.current.turn(direction),
    formatToolbarHost: formatHost,
  }), [canNext, canPrevious, formatHost, safe.bottom, safe.top]);

  // Pages with formulas or graphs need the math libraries before the editor mounts.
  const needsMath = shown !== null && holdsMathElements(shown.page.elementsById);
  const [mathLoaded, setMathLoaded] = useState(isMathRuntimeLoaded);
  useEffect(() => {
    if (!needsMath || mathLoaded) return;
    let cancelled = false;
    loadMathRuntime().then(() => {
      if (!cancelled) setMathLoaded(true);
    }, () => {
      if (!cancelled) ws.setNotice(t('workspace.error.mathRuntime'));
    });
    return () => { cancelled = true; };
  }, [mathLoaded, needsMath, t, ws]);

  const session = ws.writeSession;
  const writeRichText = useCallback(
    (change: Parameters<MobileWorkspace['commitPage']>[1], options: { message: string }) => ws.commitPage(options.message, change),
    [ws],
  );
  const commitPage = ws.commitPage;
  const writeRichTextRef = useRef(writeRichText);
  useEffect(() => {
    writeRichTextRef.current = writeRichText;
  });
  const stableWriteRichText = useCallback(
    (change: Parameters<MobileWorkspace['commitPage']>[1], options: { message: string }) => writeRichTextRef.current(change, options),
    [],
  );

  const pinned = summary ? isPinnedPage(summary) : false;
  const title = shown?.page.title ?? summary?.title ?? '';
  const content = shown ? pageContent(shown.page) : null;
  const editorReady = shown !== null && (session?.pageId === shown.page.pageId || ws.writeFailed) && (!needsMath || mathLoaded);

  const outline = useMemo<OutlineItem[]>(() => {
    if (!outlineOpen || !shown) return [];
    return pageOutline(shown.page, richTextReader(shown.pageHandle.doc()));
  }, [outlineOpen, shown]);

  const sharePdf = async () => {
    if (!ws.runtime || !shown) return;
    setMoreOpen(false);
    setSharing(true);
    try {
      const [{ pdfExportPage }, pdf, { runtimeAssetRepository }] = await Promise.all([
        import('../../components/assets/AssetWorkspaceControls'),
        import('../../io/pdf'),
        import('../../components/assets/runtimeAssetRepository'),
      ]);
      const page = await pdfExportPage(ws.runtime, shown.page.pageId);
      const bytes = await pdf.exportComposedPdf({
        pages: [page],
        repository: runtimeAssetRepository(ws.runtime),
        rasterizer: pdf.createBrowserPdfRasterizer(),
        imageRasterizer: pdf.createBrowserImageAssetRasterizer(),
      });
      const name = `${(shown.page.title || t('workspace.page.untitled')).replace(/[^\p{L}\p{N}._ -]+/gu, '-').slice(0, 80)}.pdf`;
      const shared = await shareFile(bytes, 'application/pdf', name, shown.page.title);
      if (!shared) ws.setNotice(t('mobile.page.shareUnavailable'));
    } catch {
      ws.setNotice(t('mobile.page.shareFailed'));
    } finally {
      setSharing(false);
    }
  };

  const keepChrome = moreOpen || outlineOpen || pagesOpen;
  const chromeAway = chromeHidden && !keepChrome;
  const style = { '--m-section': color } as CSSProperties;
  const sectionList = useMemo(() => (section && pagesOpen ? sectionPages(section, byDocumentId) : []), [byDocumentId, pagesOpen, section]);

  return (
    <section className="m-reader" style={style} data-chrome={chromeAway ? 'hidden' : 'shown'} data-testid="mobile-page" aria-label={title || t('workspace.page.untitled')}>
      <header className="m-reader__bar">
        <IconButton label={t('mobile.back')} onClick={onBack}>
          <ArrowLeft size={22} aria-hidden="true" />
        </IconButton>
        <div className="m-reader__title">
          <h1>{title || t('workspace.page.untitled')}</h1>
          <span className="m-location">
            <SectionDot color={color} size={8} />
            {notebook?.title ?? ''}{section ? ` · ${section.title}` : ''}
          </span>
        </div>
        <IconButton
          label={t(pinned ? 'mobile.page.unpin' : 'mobile.page.pin')}
          aria-pressed={pinned}
          onClick={() => {
            haptic('confirm');
            ws.setPagePinned(route.pageId, !pinned);
          }}
        >
          <Pin size={20} aria-hidden="true" fill={pinned ? 'currentColor' : 'none'} />
        </IconButton>
        <IconButton label={t('mobile.page.more')} onClick={() => setMoreOpen(true)}>
          <MoreVertical size={22} aria-hidden="true" />
        </IconButton>
      </header>

      <div className="m-reader__page" data-enter={enter ?? undefined} key={route.pageId}>
        {error ? (
          <EmptyState
            icon={error.notDownloaded ? <CloudOff size={28} /> : <FileQuestion size={28} />}
            title={t(error.notDownloaded ? 'mobile.page.offline.title' : 'mobile.page.error.title')}
            text={error.message}
            action={<button type="button" className="m-button m-button--tonal m-ripple" onClick={() => setAttempt((value) => value + 1)}>{t('mobile.page.retry')}</button>}
          />
        ) : !summary && !shown ? (
          <EmptyState icon={<FileQuestion size={28} />} title={t('mobile.missing.title')} text={t('mobile.missing.text')} />
        ) : !editorReady || !shown ? (
          <div className="m-reader__loading" role="status" aria-label={t('workspace.page.loading')}>
            <div className="m-skeleton" aria-hidden="true">
              <span /><span /><span /><span /><span />
            </div>
            {opening ? <LoaderCircle className="m-spin" size={22} aria-hidden="true" /> : null}
          </div>
        ) : content?.kind === 'markdown' ? (
          <div className="m-reader__markdown">
            <MarkdownPageEditor
              key={shown.page.documentId}
              title={shown.page.title}
              source={content.source}
              editable={session !== null}
              onSourceChange={(source) => {
                ws.commitPage(t('workspace.operation.editMarkdown'), (document) => {
                  document.pageContent = { version: 1, kind: 'markdown', source };
                  document.updatedAt = new Date().toISOString();
                });
              }}
            />
          </div>
        ) : (
          <PageEditor
            key={`${shown.page.documentId}:${handleKey(session?.handle ?? shown.pageHandle)}`}
            handle={session?.handle ?? shown.pageHandle}
            page={shown.page}
            deviceId={ws.deviceId}
            editable={session !== null}
            onChange={commitPage}
            writeRichText={stableWriteRichText}
            renderAssetElement={ws.renderAssetElement}
            mathFeaturesEnabled={false}
            reading={reading}
            onControllerReady={onControllerReady}
          />
        )}
      </div>

      {swipe !== 0 ? (
        <div className="m-reader__swipe" data-side={swipe < 0 ? 'next' : 'previous'} style={{ '--m-swipe': Math.abs(swipe) } as CSSProperties} aria-hidden="true">
          {swipe < 0 ? <ChevronRight size={20} /> : <ChevronLeft size={20} />}
          <span>{(swipe < 0 ? around.next : around.previous)?.title || t('workspace.page.untitled')}</span>
        </div>
      ) : null}

      <nav className="m-reader__pager" aria-label={t('mobile.page.pager')}>
        <IconButton label={t('mobile.page.previous')} disabled={!canPrevious} onClick={() => turn('previous')}>
          <ChevronLeft size={22} aria-hidden="true" />
        </IconButton>
        <button type="button" className="m-reader__position m-ripple" onClick={() => setPagesOpen(true)} data-testid="mobile-page-position">
          <SectionDot color={color} size={8} />
          {around.count > 0 ? t('mobile.page.position', { index: around.index + 1, count: around.count }) : t('mobile.page.sectionPages')}
        </button>
        <IconButton label={t('mobile.page.next')} disabled={!canNext} onClick={() => turn('next')}>
          <ChevronRight size={22} aria-hidden="true" />
        </IconButton>
      </nav>

      {/* The focused text's formatting controls dock here, above the keyboard. */}
      <div className="m-format-bar" ref={setFormatHost} aria-label={t('mobile.format.toolbar')}>
        <button
          type="button"
          className="m-format-bar__done m-ripple"
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => {
            const active = document.activeElement;
            if (active instanceof HTMLElement) active.blur();
          }}
        >
          {t('mobile.format.done')}
        </button>
      </div>

      {sharing ? (
        <div className="m-snackbar" role="status">
          <LoaderCircle className="m-spin" size={18} aria-hidden="true" />
          {t('mobile.page.sharing')}
        </div>
      ) : null}

      <Sheet open={moreOpen} onClose={() => setMoreOpen(false)} title={title || t('workspace.page.untitled')} testId="mobile-page-more">
        {shown && summary ? (
          <p className="m-sheet__meta">
            {t('mobile.page.info', {
              created: formatPageDate(shown.page.createdAt, language),
              updated: relativeTime(shown.page.updatedAt, now, locale),
            })}
          </p>
        ) : null}
        <SheetAction
          icon={<TextCursorInput size={20} />}
          label={t('mobile.page.addText')}
          hint={session ? undefined : t('mobile.page.readOnly')}
          disabled={!session || content?.kind !== 'canvas'}
          onClick={() => {
            setMoreOpen(false);
            controllerRef.current?.createText();
          }}
        />
        <SheetAction icon={<ListTree size={20} />} label={t('mobile.page.outline')} disabled={!shown || content?.kind !== 'canvas'} onClick={() => {
          setMoreOpen(false);
          setOutlineOpen(true);
        }} />
        <SheetAction icon={<Rows3 size={20} />} label={t('mobile.page.sectionPages')} onClick={() => {
          setMoreOpen(false);
          setPagesOpen(true);
        }} />
        <SheetAction icon={<ArrowUpToLine size={20} />} label={t('mobile.page.top')} disabled={!shown || content?.kind !== 'canvas'} onClick={() => {
          setMoreOpen(false);
          controllerRef.current?.revealRegion({ x: 0, y: 0, width: 1, height: 1 });
          setChromeHidden(false);
        }} />
        <SheetAction icon={<Share2 size={20} />} label={t('mobile.page.share')} disabled={!shown || sharing} onClick={() => void sharePdf()} />
      </Sheet>

      <Sheet open={outlineOpen} onClose={() => setOutlineOpen(false)} title={t('mobile.page.outline')} testId="mobile-outline">
        {outline.length === 0 ? (
          <p className="m-hint">{t('mobile.page.outline.empty')}</p>
        ) : (
          <ul className="m-list" role="list">
            {outline.map((item, index) => (
              <li key={index}>
                <button
                  type="button"
                  className="m-row m-row--compact m-ripple"
                  data-level={item.kind === 'heading' ? item.level : undefined}
                  onClick={() => {
                    setOutlineOpen(false);
                    setChromeHidden(false);
                    controllerRef.current?.revealRegion(item.frame);
                  }}
                >
                  <span className="m-row__lead" aria-hidden="true">
                    {item.kind === 'pdf' ? <FileText size={18} /> : item.kind === 'image' ? <ImageIcon size={18} /> : <span className="m-outline-mark" />}
                  </span>
                  <span className="m-row__text">
                    <span className="m-row__title">
                      {item.kind === 'pdf'
                        ? t('mobile.page.outline.pdf', { page: item.page })
                        : item.kind === 'image'
                          ? t('mobile.page.outline.image')
                          : item.text}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Sheet>

      <Sheet open={pagesOpen} onClose={() => setPagesOpen(false)} title={section?.title ?? t('mobile.page.sectionPages')} testId="mobile-section-pages">
        <ul className="m-list" role="list">
          {sectionList.map(({ page, depth }) => (
            <li key={page.pageId}>
              <button
                type="button"
                className="m-row m-row--compact m-ripple"
                data-depth={depth || undefined}
                aria-current={page.pageId === route.pageId ? 'page' : undefined}
                onClick={() => {
                  setPagesOpen(false);
                  if (page.pageId === route.pageId) return;
                  const index = sectionList.findIndex((entry) => entry.page.pageId === page.pageId);
                  const current = sectionList.findIndex((entry) => entry.page.pageId === route.pageId);
                  setEnter(index > current ? 'next' : 'previous');
                  onTurn({ notebookId: route.notebookId, sectionId: route.sectionId, pageId: page.pageId }, index > current ? 'next' : 'previous');
                }}
              >
                <span className="m-row__text">
                  <span className="m-row__title">{page.title || t('workspace.page.untitled')}</span>
                  <span className="m-row__meta">{relativeTime(page.updatedAt, now, locale)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </Sheet>
    </section>
  );
}
