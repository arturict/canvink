import {
  Repo,
  isValidAutomergeUrl,
  type AutomergeUrl,
  type StorageAdapterInterface,
  type StorageKey,
} from "@automerge/automerge-repo";
import type { ChangeFn } from "@automerge/automerge";
import { createStore, get, setMany } from "idb-keyval";
import {
  assertCanvinkAutomergeDocument,
  getAutomergeHeads,
  getAutomergeSnapshot,
  getAutomergeSnapshotAt,
  materializeMigrationAsAutomerge,
} from "../crdt";
import type { CanvinkAutomergeDoc, LiveCanvinkDocumentV2 } from "../crdt";
import type { WorkspaceState } from "../domain/types";
import { assertWorkspaceShape } from "../domain/validation";
import { canonicalJson, sameCanonicalJson, sha256Bytes, sha256Canonical } from "../domain/v2/hash";
import { createYieldBudget } from "../performance/yield";
import {
  prepareV1ToV2Migration,
  verifyMigrationResult,
} from "../domain/v2/migration";
import type {
  AssetBlob,
  CanvinkDocumentV2,
  MigrationManifestV2,
  MigrationPreviewV2,
  MigrationResultV2,
  Sha256Checksum,
  StoredDocumentV2,
} from "../domain/v2/types";
import type { StoredCanvinkDocument, WorkspaceManifestV3 } from "../domain/v3";
import {
  atomicStorageIdbKey,
  type AtomicKeyValueStore,
  type AtomicStorageKey,
} from "./browserAssetStore";
import {
  loadRecoveryDraft,
  recoveryDraftDiffersFrom,
  type RecoveryDraft,
} from "./recoveryJournal";
import { loadWorkspace, type StorageBackend } from "./workspaceStorage";

const DATABASE_NAME = "canvink-v2";
const STORE_NAME = "documents-assets";
const ACTIVATION_KEY = "activation:v2";
const ACTIVATION_VERSION = 1 as const;
const BACKUP_VERSION = 1 as const;

export type MigrationPhase =
  | "idle"
  | "loading-v1"
  | "checking-recovery"
  | "backing-up-v1"
  | "preparing-v2"
  | "staging-assets"
  | "staging-documents"
  | "verifying-stage"
  | "activating-v2"
  | "active-v2"
  | "indexing-pages"
  | "aborted"
  | "failed";

export interface MigrationProgress {
  phase: MigrationPhase;
  completed: number;
  total: number;
  authoritative: "v1" | "v2";
  resumed: boolean;
  message: string;
}

export interface V1BackupRecord {
  version: typeof BACKUP_VERSION;
  migrationId: string;
  sourceFingerprint: Sha256Checksum;
  createdAt: string;
  workspace: WorkspaceState;
}

export interface RepoChunkV2 {
  key: StorageKey;
  bytes: Uint8Array;
}

export interface RepoChunkDescriptorV2 {
  key: StorageKey;
  checksum: Sha256Checksum;
  size: number;
}

export interface ActivatedDocumentV2 {
  documentId: string;
  kind: CanvinkDocumentV2["kind"];
  url: string;
  heads: string[];
}

/**
 * Compatibility name for the active Automerge authority selector. Schema v2
 * remains readable; all v0.2 writers upgrade it atomically to schema v3.
 */
export interface V2ActivationRecord {
  version: typeof ACTIVATION_VERSION;
  schemaVersion: 2 | 3;
  format: "canvink-automerge-v2" | "canvink-automerge-v3";
  migrationId: string;
  sourceFingerprint: Sha256Checksum;
  artifactFingerprint: Sha256Checksum;
  activatedAt: string;
  manifest: MigrationManifestV2 | WorkspaceManifestV3;
  documents: ActivatedDocumentV2[];
  chunks: RepoChunkDescriptorV2[];
  assetIds: Sha256Checksum[];
  /**
   * Absent on activations written by complete-image commits, whose `chunks`
   * describe a full copy of the Repo image (the browser keeps it under
   * `repo-chunk:<n>`). `repo-live` marks an activation written by a delta
   * commit: only the documents a commit touched were written, `chunks`
   * describes the live Repo keys of those writes (carried over for untouched
   * documents), and no committed copy exists. Every document's integrity is
   * anchored by its `heads`, which the live document must contain when it is
   * loaded.
   */
  layout?: "repo-live";
}

/** A physical, namespaced storage key and its bytes, e.g. `['automerge-repo', id, 'snapshot', hash]`. */
export interface WorkspaceStorageEntry {
  key: readonly string[];
  bytes: Uint8Array;
}

/** Namespaces a delta commit may write or remove. */
export const DELTA_STORAGE_NAMESPACES = Object.freeze([
  "automerge-repo",
  "canvink-page-index",
  "canvink-dirty",
] as const);

/**
 * A topology or import commit that writes only what changed. `entries` hold
 * the new Repo chunks of new or changed documents plus their page index
 * entries; `removedPrefixes` drop removed documents (and obsolete index or
 * dirty markers). The replacement activation is published in the same
 * transaction, guarded by a compare-and-swap on the expected activation.
 */
export interface V2WorkspaceDeltaCommit {
  expectedActivation: V2ActivationRecord;
  activation: V2ActivationRecord;
  assets: AssetBlob[];
  entries: WorkspaceStorageEntry[];
  removedPrefixes: string[][];
  /** Present for an additive import; its `rollback` names what a rollback removes. */
  receipt?: V2WorkspaceImportReceipt;
}

export interface V2AtomicCommit {
  backup: V1BackupRecord;
  activation: V2ActivationRecord;
  assets: AssetBlob[];
  chunks: RepoChunkV2[];
}

export interface V2CommittedPayload {
  backup: V1BackupRecord;
  assets: AssetBlob[];
  chunks: RepoChunkV2[];
}

export interface V2WorkspaceImportReceipt {
  version: 1;
  importId: string;
  importArtifactFingerprint: Sha256Checksum;
  priorActivationArtifactFingerprint: Sha256Checksum;
  committedActivationArtifactFingerprint: Sha256Checksum;
  backupId: string;
  notebookDocumentId: string;
  pageDocumentIds: string[];
  assetIds: Sha256Checksum[];
  preparedAt: string;
  status: "committed" | "rolled-back";
  /**
   * Written by delta imports. A rollback removes exactly these physical key
   * prefixes (the imported documents and their index entries) and restores
   * the prior activation; documents that existed before the import are not
   * touched, so edits made to them after the import survive the rollback.
   * Absent on complete-image imports, whose rollback restores a stored copy
   * of the prior Repo image.
   */
  rollback?: { mode: "remove-prefixes"; prefixes: string[][] };
}

export interface V2WorkspaceExtensionCommit {
  expectedActivation: V2ActivationRecord;
  activation: V2ActivationRecord;
  assets: AssetBlob[];
  chunks: RepoChunkV2[];
  receipt: V2WorkspaceImportReceipt;
}

export interface V2WorkspaceRevisionCommit {
  expectedActivation: V2ActivationRecord;
  activation: V2ActivationRecord;
  assets: AssetBlob[];
  chunks: RepoChunkV2[];
}

export interface V2WorkspaceImportRollbackRecord {
  version: 1;
  importId: string;
  priorActivation: V2ActivationRecord;
  priorPayload: V2CommittedPayload;
  committedActivation: V2ActivationRecord;
}

/** Rollback record of a delta import: no Repo image copy, only activations. */
export interface V2WorkspaceDeltaImportRollbackRecord {
  version: 2;
  mode: "remove-prefixes";
  importId: string;
  priorActivation: V2ActivationRecord;
  committedActivation: V2ActivationRecord;
}

export interface ReopenedRepoDocument {
  url: string;
  document: LiveCanvinkDocumentV2;
}

export interface StagedRepoWorkspace {
  documents: Array<{
    documentId: string;
    kind: CanvinkDocumentV2["kind"];
    url: string;
    heads: string[];
  }>;
  chunks: RepoChunkV2[];
}

