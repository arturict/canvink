import { freeSpotBelow } from '../../editor/operations/placement';
import { getSharedAutomergeSnapshot, type LivePageDocV2 } from '../../crdt';
import { useEffect, useRef, useState, type ChangeEvent, type MutableRefObject } from 'react';
import { createPortal } from 'react-dom';
import { Archive, Camera, ChevronDown, FileCode2, FileDown, FilePlus2, FileText, FileType, FolderOpen, Image as ImageIcon, ImagePlus, Paperclip, Undo2, Upload, Wrench } from 'lucide-react';
import {
  ingestClipboardScreenshot,
  reopenAsset,
  storeOriginalAsset,
} from '../../assets';
import {
  sha256Bytes,
  type AssetBlob,
  type AttachmentElementV2,
  type ImageElementV2,
  type PdfElementV2,
} from '../../domain/v2';
import {
  mathPageSettings,
  type NotebookDocV3,
  type PageDocV3,
  type PageElementV3,
} from '../../domain/v3';
import { useI18n } from '../../i18n';
import { useConfirm } from '../../ui/ConfirmDialog';
import { AppMenuButton, menuGroups } from '../../ui/AppMenuButton';
import type { ContextMenuEntry } from '../../ui/ContextMenu';
import { DOCX_MIME_TYPE } from '../../io/docx';
import { formatPageDate } from '../../ui/dates';
import {
  CURRENT_SCHEMA_JSON_LIMITS,
  exportCurrentSchemaJson,
  importCurrentSchemaJson,
  type PortableWorkspaceJsonV3,
} from '../../io/currentSchemaJson';
import {
  createBrowserImageAssetRasterizer,
  createBrowserPdfRasterizer,
  createPdfExportBudgetCheck,
  exportComposedPdf,
  importOriginalPdf,
  materializePdfPreview,
  type PdfExportPage,
  type PlannedPdfPage,
  type RenderedImage,
} from '../../io/pdf';
import type {
  ActiveV2Context,
  V2RuntimeState,
  WorkspaceGraphRevisionRequest,
  WorkspaceV2Runtime,
} from '../../storage/workspaceV2Runtime';
import {
  createBrowserPdfPreviewRenderer,
  downloadBlob,
  downloadBytes,
  exportNotebookBundle,
  exportWorkspaceBackup,
  importNotebookBundleAdditively,
  portableLivePage,
  portablePageDocx,
  portablePageMarkdown,
  renderPortableRegionPng,
  renderPortablePagePng,
  runtimeAssetRepository,
  StagedRuntimeAssetRepository,
} from '.';
import { thumbnails } from './previewThumbnails';

interface RenderedPrintoutPage {
  element: PdfElementV2;
  thumbnail?: RenderedImage;
  assets: AssetBlob[];
}

type CommitTopology = (
  request: Omit<WorkspaceGraphRevisionRequest, 'expectedActivationArtifactFingerprint'>,
) => Promise<V2RuntimeState | null>;

export interface AssetWorkspaceControlsProps {
  runtime: WorkspaceV2Runtime;
  workspace: V2RuntimeState;
  activeContext: ActiveV2Context;
  commitTopology: CommitTopology;
  createId(scope: string): string;
  navigate(notebookId: string, sectionId: string, pageId: string): void;
  onWorkspaceState(state: V2RuntimeState): void;
  onNotice(message: string): void;
  disabled?: boolean;
  /** Ribbon "Insert" tab: the insert commands also appear there as a group. */
  insertHost?: HTMLElement | null;
  /**
   * Filled with a function that puts a PNG clip made on the canvas (the pen's
   * screen clip) on the page as an image, like a pasted screenshot.
   */
  insertClipRef?: MutableRefObject<((png: Blob) => Promise<void>) | null>;
}

type BusyOperation = 'image' | 'screenshot' | 'attachment' | 'pdf' | 'export' | 'bundle' | 'json' | null;

export const PDF_PRINTOUT_PAGE_LIMIT = 500;
const PDF_PRINTOUT_X = 72;
const PDF_PRINTOUT_MAX_WIDTH = 720;
const PDF_PRINTOUT_GAP = 30;

/**
 * PDF printouts become page backgrounds right away: the point of a printout
 * is to write on it, so pen, text, lasso and eraser act on top of it instead
 * of selecting the page. A right-click releases it (see canvasOrder).
 */
