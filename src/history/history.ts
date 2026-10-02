import * as Automerge from '@automerge/automerge';
import { translateNow } from '../i18n/current';
import {
  documentHasHeads,
  getAutomergeConflicts,
  getAutomergeHeads,
  getAutomergeHistory,
  getAutomergeSnapshot,
  getSharedAutomergeSnapshot,
  loadAutomergeDocument,
  projectLiveRichText,
  saveAutomergeDocument,
  type LivePageDocV2,
  type PageAutomergeDoc,
} from '../crdt';
import { sha256Bytes, type PageDoc, type Sha256Checksum } from '../domain/v2';
import { referencedInkSegments } from '../ink/projection';
import { inkSegments } from '../ink/segmentStore';
import type { PageDocV3, PageElementV3 } from '../domain/v3';
import type {
  V2RuntimeState,
  WorkspaceGraphRevisionRequest,
  WorkspaceV2Runtime,
} from '../storage/workspaceV2Runtime';
import {
  DEFAULT_HISTORY_RETENTION,
  type HistoryChangePreview,
  type HistoryRetentionPolicy,
  type HistorySnapshot,
  type HistorySnapshotKind,
  type HistorySnapshotMetadata,
  type HistorySnapshotStore,
  type RestoreHistoryCopyResult,
} from './types';

const MAX_CHECKPOINT_NAME_CHARACTERS = 120;
const MAX_HISTORY_LIST = 100;

export interface HistoryRuntimePort {
  getState(): V2RuntimeState | ReturnType<WorkspaceV2Runtime['getState']>;
  /**
   * Runs `reader` with the page's current Automerge document; a page that is
   * not open is loaded for the reader only. The reader must not keep it.
   */
  readPage<T>(pageId: string, reader: (document: PageAutomergeDoc) => T | Promise<T>): Promise<T>;
  getAsset(assetId: Sha256Checksum): Promise<unknown | undefined>;
  ensureSchemaV3(): Promise<V2RuntimeState>;
  /** Seals strokes drawn a moment ago into their page's document, so a snapshot of its bytes holds them. */
  sealPendingInk?(documentId: string): Promise<unknown>;
  commitWorkspaceGraphRevision(request: WorkspaceGraphRevisionRequest): Promise<V2RuntimeState>;
}

export interface WorkspaceHistoryOptions {
  now?: () => Date;
  idFactory?: () => string;
  deviceId?: string;
  policy?: Partial<HistoryRetentionPolicy>;
}

function randomId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function defaultDeviceId(): string {
  const key = 'canvink:v2-device-id:v1';
  try {
    const existing = globalThis.localStorage?.getItem(key);
    if (existing) return existing;
    const generated = randomId();
    globalThis.localStorage?.setItem(key, generated);
    return generated;
  } catch {
    return `session-${randomId()}`;
  }
}

/**
 * A snapshot holds a page's document, which references its ink by hash; the
 * segments must be available before the snapshot is read, or the ink would
 * silently be missing from a preview or a restored copy.
 */
async function requireInk(document: PageAutomergeDoc): Promise<void> {
  const missing = await inkSegments().ensure(referencedInkSegments(document));
  if (missing.length > 0) {
    throw new Error(`Snapshot ink ${missing[0]} is missing; the snapshot cannot be read.`);
  }
}

export function validateCheckpointName(name: string | undefined): string | undefined {
  if (name === undefined) return undefined;
  const trimmed = name.trim();
  if (
    trimmed.length === 0
    || Array.from(trimmed).length > MAX_CHECKPOINT_NAME_CHARACTERS
    || Array.from(trimmed).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  ) throw new Error(`Checkpoint names must contain 1 to ${MAX_CHECKPOINT_NAME_CHARACTERS} characters.`);
  return trimmed;
}

