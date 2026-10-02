import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, LogOut, RotateCcw, X } from 'lucide-react';
import {
  MICROSOFT_ONENOTE_READ_SCOPES,
  createMicrosoftGraphOneNoteClient,
  createMicrosoftOneNoteAuth,
  type MicrosoftGraphOneNoteClient,
  type MicrosoftOneNoteAuthClient,
  type MicrosoftOneNoteAuthOptions,
  type MicrosoftOneNoteAuthSession,
  type OneNoteGraphPreviewResult,
  type TauriSystemBrowserCallbackBridge,
} from '../../import/graph';
import {
  applyOneNoteImportApplication,
  createWorkspaceV2RuntimeOneNoteApplyTarget,
  oneNoteImportFromPreview,
  prepareOneNoteImportApplication,
  rollbackOneNoteImportApplication,
  selectOneNoteImportOutline,
  type OneNoteApplyProgress,
  type OneNoteApplyTarget,
  type OneNoteImportApplicationResult,
  type OneNoteImportSourceHandle,
  type StagedOneNoteImportApplication,
} from '../../import/apply';
import type {
  FidelityIssue,
  FidelityStatus,
  OneNoteImportPreviewPlan,
  PageFidelityReport,
  PlannedNotebookImport,
} from '../../import/types';
import type { WorkspaceV2Runtime } from '../../storage/workspaceV2Runtime';
import { useI18n, type TranslationKey, type TranslationParameters } from '../../i18n';
import { addLocalPdfFallback, removeLocalPdfFallback } from '../../import/pdfFallback';
import {
  desktopExportFilesFromFileList,
  desktopExportFilesFromZip,
  openOneNoteDesktopExport,
  openZipArchive,
  type OneNoteDesktopAcquisition,
} from '../../import/onenoteDesktop';
import { createBrowserPdfPreviewRenderer } from '../assets/browserPdfPreview';
import type { PdfPreviewRenderer } from '../../io/pdf';
import { formatLocale } from '../../i18n/core';

const CLIENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface OneNoteImportConfiguration {
  clientId: string;
  redirectUri: string;
  postLogoutRedirectUri?: string;
  authority?: string;
}

export interface OneNoteImportDialogDependencies {
  createAuth(options: MicrosoftOneNoteAuthOptions): MicrosoftOneNoteAuthClient;
  createGraphClient(auth: MicrosoftOneNoteAuthClient): MicrosoftGraphOneNoteClient;
  createTarget(runtime: WorkspaceV2Runtime): OneNoteApplyTarget;
  createPdfPreviewRenderer(): PdfPreviewRenderer;
  now(): string;
}

export interface OneNoteImportDialogProps {
  open: boolean;
  onClose(): void;
  runtime?: WorkspaceV2Runtime;
  target?: OneNoteApplyTarget;
  configuration?: Partial<OneNoteImportConfiguration>;
  systemBrowser?: TauriSystemBrowserCallbackBridge;
  systemBrowserFactory?: (redirectUri: string) => TauriSystemBrowserCallbackBridge;
  dependencies?: Partial<OneNoteImportDialogDependencies>;
  onImported?(result: OneNoteImportApplicationResult): void;
  onRolledBack?(): void;
}

declare global {
  interface Window {
    /** Explicit automated-acceptance seam. Normal builds never assign it. */
    __CANVINK_ONENOTE_IMPORT_TEST_DEPENDENCIES__?: OneNoteImportDialogDependencies;
  }
}

export function discoverOneNoteImportConfiguration(
  configured: Partial<OneNoteImportConfiguration> = {},
): Partial<OneNoteImportConfiguration> {
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  return {
    clientId: configured.clientId ?? import.meta.env.VITE_MICROSOFT_CLIENT_ID ?? '',
    redirectUri: configured.redirectUri
      ?? import.meta.env.VITE_MICROSOFT_REDIRECT_URI
      ?? (origin ? `${origin}/app` : ''),
    postLogoutRedirectUri: configured.postLogoutRedirectUri
      ?? import.meta.env.VITE_MICROSOFT_POST_LOGOUT_REDIRECT_URI,
    authority: configured.authority ?? import.meta.env.VITE_MICROSOFT_AUTHORITY,
  };
}

