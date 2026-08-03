import {
  MAX_ASSET_DATA_URL_CHARS,
  MAX_IMAGE_PIXELS,
  MAX_PDF_PAGES,
  MAX_PAGE_DEPTH,
  MAX_POINTS_PER_STROKE,
  MAX_TEXT_CHARS,
  MAX_TITLE_BYTES,
  MAX_WORKSPACE_ESTIMATED_BYTES,
} from './limits';
import { utf8ByteLength } from './strings';
import type { WorkspaceState } from './types';

const MAX_ID_CHARS = 256;
const MAX_SHORT_STRING_CHARS = 64 * 1024;
const MAX_COORDINATE = 10_000_000;
const MAX_NOTEBOOKS = 10_000;
const MAX_SECTIONS = 100_000;
const MAX_PAGES = 1_000_000;
const MAX_ELEMENTS = 5_000_000;
const MAX_TRASH_ENTRIES = 1_000_000;
const MAX_TOTAL_POINTS = 10_000_000;
const MAX_STRUCTURE_NODES = 20_000_000;
const MAX_CHECKLIST_ITEMS = 200;
const PAGE_TAGS = new Set(['important', 'todo', 'question', 'idea']);

type JsonRecord = Record<string, unknown>;

interface ValidationBudget {
  entityIds: Set<string>;
  notebooks: number;
  sections: number;
  pages: number;
  elements: number;
  points: number;
}

function malformed(message: string): never {
  throw new Error(`Stored Canvink data is malformed: ${message}. It was not changed.`);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown, path: string): JsonRecord {
  if (!isRecord(value)) malformed(`${path} must be an object`);
  return value;
}

function stringValue(
  value: unknown,
  path: string,
  maxLength = MAX_SHORT_STRING_CHARS,
  allowEmpty = true,
): string {
  if (
    typeof value !== 'string' ||
    value.length > maxLength ||
    (!allowEmpty && value.length === 0)
  ) {
    malformed(`${path} must be a bounded string`);
  }
  return value;
}

function utf8StringValue(
  value: unknown,
  path: string,
  maxBytes: number,
  allowEmpty = true,
): string {
  const text = stringValue(value, path, maxBytes, allowEmpty);
  if (text.includes('\0')) {
    malformed(`${path} must not contain NUL`);
  }
  if (utf8ByteLength(text) > maxBytes) {
    malformed(`${path} exceeds the ${maxBytes}-byte UTF-8 limit`);
  }
  return text;
}

function finiteNumber(
  value: unknown,
  path: string,
  minimum = -MAX_COORDINATE,
  maximum = MAX_COORDINATE,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  ) {
    malformed(`${path} must be a finite number`);
  }
  return value;
}

function positiveDimension(value: unknown, path: string): number {
  return finiteNumber(value, path, 0.01, MAX_COORDINATE);
}

function integerValue(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    malformed(`${path} must be a bounded integer`);
  }
  return value;
}

function entityId(
  value: unknown,
  path: string,
  budget: ValidationBudget,
): string {
  const id = utf8StringValue(value, path, MAX_ID_CHARS, false);
  if (budget.entityIds.has(id)) malformed(`${path} duplicates another entity ID`);
  budget.entityIds.add(id);
  return id;
}

function timestamp(value: unknown, path: string): void {
  utf8StringValue(value, path, 256, false);
}

function assertDataUrl(
  value: unknown,
  path: string,
  allowedMimeTypes: string[],
): void {
  const dataUrl = stringValue(value, path, MAX_ASSET_DATA_URL_CHARS, false);
  const mime = allowedMimeTypes.join('|').replaceAll('+', '\\+');
  if (!new RegExp(`^data:(?:${mime});base64,`, 'i').test(dataUrl)) {
    malformed(`${path} has an unsupported media type`);
  }
}

