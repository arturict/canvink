import * as Automerge from '@automerge/automerge';
import {
  WORKSPACE_SCHEMA_VERSION_V2,
  type CanvinkDocumentV2,
  type NotebookDoc,
  type PageDoc,
  type RichTextDocument,
} from '../domain/v2';
import {
  WORKSPACE_SCHEMA_VERSION_V3,
  assertV3PageMathGraph,
  upgradeDocumentV2ToV3,
  type CanvinkDocumentV3,
  type NotebookDocV3,
  type PageDocV3,
} from '../domain/v3';
import { pendingInkStrokes } from '../ink/pendingInk';
import { projectPageInk, withPendingStrokes, type PlainInkPage } from '../ink/projection';
import { peekInkSegment } from '../ink/segmentStore';
import { seedPortableRichText } from './richText';
import { STROKE_WRITE_FORMAT, hasPackedPoints, revealPageStrokes, storedElement, type StrokeStorageFormat } from './strokeStorage';
import type {
  AutomergeConflict,
  AutomergeConflictValue,
  AutomergeHistoryEntry,
  CanvinkAutomergeDoc,
  ChangeAutomergeDocumentOptions,
  CreateAutomergeDocumentOptions,
  LoadAutomergeDocumentOptions,
  LiveCanvinkDocumentV2,
  LiveNotebookDocV2,
  LivePageDocV2,
  NotebookAutomergeDoc,
  PageAutomergeDoc,
} from './types';

const INITIAL_CHANGE_MESSAGE = 'Initialize Canvink schema-v2 document';
const INITIAL_V3_CHANGE_MESSAGE = 'Initialize Canvink schema-v3 document';
const V2_TO_V3_CHANGE_MESSAGE = 'Upgrade Canvink document schema v2 to v3';
const ACTOR_ID_PATTERN = /^[0-9a-f]{64}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
}

function assertActorId(actorId: string | undefined): void {
  if (actorId !== undefined && !ACTOR_ID_PATTERN.test(actorId)) {
    throw new Error('An Automerge actor ID must be exactly 64 hexadecimal characters.');
  }
}

const PLAIN_ELEMENT_KINDS: ReadonlySet<string> = new Set(['stroke', 'shape', 'image', 'pdf', 'attachment']);

/** Frozen page elements that passed `assertPageElement`, with the key and schema they passed under. */
const validatedElements = new WeakMap<object, { elementId: string; schemaVersion: unknown }>();

/**
 * This is an integrity boundary for binary loads, not a replacement for the
 * domain's full semantic validation.
 */