export function selectOneNoteImportPreview(
  preview: OneNoteImportPreviewPlan,
  notebookId: string,
  sectionIds: ReadonlySet<string>,
  errors: Readonly<{ notebookUnavailable: string; sectionRequired: string }> = {
    notebookUnavailable: 'Das ausgewählte OneNote-Notizbuch ist nicht mehr verfügbar.',
    sectionRequired: 'Wähle mindestens einen Abschnitt aus.',
  },
): OneNoteImportPreviewPlan {
  const source = preview.notebooks.find((notebook) => notebook.sourceId === notebookId);
  if (!source) throw new Error(errors.notebookUnavailable);
  const selectedSections = source.sections.filter((section) => sectionIds.has(section.sourceId));
  if (selectedSections.length === 0) throw new Error(errors.sectionRequired);
  // A partial import names its sections, so several parts of one notebook stay distinguishable.
  const partial = selectedSections.length < source.sections.length;
  const partName = selectedSections.slice(0, 3).map((section) => section.displayName).join(', ')
    + (selectedSections.length > 3 ? ', …' : '');
  const notebook: PlannedNotebookImport = {
    ...structuredClone(source),
    displayName: partial ? `${source.displayName} – ${partName}` : source.displayName,
    sections: structuredClone(selectedSections),
  };
  const pageReports = notebook.sections.flatMap((section) => section.pages.map((page) => page.fidelity));
  const summary: OneNoteImportPreviewPlan['summary'] = {
    complete: 0,
    visual: 0,
    simplified: 0,
    unsupported: 0,
  };
  pageReports.forEach((report) => { summary[report.status] += 1; });
  return {
    ...structuredClone(preview),
    notebooks: [notebook],
    pageReports,
    summary,
  };
}

function defaultDependencies(): OneNoteImportDialogDependencies {
  if (typeof window !== 'undefined') {
    const testDependencies = window.__CANVINK_ONENOTE_IMPORT_TEST_DEPENDENCIES__;
    if (testDependencies) return testDependencies;
  }
  return {
    createAuth: createMicrosoftOneNoteAuth,
    createGraphClient: (auth) => createMicrosoftGraphOneNoteClient({
      getAccessToken: (signal) => auth.getAccessToken(signal),
      fetch: (url, init) => window.fetch(url, init),
    }),
    createTarget: createWorkspaceV2RuntimeOneNoteApplyTarget,
    createPdfPreviewRenderer: createBrowserPdfPreviewRenderer,
    now: () => new Date().toISOString(),
  };
}