/** Small injectable seam for Automerge Repo staging and reopen validation. */
export interface AutomergeRepoMigrationAdapter {
  stage(documents: StoredCanvinkDocument[]): Promise<StagedRepoWorkspace>;
  reopen(
    chunks: RepoChunkV2[],
    documents: ActivatedDocumentV2[],
  ): Promise<ReopenedRepoDocument[]>;
}

/** Small injectable seam for converting verified v2 projections to real Automerge saves. */
export interface AutomergeMigrationMaterializer {
  materialize(migration: MigrationResultV2): Promise<StoredDocumentV2[]>;
}

export interface V2WorkspaceActivationStore {
  getActivation(): Promise<V2ActivationRecord | undefined>;
  commit(commit: V2AtomicCommit): Promise<"activated" | "already-active">;
  readCommitted(activation: V2ActivationRecord): Promise<V2CommittedPayload>;
  /** Optional until a native store implements the dedicated atomic import command. */
  extendActiveWorkspace?(
    commit: V2WorkspaceExtensionCommit,
  ): Promise<"committed" | "already-committed">;
  getWorkspaceImportReceipt?(
    importId: string,
  ): Promise<V2WorkspaceImportReceipt | undefined>;
  rollbackWorkspaceImport?(
    importId: string,
  ): Promise<"rolled-back" | "already-rolled-back">;
  commitActiveWorkspaceRevision?(
    commit: V2WorkspaceRevisionCommit,
  ): Promise<"committed" | "already-committed">;
  /** Publishes a delta commit atomically; see `V2WorkspaceDeltaCommit`. */
  commitWorkspaceDelta?(
    commit: V2WorkspaceDeltaCommit,
  ): Promise<"committed" | "already-committed">;
  /**
   * Writes Repo chunks and assets of documents that no activation references
   * yet. Large imports stage their pages in bounded batches before one small
   * delta commit publishes them; after a crash the staged bytes are
   * unreferenced and harmless.
   */
  stageWorkspaceEntries?(
    entries: WorkspaceStorageEntry[],
    assets: AssetBlob[],
  ): Promise<void>;
  /** Reads one committed asset without loading the others. */
  readAsset?(assetId: Sha256Checksum): Promise<AssetBlob | undefined>;
  /** Reads and verifies the schema-v1 rollback backup of an activation. */
  readBackup?(activation: V2ActivationRecord): Promise<V1BackupRecord>;
}

export interface V1WorkspaceMigrationSource {
  loadWorkspace(): Promise<{
    workspace: WorkspaceState;
    backend: StorageBackend;
  }>;
  loadRecoveryDraft(): Promise<RecoveryDraft | null>;
}

export interface ActiveV2Workspace {
  activation: V2ActivationRecord;
  documents: ReopenedRepoDocument[];
  assets: AssetBlob[];
}

export interface MigrationRunResult {
  status: "activated" | "already-active";
  workspace: ActiveV2Workspace;
  preview: MigrationPreviewV2;
}

export type WorkspaceLoadResult =
  | {
      schemaVersion: 1;
      authoritative: "v1";
      reason: "v2-not-activated";
      workspace: WorkspaceState;
      backend: StorageBackend;
    }
  | {
      schemaVersion: 2 | 3;
      authoritative: "v2" | "v3";
      workspace: ActiveV2Workspace;
    };

export class WorkspaceMigrationBlockedError extends Error {
  constructor(
    public readonly code:
      | "pending-recovery"
      | "empty-workspace"
      | "different-v2-active"
      | "backup-corrupt"
      | "stage-corrupt",
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceMigrationBlockedError";
  }
}

class IndexedDbAtomicWorkspaceStore implements AtomicKeyValueStore {
  private readonly store = createStore(DATABASE_NAME, STORE_NAME);

  get<T>(key: AtomicStorageKey): Promise<T | undefined> {
    return get<T>(atomicStorageIdbKey(key), this.store);
  }

  setMany(entries: Array<readonly [AtomicStorageKey, unknown]>): Promise<void> {
    return setMany(
      entries.map(([key, value]) => [atomicStorageIdbKey(key), value]),
      this.store,
    );
  }

  replaceMany(
    entries: Array<readonly [AtomicStorageKey, unknown]>,
    removedKeys: readonly AtomicStorageKey[],
    removedPrefixes: ReadonlyArray<readonly string[]> = [],
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const open = indexedDB.open(DATABASE_NAME);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const database = open.result;
        const transaction = database.transaction(STORE_NAME, "readwrite");
        const store = transaction.objectStore(STORE_NAME);
        transaction.oncomplete = () => {
          database.close();
          resolve();
        };
        transaction.onerror = () => {
          database.close();
          reject(transaction.error);
        };
        transaction.onabort = () => {
          database.close();
          reject(transaction.error);
        };
        try {
          // Array keys sort after strings, and `[]` after every string, so
          // [prefix, [...prefix, []]] covers the prefix and all longer keys.
          for (const prefix of removedPrefixes) {
            store.delete(IDBKeyRange.bound([...prefix], [...prefix, []]));
          }
          for (const key of removedKeys) store.delete(atomicStorageIdbKey(key));
          for (const [key, value] of entries)
            store.put(value, atomicStorageIdbKey(key));
        } catch (error) {
          try {
            transaction.abort();
          } catch {
            // The transaction may already have aborted after the synchronous
            // IndexedDB failure.
          }
          database.close();
          reject(error);
        }
      };
    });
  }
}

class MemoryRepoStorage implements StorageAdapterInterface {
  private readonly values = new Map<
    string,
    { key: StorageKey; bytes: Uint8Array }
  >();

  constructor(chunks: RepoChunkV2[] = []) {
    for (const chunk of chunks) this.put(chunk.key, chunk.bytes);
  }

  async load(key: StorageKey): Promise<Uint8Array | undefined> {
    return this.values.get(this.encoded(key))?.bytes.slice();
  }

  async save(key: StorageKey, data: Uint8Array): Promise<void> {
    this.put(key, data);
  }

  async remove(key: StorageKey): Promise<void> {
    this.values.delete(this.encoded(key));
  }

  async loadRange(keyPrefix: StorageKey) {
    return [...this.values.values()]
      .filter(({ key }) =>
        keyPrefix.every((part, index) => key[index] === part),
      )
      .map(({ key, bytes }) => ({ key: [...key], data: bytes.slice() }));
  }

  async removeRange(keyPrefix: StorageKey): Promise<void> {
    for (const [encoded, value] of this.values) {
      if (keyPrefix.every((part, index) => value.key[index] === part)) {
        this.values.delete(encoded);
      }
    }
  }

  chunks(): RepoChunkV2[] {
    return [...this.values.values()]
      .map(({ key, bytes }) => ({ key: [...key], bytes: bytes.slice() }))
      .sort((left, right) =>
        this.encoded(left.key).localeCompare(this.encoded(right.key)),
      );
  }

  private put(key: StorageKey, bytes: Uint8Array): void {
    this.values.set(this.encoded(key), { key: [...key], bytes: bytes.slice() });
  }

  private encoded(key: StorageKey): string {
    return canonicalJson(key);
  }
}

export class InMemoryAutomergeRepoMigrationAdapter implements AutomergeRepoMigrationAdapter {
  async stage(documents: StoredCanvinkDocument[]): Promise<StagedRepoWorkspace> {
    const storage = new MemoryRepoStorage();
    const repo = new Repo({ storage, network: [], isEphemeral: false });
    try {
      const staged: StagedRepoWorkspace["documents"] = [];
      for (const document of documents) {
        if (
          document.documentFormat !== "automerge" ||
          document.encoding !== "binary"
        ) {
          throw new Error(
            `Document ${document.documentId} is not a real Automerge binary save.`,
          );
        }
        const handle = repo.import<LiveCanvinkDocumentV2>(document.bytes);
        const snapshot = handle.doc();
        assertCanvinkAutomergeDocument(snapshot);
        if (
          snapshot.documentId !== document.documentId ||
          snapshot.kind !== document.kind
        ) {
          throw new Error(
            `Staged Automerge document ${document.documentId} changed identity.`,
          );
        }
        staged.push({
          documentId: document.documentId,
          kind: document.kind,
          url: handle.url,
          heads: [...document.version.heads],
        });
      }
      await repo.flush();
      return { documents: staged, chunks: storage.chunks() };
    } finally {
      await repo.shutdown();
    }
  }

