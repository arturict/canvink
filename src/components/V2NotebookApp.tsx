import type { ChangeFn } from '@automerge/automerge';
import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  Activity,
  AlertTriangle,
  Clock3,
  Download,
  FileInput,
  Languages,
  Library,
  Maximize2,
  BookOpen,
  Hand,
  LoaderCircle,
  Menu,
  PanelLeft,
  MoreHorizontal,
  Minimize2,
  PanelTopClose,
  PanelTopOpen,
  PictureInPicture2,
  Pin,
  Settings2,
  Share2,
  StickyNote,
  Trash2,
  X,
} from 'lucide-react';
import {
  getSharedAutomergeSnapshot,
  projectLiveRichText,
  seedPortableRichText,
  type LiveCanvinkDocumentV2,
  type LiveNotebookDocV2,
  type LivePageDocV2,
} from '../crdt';
import type { MigrationProgress } from '../storage/v2WorkspaceStorage';
import { createPlatformWorkspaceRuntime } from './workspaceRuntimeFactory';
import {
  PageNotDownloadedError,
  type V2RuntimeState,
  type PageSummary,
  type PageWriteSession,
  type WorkspaceV2Runtime,
  type WorkspaceGraphRevisionRequest,
} from '../storage/workspaceV2Runtime';
import { sha256Canonical, type Sha256Checksum, type TrashRecordV2 } from '../domain/v2';
import {
  DEFAULT_MATH_PAGE_SETTINGS,
  pageContent,
  type NotebookDocV3,
  type PageContentV1,
  type PageDocV3,
  type TrashRecordV3,
} from '../domain/v3';
import { LanguageSwitcher, SUPPORTED_LANGUAGES, isLanguage, useI18n } from '../i18n';
import { WorkspaceHistory, createPlatformHistorySnapshotStore } from '../history';
import { holdsMathElements, isMathRuntimeLoaded, loadMathRuntime } from '../math/runtime';
import { LocalPerformanceRecorder } from '../performance/metrics';
import { recordCachedNavigation } from '../performance/navigation';
import LiveCanvasEditor from '../editor/LiveCanvasEditor';
import { CANVINK_FEATURE_FLAGS, featureOverrideAllowed, mathCanvasEnabledForSession } from '../config/featureFlags';
import { setAppFullscreen } from '../platform/fullscreen';
import { VIEWER_APP } from '../platform/viewerApp';
import { useBackClosesLayer } from '../platform/backClosesLayer';
import { FloatingInkToolbar } from '../editor/FloatingInkToolbar';
import {
  loadFullPageToolbar,
  saveFullPageToolbar,
  type FullPageToolbarState,
} from '../editor/floatingToolbar';
import { PageSettingsPanel } from './PageSettingsPanel';
import { PaperMenus } from './PaperMenus';
import PerformanceDiagnostics from './PerformanceDiagnostics';
import { AppMenuButton, menuGroups } from '../ui/AppMenuButton';
import type { ContextMenuEntry } from '../ui/ContextMenu';
import HistoryPanel from './history/HistoryPanel';
import { flushWhenLeaving } from './flushOnLeave';
import { flushBeforeDesktopWindowClose } from '../platform/flushOnWindowClose';
import { pendingInk } from '../ink/pendingInk';
import { flushAllInkQueues, queuedInkStrokes, subscribePendingInk } from '../editor/inkCommitQueue';
import { SearchPanel } from './search';
import {
  AssetElementPreview,
  personalSpaceAssetRepository,
  runtimeAssetRepository,
} from './assets';
import AssetWorkspaceControls from './assets/AssetWorkspaceControls';
import { renderPortableRegionPng } from './assets/pageExport';
import TeamSyncHost from './sync/TeamSyncHost';
import {
  createRealCollabGateway,
  JoinLinkDialog,
  loadJoinedRooms,
  ReadOnlyBadge,
  removeJoinedRoom,
  saveJoinedRoom,
  ShareNotebookDialog,
  useInvitations,
  useJoinLink,
  useNotebookAccess,
  useSharedNotebookSync,
} from './collab';
import { loadOwnerRooms } from './collab/ownerRoomStore';
import { loadPreviewContent } from './collab/presence/previewPage';
import { useOptionalAuth } from '../auth';
import { loadOfflineCopiesPolicy, saveOfflineCopiesPolicy, type OfflineCopiesPolicy, type SpaceStatus } from '../personal-space';
import { usePersonalSpaceSync } from './personal-space/usePersonalSpaceSync';
import { SyncStatus, AccountMenu, SpaceLinkDialog, DesktopLoginDialog } from './personal-space';
import { useKeepLocalChoice } from './personal-space/useKeepLocalChoice';
import type { AccountTab } from './personal-space/AccountDialog';
import { PresenceStack } from './collab/presence/PresenceStack';
import { PagePresenceContext, peersByPageId } from './collab/presence/PagePresence';
import {
  useCanvasPresencePort,
  useLocalPresenceUser,
  usePresenceLifecycle,
  usePresenceRoster,
} from './collab/presence/usePresence';
import Sidebar, {
  type NotebookTransferRequest,
  type PageTransferRequest,
  type SectionGroupTransferRequest,
  type SectionTransferRequest,
} from './Sidebar';
import {
  buildSectionTree,
  canMoveGroupInto,
  effectiveSectionGroupId,
  groupAncestry,
  groupInsertionIndex,
  groupSubtreeIds,
  sectionsInDisplayOrder,
  sectionsInGroup,
} from '../domain/sectionGroups';
import FullPageNavigation from './FullPageNavigation';
import NotebookSwitcher, { isSwitcherShortcut } from './NotebookSwitcher';
import DesktopUpdateChip from './DesktopUpdateChip';
import type { LocalSaveState as SaveState } from './personal-space/syncView';
import {
  PIN_TAG,
  isPinnedPage,
  quickAccessEntries,
  setPagePinned as setPinTag,
  visibleTags,
} from './pagePins';
import {
  createStablePageIdRemap,
  insertionIndex,
  invalidPageTransferCycle,
  moveIdByPlacement,
  pageSubtree,
  remappedParentPageId,
} from './pageTransfer';
import { addPageTag, removePageTag } from './pageSettings';
import {
  DEFAULT_NEW_PAGE_DEFAULTS,
  applyNotebookSettingsPatch,
  resolveNotebookSettings,
  type NotebookSettingsPatch,
  type ResolvedNewPageDefaults,
} from '../domain/notebookSettings';
import { applyPageLook, pageLookForDefaults } from './newPageDefaults';
import type { ApplyDefaultsResult } from './NotebookSettingsDialog';
import {
  PAGE_TAG_LIMIT,
  normalizePageTag,
} from '../domain/pageTags';
import {
  loadV2UiState,
  localDeviceId,
  migrationTrashCount,
  createNotebookProjector,
  rememberNavigation,
  saveV2UiState,
  type V2UiState,
} from './v2WorkspaceView';
import {
  useWorkspaceV2Runtime,
  type WorkspaceV2RuntimeFactory,
} from './useWorkspaceV2Runtime';
import { useConfirm } from '../ui/ConfirmDialog';
import { formatPageDate } from '../ui/dates';
import { Ribbon, type RibbonTab } from './Ribbon';
import { TouchModeGroup } from './TouchModeGroup';
import {
  BUILTIN_TEMPLATES,
  applyBuiltinTemplate,
  isTemplatePage,
  TEMPLATE_TAG,
  titleFromTemplate,
  type PageTemplateSource,
} from './pageTemplates';
import { useDismissibleMenus } from '../ui/dismissMenus';
import { retryableLazy } from './retryableLazy';
import { inkPainted, onInkPainted } from '../editor/inkRaster';
import {
  loadInkRaster,
  startupInkRaster,
  startupInkRasterFound,
  type ShownInkRaster,
} from '../editor/inkRasterDisplay';
import { InkRasterLayer } from '../editor/InkRasterLayer';
import { useLegacyInkRebuild } from './useLegacyInkRebuild';
import { inkRasterStore } from '../editor/inkRasterStore';

function PageLoadingStatus() {
  const { t } = useI18n();
  return (
    <div className="v2-page-loading" role="status">
      <LoaderCircle className="spin" size={18} aria-hidden="true" />
      <span>{t('workspace.page.loading')}</span>
    </div>
  );
}

// The account page loads when someone opens it; it needs none of the editor's code.
const AccountDialog = retryableLazy(() => import('./personal-space/AccountDialog'));
// Loaded when the import dialog is first wanted (see OneNoteImportDialogHost).
const OneNoteImportDialog = retryableLazy(() => import('./import/OneNoteImportDialogHost'));
// The notebook settings dialog loads when it is first opened.
const NotebookSettingsDialog = retryableLazy(() => import('./NotebookSettingsDialog'));
// The Markdown parser and editor load with the first Markdown page.
const MarkdownPageEditor = retryableLazy(() => import('../editor/markdown/MarkdownPageEditor'), {
  fallback: <PageLoadingStatus />,
});

// The editor's props change only with the page, the write session or the
// device settings, so a state change elsewhere in the shell (a ribbon tab, a
// notice, the save status) must not re-render the canvas and its toolbars.
const PageEditor = memo(LiveCanvasEditor);

/**
 * Stands for a page document handle in the editor's key: the editor is rebuilt
 * when the document behind it is replaced, not for every workspace revision.
 */
const editorHandleIds = new WeakMap<object, number>();
let editorHandleCount = 0;
function editorHandleKey(handle: object): number {
  let id = editorHandleIds.get(handle);
  if (id === undefined) {
    editorHandleCount += 1;
    id = editorHandleCount;
    editorHandleIds.set(handle, id);
  }
  return id;
}

/** A page whose document is still loading after a navigation to it. */
interface PendingPage {
  notebookId: string;
  sectionId: string;
  pageId: string;
  title: string;
}

/**
 * The app opens on the page last viewed on this device, like OneNote. The
 * workspace itself only stores the page of its last structural change.
 */
const lastViewedPageId = (): string | undefined => loadV2UiState(safeLocalStorage()).recentPageIds[0];

/**
 * How long opening a page waits for its stored ink picture (see
 * editor/inkRaster.ts) before loading its document, which holds the main
 * thread; a picture found later would only show once the page is there.
 */
const INK_RASTER_WAIT_MS = 150;
const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/**
 * The runtime opens the page last viewed within its startup, in one long
 * task for a heavy page. Its stored ink picture is looked up meanwhile and,
 * when there is one, painted on the startup screen before that task starts.
 */
function withStartupInkRaster(factory: WorkspaceV2RuntimeFactory): WorkspaceV2RuntimeFactory {
  return async (onMigrationProgress) => {
    const lookup = startupInkRaster();
    const runtime = factory(onMigrationProgress);
    if (lookup) {
      // Two frames: the app renders the picture, then a frame shows it.
      await lookup.then((raster) => (raster ? nextFrame().then(nextFrame) : undefined));
    }
    return runtime;
  };
}

export const defaultWorkspaceV2RuntimeFactory: WorkspaceV2RuntimeFactory = withStartupInkRaster(
  (onMigrationProgress) => createPlatformWorkspaceRuntime(onMigrationProgress, lastViewedPageId),
);

export interface V2NotebookAppProps {
  runtimeFactory?: WorkspaceV2RuntimeFactory;
}

function messageFromError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Titles of the section groups around a section, outermost first. */
function samePagePresence(
  left: ReadonlyMap<string, readonly unknown[]>,
  right: ReadonlyMap<string, readonly unknown[]>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [pageId, peers] of left) {
    const other = right.get(pageId);
    if (!other || other.length !== peers.length || peers.some((peer, index) => peer !== other[index])) return false;
  }
  return true;
}

function sectionGroupPath(
  notebook: { sectionGroups?: ReadonlyArray<{ id: string; title: string; parentGroupId?: string }> },
  section: { id: string; groupId?: string },
): string[] {
  const groups = notebook.sectionGroups ?? [];
  return groupAncestry(groups, effectiveSectionGroupId(section, groups))
    .map((id) => groups.find((group) => group.id === id)?.title ?? '');
}

