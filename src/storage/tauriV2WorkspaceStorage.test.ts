import * as Automerge from '@automerge/automerge';
import { describe, expect, it } from 'vitest';
import type { WorkspaceState } from '../domain/types';
import type { RecoveryDraft } from './recoveryJournal';
import type { V1WorkspaceMigrationSource } from './v2WorkspaceStorage';
import {
  TauriCanvinkStorageBridge,
  TauriV2WorkspaceActivationStore,
  createTauriV2WorkspaceMigrationOrchestrator,
  type TauriInvoke,
} from './tauriV2WorkspaceStorage';
import { createTauriWorkspaceV2Runtime } from './workspaceV2Runtime';
import { sha256Bytes } from '../domain/v2/hash';

const TIME = '2026-08-03T08:00:00.000Z';

function workspace(): WorkspaceState {
  return {
    schemaVersion: 1,
    updatedAt: TIME,
    notebooks: [{
      id: 'notebook-1',
      title: 'School',
      color: '#123456',
      createdAt: TIME,
      updatedAt: TIME,
      sections: [{
        id: 'section-1',
        title: 'Physics',
        createdAt: TIME,
        updatedAt: TIME,
        pages: [{
          id: 'page-1',
          title: 'Vectors',
          mode: 'a4',
          createdAt: TIME,
          updatedAt: TIME,
          elements: [],
        }],
      }],
    }],
    trash: [],
    activeNotebookId: 'notebook-1',
    activeSectionId: 'section-1',
    activePageId: 'page-1',
  };
}

class Source implements V1WorkspaceMigrationSource {
  async loadWorkspace() {
    return { workspace: workspace(), backend: 'tauri' as const };
  }

  async loadRecoveryDraft(): Promise<RecoveryDraft | null> {
    return null;
  }
}

interface StageRequest {
  identity: {
    migrationId: string;
    sourceFingerprint: string;
    artifactFingerprint: string;
  };
  preparedAt: string;
  activationBase64: string;
  backupBase64: string;
  assets: Array<{ assetId: string; dataBase64: string }>;
  repoEntries: Array<{ key: string[]; dataBase64: string }>;
}

class NativeHarness {
  authority: Record<string, unknown> | undefined;
  stage: StageRequest | undefined;
  assets = new Map<string, { assetId: string; dataBase64: string }>();
  repo = new Map<string, { key: string[]; dataBase64: string }>();
  loseCommitAcknowledgement = false;
  receipts = new Map<string, string>();
  importBackups = new Map<string, {
    authority: Record<string, unknown>;
    repo: Array<{ key: string[]; dataBase64: string }>;
  }>();