function pageAssetIds(page: LivePageDocV2): Sha256Checksum[] {
  const ids = new Set<Sha256Checksum>();
  for (const element of Object.values(page.elementsById)) {
    if (element.kind === 'image' || element.kind === 'attachment') ids.add(element.asset.assetId);
    if (element.kind === 'pdf') {
      ids.add(element.previewAsset.assetId);
      if (element.originalAsset) ids.add(element.originalAsset.assetId);
    }
  }
  return [...ids].sort();
}

export function copiedPageProjection(
  document: PageAutomergeDoc,
  pageId: string,
  now: string,
  idFactory: () => string,
  targetSchemaVersion: 2 | 3 = document.schemaVersion,
): PageDoc | PageDocV3 {
  // The snapshot lists every stroke; the raw document only references the segments that hold them.
  const view = getAutomergeSnapshot<LivePageDocV2>(document);
  const elementIds = new Map<string, string>();
  for (const oldId of view.zOrder) elementIds.set(oldId, `element-${idFactory()}`);
  const elementsById: Record<string, PageElementV3> = {};
  for (const oldId of view.zOrder) {
    const element = view.elementsById[oldId];
    const newId = elementIds.get(oldId);
    if (!element || !newId) throw new Error('Snapshot element ordering is corrupt.');
    if (element.kind === 'richText') {
      const { text: _text, ...metadata } = structuredClone(element);
      void _text;
      elementsById[newId] = {
        ...metadata,
        id: newId,
        createdAt: now,
        updatedAt: now,
        content: projectLiveRichText(document, oldId),
      };
    } else {
      const copy: PageElementV3 = {
        ...structuredClone(element),
        id: newId,
        createdAt: now,
        updatedAt: now,
      };
      if (copy.kind === 'math') {
        copy.dependencies.dependsOnElementIds = copy.dependencies.dependsOnElementIds.map((sourceId) => {
          const remapped = elementIds.get(sourceId);
          if (!remapped) throw new Error(`Snapshot math dependency ${sourceId} is missing.`);
          return remapped;
        });
        if (copy.rawInk) {
          const rawIds = new Map(copy.rawInk.sourceStrokes.map((stroke) => [stroke.id, `raw-${idFactory()}`]));
          copy.rawInk.sourceStrokes = copy.rawInk.sourceStrokes.map((stroke) => ({
            ...stroke,
            id: rawIds.get(stroke.id) as string,
            // Omit the key entirely when there is no in-scope source stroke;
            // Automerge rejects an explicit `undefined` and would abort the
            // whole restore of any converted-ink page.
            ...(stroke.sourceStrokeId && rawIds.has(stroke.sourceStrokeId)
              ? { sourceStrokeId: rawIds.get(stroke.sourceStrokeId) as string }
              : {}),
          }));
        }
      } else if (copy.kind === 'graph') {
        copy.series = copy.series.map((series) => {
          const sourceMathElementId = elementIds.get(series.sourceMathElementId);
          if (!sourceMathElementId) throw new Error(`Snapshot graph source ${series.sourceMathElementId} is missing.`);
          return { ...series, id: `series-${idFactory()}`, sourceMathElementId };
        });
      }
      elementsById[newId] = copy;
    }
  }
  const base = {
    schemaVersion: document.schemaVersion,
    documentId: `page:${pageId}`,
    kind: 'page',
    notebookId: document.notebookId,
    sectionId: document.sectionId,
    pageId,
    title: `${document.title} (wiederhergestellt)`,
    tags: structuredClone(document.tags),
    ...(document.taskState ? { taskState: document.taskState } : {}),
    pageType: document.pageType,
    background: structuredClone(document.background),
    createdAt: now,
    updatedAt: now,
    elementsById,
    zOrder: document.zOrder.map((id) => elementIds.get(id) as string),
    version: { protocol: 'uninitialized', heads: [] },
  };
  // A schema-v2 snapshot can be restored into an already-upgraded v3 workspace;
  // v2 and v3 element shapes are compatible and the v3 page settings default
  // when absent, so requesting v3 for a v2 source is a lossless upgrade.
  return targetSchemaVersion === 3
    ? {
      ...base,
      schemaVersion: 3,
      ...(document.mathSettings ? { mathSettings: structuredClone(document.mathSettings) } : {}),
      ...(document.pageContent ? { pageContent: structuredClone(document.pageContent) } : {}),
    } as PageDocV3
    : { ...base, schemaVersion: 2, elementsById: elementsById as PageDoc['elementsById'] } as PageDoc;
}

