import { isValidStoredNotebookSettings } from '../domain/notebookSettings';
import type { NotebookDoc, PageDoc, PageElementV2, RichTextBlock, RichTextSpan } from '../domain/v2';
import {
  WORKSPACE_SCHEMA_VERSION_V3,
  assertV3PageMathGraph,
  upgradeDocumentV2ToV3,
  type NotebookDocV3,
  type PageDocV3,
  type PageElementV3,
} from '../domain/v3';

export const PORTABLE_JSON_FORMAT_V3 = 'canvink-portable-json-v3' as const;
const PORTABLE_JSON_FORMAT_V2 = 'canvink-portable-json-v2' as const;

export const CURRENT_SCHEMA_JSON_LIMITS = Object.freeze({
  bytes: 32 * 1024 * 1024,
  pages: 5_000,
  elements: 50_000,
  nodes: 2_000_000,
  stringBytes: 8 * 1024 * 1024,
  rawInkPoints: 1_000_000,
});

export interface PortableWorkspaceJsonV3 {
  format: typeof PORTABLE_JSON_FORMAT_V3;
  schemaVersion: typeof WORKSPACE_SCHEMA_VERSION_V3;
  exportedAt: string;
  notebook: NotebookDocV3;
  pages: PageDocV3[];
}

interface PortableWorkspaceJsonV2 {
  format: typeof PORTABLE_JSON_FORMAT_V2;
  schemaVersion: 2;
  exportedAt: string;
  notebook: NotebookDoc;
  pages: PageDoc[];
}

const encoder = new TextEncoder();
const forbiddenKeys = new Set([
  'token', 'apikey', 'api_key', 'secret', 'endpoint', 'providerconfig', 'provider_config',
  'authorization', 'credentials', 'password', 'bearertoken', 'baseurl',
]);

export function exportCurrentSchemaJson(input: {
  notebook: NotebookDocV3;
  pages: readonly PageDocV3[];
  exportedAt?: string;
}): string {
  const payload: PortableWorkspaceJsonV3 = {
    format: PORTABLE_JSON_FORMAT_V3,
    schemaVersion: WORKSPACE_SCHEMA_VERSION_V3,
    exportedAt: input.exportedAt ?? new Date().toISOString(),
    notebook: structuredClone(input.notebook),
    pages: structuredClone([...input.pages]),
  };
  validateWorkspace(payload);
  const serialized = JSON.stringify(payload);
  if (encoder.encode(serialized).byteLength > CURRENT_SCHEMA_JSON_LIMITS.bytes) {
    throw new Error('Current-schema JSON export exceeds the byte limit.');
  }
  return serialized;
}

export function importCurrentSchemaJson(serialized: string): PortableWorkspaceJsonV3 {
  if (encoder.encode(serialized).byteLength > CURRENT_SCHEMA_JSON_LIMITS.bytes) {
    throw new Error('Current-schema JSON import exceeds the byte limit.');
  }
  let value: unknown;
  try { value = JSON.parse(serialized); } catch { throw new Error('Current-schema JSON is malformed.'); }
  assertRecord(value, 'workspace');
  assertExactKeys(value, ['format', 'schemaVersion', 'exportedAt', 'notebook', 'pages'], 'workspace');
  if (value.format === PORTABLE_JSON_FORMAT_V3 && value.schemaVersion === 3) {
    validateWorkspace(value as unknown as PortableWorkspaceJsonV3);
    return structuredClone(value as unknown as PortableWorkspaceJsonV3);
  }
  if (value.format === PORTABLE_JSON_FORMAT_V2 && value.schemaVersion === 2) {
    validateWorkspace(value as unknown as PortableWorkspaceJsonV2);
    const old = value as unknown as PortableWorkspaceJsonV2;
    const upgraded: PortableWorkspaceJsonV3 = {
      format: PORTABLE_JSON_FORMAT_V3,
      schemaVersion: 3,
      exportedAt: old.exportedAt,
      notebook: upgradeDocumentV2ToV3(old.notebook) as NotebookDocV3,
      pages: old.pages.map((page) => upgradeDocumentV2ToV3(page) as PageDocV3),
    };
    validateWorkspace(upgraded);
    return upgraded;
  }
  throw new Error('Current-schema JSON format or schema version is unsupported.');
}

