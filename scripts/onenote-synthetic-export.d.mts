export interface SyntheticExportOptions {
  pages?: number;
  strokes?: number;
  points?: number;
  printouts?: number;
  maxStrokes?: number;
  seed?: number;
  /** Pixel size of each printout PNG, `WxH`. */
  printoutSize?: string;
  pdfKb?: number;
  name?: string;
}

export interface SyntheticExportTotals {
  pages: number;
  strokes: number;
  points: number;
  printoutPages: number;
  documents: number;
  bytes: number;
}

export const BM_SCALE: Readonly<{ pages: number; strokes: number; points: number; printouts: number }>;

export function syntheticExportEntries(
  options?: SyntheticExportOptions,
): AsyncGenerator<[string, Uint8Array], SyntheticExportTotals, void>;

export function writeSyntheticExport(directory: string, options?: SyntheticExportOptions): Promise<SyntheticExportTotals>;

export function syntheticExportMap(
  options?: SyntheticExportOptions,
): Promise<{ entries: Map<string, Uint8Array>; totals: SyntheticExportTotals }>;
