import { storeOriginalAsset } from '../../assets/repository';
import type { AssetRepository } from '../../assets/types';
import {
  sha256Canonical,
  type AssetBlob,
  type AssetRef,
  type ElementFrame,
  type NotebookDoc,
  type NotebookSectionGroupRef,
  type PageDoc,
  type PageElementV2,
  type RichTextBlock as V2RichTextBlock,
  type RichTextMark as V2RichTextMark,
  type RichTextSpan as V2RichTextSpan,
  type Sha256Checksum,
} from '../../domain/v2';
import {
  DEFAULT_MATH_PAGE_SETTINGS,
  type NotebookDocV3,
  type PageDocV3,
} from '../../domain/v3';
import { normalizePageTags } from '../../domain/pageTags';
import { ruleSettingsForColor } from '../../editor/paper';
import { MAX_IMPORT_SECTION_GROUP_DEPTH } from '../types';
import type {
  ImportedInkStroke,
  ImportedTextStyle,
  PageFidelityReport,
  PlannedPageImport,
  RichBlock,
  RichTextSpan,
  SpatialPosition,
} from '../types';
import type {
  ApplyOneNoteImportOptions,
  OneNoteApplyCommitResult,
  OneNoteApplyProgress,
  OneNoteApplyTarget,
  OneNoteImportApplicationResult,
  OneNoteImportOutline,
  OneNoteImportPageSource,
  PlannedNotebookOutline,
  StagedOneNoteImportApplication,
  StagedOneNoteImportPage,
} from './types';

const EMPTY_VERSION = { protocol: 'uninitialized' as const, heads: [] as string[] };
const MAX_TEXT = 1_000_000;
const MAX_IDENTIFIER = 1_024;
const MAX_ELEMENTS_PER_PAGE = 20_000;

interface BuildContext {
  createdAt: string;
  refs: Map<string, AssetRef>;
  sequence: number;
}

function report(
  callback: ApplyOneNoteImportOptions['onProgress'],
  progress: OneNoteApplyProgress,
): void {
  callback?.(progress);
}

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('The OneNote import was cancelled.', 'AbortError');
}

function assertText(value: string, label: string, maximum = MAX_TEXT): void {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum) {
    throw new Error(`${label} is empty or exceeds its supported limit.`);
  }
}

function assertIdentifier(value: string, label: string): void {
  assertText(value, label, MAX_IDENTIFIER);
  if (/[/\\\0\r\n]/u.test(value)) throw new Error(`${label} contains unsafe characters.`);
}

function assertTimestamp(value: string, label: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`${label} is not a valid timestamp.`);
}

/**
 * Largest imported coordinate. OneNote pages grow with their content; a real
 * notebook page holding a whole textbook printout is about 360,000 px tall.
 * The workspace schema itself accepts up to 10,000,000.
 */
const MAX_IMPORTED_COORDINATE = 2_000_000;

function frame(position: SpatialPosition | undefined, fallbackY: number): ElementFrame {
  const number = (value: number | undefined, fallback: number, maximum: number): number => {
    if (value === undefined) return fallback;
    if (!Number.isFinite(value) || value < 0 || value > maximum) {
      throw new Error('An imported spatial coordinate is outside the supported canvas.');
    }
    return value;
  };
  return {
    x: number(position?.x, 48, MAX_IMPORTED_COORDINATE),
    y: number(position?.y, fallbackY, MAX_IMPORTED_COORDINATE),
    width: number(position?.width, 720, MAX_IMPORTED_COORDINATE),
    height: number(position?.height, 96, MAX_IMPORTED_COORDINATE),
    rotation: 0,
  };
}

function marks(spans: readonly RichTextSpan[]): V2RichTextSpan[] {
  return spans.map((span) => {
    if (typeof span.text !== 'string' || span.text.length > MAX_TEXT) {
      throw new Error('Imported rich text exceeds its supported limit.');
    }
    const converted: V2RichTextMark[] = span.marks.map((mark) => {
      if (mark.type === 'strikethrough') return { type: 'strike' };
      if (mark.type === 'code') return { type: 'inlineCode' };
      if (mark.type === 'link') {
        let url: URL;
        try {
          url = new URL(mark.href);
        } catch {
          throw new Error('An imported link is malformed.');
        }
        if (url.protocol !== 'https:' && url.protocol !== 'http:') {
          throw new Error('An imported link uses an unsafe protocol.');
        }
        return { type: 'link', href: url.href };
      }
      return { type: mark.type };
    });
    return { text: span.text, marks: converted };
  });
}