  async reopen(
    chunks: RepoChunkV2[],
    documents: ActivatedDocumentV2[],
  ): Promise<ReopenedRepoDocument[]> {
    const storage = new MemoryRepoStorage(chunks);
    const repo = new Repo({ storage, network: [], isEphemeral: false });
    try {
      const reopened: ReopenedRepoDocument[] = [];
      for (const expected of documents) {
        if (!isValidAutomergeUrl(expected.url)) {
          throw new Error(
            `Activation has an invalid Automerge URL for ${expected.documentId}.`,
          );
        }
        const handle = await repo.find<LiveCanvinkDocumentV2>(
          expected.url as AutomergeUrl,
        );
        const document = handle.doc();
        assertCanvinkAutomergeDocument(document);
        const snapshot = getAutomergeSnapshot<LiveCanvinkDocumentV2>(
          document as CanvinkAutomergeDoc,
        );
        if (
          snapshot.documentId !== expected.documentId ||
          snapshot.kind !== expected.kind
        ) {
          throw new Error(
            `Reopened Automerge document ${expected.documentId} changed identity.`,
          );
        }
        getAutomergeSnapshotAt<LiveCanvinkDocumentV2>(
          document as CanvinkAutomergeDoc,
          expected.heads,
        );
        if (
          !sameStringSet(
            getAutomergeHeads<LiveCanvinkDocumentV2>(
              document as CanvinkAutomergeDoc<LiveCanvinkDocumentV2>,
            ),
            expected.heads,
          )
        ) {
          throw new Error(
            `Reopened Automerge document ${expected.documentId} has unexpected heads.`,
          );
        }
        reopened.push({ url: expected.url, document: snapshot });
      }
      return reopened;
    } finally {
      await repo.shutdown();
    }
  }
}

/**
 * Builds a complete replacement Repo image without touching the live store.
 * Existing URLs/heads are retained; only wholly new roots may be imported.
 */
export async function stageAutomergeWorkspaceExtension(
  existingChunks: RepoChunkV2[],
  existingDocuments: ActivatedDocumentV2[],
  newDocuments: StoredCanvinkDocument[],
): Promise<StagedRepoWorkspace> {
  const existingIds = new Set(
    existingDocuments.map((document) => document.documentId),
  );
  if (
    newDocuments.length === 0 ||
    newDocuments.some((document) => existingIds.has(document.documentId)) ||
    new Set(newDocuments.map((document) => document.documentId)).size !==
      newDocuments.length
  )
    throw new Error(
      "A workspace extension must contain unique, wholly new document roots.",
    );

  const storage = new MemoryRepoStorage(existingChunks);
  const repo = new Repo({ storage, network: [], isEphemeral: false });
  try {
    const budget = createYieldBudget();
    for (const expected of existingDocuments) {
      await budget.maybeYield();
      const handle = await repo.find<LiveCanvinkDocumentV2>(
        expected.url as AutomergeUrl,
      );
      const snapshot = handle.doc();
      assertCanvinkAutomergeDocument(snapshot);
      if (
        snapshot.documentId !== expected.documentId ||
        snapshot.kind !== expected.kind
      ) {
        throw new Error(
          `Existing Automerge document ${expected.documentId} changed identity.`,
        );
      }
      getAutomergeSnapshotAt<LiveCanvinkDocumentV2>(
        snapshot as CanvinkAutomergeDoc,
        expected.heads,
      );
    }

    const added: StagedRepoWorkspace["documents"] = [];
    for (const document of newDocuments) {
      if (
        document.documentFormat !== "automerge" ||
        document.encoding !== "binary"
      ) {
        throw new Error(
          `Document ${document.documentId} is not an Automerge binary save.`,
        );
      }
      const handle = repo.import<LiveCanvinkDocumentV2>(document.bytes);
      const live = handle.doc();
      assertCanvinkAutomergeDocument(live);
      if (
        live.documentId !== document.documentId ||
        live.kind !== document.kind
      ) {
        throw new Error(
          `Imported Automerge document ${document.documentId} changed identity.`,
        );
      }
      added.push({
        documentId: document.documentId,
        kind: document.kind,
        url: handle.url,
        heads: getAutomergeHeads<LiveCanvinkDocumentV2>(
          live as CanvinkAutomergeDoc,
        ),
      });
    }
    await repo.flush();
    return {
      documents: [...structuredClone(existingDocuments), ...added],
      chunks: storage.chunks(),
    };
  } finally {
    await repo.shutdown();
  }
}

export interface StagedWorkspaceDocumentChange {
  documentId: string;
  message: string;
  change: ChangeFn<LiveCanvinkDocumentV2>;
}

/** Stages changed/new roots against a complete live Repo image without publishing them. */
export async function stageAutomergeWorkspaceRevision(
  existingChunks: RepoChunkV2[],
  existingDocuments: ActivatedDocumentV2[],
  changes: StagedWorkspaceDocumentChange[],
  newDocuments: StoredCanvinkDocument[],
  removedDocumentIds: readonly string[] = [],
): Promise<StagedRepoWorkspace> {
  const storage = new MemoryRepoStorage(existingChunks);
  const repo = new Repo({ storage, network: [], isEphemeral: false });
  const changeById = new Map(changes.map((item) => [item.documentId, item]));
  if (changeById.size !== changes.length)
    throw new Error("A document may change only once per revision.");
  const removed = new Set(removedDocumentIds);
  try {
    const documents: StagedRepoWorkspace["documents"] = [];
    const removedStorageIds: string[] = [];
    const budget = createYieldBudget();
    for (const expected of existingDocuments) {
      await budget.maybeYield();
      const handle = await repo.find<LiveCanvinkDocumentV2>(
        expected.url as AutomergeUrl,
      );
      const before = handle.doc();
      assertCanvinkAutomergeDocument(before);
      if (
        before.documentId !== expected.documentId ||
        before.kind !== expected.kind
      ) {
        throw new Error(
          `Existing Automerge document ${expected.documentId} changed identity.`,
        );
      }
      const mutation = changeById.get(expected.documentId);
      if (mutation)
        handle.change(mutation.change, { message: mutation.message });
      const after = handle.doc();
      assertCanvinkAutomergeDocument(after);
      if (
        after.documentId !== expected.documentId ||
        after.kind !== expected.kind
      ) {
        throw new Error(`Revision changed identity of ${expected.documentId}.`);
      }
      if (!removed.has(expected.documentId)) {
        documents.push({
          documentId: expected.documentId,
          kind: expected.kind,
          url: expected.url,
          heads: getAutomergeHeads<LiveCanvinkDocumentV2>(
            after as CanvinkAutomergeDoc,
          ),
        });
      } else {
        // A removed document is dropped from the descriptor list, but its
        // Automerge chunks must also leave the image so a permanently deleted
        // page cannot be reconstructed from the committed bundle.
        removedStorageIds.push(handle.documentId);
      }
    }
    for (const mutation of changes) {
      if (
        !existingDocuments.some(
          (document) => document.documentId === mutation.documentId,
        )
      ) {
        throw new Error(
          `Revision targets unknown document ${mutation.documentId}.`,
        );
      }
    }
    const existingIds = new Set(
      existingDocuments.map((document) => document.documentId),
    );
    for (const document of newDocuments) {
      await budget.maybeYield();
      // A new root may reuse the id of a root this same revision removes: that
      // replaces the document (personal-space adoption of a page whose fixed id
      // the local starter notebook also carries). Any other reuse is a bug.
      if (existingIds.has(document.documentId) && !removed.has(document.documentId)) {
        throw new Error(
          `New document ${document.documentId} collides with an existing root.`,
        );
      }
      const handle = repo.import<LiveCanvinkDocumentV2>(document.bytes);
      const live = handle.doc();
      assertCanvinkAutomergeDocument(live);
      if (
        live.documentId !== document.documentId ||
        live.kind !== document.kind
      ) {
        throw new Error(
          `New document ${document.documentId} changed identity.`,
        );
      }
      documents.push({
        documentId: document.documentId,
        kind: document.kind,
        url: handle.url,
        heads: getAutomergeHeads<LiveCanvinkDocumentV2>(
          live as CanvinkAutomergeDoc,
        ),
      });
    }
    await repo.flush();
    for (const storageId of removedStorageIds) {
      await storage.removeRange([storageId]);
    }
    return { documents, chunks: storage.chunks() };
  } finally {
    await repo.shutdown();
  }
}

