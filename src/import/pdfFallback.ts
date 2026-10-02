import { MemoryAssetRepository, reopenAsset } from '../assets';
import { importOriginalPdf, materializePdfPreview, type PdfPreviewRenderer } from '../io/pdf';
import type { AcquiredGraphResource, OneNoteGraphPreviewResult } from './graph/types';
import { createOneNoteImportPreview } from './preview';
import type { GraphOneNoteImportInput, GraphResourceInput } from './types';

export interface LocalPdfFallbackFile {
  name: string;
  type: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('The PDF fallback operation was cancelled.', 'AbortError');
}

function removeUnusedFallbackResources(input: GraphOneNoteImportInput, pageId: string) {
  const removed = input.pdfFallbacks?.find((fallback) => fallback.pageId === pageId);
  const pdfFallbacks = (input.pdfFallbacks ?? []).filter((fallback) => fallback.pageId !== pageId);
  const retainedIds = new Set(pdfFallbacks.flatMap((fallback) => [fallback.resourceId, fallback.previewResourceId]));
  const resources = input.resources.filter((resource) => (
    !removed
    || ![removed.resourceId, removed.previewResourceId].includes(resource.id)
    || retainedIds.has(resource.id)
  ));
  return { pdfFallbacks, resources };
}

function upsertResource(resources: readonly GraphResourceInput[], resource: GraphResourceInput): GraphResourceInput[] {
  const existing = resources.find((candidate) => candidate.id === resource.id);
  if (existing) {
    if (existing.sha256 !== resource.sha256 || existing.mediaType !== resource.mediaType) {
      throw new Error('A local PDF fallback resource identifier collided with different bytes.');
    }
    return [...resources];
  }
  return [...resources, resource];
}

function upsertBody(resources: readonly AcquiredGraphResource[], resource: AcquiredGraphResource): AcquiredGraphResource[] {
  const existing = resources.find((candidate) => candidate.id === resource.id);
  if (existing) {
    if (existing.sha256 !== resource.sha256 || existing.mediaType !== resource.mediaType) {
      throw new Error('A local PDF fallback body identifier collided with different bytes.');
    }
    return [...resources];
  }
  return [...resources, resource];
}

export function removeLocalPdfFallback(
  acquisition: OneNoteGraphPreviewResult,
  pageId: string,
): OneNoteGraphPreviewResult {
  const cleaned = removeUnusedFallbackResources(acquisition.input, pageId);
  const keptIds = new Set(cleaned.resources.map((resource) => resource.id));
  const input: GraphOneNoteImportInput = {
    ...structuredClone(acquisition.input),
    resources: cleaned.resources,
    pdfFallbacks: cleaned.pdfFallbacks,
  };
  const resourceBodies = acquisition.resourceBodies.filter((resource) => keptIds.has(resource.id));
  return {
    ...acquisition,
    input,
    resourceBodies,
    preview: createOneNoteImportPreview(input, { createdAt: acquisition.preview.createdAt }),
  };
}

export async function addLocalPdfFallback(
  acquisition: OneNoteGraphPreviewResult,
  pageId: string,
  file: LocalPdfFallbackFile,
  renderer: PdfPreviewRenderer,
  options: { signal?: AbortSignal; createdAt?: string } = {},
): Promise<OneNoteGraphPreviewResult> {
  abortIfNeeded(options.signal);
  if (file.type && file.type.toLowerCase() !== 'application/pdf') {
    throw new Error('The selected fallback must be a PDF file.');
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  abortIfNeeded(options.signal);
  const repository = new MemoryAssetRepository();
  const createdAt = options.createdAt ?? acquisition.preview.createdAt;
  const plan = await importOriginalPdf(repository, { bytes, fileName: file.name }, (scope) => scope, 0, () => createdAt);
  if (plan.inspection.pageCount !== 1 || plan.pages.length !== 1 || plan.pages[0].kind !== 'pdf-page') {
    throw new Error('Choose a one-page PDF exported for this source page.');
  }
  const rendered = await materializePdfPreview(repository, renderer, plan.pages[0])
    .finally(() => renderer.release?.());
  abortIfNeeded(options.signal);
  const previewBytes = await reopenAsset(repository, rendered.previewAsset);
  const pdfSha = plan.originalAsset.checksum.replace(/^sha256:/u, '');
  const previewSha = rendered.previewAsset.checksum.replace(/^sha256:/u, '');
  const pdfId = `local-pdf:${pdfSha}`;
  const previewId = `local-preview:${previewSha}`;
  const pdfMetadata: GraphResourceInput = {
    id: pdfId,
    contentUrl: `local-onenote-fallback:${pdfId}`,
    mediaType: 'application/pdf',
    fileName: plan.originalAsset.fileName,
    byteLength: bytes.byteLength,
    sha256: pdfSha,
  };
  const previewMetadata: GraphResourceInput = {
    id: previewId,
    contentUrl: `local-onenote-fallback:${previewId}`,
    mediaType: rendered.previewAsset.mimeType,
    fileName: rendered.previewAsset.fileName,
    byteLength: previewBytes.byteLength,
    sha256: previewSha,
  };
  const cleaned = removeUnusedFallbackResources(acquisition.input, pageId);
  const input: GraphOneNoteImportInput = {
    ...structuredClone(acquisition.input),
    resources: upsertResource(upsertResource(cleaned.resources, pdfMetadata), previewMetadata),
    pdfFallbacks: [...cleaned.pdfFallbacks, {
      pageId,
      resourceId: pdfId,
      previewResourceId: previewId,
      width: Math.max(1, Math.round(rendered.page.element.frame.width)),
      height: Math.max(1, Math.round(rendered.page.element.frame.height)),
    }],
  };
  const keptIds = new Set(cleaned.resources.map((resource) => resource.id));
  let resourceBodies = acquisition.resourceBodies.filter((resource) => keptIds.has(resource.id));
  resourceBodies = upsertBody(resourceBodies, {
    id: pdfId,
    bytes,
    mediaType: 'application/pdf',
    fileName: plan.originalAsset.fileName,
    sha256: pdfSha,
  });
  resourceBodies = upsertBody(resourceBodies, {
    id: previewId,
    bytes: previewBytes,
    mediaType: rendered.previewAsset.mimeType,
    fileName: rendered.previewAsset.fileName,
    sha256: previewSha,
  });
  return {
    ...acquisition,
    input,
    resourceBodies,
    preview: createOneNoteImportPreview(input, { createdAt }),
  };
}