export function layoutPdfPrintoutFrames(
  pages: readonly { frame: { width: number; height: number } }[],
  existingElements: readonly { frame: { y: number; height: number } }[],
): PdfElementV2['frame'][] {
  const existingBottom = existingElements.reduce(
    (bottom, element) => Math.max(bottom, element.frame.y + element.frame.height),
    42,
  );
  let y = Math.max(72, existingBottom + PDF_PRINTOUT_GAP);
  return pages.map((page) => {
    const scale = Math.min(1, PDF_PRINTOUT_MAX_WIDTH / page.frame.width);
    const width = Math.max(1, Math.round(page.frame.width * scale));
    const height = Math.max(1, Math.round(page.frame.height * scale));
    const frame = { x: PDF_PRINTOUT_X, y, width, height, rotation: 0 };
    y += height + PDF_PRINTOUT_GAP;
    return frame;
  });
}

export function layoutPdfPrintoutElements(
  pages: readonly PdfElementV2[],
  existingElements: readonly { frame: { y: number; height: number } }[],
): PdfElementV2[] {
  const frames = layoutPdfPrintoutFrames(pages, existingElements);
  return pages.map((page, index) => ({ ...structuredClone(page), frame: frames[index], locked: true }));
}

export function remapPortableWorkspaceForAdditiveImport(
  payload: PortableWorkspaceJsonV3,
  createId: (scope: string) => string,
  timestamp: string,
): { notebook: NotebookDocV3; pages: PageDocV3[] } {
  const notebookId = createId('json-notebook');
  const sectionIds = new Map(payload.notebook.sections.map((section) => [
    section.id, createId('json-section'),
  ]));
  const pageIds = new Map(payload.pages.map((page) => [page.pageId, createId('json-page')]));
  const documentIds = new Map(payload.pages.map((page) => [
    page.documentId, `page:${pageIds.get(page.pageId) as string}`,
  ]));
  const pages = payload.pages.map((page): PageDocV3 => {
    const documentId = documentIds.get(page.documentId);
    const sectionId = sectionIds.get(page.sectionId);
    const pageId = pageIds.get(page.pageId);
    const parentPageId = page.parentPageId ? pageIds.get(page.parentPageId) : undefined;
    if (!documentId || !sectionId || !pageId || (page.parentPageId && !parentPageId)) {
      throw new Error(`Current-schema JSON page ${page.documentId} cannot be remapped.`);
    }
    const clone = structuredClone(page);
    delete clone.parentPageId;
    return {
      ...clone,
      documentId,
      notebookId,
      sectionId,
      pageId,
      ...(parentPageId ? { parentPageId } : {}),
      createdAt: timestamp,
      updatedAt: timestamp,
      version: { protocol: 'uninitialized', heads: [] },
    };
  });
  const notebook: NotebookDocV3 = {
    ...structuredClone(payload.notebook),
    documentId: `notebook:${notebookId}`,
    notebookId,
    title: `${payload.notebook.title} (Import)`,
    createdAt: timestamp,
    updatedAt: timestamp,
    sections: payload.notebook.sections.map((section) => ({
      ...structuredClone(section),
      id: sectionIds.get(section.id) as string,
      createdAt: timestamp,
      updatedAt: timestamp,
      pageDocumentIds: section.pageDocumentIds.map((documentId) => {
        const mapped = documentIds.get(documentId);
        if (!mapped) throw new Error(`Current-schema JSON page ${documentId} cannot be remapped.`);
        return mapped;
      }),
    })),
    version: { protocol: 'uninitialized', heads: [] },
  };
  return { notebook, pages };
}

export function fileStem(value: string): string {
  // Strip a real file extension ("foto.jpeg"), not the year of a date title
  // such as "26.09.2026 Physik".
  return value.replace(/\.[A-Za-z][A-Za-z0-9]{0,4}$/, '').replace(/[^\p{L}\p{N}._-]+/gu, '-').slice(0, 100) || 'canvink';
}

function fileBytes(file: File): Promise<Uint8Array> {
  return file.arrayBuffer().then((buffer) => new Uint8Array(buffer));
}

export function mathSettingsForPdfExport(
  page: Parameters<typeof mathPageSettings>[0],
): { numberMode: 'exact' | 'decimal'; angleMode: 'degrees' | 'radians' } {
  const settings = mathPageSettings(page);
  return { numberMode: settings.numberMode, angleMode: settings.angleMode };
}

