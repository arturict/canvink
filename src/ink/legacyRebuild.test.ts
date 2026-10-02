import { afterEach, describe, expect, it, vi } from 'vitest';
import { getSharedAutomergeSnapshot, type LivePageDocV2 } from '../crdt';
import type { WorkspaceState } from '../domain/types';
import type { StrokeElementV2 } from '../domain/v2';
import type { PageDocV3 } from '../domain/v3';
import { DEFAULT_MATH_PAGE_SETTINGS } from '../domain/v3';
import { applyPageElementChanges } from '../editor/pageChanges';
import type { RecoveryDraft } from '../storage/recoveryJournal';
import { MemoryWorkspaceStore, memoryRepoFactory } from '../storage/testing/memoryWorkspaceStore';
import {
  BrowserV2WorkspaceActivationStore,
  DefaultAutomergeMigrationMaterializer,
  InMemoryAutomergeRepoMigrationAdapter,
  V2WorkspaceMigrationOrchestrator,
  type V1WorkspaceMigrationSource,
} from '../storage/v2WorkspaceStorage';
import { WorkspaceV2Runtime, type V2RuntimeState } from '../storage/workspaceV2Runtime';
import { hasLegacyInk, LegacyPageRebuilder, type RebuildRuntime } from './legacyRebuild';
import { pendingInk } from './pendingInk';
import { claimChange, leaseWinner, swappedDocuments } from './rebuildLease';
import { referencedInkSegments } from './projection';
import { MemorySegmentBackend, resetInkSegments } from './segmentStore';

const TIME = '2026-09-25T08:00:00.000Z';

const source: V1WorkspaceMigrationSource = {
  loadWorkspace: async () => ({
    workspace: {
      schemaVersion: 1, updatedAt: TIME,
      notebooks: [{
        id: 'notebook-1', title: 'Schule', color: '#123456', createdAt: TIME, updatedAt: TIME,
        sections: [{
          id: 'section-1', title: 'Physik', createdAt: TIME, updatedAt: TIME,
          pages: [{ id: 'page-1', title: 'Start', mode: 'a4', createdAt: TIME, updatedAt: TIME, elements: [] }],
        }],
      }],
      trash: [], activeNotebookId: 'notebook-1', activeSectionId: 'section-1', activePageId: 'page-1',
    } satisfies WorkspaceState,
    backend: 'indexeddb' as const,
  }),
  loadRecoveryDraft: async (): Promise<RecoveryDraft | null> => null,
};

function stroke(id: string, x: number): StrokeElementV2 {
  return {
    id, kind: 'stroke', frame: { x, y: x, width: 40, height: 20, rotation: 0 },
    createdAt: TIME, updatedAt: TIME, locked: false, tool: 'pen', color: '#111111', size: 2, opacity: 1,
    points: Array.from({ length: 8 }, (_, point) => ({
      x: x + point, y: x + point * 2, pressure: 0.5, tiltX: 0, tiltY: 0, time: point, pointerType: 'pen',
    })),
  };
}

function emptyPage(pageId: string, extra: Partial<PageDocV3> = {}): PageDocV3 {
  return {
    schemaVersion: 3, documentId: `page:${pageId}`, kind: 'page', notebookId: 'notebook-1', sectionId: 'section-1', pageId,
    title: `Seite ${pageId}`, tags: [], pageType: 'a4', background: { type: 'grid', color: '#ffffff' },
    createdAt: TIME, updatedAt: TIME, elementsById: {}, zOrder: [], mathSettings: { ...DEFAULT_MATH_PAGE_SETTINGS },
    pageContent: { version: 1, kind: 'canvas' }, version: { protocol: 'uninitialized', heads: [] }, ...extra,
  };
}

