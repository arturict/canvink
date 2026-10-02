import type { StorageKey } from '@automerge/automerge-repo';
import {
  DEFAULT_CANVINK_STORAGE_LIMITS,
  type CanvinkStorageBridge,
  type CanvinkStorageMutation,
  type CanvinkStorageRecord,
  type CanvinkStorageScanLimits,
} from '../crdt/canvinkStorageAdapter';
import { assertWorkspaceShape } from '../domain/validation';
import { canonicalJson, sha256Bytes, sha256Canonical } from '../domain/v2/hash';
import type { AssetBlob, Sha256Checksum } from '../domain/v2/types';
import { WorkerAutomergeMigrationMaterializer, WorkerAutomergeRepoMigrationAdapter } from './automergeTaskClient';
import { loadRecoveryDraft } from './recoveryJournal';
import {
  V2WorkspaceMigrationOrchestrator,
  WorkspaceMigrationBlockedError,
  type MigrationProgress,
  type RepoChunkV2,
  type V1BackupRecord,
  type V1WorkspaceMigrationSource,
  type V2ActivationRecord,
  type V2AtomicCommit,
  type V2CommittedPayload,
  type V2WorkspaceActivationStore,
  type V2WorkspaceDeltaCommit,
  type V2WorkspaceExtensionCommit,
  type V2WorkspaceImportReceipt,
  type V2WorkspaceRevisionCommit,
  type WorkspaceStorageEntry,
} from './v2WorkspaceStorage';
import { loadWorkspace } from './workspaceStorage';

const MAX_REPO_VALUE_BYTES = DEFAULT_CANVINK_STORAGE_LIMITS.maxDataBytes;
const MAX_REPO_RANGE_ENTRIES = DEFAULT_CANVINK_STORAGE_LIMITS.maxRangeEntries;
const MAX_REPO_RANGE_BYTES = DEFAULT_CANVINK_STORAGE_LIMITS.maxRangeBytes;
const MAX_MIGRATION_BYTES = 256 * 1024 * 1024;

export type TauriInvoke = <T>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;

interface NativeWorkspaceAuthority {
  migrationId: string;
  activationBase64: string;
  backupBase64: string;
  activatedAt: string;
}

interface MigrationIdentity {
  migrationId: string;
  sourceFingerprint: Sha256Checksum;
  artifactFingerprint: Sha256Checksum;
}

type NativeMigrationStatus =
  | 'prepared'
  | 'committed'
  | 'rolled-back'
  | 'already-prepared'
  | 'already-committed'
  | 'already-rolled-back';

interface NativeMigrationMarker extends MigrationIdentity {
  manifestSha256: Sha256Checksum;
  status: NativeMigrationStatus;
  startedAt: string;
  completedAt: string | null;
  error: string | null;
}

interface NativeWorkspaceImportResult {
  importId: string;
  status: 'committed' | 'already-committed' | 'rolled-back' | 'already-rolled-back';
  receiptBase64: string;
}

async function defaultInvoke<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(command, args);
}

function assertPlainRecord(
  value: unknown,
  label: string,
  keys: readonly string[],
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} is not an object.`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has an unexpected shape.`);
  }
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function decodeBase64(
  value: unknown,
  label: string,
  maxBytes: number,
  allowEmpty = false,
): Uint8Array {
  if (typeof value !== 'string') throw new Error(`${label} is not a Base64 string.`);
  const maxEncoded = Math.ceil(maxBytes / 3) * 4;
  if (value.length > maxEncoded || (!allowEmpty && value.length === 0)) {
    throw new Error(`${label} exceeds its decoded byte limit.`);
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error(`${label} is not canonical padded Base64.`);
  }
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new Error(`${label} is not valid Base64.`);
  }
  if (binary.length > maxBytes || (!allowEmpty && binary.length === 0)) {
    throw new Error(`${label} exceeds its decoded byte limit.`);
  }
  // A plain loop: Uint8Array.from with a callback costs about 15 times as much
  // per byte, which blocked the main thread for 70 ms on a 700 KB printout.
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  // The pattern above fixes alphabet, padding and length, so the only way to
  // be non-canonical is non-zero padding bits in the last group: re-encode
  // that group alone instead of the whole payload.
  const tail = bytes.length - (bytes.length % 3);
  if (encodeBase64(bytes.subarray(tail)) !== value.slice((tail / 3) * 4)) {
    throw new Error(`${label} is not canonical Base64.`);
  }
  return bytes;
}

