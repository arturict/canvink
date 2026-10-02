import { assertWorkspaceShape } from '../validation';
import type {
  ChecklistElement,
  ImageElement,
  Notebook,
  Page,
  PageElement,
  PdfElement,
  Section,
  TextElement,
  TrashEntry,
  WorkspaceState,
} from '../types';
import { canonicalJson, sha256Bytes, sha256Canonical } from './hash';
import {
  V1_TO_V2_MIGRATION_VERSION,
  WORKSPACE_SCHEMA_VERSION_V2,
  type AssetBlob,
  type AssetRef,
  type CanvinkDocumentV2,
  type MigrationPreviewV2,
  type MigrationResultV2,
  type NotebookDoc,
  type NotebookSectionRef,
  type PageDoc,
  type PageElementV2,
  type RichTextMark,
  type Sha256Checksum,
  type TrashRecordV2,
} from './types';

const EMPTY_VERSION = { protocol: 'uninitialized', heads: [] } as const;

interface MigrationContext {
  documents: CanvinkDocumentV2[];
  assetsById: Map<Sha256Checksum, AssetBlob>;
  preview: MigrationPreviewV2;
}

function decodeDataUrl(dataUrl: string): { mimeType: string; bytes: Uint8Array } {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/i.exec(dataUrl);
  if (!match || match[2].length % 4 !== 0) {
    throw new Error('An inline asset has a malformed base64 data URL. Migration was not committed.');
  }
  let binary: string;
  try {
    binary = atob(match[2]);
  } catch {
    throw new Error('An inline asset could not be decoded. Migration was not committed.');
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return { mimeType: match[1].toLowerCase(), bytes };
}

async function extractAsset(
  context: MigrationContext,
  dataUrl: string,
  options: { fileName?: string; role: AssetRef['role'] },
): Promise<AssetRef> {
  const { mimeType, bytes } = decodeDataUrl(dataUrl);
  const checksum = await sha256Bytes(bytes);
  const existing = context.assetsById.get(checksum);
  if (existing) {
    if (existing.size !== bytes.byteLength) {
      throw new Error('An asset checksum collision was detected. Migration was not committed.');
    }
  } else {
    context.assetsById.set(checksum, {
      assetId: checksum,
      checksum,
      size: bytes.byteLength,
      bytes,
    });
    context.preview.extractedAssetBytes += bytes.byteLength;
  }
  return {
    assetId: checksum,
    checksum,
    mimeType,
    size: bytes.byteLength,
    ...(options.fileName ? { fileName: options.fileName } : {}),
    role: options.role,
  };
}

function textMarks(element: TextElement): RichTextMark[] {
  const marks: RichTextMark[] = [];
  if (element.fontWeight >= 600) marks.push({ type: 'bold' });
  if (element.fontStyle === 'italic') marks.push({ type: 'italic' });
  if (element.textDecoration === 'underline') marks.push({ type: 'underline' });
  if (element.textDecoration === 'line-through') marks.push({ type: 'strike' });
  return marks;
}

function richTextFromText(element: TextElement): PageElementV2 {
  return {
    id: element.id,
    kind: 'richText',
    frame: {
      x: element.x,
      y: element.y,
      width: element.width,
      height: element.height,
      rotation: 0,
    },
    createdAt: element.createdAt,
    updatedAt: element.updatedAt,
    locked: false,
    content: {
      type: 'doc',
      blocks: element.text.split('\n').map((text, index) => ({
        id: `${element.id}:block:${index}`,
        type: 'paragraph' as const,
        ...(element.listStyle === 'bullet' ? { list: 'bullet' as const } : {}),
        ...(element.listStyle === 'numbered' ? { list: 'ordered' as const } : {}),
        spans: [{ text, marks: textMarks(element) }],
      })),
    },
    style: {
      color: element.color,
      fontFamily: element.fontFamily,
      fontSize: element.fontSize,
      textAlign: element.textAlign ?? 'left',
    },
  };
}

function richTextFromChecklist(element: ChecklistElement): PageElementV2 {
  return {
    id: element.id,
    kind: 'richText',
    frame: {
      x: element.x,
      y: element.y,
      width: element.width,
      height: element.height,
      rotation: 0,
    },
    createdAt: element.createdAt,
    updatedAt: element.updatedAt,
    locked: false,
    content: {
      type: 'doc',
      blocks: element.items.map((item) => ({
        id: item.id,
        type: 'checkItem' as const,
        checked: item.checked,
        spans: [{ text: item.text, marks: [] }],
      })),
    },
    style: {
      color: element.color,
      fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
      fontSize: element.fontSize,
      textAlign: 'left',
    },
  };
}

async function imageElement(
  context: MigrationContext,
  element: ImageElement,
): Promise<PageElementV2> {
  return {
    id: element.id,
    kind: 'image',
    frame: {
      x: element.x,
      y: element.y,
      width: element.width,
      height: element.height,
      rotation: 0,
    },
    createdAt: element.createdAt,
    updatedAt: element.updatedAt,
    locked: false,
    asset: await extractAsset(context, element.dataUrl, {
      fileName: element.name,
      role: 'original',
    }),
    alt: element.alt,
  };
}

async function pdfElement(
  context: MigrationContext,
  element: PdfElement,
): Promise<PageElementV2> {
  context.preview.previewOnlyPdfs += 1;
  return {
    id: element.id,
    kind: 'pdf',
    frame: {
      x: element.x,
      y: element.y,
      width: element.width,
      height: element.height,
      rotation: 0,
    },
    createdAt: element.createdAt,
    updatedAt: element.updatedAt,
    locked: false,
    previewAsset: await extractAsset(context, element.previewDataUrl, {
      fileName: `${element.sourceName}.preview`,
      role: 'preview',
    }),
    pageCount: element.pageCount,
    sourceAvailability: 'preview-only',
  };
}

async function migrateElement(
  context: MigrationContext,
  element: PageElement,
): Promise<PageElementV2> {
  context.preview.elements += 1;
  if (element.kind === 'text') return richTextFromText(element);
  if (element.kind === 'checklist') return richTextFromChecklist(element);
  if (element.kind === 'image') return imageElement(context, element);
  if (element.kind === 'pdf') return pdfElement(context, element);
  if (element.kind === 'shape') {
    return {
      id: element.id,
      kind: 'shape',
      frame: {
        x: element.x,
        y: element.y,
        width: element.width,
        height: element.height,
        rotation: element.rotation,
      },
      createdAt: element.createdAt,
      updatedAt: element.updatedAt,
      locked: false,
      shape: element.shapeType,
      strokeColor: element.color,
      strokeWidth: element.strokeWidth,
    };
  }
  if (element.kind === 'stroke') return {
    id: element.id,
    kind: 'stroke',
    frame: { x: element.x, y: element.y, width: 0, height: 0, rotation: 0 },
    createdAt: element.createdAt,
    updatedAt: element.updatedAt,
    locked: false,
    tool: element.tool,
    points: element.points.map((point) => ({ ...point })),
    color: element.color,
    size: element.size,
    opacity: element.opacity,
  };
  const exhaustive: never = element;
  throw new Error(`Unsupported v1 element kind: ${String(exhaustive)}`);
}

async function migratePage(
  context: MigrationContext,
  page: Page,
  notebookId: string,
  sectionId: string,
  documentId: string,
): Promise<PageDoc> {
  const elementsById: Record<string, PageElementV2> = {};
  const zOrder: string[] = [];
  for (const element of page.elements) {
    const migrated = await migrateElement(context, element);
    if (elementsById[migrated.id]) {
      throw new Error(`Page ${page.id} contains duplicate element ${migrated.id}.`);
    }
    elementsById[migrated.id] = migrated;
    zOrder.push(migrated.id);
  }
  const document: PageDoc = {
    schemaVersion: WORKSPACE_SCHEMA_VERSION_V2,
    documentId,
    kind: 'page',
    notebookId,
    sectionId,
    pageId: page.id,
    ...(page.parentPageId ? { parentPageId: page.parentPageId } : {}),
    title: page.title,
    tags: [...(page.tags ?? [])],
    ...(page.taskState ? { taskState: page.taskState } : {}),
    pageType: page.mode,
    background: {
      type: page.background === 'blank'
        ? 'plain'
        : page.background ?? 'grid',
      color: '#fffefa',
    },
    createdAt: page.createdAt,
    updatedAt: page.updatedAt,
    elementsById,
    zOrder,
    version: { ...EMPTY_VERSION, heads: [] },
  };
  context.documents.push(document);
  context.preview.pages += 1;
  return document;
}

async function migrateSection(
  context: MigrationContext,
  section: Section,
  notebookId: string,
  documentPrefix = '',
): Promise<NotebookSectionRef> {
  const pageDocumentIds: string[] = [];
  for (const page of section.pages) {
    const documentId = `${documentPrefix}page:${page.id}`;
    await migratePage(context, page, notebookId, section.id, documentId);
    pageDocumentIds.push(documentId);
  }
  context.preview.sections += 1;
  return {
    id: section.id,
    title: section.title,
    createdAt: section.createdAt,
    updatedAt: section.updatedAt,
    pageDocumentIds,
  };
}

async function migrateNotebook(
  context: MigrationContext,
  notebook: Notebook,
  documentPrefix = '',
): Promise<NotebookDoc> {
  const sections: NotebookSectionRef[] = [];
  for (const section of notebook.sections) {
    sections.push(await migrateSection(context, section, notebook.id, documentPrefix));
  }
  const document: NotebookDoc = {
    schemaVersion: WORKSPACE_SCHEMA_VERSION_V2,
    documentId: `${documentPrefix}notebook:${notebook.id}`,
    kind: 'notebook',
    notebookId: notebook.id,
    title: notebook.title,
    color: notebook.color,
    createdAt: notebook.createdAt,
    updatedAt: notebook.updatedAt,
    sections,
    settings: { defaultPageType: 'free' },
    version: { ...EMPTY_VERSION, heads: [] },
  };
  context.documents.push(document);
  context.preview.notebooks += 1;
  return document;
}

async function migrateTrashEntry(
  context: MigrationContext,
  entry: TrashEntry,
): Promise<TrashRecordV2> {
  const base = {
    id: entry.id,
    kind: entry.kind,
    deletedAt: entry.deletedAt,
    origin: { ...entry.origin },
  };
  const prefix = `trash:${entry.id}:`;
  if (entry.kind === 'notebook' && 'sections' in entry.item) {
    const notebook = await migrateNotebook(context, entry.item, prefix);
    return { ...base, notebookDocumentId: notebook.documentId };
  }
  if (entry.kind === 'section' && 'pages' in entry.item) {
    const notebookId = entry.origin.notebookId ?? `${prefix}notebook`;
    const section = await migrateSection(context, entry.item, notebookId, prefix);
    return { ...base, section };
  }
  if (entry.kind === 'page' && 'elements' in entry.item) {
    const document = await migratePage(
      context,
      entry.item,
      entry.origin.notebookId ?? `${prefix}notebook`,
      entry.origin.sectionId ?? `${prefix}section`,
      `${prefix}page:${entry.item.id}`,
    );
    return { ...base, pageDocumentId: document.documentId };
  }
  if (entry.kind === 'element' && 'kind' in entry.item) {
    return { ...base, element: await migrateElement(context, entry.item) };
  }
  throw new Error(`Trash entry ${entry.id} does not match its declared kind.`);
}

function referencedAssets(element: PageElementV2): AssetRef[] {
  if (element.kind === 'image' || element.kind === 'attachment') return [element.asset];
  if (element.kind === 'pdf') {
    return element.originalAsset
      ? [element.originalAsset, element.previewAsset]
      : [element.previewAsset];
  }
  return [];
}

function artifactProjection(result: Omit<MigrationResultV2, 'artifactFingerprint'>): unknown {
  return {
    manifest: result.manifest,
    documents: result.documents,
    assets: result.assets.map(({ assetId, checksum, size }) => ({ assetId, checksum, size })),
    preview: result.preview,
  };
}

export async function verifyMigrationResult(result: MigrationResultV2): Promise<void> {
  const assets = new Map(result.assets.map((asset) => [asset.assetId, asset]));
  if (assets.size !== result.assets.length) throw new Error('Migration contains duplicate assets.');
  for (const asset of result.assets) {
    if (asset.size !== asset.bytes.byteLength) throw new Error(`Asset ${asset.assetId} has an invalid size.`);
    const actual = await sha256Bytes(asset.bytes);
    if (actual !== asset.checksum || asset.assetId !== asset.checksum) {
      throw new Error(`Asset ${asset.assetId} failed SHA-256 verification.`);
    }
  }

  const documentIds = new Set<string>();
  const allElements: PageElementV2[] = [];
  for (const document of result.documents) {
    if (documentIds.has(document.documentId)) throw new Error(`Duplicate document ${document.documentId}.`);
    documentIds.add(document.documentId);
    if (document.kind === 'page') {
      if (
        typeof document.elementsById !== 'object'
        || document.elementsById === null
        || Array.isArray(document.elementsById)
      ) {
        throw new Error(`Page document ${document.documentId} has an invalid element map.`);
      }
      const elementIds = Object.keys(document.elementsById);
      const orderedIds = new Set(document.zOrder);
      if (orderedIds.size !== document.zOrder.length) {
        throw new Error(`Page document ${document.documentId} has duplicate z-order entries.`);
      }
      if (
        orderedIds.size !== elementIds.length
        || elementIds.some((elementId) => !orderedIds.has(elementId))
      ) {
        throw new Error(`Page document ${document.documentId} element map and z-order disagree.`);
      }
      for (const [elementId, element] of Object.entries(document.elementsById)) {
        if (element.id !== elementId) {
          throw new Error(`Page document ${document.documentId} element key ${elementId} disagrees with its id.`);
        }
        allElements.push(element);
      }
    }
  }
  for (const trash of result.manifest.trash) {
    if (trash.element) allElements.push(trash.element);
  }
  for (const element of allElements) {
    for (const reference of referencedAssets(element)) {
      const asset = assets.get(reference.assetId);
      if (!asset || asset.checksum !== reference.checksum || asset.size !== reference.size) {
        throw new Error(`Asset reference ${reference.assetId} could not be verified.`);
      }
    }
  }

  const expected = await sha256Canonical(artifactProjection(result));
  if (expected !== result.artifactFingerprint) {
    throw new Error('Migration artifact fingerprint verification failed.');
  }
}

export async function prepareV1ToV2Migration(workspace: WorkspaceState): Promise<MigrationResultV2> {
  const snapshot: unknown = structuredClone(workspace);
  assertWorkspaceShape(snapshot);
  const sourceFingerprint = await sha256Canonical(snapshot);
  const context: MigrationContext = {
    documents: [],
    assetsById: new Map(),
    preview: {
      notebooks: 0,
      sections: 0,
      pages: 0,
      elements: 0,
      trashEntries: snapshot.trash.length,
      uniqueAssets: 0,
      extractedAssetBytes: 0,
      previewOnlyPdfs: 0,
    },
  };

  for (const notebook of snapshot.notebooks) await migrateNotebook(context, notebook);
  const trash: TrashRecordV2[] = [];
  for (const entry of snapshot.trash) trash.push(await migrateTrashEntry(context, entry));

  const assets = [...context.assetsById.values()].sort((left, right) =>
    left.assetId.localeCompare(right.assetId),
  );
  context.preview.uniqueAssets = assets.length;
  const notebookDocumentIds = context.documents
    .filter((document) => document.kind === 'notebook')
    .map((document) => document.documentId);
  const pageDocumentIds = context.documents
    .filter((document) => document.kind === 'page')
    .map((document) => document.documentId);
  const migrationId = `workspace-v1-to-v2:${sourceFingerprint.slice('sha256:'.length)}`;
  const prepared = {
    manifest: {
      schemaVersion: WORKSPACE_SCHEMA_VERSION_V2,
      format: 'canvink-schema-v2' as const,
      migration: {
        name: 'workspace-v1-to-v2' as const,
        version: V1_TO_V2_MIGRATION_VERSION,
        migrationId,
        sourceFingerprint,
        preparedAt: snapshot.updatedAt,
      },
      active: {
        notebookId: snapshot.activeNotebookId,
        sectionId: snapshot.activeSectionId,
        pageId: snapshot.activePageId,
      },
      notebookDocumentIds,
      pageDocumentIds,
      assetIds: assets.map((asset) => asset.assetId),
      trash,
    },
    documents: context.documents,
    assets,
    preview: context.preview,
  };
  const result: MigrationResultV2 = {
    ...prepared,
    artifactFingerprint: await sha256Canonical(artifactProjection(prepared)),
  };
  await verifyMigrationResult(result);
  return result;
}

export function migrationResultContainsInlineAssets(result: MigrationResultV2): boolean {
  return /data:[^;,"]+;base64,/i.test(
    canonicalJson({ manifest: result.manifest, documents: result.documents }),
  );
}