function validateWorkspace(value: PortableWorkspaceJsonV2 | PortableWorkspaceJsonV3): void {
  scanBudgetsAndSecrets(value);
  assertTimestamp(value.exportedAt, 'exportedAt');
  if (!Array.isArray(value.pages) || value.pages.length > CURRENT_SCHEMA_JSON_LIMITS.pages) {
    throw new Error('Current-schema JSON exceeds the page limit.');
  }
  validateNotebook(value.notebook, value.schemaVersion);
  const sections = new Map(value.notebook.sections.map((section) => [section.id, section]));
  const documentIds = new Set<string>();
  let elements = 0;
  let rawInkPoints = 0;
  for (const page of value.pages) {
    validatePage(page, value.schemaVersion);
    if (page.notebookId !== value.notebook.notebookId || !sections.has(page.sectionId)) {
      throw new Error(`Page ${page.documentId} is outside the exported notebook graph.`);
    }
    if (documentIds.has(page.documentId)) throw new Error('Current-schema JSON contains duplicate page documents.');
    documentIds.add(page.documentId);
    elements += page.zOrder.length;
    if (elements > CURRENT_SCHEMA_JSON_LIMITS.elements) throw new Error('Current-schema JSON exceeds the element limit.');
    for (const element of Object.values(page.elementsById)) {
      if (element.kind === 'math') {
        rawInkPoints += element.rawInk?.sourceStrokes.reduce((sum, stroke) => sum + stroke.points.length, 0) ?? 0;
        if (rawInkPoints > CURRENT_SCHEMA_JSON_LIMITS.rawInkPoints) {
          throw new Error('Current-schema JSON exceeds the aggregate raw-ink point limit.');
        }
      }
    }
  }
  const referenced = value.notebook.sections.flatMap((section) => section.pageDocumentIds);
  if (new Set(referenced).size !== referenced.length
    || referenced.length !== documentIds.size
    || referenced.some((id) => !documentIds.has(id))) {
    throw new Error('Notebook sections and exported pages do not form the same unique graph.');
  }
}

function validateNotebook(value: NotebookDoc | NotebookDocV3, schemaVersion: 2 | 3): void {
  assertRecord(value, 'notebook');
  assertAllowedKeys(value, [
    'schemaVersion', 'documentId', 'kind', 'notebookId', 'title', 'color', 'createdAt',
    'updatedAt', 'sections', 'sectionGroups', 'settings', 'version',
  ], 'notebook');
  for (const required of [
    'schemaVersion', 'documentId', 'kind', 'notebookId', 'title', 'color', 'createdAt',
    'updatedAt', 'sections', 'settings', 'version',
  ]) {
    if (!(required in value)) throw new Error(`notebook is missing required field ${required}.`);
  }
  if (value.schemaVersion !== schemaVersion || value.kind !== 'notebook') throw new Error('Notebook schema is inconsistent.');
  assertIdentifier(value.documentId, 'notebook.documentId');
  assertIdentifier(value.notebookId, 'notebook.notebookId');
  assertTimestamp(value.createdAt, 'notebook.createdAt');
  assertTimestamp(value.updatedAt, 'notebook.updatedAt');
  if (!Array.isArray(value.sections)) throw new Error('Notebook sections must be an array.');
  assertRecord(value.settings, 'notebook.settings');
  if (!isValidStoredNotebookSettings(value.settings)) throw new Error('Notebook settings are malformed.');
  validateSectionGroups(value.sectionGroups);
  const sectionIds = new Set<string>();
  for (const section of value.sections) {
    assertRecord(section, 'section');
    assertAllowedKeys(section, ['id', 'title', 'color', 'groupId', 'createdAt', 'updatedAt', 'pageDocumentIds'], 'section');
    for (const required of ['id', 'title', 'createdAt', 'updatedAt', 'pageDocumentIds']) {
      if (!(required in section)) throw new Error(`section is missing required field ${required}.`);
    }
    // The optional section colour (added without a schema bump) is a plain hex colour.
    if ('color' in section && (typeof section.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(section.color))) {
      throw new Error('Section colour is malformed.');
    }
    if ('groupId' in section) assertIdentifier(section.groupId, 'section.groupId');
    assertIdentifier(section.id, 'section.id');
    if (sectionIds.has(section.id)) throw new Error('Notebook section IDs must be unique.');
    sectionIds.add(section.id);
    assertTimestamp(section.createdAt, 'section.createdAt');
    assertTimestamp(section.updatedAt, 'section.updatedAt');
    if (!Array.isArray(section.pageDocumentIds) || section.pageDocumentIds.some((id) => typeof id !== 'string' || !id)) {
      throw new Error('Section pageDocumentIds are malformed.');
    }
  }
  validateVersion(value.version);
}