function parseJson<T>(bytes: Uint8Array, label: string): T {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new Error(`${label} is not valid UTF-8 JSON.`);
  }
  return value as T;
}

function sameActivation(left: V2ActivationRecord, right: V2ActivationRecord): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function identityOf(activation: V2ActivationRecord): MigrationIdentity {
  return {
    migrationId: activation.migrationId,
    sourceFingerprint: activation.sourceFingerprint,
    artifactFingerprint: activation.artifactFingerprint,
  };
}

function physicalRepoKey(key: StorageKey): string[] {
  return ['automerge-repo', ...key];
}

function assertNativeAuthority(value: unknown): asserts value is NativeWorkspaceAuthority {
  assertPlainRecord(value, 'Native workspace authority', [
    'migrationId', 'activationBase64', 'backupBase64', 'activatedAt',
  ]);
  if (
    typeof value.migrationId !== 'string'
    || typeof value.activationBase64 !== 'string'
    || typeof value.backupBase64 !== 'string'
    || typeof value.activatedAt !== 'string'
  ) throw new Error('Native workspace authority has invalid field types.');
}

function assertNativeMarker(value: unknown): asserts value is NativeMigrationMarker {
  assertPlainRecord(value, 'Native migration marker', [
    'migrationId', 'sourceFingerprint', 'artifactFingerprint', 'manifestSha256',
    'status', 'startedAt', 'completedAt', 'error',
  ]);
  const statuses: NativeMigrationStatus[] = [
    'prepared', 'committed', 'rolled-back', 'already-prepared',
    'already-committed', 'already-rolled-back',
  ];
  if (
    typeof value.migrationId !== 'string'
    || typeof value.sourceFingerprint !== 'string'
    || typeof value.artifactFingerprint !== 'string'
    || typeof value.manifestSha256 !== 'string'
    || typeof value.startedAt !== 'string'
    || !statuses.includes(value.status as NativeMigrationStatus)
    || !(value.completedAt === null || typeof value.completedAt === 'string')
    || !(value.error === null || typeof value.error === 'string')
  ) throw new Error('Native migration marker has invalid field types.');
}

function assertNativeImportResult(value: unknown): asserts value is NativeWorkspaceImportResult {
  assertPlainRecord(value, 'Native workspace import result', [
    'importId', 'status', 'receiptBase64',
  ]);
  const statuses = ['committed', 'already-committed', 'rolled-back', 'already-rolled-back'];
  if (
    typeof value.importId !== 'string'
    || typeof value.status !== 'string'
    || !statuses.includes(value.status)
    || typeof value.receiptBase64 !== 'string'
  ) throw new Error('Native workspace import result has invalid field types.');
}

function workspaceImageRequest(
  expectedActivation: V2ActivationRecord,
  activation: V2ActivationRecord,
  assets: AssetBlob[],
  chunks: RepoChunkV2[],
) {
  return {
    expectedActivationBase64: encodeBase64(
      new TextEncoder().encode(canonicalJson(expectedActivation)),
    ),
    activationBase64: encodeBase64(new TextEncoder().encode(canonicalJson(activation))),
    assets: assets.map((asset) => ({
      assetId: asset.assetId,
      mimeType: 'application/octet-stream',
      dataBase64: encodeBase64(asset.bytes),
      createdAt: activation.activatedAt,
    })),
    repoEntries: chunks.map((chunk) => ({
      key: physicalRepoKey(chunk.key),
      dataBase64: encodeBase64(chunk.bytes),
    })),
  };
}

export class TauriCanvinkStorageBridge implements CanvinkStorageBridge {
  constructor(private readonly invoke: TauriInvoke = defaultInvoke) {}

  async load(key: readonly string[]): Promise<Uint8Array | undefined> {
    const encoded = await this.invoke<unknown>('v2_repo_load_base64', { key: [...key] });
    if (encoded === null || encoded === undefined) return undefined;
    return decodeBase64(encoded, 'Native Repo value', MAX_REPO_VALUE_BYTES, true);
  }

