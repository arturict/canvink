import { isValidAutomergeUrl } from '@automerge/automerge-repo';
import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceState } from '../domain/types';
import type { MigrationResultV2, StoredDocumentV2 } from '../domain/v2';
import type { AtomicKeyValueStore, AtomicStorageKey } from './browserAssetStore';
import type { RecoveryDraft } from './recoveryJournal';
import {
  BrowserV2WorkspaceActivationStore,
  DefaultAutomergeMigrationMaterializer,
  InMemoryAutomergeRepoMigrationAdapter,
  V2WorkspaceMigrationOrchestrator,
  loadActiveV2OrV1,
  type AutomergeMigrationMaterializer,
  type AutomergeRepoMigrationAdapter,
  type MigrationProgress,
  type V1WorkspaceMigrationSource,
} from './v2WorkspaceStorage';

const TIME = '2026-08-03T08:00:00.000Z';

function workspace(title = 'School'): WorkspaceState {
  return {
    schemaVersion: 1,
    updatedAt: TIME,
    notebooks: [{
      id: 'notebook-1',
      title,
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
          elements: [{
            id: 'image-1', kind: 'image', x: 1, y: 2, width: 30, height: 40,
            dataUrl: 'data:image/png;base64,SGVsbG8=', name: 'diagram.png', alt: '',
            createdAt: TIME, updatedAt: TIME,
          }],
        }],
      }],
    }],
    trash: [],
    activeNotebookId: 'notebook-1',
    activeSectionId: 'section-1',
    activePageId: 'page-1',
  };
}

function emptyWorkspace(): WorkspaceState {
  return {
    schemaVersion: 1,
    updatedAt: TIME,
    notebooks: [],
    trash: [],
    activeNotebookId: '',
    activeSectionId: '',
    activePageId: '',
  };
}

class MemorySource implements V1WorkspaceMigrationSource {
  loadCount = 0;

  constructor(
    private readonly value: WorkspaceState,
    private readonly recovery: RecoveryDraft | null = null,
  ) {}

  async loadWorkspace() {
    this.loadCount += 1;
    return { workspace: structuredClone(this.value), backend: 'indexeddb' as const };
  }

  async loadRecoveryDraft(): Promise<RecoveryDraft | null> {
    return this.recovery ? structuredClone(this.recovery) : null;
  }
}

class MemoryAtomicStore implements AtomicKeyValueStore {
  readonly values = new Map<string, unknown>();
  setManyCalls = 0;
  failBeforeOnce = false;
  failAfterOnce = false;

  private key(key: AtomicStorageKey): string {
    return typeof key === 'string' ? key : `array:${JSON.stringify(key)}`;
  }

  async get<T>(key: AtomicStorageKey): Promise<T | undefined> {
    const value = this.values.get(this.key(key));
    return value === undefined ? undefined : structuredClone(value) as T;
  }

  async setMany(entries: Array<readonly [AtomicStorageKey, unknown]>): Promise<void> {
    this.setManyCalls += 1;
    if (this.failBeforeOnce) {
      this.failBeforeOnce = false;
      throw new Error('simulated atomic transaction abort');
    }
    const transaction = new Map(this.values);
    for (const [key, value] of entries) transaction.set(this.key(key), structuredClone(value));
    this.values.clear();
    for (const [key, value] of transaction) this.values.set(key, value);
    if (this.failAfterOnce) {
      this.failAfterOnce = false;
      throw new Error('simulated lost commit acknowledgement');
    }
  }
}

function recovery(value: WorkspaceState): RecoveryDraft {
  return {
    version: 1,
    sessionId: 'session-1',
    revision: 1,
    capturedAt: TIME,
    workspace: value,
  };
}

function setup(value = workspace(), atomic = new MemoryAtomicStore()) {
  const source = new MemorySource(value);
  const store = new BrowserV2WorkspaceActivationStore(atomic);
  const repo = new InMemoryAutomergeRepoMigrationAdapter();
  const materializer = new DefaultAutomergeMigrationMaterializer();
  const progress: MigrationProgress[] = [];
  const orchestrator = new V2WorkspaceMigrationOrchestrator(
    source,
    store,
    repo,
    materializer,
    { now: () => TIME, onProgress: (item) => progress.push(item) },
  );
  return { atomic, source, store, repo, materializer, progress, orchestrator };
}