function validateElement(
  value: unknown,
  path: string,
  budget: ValidationBudget,
): void {
  const element = record(value, path);
  budget.elements += 1;
  if (budget.elements > MAX_ELEMENTS) malformed('workspace has too many elements');

  entityId(element.id, `${path}.id`, budget);
  const kind = stringValue(element.kind, `${path}.kind`, 32, false);
  finiteNumber(element.x, `${path}.x`);
  finiteNumber(element.y, `${path}.y`);
  timestamp(element.createdAt, `${path}.createdAt`);
  timestamp(element.updatedAt, `${path}.updatedAt`);

  if (kind === 'stroke') {
    if (element.tool !== 'pen' && element.tool !== 'highlighter') {
      malformed(`${path}.tool is unsupported`);
    }
    if (!Array.isArray(element.points) || element.points.length === 0) {
      malformed(`${path}.points must contain samples`);
    }
    if (element.points.length > MAX_POINTS_PER_STROKE) {
      malformed(`${path}.points has too many samples`);
    }
    budget.points += element.points.length;
    if (budget.points > MAX_TOTAL_POINTS) malformed('workspace has too many ink samples');
    element.points.forEach((pointValue, index) => {
      const point = record(pointValue, `${path}.points[${index}]`);
      finiteNumber(point.x, `${path}.points[${index}].x`);
      finiteNumber(point.y, `${path}.points[${index}].y`);
      finiteNumber(point.pressure, `${path}.points[${index}].pressure`, -10, 10);
      finiteNumber(point.tiltX, `${path}.points[${index}].tiltX`, -180, 180);
      finiteNumber(point.tiltY, `${path}.points[${index}].tiltY`, -180, 180);
      finiteNumber(
        point.time,
        `${path}.points[${index}].time`,
        -MAX_COORDINATE * MAX_COORDINATE,
        MAX_COORDINATE * MAX_COORDINATE,
      );
      stringValue(point.pointerType, `${path}.points[${index}].pointerType`, 32);
    });
    stringValue(element.color, `${path}.color`, 128, false);
    finiteNumber(element.size, `${path}.size`, 0.1, 1_000);
    finiteNumber(element.opacity, `${path}.opacity`, 0, 1);
    return;
  }

  if (kind === 'text') {
    stringValue(element.text, `${path}.text`, MAX_TEXT_CHARS);
    positiveDimension(element.width, `${path}.width`);
    positiveDimension(element.height, `${path}.height`);
    stringValue(element.color, `${path}.color`, 128, false);
    finiteNumber(element.fontSize, `${path}.fontSize`, 8, 120);
    stringValue(element.fontFamily, `${path}.fontFamily`, 1_024, false);
    if (![400, 500, 600, 700].includes(Number(element.fontWeight))) {
      malformed(`${path}.fontWeight is unsupported`);
    }
    if (
      element.fontStyle !== undefined &&
      element.fontStyle !== 'normal' &&
      element.fontStyle !== 'italic'
    ) {
      malformed(`${path}.fontStyle is unsupported`);
    }
    if (
      element.textDecoration !== undefined &&
      !['none', 'underline', 'line-through'].includes(
        String(element.textDecoration),
      )
    ) {
      malformed(`${path}.textDecoration is unsupported`);
    }
    if (
      element.textAlign !== undefined &&
      !['left', 'center', 'right'].includes(String(element.textAlign))
    ) {
      malformed(`${path}.textAlign is unsupported`);
    }
    if (
      element.listStyle !== undefined &&
      !['none', 'bullet', 'numbered'].includes(String(element.listStyle))
    ) {
      malformed(`${path}.listStyle is unsupported`);
    }
    return;
  }

  if (kind === 'checklist') {
    positiveDimension(element.width, `${path}.width`);
    positiveDimension(element.height, `${path}.height`);
    stringValue(element.color, `${path}.color`, 128, false);
    finiteNumber(element.fontSize, `${path}.fontSize`, 8, 120);
    if (
      !Array.isArray(element.items) ||
      element.items.length === 0 ||
      element.items.length > MAX_CHECKLIST_ITEMS
    ) {
      malformed(`${path}.items must contain between 1 and ${MAX_CHECKLIST_ITEMS} items`);
    }
    const itemIds = new Set<string>();
    let textCharacters = 0;
    element.items.forEach((itemValue, index) => {
      const item = record(itemValue, `${path}.items[${index}]`);
      const itemId = utf8StringValue(
        item.id,
        `${path}.items[${index}].id`,
        MAX_ID_CHARS,
        false,
      );
      if (itemIds.has(itemId)) {
        malformed(`${path}.items duplicates an item ID`);
      }
      itemIds.add(itemId);
      const text = stringValue(
        item.text,
        `${path}.items[${index}].text`,
        MAX_SHORT_STRING_CHARS,
      );
      textCharacters += text.length;
      if (textCharacters > MAX_TEXT_CHARS) {
        malformed(`${path}.items contains too much text`);
      }
      if (typeof item.checked !== 'boolean') {
        malformed(`${path}.items[${index}].checked must be a boolean`);
      }
    });
    return;
  }

  if (kind === 'image') {
    assertDataUrl(element.dataUrl, `${path}.dataUrl`, [
      'image/png',
      'image/jpeg',
      'image/webp',
      'image/gif',
    ]);
    stringValue(element.name, `${path}.name`, MAX_SHORT_STRING_CHARS, false);
    stringValue(element.alt, `${path}.alt`, MAX_SHORT_STRING_CHARS);
    const width = positiveDimension(element.width, `${path}.width`);
    const height = positiveDimension(element.height, `${path}.height`);
    if (width * height > MAX_IMAGE_PIXELS) malformed(`${path} has too many pixels`);
    return;
  }

  if (kind === 'pdf') {
    assertDataUrl(element.previewDataUrl, `${path}.previewDataUrl`, [
      'image/png',
      'image/jpeg',
      'image/webp',
    ]);
    stringValue(element.sourceName, `${path}.sourceName`, MAX_SHORT_STRING_CHARS, false);
    integerValue(element.pageCount, `${path}.pageCount`, 1, MAX_PDF_PAGES);
    const width = positiveDimension(element.width, `${path}.width`);
    const height = positiveDimension(element.height, `${path}.height`);
    if (width * height > MAX_IMAGE_PIXELS) malformed(`${path} preview has too many pixels`);
    return;
  }

  malformed(`${path}.kind is unsupported`);
}