export function isStructuralPdfBackground(element: PageElementV3 | undefined): element is PdfElementV2 {
  return element?.kind === 'pdf'
    && element.locked
    && Boolean(element.originalAsset)
    && element.sourceAvailability === 'original'
    && element.frame.x === 0
    && element.frame.y === 0
    && element.frame.rotation === 0;
}

/** One page prepared for the PDF export; a page that is not open is read for this only. */
export async function pdfExportPage(
  runtime: WorkspaceV2Runtime,
  pageId: string,
): Promise<PdfExportPage> {
  return runtime.readPage(pageId, (document) => {
    const page = getSharedAutomergeSnapshot<LivePageDocV2>(document);
    const portable = portableLivePage(page, document);
    const sourceElement = page.zOrder.map((id) => portable.elementsById[id]).find(isStructuralPdfBackground);
    return {
      width: sourceElement?.frame.width ?? portable.width,
      height: sourceElement?.frame.height ?? portable.height,
      elementsById: portable.elementsById,
      zOrder: [...page.zOrder],
      mathSettings: mathSettingsForPdfExport(portable.page),
      ...(sourceElement?.originalAsset ? {
        source: {
          asset: sourceElement.originalAsset,
          pageNumber: sourceElement.sourcePageNumber ?? 1,
        },
      } : {}),
    };
  });
}

/** A PDF of the given pages in order; each page is read on its own, so a long notebook never sits in memory at once. */
export async function composePdfFromPages(
  runtime: WorkspaceV2Runtime,
  pageIds: readonly string[],
): Promise<Uint8Array> {
  const checkBudget = createPdfExportBudgetCheck();
  const pages: PdfExportPage[] = [];
  for (const pageId of pageIds) {
    const page = await pdfExportPage(runtime, pageId);
    // Stops at the first page past the export limits instead of reading every page first.
    checkBudget(page, pages.length);
    pages.push(page);
  }
  return exportComposedPdf({
    pages,
    repository: runtimeAssetRepository(runtime),
    rasterizer: createBrowserPdfRasterizer(),
    imageRasterizer: createBrowserImageAssetRasterizer(),
  });
}