export function assertCanvinkAutomergeDocument(
  value: unknown,
): asserts value is LiveCanvinkDocumentV2 {
  if (!isRecord(value)) throw new Error('The Automerge root must be an object.');
  if (
    value.schemaVersion !== WORKSPACE_SCHEMA_VERSION_V2
    && value.schemaVersion !== WORKSPACE_SCHEMA_VERSION_V3
  ) {
    throw new Error(`Unsupported Automerge schema version: ${String(value.schemaVersion)}.`);
  }
  assertString(value.documentId, 'documentId');
  if (value.kind !== 'notebook' && value.kind !== 'page') {
    throw new Error(`Unsupported Automerge document kind: ${String(value.kind)}.`);
  }
  if ('version' in value) {
    throw new Error('Automerge heads must remain external to the document root.');
  }

  assertString(value.notebookId, 'notebookId');
  assertString(value.title, 'title');
  if (value.kind === 'notebook') {
    if (!Array.isArray(value.sections)) throw new Error('A notebook must contain a sections array.');
    if (!isRecord(value.settings)) throw new Error('A notebook must contain settings.');
    return;
  }

  assertString(value.sectionId, 'sectionId');
  assertString(value.pageId, 'pageId');
  if (!isRecord(value.elementsById) || !Array.isArray(value.zOrder)) {
    throw new Error('A page must contain an element map and zOrder array.');
  }
  // zOrder and the element map are two CRDT structures, so concurrent edits
  // can leave them out of step: an element one device moves while another
  // erases it stays in zOrder, and two devices moving the same element list
  // it twice. That is a legal merge result, not corruption; readers see the
  // repaired order from `pageDrawOrder` (applied by the snapshot functions).
  if (value.zOrder.some((elementId) => typeof elementId !== 'string')) {
    throw new Error('A page zOrder must contain element IDs.');
  }
  const mathAndGraphElements: Record<string, unknown> = {};
  for (const elementId of Object.keys(value.elementsById)) {
    const element = value.elementsById[elementId];
    if (isRecord(element)) {
      if (element.kind === 'math' || element.kind === 'graph') mathAndGraphElements[elementId] = element;
      // A frozen element is an immutable shared snapshot: once it passed under
      // this key and schema it need not be checked again in the next version.
      // Typing in a text box leaves the other thousands of elements untouched.
      const passed = validatedElements.get(element);
      if (passed?.elementId === elementId && passed.schemaVersion === value.schemaVersion) continue;
    }
    assertPageElement(value.schemaVersion, elementId, element);
    if (isRecord(element) && Object.isFrozen(element)) {
      validatedElements.set(element, { elementId, schemaVersion: value.schemaVersion });
    }
  }
  if (value.schemaVersion === WORKSPACE_SCHEMA_VERSION_V2 && ('mathSettings' in value || 'pageContent' in value)) {
    throw new Error('Schema-v2 pages cannot contain schema-v3 page settings.');
  }
  if (value.schemaVersion === WORKSPACE_SCHEMA_VERSION_V3) {
    // The Math Canvas checks only look at math and graph elements (and at
    // math IDs for the dependencies), so the other elements are left out.
    assertV3PageMathGraph({
      elementsById: mathAndGraphElements,
      ...('mathSettings' in value ? { mathSettings: value.mathSettings } : {}),
      ...('pageContent' in value ? { pageContent: value.pageContent } : {}),
    });
  }
}

function assertPageElement(schemaVersion: unknown, elementId: string, element: unknown): void {
  if (!isRecord(element) || element.id !== elementId) {
    throw new Error(`Page element ${elementId} does not match its stable map key.`);
  }
  if (element.kind === 'richText') {
    if (typeof element.text !== 'string') {
      throw new Error(`Rich-text element ${elementId} must contain a live text string.`);
    }
    if ('content' in element) {
      throw new Error(`Rich-text element ${elementId} duplicates mutable portable content.`);
    }
  } else if (element.kind === 'stroke') {
    if (!Array.isArray(element.points) && !hasPackedPoints(element)) {
      throw new Error(`Stroke element ${elementId} holds neither a point list nor packed points.`);
    }
  } else if (
    !PLAIN_ELEMENT_KINDS.has(String(element.kind))
    && !(schemaVersion === WORKSPACE_SCHEMA_VERSION_V3
      && (element.kind === 'math' || element.kind === 'graph'))
  ) {
    throw new Error(`Page element ${elementId} has unsupported kind ${String(element.kind)}.`);
  }
  if (
    schemaVersion === WORKSPACE_SCHEMA_VERSION_V2
    && (element.kind === 'math' || element.kind === 'graph')
  ) {
    throw new Error(`Schema-v2 page element ${elementId} cannot contain Math Canvas data.`);
  }
}

function liveNotebookFromProjection(document: NotebookDoc | NotebookDocV3): LiveNotebookDocV2 {
  const { version, ...initial } = structuredClone(document);
  void version;
  return initial;
}

function livePageFromProjection(document: PageDoc | PageDocV3, strokeFormat: StrokeStorageFormat): {
  initial: LivePageDocV2;
  richText: Array<{ elementId: string; content: RichTextDocument }>;
} {
  const projected = structuredClone(document);
  const richText: Array<{ elementId: string; content: RichTextDocument }> = [];
  const elementsById: LivePageDocV2['elementsById'] = {};
  for (const [elementId, element] of Object.entries(projected.elementsById)) {
    if (element.kind === 'richText') {
      const { content, ...metadata } = element;
      richText.push({ elementId, content });
      elementsById[elementId] = { ...metadata, text: '' };
    } else {
      // The stored form of a stroke may hold packed samples, which the live
      // element type (the reader-facing shape) does not describe.
      elementsById[elementId] = storedElement(element, strokeFormat) as LivePageDocV2['elementsById'][string];
    }
  }
  const { version: _version, elementsById: _portableElements, ...metadata } = projected;
  void _version;
  void _portableElements;
  return { initial: { ...metadata, elementsById }, richText };
}

