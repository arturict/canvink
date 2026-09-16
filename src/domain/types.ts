export const WORKSPACE_SCHEMA_VERSION = 1 as const;

export type PageMode = 'free' | 'a4';
export type EditorTool =
  | 'select'
  | 'pen'
  | 'highlighter'
  | 'eraser'
  | 'text'
  | 'checklist';
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

export type PageElement =
  | StrokeElement
  | TextElement
  | ChecklistElement
  | ImageElement
  | PdfElement;

export interface Page {
  id: string;
  parentPageId?: string;
  title: string;
  tags?: PageTag[];
  taskState?: PageTaskState;
  mode: PageMode;
  createdAt: string;
  updatedAt: string;
  elements: PageElement[];
}

export interface Section {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  pages: Page[];
}

export interface Notebook {
  id: string;
  title: string;
  color: string;
  createdAt: string;
  updatedAt: string;
  sections: Section[];
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