function validatePage(
  value: unknown,
  path: string,
  budget: ValidationBudget,
): string {
  const page = record(value, path);
  budget.pages += 1;
  if (budget.pages > MAX_PAGES) malformed('workspace has too many pages');

  const id = entityId(page.id, `${path}.id`, budget);
  if (page.parentPageId !== undefined) {
    utf8StringValue(page.parentPageId, `${path}.parentPageId`, MAX_ID_CHARS, false);
  }
  utf8StringValue(page.title, `${path}.title`, MAX_TITLE_BYTES);
  if (page.tags !== undefined) {
    if (!Array.isArray(page.tags) || page.tags.length > PAGE_TAGS.size) {
      malformed(`${path}.tags must be a bounded array`);
    }
    const tags = new Set<string>();
    page.tags.forEach((tag, index) => {
      if (typeof tag !== 'string' || !PAGE_TAGS.has(tag) || tags.has(tag)) {
        malformed(`${path}.tags[${index}] is unsupported or duplicated`);
      }
      tags.add(tag);
    });
  }
  if (
    page.taskState !== undefined &&
    page.taskState !== 'open' &&
    page.taskState !== 'done'
  ) {
    malformed(`${path}.taskState is unsupported`);
  }
  if (page.mode !== 'free' && page.mode !== 'a4') {
    malformed(`${path}.mode is unsupported`);
  }
  timestamp(page.createdAt, `${path}.createdAt`);
  timestamp(page.updatedAt, `${path}.updatedAt`);
  if (!Array.isArray(page.elements)) malformed(`${path}.elements must be an array`);
  page.elements.forEach((element, index) =>
    validateElement(element, `${path}.elements[${index}]`, budget),
  );
  return id;
}