async function workspaceWithLegacyPage(strokes: number) {
  const store = new MemoryWorkspaceStore();
  const activationStore = new BrowserV2WorkspaceActivationStore(store);
  const migrationFactory = () => new V2WorkspaceMigrationOrchestrator(
    source, activationStore, new InMemoryAutomergeRepoMigrationAdapter(), new DefaultAutomergeMigrationMaterializer(), { now: () => TIME },
  );
  await migrationFactory().run();
  const runtime = new WorkspaceV2Runtime({
    source, activationStore, repoFactory: memoryRepoFactory(store), migrationFactory, pageCacheSize: 2, indexWriteDelayMs: 10,
  });
  await runtime.startup();
  const state = (await runtime.ensureSchemaV3()) as V2RuntimeState;
  await runtime.commitWorkspaceGraphRevision({
    operationId: 'add-pages',
    expectedActivationArtifactFingerprint: state.activation.artifactFingerprint,
    message: 'Add pages',
    newDocuments: [
      emptyPage('legacy', { tags: ['pinned', 'Physik'] }),
      emptyPage('child', { parentPageId: 'legacy' }),
      emptyPage('after'),
    ],
    changes: [{
      documentId: 'notebook:notebook-1',
      change: (document) => {
        if (document.kind !== 'notebook') throw new Error('Expected notebook.');
        document.sections[0].pageDocumentIds.push('page:legacy', 'page:child', 'page:after');
      },
    }],
    updateManifest: (manifest) => { manifest.pageDocumentIds.push('page:legacy', 'page:child', 'page:after'); },
  });
  // The strokes are written into the page document itself, as pages did before segments.
  const session = await runtime.preparePageWrite('legacy');
  const upserts = Array.from({ length: strokes }, (_, index) => stroke(`legacy-s${index}`, index));
  session.change({ message: 'Draw' }, (draft) => {
    applyPageElementChanges(draft, { upserts }, {}, TIME, []);
  });
  await runtime.flush();
  return { runtime };
}

const listed = (runtime: WorkspaceV2Runtime): string[] => {
  const state = runtime.getState() as V2RuntimeState;
  return state.notebooks[0].sections[0].pageDocumentIds;
};

const strokeCount = (runtime: WorkspaceV2Runtime, documentId: string): Promise<number> =>
  runtime.readDocument(documentId, (document) => Object.values(
    getSharedAutomergeSnapshot<LivePageDocV2>(document as never).elementsById).filter((element) => element.kind === 'stroke').length);

function rebuilder(runtime: WorkspaceV2Runtime, deviceId: string, extra: Partial<ConstructorParameters<typeof LegacyPageRebuilder>[0]> = {}) {
  return new LegacyPageRebuilder({
    runtime: runtime as unknown as RebuildRuntime,
    deviceId,
    minBytes: 3_000,
    settleMs: 0,
    graceMs: 0,
    sleep: () => Promise.resolve(),
    ...extra,
  });
}

afterEach(() => pendingInk().reset());

