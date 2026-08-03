import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
} from 'react';
import {
  AlertTriangle,
  CircleHelp,
  CheckCircle2,
  Download,
  Focus,
  HardDrive,
  LoaderCircle,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Search,
  Tag,
  Trash2,
  Type,
  WifiOff,
  X,
} from 'lucide-react';
import { createId } from '../domain/ids';
import {
  createDefaultWorkspace,
  findBundledStartPage,
} from '../domain/sample';
import { MAX_TITLE_BYTES } from '../domain/limits';
import { truncateUtf8 } from '../domain/strings';
import {
  activatePage,
  addPageElement,
  appendNotebook,
  appendPage,
  appendSection,
  createNotebook,
  createPage,
  createSection,
  duplicatePage,
  getActiveContext,
  restoreTrashEntry,
  renameNotebook,
  renameSection,
  reorderPage,
  searchWorkspace,
  trashElement,
  trashNotebook,
  trashPage,
  trashSection,
  updatePage,
  updatePageElement,
} from '../domain/workspace';
import type {
  BrushSettings,
  EditorTool,
  PageTag,
  PageElement,
  TextElement,
  TrashEntry,
  WorkspaceState,
} from '../domain/types';
import { assertWorkspaceShape } from '../domain/validation';
import CanvasEditor, { type CanvasEditorHandle } from '../editor/CanvasEditor';
import {
  downloadDataUrl,
  exportPageMarkdown,
  exportPagePdf,
  exportWorkspaceJson,
  fileToImageElement,
  fileToPdfElement,
  markdownFileToPage,
  parseWorkspaceJson,
  saveWorkspaceBackup,
} from '../io/files';
import {
  activeStorageBackend,
  loadWorkspace,
  saveWorkspace,
  type StorageBackend,
  WorkspaceOpenError,
  type WorkspaceOpenFailureCode,
} from '../storage/workspaceStorage';
import {
  clearRecoveryDraftThrough,
  discardRecoveryDraft,
  loadRecoveryDraft,
  recoveryDraftDiffersFrom,
  saveRecoveryDraft,
  type RecoveryDraft,
} from '../storage/recoveryJournal';
import { canAutosave } from '../storage/persistencePolicy';
import {
  loadUiPreferences,
  saveUiPreferences,
  type UiPreferences,
} from '../ui/preferences';
import GettingStartedPanel from './GettingStartedPanel';
import Inspector from './Inspector';
import Sidebar from './Sidebar';
import Toolbar, { editorToolForKeyboardShortcut } from './Toolbar';

type SaveState = 'loading' | 'saving' | 'saved' | 'error';
type LoadFailureKind = WorkspaceOpenFailureCode | 'storage';

function messageFromError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  if (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof error.message === 'string' &&
    error.message.trim()
  ) {
    return error.message;
  }
  return fallback;
}

function blankTextElement(): TextElement {
  const now = new Date().toISOString();
  return {
    id: createId('text'),
    kind: 'text',
    x: 72,
    y: 72,
    width: 560,
    height: 160,
    text: '',
    color: '#1e2925',
    fontSize: 22,
    fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
    fontWeight: 400,
    fontStyle: 'normal',
    textDecoration: 'none',
    textAlign: 'left',
    listStyle: 'none',
    createdAt: now,
    updatedAt: now,
  };
}

function trashLabel(entry: TrashEntry): string {
  if ('title' in entry.item) return entry.item.title;
  if (entry.item.kind === 'image') return entry.item.name;
  if (entry.item.kind === 'pdf') return entry.item.sourceName;
  if (entry.item.kind === 'text') return entry.item.text.slice(0, 50) || 'Empty text';
  if (entry.item.kind === 'checklist') {
    return entry.item.items[0]?.text || 'Checklist';
  }
  return `${entry.item.tool} stroke`;
}

function shortFilename(title: string): string {
  return (
    title
      .toLocaleLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'canvink-page'
  );
}

function elementLabel(element: PageElement): string {
  if (element.kind === 'text') {
    return `Text: ${element.text.replace(/\s+/g, ' ').slice(0, 48) || 'Empty text'}`;
  }
  if (element.kind === 'stroke') {
    return `${element.tool === 'highlighter' ? 'Highlighter' : 'Pen'} stroke, ${element.points.length} points`;
  }
  if (element.kind === 'image') {
    return `Image: ${element.alt.trim() || element.name}`;
  }
  if (element.kind === 'checklist') {
    const completed = element.items.filter((item) => item.checked).length;
    return `Checklist: ${completed}/${element.items.length} complete`;
  }
  return `PDF: ${element.sourceName}, ${element.pageCount} pages`;
}

const PAGE_TAG_OPTIONS: ReadonlyArray<{ id: PageTag; label: string }> = [
  { id: 'important', label: 'Important' },
  { id: 'todo', label: 'To do' },
  { id: 'question', label: 'Question' },
  { id: 'idea', label: 'Idea' },
];