function assertSameIdentity(
  before: { readonly documentId: string; readonly kind: LiveCanvinkDocumentV2['kind'] },
  after: { readonly documentId: string; readonly kind: LiveCanvinkDocumentV2['kind'] },
  operation: string,
): void {
  if (after.documentId !== before.documentId || after.kind !== before.kind) {
    throw new Error(`${operation} cannot change documentId or kind.`);
  }
}

function sameHeads(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const leftSorted = [...left].sort();
  const rightSorted = [...right].sort();
  return leftSorted.every((head, index) => head === rightSorted[index]);
}

export function createAutomergeDocument(
  document: CanvinkDocumentV2 | CanvinkDocumentV3,
  options: CreateAutomergeDocumentOptions = {},
): CanvinkAutomergeDoc {
  assertActorId(options.actorId);
  const projected = document.kind === 'page'
    ? livePageFromProjection(document, options.strokeFormat ?? STROKE_WRITE_FORMAT)
    : { initial: liveNotebookFromProjection(document), richText: [] };
  let automergeDocument = Automerge.init<LiveCanvinkDocumentV2>(
    options.actorId === undefined ? undefined : { actor: options.actorId },
  );
  automergeDocument = Automerge.change(
    automergeDocument,
    {
      message: document.schemaVersion === WORKSPACE_SCHEMA_VERSION_V3
        ? INITIAL_V3_CHANGE_MESSAGE
        : INITIAL_CHANGE_MESSAGE,
      time: undefined,
    },
    (draft) => {
      Object.assign(draft, projected.initial);
      if (draft.kind === 'page') {
        for (const { elementId, content } of projected.richText) {
          seedPortableRichText(draft, elementId, content);
        }
      }
    },
  );
  assertCanvinkAutomergeDocument(automergeDocument);
  return automergeDocument;
}

export function createNotebookAutomergeDoc(
  document: NotebookDoc,
  options: CreateAutomergeDocumentOptions = {},
): NotebookAutomergeDoc {
  if (document.kind !== 'notebook') throw new Error('Expected a notebook document.');
  return createAutomergeDocument(document, options) as NotebookAutomergeDoc;
}

export function createPageAutomergeDoc(
  document: PageDoc,
  options: CreateAutomergeDocumentOptions = {},
): PageAutomergeDoc {
  if (document.kind !== 'page') throw new Error('Expected a page document.');
  return createAutomergeDocument(document, options) as PageAutomergeDoc;
}

export function createAutomergeDocumentV3(
  document: CanvinkDocumentV2 | CanvinkDocumentV3,
  options: CreateAutomergeDocumentOptions = {},
): CanvinkAutomergeDoc {
  const projection = document.schemaVersion === WORKSPACE_SCHEMA_VERSION_V3
    ? structuredClone(document)
    : upgradeDocumentV2ToV3(document);
  return createAutomergeDocument(projection, options);
}

export function createNotebookAutomergeDocV3(
  document: NotebookDoc | NotebookDocV3,
  options: CreateAutomergeDocumentOptions = {},
): NotebookAutomergeDoc {
  if (document.kind !== 'notebook') throw new Error('Expected a notebook document.');
  return createAutomergeDocumentV3(document, options) as NotebookAutomergeDoc;
}

export function createPageAutomergeDocV3(
  document: PageDoc | PageDocV3,
  options: CreateAutomergeDocumentOptions = {},
): PageAutomergeDoc {
  if (document.kind !== 'page') throw new Error('Expected a page document.');
  return createAutomergeDocumentV3(document, options) as PageAutomergeDoc;
}