/** Stages the schema v2 to v3 upgrade: every document of the image gets `schemaVersion = 3` in one revision. */
export function stageSchemaV3Upgrade(
  existingChunks: RepoChunkV2[],
  existingDocuments: ActivatedDocumentV2[],
): Promise<StagedRepoWorkspace> {
  return stageAutomergeWorkspaceRevision(
    existingChunks,
    existingDocuments,
    existingDocuments.map(({ documentId }) => ({
      documentId,
      message: "Upgrade Canvink workspace schema v2 to v3",
      change: (draft: LiveCanvinkDocumentV2) => {
        draft.schemaVersion = 3;
      },
    })),
    [],
  );
}

export class DefaultAutomergeMigrationMaterializer implements AutomergeMigrationMaterializer {
  async materialize(migration: MigrationResultV2): Promise<StoredDocumentV2[]> {
    return (await materializeMigrationAsAutomerge(migration)).documents;
  }
}

function backupKey(migrationId: string): string {
  return `backup:${migrationId}`;
}

function assetKey(assetId: Sha256Checksum): string {
  return `asset:${assetId}`;
}

function chunkStorageKey(index: number): string {
  return `repo-chunk:${index.toString().padStart(8, "0")}`;
}

function importReceiptKey(importId: string): string {
  return `import-receipt:${importId}`;
}

function importBackupKey(importId: string): string {
  return `import-backup:${importId}`;
}

function liveRepoStorageKey(key: StorageKey): readonly string[] {
  return ["automerge-repo", ...key];
}

function staleWorkspaceStorageKeys(
  before: V2ActivationRecord,
  after: V2ActivationRecord,
): AtomicStorageKey[] {
  const afterRepoKeys = new Set(
    after.chunks.map((chunk) => canonicalJson(chunk.key)),
  );
  const stale: AtomicStorageKey[] = before.chunks.flatMap((chunk) =>
    afterRepoKeys.has(canonicalJson(chunk.key))
      ? []
      : [liveRepoStorageKey(chunk.key)],
  );
  for (
    let index = after.chunks.length;
    index < before.chunks.length;
    index += 1
  ) {
    stale.push(chunkStorageKey(index));
  }
  return stale;
}

function sameStringSet(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    [...left].sort().every((value, index) => value === [...right].sort()[index])
  );
}

/**
 * Activations of a notebook with hundreds of pages are compared several times per commit, so a
 * different fingerprint (the common answer) ends the comparison at once.
 */
function sameActivation(
  left: V2ActivationRecord,
  right: V2ActivationRecord,
): boolean {
  return left.artifactFingerprint === right.artifactFingerprint && sameCanonicalJson(left, right);
}

function mergeAssets(current: AssetBlob[], incoming: AssetBlob[]): AssetBlob[] {
  const byId = new Map(
    current.map((asset) => [asset.assetId, structuredClone(asset)]),
  );
  for (const asset of incoming) {
    const existing = byId.get(asset.assetId);
    if (existing && canonicalJson(existing) !== canonicalJson(asset)) {
      throw new Error(
        `Imported asset ${asset.assetId} collides with different bytes.`,
      );
    }
    byId.set(asset.assetId, structuredClone(asset));
  }
  return [...byId.values()].sort((left, right) =>
    left.assetId.localeCompare(right.assetId),
  );
}

function activationHasPairedSchema(activation: V2ActivationRecord): boolean {
  if (activation.schemaVersion === 2) {
    return activation.format === "canvink-automerge-v2"
      && activation.manifest.schemaVersion === 2
      && activation.manifest.format === "canvink-schema-v2";
  }
  if (
    activation.format !== "canvink-automerge-v3"
    || activation.manifest.schemaVersion !== 3
    || activation.manifest.format !== "canvink-schema-v3"
  ) return false;
  const upgrade = activation.manifest.upgrade;
  return upgrade.name === "workspace-v2-to-v3"
    && upgrade.version === 1
    && /^sha256:[0-9a-f]{64}$/.test(upgrade.sourceArtifactFingerprint)
    && upgrade.upgradeId === `workspace-v2-to-v3:${upgrade.sourceArtifactFingerprint.slice(7)}`
    && !Number.isNaN(Date.parse(upgrade.preparedAt));
}

function assertExtensionShape(commit: V2WorkspaceExtensionCommit): void {
  const { expectedActivation: before, activation: after, receipt } = commit;
  if (
    !activationHasPairedSchema(before) ||
    !activationHasPairedSchema(after) ||
    before.schemaVersion !== after.schemaVersion ||
    before.format !== after.format ||
    before.migrationId !== after.migrationId ||
    before.sourceFingerprint !== after.sourceFingerprint ||
    receipt.priorActivationArtifactFingerprint !== before.artifactFingerprint ||
    receipt.committedActivationArtifactFingerprint !==
      after.artifactFingerprint ||
    receipt.status !== "committed" ||
    !receipt.importId ||
    receipt.backupId !== `import-backup:${receipt.importId}`
  )
    throw new Error("The additive workspace commit metadata is malformed.");

  const oldDocuments = new Map(
    before.documents.map((document) => [document.documentId, document]),
  );
  for (const [documentId, document] of oldDocuments) {
    const retained = after.documents.find(
      (candidate) => candidate.documentId === documentId,
    );
    if (
      !retained ||
      retained.kind !== document.kind ||
      retained.url !== document.url
    ) {
      throw new Error(
        `Additive commit changed existing document ${documentId}.`,
      );
    }
  }
  if (
    before.manifest.notebookDocumentIds.some(
      (id) => !after.manifest.notebookDocumentIds.includes(id),
    ) ||
    before.manifest.pageDocumentIds.some(
      (id) => !after.manifest.pageDocumentIds.includes(id),
    ) ||
    before.assetIds.some((id) => !after.assetIds.includes(id)) ||
    canonicalJson(before.manifest.active) !==
      canonicalJson(after.manifest.active)
  )
    throw new Error(
      "An additive workspace commit removed prior roots, assets, or active context.",
    );
}

export function assertDeltaStorageKey(key: readonly string[], label: string): void {
  if (
    !Array.isArray(key)
    || key.length < 2
    || key.some((segment) => typeof segment !== "string" || segment.length === 0)
    || !(DELTA_STORAGE_NAMESPACES as readonly string[]).includes(key[0])
  ) {
    throw new Error(`The delta commit ${label} has an invalid storage key.`);
  }
}

function assertDeltaCommitShape(commit: V2WorkspaceDeltaCommit): void {
  const before = commit.expectedActivation;
  const after = commit.activation;
  if (
    !activationHasPairedSchema(before)
    || !activationHasPairedSchema(after)
    || before.schemaVersion !== after.schemaVersion
    || before.format !== after.format
    || before.migrationId !== after.migrationId
    || before.sourceFingerprint !== after.sourceFingerprint
    || after.layout !== "repo-live"
  ) throw new Error("The delta workspace commit metadata is malformed.");
  commit.entries.forEach((entry) => assertDeltaStorageKey(entry.key, "entry"));
  commit.removedPrefixes.forEach((prefix) => assertDeltaStorageKey(prefix, "removed prefix"));
  const receipt = commit.receipt;
  if (!receipt) return;
  if (
    receipt.status !== "committed"
    || !receipt.importId
    || receipt.backupId !== `import-backup:${receipt.importId}`
    || receipt.priorActivationArtifactFingerprint !== before.artifactFingerprint
    || receipt.committedActivationArtifactFingerprint !== after.artifactFingerprint
    || receipt.rollback?.mode !== "remove-prefixes"
    || before.manifest.notebookDocumentIds.some((id) => !after.manifest.notebookDocumentIds.includes(id))
    || before.manifest.pageDocumentIds.some((id) => !after.manifest.pageDocumentIds.includes(id))
    || before.assetIds.some((id) => !after.assetIds.includes(id))
    || canonicalJson(before.manifest.active) !== canonicalJson(after.manifest.active)
  ) throw new Error("The delta import receipt is malformed.");
  receipt.rollback.prefixes.forEach((prefix) => assertDeltaStorageKey(prefix, "rollback prefix"));
  const retained = new Map(after.documents.map((document) => [document.documentId, document]));
  for (const document of before.documents) {
    const next = retained.get(document.documentId);
    if (!next || next.kind !== document.kind || next.url !== document.url) {
      throw new Error(`A delta import changed existing document ${document.documentId}.`);
    }
  }
}