  async loadRange(
    prefix: readonly string[],
    limits: CanvinkStorageScanLimits,
  ): Promise<CanvinkStorageRecord[]> {
    const value = await this.invoke<unknown>('v2_repo_load_range_base64', {
      prefix: [...prefix],
    });
    if (!Array.isArray(value)) throw new Error('Native Repo range is not an array.');
    if (value.length > Math.min(limits.maxEntries, MAX_REPO_RANGE_ENTRIES)) {
      throw new Error('Native Repo range contains too many entries.');
    }
    let total = 0;
    return value.map((entry, index) => {
      assertPlainRecord(entry, `Native Repo range entry ${index + 1}`, ['key', 'dataBase64']);
      if (!Array.isArray(entry.key) || entry.key.some((part) => typeof part !== 'string')) {
        throw new Error(`Native Repo range entry ${index + 1} has an invalid key.`);
      }
      const data = decodeBase64(
        entry.dataBase64,
        `Native Repo range entry ${index + 1}`,
        MAX_REPO_VALUE_BYTES,
        true,
      );
      total += data.byteLength;
      if (total > Math.min(limits.maxBytes, MAX_REPO_RANGE_BYTES)) {
        throw new Error('Native Repo range exceeds the byte limit.');
      }
      return { key: [...entry.key] as string[], data };
    });
  }

  async commit(mutations: readonly CanvinkStorageMutation[]): Promise<void> {
    const payload = mutations.map((mutation) => mutation.type === 'save'
      ? { type: 'save', key: [...mutation.key], dataBase64: encodeBase64(mutation.data) }
      : { type: 'remove', key: [...mutation.key] });
    await this.invoke('v2_repo_commit_base64', { mutations: payload });
  }

  async removeRange(
    prefix: readonly string[],
    limits: CanvinkStorageScanLimits,
  ): Promise<void> {
    await this.loadRange(prefix, limits);
    await this.invoke('v2_repo_remove_range', { prefix: [...prefix] });
  }
}

export class TauriV2WorkspaceActivationStore implements V2WorkspaceActivationStore {
  private readonly repoBridge: TauriCanvinkStorageBridge;

  constructor(private readonly invoke: TauriInvoke = defaultInvoke) {
    this.repoBridge = new TauriCanvinkStorageBridge(invoke);
  }

  async getActivation(): Promise<V2ActivationRecord | undefined> {
    const authority = await this.getAuthority();
    if (!authority) return undefined;
    const activation = parseJson<V2ActivationRecord>(
      decodeBase64(authority.activationBase64, 'Native activation', 16 * 1024 * 1024),
      'Native activation',
    );
    if (
      !activation
      || typeof activation !== 'object'
      || activation.migrationId !== authority.migrationId
    ) throw new Error('Native activation does not match its authority row.');
    return activation;
  }