export function upgradeAutomergeDocumentV2ToV3<T extends LiveCanvinkDocumentV2>(
  document: CanvinkAutomergeDoc<T>,
): CanvinkAutomergeDoc<T> {
  assertCanvinkAutomergeDocument(document);
  if (document.schemaVersion === WORKSPACE_SCHEMA_VERSION_V3) return document;
  const changed = Automerge.change<LiveCanvinkDocumentV2>(
    document as CanvinkAutomergeDoc<LiveCanvinkDocumentV2>,
    { message: V2_TO_V3_CHANGE_MESSAGE, time: undefined },
    (draft) => {
      (draft as unknown as { schemaVersion: 2 | 3 }).schemaVersion = WORKSPACE_SCHEMA_VERSION_V3;
    },
  );
  assertCanvinkAutomergeDocument(changed);
  return changed as unknown as CanvinkAutomergeDoc<T>;
}

export function loadAutomergeDocument<
  T extends LiveCanvinkDocumentV2 = LiveCanvinkDocumentV2,
>(
  bytes: Uint8Array,
  options: LoadAutomergeDocumentOptions = {},
): CanvinkAutomergeDoc<T> {
  assertActorId(options.actorId);
  if (bytes.byteLength === 0) throw new Error('Cannot load an empty Automerge document.');
  let document: CanvinkAutomergeDoc<T>;
  try {
    document = Automerge.load<T>(
      bytes,
      options.actorId === undefined ? undefined : { actor: options.actorId },
    );
  } catch (error) {
    throw new Error('The Automerge document bytes could not be loaded.', { cause: error });
  }
  assertCanvinkAutomergeDocument(document);
  if (options.expectedDocumentId !== undefined
      && document.documentId !== options.expectedDocumentId) {
    throw new Error(`Expected document ${options.expectedDocumentId}, received ${document.documentId}.`);
  }
  if (options.expectedKind !== undefined && document.kind !== options.expectedKind) {
    throw new Error(`Expected a ${options.expectedKind} document, received ${document.kind}.`);
  }
  if (
    options.expectedSchemaVersion !== undefined
    && document.schemaVersion !== options.expectedSchemaVersion
  ) {
    throw new Error(
      `Expected schema version ${options.expectedSchemaVersion}, received ${document.schemaVersion}.`,
    );
  }
  return document;
}

export function saveAutomergeDocument(
  document: CanvinkAutomergeDoc,
): Uint8Array {
  assertCanvinkAutomergeDocument(document);
  return Automerge.save(document as Automerge.Doc<unknown>);
}

export function getAutomergeHeads<T extends LiveCanvinkDocumentV2>(
  document: CanvinkAutomergeDoc<T>,
): string[] {
  return [...Automerge.getHeads(document as Automerge.Doc<unknown>)];
}

/**
 * The draw order of a page's elements after concurrent edits: every element
 * exactly once, in zOrder where it is listed (first occurrence wins), ids
 * without an element dropped, and elements zOrder misses on top in map
 * order. Returns the input array itself when it is already consistent.
 */
export function pageDrawOrder(
  zOrder: readonly string[],
  elementsById: Readonly<Record<string, unknown>>,
): readonly string[] {
  const seen = new Set<string>();
  let consistent = true;
  for (const id of zOrder) {
    if (seen.has(id) || !Object.hasOwn(elementsById, id)) consistent = false;
    else seen.add(id);
  }
  const ids = Object.keys(elementsById);
  if (consistent && seen.size === ids.length) return zOrder;
  const order = [...seen];
  for (const id of ids) if (!seen.has(id)) order.push(id);
  return order;
}

/** A page snapshot with its draw order repaired (see `pageDrawOrder`); other documents unchanged. */
export function withPageDrawOrder<T extends LiveCanvinkDocumentV2>(snapshot: T): T {
  if (snapshot.kind !== 'page') return snapshot;
  const page = snapshot as unknown as { zOrder: string[]; elementsById: Record<string, unknown> };
  const order = pageDrawOrder(page.zOrder, page.elementsById);
  if (order === page.zOrder) return snapshot;
  const frozen = Object.isFrozen(snapshot);
  const repaired = { ...snapshot, zOrder: frozen ? Object.freeze([...order]) : [...order] };
  return (frozen ? Object.freeze(repaired) : repaired) as T;
}

