import {
  forwardRef,
  useId,
  useMemo,
  useState,
  type CSSProperties,
} from 'react';
import {
  BookOpen,
  ChevronDown,
  ChevronRight,
  FilePlus2,
  FileText,
  FolderPlus,
  Pencil,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import type { Notebook, Page, Section } from '../domain/types';

export interface SidebarProps {
  notebooks: Notebook[];
  activeNotebookId: string;
  activeSectionId: string;
  activePageId: string;
  trashCount: number;
  id?: string;
  modal?: boolean;
  onClose: () => void;
  onActivatePage: (notebookId: string, sectionId: string, pageId: string) => void;
  onActivateNotebook: (notebookId: string) => void;
  onAddNotebook: () => void;
  onRenameNotebook: () => void;
  onAddSection: () => void;
  onRenameSection: (sectionId: string) => void;
  onAddPage: (sectionId: string, parentPageId?: string) => void;
  onTrashNotebook: () => void;
  onTrashSection: (sectionId: string) => void;
  onTrashPage: (sectionId: string, pageId: string) => void;
  onOpenTrash: () => void;
}

interface PageTreeProps {
  pages: Page[];
  parentPageId?: string;
  activePageId: string;
  sectionId: string;
  notebookId: string;
  depth?: number;
  onActivate: SidebarProps['onActivatePage'];
  onAddSubpage: (parentPageId: string) => void;
  onTrash: (sectionId: string, pageId: string) => void;
}

function PageTree({
  pages,
  parentPageId,
  activePageId,
  sectionId,
  notebookId,
  depth = 0,
  onActivate,
  onAddSubpage,
  onTrash,
}: PageTreeProps) {
  const children = pages.filter((page) => page.parentPageId === parentPageId);

  if (children.length === 0) return null;

  return (
    <div role="list">
      {children.map((page) => (
        <div key={page.id} role="listitem">
          <div
            className={`page-row ${activePageId === page.id ? 'is-active' : ''}`}
            style={{ '--page-depth': depth } as CSSProperties}
          >
            <button
              type="button"
              className="page-row__target"
              onClick={() => onActivate(notebookId, sectionId, page.id)}
              aria-current={activePageId === page.id ? 'page' : undefined}
            >
              <FileText size={14} />
              <span>{page.title}</span>
              <small>{page.mode === 'a4' ? 'A4' : 'Free'}</small>
            </button>
            <div className="row-actions">
              <button
                type="button"
                title={`Add subpage below ${page.title}`}
                onClick={() => onAddSubpage(page.id)}
              >
                <FilePlus2 size={13} />
              </button>
              <button
                type="button"
                title={`Move ${page.title} to trash`}
                disabled={pages.length === 1}
                onClick={() => onTrash(sectionId, page.id)}
              >
                <Trash2 size={13} />
              </button>
            </div>
          </div>
          <PageTree
            pages={pages}
            parentPageId={page.id}
            activePageId={activePageId}
            sectionId={sectionId}
            notebookId={notebookId}
            depth={depth + 1}
            onActivate={onActivate}
            onAddSubpage={onAddSubpage}
            onTrash={onTrash}
          />
        </div>
      ))}
    </div>
  );
}

const Sidebar = forwardRef<HTMLDivElement, SidebarProps>(function Sidebar(
  {
    notebooks,
    activeNotebookId,
    activeSectionId,
    activePageId,
    trashCount,
    id = 'notebook-navigation',
    modal = false,
    onClose,
    onActivatePage,
    onActivateNotebook,
    onAddNotebook,
    onRenameNotebook,
    onAddSection,
    onRenameSection,
    onAddPage,
    onTrashNotebook,
    onTrashSection,
    onTrashPage,
    onOpenTrash,
  },
  ref,
) {
  const activeNotebook = notebooks.find((item) => item.id === activeNotebookId) ?? notebooks[0];
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(() => new Set());
  const sectionListId = useId();
  const safeRootPageIds = useMemo(() => {
    const roots = new Map<string, Set<string>>();
    for (const section of activeNotebook.sections) {
      const ids = new Set(section.pages.map((page) => page.id));
      roots.set(
        section.id,
        new Set(
          section.pages
            .filter((page) => !page.parentPageId || !ids.has(page.parentPageId))
            .map((page) => page.id),
        ),
      );
    }
    return roots;
  }, [activeNotebook.sections]);

  const toggleSection = (sectionId: string) => {
    setCollapsedSections((current) => {
      const next = new Set(current);
      if (next.has(sectionId)) next.delete(sectionId);
      else next.add(sectionId);
      return next;
    });
  };

  return (
    <div
      ref={ref}
      id={id}
      className="notebook-sidebar"
      aria-label="Notebook navigation"
      aria-modal={modal || undefined}
      role={modal ? 'dialog' : 'navigation'}
    >
      <div className="sidebar-brand">
        <span className="brand-mark">
          <BookOpen size={17} />
        </span>
        <div>
          <strong>Canvink</strong>
          <small>Local notebook</small>
        </div>
        <button
          type="button"
          className="sidebar-close"
          onClick={onClose}
          aria-label="Close notebook navigation"
        >
          <X size={17} />
        </button>
      </div>

      <div className="notebook-picker">
        <label htmlFor="notebook-select">Notebook</label>
        <div>
          <span className="notebook-color" style={{ background: activeNotebook.color }} />
          <select
            id="notebook-select"
            value={activeNotebook.id}
            onChange={(event) => onActivateNotebook(event.target.value)}
          >
            {notebooks.map((notebook) => (
              <option key={notebook.id} value={notebook.id}>
                {notebook.title}
              </option>
            ))}
          </select>
          <button type="button" title="New notebook" onClick={onAddNotebook}>
            <Plus size={16} />
          </button>
          <button type="button" title="Rename notebook" onClick={onRenameNotebook}>
            <Pencil size={14} />
          </button>
        </div>
        <button
          type="button"
          className="quiet-danger notebook-delete"
          disabled={notebooks.length === 1}
          onClick={onTrashNotebook}
        >
          <Trash2 size={13} />
          Move notebook to trash
        </button>
      </div>

      <div className="sidebar-heading">
        <span>Sections</span>
        <button type="button" title="New section" onClick={onAddSection}>
          <FolderPlus size={15} />
        </button>
      </div>

      <div className="section-list" role="list" aria-label="Sections">
        {activeNotebook.sections.map((section: Section, sectionIndex) => {
          const collapsed = collapsedSections.has(section.id);
          const sectionPagesId = `${sectionListId}-pages-${sectionIndex}`;
          const rootIds = safeRootPageIds.get(section.id) ?? new Set<string>();
          const normalizedPages = section.pages.map((page) =>
            rootIds.has(page.id) ? { ...page, parentPageId: undefined } : page,
          );
          return (
            <section
              className={`section-block ${activeSectionId === section.id ? 'is-current' : ''}`}
              key={section.id}
              role="listitem"
            >
              <div className="section-row">
                <button
                  type="button"
                  onClick={() => toggleSection(section.id)}
                  aria-expanded={!collapsed}
                  aria-controls={sectionPagesId}
                >
                  {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                  <span>{section.title}</span>
                  <small>{section.pages.length}</small>
                </button>
                <button
                  type="button"
                  className="section-rename"
                  title={`Rename ${section.title}`}
                  onClick={() => onRenameSection(section.id)}
                >
                  <Pencil size={12} />
                </button>
                <button
                  type="button"
                  className="section-trash"
                  title={`Move ${section.title} to trash`}
                  disabled={activeNotebook.sections.length === 1}
                  onClick={() => onTrashSection(section.id)}
                >
                  <Trash2 size={12} />
                </button>
              </div>
              <div id={sectionPagesId} className="page-tree" hidden={collapsed}>
                <PageTree
                  pages={normalizedPages}
                  activePageId={activePageId}
                  sectionId={section.id}
                  notebookId={activeNotebook.id}
                  onActivate={onActivatePage}
                  onAddSubpage={(parentPageId) => onAddPage(section.id, parentPageId)}
                  onTrash={onTrashPage}
                />
                <button
                  type="button"
                  className="add-page"
                  onClick={() => {
                    onAddPage(section.id);
                  }}
                >
                  <Plus size={14} />
                  New page
                </button>
              </div>
            </section>
          );
        })}
      </div>

      <button type="button" className="trash-link" onClick={onOpenTrash}>
        <Trash2 size={16} />
        Trash
        <span>{trashCount}</span>
      </button>
    </div>
  );
});

export default Sidebar;
