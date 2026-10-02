export const WORKSPACE_SCHEMA_VERSION_V2 = 2 as const;
export const V1_TO_V2_MIGRATION_VERSION = 1 as const;

export type Sha256Checksum = `sha256:${string}`;

export interface VersionHeads {
  /** Empty until a CRDT implementation takes ownership of this document. */
  protocol: 'uninitialized' | 'automerge';
  /** Opaque, encoded Automerge heads when protocol is `automerge`. */
  heads: string[];
}

export interface AssetRef {
  assetId: Sha256Checksum;
  checksum: Sha256Checksum;
  mimeType: string;
  size: number;
  fileName?: string;
  role: 'original' | 'preview';
}

export interface AssetBlob {
  assetId: Sha256Checksum;
  checksum: Sha256Checksum;
  size: number;
  bytes: Uint8Array;
}

export interface ElementFrame {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
}

interface ElementBaseV2 {
  id: string;
  frame: ElementFrame;
  createdAt: string;
  updatedAt: string;
  locked: boolean;
}

export interface RichTextMark {
  type: 'bold' | 'italic' | 'underline' | 'strike' | 'inlineCode' | 'link';
  href?: string;
}

export interface RichTextSpan {
  text: string;
  marks: RichTextMark[];
}

export type RichTextBlock =
  | {
      id: string;
      type: 'paragraph' | 'heading';
      level?: 1 | 2 | 3 | 4 | 5 | 6;
      list?: 'bullet' | 'ordered';
      spans: RichTextSpan[];
    }
  | {
      id: string;
      type: 'checkItem';
      checked: boolean;
      spans: RichTextSpan[];
    }
  | {
      id: string;
      type: 'table';
      rows: RichTextSpan[][][];
    };

export interface RichTextDocument {
  type: 'doc';
  blocks: RichTextBlock[];
}

export interface RichTextElementV2 extends ElementBaseV2 {
  kind: 'richText';
  content: RichTextDocument;
  style: {
    color: string;
    fontFamily: string;
    fontSize: number;
    textAlign: 'left' | 'center' | 'right';
  };
}

export interface StrokePointV2 {
  x: number;
  y: number;
  pressure: number;
  tiltX: number;
  tiltY: number;
  time: number;
  pointerType: string;
}

export interface StrokeElementV2 extends ElementBaseV2 {
  kind: 'stroke';
  tool: 'pen' | 'highlighter';
  points: StrokePointV2[];
  color: string;
  size: number;
  opacity: number;
  tombstonedAt?: string;
  sourceStrokeId?: string;
}

export interface ShapeElementV2 extends ElementBaseV2 {
  kind: 'shape';
  shape: 'line' | 'arrow' | 'rectangle' | 'ellipse' | 'triangle' | 'axes';
  strokeColor: string;
  fillColor?: string;
  strokeWidth: number;
  points?: Array<{ x: number; y: number }>;
}

export interface ImageElementV2 extends ElementBaseV2 {
  kind: 'image';
  asset: AssetRef;
  alt: string;
}

export interface PdfElementV2 extends ElementBaseV2 {
  kind: 'pdf';
  originalAsset?: AssetRef;
  previewAsset: AssetRef;
  pageCount: number;
  /** One-based page within originalAsset for multi-page worksheet fidelity. */
  sourcePageNumber?: number;
  sourceAvailability: 'original' | 'preview-only';
}

export interface AttachmentElementV2 extends ElementBaseV2 {
  kind: 'attachment';
  asset: AssetRef;
  displayName: string;
}

export type PageElementV2 =
  | RichTextElementV2
  | StrokeElementV2
  | ShapeElementV2
  | ImageElementV2
  | PdfElementV2
  | AttachmentElementV2;

export interface PageDoc {
  schemaVersion: typeof WORKSPACE_SCHEMA_VERSION_V2;
  documentId: string;
  kind: 'page';
  notebookId: string;
  sectionId: string;
  pageId: string;
  parentPageId?: string;
  title: string;
  tags: string[];
  taskState?: 'open' | 'done';
  pageType: 'free' | 'a4';
  background: {
    type: 'plain' | 'lined' | 'grid' | 'millimeter';
    color: string;
    /**
     * Distance between rule lines in page units, as OneNote's line sizes
     * (narrow, college, wide lines; small to very large squares). Missing on
     * older pages; readers use the default spacing of the type.
     */
    spacing?: number;
    /** Base colour of the rule lines; missing means the default blue. */
    lineColor?: string;
    /** How visible the rule lines are; missing means `light`. */
    lineStrength?: 'light' | 'medium' | 'strong';
  };
  createdAt: string;
  updatedAt: string;
  /** Stable element paths are required by Automerge/ProseMirror bindings. */
  elementsById: Record<string, PageElementV2>;
  zOrder: string[];
  version: VersionHeads;
}