  async commit(commit: V2AtomicCommit): Promise<'activated' | 'already-active'> {
    const existing = await this.getActivation();
    if (existing) {
      if (!sameActivation(existing, commit.activation)) {
        throw new WorkspaceMigrationBlockedError(
          'different-v2-active',
          'A different native schema-v2 workspace is already active.',
        );
      }
      return 'already-active';
    }
    await this.verifyCommit(commit);
    const identity = identityOf(commit.activation);
    const stageRequest = {
      identity,
      preparedAt: commit.backup.createdAt,
      manifestBase64: encodeBase64(new TextEncoder().encode(canonicalJson(commit.activation.manifest))),
      activationBase64: encodeBase64(new TextEncoder().encode(canonicalJson(commit.activation))),
      backupBase64: encodeBase64(new TextEncoder().encode(canonicalJson(commit.backup))),
      assets: commit.assets.map((asset) => ({
        assetId: asset.assetId,
        mimeType: 'application/octet-stream',
        dataBase64: encodeBase64(asset.bytes),
        createdAt: commit.activation.activatedAt,
      })),
      repoEntries: commit.chunks.map((chunk) => ({
        key: physicalRepoKey(chunk.key),
        dataBase64: encodeBase64(chunk.bytes),
      })),
    };
    let stage: NativeMigrationMarker;
    try {
      const value = await this.invoke<unknown>('v2_stage_workspace_migration_base64', {
        request: stageRequest,
      });
      assertNativeMarker(value);
      stage = value;
    } catch (error) {
      const marker = await this.getMarker(identity.migrationId).catch(() => undefined);
      if (!marker || marker.status === 'rolled-back' || marker.status === 'already-rolled-back') {
        throw error;
      }
      stage = marker;
    }
    if (stage.status === 'committed' || stage.status === 'already-committed') {
      const active = await this.getActivation();
      if (!active || !sameActivation(active, commit.activation)) {
        throw new Error('Native migration is committed without its matching activation selector.');
      }
      return 'already-active';
    }
    if (stage.status !== 'prepared' && stage.status !== 'already-prepared') {
      throw new Error(`Native migration cannot commit from status ${stage.status}.`);
    }
    try {
      const value = await this.invoke<unknown>('v2_commit_migration', {
        request: { identity, committedAt: commit.activation.activatedAt },
      });
      assertNativeMarker(value);
      if (value.status !== 'committed' && value.status !== 'already-committed') {
        throw new Error(`Native migration returned unexpected commit status ${value.status}.`);
      }
    } catch (error) {
      const active = await this.getActivation().catch(() => undefined);
      if (active && sameActivation(active, commit.activation)) return 'activated';
      const marker = await this.getMarker(identity.migrationId).catch(() => undefined);
      if (marker?.status === 'prepared' || marker?.status === 'already-prepared') {
        await this.abort(identity, 'Native activation commit failed before publication.').catch(
          () => undefined,
        );
      }
      throw error;
    }
    const active = await this.getActivation();
    if (!active || !sameActivation(active, commit.activation)) {
      throw new Error('Native activation commit was not confirmed.');
    }
    return 'activated';
  }

  async readBackup(activation: V2ActivationRecord): Promise<V1BackupRecord> {
    const authority = await this.getAuthority();
    if (!authority || authority.migrationId !== activation.migrationId) {
      throw new Error('Committed schema v2 has no matching native authority row.');
    }
    const storedActivation = parseJson<V2ActivationRecord>(
      decodeBase64(authority.activationBase64, 'Native activation', 16 * 1024 * 1024),
      'Native activation',
    );
    if (!sameActivation(storedActivation, activation)) {
      throw new Error('Native authority activation does not match the requested activation.');
    }
    const backup = parseJson<V1BackupRecord>(
      decodeBase64(authority.backupBase64, 'Native v1 backup', MAX_MIGRATION_BYTES),
      'Native v1 backup',
    );
    assertWorkspaceShape(backup.workspace);
    if (
      backup.version !== 1
      || backup.migrationId !== activation.migrationId
      || backup.sourceFingerprint !== activation.sourceFingerprint
      || await sha256Canonical(backup.workspace) !== activation.sourceFingerprint
    ) throw new WorkspaceMigrationBlockedError('backup-corrupt', 'The native v1 backup is corrupt.');
    return backup;
  }

  async readAsset(assetId: Sha256Checksum): Promise<AssetBlob | undefined> {
    const value = await this.invoke<unknown>('v2_get_asset_base64', { assetId });
    if (value === null || value === undefined) return undefined;
    assertPlainRecord(value, `Native asset ${assetId}`, [
      'assetId', 'checksum', 'size', 'dataBase64',
    ]);
    if (
      value.assetId !== assetId
      || value.checksum !== assetId
      || typeof value.size !== 'number'
    ) throw new Error(`Native asset ${assetId} metadata is invalid.`);
    const bytes = decodeBase64(value.dataBase64, `Native asset ${assetId}`, 64 * 1024 * 1024);
    if (bytes.byteLength !== value.size || await sha256Bytes(bytes) !== assetId) {
      throw new Error(`Native asset ${assetId} failed integrity verification.`);
    }
    return { assetId, checksum: assetId, size: bytes.byteLength, bytes };
  }