function assertRevisionShape(commit: V2WorkspaceRevisionCommit): void {
  const before = commit.expectedActivation;
  const after = commit.activation;
  const transitionAllowed = before.schemaVersion === after.schemaVersion
    || (before.schemaVersion === 2 && after.schemaVersion === 3);
  if (
    !transitionAllowed
    || !activationHasPairedSchema(before)
    || !activationHasPairedSchema(after)
    || before.migrationId !== after.migrationId
    || before.sourceFingerprint !== after.sourceFingerprint
  ) throw new Error("The workspace revision has an invalid schema transition.");
}

export class BrowserV2WorkspaceActivationStore implements V2WorkspaceActivationStore {
  constructor(
    private readonly adapter: AtomicKeyValueStore = new IndexedDbAtomicWorkspaceStore(),
  ) {}

  private commitReplacement(
    entries: Array<readonly [AtomicStorageKey, unknown]>,
    before: V2ActivationRecord,
    after: V2ActivationRecord,
  ): Promise<void> {
    const removed = staleWorkspaceStorageKeys(before, after);
    return this.adapter.replaceMany
      ? this.adapter.replaceMany(entries, removed)
      : this.adapter.setMany(entries);
  }

  getActivation(): Promise<V2ActivationRecord | undefined> {
    return this.adapter.get<V2ActivationRecord>(ACTIVATION_KEY);
  }

  async commit(
    commit: V2AtomicCommit,
  ): Promise<"activated" | "already-active"> {
    await verifyAtomicCommit(commit);
    const existing = await this.getActivation();
    if (existing) {
      if (!sameActivation(existing, commit.activation)) {
        throw new WorkspaceMigrationBlockedError(
          "different-v2-active",
          "A different Automerge schema-v2 workspace is already active.",
        );
      }
      return "already-active";
    }
    const entries: Array<readonly [AtomicStorageKey, unknown]> = [
      [backupKey(commit.backup.migrationId), structuredClone(commit.backup)],
    ];
    commit.assets.forEach((asset) =>
      entries.push([assetKey(asset.assetId), structuredClone(asset)]),
    );
    commit.chunks.forEach((chunk, index) => {
      entries.push([chunkStorageKey(index), structuredClone(chunk)]);
      // The live Repo adapter reads the same bytes under its native hierarchical key.
      entries.push([
        liveRepoStorageKey(chunk.key),
        Uint8Array.from(chunk.bytes),
      ]);
    });
    // This distinct selector is intentionally last, but participates in the same transaction.
    entries.push([ACTIVATION_KEY, structuredClone(commit.activation)]);
    await this.adapter.setMany(entries);
    const activated = await this.getActivation();
    if (!activated || !sameActivation(activated, commit.activation)) {
      throw new Error(
        "The atomic schema-v2 activation record was not confirmed.",
      );
    }
    return "activated";
  }

  async readCommitted(
    activation: V2ActivationRecord,
  ): Promise<V2CommittedPayload> {
    const current = await this.getActivation();
    if (!current || !sameActivation(current, activation)) {
      throw new Error(
        "Committed schema v2 cannot be read without its matching activation record.",
      );
    }
    const backup = await this.adapter.get<V1BackupRecord>(
      backupKey(activation.migrationId),
    );
    if (!backup)
      throw new Error("The activated schema-v1 rollback backup is missing.");
    const assets: AssetBlob[] = [];
    for (const assetId of activation.assetIds) {
      const asset = await this.adapter.get<AssetBlob>(assetKey(assetId));
      if (!asset) throw new Error(`Activated asset ${assetId} is missing.`);
      assets.push(asset);
    }
    if (activation.layout === "repo-live") {
      // Delta commits keep no committed chunk copies: the live Repo keys are
      // the only copy, and each document's heads anchor its integrity when
      // the runtime loads it.
      const payload = { backup, assets, chunks: [] };
      await verifyCommittedPayload(activation, payload, { chunks: false });
      return payload;
    }
    const chunks: RepoChunkV2[] = [];
    for (let index = 0; index < activation.chunks.length; index += 1) {
      const chunk = await this.adapter.get<RepoChunkV2>(chunkStorageKey(index));
      if (!chunk) throw new Error(`Activated Repo chunk ${index} is missing.`);
      chunks.push(chunk);
    }
    const payload = { backup, assets, chunks };
    await verifyCommittedPayload(activation, payload);
    return payload;
  }

  async readAsset(assetId: Sha256Checksum): Promise<AssetBlob | undefined> {
    return this.adapter.get<AssetBlob>(assetKey(assetId));
  }

  async readBackup(activation: V2ActivationRecord): Promise<V1BackupRecord> {
    const backup = await this.adapter.get<V1BackupRecord>(
      backupKey(activation.migrationId),
    );
    if (!backup)
      throw new Error("The activated schema-v1 rollback backup is missing.");
    await verifyBackupRecord(activation, backup);
    return backup;
  }

  async stageWorkspaceEntries(
    entries: WorkspaceStorageEntry[],
    assets: AssetBlob[],
  ): Promise<void> {
    const values: Array<readonly [AtomicStorageKey, unknown]> = [];
    for (const asset of assets) {
      await verifyAssetBlob(asset);
      values.push([assetKey(asset.assetId), structuredClone(asset)]);
    }
    for (const entry of entries) {
      assertDeltaStorageKey(entry.key, "staged entry");
      values.push([[...entry.key], Uint8Array.from(entry.bytes)]);
    }
    if (values.length > 0) await this.adapter.setMany(values);
  }

  async commitWorkspaceDelta(
    commit: V2WorkspaceDeltaCommit,
  ): Promise<"committed" | "already-committed"> {
    assertDeltaCommitShape(commit);
    if (commit.receipt) {
      const existingReceipt = await this.adapter.get<V2WorkspaceImportReceipt>(
        importReceiptKey(commit.receipt.importId),
      );
      if (existingReceipt) {
        if (
          existingReceipt.importArtifactFingerprint !==
          commit.receipt.importArtifactFingerprint
        ) {
          throw new Error(
            `Import ID ${commit.receipt.importId} was already used for another artifact.`,
          );
        }
        if (existingReceipt.status === "rolled-back") {
          throw new Error(
            `Import ${commit.receipt.importId} was rolled back and cannot be replayed.`,
          );
        }
        return "already-committed";
      }
    }
    const current = await this.getActivation();
    if (current && sameActivation(current, commit.activation))
      return "already-committed";
    if (!current || !sameActivation(current, commit.expectedActivation)) {
      throw new Error(
        "The active workspace changed before the delta commit.",
      );
    }
    for (const asset of commit.assets) await verifyAssetBlob(asset);
    const incoming = new Set(commit.assets.map((asset) => asset.assetId));
    const known = new Set(current.assetIds);
    for (const assetId of commit.activation.assetIds) {
      if (known.has(assetId) || incoming.has(assetId)) continue;
      if (!(await this.adapter.get<AssetBlob>(assetKey(assetId)))) {
        throw new Error(`Delta commit references missing asset ${assetId}.`);
      }
    }
    const entries: Array<readonly [AtomicStorageKey, unknown]> = [];
    for (const asset of commit.assets) {
      entries.push([assetKey(asset.assetId), structuredClone(asset)]);
    }
    for (const entry of commit.entries) {
      entries.push([[...entry.key], Uint8Array.from(entry.bytes)]);
    }
    if (commit.receipt) {
      const rollback: V2WorkspaceDeltaImportRollbackRecord = {
        version: 2,
        mode: "remove-prefixes",
        importId: commit.receipt.importId,
        priorActivation: structuredClone(current),
        committedActivation: structuredClone(commit.activation),
      };
      entries.push([importBackupKey(commit.receipt.importId), rollback]);
      entries.push([
        importReceiptKey(commit.receipt.importId),
        structuredClone(commit.receipt),
      ]);
    }
    entries.push([ACTIVATION_KEY, structuredClone(commit.activation)]);
    // The first delta commit on a complete-image workspace drops the
    // committed chunk copies: from now on the live Repo keys are the only
    // copy, and the activation says so with `layout: 'repo-live'`.
    const removedKeys: AtomicStorageKey[] = current.layout === "repo-live"
      ? []
      : current.chunks.map((_chunk, index) => chunkStorageKey(index));
    await this.replaceAtomically(entries, removedKeys, commit.removedPrefixes);
    const activated = await this.getActivation();
    if (!activated || !sameActivation(activated, commit.activation)) {
      throw new Error("The delta workspace commit was not confirmed.");
    }
    return "committed";
  }