  readonly invoke: TauriInvoke = async <T>(
    command: string,
    args: Record<string, unknown> = {},
  ): Promise<T> => {
    if (command === 'v2_stage_workspace_migration_base64') {
      this.stage = args.request as StageRequest;
      return this.marker('prepared') as T;
    }
    if (command === 'v2_commit_migration') {
      if (!this.stage) throw new Error('stage missing');
      this.authority = {
        migrationId: this.stage.identity.migrationId,
        activationBase64: this.stage.activationBase64,
        backupBase64: this.stage.backupBase64,
        activatedAt: TIME,
      };
      for (const asset of this.stage.assets) this.assets.set(asset.assetId, asset);
      for (const entry of this.stage.repoEntries) {
        this.repo.set(JSON.stringify(entry.key), entry);
      }
      if (this.loseCommitAcknowledgement) {
        this.loseCommitAcknowledgement = false;
        throw new Error('lost native commit acknowledgement');
      }
      return this.marker('committed') as T;
    }
    if (command === 'v2_get_workspace_authority_base64') {
      return this.authority as T;
    }
    if (command === 'v2_get_asset_base64') {
      const asset = this.assets.get(args.assetId as string);
      if (!asset) return undefined as T;
      return {
        assetId: asset.assetId,
        checksum: asset.assetId,
        size: atob(asset.dataBase64).length,
        dataBase64: asset.dataBase64,
      } as T;
    }
    if (command === 'v2_repo_load_base64') {
      return this.repo.get(JSON.stringify(args.key))?.dataBase64 as T;
    }
    if (command === 'v2_repo_load_range_base64') {
      const prefix = args.prefix as string[];
      return [...this.repo.values()].filter((entry) =>
        prefix.every((part, index) => entry.key[index] === part)) as T;
    }
    if (command === 'v2_repo_commit_base64') {
      for (const mutation of args.mutations as Array<Record<string, unknown>>) {
        const key = mutation.key as string[];
        if (mutation.type === 'remove') this.repo.delete(JSON.stringify(key));
        else this.repo.set(JSON.stringify(key), {
          key,
          dataBase64: mutation.dataBase64 as string,
        });
      }
      return undefined as T;
    }
    if (command === 'v2_additive_import_base64') {
      const request = args.request as Record<string, unknown>;
      const receiptBase64 = request.receiptBase64 as string;
      const receipt = JSON.parse(atob(receiptBase64)) as {
        importId: string;
        status: string;
      };
      const existing = this.receipts.get(receipt.importId);
      if (existing) {
        return {
          importId: receipt.importId,
          status: 'already-committed',
          receiptBase64: existing,
        } as T;
      }
      if (!this.authority) throw new Error('authority missing');
      this.importBackups.set(receipt.importId, {
        authority: structuredClone(this.authority),
        repo: structuredClone([...this.repo.values()]),
      });
      this.authority.activationBase64 = request.activationBase64;
      this.repo.clear();
      for (const entry of request.repoEntries as Array<{ key: string[]; dataBase64: string }>) {
        this.repo.set(JSON.stringify(entry.key), structuredClone(entry));
      }
      this.receipts.set(receipt.importId, receiptBase64);
      return { importId: receipt.importId, status: 'committed', receiptBase64 } as T;
    }
    if (command === 'v2_get_workspace_import_receipt_base64') {
      return this.receipts.get(args.importId as string) as T;
    }
    if (command === 'v2_rollback_workspace_import') {
      const request = args.request as { importId: string };
      const backup = this.importBackups.get(request.importId);
      const encoded = this.receipts.get(request.importId);
      if (!backup || !encoded) throw new Error('import backup missing');
      const receipt = JSON.parse(atob(encoded)) as Record<string, unknown>;
      if (receipt.status === 'rolled-back') {
        return {
          importId: request.importId,
          status: 'already-rolled-back',
          receiptBase64: encoded,
        } as T;
      }
      receipt.status = 'rolled-back';
      const rolledBack = btoa(JSON.stringify(receipt));
      this.receipts.set(request.importId, rolledBack);
      this.authority = structuredClone(backup.authority);
      this.repo.clear();
      for (const entry of backup.repo) this.repo.set(JSON.stringify(entry.key), entry);
      return {
        importId: request.importId,
        status: 'rolled-back',
        receiptBase64: rolledBack,
      } as T;
    }
    if (command === 'v2_commit_workspace_revision_base64') {
      const request = args.request as Record<string, unknown>;
      this.authority = {
        ...this.authority,
        activationBase64: request.activationBase64,
      } as Record<string, unknown>;
      this.repo.clear();
      for (const entry of request.repoEntries as Array<{ key: string[]; dataBase64: string }>) {
        this.repo.set(JSON.stringify(entry.key), structuredClone(entry));
      }
      return 'committed' as T;
    }
    if (command === 'v2_get_migration_marker') return this.marker('prepared') as T;
    if (command === 'v2_rollback_migration') return this.marker('rolled-back') as T;
    throw new Error(`Unexpected invoke ${command}`);
  };