function flattenText(blocks: readonly RichBlock[]): V2RichTextSpan[] {
  const output: V2RichTextSpan[] = [];
  for (const block of blocks) {
    if ('content' in block && Array.isArray(block.content)) output.push(...marks(block.content));
    else if (block.type === 'list') {
      for (const item of block.items) output.push(...flattenText(item.blocks));
    } else if (block.type === 'spatialGroup') output.push(...flattenText(block.blocks));
  }
  return output.length > 0 ? output : [{ text: '', marks: [] }];
}

function richBlocks(block: RichBlock, elementId: string): V2RichTextBlock[] {
  if (block.type === 'paragraph' || block.type === 'blockquote' || block.type === 'code') {
    return [{ id: `${elementId}:block:0`, type: 'paragraph', spans: marks(block.content) }];
  }
  if (block.type === 'heading') {
    return [{ id: `${elementId}:block:0`, type: 'heading', level: block.level, spans: marks(block.content) }];
  }
  if (block.type === 'checklist') {
    return block.items.map((item, index) => ({
      id: `${elementId}:block:${index}`,
      type: 'checkItem',
      checked: item.checked,
      spans: marks(item.content),
    }));
  }
  if (block.type === 'list') {
    return block.items.map((item, index) => ({
      id: `${elementId}:block:${index}`,
      type: 'paragraph',
      list: block.ordered ? 'ordered' : 'bullet',
      spans: flattenText(item.blocks),
    }));
  }
  if (block.type === 'table') {
    return [{
      id: `${elementId}:block:0`,
      type: 'table',
      rows: block.rows.map((row) => row.map((cell) => flattenText(cell.blocks))),
    }];
  }
  throw new Error(`Block ${block.type} is not rich text.`);
}

const DEFAULT_TEXT_STYLE: RichTextElementStyle = {
  color: '#111827',
  fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
  fontSize: 16,
  textAlign: 'left',
};

type RichTextElementStyle = Extract<PageElementV2, { kind: 'richText' }>['style'];

function textStyle(style: ImportedTextStyle | undefined): RichTextElementStyle {
  const fontSize = style?.fontSize !== undefined && Number.isFinite(style.fontSize)
    ? Math.min(144, Math.max(6, style.fontSize))
    : DEFAULT_TEXT_STYLE.fontSize;
  return {
    color: style?.color && /^#[0-9a-f]{6}$/iu.test(style.color) ? style.color : DEFAULT_TEXT_STYLE.color,
    fontFamily: style?.fontFamily?.trim() ? style.fontFamily.slice(0, 256) : DEFAULT_TEXT_STYLE.fontFamily,
    fontSize,
    textAlign: 'left',
  };
}

/**
 * The one place that decides how an imported page background (a OneNote
 * printout page or a picture set as background) is pinned. The current
 * element schema only has `locked`, which keeps it from being moved or
 * selected while writing over it. When elements gain a dedicated background
 * flag, switch it here.
 */
export function importedBackgroundElementFields(background: boolean): { locked: boolean } {
  return { locked: background };
}

function strokeElement(
  id: string,
  createdAt: string,
  stroke: ImportedInkStroke,
): Extract<PageElementV2, { kind: 'stroke' }> {
  if (stroke.points.length === 0 || stroke.points.length > 100_000) {
    throw new Error('An imported ink stroke has no points or too many points.');
  }
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  const points = stroke.points.map((point) => {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.pressure)) {
      throw new Error('An imported ink point is not a finite number.');
    }
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
    return {
      x: point.x,
      y: point.y,
      // Ink without recorded pressure keeps an even width, as OneNote draws
      // it. Canvink would otherwise simulate pressure from drawing speed,
      // which import timestamps do not have, and turn straight lines into wedges.
      pressure: stroke.hasPressure ? Math.min(1, Math.max(0, point.pressure)) : 0.5,
      tiltX: 0,
      tiltY: 0,
      time: 0,
      pointerType: 'pen',
    };
  });
  if (!/^#[0-9a-f]{6}$/iu.test(stroke.color)) throw new Error('An imported ink colour is invalid.');
  return {
    id,
    kind: 'stroke',
    frame: frame({ x: minX, y: minY, width: maxX - minX, height: maxY - minY }, 0),
    createdAt,
    updatedAt: createdAt,
    locked: false,
    tool: stroke.tool,
    points,
    color: stroke.color,
    size: Math.min(200, Math.max(0.25, stroke.size)),
    opacity: Math.min(1, Math.max(0.05, stroke.opacity)),
  };
}

