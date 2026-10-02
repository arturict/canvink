/**
 * The folder layout written by `scripts/onenote-com-export.ps1`. The exporter
 * stays deliberately thin: it saves OneNote's own page XML (with binary data
 * moved into files and referenced by `canvink*` attributes) and decodes only
 * what the browser cannot, namely ISF ink and Windows metafile images. All
 * layout and formatting decisions live in the TypeScript converter, so they
 * can be fixed without exporting the notebook again.
 *
 * manifest.json            OneNoteDesktopExportManifest
 * pages/<n>.xml            GetPageContent(piAll, xs2013) with binary data externalised
 * ink/<n>.json             OneNoteDesktopInkFile for the ink objects of page n
 * assets/<sha256>.<ext>    images; Windows metafiles are converted to PNG
 * files/<sha256>.<ext>     inserted files (attachments, the PDF behind a printout)
 *
 * Page XML attributes added by the exporter:
 *   canvinkAsset="assets/…"  on one:Image (and the image's pixel size in canvinkPixelWidth/Height)
 *   canvinkInk="<key>"       on one:InkDrawing / one:InkWord / one:InkParagraph etc.
 *   canvinkFile="files/…"    on one:InsertedFile and one:MediaFile
 *   canvinkError="…"         where binary data could not be exported
 */
export const ONENOTE_DESKTOP_EXPORT_FORMAT = 'canvink-onenote-desktop-export' as const;
export const ONENOTE_DESKTOP_EXPORT_VERSION = 1 as const;

export interface OneNoteDesktopExportPage {
  id: string;
  name: string;
  /** OneNote's pageLevel: 1 is a top-level page, 2 and 3 are subpages. */
  level: number;
  created?: string;
  modified?: string;
  file?: string;
  ink?: string;
  error?: string;
}

export interface OneNoteDesktopExportSection {
  id: string;
  name: string;
  /** Names of the enclosing section groups, outermost first. */
  groupPath: string[];
  color?: string;
  encrypted?: boolean;
  locked?: boolean;
  pages: OneNoteDesktopExportPage[];
}

export interface OneNoteDesktopExportAsset {
  path: string;
  mediaType: string;
  bytes: number;
  sha256: string;
  /** Original OneNote image format when the exporter converted it (for example `emf`). */
  sourceFormat?: string;
  originalName?: string;
  /** Pixel size of images, used to respect Canvink's decoded-pixel limit before import. */
  width?: number;
  height?: number;
}

export interface OneNoteDesktopExportManifest {
  format: typeof ONENOTE_DESKTOP_EXPORT_FORMAT;
  version: typeof ONENOTE_DESKTOP_EXPORT_VERSION;
  exportedAt: string;
  generator?: string;
  notebook: { id: string; name: string; nickname?: string; color?: string };
  sections: OneNoteDesktopExportSection[];
  assets: OneNoteDesktopExportAsset[];
  errors?: string[];
}

/** One decoded ISF stroke, in WPF device-independent pixels (1/96 inch). */
export interface OneNoteDesktopInkStroke {
  /** #rrggbb */
  c: string;
  /** Alpha 0–255 of the drawing colour. */
  a: number;
  /** Pen tip width and height. */
  w: number;
  h: number;
  /** IsHighlighter */
  hl: boolean;
  /** IgnorePressure */
  ip?: boolean;
  /** Flat x, y, pressure triples; pressure is WPF's PressureFactor 0–1. */
  p: number[];
}

export interface OneNoteDesktopInkObject {
  /** StrokeCollection.GetBounds(): x, y, width, height including pen size. */
  bounds: [number, number, number, number];
  strokes: OneNoteDesktopInkStroke[];
}

export interface OneNoteDesktopInkFile {
  objects: Record<string, OneNoteDesktopInkObject>;
}