function validatePages(
  values: unknown,
  path: string,
  budget: ValidationBudget,
): void {
  if (!Array.isArray(values)) malformed(`${path} must be an array`);
  if (values.length === 0) malformed(`${path} must contain at least one page`);
  const pages = values.map((page, index) => {
    const id = validatePage(page, `${path}[${index}]`, budget);
    return { id, value: record(page, `${path}[${index}]`) };
  });
  const pageIds = new Set(pages.map((page) => page.id));
  const parents = new Map<string, string>();
  for (const page of pages) {
    if (typeof page.value.parentPageId !== 'string') continue;
    if (
      page.value.parentPageId === page.id ||
      !pageIds.has(page.value.parentPageId)
    ) {
      malformed(`${path} contains an invalid parentPageId`);
    }
    parents.set(page.id, page.value.parentPageId);
  }
  const depths = new Map<string, number>();
  for (const page of pages) {
    if (depths.has(page.id)) continue;

    const chain: string[] = [];
    const currentChain = new Set<string>();
    let currentId = page.id;
    let baseDepth = -1;

    while (true) {
      const knownDepth = depths.get(currentId);
      if (knownDepth !== undefined) {
        baseDepth = knownDepth;
        break;
      }
      if (currentChain.has(currentId)) {
        malformed(`${path} contains a page-parent cycle`);
      }

      currentChain.add(currentId);
      chain.push(currentId);
      if (chain.length > MAX_PAGE_DEPTH + 1) {
        malformed(`${path} exceeds the ${MAX_PAGE_DEPTH}-level page hierarchy limit`);
      }

      const parentId = parents.get(currentId);
      if (parentId === undefined) break;
      currentId = parentId;
    }

    for (let index = chain.length - 1; index >= 0; index -= 1) {
      baseDepth += 1;
      if (baseDepth > MAX_PAGE_DEPTH) {
        malformed(`${path} exceeds the ${MAX_PAGE_DEPTH}-level page hierarchy limit`);
      }
      depths.set(chain[index], baseDepth);
    }
  }
}

function validateSection(
  value: unknown,
  path: string,
  budget: ValidationBudget,
): void {
  const section = record(value, path);
  budget.sections += 1;
  if (budget.sections > MAX_SECTIONS) malformed('workspace has too many sections');
  entityId(section.id, `${path}.id`, budget);
  utf8StringValue(section.title, `${path}.title`, MAX_TITLE_BYTES);
  timestamp(section.createdAt, `${path}.createdAt`);
  timestamp(section.updatedAt, `${path}.updatedAt`);
  validatePages(section.pages, `${path}.pages`, budget);
}

function validateNotebook(
  value: unknown,
  path: string,
  budget: ValidationBudget,
): void {
  const notebook = record(value, path);
  budget.notebooks += 1;
  if (budget.notebooks > MAX_NOTEBOOKS) malformed('workspace has too many notebooks');
  entityId(notebook.id, `${path}.id`, budget);
  utf8StringValue(notebook.title, `${path}.title`, MAX_TITLE_BYTES);
  stringValue(notebook.color, `${path}.color`, 128, false);
  timestamp(notebook.createdAt, `${path}.createdAt`);
  timestamp(notebook.updatedAt, `${path}.updatedAt`);
  if (!Array.isArray(notebook.sections)) malformed(`${path}.sections must be an array`);
  if (notebook.sections.length === 0) {
    malformed(`${path}.sections must contain at least one section`);
  }
  notebook.sections.forEach((section, index) =>
    validateSection(section, `${path}.sections[${index}]`, budget),
  );
}