  private replaceAtomically(
    entries: Array<readonly [AtomicStorageKey, unknown]>,
    removedKeys: readonly AtomicStorageKey[],
    removedPrefixes: ReadonlyArray<readonly string[]>,
  ): Promise<void> {
    if (!this.adapter.replaceMany) {
      throw new Error("This store cannot remove keys atomically.");
    }
    return this.adapter.replaceMany(entries, removedKeys, removedPrefixes);
  }

  async extendActiveWorkspace(
    commit: V2WorkspaceExtensionCommit,
  ): Promise<"committed" | "already-committed"> {
    assertExtensionShape(commit);
    const existingReceipt = await this.adapter.get<V2WorkspaceImportReceipt>(
      importReceiptKey(commit.receipt.importId),
    );
    if (existingReceipt) {
      if (
        existingReceipt.importArtifactFingerprint !==
        commit.receipt.importArtifactFingerprint
      ) {
        throw new Error(
          `Import ID ${commit.receipt.importId} was already used for another artifact.`,
        );
      }
      if (existingReceipt.status === "rolled-back") {
        throw new Error(
          `Import ${commit.receipt.importId} was rolled back and cannot be replayed.`,
        );
      }
      return "already-committed";
    }

    const current = await this.getActivation();
    if (!current || !sameActivation(current, commit.expectedActivation)) {
      throw new Error(
        "The active workspace changed before the additive import transaction.",
      );
    }
    const priorPayload = await this.readCommitted(current);
    const assets = mergeAssets(priorPayload.assets, commit.assets);
    await verifyCommittedPayload(commit.activation, {
      backup: priorPayload.backup,
      assets,
      chunks: commit.chunks,
    });
    const rollback: V2WorkspaceImportRollbackRecord = {
      version: 1,
      importId: commit.receipt.importId,
      priorActivation: structuredClone(current),
      priorPayload: structuredClone(priorPayload),
      committedActivation: structuredClone(commit.activation),
    };
    const entries: Array<readonly [AtomicStorageKey, unknown]> = [
      [importBackupKey(commit.receipt.importId), rollback],
    ];
    commit.assets.forEach((asset) =>
      entries.push([assetKey(asset.assetId), structuredClone(asset)]),
    );
    commit.chunks.forEach((chunk, index) => {
      entries.push([chunkStorageKey(index), structuredClone(chunk)]);
      entries.push([
        liveRepoStorageKey(chunk.key),
        Uint8Array.from(chunk.bytes),
      ]);
    });
    entries.push([
      importReceiptKey(commit.receipt.importId),
      structuredClone(commit.receipt),
    ]);
    entries.push([ACTIVATION_KEY, structuredClone(commit.activation)]);
    await this.commitReplacement(entries, current, commit.activation);

    const activated = await this.getActivation();
    const receipt = await this.adapter.get<V2WorkspaceImportReceipt>(
      importReceiptKey(commit.receipt.importId),
    );
    if (
      !activated ||
      !sameActivation(activated, commit.activation) ||
      !receipt ||
      receipt.importArtifactFingerprint !==
        commit.receipt.importArtifactFingerprint
    )
      throw new Error("The additive workspace commit was not confirmed.");
    return "committed";
  }

  getWorkspaceImportReceipt(
    importId: string,
  ): Promise<V2WorkspaceImportReceipt | undefined> {
    return this.adapter.get<V2WorkspaceImportReceipt>(
      importReceiptKey(importId),
    );
  }

  async rollbackWorkspaceImport(
    importId: string,
  ): Promise<"rolled-back" | "already-rolled-back"> {
    const receipt = await this.adapter.get<V2WorkspaceImportReceipt>(
      importReceiptKey(importId),
    );
    if (!receipt)
      throw new Error(`Import ${importId} has no committed receipt.`);
    if (receipt.status === "rolled-back") return "already-rolled-back";
    const stored = await this.adapter.get<
      V2WorkspaceImportRollbackRecord | V2WorkspaceDeltaImportRollbackRecord
    >(importBackupKey(importId));
    if (!stored)
      throw new Error(`Import ${importId} has no rollback record.`);
    if ("mode" in stored && stored.mode === "remove-prefixes") {
      return this.rollbackDeltaImport(receipt, stored);
    }
    const rollback = stored as V2WorkspaceImportRollbackRecord;
    const current = await this.getActivation();
    if (!current || !sameActivation(current, rollback.committedActivation)) {
      throw new Error(
        "A later workspace commit depends on this import; rollback was refused.",
      );
    }
    await verifyCommittedPayload(
      rollback.priorActivation,
      rollback.priorPayload,
    );
    const rolledBackReceipt: V2WorkspaceImportReceipt = {
      ...structuredClone(receipt),
      status: "rolled-back",
    };
    const entries: Array<readonly [AtomicStorageKey, unknown]> = [];
    rollback.priorPayload.assets.forEach((asset) => {
      entries.push([assetKey(asset.assetId), structuredClone(asset)]);
    });
    rollback.priorPayload.chunks.forEach((chunk, index) => {
      entries.push([chunkStorageKey(index), structuredClone(chunk)]);
      entries.push([
        liveRepoStorageKey(chunk.key),
        Uint8Array.from(chunk.bytes),
      ]);
    });
    entries.push([importReceiptKey(importId), rolledBackReceipt]);
    entries.push([ACTIVATION_KEY, structuredClone(rollback.priorActivation)]);
    await this.commitReplacement(entries, current, rollback.priorActivation);
    const restored = await this.getActivation();
    if (!restored || !sameActivation(restored, rollback.priorActivation)) {
      throw new Error("The prior workspace activation was not restored.");
    }
    return "rolled-back";
  }

  private async rollbackDeltaImport(
    receipt: V2WorkspaceImportReceipt,
    rollback: V2WorkspaceDeltaImportRollbackRecord,
  ): Promise<"rolled-back"> {
    if (receipt.rollback?.mode !== "remove-prefixes") {
      throw new Error(`Import ${receipt.importId} has a malformed delta receipt.`);
    }
    const current = await this.getActivation();
    if (!current || !sameActivation(current, rollback.committedActivation)) {
      throw new Error(
        "A later workspace commit depends on this import; rollback was refused.",
      );
    }
    const prefixes = receipt.rollback.prefixes.map((prefix) => {
      assertDeltaStorageKey(prefix, "rollback prefix");
      return [...prefix];
    });
    const entries: Array<readonly [AtomicStorageKey, unknown]> = [
      [importReceiptKey(receipt.importId), { ...structuredClone(receipt), status: "rolled-back" }],
      [ACTIVATION_KEY, structuredClone(rollback.priorActivation)],
    ];
    await this.replaceAtomically(entries, [], prefixes);
    const restored = await this.getActivation();
    if (!restored || !sameActivation(restored, rollback.priorActivation)) {
      throw new Error("The prior workspace activation was not restored.");
    }
    return "rolled-back";
  }