function fail(message: string): never {
  throw new Error(`OneNote desktop export: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) fail(`${label} is missing or invalid.`);
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  return value === undefined || value === null || value === '' ? undefined : string(value, label);
}

function safePath(value: unknown, prefix: string, label: string): string {
  const path = string(value, label).replace(/\\/g, '/');
  if (!path.startsWith(prefix) || path.split('/').some((part) => part === '..' || part === '')) {
    fail(`${label} has an unsafe path.`);
  }
  return path;
}

export function validateDesktopExportManifest(raw: unknown): OneNoteDesktopExportManifest {
  if (!isRecord(raw)) fail('manifest.json is not an object.');
  if (raw.format !== ONENOTE_DESKTOP_EXPORT_FORMAT) fail('manifest.json is not a Canvink OneNote desktop export.');
  if (raw.version !== ONENOTE_DESKTOP_EXPORT_VERSION) fail(`manifest version ${String(raw.version)} is not supported.`);
  if (!isRecord(raw.notebook)) fail('the notebook entry is missing.');
  if (!Array.isArray(raw.sections)) fail('the section list is missing.');
  if (!Array.isArray(raw.assets)) fail('the asset list is missing.');
  const sections = raw.sections.map((section, sectionIndex): OneNoteDesktopExportSection => {
    if (!isRecord(section) || !Array.isArray(section.pages)) fail(`section ${sectionIndex} is malformed.`);
    return {
      id: string(section.id, `section ${sectionIndex} id`),
      name: string(section.name, `section ${sectionIndex} name`),
      groupPath: Array.isArray(section.groupPath)
        ? section.groupPath.map((name, index) => string(name, `section ${sectionIndex} group ${index}`))
        : [],
      color: optionalString(section.color, 'section color'),
      encrypted: section.encrypted === true,
      locked: section.locked === true,
      pages: section.pages.map((page, pageIndex): OneNoteDesktopExportPage => {
        const label = `section ${sectionIndex} page ${pageIndex}`;
        if (!isRecord(page)) fail(`${label} is malformed.`);
        const level = page.level === undefined ? 1 : Number(page.level);
        if (!Number.isInteger(level) || level < 1 || level > 32) fail(`${label} level is invalid.`);
        return {
          id: string(page.id, `${label} id`),
          name: typeof page.name === 'string' ? page.name : '',
          level,
          created: optionalString(page.created, `${label} created`),
          modified: optionalString(page.modified, `${label} modified`),
          file: page.file === undefined || page.file === null ? undefined : safePath(page.file, 'pages/', `${label} file`),
          ink: page.ink === undefined || page.ink === null ? undefined : safePath(page.ink, 'ink/', `${label} ink`),
          error: optionalString(page.error, `${label} error`),
        };
      }),
    };
  });
  const assets = raw.assets.map((asset, index): OneNoteDesktopExportAsset => {
    if (!isRecord(asset)) fail(`asset ${index} is malformed.`);
    const path = string(asset.path, `asset ${index} path`).replace(/\\/g, '/');
    if (!(path.startsWith('assets/') || path.startsWith('files/'))) fail(`asset ${index} has an unsafe path.`);
    safePath(path, path.startsWith('assets/') ? 'assets/' : 'files/', `asset ${index} path`);
    const bytes = Number(asset.bytes);
    if (!Number.isSafeInteger(bytes) || bytes < 0) fail(`asset ${index} size is invalid.`);
    const sha256 = string(asset.sha256, `asset ${index} sha256`).toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(sha256)) fail(`asset ${index} sha256 is invalid.`);
    const width = Number(asset.width);
    const height = Number(asset.height);
    return {
      path,
      ...(Number.isSafeInteger(width) && width > 0 ? { width } : {}),
      ...(Number.isSafeInteger(height) && height > 0 ? { height } : {}),
      mediaType: string(asset.mediaType, `asset ${index} mediaType`).toLowerCase(),
      bytes,
      sha256,
      sourceFormat: optionalString(asset.sourceFormat, `asset ${index} sourceFormat`),
      originalName: optionalString(asset.originalName, `asset ${index} originalName`),
    };
  });
  return {
    format: ONENOTE_DESKTOP_EXPORT_FORMAT,
    version: ONENOTE_DESKTOP_EXPORT_VERSION,
    exportedAt: string(raw.exportedAt, 'exportedAt'),
    generator: optionalString(raw.generator, 'generator'),
    notebook: {
      id: string(raw.notebook.id, 'notebook id'),
      name: string(raw.notebook.name, 'notebook name'),
      nickname: optionalString(raw.notebook.nickname, 'notebook nickname'),
      color: optionalString(raw.notebook.color, 'notebook color'),
    },
    sections,
    assets,
    errors: Array.isArray(raw.errors) ? raw.errors.filter((item): item is string => typeof item === 'string') : [],
  };
}

export function validateDesktopInkFile(raw: unknown, path: string): OneNoteDesktopInkFile {
  if (!isRecord(raw) || !isRecord(raw.objects)) fail(`${path} is malformed.`);
  const objects: Record<string, OneNoteDesktopInkObject> = {};
  for (const [key, value] of Object.entries(raw.objects)) {
    if (!isRecord(value) || !Array.isArray(value.bounds) || value.bounds.length !== 4 || !Array.isArray(value.strokes)) {
      fail(`${path} ink object ${key} is malformed.`);
    }
    const bounds = value.bounds.map(Number) as [number, number, number, number];
    if (bounds.some((item) => !Number.isFinite(item))) fail(`${path} ink object ${key} has invalid bounds.`);
    objects[key] = {
      bounds,
      strokes: value.strokes.map((stroke, index): OneNoteDesktopInkStroke => {
        if (!isRecord(stroke) || !Array.isArray(stroke.p) || stroke.p.length % 3 !== 0) {
          fail(`${path} ink object ${key} stroke ${index} is malformed.`);
        }
        const points = stroke.p.map(Number);
        if (points.some((item) => !Number.isFinite(item))) fail(`${path} ink object ${key} stroke ${index} has invalid points.`);
        const color = typeof stroke.c === 'string' && /^#[0-9a-f]{6}$/i.test(stroke.c) ? stroke.c.toLowerCase() : '#000000';
        const alpha = Number(stroke.a);
        const width = Number(stroke.w);
        const height = Number(stroke.h);
        return {
          c: color,
          a: Number.isFinite(alpha) ? Math.min(255, Math.max(0, alpha)) : 255,
          w: Number.isFinite(width) && width > 0 ? width : 2,
          h: Number.isFinite(height) && height > 0 ? height : 2,
          hl: stroke.hl === true,
          ip: stroke.ip === true,
          p: points,
        };
      }),
    };
  }
  return { objects };
}