function createLocalId(scope: string): string {
  const suffix = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${scope}-${suffix}`;
}

function downloadJson(value: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function newPageProjection(options: {
  notebookId: string;
  sectionId: string;
  pageId: string;
  title?: string;
  parentPageId?: string;
  pageKind?: PageContentV1['kind'];
  /** The notebook's defaults for new pages; the built-in ones when omitted. */
  defaults?: ResolvedNewPageDefaults;
  now: string;
}): PageDocV3 {
  const pageKind = options.pageKind ?? 'canvas';
  const look = pageLookForDefaults(options.defaults ?? DEFAULT_NEW_PAGE_DEFAULTS);
  return {
    schemaVersion: 3,
    documentId: `page:${options.pageId}`,
    kind: 'page',
    notebookId: options.notebookId,
    sectionId: options.sectionId,
    pageId: options.pageId,
    ...(options.parentPageId ? { parentPageId: options.parentPageId } : {}),
    title: options.title ?? 'Untitled page',
    tags: [],
    pageType: pageKind === 'markdown' ? 'free' : look.pageType,
    ...(pageKind !== 'markdown' && look.paper ? { paper: look.paper } : {}),
    background: pageKind === 'markdown'
      ? { type: 'plain', color: '#ffffff' }
      : look.background,
    createdAt: options.now,
    updatedAt: options.now,
    elementsById: {},
    zOrder: [],
    mathSettings: { ...DEFAULT_MATH_PAGE_SETTINGS },
    pageContent: pageKind === 'markdown'
      ? { version: 1, kind: 'markdown', source: '' }
      : { version: 1, kind: 'canvas' },
    version: { protocol: 'uninitialized', heads: [] },
  };
}

/**
 * A portable copy of a page for a new page ID. The source page is read on
 * demand, so copying a page that is not open loads it only for the copy.
 */
/**
 * Whether two snapshots of a page hold the same ink: the same strokes with the
 * same samples, colours and order. A rebuild only replaces the original when
 * this holds.
 */
function sameInk(before: LivePageDocV2, after: LivePageDocV2): boolean {
  const strokeIds = (page: LivePageDocV2): string[] => page.zOrder.filter((id) => page.elementsById[id]?.kind === 'stroke');
  const left = strokeIds(before);
  const right = strokeIds(after);
  if (left.length !== right.length) return false;
  return left.every((id, index) => {
    const a = before.elementsById[id];
    const b = after.elementsById[right[index]];
    return id === right[index] && a?.kind === 'stroke' && b?.kind === 'stroke'
      && a.color === b.color && a.size === b.size && a.tool === b.tool
      && a.points.length === b.points.length
      // Segments hold positions at 1/128 unit and pressure in 254 steps, as packed samples do.
      && a.points.every((point, at) => Math.abs(point.x - b.points[at].x) <= 1 / 200
        && Math.abs(point.y - b.points[at].y) <= 1 / 200
        && Math.abs(point.pressure - b.points[at].pressure) <= 1 / 200);
  });
}

async function duplicatePageProjection(
  runtime: WorkspaceV2Runtime,
  sourcePageId: string,
  pageId: string,
  now: string,
  title: string,
): Promise<PageDocV3> {
  return runtime.readPage(sourcePageId, (document) => {
    const source = getSharedAutomergeSnapshot<LivePageDocV2>(document);
    const elementsById: PageDocV3['elementsById'] = {};
    for (const [elementId, element] of Object.entries(source.elementsById)) {
      if (element.kind === 'richText') {
        const { text: _text, ...metadata } = structuredClone(element);
        void _text;
        elementsById[elementId] = {
          ...metadata,
          content: projectLiveRichText(document, elementId),
        };
      } else {
        elementsById[elementId] = structuredClone(element);
      }
    }
    return {
      ...structuredClone(source),
      schemaVersion: 3,
      documentId: `page:${pageId}`,
      pageId,
      title,
      // A copy is a new page; the original stays the pinned one.
      tags: source.tags.filter((tag) => tag !== PIN_TAG),
      createdAt: now,
      updatedAt: now,
      elementsById,
      mathSettings: source.mathSettings
        ? structuredClone(source.mathSettings)
        : { ...DEFAULT_MATH_PAGE_SETTINGS },
      version: { protocol: 'uninitialized', heads: [] },
    } as PageDocV3;
  });
}

function LoadingWorkspace({ progress, inkRaster }: { progress: MigrationProgress | null; inkRaster: ShownInkRaster | null }) {
  const { t } = useI18n();
  const migrating = progress && progress.phase !== 'idle';
  const indexing = progress?.phase === 'indexing-pages';
  const maximum = Math.max(1, progress?.total ?? 1);
  const value = Math.min(maximum, progress?.completed ?? 0);
  return (
    <main className="app-loading" aria-live="polite">
      <span className="brand-mark" aria-hidden="true">C</span>
      <h1>{indexing ? t('workspace.loading.indexing') : migrating ? t('workspace.migration.title') : t('workspace.loading.title')}</h1>
      <p>
        {indexing
          ? t('workspace.loading.indexingPages', { done: value, total: maximum })
          : `${t('workspace.loading.checking')} ${migrating ? `(${value}/${maximum})` : ''}`}
      </p>
      {migrating ? (
        <progress aria-label={t('workspace.migration.progress')} max={maximum} value={value} />
      ) : null}
      <small>{indexing ? t('workspace.loading.indexingHint') : t('workspace.migration.backup')}</small>
      <LanguageSwitcher className="app-language-switcher" />
      {inkRaster ? <InkRasterLayer raster={inkRaster} fixed /> : null}
    </main>
  );
}

function RecoveryWorkspace({
  error,
  recoveryCode,
  retry,
}: {
  error: Error;
  recoveryCode: string | null;
  retry: () => void;
}) {
  const { t } = useI18n();
  const downloadReport = () => downloadJson({
    generatedAt: new Date().toISOString(),
    recoveryCode,
    message: error.message,
    userAgent: navigator.userAgent,
  }, 'canvink-v2-recovery-report.json');
  return (
    <main className="fatal-state v2-recovery" aria-labelledby="v2-recovery-title">
      <AlertTriangle size={34} aria-hidden="true" />
      <h1 id="v2-recovery-title">{t('workspace.recovery.title')}</h1>
      <p role="alert">{error.message}</p>
      <p>
        {t('workspace.recovery.description')}
      </p>
      <div className="v2-recovery__actions">
        <button type="button" onClick={retry}>{t('workspace.recovery.retry')}</button>
        <button type="button" onClick={downloadReport}>{t('workspace.recovery.download')}</button>
      </div>
      <small>{t('workspace.recovery.code', { code: recoveryCode ?? t('workspace.recovery.fallbackCode') })}</small>
      <LanguageSwitcher className="app-language-switcher" />
    </main>
  );
}

const TOUCH_DRAW_KEY = 'canvink:touch-draws';

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const list = window.matchMedia(query);
    const update = () => setMatches(list.matches);
    list.addEventListener('change', update);
    return () => list.removeEventListener('change', update);
  }, [query]);
  return matches;
}

/** How long a notice stays: about three seconds, longer for long texts. */
function noticeDuration(message: string): number {
  return Math.min(10_000, 3_000 + Math.max(0, message.length - 60) * 50);
}

/**
 * Strokes the pen has lifted from but the editor has not written yet go into
 * the page first. Their journal records are started at once, before the long
 * seal inside `flush`: a closing page may be cut off after the first
 * asynchronous steps, and the journal is what brings the strokes back.
 */
function flushForLeaving(runtime: { flush(options?: { seal?: boolean }): Promise<void> }): Promise<unknown> {
  flushAllInkQueues();
  return Promise.all([pendingInk().flushJournals(), runtime.flush({ seal: false })]);
}

export default function V2NotebookApp({
  runtimeFactory = defaultWorkspaceV2RuntimeFactory,
}: V2NotebookAppProps) {
  const { language, setLanguage, t, plural } = useI18n();
  useDismissibleMenus();
  // OneNote-style ribbon: the active tab and the slot elements the page
  // editor and the asset controls render their groups into.
  const [ribbonTab, setRibbonTab] = useState<RibbonTab>('home');
  const [homeSlot, setHomeSlot] = useState<HTMLDivElement | null>(null);
  const [insertSlot, setInsertSlot] = useState<HTMLDivElement | null>(null);
  const [drawSlot, setDrawSlot] = useState<HTMLDivElement | null>(null);
  const [viewSlot, setViewSlot] = useState<HTMLDivElement | null>(null);
  // Slots of the floating ink toolbar, mounted only in the full page view.
  const [floatSlot, setFloatSlot] = useState<HTMLElement | null>(null);
  const [floatCurrentSlot, setFloatCurrentSlot] = useState<HTMLElement | null>(null);
  const [assetInsertSlot, setAssetInsertSlot] = useState<HTMLDivElement | null>(null);
  // "Draw with touch": unset means automatic (fingers draw until a pen is
  // used, then they scroll); an explicit choice is remembered per device.
  const [touchDraws, setTouchDraws] = useState<boolean | undefined>(() => {
    const stored = safeLocalStorage()?.getItem(TOUCH_DRAW_KEY);
    return stored === 'true' ? true : stored === 'false' ? false : undefined;
  });
  const updateTouchDraws = useCallback((value: boolean) => {
    setTouchDraws(value);
    try {
      safeLocalStorage()?.setItem(TOUCH_DRAW_KEY, String(value));
    } catch {
      // Without storage the choice lasts for this session only.
    }
  }, []);
  const ribbonSlotRefs = useMemo(
    () => ({ home: setHomeSlot, insert: setInsertSlot, draw: setDrawSlot, view: setViewSlot }),
    [],
  );
  const ribbonSlots = useMemo(
    () => ({
      home: homeSlot,
      insert: insertSlot,
      draw: drawSlot,
      view: viewSlot,
      float: floatSlot,
      floatCurrent: floatCurrentSlot,
    }),
    [drawSlot, floatCurrentSlot, floatSlot, homeSlot, insertSlot, viewSlot],
  );
  const startup = useWorkspaceV2Runtime(runtimeFactory);
  const [workspaceOverride, setWorkspaceOverride] = useState<V2RuntimeState | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // The page being opened while its document loads (see navigate).
  const [pendingPage, setPendingPage] = useState<PendingPage | null>(null);
  // The stored picture of a loading page's ink, shown until the editor has
  // painted the real ink (see editor/inkRaster.ts).
  const [inkRaster, setInkRaster] = useState<ShownInkRaster | null>(() => {
    const found = startupInkRasterFound();
    return found && !inkPainted(found.record.pageId) ? found : null;
  });
  const inkRasterTargetRef = useRef<string | null>(null);
  useEffect(() => {
    let active = true;
    void startupInkRaster()?.then((raster) => {
      if (!active || !raster) return;
      if (inkPainted(raster.record.pageId)) raster.bitmap.close();
      else setInkRaster((current) => current ?? raster);
    });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => onInkPainted((pageId) => {
    setInkRaster((current) => (current?.record.pageId === pageId ? null : current));
  }), []);
  useEffect(() => {
    if (!inkRaster) return;
    // A page that never paints ink (it failed to open) does not keep the picture.
    const timer = window.setTimeout(() => setInkRaster((current) => (current === inkRaster ? null : current)), 15_000);
    return () => {
      window.clearTimeout(timer);
      inkRaster.bitmap.close();
    };
  }, [inkRaster]);
  // Notices are transient toasts over the page, never part of it: a short
  // one ("PDF-Ausdruck eingefügt") goes after about three seconds, longer
  // texts such as errors stay a little longer.
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), noticeDuration(notice));
    return () => window.clearTimeout(timer);
  }, [notice]);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const wideLayout = useMediaQuery('(min-width: 1100px)');
  // Below this width the navigation covers the title bar (see styles.css).
  const overlayNavigation = useMediaQuery('(max-width: 820px)');
  const [trashOpen, setTrashOpen] = useState(false);
  useEffect(() => {
    if (!trashOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setTrashOpen(false);
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [trashOpen]);
  const [shareOpen, setShareOpen] = useState(false);
  // The notebook the share dialog is for; the open one when unset (the settings dialog can name another).
  const [shareNotebookId, setShareNotebookId] = useState<string | null>(null);
  const [notebookSettingsTarget, setNotebookSettingsTarget] = useState<{ notebookId: string; returnFocus: HTMLElement | null } | null>(null);
  useBackClosesLayer(notebookSettingsTarget !== null && !shareOpen, () => setNotebookSettingsTarget(null));
  const [offlinePolicy, setOfflinePolicy] = useState<OfflineCopiesPolicy>(loadOfflineCopiesPolicy);
  const [locationHash, setLocationHash] = useState(() => window.location.hash);
  const [oneNoteImportOpen, setOneNoteImportOpen] = useState(() => {
    const callback = new URLSearchParams(window.location.search);
    return callback.has('state') && (callback.has('code') || callback.has('error'));
  });
  // Mounted when first opened and kept, so the dialog keeps its state like an always-mounted one.
  const [oneNoteImportLoaded, setOneNoteImportLoaded] = useState(oneNoteImportOpen);
  if (oneNoteImportOpen && !oneNoteImportLoaded) setOneNoteImportLoaded(true);
  const [historyOpen, setHistoryOpen] = useState(false);
  // The page-history viewer (TeamSyncHost) makes the whole app read-only; sharing makes one notebook so.
  const [teamViewerMode, setViewerMode] = useState(false);
  // Bumped after a share was created, joined or left: those change local records, not the workspace.
  const [ownerRoomsTick, setOwnerRoomsTick] = useState(0);
  // OneNote's full page view: only the page and a compact set of drawing
  // tools, with the window in fullscreen where the platform allows it.
  const [fullPage, setFullPage] = useState(false);
  const [fullPageToolsOpen, setFullPageToolsOpen] = useState(true);
  // Floating tools or the docked Draw row, and where the floating toolbar
  // rests; remembered per device.
  const [fullPageToolbar, setFullPageToolbar] = useState<FullPageToolbarState>(
    () => loadFullPageToolbar(safeLocalStorage()),
  );
  const updateFullPageToolbar = useCallback((update: Partial<FullPageToolbarState>) => {
    setFullPageToolbar((current) => ({ ...current, ...update }));
  }, []);
  useEffect(() => {
    saveFullPageToolbar(safeLocalStorage(), fullPageToolbar);
  }, [fullPageToolbar]);
  const fullPageFloating = fullPage && fullPageToolbar.mode === 'floating';
  // The navigation panel of the full page view; `switcherRequested` opens
  // the notebook switcher in it at once (Ctrl+G).
  const [fullPageNavOpen, setFullPageNavOpen] = useState(false);
  const [switcherRequested, setSwitcherRequested] = useState(false);
  const closeFullPageNav = useCallback(() => {
    setFullPageNavOpen(false);
    setSwitcherRequested(false);
  }, []);
  const fullPageRef = useRef(false);
  const tabBeforeFullPageRef = useRef<RibbonTab>('home');
  const [tagDraft, setTagDraft] = useState('');
  const [uiState, setUiState] = useState<V2UiState>(() => loadV2UiState(safeLocalStorage()));
  const [deviceId] = useState(() => localDeviceId(safeLocalStorage()));
  const mathFeaturesEnabled = mathCanvasEnabledForSession(CANVINK_FEATURE_FLAGS, {
    allowFeatureOverride: featureOverrideAllowed(import.meta.env),
    search: window.location.search,
  });
  const performanceRecorder = useMemo(() => new LocalPerformanceRecorder(), []);
  const flushTimerRef = useRef<number | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const { confirm, element: confirmElement } = useConfirm();
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [pageWriteSession, setPageWriteSession] = useState<PageWriteSession | null>(null);
  // The page whose write session could not be prepared; it opens read-only.
  const [pageWriteFailedFor, setPageWriteFailedFor] = useState<string | null>(null);

  const runtime = startup.runtime;
  const workspace = workspaceOverride ?? startup.state;
  // What this account may do in each shared notebook, as the room last said. A reader's notebook is
  // read-only: the editing UI is off (the same switch the page-history viewer uses) and the storage
  // layer refuses local edits of its documents (`src/storage/readOnlyDocuments.ts`).
  const notebookAccess = useNotebookAccess(workspace, ownerRoomsTick);
  const activeNotebookId = workspace?.active.notebookId;
  const notebookReadOnly = activeNotebookId ? notebookAccess.isReadOnly(activeNotebookId) : false;
  const viewerMode = teamViewerMode || notebookReadOnly;
  const workspaceHistory = useMemo(
    () => runtime ? new WorkspaceHistory(runtime, createPlatformHistorySnapshotStore()) : null,
    [runtime],
  );
  const activePageId = workspace?.active.pageId ?? null;
  const activePageWriteSession = !viewerMode
    && pageWriteSession?.pageId === activePageId
    && pageWriteSession.activationArtifactFingerprint === workspace?.activation.artifactFingerprint
    ? pageWriteSession
    : null;
  // The newest session of the shown page, even while a newer one is being
  // prepared (after a sync commit or a topology change). The editor keeps
  // running on it, so nothing remounts and no stroke in flight is lost.
  const shownPageWriteSession = !viewerMode && pageWriteSession?.pageId === activePageId
    ? pageWriteSession
    : null;
  // Changes made while the session is prepared again; applied in order as
  // soon as the new session is ready.
  const queuedPageChangesRef = useRef<Array<{ pageId: string; message: string; change: ChangeFn<LivePageDocV2> }>>([]);
  // The indicator reads "saved" only when nothing is waiting to be written:
  // no debounced flush scheduled, no flush or topology commit still running.
  // A flush that finishes while a newer edit waits for its own flush must not
  // report "saved" for that edit.
  const writesInFlightRef = useRef(0);
  // A stroke that waits in the editor for its write is not saved either.
  const inkWaiting = useSyncExternalStore(subscribePendingInk, () => queuedInkStrokes() > 0, () => false);
  const markSavedWhenIdle = useCallback(() => {
    if (flushTimerRef.current === null && writesInFlightRef.current === 0) setSaveState('saved');
  }, []);
  const scheduleFlush = useCallback(() => {
    if (!runtime) return;
    setSaveState('saving');
    setSaveError(null);
    if (flushTimerRef.current !== null) window.clearTimeout(flushTimerRef.current);
    flushTimerRef.current = window.setTimeout(() => {
      flushTimerRef.current = null;
      const startedAt = performance.now();
      writesInFlightRef.current += 1;
      void runtime.flush().then(() => {
        performanceRecorder.record('storage-flush', Math.max(0, performance.now() - startedAt));
        writesInFlightRef.current -= 1;
        markSavedWhenIdle();
      }).catch((error: unknown) => {
        writesInFlightRef.current -= 1;
        setSaveState('error');
        setSaveError(messageFromError(error, t('workspace.error.flush')));
      });
    }, 250);
  }, [markSavedWhenIdle, performanceRecorder, runtime, t]);

  useEffect(() => () => {
    if (flushTimerRef.current !== null) window.clearTimeout(flushTimerRef.current);
  }, []);

  useEffect(() => {
    if (!runtime) return;
    return flushWhenLeaving(window, document, () => flushForLeaving(runtime));
  }, [runtime]);

  // The desktop window's close is held until the last edits are written.
  useEffect(() => {
    if (!runtime) return;
    const registration = flushBeforeDesktopWindowClose(() => flushForLeaving(runtime));
    return () => {
      void registration.then((stop) => stop());
    };
  }, [runtime]);

  // Ink pictures of pages that are gone are dropped once the app has settled.
  const workspacePagesRef = useRef(workspace?.pages);
  useEffect(() => {
    workspacePagesRef.current = workspace?.pages;
  }, [workspace?.pages]);
  useEffect(() => {
    if (!runtime) return;
    const timer = window.setTimeout(() => {
      const pages = workspacePagesRef.current;
      if (pages) void inkRasterStore()?.prune(new Set(pages.map((page) => page.pageId))).catch(() => undefined);
    }, 10_000);
    return () => window.clearTimeout(timer);
  }, [runtime]);

  useEffect(() => {
    const updateHash = () => setLocationHash(window.location.hash);
    window.addEventListener('hashchange', updateHash);
    return () => window.removeEventListener('hashchange', updateHash);
  }, []);

  const leaveFullPageView = useCallback(() => {
    if (!fullPageRef.current) return;
    fullPageRef.current = false;
    setFullPage(false);
    setFullPageNavOpen(false);
    setSwitcherRequested(false);
    setRibbonTab(tabBeforeFullPageRef.current);
  }, []);

  const enterFullPage = useCallback(() => {
    if (fullPageRef.current) return;
    fullPageRef.current = true;
    tabBeforeFullPageRef.current = ribbonTab;
    setRibbonTab('draw');
    setFullPageToolsOpen(true);
    setFullPage(true);
    // The page view works without window fullscreen (iPad Safari has none).
    void setAppFullscreen(true).catch(() => undefined);
  }, [ribbonTab]);

  const exitFullPage = useCallback(() => {
    leaveFullPageView();
    void setAppFullscreen(false).catch(() => undefined);
  }, [leaveFullPageView]);

  const toggleFullscreen = useCallback(() => {
    if (fullPageRef.current) exitFullPage();
    else enterFullPage();
  }, [enterFullPage, exitFullPage]);

  useEffect(() => {
    // The browser leaves fullscreen on Escape by itself; the page view follows.
    const followBrowserFullscreen = () => {
      if (!document.fullscreenElement) leaveFullPageView();
    };
    document.addEventListener('fullscreenchange', followBrowserFullscreen);
    return () => document.removeEventListener('fullscreenchange', followBrowserFullscreen);
  }, [leaveFullPageView]);

  useEffect(() => {
    if (!fullPage) return;
    // Escape leaves the page view unless something closer used it (a menu,
    // a selection on the canvas) or the focus is in text.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable
        || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return;
      // The navigation panel closes first; a second Escape leaves the view.
      if (fullPageNavOpen) {
        event.preventDefault();
        closeFullPageNav();
        return;
      }
      exitFullPage();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [closeFullPageNav, exitFullPage, fullPage, fullPageNavOpen]);

  // The active page's content is not part of the workspace state (which
  // holds page summaries only); a revision counter re-reads the active
  // context after each change of the page.
  const [activePageRevision, setActivePageRevision] = useState(0);
  const replacePage = useCallback((page: LivePageDocV2) => {
    void page;
    setActivePageRevision((revision) => revision + 1);
  }, []);

  // Titles, tags and locations of every page, notebooks and navigation come
  // from the runtime state, which the runtime republishes when they change
  // (also for changes that arrive through sync for pages that are not open).
  useEffect(() => {
    if (!runtime) return;
    return runtime.subscribeToState((state) => {
      if (state.schemaVersion === 2 || state.schemaVersion === 3) setWorkspaceOverride(state);
    });
  }, [runtime]);

  useEffect(() => {
    if (!runtime) return;
    return runtime.subscribeToListenerFailures(() => {
      setSaveState('error');
      setSaveError(t('workspace.error.listener'));
    });
  }, [runtime, t]);

  useEffect(() => {
    if (!runtime || !activePageId || viewerMode) return;
    let cancelled = false;
    void runtime.preparePageWrite(activePageId).then((session) => {
      if (cancelled) return;
      const ready = runtime.getState();
      if (ready.schemaVersion === 1) throw new Error('Schema-v3 editor authority is unavailable.');
      setWorkspaceOverride(ready);
      setPageWriteSession(session);
      const queued = queuedPageChangesRef.current.filter((entry) => entry.pageId === session.pageId);
      queuedPageChangesRef.current = [];
      if (queued.length === 0) return;
      try {
        let page: LivePageDocV2 | null = null;
        for (const entry of queued) page = session.change({ message: entry.message }, entry.change);
        if (page) replacePage(page);
        scheduleFlush();
      } catch (error) {
        setSaveState('error');
        setSaveError(messageFromError(error, t('workspace.error.pageChange')));
      }
    }).catch((error: unknown) => {
      if (cancelled) return;
      setPageWriteFailedFor(activePageId);
      setSaveState('error');
      setSaveError(messageFromError(error, t('workspace.error.pageChange')));
    });
    return () => { cancelled = true; };
  }, [activePageId, replacePage, runtime, scheduleFlush, t, viewerMode, workspace?.activation.artifactFingerprint]);

  useEffect(() => {
    if (!runtime || !activePageId) return;
    const unsubscribe = runtime.subscribeToPageChanges(activePageId, (page) => {
      replacePage(page);
      scheduleFlush();
    });
    return unsubscribe;
  }, [activePageId, replacePage, runtime, scheduleFlush, workspace?.activation.artifactFingerprint]);

  useEffect(() => {
    saveV2UiState(safeLocalStorage(), uiState);
  }, [uiState]);

  // Whatever makes a page active (a click, a new notebook or page, a move, a
  // restore) becomes the page this device returns to at the next start and
  // when switching back to its notebook. Clicks are remembered earlier, in
  // navigate; this covers every other way.
  const shownNotebookId = workspace?.active.notebookId;
  const shownPageId = workspace?.active.pageId;
  const shownSectionId = workspace?.active.sectionId;
  // A section reopens at the page last open there, also for Ctrl+Tab and
  // while the navigation panel is hidden (full page view).
  const [lastPageBySection] = useState(() => new Map<string, string>());
  // Where keyboard navigation continues from: the page a navigation is
  // heading to, which is ahead of the shown page while that loads. Reading
  // the shown page instead made a quick second Ctrl+Tab start from the old
  // section.
  const navigationsInFlightRef = useRef(0);
  const navigationSequenceRef = useRef(0);
  const navigationTargetRef = useRef<{ notebookId: string; sectionId: string; pageId: string } | null>(null);
  useEffect(() => {
    if (!shownSectionId || !shownPageId) return;
    lastPageBySection.set(shownSectionId, shownPageId);
    if (shownNotebookId && navigationsInFlightRef.current === 0) navigationTargetRef.current = { notebookId: shownNotebookId, sectionId: shownSectionId, pageId: shownPageId };
  }, [lastPageBySection, shownNotebookId, shownSectionId, shownPageId]);
  const shownNotebookRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!shownNotebookId || !shownPageId) return;
    const fromNotebookId = shownNotebookRef.current;
    shownNotebookRef.current = shownNotebookId;
    setUiState((current) => (
      current.recentPageIds[0] === shownPageId && current.lastPageByNotebook?.[shownNotebookId] === shownPageId
        ? current
        : rememberNavigation(current, fromNotebookId, { notebookId: shownNotebookId, pageId: shownPageId })
    ));
  }, [shownNotebookId, shownPageId]);

  const commitPage = useCallback((message: string, change: ChangeFn<LivePageDocV2>): boolean => {
    if (!runtime || !activePageId) return false;
    if (viewerMode) {
      setNotice(t('workspace.viewer.readOnly'));
      return false;
    }
    if (!activePageWriteSession) {
      if (!shownPageWriteSession) return false;
      // The previous session still writes unless the activation moved on
      // under it; then the change waits for the new session.
      try {
        replacePage(shownPageWriteSession.change({ message }, change));
        scheduleFlush();
      } catch {
        queuedPageChangesRef.current.push({ pageId: activePageId, message, change });
      }
      return true;
    }
    try {
      const page = activePageWriteSession.change({ message }, change);
      replacePage(page);
      scheduleFlush();
      return true;
    } catch (error) {
      setSaveState('error');
      setSaveError(messageFromError(error, t('workspace.error.pageChange')));
      return false;
    }
  }, [activePageId, activePageWriteSession, replacePage, runtime, scheduleFlush, shownPageWriteSession, t, viewerMode]);
  const writeRichText = useCallback((
    change: ChangeFn<LivePageDocV2>,
    options: { message: string },
  ): boolean => commitPage(options.message, change), [commitPage]);

  const commitTopology = useCallback(async (
    request: Omit<WorkspaceGraphRevisionRequest, 'expectedActivationArtifactFingerprint'>,
  ): Promise<V2RuntimeState | null> => {
    if (!runtime || !workspace) return null;
    // A reader may still reorganise their own workspace (create, move, leave a notebook); a change to
    // a document of a read-only notebook is refused by the runtime itself.
    if (teamViewerMode) {
      setNotice(t('workspace.viewer.readOnly'));
      return null;
    }
    setSaveState('saving');
    setSaveError(null);
    writesInFlightRef.current += 1;
    try {
      const ready = await runtime.ensureSchemaV3();
      setWorkspaceOverride(ready);
      const next = await runtime.commitWorkspaceGraphRevision({
        ...request,
        expectedActivationArtifactFingerprint: ready.activation.artifactFingerprint,
      });
      setWorkspaceOverride(next);
      writesInFlightRef.current -= 1;
      markSavedWhenIdle();
      return next;
    } catch (error) {
      writesInFlightRef.current -= 1;
      const message = messageFromError(error, t('workspace.error.topologyChange'));
      setSaveState('error');
      setSaveError(message);
      return null;
    }
  }, [markSavedWhenIdle, runtime, t, teamViewerMode, workspace]);
  const reportTopologyError = useCallback((error: unknown) => {
    setSaveState('error');
    setSaveError(messageFromError(error, t('workspace.error.topologyChange')));
  }, [t]);
  // A picture that cannot be shown does not mean the notebook failed to save.
  const reportAssetError = useCallback((message: string) => {
    setNotice(message);
  }, []);

  const activeContext = useMemo(() => {
    if (!runtime || !workspace) return null;
    void activePageRevision;
    try {
      return runtime.getActiveContext();
    } catch {
      return null;
    }
  }, [activePageRevision, runtime, workspace]);
  // New text boxes start with the notebook's text style (Notizbuch-Einstellungen).
  const notebookNewPage = resolveNotebookSettings(activeContext?.notebook.settings).newPage;
  const newTextSize = notebookNewPage.textSize;
  const newTextColor = notebookNewPage.textColor;
  const newTextStyle = useMemo(() => ({ fontSize: newTextSize, color: newTextColor }), [newTextColor, newTextSize]);
  // The math libraries are about 3.5 MB and only a page with a formula or a
  // graph (or a session with the Math Canvas on) needs them: the editor
  // mounts once they are loaded, and every other page never loads them.
  const activePageNeedsMath = mathFeaturesEnabled
    || (activeContext !== null && holdsMathElements(activeContext.page.elementsById));
  const [mathRuntimeLoaded, setMathRuntimeLoaded] = useState(isMathRuntimeLoaded);
  useEffect(() => {
    if (!activePageNeedsMath || mathRuntimeLoaded) return;
    let cancelled = false;
    loadMathRuntime().then(
      () => { if (!cancelled) setMathRuntimeLoaded(true); },
      () => { if (!cancelled) setNotice(t('workspace.error.mathRuntime')); },
    );
    return () => { cancelled = true; };
  }, [activePageNeedsMath, mathRuntimeLoaded, t]);
  const mathRuntimeReady = mathRuntimeLoaded || !activePageNeedsMath;
  const collabSyncUrl = (import.meta.env.VITE_COLLAB_SYNC_URL as string | undefined) || undefined;
  // In e2e builds `ClerkGate` provides the test identity through the same context.
  const spaceAuth = useOptionalAuth();
  const accountGetToken = spaceAuth.available ? spaceAuth.getToken : undefined;
  const collabGateway = useMemo(
    () => (collabSyncUrl ? createRealCollabGateway({
      syncUrl: collabSyncUrl,
      getRuntime: () => runtime,
      // An admin who joined a notebook manages its sharing with the account.
      getAccountToken: () => accountGetToken?.() ?? Promise.resolve(null),
      onRoomCreated: () => setOwnerRoomsTick((tick) => tick + 1),
      onRoomRemoved: () => setOwnerRoomsTick((tick) => tick + 1),
    }) : null),
    [accountGetToken, collabSyncUrl, runtime],
  );
  const sharingAvailable = Boolean(collabGateway) && Boolean(collabSyncUrl);

  // Personal space (services/collab-sync/PERSONAL-SYNC.md). Gated on all three env vars
  // (§8.2): absent any one of them, `personalSpaceEnabled` is false and the hook below
  // short-circuits to `{ kind: 'disabled' }` without ever opening a socket.
  const personalSpaceEnabled = (import.meta.env.VITE_PERSONAL_SPACE as string | undefined) === '1';

  // Live presence in shared notebooks: who else is here, on which page,
  // their pointer, live ink and work region (src/collab/presence.ts).
  const presenceUser = useLocalPresenceUser(spaceAuth, deviceId);
  const accountSignedIn = spaceAuth.available && spaceAuth.isSignedIn;
  const presenceHubs = useSharedNotebookSync({
    runtime,
    workspace,
    syncUrl: collabSyncUrl,
    bindTrigger: ownerRoomsTick,
    presenceUser,
    signedIn: accountSignedIn,
    getAccountToken: accountGetToken,
    onAccessLost: () => {
      setOwnerRoomsTick((tick) => tick + 1);
      setNotice(t('collab.notice.accessLost'));
    },
    onAdoptFailed: () => setNotice(t('collab.notice.pageNotAdopted')),
    onRoleChanged: (notebookId, role) => {
      const title = workspace?.notebooks.find((notebook) => notebook.notebookId === notebookId)?.title ?? '';
      setNotice(t(`collab.notice.role.${role}`, { title }));
    },
  });
  const activePresenceHub = activeContext ? presenceHubs.get(activeContext.notebook.notebookId) ?? null : null;
  const activePageDocId = activeContext?.page.documentId ?? null;
  usePresenceLifecycle(activePresenceHub, activePageDocId, presenceUser);
  const canvasPresence = useCanvasPresencePort(activePresenceHub, activePageDocId);
  const presenceRoster = usePresenceRoster(activePresenceHub);
  // Recomputed with the workspace (a page can be new), but kept as the same
  // object while nobody moved: every published title otherwise re-rendered the
  // presence dots of every row in the page list.
  const nextPagePresence = useMemo(
    () => peersByPageId(presenceRoster, (docId) => workspace?.pages.find((page) => page.documentId === docId)?.pageId),
    [presenceRoster, workspace],
  );
  const [pagePresence, setPagePresence] = useState(nextPagePresence);
  if (!samePagePresence(pagePresence, nextPagePresence)) setPagePresence(nextPagePresence);
  const [spaceStatus, setSpaceStatus] = useState<SpaceStatus>({ kind: 'disabled' });
  const [accountDialogTab, setAccountDialogTab] = useState<AccountTab | null>(null);
  useLegacyInkRebuild({
    runtime,
    workspace: workspace?.schemaVersion === 3 ? workspace : null,
    activePageId: activePageId ?? undefined,
    viewerMode,
    spaceStatus,
    recentPageIds: uiState.recentPageIds,
  });
  const linkChoice = useKeepLocalChoice(spaceAuth.available ? spaceAuth.user?.id : undefined);
  // The share rooms of the notebooks this device joined go into the account, so its other devices
  // connect them too; the account's own list comes back through `onSharedRooms`.
  const joinedRooms = useMemo(() => {
    void ownerRoomsTick;
    const joined = loadJoinedRooms();
    const owned = loadOwnerRooms();
    const rooms = new Map<string, string>();
    for (const notebook of workspace?.notebooks ?? []) {
      const record = joined[notebook.notebookId];
      if (record && !owned[notebook.notebookId]) rooms.set(notebook.documentId, record.roomId);
    }
    return rooms;
  }, [ownerRoomsTick, workspace]);
  const adoptAccountRooms = useCallback((rooms: ReadonlyMap<string, string>) => {
    let changed = false;
    for (const [documentId, roomId] of rooms) {
      const notebookId = documentId.replace(/^notebook:/, '');
      if (loadOwnerRooms()[notebookId] || loadJoinedRooms()[notebookId]?.roomId === roomId) continue;
      saveJoinedRoom(notebookId, { roomId });
      changed = true;
    }
    if (changed) setOwnerRoomsTick((tick) => tick + 1);
  }, []);
  const personalSpace = usePersonalSpaceSync({
    runtime,
    workspace,
    syncUrl: collabSyncUrl,
    auth: spaceAuth,
    enabled: personalSpaceEnabled,
    onWorkspaceReplaced: setWorkspaceOverride,
    onNotice: setNotice,
    onStatus: setSpaceStatus,
    sharedRooms: joinedRooms,
    onSharedRooms: adoptAccountRooms,
  });

  // The update restart replaces the app: queued ink and storage are written first and a sync is
  // started; whatever it does not push stays in the local outbox for the next start.
  const updateFlushRef = useRef<() => Promise<void>>(() => Promise.resolve());
  useEffect(() => {
    updateFlushRef.current = async () => {
      try {
        if (runtime) await flushForLeaving(runtime);
      } finally {
        personalSpace.syncNow();
      }
    };
  });
  const flushBeforeUpdateRestart = useCallback(() => updateFlushRef.current(), []);
  // Desktop app: the Worker refuses the sync socket of a device that was
  // signed out on the web. Refreshing the device credential finds that out
  // and signs the app out, instead of leaving it in a sync error.
  const spaceErrorMessage = spaceStatus.kind === 'error' ? spaceStatus.message : null;
  const desktopRecheck = spaceAuth.available ? spaceAuth.desktop?.recheck : undefined;
  useEffect(() => {
    if (spaceErrorMessage !== null) desktopRecheck?.();
  }, [spaceErrorMessage, desktopRecheck]);
  // §5.7: once personal space is enabled, an asset an adopted page references but this device
  // does not have yet must be lazily fetched (`personalSpaceAssetRepository`'s own doc comment) —
  // `runtimeAssetRepository` alone (used for the sharing-only / no-personal-space case) has no
  // such fallback and would leave the `<img>` permanently unresolved.
  const assetRepository = useMemo(
    () => runtime
      ? (personalSpaceEnabled
        ? personalSpaceAssetRepository(runtime, { requestAsset: personalSpace.requestAsset })
        : runtimeAssetRepository(runtime))
      : null,
    [runtime, personalSpaceEnabled, personalSpace.requestAsset],
  );

  const renderAssetElement = useCallback((element: Parameters<typeof AssetElementPreview>[0]['element']) => (
    assetRepository ? (
      <AssetElementPreview element={element} repository={assetRepository} onError={reportAssetError} />
    ) : null
  ), [assetRepository, reportAssetError]);

  // The pen's screen clip: the canvas hands over its elements (held ink
  // included) and gets a PNG back; inserting goes through the asset controls.
  const insertClipRef = useRef<((png: Blob) => Promise<void>) | null>(null);
  const activePageForClip = activeContext?.page;
  const renderRegionImage = useCallback(async (
    elements: Parameters<typeof renderPortableRegionPng>[0]['elementsById'],
    elementIds: readonly string[],
    region: Parameters<typeof renderPortableRegionPng>[3],
  ) => {
    if (!assetRepository || !activePageForClip) throw new Error('No page is open.');
    const { png } = await renderPortableRegionPng(
      { page: activePageForClip, elementsById: { ...elements }, width: region.width, height: region.height },
      assetRepository,
      elementIds,
      region,
    );
    return new Blob([Uint8Array.from(png)], { type: 'image/png' });
  }, [activePageForClip, assetRepository]);
  const insertRegionImage = useCallback(
    (png: Blob) => insertClipRef.current?.(png),
    [],
  );

  const visibleNotebooks = useMemo(() => {
    if (!workspace) return [];
    const trashedNotebookIds = new Set(workspace.activation.manifest.trash.flatMap(
      (entry) => entry.kind === 'notebook' && entry.notebookDocumentId
        ? [entry.notebookDocumentId]
        : [],
    ));
    const notebooksByDocumentId = new Map(
      workspace.notebooks.map((notebook) => [notebook.documentId, notebook]),
    );
    return workspace.activation.manifest.notebookDocumentIds
      .map((documentId) => notebooksByDocumentId.get(documentId))
      .filter((notebook): notebook is LiveNotebookDocV2 => (
        notebook !== undefined && !trashedNotebookIds.has(notebook.documentId)
      ));
  }, [workspace]);
  // Keeps the projected page and section objects of what a change did not touch.
  const notebookProjector = useMemo(() => createNotebookProjector(), []);
  const liveNotebooks = useMemo(
    () => workspace ? notebookProjector(visibleNotebooks, workspace.pages) : [],
    [notebookProjector, visibleNotebooks, workspace],
  );
  // The lists behind the navigation, the notebook switcher and the page menu.
  // They walk every page, and the shell renders on each keystroke and click.
  const navigationLists = useMemo(() => {
    if (!workspace || !activeContext) return null;
    const pinnedPageIds = new Set(workspace.pages.filter(isPinnedPage).map((page) => page.pageId));
    return {
      pinnedPageIds,
      quickAccess: quickAccessEntries(liveNotebooks, pinnedPageIds),
      templatePages: workspace.pages
        .filter(isTemplatePage)
        .map((page) => ({ pageId: page.pageId, title: page.title, sectionId: page.sectionId })),
    };
  }, [activeContext, liveNotebooks, workspace]);
  const navigate = useCallback((notebookId: string, sectionId: string, pageId: string) => {
    if (!runtime) return;
    navigationTargetRef.current = { notebookId, sectionId, pageId };
    navigationsInFlightRef.current += 1;
    const sequence = ++navigationSequenceRef.current;
    const startedAt = performance.now();
    // Where the focus was when the navigation started; see the focus below.
    const focusOrigin = document.activeElement;
    const before = runtime.getState();
    const fromNotebookId = before.schemaVersion === 1 ? undefined : before.active.notebookId;
    // A page that is not in memory loads first; a newer navigation that
    // finishes earlier wins (the runtime keeps the latest target). Loading
    // a page is one Automerge call that holds the main thread (about two
    // seconds for 7,000 strokes), so its title and a loading state are
    // painted before it starts.
    const needsLoad = !runtime.isPageLoaded(pageId);
    if (needsLoad) setPendingPage({ notebookId, sectionId, pageId, title: runtime.getPageSummary(pageId)?.title ?? '' });
    // Remembered at once, not after loading: a reload while a heavy page
    // loads returns to that page (the next start opens it; see
    // lastViewedPageId). A page that is gone by then is skipped at startup.
    // A page in memory opens within the same task, so it is remembered with
    // the navigation itself and the shell renders once, not twice.
    const remember = () => setUiState((current) => rememberNavigation(current, fromNotebookId, { notebookId, pageId }));
    if (needsLoad) remember();
    // The page's stored ink picture is shown before its document loads.
    inkRasterTargetRef.current = pageId;
    const rasterShown = needsLoad
      ? loadInkRaster(pageId, INK_RASTER_WAIT_MS).then((raster) => {
        if (!raster) return;
        if (inkRasterTargetRef.current !== pageId || inkPainted(pageId)) raster.bitmap.close();
        else setInkRaster(raster);
      })
      : Promise.resolve();
    const painted = needsLoad
      ? rasterShown.then(() => new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0))))
      : Promise.resolve();
    // A newer navigation that started meanwhile (a quick second key press
    // while this page still loads) wins; opening this one afterwards would
    // undo it.
    void painted.then(() => sequence === navigationSequenceRef.current
      ? runtime.navigateTo({ notebookId, sectionId, pageId })
      : undefined).then(() => {
      if (sequence !== navigationSequenceRef.current) return;
      const next = runtime.getState();
      if (next.schemaVersion !== 2 && next.schemaVersion !== 3) throw new Error(t('workspace.error.navigationSchema'));
      if (!needsLoad) remember();
      setWorkspaceOverride(next);
      if (next.active.pageId !== pageId) return;
      requestAnimationFrame(() => {
        // The title takes the focus the navigation was started with. Focus
        // that the person moved elsewhere meanwhile (a rename started by a
        // double click, a keystroke to another row while a page loads) stays.
        const active = document.activeElement;
        const focusMoved = active !== null && active !== document.body && active !== focusOrigin;
        if (!focusMoved) titleRef.current?.focus();
        recordCachedNavigation(performanceRecorder, startedAt, () => performance.now());
      });
    }).catch((error: unknown) => {
      setNotice(error instanceof PageNotDownloadedError
        ? t('workspace.error.pageNotDownloaded')
        : messageFromError(error, t('workspace.error.navigation')));
    }).finally(() => {
      navigationsInFlightRef.current -= 1;
      if (navigationsInFlightRef.current === 0) {
        const settled = runtime.getState();
        if (settled.schemaVersion !== 1) navigationTargetRef.current = settled.active;
      }
      if (needsLoad) setPendingPage((current) => (current?.pageId === pageId ? null : current));
    });
  }, [performanceRecorder, runtime, t]);

  // Presence: the page behind a person's face (round preview) and a jump to it.
  const loadPresenceContent = useCallback(
    (documentId: string) => runtime
      ? loadPreviewContent(
        documentId,
        (id, reader) => runtime.readDocument(id, reader),
        (assetId) => runtime.getAsset(assetId as Sha256Checksum),
      )
      : Promise.reject(new Error('The workspace is not open.')),
    [runtime],
  );
  const openPresencePage = useCallback((documentId: string) => {
    const page = workspace?.pages.find((candidate) => candidate.documentId === documentId);
    if (page) navigate(page.notebookId, page.sectionId, page.pageId);
  }, [navigate, workspace]);

  // Switching notebooks returns to the page last open there (OneNote keeps
  // each notebook where you left it); otherwise the first page opens.
  const navigateNotebook = useCallback((notebookId: string) => {
    const notebook = workspace?.notebooks.find((candidate) => candidate.notebookId === notebookId);
    if (!notebook || !workspace) return;
    const rememberedPageId = uiState.lastPageByNotebook?.[notebookId];
    const remembered = rememberedPageId
      ? workspace.pages.find((candidate) => candidate.pageId === rememberedPageId)
      : undefined;
    const rememberedSection = remembered
      ? notebook.sections.find((section) => section.pageDocumentIds.includes(remembered.documentId))
      : undefined;
    if (remembered && rememberedSection) {
      navigate(notebookId, rememberedSection.id, remembered.pageId);
      return;
    }
    const section = notebook.sections.find((candidate) => candidate.pageDocumentIds.length > 0);
    const pageDocumentId = section?.pageDocumentIds[0];
    const page = workspace.pages.find((candidate) => candidate.documentId === pageDocumentId);
    if (section && page) navigate(notebookId, section.id, page.pageId);
  }, [navigate, uiState.lastPageByNotebook, workspace]);

  // A share link adds the shared notebook to this workspace and opens it like any other
  // notebook; the dialog only covers signing in and the short wait while it is added.
  const openJoinedNotebook = useCallback((notebookId: string, added: boolean) => {
    if (!runtime) return;
    const next = runtime.getState();
    if (next.schemaVersion === 1) return;
    if (added) setOwnerRoomsTick((tick) => tick + 1);
    setWorkspaceOverride(next);
    const notebook = next.notebooks.find((candidate) => candidate.notebookId === notebookId);
    if (!notebook) return;
    const rememberedPageId = uiState.lastPageByNotebook?.[notebookId];
    const remembered = rememberedPageId ? next.pages.find((candidate) => candidate.pageId === rememberedPageId) : undefined;
    const rememberedSection = remembered
      ? notebook.sections.find((section) => section.pageDocumentIds.includes(remembered.documentId))
      : undefined;
    if (remembered && rememberedSection) {
      navigate(notebookId, rememberedSection.id, remembered.pageId);
      return;
    }
    const section = notebook.sections.find((candidate) => candidate.pageDocumentIds.length > 0);
    const first = next.pages.find((candidate) => candidate.documentId === section?.pageDocumentIds[0]);
    if (section && first) navigate(notebookId, section.id, first.pageId);
  }, [navigate, runtime, uiState.lastPageByNotebook]);
  const finishJoinLink = useCallback(() => {
    // The fragment is the link; the query (a test identity, the OneNote callback) stays as it is.
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}`);
    setLocationHash('');
  }, []);
  const spaceSettled = !personalSpaceEnabled
    || !accountSignedIn
    || !['disabled', 'signed-out', 'link-required', 'bootstrapping'].includes(spaceStatus.kind);
  const joinLink = useJoinLink({
    hash: locationHash,
    runtime,
    workspace,
    syncUrl: collabSyncUrl,
    gateway: collabGateway,
    auth: spaceAuth,
    accountReady: spaceSettled,
    onJoined: openJoinedNotebook,
    onFinished: finishJoinLink,
  });
  // Notebooks shared with this account by e-mail address ("Mit dir geteilt" in the notebook switcher).
  const invitations = useInvitations({
    runtime,
    workspace,
    syncUrl: collabSyncUrl,
    auth: spaceAuth,
    accountReady: spaceSettled,
    onJoined: openJoinedNotebook,
    onFailed: () => setNotice(t('collab.invites.error')),
  });
  // Which notebooks of this workspace are shared, with the role this account has in each.
  const sharedNotebooks = notebookAccess.roles;

  // Ctrl+PgUp/PgDn step through the pages of the section (as in OneNote),
  // Ctrl+(Shift+)Tab through its notebook's sections in navigation order.
  // Ctrl+G opens the notebook switcher; in the full page view, where the
  // title bar is hidden, it opens the navigation panel with the switcher.
  useEffect(() => {
    if (!activeContext) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const from = navigationTargetRef.current ?? {
        notebookId: activeContext.notebook.notebookId,
        sectionId: activeContext.section.id,
        pageId: activeContext.page.pageId,
      };
      const notebook = liveNotebooks.find((candidate) => candidate.id === from.notebookId);
      const section = notebook?.sections.find((candidate) => candidate.id === from.sectionId);
      if (!notebook || !section) return;
      if (event.defaultPrevented || event.altKey || !(event.ctrlKey || event.metaKey)) return;
      if (fullPage && !fullPageNavOpen && isSwitcherShortcut(event)) {
        event.preventDefault();
        setSwitcherRequested(true);
        setFullPageNavOpen(true);
        return;
      }
      if (event.key === 'PageUp' || event.key === 'PageDown') {
        if (event.shiftKey) return;
        const index = section.pages.findIndex((page) => page.id === from.pageId);
        const target = section.pages[index + (event.key === 'PageDown' ? 1 : -1)];
        event.preventDefault();
        if (index >= 0 && target) navigate(notebook.id, section.id, target.id);
      } else if (event.key === 'Tab') {
        const sections = sectionsInDisplayOrder(buildSectionTree(notebook.sections, notebook.sectionGroups ?? []))
          .filter((candidate) => candidate.pages.length > 0 || candidate.id === section.id);
        const index = sections.findIndex((candidate) => candidate.id === section.id);
        const target = sections[(index + (event.shiftKey ? -1 : 1) + sections.length) % sections.length];
        event.preventDefault();
        const remembered = target ? lastPageBySection.get(target.id) : undefined;
        const page = target?.pages.find((candidate) => candidate.id === remembered)
          ?? target?.pages.find((candidate) => !candidate.parentPageId)
          ?? target?.pages[0];
        if (target && target.id !== section.id && page) navigate(notebook.id, target.id, page.id);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeContext, fullPage, fullPageNavOpen, lastPageBySection, liveNotebooks, navigate]);

  const openImportedNotebook = useCallback((result: { pageDocumentIds: string[] }) => {
    if (!runtime) return;
    const next = runtime.getState();
    if (next.schemaVersion !== 2 && next.schemaVersion !== 3) return;
    setWorkspaceOverride(next);
    const firstPage = next.pages.find((page) => result.pageDocumentIds.includes(page.documentId));
    if (firstPage) navigate(firstPage.notebookId, firstPage.sectionId, firstPage.pageId);
  }, [navigate, runtime]);

  const addNotebook = useCallback(() => {
    if (!workspace) return;
    const now = new Date().toISOString();
    const notebookId = createLocalId('notebook');
    const sectionId = createLocalId('section');
    const pageId = createLocalId('page');
    const page = newPageProjection({ notebookId, sectionId, pageId, title: t('workspace.page.untitled'), now });
    const notebook: NotebookDocV3 = {
      schemaVersion: 3,
      documentId: `notebook:${notebookId}`,
      kind: 'notebook',
      notebookId,
      title: t('workspace.notebook.new'),
      color: '#4f7c6d',
      createdAt: now,
      updatedAt: now,
      sections: [{
        id: sectionId,
        title: t('workspace.section.new'),
        createdAt: now,
        updatedAt: now,
        pageDocumentIds: [page.documentId],
      }],
      settings: { defaultPageType: 'a4' },
      version: { protocol: 'uninitialized', heads: [] },
    };
    void commitTopology({
      operationId: createLocalId('create-notebook'),
      message: t('workspace.operation.createNotebook'),
      newDocuments: [notebook, page],
      updateManifest: (manifest) => {
        manifest.notebookDocumentIds.push(notebook.documentId);
        manifest.pageDocumentIds.push(page.documentId);
      },
    }).then((next) => {
      if (next) navigate(notebookId, sectionId, pageId);
    });
  }, [commitTopology, navigate, t, workspace]);

  // Names arrive from the inline rename fields, already trimmed and non-empty.
  const renameNotebook = useCallback((notebookId: string, title: string) => {
    const notebook = workspace?.notebooks.find((candidate) => candidate.notebookId === notebookId);
    if (!notebook || title === notebook.title) return;
    const updatedAt = new Date().toISOString();
    void commitTopology({
      operationId: createLocalId('rename-notebook'),
      message: t('workspace.operation.renameNotebook'),
      changes: [{
        documentId: notebook.documentId,
        change: (document) => {
          if (document.kind !== 'notebook') return;
          document.title = title;
          document.updatedAt = updatedAt;
        },
      }],
    });
  }, [commitTopology, t, workspace]);

  const updateNotebookSettings = useCallback((notebookId: string, patch: NotebookSettingsPatch) => {
    const notebook = workspace?.notebooks.find((candidate) => candidate.notebookId === notebookId);
    if (!notebook) return;
    const updatedAt = new Date().toISOString();
    void commitTopology({
      operationId: createLocalId('notebook-settings'),
      message: t('nbSettings.operation.settings'),
      changes: [{
        documentId: notebook.documentId,
        change: (document) => {
          if (document.kind !== 'notebook') return;
          if (applyNotebookSettingsPatch(document.settings, patch)) document.updatedAt = updatedAt;
        },
      }],
    });
  }, [commitTopology, t, workspace]);

  const setNotebookColor = useCallback((notebookId: string, color: string) => {
    const notebook = workspace?.notebooks.find((candidate) => candidate.notebookId === notebookId);
    if (!notebook || notebook.color === color) return;
    const updatedAt = new Date().toISOString();
    void commitTopology({
      operationId: createLocalId('notebook-color'),
      message: t('nbSettings.operation.color'),
      changes: [{
        documentId: notebook.documentId,
        change: (document) => {
          if (document.kind !== 'notebook') return;
          document.color = color;
          document.updatedAt = updatedAt;
        },
      }],
    });
  }, [commitTopology, t, workspace]);

  // "Auf alle Seiten anwenden": the paper and sheet of the notebook's new-page defaults go onto every
  // canvas page this device holds, in bounded commits so a long notebook never blocks the storage queue.
  const applyNotebookDefaultsToPages = useCallback(async (notebookId: string): Promise<ApplyDefaultsResult> => {
    const notebook = workspace?.notebooks.find((candidate) => candidate.notebookId === notebookId);
    if (!runtime || !workspace || !notebook) throw new Error(t('workspace.error.topologyChange'));
    const look = pageLookForDefaults(resolveNotebookSettings(notebook.settings).newPage);
    const updatedAt = new Date().toISOString();
    const canvasPages = workspace.pages.filter((page) => page.notebookId === notebookId && page.pageContentKind === 'canvas');
    const reachable = canvasPages.filter((page) => runtime.isDocumentAvailable(page.documentId));
    // A change function can run again when the commit is rebased, so a page counts once.
    const changedIds = new Set<string>();
    for (let start = 0; start < reachable.length; start += 20) {
      const next = await commitTopology({
        operationId: createLocalId('apply-notebook-defaults'),
        message: t('nbSettings.operation.applyDefaults'),
        changes: reachable.slice(start, start + 20).map((page) => ({
          documentId: page.documentId,
          change: (document) => {
            if (document.kind !== 'page') return;
            if (applyPageLook(document, look, updatedAt)) changedIds.add(page.documentId);
            else changedIds.delete(page.documentId);
          },
        })),
      });
      if (!next) throw new Error(t('nbSettings.applyAll.failed'));
    }
    return { changed: changedIds.size, total: canvasPages.length, skipped: canvasPages.length - reachable.length };
  }, [commitTopology, runtime, t, workspace]);

  const renameSection = useCallback((sectionId: string, title: string) => {
    if (!activeContext) return;
    const section = activeContext.notebook.sections.find((candidate) => candidate.id === sectionId);
    if (!section || title === section.title) return;
    const updatedAt = new Date().toISOString();
    void commitTopology({
      operationId: createLocalId('rename-section'),
      message: t('workspace.operation.renameSection'),
      changes: [{
        documentId: activeContext.notebook.documentId,
        change: (document) => {
          if (document.kind !== 'notebook') return;
          const draft = document.sections.find((candidate) => candidate.id === sectionId);
          if (!draft) return;
          draft.title = title;
          draft.updatedAt = updatedAt;
          document.updatedAt = updatedAt;
        },
      }],
    });
  }, [activeContext, commitTopology, t]);

  const renamePage = useCallback((sectionId: string, pageId: string, title: string) => {
    const page = workspace?.pages.find((candidate) => candidate.pageId === pageId);
    if (!page || page.sectionId !== sectionId || title === page.title) return;
    const updatedAt = new Date().toISOString();
    void commitTopology({
      operationId: createLocalId('rename-page'),
      message: t('workspace.operation.renamePage'),
      changes: [{
        documentId: page.documentId,
        change: (document) => {
          if (document.kind !== 'page') return;
          document.title = title;
          document.updatedAt = updatedAt;
        },
      }],
    });
  }, [commitTopology, t, workspace]);

  const addSection = useCallback((groupId?: string) => {
    if (!activeContext) return;
    const sectionId = createLocalId('section');
    const pageId = createLocalId('page');
    const timestamp = new Date().toISOString();
    const page = newPageProjection({
      notebookId: activeContext.notebook.notebookId,
      sectionId,
      pageId,
      title: t('workspace.page.untitled'),
      defaults: resolveNotebookSettings(activeContext.notebook.settings).newPage,
      now: timestamp,
    });
    void commitTopology({
      operationId: createLocalId('create-section'),
      message: t('workspace.operation.createSection'),
      newDocuments: [page],
      changes: [{
        documentId: activeContext.notebook.documentId,
        change: (document) => {
          if (document.kind !== 'notebook') return;
          document.sections.push({
            id: sectionId,
            title: t('workspace.section.new'),
            ...(groupId && document.sectionGroups?.some((group) => group.id === groupId) ? { groupId } : {}),
            createdAt: timestamp,
            updatedAt: timestamp,
            pageDocumentIds: [page.documentId],
          });
          document.updatedAt = timestamp;
        },
      }],
      updateManifest: (manifest) => {
        manifest.pageDocumentIds.push(page.documentId);
        manifest.active = {
          notebookId: page.notebookId,
          sectionId,
          pageId,
        };
      },
    }).then((next) => {
      if (next) navigate(page.notebookId, sectionId, pageId);
    });
  }, [activeContext, commitTopology, navigate, t]);

  /**
   * Section groups are OneNote's folders for sections. They live in the
   * notebook document next to the sections (see NotebookSectionGroupRef),
   * so every group change is one notebook-document change.
   */
  const addSectionGroup = useCallback((parentGroupId?: string): string | undefined => {
    if (!activeContext || viewerMode) return undefined;
    const title = t('workspace.sectionGroup.new');
    const groupId = createLocalId('section-group');
    const timestamp = new Date().toISOString();
    void commitTopology({
      operationId: createLocalId('create-section-group'),
      message: t('workspace.operation.createSectionGroup'),
      changes: [{
        documentId: activeContext.notebook.documentId,
        change: (document) => {
          if (document.kind !== 'notebook') return;
          const parentExists = Boolean(parentGroupId && document.sectionGroups?.some((group) => group.id === parentGroupId));
          const group = {
            id: groupId,
            title,
            ...(parentExists && parentGroupId ? { parentGroupId } : {}),
            createdAt: timestamp,
            updatedAt: timestamp,
          };
          if (!document.sectionGroups) document.sectionGroups = [group];
          else document.sectionGroups.splice(groupInsertionIndex(document.sectionGroups, group.parentGroupId), 0, group);
          document.updatedAt = timestamp;
        },
      }],
    });
    return groupId;
  }, [activeContext, commitTopology, t, viewerMode]);

  const renameSectionGroup = useCallback((groupId: string, title: string) => {
    if (!activeContext) return;
    const group = activeContext.notebook.sectionGroups?.find((candidate) => candidate.id === groupId);
    if (!group || title === group.title) return;
    const updatedAt = new Date().toISOString();
    void commitTopology({
      operationId: createLocalId('rename-section-group'),
      message: t('workspace.operation.renameSectionGroup'),
      changes: [{
        documentId: activeContext.notebook.documentId,
        change: (document) => {
          if (document.kind !== 'notebook') return;
          const draft = document.sectionGroups?.find((candidate) => candidate.id === groupId);
          if (!draft) return;
          draft.title = title;
          draft.updatedAt = updatedAt;
          document.updatedAt = updatedAt;
        },
      }],
    });
  }, [activeContext, commitTopology, t]);

  const transferSectionGroup = useCallback((request: SectionGroupTransferRequest) => {
    if (!activeContext || activeContext.notebook.notebookId !== request.notebookId) return;
    const groups = activeContext.notebook.sectionGroups ?? [];
    if (!groups.some((group) => group.id === request.groupId)) return;
    if (!canMoveGroupInto(groups, request.groupId, request.targetParentGroupId)) return;
    const updatedAt = new Date().toISOString();
    void commitTopology({
      operationId: createLocalId('move-section-group'),
      message: t('workspace.operation.moveSectionGroup'),
      changes: [{
        documentId: activeContext.notebook.documentId,
        change: (document) => {
          if (document.kind !== 'notebook' || !document.sectionGroups) return;
          const index = document.sectionGroups.findIndex((group) => group.id === request.groupId);
          if (index < 0) return;
          const moved = structuredClone(document.sectionGroups[index]);
          document.sectionGroups.splice(index, 1);
          const parent = request.targetParentGroupId
            && document.sectionGroups.some((group) => group.id === request.targetParentGroupId)
            ? request.targetParentGroupId
            : undefined;
          if (parent) moved.parentGroupId = parent;
          else delete moved.parentGroupId;
          moved.updatedAt = updatedAt;
          document.sectionGroups.splice(groupInsertionIndex(document.sectionGroups, parent, request.anchor), 0, moved);
          document.updatedAt = updatedAt;
        },
      }],
    });
  }, [activeContext, commitTopology, t]);

  const trashSectionGroup = useCallback(async (groupId: string) => {
    if (!activeContext || !workspace) return;
    const notebook = activeContext.notebook;
    const groups = notebook.sectionGroups ?? [];
    const group = groups.find((candidate) => candidate.id === groupId);
    if (!group) return;
    const removedGroupIds = groupSubtreeIds(groups, groupId);
    const removedSections = sectionsInGroup(notebook.sections, groups, groupId);
    const removedSectionIds = new Set(removedSections.map((section) => section.id));
    const fallbackSection = notebook.sections.find((candidate) => !removedSectionIds.has(candidate.id)
      && candidate.pageDocumentIds.length > 0);
    const fallbackPage = workspace.pages.find(
      (page) => fallbackSection?.pageDocumentIds.includes(page.documentId),
    );
    if (removedSections.length > 0) {
      if (!fallbackSection || !fallbackPage) return;
      const confirmed = await confirm({
        title: t('workspace.sectionGroup.deleteTitle'),
        message: plural(removedSections.length, {
          one: 'workspace.sectionGroup.deleteConfirm.one',
          other: 'workspace.sectionGroup.deleteConfirm.other',
        }, { title: group.title }),
        confirmLabel: t('menu.delete'),
        danger: true,
      });
      if (!confirmed) return;
    }
    const now = new Date().toISOString();
    // Each section goes to the trash on its own, as when it is deleted
    // directly, so it can be restored; a restored section whose group is
    // gone returns to the top level.
    const entries: TrashRecordV2[] = removedSections.map((section) => ({
      id: createLocalId('trash'),
      kind: 'section',
      deletedAt: now,
      origin: { notebookId: notebook.notebookId },
      section: structuredClone(section),
    }));
    void commitTopology({
      operationId: createLocalId('trash-section-group'),
      message: t('workspace.operation.trashSectionGroup'),
      changes: [{
        documentId: notebook.documentId,
        change: (document) => {
          if (document.kind !== 'notebook') return;
          for (let index = document.sections.length - 1; index >= 0; index -= 1) {
            if (removedSectionIds.has(document.sections[index].id)) document.sections.splice(index, 1);
          }
          if (document.sectionGroups) {
            for (let index = document.sectionGroups.length - 1; index >= 0; index -= 1) {
              if (removedGroupIds.has(document.sectionGroups[index].id)) document.sectionGroups.splice(index, 1);
            }
            if (document.sectionGroups.length === 0) delete document.sectionGroups;
          }
          document.updatedAt = now;
        },
      }],
      updateManifest: (manifest) => {
        manifest.trash.push(...entries);
        if (removedSectionIds.has(manifest.active.sectionId) && fallbackSection && fallbackPage) {
          manifest.active = {
            notebookId: notebook.notebookId,
            sectionId: fallbackSection.id,
            pageId: fallbackPage.pageId,
          };
        }
      },
    });
  }, [activeContext, commitTopology, confirm, plural, t, workspace]);

  const transferNotebook = useCallback((request: NotebookTransferRequest) => {
    if (!runtime || !workspace || teamViewerMode) return;
    const source = workspace.notebooks.find(
      (notebook) => notebook.notebookId === request.notebookId,
    );
    const target = workspace.notebooks.find(
      (notebook) => notebook.notebookId === request.targetNotebookId,
    );
    if (!source || !target) return;

    if (!request.copy) {
      if (source.documentId === target.documentId) return;
      void commitTopology({
        operationId: createLocalId('reorder-notebook'),
        message: t('workspace.operation.reorderNotebook'),
        updateManifest: (manifest) => {
          manifest.notebookDocumentIds = moveIdByPlacement(
            manifest.notebookDocumentIds,
            source.documentId,
            target.documentId,
            request.placement,
          );
        },
      });
      return;
    }

    const now = new Date().toISOString();
    const notebookId = createLocalId('notebook');
    const sectionIdBySourceId = new Map(
      source.sections.map((section) => [section.id, createLocalId('section')]),
    );
    const sourcePageDocumentIds = new Set(
      source.sections.flatMap((section) => section.pageDocumentIds),
    );
    const sourcePages = source.sections.flatMap((section) => section.pageDocumentIds)
      .map((documentId) => workspace.pages.find((page) => page.documentId === documentId))
      .filter((page): page is PageSummary => Boolean(page));
    if (sourcePages.length !== sourcePageDocumentIds.size) {
      setNotice(t('workspace.error.transferDocuments'));
      return;
    }
    const pageRemap = createStablePageIdRemap(sourcePages, () => createLocalId('page'));
    const duplicateNotebook: NotebookDocV3 = {
      ...structuredClone(source),
      schemaVersion: 3,
      documentId: `notebook:${notebookId}`,
      notebookId,
      title: t('workspace.notebook.copySuffix', { title: source.title }),
      createdAt: now,
      updatedAt: now,
      sections: source.sections.map((section) => {
        const sectionId = sectionIdBySourceId.get(section.id);
        if (!sectionId) throw new Error(t('workspace.error.copyId'));
        return {
          ...structuredClone(section),
          id: sectionId,
          createdAt: now,
          updatedAt: now,
          pageDocumentIds: section.pageDocumentIds.map((documentId) => {
            const page = sourcePages.find((candidate) => candidate.documentId === documentId);
            const nextDocumentId = page
              ? pageRemap.documentIdBySourceId.get(page.pageId)
              : undefined;
            if (!nextDocumentId) throw new Error(t('workspace.error.copyId'));
            return nextDocumentId;
          }),
        };
      }),
      version: { protocol: 'uninitialized', heads: [] },
    };
    const firstSection = duplicateNotebook.sections.find((section) => section.pageDocumentIds.length > 0);
    const firstPageId = firstSection
      ? sourcePages.find((page) => pageRemap.documentIdBySourceId.get(page.pageId) === firstSection.pageDocumentIds[0])
      : undefined;
    // A notebook copy is written like an import: page by page, so copying a
    // large notebook needs memory for one page at a time.
    setSaveState('saving');
    void (async () => {
      const writer = await runtime.beginAdditiveImport({
        importId: createLocalId('copy-notebook'),
        preparedAt: now,
        notebook: duplicateNotebook,
      });
      try {
        for (const page of sourcePages) {
          const pageId = pageRemap.pageIdBySourceId.get(page.pageId);
          const sectionId = sectionIdBySourceId.get(page.sectionId);
          if (!pageId || !sectionId) throw new Error(t('workspace.error.copyId'));
          const duplicate = await duplicatePageProjection(runtime, page.pageId, pageId, now, page.title);
          duplicate.notebookId = notebookId;
          duplicate.sectionId = sectionId;
          const parentPageId = remappedParentPageId(page, pageRemap);
          if (parentPageId) duplicate.parentPageId = parentPageId;
          else delete duplicate.parentPageId;
          await writer.addPage(duplicate);
        }
        await writer.commit(await sha256Canonical({
          namespace: 'canvink-notebook-copy',
          sourceNotebookDocumentId: source.documentId,
          notebookDocumentId: duplicateNotebook.documentId,
        }));
      } catch (error) {
        await writer.abort().catch(() => undefined);
        throw error;
      }
      setSaveState('saved');
      const next = await commitTopology({
        operationId: createLocalId('place-notebook-copy'),
        message: t('workspace.operation.copyNotebook'),
        updateManifest: (manifest) => {
          manifest.notebookDocumentIds = moveIdByPlacement(
            manifest.notebookDocumentIds,
            duplicateNotebook.documentId,
            target.documentId,
            request.placement,
          );
        },
      });
      const firstCopyId = firstPageId ? pageRemap.pageIdBySourceId.get(firstPageId.pageId) : undefined;
      if (next && firstSection && firstCopyId) navigate(notebookId, firstSection.id, firstCopyId);
    })().catch((error: unknown) => {
      setSaveState('error');
      setSaveError(messageFromError(error, t('workspace.error.topologyChange')));
    });
  }, [commitTopology, navigate, runtime, t, teamViewerMode, workspace]);

  const transferSection = useCallback((request: SectionTransferRequest) => {
    if (!runtime || !workspace || viewerMode) return;
    const sourceNotebook = workspace.notebooks.find(
      (notebook) => notebook.notebookId === request.sourceNotebookId,
    );
    const targetNotebook = workspace.notebooks.find(
      (notebook) => notebook.notebookId === request.targetNotebookId,
    );
    const sourceSection = sourceNotebook?.sections.find(
      (section) => section.id === request.sectionId,
    );
    const targetSection = request.targetSectionId
      ? targetNotebook?.sections.find((section) => section.id === request.targetSectionId)
      : undefined;
    if (!sourceNotebook || !targetNotebook || !sourceSection) return;
    if (request.targetSectionId && !targetSection) {
      setNotice(t('workspace.error.targetSection'));
      return;
    }
    const sameNotebook = sourceNotebook.documentId === targetNotebook.documentId;
    if (!request.copy && !sameNotebook && sourceNotebook.sections.length === 1) {
      setNotice(t('workspace.error.lastSectionMove'));
      return;
    }
    if (!request.copy && sameNotebook && sourceSection.id === targetSection?.id) return;
    // Next to a section the moved section joins that section's group;
    // "inside" names the group (or the top level) directly. Groups belong to
    // one notebook, so an id from elsewhere means the top level.
    const targetGroups = targetNotebook.sectionGroups ?? [];
    const requestedGroupId = targetSection ? targetSection.groupId : request.targetGroupId;
    const targetGroupId = requestedGroupId
      ? effectiveSectionGroupId({ id: '', groupId: requestedGroupId }, targetGroups)
      : undefined;
    const placeInGroup = <T extends { groupId?: string }>(section: T): T => {
      if (targetGroupId) section.groupId = targetGroupId;
      else delete section.groupId;
      return section;
    };

    const now = new Date().toISOString();
    const sourcePages = sourceSection.pageDocumentIds
      .map((documentId) => workspace.pages.find((page) => page.documentId === documentId))
      .filter((page): page is PageSummary => Boolean(page));
    if (sourcePages.length !== sourceSection.pageDocumentIds.length) {
      setNotice(t('workspace.error.transferDocuments'));
      return;
    }

    if (request.copy) {
      const sectionId = createLocalId('section');
      const pageRemap = createStablePageIdRemap(sourcePages, () => createLocalId('page'));
      void (async () => {
        const duplicatePages: PageDocV3[] = [];
        for (const page of sourcePages) {
          const pageId = pageRemap.pageIdBySourceId.get(page.pageId);
          if (!pageId) throw new Error(t('workspace.error.copyId'));
          const duplicate = await duplicatePageProjection(runtime, page.pageId, pageId, now, page.title);
          duplicate.notebookId = targetNotebook.notebookId;
          duplicate.sectionId = sectionId;
          const parentPageId = remappedParentPageId(page, pageRemap);
          if (parentPageId) duplicate.parentPageId = parentPageId;
          else delete duplicate.parentPageId;
          duplicatePages.push(duplicate);
        }
        const duplicateSection = placeInGroup({
          ...structuredClone(sourceSection),
          id: sectionId,
          title: t('workspace.section.copySuffix', { title: sourceSection.title }),
          createdAt: now,
          updatedAt: now,
          pageDocumentIds: duplicatePages.map((page) => page.documentId),
        });
        const firstPage = duplicatePages[0];
        void commitTopology({
          operationId: createLocalId('copy-section'),
          message: t('workspace.operation.copySection'),
          newDocuments: duplicatePages,
          changes: [{
            documentId: targetNotebook.documentId,
            change: (document) => {
              if (document.kind !== 'notebook') return;
              const at = insertionIndex(
                document.sections.map((section) => section.id),
                targetSection?.id,
                request.placement,
              );
              document.sections.splice(at, 0, duplicateSection);
              document.updatedAt = now;
            },
          }],
          updateManifest: (manifest) => {
            manifest.pageDocumentIds.push(...duplicatePages.map((page) => page.documentId));
            if (firstPage) {
              manifest.active = {
                notebookId: targetNotebook.notebookId,
                sectionId,
                pageId: firstPage.pageId,
              };
            }
          },
        }).then((next) => {
          if (next && firstPage) navigate(targetNotebook.notebookId, sectionId, firstPage.pageId);
        });
      })().catch(reportTopologyError);
      return;
    }

    const destinationIds = targetNotebook.sections
      .map((section) => section.id)
      .filter((sectionId) => !sameNotebook || sectionId !== sourceSection.id);
    const at = insertionIndex(destinationIds, targetSection?.id, request.placement);
    const movedSection = placeInGroup(structuredClone(sourceSection));
    const changes: Array<{
      documentId: string;
      change: ChangeFn<LiveCanvinkDocumentV2>;
    }> = [];
    if (sameNotebook) {
      changes.push({
        documentId: sourceNotebook.documentId,
        change: (document) => {
          if (document.kind !== 'notebook') return;
          const sourceIndex = document.sections.findIndex(
            (section) => section.id === sourceSection.id,
          );
          if (sourceIndex < 0) throw new Error(t('workspace.error.sourceSection'));
          document.sections.splice(sourceIndex, 1);
          document.sections.splice(at, 0, movedSection);
          document.updatedAt = now;
        },
      });
    } else {
      changes.push({
        documentId: sourceNotebook.documentId,
        change: (document) => {
          if (document.kind !== 'notebook') return;
          const sourceIndex = document.sections.findIndex(
            (section) => section.id === sourceSection.id,
          );
          if (sourceIndex < 0) throw new Error(t('workspace.error.sourceSection'));
          document.sections.splice(sourceIndex, 1);
          document.updatedAt = now;
        },
      }, {
        documentId: targetNotebook.documentId,
        change: (document) => {
          if (document.kind !== 'notebook') return;
          document.sections.splice(at, 0, movedSection);
          document.updatedAt = now;
        },
      });
      for (const page of sourcePages) {
        changes.push({
          documentId: page.documentId,
          change: (document) => {
            if (document.kind !== 'page') return;
            document.notebookId = targetNotebook.notebookId;
            document.updatedAt = now;
          },
        });
      }
    }
    const firstPage = sourcePages[0];
    void commitTopology({
      operationId: createLocalId('move-section'),
      message: t('workspace.operation.moveSection'),
      changes,
      updateManifest: (manifest) => {
        if (firstPage) {
          manifest.active = {
            notebookId: targetNotebook.notebookId,
            sectionId: sourceSection.id,
            pageId: firstPage.pageId,
          };
        }
      },
    }).then((next) => {
      if (next && firstPage) {
        navigate(targetNotebook.notebookId, sourceSection.id, firstPage.pageId);
      }
    });
  }, [commitTopology, navigate, reportTopologyError, runtime, t, viewerMode, workspace]);

  const addPage = useCallback((
    sectionId: string,
    parentPageId?: string,
    pageKind: PageContentV1['kind'] = 'canvas',
  ) => {
    if (!activeContext) return;
    const now = new Date().toISOString();
    const pageId = createLocalId('page');
    const page = newPageProjection({
      notebookId: activeContext.notebook.notebookId,
      sectionId,
      pageId,
      parentPageId,
      pageKind,
      title: t('workspace.page.untitled'),
      defaults: resolveNotebookSettings(activeContext.notebook.settings).newPage,
      now,
    });
    void commitTopology({
      operationId: createLocalId('create-page'),
      message: t('workspace.operation.createPage'),
      newDocuments: [page],
      changes: [{
        documentId: activeContext.notebook.documentId,
        change: (document) => {
          if (document.kind !== 'notebook') return;
          const section = document.sections.find((candidate) => candidate.id === sectionId);
          if (!section) throw new Error(t('workspace.error.targetSection'));
          section.pageDocumentIds.push(page.documentId);
          section.updatedAt = now;
          document.updatedAt = now;
        },
      }],
      updateManifest: (manifest) => { manifest.pageDocumentIds.push(page.documentId); },
    }).then((next) => {
      if (next) navigate(page.notebookId, sectionId, pageId);
    });
  }, [activeContext, commitTopology, navigate, t]);

  // Creates a page from a built-in template or from a page tagged "vorlage"
  // (whole content, including ink), titled with today's date.
  const addPageFromTemplate = useCallback((sectionId: string, source: PageTemplateSource) => {
    if (!runtime || !activeContext || !workspace) return;
    const now = new Date();
    const timestamp = now.toISOString();
    const pageId = createLocalId('page');
    const notebookId = activeContext.notebook.notebookId;
    const notebookDocumentId = activeContext.notebook.documentId;
    let preparedPage: Promise<PageDocV3>;
    if (source.kind === 'builtin') {
      preparedPage = Promise.resolve(applyBuiltinTemplate(source.id, newPageProjection({
        notebookId,
        sectionId,
        pageId,
        title: titleFromTemplate('{datum}', now),
        now: timestamp,
      }), t));
    } else {
      const template = workspace.pages.find((candidate) => candidate.pageId === source.pageId);
      if (!template) return;
      preparedPage = duplicatePageProjection(
        runtime, template.pageId, pageId, timestamp, titleFromTemplate(template.title, now),
      ).then((page) => {
        page.notebookId = notebookId;
        page.sectionId = sectionId;
        delete page.parentPageId;
        page.tags = page.tags.filter((tag) => tag !== TEMPLATE_TAG);
        return page;
      });
    }
    void preparedPage.then((page) => commitTopology({
      operationId: createLocalId('create-page-from-template'),
      message: t('workspace.operation.createPage'),
      newDocuments: [page],
      changes: [{
        documentId: notebookDocumentId,
        change: (document) => {
          if (document.kind !== 'notebook') return;
          const section = document.sections.find((candidate) => candidate.id === sectionId);
          if (!section) throw new Error(t('workspace.error.targetSection'));
          section.pageDocumentIds.push(page.documentId);
          section.updatedAt = timestamp;
          document.updatedAt = timestamp;
        },
      }],
      updateManifest: (manifest) => { manifest.pageDocumentIds.push(page.documentId); },
    }).then((next) => {
      if (next) navigate(page.notebookId, sectionId, pageId);
    })).catch((error: unknown) => {
      setSaveState('error');
      setSaveError(messageFromError(error, t('workspace.error.topologyChange')));
    });
  }, [activeContext, commitTopology, navigate, runtime, t, workspace]);

  const toggleActivePageTemplate = useCallback((enabled: boolean) => {
    const updatedAt = new Date().toISOString();
    commitPage(t('workspace.operation.changeTags'), (document) => {
      if (enabled) addPageTag(document, TEMPLATE_TAG, updatedAt);
      else removePageTag(document, TEMPLATE_TAG, updatedAt);
    });
  }, [commitPage, t]);

  const reorderPage = useCallback((sectionId: string, pageId: string, direction: 'up' | 'down') => {
    if (!activeContext || !workspace) return;
    const page = workspace.pages.find((candidate) => candidate.pageId === pageId);
    if (!page) return;
    void commitTopology({
      operationId: createLocalId('reorder-page'),
      message: t('workspace.operation.reorderPage'),
      changes: [{
        documentId: activeContext.notebook.documentId,
        change: (document) => {
          if (document.kind !== 'notebook') return;
          const section = document.sections.find((candidate) => candidate.id === sectionId);
          if (!section) return;
          const index = section.pageDocumentIds.indexOf(page.documentId);
          const target = direction === 'up' ? index - 1 : index + 1;
          if (index < 0 || target < 0 || target >= section.pageDocumentIds.length) return;
          const [documentId] = section.pageDocumentIds.splice(index, 1);
          section.pageDocumentIds.splice(target, 0, documentId);
          const timestamp = new Date().toISOString();
          section.updatedAt = timestamp;
          document.updatedAt = timestamp;
        },
      }],
    });
  }, [activeContext, commitTopology, t, workspace]);

  const transferPage = useCallback((request: PageTransferRequest) => {
    if (!runtime || !workspace) return;
    const source = workspace.pages.find((page) => page.pageId === request.pageId);
    const sourceNotebook = workspace.notebooks.find(
      (notebook) => notebook.notebookId === request.sourceNotebookId,
    );
    const targetNotebook = workspace.notebooks.find(
      (notebook) => notebook.notebookId === request.targetNotebookId,
    );
    const targetSection = targetNotebook?.sections.find(
      (section) => section.id === request.targetSectionId,
    );
    const targetPage = request.targetPageId
      ? workspace.pages.find((page) => page.pageId === request.targetPageId)
      : undefined;
    if (!source || !sourceNotebook || !targetNotebook || !targetSection) return;
    if (
      targetPage
      && (targetPage.notebookId !== targetNotebook.notebookId
        || targetPage.sectionId !== targetSection.id)
    ) {
      setNotice(t('workspace.transfer.wrongSection'));
      return;
    }
    if (!request.copy && invalidPageTransferCycle(workspace.pages, source.pageId, targetPage?.pageId)) {
      setNotice(t('workspace.transfer.cycle'));
      return;
    }

    const subtree = pageSubtree(workspace.pages, source.pageId);
    const subtreeDocumentIds = new Set(subtree.map((page) => page.documentId));
    const sourceSection = sourceNotebook.sections.find((section) => section.id === source.sectionId);
    if (!sourceSection) return;
    const orderedSubtree = sourceSection.pageDocumentIds
      .filter((documentId) => subtreeDocumentIds.has(documentId))
      .map((documentId) => subtree.find((page) => page.documentId === documentId))
      .filter((page): page is PageSummary => Boolean(page));
    for (const page of subtree) {
      if (!orderedSubtree.includes(page)) orderedSubtree.push(page);
    }
    const targetParentPageId = request.placement === 'inside'
      ? targetPage?.pageId
      : request.placement === 'before' || request.placement === 'after'
        ? targetPage?.parentPageId
        : undefined;
    const now = new Date().toISOString();

    if (request.copy) {
      const idMap = new Map(orderedSubtree.map((page) => [page.pageId, createLocalId('page')]));
      void (async () => {
        const duplicates: PageDocV3[] = [];
        for (const page of orderedSubtree) {
          const duplicateId = idMap.get(page.pageId);
          if (!duplicateId) throw new Error(t('workspace.error.copyId'));
          const duplicate = await duplicatePageProjection(runtime, page.pageId, duplicateId, now, t('workspace.page.copySuffix', { title: page.title }));
          duplicate.notebookId = targetNotebook.notebookId;
          duplicate.sectionId = targetSection.id;
          duplicate.title = page.pageId === source.pageId ? t('workspace.page.copySuffix', { title: page.title }) : page.title;
          const parentPageId = page.pageId === source.pageId
            ? targetParentPageId
            : page.parentPageId ? idMap.get(page.parentPageId) : undefined;
          if (parentPageId) duplicate.parentPageId = parentPageId;
          else delete duplicate.parentPageId;
          duplicates.push(duplicate);
        }
        await commitTopology({
          operationId: createLocalId('copy-page-tree'),
          message: t('workspace.operation.copyPageTree'),
          newDocuments: duplicates,
          changes: [{
            documentId: targetNotebook.documentId,
            change: (document) => {
              if (document.kind !== 'notebook') return;
              const section = document.sections.find((candidate) => candidate.id === targetSection.id);
              if (!section) throw new Error(t('workspace.error.copyTargetSection'));
              let insertion = section.pageDocumentIds.length;
              if (targetPage) {
                const targetIndex = section.pageDocumentIds.indexOf(targetPage.documentId);
                if (targetIndex >= 0) insertion = targetIndex + (request.placement === 'before' ? 0 : 1);
              }
              section.pageDocumentIds.splice(insertion, 0, ...duplicates.map((page) => page.documentId));
              section.updatedAt = now;
              document.updatedAt = now;
            },
          }],
          updateManifest: (manifest) => {
            manifest.pageDocumentIds.push(...duplicates.map((page) => page.documentId));
            const rootCopy = duplicates[0];
            if (rootCopy) {
              manifest.active = {
                notebookId: targetNotebook.notebookId,
                sectionId: targetSection.id,
                pageId: rootCopy.pageId,
              };
            }
          },
        }).then((next) => {
          const rootCopy = duplicates[0];
          if (next && rootCopy) navigate(targetNotebook.notebookId, targetSection.id, rootCopy.pageId);
        });
      })().catch(reportTopologyError);
      return;
    }

    const moveWithinNotebook = sourceNotebook.documentId === targetNotebook.documentId;
    const changes: Array<{
      documentId: string;
      change: ChangeFn<LiveCanvinkDocumentV2>;
    }> = [];
    if (moveWithinNotebook) {
      changes.push({
        documentId: sourceNotebook.documentId,
        change: (document) => {
          if (document.kind !== 'notebook') return;
          const from = document.sections.find((section) => section.id === source.sectionId);
          const to = document.sections.find((section) => section.id === targetSection.id);
          if (!from || !to) throw new Error(t('workspace.error.moveSection'));
          from.pageDocumentIds = from.pageDocumentIds.filter((id) => !subtreeDocumentIds.has(id));
          let insertion = to.pageDocumentIds.length;
          if (targetPage) {
            const targetIndex = to.pageDocumentIds.indexOf(targetPage.documentId);
            if (targetIndex >= 0) insertion = targetIndex + (request.placement === 'before' ? 0 : 1);
          }
          to.pageDocumentIds.splice(insertion, 0, ...orderedSubtree.map((page) => page.documentId));
          from.updatedAt = now;
          to.updatedAt = now;
          document.updatedAt = now;
        },
      });
    } else {
      changes.push({
        documentId: sourceNotebook.documentId,
        change: (document) => {
          if (document.kind !== 'notebook') return;
          const section = document.sections.find((candidate) => candidate.id === source.sectionId);
          if (!section) throw new Error(t('workspace.error.sourceSection'));
          section.pageDocumentIds = section.pageDocumentIds.filter((id) => !subtreeDocumentIds.has(id));
          section.updatedAt = now;
          document.updatedAt = now;
        },
      }, {
        documentId: targetNotebook.documentId,
        change: (document) => {
          if (document.kind !== 'notebook') return;
          const section = document.sections.find((candidate) => candidate.id === targetSection.id);
          if (!section) throw new Error(t('workspace.error.targetSection'));
          let insertion = section.pageDocumentIds.length;
          if (targetPage) {
            const targetIndex = section.pageDocumentIds.indexOf(targetPage.documentId);
            if (targetIndex >= 0) insertion = targetIndex + (request.placement === 'before' ? 0 : 1);
          }
          section.pageDocumentIds.splice(insertion, 0, ...orderedSubtree.map((page) => page.documentId));
          section.updatedAt = now;
          document.updatedAt = now;
        },
      });
    }
    for (const page of orderedSubtree) {
      changes.push({
        documentId: page.documentId,
        change: (document) => {
          if (document.kind !== 'page') return;
          document.notebookId = targetNotebook.notebookId;
          document.sectionId = targetSection.id;
          if (page.pageId === source.pageId) {
            if (targetParentPageId) document.parentPageId = targetParentPageId;
            else delete document.parentPageId;
          }
          document.updatedAt = now;
        },
      });
    }
    void commitTopology({
      operationId: createLocalId('move-page-tree'),
      message: t('workspace.operation.movePageTree'),
      changes,
      updateManifest: (manifest) => {
        manifest.active = {
          notebookId: targetNotebook.notebookId,
          sectionId: targetSection.id,
          pageId: source.pageId,
        };
      },
    }).then((next) => {
      if (next) navigate(targetNotebook.notebookId, targetSection.id, source.pageId);
    });
  }, [commitTopology, navigate, reportTopologyError, runtime, t, workspace]);

  const duplicatePage = useCallback((sectionId: string, pageId: string) => {
    if (!runtime || !activeContext || !workspace) return;
    const source = workspace.pages.find((page) => page.pageId === pageId);
    if (!source) return;
    // The notebook of the page being copied, not the active one: the page list
    // already shows the new notebook while a switch to it is still finishing.
    const sourceNotebook = workspace.notebooks.find((notebook) => notebook.notebookId === source.notebookId);
    if (!sourceNotebook) return;
    const now = new Date().toISOString();
    const duplicateId = createLocalId('page');
    const notebookDocumentId = sourceNotebook.documentId;
    void duplicatePageProjection(runtime, source.pageId, duplicateId, now, t('workspace.page.copySuffix', { title: source.title })).then((duplicate) => {
      duplicate.sectionId = sectionId;
      return commitTopology({
        operationId: createLocalId('duplicate-page'),
        message: t('workspace.operation.duplicatePage'),
        newDocuments: [duplicate],
        changes: [{
          documentId: notebookDocumentId,
          change: (document) => {
            if (document.kind !== 'notebook') return;
            const section = document.sections.find((candidate) => candidate.id === sectionId);
            if (!section) throw new Error(t('workspace.error.sourceSection'));
            const index = section.pageDocumentIds.indexOf(source.documentId);
            section.pageDocumentIds.splice(index + 1, 0, duplicate.documentId);
            section.updatedAt = now;
            document.updatedAt = now;
          },
        }],
        updateManifest: (manifest) => { manifest.pageDocumentIds.push(duplicate.documentId); },
      }).then((next) => {
        if (next) navigate(duplicate.notebookId, sectionId, duplicateId);
      });
    }).catch(reportTopologyError);
  }, [activeContext, commitTopology, navigate, reportTopologyError, runtime, t, workspace]);

  /**
   * Writes a page again as a fresh document whose ink lives in segments. An
   * Automerge document keeps every operation it ever had, so a page drawn in
   * the older formats stays slow to open however it is edited; a new document
   * starts without that history. The rebuild runs in two steps so nothing is
   * lost at any point: the new page is added next to the old one and read back
   * against it, and only when every stroke matches does the old page go to the
   * trash (where it can be restored) and the new one take its place, with the
   * sub-pages following it.
   */
  const rebuildPage = useCallback((sectionId: string, pageId: string) => {
    if (!runtime || !activeContext || !workspace) return;
    const source = workspace.pages.find((page) => page.pageId === pageId);
    const section = activeContext.notebook.sections.find((candidate) => candidate.id === sectionId);
    if (!source || !section) return;
    const now = new Date().toISOString();
    const rebuiltId = createLocalId('page');
    const notebookDocumentId = activeContext.notebook.documentId;
    const children = workspace.pages.filter((page) => page.parentPageId === source.pageId);
    void (async () => {
      const rebuilt = await duplicatePageProjection(runtime, source.pageId, rebuiltId, now, source.title);
      // The rebuilt page keeps the pin state, tags and title of the original.
      rebuilt.tags = [...source.tags];
      rebuilt.sectionId = sectionId;
      if (source.parentPageId) rebuilt.parentPageId = source.parentPageId;
      else delete rebuilt.parentPageId;
      await commitTopology({
        operationId: createLocalId('rebuild-page'),
        message: t('workspace.operation.rebuildPage'),
        newDocuments: [rebuilt],
        changes: [{
          documentId: notebookDocumentId,
          change: (document) => {
            if (document.kind !== 'notebook') return;
            const target = document.sections.find((candidate) => candidate.id === sectionId);
            if (!target) throw new Error(t('workspace.error.sourceSection'));
            const index = target.pageDocumentIds.indexOf(source.documentId);
            target.pageDocumentIds.splice(index + 1, 0, rebuilt.documentId);
            target.updatedAt = now;
            document.updatedAt = now;
          },
        }],
        updateManifest: (manifest) => { manifest.pageDocumentIds.push(rebuilt.documentId); },
      });
      const matches = await runtime.readPage(source.pageId, (original) => runtime.readPage(rebuiltId, (copy) => {
        const before = getSharedAutomergeSnapshot<LivePageDocV2>(original);
        const after = getSharedAutomergeSnapshot<LivePageDocV2>(copy);
        return sameInk(before, after);
      }));
      if (!matches) {
        setNotice(t('workspace.error.rebuildVerify'));
        return;
      }
      if (!workspaceHistory) throw new Error(t('workspace.error.historyUnavailable'));
      await workspaceHistory.createTrashCheckpoint(pageId);
      const index = section.pageDocumentIds.indexOf(source.documentId);
      const entry: TrashRecordV2 = {
        id: createLocalId('trash'),
        kind: 'page',
        deletedAt: now,
        origin: { notebookId: source.notebookId, sectionId, index, parentPageId: source.parentPageId ?? '' },
        pageDocumentId: source.documentId,
      };
      const shownPageId = workspace.active.pageId;
      await commitTopology({
        operationId: createLocalId('rebuild-page-swap'),
        message: t('workspace.operation.rebuildPage'),
        changes: [
          {
            documentId: notebookDocumentId,
            change: (document) => {
              if (document.kind !== 'notebook') return;
              const target = document.sections.find((candidate) => candidate.id === sectionId);
              if (!target) return;
              const at = target.pageDocumentIds.indexOf(source.documentId);
              if (at >= 0) target.pageDocumentIds.splice(at, 1);
              target.updatedAt = now;
              document.updatedAt = now;
            },
          },
          ...children.map((child) => ({
            documentId: child.documentId,
            change: (document: LiveCanvinkDocumentV2) => {
              if (document.kind === 'page') document.parentPageId = rebuiltId;
            },
          })),
        ],
        updateManifest: (manifest) => {
          manifest.trash.push(entry);
          if (manifest.active.pageId === pageId || shownPageId === pageId) {
            manifest.active = { notebookId: source.notebookId, sectionId, pageId: rebuiltId };
          }
        },
      });
      if (shownPageId === pageId) navigate(source.notebookId, sectionId, rebuiltId);
    })().catch(reportTopologyError);
  }, [activeContext, commitTopology, navigate, reportTopologyError, runtime, t, workspace, workspaceHistory]);

  const addActivePageTag = useCallback(() => {
    if (!activeContext) return;
    const tag = normalizePageTag(tagDraft);
    if (!tag) {
      setNotice(t('workspace.page.tags.invalid'));
      return;
    }
    if (activeContext.page.tags.includes(tag)) {
      setTagDraft('');
      return;
    }
    if (activeContext.page.tags.length >= PAGE_TAG_LIMIT) {
      setNotice(t('workspace.page.tags.full', { count: PAGE_TAG_LIMIT }));
      return;
    }
    const updatedAt = new Date().toISOString();
    const committed = commitPage(t('workspace.operation.changeTags'), (document) => {
      addPageTag(document, tag, updatedAt);
    });
    if (committed) setTagDraft('');
  }, [activeContext, commitPage, t, tagDraft]);

  const removeActivePageTag = useCallback((tag: string) => {
    const updatedAt = new Date().toISOString();
    commitPage(t('workspace.operation.changeTags'), (document) => {
      removePageTag(document, tag, updatedAt);
    });
  }, [commitPage, t]);

  const trashPage = useCallback((sectionId: string, pageId: string) => {
    if (!activeContext || !workspace) return;
    const page = workspace.pages.find((candidate) => candidate.pageId === pageId);
    const section = activeContext.notebook.sections.find((candidate) => candidate.id === sectionId);
    if (!page || !section) return;
    const index = section.pageDocumentIds.indexOf(page.documentId);
    // The page that takes over is a neighbour in the same section (the next
    // one, else the previous one), like closing a tab; only a section with
    // no other page falls back to any page of the workspace.
    const neighbourDocumentId = section.pageDocumentIds[index + 1] ?? section.pageDocumentIds[index - 1];
    const fallback = workspace.pages.find((candidate) => candidate.documentId === neighbourDocumentId)
      ?? workspace.pages.find((candidate) => candidate.pageId !== pageId
        && workspace.notebooks.some((notebook) => notebook.sections.some(
          (candidateSection) => candidateSection.pageDocumentIds.includes(candidate.documentId),
        )));
    if (!fallback) return;
    const shownPageId = workspace.active.pageId;
    const now = new Date().toISOString();
    const entry: TrashRecordV2 = {
      id: createLocalId('trash'),
      kind: 'page',
      deletedAt: now,
      origin: {
        notebookId: page.notebookId,
        sectionId,
        index,
        parentPageId: page.parentPageId ?? '',
      },
      pageDocumentId: page.documentId,
    };
    void (async () => {
      try {
        if (!workspaceHistory) throw new Error(t('workspace.error.historyUnavailable'));
        await workspaceHistory.createTrashCheckpoint(pageId);
        await commitTopology({
          operationId: createLocalId('trash-page'),
          message: t('workspace.operation.trashPage'),
          changes: [{
            documentId: activeContext.notebook.documentId,
            change: (document) => {
              if (document.kind !== 'notebook') return;
              const target = document.sections.find((candidate) => candidate.id === sectionId);
              if (!target) return;
              const pageIndex = target.pageDocumentIds.indexOf(page.documentId);
              if (pageIndex >= 0) target.pageDocumentIds.splice(pageIndex, 1);
              target.updatedAt = now;
              document.updatedAt = now;
            },
          }],
          updateManifest: (manifest) => {
            manifest.trash.push(entry);
            if (manifest.active.pageId === pageId || shownPageId === pageId) {
              manifest.active = {
                notebookId: fallback.notebookId,
                sectionId: fallback.sectionId,
                pageId: fallback.pageId,
              };
            }
          },
        });
      } catch (error) {
        setNotice(messageFromError(error, t('workspace.error.historyBeforeDelete')));
      }
    })();
  }, [activeContext, commitTopology, t, workspace, workspaceHistory]);

  const trashSection = useCallback((sectionId: string) => {
    if (!activeContext || !workspace) return;
    const section = activeContext.notebook.sections.find((candidate) => candidate.id === sectionId);
    const fallbackSection = activeContext.notebook.sections.find((candidate) => candidate.id !== sectionId
      && candidate.pageDocumentIds.length > 0);
    const fallbackPage = workspace.pages.find(
      (page) => fallbackSection?.pageDocumentIds.includes(page.documentId),
    );
    if (!section || !fallbackSection || !fallbackPage) return;
    const now = new Date().toISOString();
    const entry: TrashRecordV2 = {
      id: createLocalId('trash'),
      kind: 'section',
      deletedAt: now,
      origin: { notebookId: activeContext.notebook.notebookId },
      section: structuredClone(section),
    };
    void commitTopology({
      operationId: createLocalId('trash-section'),
      message: t('workspace.operation.trashSection'),
      changes: [{
        documentId: activeContext.notebook.documentId,
        change: (document) => {
          if (document.kind !== 'notebook') return;
          const index = document.sections.findIndex((candidate) => candidate.id === sectionId);
          if (index >= 0) document.sections.splice(index, 1);
          document.updatedAt = now;
        },
      }],
      updateManifest: (manifest) => {
        manifest.trash.push(entry);
        if (manifest.active.sectionId === sectionId) {
          manifest.active = {
            notebookId: activeContext.notebook.notebookId,
            sectionId: fallbackSection.id,
            pageId: fallbackPage.pageId,
          };
        }
      },
    });
  }, [activeContext, commitTopology, t, workspace]);

  const trashNotebook = useCallback((notebookId?: string) => {
    if (!activeContext || !workspace) return;
    const notebook = notebookId
      ? workspace.notebooks.find((candidate) => candidate.notebookId === notebookId)
      : activeContext.notebook;
    if (!notebook) return;
    const trashedNotebookIds = new Set(workspace.activation.manifest.trash.flatMap(
      (entry) => entry.kind === 'notebook' && entry.notebookDocumentId ? [entry.notebookDocumentId] : [],
    ));
    const fallbackNotebook = workspace.notebooks.find(
      (candidate) => candidate.documentId !== notebook.documentId
        && !trashedNotebookIds.has(candidate.documentId),
    );
    const fallbackSection = fallbackNotebook?.sections.find(
      (candidate) => candidate.pageDocumentIds.length > 0,
    );
    const fallbackPage = workspace.pages.find(
      (page) => fallbackSection?.pageDocumentIds.includes(page.documentId),
    );
    if (!fallbackNotebook || !fallbackSection || !fallbackPage) return;
    const entry: TrashRecordV2 = {
      id: createLocalId('trash'),
      kind: 'notebook',
      deletedAt: new Date().toISOString(),
      origin: {},
      notebookDocumentId: notebook.documentId,
    };
    const trashingActive = notebook.documentId === activeContext.notebook.documentId;
    void commitTopology({
      operationId: createLocalId('trash-notebook'),
      message: t('workspace.operation.trashNotebook'),
      updateManifest: (manifest) => {
        manifest.trash.push(entry);
        if (!trashingActive) return;
        manifest.active = {
          notebookId: fallbackNotebook.notebookId,
          sectionId: fallbackSection.id,
          pageId: fallbackPage.pageId,
        };
      },
    });
  }, [activeContext, commitTopology, t, workspace]);

  // Leaving a shared notebook takes it out of this workspace (into the trash, like any notebook, so
  // it can be restored) and cuts its connection to the room; the others keep their copy.
  const leaveSharedNotebook = useCallback(async (notebookId: string) => {
    const notebook = workspace?.notebooks.find((candidate) => candidate.notebookId === notebookId);
    if (!notebook) return;
    if (liveNotebooks.length < 2) {
      setNotice(t('collab.leave.last'));
      return;
    }
    const confirmed = await confirm({
      title: t('collab.leave.title'),
      message: t('collab.leave.confirm', { title: notebook.title }),
      confirmLabel: t('collab.leave.action'),
      danger: true,
    });
    if (!confirmed) return;
    // The room is told the person left (best effort); the notebook leaves the workspace either way.
    void collabGateway?.leaveNotebook(notebookId).catch(() => undefined);
    removeJoinedRoom(notebookId);
    personalSpace.clearSharedRoom(notebook.documentId);
    setOwnerRoomsTick((tick) => tick + 1);
    trashNotebook(notebookId);
  }, [collabGateway, confirm, liveNotebooks.length, personalSpace, t, trashNotebook, workspace]);

  const moveNotebook = useCallback((notebookId: string, direction: 'up' | 'down') => {
    const index = visibleNotebooks.findIndex((notebook) => notebook.notebookId === notebookId);
    const neighbour = visibleNotebooks[direction === 'up' ? index - 1 : index + 1];
    if (index < 0 || !neighbour) return;
    transferNotebook({
      notebookId,
      targetNotebookId: neighbour.notebookId,
      placement: direction === 'up' ? 'before' : 'after',
      copy: false,
    });
  }, [transferNotebook, visibleNotebooks]);

  const setSectionColor = useCallback((sectionId: string, color: string | undefined) => {
    if (!activeContext) return;
    const updatedAt = new Date().toISOString();
    void commitTopology({
      operationId: createLocalId('section-color'),
      message: t('workspace.operation.sectionColor'),
      changes: [{
        documentId: activeContext.notebook.documentId,
        change: (document) => {
          if (document.kind !== 'notebook') return;
          const section = document.sections.find((candidate) => candidate.id === sectionId);
          if (!section) return;
          if (color) section.color = color;
          else delete section.color;
          section.updatedAt = updatedAt;
        },
      }],
    });
  }, [activeContext, commitTopology, t]);

  /**
   * Pins and template marks are page tags, written as a topology change so
   * they work for any page in the list, not only the open one. A pin does
   * not count as editing the page, so `updatedAt` stays.
   */
  const setPageTag = useCallback((pageId: string, change: (tags: string[]) => boolean, message: string) => {
    const page = workspace?.pages.find((candidate) => candidate.pageId === pageId);
    if (!page) return;
    void commitTopology({
      operationId: createLocalId('page-tag'),
      message,
      changes: [{
        documentId: page.documentId,
        change: (document) => {
          if (document.kind !== 'page') return;
          change(document.tags);
        },
      }],
    });
  }, [commitTopology, workspace]);

  const setPagePinned = useCallback((pageId: string, pinned: boolean) => {
    const page = workspace?.pages.find((candidate) => candidate.pageId === pageId);
    if (!page || isPinnedPage(page) === pinned) return;
    if (pinned && page.tags.length >= PAGE_TAG_LIMIT) {
      setNotice(t('workspace.pin.full', { count: PAGE_TAG_LIMIT }));
      return;
    }
    setPageTag(pageId, (tags) => setPinTag({ tags }, pinned), t('workspace.operation.pinPage'));
  }, [setPageTag, t, workspace]);

  const setPageTemplate = useCallback((pageId: string, enabled: boolean) => {
    setPageTag(pageId, (tags) => {
      const index = tags.indexOf(TEMPLATE_TAG);
      if (enabled && index === -1 && tags.length < PAGE_TAG_LIMIT) tags.push(TEMPLATE_TAG);
      else if (!enabled && index !== -1) tags.splice(index, 1);
      else return false;
      return true;
    }, t('workspace.operation.changeTags'));
  }, [setPageTag, t]);

  // Stars used to be kept in this browser only (and nothing listed them).
  // Turn any left over into synced pins once, shortly after opening, then
  // forget them.
  const migratedFavoritesRef = useRef(false);
  useEffect(() => {
    if (migratedFavoritesRef.current || !workspace || !runtime || teamViewerMode) return;
    if (uiState.favoritePageIds.length === 0) return;
    const favorites = new Set(uiState.favoritePageIds);
    const pages = workspace.pages.filter((page) => favorites.has(page.pageId)
      && !isPinnedPage(page)
      && page.tags.length < PAGE_TAG_LIMIT);
    // Stars of pages that no longer exist stay inert in local storage.
    if (pages.length === 0) return;
    const timer = window.setTimeout(() => {
      migratedFavoritesRef.current = true;
      void commitTopology({
        operationId: createLocalId('pin-favorites'),
        message: t('workspace.operation.pinPage'),
        changes: pages.map((page) => ({
          documentId: page.documentId,
          change: (document) => {
            if (document.kind === 'page') setPinTag(document, true);
          },
        })),
      }).then((next) => {
        if (next) setUiState((current) => ({ ...current, favoritePageIds: [] }));
      });
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [commitTopology, runtime, t, uiState.favoritePageIds, teamViewerMode, workspace]);

  const restoreTrashEntry = useCallback((entry: TrashRecordV2 | TrashRecordV3) => {
    if (!workspace) return;
    const now = new Date().toISOString();
    if (entry.kind === 'notebook' && entry.notebookDocumentId) {
      void commitTopology({
        operationId: createLocalId('restore-notebook'),
        message: t('workspace.operation.restoreNotebook'),
        updateManifest: (manifest) => {
          manifest.trash = manifest.trash.filter((candidate) => candidate.id !== entry.id);
        },
      });
      return;
    }
    const notebookId = typeof entry.origin.notebookId === 'string'
      ? entry.origin.notebookId
      : undefined;
    const notebook = workspace.notebooks.find((candidate) => candidate.notebookId === notebookId);
    if (!notebook) return;
    if (entry.kind === 'section' && entry.section) {
      const restoredSection = structuredClone(entry.section);
      void commitTopology({
        operationId: createLocalId('restore-section'),
        message: t('workspace.operation.restoreSection'),
        changes: [{
          documentId: notebook.documentId,
          change: (document) => {
            if (document.kind !== 'notebook') return;
            // A section whose group was deleted meanwhile returns to the top level.
            if (restoredSection.groupId && !document.sectionGroups?.some((group) => group.id === restoredSection.groupId)) {
              delete restoredSection.groupId;
            }
            document.sections.push(restoredSection);
            document.updatedAt = now;
          },
        }],
        updateManifest: (manifest) => {
          manifest.trash = manifest.trash.filter((candidate) => candidate.id !== entry.id);
        },
      });
      return;
    }
    if (entry.kind === 'page' && entry.pageDocumentId) {
      const sectionId = typeof entry.origin.sectionId === 'string'
        ? entry.origin.sectionId
        : undefined;
      const index = typeof entry.origin.index === 'number' ? entry.origin.index : Number.MAX_SAFE_INTEGER;
      if (!sectionId) return;
      void commitTopology({
        operationId: createLocalId('restore-page'),
        message: t('workspace.operation.restorePage'),
        changes: [{
          documentId: notebook.documentId,
          change: (document) => {
            if (document.kind !== 'notebook') return;
            const section = document.sections.find((candidate) => candidate.id === sectionId);
            if (!section) throw new Error(t('workspace.error.restoreTarget'));
            section.pageDocumentIds.splice(
              Math.min(index, section.pageDocumentIds.length),
              0,
              entry.pageDocumentId as string,
            );
            section.updatedAt = now;
            document.updatedAt = now;
          },
        }],
        updateManifest: (manifest) => {
          manifest.trash = manifest.trash.filter((candidate) => candidate.id !== entry.id);
        },
      });
    }
  }, [commitTopology, t, workspace]);

  const permanentlyDeleteTrashEntry = useCallback(async (entry: TrashRecordV2 | TrashRecordV3) => {
    if (!workspace) return;
    const confirmed = await confirm({
      title: t('workspace.trash.permanentTitle'),
      message: t('workspace.trash.permanentConfirm'),
      confirmLabel: t('workspace.trash.deletePermanently'),
      danger: true,
    });
    if (!confirmed) return;
    let removedDocumentIds: string[] = [];
    if (entry.kind === 'page' && entry.pageDocumentId) {
      removedDocumentIds = [entry.pageDocumentId];
    } else if (entry.kind === 'section' && entry.section) {
      removedDocumentIds = [...entry.section.pageDocumentIds];
    } else if (entry.kind === 'notebook' && entry.notebookDocumentId) {
      const notebook = workspace.notebooks.find(
        (candidate) => candidate.documentId === entry.notebookDocumentId,
      );
      removedDocumentIds = [
        entry.notebookDocumentId,
        ...(notebook?.sections.flatMap((section) => section.pageDocumentIds) ?? []),
      ];
    }
    const removed = new Set(removedDocumentIds);
    void commitTopology({
      operationId: createLocalId('delete-trash'),
      message: t('workspace.operation.permanentDelete'),
      removedDocumentIds,
      updateManifest: (manifest) => {
        manifest.trash = manifest.trash.filter((candidate) => candidate.id !== entry.id);
        manifest.notebookDocumentIds = manifest.notebookDocumentIds.filter((id) => !removed.has(id));
        manifest.pageDocumentIds = manifest.pageDocumentIds.filter((id) => !removed.has(id));
      },
    });
  }, [commitTopology, confirm, t, workspace]);

  const addQuickNote = useCallback(() => {
    const elementId = createLocalId('rich-text');
    const blockId = createLocalId('paragraph');
    const timestamp = new Date().toISOString();
    commitPage(t('workspace.operation.quickNote'), (document) => {
      document.elementsById[elementId] = {
        id: elementId,
        kind: 'richText',
        frame: { x: 72, y: 72, width: 560, height: 160, rotation: 0 },
        createdAt: timestamp,
        updatedAt: timestamp,
        locked: false,
        text: '',
        style: {
          color: '#1e2925',
          fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
          fontSize: 22,
          textAlign: 'left',
        },
      };
      document.zOrder.push(elementId);
      document.updatedAt = timestamp;
      seedPortableRichText(document, elementId, {
        type: 'doc',
        blocks: [{ id: blockId, type: 'paragraph', spans: [] }],
      });
    });
    requestAnimationFrame(() => {
      const editor = document.querySelector<HTMLElement>(
        `[data-element-id="${CSS.escape(elementId)}"] .ProseMirror`,
      );
      editor?.focus();
    });
  }, [commitPage, t]);

  const downloadRollbackCopy = useCallback(async () => {
    if (!runtime) return;
    try {
      const copy = await runtime.createV1RollbackCopy();
      downloadJson(copy, 'canvink-schema-v1-rollback-copy.json');
      setNotice(t('workspace.rollback.downloaded'));
    } catch (error) {
      setNotice(messageFromError(error, t('workspace.rollback.unavailable')));
    }
  }, [runtime, t]);

  if (startup.phase === 'opening' || startup.phase === 'migrating') {
    return <LoadingWorkspace progress={startup.progress} inkRaster={inkRaster} />;
  }
  if (startup.error || startup.phase === 'failed' || startup.phase === 'recovery-required') {
    return (
      <RecoveryWorkspace
        error={startup.error ?? new Error(t('workspace.error.open'))}
        recoveryCode={startup.recoveryCode}
        retry={startup.retry}
      />
    );
  }
  if (!runtime || !workspace || !activeContext || !navigationLists) {
    return <LoadingWorkspace progress={startup.progress} inkRaster={inkRaster} />;
  }

  // The title shows a page that is still loading at once, so the navigation
  // highlights it in the same commit. Otherwise the previous page stays
  // marked as open for the length of the load, and a command taken from its
  // row would act on a page the title no longer shows.
  const shownLocation = pendingPage ?? workspace.active;
  const { pinnedPageIds, quickAccess, templatePages } = navigationLists;
  const activePagePinned = pinnedPageIds.has(activeContext.page.pageId);
  const activePageContent = pageContent(activeContext.page);
  const activePageIsTemplate = isTemplatePage(activeContext.page);

  const trashEntryTitle = (entry: TrashRecordV2 | TrashRecordV3): string => {
    const title = entry.kind === 'section'
      ? entry.section?.title
      : entry.kind === 'page'
        ? workspace.pages.find((page) => page.documentId === entry.pageDocumentId)?.title
        : entry.kind === 'notebook'
          ? workspace.notebooks.find((notebook) => notebook.documentId === entry.notebookDocumentId)?.title
          : undefined;
    return title || t(`workspace.trash.kind.${entry.kind}`);
  };

  // Focus returns to the control that opened the dialog; the notebook switcher's list is gone by then,
  // so its button stands in.
  const openNotebookSettings = (notebookId: string, returnFocus: HTMLElement | null = null) => {
    setNotebookSettingsTarget({
      notebookId,
      returnFocus: returnFocus ?? document.querySelector<HTMLElement>('.notebook-switcher__button'),
    });
  };
  const settingsNotebook = notebookSettingsTarget
    ? workspace.notebooks.find((notebook) => notebook.notebookId === notebookSettingsTarget.notebookId)
    : undefined;
  const activeLiveNotebook = liveNotebooks.find((notebook) => notebook.id === activeContext.notebook.notebookId);
  // With a sorted notebook the order is not the user's to move, so the move commands step aside.
  const pagesMovable = (activeLiveNotebook?.sort?.pages ?? 'manual') === 'manual';
  const sectionsMovable = (activeLiveNotebook?.sort?.sections ?? 'manual') === 'manual';
  const defaultTemplateReference = notebookNewPage.template;
  const notebookTemplate = (() => {
    if (!defaultTemplateReference) return undefined;
    if (defaultTemplateReference.kind === 'builtin') {
      const builtin = BUILTIN_TEMPLATES.find((candidate) => candidate.id === defaultTemplateReference.id);
      return builtin ? { source: { kind: 'builtin', id: builtin.id } as const, title: t(builtin.labelKey) } : undefined;
    }
    const page = templatePages.find((candidate) => candidate.pageId === defaultTemplateReference.pageId);
    return page ? { source: { kind: 'page', pageId: page.pageId } as const, title: page.title } : undefined;
  })();

  const notebookSwitcher = (shortcut: boolean, openOnMount = false) => (
    <NotebookSwitcher
      notebooks={liveNotebooks}
      activeNotebookId={activeContext.notebook.notebookId}
      previousNotebookId={uiState.previousNotebookId}
      quickAccess={quickAccess}
      onSelectNotebook={navigateNotebook}
      onOpenPage={(entry) => navigate(entry.notebookId, entry.sectionId, entry.pageId)}
      onUnpinPage={(entry) => setPagePinned(entry.pageId, false)}
      onAddNotebook={addNotebook}
      onRenameNotebook={renameNotebook}
      onDuplicateNotebook={(notebookId) => transferNotebook({
        notebookId,
        targetNotebookId: notebookId,
        placement: 'after',
        copy: true,
      })}
      onMoveNotebook={moveNotebook}
      onTrashNotebook={trashNotebook}
      sharedNotebooks={sharedNotebooks}
      onLeaveNotebook={(notebookId) => void leaveSharedNotebook(notebookId)}
      onOpenNotebookSettings={(notebookId) => openNotebookSettings(notebookId)}
      readOnly={teamViewerMode}
      invitations={invitations.invitations}
      invitationBusyRoomId={invitations.busyRoomId}
      onOpenInvitation={invitations.open}
      onDeclineInvitation={invitations.decline}
      shortcut={shortcut}
      openOnMount={openOnMount}
    />
  );

  // The navigation is one component in two places: the docked sidebar and,
  // in the full page view, the slide-in panel. They share these props.
  const sidebarProps = {
    notebooks: liveNotebooks,
    activeNotebookId: shownLocation.notebookId,
    activeSectionId: shownLocation.sectionId,
    activePageId: shownLocation.pageId,
    lastPageBySection,
    trashCount: migrationTrashCount(workspace.activation.manifest),
    onAddSection: addSection,
    onRenameSection: renameSection,
    onRenamePage: renamePage,
    onAddPage: addPage,
    templates: templatePages,
    onAddPageFromTemplate: addPageFromTemplate,
    notebookTemplate,
    onTrashSection: trashSection,
    onTrashPage: trashPage,
    onDuplicatePage: duplicatePage,
    onRebuildPage: rebuildPage,
    onReorderPage: reorderPage,
    onTransferPage: transferPage,
    onTransferSection: transferSection,
    onAddSectionGroup: addSectionGroup,
    onRenameSectionGroup: renameSectionGroup,
    onTrashSectionGroup: trashSectionGroup,
    onTransferSectionGroup: transferSectionGroup,
    onOpenTrash: () => setTrashOpen(true),
    quickAccess,
    pinnedPageIds,
    onSetPagePinned: setPagePinned,
    onSetPageTemplate: setPageTemplate,
    onSetSectionColor: setSectionColor,
    capabilities: {
      createNotebook: !teamViewerMode,
      createSection: !viewerMode,
      createPage: !viewerMode,
      renameNotebook: !viewerMode,
      renameSection: !viewerMode,
      renamePage: !viewerMode,
      trashNotebook: !teamViewerMode,
      trashSection: !viewerMode,
      trashPage: !viewerMode,
      duplicatePage: !viewerMode,
      reorderPage: !viewerMode && pagesMovable,
      transferPage: !viewerMode,
      reorderNotebook: !teamViewerMode,
      duplicateNotebook: !teamViewerMode,
      reorderSection: !viewerMode && sectionsMovable,
      duplicateSection: !viewerMode,
      transferSection: !viewerMode,
      openTrash: true,
      pinPage: !viewerMode,
      templatePage: !viewerMode,
      colorSection: !viewerMode,
      createSectionGroup: !viewerMode,
      manageSectionGroups: !viewerMode,
    },
  };

  // The title bar's "More" menu: create and import, then the notebook, then
  // the app itself. Commands that do not exist here are left out; those a
  // read-only page only suspends stay visible and disabled.
  const moreMenuItems = (): ContextMenuEntry[] => menuGroups([
    [
      {
        id: 'quick-note',
        label: t('workspace.quickNote'),
        icon: <StickyNote size={16} />,
        disabled: viewerMode || activePageContent.kind !== 'canvas',
        onSelect: addQuickNote,
      },
      !VIEWER_APP && {
        id: 'import-onenote',
        label: t('workspace.import.open'),
        icon: <FileInput size={16} />,
        disabled: viewerMode,
        onSelect: () => setOneNoteImportOpen(true),
      },
    ],
    [
      sharingAvailable && notebookAccess.canManage(activeContext.notebook.notebookId) && {
        id: 'share',
        label: t('collab.share.open'),
        icon: <Share2 size={16} />,
        disabled: teamViewerMode,
        onSelect: () => {
          setShareNotebookId(null);
          setShareOpen(true);
        },
      },
      {
        id: 'notebook-settings',
        label: t('nbSettings.open'),
        icon: <Settings2 size={16} />,
        // The menu closes on select; focus goes back to its button when the dialog closes.
        onSelect: () => openNotebookSettings(activeContext.notebook.notebookId, document.getElementById('topbar-more-button')),
      },
      {
        id: 'history',
        label: t('workspace.history.open'),
        icon: <Clock3 size={16} />,
        disabled: viewerMode,
        onSelect: () => setHistoryOpen(true),
      },
      !VIEWER_APP && {
        id: 'rollback-copy',
        label: t('workspace.rollback.download'),
        icon: <Download size={16} />,
        onSelect: () => { void downloadRollbackCopy(); },
      },
    ],
    [
      {
        kind: 'segmented',
        id: 'language',
        label: t('app.language.label'),
        icon: <Languages size={16} />,
        value: language,
        options: SUPPORTED_LANGUAGES.map((option) => ({
          value: option,
          label: option.toUpperCase(),
          ariaLabel: t(`app.language.${option}`),
        })),
        onChange: (value) => { if (isLanguage(value)) setLanguage(value); },
      },
      !VIEWER_APP && {
        id: 'diagnostics',
        label: t('performance.open'),
        icon: <Activity size={16} />,
        onSelect: () => setDiagnosticsOpen(true),
      },
    ],
  ], 'more');

  return (
    <div className={`notebook-app v2-notebook-app${sidebarOpen ? '' : ' sidebar-is-closed'}${fullPage ? ' is-full-page' : ''}${fullPageFloating ? ' is-full-page-floating' : ''}${fullPage && !fullPageFloating && !fullPageToolsOpen ? ' is-full-page-collapsed' : ''}`}>
      {fullPageFloating ? (
        <FloatingInkToolbar
          state={fullPageToolbar}
          onChange={updateFullPageToolbar}
          onExit={exitFullPage}
          onOpenNavigation={() => setFullPageNavOpen(true)}
          toolsRef={setFloatSlot}
          currentRef={setFloatCurrentSlot}
        />
      ) : fullPage ? (
        <div className="full-page-controls" role="toolbar" aria-label={t('ribbon.fullPage')}>
          <button
            type="button"
            className="full-page-controls__button"
            aria-label={t('workspace.fullPage.floating')}
            title={t('workspace.fullPage.floating')}
            onClick={() => updateFullPageToolbar({ mode: 'floating' })}
          >
            <PictureInPicture2 size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="full-page-controls__button"
            aria-label={t(fullPageToolsOpen ? 'workspace.fullPage.collapse' : 'workspace.fullPage.expand')}
            title={t(fullPageToolsOpen ? 'workspace.fullPage.collapse' : 'workspace.fullPage.expand')}
            aria-expanded={fullPageToolsOpen}
            onClick={() => setFullPageToolsOpen((open) => !open)}
          >
            {fullPageToolsOpen ? <PanelTopClose size={16} aria-hidden="true" /> : <PanelTopOpen size={16} aria-hidden="true" />}
          </button>
          <button
            type="button"
            className="full-page-controls__button"
            aria-label={t('workspace.fullPage.navigation')}
            title={t('workspace.fullPage.navigation')}
            aria-keyshortcuts="Control+G"
            onClick={() => setFullPageNavOpen(true)}
          >
            <Library size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="full-page-controls__button"
            aria-label={t('workspace.fullscreen.exit')}
            title={t('workspace.fullscreen.exit')}
            aria-pressed="true"
            onClick={exitFullPage}
          >
            <Minimize2 size={16} aria-hidden="true" />
          </button>
        </div>
      ) : null}
      {fullPage && fullPageNavOpen ? (
        <FullPageNavigation onClose={closeFullPageNav}>
          <PagePresenceContext.Provider value={pagePresence}>
            <Sidebar
              {...sidebarProps}
              layout="tree"
              onClose={closeFullPageNav}
              // Choosing a page closes the panel; the page stays in fullscreen.
              onActivatePage={(notebookId, sectionId, pageId) => {
                navigate(notebookId, sectionId, pageId);
                closeFullPageNav();
              }}
              notebookSwitcher={notebookSwitcher(true, switcherRequested)}
            />
          </PagePresenceContext.Provider>
        </FullPageNavigation>
      ) : null}
      <a className="skip-link" href="#v2-page-editor">{t('workspace.skipToPage')}</a>
      <header className="app-topbar">
        <button
          type="button"
          className="sidebar-toggle"
          onClick={() => setSidebarOpen((current) => !current)}
          aria-label={t(sidebarOpen ? 'workspace.sidebar.close' : 'workspace.sidebar.open')}
          aria-expanded={sidebarOpen}
        >
          <Menu size={18} />
        </button>
        <div className="app-topbar__brand" aria-hidden="true">
          <span className="brand-mark"><BookOpen size={15} /></span>
          <strong>Canvink</strong>
        </div>
        {notebookSwitcher(!fullPage)}
        {notebookReadOnly ? <ReadOnlyBadge /> : null}
        <SearchPanel
          runtime={runtime!}
          workspace={workspace!}
          activePageId={workspace!.active.pageId}
          onNavigate={navigate}
        />
        <div className="topbar-actions">
          {VIEWER_APP ? null : (
            <button
              type="button"
              className="topbar-action topbar-action--icon"
              aria-label={t(fullPage ? 'workspace.fullscreen.exit' : 'workspace.fullscreen.enter')}
              aria-pressed={fullPage}
              onClick={toggleFullscreen}
            >
              {fullPage ? <Minimize2 size={16} aria-hidden="true" /> : <Maximize2 size={16} aria-hidden="true" />}
            </button>
          )}
          {/* "Is my work safe?": the local save and, with an account, the sync. The account itself is the avatar. */}
          <SyncStatus
            save={{ state: inkWaiting && saveState === 'saved' ? 'saving' : saveState, error: saveError }}
            status={personalSpaceEnabled ? spaceStatus : null}
            offlineProgress={personalSpace.offlineProgress}
            canSignIn={spaceAuth.available && !spaceAuth.isSignedIn}
            onSyncNow={() => personalSpace.syncNow()}
            onSignIn={() => {
              // A signed-in device that still has to connect its notebooks asks again, it does not sign in.
              if (spaceStatus.kind === 'link-required') linkChoice.reconsider();
              else if (spaceAuth.available) spaceAuth.openSignIn();
            }}
            onOpenStorage={() => setAccountDialogTab('storage')}
          />
          <TeamSyncHost
            compact
            notebookId={activeContext.notebook.notebookId}
            pageId={activeContext.page.pageId}
            pageHandle={activeContext.pageHandle}
            deviceId={deviceId}
            workspaceRuntime={runtime ?? undefined}
            onViewerModeChange={(viewer) => {
              setViewerMode(viewer);
              if (viewer) setHistoryOpen(false);
            }}
          />
          <AppMenuButton
            id="topbar-more-button"
            label={t('workspace.more')}
            className="topbar-action"
            items={moreMenuItems}
            onPointerEnter={OneNoteImportDialog.preload}
            onFocus={OneNoteImportDialog.preload}
          >
            <MoreHorizontal size={16} aria-hidden="true" /> <span>{t('workspace.more')}</span>
          </AppMenuButton>
          {VIEWER_APP ? null : (
            <PerformanceDiagnostics
              recorder={performanceRecorder}
              open={diagnosticsOpen}
              onClose={() => setDiagnosticsOpen(false)}
            />
          )}
          <PresenceStack
            hub={activePresenceHub}
            pageDocId={activeContext.page.documentId}
            pageTitle={(docId) => workspace.pages.find((page) => page.documentId === docId)?.title}
            loadContent={loadPresenceContent}
            openPage={openPresencePage}
          />
          <DesktopUpdateChip flush={flushBeforeUpdateRestart} />
          {spaceAuth.available ? (
            <AccountMenu
              auth={spaceAuth}
              onOpenAccount={() => setAccountDialogTab('profile')}
              onSignOut={() => personalSpace.signOut()}
              sync={{
                save: inkWaiting && saveState === 'saved' ? 'saving' : saveState,
                status: personalSpaceEnabled ? spaceStatus : null,
              }}
            />
          ) : null}
        </div>
      </header>
      <Ribbon
        tab={ribbonTab}
        onTab={setRibbonTab}
        slotRefs={ribbonSlotRefs}
        before={activePageContent.kind === 'canvas' && !VIEWER_APP ? (
          <AssetWorkspaceControls
                runtime={runtime}
                workspace={workspace}
                activeContext={activeContext}
                commitTopology={commitTopology}
                createId={createLocalId}
                navigate={navigate}
                onWorkspaceState={setWorkspaceOverride}
                onNotice={setNotice}
                disabled={viewerMode}
                insertHost={assetInsertSlot}
                insertClipRef={insertClipRef}
              />
        ) : null}
        insertExtras={<div ref={setAssetInsertSlot} className="ribbon__slot" />}
        drawExtras={activePageContent.kind === 'canvas' ? (
          <div className="ribbon-groups" role="toolbar" aria-label={t('ribbon.draw')}>
            <div className="ribbon-group" role="group" aria-label={t('ribbon.group.touch')}>
              <button
                type="button"
                className="ribbon-button"
                aria-label={t('ribbon.touchDraw')}
                aria-pressed={touchDraws === true}
                title={t(touchDraws === undefined ? 'ribbon.touchDraw.auto' : 'ribbon.touchDraw.hint')}
                onClick={() => updateTouchDraws(touchDraws !== true)}
              >
                <Hand size={16} aria-hidden="true" />
              </button>
            </div>
          </div>
        ) : null}
        viewExtras={(
          <div className="ribbon-groups" role="toolbar" aria-label={t('ribbon.view')}>
            {activePageContent.kind === 'canvas' ? (
              <>
                <div className="ribbon-group" role="group" aria-label={t('ribbon.group.paper')}>
                  <PaperMenus page={activeContext.page} disabled={viewerMode} onChange={commitPage} />
                </div>
                <div className="ribbon-group" role="group" aria-label={t('ribbon.group.window')}>
                  <button
                    type="button"
                    className="ribbon-button ribbon-button--labelled"
                    aria-pressed={sidebarOpen}
                    onClick={() => setSidebarOpen((current) => !current)}
                  >
                    <PanelLeft size={16} aria-hidden="true" /><span>{t('ribbon.navigation')}</span>
                  </button>
                  {VIEWER_APP ? null : (
                    <button
                      type="button"
                      className="ribbon-button ribbon-button--labelled"
                      aria-pressed={fullPage}
                      onClick={toggleFullscreen}
                    >
                      <Maximize2 size={16} aria-hidden="true" /><span>{t('ribbon.fullPage')}</span>
                    </button>
                  )}
                </div>
              </>
            ) : null}
            <TouchModeGroup />
          </div>
        )}
      />
      <div className="v2-body">
      {sidebarOpen && !fullPage ? (
        <PagePresenceContext.Provider value={pagePresence}>
          <Sidebar
            {...sidebarProps}
            layout={wideLayout ? 'panes' : 'tree'}
            onClose={() => setSidebarOpen(false)}
            onActivatePage={navigate}
            notebookSwitcher={overlayNavigation ? notebookSwitcher(false) : undefined}
          />
        </PagePresenceContext.Provider>
      ) : null}
      <main
        className="workspace-shell v2-workspace-shell"
        id="v2-page-editor"
        data-page-loading={pendingPage ? 'true' : undefined}
      >

        {/* OneNote-style page title block: a large title with the creation
            date underneath, below the drawing toolbar like a page title under
            OneNote's ribbon. */}
        <header className="page-header">
          <div className="page-header__title">
            <input
              ref={titleRef}
              aria-label={t('workspace.page.title')}
              value={pendingPage ? pendingPage.title : activeContext.page.title}
              disabled={viewerMode || pendingPage !== null}
              // A page that has just opened has no write session for a moment;
              // typing then would be dropped, and the controlled value would
              // snap back. Read-only (not disabled) keeps the focus that
              // opening the page gave the field.
              readOnly={shownPageWriteSession === null && pageWriteFailedFor !== activePageId}
              onChange={(event) => {
                const title = event.target.value;
                commitPage(t('workspace.operation.renamePage'), (document) => {
                  document.title = title;
                  document.updatedAt = new Date().toISOString();
                });
              }}
            />
            <p className="page-header__meta">
              <time dateTime={activeContext.page.createdAt}>{formatPageDate(activeContext.page.createdAt, language)}</time>
              <span role="group" aria-label={t('workspace.page.location')}>
                <button
                  type="button"
                  className="page-header__notebook"
                  title={t('nbSettings.openFor', { title: activeContext.notebook.title })}
                  aria-label={t('nbSettings.openFor', { title: activeContext.notebook.title })}
                  onClick={(event) => openNotebookSettings(activeContext.notebook.notebookId, event.currentTarget)}
                >
                  {activeContext.notebook.title}
                </button>
                {[
                  '',
                  ...sectionGroupPath(activeContext.notebook, activeContext.section),
                  activeContext.section.title,
                ].join(' / ')}
              </span>
            </p>
          </div>
          <button
            type="button"
            className="v2-icon-button"
            aria-label={t(activePagePinned ? 'menu.unpin' : 'menu.pin')}
            title={t(activePagePinned ? 'menu.unpin' : 'menu.pin')}
            aria-pressed={activePagePinned}
            disabled={viewerMode}
            onClick={() => setPagePinned(activeContext.page.pageId, !activePagePinned)}
          >
            <Pin size={15} fill={activePagePinned ? 'currentColor' : 'none'} aria-hidden="true" />
          </button>
          <PageSettingsPanel
            page={activeContext.page}
            isCanvas={activePageContent.kind === 'canvas'}
            viewerMode={viewerMode}
            isTemplate={activePageIsTemplate}
            tags={visibleTags(activeContext.page.tags)}
            tagLimitReached={activeContext.page.tags.length >= PAGE_TAG_LIMIT}
            tagDraft={tagDraft}
            onTagDraft={setTagDraft}
            onAddTag={addActivePageTag}
            onRemoveTag={removeActivePageTag}
            onToggleTemplate={toggleActivePageTemplate}
            onChange={commitPage}
          />
        </header>

        {notice ? (
          <p className="v2-notice" role="status">
            <span>{notice}</span>
            <button type="button" className="v2-notice__close" aria-label={t('workspace.notice.close')} onClick={() => setNotice(null)}>
              <X size={13} aria-hidden="true" />
            </button>
          </p>
        ) : null}
        {inkRaster && inkRaster.record.pageId === shownLocation.pageId ? <InkRasterLayer raster={inkRaster} /> : null}
        {pendingPage ? (
          <div className="v2-page-loading" role="status">
            <LoaderCircle className="spin" size={18} aria-hidden="true" />
            <span>{t('workspace.page.loading')}</span>
          </div>
        ) : null}
        {activePageContent.kind === 'markdown' ? (
          <MarkdownPageEditor
            key={activeContext.page.documentId}
            title={activeContext.page.title}
            source={activePageContent.source}
            editable={!viewerMode && activePageWriteSession !== null}
            onSourceChange={(source) => {
              commitPage(t('workspace.operation.editMarkdown'), (document) => {
                document.pageContent = { version: 1, kind: 'markdown', source };
                document.updatedAt = new Date().toISOString();
              });
            }}
          />
        ) : !mathRuntimeReady ? (
          <div className="v2-page-loading" role="status">
            <LoaderCircle className="spin" size={18} aria-hidden="true" />
            <span>{t('workspace.page.loading')}</span>
          </div>
        ) : viewerMode || shownPageWriteSession !== null || pageWriteFailedFor === activePageId ? (
          // Mounted once the page's write session is ready, so opening a page
          // builds the canvas and its toolbars once, not first read-only and
          // then again for editing.
          <PageEditor
            key={`${activeContext.page.documentId}:${editorHandleKey(shownPageWriteSession?.handle ?? activeContext.pageHandle)}`}
            handle={shownPageWriteSession?.handle ?? activeContext.pageHandle}
            page={activeContext.page}
            deviceId={deviceId}
            editable={!viewerMode && shownPageWriteSession !== null}
            performanceRecorder={performanceRecorder}
            mathFeaturesEnabled={mathFeaturesEnabled}
            ribbonSlots={ribbonSlots}
            touchDraws={touchDraws}
            newTextStyle={newTextStyle}
            presence={canvasPresence}
            onChange={commitPage}
            writeRichText={writeRichText}
            renderAssetElement={renderAssetElement}
            renderRegionImage={renderRegionImage}
            insertRegionImage={insertRegionImage}
          />
        ) : (
          // The write session follows the activation: after a cloud sync
          // commit or a page change it takes a moment to prepare again, and
          // the page must read as loading meanwhile, not as an empty page.
          <div className="v2-page-loading" role="status" data-page-preparing="true">
            <LoaderCircle className="spin" size={18} aria-hidden="true" />
            <span>{t('workspace.page.loading')}</span>
          </div>
        )}
      </main>
      </div>

      {confirmElement}
      {trashOpen ? (
        <div className="recovery-overlay" role="presentation">
          <section className="recovery-card v2-trash-dialog" role="dialog" aria-modal="true" aria-labelledby="v2-trash-title">
            <button type="button" className="recovery-card__close" aria-label={t('workspace.trash.close')} onClick={() => setTrashOpen(false)}>
              <X size={16} />
            </button>
            <Trash2 size={24} aria-hidden="true" />
            <h2 id="v2-trash-title">{t('workspace.trash.title')}</h2>
            {workspace.activation.manifest.trash.length === 0 ? (
              <p className="v2-trash-dialog__empty">{t('workspace.trash.empty')}</p>
            ) : (
              <ul>
                {workspace.activation.manifest.trash.map((entry) => (
                  <li key={entry.id}>
                    <span className="v2-trash-dialog__item">
                      <strong>{trashEntryTitle(entry)}</strong>
                      <small>
                        {t(`workspace.trash.kind.${entry.kind}`)} · {formatPageDate(entry.deletedAt, language)}
                      </small>
                    </span>
                    <button type="button" onClick={() => restoreTrashEntry(entry)}>{t('workspace.trash.restore')}</button>
                    <button type="button" className="v2-trash-dialog__danger" onClick={() => permanentlyDeleteTrashEntry(entry)}>
                      {t('workspace.trash.deletePermanently')}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <button type="button" className="v2-trash-dialog__secondary" onClick={() => void downloadRollbackCopy()}>{t('workspace.trash.downloadRollback')}</button>
          </section>
        </div>
      ) : null}
      {shareOpen && sharingAvailable ? (
        <ShareNotebookDialog
          gateway={collabGateway}
          notebookId={shareNotebookId ?? activeContext.notebook.notebookId}
          notebookTitle={
            workspace.notebooks.find((notebook) => notebook.notebookId === (shareNotebookId ?? activeContext.notebook.notebookId))?.title
            ?? activeContext.notebook.title
          }
          onClose={() => {
            setShareOpen(false);
            setShareNotebookId(null);
          }}
        />
      ) : null}
      {settingsNotebook && !shareOpen ? (
        <NotebookSettingsDialog
          notebook={settingsNotebook}
          workspace={workspace}
          runtime={runtime}
          templates={templatePages}
          readOnly={viewerMode && settingsNotebook.notebookId === activeContext.notebook.notebookId}
          sharing={{
            // Anyone but the owner sees it as shared with them ("Mit dir geteilt").
            state: !sharedNotebooks.has(settingsNotebook.notebookId)
              ? 'private'
              : sharedNotebooks.get(settingsNotebook.notebookId) === 'owner' ? 'owner' : 'member',
            available: sharingAvailable,
          }}
          onOpenShare={() => {
            setShareNotebookId(settingsNotebook.notebookId);
            setShareOpen(true);
          }}
          offline={personalSpaceEnabled && ['synced', 'offline', 'reconnecting', 'bootstrapping'].includes(spaceStatus.kind) ? {
            policy: offlinePolicy,
            remaining: personalSpace.offlineProgress?.remaining,
            onPolicyChange: (policy) => {
              saveOfflineCopiesPolicy(policy);
              setOfflinePolicy(policy);
              // The pass that downloads the pages reads the policy when it starts.
              if (policy === 'all') personalSpace.syncNow();
            },
          } : undefined}
          isLastNotebook={liveNotebooks.length < 2}
          onSettings={(patch) => updateNotebookSettings(settingsNotebook.notebookId, patch)}
          onRename={(title) => renameNotebook(settingsNotebook.notebookId, title)}
          onColor={(color) => setNotebookColor(settingsNotebook.notebookId, color)}
          onApplyDefaults={() => applyNotebookDefaultsToPages(settingsNotebook.notebookId)}
          onTrash={() => trashNotebook(settingsNotebook.notebookId)}
          onLeave={() => void leaveSharedNotebook(settingsNotebook.notebookId)}
          onClose={() => setNotebookSettingsTarget(null)}
          returnFocus={notebookSettingsTarget?.returnFocus}
        />
      ) : null}
      <JoinLinkDialog join={joinLink} />
      {/* Outside the topbar: its styles would contain a fixed overlay. */}
      <DesktopLoginDialog auth={spaceAuth} />
      {accountDialogTab && spaceAuth.available && spaceAuth.isSignedIn ? (
        <AccountDialog
          auth={spaceAuth}
          descriptor={personalSpace.descriptor}
          personalSpace={personalSpaceEnabled}
          syncUrl={collabSyncUrl}
          initialTab={accountDialogTab}
          onClose={() => setAccountDialogTab(null)}
        />
      ) : null}
      {personalSpaceEnabled ? (
        <SpaceLinkDialog
          status={linkChoice.settled ? { kind: 'signed-out' } : spaceStatus}
          onAddLocal={() => personalSpace.addLocalToAccount()}
          onKeepLocal={linkChoice.keepLocal}
          onDiscard={() => personalSpace.discardLocalForAccount()}
          onClose={linkChoice.snooze}
        />
      ) : null}
      {oneNoteImportLoaded ? (
        <OneNoteImportDialog
          open={oneNoteImportOpen && !teamViewerMode}
          runtime={runtime}
          onClose={() => setOneNoteImportOpen(false)}
          onImported={openImportedNotebook}
          onRolledBack={() => {
            const restored = runtime.getState();
            if (restored.schemaVersion === 2 || restored.schemaVersion === 3) setWorkspaceOverride(restored);
          }}
        />
      ) : null}
      <HistoryPanel
        open={historyOpen}
        runtime={runtime}
        pageId={activeContext.page.pageId}
        onClose={() => setHistoryOpen(false)}
        onRestored={() => {
          const restored = runtime.getState();
          if (restored.schemaVersion === 2 || restored.schemaVersion === 3) setWorkspaceOverride(restored);
          setNotice(t('workspace.history.restored'));
        }}
      />
    </div>
  );
}
