import { useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { BookOpen, ChevronDown, ChevronRight, Folder, NotebookTabs, Users } from 'lucide-react';
import type { LiveNotebookDocV2 } from '../../crdt';
import { formatLocale } from '../../i18n/core';
import { useI18n } from '../../i18n';
import { sectionColor } from '../../components/sectionColors';
import type { SectionGroupNode } from '../../domain/sectionGroups';
import { loadJoinedRooms } from '../../components/collab/joinedRoomStore';
import { loadOwnerRooms } from '../../components/collab/ownerRoomStore';
import type { PageSummary } from '../../storage/workspaceV2Runtime';
import { notebookTree, orderedSections, sectionPages, type PageEntry } from '../model';
import { EmptyState, ListScreen, SectionDot } from '../ui';
import type { MobileWorkspace } from '../useMobileWorkspace';
import { PageRow } from './HomeScreen';

type Section = LiveNotebookDocV2['sections'][number];
type Group = NonNullable<LiveNotebookDocV2['sectionGroups']>[number];

/** The notebooks, as OneNote's phone app lists them: a coloured spine, the title, how much is inside. */
export function NotebooksScreen({
  ws,
  onOpen,
  onRefresh,
}: {
  ws: MobileWorkspace;
  onOpen: (notebookId: string) => void;
  onRefresh: () => Promise<void> | void;
}) {
  const { t, plural } = useI18n();
  const shared = useMemo(() => {
    void ws.workspace;
    const owned = loadOwnerRooms();
    const joined = loadJoinedRooms();
    return new Set(ws.notebooks.filter((notebook) => owned[notebook.notebookId] || joined[notebook.notebookId]).map((notebook) => notebook.notebookId));
  }, [ws.notebooks, ws.workspace]);
  return (
    <ListScreen title={t('mobile.tab.notebooks')} onRefresh={onRefresh} testId="mobile-notebooks">
      {ws.notebooks.length === 0 ? (
        <EmptyState icon={<NotebookTabs size={28} />} title={t('mobile.notebooks.empty')} />
      ) : (
        <ul className="m-list m-list--cards" role="list">
          {ws.notebooks.map((notebook) => {
            const pages = notebook.sections.reduce((total, section) => total + section.pageDocumentIds.length, 0);
            return (
              <li key={notebook.notebookId}>
                <button
                  type="button"
                  className="m-notebook m-ripple"
                  style={{ '--m-notebook': notebook.color || '#4f7c6d' } as CSSProperties}
                  onClick={() => onOpen(notebook.notebookId)}
                >
                  <span className="m-notebook__spine" aria-hidden="true"><BookOpen size={20} /></span>
                  <span className="m-row__text">
                    <span className="m-row__title">{notebook.title}</span>
                    <span className="m-row__meta">
                      {plural(notebook.sections.length, { one: 'mobile.notebook.sections.one', other: 'mobile.notebook.sections.other' })}
                      {' · '}
                      {plural(pages, { one: 'mobile.notebook.pages.one', other: 'mobile.notebook.pages.other' })}
                    </span>
                  </span>
                  {shared.has(notebook.notebookId) ? (
                    <span className="m-row__trail" title={t('mobile.notebook.shared')}>
                      <Users size={16} aria-label={t('mobile.notebook.shared')} />
                    </span>
                  ) : null}
                  <ChevronRight size={18} aria-hidden="true" className="m-row__chevron" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </ListScreen>
  );
}

/** A notebook's sections with their colours; section groups fold open in place. */
export function NotebookScreen({
  notebook,
  onBack,
  onOpenSection,
  onRefresh,
}: {
  notebook: LiveNotebookDocV2 | undefined;
  onBack: () => void;
  onOpenSection: (sectionId: string) => void;
  onRefresh: () => Promise<void> | void;
}) {
  const { t, plural } = useI18n();
  const tree = useMemo(() => (notebook ? notebookTree(notebook) : null), [notebook]);
  if (!notebook || !tree) {
    return (
      <ListScreen title={t('mobile.missing.title')} onBack={onBack}>
        <EmptyState icon={<NotebookTabs size={28} />} title={t('mobile.missing.title')} text={t('mobile.missing.text')} />
      </ListScreen>
    );
  }
  const sectionRow = (section: Section) => (
    <li key={section.id}>
      <button type="button" className="m-row m-ripple" onClick={() => onOpenSection(section.id)} data-testid="mobile-section-row">
        <span className="m-row__lead m-section-tab" style={{ background: sectionColor(section) }} aria-hidden="true" />
        <span className="m-row__text">
          <span className="m-row__title">{section.title}</span>
          <span className="m-row__meta">{plural(section.pageDocumentIds.length, { one: 'mobile.notebook.pages.one', other: 'mobile.notebook.pages.other' })}</span>
        </span>
        <ChevronRight size={18} aria-hidden="true" className="m-row__chevron" />
      </button>
    </li>
  );
  return (
    <ListScreen
      title={notebook.title}
      subtitle={plural(notebook.sections.length, { one: 'mobile.notebook.sections.one', other: 'mobile.notebook.sections.other' })}
      onBack={onBack}
      onRefresh={onRefresh}
      accent={notebook.color || undefined}
      testId="mobile-notebook"
    >
      <ul className="m-list" role="list">
        {tree.sections.map(sectionRow)}
        {tree.groups.map((node) => <GroupRows key={node.group.id} node={node} sectionRow={sectionRow} />)}
      </ul>
      {notebook.sections.length === 0 ? <EmptyState icon={<NotebookTabs size={28} />} title={t('mobile.notebook.empty')} /> : null}
    </ListScreen>
  );
}

function GroupRows({ node, sectionRow }: { node: SectionGroupNode<Section, Group>; sectionRow: (section: Section) => ReactNode }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <li className="m-group-row" data-depth={node.depth || undefined}>
      <button type="button" className="m-row m-ripple" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span className="m-row__lead" aria-hidden="true"><Folder size={20} /></span>
        <span className="m-row__text">
          <span className="m-row__title">{node.group.title}</span>
          <span className="m-row__meta">{t('mobile.notebook.group')}</span>
        </span>
        <ChevronDown size={18} aria-hidden="true" className="m-row__chevron" data-open={open ? 'true' : undefined} />
      </button>
      {open ? (
        <ul className="m-list m-list--nested" role="list">
          {node.sections.map(sectionRow)}
          {node.groups.map((child) => <GroupRows key={child.group.id} node={child} sectionRow={sectionRow} />)}
        </ul>
      ) : null}
    </li>
  );
}

/**
 * A section's pages, newest structure first as in the notebook, subpages
 * indented. The section's colour runs along the top, and the notebook's
 * other sections sit in a row of chips to switch without going back.
 */
export function SectionScreen({
  ws,
  notebook,
  sectionId,
  byDocumentId,
  now,
  onBack,
  onSwitchSection,
  onOpenPage,
  onRefresh,
}: {
  ws: MobileWorkspace;
  notebook: LiveNotebookDocV2 | undefined;
  sectionId: string;
  byDocumentId: ReadonlyMap<string, PageSummary>;
  now: Date;
  onBack: () => void;
  onSwitchSection: (sectionId: string) => void;
  onOpenPage: (entry: PageEntry) => void;
  onRefresh: () => Promise<void> | void;
}) {
  const { t, language } = useI18n();
  const locale = formatLocale(language);
  const section = notebook?.sections.find((candidate) => candidate.id === sectionId);
  const pages = useMemo(() => (section ? sectionPages(section, byDocumentId) : []), [byDocumentId, section]);
  const siblings = useMemo(() => (notebook ? orderedSections(notebook) : []), [notebook]);
  if (!notebook || !section) {
    return (
      <ListScreen title={t('mobile.missing.title')} onBack={onBack}>
        <EmptyState icon={<NotebookTabs size={28} />} title={t('mobile.missing.title')} text={t('mobile.missing.text')} />
      </ListScreen>
    );
  }
  const color = sectionColor(section);
  const chips = siblings.length > 1 ? (
    <nav className="m-chips" aria-label={t('mobile.section.others')}>
      {siblings.map((candidate) => (
        <button
          key={candidate.id}
          type="button"
          className="m-chip m-ripple"
          aria-current={candidate.id === section.id ? 'page' : undefined}
          onClick={() => {
            if (candidate.id !== section.id) onSwitchSection(candidate.id);
          }}
        >
          <SectionDot color={sectionColor(candidate)} size={8} />
          {candidate.title}
        </button>
      ))}
    </nav>
  ) : undefined;
  return (
    <ListScreen
      title={section.title}
      subtitle={<span className="m-location"><SectionDot color={color} />{notebook.title}</span>}
      onBack={onBack}
      onRefresh={onRefresh}
      accent={color}
      header={chips}
      testId="mobile-section"
    >
      {pages.length === 0 ? (
        <EmptyState icon={<NotebookTabs size={28} />} title={t('mobile.section.empty')} />
      ) : (
        <ul className="m-list" role="list">
          {pages.map(({ page, depth }) => (
            <li key={page.pageId}>
              <PageRow
                entry={{
                  page,
                  notebookId: notebook.notebookId,
                  notebookTitle: notebook.title,
                  sectionId: section.id,
                  sectionTitle: section.title,
                  sectionColor: color,
                }}
                depth={depth}
                showLocation={false}
                now={now}
                locale={locale}
                available={ws.isAvailable(page.documentId)}
                onOpen={onOpenPage}
              />
            </li>
          ))}
        </ul>
      )}
    </ListScreen>
  );
}
