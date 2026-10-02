import {
  createContext,
  forwardRef,
  memo,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import {
  ArrowDown,
  ArrowUp,
  BookOpen,
  ChevronDown,
  ChevronRight,
  Copy,
  RefreshCw,
  FilePlus2,
  FileText,
  FolderClosed,
  FolderInput,
  FolderOpen,
  FolderPlus,
  IndentDecrease,
  IndentIncrease,
  LayoutTemplate,
  Palette,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import type { Notebook, Page, Section, SectionGroup } from '../domain/types';
import {
  buildSectionTree,
  canMoveGroupInto,
  effectiveGroupParents,
  effectiveSectionGroupId,
  groupAncestry,
  groupSubtreeIds,
  sectionsInGroup,
  type SectionGroupNode,
} from '../domain/sectionGroups';
import {
  BUILTIN_TEMPLATES,
  type PageTemplateSource,
  type TemplatePageSummary,
} from './pageTemplates';
import { useI18n } from '../i18n';
import { InlineRename } from '../ui/InlineRename';
import { useStableCallback } from '../ui/useStableCallback';
import {
  contextMenuTriggerProps,
  useContextMenu,
  type ContextMenuEntry,
} from '../ui/ContextMenu';
import type { MenuPoint } from '../ui/contextMenuModel';
import { ColumnResizer, useColumnWidth } from './ColumnResizer';
import MoveCopyDialog, { type MoveCopyTarget } from './MoveCopyDialog';
import type { QuickAccessEntry } from './pagePins';
import {
  desiredDepth,
  gapFromMidpoints,
  indentTarget,
  isNoopDrop,
  outdentTarget,
  resolvePageDrop,
  type PageDropTarget,
} from './pageTreeDrop';
import { SECTION_COLOR_PALETTE, sectionColor } from './sectionColors';
import { useNavigationCollapse } from './navigationCollapse';

export { sectionColor } from './sectionColors';
import { PagePresenceDots } from './collab/presence/PagePresence';

export interface SidebarProps {
  notebooks: Notebook[];
  activeNotebookId: string;
  activeSectionId: string;
  activePageId: string;
  /** The page last open in each section, kept by the shell so it also
   * follows keyboard navigation while this panel is not mounted. */
  lastPageBySection?: ReadonlyMap<string, string>;
  trashCount: number;
  id?: string;
  modal?: boolean;
  onClose: () => void;
  onActivatePage: (notebookId: string, sectionId: string, pageId: string) => void;
  /**
   * Notebook switching and management live in the title bar's notebook
   * switcher; these stay optional for the legacy schema-v1 shell.
   */
  onActivateNotebook?: (notebookId: string) => void;
  onAddNotebook?: () => void;
  onRenameNotebook?: () => void;
  onTrashNotebook?: () => void;
  /** Creates a section, inside `groupId` when given. */
  onAddSection: (groupId?: string) => void;
  /** Called with the new, non-empty name once an inline rename is confirmed. */
  onRenameSection: (sectionId: string, title: string) => void;
  onRenamePage?: (sectionId: string, pageId: string, title: string) => void;
  onAddPage: (
    sectionId: string,
    parentPageId?: string,
    pageKind?: 'canvas' | 'markdown',
  ) => void;
  /**
   * "tree" nests pages under their sections (phones); "panes" shows the
   * sections and the pages of the active section in two columns, like
   * OneNote's navigation and page list.
   */
  layout?: 'tree' | 'panes';
  /** Pages tagged as templates; one inside a section becomes its default. */
  templates?: readonly TemplatePageSummary[];
  onAddPageFromTemplate?: (sectionId: string, source: PageTemplateSource) => void;
  /**
   * The notebook's default template (Notizbuch-Einstellungen): "Add page" in a
   * section without a template of its own starts from it.
   */
  notebookTemplate?: { source: PageTemplateSource; title: string };
  onTrashSection: (sectionId: string) => void;
  onTrashPage: (sectionId: string, pageId: string) => void;
  onDuplicatePage: (sectionId: string, pageId: string) => void;
  /** Writes the page again in the current ink format (a fresh document with its ink in segments); the old page goes to the trash. */
  onRebuildPage?: (sectionId: string, pageId: string) => void;
  onReorderPage: (
    sectionId: string,
    pageId: string,
    direction: 'up' | 'down',
  ) => void;
  onTransferPage?: (request: PageTransferRequest) => void;
  onTransferNotebook?: (request: NotebookTransferRequest) => void;
  onTransferSection?: (request: SectionTransferRequest) => void;
  /** Section groups ("Abschnittsgruppen"); absent handlers hide the commands. */
  /**
   * Creates a group with the default name and returns its id, so the
   * navigation can show it in rename mode at once.
   */
  onAddSectionGroup?: (parentGroupId?: string) => string | undefined;
  onRenameSectionGroup?: (groupId: string, title: string) => void;
  onTrashSectionGroup?: (groupId: string) => void;
  onTransferSectionGroup?: (request: SectionGroupTransferRequest) => void;
  onOpenTrash: () => void;
  /** Pinned pages ("Schnellzugriff"), shown at the top of the navigation. */
  quickAccess?: readonly QuickAccessEntry[];
  pinnedPageIds?: ReadonlySet<string>;
  onSetPagePinned?: (pageId: string, pinned: boolean) => void;
  onSetPageTemplate?: (pageId: string, enabled: boolean) => void;
  onSetSectionColor?: (sectionId: string, color: string | undefined) => void;
  /**
   * A notebook switcher for the navigation's own header. On phones the
   * navigation covers the title bar, so it carries its own switcher.
   */
  notebookSwitcher?: ReactNode;
  capabilities?: Partial<SidebarCapabilities>;
}

export type PageDropPlacement = 'root' | 'before' | 'inside' | 'after';

export interface PageTransferRequest {
  sourceNotebookId: string;
  sourceSectionId: string;
  pageId: string;
  targetNotebookId: string;
  targetSectionId: string;
  targetPageId?: string;
  placement: PageDropPlacement;
  copy: boolean;
}

export interface NotebookTransferRequest {
  notebookId: string;
  targetNotebookId: string;
  placement: 'before' | 'after';
  copy: boolean;
}

export interface SectionTransferRequest {
  sourceNotebookId: string;
  sectionId: string;
  targetNotebookId: string;
  /** With "before"/"after" the section joins this section's group. */
  targetSectionId?: string;
  placement: 'before' | 'inside' | 'after';
  /**
   * With "inside": the section group the section ends up last in; absent
   * means the notebook's top level.
   */
  targetGroupId?: string;
  copy: boolean;
}

/** Moves a section group within its notebook. */
export interface SectionGroupTransferRequest {
  notebookId: string;
  groupId: string;
  /** The new parent group; absent means the notebook's top level. */
  targetParentGroupId?: string;
  /** A sibling group to land next to; without it the group goes last. */
  anchor?: { groupId: string; placement: 'before' | 'after' };
}

interface SidebarCapabilities {
  createNotebook: boolean;
  createSection: boolean;
  createPage: boolean;
  renameNotebook: boolean;
  renameSection: boolean;
  renamePage: boolean;
  trashNotebook: boolean;
  trashSection: boolean;
  trashPage: boolean;
  duplicatePage: boolean;
  reorderPage: boolean;
  transferPage: boolean;
  reorderNotebook: boolean;
  duplicateNotebook: boolean;
  reorderSection: boolean;
  duplicateSection: boolean;
  transferSection: boolean;
  openTrash: boolean;
  pinPage: boolean;
  templatePage: boolean;
  colorSection: boolean;
  createSectionGroup: boolean;
  manageSectionGroups: boolean;
}

const ALL_SIDEBAR_CAPABILITIES: Readonly<SidebarCapabilities> = Object.freeze({
  createNotebook: true,
  createSection: true,
  createPage: true,
  renameNotebook: true,
  renameSection: true,
  renamePage: true,
  trashNotebook: true,
  trashSection: true,
  trashPage: true,
  duplicatePage: true,
  reorderPage: true,
  transferPage: true,
  reorderNotebook: true,
  duplicateNotebook: true,
  reorderSection: true,
  duplicateSection: true,
  transferSection: true,
  openTrash: true,
  pinPage: true,
  templatePage: true,
  colorSection: true,
  createSectionGroup: true,
  manageSectionGroups: true,
});

const SECTION_DRAG_TYPE = 'application/x-canvink-section';
const GROUP_DRAG_TYPE = 'application/x-canvink-section-group';
/**
 * Indentation per subpage level. OneNote indents subpages by about a tab
 * stop, so levels read at a glance; `.page-row` padding uses the same value.
 */
export const PAGE_INDENT_PX = 20;
/** Left padding of a top-level page row in each layout. */
const PAGE_ROW_BASE_PX = { panes: 10, tree: 44 } as const;
/** Indentation per section group level; matches `--nav-depth-step`. */
const SECTION_INDENT_PX = 16;

function closeDetailsMenu(event: ReactMouseEvent<HTMLElement>): void {
  event.currentTarget.closest('details')?.removeAttribute('open');
}

function copyModifier(event: { ctrlKey: boolean; altKey: boolean; metaKey?: boolean }): boolean {
  return event.ctrlKey || event.altKey;
}

/** What a page drag carries while it is in flight. */
interface PageDrag {
  pageId: string;
  sectionId: string;
  /** The page and its subpages: dropping among them means "stay". */
  subtree: ReadonlySet<string>;
  startX: number;
  depth: number;
}

interface DropIndicator {
  sectionId: string;
  top: number;
  target: PageDropTarget;
}

/** A section or section group being dragged in the section list. */
interface StructureDrag {
  kind: 'section' | 'group';
  id: string;
}

/** Where a section or group drop would land, for the drop indicator. */
interface StructureDrop {
  key: string;
  placement: 'before' | 'after' | 'inside';
}

type NavKey = `section:${string}` | `group:${string}` | `page:${string}`;

/**
 * What a page row does. Fixed identities (see `useStableCallback`), so a
 * memoised row does not re-render because the sidebar did.
 */
interface PageRowActions {
  activate: SidebarProps['onActivatePage'];
  openMenu: (point: MenuPoint, trigger: HTMLElement, sectionId: string, page: Page) => void;
  startDrag: (event: ReactDragEvent<HTMLElement>, sectionId: string, page: Page, depth: number) => void;
  endDrag: () => void;
  toggleCollapsed: (pageId: string) => void;
  finishRename: (sectionId: string, pageId: string, title: string | null) => void;
}

interface PageTreeContextValue {
  activePageId: string;
  notebookId: string;
  templatePageIds: ReadonlySet<string>;
  pinnedPageIds: ReadonlySet<string>;
  isCollapsed: (pageId: string) => boolean;
  tabStop: NavKey | undefined;
  actions: PageRowActions;
  drag: PageDrag | null;
  canDrag: boolean;
  /** The page whose title is being edited in place. */
  renamingPageId: string | undefined;
  /** Nav key of the section row that owns these pages in the tree layout. */
  parentKey?: NavKey;
}

const PageTreeContext = createContext<PageTreeContextValue | null>(null);

function usePageTree(): PageTreeContextValue {
  const value = useContext(PageTreeContext);
  if (!value) throw new Error('PageTree rendered outside its Sidebar.');
  return value;
}

interface PageRowProps {
  page: Page;
  sectionId: string;
  depth: number;
  parentKey?: NavKey;
  notebookId: string;
  hasChildren: boolean;
  collapsed: boolean;
  active: boolean;
  pinned: boolean;
  isTemplate: boolean;
  /** The row that holds the list's one Tab stop. */
  tabbable: boolean;
  dragging: boolean;
  canDrag: boolean;
  renaming: boolean;
  actions: PageRowActions;
}

/**
 * One row of the page list. Everything that varies is a primitive prop, so a
 * change in one page (a title typed, the open page switching) re-renders its
 * row and leaves the other rows of a long section alone.
 */
const PageRow = memo(function PageRow({
  page,
  sectionId,
  depth,
  parentKey,
  notebookId,
  hasChildren,
  collapsed,
  active,
  pinned,
  isTemplate,
  tabbable,
  dragging,
  canDrag,
  renaming,
  actions,
}: PageRowProps) {
  const { t } = useI18n();
  const navKey: NavKey = `page:${page.id}`;
  const trigger = contextMenuTriggerProps((point, element) => actions.openMenu(point, element, sectionId, page));
  return (
    <div
      className={`page-row ${active ? 'is-active' : ''}`}
      style={{ '--page-depth': depth } as CSSProperties}
      data-page-row-id={page.id}
      data-depth={depth}
      data-dragging={dragging || undefined}
    >
      {renaming ? (
        <div className="page-row__target page-row__target--editing">
          <InlineRename
            value={page.title}
            label={t('workspace.page.title')}
            onDone={(title) => actions.finishRename(sectionId, page.id, title)}
          />
        </div>
      ) : (
      <button
        type="button"
        className="page-row__target"
        draggable={canDrag}
        aria-keyshortcuts="Shift+F10"
        tabIndex={tabbable ? 0 : -1}
        data-nav-item={navKey}
        data-nav-parent={parentKey}
        data-nav-expanded={hasChildren ? String(!collapsed) : undefined}
        title={page.title}
        {...trigger}
        onDragStart={(event) => actions.startDrag(event, sectionId, page, depth)}
        onDragEnd={actions.endDrag}
        onClick={() => actions.activate(notebookId, sectionId, page.id)}
        aria-current={active ? 'page' : undefined}
      >
        <span className="page-row__title">{page.title}</span>
        <PagePresenceDots pageId={page.id} />
        {pinned ? (
          <Pin size={12} className="page-row__pin" aria-label={t('sidebar.page.pinned')} />
        ) : null}
        {isTemplate ? <small className="page-row__template">{t('templates.badge')}</small> : null}
        {/* OneNote lists only titles; the page type stays available to
            screen readers, and the paper itself shows it on the page. */}
        <small className="sr-only">{page.mode === 'a4' ? 'A4' : t('sidebar.page.free')}</small>
      </button>
      )}
      {hasChildren ? (
        <button
          type="button"
          className="page-row__toggle"
          tabIndex={-1}
          aria-expanded={!collapsed}
          aria-label={t(collapsed ? 'sidebar.page.expand' : 'sidebar.page.collapse', { title: page.title })}
          title={t(collapsed ? 'sidebar.page.expand' : 'sidebar.page.collapse', { title: page.title })}
          onClick={() => actions.toggleCollapsed(page.id)}
        >
          {collapsed ? <ChevronRight size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
        </button>
      ) : null}
    </div>
  );
});

function PageTree({
  pages,
  parentPageId,
  sectionId,
  depth = 0,
  parentKey,
}: {
  pages: Page[];
  parentPageId?: string;
  sectionId: string;
  depth?: number;
  parentKey?: NavKey;
}) {
  const tree = usePageTree();
  const children = pages.filter((page) => page.parentPageId === parentPageId);
  if (children.length === 0) return null;
  const parentIds = new Set<string>();
  for (const candidate of pages) if (candidate.parentPageId !== undefined) parentIds.add(candidate.parentPageId);

  return (
    <div role="list">
      {children.map((page) => {
        const hasChildren = parentIds.has(page.id);
        const collapsed = hasChildren && tree.isCollapsed(page.id);
        const navKey: NavKey = `page:${page.id}`;
        return (
          <div key={page.id} role="listitem">
            <PageRow
              page={page}
              sectionId={sectionId}
              depth={depth}
              parentKey={parentKey}
              notebookId={tree.notebookId}
              hasChildren={hasChildren}
              collapsed={collapsed}
              active={tree.activePageId === page.id}
              pinned={tree.pinnedPageIds.has(page.id)}
              isTemplate={tree.templatePageIds.has(page.id)}
              tabbable={tree.tabStop === navKey}
              dragging={tree.drag?.pageId === page.id}
              canDrag={tree.canDrag}
              renaming={tree.renamingPageId === page.id}
              actions={tree.actions}
            />
            {hasChildren && !collapsed ? (
              <PageTree pages={pages} parentPageId={page.id} sectionId={sectionId} depth={depth + 1} parentKey={navKey} />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function descendantsOf(pages: readonly Page[], pageId: string): Set<string> {
  const descendants = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const candidate of pages) {
      if (
        candidate.parentPageId
        && (candidate.parentPageId === pageId || descendants.has(candidate.parentPageId))
        && !descendants.has(candidate.id)
        && candidate.id !== pageId
      ) {
        descendants.add(candidate.id);
        changed = true;
      }
    }
  }
  return descendants;
}

/** The chain of parent pages above a page, outermost first. */
function pageAncestors(pages: readonly Page[], pageId: string): string[] {
  const byId = new Map(pages.map((page) => [page.id, page]));
  const chain: string[] = [];
  const seen = new Set([pageId]);
  for (let parent = byId.get(pageId)?.parentPageId; parent && byId.has(parent) && !seen.has(parent); parent = byId.get(parent)?.parentPageId) {
    seen.add(parent);
    chain.unshift(parent);
  }
  return chain;
}

/** Visible rows of one page tree container, measured for a drop. */
function measureRows(container: HTMLElement, exclude: ReadonlySet<string>) {
  return [...container.querySelectorAll<HTMLElement>('.page-row[data-page-row-id]')]
    .filter((element) => !exclude.has(element.dataset.pageRowId ?? ''))
    .map((element) => ({
      id: element.dataset.pageRowId ?? '',
      depth: Number(element.dataset.depth ?? 0),
      rect: element.getBoundingClientRect(),
    }));
}

/**
 * Arrow-key navigation over the rows of a list, like a tree view: up and
 * down move between visible rows, right unfolds or enters, left folds or
 * returns to the parent row; Home and End jump to the ends; F2 renames
 * the row in place.
 */
function handleNavKeyDown(
  event: ReactKeyboardEvent<HTMLElement>,
  toggle: (key: NavKey) => void,
  rename: (key: NavKey) => void,
): void {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  if (!(event.target instanceof HTMLElement)) return;
  const current = event.target.closest<HTMLElement>('[data-nav-item]');
  if (!current || !event.currentTarget.contains(current)) return;
  const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-nav-item]')]
    .filter((item) => item.getClientRects().length > 0);
  const index = items.indexOf(current);
  const key = current.dataset.navItem as NavKey;
  const expanded = current.dataset.navExpanded;
  let next: HTMLElement | undefined;
  switch (event.key) {
    case 'F2':
      event.preventDefault();
      rename(key);
      return;
    case 'ArrowDown': next = items[index + 1]; break;
    case 'ArrowUp': next = items[index - 1]; break;
    case 'Home': next = items[0]; break;
    case 'End': next = items.at(-1); break;
    case 'ArrowRight':
      if (expanded === 'false') {
        event.preventDefault();
        toggle(key);
        return;
      }
      if (expanded === 'true') next = items[index + 1];
      break;
    case 'ArrowLeft':
      if (expanded === 'true') {
        event.preventDefault();
        toggle(key);
        return;
      }
      next = items.find((item) => item.dataset.navItem === current.dataset.navParent);
      break;
    default:
      return;
  }
  event.preventDefault();
  next?.focus();
}

type MoveCopyRequest =
  | { kind: 'page'; sectionId: string; page: Page; returnFocus: HTMLElement | null }
  | { kind: 'section'; section: Section; returnFocus: HTMLElement | null }
  | { kind: 'group'; group: SectionGroup; returnFocus: HTMLElement | null };

const normalizedPagesCache = new WeakMap<Section, Page[]>();

/**
 * The pages of a section with orphans (a parent that is not in the section)
 * moved to the top level. Cached per section object: a section keeps its
 * pages' objects while nothing in it changes (see createNotebookProjector),
 * and a memoised row is only as good as the page object it gets.
 */
function normalizedPagesOf(section: Section): Page[] {
  const cached = normalizedPagesCache.get(section);
  if (cached) return cached;
  const ids = new Set(section.pages.map((page) => page.id));
  const pages = section.pages.map((page) => (
    page.parentPageId !== undefined && !ids.has(page.parentPageId)
      ? { ...page, parentPageId: undefined }
      : page
  ));
  normalizedPagesCache.set(section, pages);
  return pages;
}

const NO_GROUPS: readonly SectionGroup[] = Object.freeze([]);

const NO_LAST_PAGES: ReadonlyMap<string, string> = new Map();

const Sidebar = forwardRef<HTMLDivElement, SidebarProps>(function Sidebar(
  {
    notebooks,
    activeNotebookId,
    activeSectionId,
    activePageId,
    lastPageBySection = NO_LAST_PAGES,
    trashCount,
    id = 'notebook-navigation',
    modal = false,
    onClose,
    onActivatePage,
    onAddSection,
    onRenameSection,
    onRenamePage,
    onAddPage,
    templates = [],
    layout = 'tree',
    onAddPageFromTemplate,
    notebookTemplate,
    onTrashSection,
    onTrashPage,
    onDuplicatePage,
    onRebuildPage,
    onReorderPage,
    onTransferPage,
    onTransferSection,
    onAddSectionGroup,
    onRenameSectionGroup,
    onTrashSectionGroup,
    onTransferSectionGroup,
    onOpenTrash,
    quickAccess = [],
    pinnedPageIds,
    onSetPagePinned,
    onSetPageTemplate,
    onSetSectionColor,
    notebookSwitcher,
    capabilities: capabilityOverrides,
  },
  ref,
) {
  const { t } = useI18n();
  const templatePageIds = useMemo(() => new Set(templates.map((template) => template.pageId)), [templates]);
  const pinned = useMemo(() => pinnedPageIds ?? new Set<string>(), [pinnedPageIds]);
  const capabilities: SidebarCapabilities = {
    ...ALL_SIDEBAR_CAPABILITIES,
    transferPage: Boolean(onTransferPage),
    reorderSection: Boolean(onTransferSection),
    duplicateSection: Boolean(onTransferSection),
    transferSection: Boolean(onTransferSection),
    pinPage: Boolean(onSetPagePinned),
    templatePage: Boolean(onSetPageTemplate),
    colorSection: Boolean(onSetSectionColor),
    renamePage: Boolean(onRenamePage),
    createSectionGroup: Boolean(onAddSectionGroup),
    manageSectionGroups: Boolean(onRenameSectionGroup && onTrashSectionGroup && onTransferSectionGroup),
    ...capabilityOverrides,
  };
  const transferPage = onTransferPage ?? (() => undefined);
  const transferSection = onTransferSection ?? (() => undefined);
  const transferGroup = onTransferSectionGroup ?? (() => undefined);
  const activeNotebook = notebooks.find((item) => item.id === activeNotebookId) ?? notebooks[0];
  const groups = activeNotebook.sectionGroups ?? NO_GROUPS;
  const sectionTree = useMemo(
    () => buildSectionTree(activeNotebook.sections, groups),
    [activeNotebook.sections, groups],
  );
  const groupParents = useMemo(() => effectiveGroupParents(groups), [groups]);
  const collapse = useNavigationCollapse();
  const [quickAccessOpen, setQuickAccessOpen] = useState(true);
  const [drag, setDrag] = useState<PageDrag | null>(null);
  const [dropIndicator, setDropIndicator] = useState<DropIndicator | null>(null);
  const [pageDropTargetSectionId, setPageDropTargetSectionId] = useState<string>();
  const [structureDrag, setStructureDrag] = useState<StructureDrag | null>(null);
  const [structureDrop, setStructureDrop] = useState<StructureDrop | null>(null);
  const [dragStatus, setDragStatus] = useState('');
  const [moveCopy, setMoveCopy] = useState<MoveCopyRequest | null>(null);
  /** The row whose name is being edited in place. */
  const [renamingKey, setRenamingKey] = useState<NavKey | null>(null);
  const renameFocusKey = useRef<NavKey | null>(null);
  const menu = useContextMenu();
  const sectionListId = useId();
  const lastIndicatorKey = useRef('');
  const rootRef = useRef<HTMLDivElement | null>(null);
  const setRootRef = useCallback((node: HTMLDivElement | null) => {
    rootRef.current = node;
    if (typeof ref === 'function') ref(node);
    else if (ref) ref.current = node;
  }, [ref]);

  const allActivePages = useMemo(
    () => activeNotebook.sections.flatMap((section) => section.pages),
    [activeNotebook.sections],
  );

  const activeSection = activeNotebook.sections.find((section) => section.id === activeSectionId);
  const activeSectionGroupId = activeSection ? effectiveSectionGroupId(activeSection, groups) : undefined;
  const sectionOpen = (section: Section) => collapse.isSectionOpen(section.id, section.id === activeSectionId);

  // Opening another page reveals it: its parent pages, the groups around its
  // section and (on phones) the section itself unfold, and its row scrolls
  // into view, as OneNote does when a search result or link opens a page.
  const { reveal, storedSectionOpen, setSectionOpen } = collapse;
  const activePagePath = useMemo(() => {
    const section = activeNotebook.sections.find((candidate) => candidate.id === activeSectionId);
    return section ? pageAncestors(section.pages, activePageId) : [];
  }, [activeNotebook.sections, activePageId, activeSectionId]);
  const activeGroupPath = groupAncestry(groups, activeSectionGroupId);
  const revealedOnce = useRef(false);
  useEffect(() => {
    // Folds stored from an earlier session stay as they were when the
    // navigation mounts; a folded group that holds the open section is
    // highlighted instead.
    const mounting = !revealedOnce.current;
    revealedOnce.current = true;
    // In the phone tree a section stays open once it has been open, so
    // opening a page elsewhere does not fold the section just left. A fold
    // stored earlier is kept when the navigation mounts.
    if (layout === 'tree' && activeSectionId) {
      const stored = storedSectionOpen(activeSectionId);
      if (mounting ? stored === undefined : stored !== true) setSectionOpen(activeSectionId, true);
    }
    if (mounting) return;
    reveal('pages', activePagePath);
    reveal('groups', activeGroupPath);
    // Only a change of the open page should unfold anything; later folds by
    // the user stay folded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePageId, activeSectionId]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const root = rootRef.current;
      if (!root || !activePageId) return;
      root.querySelector(`[data-page-row-id="${CSS.escape(activePageId)}"]`)
        ?.scrollIntoView({ block: 'nearest' });
      if (layout === 'panes' && activeSectionId) {
        root.querySelector(`[data-section-row-id="${CSS.escape(activeSectionId)}"]`)
          ?.scrollIntoView({ block: 'nearest' });
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [activePageId, activeSectionId, layout]);

  // OneNote opens a section at the page last open there, else its first page.
  const openSection = (section: Section) => {
    const remembered = lastPageBySection.get(section.id);
    const first = section.pages.find((page) => page.id === remembered)
      ?? section.pages.find((page) => !page.parentPageId)
      ?? section.pages[0];
    if (first) onActivatePage(activeNotebook.id, section.id, first.id);
  };

  const toggleNavKey = (key: NavKey) => {
    const [kind, ...rest] = key.split(':');
    const itemId = rest.join(':');
    if (kind === 'group') collapse.toggle('groups', itemId);
    else if (kind === 'page') collapse.toggle('pages', itemId);
    else if (kind === 'section' && layout === 'tree') {
      const section = activeNotebook.sections.find((candidate) => candidate.id === itemId);
      if (section) setSectionOpen(section.id, !sectionOpen(section));
    }
  };

  const startRename = (key: NavKey) => {
    const [kind, ...rest] = key.split(':');
    const itemId = rest.join(':');
    const allowed = kind === 'section' ? capabilities.renameSection
      : kind === 'group' ? capabilities.manageSectionGroups
        : kind === 'page' ? capabilities.renamePage : false;
    if (!allowed || !itemId) return;
    setRenamingKey(key);
  };

  const finishRename = (key: NavKey, title: string | null) => {
    const [kind, ...rest] = key.split(':');
    const itemId = rest.join(':');
    renameFocusKey.current = key;
    setRenamingKey((current) => (current === key ? null : current));
    if (title === null) return;
    if (kind === 'section') onRenameSection(itemId, title);
    else if (kind === 'group') onRenameSectionGroup?.(itemId, title);
    else if (kind === 'page') {
      const section = activeNotebook.sections.find((candidate) => candidate.pages.some((page) => page.id === itemId));
      if (section) onRenamePage?.(section.id, itemId, title);
    }
  };

  // After a rename ends the row gets focus back, whether it was confirmed,
  // cancelled or left by clicking elsewhere.
  useEffect(() => {
    const key = renameFocusKey.current;
    if (renamingKey !== null || key === null) return;
    renameFocusKey.current = null;
    const active = document.activeElement;
    if (active && active !== document.body && !rootRef.current?.contains(active)) return;
    rootRef.current?.querySelector<HTMLElement>(`[data-nav-item="${CSS.escape(key)}"]`)?.focus({ preventScroll: true });
  }, [renamingKey]);

  // One Tab stop per list (roving tabindex): the open section and page, or
  // the folded row that hides them.
  const outermostCollapsedGroup = activeGroupPath.find((groupId) => collapse.isCollapsed('groups', groupId));
  const sectionTabStop: NavKey | undefined = outermostCollapsedGroup
    ? `group:${outermostCollapsedGroup}`
    : activeSection ? `section:${activeSection.id}` : undefined;
  const outermostCollapsedPage = activePagePath.find((pageId) => collapse.isCollapsed('pages', pageId));
  const pageTabStop: NavKey | undefined = outermostCollapsedPage ? `page:${outermostCollapsedPage}` : `page:${activePageId}`;

  const activeAddTargetSectionId = activeSection?.id ?? activeNotebook.sections[0]?.id;

  const clearDrag = () => {
    setDrag(null);
    setDropIndicator(null);
    setPageDropTargetSectionId(undefined);
    lastIndicatorKey.current = '';
  };

  const clearStructureDrag = () => {
    setStructureDrag(null);
    setStructureDrop(null);
  };

  const startDrag = (event: ReactDragEvent<HTMLElement>, sectionId: string, page: Page, depth: number) => {
    event.dataTransfer.effectAllowed = 'copyMove';
    event.dataTransfer.setData('text/plain', page.id);
    setDrag({
      pageId: page.id,
      sectionId,
      subtree: new Set([page.id, ...descendantsOf(allActivePages, page.id)]),
      startX: event.clientX,
      depth,
    });
    setDragStatus(t('sidebar.drag.pickedUp', { title: page.title }));
  };

  /**
   * Where a page drop at the pointer would go inside one section's page
   * list: the gap from the vertical position, the level from how far the
   * pointer moved sideways since the drag started (OneNote's gesture).
   */
  const dropTargetAt = (event: ReactDragEvent<HTMLElement>, current: PageDrag) => {
    const rows = measureRows(event.currentTarget, current.subtree);
    const gap = gapFromMidpoints(rows.map((row) => row.rect.top + row.rect.height / 2), event.clientY);
    const target = resolvePageDrop(rows, gap, desiredDepth(current.depth, event.clientX - current.startX));
    const containerTop = event.currentTarget.getBoundingClientRect().top;
    const top = rows.length === 0
      ? 0
      : gap < rows.length
        ? rows[gap].rect.top - containerTop
        : rows[rows.length - 1].rect.bottom - containerTop;
    return { rows, target, top };
  };

  const originGap = (sectionId: string, current: PageDrag, container: HTMLElement): number | undefined => {
    if (current.sectionId !== sectionId) return undefined;
    const all = [...container.querySelectorAll<HTMLElement>('.page-row[data-page-row-id]')];
    const index = all.findIndex((element) => element.dataset.pageRowId === current.pageId);
    return index < 0 ? undefined : all.slice(0, index).filter((element) => !current.subtree.has(element.dataset.pageRowId ?? '')).length;
  };

  const pageTreeDropHandlers = (section: Section) => ({
    onDragOver: (event: ReactDragEvent<HTMLDivElement>) => {
      if (!drag || !capabilities.transferPage) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = copyModifier(event) ? 'copy' : 'move';
      const { target, top } = dropTargetAt(event, drag);
      const key = `${section.id}:${target.gap}:${target.depth}:${Math.round(top)}`;
      if (key === lastIndicatorKey.current) return;
      lastIndicatorKey.current = key;
      setPageDropTargetSectionId(undefined);
      setDropIndicator({ sectionId: section.id, top, target });
    },
    onDragLeave: (event: ReactDragEvent<HTMLDivElement>) => {
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
      setDropIndicator((current) => current?.sectionId === section.id ? null : current);
      lastIndicatorKey.current = '';
    },
    onDrop: (event: ReactDragEvent<HTMLDivElement>) => {
      if (!drag || !capabilities.transferPage) return;
      event.preventDefault();
      event.stopPropagation();
      const current = drag;
      const { target } = dropTargetAt(event, current);
      const origin = originGap(section.id, current, event.currentTarget);
      const copy = copyModifier(event);
      clearDrag();
      const source = allActivePages.find((page) => page.id === current.pageId);
      if (!source) return;
      if (!copy && origin !== undefined && isNoopDrop(target, { gap: origin, depth: current.depth })) return;
      if (target.placement === 'inside' && target.targetPageId) reveal('pages', [target.targetPageId]);
      transferPage({
        sourceNotebookId: activeNotebook.id,
        sourceSectionId: current.sectionId,
        pageId: current.pageId,
        targetNotebookId: activeNotebook.id,
        targetSectionId: section.id,
        targetPageId: target.targetPageId,
        placement: target.placement,
        copy,
      });
      setDragStatus(t('sidebar.drag.transferring', {
        title: source.title,
        operation: t(copy ? 'sidebar.drag.copied' : 'sidebar.drag.moved'),
      }));
    },
  });

  /** The dragged section or group, from React state or the drag data. */
  const draggedStructure = (event: ReactDragEvent<HTMLElement>): StructureDrag | null => {
    if (structureDrag) return structureDrag;
    const types = event.dataTransfer.types;
    if (types.includes(GROUP_DRAG_TYPE)) {
      const groupId = event.dataTransfer.getData(GROUP_DRAG_TYPE);
      return groupId ? { kind: 'group', id: groupId } : null;
    }
    if (types.includes(SECTION_DRAG_TYPE)) {
      const sectionId = event.dataTransfer.getData(SECTION_DRAG_TYPE);
      return sectionId ? { kind: 'section', id: sectionId } : null;
    }
    return null;
  };

  const showStructureDrop = (next: StructureDrop | null) => {
    setStructureDrop((current) => (
      current?.key === next?.key && current?.placement === next?.placement ? current : next
    ));
  };

  const moveSectionInto = (sectionId: string, groupId: string | undefined, copy: boolean) => {
    transferSection({
      sourceNotebookId: activeNotebook.id,
      sectionId,
      targetNotebookId: activeNotebook.id,
      placement: 'inside',
      ...(groupId ? { targetGroupId: groupId } : {}),
      copy,
    });
    if (groupId) reveal('groups', [groupId]);
  };

  const moveGroup = (request: Omit<SectionGroupTransferRequest, 'notebookId'>) => {
    if (!canMoveGroupInto(groups, request.groupId, request.targetParentGroupId)) return;
    transferGroup({ notebookId: activeNotebook.id, ...request });
    if (request.targetParentGroupId) reveal('groups', [request.targetParentGroupId]);
  };

  const announceStructureMove = (dragged: StructureDrag, copy: boolean) => {
    const title = dragged.kind === 'section'
      ? activeNotebook.sections.find((candidate) => candidate.id === dragged.id)?.title
      : groups.find((group) => group.id === dragged.id)?.title;
    setDragStatus(t('sidebar.drag.sectionTransferred', {
      operation: t(copy ? 'sidebar.drag.copied' : 'sidebar.drag.moved'),
      title: title ?? t('sidebar.drag.fallbackSection'),
    }));
  };

  /** Dropping on a section row: sections land before or after it. */
  const sectionDropHandlers = (section: Section) => ({
    onDragOver: (event: ReactDragEvent<HTMLElement>) => {
      if (drag && capabilities.transferPage) {
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = copyModifier(event) ? 'copy' : 'move';
        setPageDropTargetSectionId(section.id);
        setDropIndicator(null);
        lastIndicatorKey.current = '';
        return;
      }
      const dragged = draggedStructure(event);
      if (dragged?.kind !== 'section' || !capabilities.reorderSection) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = copyModifier(event) ? 'copy' : 'move';
      const bounds = event.currentTarget.getBoundingClientRect();
      showStructureDrop({
        key: `section:${section.id}`,
        placement: event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after',
      });
    },
    onDragLeave: (event: ReactDragEvent<HTMLElement>) => {
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
      if (pageDropTargetSectionId === section.id) setPageDropTargetSectionId(undefined);
      setStructureDrop((current) => current?.key === `section:${section.id}` ? null : current);
    },
    onDrop: (event: ReactDragEvent<HTMLElement>) => {
      event.preventDefault();
      event.stopPropagation();
      setPageDropTargetSectionId(undefined);
      const dragged = draggedStructure(event);
      const copy = copyModifier(event);
      if (dragged?.kind === 'section' && capabilities.reorderSection) {
        clearStructureDrag();
        if (dragged.id === section.id && !copy) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        transferSection({
          sourceNotebookId: activeNotebook.id,
          sectionId: dragged.id,
          targetNotebookId: activeNotebook.id,
          targetSectionId: section.id,
          placement: event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after',
          copy,
        });
        announceStructureMove(dragged, copy);
        return;
      }
      if (!drag || !capabilities.transferPage) return;
      const current = drag;
      clearDrag();
      const source = allActivePages.find((page) => page.id === current.pageId);
      // Dropping a page on a section moves it to the end of that
      // section's page list, like dropping it on a section tab.
      transferPage({
        sourceNotebookId: activeNotebook.id,
        sourceSectionId: current.sectionId,
        pageId: current.pageId,
        targetNotebookId: activeNotebook.id,
        targetSectionId: section.id,
        placement: 'root',
        copy,
      });
      setDragStatus(t('sidebar.drag.transferring', {
        title: source?.title ?? t('sidebar.drag.fallbackPage'),
        operation: t(copy ? 'sidebar.drag.copied' : 'sidebar.drag.moved'),
      }));
    },
  });

  /**
   * Dropping on a group row: a section goes into the group; a group goes
   * before or after it near the row's edges and into it in the middle.
   */
  const groupPlacement = (event: ReactDragEvent<HTMLElement>, dragged: StructureDrag): StructureDrop['placement'] => {
    if (dragged.kind === 'section') return 'inside';
    const bounds = event.currentTarget.getBoundingClientRect();
    const offset = event.clientY - bounds.top;
    if (offset < bounds.height * 0.25) return 'before';
    if (offset > bounds.height * 0.75) return 'after';
    return 'inside';
  };

  const groupDropAllowed = (dragged: StructureDrag | null, group: SectionGroup, placement: StructureDrop['placement']) => {
    if (!dragged) return false;
    if (dragged.kind === 'section') return capabilities.reorderSection;
    if (!capabilities.manageSectionGroups || dragged.id === group.id) return false;
    const parent = placement === 'inside' ? group.id : groupParents.get(group.id);
    return canMoveGroupInto(groups, dragged.id, parent);
  };

  const groupDropHandlers = (group: SectionGroup) => ({
    onDragOver: (event: ReactDragEvent<HTMLElement>) => {
      const dragged = draggedStructure(event);
      if (!dragged) return;
      const placement = groupPlacement(event, dragged);
      if (!groupDropAllowed(dragged, group, placement)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = dragged.kind === 'section' && copyModifier(event) ? 'copy' : 'move';
      showStructureDrop({ key: `group:${group.id}`, placement });
    },
    onDragLeave: (event: ReactDragEvent<HTMLElement>) => {
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
      setStructureDrop((current) => current?.key === `group:${group.id}` ? null : current);
    },
    onDrop: (event: ReactDragEvent<HTMLElement>) => {
      const dragged = draggedStructure(event);
      if (!dragged) return;
      const placement = groupPlacement(event, dragged);
      if (!groupDropAllowed(dragged, group, placement)) return;
      event.preventDefault();
      event.stopPropagation();
      clearStructureDrag();
      const copy = dragged.kind === 'section' && copyModifier(event);
      if (dragged.kind === 'section') {
        moveSectionInto(dragged.id, group.id, copy);
      } else if (placement === 'inside') {
        moveGroup({ groupId: dragged.id, targetParentGroupId: group.id });
      } else {
        const parent = groupParents.get(group.id);
        moveGroup({
          groupId: dragged.id,
          ...(parent ? { targetParentGroupId: parent } : {}),
          anchor: { groupId: group.id, placement },
        });
      }
      announceStructureMove(dragged, copy);
    },
  });

  /** The empty part of the section list is the notebook's top level. */
  const topLevelDropHandlers = {
    onDragOver: (event: ReactDragEvent<HTMLElement>) => {
      const dragged = draggedStructure(event);
      if (!dragged || (dragged.kind === 'section' ? !capabilities.reorderSection : !capabilities.manageSectionGroups)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = dragged.kind === 'section' && copyModifier(event) ? 'copy' : 'move';
      showStructureDrop({ key: 'top', placement: 'inside' });
    },
    onDragLeave: (event: ReactDragEvent<HTMLElement>) => {
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
      setStructureDrop((current) => current?.key === 'top' ? null : current);
    },
    onDrop: (event: ReactDragEvent<HTMLElement>) => {
      const dragged = draggedStructure(event);
      if (!dragged) return;
      event.preventDefault();
      clearStructureDrag();
      const copy = dragged.kind === 'section' && copyModifier(event);
      if (dragged.kind === 'section') moveSectionInto(dragged.id, undefined, copy);
      else moveGroup({ groupId: dragged.id });
      announceStructureMove(dragged, copy);
    },
  };

  const openMenuAt = (point: MenuPoint, trigger: HTMLElement, label: string, items: ContextMenuEntry[]) => {
    menu.open({ point, label, items, returnFocus: trigger });
  };

  /** A new group appears with its default name, already in rename mode. */
  const addGroup = (parentGroupId?: string) => {
    const groupId = onAddSectionGroup?.(parentGroupId);
    if (groupId) setRenamingKey(`group:${groupId}`);
  };

  const openPageMenu = (point: MenuPoint, trigger: HTMLElement, sectionId: string, page: Page) => {
    const section = activeNotebook.sections.find((candidate) => candidate.id === sectionId);
    if (!section) return;
    const pages = normalizedPagesOf(section);
    const siblings = pages.filter((candidate) => candidate.parentPageId === page.parentPageId);
    const siblingIndex = siblings.findIndex((candidate) => candidate.id === page.id);
    const tree = pages.map((candidate) => ({ id: candidate.id, parentPageId: candidate.parentPageId }));
    const indent = indentTarget(tree, page.id);
    const outdent = outdentTarget(tree, page.id);
    const isPinned = pinned.has(page.id);
    const isTemplate = templatePageIds.has(page.id);
    const move = (target: { targetPageId: string; placement: 'inside' | 'after' }) => transferPage({
      sourceNotebookId: activeNotebook.id,
      sourceSectionId: sectionId,
      pageId: page.id,
      targetNotebookId: activeNotebook.id,
      targetSectionId: sectionId,
      targetPageId: target.targetPageId,
      placement: target.placement,
      copy: false,
    });
    openMenuAt(point, trigger, t('menu.page', { title: page.title }), [
      { id: 'new-page', label: t('menu.newPage'), icon: <FilePlus2 size={14} />, disabled: !capabilities.createPage, onSelect: () => onAddPage(sectionId, page.parentPageId, 'canvas') },
      { id: 'new-subpage', label: t('menu.newSubpage'), icon: <FilePlus2 size={14} />, disabled: !capabilities.createPage, onSelect: () => onAddPage(sectionId, page.id, 'canvas') },
      { id: 'indent', label: t('menu.indentPage'), icon: <IndentIncrease size={14} />, disabled: !capabilities.transferPage || !indent, onSelect: () => { if (indent) move(indent); } },
      { id: 'outdent', label: t('menu.outdentPage'), icon: <IndentDecrease size={14} />, disabled: !capabilities.transferPage || !outdent, onSelect: () => { if (outdent) move(outdent); } },
      { id: 'up', label: t('menu.moveUp'), icon: <ArrowUp size={14} />, disabled: !capabilities.reorderPage || siblingIndex <= 0, onSelect: () => onReorderPage(sectionId, page.id, 'up') },
      { id: 'down', label: t('menu.moveDown'), icon: <ArrowDown size={14} />, disabled: !capabilities.reorderPage || siblingIndex === siblings.length - 1, onSelect: () => onReorderPage(sectionId, page.id, 'down') },
      { id: 'rename', label: t('menu.rename'), icon: <Pencil size={14} />, disabled: !capabilities.renamePage, onSelect: () => startRename(`page:${page.id}`) },
      { kind: 'separator', id: 'sep-1' },
      { id: 'move-copy', label: t('menu.moveOrCopy'), icon: <FolderInput size={14} />, disabled: !capabilities.transferPage, onSelect: () => setMoveCopy({ kind: 'page', sectionId, page, returnFocus: trigger }) },
      { id: 'duplicate', label: t('menu.duplicate'), icon: <Copy size={14} />, disabled: !capabilities.duplicatePage, onSelect: () => onDuplicatePage(sectionId, page.id) },
      ...(onRebuildPage ? [{ id: 'rebuild', label: t('menu.rebuildPage'), icon: <RefreshCw size={14} />, disabled: !capabilities.duplicatePage, onSelect: () => onRebuildPage(sectionId, page.id) }] : []),
      { kind: 'separator', id: 'sep-2' },
      { id: 'pin', label: t(isPinned ? 'menu.unpin' : 'menu.pin'), icon: isPinned ? <PinOff size={14} /> : <Pin size={14} />, disabled: !capabilities.pinPage, onSelect: () => onSetPagePinned?.(page.id, !isPinned) },
      { id: 'template', label: t('templates.useAsTemplate'), icon: <LayoutTemplate size={14} />, role: 'menuitemcheckbox', checked: isTemplate, disabled: !capabilities.templatePage, onSelect: () => onSetPageTemplate?.(page.id, !isTemplate) },
      { kind: 'separator', id: 'sep-3' },
      { id: 'delete', label: t('menu.delete'), icon: <Trash2 size={14} />, danger: true, disabled: !capabilities.trashPage || section.pages.length === 1, onSelect: () => onTrashPage(sectionId, page.id) },
    ]);
  };

  const openSectionMenu = (point: MenuPoint, trigger: HTMLElement, section: Section) => {
    const chosen = section.color;
    const groupId = effectiveSectionGroupId(section, groups);
    // "Up" and "down" move among the sections of the same group.
    const siblings = activeNotebook.sections.filter((candidate) => effectiveSectionGroupId(candidate, groups) === groupId);
    const siblingIndex = siblings.findIndex((candidate) => candidate.id === section.id);
    const moveNextTo = (neighbour: Section | undefined, placement: 'before' | 'after') => {
      if (!neighbour) return;
      transferSection({
        sourceNotebookId: activeNotebook.id,
        sectionId: section.id,
        targetNotebookId: activeNotebook.id,
        targetSectionId: neighbour.id,
        placement,
        copy: false,
      });
    };
    openMenuAt(point, trigger, t('menu.section', { title: section.title }), [
      { id: 'rename', label: t('menu.rename'), icon: <Pencil size={14} />, disabled: !capabilities.renameSection, onSelect: () => startRename(`section:${section.id}`) },
      {
        id: 'color',
        label: t('menu.sectionColor'),
        icon: <Palette size={14} />,
        disabled: !capabilities.colorSection,
        submenu: [
          { id: 'color-auto', label: t('menu.sectionColor.auto'), role: 'menuitemradio', checked: !chosen, onSelect: () => onSetSectionColor?.(section.id, undefined) },
          ...SECTION_COLOR_PALETTE.map((color) => ({
            id: `color-${color.value}`,
            label: t(color.labelKey),
            swatch: color.value,
            role: 'menuitemradio' as const,
            checked: chosen === color.value,
            onSelect: () => onSetSectionColor?.(section.id, color.value),
          })),
        ],
      },
      { id: 'new-section', label: t('menu.newSection'), icon: <Plus size={14} />, disabled: !capabilities.createSection, onSelect: () => onAddSection(groupId) },
      { id: 'new-group', label: t('menu.newSectionGroup'), icon: <FolderPlus size={14} />, disabled: !capabilities.createSectionGroup, onSelect: () => addGroup(groupId) },
      { kind: 'separator', id: 'sep-1' },
      { id: 'move-copy', label: t('menu.moveOrCopy'), icon: <FolderInput size={14} />, disabled: !capabilities.transferSection, onSelect: () => setMoveCopy({ kind: 'section', section, returnFocus: trigger }) },
      {
        id: 'duplicate',
        label: t('menu.duplicate'),
        icon: <Copy size={14} />,
        disabled: !capabilities.duplicateSection,
        onSelect: () => transferSection({
          sourceNotebookId: activeNotebook.id,
          sectionId: section.id,
          targetNotebookId: activeNotebook.id,
          targetSectionId: section.id,
          placement: 'after',
          copy: true,
        }),
      },
      {
        id: 'up',
        label: t('menu.moveUp'),
        icon: <ArrowUp size={14} />,
        disabled: !capabilities.reorderSection || siblingIndex <= 0,
        onSelect: () => moveNextTo(siblings[siblingIndex - 1], 'before'),
      },
      {
        id: 'down',
        label: t('menu.moveDown'),
        icon: <ArrowDown size={14} />,
        disabled: !capabilities.reorderSection || siblingIndex === siblings.length - 1,
        onSelect: () => moveNextTo(siblings[siblingIndex + 1], 'after'),
      },
      { kind: 'separator', id: 'sep-2' },
      { id: 'delete', label: t('menu.delete'), icon: <Trash2 size={14} />, danger: true, disabled: !capabilities.trashSection || activeNotebook.sections.length === 1, onSelect: () => onTrashSection(section.id) },
    ]);
  };

  const openGroupMenu = (point: MenuPoint, trigger: HTMLElement, group: SectionGroup) => {
    const parent = groupParents.get(group.id);
    const siblings = groups.filter((candidate) => groupParents.get(candidate.id) === parent);
    const index = siblings.findIndex((candidate) => candidate.id === group.id);
    const contained = sectionsInGroup(activeNotebook.sections, groups, group.id).length;
    const manage = capabilities.manageSectionGroups;
    const moveNextTo = (neighbour: SectionGroup | undefined, placement: 'before' | 'after') => {
      if (!neighbour) return;
      moveGroup({ groupId: group.id, ...(parent ? { targetParentGroupId: parent } : {}), anchor: { groupId: neighbour.id, placement } });
    };
    openMenuAt(point, trigger, t('menu.sectionGroup', { title: group.title }), [
      { id: 'rename', label: t('menu.rename'), icon: <Pencil size={14} />, disabled: !manage, onSelect: () => startRename(`group:${group.id}`) },
      { id: 'new-section', label: t('menu.newSection'), icon: <Plus size={14} />, disabled: !capabilities.createSection, onSelect: () => { reveal('groups', [group.id]); onAddSection(group.id); } },
      { id: 'new-group', label: t('menu.newSectionGroup'), icon: <FolderPlus size={14} />, disabled: !capabilities.createSectionGroup, onSelect: () => { reveal('groups', [group.id]); addGroup(group.id); } },
      { kind: 'separator', id: 'sep-1' },
      { id: 'move', label: t('menu.move'), icon: <FolderInput size={14} />, disabled: !manage, onSelect: () => setMoveCopy({ kind: 'group', group, returnFocus: trigger }) },
      { id: 'up', label: t('menu.moveUp'), icon: <ArrowUp size={14} />, disabled: !manage || index <= 0, onSelect: () => moveNextTo(siblings[index - 1], 'before') },
      { id: 'down', label: t('menu.moveDown'), icon: <ArrowDown size={14} />, disabled: !manage || index === siblings.length - 1, onSelect: () => moveNextTo(siblings[index + 1], 'after') },
      { kind: 'separator', id: 'sep-2' },
      // A notebook keeps at least one section, as when deleting a section.
      { id: 'delete', label: t('menu.delete'), icon: <Trash2 size={14} />, danger: true, disabled: !manage || (contained > 0 && contained >= activeNotebook.sections.length), onSelect: () => onTrashSectionGroup?.(group.id) },
    ]);
  };

  const openSectionListMenu = (event: ReactMouseEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget) return;
    event.preventDefault();
    openMenuAt({ x: event.clientX, y: event.clientY }, event.currentTarget, t('sidebar.sections'), [
      { id: 'new-section', label: t('menu.newSection'), icon: <Plus size={14} />, disabled: !capabilities.createSection, onSelect: () => onAddSection() },
      { id: 'new-group', label: t('menu.newSectionGroup'), icon: <FolderPlus size={14} />, disabled: !capabilities.createSectionGroup, onSelect: () => addGroup() },
    ]);
  };

  const openQuickAccessMenu = (point: MenuPoint, trigger: HTMLElement, entry: QuickAccessEntry) => {
    openMenuAt(point, trigger, t('menu.page', { title: entry.title }), [
      { id: 'open', label: t('menu.open'), icon: <FileText size={14} />, onSelect: () => onActivatePage(entry.notebookId, entry.sectionId, entry.pageId) },
      { id: 'unpin', label: t('menu.unpin'), icon: <PinOff size={14} />, disabled: !capabilities.pinPage, onSelect: () => onSetPagePinned?.(entry.pageId, false) },
    ]);
  };

  const completeMoveCopy = (request: MoveCopyRequest, target: MoveCopyTarget, copy: boolean) => {
    setMoveCopy(null);
    if (request.kind === 'page' && target.sectionId) {
      transferPage({
        sourceNotebookId: activeNotebook.id,
        sourceSectionId: request.sectionId,
        pageId: request.page.id,
        targetNotebookId: target.notebookId,
        targetSectionId: target.sectionId,
        placement: 'root',
        copy,
      });
    } else if (request.kind === 'section') {
      transferSection({
        sourceNotebookId: activeNotebook.id,
        sectionId: request.section.id,
        targetNotebookId: target.notebookId,
        placement: 'inside',
        ...(target.groupId ? { targetGroupId: target.groupId } : {}),
        copy,
      });
      if (target.groupId && target.notebookId === activeNotebook.id) reveal('groups', [target.groupId]);
    } else if (request.kind === 'group') {
      moveGroup({ groupId: request.group.id, ...(target.groupId ? { targetParentGroupId: target.groupId } : {}) });
    }
  };

  const templateMenu = (section: Section) => onAddPageFromTemplate ? (
    <details className="page-template-menu">
      <summary aria-label={t('templates.choose', { title: section.title })} title={t('templates.choose', { title: section.title })}>
        <ChevronDown size={13} aria-hidden="true" />
      </summary>
      <div className="page-template-menu__popover" role="menu">
        <button type="button" role="menuitem" onClick={(event) => { closeDetailsMenu(event); onAddPage(section.id, undefined, 'canvas'); }}>
          {t('templates.blank')}
        </button>
        <p className="page-template-menu__label" role="presentation">{t('templates.builtin')}</p>
        {BUILTIN_TEMPLATES.map((template) => (
          <button
            key={template.id}
            type="button"
            role="menuitem"
            title={t(template.descriptionKey)}
            onClick={(event) => { closeDetailsMenu(event); onAddPageFromTemplate(section.id, { kind: 'builtin', id: template.id }); }}
          >
            {t(template.labelKey)}
          </button>
        ))}
        {/* Own templates appear by name once a page is marked as one; an
            empty group would only need explaining, so it is left out. */}
        {templates.length > 0 ? (
          <>
            <p className="page-template-menu__label" role="presentation">{t('templates.mine')}</p>
            {templates.map((template) => (
              <button key={template.pageId} type="button" role="menuitem" onClick={(event) => { closeDetailsMenu(event); onAddPageFromTemplate(section.id, { kind: 'page', pageId: template.pageId }); }}>
                {template.title}
              </button>
            ))}
          </>
        ) : null}
      </div>
    </details>
  ) : null;

  // Pages of one section: nested under the section in the tree layout, or in
  // the separate page column of the OneNote-style panes layout.
  const renderSectionPages = (section: Section, collapsed = false, sectionDepth = 0) => {
    const sectionPagesId = `${sectionListId}-pages-${section.id}`;
    const normalizedPages = normalizedPagesOf(section);
    const ownTemplate = templates.find((template) => template.sectionId === section.id);
    const sectionTemplate = ownTemplate
      ? { source: { kind: 'page', pageId: ownTemplate.pageId } as const, title: ownTemplate.title }
      : notebookTemplate;
    const addRow = capabilities.createPage ? (
      <div className="sidebar-add-row-group">
        <button
          type="button"
          className="sidebar-add-row"
          aria-label={sectionTemplate
            ? t('templates.addFromDefault', { section: section.title, template: sectionTemplate.title })
            : t('sidebar.page.addTo', { title: section.title })}
          onClick={() => sectionTemplate && onAddPageFromTemplate
            ? onAddPageFromTemplate(section.id, sectionTemplate.source)
            : onAddPage(section.id, undefined, 'canvas')}
        >
          <Plus size={14} aria-hidden="true" />
          <span>{t('sidebar.page.add')}</span>
          {sectionTemplate ? <small className="sidebar-add-row__template">{sectionTemplate.title}</small> : null}
        </button>
        {templateMenu(section)}
      </div>
    ) : null;
    const indicator = dropIndicator?.sectionId === section.id ? dropIndicator : null;
    return (
      <>
        {layout === 'panes' ? addRow : null}
        <div
          id={sectionPagesId}
          className="page-tree"
          hidden={collapsed}
          data-section-id={section.id}
          style={{ '--section-depth': sectionDepth } as CSSProperties}
          {...pageTreeDropHandlers(section)}
        >
          <PageTree
            pages={normalizedPages}
            sectionId={section.id}
            parentKey={layout === 'tree' ? `section:${section.id}` : undefined}
          />
          {indicator ? (
            <div
              className="page-drop-indicator"
              aria-hidden="true"
              style={{
                top: indicator.top,
                left: indicator.target.depth * PAGE_INDENT_PX + PAGE_ROW_BASE_PX[layout] + (layout === 'tree' ? sectionDepth * SECTION_INDENT_PX : 0) - 4,
              }}
            />
          ) : null}
          {layout === 'tree' ? addRow : null}
        </div>
      </>
    );
  };

  const dropAttribute = (key: string) => structureDrop?.key === key ? structureDrop.placement : undefined;

  const renderSection = (section: Section, depth: number, parentKey?: NavKey) => {
    const collapsed = layout === 'tree' && !sectionOpen(section);
    const sectionPagesId = `${sectionListId}-pages-${section.id}`;
    const navKey: NavKey = `section:${section.id}`;
    const current = activeSectionId === section.id;
    return (
      <section
        className={`section-block ${current ? 'is-current' : ''}`}
        key={section.id}
        role="listitem"
        data-page-drop-target={pageDropTargetSectionId === section.id || undefined}
        data-drop={dropAttribute(navKey)}
        {...sectionDropHandlers(section)}
      >
        <div className="section-row" style={{ '--nav-depth': depth } as CSSProperties} data-section-row-id={section.id}>
          {renamingKey === navKey ? (
            <div className="section-row__editing">
              {layout === 'tree' ? (collapsed ? <ChevronRight size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />) : null}
              <span className="section-color" style={{ background: sectionColor(section) }} aria-hidden="true" />
              <InlineRename value={section.title} label={t('workspace.section.renamePrompt')} onDone={(title) => finishRename(navKey, title)} />
            </div>
          ) : (
          <button
            type="button"
            draggable={capabilities.reorderSection}
            aria-keyshortcuts="Shift+F10"
            tabIndex={(layout === 'tree' ? treeTabStop : sectionTabStop) === navKey ? 0 : -1}
            data-nav-item={navKey}
            data-nav-parent={parentKey}
            data-nav-expanded={layout === 'tree' ? String(!collapsed) : undefined}
            title={section.title}
            {...contextMenuTriggerProps((point, element) => openSectionMenu(point, element, section))}
            onClick={() => layout === 'panes' ? openSection(section) : setSectionOpen(section.id, collapsed)}
            onDoubleClick={() => startRename(navKey)}
            onDragStart={(event) => {
              event.stopPropagation();
              event.dataTransfer.effectAllowed = 'copyMove';
              event.dataTransfer.setData('text/plain', section.id);
              event.dataTransfer.setData(SECTION_DRAG_TYPE, section.id);
              setStructureDrag({ kind: 'section', id: section.id });
              setDragStatus(t('sidebar.drag.sectionPickedUp', { title: section.title }));
            }}
            onDragEnd={clearStructureDrag}
            aria-expanded={layout === 'tree' ? !collapsed : undefined}
            aria-controls={layout === 'tree' ? sectionPagesId : undefined}
            aria-current={layout === 'panes' && current ? 'true' : undefined}
          >
            {layout === 'tree' ? (collapsed ? <ChevronRight size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />) : null}
            <span className="section-color" style={{ background: sectionColor(section) }} aria-hidden="true" />
            <span className="section-row__title">{section.title}</span>
          </button>
          )}
        </div>
        {layout === 'tree' ? (
          <PageTreeContext.Provider value={{ ...treeContext, tabStop: treeTabStop, parentKey: navKey }}>
            {renderSectionPages(section, collapsed, depth)}
          </PageTreeContext.Provider>
        ) : null}
      </section>
    );
  };

  const renderGroup = (node: SectionGroupNode<Section, SectionGroup>, parentKey?: NavKey): ReactNode => {
    const { group } = node;
    const collapsed = collapse.isCollapsed('groups', group.id);
    const navKey: NavKey = `group:${group.id}`;
    const childrenId = `${sectionListId}-group-${group.id}`;
    const holdsCurrent = activeGroupPath.includes(group.id);
    return (
      <div
        key={group.id}
        className={`section-group${holdsCurrent ? ' holds-current' : ''}`}
        role="listitem"
        data-drop={dropAttribute(navKey)}
      >
        <div className="section-group__row" style={{ '--nav-depth': node.depth } as CSSProperties} {...groupDropHandlers(group)}>
          {renamingKey === navKey ? (
            <div className="section-group__editing">
              {collapsed ? <ChevronRight size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
              {collapsed ? <FolderClosed size={15} aria-hidden="true" /> : <FolderOpen size={15} aria-hidden="true" />}
              <InlineRename value={group.title} label={t('workspace.sectionGroup.renamePrompt')} onDone={(title) => finishRename(navKey, title)} />
            </div>
          ) : (
          <button
            type="button"
            className="section-group__button"
            draggable={capabilities.manageSectionGroups}
            aria-keyshortcuts="Shift+F10"
            aria-expanded={!collapsed}
            aria-controls={childrenId}
            tabIndex={(layout === 'tree' ? treeTabStop : sectionTabStop) === navKey ? 0 : -1}
            data-nav-item={navKey}
            data-nav-parent={parentKey}
            data-nav-expanded={String(!collapsed)}
            title={group.title}
            {...contextMenuTriggerProps((point, element) => openGroupMenu(point, element, group))}
            onClick={() => collapse.toggle('groups', group.id)}
            onDoubleClick={() => startRename(navKey)}
            onDragStart={(event) => {
              event.stopPropagation();
              event.dataTransfer.effectAllowed = 'move';
              event.dataTransfer.setData('text/plain', group.id);
              event.dataTransfer.setData(GROUP_DRAG_TYPE, group.id);
              setStructureDrag({ kind: 'group', id: group.id });
              setDragStatus(t('sidebar.drag.groupPickedUp', { title: group.title }));
            }}
            onDragEnd={clearStructureDrag}
          >
            {collapsed ? <ChevronRight size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
            {collapsed ? <FolderClosed size={15} aria-hidden="true" /> : <FolderOpen size={15} aria-hidden="true" />}
            <span className="section-row__title">{group.title}</span>
          </button>
          )}
        </div>
        <div id={childrenId} role="list" aria-label={group.title} hidden={collapsed}>
          {collapsed ? null : (
            <>
              {node.sections.map((section) => renderSection(section, node.depth + 1, navKey))}
              {node.groups.map((child) => renderGroup(child, navKey))}
            </>
          )}
        </div>
      </div>
    );
  };

  const treeTabStop: NavKey | undefined = (() => {
    // The phone tree holds sections and pages in one list with one Tab stop.
    if (sectionTabStop?.startsWith('group:')) return sectionTabStop;
    if (activeSection && !sectionOpen(activeSection)) return sectionTabStop;
    return pageTabStop;
  })();

  const activatePage = useStableCallback(onActivatePage);
  const openRowMenu = useStableCallback(openPageMenu);
  const startRowDrag = useStableCallback(startDrag);
  const endRowDrag = useStableCallback(clearDrag);
  const finishRowRename = useStableCallback((_sectionId: string, pageId: string, title: string | null) => finishRename(`page:${pageId}`, title));
  const toggleRowCollapsed = useStableCallback((pageId: string) => collapse.toggle('pages', pageId));
  const rowActions = useMemo<PageRowActions>(() => ({
    activate: activatePage,
    openMenu: openRowMenu,
    startDrag: startRowDrag,
    endDrag: endRowDrag,
    toggleCollapsed: toggleRowCollapsed,
    finishRename: finishRowRename,
  }), [activatePage, endRowDrag, finishRowRename, openRowMenu, startRowDrag, toggleRowCollapsed]);

  const treeContext: PageTreeContextValue = {
    activePageId,
    notebookId: activeNotebook.id,
    templatePageIds,
    pinnedPageIds: pinned,
    isCollapsed: (pageId) => collapse.isCollapsed('pages', pageId),
    tabStop: pageTabStop,
    actions: rowActions,
    drag,
    canDrag: capabilities.transferPage,
    renamingPageId: renamingKey?.startsWith('page:') ? renamingKey.slice('page:'.length) : undefined,
  };

  const moveCopyNotebooks = (moveCopy?.kind === 'group' ? [activeNotebook] : notebooks).map((notebook) => ({
    id: notebook.id,
    title: notebook.title,
    color: notebook.color,
    sections: notebook.sections.map((section) => ({
      id: section.id,
      title: section.title,
      ...(section.color ? { color: section.color } : {}),
      ...(section.groupId ? { groupId: section.groupId } : {}),
    })),
    ...(notebook.sectionGroups ? { sectionGroups: notebook.sectionGroups } : {}),
  }));

  const moveCopyCurrent = (request: MoveCopyRequest): MoveCopyTarget => {
    if (request.kind === 'page') return { notebookId: activeNotebook.id, sectionId: request.sectionId };
    const groupId = request.kind === 'section'
      ? effectiveSectionGroupId(request.section, groups)
      : groupParents.get(request.group.id);
    return { notebookId: activeNotebook.id, ...(groupId ? { groupId } : {}) };
  };

  const [sectionWidth, setSectionWidth] = useColumnWidth('sections');
  const [pageWidth, setPageWidth] = useColumnWidth('pages');
  const columnStyle = layout === 'panes' && (sectionWidth || pageWidth)
    ? {
      ...(sectionWidth ? { '--nav-section-width': `${sectionWidth}px` } : {}),
      ...(pageWidth ? { '--nav-page-width': `${pageWidth}px` } : {}),
    } as CSSProperties
    : undefined;

  return (
    <div
      ref={setRootRef}
      id={id}
      style={columnStyle}
      className={`notebook-sidebar${layout === 'panes' ? ' notebook-sidebar--panes' : ''}`}
      aria-label={t('sidebar.navigation')}
      aria-modal={modal || undefined}
      role={modal ? 'dialog' : 'navigation'}
    >
      <PageTreeContext.Provider value={treeContext}>
      <div className="nav-pane">
      <div className="sidebar-brand">
        <span className="brand-mark">
          <BookOpen size={17} />
        </span>
        <div className="sidebar-brand__text">
          <strong>Canvink</strong>
          {notebookSwitcher ?? <small>{activeNotebook.title}</small>}
        </div>
        <button
          type="button"
          className="sidebar-close"
          onClick={onClose}
          aria-label={t('sidebar.close')}
        >
          <X size={17} />
        </button>
      </div>

      {quickAccess.length > 0 ? (
        <div className="quick-access">
          <button
            type="button"
            className="sidebar-heading quick-access__heading"
            aria-expanded={quickAccessOpen}
            aria-controls={`${sectionListId}-quick-access`}
            title={t('quickAccess.toggle')}
            onClick={() => setQuickAccessOpen((open) => !open)}
          >
            <span>{t('quickAccess.title')}</span>
            {quickAccessOpen ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
          </button>
          <div
            id={`${sectionListId}-quick-access`}
            className="quick-access__list"
            role="list"
            aria-label={t('quickAccess.title')}
            hidden={!quickAccessOpen}
          >
            {quickAccess.map((entry) => (
              <div key={entry.pageId} role="listitem">
                <button
                  type="button"
                  className={`quick-access__item${entry.pageId === activePageId ? ' is-active' : ''}`}
                  aria-current={entry.pageId === activePageId ? 'page' : undefined}
                  aria-keyshortcuts="Shift+F10"
                  title={t('quickAccess.location', { notebook: entry.notebookTitle, section: entry.sectionTitle })}
                  {...contextMenuTriggerProps((point, element) => openQuickAccessMenu(point, element, entry))}
                  onClick={() => onActivatePage(entry.notebookId, entry.sectionId, entry.pageId)}
                >
                  <span className="section-color" style={{ background: sectionColor({ id: entry.sectionId, color: entry.sectionColor }) }} aria-hidden="true" />
                  <span className="quick-access__text">
                    <span>{entry.title}</span>
                    <small>{t('quickAccess.location', { notebook: entry.notebookTitle, section: entry.sectionTitle })}</small>
                  </span>
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="sidebar-heading">
        <span>{t('sidebar.sections')}</span>
      </div>

      <div
        className="section-list"
        role="list"
        aria-label={t('sidebar.sections')}
        data-drop={dropAttribute('top')}
        onKeyDown={(event) => handleNavKeyDown(event, toggleNavKey, startRename)}
        onContextMenu={openSectionListMenu}
        {...topLevelDropHandlers}
      >
        {sectionTree.sections.map((section) => renderSection(section, 0))}
        {sectionTree.groups.map((node) => renderGroup(node))}
      </div>

      {capabilities.createSection ? (
        <button type="button" className="sidebar-add-row sidebar-add-row--section sidebar-add-section" onClick={() => onAddSection()}>
          <Plus size={14} aria-hidden="true" />
          <span>{t('sidebar.section.add')}</span>
        </button>
      ) : null}

      <div className="sidebar-footer">
        <details className="sidebar-create-menu">
          <summary
            role="button"
            aria-haspopup="menu"
            aria-label={t('sidebar.add.menu')}
            title={t('sidebar.add.menu')}
          >
            <Plus size={20} />
          </summary>
          <div className="sidebar-create-menu__popover">
            <button
              type="button"
              aria-label={t('sidebar.add.canvasPage')}
              title={t('sidebar.add.canvasPageDescription')}
              data-page-kind="canvas"
              disabled={!capabilities.createPage || !activeAddTargetSectionId}
              onClick={(event) => {
                closeDetailsMenu(event);
                if (activeAddTargetSectionId) {
                  onAddPage(activeAddTargetSectionId, undefined, 'canvas');
                }
              }}
            >
              <FilePlus2 size={16} />
              <span><strong>{t('sidebar.add.canvasPage')}</strong></span>
            </button>
            <button
              type="button"
              aria-label={t('sidebar.add.markdownPage')}
              title={t('sidebar.add.markdownPageDescription')}
              data-page-kind="markdown"
              disabled={!capabilities.createPage || !activeAddTargetSectionId}
              onClick={(event) => {
                closeDetailsMenu(event);
                if (activeAddTargetSectionId) {
                  onAddPage(activeAddTargetSectionId, undefined, 'markdown');
                }
              }}
            >
              <FileText size={16} />
              <span><strong>{t('sidebar.add.markdownPage')}</strong></span>
            </button>
            <button
              type="button"
              aria-label={t('sidebar.newSection')}
              disabled={!capabilities.createSection}
              onClick={(event) => {
                closeDetailsMenu(event);
                onAddSection();
              }}
            >
              <Plus size={16} />
              <span><strong>{t('sidebar.newSection')}</strong></span>
            </button>
            {onAddSectionGroup ? (
              <button
                type="button"
                aria-label={t('menu.newSectionGroup')}
                disabled={!capabilities.createSectionGroup}
                onClick={(event) => {
                  closeDetailsMenu(event);
                  addGroup();
                }}
              >
                <FolderPlus size={16} />
                <span><strong>{t('menu.newSectionGroup')}</strong></span>
              </button>
            ) : null}
          </div>
        </details>
        <button
          type="button"
          className="trash-link"
          onClick={onOpenTrash}
          disabled={!capabilities.openTrash}
          aria-label={`${t('sidebar.trash')} (${trashCount})`}
          title={t('sidebar.trash')}
        >
          <Trash2 size={16} />
          {trashCount > 0 ? <span>{trashCount}</span> : null}
        </button>
      </div>
      </div>
      {layout === 'panes' ? (
        <ColumnResizer column="sections" label={t('sidebar.resize.sections')} width={sectionWidth} onResize={setSectionWidth} />
      ) : null}
      {layout === 'panes' ? (
        <div
          className="page-pane"
          aria-label={activeSection ? t('sidebar.pages.of', { title: activeSection.title }) : undefined}
          onKeyDown={(event) => handleNavKeyDown(event, toggleNavKey, startRename)}
        >
          {activeSection ? renderSectionPages(activeSection) : null}
        </div>
      ) : null}
      {layout === 'panes' ? (
        <ColumnResizer column="pages" label={t('sidebar.resize.pages')} width={pageWidth} onResize={setPageWidth} />
      ) : null}
      <p className="sr-only" role="status" aria-live="polite">{dragStatus}</p>
      {menu.element}
      {moveCopy ? (
        <MoveCopyDialog
          kind={moveCopy.kind}
          subjectTitle={moveCopy.kind === 'page' ? moveCopy.page.title : moveCopy.kind === 'section' ? moveCopy.section.title : moveCopy.group.title}
          notebooks={moveCopyNotebooks}
          current={moveCopyCurrent(moveCopy)}
          excludedGroupIds={moveCopy.kind === 'group' ? groupSubtreeIds(groups, moveCopy.group.id) : undefined}
          returnFocus={moveCopy.returnFocus}
          onMove={(target) => completeMoveCopy(moveCopy, target, false)}
          onCopy={moveCopy.kind === 'group' ? undefined : (target) => completeMoveCopy(moveCopy, target, true)}
          onClose={() => setMoveCopy(null)}
        />
      ) : null}
      </PageTreeContext.Provider>
    </div>
  );
});

export default Sidebar;
