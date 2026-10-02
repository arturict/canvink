import { Settings2, X } from 'lucide-react';
import { useId, useRef, type KeyboardEvent } from 'react';
import type { LivePageDocV2 } from '../crdt';
import { PAGE_TAG_MAX_LENGTH, SUGGESTED_PAGE_TAGS } from '../domain/pageTags';
import { useI18n, type TranslationKey } from '../i18n';
import {
  activeRulingPreset,
  RULING_PRESETS,
  ruleSpacing,
  type PageBackground,
} from '../editor/paper';
import { applyPageRuling, applyRuleStyle, setPageTaskState } from './pageSettings';
import { RuleStyleControls, RulingSample, type PageChange } from './PaperMenus';
import './PageSettingsPanel.css';

export type PaperKind = PageBackground['type'];

export const PAPER_KINDS: ReadonlyArray<{ type: PaperKind; labelKey: TranslationKey; spacing?: number }> = [
  { type: 'plain', labelKey: 'workspace.page.background.plain' },
  { type: 'lined', labelKey: 'workspace.page.background.lined', spacing: 32 },
  { type: 'grid', labelKey: 'workspace.page.background.grid', spacing: 40 },
  { type: 'millimeter', labelKey: 'workspace.page.background.millimeter' },
];

export const SPACING_LABELS: Readonly<Record<string, TranslationKey>> = {
  'lines-narrow': 'pageSettings.spacing.narrow',
  'lines-college': 'pageSettings.spacing.college',
  'lines-standard': 'pageSettings.spacing.standard',
  'lines-wide': 'pageSettings.spacing.wide',
  'squares-small': 'pageSettings.spacing.small',
  'squares-medium': 'pageSettings.spacing.medium',
  'squares-large': 'pageSettings.spacing.large',
  'squares-xlarge': 'pageSettings.spacing.xlarge',
};

const TASK_STATES: ReadonlyArray<{ value: '' | 'open' | 'done'; labelKey: TranslationKey }> = [
  { value: '', labelKey: 'workspace.page.taskState.none' },
  { value: 'open', labelKey: 'workspace.page.taskState.open' },
  { value: 'done', labelKey: 'workspace.page.taskState.done' },
];

/**
 * The "Seiteneinstellungen" popover of the page header (a bottom sheet on
 * phones): paper with its lines, page mode, task state, template switch and
 * tags. Moving, copying and the page level live in the page list (context
 * menu, drag and drop), as in OneNote.
 */