  async commitActiveWorkspaceRevision(
    commit: V2WorkspaceRevisionCommit,
  ): Promise<"committed" | "already-committed"> {
    assertRevisionShape(commit);
    const current = await this.getActivation();
    if (current && sameActivation(current, commit.activation))
      return "already-committed";
    if (!current || !sameActivation(current, commit.expectedActivation)) {
      throw new Error(
        "The active workspace changed before the topology transaction.",
      );
    }
    const priorPayload = await this.readCommitted(current);
    const assets = mergeAssets(priorPayload.assets, commit.assets);
    await verifyCommittedPayload(commit.activation, {
      backup: priorPayload.backup,
      assets,
      chunks: commit.chunks,
    });
    const entries: Array<readonly [AtomicStorageKey, unknown]> = [];
    commit.assets.forEach((asset) =>
      entries.push([assetKey(asset.assetId), structuredClone(asset)]),
    );
    commit.chunks.forEach((chunk, index) => {
      entries.push([chunkStorageKey(index), structuredClone(chunk)]);
      entries.push([
        liveRepoStorageKey(chunk.key),
        Uint8Array.from(chunk.bytes),
      ]);
    });
    entries.push([ACTIVATION_KEY, structuredClone(commit.activation)]);
    await this.commitReplacement(entries, current, commit.activation);
    const activated = await this.getActivation();
    if (!activated || !sameActivation(activated, commit.activation)) {
      throw new Error("The workspace topology transaction was not confirmed.");
    }
    return "committed";
  }
}

function assertUsableV1Workspace(workspace: WorkspaceState): void {
  if (
    !workspace.notebooks.some((notebook) =>
      notebook.sections.some((section) => section.pages.length > 0),
    )
  ) {
    throw new WorkspaceMigrationBlockedError(
      "empty-workspace",
      "Migration refused an empty workspace. Schema v1 remains authoritative.",
    );
  }
}

async function checkedBackup(
  workspace: WorkspaceState,
  migrationId: string,
  sourceFingerprint: Sha256Checksum,
  createdAt: string,
): Promise<V1BackupRecord> {
  const backup: V1BackupRecord = {
    version: BACKUP_VERSION,
    migrationId,
    sourceFingerprint,
    createdAt,
    workspace: structuredClone(workspace),
  };
  assertWorkspaceShape(backup.workspace);
  if (
    (await sha256Canonical(backup.workspace)) !== sourceFingerprint ||
    canonicalJson(backup.workspace) !== canonicalJson(workspace)
  ) {
    throw new WorkspaceMigrationBlockedError(
      "backup-corrupt",
      "The staged schema-v1 backup failed read-back verification.",
    );
  }
  return backup;
}

async function chunkDescriptors(
  chunks: RepoChunkV2[],
): Promise<RepoChunkDescriptorV2[]> {
  const descriptors: RepoChunkDescriptorV2[] = [];
  for (const chunk of chunks) {
    descriptors.push({
      key: [...chunk.key],
      checksum: await sha256Bytes(chunk.bytes),
      size: chunk.bytes.byteLength,
    });
  }
  return descriptors;
}

async function verifyBackupRecord(
  activation: V2ActivationRecord,
  backup: V1BackupRecord,
): Promise<void> {
  assertWorkspaceShape(backup.workspace);
  if (
    backup.version !== BACKUP_VERSION ||
    backup.migrationId !== activation.migrationId ||
    backup.sourceFingerprint !== activation.sourceFingerprint ||
    (await sha256Canonical(backup.workspace)) !==
      activation.sourceFingerprint
  ) {
    throw new WorkspaceMigrationBlockedError(
      "backup-corrupt",
      "The activated v1 backup is corrupt.",
    );
  }
}

export async function verifyAssetBlob(asset: AssetBlob): Promise<void> {
  if (
    asset.assetId !== asset.checksum ||
    asset.size !== asset.bytes.byteLength ||
    (await sha256Bytes(asset.bytes)) !== asset.checksum
  )
    throw new Error(
      `Activated asset ${asset.assetId} failed integrity verification.`,
    );
}

async function verifyCommittedPayload(
  activation: V2ActivationRecord,
  payload: V2CommittedPayload,
  options: { chunks: boolean } = { chunks: true },
): Promise<void> {
  await verifyBackupRecord(activation, payload.backup);
  if (payload.assets.length !== activation.assetIds.length) {
    throw new Error("The activated asset set is incomplete.");
  }
  for (const asset of payload.assets) {
    if (!activation.assetIds.includes(asset.assetId))
      throw new Error(
        `Activated asset ${asset.assetId} failed integrity verification.`,
      );
    await verifyAssetBlob(asset);
  }
  if (!options.chunks) return;
  const descriptors = await chunkDescriptors(payload.chunks);
  if (canonicalJson(descriptors) !== canonicalJson(activation.chunks)) {
    throw new Error(
      "Activated Automerge Repo chunks failed integrity verification.",
    );
  }
}

async function verifyAtomicCommit(commit: V2AtomicCommit): Promise<void> {
  if (
    commit.activation.version !== ACTIVATION_VERSION ||
    commit.activation.schemaVersion !== 2 ||
    commit.activation.format !== "canvink-automerge-v2" ||
    commit.backup.migrationId !== commit.activation.migrationId
  )
    throw new Error("The schema-v2 atomic commit metadata is malformed.");
  await verifyCommittedPayload(commit.activation, commit);
}

function verifyDocumentMap(
  activation: V2ActivationRecord,
  reopened: ReopenedRepoDocument[],
): void {
  if (
    activation.documents.length === 0 ||
    reopened.length !== activation.documents.length ||
    new Set(activation.documents.map((item) => item.documentId)).size !==
      activation.documents.length ||
    new Set(activation.documents.map((item) => item.url)).size !==
      activation.documents.length
  )
    throw new Error(
      "The activated Automerge document map is empty, incomplete, or duplicated.",
    );
  const byUrl = new Map(reopened.map((item) => [item.url, item.document]));
  for (const expected of activation.documents) {
    const document = byUrl.get(expected.url);
    if (
      !document ||
      document.documentId !== expected.documentId ||
      document.kind !== expected.kind ||
      document.schemaVersion !== activation.schemaVersion
    ) {
      throw new Error(
        `Activated Automerge document ${expected.documentId} could not be verified.`,
      );
    }
  }
  const activeNotebook = activation.documents.find(
    (item) =>
      item.kind === "notebook" &&
      item.documentId === `notebook:${activation.manifest.active.notebookId}`,
  );
  const activePage = activation.documents.find(
    (item) =>
      item.kind === "page" &&
      item.documentId === `page:${activation.manifest.active.pageId}`,
  );
  if (!activeNotebook || !activePage) {
    throw new WorkspaceMigrationBlockedError(
      "empty-workspace",
      "The active Automerge workspace has no usable active notebook and page.",
    );
  }
}

export class V2WorkspaceMigrationOrchestrator {
  private progress: MigrationProgress = {
    phase: "idle",
    completed: 0,
    total: 0,
    authoritative: "v1",
    resumed: false,
    message: "Migration has not started.",
  };

  constructor(
    private readonly source: V1WorkspaceMigrationSource,
    private readonly activationStore: V2WorkspaceActivationStore,
    private readonly repo: AutomergeRepoMigrationAdapter,
    private readonly materializer: AutomergeMigrationMaterializer,
    private readonly options: {
      now?: () => string;
      onProgress?: (progress: MigrationProgress) => void;
    } = {},
  ) {}

  getStatus(): MigrationProgress {
    return { ...this.progress };
  }