  async readCommitted(activation: V2ActivationRecord): Promise<V2CommittedPayload> {
    const backup = await this.readBackup(activation);
    const assets: AssetBlob[] = [];
    for (const assetId of activation.assetIds) {
      const asset = await this.readAsset(assetId);
      if (!asset) throw new Error(`Native asset ${assetId} is missing.`);
      assets.push(asset);
    }
    // A delta-committed activation describes live Repo keys only; documents
    // are verified against their heads when the runtime loads them.
    if (activation.layout === 'repo-live') return { backup, assets, chunks: [] };

    // Unlike the browser store, the desktop keeps no separate copy of the committed chunks: the
    // live Repo writes into the same SQLite table and, as the user keeps editing, compacts a
    // document's incremental chunks into a new snapshot and deletes the old ones. A committed
    // chunk that is gone is therefore expected; the document's current chunks stand in for it,
    // and opening the workspace still checks that every live document contains the committed
    // heads. A committed chunk that is present under its content-addressed key must match.
    const chunks: RepoChunkV2[] = [];
    const compactedStorageIds = new Set<string>();
    for (const descriptor of activation.chunks) {
      const bytes = await this.repoBridge.load(physicalRepoKey(descriptor.key));
      if (!bytes && descriptor.key.length > 1) {
        compactedStorageIds.add(descriptor.key[0]);
        continue;
      }
      if (
        !bytes
        || bytes.byteLength !== descriptor.size
        || await sha256Bytes(bytes) !== descriptor.checksum
      ) throw new Error('A native Automerge Repo chunk failed integrity verification.');
      chunks.push({ key: [...descriptor.key], bytes });
    }
    const loadedKeys = new Set(chunks.map((chunk) => JSON.stringify(chunk.key)));
    for (const storageId of compactedStorageIds) {
      const live = await this.repoBridge.loadRange(physicalRepoKey([storageId]), {
        maxEntries: MAX_REPO_RANGE_ENTRIES,
        maxBytes: MAX_REPO_RANGE_BYTES,
      });
      if (live.length === 0) {
        throw new Error('A native Automerge Repo document has no chunks left.');
      }
      for (const record of live) {
        const key = record.key.slice(1);
        if (loadedKeys.has(JSON.stringify(key))) continue;
        loadedKeys.add(JSON.stringify(key));
        chunks.push({ key, bytes: record.data });
      }
    }
    return { backup, assets, chunks };
  }

  async extendActiveWorkspace(
    commit: V2WorkspaceExtensionCommit,
  ): Promise<'committed' | 'already-committed'> {
    const request = {
      ...workspaceImageRequest(
        commit.expectedActivation,
        commit.activation,
        commit.assets,
        commit.chunks,
      ),
      receiptBase64: encodeBase64(
        new TextEncoder().encode(canonicalJson(commit.receipt)),
      ),
    };
    let result: NativeWorkspaceImportResult;
    try {
      const value = await this.invoke<unknown>('v2_additive_import_base64', { request });
      assertNativeImportResult(value);
      result = value;
    } catch (error) {
      const receipt = await this.getWorkspaceImportReceipt(commit.receipt.importId)
        .catch(() => undefined);
      const active = await this.getActivation().catch(() => undefined);
      if (
        !receipt
        || receipt.status !== 'committed'
        || receipt.importArtifactFingerprint !== commit.receipt.importArtifactFingerprint
        || !active
        || !sameActivation(active, commit.activation)
      ) throw error;
      return 'already-committed';
    }
    if (result.importId !== commit.receipt.importId) {
      throw new Error('Native workspace import returned another import ID.');
    }
    const receipt = this.parseImportReceipt(result.receiptBase64);
    if (
      receipt.importId !== commit.receipt.importId
      || receipt.importArtifactFingerprint !== commit.receipt.importArtifactFingerprint
      || receipt.status !== 'committed'
    ) throw new Error('Native workspace import returned a mismatched receipt.');
    const active = await this.getActivation();
    if (!active || !sameActivation(active, commit.activation)) {
      throw new Error('Native additive import was not confirmed by activation:v2.');
    }
    await this.readCommitted(active);
    return result.status === 'already-committed' ? 'already-committed' : 'committed';
  }