export default function AssetWorkspaceControls({
  runtime,
  workspace,
  activeContext,
  commitTopology,
  createId,
  navigate,
  onWorkspaceState,
  onNotice,
  disabled = false,
  insertHost = null,
  insertClipRef,
}: AssetWorkspaceControlsProps) {
  const { language, t } = useI18n();
  const { confirm, element: confirmElement } = useConfirm();
  const imageInput = useRef<HTMLInputElement>(null);
  const attachmentInput = useRef<HTMLInputElement>(null);
  const pdfInput = useRef<HTMLInputElement>(null);
  const bundleInput = useRef<HTMLInputElement>(null);
  const currentJsonInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<BusyOperation>(null);
  const [progress, setProgress] = useState('');
  const [lastBundleImportId, setLastBundleImportId] = useState<string | null>(null);

  const run = async (operation: Exclude<BusyOperation, null>, work: () => Promise<void>) => {
    setBusy(operation);
    setProgress(t('assets.preparing'));
    try {
      await work();
    } catch (error) {
      onNotice(error instanceof Error ? error.message : t('assets.error.operation'));
    } finally {
      setBusy(null);
      setProgress('');
    }
  };

  const addImageBytes = async (bytes: Uint8Array, mimeType: string, fileName: string, screenshot = false) => {
    const stage = new StagedRuntimeAssetRepository(runtime);
    const stored = screenshot
      ? await ingestClipboardScreenshot(stage, { bytes, mimeType, fileName })
      : await storeOriginalAsset(stage, { bytes, mimeType, fileName, kind: 'image' });
    const dimensions = stored.imageDimensions;
    if (!dimensions) throw new Error(t('assets.error.dimensions'));
    const scale = Math.min(1, 700 / dimensions.width, 500 / dimensions.height);
    const now = new Date().toISOString();
    const element: ImageElementV2 = {
      id: createId(screenshot ? 'screenshot' : 'image'),
      kind: 'image',
      frame: {
        x: 72,
        y: 72,
        width: Math.max(1, Math.round(dimensions.width * scale)),
        height: Math.max(1, Math.round(dimensions.height * scale)),
        rotation: 0,
      },
      createdAt: now,
      updatedAt: now,
      locked: false,
      asset: stored.ref,
      alt: fileStem(fileName),
    };
    await commitTopology({
      operationId: createId('add-image'),
      message: screenshot ? t('assets.controls.screenshot') : t('assets.controls.image'),
      assets: stage.pendingAssets(),
      changes: [{
        documentId: activeContext.page.documentId,
        change: (document) => {
          if (document.kind !== 'page') return;
          // Repeated inserts stack below each other instead of covering one another.
          const { x, y } = freeSpotBelow(Object.values(activeContext.page.elementsById), element.frame);
          document.elementsById[element.id] = structuredClone({ ...element, frame: { ...element.frame, x, y } });
          document.zOrder.push(element.id);
          document.updatedAt = now;
        },
      }],
    });
    onNotice(stored.disposition === 'deduplicated' ? t('assets.image.deduplicated') : t('assets.image.saved'));
  };

  useEffect(() => {
    if (!insertClipRef) return;
    insertClipRef.current = (png) => run('screenshot', async () => {
      if (disabled) throw new Error(t('workspace.viewer.readOnly'));
      await addImageBytes(new Uint8Array(await png.arrayBuffer()), 'image/png', 'clip.png', true);
    });
    return () => {
      insertClipRef.current = null;
    };
  });

  const addImage = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    void run('image', async () => addImageBytes(await fileBytes(file), file.type, file.name));
  };

  const addScreenshot = () => void run('screenshot', async () => {
    if (disabled) throw new Error(t('workspace.viewer.readOnly'));
    if (!navigator.clipboard?.read) throw new Error(t('assets.clipboard.unsupported'));
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const mimeType = item.types.find((type) => ['image/png', 'image/jpeg', 'image/webp'].includes(type));
      if (!mimeType) continue;
      const blob = await item.getType(mimeType);
      await addImageBytes(new Uint8Array(await blob.arrayBuffer()), mimeType, `screenshot.${mimeType.split('/')[1]}`, true);
      return;
    }
    throw new Error(t('assets.clipboard.empty'));
  });

  const addAttachment = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    void run('attachment', async () => {
      const stage = new StagedRuntimeAssetRepository(runtime);
      const stored = await storeOriginalAsset(stage, {
        bytes: await fileBytes(file),
        mimeType: file.type || 'application/octet-stream',
        fileName: file.name,
        kind: 'attachment',
      });
      const now = new Date().toISOString();
      const element: AttachmentElementV2 = {
        id: createId('attachment'),
        kind: 'attachment',
        frame: { x: 72, y: 72, width: 360, height: 96, rotation: 0 },
        createdAt: now,
        updatedAt: now,
        locked: false,
        asset: stored.ref,
        displayName: file.name,
      };
      await commitTopology({
        operationId: createId('add-attachment'),
        message: t('assets.controls.attachment'),
        assets: stage.pendingAssets(),
        changes: [{
          documentId: activeContext.page.documentId,
          change: (document) => {
            if (document.kind !== 'page') return;
            const { x, y } = freeSpotBelow(Object.values(activeContext.page.elementsById), element.frame);
            document.elementsById[element.id] = structuredClone({ ...element, frame: { ...element.frame, x, y } });
            document.zOrder.push(element.id);
            document.updatedAt = now;
          },
        }],
      });
      onNotice(stored.disposition === 'deduplicated' ? t('assets.attachment.deduplicated') : t('assets.attachment.saved'));
    });
  };

  const addPdf = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    void run('pdf', async () => {
      const stage = new StagedRuntimeAssetRepository(runtime);
      setProgress(t('assets.pdf.inspecting'));
      const plan = await importOriginalPdf(
        stage,
        { bytes: await fileBytes(file), fileName: file.name },
        createId,
        0,
        undefined,
        // A printout is written on, not searched by its text; reading the text of hundreds of pages is what made this slow.
        { text: false },
      );
      if (plan.inspection.pageCount > PDF_PRINTOUT_PAGE_LIMIT) {
        throw new Error(t('assets.pdf.printoutTooMany', { max: PDF_PRINTOUT_PAGE_LIMIT }));
      }
      const planned = plan.pages.filter((page): page is PlannedPdfPage => page.kind === 'pdf-page');
      const renderer = createBrowserPdfPreviewRenderer();
      /** Where each page sits on the page, fixed by the first commit so every later batch continues the stack. */
      let frames: PdfElementV2['frame'][] | undefined;
      const insertedIds: string[] = [];
      let rendered = 0;
      try {
        // Every page comes from the same PDF: read and verify it once, and let the renderer keep it open.
        const pdfBytes = await reopenAsset(stage, plan.originalAsset);
        const parallel = Math.max(1, renderer.concurrency ?? 1);
        // The pages render in order and without pause while earlier ones are saved.
        const slots = planned.map(() => {
          let resolve!: (page: RenderedPrintoutPage) => void;
          let reject!: (error: unknown) => void;
          const promise = new Promise<RenderedPrintoutPage>((res, rej) => {
            resolve = res;
            reject = rej;
          });
          // A failure is reported where the commit loop waits for the page.
          promise.catch(() => undefined);
          return { promise, resolve, reject };
        });
        let next = 0;
        const pull = async (): Promise<void> => {
          for (;;) {
            const index = next;
            next += 1;
            if (index >= planned.length) return;
            try {
              const pageStage = new StagedRuntimeAssetRepository(runtime);
              const materialized = await materializePdfPreview(pageStage, renderer, planned[index], pdfBytes);
              rendered += 1;
              setProgress(t('assets.pdf.previewProgress', { page: rendered, total: planned.length }));
              slots[index].resolve({
                element: { ...materialized.page.element, previewAsset: materialized.previewAsset, sourcePageNumber: planned[index].sourcePage.pageNumber },
                thumbnail: materialized.thumbnail,
                assets: pageStage.pendingAssets(),
              });
            } catch (error) {
              slots[index].reject(error);
              return;
            }
          }
        };
        const workers = Array.from({ length: parallel }, pull);
        // The first pages appear after a moment; the batches grow so a long book needs few commits.
        let batchSize = Math.max(2, parallel * 2);
        let cursor = 0;
        while (cursor < planned.length) {
          const end = Math.min(planned.length, cursor + batchSize);
          const done = await Promise.all(slots.slice(cursor, end).map((slot) => slot.promise));
          cursor = end;
          batchSize = Math.min(128, batchSize * 4);
          const now = new Date().toISOString();
          const elements = done.map((entry) => entry.element);
          const assets = new Map<string, AssetBlob>();
          for (const blob of [...(insertedIds.length === 0 ? stage.pendingAssets() : []), ...done.flatMap((entry) => entry.assets)]) assets.set(blob.assetId, blob);
          const committed = await commitTopology({
            operationId: createId('insert-pdf-printout'),
            message: t('assets.controls.pdf'),
            assets: [...assets.values()],
            changes: [{
              documentId: activeContext.page.documentId,
              change: (document) => {
                if (document.kind !== 'page') return;
                const laidOut = frames ??= layoutPdfPrintoutFrames(planned.map((page) => page.element), Object.values(document.elementsById));
                const chosen = elements.map((element, index) => ({ ...element, frame: laidOut[insertedIds.length + index], locked: true }));
                for (const element of chosen) document.elementsById[element.id] = structuredClone(element);
                // Backgrounds sit at the bottom of the page order, so exports draw
                // earlier ink above them as the editor does; later batches continue after the earlier ones.
                const after = insertedIds.length === 0 ? 0 : document.zOrder.indexOf(insertedIds[insertedIds.length - 1]) + 1;
                document.zOrder.splice(after, 0, ...chosen.map((element) => element.id));
                insertedIds.push(...chosen.map((element) => element.id));
                document.updatedAt = now;
              },
            }],
          });
          if (!committed) throw new Error(t('assets.error.operation'));
          // Thumbnails are ready before the sharp pictures are read back.
          await Promise.all(done.map((entry) => entry.thumbnail
            ? thumbnails.put(entry.element.previewAsset.assetId, new Blob([entry.thumbnail.bytes.slice().buffer], { type: entry.thumbnail.mimeType }))
            : undefined));
        }
        await Promise.all(workers);
      } finally {
        await renderer.release?.();
      }
      onNotice(t('assets.pdf.printoutImported', { pages: plan.inspection.pageCount }));
    });
  };

  /** Page IDs in scope order; contents are read one page at a time by the exports. */
  const pagesForScope = (scope: 'page' | 'section' | 'notebook'): string[] => {
    if (scope === 'page') return [activeContext.page.pageId];
    if (scope === 'section') return activeContext.section.pageDocumentIds.map((documentId) => {
      const page = workspace.pages.find((candidate) => candidate.documentId === documentId);
      if (!page) throw new Error(t('assets.error.missingSectionPage', { documentId }));
      return page.pageId;
    });
    return activeContext.notebook.sections.flatMap((section) => section.pageDocumentIds.map((documentId) => {
      const page = workspace.pages.find((candidate) => candidate.documentId === documentId);
      if (!page) throw new Error(t('assets.error.missingNotebookPage', { documentId }));
      return page.pageId;
    }));
  };

  const exportPdf = (scope: 'page' | 'section' | 'notebook') => void run('export', async () => {
    setProgress(t('assets.pdf.composing'));
    const bytes = await composePdfFromPages(runtime, pagesForScope(scope));
    const name = scope === 'page'
      ? activeContext.page.title
      : scope === 'section'
        ? activeContext.section.title
        : activeContext.notebook.title;
    downloadBytes(bytes, 'application/pdf', `${fileStem(name)}.pdf`);
    onNotice(t('assets.pdf.exported', { scope: t(scope === 'page' ? 'assets.scope.page' : scope === 'section' ? 'assets.scope.section' : 'assets.scope.notebook') }));
  });

  const exportPng = () => void run('export', async () => {
    const portable = portableLivePage(activeContext.page, activeContext.pageHandle.doc());
    const bytes = await renderPortablePagePng(portable, runtimeAssetRepository(runtime));
    downloadBytes(bytes, 'image/png', `${fileStem(activeContext.page.title)}.png`);
    onNotice(t('assets.png.exported'));
  });

  const exportMarkdown = () => {
    const portable = portableLivePage(activeContext.page, activeContext.pageHandle.doc());
    downloadBytes(
      new TextEncoder().encode(portablePageMarkdown(portable)),
      'text/markdown',
      `${fileStem(activeContext.page.title)}.md`,
    );
    onNotice(t('assets.markdown.exported'));
  };

  // One click from the page header: editable Word text for text containers,
  // pictures for handwriting, drawings, images and PDF printouts.
  const exportDocx = () => void run('export', async () => {
    const portable = portableLivePage(activeContext.page, activeContext.pageHandle.doc());
    const repository = runtimeAssetRepository(runtime);
    const bytes = await portablePageDocx(portable, {
      subtitle: `${formatPageDate(activeContext.page.createdAt, language)} · ${activeContext.notebook.title} / ${activeContext.section.title}`,
      renderRegion: (ids, region) => renderPortableRegionPng(portable, repository, ids, region),
      attachmentLabel: (name) => t('assets.docx.attachment', { name }),
    });
    downloadBytes(bytes, DOCX_MIME_TYPE, `${fileStem(activeContext.page.title)}.docx`);
    onNotice(t('assets.docx.exported'));
  });

  const exportBundle = () => void run('bundle', async () => {
    setProgress(t('assets.bundle.checking'));
    const blob = await exportNotebookBundle(runtime, workspace, activeContext.notebook.notebookId, {
      onProgress: (done, total) => setProgress(t('assets.backup.progress', { done, total })),
    });
    downloadBlob(blob, `${fileStem(activeContext.notebook.title)}.canvink`);
    onNotice(t('assets.bundle.exported'));
  });

  const exportBackup = () => void run('bundle', async () => {
    setProgress(t('assets.bundle.checking'));
    const blob = await exportWorkspaceBackup(runtime, workspace, {
      onProgress: (done, total) => setProgress(t('assets.backup.progress', { done, total })),
    });
    downloadBlob(blob, `canvink-${new Date().toISOString().slice(0, 10)}.zip`);
    onNotice(t('assets.backup.exported'));
  });

  const exportCurrentJson = () => void run('json', async () => {
    const pages: PageDocV3[] = [];
    for (const pageId of pagesForScope('notebook')) {
      pages.push(await runtime.readPage(pageId, (document): PageDocV3 => {
        const projection = portableLivePage(getSharedAutomergeSnapshot<LivePageDocV2>(document), document);
        return {
          ...structuredClone(projection.page),
          schemaVersion: 3,
          elementsById: structuredClone(projection.elementsById),
          mathSettings: mathPageSettings(projection.page),
          version: { protocol: 'uninitialized', heads: [] },
        } as PageDocV3;
      }));
    }
    const notebook: NotebookDocV3 = {
      ...structuredClone(activeContext.notebook),
      schemaVersion: 3,
      version: { protocol: 'uninitialized', heads: [] },
    };
    const serialized = exportCurrentSchemaJson({ notebook, pages });
    downloadBytes(
      new TextEncoder().encode(serialized),
      'application/json',
      `${fileStem(activeContext.notebook.title)}.canvink.json`,
    );
    onNotice(t('assets.currentJson.exported'));
  });

  const importCurrentJson = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > CURRENT_SCHEMA_JSON_LIMITS.bytes) {
      onNotice(t('assets.currentJson.tooLarge'));
      return;
    }
    if (!(await confirm({ title: t('assets.import.title'), message: t('assets.currentJson.importConfirm'), confirmLabel: t('assets.import.confirm') }))) return;
    void run('json', async () => {
      const serialized = await file.text();
      const payload = importCurrentSchemaJson(serialized);
      const preparedAt = new Date().toISOString();
      const remapped = remapPortableWorkspaceForAdditiveImport(payload, createId, preparedAt);
      await runtime.extendActiveWorkspace({
        importId: createId('json-import'),
        importArtifactFingerprint: await sha256Bytes(new TextEncoder().encode(serialized)),
        expectedActivationArtifactFingerprint: workspace.activation.artifactFingerprint,
        notebook: remapped.notebook,
        pages: remapped.pages,
        assets: [],
        preparedAt,
      });
      const state = runtime.getState();
      if (state.schemaVersion !== 2 && state.schemaVersion !== 3) {
        throw new Error(t('assets.currentJson.schemaError'));
      }
      const firstSection = remapped.notebook.sections[0];
      const firstPage = remapped.pages.find((page) => page.documentId === firstSection?.pageDocumentIds[0]);
      if (!firstSection || !firstPage) throw new Error(t('assets.currentJson.empty'));
      onWorkspaceState(state);
      navigate(remapped.notebook.notebookId, firstSection.id, firstPage.pageId);
      onNotice(t('assets.currentJson.imported'));
    });
  };

  const importBundle = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!(await confirm({ title: t('assets.import.title'), message: t('assets.bundle.importConfirm'), confirmLabel: t('assets.import.confirm') }))) return;
    void run('bundle', async () => {
      setProgress(t('assets.bundle.validating'));
      const imported = await importNotebookBundleAdditively(runtime, workspace, file, createId);
      const state = runtime.getState();
      if (state.schemaVersion !== 2 && state.schemaVersion !== 3) throw new Error(t('assets.bundle.schemaError'));
      onWorkspaceState(state);
      setLastBundleImportId(imported.result.importId);
      navigate(imported.notebookId, imported.sectionId, imported.pageId);
      onNotice(t('assets.bundle.imported'));
    });
  };

  const rollbackBundle = async () => {
    if (!lastBundleImportId) return;
    if (!(await confirm({ title: t('assets.bundle.rollbackTitle'), message: t('assets.bundle.rollbackConfirm'), confirmLabel: t('assets.bundle.rollbackAction'), danger: true }))) return;
    void run('bundle', async () => {
      await runtime.rollbackWorkspaceImport(lastBundleImportId);
      const state = runtime.getState();
      if (state.schemaVersion !== 2 && state.schemaVersion !== 3) throw new Error(t('assets.bundle.rollbackSchemaError'));
      onWorkspaceState(state);
      setLastBundleImportId(null);
      onNotice(t('assets.bundle.rolledBack'));
    });
  };

  // OneNote's File: what leaves the page or the notebook, and the notebook
  // as a file. Inserting is the Insert tab's job, so it is not repeated here.
  // The Word export is one of the export formats rather than a button of its
  // own, and the developer schema JSON sits behind "Advanced".
  const fileMenuItems = (): ContextMenuEntry[] => menuGroups([
    [
      {
        id: 'export',
        label: t('assets.controls.export'),
        icon: <FileDown size={16} />,
        disabled: Boolean(busy),
        submenu: [
          { id: 'export-page-pdf', label: t('assets.controls.pagePdf'), icon: <FileText size={16} />, onSelect: () => exportPdf('page') },
          { id: 'export-section-pdf', label: t('assets.controls.sectionPdf'), icon: <FileText size={16} />, onSelect: () => exportPdf('section') },
          { id: 'export-notebook-pdf', label: t('assets.controls.notebookPdf'), icon: <FileText size={16} />, onSelect: () => exportPdf('notebook') },
          { kind: 'separator', id: 'export-separator' },
          { id: 'export-page-png', label: t('assets.controls.pagePng'), icon: <ImageIcon size={16} />, onSelect: () => exportPng() },
          { id: 'export-page-markdown', label: t('assets.controls.pageMarkdown'), icon: <FileCode2 size={16} />, onSelect: () => exportMarkdown() },
          { id: 'export-page-docx', label: t('assets.controls.pageDocx'), icon: <FileType size={16} />, onSelect: () => exportDocx() },
        ],
      },
    ],
    [
      { id: 'notebook-bundle', label: t('assets.controls.notebookBundle'), icon: <Archive size={16} />, disabled: Boolean(busy), onSelect: () => exportBundle() },
      { id: 'workspace-backup', label: t('assets.controls.workspaceBackup'), icon: <Archive size={16} />, disabled: Boolean(busy), onSelect: () => exportBackup() },
      { id: 'import-bundle', label: t('assets.controls.importBundle'), icon: <Upload size={16} />, disabled: disabled || Boolean(busy), onSelect: () => bundleInput.current?.click() },
      lastBundleImportId ? { id: 'rollback-bundle', label: t('assets.controls.rollbackBundle'), icon: <Undo2 size={16} />, disabled: disabled || Boolean(busy), onSelect: () => { void rollbackBundle(); } } : null,
    ],
    [
      {
        id: 'advanced',
        label: t('assets.controls.advanced'),
        icon: <Wrench size={16} />,
        disabled: Boolean(busy),
        submenu: [
          { id: 'schema-export', label: t('assets.controls.currentJsonExport'), icon: <FileDown size={16} />, onSelect: () => exportCurrentJson() },
          { id: 'schema-import', label: t('assets.controls.currentJsonImport'), icon: <Upload size={16} />, disabled: disabled, onSelect: () => currentJsonInput.current?.click() },
        ],
      },
    ],
  ], 'file');

  return (
    <div className="asset-workspace-controls" aria-label={t('assets.controls.label')}>
      {confirmElement}
      <input ref={imageInput} hidden disabled={disabled} type="file" accept="image/png,image/jpeg,image/gif,image/webp" onChange={addImage} />
      <input ref={attachmentInput} hidden disabled={disabled} type="file" onChange={addAttachment} />
      <input ref={pdfInput} hidden disabled={disabled} type="file" accept="application/pdf,.pdf" onChange={addPdf} />
      <input ref={bundleInput} hidden disabled={disabled} type="file" accept=".canvink,application/vnd.canvink.bundle+zip" onChange={(event) => void importBundle(event)} />
      <input ref={currentJsonInput} hidden disabled={disabled} type="file" accept="application/json,.json" onChange={(event) => void importCurrentJson(event)} />
      <AppMenuButton
        label={t('assets.controls.fileMenu')}
        className="asset-workspace-controls__file"
        align="start"
        items={fileMenuItems}
      >
        <FolderOpen size={15} aria-hidden="true" />
        <span className="asset-workspace-controls__file-label">{t('assets.controls.fileMenu')}</span>
        <ChevronDown size={13} aria-hidden="true" className="asset-workspace-controls__file-chevron" />
      </AppMenuButton>
      {busy ? <output role="status" aria-live="polite" title={progress}>{progress}</output> : null}
      {insertHost ? createPortal(
        <div className="ribbon-groups" role="toolbar" aria-label={t('canvas.toolbar.insert')}>
          <div className="ribbon-group" role="group" aria-label={t('canvas.toolbar.insert')}>
            <button type="button" className="ribbon-button ribbon-button--labelled" disabled={disabled || Boolean(busy)} onClick={() => imageInput.current?.click()}><ImagePlus size={16} aria-hidden="true" /><span>{t('assets.controls.image')}</span></button>
            <button type="button" className="ribbon-button ribbon-button--labelled" disabled={disabled || Boolean(busy)} onClick={addScreenshot}><Camera size={16} aria-hidden="true" /><span>{t('assets.controls.screenshot')}</span></button>
            <button type="button" className="ribbon-button ribbon-button--labelled" disabled={disabled || Boolean(busy)} onClick={() => pdfInput.current?.click()}><FilePlus2 size={16} aria-hidden="true" /><span>{t('assets.controls.pdf')}</span></button>
            <button type="button" className="ribbon-button ribbon-button--labelled" disabled={disabled || Boolean(busy)} onClick={() => attachmentInput.current?.click()}><Paperclip size={16} aria-hidden="true" /><span>{t('assets.controls.attachment')}</span></button>
          </div>
        </div>,
        insertHost,
      ) : null}
    </div>
  );
}
