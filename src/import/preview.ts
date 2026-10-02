import { convertOneNoteHtml, type OneNoteHtmlConversionOptions } from './onenoteHtml';
import {
  MAX_IMPORT_SECTION_GROUP_DEPTH,
  ONENOTE_IMPORT_PREVIEW_VERSION,
  type FidelityIssue,
  type FidelityStatus,
  type GraphOneNoteImportInput,
  type GraphPageInput,
  type GraphPdfFallbackInput,
  type GraphResourceInput,
  type OneNoteImportPreviewPlan,
  type PageFidelityReport,
  type PlannedPageImport,
  type RichBlock,
} from './types';

export interface OneNoteImportPreviewOptions extends OneNoteHtmlConversionOptions {
  /** Supplied by the caller to keep preview generation deterministic and testable. */
  createdAt: string;
}

export class OneNoteImportInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OneNoteImportInputError';
  }
}

function assertNonEmpty(value: string, label: string): void {
  if (!value.trim()) throw new OneNoteImportInputError(`${label} must not be empty.`);
}

function assertUnique(id: string, label: string, seen: Set<string>): void {
  assertNonEmpty(id, `${label} id`);
  if (seen.has(id)) throw new OneNoteImportInputError(`Duplicate ${label} id: ${id}`);
  seen.add(id);
}

function validateInput(input: GraphOneNoteImportInput, options: OneNoteImportPreviewOptions): void {
  if (!Number.isFinite(Date.parse(options.createdAt))) {
    throw new OneNoteImportInputError('createdAt must be an ISO-compatible date string.');
  }
  const notebookIds = new Set<string>();
  const sectionIds = new Set<string>();
  const pageIds = new Set<string>();
  const resourceIds = new Set<string>();
  const resourceUrls = new Set<string>();
  for (const resource of input.resources) {
    assertUnique(resource.id, 'resource', resourceIds);
    assertNonEmpty(resource.contentUrl, `Resource ${resource.id} contentUrl`);
    assertNonEmpty(resource.mediaType, `Resource ${resource.id} mediaType`);
    if (resourceUrls.has(resource.contentUrl.trim())) {
      throw new OneNoteImportInputError(`Duplicate resource contentUrl: ${resource.contentUrl}`);
    }
    resourceUrls.add(resource.contentUrl.trim());
    if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(resource.mediaType)) {
      throw new OneNoteImportInputError(`Resource ${resource.id} mediaType is invalid.`);
    }
    if (!Number.isSafeInteger(resource.byteLength) || resource.byteLength < 0) {
      throw new OneNoteImportInputError(`Resource ${resource.id} byteLength must be a non-negative safe integer.`);
    }
    if (resource.sha256 !== undefined && !/^[a-f0-9]{64}$/i.test(resource.sha256)) {
      throw new OneNoteImportInputError(`Resource ${resource.id} sha256 must contain 64 hexadecimal characters.`);
    }
  }
  for (const notebook of input.notebooks) {
    assertUnique(notebook.id, 'notebook', notebookIds);
    assertNonEmpty(notebook.displayName, `Notebook ${notebook.id} displayName`);
    for (const section of notebook.sections) {
      assertUnique(section.id, 'section', sectionIds);
      assertNonEmpty(section.displayName, `Section ${section.id} displayName`);
      if (section.groupPath !== undefined) {
        if (!Array.isArray(section.groupPath) || section.groupPath.length > MAX_IMPORT_SECTION_GROUP_DEPTH) {
          throw new OneNoteImportInputError(`Section ${section.id} groupPath is invalid or nested too deeply.`);
        }
        section.groupPath.forEach((name, index) => {
          if (typeof name !== 'string') throw new OneNoteImportInputError(`Section ${section.id} group ${index} name is invalid.`);
          assertNonEmpty(name, `Section ${section.id} group ${index} name`);
        });
      }
      if (!Number.isSafeInteger(section.order)) throw new OneNoteImportInputError(`Section ${section.id} order must be an integer.`);
      for (const page of section.pages) {
        assertUnique(page.id, 'page', pageIds);
        assertNonEmpty(page.title, `Page ${page.id} title`);
        if (!Number.isSafeInteger(page.order)) throw new OneNoteImportInputError(`Page ${page.id} order must be an integer.`);
        if (page.level !== undefined && (!Number.isSafeInteger(page.level) || page.level < 0)) {
          throw new OneNoteImportInputError(`Page ${page.id} level must be a non-negative integer.`);
        }
      }
    }
  }
  const fallbackPages = new Set<string>();
  for (const fallback of input.pdfFallbacks ?? []) {
    if (!pageIds.has(fallback.pageId)) throw new OneNoteImportInputError(`PDF fallback references unknown page: ${fallback.pageId}`);
    if (fallbackPages.has(fallback.pageId)) throw new OneNoteImportInputError(`Duplicate PDF fallback for page: ${fallback.pageId}`);
    if (!Number.isSafeInteger(fallback.width) || fallback.width < 1 || fallback.width > 100_000
      || !Number.isSafeInteger(fallback.height) || fallback.height < 1 || fallback.height > 100_000) {
      throw new OneNoteImportInputError(`PDF fallback for page ${fallback.pageId} has invalid dimensions.`);
    }
    fallbackPages.add(fallback.pageId);
  }
}

function stableOrder<T extends { order: number }>(items: readonly T[]): T[] {
  return items.map((item, index) => ({ item, index }))
    .sort((left, right) => left.item.order - right.item.order || left.index - right.index)
    .map(({ item }) => item);
}

