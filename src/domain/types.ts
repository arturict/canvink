export const WORKSPACE_SCHEMA_VERSION = 1 as const;

export type PageMode = 'free' | 'a4';
export type PageBackground = 'blank' | 'lined' | 'grid' | 'millimeter';
export type ShapeType = 'line' | 'arrow' | 'rectangle' | 'ellipse' | 'triangle' | 'axes';
export type EditorTool =
  | 'select'
  | 'hand'
  | 'pen'
  | 'highlighter'
  | 'eraser'
  | 'text'
  | 'checklist'
  | 'shape';
export type TrashKind = 'notebook' | 'section' | 'page' | 'element';
export type PageTag = 'important' | 'todo' | 'question' | 'idea';
export type PageTaskState = 'open' | 'done';
export type TextListStyle = 'none' | 'bullet' | 'numbered';

export interface InkPoint {
  x: number;
  y: number;
  pressure: number;
  tiltX: number;
  tiltY: number;
  time: number;
  pointerType: string;
}

interface ElementBase {
  id: string;
  x: number;
  y: number;
  createdAt: string;
  updatedAt: string;
}

export interface StrokeElement extends ElementBase {
  kind: 'stroke';
  tool: 'pen' | 'highlighter';
  points: InkPoint[];
  color: string;
  size: number;
  opacity: number;
}

export interface TextElement extends ElementBase {
  kind: 'text';
  text: string;
  width: number;
  height: number;
  color: string;
  fontSize: number;
  fontFamily: string;
  fontWeight: 400 | 500 | 600 | 700;
  fontStyle?: 'normal' | 'italic';
  textDecoration?: 'none' | 'underline' | 'line-through';
  textAlign?: 'left' | 'center' | 'right';
  listStyle?: TextListStyle;
}

export interface ChecklistItem {
  id: string;
  text: string;
  checked: boolean;
}

export interface ChecklistElement extends ElementBase {
  kind: 'checklist';
  width: number;
  height: number;
  color: string;
  fontSize: number;
  items: ChecklistItem[];
}

export interface ImageElement extends ElementBase {
  kind: 'image';
  dataUrl: string;
  name: string;
  alt: string;
  width: number;
  height: number;
}

export interface PdfElement extends ElementBase {
  kind: 'pdf';
  previewDataUrl: string;
  sourceName: string;
  pageCount: number;
  width: number;
  height: number;
}

export interface ShapeElement extends ElementBase {
  kind: 'shape';
  shapeType: ShapeType;
  width: number;
  height: number;
  rotation: number;
  color: string;
  strokeWidth: number;
}

export type PageElement =
  | StrokeElement
  | TextElement
  | ChecklistElement
  | ImageElement
  | PdfElement
  | ShapeElement;

export interface Page {
  id: string;
  parentPageId?: string;
  title: string;
  tags?: PageTag[];
  taskState?: PageTaskState;
  mode: PageMode;
  /** Older workspaces omitted this field and used the original grid canvas. */
  background?: PageBackground;
  createdAt: string;
  updatedAt: string;
  elements: PageElement[];
}

export interface Section {
  id: string;
  title: string;
  /** Chosen section colour; absent means the derived default. */
  color?: string;
  /** The section group the section sits in; absent means the top level. */
  groupId?: string;
  createdAt: string;
  updatedAt: string;
  pages: Page[];
}

/** A section group ("Abschnittsgruppe"); groups nest via `parentGroupId`. */
export interface SectionGroup {
  id: string;
  title: string;
  parentGroupId?: string;
}

export interface Notebook {
  id: string;
  title: string;
  color: string;
  createdAt: string;
  updatedAt: string;
  sections: Section[];
  /** Section groups in sibling order; absent when the notebook has none. */
  sectionGroups?: SectionGroup[];
  /** The notebook's own symbol (an emoji), shown instead of its colour dot. */
  icon?: string;
  /**
   * How the navigation orders sections and pages when the notebook does not
   * keep the user's own order. `sections` and `pages` are already sorted;
   * manual moves have no visible effect while a key is set.
   */
  sort?: { sections: 'manual' | 'title' | 'created' | 'updated'; pages: 'manual' | 'title' | 'created' | 'updated' };
}

export interface TrashOrigin {
  notebookId?: string;
  sectionId?: string;
  pageId?: string;
  originalParentPageId?: string;
  previousSiblingId?: string;
  nextSiblingId?: string;
  index?: number;
  childPageIds?: string[];
}

export interface TrashEntry {
  id: string;
  kind: TrashKind;
  deletedAt: string;
  origin: TrashOrigin;
  item: Notebook | Section | Page | PageElement;
}

export interface WorkspaceState {
  schemaVersion: typeof WORKSPACE_SCHEMA_VERSION;
  updatedAt: string;
  notebooks: Notebook[];
  trash: TrashEntry[];
  activeNotebookId: string;
  activeSectionId: string;
  activePageId: string;
}

export interface ActiveContext {
  notebook: Notebook;
  section: Section;
  page: Page;
}

export interface WorkspaceSearchResult {
  id: string;
  kind: 'notebook' | 'section' | 'page' | 'text' | 'checklist';
  title: string;
  excerpt: string;
  notebookId: string;
  sectionId: string;
  pageId: string;
  elementId?: string;
}

export interface BrushSettings {
  color: string;
  size: number;
}
