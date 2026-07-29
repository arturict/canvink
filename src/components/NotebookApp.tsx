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
  CheckCircle2,
  HardDrive,
  LoaderCircle,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { createDefaultWorkspace } from '../domain/sample';
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
  getActiveContext,
  restoreTrashEntry,
  renameNotebook,
  renameSection,
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
  PageElement,
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
} from '../storage/workspaceStorage';
import { canAutosave } from '../storage/persistencePolicy';
import Inspector from './Inspector';
import Sidebar from './Sidebar';
import Toolbar from './Toolbar';

type SaveState = 'loading' | 'saving' | 'saved' | 'error';

function trashLabel(entry: TrashEntry): string {
  if ('title' in entry.item) return entry.item.title;
  if (entry.item.kind === 'image') return entry.item.name;
  if (entry.item.kind === 'pdf') return entry.item.sourceName;
  if (entry.item.kind === 'text') return entry.item.text.slice(0, 50) || 'Empty text';
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
  if (element.kind === 'image') return `Image: ${element.name}`;
  return `PDF: ${element.sourceName}, ${element.pageCount} pages`;
}

export default function NotebookApp() {
  const [workspace, setWorkspace] = useState<WorkspaceState>(() => createDefaultWorkspace());
  const [storageReady, setStorageReady] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [storageBackend, setStorageBackend] = useState<StorageBackend>(() =>
    activeStorageBackend(),
  );
  const [saveState, setSaveState] = useState<SaveState>('loading');
  const [notice, setNotice] = useState<string | null>(null);
  const [tool, setTool] = useState<EditorTool>('pen');
  const [brush, setBrush] = useState<BrushSettings>({ color: '#1e2925', size: 7 });
  const [selectedElementId, setSelectedElementId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(() =>
    window.matchMedia('(min-width: 821px)').matches,
  );
  const [trashOpen, setTrashOpen] = useState(false);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const pdfInputRef = useRef<HTMLInputElement>(null);
  const portableInputRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<CanvasEditorHandle>(null);
  const workspaceRef = useRef(workspace);
  const storageReadyRef = useRef(storageReady);
  const loadFailedRef = useRef(loadFailed);
  const dirtyRevisionRef = useRef(0);
  const savedRevisionRef = useRef(0);
  const saveTimerRef = useRef<number | null>(null);
  const skipNextAutosaveRef = useRef(false);
  const closingRef = useRef(false);
  const flushSaveRef = useRef<() => Promise<void>>(async () => undefined);
  const saveErrorNoticeRef = useRef<string | null>(null);
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
  const closeTrash = useCallback(() => {
    setTrashOpen(false);
    window.requestAnimationFrame(() => trashReturnFocusRef.current?.focus());
  }, []);

  const persistSnapshot = useCallback(
    async (snapshot: WorkspaceState, revision: number): Promise<void> => {
      try {
        const backend = await saveWorkspace(snapshot);
        savedRevisionRef.current = Math.max(savedRevisionRef.current, revision);
        if (revision === dirtyRevisionRef.current) {
          setStorageBackend(backend);
          setSaveState('saved');
          const resolvedMessage = saveErrorNoticeRef.current;
          saveErrorNoticeRef.current = null;
          setNotice((current) => (current === resolvedMessage ? null : current));
        }
      } catch (error) {
        if (revision === dirtyRevisionRef.current) {
          const message = error instanceof Error ? error.message : 'Autosave failed.';
          saveErrorNoticeRef.current = message;
          setSaveState('error');
          setNotice(message);
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
    let active = true;
    loadWorkspace()
      .then((result) => {
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
        setLoadFailed(false);
        setStorageReady(true);
      })
      .catch((error: unknown) => {
        if (!active) return;
        loadFailedRef.current = true;
        setNotice(error instanceof Error ? error.message : 'Could not load the local workspace.');
        setSaveState('error');
        setLoadFailed(true);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!canAutosave({ storageReady, loadFailed })) return undefined;
    if (skipNextAutosaveRef.current) {
      skipNextAutosaveRef.current = false;
      return undefined;
    }

    const revision = dirtyRevisionRef.current + 1;
    dirtyRevisionRef.current = revision;
    setSaveState('saving');
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
      void flushSaveRef.current().catch(() => undefined);
      event.preventDefault();
      event.returnValue = '';
    };
    const handlePageHide = () => {
      if (hasUnsavedChanges()) {
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
          setNotice(
            error instanceof Error
              ? error.message
              : 'Could not install the safe-close handler.',
          );
        });
    }

    return () => {
      disposed = true;
      unlistenClose?.();
      window.removeEventListener('beforeunload', handleBeforeUnload);
      window.removeEventListener('pagehide', handlePageHide);
    };
  }, [loadFailed, storageReady]);

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
      if (trashOpen || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.tagName === 'SELECT' ||
        target?.isContentEditable
      ) {
        return;
      }

      const keyTools: Record<string, EditorTool> = {
        v: 'select',
        p: 'pen',
        h: 'highlighter',
        e: 'eraser',
        t: 'text',
      };
      const nextTool = keyTools[event.key.toLocaleLowerCase()];
      if (nextTool) setTool(nextTool);

      if (
        (event.key === 'Delete' || event.key === 'Backspace') &&
        selectedElementId &&
        context
      ) {
        event.preventDefault();
        setWorkspace((current) => trashElement(current, context.page.id, selectedElementId));
        setSelectedElementId(null);
      }
    };
    window.addEventListener('keydown', handleKeyboard);
    return () => window.removeEventListener('keydown', handleKeyboard);
  }, [context, selectedElementId, trashOpen]);

  if (!storageReady) {
    if (loadFailed) {
      return (
        <main className="fatal-state" role="alert">
          <AlertTriangle />
          <h1>Your local workspace could not be opened.</h1>
          <p>{notice ?? 'Canvink did not change the stored data.'}</p>
          <p>Editing is disabled so unsaved welcome data cannot hide the problem.</p>
          <button type="button" onClick={() => window.location.reload()}>
            Try opening it again
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

  const showNotice = (message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice((current) => (current === message ? null : current)), 4200);
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
        error instanceof Error
          ? error.message
          : 'This object would exceed the safe workspace limits.',
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
      showNotice(
        error instanceof Error ? error.message : 'This change is not valid.',
      );
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
      showNotice(error instanceof Error ? error.message : 'Image import failed.');
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
      showNotice(error instanceof Error ? error.message : 'PDF import failed.');
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
      showNotice(error instanceof Error ? error.message : 'Import failed.');
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

  return (
    <main className={`notebook-app ${sidebarOpen ? '' : 'sidebar-is-closed'}`}>
      {sidebarOpen ? (
        <Sidebar
          notebooks={workspace.notebooks}
          activeNotebookId={workspace.activeNotebookId}
          activeSectionId={workspace.activeSectionId}
          activePageId={workspace.activePageId}
          trashCount={workspace.trash.length}
          onClose={() => setSidebarOpen(false)}
          onActivatePage={(notebookId, sectionId, pageId) => {
            setWorkspace((current) => activatePage(current, notebookId, sectionId, pageId));
            setSelectedElementId(null);
            if (window.matchMedia('(max-width: 820px)').matches) {
              setSidebarOpen(false);
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
          onOpenTrash={() => {
            trashReturnFocusRef.current =
              document.activeElement instanceof HTMLElement ? document.activeElement : null;
            setTrashOpen(true);
          }}
        />
      ) : null}
      {sidebarOpen ? (
        <button
          type="button"
          className="sidebar-scrim"
          aria-label="Close notebook navigation"
          onClick={() => setSidebarOpen(false)}
        />
      ) : null}

      <section className="workspace-shell">
        <header className="app-topbar">
          <button
            type="button"
            className="sidebar-toggle"
            onClick={() => setSidebarOpen((value) => !value)}
            aria-label={sidebarOpen ? 'Hide notebook navigation' : 'Show notebook navigation'}
          >
            {sidebarOpen ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}
          </button>
          <div className="breadcrumbs" aria-label="Current page location">
            <span>{context.notebook.title}</span>
            <i>/</i>
            <span>{context.section.title}</span>
          </div>
          <div className="search-box">
            <Search size={16} />
            <input
              type="search"
              placeholder="Search pages and text"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              aria-label="Search workspace"
            />
            {searchQuery ? (
              <button type="button" onClick={() => setSearchQuery('')} aria-label="Clear search">
                <X size={14} />
              </button>
            ) : null}
            {deferredQuery ? (
              <div className="search-results">
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
                      }}
                    >
                      <span>{result.title}</span>
                      <small>{result.excerpt}</small>
                    </button>
                  ))
                ) : (
                  <p>No matching notes.</p>
                )}
              </div>
            ) : null}
          </div>
          <div className={`save-indicator save-indicator--${saveState}`} title={`Using ${storageBackend}`}>
            <SaveIcon size={15} className={saveState === 'saving' || saveState === 'loading' ? 'spin' : ''} />
            <span>{saveIndicator.label}</span>
            <HardDrive size={13} />
          </div>
        </header>

        <Toolbar
          tool={tool}
          brush={brush}
          pageMode={context.page.mode}
          onToolChange={setTool}
          onBrushChange={setBrush}
          onPageModeChange={(mode) =>
            setWorkspace((current) =>
              updatePage(current, context.page.id, (page) => ({ ...page, mode })),
            )
          }
          onImportImage={() => imageInputRef.current?.click()}
          onImportPdf={() => pdfInputRef.current?.click()}
          onPortableImport={() => portableInputRef.current?.click()}
          onExportJson={() => exportWorkspaceJson(workspace)}
          onExportMarkdown={() => exportPageMarkdown(context)}
          onExportPng={() => {
            const dataUrl = editorRef.current?.toPngDataUrl(2);
            if (dataUrl) downloadDataUrl(dataUrl, `${shortFilename(context.page.title)}.png`);
          }}
          onExportPdf={() =>
            exportPagePdf(context).catch((error: unknown) =>
              showNotice(error instanceof Error ? error.message : 'PDF export failed.'),
            )
          }
        />

        <div className="page-header">
          <input
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
        />
      </section>

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
                <div className="empty-trash">
                  <Trash2 size={28} />
                  <p>Trash is empty.</p>
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
        <div className="toast" role="status">
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss message">
            <X size={14} />
          </button>
        </div>
      ) : null}
    </main>
  );
}