function validateTrashEntry(
  value: unknown,
  path: string,
  budget: ValidationBudget,
): void {
  const entry = record(value, path);
  entityId(entry.id, `${path}.id`, budget);
  timestamp(entry.deletedAt, `${path}.deletedAt`);
  const origin = record(entry.origin, `${path}.origin`);
  for (const field of [
    'notebookId',
    'sectionId',
    'pageId',
    'originalParentPageId',
    'previousSiblingId',
    'nextSiblingId',
  ]) {
    if (origin[field] !== undefined) {
      utf8StringValue(origin[field], `${path}.origin.${field}`, MAX_ID_CHARS, false);
    }
  }
  if (origin.index !== undefined) {
    integerValue(origin.index, `${path}.origin.index`, 0, MAX_STRUCTURE_NODES);
  }
  if (origin.childPageIds !== undefined) {
    if (
      !Array.isArray(origin.childPageIds) ||
      origin.childPageIds.length > MAX_PAGES
    ) {
      malformed(`${path}.origin.childPageIds must be a bounded array`);
    }
    origin.childPageIds.forEach((id, index) =>
      utf8StringValue(
        id,
        `${path}.origin.childPageIds[${index}]`,
        MAX_ID_CHARS,
        false,
      ),
    );
  }

  if (entry.kind === 'notebook') {
    validateNotebook(entry.item, `${path}.item`, budget);
  } else if (entry.kind === 'section') {
    validateSection(entry.item, `${path}.item`, budget);
  } else if (entry.kind === 'page') {
    validatePage(entry.item, `${path}.item`, budget);
  } else if (entry.kind === 'element') {
    validateElement(entry.item, `${path}.item`, budget);
  } else {
    malformed(`${path}.kind is unsupported`);
  }
}

export function assertWorkspaceWithinBudget(value: unknown): void {
  const stack: unknown[] = [value];
  const seen = new WeakSet<object>();
  let estimatedBytes = 0;
  let nodes = 0;

  while (stack.length > 0) {
    const current = stack.pop();
    nodes += 1;
    if (nodes > MAX_STRUCTURE_NODES) malformed('workspace has too many values');
    if (typeof current === 'string') {
      estimatedBytes += current.length * 3;
    } else if (typeof current === 'number' || typeof current === 'boolean') {
      estimatedBytes += 16;
    } else if (current && typeof current === 'object') {
      if (seen.has(current)) malformed('workspace contains a cyclic value');
      seen.add(current);
      if (Array.isArray(current)) {
        for (const child of current) stack.push(child);
      } else {
        for (const [key, child] of Object.entries(current)) {
          estimatedBytes += key.length * 3;
          stack.push(child);
        }
      }
    }
    if (estimatedBytes > MAX_WORKSPACE_ESTIMATED_BYTES) {
      malformed('workspace exceeds the safe size limit');
    }
  }
}

export function assertWorkspaceShape(value: unknown): asserts value is WorkspaceState {
  assertWorkspaceWithinBudget(value);
  const workspace = record(value, 'workspace');
  timestamp(workspace.updatedAt, 'workspace.updatedAt');
  utf8StringValue(workspace.activeNotebookId, 'workspace.activeNotebookId', MAX_ID_CHARS);
  utf8StringValue(workspace.activeSectionId, 'workspace.activeSectionId', MAX_ID_CHARS);
  utf8StringValue(workspace.activePageId, 'workspace.activePageId', MAX_ID_CHARS);

  if (!Array.isArray(workspace.notebooks)) {
    malformed('workspace.notebooks must be an array');
  }
  if (!Array.isArray(workspace.trash)) {
    malformed('workspace.trash must be an array');
  }
  if (workspace.trash.length > MAX_TRASH_ENTRIES) {
    malformed('workspace has too many trash entries');
  }

  const budget: ValidationBudget = {
    entityIds: new Set(),
    notebooks: 0,
    sections: 0,
    pages: 0,
    elements: 0,
    points: 0,
  };
  workspace.notebooks.forEach((notebook, index) =>
    validateNotebook(notebook, `workspace.notebooks[${index}]`, budget),
  );
  workspace.trash.forEach((entry, index) =>
    validateTrashEntry(entry, `workspace.trash[${index}]`, budget),
  );

  const typedWorkspace = workspace as unknown as WorkspaceState;
  const activeNotebook = typedWorkspace.notebooks.find(
    (notebook) => notebook.id === typedWorkspace.activeNotebookId,
  );
  const activeSection = activeNotebook?.sections.find(
    (section) => section.id === typedWorkspace.activeSectionId,
  );
  const activePage = activeSection?.pages.find(
    (page) => page.id === typedWorkspace.activePageId,
  );
  if (!activeNotebook || !activeSection || !activePage) {
    malformed('active notebook, section, and page IDs must reference one usable page');
  }
}
