import { MAX_IMAGE_FILE_BYTES, MAX_IMAGE_PIXELS, MAX_PDF_FILE_BYTES, MAX_WORKSPACE_IMPORT_BYTES } from '../../domain/limits';
import { isOneNoteRecycleBinGroupName } from '../../domain/oneNoteRecycleBin';
import { sha256Canonical } from '../../domain/v2';
import type {
  OneNoteImportOutline,
  OneNoteImportPageSource,
  OneNoteImportResourceBody,
  PlannedPageOutline,
  PlannedSectionOutline,
} from '../apply/types';
import type {
  FidelityIssue,
  FidelityStatus,
  PageContentCounts,
  PlannedPageImport,
  RichBlock,
} from '../types';
import {
  validateDesktopExportManifest,
  validateDesktopInkFile,
  type OneNoteDesktopExportAsset,
  type OneNoteDesktopExportManifest,
  type OneNoteDesktopExportPage,
  type OneNoteDesktopInkFile,
} from './exportFormat';
import { convertDesktopPageXml, type DesktopAssetInfo } from './pageXml';
import { parseXml } from './xml';
import type { ZipArchive } from './zip';

/** The files of an export, however the user handed them over (folder picker or ZIP). */
export interface DesktopExportFiles {
  /** Paths relative to the export root, with forward slashes. */
  has(path: string): boolean;
  read(path: string): Promise<Uint8Array>;
  /** Byte size without reading the file, when the container knows it. */
  size?(path: string): number | undefined;
}

export interface OneNoteDesktopImportOptions {
  createdAt: string;
  /** Title for pages OneNote shows as untitled. */
  untitledPage?: string;
  /** OneNote's hidden recycle bin group is skipped unless this is set. */
  includeRecycleBin?: boolean;
  signal?: AbortSignal;
}

/** What the manifest tells before any page is read. */
export interface OneNoteDesktopExportSummary {
  sections: number;
  pages: number;
  /** Pages OneNote did not export (password-protected sections, errors). */
  pagesWithErrors: number;
  /** Pictures and printout page images in `assets/`. */
  images: number;
  /** Inserted files and printout PDFs in `files/`. */
  files: number;
  resourceBytes: number;
}

export interface OneNoteDesktopAcquisition {
  source: 'desktop-export';
  manifest: OneNoteDesktopExportManifest;
  /** Structure for the review; pages are read one at a time by `reader` during apply. */
  outline: OneNoteImportOutline;
  reader: OneNoteImportPageSource;
  /** Page titles by OneNote page ID, for the review list. */
  pageTitles: Record<string, string>;
  summary: OneNoteDesktopExportSummary;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('The OneNote import was cancelled.', 'AbortError');
}

/** Plan resource IDs may not contain slashes; export paths are `assets/<sha>.<ext>`. */
function resourceIdForPath(path: string): string {
  return `onenote-desktop:${path.replace(/\//g, ':')}`;
}

function pageStatus(blocks: readonly RichBlock[], issues: readonly FidelityIssue[], failed: boolean): FidelityStatus {
  if (failed || (blocks.length === 0 && issues.some((item) => item.severity === 'unsupported'))) return 'unsupported';
  if (issues.some((item) => item.severity === 'unsupported' || item.severity === 'simplified')) return 'simplified';
  if (issues.length > 0) return 'visual';
  return 'complete';
}

function validTimestamp(value: string | undefined): string | undefined {
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined;
}

function limitReason(asset: OneNoteDesktopExportAsset, kind: 'image' | 'pdf' | 'attachment'): string | undefined {
  const megabytes = (value: number) => `${Math.round(value / 1024 / 1024)} MB`;
  const name = asset.originalName ?? asset.path;
  if (kind === 'image') {
    if (asset.bytes > MAX_IMAGE_FILE_BYTES) return `The picture ${name} is larger than ${megabytes(MAX_IMAGE_FILE_BYTES)}.`;
    if (asset.width && asset.height && asset.width * asset.height > MAX_IMAGE_PIXELS) return `The picture ${name} has too many pixels.`;
  } else if (kind === 'pdf') {
    if (asset.mediaType !== 'application/pdf') return `${name} is not a PDF.`;
    if (asset.bytes > MAX_PDF_FILE_BYTES) return `The PDF ${name} is larger than ${megabytes(MAX_PDF_FILE_BYTES)}.`;
  } else if (asset.bytes > MAX_WORKSPACE_IMPORT_BYTES) {
    return `The file ${name} is larger than ${megabytes(MAX_WORKSPACE_IMPORT_BYTES)}.`;
  }
  if (asset.bytes === 0) return `${name} is empty.`;
  return undefined;
}

