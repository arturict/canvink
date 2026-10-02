import { Ban, Users, X } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { LiveNotebookDocV2, LivePageDocV2 } from '../crdt';
import {
  DEFAULT_PAPER_COLOR,
  DEFAULT_TEXT_COLOR,
  NOTEBOOK_SORT_KEYS,
  NOTEBOOK_TEXT_SIZES,
  normalizeNotebookIcon,
  resolveNotebookSettings,
  templateReferenceString,
  type NotebookSettingsPatch,
} from '../domain/notebookSettings';
import type { NotebookSortKey } from '../domain/v2';
import { formatLocale } from '../i18n/core';
import { useI18n, type TranslationKey } from '../i18n';
import { PAPER_CHOICES, RULING_PRESETS, activeRulingPreset, ruleSpacing } from '../editor/paper';
import type { V2RuntimeState, WorkspaceV2Runtime } from '../storage/workspaceV2Runtime';
import { useConfirm } from '../ui/ConfirmDialog';
import { composePdfFromPages, fileStem } from './assets/AssetWorkspaceControls';
import { downloadBlob, downloadBytes, exportNotebookBundle } from './assets';
import {
  formatBytes,
  measureNotebookStorage,
  notebookCounts,
  pageFootprint,
  type StorageMeasure,
  type StorageReader,
} from './notebookStats';
import { PAPER_KINDS, SPACING_LABELS } from './PageSettingsPanel';
import { RuleStyleControls, RulingSample } from './PaperMenus';
import { BUILTIN_TEMPLATES, type TemplatePageSummary } from './pageTemplates';
import { SECTION_COLOR_PALETTE } from './sectionColors';
import './PageSettingsPanel.css';
import './NotebookSettingsDialog.css';

/** The notebook's default colour (new notebooks start with it) followed by the section palette. */
export const NOTEBOOK_COLORS: ReadonlyArray<{ value: string; labelKey: TranslationKey }> = [
  { value: '#4f7c6d', labelKey: 'nbSettings.color.default' },
  ...SECTION_COLOR_PALETTE,
];

const NOTEBOOK_ICONS = ['📘', '📓', '📚', '🎓', '🧪', '🧮', '💼', '🏠', '✈️', '💡', '🎨', '🌱'] as const;

const PAPER_COLORS: ReadonlyArray<{ value: string; labelKey: TranslationKey }> = [
  { value: DEFAULT_PAPER_COLOR, labelKey: 'nbSettings.paperColor.white' },
  { value: '#fdf6e3', labelKey: 'nbSettings.paperColor.cream' },
  { value: '#eef1f4', labelKey: 'nbSettings.paperColor.grey' },
  { value: '#eaf4ec', labelKey: 'nbSettings.paperColor.mint' },
];

const TEXT_COLORS: ReadonlyArray<{ value: string; labelKey: TranslationKey }> = [
  { value: DEFAULT_TEXT_COLOR, labelKey: 'nbSettings.textColor.black' },
  { value: '#1e3a8a', labelKey: 'nbSettings.textColor.blue' },
  { value: '#166534', labelKey: 'nbSettings.textColor.green' },
  { value: '#991b1b', labelKey: 'nbSettings.textColor.red' },
  { value: '#475569', labelKey: 'nbSettings.textColor.grey' },
];

const SORT_LABELS: Readonly<Record<NotebookSortKey, TranslationKey>> = {
  manual: 'nbSettings.sort.manual',
  title: 'nbSettings.sort.title',
  created: 'nbSettings.sort.created',
  updated: 'nbSettings.sort.updated',
};

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface NotebookSharingState {
  state: 'private' | 'owner' | 'member';
  /** Replaces the default one-line summary, for example "Geteilt mit 2 Personen". */
  summary?: string;
  /** Whether this installation can share at all. */
  available: boolean;
}