  async run(): Promise<MigrationRunResult> {
    let expectedMigrationId: string | undefined;
    try {
      this.report(
        "loading-v1",
        0,
        1,
        "Loading the authoritative schema-v1 workspace.",
      );
      const { workspace } = await this.source.loadWorkspace();
      assertUsableV1Workspace(workspace);
      assertWorkspaceShape(workspace);
      this.report("loading-v1", 1, 1, "Loaded schema v1.");

      this.report("checking-recovery", 0, 1, "Checking the recovery journal.");
      const recovery = await this.source.loadRecoveryDraft();
      if (recovery && recoveryDraftDiffersFrom(recovery, workspace)) {
        throw new WorkspaceMigrationBlockedError(
          "pending-recovery",
          "A recovery draft differs from the saved workspace and must be resolved first.",
        );
      }
      this.report(
        "checking-recovery",
        1,
        1,
        "No recovery draft blocks migration.",
      );

      const sourceFingerprint = await sha256Canonical(workspace);
      expectedMigrationId = `workspace-v1-to-v2:${sourceFingerprint.slice("sha256:".length)}`;
      this.report(
        "backing-up-v1",
        0,
        1,
        "Cloning and verifying the schema-v1 rollback backup.",
      );
      const backup = await checkedBackup(
        workspace,
        expectedMigrationId,
        sourceFingerprint,
        this.options.now?.() ?? new Date().toISOString(),
      );
      this.report(
        "backing-up-v1",
        1,
        1,
        "The schema-v1 rollback backup passed verification.",
      );

      this.report(
        "preparing-v2",
        0,
        1,
        "Preparing deterministic schema-v2 projections.",
      );
      const migration = await prepareV1ToV2Migration(workspace);
      await verifyMigrationResult(migration);
      this.report("preparing-v2", 1, 1, "Prepared schema-v2 projections.");

      const existing = await this.activationStore.getActivation();
      if (existing) {
        if (
          existing.migrationId !== expectedMigrationId ||
          existing.sourceFingerprint !== sourceFingerprint ||
          existing.artifactFingerprint !== migration.artifactFingerprint
        )
          throw new WorkspaceMigrationBlockedError(
            "different-v2-active",
            "A different Automerge schema-v2 workspace is already active.",
          );
        const active = await this.loadActivated(existing);
        this.report(
          "active-v2",
          1,
          1,
          "The matching Automerge workspace was already active.",
          true,
          "v2",
        );
        return {
          status: "already-active",
          workspace: active,
          preview: migration.preview,
        };
      }

      this.report(
        "staging-assets",
        0,
        migration.assets.length,
        "Verifying staged assets.",
      );
      for (let index = 0; index < migration.assets.length; index += 1) {
        const asset = migration.assets[index];
        if ((await sha256Bytes(asset.bytes)) !== asset.checksum) {
          throw new WorkspaceMigrationBlockedError(
            "stage-corrupt",
            `Asset ${asset.assetId} is corrupt.`,
          );
        }
        this.report(
          "staging-assets",
          index + 1,
          migration.assets.length,
          "Verifying staged assets.",
        );
      }

      this.report(
        "staging-documents",
        0,
        migration.documents.length,
        "Materializing real Automerge documents.",
      );
      const binaries = await this.materializer.materialize(migration);
      if (binaries.length !== migration.documents.length) {
        throw new WorkspaceMigrationBlockedError(
          "stage-corrupt",
          "Automerge materialization is incomplete.",
        );
      }
      const staged = await this.repo.stage(binaries);
      this.report(
        "staging-documents",
        staged.documents.length,
        migration.documents.length,
        "Staged real Automerge Repo chunks in memory.",
      );

      this.report(
        "verifying-stage",
        0,
        1,
        "Reopening staged Automerge Repo chunks.",
      );
      const activation: V2ActivationRecord = {
        version: ACTIVATION_VERSION,
        schemaVersion: 2,
        format: "canvink-automerge-v2",
        migrationId: expectedMigrationId,
        sourceFingerprint,
        artifactFingerprint: migration.artifactFingerprint,
        activatedAt: this.options.now?.() ?? new Date().toISOString(),
        manifest: structuredClone(migration.manifest),
        documents: structuredClone(staged.documents),
        chunks: await chunkDescriptors(staged.chunks),
        assetIds: migration.assets.map((asset) => asset.assetId),
      };
      const reopened = await this.repo.reopen(
        staged.chunks,
        activation.documents,
      );
      verifyDocumentMap(activation, reopened);
      await verifyAtomicCommit({
        backup,
        activation,
        assets: migration.assets,
        chunks: staged.chunks,
      });
      this.report(
        "verifying-stage",
        1,
        1,
        "Reopened and verified every staged Automerge document.",
      );

      this.report(
        "activating-v2",
        0,
        1,
        "Atomically committing backup, assets, Repo chunks, and activation.",
      );
      let status: "activated" | "already-active";
      try {
        status = await this.activationStore.commit({
          backup,
          activation,
          assets: migration.assets,
          chunks: staged.chunks,
        });
      } catch (error) {
        const reconciled = await this.activationStore.getActivation();
        if (!reconciled || !sameActivation(reconciled, activation)) throw error;
        status = "activated";
      }
      const committedActivation = await this.activationStore.getActivation();
      if (
        !committedActivation ||
        !sameActivation(committedActivation, activation)
      ) {
        throw new Error(
          "The distinct schema-v2 activation selector was not committed.",
        );
      }
      const active = await this.loadActivated(committedActivation);
      this.report(
        "active-v2",
        1,
        1,
        "Automerge schema v2 is committed and active.",
        false,
        "v2",
      );
      return { status, workspace: active, preview: migration.preview };
    } catch (error) {
      const activation = await this.activationStore
        .getActivation()
        .catch(() => undefined);
      const authoritative =
        activation && activation.migrationId === expectedMigrationId
          ? "v2"
          : "v1";
      this.report(
        "failed",
        0,
        1,
        error instanceof Error ? error.message : "Migration failed.",
        this.progress.resumed,
        authoritative,
      );
      throw error;
    }
  }

  async abort(): Promise<void> {
    if (await this.activationStore.getActivation()) {
      throw new Error(
        "Schema v2 is already active and cannot be rolled back by abort.",
      );
    }
    this.report(
      "aborted",
      1,
      1,
      "The in-memory stage was abandoned. Schema v1 remains authoritative.",
    );
  }

  private async loadActivated(
    activation: V2ActivationRecord,
  ): Promise<ActiveV2Workspace> {
    const payload = await this.activationStore.readCommitted(activation);
    const documents = await this.repo.reopen(
      payload.chunks,
      activation.documents,
    );
    verifyDocumentMap(activation, documents);
    return { activation, documents, assets: payload.assets };
  }

  private report(
    phase: MigrationPhase,
    completed: number,
    total: number,
    message: string,
    resumed = this.progress.resumed,
    authoritative: MigrationProgress["authoritative"] = this.progress
      .authoritative,
  ): void {
    this.progress = {
      phase,
      completed,
      total,
      message,
      resumed,
      authoritative,
    };
    this.options.onProgress?.({ ...this.progress });
  }
}

export function createBrowserV2WorkspaceMigrationOrchestrator(
  options: {
    now?: () => string;
    onProgress?: (progress: MigrationProgress) => void;
    activationStore?: V2WorkspaceActivationStore;
    repo?: AutomergeRepoMigrationAdapter;
    materializer?: AutomergeMigrationMaterializer;
  } = {},
): V2WorkspaceMigrationOrchestrator {
  return new V2WorkspaceMigrationOrchestrator(
    { loadWorkspace, loadRecoveryDraft },
    options.activationStore ?? new BrowserV2WorkspaceActivationStore(),
    options.repo ?? new InMemoryAutomergeRepoMigrationAdapter(),
    options.materializer ?? new DefaultAutomergeMigrationMaterializer(),
    { now: options.now, onProgress: options.onProgress },
  );
}

export async function loadActiveV2OrV1(
  source: V1WorkspaceMigrationSource,
  activationStore: V2WorkspaceActivationStore,
  repo: AutomergeRepoMigrationAdapter,
): Promise<WorkspaceLoadResult> {
  const activation = await activationStore.getActivation();
  if (activation) {
    const payload = await activationStore.readCommitted(activation);
    const documents = await repo.reopen(payload.chunks, activation.documents);
    verifyDocumentMap(activation, documents);
    return {
      schemaVersion: 2,
      authoritative: "v2",
      workspace: { activation, documents, assets: payload.assets },
    };
  }
  const loaded = await source.loadWorkspace();
  assertUsableV1Workspace(loaded.workspace);
  assertWorkspaceShape(loaded.workspace);
  return {
    schemaVersion: 1,
    authoritative: "v1",
    reason: "v2-not-activated",
    ...loaded,
  };
}