function sameHeads(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && [...left].sort().every((head, index) => head === [...right].sort()[index]);
}

export class WorkspaceHistory {
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly deviceId: string;
  private readonly policy: HistoryRetentionPolicy;
  /**
   * The newest automatic snapshot of each page this instance has looked at.
   * The automatic check runs after every page change; without this it would
   * list the stored snapshots each time. Only this instance writes automatic
   * snapshots, and it updates the entry when it does (or drops it on delete).
   */
  private readonly latestAutomatic = new Map<string, HistorySnapshotMetadata | undefined>();

  constructor(
    private readonly runtime: HistoryRuntimePort,
    private readonly store: HistorySnapshotStore,
    options: WorkspaceHistoryOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomId;
    this.deviceId = options.deviceId ?? defaultDeviceId();
    this.policy = { ...DEFAULT_HISTORY_RETENTION, ...options.policy };
    if (
      this.policy.automaticIntervalMs < 1
      || this.policy.automaticChangeThreshold < 1
      || this.policy.maxAutomaticPerPage < 1
      || this.policy.maxManualPerPage < 1
      || this.policy.maxTrashPerPage < 1
    ) throw new Error('History retention limits must be positive.');
  }

  list(pageId: string): Promise<HistorySnapshotMetadata[]> {
    return this.store.list(`page:${pageId}`, MAX_HISTORY_LIST);
  }

  createManualCheckpoint(pageId: string, name: string): Promise<HistorySnapshotMetadata> {
    return this.capture(pageId, 'manual', validateCheckpointName(name));
  }

  createTrashCheckpoint(pageId: string): Promise<HistorySnapshotMetadata> {
    return this.capture(pageId, 'trash');
  }

  async captureAutomaticIfDue(pageId: string): Promise<HistorySnapshotMetadata | undefined> {
    if (!this.latestAutomatic.has(pageId)) {
      const automatic = (await this.list(pageId)).filter((item) => item.kind === 'automatic');
      this.latestAutomatic.set(pageId, automatic[0]);
    }
    const latest = this.latestAutomatic.get(pageId);
    const due = await this.runtime.readPage(pageId, async (document) => {
      const heads = getAutomergeHeads(document);
      if (latest && sameHeads(latest.heads, heads)) return false;
      const elapsed = latest ? this.now().getTime() - Date.parse(latest.createdAt) : Infinity;
      if (latest && elapsed < this.policy.automaticIntervalMs) {
        const changesSince = await this.changesSince(latest, document);
        if (changesSince < this.policy.automaticChangeThreshold) return false;
      }
      return true;
    });
    return due ? this.capture(pageId, 'automatic') : undefined;
  }

  /**
   * Changes made after a snapshot. This runs after every page change, so it
   * reads them from the change graph since the snapshot's heads. A snapshot
   * whose heads the current document does not contain (the page was rebuilt
   * into a new document, or replaced by a rewritten copy) counts as infinitely
   * far behind: the next automatic snapshot is taken at once. Comparing both
   * histories change by change instead (the old way) replayed every change of
   * both documents and took 15 s on a page with thousands of strokes, on the
   * main thread, right after the rebuild of that page.
   */
  private async changesSince(
    latest: HistorySnapshotMetadata,
    document: PageAutomergeDoc,
  ): Promise<number> {
    // Not Automerge.hasHeads: it encodes each change it looks up, and this runs
    // after every edit (an imported page is one change of several megabytes).
    if (documentHasHeads(document, latest.heads)) {
      return Automerge.getChangesMetaSince(document, [...latest.heads]).length;
    }
    return Number.POSITIVE_INFINITY;
  }