function assetRef(context: BuildContext, resourceId: string, role: AssetRef['role'] = 'original'): AssetRef {
  const original = context.refs.get(resourceId);
  if (!original) throw new Error(`Imported resource ${resourceId} is missing.`);
  return { ...original, role };
}

function addElement(
  elements: Record<string, PageElementV2>,
  zOrder: string[],
  context: BuildContext,
  block: RichBlock,
): void {
  if (block.type === 'spatialGroup') {
    for (const child of block.blocks) addElement(elements, zOrder, context, child);
    return;
  }
  const createdAt = context.createdAt;
  if (block.type === 'ink') {
    if (zOrder.length + block.strokes.length > MAX_ELEMENTS_PER_PAGE) {
      throw new Error('An imported page has too many elements.');
    }
    for (const stroke of block.strokes) {
      const id = `onenote-element-${context.sequence++}`;
      elements[id] = strokeElement(id, createdAt, stroke);
      zOrder.push(id);
    }
    return;
  }
  if (zOrder.length >= MAX_ELEMENTS_PER_PAGE) throw new Error('An imported page has too many elements.');
  const id = `onenote-element-${context.sequence++}`;
  const base = {
    id,
    frame: frame(block.position, 48 + zOrder.length * 112),
    createdAt,
    updatedAt: createdAt,
    locked: false,
  };
  let element: PageElementV2;
  if (block.type === 'image') {
    element = {
      ...base,
      ...importedBackgroundElementFields(block.background === true),
      kind: 'image',
      asset: assetRef(context, block.resourceId),
      alt: block.alt,
    };
  } else if (block.type === 'pdfPage') {
    if (!Number.isInteger(block.pageNumber) || !Number.isInteger(block.pageCount)
      || block.pageNumber < 1 || block.pageNumber > block.pageCount) {
      throw new Error('An imported printout page number is invalid.');
    }
    element = {
      ...base,
      ...importedBackgroundElementFields(block.background),
      kind: 'pdf',
      ...(block.originalResourceId ? { originalAsset: assetRef(context, block.originalResourceId) } : {}),
      previewAsset: assetRef(context, block.previewResourceId, 'preview'),
      pageCount: block.pageCount,
      sourcePageNumber: block.pageNumber,
      sourceAvailability: block.originalResourceId ? 'original' : 'preview-only',
    };
  } else if (block.type === 'textFrame') {
    const blocks = block.blocks.flatMap((child, index) => richBlocks(child, `${id}:${index}`));
    element = {
      ...base,
      kind: 'richText',
      content: { type: 'doc', blocks: blocks.length > 0 ? blocks : [{ id: `${id}:block:0`, type: 'paragraph', spans: [] }] },
      style: textStyle(block.textStyle),
    };
  } else if (block.type === 'attachment') {
    element = {
      ...base,
      kind: 'attachment',
      asset: assetRef(context, block.resourceId),
      displayName: block.fileName,
    };
  } else {
    element = {
      ...base,
      kind: 'richText',
      content: { type: 'doc', blocks: richBlocks(block, id) },
      style: { ...DEFAULT_TEXT_STYLE },
    };
  }
  elements[id] = element;
  zOrder.push(id);
}


async function stableId(kind: string, ...parts: string[]): Promise<string> {
  const digest = await sha256Canonical({ namespace: 'canvink-onenote-import-id-v1', kind, parts });
  return `${kind}:onenote:${digest.slice('sha256:'.length, 'sha256:'.length + 32)}`;
}

const HEX_COLOR = /^#[0-9a-f]{6}$/iu;
const FIDELITY_STATUSES = new Set(['complete', 'visual', 'simplified', 'unsupported']);

function importedPageBackground(source: PlannedPageImport): PageDoc['background'] {
  const planned = source.background;
  if (!planned) return { type: 'plain', color: '#ffffff' };
  if (!['plain', 'lined', 'grid'].includes(planned.type) || !HEX_COLOR.test(planned.color)) {
    throw new Error('An imported page background is invalid.');
  }
  return {
    type: planned.type,
    color: planned.color.toLowerCase(),
    ...(planned.spacing !== undefined && Number.isFinite(planned.spacing)
      ? { spacing: Math.min(160, Math.max(8, planned.spacing)) }
      : {}),
    // OneNote's line colour is what it draws; Canvink draws its line colour
    // with a strength over the paper, so both are chosen to look the same.
    ...(planned.lineColor && HEX_COLOR.test(planned.lineColor)
      ? ruleSettingsForColor(planned.lineColor.toLowerCase(), planned.color.toLowerCase())
      : {}),
  };
}

