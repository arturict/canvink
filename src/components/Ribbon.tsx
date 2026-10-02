import type { ReactNode } from 'react';
import { useI18n, type TranslationKey } from '../i18n';
import { VIEWER_APP } from '../platform/viewerApp';

export type RibbonTab = 'home' | 'insert' | 'draw' | 'view';

const ALL_TABS: ReadonlyArray<{ id: RibbonTab; labelKey: TranslationKey }> = [
  { id: 'home', labelKey: 'ribbon.home' },
  { id: 'insert', labelKey: 'ribbon.insert' },
  { id: 'draw', labelKey: 'ribbon.draw' },
  { id: 'view', labelKey: 'ribbon.view' },
];

/** The phone viewer shows only what it can do: text editing and the view. Hidden panels stay mounted. */
const TABS = VIEWER_APP ? ALL_TABS.filter(({ id }) => id === 'home' || id === 'view') : ALL_TABS;

export interface RibbonSlotRefs {
  home: (element: HTMLDivElement | null) => void;
  insert: (element: HTMLDivElement | null) => void;
  draw: (element: HTMLDivElement | null) => void;
  view: (element: HTMLDivElement | null) => void;
}

/**
 * OneNote's simplified ribbon: a row of tabs and one row of commands for the
 * active tab. The page editor and the asset controls portal their groups into
 * the slots; groups owned by the notebook shell are passed as children per
 * tab. Inactive panels stay mounted (hidden) so portals keep their targets.
 */
export function Ribbon({
  tab,
  onTab,
  slotRefs,
  before,
  end,
  insertExtras,
  drawExtras,
  viewExtras,
}: {
  tab: RibbonTab;
  onTab: (tab: RibbonTab) => void;
  slotRefs: RibbonSlotRefs;
  /** Shown before the tabs, like OneNote's "File". */
  before?: ReactNode;
  /** Shown at the right end of the tab row. */
  end?: ReactNode;
  insertExtras?: ReactNode;
  drawExtras?: ReactNode;
  viewExtras?: ReactNode;
}) {
  const { t } = useI18n();
  const panel = (id: RibbonTab, extras?: ReactNode, extrasFirst = false) => (
    <div
      id={`ribbon-panel-${id}`}
      className="ribbon__panel"
      role="tabpanel"
      aria-labelledby={`ribbon-tab-${id}`}
      hidden={tab !== id}
    >
      {extrasFirst ? extras : null}
      <div ref={slotRefs[id]} className="ribbon__slot" />
      {extrasFirst ? null : extras}
    </div>
  );
  return (
    <section className="ribbon" aria-label={t('ribbon.label')}>
      <div className="ribbon__tabs">
        {before}
        <div className="ribbon__tablist" role="tablist" aria-label={t('ribbon.label')}>
          {TABS.map(({ id, labelKey }) => (
            <button
              key={id}
              id={`ribbon-tab-${id}`}
              type="button"
              role="tab"
              aria-selected={tab === id}
              aria-controls={`ribbon-panel-${id}`}
              tabIndex={tab === id ? 0 : -1}
              className="ribbon__tab"
              onClick={() => onTab(id)}
              onKeyDown={(event) => {
                if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
                const index = TABS.findIndex((candidate) => candidate.id === tab);
                const next = TABS[(index + (event.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length];
                onTab(next.id);
                document.getElementById(`ribbon-tab-${next.id}`)?.focus();
              }}
            >
              {t(labelKey)}
            </button>
          ))}
        </div>
        <div className="ribbon__end">{end}</div>
      </div>
      <div className="ribbon__card">
        {panel('home')}
        {panel('insert', insertExtras)}
        {panel('draw', drawExtras)}
        {panel('view', viewExtras, true)}
      </div>
    </section>
  );
}