export function getAutomergeSnapshot<T extends LiveCanvinkDocumentV2>(
  document: CanvinkAutomergeDoc<T>,
): T {
  const snapshot = revealPageStrokes(Automerge.toJS(document));
  assertCanvinkAutomergeDocument(snapshot);
  return withPageDrawOrder(withInkSegments(snapshot));
}

/**
 * The page with its ink segments expanded into strokes and its pending
 * strokes added (see src/ink/projection.ts); other documents and pages
 * without ink are returned as they are. Segments
 * that are not resident are left out; the runtime makes a page's segments
 * resident before it hands the page out.
 */
export function withInkSegments<T extends LiveCanvinkDocumentV2>(snapshot: T): T {
  if (snapshot.kind !== 'page') return snapshot;
  const projected = projectPageInk(snapshot as unknown as PlainInkPage & T, peekInkSegment);
  return withPendingStrokes(projected as unknown as PlainInkPage & T, pendingInkStrokes(snapshot.documentId));
}

/**
 * Whether every change hash in `heads` is part of `document`. Same answer as
 * `Automerge.hasHeads`, which encodes every change it looks up: an imported
 * page is one change of a few megabytes, so that check alone took most of a
 * second when the page opened.
 */
export function documentHasHeads(
  document: Automerge.Doc<unknown>,
  heads: readonly string[],
): boolean {
  const current = new Set(Automerge.getHeads(document));
  if (heads.every((hash) => current.has(hash))) return true;
  // `getMissingDeps` also lists what changes waiting in the document's queue
  // depend on; only the requested hashes count here.
  const missing = new Set(Automerge.getMissingDeps(document, [...heads]));
  return heads.every((hash) => !missing.has(hash));
}

export function getAutomergeSnapshotAt<T extends LiveCanvinkDocumentV2>(
  document: CanvinkAutomergeDoc<T>,
  heads: readonly string[],
): T {
  if (!documentHasHeads(document, heads)) {
    throw new Error('The requested Automerge heads are not present in this document.');
  }
  const historical = Automerge.view(document, [...heads]);
  const snapshot = revealPageStrokes(Automerge.toJS(historical));
  assertCanvinkAutomergeDocument(snapshot);
  return withPageDrawOrder(withInkSegments(snapshot));
}

export function changeAutomergeDocument<T extends LiveCanvinkDocumentV2>(
  document: CanvinkAutomergeDoc<T>,
  options: ChangeAutomergeDocumentOptions,
  callback: Automerge.ChangeFn<T>,
): CanvinkAutomergeDoc<T> {
  if (!options.message.trim()) throw new Error('An Automerge change requires a message.');
  const beforeHeads = getAutomergeHeads(document);
  if (options.expectedHeads && !sameHeads(beforeHeads, options.expectedHeads)) {
    throw new Error('The Automerge document changed since the expected heads were captured.');
  }
  const changed = Automerge.change(
    document,
    { message: options.message, time: options.time },
    callback,
  );
  assertCanvinkAutomergeDocument(changed);
  assertSameIdentity(document, changed, 'An Automerge change');
  return changed;
}

export function changePageDocument(
  document: PageAutomergeDoc,
  options: ChangeAutomergeDocumentOptions,
  callback: Automerge.ChangeFn<LivePageDocV2>,
): PageAutomergeDoc {
  if (document.kind !== 'page') throw new Error('Expected a page Automerge document.');
  return changeAutomergeDocument(document, options, callback);
}

export function mergeAutomergeDocuments<T extends LiveCanvinkDocumentV2>(
  local: CanvinkAutomergeDoc<T>,
  remote: CanvinkAutomergeDoc<T>,
): CanvinkAutomergeDoc<T> {
  assertSameIdentity(local, remote, 'An Automerge merge');
  const merged = Automerge.merge(local, remote);
  assertCanvinkAutomergeDocument(merged);
  return merged;
}

