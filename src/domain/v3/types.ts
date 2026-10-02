import type {
  ElementFrame,
  MigrationManifestV2,
  NotebookDoc,
  PageDoc,
  PageElementV2,
  StrokeElementV2,
  StoredDocumentV2,
  TrashRecordV2,
} from '../v2/types';

export const DEFAULT_PAGE_CONTENT = Object.freeze({
  version: 1,
  kind: 'canvas',
} as const satisfies PageContentV1);

export type PageContentV1 =
  | { version: 1; kind: 'canvas' }
  | { version: 1; kind: 'markdown'; source: string };

export const WORKSPACE_SCHEMA_VERSION_V3 = 3 as const;
export const V2_TO_V3_MIGRATION_VERSION = 1 as const;

export const DEFAULT_MATH_PAGE_SETTINGS = Object.freeze({
  version: 1,
  resultMode: 'suggest',
  numberMode: 'exact',
  angleMode: 'degrees',
  autoRecognition: true,
} as const satisfies MathPageSettingsV1);

export interface MathPageSettingsV1 {
  version: 1;
  resultMode: 'suggest' | 'insert' | 'off';
  numberMode: 'exact' | 'decimal';
  angleMode: 'degrees' | 'radians';
  autoRecognition: boolean;
}

export interface MathRecognitionProviderV1 {
  kind: 'compatible-endpoint' | 'mathpix';
  apiVersion?: string;
  modelVersion?: string;
  durationMs?: number;
}

export interface MathRecognitionV1 {
  state: 'idle' | 'scheduled' | 'pending' | 'recognized' | 'ambiguous' | 'unrecognized';
  alternatives: string[];
  warnings: string[];
  provider?: MathRecognitionProviderV1;
}

export interface MathCurrencyRateV1 {
  base: string;
  quote: string;
  asOf: string;
  source: string;
  status: 'current' | 'stale';
  snapshotVersion: 1;
}

export interface MathResultV1 {
  state: 'none' | 'valid' | 'error';
  sourceFingerprint?: string;
  engineVersion?: string;
  exactLatex?: string;
  decimalText?: string;
  unit?: string;
  currencyRate?: MathCurrencyRateV1;
  diagnostics: string[];
}

export interface MathDependenciesV1 {
  sourceFingerprint?: string;
  defines: string[];
  references: string[];
  dependsOnElementIds: string[];
  state: 'valid' | 'undefined' | 'cycle';
}

export interface MathRawInkV1 {
  /** Original page-space bounds at the instant ink was converted. */
  captureFrame: ElementFrame;
  /** Exact, immutable copies of the selected source strokes. */
  sourceStrokes: StrokeElementV2[];
}

interface ElementBaseV3 {
  id: string;
  frame: ElementFrame;
  createdAt: string;
  updatedAt: string;
  locked: boolean;
}

export interface MathElementV3 extends ElementBaseV3 {
  kind: 'math';
  inputKind: 'typed' | 'ink' | 'converted-ink';
  autoRecognition: 'inherit' | 'enabled' | 'disabled';
  rawInk?: MathRawInkV1;
  typedLatex?: string;
  recognizedLatex?: string;
  correctedLatex?: string;
  recognition: MathRecognitionV1;
  result: MathResultV1;
  dependencies: MathDependenciesV1;
}

export interface GraphSeriesV1 {
  id: string;
  sourceMathElementId: string;
  color: string;
  visible: boolean;
}

export interface GraphViewportV1 {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  equalScale: boolean;
  axesVisible: boolean;
  gridVisible: boolean;
}

export interface GraphElementV3 extends ElementBaseV3 {
  kind: 'graph';
  series: GraphSeriesV1[];
  viewport: GraphViewportV1;
}

export type PageElementV3 = PageElementV2 | MathElementV3 | GraphElementV3;

export interface NotebookDocV3 extends Omit<NotebookDoc, 'schemaVersion'> {
  schemaVersion: typeof WORKSPACE_SCHEMA_VERSION_V3;
}

export interface PageDocV3 extends Omit<PageDoc, 'schemaVersion' | 'elementsById'> {
  schemaVersion: typeof WORKSPACE_SCHEMA_VERSION_V3;
  /** Missing only on losslessly upgraded v2 pages; readers apply immutable defaults. */
  mathSettings?: MathPageSettingsV1;
  /** Missing on upgraded v2 pages; readers treat it as a canvas page. */
  pageContent?: PageContentV1;
  /**
   * Paper size of a fixed-size page (`pageType: 'a4'`). Missing means A4
   * portrait, which older readers show for every fixed-size page.
   */
  paper?: PagePaperV1;
  elementsById: Record<string, PageElementV3>;
}

export interface PagePaperV1 {
  size: 'a4' | 'a5' | 'letter';
  orientation: 'portrait' | 'landscape';
}

export type CanvinkDocumentV3 = NotebookDocV3 | PageDocV3;

export interface TrashRecordV3 extends Omit<TrashRecordV2, 'element'> {
  element?: PageElementV3;
}

export interface WorkspaceManifestV3
  extends Omit<MigrationManifestV2, 'schemaVersion' | 'format' | 'trash'> {
  schemaVersion: typeof WORKSPACE_SCHEMA_VERSION_V3;
  format: 'canvink-schema-v3';
  trash: TrashRecordV3[];
  upgrade: {
    name: 'workspace-v2-to-v3';
    version: typeof V2_TO_V3_MIGRATION_VERSION;
    upgradeId: string;
    sourceArtifactFingerprint: `sha256:${string}`;
    preparedAt: string;
  };
}

export type CanvinkDocument = CanvinkDocumentV3 | NotebookDoc | PageDoc;
export type WorkspaceManifest = WorkspaceManifestV3 | MigrationManifestV2;

export interface StoredDocumentV3 extends Omit<StoredDocumentV2, 'schemaVersion'> {
  schemaVersion: typeof WORKSPACE_SCHEMA_VERSION_V3;
}

export type StoredCanvinkDocument = StoredDocumentV2 | StoredDocumentV3;

export function mathPageSettings(page: Pick<PageDocV3, 'mathSettings'>): MathPageSettingsV1 {
  return page.mathSettings
    ? structuredClone(page.mathSettings)
    : { ...DEFAULT_MATH_PAGE_SETTINGS };
}

export function pageContent(page: Pick<PageDocV3, 'pageContent'>): PageContentV1 {
  return page.pageContent
    ? structuredClone(page.pageContent)
    : { ...DEFAULT_PAGE_CONTENT };
}