export interface NotebookOfflineState {
  policy: 'all' | 'opened';
  /** Pages the account is still downloading to this device; absent when idle. */
  remaining?: number;
  onPolicyChange: (policy: 'all' | 'opened') => void;
}

export interface ApplyDefaultsResult {
  changed: number;
  total: number;
  skipped: number;
}

export interface NotebookSettingsDialogProps {
  notebook: LiveNotebookDocV2;
  workspace: V2RuntimeState;
  runtime: WorkspaceV2Runtime;
  templates: readonly TemplatePageSummary[];
  /** The notebook cannot be changed (a shared notebook opened read-only). */
  readOnly: boolean;
  sharing: NotebookSharingState;
  onOpenShare: () => void;
  /** Present when the account syncs this notebook to other devices. */
  offline?: NotebookOfflineState;
  /** The only notebook of the workspace cannot be trashed or left. */
  isLastNotebook: boolean;
  onSettings: (patch: NotebookSettingsPatch) => void;
  onRename: (title: string) => void;
  onColor: (color: string) => void;
  onApplyDefaults: () => Promise<ApplyDefaultsResult>;
  onTrash: () => void;
  onLeave: () => void;
  onClose: () => void;
  /** Focus goes back here when the dialog closes. */
  returnFocus?: HTMLElement | null;
}

function Section({ id, title, aside, children }: { id: string; title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="settings-section nb-settings__section" aria-labelledby={id}>
      <h3 id={id}>
        {title}
        {aside ? <small className="nb-settings__where">{aside}</small> : null}
      </h3>
      {children}
    </section>
  );
}

function Row({ label, labelId, children }: { label: string; labelId?: string; children: ReactNode }) {
  return (
    <div className="nb-settings__row">
      <span className="nb-settings__row-label" id={labelId}>{label}</span>
      <div className="nb-settings__row-control">{children}</div>
    </div>
  );
}