describe('automatic rebuild of legacy pages', () => {
  it('replaces the document in place: same page id, place, level, tags and title, no duplicate, no trash', async () => {
    resetInkSegments(new MemorySegmentBackend());
    const { runtime } = await workspaceWithLegacyPage(60);
    const before = listed(runtime);
    expect(before).toEqual(['page:page-1', 'page:legacy', 'page:child', 'page:after']);
    const legacyIndex = before.indexOf('page:legacy');
    // Stored as elements of the document, not in a segment.
    await runtime.readDocument('page:legacy', (document) => expect(referencedInkSegments(document)).toHaveLength(0));
    await runtime.readDocument('page:legacy', (document) => expect(hasLegacyInk(document)).toBe(true));

    const worker = rebuilder(runtime, 'device-a');
    expect(await worker.rebuildDocument('page:legacy')).toBe('rebuilt');

    const after = listed(runtime);
    expect(after).toEqual(['page:page-1', 'page:legacy~r1', 'page:child', 'page:after']);
    expect(after.indexOf('page:legacy~r1')).toBe(legacyIndex);
    const state = runtime.getState() as V2RuntimeState;
    const page = state.pages.find((candidate) => candidate.documentId === 'page:legacy~r1');
    expect(page).toMatchObject({ pageId: 'legacy', title: 'Seite legacy', notebookId: 'notebook-1', sectionId: 'section-1' });
    expect(page?.tags).toEqual(['pinned', 'Physik']);
    expect(state.pages.find((candidate) => candidate.pageId === 'child')?.parentPageId).toBe('legacy');
    expect(state.activation.manifest.trash).toEqual([]);
    // The page id still resolves to exactly one document, the listed one.
    expect(await runtime.readPage('legacy', (document) => document.documentId)).toBe('page:legacy~r1');
    expect(await strokeCount(runtime, 'page:legacy~r1')).toBe(60);
    await runtime.readDocument('page:legacy~r1', (document) => expect(referencedInkSegments(document).length).toBeGreaterThan(0));
    // Nothing of the copy is left to rebuild, however large it stays.
    await runtime.readDocument('page:legacy~r1', (document) => expect(hasLegacyInk(document)).toBe(false));
    // The claim was released with the swap.
    expect(leaseWinner(state.notebooks[0], 'page:legacy', Date.now())).toBeUndefined();

    // The hidden original goes once the copy is safe; other devices are told to retire it.
    worker.start();
    await worker.tick();
    worker.stop();
    const dropped = runtime.getState() as V2RuntimeState;
    expect(dropped.pages.filter((candidate) => candidate.pageId === 'legacy').map((candidate) => candidate.documentId)).toEqual(['page:legacy~r1']);
    expect(swappedDocuments(dropped.notebooks[0])).toEqual([{ replacement: 'page:legacy~r1', replaced: 'page:legacy' }]);
    await runtime.shutdown();
  });

  it('leaves a page alone that another device holds the claim on, and touches nothing', async () => {
    resetInkSegments(new MemorySegmentBackend());
    const { runtime } = await workspaceWithLegacyPage(30);
    const state = (await runtime.ensureSchemaV3()) as V2RuntimeState;
    await runtime.commitWorkspaceGraphRevision({
      operationId: 'foreign-claim',
      expectedActivationArtifactFingerprint: state.activation.artifactFingerprint,
      message: 'Foreign claim',
      changes: [{
        documentId: 'notebook:notebook-1',
        change: (document) => claimChange('page:legacy', 'device-a', new Date(Date.now() - 1000))(document as never),
      }],
    });
    const worker = rebuilder(runtime, 'device-b');
    expect(await worker.rebuildDocument('page:legacy')).toBe('leased');
    expect(listed(runtime)).toContain('page:legacy');
    expect(worker.claimsOn('page:legacy')).toEqual(['device-a']);
    await runtime.shutdown();
  });

  it('takes over a page whose claim has expired', async () => {
    resetInkSegments(new MemorySegmentBackend());
    const { runtime } = await workspaceWithLegacyPage(30);
    const state = (await runtime.ensureSchemaV3()) as V2RuntimeState;
    await runtime.commitWorkspaceGraphRevision({
      operationId: 'old-claim',
      expectedActivationArtifactFingerprint: state.activation.artifactFingerprint,
      message: 'Old claim',
      changes: [{
        documentId: 'notebook:notebook-1',
        change: (document) => claimChange('page:legacy', 'device-a', new Date(Date.now() - 60 * 60_000))(document as never),
      }],
    });
    expect(await rebuilder(runtime, 'device-b').rebuildDocument('page:legacy')).toBe('rebuilt');
    expect(listed(runtime)).toContain('page:legacy~r1');
    await runtime.shutdown();
  });

  it('backs off when a rival claim that arrives while it settles wins', async () => {
    resetInkSegments(new MemorySegmentBackend());
    const { runtime } = await workspaceWithLegacyPage(30);
    const worker = rebuilder(runtime, 'device-b', {
      // A rival device's earlier claim reaches this device during the settle time.
      sleep: async () => {
        const state = (await runtime.ensureSchemaV3()) as V2RuntimeState;
        await runtime.commitWorkspaceGraphRevision({
          operationId: 'rival',
          expectedActivationArtifactFingerprint: state.activation.artifactFingerprint,
          message: 'Rival',
          changes: [{
            documentId: 'notebook:notebook-1',
            change: (document) => claimChange('page:legacy', 'device-a', new Date(Date.now() - 5000))(document as never),
          }],
        });
      },
      settleMs: 1,
    });
    expect(await worker.rebuildDocument('page:legacy')).toBe('lost');
    expect(listed(runtime)).toContain('page:legacy');
    expect(worker.claimsOn('page:legacy')).toEqual(['device-a']);
    await runtime.shutdown();
  });

  it('keeps the strokes drawn while the page was being rebuilt', async () => {
    resetInkSegments(new MemorySegmentBackend());
    const { runtime } = await workspaceWithLegacyPage(40);
    const worker = rebuilder(runtime, 'device-a');
    const swapping = worker.rebuildDocument('page:legacy');
    // A stroke lands in the pending journal of the original while the copy is built.
    pendingInk().upsert('page:legacy', stroke('late', 500));
    await swapping;
    await runtime.sealPendingInk('page:legacy~r1');
    expect(await strokeCount(runtime, 'page:legacy~r1')).toBeGreaterThanOrEqual(40);
    await runtime.shutdown();
  });

  it('leaves a large page alone that holds no strokes of its own, and looks at it only once', async () => {
    resetInkSegments(new MemorySegmentBackend());
    const { runtime } = await workspaceWithLegacyPage(0);
    const marked = new Set<string>();
    const progress: number[] = [];
    const worker = rebuilder(runtime, 'device-a', {
      minBytes: 1,
      inkFree: { has: (documentId) => marked.has(documentId), add: (documentId) => { marked.add(documentId); } },
      onProgress: (remaining) => progress.push(remaining),
    });
    const rebuilt: string[] = [];
    const original = worker.rebuildDocument.bind(worker);
    worker.rebuildDocument = async (documentId: string) => {
      rebuilt.push(documentId);
      return original(documentId);
    };
    const reads = vi.spyOn(runtime, 'readDocument');
    worker.start();
    expect(await worker.tick()).toBe('idle');
    expect(rebuilt).toEqual([]);
    expect(progress.at(-1)).toBe(0);
    // Every listed page was looked at and remembered ...
    expect(marked.size).toBeGreaterThanOrEqual(4);
    const readsAfterFirstLook = reads.mock.calls.length;
    // ... and the next look does not load any of them again.
    expect(await worker.tick()).toBe('idle');
    expect(reads.mock.calls.length).toBe(readsAfterFirstLook);
    // A new rebuilder on the same device skips the marked pages without loading them.
    const again = rebuilder(runtime, 'device-a', { minBytes: 1, inkFree: { has: (documentId) => marked.has(documentId), add: () => undefined } });
    again.start();
    expect(await again.tick()).toBe('idle');
    expect(reads.mock.calls.length).toBe(readsAfterFirstLook);
    worker.stop();
    again.stop();
    await runtime.shutdown();
  });

  it('rebuilds only pages that are large enough, recent pages first', async () => {
    resetInkSegments(new MemorySegmentBackend());
    const { runtime } = await workspaceWithLegacyPage(60);
    const order: string[] = [];
    const worker = rebuilder(runtime, 'device-a', { minBytes: 3_000, recentPageIds: () => ['legacy'] });
    const original = worker.rebuildDocument.bind(worker);
    worker.rebuildDocument = async (documentId: string) => {
      order.push(documentId);
      return original(documentId);
    };
    worker.start();
    // Only the page with ink passes the size threshold.
    expect(await worker.tick()).toBe('rebuilt');
    expect(order).toEqual(['page:legacy']);
    expect(await worker.tick()).toBe('idle');
    worker.stop();
    await runtime.shutdown();
  });
});

describe('rebuild schedule', () => {
  it('follows a rebuilt page with the next one after a moment and waits the idle interval otherwise', async () => {
    vi.useFakeTimers();
    try {
      const worker = new LegacyPageRebuilder({ runtime: {} as unknown as RebuildRuntime, deviceId: 'device-a' });
      const tick = vi.fn<() => Promise<'rebuilt' | 'idle'>>()
        .mockResolvedValueOnce('rebuilt')
        .mockResolvedValueOnce('rebuilt')
        .mockResolvedValue('idle');
      worker.tick = tick;
      worker.start();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(tick).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(tick).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(tick).toHaveBeenCalledTimes(3);
      // Idle: the next look is 20 s away.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(tick).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(tick).toHaveBeenCalledTimes(4);
      worker.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