interface IndexedDesktopPage {
  page: OneNoteDesktopExportPage;
  title: string;
  level: number;
  order: number;
}

/**
 * Opens a OneNote desktop export for review by reading only its manifest.
 * The returned reader converts one page (page XML and ink) and reads one
 * resource at a time when the import is applied, so neither the review nor
 * the import holds the whole notebook in memory. Nothing is written here.
 */
export async function openOneNoteDesktopExport(
  files: DesktopExportFiles,
  options: OneNoteDesktopImportOptions,
): Promise<OneNoteDesktopAcquisition> {
  if (!Number.isFinite(Date.parse(options.createdAt))) throw new Error('createdAt must be an ISO date.');
  if (!files.has('manifest.json')) throw new Error('The folder has no manifest.json. Choose the folder the OneNote exporter wrote.');
  abortIfNeeded(options.signal);
  const manifestBytes = await files.read('manifest.json');
  const parsedManifest = validateDesktopExportManifest(JSON.parse(utf8.decode(manifestBytes)));
  // Deleted pages live in a section group OneNote hides; Canvink has its own trash.
  const manifest = options.includeRecycleBin
    ? parsedManifest
    : { ...parsedManifest, sections: parsedManifest.sections.filter((section) => !isOneNoteRecycleBinGroupName(section.groupPath[0] ?? '')) };
  const assets = new Map<string, OneNoteDesktopExportAsset>(
    manifest.assets.map((asset) => [asset.path, { ...asset }]),
  );
  const untitled = options.untitledPage ?? 'Ohne Titel';
  const summary: OneNoteDesktopExportSummary = {
    sections: manifest.sections.length,
    pages: 0,
    pagesWithErrors: 0,
    images: manifest.assets.filter((asset) => asset.path.startsWith('assets/')).length,
    files: manifest.assets.filter((asset) => asset.path.startsWith('files/')).length,
    resourceBytes: manifest.assets.reduce((sum, asset) => sum + asset.bytes, 0),
  };
  const pageTitles: Record<string, string> = {};
  const pagesById = new Map<string, IndexedDesktopPage>();
  const warnings: OneNoteImportOutline['warnings'] = (manifest.errors ?? []).map((message) => ({ message }));
  // Recorded at review; a page file whose size changes afterwards is refused.
  const fileSizes: Array<[string, number | null]> = [];
  const sections: PlannedSectionOutline[] = manifest.sections.map((section, sectionIndex) => {
    const pages: PlannedPageOutline[] = [];
    let previousLevel = -1;
    for (const [pageIndex, page] of section.pages.entries()) {
      if (pagesById.has(page.id)) continue;
      // Canvink requires each subpage to sit directly below an existing parent level.
      const level = Math.max(0, Math.min(page.level - 1, previousLevel + 1));
      previousLevel = level;
      const title = page.name.trim() || untitled;
      pagesById.set(page.id, { page, title, level, order: pageIndex });
      pageTitles[page.id] = title;
      summary.pages += 1;
      if (page.error || !page.file || !files.has(page.file)) {
        summary.pagesWithErrors += 1;
        warnings.push({ pageId: page.id, message: page.error ?? 'The exported page file is missing.' });
      }
      for (const path of [page.file, page.ink]) {
        if (path) fileSizes.push([path, files.has(path) ? files.size?.(path) ?? null : null]);
      }
      pages.push({ sourceId: page.id, title, order: pageIndex, level });
    }
    return {
      sourceId: section.id,
      displayName: section.name,
      ...(section.groupPath.length > 0 ? { groupPath: [...section.groupPath] } : {}),
      ...(section.color && /^#[0-9a-f]{6}$/i.test(section.color) ? { color: section.color.toLowerCase() } : {}),
      order: sectionIndex,
      pages,
    };
  });
  const recordedSizes = new Map(fileSizes);
  const sourceRevision = await sha256Canonical({
    namespace: 'canvink-onenote-desktop-source-v1',
    manifest: await sha256Hex(manifestBytes),
    files: fileSizes,
  });
  const pathByResourceId = new Map([...assets.keys()].map((path) => [resourceIdForPath(path), path]));

  const readChecked = async (path: string): Promise<Uint8Array> => {
    const bytes = await files.read(path);
    const recorded = recordedSizes.get(path);
    if (recorded !== undefined && recorded !== null && recorded !== bytes.byteLength) {
      throw new Error(`${path} changed after the review. Choose the export again.`);
    }
    return bytes;
  };

  const readPage = async (outline: PlannedPageOutline, signal?: AbortSignal): Promise<PlannedPageImport> => {
    abortIfNeeded(signal);
    const indexed = pagesById.get(outline.sourceId);
    if (!indexed) throw new Error(`OneNote page ${outline.sourceId} is not part of the export.`);
    const { page } = indexed;
    let blocks: RichBlock[] = [];
    const issues: FidelityIssue[] = [];
    let title = indexed.title;
    let tags: string[] = [];
    let taskState: 'open' | 'done' | undefined;
    let background: PlannedPageImport['background'];
    let counts: PageContentCounts | undefined;
    let failed = false;
    if (page.error || !page.file || !files.has(page.file)) {
      failed = true;
      issues.push({
        code: 'unsupported-element',
        severity: 'unsupported',
        message: page.error
          ? `OneNote did not return this page: ${page.error}`
          : 'The exported page file is missing.',
        sourceElement: 'Page',
      });
    } else {
      let ink: OneNoteDesktopInkFile | undefined;
      if (page.ink && files.has(page.ink)) {
        ink = validateDesktopInkFile(JSON.parse(utf8.decode(await readChecked(page.ink))), page.ink);
      }
      const xmlText = utf8.decode(await readChecked(page.file));
      try {
        const converted = convertDesktopPageXml(parseXml(xmlText), {
          ink,
          asset: (path): DesktopAssetInfo | undefined => {
            const asset = assets.get(path);
            return asset && files.has(path)
              ? { resourceId: resourceIdForPath(path), mediaType: asset.mediaType, bytes: asset.bytes, width: asset.width, height: asset.height, originalName: asset.originalName }
              : undefined;
          },
          rejectResource: (path, kind) => {
            const asset = assets.get(path);
            return asset ? limitReason(asset, kind) : `${path} is missing from the export.`;
          },
        });
        blocks = converted.blocks;
        issues.push(...converted.issues);
        title = converted.title || title;
        tags = converted.tags;
        taskState = converted.taskState;
        background = converted.background;
        counts = converted.counts;
      } catch (cause) {
        failed = true;
        issues.push({
          code: 'malformed-html',
          severity: 'unsupported',
          message: `The page XML could not be read: ${cause instanceof Error ? cause.message : String(cause)}`,
          sourceElement: 'Page',
        });
      }
    }
    const created = validTimestamp(page.created);
    const modified = validTimestamp(page.modified) ?? created;
    return {
      sourceId: page.id,
      title,
      order: indexed.order,
      level: indexed.level,
      ...(created ? { createdDateTime: created } : {}),
      ...(modified ? { lastModifiedDateTime: modified } : {}),
      blocks,
      tags,
      ...(taskState ? { taskState } : {}),
      ...(background ? { background } : {}),
      fidelity: {
        pageId: page.id,
        status: pageStatus(blocks, issues, failed),
        issues,
        convertedBlockCount: blocks.length,
        ...(counts ? { contentCounts: counts } : {}),
      },
    };
  };

  const readResource = async (resourceId: string, signal?: AbortSignal): Promise<OneNoteImportResourceBody> => {
    abortIfNeeded(signal);
    const path = pathByResourceId.get(resourceId) ?? resourceId;
    const asset = assets.get(path);
    if (!asset) throw new Error(`The export references ${path}, which its manifest does not list.`);
    const bytes = await files.read(path);
    if (bytes.byteLength !== asset.bytes) throw new Error(`${path} does not have the size the manifest records.`);
    if (await sha256Hex(bytes) !== asset.sha256) throw new Error(`${path} failed its SHA-256 check.`);
    const fileName = asset.originalName ?? path.split('/').at(-1);
    return { bytes, mediaType: asset.mediaType, ...(fileName ? { fileName } : {}) };
  };

  return {
    source: 'desktop-export',
    manifest,
    outline: {
      kind: 'onenote-import-outline',
      version: 1,
      source: 'desktop-export',
      createdAt: options.createdAt,
      notebooks: [{ sourceId: manifest.notebook.id, displayName: manifest.notebook.name, sections }],
      sourceRevision,
      // Every file of the export; a partial selection references fewer.
      resources: { count: manifest.assets.length, bytes: summary.resourceBytes, exact: false },
      warnings,
    },
    reader: { readPage, readResource },
    pageTitles,
    summary,
  };
}

/** Files chosen with a directory picker carry `webkitRelativePath` (`<folder>/manifest.json`). */
export function desktopExportFilesFromFileList(fileList: Iterable<File>): DesktopExportFiles {
  const all = [...fileList].map((file) => ({ file, path: (file.webkitRelativePath || file.name).replace(/\\/g, '/') }));
  const manifest = all
    .filter((entry) => entry.path === 'manifest.json' || entry.path.endsWith('/manifest.json'))
    .sort((left, right) => left.path.split('/').length - right.path.split('/').length)[0];
  const root = manifest ? manifest.path.slice(0, manifest.path.length - 'manifest.json'.length) : '';
  const byPath = new Map<string, File>();
  for (const entry of all) {
    if (entry.path.startsWith(root)) byPath.set(entry.path.slice(root.length), entry.file);
  }
  return {
    has: (path) => byPath.has(path),
    size: (path) => byPath.get(path)?.size,
    read: async (path) => {
      const file = byPath.get(path);
      if (!file) throw new Error(`${path} is missing from the chosen folder.`);
      return new Uint8Array(await file.arrayBuffer());
    },
  };
}

/** A ZIP of the export folder may contain the folder itself or only its contents. */
export function desktopExportFilesFromEntries(entries: ReadonlyMap<string, Uint8Array>): DesktopExportFiles {
  const manifest = [...entries.keys()]
    .filter((path) => path === 'manifest.json' || path.endsWith('/manifest.json'))
    .sort((left, right) => left.split('/').length - right.split('/').length)[0];
  const root = manifest ? manifest.slice(0, manifest.length - 'manifest.json'.length) : '';
  const byPath = new Map<string, Uint8Array>();
  for (const [path, bytes] of entries) {
    if (path.startsWith(root)) byPath.set(path.slice(root.length), bytes);
  }
  return {
    has: (path) => byPath.has(path),
    size: (path) => byPath.get(path)?.byteLength,
    read: async (path) => {
      const bytes = byPath.get(path);
      if (!bytes) throw new Error(`${path} is missing from the ZIP archive.`);
      return bytes;
    },
  };
}

/** A ZIP of the export folder, read entry by entry on demand. */
export function desktopExportFilesFromZip(archive: ZipArchive): DesktopExportFiles {
  const names = archive.names();
  const manifest = names
    .filter((path) => path === 'manifest.json' || path.endsWith('/manifest.json'))
    .sort((left, right) => left.split('/').length - right.split('/').length)[0];
  const root = manifest ? manifest.slice(0, manifest.length - 'manifest.json'.length) : '';
  const known = new Set(names.filter((name) => name.startsWith(root)).map((name) => name.slice(root.length)));
  return {
    has: (path) => known.has(path),
    size: (path) => (known.has(path) ? archive.size(root + path) : undefined),
    read: async (path) => {
      if (!known.has(path)) throw new Error(`${path} is missing from the ZIP archive.`);
      return archive.read(root + path);
    },
  };
}