function safeResourceFileName(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const sanitized = Array.from(value)
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f || '<>:"/\\|?*'.includes(character) ? '_' : character;
    })
    .join('')
    .replace(/^\.+$/, '_')
    .slice(0, 255);
  return sanitized || 'resource';
}

function collectResourceIds(blocks: readonly RichBlock[], target: Set<string>): void {
  for (const block of blocks) {
    if (block.type === 'image' || block.type === 'attachment') target.add(block.resourceId);
    else if (block.type === 'pdfPage') {
      target.add(block.previewResourceId);
      if (block.originalResourceId) target.add(block.originalResourceId);
    } else if (block.type === 'spatialGroup' || block.type === 'textFrame') collectResourceIds(block.blocks, target);
    else if (block.type === 'list') {
      for (const item of block.items) collectResourceIds(item.blocks, target);
    } else if (block.type === 'table') {
      for (const row of block.rows) for (const cell of row) collectResourceIds(cell.blocks, target);
    }
  }
}

function pageStatus(
  blocks: readonly RichBlock[],
  issues: readonly FidelityIssue[],
  hadSourceContent: boolean,
  pdfFallbackResourceId: string | undefined,
): FidelityStatus {
  if (pdfFallbackResourceId) return 'visual';
  if (blocks.length === 0 && (hadSourceContent || issues.some((issue) => issue.severity === 'unsupported'))) return 'unsupported';
  if (issues.length > 0) return 'simplified';
  return 'complete';
}

function planPage(
  page: GraphPageInput,
  resources: readonly GraphResourceInput[],
  resourceById: ReadonlyMap<string, GraphResourceInput>,
  fallbackInput: GraphPdfFallbackInput | undefined,
  options: OneNoteImportPreviewOptions,
  referencedResources: Set<string>,
): PlannedPageImport {
  const converted = convertOneNoteHtml(page.html, resources, options);
  const issues = [...converted.issues];
  let validFallbackId: string | undefined;
  let validFallbackPreviewId: string | undefined;
  if (fallbackInput) {
    const fallback = resourceById.get(fallbackInput.resourceId);
    const fallbackPreview = resourceById.get(fallbackInput.previewResourceId);
    if (
      fallback?.mediaType.toLowerCase() === 'application/pdf'
      && ['image/png', 'image/jpeg'].includes(fallbackPreview?.mediaType.toLowerCase() ?? '')
    ) {
      validFallbackId = fallback.id;
      validFallbackPreviewId = fallbackPreview!.id;
      referencedResources.add(fallback.id);
      referencedResources.add(fallbackPreview!.id);
    } else {
      issues.push({
        code: 'pdf-fallback-invalid',
        severity: 'unsupported',
        message: `PDF fallback ${fallbackInput.resourceId} or its rendered preview is missing or invalid.`,
      });
    }
  }
  collectResourceIds(converted.blocks, referencedResources);
  const fidelity: PageFidelityReport = {
    pageId: page.id,
    status: pageStatus(converted.blocks, issues, converted.hadSourceContent, validFallbackId),
    issues,
    convertedBlockCount: converted.blocks.length,
    pdfFallbackResourceId: validFallbackId,
    ...(validFallbackPreviewId ? {
      pdfFallbackPreviewResourceId: validFallbackPreviewId,
      pdfFallbackWidth: fallbackInput!.width,
      pdfFallbackHeight: fallbackInput!.height,
    } : {}),
  };
  return {
    sourceId: page.id,
    title: page.title,
    order: page.order,
    level: page.level ?? 0,
    createdDateTime: page.createdDateTime,
    lastModifiedDateTime: page.lastModifiedDateTime,
    blocks: converted.blocks,
    tags: converted.tags,
    ...(converted.taskState ? { taskState: converted.taskState } : {}),
    fidelity,
  };
}

/**
 * Creates an inert, serializable proposal. This function has no workspace,
 * persistence, authentication, or network dependency and cannot apply itself.
 */
export function createOneNoteImportPreview(
  input: GraphOneNoteImportInput,
  options: OneNoteImportPreviewOptions,
): OneNoteImportPreviewPlan {
  validateInput(input, options);
  const resourceById = new Map(input.resources.map((resource) => [resource.id, resource]));
  const fallbackByPage = new Map((input.pdfFallbacks ?? []).map((fallback) => [fallback.pageId, fallback]));
  const referencedResources = new Set<string>();
  const pageReports: PageFidelityReport[] = [];
  const notebooks = input.notebooks.map((notebook) => ({
    sourceId: notebook.id,
    displayName: notebook.displayName,
    sections: stableOrder(notebook.sections).map((section) => ({
      sourceId: section.id,
      displayName: section.displayName,
      ...(section.groupPath?.length ? { groupPath: [...section.groupPath] } : {}),
      order: section.order,
      pages: stableOrder(section.pages).map((page) => {
        const planned = planPage(
          page,
          input.resources,
          resourceById,
          fallbackByPage.get(page.id),
          options,
          referencedResources,
        );
        pageReports.push(planned.fidelity);
        return planned;
      }),
    })),
  }));
  const summary: Record<FidelityStatus, number> = { complete: 0, visual: 0, simplified: 0, unsupported: 0 };
  for (const report of pageReports) summary[report.status] += 1;

  return {
    kind: 'onenote-import-preview',
    version: ONENOTE_IMPORT_PREVIEW_VERSION,
    createdAt: options.createdAt,
    notebooks,
    resources: input.resources
      .filter((resource) => referencedResources.has(resource.id))
      .map((resource) => ({
        sourceId: resource.id,
        mediaType: resource.mediaType,
        fileName: safeResourceFileName(resource.fileName),
        byteLength: resource.byteLength,
        sha256: resource.sha256,
      })),
    pageReports,
    summary,
  };
}
