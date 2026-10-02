export const ONENOTE_IMPORT_PREVIEW_VERSION = 1 as const;

/** Deepest section-group nesting an import accepts (matches the Graph walk's default limit). */
export const MAX_IMPORT_SECTION_GROUP_DEPTH = 16;

export interface GraphNotebookInput {
  id: string;
  displayName: string;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  sections: readonly GraphSectionInput[];
}

export interface GraphSectionInput {
  id: string;
  displayName: string;
  /** Names of the enclosing section groups, outermost first; absent at the notebook's top level. */
  groupPath?: readonly string[];
  order: number;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  pages: readonly GraphPageInput[];
}

export interface GraphPageInput {
  id: string;
  title: string;
  order: number;
  level?: number;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  /** The response body from Graph's `/onenote/pages/{id}/content` endpoint. */
  html: string;
}

/**
 * Metadata for a resource that an integration has already retrieved locally.
 * The previewer deliberately accepts no access token and performs no fetches.
 */
export interface GraphResourceInput {
  id: string;
  contentUrl: string;
  mediaType: string;
  fileName?: string;
  byteLength: number;
  sha256?: string;
}

export interface GraphPdfFallbackInput {
  pageId: string;
  resourceId: string;
  previewResourceId: string;
  width: number;
  height: number;
}

export interface GraphOneNoteImportInput {
  notebooks: readonly GraphNotebookInput[];
  resources: readonly GraphResourceInput[];
  pdfFallbacks?: readonly GraphPdfFallbackInput[];
}

export type RichTextMark =
  | { type: 'bold' }
  | { type: 'italic' }
  | { type: 'underline' }
  | { type: 'strikethrough' }
  | { type: 'code' }
  | { type: 'link'; href: string };

export interface RichTextSpan {
  text: string;
  marks: RichTextMark[];
}

export interface SpatialPosition {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  zIndex?: number;
}

interface BlockBase {
  sourceId?: string;
  position?: SpatialPosition;
}

export interface TextBlock extends BlockBase {
  type: 'paragraph' | 'blockquote' | 'code';
  content: RichTextSpan[];
}

export interface HeadingBlock extends BlockBase {
  type: 'heading';
  level: 1 | 2 | 3 | 4 | 5 | 6;
  content: RichTextSpan[];
}

export interface ListItem {
  checked?: boolean;
  blocks: RichBlock[];
}

export interface ListBlock extends BlockBase {
  type: 'list';
  ordered: boolean;
  start?: number;
  items: ListItem[];
}

export interface ChecklistBlock extends BlockBase {
  type: 'checklist';
  items: Array<{ checked: boolean; content: RichTextSpan[] }>;
}

export interface TableCell {
  header: boolean;
  rowSpan: number;
  colSpan: number;
  blocks: RichBlock[];
}

export interface TableBlock extends BlockBase {
  type: 'table';
  rows: TableCell[][];
}

export interface ImageBlock extends BlockBase {
  type: 'image';
  resourceId: string;
  mediaType: string;
  alt: string;
  /** Page backgrounds (OneNote "Set Picture as Background") are pinned behind ink. */
  background?: boolean;
}

/** Element-wide text appearance; the rich-text model has no per-span colour or size. */
export interface ImportedTextStyle {
  color?: string;
  fontFamily?: string;
  /** CSS pixels */
  fontSize?: number;
}

/**
 * One positioned text container (a OneNote outline, or the part of it between
 * two flow images) that becomes a single rich-text element.
 */
export interface TextFrameBlock extends BlockBase {
  type: 'textFrame';
  blocks: RichBlock[];
  textStyle?: ImportedTextStyle;
}

export interface ImportedInkPoint {
  x: number;
  y: number;
  pressure: number;
}

/** A stroke in page coordinates (CSS pixels), ready to become a native stroke. */
export interface ImportedInkStroke {
  tool: 'pen' | 'highlighter';
  color: string;
  opacity: number;
  size: number;
  /** False for mouse or finger ink, whose width Canvink then simulates. */
  hasPressure: boolean;
  points: ImportedInkPoint[];
}

export interface InkBlock extends BlockBase {
  type: 'ink';
  strokes: ImportedInkStroke[];
}