/**
 * Section groups were added without a schema bump. Only their shape is
 * checked: a parent or group reference that names no group, or parents that
 * form a cycle (possible after concurrent moves on two devices), are read as
 * the notebook's top level rather than rejected.
 */
function validateSectionGroups(value: unknown): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw new Error('Notebook sectionGroups must be an array.');
  const ids = new Set<string>();
  for (const group of value as unknown[]) {
    assertRecord(group, 'sectionGroup');
    assertAllowedKeys(group, ['id', 'title', 'parentGroupId', 'createdAt', 'updatedAt'], 'sectionGroup');
    for (const required of ['id', 'title', 'createdAt', 'updatedAt']) {
      if (!(required in group)) throw new Error(`sectionGroup is missing required field ${required}.`);
    }
    assertIdentifier(group.id, 'sectionGroup.id');
    if (ids.has(group.id)) throw new Error('Notebook section group IDs must be unique.');
    ids.add(group.id);
    if (typeof group.title !== 'string') throw new Error('Section group title is malformed.');
    assertTimestamp(group.createdAt, 'sectionGroup.createdAt');
    assertTimestamp(group.updatedAt, 'sectionGroup.updatedAt');
    if ('parentGroupId' in group) assertIdentifier(group.parentGroupId, 'sectionGroup.parentGroupId');
  }
}