/** One-of-many buttons in a pill, as in the page settings. */
function Segments<T extends string | number>({
  label,
  value,
  options,
  disabled,
  onSelect,
}: {
  label: string;
  value: T | undefined;
  options: ReadonlyArray<{ value: T; label: string }>;
  disabled: boolean;
  onSelect: (value: T) => void;
}) {
  return (
    <div className="paper-menu__segments" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          disabled={disabled}
          onClick={() => onSelect(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Swatches({
  label,
  value,
  choices,
  disabled,
  onSelect,
}: {
  label: string;
  value: string;
  choices: ReadonlyArray<{ value: string; name: string; border?: boolean }>;
  disabled: boolean;
  onSelect: (value: string) => void;
}) {
  return (
    <div className="paper-menu__swatches" role="group" aria-label={label}>
      {choices.map((choice) => (
        <button
          key={choice.value}
          type="button"
          className="paper-menu__swatch"
          aria-label={choice.name}
          title={choice.name}
          aria-pressed={value.toLowerCase() === choice.value}
          disabled={disabled}
          style={{ background: choice.value }}
          onClick={() => onSelect(choice.value)}
        />
      ))}
    </div>
  );
}

/**
 * "Notizbuch-Einstellungen": the settings of one notebook, modelled on the
 * page settings and on OneNote's notebook properties. A modal dialog (the
 * whole screen on phones) in calm sections: general, defaults for new pages,
 * sorting, offline copies, sharing, export and the danger zone.
 *
 * Everything except the offline copies lives in the notebook document, so it
 * syncs to the other devices and to collaborators; what stays on this device
 * is labelled "auf diesem Gerät".
 */
export default function NotebookSettingsDialog({
  notebook,
  workspace,
  runtime,
  templates,
  readOnly,
  sharing,
  onOpenShare,
  offline,
  isLastNotebook,
  onSettings,
  onRename,
  onColor,
  onApplyDefaults,
  onTrash,
  onLeave,
  onClose,
  returnFocus,
}: NotebookSettingsDialogProps) {
  const { language, t } = useI18n();
  const { confirm, element: confirmElement } = useConfirm();
  const id = useId();
  const rootRef = useRef<HTMLElement>(null);
  const settings = useMemo(() => resolveNotebookSettings(notebook.settings), [notebook.settings]);
  const defaults = settings.newPage;
  const pages = useMemo(
    () => workspace.pages.filter((page) => page.notebookId === notebook.notebookId),
    [notebook.notebookId, workspace.pages],
  );
  const counts = notebookCounts(notebook, (documentId) => runtime.isDocumentAvailable(documentId));
  const lastChanged = pages.reduce((latest, page) => (page.updatedAt > latest ? page.updatedAt : latest), notebook.updatedAt);

  // The dialog holds focus: it opens on its own frame, not on a field, so a phone's keyboard stays down.
  useEffect(() => {
    const previous = returnFocus ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    rootRef.current?.focus({ preventScroll: true });
    return () => {
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
    // Only the element focused when the dialog opened matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const root = rootRef.current;
    if (!root) return;
    const focusable = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((element) => element.offsetParent !== null);
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === root)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  // --- General -------------------------------------------------------------
  const [name, setName] = useState(notebook.title);
  // A rename from elsewhere (another device, the switcher) replaces what the field shows.
  const [shownTitle, setShownTitle] = useState(notebook.title);
  if (shownTitle !== notebook.title) {
    setShownTitle(notebook.title);
    setName(notebook.title);
  }
  const commitName = () => {
    const title = name.trim();
    if (!title) setName(notebook.title);
    else if (title !== notebook.title) onRename(title);
  };

  const [customIcon, setCustomIcon] = useState('');
  const customIconInvalid = customIcon.trim() !== '' && normalizeNotebookIcon(customIcon) === undefined;
  const colorChoices = NOTEBOOK_COLORS.some((choice) => choice.value === notebook.color.toLowerCase())
    ? NOTEBOOK_COLORS
    : [{ value: notebook.color.toLowerCase(), labelKey: 'nbSettings.color' as const }, ...NOTEBOOK_COLORS];

  const [storage, setStorage] = useState<StorageMeasure | null>(null);
  useEffect(() => {
    let cancelled = false;
    const reader: StorageReader = {
      documentBytes: (documentId) => (runtime.isDocumentAvailable(documentId)
        ? runtime.storedDocumentBytes(documentId).catch(() => 0)
        : Promise.resolve(0)),
      pageFootprint: async (documentId) => {
        const page = runtime.isDocumentAvailable(documentId)
          ? workspace.pages.find((candidate) => candidate.documentId === documentId)
          : undefined;
        if (!page) return null;
        // Reading a page that is not open loads it for this read only and frees it again.
        return runtime.readPage(page.pageId, (document) => pageFootprint(document as unknown as LivePageDocV2)).catch(() => null);
      },
    };
    void measureNotebookStorage(notebook, reader, (measure) => {
      if (!cancelled) setStorage(measure);
    }, () => cancelled);
    return () => { cancelled = true; };
    // One pass per opening: editing a setting does not change what the notebook weighs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime, notebook.documentId]);
  const locale = formatLocale(language);
  const dateFormat = useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }), [locale]);
  const formatDate = (iso: string) => {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? '' : dateFormat.format(date);
  };
  const storageDone = storage !== null && storage.measuredPages >= counts.pagesOnDevice;
  const storageText = storage === null
    ? t('nbSettings.storage.calculating')
    : storageDone
      ? formatBytes(storage.bytes, locale)
      : t('nbSettings.storage.partial', {
        size: formatBytes(storage.bytes, locale),
        done: storage.measuredPages,
        total: counts.pagesOnDevice,
      });

  // --- New pages -----------------------------------------------------------
  const background = {
    type: defaults.ruling,
    color: defaults.paperColor,
    spacing: defaults.spacing,
    lineColor: defaults.lineColor,
    lineStrength: defaults.lineStrength,
  };
  const presets = defaults.ruling === 'lined'
    ? RULING_PRESETS.lines
    : defaults.ruling === 'grid' ? RULING_PRESETS.squares : [];
  const activePreset = activeRulingPreset(background);
  const locked = readOnly;
  const patchNewPage = (newPage: NonNullable<NotebookSettingsPatch['newPage']>) => onSettings({ newPage });

  const templateValue = defaults.template ? templateReferenceString(defaults.template) : '';
  const template = defaults.template;
  const templateKnown = !template
    || (template.kind === 'builtin'
      ? BUILTIN_TEMPLATES.some((builtin) => builtin.id === template.id)
      : templates.some((candidate) => candidate.pageId === template.pageId));

  const [applyState, setApplyState] = useState<{ kind: 'idle' } | { kind: 'working' } | { kind: 'done'; result: ApplyDefaultsResult } | { kind: 'failed' }>({ kind: 'idle' });
  const applyAll = async () => {
    const confirmed = await confirm({
      title: t('nbSettings.applyAll.title'),
      message: t('nbSettings.applyAll.confirm', { title: notebook.title }),
      confirmLabel: t('nbSettings.applyAll.action'),
    });
    if (!confirmed) return;
    setApplyState({ kind: 'working' });
    try {
      setApplyState({ kind: 'done', result: await onApplyDefaults() });
    } catch {
      setApplyState({ kind: 'failed' });
    }
  };

  // --- Export --------------------------------------------------------------
  const [exportState, setExportState] = useState<{ kind: 'idle' } | { kind: 'working'; progress?: string } | { kind: 'done'; message: string } | { kind: 'failed'; message: string }>({ kind: 'idle' });
  const runExport = async (kind: 'pdf' | 'bundle') => {
    setExportState({ kind: 'working' });
    try {
      if (kind === 'pdf') {
        const pageIds = notebook.sections.flatMap((section) => section.pageDocumentIds.map((documentId) => {
          const page = pages.find((candidate) => candidate.documentId === documentId);
          if (!page) throw new Error(t('nbSettings.export.notOnDevice'));
          return page.pageId;
        }));
        const bytes = await composePdfFromPages(runtime, pageIds);
        downloadBytes(bytes, 'application/pdf', `${fileStem(notebook.title)}.pdf`);
        setExportState({ kind: 'done', message: t('nbSettings.export.pdfDone', { title: notebook.title }) });
      } else {
        const blob = await exportNotebookBundle(runtime, workspace, notebook.notebookId, {
          onProgress: (done, total) => setExportState({ kind: 'working', progress: `${done} / ${total}` }),
        });
        downloadBlob(blob, `${fileStem(notebook.title)}.canvink`);
        setExportState({ kind: 'done', message: t('nbSettings.export.bundleDone', { title: notebook.title }) });
      }
    } catch (error) {
      setExportState({ kind: 'failed', message: error instanceof Error && error.message ? error.message : t('nbSettings.export.failed') });
    }
  };

  // --- Danger zone ---------------------------------------------------------
  const trash = async () => {
    const confirmed = await confirm({
      title: t('nbSettings.trash.title'),
      message: t('nbSettings.trash.confirm', { title: notebook.title }),
      confirmLabel: t('nbSettings.trash.action'),
      danger: true,
    });
    if (!confirmed) return;
    onClose();
    onTrash();
  };

  const sharingSummary = sharing.summary ?? t(
    sharing.state === 'owner' ? 'nbSettings.sharing.owner' : sharing.state === 'member' ? 'nbSettings.sharing.member' : 'nbSettings.sharing.private',
  );
  const sectionId = (part: string) => `${id}-${part}`;
  const keepAll = offline?.policy === 'all';

  return (
    <div
      className="recovery-overlay nb-settings-overlay"
      role="presentation"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={rootRef}
        className="nb-settings"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <header className="nb-settings__header">
          <span className="nb-settings__dot" style={{ background: notebook.color }} aria-hidden="true">
            {settings.icon ?? ''}
          </span>
          <div className="nb-settings__heading">
            <h2 id={`${id}-title`}>{t('nbSettings.title')}</h2>
            <p>{notebook.title}</p>
          </div>
          <button type="button" className="v2-icon-button" aria-label={t('nbSettings.close')} onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </button>
        </header>

        <div className="nb-settings__body">
          {readOnly ? <p className="nb-settings__notice" role="status">{t('nbSettings.readOnly')}</p> : null}

          <Section id={sectionId('general')} title={t('nbSettings.general')}>
            <Row label={t('nbSettings.name')} labelId={sectionId('name')}>
              <input
                type="text"
                className="nb-settings__input"
                aria-labelledby={sectionId('name')}
                value={name}
                maxLength={120}
                autoComplete="off"
                enterKeyHint="done"
                disabled={locked}
                onChange={(event) => setName(event.target.value)}
                onBlur={commitName}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing) return;
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    event.currentTarget.blur();
                  } else if (event.key === 'Escape' && name !== notebook.title) {
                    // Escape undoes the edit first; a second Escape closes the dialog.
                    event.preventDefault();
                    event.stopPropagation();
                    setName(notebook.title);
                  }
                }}
              />
            </Row>
            <Row label={t('nbSettings.color')}>
              <Swatches
                label={t('nbSettings.color')}
                value={notebook.color}
                choices={colorChoices.map((choice) => ({ value: choice.value, name: choice.labelKey === 'nbSettings.color' ? choice.value : t(choice.labelKey) }))}
                disabled={locked}
                onSelect={onColor}
              />
            </Row>
            <Row label={t('nbSettings.icon')}>
              <div className="nb-settings__icons" role="group" aria-label={t('nbSettings.icon')}>
                <button
                  type="button"
                  className="nb-settings__icon-button nb-settings__icon-button--none"
                  aria-pressed={settings.icon === undefined}
                  aria-label={t('nbSettings.icon.none')}
                  title={t('nbSettings.icon.none')}
                  disabled={locked}
                  onClick={() => onSettings({ icon: null })}
                >
                  <Ban size={14} aria-hidden="true" />
                </button>
                {NOTEBOOK_ICONS.map((symbol) => (
                  <button
                    key={symbol}
                    type="button"
                    className="nb-settings__icon-button"
                    aria-pressed={settings.icon === symbol}
                    aria-label={t('nbSettings.icon.pick', { symbol })}
                    disabled={locked}
                    onClick={() => onSettings({ icon: symbol })}
                  >
                    <span aria-hidden="true">{symbol}</span>
                  </button>
                ))}
                <input
                  type="text"
                  className="nb-settings__input nb-settings__input--icon"
                  aria-label={t('nbSettings.icon.custom')}
                  aria-invalid={customIconInvalid}
                  placeholder="＋"
                  value={customIcon}
                  maxLength={16}
                  autoComplete="off"
                  disabled={locked}
                  onChange={(event) => {
                    setCustomIcon(event.target.value);
                    const symbol = normalizeNotebookIcon(event.target.value);
                    if (symbol) onSettings({ icon: symbol });
                  }}
                />
              </div>
              {customIconInvalid ? <p className="nb-settings__hint" role="alert">{t('nbSettings.icon.invalid')}</p> : null}
            </Row>
            <dl className="nb-settings__facts">
              <div><dt>{t('nbSettings.created')}</dt><dd>{formatDate(notebook.createdAt)}</dd></div>
              <div><dt>{t('nbSettings.changed')}</dt><dd>{formatDate(lastChanged)}</dd></div>
              <div><dt>{t('nbSettings.sections')}</dt><dd>{counts.sections}</dd></div>
              <div><dt>{t('nbSettings.pages')}</dt><dd>{counts.pages}</dd></div>
              <div>
                <dt>{t('nbSettings.storage')}</dt>
                <dd title={t('nbSettings.storage.hint')} aria-live="polite">
                  {storageText} <small className="nb-settings__where">{t('nbSettings.thisDevice')}</small>
                </dd>
              </div>
            </dl>
          </Section>

          <Section id={sectionId('new')} title={t('nbSettings.newPages')}>
            <p className="nb-settings__hint">{t('nbSettings.newPages.hint')}</p>
            <div className="paper-tiles" role="group" aria-label={t('workspace.page.background')}>
              {PAPER_KINDS.map((kind) => (
                <button
                  key={kind.type}
                  type="button"
                  className="paper-tile"
                  aria-pressed={defaults.ruling === kind.type}
                  disabled={locked}
                  onClick={() => patchNewPage({ ruling: kind.type, spacing: null })}
                >
                  <RulingSample background={{ ...background, type: kind.type, spacing: kind.spacing, color: defaults.paperColor }} />
                  <span>{t(kind.labelKey)}</span>
                </button>
              ))}
            </div>
            {presets.length > 0 ? (
              <Row label={t('pageSettings.spacing')}>
                <div className="paper-menu__segments" role="group" aria-label={t('pageSettings.spacing')}>
                  {presets.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      aria-pressed={activePreset === preset.id}
                      disabled={locked}
                      onClick={() => patchNewPage({ spacing: preset.spacing ?? null })}
                    >
                      {t(SPACING_LABELS[preset.id] ?? preset.labelKey)}
                    </button>
                  ))}
                </div>
              </Row>
            ) : null}
            {defaults.ruling !== 'plain' && ruleSpacing(background) !== undefined ? (
              <RuleStyleControls
                background={background}
                disabled={locked}
                onStyle={(style) => patchNewPage({
                  ...(style.lineColor !== undefined ? { lineColor: style.lineColor } : {}),
                  ...(style.lineStrength !== undefined ? { lineStrength: style.lineStrength } : {}),
                })}
              />
            ) : null}
            <Row label={t('nbSettings.paperColor')}>
              <Swatches
                label={t('nbSettings.paperColor')}
                value={defaults.paperColor}
                choices={PAPER_COLORS.map((choice) => ({ value: choice.value, name: t(choice.labelKey) }))}
                disabled={locked}
                onSelect={(paperColor) => patchNewPage({ paperColor })}
              />
            </Row>
            <Row label={t('nbSettings.sheet')}>
              <Segments
                label={t('nbSettings.sheet')}
                value={defaults.pageType}
                disabled={locked}
                options={[
                  { value: 'free' as const, label: t('nbSettings.sheet.free') },
                  { value: 'a4' as const, label: t('nbSettings.sheet.fixed') },
                ]}
                onSelect={(pageType) => patchNewPage({ pageType })}
              />
            </Row>
            {defaults.pageType === 'a4' ? (
              <Row label={t('nbSettings.sheet.size')} labelId={sectionId('sheet-size')}>
                <select
                  className="nb-settings__select"
                  aria-labelledby={sectionId('sheet-size')}
                  disabled={locked}
                  value={`${defaults.paper.size}-${defaults.paper.orientation}`}
                  onChange={(event) => {
                    const choice = PAPER_CHOICES.find((candidate) => `${candidate.paper.size}-${candidate.paper.orientation}` === event.target.value);
                    if (choice) patchNewPage({ paper: choice.paper });
                  }}
                >
                  {PAPER_CHOICES.map((choice) => (
                    <option key={`${choice.paper.size}-${choice.paper.orientation}`} value={`${choice.paper.size}-${choice.paper.orientation}`}>
                      {t(choice.labelKey)}
                    </option>
                  ))}
                </select>
              </Row>
            ) : null}
            <Row label={t('nbSettings.template')} labelId={sectionId('template')}>
              <select
                className="nb-settings__select"
                aria-labelledby={sectionId('template')}
                disabled={locked}
                value={templateKnown ? templateValue : ''}
                onChange={(event) => patchNewPage({ template: event.target.value || null })}
              >
                <option value="">{t('nbSettings.template.none')}</option>
                <optgroup label={t('nbSettings.template.builtin')}>
                  {BUILTIN_TEMPLATES.map((template) => (
                    <option key={template.id} value={`builtin:${template.id}`}>{t(template.labelKey)}</option>
                  ))}
                </optgroup>
                {templates.length > 0 ? (
                  <optgroup label={t('nbSettings.template.mine')}>
                    {templates.map((template) => (
                      <option key={template.pageId} value={`page:${template.pageId}`}>{template.title}</option>
                    ))}
                  </optgroup>
                ) : null}
              </select>
            </Row>
            <p className="nb-settings__hint">
              {t(templateKnown ? 'nbSettings.template.hint' : 'nbSettings.template.missing')}
            </p>
            <Row label={t('nbSettings.text.size')}>
              <Segments
                label={t('nbSettings.text.size')}
                value={defaults.textSize}
                disabled={locked}
                options={NOTEBOOK_TEXT_SIZES.map((size) => ({ value: size, label: String(size) }))}
                onSelect={(textSize) => patchNewPage({ textSize })}
              />
            </Row>
            <Row label={t('nbSettings.text.color')}>
              <Swatches
                label={t('nbSettings.text.color')}
                value={defaults.textColor}
                choices={TEXT_COLORS.map((choice) => ({ value: choice.value, name: t(choice.labelKey) }))}
                disabled={locked}
                onSelect={(textColor) => patchNewPage({ textColor })}
              />
            </Row>
            <p className="nb-settings__hint">{t('nbSettings.text.hint')}</p>
            <div className="nb-settings__action">
              <button type="button" disabled={locked || applyState.kind === 'working'} onClick={() => void applyAll()}>
                {applyState.kind === 'working' ? t('nbSettings.applyAll.working') : t('nbSettings.applyAll')}
              </button>
              <p className="nb-settings__hint">{t('nbSettings.applyAll.hint')}</p>
              <div role="status" className="nb-settings__result">
                {applyState.kind === 'done' ? (
                  <>
                    <span>
                      {applyState.result.changed === 0
                        ? t('nbSettings.applyAll.same')
                        : t('nbSettings.applyAll.done', { changed: applyState.result.changed, total: applyState.result.total })}
                    </span>
                    {applyState.result.skipped > 0
                      ? <span>{t('nbSettings.applyAll.skipped', { skipped: applyState.result.skipped })}</span>
                      : null}
                  </>
                ) : applyState.kind === 'failed' ? t('nbSettings.applyAll.failed') : null}
              </div>
            </div>
          </Section>

          <Section id={sectionId('sort')} title={t('nbSettings.sort')}>
            {(['sections', 'pages'] as const).map((scope) => (
              <Row key={scope} label={t(scope === 'sections' ? 'nbSettings.sort.sections' : 'nbSettings.sort.pages')}>
                <Segments
                  label={t(scope === 'sections' ? 'nbSettings.sort.sections' : 'nbSettings.sort.pages')}
                  value={settings.sort[scope]}
                  disabled={locked}
                  options={NOTEBOOK_SORT_KEYS.map((key) => ({ value: key, label: t(SORT_LABELS[key]) }))}
                  onSelect={(key) => onSettings({ sort: { [scope]: key } })}
                />
              </Row>
            ))}
            <p className="nb-settings__hint">{t('nbSettings.sort.hint')}</p>
          </Section>

          <Section id={sectionId('offline')} title={t('nbSettings.offline')} aside={t('nbSettings.thisDevice')}>
            {offline ? (
              <>
                <div className="nb-settings__row nb-settings__row--status">
                  <span className="nb-settings__row-label">{t('nbSettings.offline.pagesHere')}</span>
                  <strong>{t('nbSettings.offline.pagesHere.value', { here: counts.pagesOnDevice, total: counts.pages })}</strong>
                </div>
                <p className="nb-settings__hint" role="status">
                  {offline.remaining !== undefined && offline.remaining > 0
                    ? t('nbSettings.offline.downloading', { remaining: offline.remaining })
                    : counts.pagesOnDevice >= counts.pages
                      ? t('nbSettings.offline.complete')
                      : t('nbSettings.offline.openedOnly')}
                </p>
                <div className="settings-row settings-row--switch nb-settings__switch">
                  <span className="settings-row__label" id={sectionId('keep-all')}>
                    {t('nbSettings.offline.keepAll')}
                    <small>{t('nbSettings.offline.keepAll.hint')}</small>
                  </span>
                  <button
                    type="button"
                    role="switch"
                    className="switch"
                    aria-checked={keepAll}
                    aria-labelledby={sectionId('keep-all')}
                    onClick={() => offline.onPolicyChange(keepAll ? 'opened' : 'all')}
                  >
                    <span aria-hidden="true" />
                  </button>
                </div>
              </>
            ) : (
              <p className="nb-settings__hint">{t('nbSettings.offline.local')}</p>
            )}
          </Section>

          <Section id={sectionId('sharing')} title={t('nbSettings.sharing')}>
            <div className="nb-settings__row nb-settings__row--status">
              <span className="nb-settings__share-state">
                {sharing.state !== 'private' ? <Users size={14} aria-hidden="true" /> : null}
                <strong>{sharingSummary}</strong>
              </span>
              {sharing.available && sharing.state !== 'member' ? (
                <button type="button" disabled={locked} onClick={onOpenShare}>{t('nbSettings.sharing.manage')}</button>
              ) : null}
            </div>
            {!sharing.available ? <p className="nb-settings__hint">{t('nbSettings.sharing.unavailable')}</p> : null}
            {sharing.state === 'member' ? <p className="nb-settings__hint">{t('nbSettings.sharing.memberHint')}</p> : null}
          </Section>

          <Section id={sectionId('export')} title={t('nbSettings.export')}>
            <div className="nb-settings__buttons">
              <button type="button" disabled={exportState.kind === 'working'} onClick={() => void runExport('pdf')}>
                {t('nbSettings.export.pdf')}
              </button>
              <button type="button" disabled={exportState.kind === 'working'} onClick={() => void runExport('bundle')}>
                {t('nbSettings.export.bundle')}
              </button>
            </div>
            <p className="nb-settings__hint">{t('nbSettings.export.hint')}</p>
            <div role="status" className="nb-settings__result">
              {exportState.kind === 'working'
                ? `${t('nbSettings.export.working')}${exportState.progress ? ` ${exportState.progress}` : ''}`
                : exportState.kind === 'done' || exportState.kind === 'failed' ? exportState.message : null}
            </div>
          </Section>

          <Section id={sectionId('danger')} title={t('nbSettings.danger')}>
            <div className="nb-settings__danger">
              {sharing.state === 'member' ? (
                <div className="nb-settings__action">
                  <button type="button" className="nb-settings__danger-button" disabled={isLastNotebook} onClick={() => { onClose(); onLeave(); }}>
                    {t('nbSettings.leave')}
                  </button>
                  <p className="nb-settings__hint">{isLastNotebook ? t('nbSettings.trash.last') : t('nbSettings.leave.hint')}</p>
                </div>
              ) : (
                <div className="nb-settings__action">
                  <button type="button" className="nb-settings__danger-button" disabled={locked || isLastNotebook} onClick={() => void trash()}>
                    {t('nbSettings.trash')}
                  </button>
                  <p className="nb-settings__hint">{isLastNotebook ? t('nbSettings.trash.last') : t('nbSettings.trash.hint')}</p>
                </div>
              )}
            </div>
          </Section>
        </div>
        {confirmElement}
      </section>
    </div>
  );
}