/** One page of a file printout, shown from its rendered image and linked to the original PDF. */
export interface PdfPageBlock extends BlockBase {
  type: 'pdfPage';
  previewResourceId: string;
  originalResourceId?: string;
  pageNumber: number;
  pageCount: number;
  background: boolean;
}

export interface AttachmentBlock extends BlockBase {
  type: 'attachment';
  resourceId: string;
  mediaType: string;
  fileName: string;
}

export interface SpatialGroupBlock extends BlockBase {
  type: 'spatialGroup';
  blocks: RichBlock[];
}

export type RichBlock =
  | TextBlock
  | HeadingBlock
  | ListBlock
  | ChecklistBlock
  | TableBlock
  | ImageBlock
  | AttachmentBlock
  | SpatialGroupBlock
  | TextFrameBlock
  | InkBlock
  | PdfPageBlock;

export type FidelityStatus =
  | 'complete'
  | 'visual'
  | 'simplified'
  | 'unsupported';

export type FidelityIssueCode =
  | 'attachment-resource-missing'
  | 'content-limit-exceeded'
  | 'image-resource-missing'
  | 'ink-data-missing'
  | 'invalid-position'
  | 'layout-estimated'
  | 'list-nesting-flattened'
  | 'malformed-html'
  | 'pdf-fallback-invalid'
  | 'resource-not-downloaded'
  | 'resource-too-large'
  | 'style-dropped'
  | 'data-tag-unsupported'
  | 'unsafe-file-name'
  | 'unsafe-url-dropped'
  | 'unsupported-element';

export interface FidelityIssue {
  code: FidelityIssueCode;
  severity: 'visual' | 'simplified' | 'unsupported';
  message: string;
  sourceElement?: string;
}

export interface PageFidelityReport {
  pageId: string;
  status: FidelityStatus;
  issues: FidelityIssue[];
  convertedBlockCount: number;
  pdfFallbackResourceId?: string;
  pdfFallbackPreviewResourceId?: string;
  pdfFallbackWidth?: number;
  pdfFallbackHeight?: number;
  /** What a desktop export carried onto the page, for the review and the import report. */
  contentCounts?: PageContentCounts;
}

export interface PageContentCounts {
  textFrames: number;
  images: number;
  printoutPages: number;
  attachments: number;
  inkObjects: number;
  inkStrokes: number;
}

export interface PlannedPageImport {
  sourceId: string;
  title: string;
  order: number;
  level: number;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  blocks: RichBlock[];
  tags?: string[];
  taskState?: 'open' | 'done';
  /** Paper of the page (OneNote rule lines and page colour); plain white when missing. */
  background?: PlannedPageBackground;
  fidelity: PageFidelityReport;
}

export interface PlannedPageBackground {
  type: 'plain' | 'lined' | 'grid';
  color: string;
  /** Distance between rule lines in CSS pixels. */
  spacing?: number;
  lineColor?: string;
}

export interface PlannedSectionImport {
  sourceId: string;
  /** The section's own name, without its group path. */
  displayName: string;
  /**
   * Names of the enclosing OneNote section groups, outermost first; absent at
   * the notebook's top level. Applying the import turns every distinct path
   * prefix into one Canvink section group.
   */
  groupPath?: string[];
  /** Section tab colour, `#rrggbb`. */
  color?: string;
  order: number;
  pages: PlannedPageImport[];
}

export interface PlannedNotebookImport {
  sourceId: string;
  displayName: string;
  sections: PlannedSectionImport[];
}

export interface PlannedResourceImport {
  sourceId: string;
  mediaType: string;
  fileName?: string;
  byteLength: number;
  sha256?: string;
}

export interface OneNoteImportPreviewPlan {
  kind: 'onenote-import-preview';
  version: typeof ONENOTE_IMPORT_PREVIEW_VERSION;
  createdAt: string;
  /** A declarative proposal only. No WorkspaceState or persistence adapter is accepted. */
  notebooks: PlannedNotebookImport[];
  resources: PlannedResourceImport[];
  pageReports: PageFidelityReport[];
  summary: Record<FidelityStatus, number>;
}