  async getWorkspaceImportReceipt(
    importId: string,
  ): Promise<V2WorkspaceImportReceipt | undefined> {
    const value = await this.invoke<unknown>('v2_get_workspace_import_receipt_base64', {
      importId,
    });
    if (value === null || value === undefined) return undefined;
    if (typeof value !== 'string') throw new Error('Native workspace import receipt is invalid.');
    return this.parseImportReceipt(value);
  }

  async rollbackWorkspaceImport(
    importId: string,
  ): Promise<'rolled-back' | 'already-rolled-back'> {
    const value = await this.invoke<unknown>('v2_rollback_workspace_import', {
      request: { importId, rolledBackAt: new Date().toISOString() },
    });
    assertNativeImportResult(value);
    if (value.importId !== importId) throw new Error('Native rollback returned another import ID.');
    const receipt = this.parseImportReceipt(value.receiptBase64);
    if (receipt.importId !== importId || receipt.status !== 'rolled-back') {
      throw new Error('Native rollback returned a mismatched receipt.');
    }
    const active = await this.getActivation();
    if (!active) throw new Error('Native rollback removed activation:v2.');
    // Documents are verified against their heads when the runtime reopens
    // them; reading every asset and chunk back here cost O(workspace).
    return value.status === 'already-rolled-back' ? 'already-rolled-back' : 'rolled-back';
  }

  async commitActiveWorkspaceRevision(
    commit: V2WorkspaceRevisionCommit,
  ): Promise<'committed' | 'already-committed'> {
    const request = workspaceImageRequest(
      commit.expectedActivation,
      commit.activation,
      commit.assets,
      commit.chunks,
    );
    let status: unknown;
    try {
      status = await this.invoke<unknown>('v2_commit_workspace_revision_base64', { request });
    } catch (error) {
      const active = await this.getActivation().catch(() => undefined);
      if (!active || !sameActivation(active, commit.activation)) throw error;
      return 'already-committed';
    }
    if (status !== 'committed' && status !== 'already-committed') {
      throw new Error('Native workspace revision returned an invalid status.');
    }
    const active = await this.getActivation();
    if (!active || !sameActivation(active, commit.activation)) {
      throw new Error('Native workspace revision was not confirmed by activation:v2.');
    }
    await this.readCommitted(active);
    return status;
  }

  async stageWorkspaceEntries(
    entries: WorkspaceStorageEntry[],
    assets: AssetBlob[],
  ): Promise<void> {
    if (entries.length === 0 && assets.length === 0) return;
    await this.invoke('v2_stage_workspace_entries_base64', {
      request: {
        assets: assets.map((asset) => ({
          assetId: asset.assetId,
          mimeType: 'application/octet-stream',
          dataBase64: encodeBase64(asset.bytes),
          createdAt: new Date().toISOString(),
        })),
        repoEntries: entries.map((entry) => ({
          key: [...entry.key],
          dataBase64: encodeBase64(entry.bytes),
        })),
      },
    });
  }

  async commitWorkspaceDelta(
    commit: V2WorkspaceDeltaCommit,
  ): Promise<'committed' | 'already-committed'> {
    const request = {
      expectedActivationBase64: encodeBase64(
        new TextEncoder().encode(canonicalJson(commit.expectedActivation)),
      ),
      activationBase64: encodeBase64(new TextEncoder().encode(canonicalJson(commit.activation))),
      receiptBase64: commit.receipt
        ? encodeBase64(new TextEncoder().encode(canonicalJson(commit.receipt)))
        : null,
      assets: commit.assets.map((asset) => ({
        assetId: asset.assetId,
        mimeType: 'application/octet-stream',
        dataBase64: encodeBase64(asset.bytes),
        createdAt: commit.activation.activatedAt,
      })),
      repoEntries: commit.entries.map((entry) => ({
        key: [...entry.key],
        dataBase64: encodeBase64(entry.bytes),
      })),
      removedPrefixes: commit.removedPrefixes.map((prefix) => [...prefix]),
    };
    let status: unknown;
    try {
      status = await this.invoke<unknown>('v2_commit_workspace_delta_base64', { request });
    } catch (error) {
      const active = await this.getActivation().catch(() => undefined);
      if (!active || !sameActivation(active, commit.activation)) throw error;
      return 'already-committed';
    }
    if (status !== 'committed' && status !== 'already-committed') {
      throw new Error('Native delta commit returned an invalid status.');
    }
    const active = await this.getActivation();
    if (!active || !sameActivation(active, commit.activation)) {
      if (status === 'already-committed' && commit.receipt) return status;
      throw new Error('Native delta commit was not confirmed by activation:v2.');
    }
    return status;
  }