function message(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

const fidelityLabelKeys: Record<FidelityStatus, TranslationKey> = {
  complete: 'onenote.fidelity.complete',
  visual: 'onenote.fidelity.visual',
  simplified: 'onenote.fidelity.simplified',
  unsupported: 'onenote.fidelity.unsupported',
};

const fidelityIssueKeys: Record<FidelityIssue['code'], TranslationKey> = {
  'attachment-resource-missing': 'onenote.issue.attachment-resource-missing',
  'content-limit-exceeded': 'onenote.issue.content-limit-exceeded',
  'image-resource-missing': 'onenote.issue.image-resource-missing',
  'ink-data-missing': 'onenote.issue.ink-data-missing',
  'invalid-position': 'onenote.issue.invalid-position',
  'layout-estimated': 'onenote.issue.layout-estimated',
  'list-nesting-flattened': 'onenote.issue.list-nesting-flattened',
  'malformed-html': 'onenote.issue.malformed-html',
  'pdf-fallback-invalid': 'onenote.issue.pdf-fallback-invalid',
  'resource-not-downloaded': 'onenote.issue.resource-not-downloaded',
  'resource-too-large': 'onenote.issue.resource-too-large',
  'style-dropped': 'onenote.issue.style-dropped',
  'data-tag-unsupported': 'onenote.issue.data-tag-unsupported',
  'unsafe-file-name': 'onenote.issue.unsafe-file-name',
  'unsafe-url-dropped': 'onenote.issue.unsafe-url-dropped',
  'unsupported-element': 'onenote.issue.unsupported-element',
};

type Translate = (key: TranslationKey, parameters?: TranslationParameters) => string;

function localizedIssue(issue: FidelityIssue, t: Translate): string {
  return t(fidelityIssueKeys[issue.code]);
}

function formatSize(bytes: number, locale: string): string {
  if (bytes < 1024 * 1024) return `${Math.max(bytes > 0 ? 1 : 0, Math.round(bytes / 1024)).toLocaleString(locale)} kB`;
  return `${(bytes / 1024 / 1024).toLocaleString(locale, { maximumFractionDigits: 1 })} MB`;
}

function formatSeconds(milliseconds: number, locale: string): string {
  return (milliseconds / 1000).toLocaleString(locale, { maximumFractionDigits: 1 });
}

/** Per-page fidelity with a status filter; used by the review (Graph) and the import report. */
function FidelityReports({ reports, titles, t }: {
  reports: readonly PageFidelityReport[];
  titles: Readonly<Record<string, string>>;
  t: Translate;
}) {
  const [filter, setFilter] = useState<FidelityStatus | 'all'>('all');
  const shown = reports.filter((report) => filter === 'all' || report.status === filter);
  return (
    <>
      <div className="onenote-import-filters" aria-label={t('onenote.filterFidelity')}>
        {(['all', 'complete', 'visual', 'simplified', 'unsupported'] as const).map((status) => (
          <button key={status} type="button" aria-pressed={filter === status} onClick={() => setFilter(status)}>
            {status === 'all' ? t('onenote.fidelity.all') : t(fidelityLabelKeys[status])}
          </button>
        ))}
      </div>
      <ul className="onenote-import-reports">
        {shown.map((report) => (
          <li key={report.pageId} data-fidelity={report.status}>
            <strong>{titles[report.pageId] ?? report.pageId}</strong><span>{t(fidelityLabelKeys[report.status])}</span>
            {report.contentCounts ? (
              <small>{t('onenote.desktop.pageCounts', {
                strokes: report.contentCounts.inkStrokes,
                printouts: report.contentCounts.printoutPages,
                images: report.contentCounts.images,
                texts: report.contentCounts.textFrames,
              })}</small>
            ) : null}
            {report.pdfFallbackResourceId ? <small>{t('onenote.pdfFallback')}</small> : null}
            {report.issues.map((issue, index) => <small key={`${issue.code}-${index}`}>{localizedIssue(issue, t)}</small>)}
          </li>
        ))}
      </ul>
    </>
  );
}

export default function OneNoteImportDialog({
  open,
  onClose,
  runtime,
  target: injectedTarget,
  configuration,
  systemBrowser,
  systemBrowserFactory,
  dependencies: dependencyOverrides,
  onImported,
  onRolledBack,
}: OneNoteImportDialogProps) {
  const { language, t } = useI18n();
  const discovered = useMemo(() => discoverOneNoteImportConfiguration(configuration), [configuration]);
  const dependencies = useMemo(() => ({ ...defaultDependencies(), ...dependencyOverrides }), [dependencyOverrides]);
  const target = useMemo(
    () => injectedTarget ?? (runtime ? dependencies.createTarget(runtime) : undefined),
    [dependencies, injectedTarget, runtime],
  );
  const [clientId, setClientId] = useState(discovered.clientId ?? '');
  const [redirectUri, setRedirectUri] = useState(discovered.redirectUri ?? '');
  const [auth, setAuth] = useState<MicrosoftOneNoteAuthClient | null>(null);
  const [session, setSession] = useState<MicrosoftOneNoteAuthSession | null>(null);
  const [source, setSource] = useState<'graph' | 'desktop'>('graph');
  const [acquisition, setAcquisition] = useState<OneNoteGraphPreviewResult | null>(null);
  const [desktopAcquisition, setDesktopAcquisition] = useState<OneNoteDesktopAcquisition | null>(null);
  const [selectedNotebookId, setSelectedNotebookId] = useState('');
  const [selectedSectionIds, setSelectedSectionIds] = useState<Set<string>>(new Set());
  const [stage, setStage] = useState<StagedOneNoteImportApplication | null>(null);
  const [result, setResult] = useState<OneNoteImportApplicationResult | null>(null);
  const [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState<'auth' | 'acquire' | 'desktop' | 'fallback' | 'stage' | 'apply' | 'rollback' | null>(null);
  const [progress, setProgress] = useState<OneNoteApplyProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rollbackError, setRollbackError] = useState<string | null>(null);
  const cancellation = useRef<AbortController | null>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLElement>(null);
  const closeDialog = useCallback(() => {
    cancellation.current?.abort();
    cancellation.current = null;
    setAcquisition(null);
    setDesktopAcquisition(null);
    setStage(null);
    setResult(null);
    setProgress(null);
    setError(null);
    setRollbackError(null);
    setBusy(null);
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const timer = window.setTimeout(() => closeButton.current?.focus(), 0);
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) closeDialog();
      if (event.key !== 'Tab') return;
      const focusable = [...(dialog.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      ) ?? [])].filter((element) => !element.hasAttribute('hidden'));
      if (focusable.length === 0) return;
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
    window.addEventListener('keydown', escape);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('keydown', escape);
      previouslyFocused?.focus();
    };
  }, [busy, closeDialog, open]);

  useEffect(() => () => cancellation.current?.abort(), []);

  if (!open) return null;

  // The Graph and the desktop-export sources feed the same selection, review and apply steps.
  const loaded = source === 'desktop' ? desktopAcquisition : acquisition;
  const loadedNotebooks = source === 'desktop'
    ? desktopAcquisition?.outline.notebooks
    : acquisition?.preview.notebooks;
  const selectedNotebook = loadedNotebooks?.find(
    (notebook) => notebook.sourceId === selectedNotebookId,
  );
  const locale = formatLocale(language);

  const begin = (kind: NonNullable<typeof busy>) => {
    // React does not commit the `busy` state synchronously. Keep the controller
    // as the synchronous operation lock so a second click from the same render
    // cannot cancel or overtake the first operation.
    if (cancellation.current) return null;
    const controller = new AbortController();
    cancellation.current = controller;
    setBusy(kind);
    setError(null);
    setProgress(null);
    return controller;
  };
  const finish = (controller: AbortController) => {
    if (cancellation.current !== controller) return;
    cancellation.current = null;
    setBusy(null);
  };

  const configureAndSignIn = async () => {
    if (!CLIENT_ID_PATTERN.test(clientId.trim())) {
      setError(t('onenote.error.clientId'));
      return;
    }
    if (!redirectUri.trim()) {
      setError(t('onenote.error.redirectUri'));
      return;
    }
    const controller = begin('auth');
    if (!controller) return;
    try {
      const nativeSystemBrowser = systemBrowser ?? systemBrowserFactory?.(redirectUri.trim());
      const nextAuth = dependencies.createAuth({
        clientId: clientId.trim(),
        redirectUri: redirectUri.trim(),
        ...(discovered.postLogoutRedirectUri ? { postLogoutRedirectUri: discovered.postLogoutRedirectUri } : {}),
        ...(discovered.authority ? { authority: discovered.authority } : {}),
        ...(nativeSystemBrowser ? { systemBrowser: nativeSystemBrowser } : {}),
      });
      await nextAuth.initialize();
      const redirectSession = await nextAuth.completeRedirect(controller.signal);
      if (redirectSession && typeof window !== 'undefined') {
        window.history.replaceState({}, document.title, window.location.pathname);
      }
      const authorization = redirectSession
        ? { status: 'authorized' as const, session: redirectSession }
        : await nextAuth.authorize(controller.signal);
      setAuth(nextAuth);
      if (authorization.status === 'authorized') setSession(authorization.session);
    } catch (cause) {
      setError(message(cause, t('onenote.error.signIn')));
    } finally {
      finish(controller);
    }
  };

  const logout = async () => {
    if (!auth) return;
    const controller = begin('auth');
    if (!controller) return;
    try {
      await auth.logout({ signal: controller.signal, endServerSession: false });
      setSession(null);
      setAuth(null);
      setAcquisition(null);
      setStage(null);
      setResult(null);
    } catch (cause) {
      setError(message(cause, t('onenote.error.logout')));
    } finally {
      finish(controller);
    }
  };

  const acquire = async () => {
    if (!auth) return;
    const controller = begin('acquire');
    if (!controller) return;
    try {
      const next = await dependencies.createGraphClient(auth).acquirePreview({
        signal: controller.signal,
        preview: { createdAt: dependencies.now() },
      });
      if (next.preview.notebooks.length === 0) throw new Error(t('onenote.error.noNotebooks'));
      const first = next.preview.notebooks[0];
      setAcquisition(next);
      setSelectedNotebookId(first.sourceId);
      setSelectedSectionIds(new Set(first.sections.map((section) => section.sourceId)));
      setStage(null);
      setResult(null);
    } catch (cause) {
      setError(message(cause, t('onenote.error.acquire')));
    } finally {
      finish(controller);
    }
  };

  const readDesktopExport = async (files: FileList | null, kind: 'folder' | 'zip') => {
    if (!files || files.length === 0) return;
    const controller = begin('desktop');
    if (!controller) return;
    try {
      // Only the manifest (and a ZIP's directory) is read now; pages and
      // files are read one at a time while the import is written.
      const exportFiles = kind === 'zip'
        ? desktopExportFilesFromZip(await openZipArchive(files[0]))
        : desktopExportFilesFromFileList(Array.from(files));
      const next = await openOneNoteDesktopExport(exportFiles, {
        createdAt: dependencies.now(),
        untitledPage: t('onenote.desktop.untitledPage'),
        signal: controller.signal,
      });
      const first = next.outline.notebooks[0];
      setDesktopAcquisition(next);
      setSelectedNotebookId(first.sourceId);
      setSelectedSectionIds(new Set(first.sections.map((section) => section.sourceId)));
      setStage(null);
      setResult(null);
    } catch (cause) {
      setError(message(cause, t('onenote.error.desktop')));
    } finally {
      finish(controller);
    }
  };

  const prepare = async () => {
    if (!loaded || !target) return;
    const controller = begin('stage');
    if (!controller) return;
    try {
      const errors = {
        notebookUnavailable: t('onenote.error.notebookUnavailable'),
        sectionRequired: t('onenote.error.sectionRequired'),
      };
      let handle: OneNoteImportSourceHandle;
      if (source === 'desktop' && desktopAcquisition) {
        handle = {
          outline: selectOneNoteImportOutline(desktopAcquisition.outline, selectedNotebookId, selectedSectionIds, errors),
          source: desktopAcquisition.reader,
        };
      } else if (acquisition) {
        handle = await oneNoteImportFromPreview(
          selectOneNoteImportPreview(acquisition.preview, selectedNotebookId, selectedSectionIds, errors),
          acquisition.resourceBodies,
        );
      } else return;
      const next = await prepareOneNoteImportApplication({
        ...handle,
        target,
        preparedAt: dependencies.now(),
        signal: controller.signal,
        onProgress: setProgress,
      });
      setStage(next);
      setApproved(false);
    } catch (cause) {
      setError(message(cause, t('onenote.error.prepare')));
    } finally {
      finish(controller);
    }
  };

  const addPdfFallback = async (pageId: string, file: File) => {
    if (!acquisition) return;
    const controller = begin('fallback');
    if (!controller) return;
    try {
      const next = await addLocalPdfFallback(
        acquisition,
        pageId,
        file,
        dependencies.createPdfPreviewRenderer(),
        { signal: controller.signal, createdAt: dependencies.now() },
      );
      setAcquisition(next);
      setStage(null);
      setResult(null);
    } catch (cause) {
      setError(message(cause, t('onenote.error.pdfFallback')));
    } finally {
      finish(controller);
    }
  };

  const removePdfFallback = (pageId: string) => {
    if (!acquisition) return;
    setAcquisition(removeLocalPdfFallback(acquisition, pageId));
    setStage(null);
    setResult(null);
  };

  const apply = async () => {
    if (!stage || !target || !approved) return;
    const controller = begin('apply');
    if (!controller) return;
    try {
      const committed = await applyOneNoteImportApplication(target, stage, {
        approvalArtifactFingerprint: stage.review.approvalArtifactFingerprint,
        signal: controller.signal,
        onProgress: setProgress,
      });
      setResult(committed);
      setRollbackError(null);
      onImported?.(committed);
    } catch (cause) {
      setError(message(cause, t('onenote.error.apply')));
    } finally {
      finish(controller);
    }
  };

  const rollback = async () => {
    if (!result || !target) return;
    const controller = begin('rollback');
    if (!controller) return;
    try {
      await rollbackOneNoteImportApplication(target, result, setProgress);
      setResult(null);
      setStage(null);
      setApproved(false);
      setRollbackError(null);
      onRolledBack?.();
    } catch (cause) {
      setRollbackError(message(cause, t('onenote.error.rollback')));
    } finally {
      finish(controller);
    }
  };

  const cancel = () => {
    cancellation.current?.abort();
    auth?.cancelPendingAuthorization();
  };

  return (
    <div className="onenote-import-backdrop" role="presentation">
      <section
        ref={dialog}
        className="onenote-import-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="onenote-import-title"
        aria-describedby="onenote-import-safety"
      >
        <header className="onenote-import-dialog__header">
          <div>
            <span className="onenote-import-dialog__eyebrow">Microsoft OneNote</span>
            <h2 id="onenote-import-title">{t('onenote.title')}</h2>
          </div>
          <div className="onenote-import-dialog__header-actions">
            {session ? <button type="button" onClick={() => void logout()} disabled={Boolean(busy)} aria-label={t('onenote.logout.label')}><LogOut size={17} /></button> : null}
            <button ref={closeButton} type="button" onClick={closeDialog} disabled={Boolean(busy)} aria-label={t('onenote.close')}>
              <X size={18} />
            </button>
          </div>
        </header>

        {!loaded && !stage && !result ? (
          <div className="onenote-import-filters" role="radiogroup" aria-label={t('onenote.source.label')}>
            {(['graph', 'desktop'] as const).map((option) => (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={source === option}
                aria-pressed={source === option}
                disabled={Boolean(busy)}
                onClick={() => { setSource(option); setError(null); }}
              >
                {t(option === 'graph' ? 'onenote.source.graph' : 'onenote.source.desktop')}
              </button>
            ))}
          </div>
        ) : null}

        {source === 'graph' ? (
          <p id="onenote-import-safety" className="onenote-import-dialog__safety">
            {t('onenote.safety.beforeScope')} <code>{MICROSOFT_ONENOTE_READ_SCOPES[0]}</code>.{' '}
            {t('onenote.safety.afterScope')}
          </p>
        ) : (
          <p id="onenote-import-safety" className="onenote-import-dialog__safety">{t('onenote.desktop.safety')}</p>
        )}

        {error ? <div className="onenote-import-alert" role="alert"><AlertTriangle size={18} />{error}</div> : null}
        {busy ? (
          <div className="onenote-import-progress" aria-live="polite">
            {progress?.phase === 'writing-pages' && progress.total > 0
              ? <progress aria-label={t('onenote.progress.label')} value={progress.completed} max={progress.total} />
              : <progress aria-label={t('onenote.progress.label')} />}
            <span>{busy === 'auth'
              ? t('onenote.progress.auth')
              : busy === 'acquire'
                ? t('onenote.progress.acquire')
                : busy === 'desktop'
                  ? t('onenote.progress.desktop')
                : busy === 'fallback'
                  ? t('onenote.progress.pdfFallback')
                  : progress?.phase === 'writing-pages'
                    ? t('onenote.progress.pages', {
                      completed: progress.completed,
                      total: progress.total,
                      size: formatSize(progress.stagedBytes ?? 0, locale),
                      seconds: formatSeconds(progress.elapsedMs ?? 0, locale),
                    })
                    : t('onenote.progress.import')}</span>
            <button type="button" onClick={cancel}>{t('common.cancel')}</button>
          </div>
        ) : null}

        {source === 'desktop' && !desktopAcquisition ? (
          <div className="onenote-import-step">
            <h3>{t('onenote.desktop.title')}</h3>
            <p className="onenote-import-help">{t('onenote.desktop.help')}</p>
            <div className="onenote-import-actions">
              <label className="onenote-import-file-button onenote-import-primary">
                {t('onenote.desktop.chooseFolder')}
                <input
                  ref={(node) => node?.setAttribute('webkitdirectory', '')}
                  type="file"
                  multiple
                  disabled={Boolean(busy)}
                  aria-label={t('onenote.desktop.chooseFolder')}
                  onChange={(event) => {
                    const files = event.currentTarget.files;
                    void readDesktopExport(files, 'folder').finally(() => { event.target.value = ''; });
                  }}
                />
              </label>
              <label className="onenote-import-file-button">
                {t('onenote.desktop.chooseZip')}
                <input
                  type="file"
                  accept=".zip,application/zip"
                  disabled={Boolean(busy)}
                  aria-label={t('onenote.desktop.chooseZip')}
                  onChange={(event) => {
                    const files = event.currentTarget.files;
                    void readDesktopExport(files, 'zip').finally(() => { event.target.value = ''; });
                  }}
                />
              </label>
            </div>
          </div>
        ) : null}

        {source === 'graph' && !session ? (
          <div className="onenote-import-step">
            <h3>{t('onenote.step1.title')}</h3>
            <label>
              {t('onenote.clientId')}
              <input value={clientId} onChange={(event) => setClientId(event.target.value)} autoComplete="off" spellCheck={false} />
            </label>
            <label>
              {t('onenote.redirectUri')}
              <input value={redirectUri} onChange={(event) => setRedirectUri(event.target.value)} autoComplete="off" spellCheck={false} />
            </label>
            <p className="onenote-import-help">{t('onenote.publicClientHelp')}</p>
            <button type="button" className="onenote-import-primary" onClick={() => void configureAndSignIn()} disabled={Boolean(busy)}>
              {t('onenote.signIn')}
            </button>
          </div>
        ) : null}

        {source === 'graph' && session && !acquisition ? (
          <div className="onenote-import-step">
            <div className="onenote-import-account">
              <div><strong>{t('onenote.signedIn')}</strong><span>{session.username ?? session.accountId}</span></div>
              <button type="button" onClick={() => void logout()}><LogOut size={16} /> {t('onenote.logout')}</button>
            </div>
            <h3>{t('onenote.step2.title')}</h3>
            <p>{t('onenote.readHelp')}</p>
            <button type="button" className="onenote-import-primary" onClick={() => void acquire()} disabled={Boolean(busy)}>
              {t('onenote.findNotebooks')}
            </button>
          </div>
        ) : null}

        {loaded && !stage ? (
          <div className="onenote-import-step">
            <h3>{t(source === 'desktop' ? 'onenote.desktop.step2.title' : 'onenote.step3.title')}</h3>
            {desktopAcquisition && source === 'desktop' ? (
              <p className="onenote-import-help">{t('onenote.desktop.stats', {
                pages: desktopAcquisition.summary.pages.toLocaleString(locale),
                sections: desktopAcquisition.summary.sections,
                files: (desktopAcquisition.summary.images + desktopAcquisition.summary.files).toLocaleString(locale),
                size: formatSize(desktopAcquisition.summary.resourceBytes, locale),
              })}</p>
            ) : null}
            <fieldset>
              <legend>{t('onenote.oneNotebook')}</legend>
              {loadedNotebooks?.map((notebook) => (
                <label key={notebook.sourceId} className="onenote-import-choice">
                  <input
                    type="radio"
                    name="onenote-notebook"
                    value={notebook.sourceId}
                    checked={selectedNotebookId === notebook.sourceId}
                    onChange={() => {
                      setSelectedNotebookId(notebook.sourceId);
                      setSelectedSectionIds(new Set(notebook.sections.map((section) => section.sourceId)));
                    }}
                  />
                  {notebook.displayName}
                </label>
              ))}
            </fieldset>
            <fieldset>
              <legend>{t('onenote.sections')}</legend>
              {selectedNotebook?.sections.map((section) => (
                <label key={section.sourceId} className="onenote-import-choice">
                  <input
                    type="checkbox"
                    checked={selectedSectionIds.has(section.sourceId)}
                    onChange={() => setSelectedSectionIds((current) => {
                      const next = new Set(current);
                      if (next.has(section.sourceId)) next.delete(section.sourceId); else next.add(section.sourceId);
                      return next;
                    })}
                  />
                  {/* Groups are real in Canvink now; the chooser still names them so
                      same-named sections in different groups stay distinguishable. */}
                  {[...(section.groupPath ?? []), section.displayName].join(' › ')} <span>{t('onenote.pages', { count: section.pages.length })}</span>
                </label>
              ))}
            </fieldset>
            {acquisition && source === 'graph' ? <fieldset className="onenote-import-fallbacks">
              <legend>{t('onenote.pdfFallbacks.title')}</legend>
              <p className="onenote-import-help">{t('onenote.pdfFallbacks.help')}</p>
              {selectedNotebook?.sections
                .filter((section) => selectedSectionIds.has(section.sourceId))
                .flatMap((section) => section.pages.map((page) => {
                  const fallback = acquisition.input.pdfFallbacks?.find((item) => item.pageId === page.sourceId);
                  const report = acquisition.preview.pageReports.find((item) => item.pageId === page.sourceId);
                  return (
                    <div key={page.sourceId} className="onenote-import-fallback-row" data-page-id={page.sourceId}>
                      <span><strong>{page.title}</strong><small>{section.displayName} · {report ? t(fidelityLabelKeys[report.status]) : ''}</small></span>
                      {fallback ? (
                        <button type="button" onClick={() => removePdfFallback(page.sourceId)} disabled={Boolean(busy)}>
                          {t('onenote.pdfFallbacks.remove')}
                        </button>
                      ) : (
                        <label className="onenote-import-file-button">
                          {t('onenote.pdfFallbacks.choose')}
                          <input
                            type="file"
                            accept="application/pdf,.pdf"
                            disabled={Boolean(busy)}
                            aria-label={t('onenote.pdfFallbacks.chooseForPage', { page: page.title })}
                            onChange={(event) => {
                              const file = event.currentTarget.files?.[0];
                              event.currentTarget.value = '';
                              if (file) void addPdfFallback(page.sourceId, file);
                            }}
                          />
                        </label>
                      )}
                    </div>
                  );
                }))}
            </fieldset> : null}
            <div className="onenote-import-actions">
              <button
                type="button"
                onClick={() => (source === 'desktop' ? setDesktopAcquisition(null) : void acquire())}
              >
                {t('onenote.readAgain')}
              </button>
              <button type="button" className="onenote-import-primary" onClick={() => void prepare()} disabled={selectedSectionIds.size === 0 || !target}>
                {t('onenote.reviewSelection')}
              </button>
            </div>
          </div>
        ) : null}

        {stage && !result ? (
          <div className="onenote-import-step">
            <h3>{t(source === 'desktop' ? 'onenote.desktop.step3.title' : 'onenote.step4.title')}</h3>
            <dl className="onenote-import-summary">
              <div><dt>{t('onenote.newNotebook')}</dt><dd>{stage.review.notebookTitle}</dd></div>
              <div><dt>{t('onenote.scope')}</dt><dd>{t('onenote.scopeValue', { sections: stage.review.sectionCount, pages: stage.review.pageCount })}</dd></div>
              <div><dt>{t('onenote.originalFiles')}</dt><dd>{stage.review.resourceTotalsExact
                ? t('onenote.resources', { count: stage.review.resourceCount, bytes: stage.review.resourceBytes.toLocaleString(locale) })
                : t('onenote.resourcesAtMost', { count: stage.review.resourceCount.toLocaleString(locale), size: formatSize(stage.review.resourceBytes, locale) })}</dd></div>
            </dl>
            {stage.review.fidelity.length > 0
              ? <FidelityReports reports={stage.review.fidelity} titles={stage.review.pageTitles} t={t} />
              : <p className="onenote-import-help">{t('onenote.fidelityAfterImport')}</p>}
            {stage.review.warnings.length > 0 ? (
              <div className="onenote-import-warning"><AlertTriangle size={18} /><span>{t('onenote.warnings', { count: stage.review.warnings.length })}</span></div>
            ) : null}
            <div className="onenote-import-fingerprint">
              <span>{t('onenote.fingerprint')}</span><code>{stage.review.approvalArtifactFingerprint}</code>
            </div>
            <label className="onenote-import-approval">
              <input type="checkbox" checked={approved} onChange={(event) => setApproved(event.target.checked)} />
              {t('onenote.approval')}
            </label>
            <div className="onenote-import-actions">
              <button type="button" onClick={() => { setStage(null); setApproved(false); }}>{t('onenote.changeSelection')}</button>
              <button type="button" className="onenote-import-primary" disabled={!approved || Boolean(busy)} onClick={() => void apply()}>
                {t('onenote.import')}
              </button>
            </div>
          </div>
        ) : null}

        {result ? (
          <div className="onenote-import-step onenote-import-success" aria-live="polite">
            <CheckCircle2 size={30} />
            <h3>{t('onenote.complete.title')}</h3>
            <p>{t('onenote.complete.help')}</p>
            {/* The data attributes carry the measurements for tests and scripts/onenote-import-bench.mjs. */}
            <p
              className="onenote-import-help"
              data-testid="onenote-import-timing"
              data-timing={JSON.stringify(result.timing)}
              data-stats={JSON.stringify(result.stats)}
            >{t('onenote.complete.timing', {
              pages: result.stats.pages.toLocaleString(locale),
              strokes: result.stats.strokes.toLocaleString(locale),
              seconds: formatSeconds(result.timing.totalMs, locale),
            })}</p>
            <code>{t('onenote.receipt', { id: result.importId })}</code>
            <FidelityReports reports={result.fidelity} titles={result.pageTitles} t={t} />
            {rollbackError ? <div className="onenote-import-alert" role="alert"><AlertTriangle size={18} />{rollbackError}</div> : null}
            <div className="onenote-import-actions">
              <button type="button" onClick={() => void rollback()} disabled={Boolean(busy)}><RotateCcw size={16} /> {t('onenote.rollback')}</button>
              <button type="button" className="onenote-import-primary" onClick={closeDialog}>{t('onenote.openNotebook')}</button>
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}