function assertFidelity(report: PageFidelityReport, sourceId: string): void {
  if (report.pageId !== sourceId
    || !FIDELITY_STATUSES.has(report.status)
    || !Array.isArray(report.issues)) {
    throw new Error('A per-page OneNote fidelity report is malformed.');
  }
}

function buildPage(
  staged: StagedOneNoteImportPage,
  notebookId: string,
  source: PlannedPageImport,
  context: BuildContext,
): PageDocV3 {
  assertText(source.title, 'OneNote page title');
  const elementsById: Record<string, PageElementV2> = {};
  const zOrder: string[] = [];
  for (const block of source.blocks) addElement(elementsById, zOrder, context, block);
  if (source.fidelity.pdfFallbackResourceId) {
    if (!source.fidelity.pdfFallbackPreviewResourceId
      || !source.fidelity.pdfFallbackWidth
      || !source.fidelity.pdfFallbackHeight) {
      throw new Error('The OneNote PDF fallback is missing its validated rendered preview.');
    }
    const id = `onenote-element-${context.sequence++}`;
    const originalAsset = assetRef(context, source.fidelity.pdfFallbackResourceId);
    const previewAsset = assetRef(context, source.fidelity.pdfFallbackPreviewResourceId);
    elementsById[id] = {
      id,
      kind: 'pdf',
      frame: {
        x: 0,
        y: 0,
        width: source.fidelity.pdfFallbackWidth,
        height: source.fidelity.pdfFallbackHeight,
        rotation: 0,
      },
      createdAt: context.createdAt,
      updatedAt: context.createdAt,
      locked: true,
      originalAsset,
      previewAsset: { ...previewAsset, role: 'preview' },
      pageCount: 1,
      sourceAvailability: 'original',
    };
    zOrder.unshift(id);
  }
  const createdAt = source.createdDateTime ?? context.createdAt;
  const updatedAt = source.lastModifiedDateTime ?? createdAt;
  assertTimestamp(createdAt, 'OneNote page creation time');
  assertTimestamp(updatedAt, 'OneNote page modification time');
  const page = {
    documentId: staged.documentId,
    kind: 'page' as const,
    notebookId,
    sectionId: staged.sectionId,
    pageId: staged.pageId,
    ...(staged.parentPageId ? { parentPageId: staged.parentPageId } : {}),
    title: source.title,
    tags: normalizePageTags(source.tags ?? []),
    ...(source.taskState ? { taskState: source.taskState } : {}),
    pageType: (source.fidelity.pdfFallbackResourceId ? 'a4' : 'free') as PageDoc['pageType'],
    background: importedPageBackground(source),
    createdAt,
    updatedAt,
    elementsById,
    zOrder,
    version: { ...EMPTY_VERSION },
  };
  return {
    ...page,
    schemaVersion: 3,
    mathSettings: { ...DEFAULT_MATH_PAGE_SETTINGS },
  };
}

/**
 * Builds the notebook projection from the structure alone: stable IDs for the
 * notebook, section groups, sections and pages, and the page hierarchy. Page
 * content is not needed, so the review works for notebooks of any size.
 */