export default function NotebookApp() {
  const [workspace, setWorkspace] = useState<WorkspaceState>(() => createDefaultWorkspace());
  const [storageReady, setStorageReady] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadFailureKind, setLoadFailureKind] = useState<LoadFailureKind>('storage');
  const [storageBackend, setStorageBackend] = useState<StorageBackend>(() =>
    activeStorageBackend(),
  );
  const [saveState, setSaveState] = useState<SaveState>('loading');
  const [saveErrorMessage, setSaveErrorMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [noticeKind, setNoticeKind] = useState<'status' | 'error'>('status');
  const [recoveryDraft, setRecoveryDraft] = useState<RecoveryDraft | null>(null);
  const [recoveryWarning, setRecoveryWarning] = useState<string | null>(null);
  const [recoveryActionFeedback, setRecoveryActionFeedback] = useState<{
    kind: 'status' | 'error';
    message: string;
  } | null>(null);
  const [tool, setTool] = useState<EditorTool>('pen');
  const [brush, setBrush] = useState<BrushSettings>({ color: '#1e2925', size: 7 });
  const [selectedElementId, setSelectedElementId] = useState<string | null>(null);
  const [hiddenEmptyPromptPageId, setHiddenEmptyPromptPageId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [preferences, setPreferences] = useState<UiPreferences>(() => loadUiPreferences());
  const [guideOpen, setGuideOpen] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [isOnline, setIsOnline] = useState(() => navigator.onLine);
  const [compactLayout, setCompactLayout] = useState(() =>
    window.matchMedia('(max-width: 820px)').matches,
  );
  const [sidebarOpen, setSidebarOpen] = useState(() =>
    window.matchMedia('(min-width: 821px)').matches,
  );
  const [trashOpen, setTrashOpen] = useState(false);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const pdfInputRef = useRef<HTMLInputElement>(null);
  const portableInputRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<CanvasEditorHandle>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const pageTitleRef = useRef<HTMLInputElement>(null);
  const sidebarToggleRef = useRef<HTMLButtonElement>(null);
  const guideTriggerRef = useRef<HTMLButtonElement>(null);
  const sidebarNavigationRef = useRef<HTMLDivElement>(null);
  const workspaceShellRef = useRef<HTMLElement>(null);
  const workspaceRef = useRef(workspace);
  const storageReadyRef = useRef(storageReady);
  const loadFailedRef = useRef(loadFailed);
  const dirtyRevisionRef = useRef(0);
  const savedRevisionRef = useRef(0);
  const saveTimerRef = useRef<number | null>(null);
  const recoveryTimerRef = useRef<number | null>(null);
  const recoverySessionIdRef = useRef(createId('recovery'));
  const skipNextAutosaveRef = useRef(false);
  const closingRef = useRef(false);
  const flushSaveRef = useRef<() => Promise<void>>(async () => undefined);
  const trashDialogRef = useRef<HTMLElement>(null);
  const trashReturnFocusRef = useRef<HTMLElement | null>(null);
  const deferredQuery = useDeferredValue(searchQuery);
  const context = getActiveContext(workspace);
  const searchResults = useMemo(
    () => searchWorkspace(workspace, deferredQuery),
    [deferredQuery, workspace],
  );
  const selectedElement =
    context?.page.elements.find((element) => element.id === selectedElementId) ?? null;
  const closeSidebar = useCallback((restoreFocus = true) => {
    setSidebarOpen(false);
    if (restoreFocus) {
      window.requestAnimationFrame(() => sidebarToggleRef.current?.focus());
    }
  }, []);
  const closeTrash = useCallback(() => {
    setTrashOpen(false);
    window.requestAnimationFrame(() => trashReturnFocusRef.current?.focus());
  }, []);

  const persistSnapshot = useCallback(
    async (snapshot: WorkspaceState, revision: number): Promise<void> => {
      try {
        const backend = await saveWorkspace(snapshot);
        savedRevisionRef.current = Math.max(savedRevisionRef.current, revision);
        void clearRecoveryDraftThrough({
          sessionId: recoverySessionIdRef.current,
          revision,
        })
          .then(() => {
            if (revision === dirtyRevisionRef.current) setRecoveryWarning(null);
          })
          .catch((error: unknown) => {
            if (revision === dirtyRevisionRef.current) {
              setRecoveryWarning(
                `Your note is saved, but the temporary recovery draft could not be cleared. ${messageFromError(error, 'You can keep editing safely.')}`,
              );
            }
          });
        if (revision === dirtyRevisionRef.current) {
          setStorageBackend(backend);
          setSaveState('saved');
          setSaveErrorMessage(null);
        }
      } catch (error) {
        if (revision === dirtyRevisionRef.current) {
          const message = messageFromError(error, 'Autosave failed.');
          setSaveState('error');
          setSaveErrorMessage(message);
        }
        throw error;
      }
    },
    [],
  );

  const flushLatestWorkspace = useCallback(async (): Promise<void> => {
    if (
      !canAutosave({
        storageReady: storageReadyRef.current,
        loadFailed: loadFailedRef.current,
      })
    ) {
      return;
    }
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }

    const revision = dirtyRevisionRef.current;
    if (revision <= savedRevisionRef.current) return;
    await persistSnapshot(structuredClone(workspaceRef.current), revision);
  }, [persistSnapshot]);

  const flushRecoveryDraft = useCallback(async (): Promise<void> => {
    const revision = dirtyRevisionRef.current;
    if (
      revision <= savedRevisionRef.current ||
      !canAutosave({
        storageReady: storageReadyRef.current,
        loadFailed: loadFailedRef.current,
      })
    ) {
      return;
    }
    if (recoveryTimerRef.current !== null) {
      window.clearTimeout(recoveryTimerRef.current);
      recoveryTimerRef.current = null;
    }
    await saveRecoveryDraft(workspaceRef.current, {
      sessionId: recoverySessionIdRef.current,
      revision,
    });
  }, []);

  useEffect(() => {
    workspaceRef.current = workspace;
  }, [workspace]);

  useEffect(() => {
    storageReadyRef.current = storageReady;
    loadFailedRef.current = loadFailed;
  }, [loadFailed, storageReady]);

  useEffect(() => {
    flushSaveRef.current = flushLatestWorkspace;
  }, [flushLatestWorkspace]);

  useEffect(() => {
    const updateOnlineState = () => setIsOnline(navigator.onLine);
    window.addEventListener('online', updateOnlineState);
    window.addEventListener('offline', updateOnlineState);
    return () => {
      window.removeEventListener('online', updateOnlineState);
      window.removeEventListener('offline', updateOnlineState);
    };
  }, []);

  useEffect(() => {
    const media = window.matchMedia('(max-width: 820px)');
    const handleLayoutChange = (event: MediaQueryListEvent) => {
      setCompactLayout(event.matches);
      if (event.matches) {
        setGuideOpen(false);
        trashReturnFocusRef.current = sidebarToggleRef.current;
        closeSidebar(
          sidebarNavigationRef.current?.contains(document.activeElement) ?? false,
        );
      }
    };
    media.addEventListener('change', handleLayoutChange);
    return () => media.removeEventListener('change', handleLayoutChange);
  }, [closeSidebar]);

  useEffect(() => {
    let active = true;
    loadWorkspace()
      .then(async (result) => {
        let pendingRecovery: RecoveryDraft | null = null;
        let recoveryLoadWarning: string | null = null;
        try {
          const draft = await loadRecoveryDraft();
          if (draft && recoveryDraftDiffersFrom(draft, result.workspace)) {
            pendingRecovery = draft;
          } else if (draft) {
            await discardRecoveryDraft(draft);
          }
        } catch (error) {
          recoveryLoadWarning = `Saved notes opened normally, but a temporary recovery draft could not be checked. ${messageFromError(error, 'The recovery data was left unchanged.')}`;
        }
        return { result, pendingRecovery, recoveryLoadWarning };
      })
      .then(({ result, pendingRecovery, recoveryLoadWarning }) => {
        if (!active) return;
        workspaceRef.current = result.workspace;
        dirtyRevisionRef.current = 0;
        savedRevisionRef.current = 0;
        skipNextAutosaveRef.current = true;
        storageReadyRef.current = true;
        loadFailedRef.current = false;
        setWorkspace(result.workspace);
        setStorageBackend(result.backend);
        setSaveState('saved');
        setSaveErrorMessage(null);
        setLoadFailed(false);
        setStorageReady(true);
        setRecoveryDraft(pendingRecovery);
        setRecoveryWarning(recoveryLoadWarning);
        const loadedContext = getActiveContext(result.workspace);
        setGuideOpen(
          !loadUiPreferences().guideDismissed &&
            loadedContext?.page.title === 'Quick note' &&
            loadedContext.page.elements.length === 0,
        );
      })
      .catch((error: unknown) => {
        if (!active) return;
        loadFailedRef.current = true;
        setLoadFailureKind(
          error instanceof WorkspaceOpenError ? error.code : 'storage',
        );
        setNotice(messageFromError(error, 'Could not load the local workspace.'));
        setSaveState('error');
        setLoadFailed(true);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const shell = workspaceShellRef.current;
    if (!sidebarOpen || !compactLayout) {
      shell?.removeAttribute('inert');
      return undefined;
    }

    shell?.setAttribute('inert', '');
    const navigation = sidebarNavigationRef.current;
    const focusableElements = () =>
      navigation
        ? [...navigation.querySelectorAll<HTMLElement>(
            'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
          )].filter((element) => element.offsetParent !== null)
        : [];

    window.requestAnimationFrame(() => focusableElements()[0]?.focus());
    const handleNavigationKeyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeSidebar();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = focusableElements();
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleNavigationKeyboard, true);
    return () => {
      shell?.removeAttribute('inert');
      document.removeEventListener('keydown', handleNavigationKeyboard, true);
    };
  }, [closeSidebar, compactLayout, sidebarOpen]);

  useEffect(() => {
    if (!canAutosave({ storageReady, loadFailed })) return undefined;
    if (skipNextAutosaveRef.current) {
      skipNextAutosaveRef.current = false;
      return undefined;
    }

    const revision = dirtyRevisionRef.current + 1;
    dirtyRevisionRef.current = revision;
    setSaveState('saving');
    if (recoveryTimerRef.current !== null) {
      window.clearTimeout(recoveryTimerRef.current);
    }
    recoveryTimerRef.current = window.setTimeout(() => {
      recoveryTimerRef.current = null;
      void saveRecoveryDraft(workspace, {
        sessionId: recoverySessionIdRef.current,
        revision,
      })
        .then(() => {
          if (revision === dirtyRevisionRef.current) setRecoveryWarning(null);
        })
        .catch((error: unknown) => {
          if (revision === dirtyRevisionRef.current) {
            setRecoveryWarning(
              `Crash recovery could not protect the latest unsaved edit. ${messageFromError(error, 'Autosave will still continue.')}`,
            );
          }
        });
    }, 180);
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      void persistSnapshot(structuredClone(workspaceRef.current), revision).catch(
        () => undefined,
      );
    }, 650);
    return () => {
      if (recoveryTimerRef.current !== null) {
        window.clearTimeout(recoveryTimerRef.current);
        recoveryTimerRef.current = null;
      }
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
  }, [loadFailed, persistSnapshot, storageReady, workspace]);

  useEffect(() => {
    if (!storageReady || loadFailed) return undefined;

    const hasUnsavedChanges = () =>
      dirtyRevisionRef.current > savedRevisionRef.current;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!hasUnsavedChanges()) return;
      void flushRecoveryDraft().catch(() => undefined);
      void flushSaveRef.current().catch(() => undefined);
      event.preventDefault();
      event.returnValue = '';
    };
    const handlePageHide = () => {
      if (hasUnsavedChanges()) {
        void flushRecoveryDraft().catch(() => undefined);
        void flushSaveRef.current().catch(() => undefined);
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    window.addEventListener('pagehide', handlePageHide);

    let unlistenClose: (() => void) | undefined;
    let disposed = false;
    if (activeStorageBackend() === 'tauri') {
      void import('@tauri-apps/api/window')
        .then(({ getCurrentWindow }) =>
          getCurrentWindow().onCloseRequested(async (event) => {
            if (closingRef.current || !hasUnsavedChanges()) return;
            event.preventDefault();
            closingRef.current = true;
            try {
              await flushSaveRef.current();
              await getCurrentWindow().destroy();
            } catch {
              closingRef.current = false;
            }
          }),
        )
        .then((unlisten) => {
          if (disposed) {
            unlisten();
          } else {
            unlistenClose = unlisten;
          }
        })
        .catch((error: unknown) => {
          setSaveState('error');
          setNoticeKind('error');
          setNotice(
            messageFromError(error, 'Could not install the safe-close handler.'),
          );
        });
    }

    return () => {
      disposed = true;
      unlistenClose?.();
      window.removeEventListener('beforeunload', handleBeforeUnload);
      window.removeEventListener('pagehide', handlePageHide);
    };
  }, [flushRecoveryDraft, loadFailed, storageReady]);

  useEffect(() => {
    if (!trashOpen) return undefined;
    const dialog = trashDialogRef.current;
    if (!dialog) return undefined;

    const focusableElements = () =>
      [...dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )].filter((element) => element.offsetParent !== null);
    focusableElements()[0]?.focus();

    const handleDialogKeyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeTrash();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = focusableElements();
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleDialogKeyboard, true);
    return () => document.removeEventListener('keydown', handleDialogKeyboard, true);
  }, [closeTrash, trashOpen]);

  useEffect(() => {
    const handleKeyboard = (event: KeyboardEvent) => {
      if (
        trashOpen ||
        (compactLayout && sidebarOpen) ||
        event.ctrlKey ||
        event.metaKey
      ) {
        return;
      }
      const target = event.target as HTMLElement | null;
      if (
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.tagName === 'SELECT' ||
        target?.isContentEditable
      ) {
        return;
      }

      if (event.altKey && event.shiftKey) {
        const nextTool = editorToolForKeyboardShortcut(event);
        if (nextTool) {
          event.preventDefault();
          setTool(nextTool);
          if (nextTool !== 'select' && context) {
            setHiddenEmptyPromptPageId(context.page.id);
          }
        }
        return;
      }
      if (event.altKey) return;

      const canvasOwnsKeyboard =
        !target ||
        target === document.body ||
        Boolean(target.closest('.canvas-page'));
      if (!canvasOwnsKeyboard) return;

      if (
        (event.key === 'Delete' || event.key === 'Backspace') &&
        selectedElementId &&
        context
      ) {
        event.preventDefault();
        setWorkspace((current) => trashElement(current, context.page.id, selectedElementId));
        setSelectedElementId(null);
      }

      const movement = {
        ArrowLeft: { x: -1, y: 0 },
        ArrowRight: { x: 1, y: 0 },
        ArrowUp: { x: 0, y: -1 },
        ArrowDown: { x: 0, y: 1 },
      }[event.key];
      if (movement && selectedElement && context) {
        event.preventDefault();
        const distance = event.shiftKey ? 10 : 1;
        setWorkspace((current) =>
          updatePageElement(current, context.page.id, selectedElement.id, {
            x: selectedElement.x + movement.x * distance,
            y: selectedElement.y + movement.y * distance,
          }),
        );
      }
    };
    window.addEventListener('keydown', handleKeyboard);
    return () => window.removeEventListener('keydown', handleKeyboard);
  }, [
    compactLayout,
    context,
    selectedElement,
    selectedElementId,
    sidebarOpen,
    trashOpen,
  ]);

  const restorePendingRecovery = () => {
    if (!recoveryDraft) return;
    workspaceRef.current = recoveryDraft.workspace;
    dirtyRevisionRef.current = 0;
    savedRevisionRef.current = 0;
    skipNextAutosaveRef.current = false;
    setSelectedElementId(null);
    setGuideOpen(false);
    setRecoveryActionFeedback(null);
    setRecoveryWarning(null);
    setRecoveryDraft(null);
    setWorkspace(recoveryDraft.workspace);
  };

  const keepSavedWorkspace = async () => {
    if (!recoveryDraft) return;
    setRecoveryActionFeedback(null);
    try {
      const discarded = await discardRecoveryDraft(recoveryDraft);
      if (!discarded) {
        setRecoveryActionFeedback({
          kind: 'error',
          message: 'The recovery draft changed before it could be discarded. Reload and review it again.',
        });
        return;
      }
      setRecoveryDraft(null);
    } catch (error) {
      setRecoveryActionFeedback({
        kind: 'error',
        message: messageFromError(error, 'The recovery draft could not be discarded.'),
      });
    }
  };

  const downloadPendingRecovery = () => {
    if (!recoveryDraft) return;
    try {
      exportWorkspaceJson(recoveryDraft.workspace);
      setRecoveryActionFeedback({
        kind: 'status',
        message: 'Recovery copy download started. Confirm that the JSON file appears in Downloads.',
      });
    } catch (error) {
      setRecoveryActionFeedback({
        kind: 'error',
        message: messageFromError(error, 'The recovery copy could not be downloaded.'),
      });
    }
  };

  if (!storageReady) {
    if (loadFailed) {
      const failure = {
        'writer-conflict': {
          title: 'Canvink is already open in another tab.',
          detail:
            'Only one browser tab can edit this local workspace at a time. Close the other Canvink tab, then try again here.',
          safety: 'Your stored notes were not changed by this tab.',
        },
        'coordination-unavailable': {
          title: 'This browser cannot safely edit the workspace.',
          detail:
            'Canvink needs browser write coordination to prevent two tabs from overwriting each other. Use a current browser with Web Locks support or the desktop app.',
          safety: 'Your stored notes were not changed.',
        },
        storage: {
          title: 'Your local workspace could not be opened.',
          detail: notice ?? 'Canvink could not verify the stored data.',
          safety: 'Editing stays disabled so placeholder data cannot overwrite your notes.',
        },
      }[loadFailureKind];
      return (
        <main
          className="fatal-state"
          role="alert"
          data-failure-kind={loadFailureKind}
        >
          <AlertTriangle />
          <h1>{failure.title}</h1>
          <p>{failure.detail}</p>
          <p>{failure.safety}</p>
          <button type="button" onClick={() => window.location.reload()}>
            Try again
          </button>
        </main>
      );
    }

    return (
      <main className="fatal-state" aria-live="polite">
        <LoaderCircle className="spin" />
        <h1>Opening your local workspace</h1>
        <p>The editor will unlock after stored data has been checked.</p>
      </main>
    );
  }

  if (recoveryDraft) {
    return (
      <main className="fatal-state fatal-state--recovery">
        <section
          className="recovery-card"
          role="dialog"
          aria-modal="true"
          aria-labelledby="recovery-title"
          aria-describedby="recovery-description"
        >
          <RefreshCw aria-hidden="true" />
          <p className="recovery-card__eyebrow">Unsaved work found</p>
          <h1 id="recovery-title">Resume your last editing draft?</h1>
          <p id="recovery-description">
            Canvink found a valid temporary draft from{' '}
            <time dateTime={recoveryDraft.capturedAt}>
              {new Date(recoveryDraft.capturedAt).toLocaleString()}
            </time>
            . It has not replaced your last saved workspace.
          </p>
          <div className="recovery-card__actions">
            <button type="button" onClick={restorePendingRecovery}>
              <RefreshCw size={16} />
              Restore unsaved draft
            </button>
            <button type="button" onClick={() => void keepSavedWorkspace()}>
              Keep last saved copy
            </button>
            <button type="button" onClick={downloadPendingRecovery}>
              <Download size={16} />
              Download draft first
            </button>
          </div>
          {recoveryActionFeedback ? (
            <p
              className={`recovery-card__feedback ${recoveryActionFeedback.kind === 'error' ? 'recovery-card__feedback--error' : ''}`}
              role={recoveryActionFeedback.kind === 'error' ? 'alert' : 'status'}
            >
              {recoveryActionFeedback.message}
            </p>
          ) : null}
        </section>
      </main>
    );
  }

  if (!context) {
    return (
      <main className="fatal-state">
        <AlertTriangle />
        <h1>This workspace has no usable page.</h1>
        <button type="button" onClick={() => setWorkspace(createDefaultWorkspace())}>
          Restore the welcome notebook
        </button>
      </main>
    );
  }

  const showNotice = (
    message: string,
    kind: 'status' | 'error' = 'status',
  ) => {
    setNoticeKind(kind);
    setNotice(message);
    window.setTimeout(() => setNotice((current) => (current === message ? null : current)), 4200);
  };

  const showOperationError = (operation: string, error: unknown) => {
    showNotice(
      `${operation} failed. ${messageFromError(error, 'Try again or choose another export format.')}`,
      'error',
    );
  };

  const runSynchronousExport = (
    operation: string,
    exportAction: () => void,
    successMessage?: string,
  ) => {
    try {
      exportAction();
      if (successMessage) showNotice(successMessage);
    } catch (error) {
      showOperationError(operation, error);
    }
  };

  const addElement = (
    element: PageElement,
    pageId = context.page.id,
  ): boolean => {
    const candidate = addPageElement(workspaceRef.current, pageId, element);
    if (candidate === workspaceRef.current) {
      showNotice('The destination page is no longer available. Nothing was imported.');
      return false;
    }
    try {
      assertWorkspaceShape(candidate);
      workspaceRef.current = candidate;
      setWorkspace(candidate);
      return true;
    } catch (error) {
      showNotice(
        messageFromError(error, 'This object would exceed the safe workspace limits.'),
      );
      return false;
    }
  };

  const updateElement = (elementId: string, patch: Partial<PageElement>) => {
    const candidate = updatePageElement(
      workspaceRef.current,
      context.page.id,
      elementId,
      patch,
    );
    try {
      assertWorkspaceShape(candidate);
      workspaceRef.current = candidate;
      setWorkspace(candidate);
    } catch (error) {
      showNotice(messageFromError(error, 'This change is not valid.'));
    }
  };

  const removeElement = (elementId: string) => {
    setWorkspace((current) => trashElement(current, context.page.id, elementId));
    if (selectedElementId === elementId) setSelectedElementId(null);
  };

  const importImage = async (file?: File) => {
    if (!file) return;
    const targetPageId = context.page.id;
    try {
      const element = await fileToImageElement(file);
      if (!addElement(element, targetPageId)) return;
      setSelectedElementId(element.id);
      setTool('select');
      showNotice(`Added ${file.name}.`);
    } catch (error) {
      showNotice(messageFromError(error, 'Image import failed.'));
    }
  };

  const importPdf = async (file?: File) => {
    if (!file) return;
    const targetPageId = context.page.id;
    showNotice(`Rendering a preview of ${file.name}…`);
    try {
      const element = await fileToPdfElement(file);
      if (!addElement(element, targetPageId)) return;
      setSelectedElementId(element.id);
      setTool('select');
      showNotice(`Added a ${element.pageCount}-page PDF preview.`);
    } catch (error) {
      showNotice(messageFromError(error, 'PDF import failed.'));
    }
  };

  const portableImport = async (file?: File) => {
    if (!file) return;
    const targetNotebookId = context.notebook.id;
    const targetSectionId = context.section.id;
    try {
      if (/\.json$/i.test(file.name) || file.type === 'application/json') {
        const imported = await parseWorkspaceJson(file);
        const confirmed = window.confirm(
          'Replace this entire workspace with the selected export? The next step saves a JSON backup of the current workspace before replacement.',
        );
        if (!confirmed) {
          showNotice('Workspace replacement cancelled.');
          return;
        }
        const backupResult = await saveWorkspaceBackup(workspaceRef.current);
        if (
          backupResult === 'download-started' &&
          !window.confirm(
            'Confirm that the backup download finished and the JSON file is safely stored. Replace the workspace now?',
          )
        ) {
          showNotice('Workspace replacement cancelled. The current workspace was kept.');
          return;
        }
        workspaceRef.current = imported;
        setWorkspace(imported);
        showNotice('Workspace replaced after saving a backup. Saving locally now.');
      } else {
        const page = await markdownFileToPage(file);
        const candidate = appendPage(
          workspaceRef.current,
          targetNotebookId,
          targetSectionId,
          page,
        );
        if (candidate === workspaceRef.current) {
          showNotice('The destination section is no longer available. Nothing was imported.');
          return;
        }
        assertWorkspaceShape(candidate);
        workspaceRef.current = candidate;
        setWorkspace(candidate);
        showNotice(`Imported ${file.name} as an editable page.`);
      }
    } catch (error) {
      showNotice(messageFromError(error, 'Import failed.'));
    }
  };

  const handleDrop = async (event: DragEvent) => {
    event.preventDefault();
    const file = event.dataTransfer.files[0];
    if (!file) return;
    if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
      await importPdf(file);
    } else if (file.type.startsWith('image/')) {
      await importImage(file);
    } else if (
      file.type === 'application/json' ||
      file.type === 'text/markdown' ||
      file.type === 'text/plain' ||
      /\.(json|md)$/i.test(file.name)
    ) {
      await portableImport(file);
    } else {
      showNotice('Drop a PNG, JPEG, WebP, GIF, PDF, JSON export, or Markdown file.');
    }
  };

  const dismissGuide = () => {
    setGuideOpen(false);
    const nextPreferences: UiPreferences = {
      ...preferences,
      guideDismissed: true,
    };
    setPreferences(nextPreferences);
    saveUiPreferences(nextPreferences);
    window.requestAnimationFrame(() => guideTriggerRef.current?.focus());
  };

  const changeTextSize = (textSize: UiPreferences['textSize']) => {
    const nextPreferences: UiPreferences = {
      ...preferences,
      textSize,
    };
    setPreferences(nextPreferences);
    saveUiPreferences(nextPreferences);
  };

  const startTextOnPage = (snapshot: WorkspaceState, pageId: string) => {
    const active = getActiveContext(snapshot);
    const targetPage = active?.page.id === pageId
      ? active.page
      : snapshot.notebooks
          .flatMap((notebook) => notebook.sections)
          .flatMap((section) => section.pages)
          .find((page) => page.id === pageId);
    const existingEmptyText = targetPage?.elements.find(
      (element) => element.kind === 'text' && element.text.trim() === '',
    );
    if (existingEmptyText) {
      workspaceRef.current = snapshot;
      setWorkspace(snapshot);
      setSelectedElementId(existingEmptyText.id);
      setTool('select');
      editorRef.current?.editText(existingEmptyText.id);
      return;
    }

    const element = blankTextElement();
    const candidate = addPageElement(snapshot, pageId, element);
    try {
      assertWorkspaceShape(candidate);
      workspaceRef.current = candidate;
      setWorkspace(candidate);
      setSelectedElementId(element.id);
      setTool('select');
      editorRef.current?.editText(element.id);
    } catch (error) {
      showNotice(messageFromError(error, 'A text note could not be added safely.'));
    }
  };

  const startQuickNote = () => {
    let candidate = workspaceRef.current;
    const active = getActiveContext(candidate);
    if (!active) return;

    const notebook = candidate.notebooks.find((item) => item.id === active.notebook.id);
    const notesSection =
      notebook?.sections.find((section) => section.title === 'Notes') ?? active.section;
    let targetPage =
      active.page.title === 'Quick note' &&
      active.page.elements.every(
        (element) => element.kind === 'text' && element.text.trim() === '',
      )
        ? active.page
        : notesSection.pages.find(
            (page) =>
              page.title === 'Quick note' &&
              page.elements.every(
                (element) => element.kind === 'text' && element.text.trim() === '',
              ),
          );

    if (!targetPage) {
      targetPage = createPage('Quick note', 'free');
      candidate = appendPage(candidate, active.notebook.id, notesSection.id, targetPage);
    } else {
      candidate = activatePage(candidate, active.notebook.id, notesSection.id, targetPage.id);
    }

    setGuideOpen(false);
    startTextOnPage(candidate, targetPage.id);
  };

  const openExample = () => {
    const example = findBundledStartPage(workspaceRef.current);
    if (example) {
      const candidate = activatePage(
        workspaceRef.current,
        example.notebook.id,
        example.section.id,
        example.page.id,
      );
      workspaceRef.current = candidate;
      setWorkspace(candidate);
      setSelectedElementId(null);
      setGuideOpen(false);
      window.requestAnimationFrame(() => pageTitleRef.current?.focus());
      return;
    }
    showNotice('The example page is not available in this workspace.');
  };

  const focusSearch = () => {
    setGuideOpen(false);
    window.requestAnimationFrame(() => searchInputRef.current?.focus());
  };

  const clearSearch = () => {
    setSearchQuery('');
    window.requestAnimationFrame(() => searchInputRef.current?.focus());
  };

  const retrySave = () => {
    setSaveState('saving');
    void flushLatestWorkspace().catch(() => undefined);
  };

  const downloadRescueCopy = () => {
    runSynchronousExport(
      'Rescue copy download',
      () => exportWorkspaceJson(workspaceRef.current),
      'Rescue copy download started. Confirm that the JSON file appears in Downloads.',
    );
  };

  const addPage = (sectionId: string, parentPageId?: string) => {
    const page = createPage(parentPageId ? 'Untitled subpage' : 'Untitled page', 'free', parentPageId);
    const candidate = appendPage(
      workspaceRef.current,
      context.notebook.id,
      sectionId,
      page,
    );
    if (candidate === workspaceRef.current) {
      showNotice('Pages support at most 64 nested subpage levels.');
      return;
    }
    workspaceRef.current = candidate;
    setSelectedElementId(null);
    setWorkspace(candidate);
    window.requestAnimationFrame(() => pageTitleRef.current?.focus());
  };

  const activateNotebook = (notebookId: string) => {
    const notebook = workspace.notebooks.find((item) => item.id === notebookId);
    const section = notebook?.sections[0];
    const page = section?.pages[0];
    if (notebook && section && page) {
      setWorkspace((current) => activatePage(current, notebook.id, section.id, page.id));
    }
  };

  const saveIndicator = {
    loading: { icon: LoaderCircle, label: 'Opening local data' },
    saving: { icon: LoaderCircle, label: 'Saving locally' },
    saved: { icon: CheckCircle2, label: 'Saved locally' },
    error: { icon: AlertTriangle, label: 'Save needs attention' },
  }[saveState];
  const SaveIcon = saveIndicator.icon;
  const activePageTags = context.page.tags ?? [];

  const togglePageTag = (tag: PageTag) => {
    setWorkspace((current) =>
      updatePage(current, context.page.id, (page) => {
        const tags = page.tags ?? [];
        const removing = tags.includes(tag);
        const nextTags = removing
          ? tags.filter((candidate) => candidate !== tag)
          : [...tags, tag];
        return {
          ...page,
          tags: nextTags.length ? nextTags : undefined,
          ...(tag === 'todo'
            ? { taskState: removing ? undefined : page.taskState ?? 'open' }
            : {}),
        };
      }),
    );
  };

  return (
    <main
      className={[
        'notebook-app',
        sidebarOpen ? '' : 'sidebar-is-closed',
        focusMode ? 'focus-mode' : '',
        preferences.textSize === 'large' ? 'ui-text-large' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <a className="skip-link" href="#page-editor">
        Skip to the page editor
      </a>
      {sidebarOpen ? (
        <Sidebar
          ref={sidebarNavigationRef}
          id="notebook-navigation"
          modal={compactLayout}
          notebooks={workspace.notebooks}
          activeNotebookId={workspace.activeNotebookId}
          activeSectionId={workspace.activeSectionId}
          activePageId={workspace.activePageId}
          trashCount={workspace.trash.length}
          onClose={() => closeSidebar(compactLayout)}
          onActivatePage={(notebookId, sectionId, pageId) => {
            setWorkspace((current) => activatePage(current, notebookId, sectionId, pageId));
            setSelectedElementId(null);
            if (compactLayout) {
              closeSidebar(false);
              window.requestAnimationFrame(() => pageTitleRef.current?.focus());
            }
          }}
          onActivateNotebook={activateNotebook}
          onAddNotebook={() =>
            setWorkspace((current) => appendNotebook(current, createNotebook()))
          }
          onRenameNotebook={() => {
            const title = window.prompt('Notebook name', context.notebook.title);
            if (title) {
              setWorkspace((current) =>
                renameNotebook(current, context.notebook.id, title),
              );
            }
          }}
          onAddSection={() =>
            setWorkspace((current) =>
              appendSection(current, context.notebook.id, createSection()),
            )
          }
          onRenameSection={(sectionId) => {
            const section = context.notebook.sections.find((item) => item.id === sectionId);
            const title = window.prompt('Section name', section?.title ?? '');
            if (title) {
              setWorkspace((current) =>
                renameSection(
                  current,
                  context.notebook.id,
                  sectionId,
                  title,
                ),
              );
            }
          }}
          onAddPage={addPage}
          onTrashNotebook={() =>
            setWorkspace((current) => trashNotebook(current, context.notebook.id))
          }
          onTrashSection={(sectionId) =>
            setWorkspace((current) =>
              trashSection(current, context.notebook.id, sectionId),
            )
          }
          onTrashPage={(sectionId, pageId) =>
            setWorkspace((current) =>
              trashPage(current, context.notebook.id, sectionId, pageId),
            )
          }
          onDuplicatePage={(sectionId, pageId) => {
            setWorkspace((current) =>
              duplicatePage(current, context.notebook.id, sectionId, pageId),
            );
            setSelectedElementId(null);
          }}
          onReorderPage={(sectionId, pageId, direction) =>
            setWorkspace((current) =>
              reorderPage(
                current,
                context.notebook.id,
                sectionId,
                pageId,
                direction,
              ),
            )
          }
          onOpenTrash={() => {
            setGuideOpen(false);
            trashReturnFocusRef.current = compactLayout
              ? sidebarToggleRef.current
              : document.activeElement instanceof HTMLElement
                ? document.activeElement
                : null;
            if (compactLayout) {
              closeSidebar(false);
            }
            setTrashOpen(true);
          }}
        />
      ) : null}
      {sidebarOpen ? (
        <button
          type="button"
          className="sidebar-scrim"
          aria-label="Close notebook navigation"
          aria-hidden="true"
          tabIndex={-1}
          onClick={() => closeSidebar()}
        />
      ) : null}

      <section ref={workspaceShellRef} className="workspace-shell">
        <header className="app-topbar">
          <button
            ref={sidebarToggleRef}
            type="button"
            className="sidebar-toggle"
            onClick={() => {
              setFocusMode(false);
              if (!sidebarOpen && compactLayout) {
                setGuideOpen(false);
              }
              setSidebarOpen(!sidebarOpen);
            }}
            aria-label={sidebarOpen ? 'Hide notebook navigation' : 'Show notebook navigation'}
            aria-controls="notebook-navigation"
            aria-expanded={sidebarOpen}
          >
            {sidebarOpen ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}
          </button>
          <button
            type="button"
            className="topbar-action topbar-action--primary"
            onClick={startQuickNote}
          >
            <Type size={16} />
            <span>Quick note</span>
          </button>
          <div className="breadcrumbs" aria-label="Current page location">
            <span>{context.notebook.title}</span>
            <i>/</i>
            <span>{context.section.title}</span>
          </div>
          <div className="search-box" role="search">
            <Search size={16} />
            <input
              ref={searchInputRef}
              type="search"
              placeholder="Search notes, tag:todo, is:open"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              aria-label="Search workspace"
            />
            {searchQuery ? (
              <button type="button" onClick={clearSearch} aria-label="Clear search">
                <X size={14} />
              </button>
            ) : null}
            {deferredQuery ? (
              <div
                id="workspace-search-results"
                className="search-results"
                role="region"
                aria-label="Search results"
              >
                {searchResults.length ? (
                  searchResults.map((result) => (
                    <button
                      type="button"
                      key={result.id}
                      onClick={() => {
                        setWorkspace((current) =>
                          activatePage(
                            current,
                            result.notebookId,
                            result.sectionId,
                            result.pageId,
                          ),
                        );
                        setSelectedElementId(result.elementId ?? null);
                        setSearchQuery('');
                        window.requestAnimationFrame(() => pageTitleRef.current?.focus());
                      }}
                    >
                      <span>{result.title}</span>
                      <small>{result.excerpt}</small>
                    </button>
                  ))
                ) : (
                  <div
                    className="search-empty-state"
                    data-empty-kind="search"
                    role="status"
                  >
                    <strong>No matching notes</strong>
                    <p>Try a shorter phrase or start a new quick note.</p>
                    <div>
                      <button type="button" onClick={clearSearch}>
                        Clear search
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setSearchQuery('');
                          startQuickNote();
                        }}
                      >
                        Quick note
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ) : null}
          </div>
          <div className="topbar-actions">
            <button
              ref={guideTriggerRef}
              type="button"
              className="topbar-action"
              aria-label="Guide and display"
              aria-controls="getting-started-panel"
              aria-expanded={guideOpen}
              onClick={() => {
                if (guideOpen) {
                  dismissGuide();
                } else {
                  setGuideOpen(true);
                }
              }}
            >
              <CircleHelp size={16} />
              <span>Guide</span>
            </button>
            <button
              type="button"
              className="topbar-action"
              aria-pressed={focusMode}
              aria-label={focusMode ? 'Exit focus mode' : 'Enter focus mode'}
              onClick={() => {
                if (focusMode) {
                  setFocusMode(false);
                  if (!compactLayout) setSidebarOpen(true);
                } else {
                  setFocusMode(true);
                  setSidebarOpen(false);
                }
              }}
            >
              <Focus size={16} />
              <span>Focus</span>
            </button>
          </div>
          <div
            className={`save-indicator save-indicator--${saveState}`}
            title={`Using ${storageBackend}`}
            role="status"
            aria-live="polite"
            data-testid="save-status"
            data-state={saveState}
          >
            <SaveIcon size={15} className={saveState === 'saving' || saveState === 'loading' ? 'spin' : ''} />
            <span>{saveIndicator.label}</span>
            <HardDrive size={13} />
          </div>
        </header>

        <div className="status-stack" aria-live="polite">
          {!isOnline ? (
            <div
              className="status-banner status-banner--offline"
              data-testid="offline-status"
              role="status"
            >
              <WifiOff size={17} />
              <p>
                {storageBackend === 'tauri'
                  ? 'This desktop app edits and saves locally without a network connection.'
                  : 'Browser reports offline. Editing and local saves continue here. Reopening works after the offline app shell has been cached.'}
              </p>
            </div>
          ) : null}
          {recoveryWarning ? (
            <div
              className="status-banner status-banner--warning"
              data-testid="recovery-warning"
              role="alert"
            >
              <AlertTriangle size={17} />
              <p>{recoveryWarning}</p>
              <div className="status-banner__actions">
                <button type="button" onClick={() => setRecoveryWarning(null)}>
                  Dismiss
                </button>
              </div>
            </div>
          ) : null}
          {saveErrorMessage ? (
            <div className="status-banner status-banner--error" role="alert">
              <AlertTriangle size={17} />
              <div>
                <strong>Changes are not saved yet.</strong>
                <p>{saveErrorMessage}</p>
              </div>
              <div className="status-banner__actions">
                <button type="button" onClick={retrySave}>
                  <RefreshCw size={15} />
                  Retry save
                </button>
                <button type="button" onClick={downloadRescueCopy}>
                  <Download size={15} />
                  Download rescue copy
                </button>
              </div>
            </div>
          ) : null}
        </div>

        <Toolbar
          tool={tool}
          brush={brush}
          pageMode={context.page.mode}
          onToolChange={(nextTool) => {
            setTool(nextTool);
            if (nextTool !== 'select') {
              setHiddenEmptyPromptPageId(context.page.id);
            }
          }}
          onBrushChange={setBrush}
          onPageModeChange={(mode) =>
            setWorkspace((current) =>
              updatePage(current, context.page.id, (page) => ({ ...page, mode })),
            )
          }
          onImportImage={() => imageInputRef.current?.click()}
          onImportPdf={() => pdfInputRef.current?.click()}
          onPortableImport={() => portableInputRef.current?.click()}
          onExportJson={() =>
            runSynchronousExport('JSON export', () => exportWorkspaceJson(workspace))
          }
          onExportMarkdown={() =>
            runSynchronousExport('Markdown export', () => exportPageMarkdown(context))
          }
          onExportPng={() => {
            runSynchronousExport('PNG export', () => {
              const dataUrl = editorRef.current?.toPngDataUrl(2);
              if (!dataUrl) {
                throw new Error('The canvas is not ready for export.');
              }
              downloadDataUrl(dataUrl, `${shortFilename(context.page.title)}.png`);
            });
          }}
          onExportPdf={() =>
            exportPagePdf(context).catch((error: unknown) =>
              showOperationError('PDF export', error),
            )
          }
        />

        <div className="page-header">
          <input
            ref={pageTitleRef}
            value={context.page.title}
            maxLength={16 * 1024}
            aria-label="Page title"
            onChange={(event) =>
              setWorkspace((current) =>
                updatePage(current, context.page.id, (page) => ({
                  ...page,
                  title: truncateUtf8(event.target.value, MAX_TITLE_BYTES),
                })),
              )
            }
          />
          <div className="page-meta-actions">
            {activePageTags.map((tag) => (
              <span className={`page-tag page-tag--${tag}`} key={tag}>
                {PAGE_TAG_OPTIONS.find((option) => option.id === tag)?.label ?? tag}
              </span>
            ))}
            {activePageTags.includes('todo') ? (
              <button
                type="button"
                className={`page-task-state page-task-state--${context.page.taskState ?? 'open'}`}
                aria-pressed={context.page.taskState === 'done'}
                onClick={() =>
                  setWorkspace((current) =>
                    updatePage(current, context.page.id, (page) => ({
                      ...page,
                      taskState: page.taskState === 'done' ? 'open' : 'done',
                    })),
                  )
                }
              >
                <CheckCircle2 size={13} />
                {context.page.taskState === 'done' ? 'Done' : 'Open'}
              </button>
            ) : null}
            <details className="page-tag-menu">
              <summary aria-label="Page tags">
                <Tag size={14} />
                <span>Tags</span>
              </summary>
              <div className="page-tag-menu__popover">
                {PAGE_TAG_OPTIONS.map((option) => (
                  <button
                    type="button"
                    key={option.id}
                    aria-pressed={activePageTags.includes(option.id)}
                    onClick={() => togglePageTag(option.id)}
                  >
                    <span className={`page-tag-dot page-tag-dot--${option.id}`} />
                    {option.label}
                  </button>
                ))}
              </div>
            </details>
          </div>
          <label className="object-picker">
            <span className="sr-only">Selected canvas object</span>
            <select
              value={selectedElement?.id ?? ''}
              onChange={(event) => {
                setTool('select');
                setSelectedElementId(event.target.value || null);
              }}
              aria-label="Select a canvas object"
            >
              <option value="">Objects ({context.page.elements.length})</option>
              {context.page.elements.map((element) => (
                <option key={element.id} value={element.id}>
                  {elementLabel(element)}
                </option>
              ))}
            </select>
          </label>
          <span>{context.page.mode === 'a4' ? 'A4 page' : 'Free canvas'}</span>
        </div>

        <div
          className="canvas-viewport"
          onDragOver={(event) => event.preventDefault()}
          onDrop={handleDrop}
        >
          {context.page.elements.length === 0 &&
          hiddenEmptyPromptPageId !== context.page.id ? (
            <section className="canvas-empty-state" data-empty-kind="page">
              <span className="app-eyebrow">Blank page</span>
              <h2>Capture the first thing on your mind</h2>
              <p>Start with text, draw directly, or add an image. You can organize it later.</p>
              <div>
                <button
                  type="button"
                  className="canvas-empty-state__primary"
                  onClick={() => startTextOnPage(workspaceRef.current, context.page.id)}
                >
                  <Type size={17} />
                  Write a note
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setTool('pen');
                    setHiddenEmptyPromptPageId(context.page.id);
                    document.getElementById('page-editor')?.focus();
                  }}
                >
                  Draw
                </button>
                <button type="button" onClick={() => imageInputRef.current?.click()}>
                  Add image
                </button>
              </div>
            </section>
          ) : null}
          <CanvasEditor
            ref={editorRef}
            page={context.page}
            tool={tool}
            brush={brush}
            selectedElementId={selectedElementId}
            onSelectElement={setSelectedElementId}
            onAddElement={addElement}
            onUpdateElement={updateElement}
            onDeleteElement={removeElement}
            onToolChange={setTool}
          />
        </div>

        <Inspector
          element={selectedElement}
          onUpdate={(patch) => {
            if (selectedElement) updateElement(selectedElement.id, patch);
          }}
          onDelete={() => {
            if (selectedElement) removeElement(selectedElement.id);
          }}
          onClose={() => setSelectedElementId(null)}
          onEditText={() => {
            if (selectedElement?.kind === 'text') {
              editorRef.current?.editText(selectedElement.id);
            }
          }}
        />
      </section>

      {guideOpen ? (
        <GettingStartedPanel
          textSize={preferences.textSize}
          onTextSizeChange={changeTextSize}
          onQuickNote={startQuickNote}
          onFocusSearch={focusSearch}
          onOpenExample={openExample}
          onDismiss={dismissGuide}
        />
      ) : null}

      <input
        ref={imageInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        hidden
        onChange={(event) => {
          void importImage(event.target.files?.[0]);
          event.target.value = '';
        }}
      />
      <input
        ref={pdfInputRef}
        type="file"
        accept="application/pdf,.pdf"
        hidden
        onChange={(event) => {
          void importPdf(event.target.files?.[0]);
          event.target.value = '';
        }}
      />
      <input
        ref={portableInputRef}
        type="file"
        accept="application/json,text/markdown,.json,.md"
        hidden
        onChange={(event) => {
          void portableImport(event.target.files?.[0]);
          event.target.value = '';
        }}
      />

      {trashOpen ? (
        <div className="modal-backdrop" role="presentation" onMouseDown={closeTrash}>
          <section
            ref={trashDialogRef}
            className="trash-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="trash-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <Trash2 size={19} />
                <div>
                  <h2 id="trash-title">Trash</h2>
                  <p>Restore items or remove them permanently.</p>
                </div>
              </div>
              <button type="button" onClick={closeTrash} aria-label="Close trash">
                <X size={18} />
              </button>
            </header>
            <div className="trash-list">
              {workspace.trash.length ? (
                [...workspace.trash]
                  .reverse()
                  .map((entry) => (
                    <div key={entry.id} className="trash-item">
                      <div>
                        <strong>{trashLabel(entry)}</strong>
                        <small>
                          {entry.kind} · {new Date(entry.deletedAt).toLocaleString()}
                        </small>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          const restored = restoreTrashEntry(workspace, entry.id);
                          if (restored === workspace) {
                            showNotice(
                              'Restore the parent notebook, section, or page first.',
                            );
                          } else {
                            setWorkspace(restored);
                          }
                        }}
                      >
                        Restore
                      </button>
                      <button
                        type="button"
                        className="quiet-danger"
                        onClick={() => {
                          if (window.confirm('Permanently delete this item?')) {
                            setWorkspace((current) => ({
                              ...current,
                              trash: current.trash.filter((item) => item.id !== entry.id),
                            }));
                          }
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  ))
              ) : (
                <div className="empty-trash" data-empty-kind="trash">
                  <Trash2 size={28} />
                  <strong>Trash is empty</strong>
                  <p>Deleted pages and canvas objects appear here so you can restore them.</p>
                  <button type="button" onClick={closeTrash}>
                    Back to notes
                  </button>
                </div>
              )}
            </div>
            {workspace.trash.length ? (
              <footer>
                <button
                  type="button"
                  className="delete-object"
                  onClick={() => {
                    if (window.confirm('Permanently delete every item in trash?')) {
                      setWorkspace((current) => ({ ...current, trash: [] }));
                    }
                  }}
                >
                  Empty trash
                </button>
              </footer>
            ) : null}
          </section>
        </div>
      ) : null}

      {notice ? (
        <div
          className={`toast ${noticeKind === 'error' ? 'toast--error' : ''}`}
          role={noticeKind === 'error' ? 'alert' : 'status'}
        >
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss message">
            <X size={14} />
          </button>
        </div>
      ) : null}
    </main>
  );
}
