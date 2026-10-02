import type { ChangeFn } from '@automerge/automerge';
import { createElement, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { LiveNotebookDocV2, LivePageDocV2 } from '../crdt';
import { useI18n } from '../i18n';
import { useOptionalAuth, type OptionalAuthValue } from '../auth';
import type { SpaceStatus } from '../personal-space';
import {
  PageNotDownloadedError,
  type ActiveV2Context,
  type PageWriteSession,
  type V2NavigationTarget,
  type V2RuntimeState,
  type WorkspaceGraphRevisionRequest,
  type WorkspaceV2Runtime,
} from '../storage/workspaceV2Runtime';
import type { MigrationProgress } from '../storage/v2WorkspaceStorage';
import { useWorkspaceV2Runtime, type WorkspaceV2RuntimeFactory, type WorkspaceV2StartupPhase } from '../components/useWorkspaceV2Runtime';
import { createPlatformWorkspaceRuntime } from '../components/workspaceRuntimeFactory';
import {
  loadV2UiState,
  localDeviceId,
  rememberNavigation,
  saveV2UiState,
  type V2UiState,
} from '../components/v2WorkspaceView';
import { flushWhenLeaving } from '../components/flushOnLeave';
import { flushAllInkQueues } from '../editor/inkCommitQueue';
import { pendingInk } from '../ink/pendingInk';
import { inkRasterStore } from '../editor/inkRasterStore';
import { usePersonalSpaceSync, type UsePersonalSpaceSyncResult } from '../components/personal-space/usePersonalSpaceSync';
import { useSharedNotebookSync } from '../components/collab/useSharedNotebookSync';
import { useLocalPresenceUser } from '../components/collab/presence/usePresence';
import { loadJoinedRooms, saveJoinedRoom } from '../components/collab/joinedRoomStore';
import { loadOwnerRooms } from '../components/collab/ownerRoomStore';
import { personalSpaceAssetRepository, runtimeAssetRepository } from '../components/assets/runtimeAssetRepository';
import AssetElementPreview from '../components/assets/AssetElementPreview';
import { WorkspaceSearchController } from '../components/search/searchRuntime';
import { PAGE_TAG_LIMIT } from '../domain/pageTags';
import { isPinnedPage, setPagePinned as setPinTag } from '../components/pagePins';

/**
 * The phone app's data layer: the same workspace runtime, storage, sync and
 * search as the notebook shell (V2NotebookApp), with the phone's flow of
 * opening one page at a time. It writes only what the phone does: text on a
 * page, page pins. Ink is never written (applyPageElementChanges drops it in
 * the phone build).
 */

export type SaveState = 'saved' | 'saving' | 'error';

export interface PageOpenError {
  pageId: string;
  notDownloaded: boolean;
  message: string;
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function messageFromError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

function createLocalId(scope: string): string {
  const suffix = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${scope}-${suffix}`;
}

/** The page last viewed on this device; the runtime opens it at start, so "Weiter, wo du warst" is instant. */
const lastViewedPageId = (): string | undefined => loadV2UiState(safeLocalStorage()).recentPageIds[0];

export const mobileRuntimeFactory: WorkspaceV2RuntimeFactory = (onMigrationProgress: (progress: MigrationProgress) => void) =>
  createPlatformWorkspaceRuntime(onMigrationProgress, lastViewedPageId);

/** Strokes waiting for their write and the runtime's own debounce are written before the app goes away. */
function flushForLeaving(runtime: { flush(options?: { seal?: boolean }): Promise<void> }): Promise<unknown> {
  flushAllInkQueues();
  return Promise.all([pendingInk().flushJournals(), runtime.flush({ seal: false })]);
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

export interface MobileWorkspace {
  phase: WorkspaceV2StartupPhase;
  progress: MigrationProgress | null;
  error: Error | null;
  recoveryCode: string | null;
  retry: () => void;
  runtime: WorkspaceV2Runtime | null;
  workspace: V2RuntimeState | null;
  /** Notebooks in the person's order, without those in the trash. */
  notebooks: readonly LiveNotebookDocV2[];
  activeContext: ActiveV2Context | null;
  /** The page being opened (its document loads). */
  openingPageId: string | null;
  openError: PageOpenError | null;
  openPage: (target: V2NavigationTarget) => Promise<boolean>;
  /** The open page's writer, null until it is ready (or when it failed: the page is read-only). */
  writeSession: PageWriteSession | null;
  writeFailed: boolean;
  commitPage: (message: string, change: ChangeFn<LivePageDocV2>) => boolean;
  setPagePinned: (pageId: string, pinned: boolean) => void;
  saveState: SaveState;
  saveError: string | null;
  notice: string | null;
  setNotice: (notice: string | null) => void;
  auth: OptionalAuthValue;
  personalSpaceEnabled: boolean;
  spaceStatus: SpaceStatus;
  personalSpace: UsePersonalSpaceSyncResult;
  uiState: V2UiState;
  deviceId: string;
  renderAssetElement: (element: Parameters<typeof AssetElementPreview>[0]['element']) => ReactNode;
  searchController: WorkspaceSearchController | null;
  /** Starts the search index now (the Search tab was opened before it started by itself). */
  requestSearch: () => void;
  /** Whether this device holds the page's document (false for a page still to download). */
  isAvailable: (documentId: string) => boolean;
}

export function useMobileWorkspace(factory: WorkspaceV2RuntimeFactory = mobileRuntimeFactory): MobileWorkspace {
  const { t } = useI18n();
  const startup = useWorkspaceV2Runtime(factory);
  const runtime = startup.runtime;
  const [workspaceOverride, setWorkspaceOverride] = useState<V2RuntimeState | null>(null);
  const workspace = workspaceOverride ?? startup.state;
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [uiState, setUiState] = useState<V2UiState>(() => loadV2UiState(safeLocalStorage()));
  const [deviceId] = useState(() => localDeviceId(safeLocalStorage()));
  const [openingPageId, setOpeningPageId] = useState<string | null>(null);
  const [openError, setOpenError] = useState<PageOpenError | null>(null);
  const [pageRevision, setPageRevision] = useState(0);
  const [pageWriteSession, setPageWriteSession] = useState<PageWriteSession | null>(null);
  const [pageWriteFailedFor, setPageWriteFailedFor] = useState<string | null>(null);
  const flushTimerRef = useRef<number | null>(null);
  const writesInFlightRef = useRef(0);
  const navigationSequenceRef = useRef(0);

  useEffect(() => {
    saveV2UiState(safeLocalStorage(), uiState);
  }, [uiState]);

  // Notices are short toasts; they go after a few seconds.
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), Math.min(10_000, 3_200 + Math.max(0, notice.length - 60) * 50));
    return () => window.clearTimeout(timer);
  }, [notice]);

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
      writesInFlightRef.current += 1;
      void runtime.flush().then(() => {
        writesInFlightRef.current -= 1;
        markSavedWhenIdle();
      }).catch((error: unknown) => {
        writesInFlightRef.current -= 1;
        setSaveState('error');
        setSaveError(messageFromError(error, t('workspace.error.flush')));
      });
    }, 250);
  }, [markSavedWhenIdle, runtime, t]);
  useEffect(() => () => {
    if (flushTimerRef.current !== null) window.clearTimeout(flushTimerRef.current);
  }, []);

  useEffect(() => {
    if (!runtime) return;
    return flushWhenLeaving(window, document, () => flushForLeaving(runtime));
  }, [runtime]);

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

  // Ink pictures (thumbnails) of pages that are gone are dropped once the app has settled.
  const pagesRef = useRef(workspace?.pages);
  useEffect(() => {
    pagesRef.current = workspace?.pages;
  }, [workspace?.pages]);
  useEffect(() => {
    if (!runtime) return;
    const timer = window.setTimeout(() => {
      const pages = pagesRef.current;
      if (pages) void inkRasterStore()?.prune(new Set(pages.map((page) => page.pageId))).catch(() => undefined);
    }, 15_000);
    return () => window.clearTimeout(timer);
  }, [runtime]);

  const notebooks = useMemo(() => {
    if (!workspace) return [];
    const trashed = new Set(workspace.activation.manifest.trash.flatMap(
      (entry) => entry.kind === 'notebook' && entry.notebookDocumentId ? [entry.notebookDocumentId] : [],
    ));
    const byDocumentId = new Map(workspace.notebooks.map((notebook) => [notebook.documentId, notebook]));
    return workspace.activation.manifest.notebookDocumentIds
      .map((documentId) => byDocumentId.get(documentId))
      .filter((notebook): notebook is LiveNotebookDocV2 => notebook !== undefined && !trashed.has(notebook.documentId));
  }, [workspace]);

  const activePageId = workspace?.active.pageId ?? null;
  const activationFingerprint = workspace?.activation.artifactFingerprint;
  const activeContext = useMemo(() => {
    if (!runtime || !workspace) return null;
    void pageRevision;
    try {
      return runtime.getActiveContext();
    } catch {
      return null;
    }
  }, [pageRevision, runtime, workspace]);

  // The open page's write session follows the activation: after a sync commit
  // it is prepared again, while the editor keeps writing to the previous one.
  const queuedChangesRef = useRef<Array<{ pageId: string; message: string; change: ChangeFn<LivePageDocV2> }>>([]);
  const replacePage = useCallback(() => setPageRevision((revision) => revision + 1), []);
  useEffect(() => {
    if (!runtime || !activePageId) return;
    let cancelled = false;
    void runtime.preparePageWrite(activePageId).then((session) => {
      if (cancelled) return;
      const ready = runtime.getState();
      if (ready.schemaVersion !== 1) setWorkspaceOverride(ready);
      setPageWriteSession(session);
      const queued = queuedChangesRef.current.filter((entry) => entry.pageId === session.pageId);
      queuedChangesRef.current = [];
      if (queued.length === 0) return;
      try {
        for (const entry of queued) session.change({ message: entry.message }, entry.change);
        replacePage();
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
  }, [activePageId, activationFingerprint, replacePage, runtime, scheduleFlush, t]);

  useEffect(() => {
    if (!runtime || !activePageId) return;
    return runtime.subscribeToPageChanges(activePageId, () => {
      replacePage();
      scheduleFlush();
    });
  }, [activePageId, activationFingerprint, replacePage, runtime, scheduleFlush]);

  const shownSession = pageWriteSession?.pageId === activePageId ? pageWriteSession : null;
  const currentSession = shownSession && shownSession.activationArtifactFingerprint === activationFingerprint ? shownSession : null;

  const commitPage = useCallback((message: string, change: ChangeFn<LivePageDocV2>): boolean => {
    if (!runtime || !activePageId) return false;
    if (!currentSession) {
      if (!shownSession) return false;
      try {
        shownSession.change({ message }, change);
        replacePage();
        scheduleFlush();
      } catch {
        queuedChangesRef.current.push({ pageId: activePageId, message, change });
      }
      return true;
    }
    try {
      currentSession.change({ message }, change);
      replacePage();
      scheduleFlush();
      return true;
    } catch (error) {
      setSaveState('error');
      setSaveError(messageFromError(error, t('workspace.error.pageChange')));
      return false;
    }
  }, [activePageId, currentSession, replacePage, runtime, scheduleFlush, shownSession, t]);

  const commitTopology = useCallback(async (
    request: Omit<WorkspaceGraphRevisionRequest, 'expectedActivationArtifactFingerprint'>,
  ): Promise<V2RuntimeState | null> => {
    if (!runtime) return null;
    setSaveState('saving');
    writesInFlightRef.current += 1;
    try {
      const ready = await runtime.ensureSchemaV3();
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
      setSaveState('error');
      setSaveError(messageFromError(error, t('workspace.error.topologyChange')));
      return null;
    }
  }, [markSavedWhenIdle, runtime, t]);

  /** A pin is a page tag written as a topology change, so any page can be pinned without opening it. */
  const setPagePinned = useCallback((pageId: string, pinned: boolean) => {
    const page = workspace?.pages.find((candidate) => candidate.pageId === pageId);
    if (!page || isPinnedPage(page) === pinned) return;
    if (pinned && page.tags.length >= PAGE_TAG_LIMIT) {
      setNotice(t('workspace.pin.full', { count: PAGE_TAG_LIMIT }));
      return;
    }
    void commitTopology({
      operationId: createLocalId('page-tag'),
      message: t('workspace.operation.pinPage'),
      changes: [{
        documentId: page.documentId,
        change: (document) => {
          if (document.kind === 'page') setPinTag(document, pinned);
        },
      }],
    });
  }, [commitTopology, t, workspace]);

  const openPage = useCallback(async (target: V2NavigationTarget): Promise<boolean> => {
    if (!runtime) return false;
    const sequence = ++navigationSequenceRef.current;
    const before = runtime.getState();
    const fromNotebookId = before.schemaVersion === 1 ? undefined : before.active.notebookId;
    setOpenError(null);
    const needsLoad = !runtime.isPageLoaded(target.pageId);
    if (needsLoad) setOpeningPageId(target.pageId);
    try {
      // The screen's transition and the page's title paint before a heavy
      // page's document holds the main thread.
      if (needsLoad) {
        await nextFrame();
        await nextFrame();
      }
      if (sequence !== navigationSequenceRef.current) return false;
      await runtime.navigateTo(target);
      if (sequence !== navigationSequenceRef.current) return false;
      const next = runtime.getState();
      if (next.schemaVersion === 1) return false;
      setWorkspaceOverride(next);
      if (next.active.pageId !== target.pageId) return false;
      setUiState((current) => rememberNavigation(current, fromNotebookId, { notebookId: target.notebookId, pageId: target.pageId }));
      return true;
    } catch (error) {
      if (sequence === navigationSequenceRef.current) {
        setOpenError({
          pageId: target.pageId,
          notDownloaded: error instanceof PageNotDownloadedError,
          message: error instanceof PageNotDownloadedError
            ? t('workspace.error.pageNotDownloaded')
            : messageFromError(error, t('workspace.error.navigation')),
        });
      }
      return false;
    } finally {
      if (sequence === navigationSequenceRef.current) setOpeningPageId(null);
    }
  }, [runtime, t]);

  // Accounts and sync, as in the notebook shell.
  const collabSyncUrl = (import.meta.env.VITE_COLLAB_SYNC_URL as string | undefined) || undefined;
  const personalSpaceEnabled = (import.meta.env.VITE_PERSONAL_SPACE as string | undefined) === '1';
  const auth = useOptionalAuth();
  const presenceUser = useLocalPresenceUser(auth, deviceId);
  const signedIn = auth.available && auth.isSignedIn;
  const [roomsTick, setRoomsTick] = useState(0);
  useSharedNotebookSync({
    runtime,
    workspace,
    syncUrl: collabSyncUrl,
    bindTrigger: roomsTick,
    presenceUser,
    signedIn,
    getAccountToken: auth.available ? auth.getToken : undefined,
    onAccessLost: () => {
      setRoomsTick((tick) => tick + 1);
      setNotice(t('collab.notice.accessLost'));
    },
    onAdoptFailed: () => setNotice(t('collab.notice.pageNotAdopted')),
  });
  const joinedRooms = useMemo(() => {
    void roomsTick;
    const joined = loadJoinedRooms();
    const owned = loadOwnerRooms();
    const rooms = new Map<string, string>();
    for (const notebook of workspace?.notebooks ?? []) {
      const record = joined[notebook.notebookId];
      if (record && !owned[notebook.notebookId]) rooms.set(notebook.documentId, record.roomId);
    }
    return rooms;
  }, [roomsTick, workspace]);
  const adoptAccountRooms = useCallback((rooms: ReadonlyMap<string, string>) => {
    let changed = false;
    for (const [documentId, roomId] of rooms) {
      const notebookId = documentId.replace(/^notebook:/, '');
      if (loadOwnerRooms()[notebookId] || loadJoinedRooms()[notebookId]?.roomId === roomId) continue;
      saveJoinedRoom(notebookId, { roomId });
      changed = true;
    }
    if (changed) setRoomsTick((tick) => tick + 1);
  }, []);
  const [spaceStatus, setSpaceStatus] = useState<SpaceStatus>({ kind: 'disabled' });
  const personalSpace = usePersonalSpaceSync({
    runtime,
    workspace,
    syncUrl: collabSyncUrl,
    auth,
    enabled: personalSpaceEnabled,
    onWorkspaceReplaced: setWorkspaceOverride,
    onNotice: setNotice,
    onStatus: setSpaceStatus,
    sharedRooms: joinedRooms,
    onSharedRooms: adoptAccountRooms,
  });
  // The app coming back to the front catches up at once instead of waiting for the next push.
  const syncNowRef = useRef(personalSpace.syncNow);
  useEffect(() => {
    syncNowRef.current = personalSpace.syncNow;
  });
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') syncNowRef.current();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);
  // The phone app: a device the web signed out finds out and shows itself signed out.
  const spaceErrorMessage = spaceStatus.kind === 'error' ? spaceStatus.message : null;
  const desktopRecheck = auth.available ? auth.desktop?.recheck : undefined;
  useEffect(() => {
    if (spaceErrorMessage !== null) desktopRecheck?.();
  }, [spaceErrorMessage, desktopRecheck]);

  const assetRepository = useMemo(
    () => runtime
      ? (personalSpaceEnabled
        ? personalSpaceAssetRepository(runtime, { requestAsset: personalSpace.requestAsset })
        : runtimeAssetRepository(runtime))
      : null,
    [runtime, personalSpaceEnabled, personalSpace.requestAsset],
  );
  const renderAssetElement = useCallback((element: Parameters<typeof AssetElementPreview>[0]['element']) => (
    assetRepository
      ? createElement(AssetElementPreview, { element, repository: assetRepository, onError: setNotice })
      : null
  ), [assetRepository]);

  // Search opens its index a few seconds after the start, after the page prefetch
  // (see MobileApp), so neither competes with the first screen or the first page.
  const [searchController, setSearchController] = useState<WorkspaceSearchController | null>(null);
  const searchWorkspaceRef = useRef(workspace);
  useEffect(() => {
    searchWorkspaceRef.current = workspace;
  }, [workspace]);
  const workspaceReady = workspace !== null;
  // Opening Search starts the index at once.
  const startSearchRef = useRef<() => void>(() => undefined);
  const requestSearch = useCallback(() => startSearchRef.current(), []);
  useEffect(() => {
    if (!runtime || !workspaceReady) return;
    const controller = new WorkspaceSearchController(runtime);
    let started = false;
    const start = () => {
      const current = searchWorkspaceRef.current;
      if (started || !current) return;
      started = true;
      window.clearTimeout(timer);
      void controller.initialize(current);
      setSearchController(controller);
    };
    const timer = window.setTimeout(start, 6_000);
    startSearchRef.current = start;
    return () => {
      startSearchRef.current = () => undefined;
      window.clearTimeout(timer);
      if (started) controller.dispose();
      setSearchController((current) => (current === controller ? null : current));
    };
  }, [runtime, workspaceReady]);
  useEffect(() => {
    if (searchController && workspace) searchController.updateWorkspace(workspace);
  }, [searchController, workspace]);

  const isAvailable = useCallback(
    (documentId: string) => runtime?.isDocumentAvailable(documentId) ?? false,
    [runtime],
  );

  return {
    phase: startup.phase,
    progress: startup.progress,
    error: startup.error,
    recoveryCode: startup.recoveryCode,
    retry: startup.retry,
    runtime,
    workspace,
    notebooks,
    activeContext,
    openingPageId,
    openError,
    openPage,
    writeSession: shownSession,
    writeFailed: pageWriteFailedFor !== null && pageWriteFailedFor === activePageId,
    commitPage,
    setPagePinned,
    saveState,
    saveError,
    notice,
    setNotice,
    auth,
    personalSpaceEnabled,
    spaceStatus,
    personalSpace,
    uiState,
    deviceId,
    renderAssetElement,
    searchController,
    requestSearch,
    isAvailable,
  };
}