async function buildNotebookProjection(
  source: PlannedNotebookOutline,
  createdAt: string,
): Promise<{ notebook: NotebookDocV3; pages: StagedOneNoteImportPage[] }> {
  assertIdentifier(source.sourceId, 'OneNote notebook ID');
  assertText(source.displayName, 'OneNote notebook name');
  // The selected sections are part of the identity, so a large notebook can be
  // imported in parts (one Canvink notebook per selection) without collisions.
  const notebookId = await stableId(
    'notebook-id',
    source.sourceId,
    ...source.sections.map((section) => section.sourceId).sort(),
  );
  const documentId = `notebook:${notebookId}`;
  const pages: StagedOneNoteImportPage[] = [];
  const sections: NotebookDoc['sections'] = [];
  // OneNote identifies a group only by its name within its parent, so one
  // Canvink group stands for each distinct name path. Its id derives from that
  // path, which keeps re-imports stable; siblings keep the order in which the
  // (ordered) sections first reach them.
  const sectionGroups: NotebookSectionGroupRef[] = [];
  const groupIdByPath = new Map<string, string>();
  for (const section of [...source.sections].sort((a, b) => a.order - b.order)) {
    assertIdentifier(section.sourceId, 'OneNote section ID');
    assertText(section.displayName, 'OneNote section name');
    const sectionId = await stableId('section', source.sourceId, section.sourceId);
    const groupPath = section.groupPath ?? [];
    if (!Array.isArray(groupPath) || groupPath.length > MAX_IMPORT_SECTION_GROUP_DEPTH) {
      throw new Error('OneNote section group nesting is invalid or too deep.');
    }
    let groupId: string | undefined;
    for (let depth = 1; depth <= groupPath.length; depth += 1) {
      const prefix = groupPath.slice(0, depth);
      const title = prefix[depth - 1];
      assertText(title, 'OneNote section group name');
      const key = JSON.stringify(prefix);
      let id = groupIdByPath.get(key);
      if (!id) {
        id = await stableId('section-group', source.sourceId, ...prefix);
        groupIdByPath.set(key, id);
        sectionGroups.push({
          id,
          title,
          ...(groupId ? { parentGroupId: groupId } : {}),
          createdAt,
          updatedAt: createdAt,
        });
      }
      groupId = id;
    }
    const ordered = [...section.pages].sort((a, b) => a.order - b.order);
    const parents: string[] = [];
    const sectionPages: StagedOneNoteImportPage[] = [];
    for (const outline of ordered) {
      assertIdentifier(outline.sourceId, 'OneNote page ID');
      assertText(outline.title, 'OneNote page title');
      if (outline.fidelity) assertFidelity(outline.fidelity, outline.sourceId);
      if (!Number.isInteger(outline.level) || outline.level < 0 || outline.level > 32) {
        throw new Error('OneNote page hierarchy level is invalid.');
      }
      if (outline.level > parents.length) {
        throw new Error('OneNote page hierarchy skips a required parent level.');
      }
      const parentPageId = outline.level > 0 ? parents[outline.level - 1] : undefined;
      const pageId = await stableId('page-id', notebookId, sectionId, outline.sourceId);
      parents[outline.level] = pageId;
      parents.length = outline.level + 1;
      sectionPages.push({
        outline,
        sectionId,
        pageId,
        documentId: `page:${pageId}`,
        ...(parentPageId ? { parentPageId } : {}),
      });
    }
    pages.push(...sectionPages);
    sections.push({
      id: sectionId,
      title: section.displayName,
      ...(section.color && HEX_COLOR.test(section.color) ? { color: section.color.toLowerCase() } : {}),
      ...(groupId ? { groupId } : {}),
      createdAt,
      updatedAt: createdAt,
      pageDocumentIds: sectionPages.map((page) => page.documentId),
    });
  }
  const notebookBase = {
    documentId,
    kind: 'notebook' as const,
    notebookId,
    title: `${source.displayName} (OneNote import)`,
    color: '#7719aa',
    createdAt,
    updatedAt: createdAt,
    sections,
    // Omitted rather than empty, like documents written before groups existed.
    ...(sectionGroups.length > 0 ? { sectionGroups } : {}),
    settings: { defaultPageType: 'free' as const },
    version: { ...EMPTY_VERSION },
  };
  const notebook: NotebookDocV3 = { ...notebookBase, schemaVersion: 3 };
  if (new Set(sections.map((section) => section.id)).size !== sections.length
    || new Set(pages.map((page) => page.documentId)).size !== pages.length) {
    throw new Error('The OneNote source contains duplicate section or page identities.');
  }
  return { notebook, pages };
}

type ResourceKind = 'image' | 'pdf' | 'attachment';