  private marker(status: string) {
    if (!this.stage) throw new Error('stage missing');
    return {
      ...this.stage.identity,
      manifestSha256: `sha256:${'c'.repeat(64)}`,
      status,
      startedAt: TIME,
      completedAt: status === 'prepared' ? null : TIME,
      error: null,
    };
  }
}

describe('Tauri schema-v2 storage', () => {
  it('reconciles a lost native commit acknowledgement and reopens real Repo chunks', async () => {
    const native = new NativeHarness();
    native.loseCommitAcknowledgement = true;
    const migration = createTauriV2WorkspaceMigrationOrchestrator({
      invoke: native.invoke,
      source: new Source(),
      now: () => TIME,
    });

    const result = await migration.run();

    expect(result.status).toBe('activated');
    expect(result.workspace.documents).toHaveLength(2);
    expect(native.authority).toBeDefined();
    expect([...native.repo.values()].every((entry) => entry.key[0] === 'automerge-repo')).toBe(true);
  });

  it('reopens after the live Repo compacted the committed chunks', async () => {
    const native = new NativeHarness();
    const first = createTauriWorkspaceV2Runtime({ invoke: native.invoke, source: new Source(), now: () => TIME });
    await first.startup();
    await first.migrateV1ToV2();

    // automerge-repo compacts a document as the user edits: it loads every chunk of the
    // document, saves one new snapshot and deletes the chunks the activation still lists.
    const decode = (encoded: string) => Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
    const storageIds = new Set([...native.repo.values()]
      .map((entry) => entry.key)
      .filter((key) => key.length > 2)
      .map((key) => key[1]));
    for (const storageId of storageIds) {
      const entries = [...native.repo.values()].filter((entry) => entry.key[1] === storageId);
      let document = Automerge.init<unknown>();
      for (const entry of entries) document = Automerge.loadIncremental(document, decode(entry.dataBase64));
      for (const entry of entries) native.repo.delete(JSON.stringify(entry.key));
      const snapshot = Automerge.save(document);
      const key = ['automerge-repo', storageId, 'snapshot', `compacted-${storageId}`];
      native.repo.set(JSON.stringify(key), { key, dataBase64: btoa(String.fromCharCode(...snapshot)) });
    }

    const reopened = createTauriWorkspaceV2Runtime({ invoke: native.invoke, source: new Source(), now: () => TIME });
    const state = await reopened.startup();
    expect(state.schemaVersion).not.toBe(1);
    expect(reopened.getPageHandle('page-1').doc().title).toBe('Vectors');
  });

  it('still rejects a committed chunk whose bytes changed', async () => {
    const native = new NativeHarness();
    const migrated = await createTauriV2WorkspaceMigrationOrchestrator({
      invoke: native.invoke,
      source: new Source(),
      now: () => TIME,
    }).run();
    const descriptor = migrated.workspace.activation.chunks.find((chunk) => chunk.key.length > 1)!;
    const key = ['automerge-repo', ...descriptor.key];
    native.repo.set(JSON.stringify(key), { key, dataBase64: btoa('tampered') });

    await expect(new TauriV2WorkspaceActivationStore(native.invoke).readCommitted(migrated.workspace.activation))
      .rejects.toThrow(/integrity verification/);
  });

  it('rejects malformed native Base64 without returning bytes to Repo', async () => {
    const bridge = new TauriCanvinkStorageBridge(async <T>() => 'not/base64?' as T);

    await expect(bridge.load(['automerge-repo', 'bad'])).rejects.toThrow(/Base64/i);
  });

  it('encodes live Repo mutations as one native atomic command', async () => {
    let observed: Record<string, unknown> | undefined;
    const bridge = new TauriCanvinkStorageBridge(async <T>(
      command: string,
      args?: Record<string, unknown>,
    ) => {
      expect(command).toBe('v2_repo_commit_base64');
      observed = args;
      return undefined as T;
    });

    await bridge.commit([
      { type: 'save', key: ['automerge-repo', 'one'], data: Uint8Array.of(1, 2, 3) },
      { type: 'remove', key: ['automerge-repo', 'two'] },
    ]);

    expect(observed).toEqual({
      mutations: [
        { type: 'save', key: ['automerge-repo', 'one'], dataBase64: 'AQID' },
        { type: 'remove', key: ['automerge-repo', 'two'] },
      ],
    });
  });

  it('uses dedicated atomic native commands for imports, rollback, and graph revisions', async () => {
    const native = new NativeHarness();
    const migration = createTauriV2WorkspaceMigrationOrchestrator({
      invoke: native.invoke,
      source: new Source(),
      now: () => TIME,
    });
    const migrated = await migration.run();
    const before = migrated.workspace.activation;
    const chunks = before.chunks.map((descriptor) => {
      const physical = ['automerge-repo', ...descriptor.key];
      const encoded = native.repo.get(JSON.stringify(physical))?.dataBase64;
      if (!encoded) throw new Error('test Repo chunk missing');
      return {
        key: [...descriptor.key],
        bytes: Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0)),
      };
    });
    const after = {
      ...structuredClone(before),
      artifactFingerprint: `sha256:${'c'.repeat(64)}` as const,
    };
    const receipt = {
      version: 1 as const,
      importId: 'import-1',
      importArtifactFingerprint: `sha256:${'d'.repeat(64)}` as const,
      priorActivationArtifactFingerprint: before.artifactFingerprint,
      committedActivationArtifactFingerprint: after.artifactFingerprint,
      backupId: 'import-backup:import-1',
      notebookDocumentId: before.documents.find((item) => item.kind === 'notebook')!.documentId,
      pageDocumentIds: before.documents.filter((item) => item.kind === 'page').map((item) => item.documentId),
      assetIds: [],
      preparedAt: TIME,
      status: 'committed' as const,
    };
    const store = new TauriV2WorkspaceActivationStore(native.invoke);

    await expect(store.extendActiveWorkspace({
      expectedActivation: before,
      activation: after,
      assets: [],
      chunks,
      receipt,
    })).resolves.toBe('committed');
    await expect(store.getWorkspaceImportReceipt('import-1')).resolves.toMatchObject({
      importId: 'import-1', status: 'committed',
    });
    await expect(store.rollbackWorkspaceImport('import-1')).resolves.toBe('rolled-back');

    const revision = {
      ...structuredClone(before),
      artifactFingerprint: `sha256:${'e'.repeat(64)}` as const,
    };
    await expect(store.commitActiveWorkspaceRevision({
      expectedActivation: before,
      activation: revision,
      assets: [],
      chunks,
    })).resolves.toBe('committed');
  });
});

