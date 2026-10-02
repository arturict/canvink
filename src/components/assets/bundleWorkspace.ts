import * as Automerge from '@automerge/automerge';
import { translateNow } from '../../i18n/current';
import {
  getAutomergeSnapshot,
  loadAutomergeDocument,
  projectLiveRichText,
  saveAutomergeDocument,
  type CanvinkAutomergeDoc,
  type LiveNotebookDocV2,
  type LivePageDocV2,
  type PageAutomergeDoc,
} from '../../crdt';
import type { NotebookDoc, PageDoc, Sha256Checksum } from '../../domain/v2';
import { inkSegments } from '../../ink/segmentStore';
import { INK_SEGMENT_MIME_TYPE } from '../../storage/pageIndex';
import { sha256Canonical } from '../../domain/v2';
import type { NotebookDocV3, PageDocV3, PageElementV3 } from '../../domain/v3';
import { CanvinkBundleBlobWriter, openCanvinkBundle } from '../../io';
import type {
  ExtendActiveWorkspaceResult,
  V2RuntimeState,
  WorkspaceV2Runtime,
} from '../../storage/workspaceV2Runtime';

/**
 * Exports one notebook as a `.canvink` bundle, page by page: every page is
 * read (loaded only for the read if it is not open), saved, and handed to
 * Blob storage before the next one is read.
 */