export function getAutomergeChanges<T extends LiveCanvinkDocumentV2>(
  oldDocument: CanvinkAutomergeDoc<T>,
  newDocument: CanvinkAutomergeDoc<T>,
): Uint8Array[] {
  assertSameIdentity(oldDocument, newDocument, 'Change extraction');
  try {
    return Automerge.getChanges(oldDocument, newDocument).map((change) => change.slice());
  } catch (error) {
    throw new Error('Changes can only be extracted when the old document is an ancestor.', {
      cause: error,
    });
  }
}

export function getAllAutomergeChanges<T extends LiveCanvinkDocumentV2>(
  document: CanvinkAutomergeDoc<T>,
): Uint8Array[] {
  return Automerge.getAllChanges(document).map((change) => change.slice());
}

export function applyAutomergeChanges<T extends LiveCanvinkDocumentV2>(
  document: CanvinkAutomergeDoc<T>,
  changes: readonly Uint8Array[],
): CanvinkAutomergeDoc<T> {
  let changed: CanvinkAutomergeDoc<T>;
  try {
    [changed] = Automerge.applyChanges(
      Automerge.clone(document),
      changes.map((change) => change.slice()),
    );
  } catch (error) {
    throw new Error('The Automerge changes could not be applied.', { cause: error });
  }
  assertCanvinkAutomergeDocument(changed);
  assertSameIdentity(document, changed, 'Applying Automerge changes');
  return changed;
}

export function extractPageChanges(
  oldDocument: PageAutomergeDoc,
  newDocument: PageAutomergeDoc,
): Uint8Array[] {
  if (oldDocument.kind !== 'page' || newDocument.kind !== 'page') {
    throw new Error('Page change extraction requires page documents.');
  }
  return getAutomergeChanges(oldDocument, newDocument);
}

export function applyPageChanges(
  document: PageAutomergeDoc,
  changes: readonly Uint8Array[],
): PageAutomergeDoc {
  if (document.kind !== 'page') throw new Error('Expected a page Automerge document.');
  return applyAutomergeChanges(document, changes);
}

export function getAutomergeHistory<T extends LiveCanvinkDocumentV2>(
  document: CanvinkAutomergeDoc<T>,
): AutomergeHistoryEntry<T>[] {
  return Automerge.getHistory(document).map(({ change, snapshot }) => ({
    actor: change.actor,
    hash: change.hash,
    sequence: change.seq,
    dependencies: [...change.deps],
    message: change.message,
    time: change.time,
    snapshot: withInkSegments(revealPageStrokes(structuredClone(snapshot))),
  }));
}

function copyConflictValue(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return new Date(value.getTime());
  if (value instanceof Uint8Array) return value.slice();
  const prior = seen.get(value);
  if (prior !== undefined) return prior;
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    seen.set(value, result);
    for (const item of value) result.push(copyConflictValue(item, seen));
    return result;
  }
  const result: Record<string, unknown> = {};
  seen.set(value, result);
  for (const [key, child] of Object.entries(value)) {
    result[key] = copyConflictValue(child, seen);
  }
  return result;
}

export function getAutomergeConflicts<T extends LiveCanvinkDocumentV2>(
  document: CanvinkAutomergeDoc<T>,
): AutomergeConflict[] {
  const conflicts: AutomergeConflict[] = [];
  const seen = new WeakSet<object>();

  const visit = (value: unknown, path: Array<string | number>): void => {
    // Byte strings (packed stroke samples) are a single value, not a container.
    if (value === null || typeof value !== 'object' || value instanceof Uint8Array || seen.has(value)) return;
    seen.add(value);
    const entries: Array<[string | number, unknown]> = Array.isArray(value)
      ? value.map((child, index) => [index, child])
      : Object.entries(value);

    for (const [property, child] of entries) {
      const values = Automerge.getConflicts(
        value as Automerge.Doc<Record<string, unknown>>,
        property,
      );
      if (values && Object.keys(values).length > 1) {
        const reportedValues: AutomergeConflictValue[] = Object.entries(values)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([operationId, conflictValue]) => ({
            operationId,
            value: copyConflictValue(conflictValue),
          }));
        conflicts.push({ path: [...path, property], values: reportedValues });
      }
      visit(child, [...path, property]);
    }
  };

  visit(document, []);
  return conflicts;
}