export interface NotebookSectionRef {
  id: string;
  title: string;
  /**
   * Colour chosen with "Abschnittsfarbe" (`#rrggbb`). Optional and additive:
   * sections without it show a colour derived from their id.
   */
  color?: string;
  /**
   * The section group ("Abschnittsgruppe") the section sits in. Optional and
   * additive like `color`: absent means the notebook's top level. Readers
   * treat an id that names no group as absent.
   */
  groupId?: string;
  createdAt: string;
  updatedAt: string;
  pageDocumentIds: string[];
}

/**
 * A section group, OneNote's folder for sections. Groups nest through
 * `parentGroupId`; their order among siblings is their order in
 * `NotebookDoc.sectionGroups`. Sections keep their order in
 * `NotebookDoc.sections` and name their group with `groupId`, so documents
 * written before groups existed stay valid and older readers still see
 * every section.
 */
export interface NotebookSectionGroupRef {
  id: string;
  title: string;
  /** Absent means the group sits at the notebook's top level. */
  parentGroupId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface NotebookDoc {
  schemaVersion: typeof WORKSPACE_SCHEMA_VERSION_V2;
  documentId: string;
  kind: 'notebook';
  notebookId: string;
  title: string;
  color: string;
  createdAt: string;
  updatedAt: string;
  sections: NotebookSectionRef[];
  /** Section groups; absent on notebooks that never had one. */
  sectionGroups?: NotebookSectionGroupRef[];
  settings: NotebookSettings;
  version: VersionHeads;
}

export type NotebookSortKey = 'manual' | 'title' | 'created' | 'updated';

/**
 * What new pages of the notebook start with. Every key is optional and
 * written on its own, so two devices changing different keys merge cleanly;
 * a missing key means the built-in default, which is what notebooks that
 * never had these settings have always produced (A4 portrait sheet, squares,
 * white paper).
 */
export interface NotebookNewPageDefaults {
  pageType?: 'free' | 'a4';
  /** Size of the sheet when `pageType` is `a4`. */
  paper?: { size: 'a4' | 'a5' | 'letter'; orientation: 'portrait' | 'landscape' };
  ruling?: PageDoc['background']['type'];
  spacing?: number;
  /** Colour of the paper (`#rrggbb`). */
  paperColor?: string;
  lineColor?: string;
  lineStrength?: NonNullable<PageDoc['background']['lineStrength']>;
  /** `builtin:<id>` of a built-in template or `page:<pageId>` of a page tagged as template. */
  template?: string;
  /** Font size of new text boxes. */
  textSize?: number;
  /** Colour of new text boxes (`#rrggbb`). */
  textColor?: string;
}

export interface NotebookSettings {
  /**
   * Mirrors `newPage.pageType` for readers from before the per-notebook
   * settings; the current readers use `newPage`.
   */
  defaultPageType: 'free' | 'a4';
  /** A short symbol (one emoji) shown instead of the colour dot. */
  icon?: string;
  newPage?: NotebookNewPageDefaults;
  /** How the navigation orders sections and pages; missing means manual. */
  sort?: { sections?: NotebookSortKey; pages?: NotebookSortKey };
}

export type CanvinkDocumentV2 = NotebookDoc | PageDoc;

export interface TrashRecordV2 {
  id: string;
  kind: 'notebook' | 'section' | 'page' | 'element';
  deletedAt: string;
  origin: Record<string, unknown>;
  notebookDocumentId?: string;
  section?: NotebookSectionRef;
  pageDocumentId?: string;
  element?: PageElementV2;
}

export interface MigrationManifestV2 {
  schemaVersion: typeof WORKSPACE_SCHEMA_VERSION_V2;
  format: 'canvink-schema-v2';
  migration: {
    name: 'workspace-v1-to-v2';
    version: typeof V1_TO_V2_MIGRATION_VERSION;
    migrationId: string;
    sourceFingerprint: Sha256Checksum;
    preparedAt: string;
  };
  active: {
    notebookId: string;
    sectionId: string;
    pageId: string;
  };
  notebookDocumentIds: string[];
  pageDocumentIds: string[];
  assetIds: Sha256Checksum[];
  trash: TrashRecordV2[];
}

export interface MigrationPreviewV2 {
  notebooks: number;
  sections: number;
  pages: number;
  elements: number;
  trashEntries: number;
  uniqueAssets: number;
  extractedAssetBytes: number;
  previewOnlyPdfs: number;
}

export interface MigrationResultV2 {
  manifest: MigrationManifestV2;
  documents: CanvinkDocumentV2[];
  assets: AssetBlob[];
  preview: MigrationPreviewV2;
  artifactFingerprint: Sha256Checksum;
}

export interface StoredDocumentV2 {
  documentId: string;
  kind: CanvinkDocumentV2['kind'];
  schemaVersion: typeof WORKSPACE_SCHEMA_VERSION_V2;
  /** JSON is the migration projection. `automerge` is reserved for later binary CRDT data. */
  documentFormat: 'canvink-json-v2' | 'automerge';
  encoding: 'utf8-json' | 'binary';
  version: VersionHeads;
  bytes: Uint8Array;
}
