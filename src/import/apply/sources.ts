import { sha256Bytes, sha256Canonical } from '../../domain/v2';
import type { AcquiredGraphResource } from '../graph/types';
import type { OneNoteImportPreviewPlan } from '../types';
import { pageResourceKinds } from './application';
import type {
  OneNoteImportOutline,
  OneNoteImportPageSource,
  PlannedNotebookOutline,
} from './types';

export interface OneNoteImportSourceHandle {
  outline: OneNoteImportOutline;
  source: OneNoteImportPageSource;
}

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('The OneNote import was cancelled.', 'AbortError');
}

/**
 * Serves an already converted preview plan (the Graph path, which acquires
 * every page before the review) page by page, so it is applied through the
 * same bounded writer as a desktop export.
 */
export async function oneNoteImportFromPreview(
  preview: OneNoteImportPreviewPlan,
  resourceBodies: readonly AcquiredGraphResource[],
): Promise<OneNoteImportSourceHandle> {
  if (preview.kind !== 'onenote-import-preview' || preview.version !== 1) {
    throw new Error('Unsupported OneNote preview format.');
  }
  const pages = new Map(preview.notebooks.flatMap((notebook) => notebook.sections.flatMap(
    (section) => section.pages.map((page) => [page.sourceId, page] as const),
  )));
  const fidelity = [...pages.values()].map((page) => page.fidelity);
  if (preview.pageReports.length !== fidelity.length
    || preview.pageReports.some((report, index) => (
      report.pageId !== fidelity[index].pageId || report.status !== fidelity[index].status
    ))) {
    throw new Error('The OneNote preview summary does not match its page fidelity reports.');
  }
  const statusCounts = { complete: 0, visual: 0, simplified: 0, unsupported: 0 };
  fidelity.forEach((report) => { statusCounts[report.status] += 1; });
  if (Object.entries(statusCounts).some(([status, count]) => (
    preview.summary[status as keyof typeof statusCounts] !== count
  ))) throw new Error('The OneNote preview fidelity counts are inconsistent.');

  const metadata = new Map(preview.resources.map((resource) => [resource.sourceId, resource]));
  if (metadata.size !== preview.resources.length) throw new Error('OneNote preview contains duplicate resources.');
  const bodies = new Map<string, AcquiredGraphResource>();
  for (const body of resourceBodies) {
    if (bodies.has(body.id)) throw new Error('OneNote acquisition contains duplicate resource bodies.');
    bodies.set(body.id, body);
  }
  const referenced = new Set<string>();
  for (const page of pages.values()) {
    for (const resourceId of pageResourceKinds(page).keys()) referenced.add(resourceId);
  }
  let bytes = 0;
  for (const resourceId of referenced) {
    const meta = metadata.get(resourceId);
    // Checked again when the page is written; failing here keeps a broken
    // acquisition from reaching the approval step.
    if (!meta || !bodies.has(resourceId)) throw new Error(`Imported resource ${resourceId} is incomplete.`);
    bytes += meta.byteLength;
  }
  const notebooks: PlannedNotebookOutline[] = preview.notebooks.map((notebook) => ({
    sourceId: notebook.sourceId,
    displayName: notebook.displayName,
    sections: notebook.sections.map((section) => ({
      ...section,
      pages: section.pages.map((page) => ({
        sourceId: page.sourceId,
        title: page.title,
        order: page.order,
        level: page.level,
        fidelity: page.fidelity,
      })),
    })),
  }));
  const sourceRevision = await sha256Canonical({
    namespace: 'canvink-onenote-preview-source-v1',
    notebooks: preview.notebooks,
    resources: [...referenced].sort().map((resourceId) => metadata.get(resourceId)),
  });
  return {
    outline: {
      kind: 'onenote-import-outline',
      version: 1,
      source: 'graph',
      createdAt: preview.createdAt,
      notebooks,
      sourceRevision,
      resources: { count: referenced.size, bytes, exact: true },
      warnings: [],
    },
    source: {
      readPage: async (outline, signal) => {
        abortIfNeeded(signal);
        const page = pages.get(outline.sourceId);
        if (!page) throw new Error(`OneNote page ${outline.sourceId} is not part of the acquisition.`);
        return page;
      },
      readResource: async (resourceId, signal) => {
        abortIfNeeded(signal);
        const meta = metadata.get(resourceId);
        const body = bodies.get(resourceId);
        if (!meta || !body) throw new Error(`Imported resource ${resourceId} is incomplete.`);
        if (!(body.bytes instanceof Uint8Array) || body.bytes.byteLength !== meta.byteLength) {
          throw new Error(`Imported resource ${resourceId} byte length does not match its preview.`);
        }
        if (body.mediaType.toLowerCase() !== meta.mediaType.toLowerCase()) {
          throw new Error(`Imported resource ${resourceId} MIME type changed after preview.`);
        }
        const checksum = await sha256Bytes(body.bytes);
        const expected = meta.sha256 ? `sha256:${meta.sha256.replace(/^sha256:/u, '')}` : undefined;
        const acquired = `sha256:${body.sha256.replace(/^sha256:/u, '')}`;
        if ((expected && checksum !== expected) || checksum !== acquired) {
          throw new Error(`Imported resource ${resourceId} failed SHA-256 verification.`);
        }
        return { bytes: body.bytes, mediaType: meta.mediaType, ...(meta.fileName ? { fileName: meta.fileName } : {}) };
      },
    },
  };
}

/**
 * Narrows an outline to one notebook and the chosen sections. A partial
 * import is named after its sections, so several parts of one notebook stay
 * distinguishable.
 */
export function selectOneNoteImportOutline(
  outline: OneNoteImportOutline,
  notebookId: string,
  sectionIds: ReadonlySet<string>,
  errors: Readonly<{ notebookUnavailable: string; sectionRequired: string }>,
): OneNoteImportOutline {
  const source = outline.notebooks.find((notebook) => notebook.sourceId === notebookId);
  if (!source) throw new Error(errors.notebookUnavailable);
  const sections = source.sections.filter((section) => sectionIds.has(section.sourceId));
  if (sections.length === 0) throw new Error(errors.sectionRequired);
  const partial = sections.length < source.sections.length;
  const partName = sections.slice(0, 3).map((section) => section.displayName).join(', ')
    + (sections.length > 3 ? ', …' : '');
  const selectedPages = new Set(sections.flatMap((section) => section.pages.map((page) => page.sourceId)));
  return {
    ...outline,
    notebooks: [{
      ...source,
      displayName: partial ? `${source.displayName} – ${partName}` : source.displayName,
      sections,
    }],
    warnings: outline.warnings.filter((warning) => !warning.pageId || selectedPages.has(warning.pageId)),
  };
}