/** The resources one page references, with the strictest kind each is used as. */
export function pageResourceKinds(page: PlannedPageImport): Map<string, ResourceKind> {
  const kinds = new Map<string, ResourceKind>();
  const visit = (block: RichBlock): void => {
    if (block.type === 'image') kinds.set(block.resourceId, 'image');
    else if (block.type === 'attachment' && !kinds.has(block.resourceId)) kinds.set(block.resourceId, 'attachment');
    else if (block.type === 'pdfPage') {
      kinds.set(block.previewResourceId, 'image');
      // A printout's original PDF may also appear as an attachment icon; it is stored as a PDF.
      if (block.originalResourceId) kinds.set(block.originalResourceId, 'pdf');
    } else if (block.type === 'spatialGroup' || block.type === 'textFrame') block.blocks.forEach(visit);
    else if (block.type === 'list') block.items.forEach((item) => item.blocks.forEach(visit));
    else if (block.type === 'table') block.rows.flat().forEach((cell) => cell.blocks.forEach(visit));
  };
  page.blocks.forEach(visit);
  if (page.fidelity.pdfFallbackResourceId) kinds.set(page.fidelity.pdfFallbackResourceId, 'pdf');
  if (page.fidelity.pdfFallbackPreviewResourceId) kinds.set(page.fidelity.pdfFallbackPreviewResourceId, 'image');
  return kinds;
}

/** Receives what `storeOriginalAsset` validated without keeping anything. */
class CollectingAssetRepository implements AssetRepository {
  collected: AssetBlob[] = [];

  async getAsset(): Promise<AssetBlob | undefined> {
    return undefined;
  }

  async putAsset(asset: AssetBlob): Promise<'stored' | 'deduplicated'> {
    this.collected.push(asset);
    return 'stored';
  }
}

async function reviewFingerprint(
  stage: Pick<StagedOneNoteImportApplication, 'notebook' | 'pages' | 'sourceRevision' | 'preparedAt'>,
): Promise<Sha256Checksum> {
  return sha256Canonical({
    namespace: 'canvink-onenote-import-review-v2',
    sourceRevision: stage.sourceRevision,
    preparedAt: stage.preparedAt,
    notebook: stage.notebook,
    pages: stage.pages.map((page) => ({
      sourceId: page.outline.sourceId,
      title: page.outline.title,
      level: page.outline.level,
      sectionId: page.sectionId,
      pageId: page.pageId,
      parentPageId: page.parentPageId,
    })),
  });
}

/**
 * The import artifact fingerprint, computed incrementally: the notebook
 * projection, the ordered per-page document hashes and the asset list. Equal
 * inputs give equal fingerprints, so a replayed import is recognised.
 */
function importArtifactFingerprint(
  notebook: NotebookDocV3,
  pageHashes: readonly Sha256Checksum[],
  assets: ReadonlyMap<Sha256Checksum, number>,
): Promise<Sha256Checksum> {
  return sha256Canonical({
    namespace: 'canvink-onenote-import-artifact-v2',
    notebook,
    pages: pageHashes,
    assets: [...assets.entries()].sort(([left], [right]) => left.localeCompare(right))
      .map(([assetId, size]) => ({ assetId, size })),
  });
}

export interface PrepareOneNoteImportApplicationInput {
  /** The reviewed selection: exactly one notebook. */
  outline: OneNoteImportOutline;
  source: OneNoteImportPageSource;
  target: OneNoteApplyTarget;
  /**
   * Time stamp of this preparation (defaults to the outline's creation time).
   * It is part of the reviewed artifact and so of the import ID: applying the
   * same stage again is recognised as a replay, while preparing again (for
   * example after a rollback) starts a new import.
   */
  preparedAt?: string;
  signal?: AbortSignal;
  onProgress?: (progress: OneNoteApplyProgress) => void;
}

/**
 * Prepares the review from the structure alone. No page is read here; apply
 * reads, converts and writes one page at a time.
 */
