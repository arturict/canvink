import { FileText, Rows3 } from 'lucide-react';
import type { LivePageDocV2 } from '../crdt';
import type { PagePaperV1 } from '../domain/v3';
import { useI18n } from '../i18n';
import {
  activeRulingPreset,
  PAPER_CHOICES,
  pagePaper,
  RULE_COLORS,
  RULE_STRENGTHS,
  RULING_PRESETS,
  ruleBaseColor,
  rulePatternStyle,
  ruleStrength,
  samePaper,
  type PageBackground,
} from '../editor/paper';
import { RibbonPopover } from '../editor/RibbonPopover';
import { applyPagePaper, applyPageRuling, applyRuleStyle } from './pageSettings';
import './PaperMenus.css';

export type PageChange = (message: string, change: (document: LivePageDocV2) => void) => unknown;

/** A small square of paper showing a ruling, as in OneNote's line gallery. */
export function RulingSample({ background }: { background: PageBackground }) {
  return (
    <span
      className="paper-menu__sample"
      aria-hidden="true"
      style={{ backgroundColor: '#fff', ...rulePatternStyle(background, 0.35, { x: 0, y: 0 }) }}
    />
  );
}

/**
 * Line colour and strength, shared by the Ansicht "Linien" gallery (stacked
 * under headings) and the page settings panel (inline rows).
 */
export function RuleStyleControls({
  background,
  disabled = false,
  headings = false,
  onStyle,
}: {
  background: PageBackground;
  disabled?: boolean;
  headings?: boolean;
  onStyle: (style: Parameters<typeof applyRuleStyle>[1]) => void;
}) {
  const { t } = useI18n();
  const colors = (
    <div className="paper-menu__swatches" role="group" aria-label={t('paper.color')}>
      {RULE_COLORS.map((choice) => (
        <button
          key={choice.color}
          type="button"
          className="paper-menu__swatch"
          aria-label={t(choice.labelKey)}
          title={t(choice.labelKey)}
          aria-pressed={ruleBaseColor(background) === choice.color}
          disabled={disabled}
          style={{ background: choice.color }}
          onClick={() => onStyle({ lineColor: choice.color })}
        />
      ))}
    </div>
  );
  const strengths = (
    <div className="paper-menu__segments" role="group" aria-label={t('paper.strength')}>
      {RULE_STRENGTHS.map((choice) => (
        <button
          key={choice.strength}
          type="button"
          aria-pressed={ruleStrength(background) === choice.strength}
          disabled={disabled}
          onClick={() => onStyle({ lineStrength: choice.strength })}
        >
          {t(choice.labelKey)}
        </button>
      ))}
    </div>
  );
  if (headings) {
    return (
      <>
        <p className="paper-menu__heading">{t('paper.color')}</p>
        {colors}
        <p className="paper-menu__heading">{t('paper.strength')}</p>
        {strengths}
      </>
    );
  }
  return (
    <>
      <div className="settings-row">
        <span className="settings-row__label">{t('paper.color')}</span>
        {colors}
      </div>
      <div className="settings-row">
        <span className="settings-row__label">{t('paper.strength')}</span>
        {strengths}
      </div>
    </>
  );
}

/**
 * OneNote's "Ansicht > Linien" and "Papiergrösse": the rule lines of the page
 * (none, lines or squares in several sizes, millimetre paper, line colour and
 * strength) and its paper (free, or a fixed A4, A5 or Letter sheet).
 */
export function PaperMenus({
  page,
  disabled,
  onChange,
}: {
  page: Pick<LivePageDocV2, 'background' | 'pageType' | 'paper'>;
  disabled: boolean;
  onChange: PageChange;
}) {
  const { t } = useI18n();
  const background = page.background;
  const active = activeRulingPreset(background);
  const style = { lineColor: background.lineColor, lineStrength: background.lineStrength };
  const setRuling = (ruling: { type: PageBackground['type']; spacing?: number }) => {
    const updatedAt = new Date().toISOString();
    onChange(t('workspace.operation.changeBackground'), (document) => {
      applyPageRuling(document, ruling, updatedAt);
    });
  };
  const setStyle = (next: Parameters<typeof applyRuleStyle>[1]) => {
    const updatedAt = new Date().toISOString();
    onChange(t('workspace.operation.changeBackground'), (document) => {
      applyRuleStyle(document, next, updatedAt);
    });
  };
  const setPaper = (paper: PagePaperV1 | null) => {
    const updatedAt = new Date().toISOString();
    onChange(t('workspace.operation.changePageMode'), (document) => {
      applyPagePaper(document, paper, updatedAt);
    });
  };
  const currentPaper = page.pageType === 'a4' ? pagePaper(page) : null;
  const rulingOption = (
    id: string,
    label: string,
    ruling: { type: PageBackground['type']; spacing?: number },
  ) => (
    <button
      key={id}
      type="button"
      className="paper-menu__option"
      aria-pressed={active === id}
      onClick={() => setRuling(ruling)}
    >
      <RulingSample background={{ ...background, ...style, type: ruling.type, spacing: ruling.spacing }} />
      <span>{label}</span>
    </button>
  );

  return (
    <>
      <RibbonPopover
        label={t('paper.lines')}
        disabled={disabled}
        className="ribbon-button--labelled"
        buttonContent={<><Rows3 aria-hidden="true" /><span>{t('paper.lines')}</span></>}
        panelClassName="paper-menu"
      >
        {rulingOption('none', t('paper.lines.none'), { type: 'plain' })}
        <p className="paper-menu__heading">{t('paper.lines.group')}</p>
        <div className="paper-menu__grid">
          {RULING_PRESETS.lines.map((preset) => rulingOption(preset.id, t(preset.labelKey), preset))}
        </div>
        <p className="paper-menu__heading">{t('paper.squares.group')}</p>
        <div className="paper-menu__grid">
          {RULING_PRESETS.squares.map((preset) => rulingOption(preset.id, t(preset.labelKey), preset))}
        </div>
        {rulingOption('millimeter', t('paper.millimeter'), { type: 'millimeter' })}
        <RuleStyleControls
          background={background}
          disabled={disabled}
          headings
          onStyle={setStyle}
        />
      </RibbonPopover>
      <RibbonPopover
        label={t('paper.size')}
        disabled={disabled}
        className="ribbon-button--labelled"
        buttonContent={<><FileText aria-hidden="true" /><span>{t('paper.size')}</span></>}
        panelClassName="paper-menu paper-menu--size"
      >
        {(close) => (
          <>
            <button
              type="button"
              className="paper-menu__option"
              aria-pressed={currentPaper === null}
              onClick={() => { setPaper(null); close(); }}
            >
              <span className="paper-menu__sheet paper-menu__sheet--free" aria-hidden="true" />
              <span>{t('paper.size.free')}</span>
            </button>
            <p className="paper-menu__heading">{t('paper.size.fixed')}</p>
            <div className="paper-menu__grid">
              {PAPER_CHOICES.map((choice) => (
                <button
                  key={`${choice.paper.size}-${choice.paper.orientation}`}
                  type="button"
                  className="paper-menu__option"
                  aria-pressed={currentPaper !== null && samePaper(currentPaper, choice.paper)}
                  onClick={() => { setPaper(choice.paper); close(); }}
                >
                  <span
                    className={`paper-menu__sheet paper-menu__sheet--${choice.paper.orientation}`}
                    aria-hidden="true"
                  />
                  <span>{t(choice.labelKey)}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </RibbonPopover>
    </>
  );
}