function validatePage(value: PageDoc | PageDocV3, schemaVersion: 2 | 3): void {
  assertRecord(value, 'page');
  const keys = [
    'schemaVersion', 'documentId', 'kind', 'notebookId', 'sectionId', 'pageId', 'parentPageId',
    'title', 'tags', 'taskState', 'pageType', 'background', 'createdAt', 'updatedAt',
    'elementsById', 'zOrder', 'version', ...(schemaVersion === 3 ? ['mathSettings', 'pageContent', 'paper'] : []),
  ];
  assertAllowedKeys(value, keys, 'page');
  for (const required of keys.filter((key) => !['parentPageId', 'taskState', 'mathSettings', 'pageContent', 'paper'].includes(key))) {
    if (!(required in value)) throw new Error(`page is missing required field ${required}.`);
  }
  if (value.schemaVersion !== schemaVersion || value.kind !== 'page') throw new Error('Page schema is inconsistent.');
  assertIdentifier(value.documentId, 'page.documentId');
  assertIdentifier(value.pageId, 'page.pageId');
  assertTimestamp(value.createdAt, 'page.createdAt');
  assertTimestamp(value.updatedAt, 'page.updatedAt');
  if (!Array.isArray(value.tags) || value.tags.some((tag) => typeof tag !== 'string')) throw new Error('Page tags are malformed.');
  if (value.pageType !== 'free' && value.pageType !== 'a4') throw new Error('Page type is malformed.');
  if (value.taskState !== undefined && value.taskState !== 'open' && value.taskState !== 'done') throw new Error('Page task state is malformed.');
  assertRecord(value.background, 'page.background');
  assertAllowedKeys(value.background, ['type', 'color', 'spacing', 'lineColor', 'lineStrength'], 'page.background');
  if (!['plain', 'lined', 'grid', 'millimeter'].includes(String(value.background.type)) || typeof value.background.color !== 'string') {
    throw new Error('Page background is malformed.');
  }
  // Rule line settings are optional; pages written before them omit them.
  const { spacing, lineColor, lineStrength } = value.background;
  if ((spacing !== undefined && (typeof spacing !== 'number' || !Number.isFinite(spacing) || spacing < 4 || spacing > 400))
    || (lineColor !== undefined && (typeof lineColor !== 'string' || !/^#[0-9a-f]{6}$/i.test(lineColor)))
    || (lineStrength !== undefined && !['light', 'medium', 'strong'].includes(String(lineStrength)))) {
    throw new Error('Page background rule lines are malformed.');
  }
  if ('paper' in value && value.paper !== undefined) {
    const paper: unknown = value.paper;
    if (!isRecord(paper)) throw new Error('Page paper is malformed.');
    assertExactKeys(paper, ['size', 'orientation'], 'page.paper');
    if (!['a4', 'a5', 'letter'].includes(String(paper.size)) || !['portrait', 'landscape'].includes(String(paper.orientation))) {
      throw new Error('Page paper is malformed.');
    }
  }
  validateVersion(value.version);
  if (!Array.isArray(value.zOrder) || !isRecord(value.elementsById)) throw new Error('Page element graph is malformed.');
  const ids = Object.keys(value.elementsById);
  if (new Set(value.zOrder).size !== value.zOrder.length || value.zOrder.length !== ids.length
    || value.zOrder.some((id) => typeof id !== 'string' || !Object.hasOwn(value.elementsById, id))) {
    throw new Error('Page elements and zOrder must contain the same unique IDs.');
  }
  for (const [id, element] of Object.entries(value.elementsById)) {
    if (!isRecord(element) || element.id !== id) throw new Error(`Page element ${id} does not match its map key.`);
    validateElement(element as unknown as PageElementV3, schemaVersion);
  }
  if (schemaVersion === 3) assertV3PageMathGraph(value as PageDocV3);
}

function validateElement(element: PageElementV3, schemaVersion: 2 | 3): void {
  const common = ['id', 'kind', 'frame', 'createdAt', 'updatedAt', 'locked'];
  const fields: Record<PageElementV3['kind'], string[]> = {
    richText: ['content', 'style'], stroke: ['tool', 'points', 'color', 'size', 'opacity', 'tombstonedAt', 'sourceStrokeId'],
    shape: ['shape', 'strokeColor', 'fillColor', 'strokeWidth', 'points'], image: ['asset', 'alt'],
    pdf: ['originalAsset', 'previewAsset', 'pageCount', 'sourcePageNumber', 'sourceAvailability'],
    attachment: ['asset', 'displayName'],
    math: ['inputKind', 'autoRecognition', 'rawInk', 'typedLatex', 'recognizedLatex', 'correctedLatex', 'recognition', 'result', 'dependencies'],
    graph: ['series', 'viewport'],
  };
  if (!(element.kind in fields) || (schemaVersion === 2 && (element.kind === 'math' || element.kind === 'graph'))) {
    throw new Error(`Unsupported page element kind ${String(element.kind)}.`);
  }
  assertAllowedKeys(element as unknown as Record<string, unknown>, [...common, ...fields[element.kind]], `element ${element.id}`);
  for (const key of common) if (!(key in element)) throw new Error(`Element ${element.id} is missing ${key}.`);
  validateFrame(element.frame, `element ${element.id}.frame`);
  assertIdentifier(element.id, `element ${element.id}.id`);
  assertTimestamp(element.createdAt, `element ${element.id}.createdAt`);
  assertTimestamp(element.updatedAt, `element ${element.id}.updatedAt`);
  if (typeof element.locked !== 'boolean') throw new Error(`Element ${element.id} lock state is malformed.`);
  if (element.kind === 'richText') {
    validateRichText(element.content);
    assertRecord(element.style, 'richText style');
    assertExactKeys(element.style, ['color', 'fontFamily', 'fontSize', 'textAlign'], 'richText style');
    if (typeof element.style.color !== 'string' || typeof element.style.fontFamily !== 'string'
      || !Number.isFinite(element.style.fontSize) || !['left', 'center', 'right'].includes(element.style.textAlign)) {
      throw new Error('Rich-text style is malformed.');
    }
  } else if (element.kind === 'stroke') validateStroke(element);
  else if (element.kind === 'shape') {
    if (!['line', 'arrow', 'rectangle', 'ellipse', 'triangle', 'axes'].includes(element.shape)
      || typeof element.strokeColor !== 'string' || !Number.isFinite(element.strokeWidth)) throw new Error('Shape is malformed.');
    element.points?.forEach((point) => validateFinitePoint(point));
  } else if (element.kind === 'image') {
    validateAsset(element.asset);
    if (typeof element.alt !== 'string') throw new Error('Image alt text is malformed.');
  } else if (element.kind === 'attachment') {
    validateAsset(element.asset);
    if (typeof element.displayName !== 'string') throw new Error('Attachment name is malformed.');
  }
  else if (element.kind === 'pdf') {
    validateAsset(element.previewAsset);
    if (element.originalAsset) validateAsset(element.originalAsset);
    if (!Number.isSafeInteger(element.pageCount) || element.pageCount < 1
      || !['original', 'preview-only'].includes(element.sourceAvailability)) throw new Error('PDF element is malformed.');
  }
}

function validateRichText(document: Extract<PageElementV2, { kind: 'richText' }>['content']): void {
  assertRecord(document, 'richText');
  assertExactKeys(document, ['type', 'blocks'], 'richText');
  if (document.type !== 'doc' || !Array.isArray(document.blocks)) throw new Error('Rich text is malformed.');
  document.blocks.forEach(validateBlock);
}

function validateBlock(block: RichTextBlock): void {
  assertRecord(block, 'richText block');
  if (block.type === 'table') {
    assertExactKeys(block, ['id', 'type', 'rows'], 'table block');
    if (!Array.isArray(block.rows)) throw new Error('Rich-text table rows are malformed.');
    block.rows.flat(2).forEach(validateSpan);
  } else {
    const allowed = block.type === 'checkItem' ? ['id', 'type', 'checked', 'spans'] : ['id', 'type', 'level', 'list', 'spans'];
    assertAllowedKeys(block, allowed, 'richText block');
    if (!Array.isArray(block.spans)) throw new Error('Rich-text spans are malformed.');
    block.spans.forEach(validateSpan);
  }
}

function validateSpan(span: RichTextSpan): void {
  assertRecord(span, 'richText span');
  assertExactKeys(span, ['text', 'marks'], 'richText span');
  if (typeof span.text !== 'string' || !Array.isArray(span.marks)) throw new Error('Rich-text span is malformed.');
  for (const mark of span.marks) {
    assertRecord(mark, 'richText mark');
    assertAllowedKeys(mark, ['type', 'href'], 'richText mark');
    if (!['bold', 'italic', 'underline', 'strike', 'inlineCode', 'link'].includes(String(mark.type))
      || (mark.href !== undefined && typeof mark.href !== 'string')) throw new Error('Rich-text mark is malformed.');
  }
}

function validateStroke(stroke: Extract<PageElementV2, { kind: 'stroke' }>): void {
  if (!Array.isArray(stroke.points)) throw new Error('Stroke points are malformed.');
  if (!['pen', 'highlighter'].includes(stroke.tool) || typeof stroke.color !== 'string'
    || !Number.isFinite(stroke.size) || !Number.isFinite(stroke.opacity)) throw new Error('Stroke style is malformed.');
  stroke.points.forEach((point) => {
    assertRecord(point, 'stroke point');
    assertExactKeys(point, ['x', 'y', 'pressure', 'tiltX', 'tiltY', 'time', 'pointerType'], 'stroke point');
    if (![point.x, point.y, point.pressure, point.tiltX, point.tiltY, point.time].every(Number.isFinite)
      || typeof point.pointerType !== 'string') throw new Error('Stroke point is malformed.');
  });
}

function validateAsset(asset: Extract<PageElementV2, { kind: 'image' }>['asset']): void {
  assertRecord(asset, 'asset');
  assertAllowedKeys(asset, ['assetId', 'checksum', 'mimeType', 'size', 'fileName', 'role'], 'asset');
  if (typeof asset.assetId !== 'string' || typeof asset.checksum !== 'string' || typeof asset.mimeType !== 'string'
    || !Number.isSafeInteger(asset.size) || asset.size < 0 || !['original', 'preview'].includes(asset.role)) {
    throw new Error('Asset reference is malformed.');
  }
}

function validateVersion(value: unknown): void {
  assertRecord(value, 'version');
  assertExactKeys(value, ['protocol', 'heads'], 'version');
  if (!['uninitialized', 'automerge'].includes(String(value.protocol)) || !Array.isArray(value.heads)
    || value.heads.length > 1_024 || value.heads.some((head) => typeof head !== 'string')) {
    throw new Error('Document version is malformed.');
  }
}

function scanBudgetsAndSecrets(root: unknown): void {
  let nodes = 0;
  let stringBytes = 0;
  const stack = [root];
  while (stack.length > 0) {
    const value = stack.pop();
    nodes += 1;
    if (nodes > CURRENT_SCHEMA_JSON_LIMITS.nodes) throw new Error('Current-schema JSON exceeds the node limit.');
    if (typeof value === 'string') {
      stringBytes += encoder.encode(value).byteLength;
      if (stringBytes > CURRENT_SCHEMA_JSON_LIMITS.stringBytes) throw new Error('Current-schema JSON exceeds the string budget.');
    } else if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new Error('Current-schema JSON contains a non-finite number.');
    } else if (Array.isArray(value)) stack.push(...value);
    else if (isRecord(value)) {
      for (const [key, child] of Object.entries(value)) {
        if (forbiddenKeys.has(key.toLowerCase())) throw new Error(`Current-schema JSON contains forbidden secret/configuration field ${key}.`);
        stack.push(child);
      }
    }
  }
}

function validateFrame(value: unknown, label: string): void {
  assertRecord(value, label);
  assertExactKeys(value, ['x', 'y', 'width', 'height', 'rotation'], label);
  if (![value.x, value.y, value.width, value.height, value.rotation].every(Number.isFinite)
    || (value.width as number) < 0 || (value.height as number) < 0) throw new Error(`${label} is malformed.`);
}

function validateFinitePoint(value: unknown): void {
  assertRecord(value, 'point');
  assertExactKeys(value, ['x', 'y'], 'point');
  if (![value.x, value.y].every(Number.isFinite)) throw new Error('Point is malformed.');
}

function assertTimestamp(value: unknown, label: string): void {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw new Error(`${label} is not a timestamp.`);
}

function assertIdentifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || encoder.encode(value).byteLength > 256) {
    throw new Error(`${label} is not a bounded identifier.`);
  }
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
}

function assertExactKeys(value: Record<string, unknown>, names: readonly string[], label: string): void {
  assertAllowedKeys(value, names, label);
  if (names.some((name) => !(name in value))) throw new Error(`${label} is missing required fields.`);
}

function assertAllowedKeys(value: Record<string, unknown>, names: readonly string[], label: string): void {
  const allowed = new Set(names);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`${label} contains unsupported field ${unknown}.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