  async preview(snapshotId: string): Promise<HistoryChangePreview> {
    const snapshot = await this.checkedSnapshot(snapshotId);
    const historical = loadAutomergeDocument(snapshot.bytes, {
      expectedDocumentId: snapshot.documentId,
      expectedKind: 'page',
    }) as PageAutomergeDoc;
    await requireInk(historical);
    const historicalHashes = new Set(getAutomergeHistory(historical).map((entry) => entry.hash));
    let current: {
      title: string;
      later: ReturnType<typeof getAutomergeHistory<LivePageDocV2>>;
      conflicts: number;
      elements: number;
    } | undefined;
    try {
      current = await this.runtime.readPage(snapshot.pageId, (document) => ({
        title: document.title,
        later: getAutomergeHistory(document).filter((entry) => !historicalHashes.has(entry.hash)),
        conflicts: getAutomergeConflicts(document).length,
        elements: getSharedAutomergeSnapshot<LivePageDocV2>(document).zOrder.length,
      }));
    } catch {
      current = undefined;
    }
    const later = current?.later ?? [];
    const { bytes: _bytes, ...metadata } = snapshot;
    void _bytes;
    return {
      snapshot: metadata,
      sourceTitle: historical.title,
      ...(current ? { currentTitle: current.title } : {}),
      changesAfterSnapshot: later.length,
      changeMessages: later.slice(-20).reverse().map((entry) => ({
        actor: entry.actor,
        message: entry.message?.trim() || translateNow('history.change.noMessage'),
        ...(entry.time > 0 ? { time: new Date(entry.time * 1000).toISOString() } : {}),
      })),
      snapshotConflicts: getAutomergeConflicts(historical).length,
      currentConflicts: current?.conflicts ?? 0,
      elementDelta: current ? current.elements - getAutomergeSnapshot<LivePageDocV2>(historical).zOrder.length : 0,
    };
  }

  async restoreAsCopy(snapshotId: string): Promise<RestoreHistoryCopyResult> {
    const snapshot = await this.checkedSnapshot(snapshotId);
    const historical = loadAutomergeDocument(snapshot.bytes, {
      expectedDocumentId: snapshot.documentId,
      expectedKind: 'page',
    }) as PageAutomergeDoc;
    await requireInk(historical);
    for (const assetId of pageAssetIds(historical)) {
      if (!await this.runtime.getAsset(assetId)) {
        throw new Error(`Snapshot asset ${assetId} is missing; restore was not started.`);
      }
    }
    // Upgrade the workspace to v3 before capturing the activation fingerprint.
    // commitWorkspaceGraphRevision upgrades internally, so a fingerprint read
    // beforehand would be stale the instant the transaction runs — which used
    // to make every restore fail and, worse, permanently strand pre-v3
    // snapshots behind a schema-equality check the upgrade could never satisfy.
    const state = await this.runtime.ensureSchemaV3();
    const notebook = state.notebooks.find((item) => item.notebookId === historical.notebookId);
    const section = notebook?.sections.find((item) => item.id === historical.sectionId);
    if (!notebook || !section) {
      throw new Error('The snapshot notebook or section no longer exists; restore was not started.');
    }
    const pageId = `restored-${this.idFactory()}`;
    const now = this.now().toISOString();
    const copy = copiedPageProjection(historical, pageId, now, this.idFactory, 3);
    await this.runtime.commitWorkspaceGraphRevision({
      operationId: `history-restore-${this.idFactory()}`,
      expectedActivationArtifactFingerprint: state.activation.artifactFingerprint,
      message: `Verlaufskopie aus ${snapshot.createdAt}`,
      newDocuments: [copy],
      changes: [{
        documentId: notebook.documentId,
        change: (draft) => {
          if (draft.kind !== 'notebook') throw new Error('History target is not a notebook.');
          const target = draft.sections.find((item) => item.id === historical.sectionId);
          if (!target) throw new Error('History target section changed before restore.');
          const sourceIndex = target.pageDocumentIds.indexOf(snapshot.documentId);
          target.pageDocumentIds.splice(
            sourceIndex < 0 ? target.pageDocumentIds.length : sourceIndex + 1,
            0,
            copy.documentId,
          );
          target.updatedAt = now;
          draft.updatedAt = now;
        },
      }],
      updateManifest: (manifest) => {
        manifest.pageDocumentIds.push(copy.documentId);
        manifest.active = {
          notebookId: copy.notebookId,
          sectionId: copy.sectionId,
          pageId: copy.pageId,
        };
      },
    });
    return { pageId: copy.pageId, documentId: copy.documentId, title: copy.title };
  }