export function PageSettingsPanel({
  page,
  isCanvas,
  viewerMode,
  isTemplate,
  tags,
  tagLimitReached,
  tagDraft,
  onTagDraft,
  onAddTag,
  onRemoveTag,
  onToggleTemplate,
  onChange,
}: {
  page: Pick<LivePageDocV2, 'background' | 'pageType' | 'taskState'>;
  isCanvas: boolean;
  viewerMode: boolean;
  isTemplate: boolean;
  tags: readonly string[];
  tagLimitReached: boolean;
  tagDraft: string;
  onTagDraft: (draft: string) => void;
  onAddTag: () => void;
  onRemoveTag: (tag: string) => void;
  onToggleTemplate: (enabled: boolean) => void;
  onChange: PageChange;
}) {
  const { t } = useI18n();
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const tagInputRef = useRef<HTMLInputElement>(null);
  const ids = useId();
  const background = page.background;
  const activePreset = activeRulingPreset(background);
  const presets = background.type === 'lined'
    ? RULING_PRESETS.lines
    : background.type === 'grid' ? RULING_PRESETS.squares : [];

  const close = () => {
    if (detailsRef.current) detailsRef.current.open = false;
  };
  const setRuling = (ruling: { type: PaperKind; spacing?: number }) => {
    const updatedAt = new Date().toISOString();
    onChange(t('workspace.operation.changeBackground'), (document) => {
      applyPageRuling(document, ruling, updatedAt);
    });
  };
  const chooseKind = (kind: (typeof PAPER_KINDS)[number]) => {
    if (background.type === kind.type) return;
    setRuling({ type: kind.type, spacing: kind.spacing });
  };
  const setMode = (pageType: LivePageDocV2['pageType']) => {
    if (page.pageType === pageType) return;
    const updatedAt = new Date().toISOString();
    onChange(t('workspace.operation.changePageMode'), (document) => {
      document.pageType = pageType;
      document.updatedAt = updatedAt;
    });
  };
  const setTaskState = (value: '' | 'open' | 'done') => {
    const taskState = value === '' ? undefined : value;
    const updatedAt = new Date().toISOString();
    onChange(t('workspace.operation.changeTaskState'), (document) => {
      setPageTaskState(document, taskState, updatedAt);
    });
  };
  const setStyle = (style: Parameters<typeof applyRuleStyle>[1]) => {
    const updatedAt = new Date().toISOString();
    onChange(t('workspace.operation.changeBackground'), (document) => {
      applyRuleStyle(document, style, updatedAt);
    });
  };
  const tagKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      if (tagDraft.trim()) onAddTag();
    } else if (event.key === 'Backspace' && tagDraft === '') {
      const last = tags.at(-1);
      if (last) onRemoveTag(last);
    }
  };

  return (
    <details ref={detailsRef} className="page-settings-menu" name="v2-page-menu">
      <summary
        role="button"
        aria-haspopup="menu"
        aria-label={t('workspace.page.settings')}
        title={t('workspace.page.settings')}
      >
        <Settings2 size={15} aria-hidden="true" />
        <span>{t('workspace.page.settings')}</span>
      </summary>
      <button type="button" className="page-settings-menu__scrim" tabIndex={-1} aria-hidden="true" onClick={close} />
      <div className="page-settings-menu__popover" role="group" aria-label={t('workspace.page.settings')}>
        <header>
          <strong>{t('workspace.page.settings')}</strong>
          <button
            type="button"
            className="v2-icon-button"
            aria-label={t('workspace.page.settings.close')}
            onClick={close}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </header>

        {isCanvas ? (
          <section className="settings-section" aria-labelledby={`${ids}-paper`}>
            <h3 id={`${ids}-paper`}>{t('pageSettings.paper')}</h3>
            <div className="paper-tiles" role="group" aria-label={t('workspace.page.background')}>
              {PAPER_KINDS.map((kind) => (
                <button
                  key={kind.type}
                  type="button"
                  className="paper-tile"
                  aria-pressed={background.type === kind.type}
                  disabled={viewerMode}
                  onClick={() => chooseKind(kind)}
                >
                  <RulingSample background={{ ...background, type: kind.type, spacing: kind.spacing }} />
                  <span>{t(kind.labelKey)}</span>
                </button>
              ))}
            </div>
            {presets.length > 0 ? (
              <div className="settings-row">
                <span className="settings-row__label">{t('pageSettings.spacing')}</span>
                <div className="paper-menu__segments" role="group" aria-label={t('pageSettings.spacing')}>
                  {presets.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      title={t(preset.labelKey)}
                      aria-pressed={activePreset === preset.id}
                      disabled={viewerMode}
                      onClick={() => setRuling(preset)}
                    >
                      {t(SPACING_LABELS[preset.id] ?? preset.labelKey)}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
            {background.type !== 'plain' && ruleSpacing(background) !== undefined ? (
              <RuleStyleControls background={background} disabled={viewerMode} onStyle={setStyle} />
            ) : null}
          </section>
        ) : null}

        <section className="settings-section" aria-labelledby={`${ids}-page`}>
          <h3 id={`${ids}-page`}>{t('pageSettings.page')}</h3>
          {isCanvas ? (
            <div className="settings-row">
              <span className="settings-row__label">{t('workspace.page.mode')}</span>
              <div className="paper-menu__segments" role="group" aria-label={t('workspace.page.mode')}>
                <button type="button" aria-pressed={page.pageType === 'free'} disabled={viewerMode} onClick={() => setMode('free')}>
                  {t('workspace.page.mode.free')}
                </button>
                <button type="button" aria-pressed={page.pageType === 'a4'} disabled={viewerMode} onClick={() => setMode('a4')}>
                  {t('workspace.page.mode.a4')}
                </button>
              </div>
            </div>
          ) : null}
          <div className="settings-row">
            <span className="settings-row__label">{t('pageSettings.task')}</span>
            <div className="paper-menu__segments" role="group" aria-label={t('workspace.page.taskState')}>
              {TASK_STATES.map((state) => (
                <button
                  key={state.value}
                  type="button"
                  aria-pressed={(page.taskState ?? '') === state.value}
                  disabled={viewerMode}
                  onClick={() => setTaskState(state.value)}
                >
                  {t(state.labelKey)}
                </button>
              ))}
            </div>
          </div>
          <div className="settings-row settings-row--switch" title={t('templates.useAsTemplate.hint')}>
            <span className="settings-row__label" id={`${ids}-template`}>{t('pageSettings.template')}</span>
            <button
              type="button"
              role="switch"
              className="switch"
              aria-checked={isTemplate}
              aria-labelledby={`${ids}-template`}
              disabled={viewerMode}
              onClick={() => onToggleTemplate(!isTemplate)}
            >
              <span aria-hidden="true" />
            </button>
          </div>
        </section>

        <section className="settings-section" aria-labelledby={`${ids}-tags`}>
          <h3 id={`${ids}-tags`}>{t('workspace.page.tags')}</h3>
          {/* The whole field acts as the input, as in a chip input; the
              chips and the text field inside stay real controls. */}
          <div className="chip-input" onClick={() => tagInputRef.current?.focus()}>
            <ul aria-labelledby={`${ids}-tags`}>
              {tags.map((tag) => (
                <li key={tag}>
                  <span>{tag}</span>
                  <button
                    type="button"
                    aria-label={t('workspace.page.tags.remove', { tag })}
                    disabled={viewerMode}
                    onClick={() => onRemoveTag(tag)}
                  >
                    <X size={11} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
            <input
              ref={tagInputRef}
              type="text"
              list={`${ids}-suggestions`}
              aria-label={t('workspace.page.tags.add')}
              placeholder={tags.length === 0 ? t('workspace.page.tags.placeholder') : ''}
              value={tagDraft}
              maxLength={PAGE_TAG_MAX_LENGTH}
              disabled={viewerMode || tagLimitReached}
              onChange={(event) => onTagDraft(event.target.value)}
              onKeyDown={tagKeyDown}
            />
            <datalist id={`${ids}-suggestions`}>
              {SUGGESTED_PAGE_TAGS.map((tag) => <option key={tag} value={tag} />)}
            </datalist>
          </div>
        </section>
      </div>
    </details>
  );
}