export async function exportNotebookBundle(
  runtime: WorkspaceV2Runtime,
  state: V2RuntimeState,
  notebookId: string,
  options: { onProgress?: (done: number, total: number) => void } = {},
): Promise<Blob> {
  // Ink drawn a moment ago joins its pages first; the page summaries then list its segments.
  await runtime.sealAllPendingInk();
  const notebook = state.notebooks.find((candidate) => candidate.notebookId === notebookId);
  if (!notebook) throw new Error(translateNow('error.bundle.notebookMissing'));
  const current = runtime.getState();
  const summaries = current.schemaVersion === 1 ? state.pages : current.pages;
  const orderedPages = notebook.sections.flatMap((section) => section.pageDocumentIds.map((documentId) => {
    const page = summaries.find((candidate) => candidate.documentId === documentId);
    if (!page) throw new Error(translateNow('error.bundle.pageMissing', { id: documentId }));
    return page;
  }));
  const writer = new CanvinkBundleBlobWriter({
    schemaVersion: state.schemaVersion,
    createdAt: new Date().toISOString(),
    generator: state.schemaVersion === 3 ? 'canvink-v3' : 'canvink-v2',
  });
  await writer.setNotebook({
    id: notebook.documentId,
    bytes: saveAutomergeDocument(runtime.getNotebookHandle(notebookId).doc() as CanvinkAutomergeDoc),
  });
  // Pages are copied as their stored Automerge bytes: exporting does not
  // load (or re-encode) a page, so it costs I/O rather than Automerge work.
  // Asset references (MIME type, file name) come from the page summaries.
  const references = new Map<string, { mimeType: string; fileName?: string }>();
  for (const [index, page] of orderedPages.entries()) {
    await writer.addPage({ id: page.documentId, bytes: await runtime.readDocumentBytes(page.documentId) });
    for (const asset of page.assets) if (!references.has(asset.assetId)) references.set(asset.assetId, asset);
    options.onProgress?.(index + 1, orderedPages.length);
  }
  for (const [assetId, reference] of [...references.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const asset = await runtime.getAsset(assetId as Sha256Checksum);
    if (!asset) throw new Error(translateNow('error.bundle.assetMissing', { id: assetId }));
    await writer.addAsset({ bytes: asset.bytes, mimeType: reference.mimeType, originalName: reference.fileName });
  }
  return writer.finish();
}

function portablePage(
  source: LivePageDocV2,
  document: PageAutomergeDoc,
  ids: { notebookId: string; sectionId: string; pageId: string; parentPageId?: string },
  now: string,
): PageDoc | PageDocV3 {
  const elementsById: Record<string, PageElementV3> = {};
  for (const [elementId, element] of Object.entries(source.elementsById)) {
    if (element.kind === 'richText') {
      const { text: _text, ...metadata } = structuredClone(element);
      void _text;
      elementsById[elementId] = {
        ...metadata,
        content: projectLiveRichText(document, elementId),
      };
    } else elementsById[elementId] = structuredClone(element);
  }
  const portable = {
    ...structuredClone(source),
    documentId: `page:${ids.pageId}`,
    notebookId: ids.notebookId,
    sectionId: ids.sectionId,
    pageId: ids.pageId,
    ...(ids.parentPageId ? { parentPageId: ids.parentPageId } : {}),
    createdAt: now,
    updatedAt: now,
    elementsById,
    version: { protocol: 'uninitialized', heads: [] },
  };
  return source.schemaVersion === 3
    ? { ...portable, schemaVersion: 3 } as PageDocV3
    : { ...portable, schemaVersion: 2, elementsById: elementsById as PageDoc['elementsById'] } as PageDoc;
}

export interface ImportedBundleTarget {
  result: ExtendActiveWorkspaceResult;
  notebookId: string;
  sectionId: string;
  pageId: string;
}

/**
 * Adds the notebook of a bundle to the workspace as a new notebook. The
 * bundle is read entry by entry and each page is written as soon as it is
 * converted, so a large bundle never has all its pages in memory.
 */
export async function importNotebookBundleAdditively(
  runtime: WorkspaceV2Runtime,
  state: V2RuntimeState,
  source: Blob | Uint8Array,
  createId: (scope: string) => string,
): Promise<ImportedBundleTarget> {
  const bundle = await openCanvinkBundle(source instanceof Blob ? source : new Blob([source as BlobPart]));
  const notebookDocument = loadAutomergeDocument<LiveNotebookDocV2>((await bundle.readNotebook()).bytes, {
    expectedDocumentId: bundle.manifest.notebook.id,
    expectedKind: 'notebook',
  });
  const sourceNotebook = getAutomergeSnapshot<LiveNotebookDocV2>(notebookDocument);
  Automerge.free(notebookDocument);
  if (sourceNotebook.schemaVersion !== bundle.manifest.schemaVersion) {
    throw new Error(translateNow('error.bundle.schemaMismatch'));
  }
  const expectedPageIds = sourceNotebook.sections.flatMap((section) => section.pageDocumentIds);
  const bundlePageIds = bundle.manifest.pages.map((page) => page.id);
  if (
    expectedPageIds.length !== bundlePageIds.length
    || new Set(bundlePageIds).size !== bundlePageIds.length
    || expectedPageIds.some((documentId) => !bundlePageIds.includes(documentId))
  ) throw new Error(translateNow('error.bundle.indexMismatch'));

  const now = new Date().toISOString();
  const notebookId = createId('bundle-notebook');
  const sectionIdMap = new Map(sourceNotebook.sections.map((section) => [section.id, createId('bundle-section')]));
  // New page IDs are assigned per source document before any page is read.
  // A page document ID ends with `page:<pageId>` (migrated workspaces may
  // prefix it), which resolves parent page references to documents.
  const newPageIdByDocument = new Map(bundlePageIds.map((documentId) => [documentId, createId('bundle-page')]));
  const documentIdBySource = new Map(bundlePageIds.map((documentId) => [
    documentId,
    `page:${newPageIdByDocument.get(documentId) as string}`,
  ]));
  const newPageIdForSourcePage = (pageId: string): string | undefined => {
    const exact = newPageIdByDocument.get(`page:${pageId}`);
    if (exact) return exact;
    const matches = bundlePageIds.filter((documentId) => documentId.endsWith(`page:${pageId}`));
    return matches.length === 1 ? newPageIdByDocument.get(matches[0]) : undefined;
  };
  const notebookBase = {
    ...structuredClone(sourceNotebook),
    documentId: `notebook:${notebookId}`,
    notebookId,
    title: `${sourceNotebook.title} (Import)`,
    createdAt: now,
    updatedAt: now,
    sections: sourceNotebook.sections.map((section) => ({
      ...structuredClone(section),
      id: sectionIdMap.get(section.id) as string,
      createdAt: now,
      updatedAt: now,
      pageDocumentIds: section.pageDocumentIds.map((documentId) => {
        const mapped = documentIdBySource.get(documentId);
        if (!mapped) throw new Error(translateNow('error.bundle.pageUnmapped', { id: documentId }));
        return mapped;
      }),
    })),
    version: { protocol: 'uninitialized', heads: [] },
  };
  const notebook: NotebookDoc | NotebookDocV3 = sourceNotebook.schemaVersion === 3
    ? { ...notebookBase, schemaVersion: 3 } as NotebookDocV3
    : { ...notebookBase, schemaVersion: 2 } as NotebookDoc;
  const importId = createId('bundle-import');
  const writer = await runtime.beginAdditiveImport({
    importId,
    preparedAt: now,
    notebook,
    expectedActivationArtifactFingerprint: state.activation.artifactFingerprint,
  });
  let firstPageId: string | undefined;
  const firstDocumentId = notebook.sections[0]?.pageDocumentIds[0];
  try {
    for (const [index, descriptor] of bundle.manifest.assets.entries()) {
      const asset = await bundle.readAsset(index);
      const assetId = `sha256:${asset.sha256}` as Sha256Checksum;
      if (descriptor.id !== assetId) throw new Error(translateNow('error.bundle.assetNotCanonical', { id: descriptor.id }));
      if (descriptor.mimeType === INK_SEGMENT_MIME_TYPE) {
        // Ink segments belong to the segment store; the pages read below use them.
        if (!(await inkSegments().adopt(asset.sha256, asset.bytes))) {
          throw new Error(translateNow('error.bundle.inkSegmentCorrupt', { id: descriptor.id }));
        }
        continue;
      }
      await writer.addAssets([{ assetId, checksum: assetId, size: asset.bytes.byteLength, bytes: asset.bytes }]);
    }
    for (const [index] of bundle.manifest.pages.entries()) {
      const entry = await bundle.readPage(index);
      const document = loadAutomergeDocument<LivePageDocV2>(entry.bytes, {
        expectedDocumentId: entry.id,
        expectedKind: 'page',
        expectedSchemaVersion: sourceNotebook.schemaVersion,
      }) as PageAutomergeDoc;
      let page: PageDoc | PageDocV3;
      try {
        const source = getAutomergeSnapshot<LivePageDocV2>(document);
        const sectionId = sectionIdMap.get(source.sectionId);
        const pageId = newPageIdByDocument.get(entry.id);
        if (!sectionId || !pageId) throw new Error(translateNow('error.bundle.mappingIncomplete'));
        page = portablePage(source, document, {
          notebookId,
          sectionId,
          pageId,
          parentPageId: source.parentPageId ? newPageIdForSourcePage(source.parentPageId) : undefined,
        }, now);
      } finally {
        Automerge.free(document);
      }
      if (page.documentId === firstDocumentId) firstPageId = page.pageId;
      await writer.addPage(page);
    }
    const result = await writer.commit(await sha256Canonical(bundle.manifest));
    const firstSection = notebook.sections[0];
    if (!firstSection || !firstPageId) throw new Error(translateNow('error.bundle.noOpenablePage'));
    return { result, notebookId, sectionId: firstSection.id, pageId: firstPageId };
  } catch (error) {
    await writer.abort().catch(() => undefined);
    throw error;
  }
}