export async function prepareOneNoteImportApplication(
  input: PrepareOneNoteImportApplicationInput,
): Promise<StagedOneNoteImportApplication> {
  abortIfNeeded(input.signal);
  report(input.onProgress, { phase: 'validating', completed: 0, total: 1, message: 'Validating the additive OneNote import.' });
  if (input.outline.kind !== 'onenote-import-outline' || input.outline.version !== 1) {
    throw new Error('Unsupported OneNote import outline.');
  }
  if (input.outline.notebooks.length !== 1) {
    throw new Error('Apply exactly one reviewed OneNote notebook at a time.');
  }
  assertTimestamp(input.outline.createdAt, 'OneNote preview creation time');
  const preparedAt = input.preparedAt ?? input.outline.createdAt;
  assertTimestamp(preparedAt, 'OneNote import preparation time');
  assertText(input.outline.sourceRevision, 'OneNote source revision', MAX_IDENTIFIER);
  const snapshot = await input.target.inspect();
  report(input.onProgress, { phase: 'staging-documents', completed: 0, total: 1, message: 'Planning a separate imported notebook.' });
  const { notebook, pages } = await buildNotebookProjection(input.outline.notebooks[0], preparedAt);
  if (pages.length === 0) throw new Error('The selected OneNote sections contain no pages.');
  if (snapshot.notebookDocumentIds.includes(notebook.documentId)
    || pages.some((page) => snapshot.pageDocumentIds.includes(page.documentId))) {
    throw new Error('The reviewed import collides with an existing workspace document.');
  }
  const fingerprint = await reviewFingerprint({ notebook, pages, sourceRevision: input.outline.sourceRevision, preparedAt });
  const importId = `onenote-${fingerprint.slice('sha256:'.length, 'sha256:'.length + 32)}`;
  const fidelity = pages.flatMap((page) => (page.outline.fidelity ? [structuredClone(page.outline.fidelity)] : []));
  const warnings = [
    ...input.outline.warnings.map((warning) => (warning.pageId ? `${warning.pageId}: ${warning.message}` : warning.message)),
    ...fidelity.filter((page) => page.status !== 'complete').map((page) => `${page.pageId}: ${page.status}`),
  ];
  const stage: StagedOneNoteImportApplication = {
    kind: 'staged-onenote-import',
    version: 2,
    preparedAt,
    sourceRevision: input.outline.sourceRevision,
    review: {
      importId,
      approvalArtifactFingerprint: fingerprint,
      expectedActivationArtifactFingerprint: snapshot.activationArtifactFingerprint,
      notebookTitle: notebook.title,
      sectionCount: notebook.sections.length,
      pageCount: pages.length,
      resourceCount: input.outline.resources.count,
      resourceBytes: input.outline.resources.bytes,
      resourceTotalsExact: input.outline.resources.exact,
      fidelity,
      pageTitles: Object.fromEntries(pages.map((page) => [page.outline.sourceId, page.outline.title])),
      warnings,
    },
    notebook,
    pages,
    source: input.source,
  };
  report(input.onProgress, { phase: 'awaiting-review', completed: 1, total: 1, message: 'The additive import is planned and awaits explicit approval.' });
  return stage;
}

function countInk(page: PageDocV3): { strokes: number; points: number } {
  let strokes = 0;
  let points = 0;
  for (const element of Object.values(page.elementsById)) {
    if (element.kind !== 'stroke') continue;
    strokes += 1;
    points += element.points.length;
  }
  return { strokes, points };
}

/**
 * Reads, converts and writes the reviewed notebook one page at a time, so the
 * memory it needs is bounded by the largest page, not by the notebook. A
 * failure on any page aborts the writer; the workspace stays unchanged.
 */