describe('schema-v2 Automerge activation', () => {
  it('stages real Repo chunks, reopens them, and atomically commits a distinct activation selector', async () => {
    const context = setup();

    const result = await context.orchestrator.run();

    expect(result.status).toBe('activated');
    expect(result.workspace.documents).toHaveLength(2);
    expect(result.workspace.assets).toHaveLength(1);
    expect(result.workspace.activation.documents.every((item) => isValidAutomergeUrl(item.url))).toBe(true);
    expect(result.workspace.activation.chunks.length).toBeGreaterThan(0);
    expect(context.atomic.values.has('activation:v2')).toBe(true);
    expect(context.atomic.values.has('migration:v1-to-v2:committed')).toBe(false);
    expect([...context.atomic.values.keys()].some((key) => key.startsWith('backup:'))).toBe(true);
    expect([...context.atomic.values.keys()].some((key) => key.startsWith('repo-chunk:'))).toBe(true);
    expect(
      [...context.atomic.values.keys()].some((key) => key.startsWith('array:["automerge-repo"')),
    ).toBe(true);
    expect(context.progress.findIndex((item) => item.phase === 'backing-up-v1')).toBeLessThan(
      context.progress.findIndex((item) => item.phase === 'preparing-v2'),
    );
    expect(context.orchestrator.getStatus()).toMatchObject({
      phase: 'active-v2', authoritative: 'v2', completed: 1, total: 1,
    });
  });

  it('leaves v1 authoritative and no partial records when the atomic transaction aborts, then retries', async () => {
    const atomic = new MemoryAtomicStore();
    atomic.failBeforeOnce = true;
    const first = setup(workspace(), atomic);

    await expect(first.orchestrator.run()).rejects.toThrow(/transaction abort/i);
    expect(atomic.values.size).toBe(0);
    expect(first.orchestrator.getStatus()).toMatchObject({ phase: 'failed', authoritative: 'v1' });

    const retry = setup(workspace(), atomic);
    await expect(retry.orchestrator.run()).resolves.toMatchObject({ status: 'activated' });
    expect(atomic.values.has('activation:v2')).toBe(true);
  });

  it('reconciles a lost acknowledgement by reading the separate activation record', async () => {
    const atomic = new MemoryAtomicStore();
    atomic.failAfterOnce = true;
    const context = setup(workspace(), atomic);

    await expect(context.orchestrator.run()).resolves.toMatchObject({ status: 'activated' });
    expect(context.orchestrator.getStatus().authoritative).toBe('v2');
  });

  it('is idempotent for the same source and rejects a different source without rewriting activation', async () => {
    const context = setup();
    await context.orchestrator.run();
    const writes = context.atomic.setManyCalls;
    await expect(context.orchestrator.run()).resolves.toMatchObject({ status: 'already-active' });
    expect(context.atomic.setManyCalls).toBe(writes);
    const activationBefore = structuredClone(context.atomic.values.get('activation:v2'));

    const different = setup(workspace('Changed'), context.atomic);
    await expect(different.orchestrator.run()).rejects.toMatchObject({
      code: 'different-v2-active',
    });
    expect(context.atomic.values.get('activation:v2')).toEqual(activationBefore);
  });

  it('blocks a divergent recovery draft before backup, materialization, or commit', async () => {
    const atomic = new MemoryAtomicStore();
    const materialize = vi.fn<(migration: MigrationResultV2) => Promise<StoredDocumentV2[]>>();
    const materializer: AutomergeMigrationMaterializer = { materialize };
    const orchestrator = new V2WorkspaceMigrationOrchestrator(
      new MemorySource(workspace(), recovery(workspace('Recovered'))),
      new BrowserV2WorkspaceActivationStore(atomic),
      new InMemoryAutomergeRepoMigrationAdapter(),
      materializer,
      { now: () => TIME },
    );

    await expect(orchestrator.run()).rejects.toMatchObject({ code: 'pending-recovery' });
    expect(materialize).not.toHaveBeenCalled();
    expect(atomic.values.size).toBe(0);
  });

  it('fails closed when Automerge materialization is incomplete', async () => {
    const atomic = new MemoryAtomicStore();
    const materializer: AutomergeMigrationMaterializer = {
      materialize: async () => [],
    };
    const orchestrator = new V2WorkspaceMigrationOrchestrator(
      new MemorySource(workspace()),
      new BrowserV2WorkspaceActivationStore(atomic),
      new InMemoryAutomergeRepoMigrationAdapter(),
      materializer,
      { now: () => TIME },
    );

    await expect(orchestrator.run()).rejects.toMatchObject({ code: 'stage-corrupt' });
    expect(atomic.values.size).toBe(0);
  });

  it('fails closed when staged Repo chunks cannot be reopened', async () => {
    const atomic = new MemoryAtomicStore();
    const realRepo = new InMemoryAutomergeRepoMigrationAdapter();
    const repo: AutomergeRepoMigrationAdapter = {
      stage: (documents) => realRepo.stage(documents),
      reopen: async () => { throw new Error('simulated corrupt Repo chunks'); },
    };
    const orchestrator = new V2WorkspaceMigrationOrchestrator(
      new MemorySource(workspace()),
      new BrowserV2WorkspaceActivationStore(atomic),
      repo,
      new DefaultAutomergeMigrationMaterializer(),
      { now: () => TIME },
    );

    await expect(orchestrator.run()).rejects.toThrow(/corrupt Repo chunks/i);
    expect(atomic.values.size).toBe(0);
    expect(orchestrator.getStatus().authoritative).toBe('v1');
  });

  it('rejects malformed inline assets only after the checked-backup phase and before commit', async () => {
    const value = workspace();
    const image = value.notebooks[0].sections[0].pages[0].elements[0];
    if (image.kind !== 'image') throw new Error('Fixture mismatch.');
    image.dataUrl = 'data:image/png;base64,%%%';
    const context = setup(value);

    await expect(context.orchestrator.run()).rejects.toThrow(/malformed|decode/i);
    expect(context.progress.some((item) => item.phase === 'backing-up-v1' && item.completed === 1)).toBe(true);
    expect(context.atomic.values.size).toBe(0);
  });

  it('loads v1 when activation is absent even if the old JSON migration marker exists', async () => {
    const context = setup();
    context.atomic.values.set('migration:v1-to-v2:committed', {
      migrationId: 'old-json-only',
    });

    await expect(loadActiveV2OrV1(context.source, context.store, context.repo)).resolves.toMatchObject({
      schemaVersion: 1,
      authoritative: 'v1',
      reason: 'v2-not-activated',
      workspace: { activePageId: 'page-1' },
    });
  });

  it('never falls back to v1 when activation exists but a committed chunk is corrupt', async () => {
    const context = setup();
    await context.orchestrator.run();
    const chunkKey = [...context.atomic.values.keys()].find((key) => key.startsWith('repo-chunk:'));
    if (!chunkKey) throw new Error('Expected committed Repo chunk.');
    const chunk = context.atomic.values.get(chunkKey) as { bytes: Uint8Array };
    chunk.bytes[0] ^= 0xff;
    context.atomic.values.set(chunkKey, chunk);
    const fallback = new MemorySource(workspace('must not load'));

    await expect(loadActiveV2OrV1(fallback, context.store, context.repo)).rejects.toThrow(/chunks.*integrity/i);
    expect(fallback.loadCount).toBe(0);
  });

  it('never falls back to v1 when an activated asset is corrupt', async () => {
    const context = setup();
    await context.orchestrator.run();
    const assetKey = [...context.atomic.values.keys()].find((key) => key.startsWith('asset:'));
    if (!assetKey) throw new Error('Expected committed asset.');
    const asset = context.atomic.values.get(assetKey) as { bytes: Uint8Array };
    asset.bytes[0] ^= 0xff;
    context.atomic.values.set(assetKey, asset);
    const fallback = new MemorySource(workspace('must not load'));

    await expect(loadActiveV2OrV1(fallback, context.store, context.repo)).rejects.toThrow(/asset.*integrity/i);
    expect(fallback.loadCount).toBe(0);
  });

  it('never falls back to v1 when the activated rollback backup is corrupt', async () => {
    const context = setup();
    const result = await context.orchestrator.run();
    const backupKey = [...context.atomic.values.keys()].find((key) => key.startsWith('backup:'));
    if (!backupKey) throw new Error('Expected committed backup.');
    const backup = context.atomic.values.get(backupKey) as { workspace: WorkspaceState };
    backup.workspace.notebooks[0].title = 'tampered backup';
    context.atomic.values.set(backupKey, backup);
    const fallback = new MemorySource(workspace('must not load'));

    await expect(loadActiveV2OrV1(fallback, context.store, context.repo)).rejects.toMatchObject({
      code: 'backup-corrupt',
    });
    expect(result.workspace.activation.version).toBe(1);
    expect(fallback.loadCount).toBe(0);
  });

  it('never falls back to v1 when activation contains an invalid Automerge URL', async () => {
    const context = setup();
    await context.orchestrator.run();
    const activation = context.atomic.values.get('activation:v2') as {
      documents: Array<{ url: string }>;
    };
    activation.documents[0].url = 'automerge:invalid';
    context.atomic.values.set('activation:v2', activation);
    const fallback = new MemorySource(workspace('must not load'));

    await expect(loadActiveV2OrV1(fallback, context.store, context.repo)).rejects.toThrow(/invalid Automerge URL/i);
    expect(fallback.loadCount).toBe(0);
  });

  it('explicitly refuses an empty v1 fallback instead of returning a blank workspace', async () => {
    const context = setup(emptyWorkspace());

    await expect(context.orchestrator.run()).rejects.toMatchObject({ code: 'empty-workspace' });
    await expect(loadActiveV2OrV1(context.source, context.store, context.repo)).rejects.toMatchObject({
      code: 'empty-workspace',
    });
    expect(context.atomic.values.size).toBe(0);
  });

  it('abort is safe before activation and forbidden after activation', async () => {
    const context = setup();
    await context.orchestrator.abort();
    expect(context.orchestrator.getStatus()).toMatchObject({ phase: 'aborted', authoritative: 'v1' });
    expect(context.atomic.values.size).toBe(0);

    await context.orchestrator.run();
    await expect(context.orchestrator.abort()).rejects.toThrow(/already active/i);
    expect(context.atomic.values.has('activation:v2')).toBe(true);
  });
});