describe('native asset reads', () => {
  const nativeAsset = async (bytes: Uint8Array, dataBase64: string): Promise<TauriInvoke> => {
    const assetId = await sha256Bytes(bytes);
    return async <T>() => ({ assetId, checksum: assetId, size: bytes.byteLength, dataBase64 }) as T;
  };

  it('decodes payloads of every padding length', async () => {
    for (const length of [1, 2, 3, 4, 5, 1000]) {
      const bytes = Uint8Array.from({ length }, (_, index) => (index * 37 + 11) & 0xff);
      const encoded = btoa(String.fromCharCode(...bytes));
      const store = new TauriV2WorkspaceActivationStore(await nativeAsset(bytes, encoded));
      const asset = await store.readAsset(await sha256Bytes(bytes));
      expect([...(asset?.bytes ?? [])]).toEqual([...bytes]);
    }
  });

  it('rejects Base64 whose padding bits are not zero', async () => {
    // "QQ==" is the canonical form of one byte 0x41; "QR==" decodes to the same byte.
    const bytes = Uint8Array.of(0x41);
    const store = new TauriV2WorkspaceActivationStore(await nativeAsset(bytes, 'QR=='));
    await expect(store.readAsset(await sha256Bytes(bytes))).rejects.toThrow(/canonical/);
  });
});