  async abort(identity: MigrationIdentity, reason = 'Migration aborted.'): Promise<void> {
    const value = await this.invoke<unknown>('v2_rollback_migration', {
      request: { identity, rolledBackAt: new Date().toISOString(), reason },
    });
    assertNativeMarker(value);
    if (value.status !== 'rolled-back' && value.status !== 'already-rolled-back') {
      throw new Error(`Native migration returned unexpected rollback status ${value.status}.`);
    }
  }

  private async getAuthority(): Promise<NativeWorkspaceAuthority | undefined> {
    const value = await this.invoke<unknown>('v2_get_workspace_authority_base64');
    if (value === null || value === undefined) return undefined;
    assertNativeAuthority(value);
    return value;
  }

  private async getMarker(migrationId: string): Promise<NativeMigrationMarker | undefined> {
    const value = await this.invoke<unknown>('v2_get_migration_marker', { migrationId });
    if (value === null || value === undefined) return undefined;
    assertNativeMarker(value);
    return value;
  }

  private parseImportReceipt(encoded: string): V2WorkspaceImportReceipt {
    const receipt = parseJson<V2WorkspaceImportReceipt>(
      decodeBase64(encoded, 'Native workspace import receipt', 16 * 1024 * 1024),
      'Native workspace import receipt',
    );
    if (
      !receipt
      || typeof receipt !== 'object'
      || receipt.version !== 1
      || typeof receipt.importId !== 'string'
      || (receipt.status !== 'committed' && receipt.status !== 'rolled-back')
    ) throw new Error('Native workspace import receipt is malformed.');
    return receipt;
  }

  private async verifyCommit(commit: V2AtomicCommit): Promise<void> {
    if (
      commit.activation.version !== 1
      || commit.activation.schemaVersion !== 2
      || commit.activation.format !== 'canvink-automerge-v2'
      || commit.backup.migrationId !== commit.activation.migrationId
      || commit.backup.sourceFingerprint !== commit.activation.sourceFingerprint
      || commit.assets.length !== commit.activation.assetIds.length
      || commit.chunks.length !== commit.activation.chunks.length
    ) throw new Error('Native schema-v2 commit is malformed or incomplete.');
    assertWorkspaceShape(commit.backup.workspace);
    if (await sha256Canonical(commit.backup.workspace) !== commit.activation.sourceFingerprint) {
      throw new WorkspaceMigrationBlockedError('backup-corrupt', 'The native v1 backup is corrupt.');
    }
    let total = 0;
    for (const asset of commit.assets) total += asset.bytes.byteLength;
    for (const chunk of commit.chunks) total += chunk.bytes.byteLength;
    if (!Number.isSafeInteger(total) || total > MAX_MIGRATION_BYTES) {
      throw new Error('Native schema-v2 commit exceeds the migration byte limit.');
    }
  }
}

export function createTauriV2WorkspaceMigrationOrchestrator(options: {
  invoke?: TauriInvoke;
  now?: () => string;
  onProgress?: (progress: MigrationProgress) => void;
  activationStore?: TauriV2WorkspaceActivationStore;
  source?: V1WorkspaceMigrationSource;
} = {}): V2WorkspaceMigrationOrchestrator {
  const activationStore = options.activationStore
    ?? new TauriV2WorkspaceActivationStore(options.invoke);
  return new V2WorkspaceMigrationOrchestrator(
    options.source ?? { loadWorkspace, loadRecoveryDraft },
    activationStore,
    new WorkerAutomergeRepoMigrationAdapter(),
    new WorkerAutomergeMigrationMaterializer(),
    { now: options.now, onProgress: options.onProgress },
  );
}