export async function applyOneNoteImportApplication(
  target: OneNoteApplyTarget,
  stage: StagedOneNoteImportApplication,
  options: ApplyOneNoteImportOptions,
): Promise<OneNoteImportApplicationResult> {
  const now = options.now ?? (() => performance.now());
  const started = now();
  abortIfNeeded(options.signal);
  if (options.approvalArtifactFingerprint !== stage.review.approvalArtifactFingerprint) {
    throw new Error('Explicit approval does not match the reviewed OneNote artifact.');
  }
  if (await reviewFingerprint(stage) !== stage.review.approvalArtifactFingerprint) {
    throw new Error('The staged OneNote artifact changed after review.');
  }
  const timing = { readPagesMs: 0, readResourcesMs: 0, convertMs: 0, writeMs: 0, commitMs: 0, verifyMs: 0 };
  const stats = { pages: 0, elements: 0, strokes: 0, inkPoints: 0, assets: 0, assetBytes: 0, stagedBytes: 0 };
  const total = stage.pages.length;
  const progress = (phase: OneNoteApplyProgress['phase'], completed: number, message: string, stagedBytes?: number) => report(
    options.onProgress,
    { phase, completed, total, message, ...(stagedBytes === undefined ? {} : { stagedBytes }), elapsedMs: now() - started },
  );
  progress('writing-pages', 0, 'Writing the imported pages.', 0);
  const writer = await target.begin({
    importId: stage.review.importId,
    preparedAt: stage.preparedAt,
    notebook: structuredClone(stage.notebook),
  });
  const refs = new Map<string, AssetRef>();
  const validatedKinds = new Map<string, Set<ResourceKind>>();
  const assetSizes = new Map<Sha256Checksum, number>();
  const pageHashes: Sha256Checksum[] = [];
  const fidelity: PageFidelityReport[] = [];
  const pageTitles: Record<string, string> = {};
  const context: BuildContext = { createdAt: stage.preparedAt, refs, sequence: 0 };
  let committed: OneNoteApplyCommitResult;
  try {
    for (const [index, staged] of stage.pages.entries()) {
      abortIfNeeded(options.signal);
      let mark = now();
      const planned = await stage.source.readPage(staged.outline, options.signal);
      timing.readPagesMs += now() - mark;
      if (planned.sourceId !== staged.outline.sourceId) {
        throw new Error(`OneNote page ${staged.outline.sourceId} was read as another page.`);
      }
      assertFidelity(planned.fidelity, planned.sourceId);

      mark = now();
      const collector = new CollectingAssetRepository();
      for (const [resourceId, kind] of pageResourceKinds(planned)) {
        const kinds = validatedKinds.get(resourceId) ?? new Set<ResourceKind>();
        if (kinds.has(kind)) continue;
        abortIfNeeded(options.signal);
        const body = await stage.source.readResource(resourceId, options.signal);
        const stored = await storeOriginalAsset(collector, {
          bytes: body.bytes,
          mimeType: body.mediaType,
          fileName: body.fileName,
          kind,
        });
        kinds.add(kind);
        validatedKinds.set(resourceId, kinds);
        if (!refs.has(resourceId)) refs.set(resourceId, stored.ref);
      }
      const fresh = collector.collected.filter((asset) => !assetSizes.has(asset.assetId));
      timing.readResourcesMs += now() - mark;

      mark = now();
      const page = buildPage(staged, stage.notebook.notebookId, planned, context);
      pageHashes.push(await sha256Canonical(page));
      timing.convertMs += now() - mark;

      mark = now();
      if (fresh.length > 0) {
        await writer.addAssets(fresh);
        for (const asset of fresh) {
          assetSizes.set(asset.assetId, asset.size);
          stats.assets += 1;
          stats.assetBytes += asset.size;
        }
      }
      await writer.addPage(page);
      timing.writeMs += now() - mark;

      const ink = countInk(page);
      stats.pages += 1;
      stats.elements += page.zOrder.length;
      stats.strokes += ink.strokes;
      stats.inkPoints += ink.points;
      fidelity.push(structuredClone(planned.fidelity));
      pageTitles[planned.sourceId] = planned.title;
      progress('writing-pages', index + 1, 'Writing the imported pages.', writer.progress().stagedBytes);
    }
    abortIfNeeded(options.signal);
    const mark = now();
    progress('committing', total, 'Atomically adding the imported notebook.', writer.progress().stagedBytes);
    stats.stagedBytes = writer.progress().stagedBytes;
    committed = await writer.commit(await importArtifactFingerprint(stage.notebook, pageHashes, assetSizes));
    timing.commitMs = now() - mark;
  } catch (error) {
    await writer.abort().catch(() => undefined);
    throw error;
  }
  progress('verifying', total, 'Reopening and checking the committed workspace.');
  const verifyStarted = now();
  try {
    await target.verify(committed);
  } catch (verificationError) {
    progress('rolling-back', total, 'Verification failed; restoring the pre-import workspace.');
    try {
      await target.rollback(committed.importId);
    } catch (rollbackError) {
      throw new AggregateError(
        [verificationError, rollbackError],
        'The OneNote import failed verification and automatic rollback also failed.',
        { cause: rollbackError },
      );
    }
    progress('rolled-back', total, 'The failed import was rolled back.');
    throw new Error('The OneNote import failed verification and was rolled back.', { cause: verificationError });
  }
  timing.verifyMs = now() - verifyStarted;
  progress('completed', total, 'The imported notebook was added without replacing existing work.');
  return {
    ...committed,
    fidelity,
    pageTitles,
    timing: { totalMs: now() - started, ...timing },
    stats,
  };
}

export async function rollbackOneNoteImportApplication(
  target: OneNoteApplyTarget,
  result: Pick<OneNoteImportApplicationResult, 'importId'>,
  onProgress?: (progress: OneNoteApplyProgress) => void,
): Promise<'rolled-back' | 'already-rolled-back'> {
  report(onProgress, { phase: 'rolling-back', completed: 0, total: 1, message: 'Restoring the exact pre-import workspace.' });
  const status = await target.rollback(result.importId);
  report(onProgress, { phase: 'rolled-back', completed: 1, total: 1, message: 'The additive import was rolled back.' });
  return status;
}