  async delete(snapshotId: string): Promise<boolean> {
    const snapshot = await this.checkedSnapshot(snapshotId);
    this.latestAutomatic.delete(snapshot.pageId);
    return this.store.deleteGuarded(snapshotId, snapshot.checksum);
  }

  private async capture(
    pageId: string,
    kind: HistorySnapshotKind,
    name?: string,
  ): Promise<HistorySnapshotMetadata> {
    if (kind === 'manual') {
      const existing = await this.list(pageId);
      if (existing.filter((item) => item.kind === 'manual').length >= this.policy.maxManualPerPage) {
        throw new Error(`At most ${this.policy.maxManualPerPage} named checkpoints are retained per page.`);
      }
    }
    const documentIdToSeal = this.runtime.getState().schemaVersion === 1
      ? undefined
      : (this.runtime.getState() as V2RuntimeState).pages.find((page) => page.pageId === pageId)?.documentId;
    if (documentIdToSeal) await this.runtime.sealPendingInk?.(documentIdToSeal);
    const { bytes, documentId, heads } = await this.runtime.readPage(pageId, (document) => ({
      bytes: saveAutomergeDocument(document),
      documentId: document.documentId,
      heads: getAutomergeHeads(document),
    }));
    const createdAt = this.now().toISOString();
    const snapshot: HistorySnapshot = {
      version: 1,
      snapshotId: `history-${this.idFactory()}`,
      documentId,
      pageId,
      ...(name ? { name } : {}),
      deviceId: this.deviceId,
      kind,
      heads,
      checksum: await sha256Bytes(bytes),
      size: bytes.byteLength,
      createdAt,
      bytes,
    };
    const stored = await this.store.put(snapshot);
    const confirmed = await this.checkedSnapshot(stored.snapshotId);
    await this.rotate(confirmed.documentId, kind);
    if (kind === 'automatic') this.latestAutomatic.set(pageId, stored);
    return stored;
  }

  private async rotate(documentId: string, kind: HistorySnapshotKind): Promise<void> {
    if (kind === 'manual') return;
    const maximum = kind === 'automatic'
      ? this.policy.maxAutomaticPerPage
      : this.policy.maxTrashPerPage;
    const matching = (await this.store.list(documentId, MAX_HISTORY_LIST))
      .filter((item) => item.kind === kind);
    for (const stale of matching.slice(maximum)) {
      await this.store.deleteGuarded(stale.snapshotId, stale.checksum);
    }
  }

  private async checkedSnapshot(snapshotId: string): Promise<HistorySnapshot> {
    const snapshot = await this.store.get(snapshotId);
    if (!snapshot) throw new Error('History snapshot no longer exists.');
    if (await sha256Bytes(snapshot.bytes) !== snapshot.checksum) {
      throw new Error(`History snapshot ${snapshotId} failed integrity verification.`);
    }
    return snapshot;
  }
}
