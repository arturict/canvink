import { describe, expect, it } from 'vitest';
import { getSharedAutomergeSnapshot, type LivePageDocV2 } from '../../crdt';
import type { WorkspaceState } from '../../domain/types';
import { MemoryWorkspaceStore, memoryRepoFactory } from '../../storage/testing/memoryWorkspaceStore';
import {
  BrowserV2WorkspaceActivationStore,
  DefaultAutomergeMigrationMaterializer,
  InMemoryAutomergeRepoMigrationAdapter,
  V2WorkspaceMigrationOrchestrator,
  type V1WorkspaceMigrationSource,
} from '../../storage/v2WorkspaceStorage';
import { WorkspaceV2Runtime } from '../../storage/workspaceV2Runtime';
import { syntheticExportMap } from '../../../scripts/onenote-synthetic-export.mjs';
import { benchConfig, exportFolderFiles, log, memoryUsage, writeJson } from '../../../scripts/onenote-bench-support.mjs';
import { desktopExportFilesFromEntries, openOneNoteDesktopExport } from '../onenoteDesktop/convert';
import { applyOneNoteImportApplication, prepareOneNoteImportApplication } from './application';
import { createWorkspaceV2RuntimeOneNoteApplyTarget } from './workspaceV2RuntimeAdapter';

const TIME = '2026-09-25T08:00:00.000Z';
const PAGE_CACHE = 2;

function workspace(): WorkspaceState {
  return {
    schemaVersion: 1,
    updatedAt: TIME,
    notebooks: [{
      id: 'notebook-1',
      title: 'Schule',
      color: '#123456',
      createdAt: TIME,
      updatedAt: TIME,
      sections: [{
        id: 'section-1',
        title: 'Physik',
        createdAt: TIME,
        updatedAt: TIME,
        pages: [{ id: 'page-1', title: 'Vektoren', mode: 'a4', createdAt: TIME, updatedAt: TIME, elements: [] }],
      }],
    }],
    trash: [],
    activeNotebookId: 'notebook-1',
    activeSectionId: 'section-1',
    activePageId: 'page-1',
  };
}

async function openRuntime(): Promise<WorkspaceV2Runtime> {
  const store = new MemoryWorkspaceStore();
  const value = workspace();
  const source: V1WorkspaceMigrationSource = {
    loadWorkspace: async () => ({ workspace: structuredClone(value), backend: 'indexeddb' as const }),
    loadRecoveryDraft: async () => null,
  };
  const activationStore = new BrowserV2WorkspaceActivationStore(store);
  const migrationFactory = () => new V2WorkspaceMigrationOrchestrator(
    source,
    activationStore,
    new InMemoryAutomergeRepoMigrationAdapter(),
    new DefaultAutomergeMigrationMaterializer(),
    { now: () => TIME },
  );
  await migrationFactory().run();
  const runtime = new WorkspaceV2Runtime({
    source,
    activationStore,
    repoFactory: memoryRepoFactory(store),
    migrationFactory,
    acquireWriteAccess: async () => 'indexeddb' as const,
    pageCacheSize: PAGE_CACHE,
  });
  await runtime.startup();
  const state = await runtime.ensureSchemaV3();
  if (state.schemaVersion !== 3) throw new Error('Expected schema v3.');
  return runtime;
}

async function stageExport(runtime: WorkspaceV2Runtime, pages: number) {
  const { entries, totals } = await syntheticExportMap({
    pages,
    strokes: pages * 60,
    points: pages * 600,
    printouts: Math.ceil(pages / 2),
    maxStrokes: 400,
    seed: 3,
  });
  const acquisition = await openOneNoteDesktopExport(desktopExportFilesFromEntries(entries), { createdAt: TIME });
  const target = createWorkspaceV2RuntimeOneNoteApplyTarget(runtime);
  const stage = await prepareOneNoteImportApplication({ outline: acquisition.outline, source: acquisition.reader, target });
  return { stage, target, totals };
}

describe('OneNote import into the real workspace runtime', () => {
  it('writes a many-page notebook with a bounded number of loaded pages, and every page reads back', async () => {
    const runtime = await openRuntime();
    const { stage, target, totals } = await stageExport(runtime, 48);
    let peakLoaded = 0;
    const result = await applyOneNoteImportApplication(target, stage, {
      approvalArtifactFingerprint: stage.review.approvalArtifactFingerprint,
      onProgress: () => {
        peakLoaded = Math.max(peakLoaded, runtime.getMemoryDiagnostics().loadedPages);
      },
    });

    expect(result.status).toBe('committed');
    expect(result.stats).toMatchObject({ pages: 48, strokes: totals.strokes });
    expect(result.stats.assets).toBe(totals.printoutPages + totals.documents);
    expect(result.timing.totalMs).toBeGreaterThan(0);
    // The active page plus the LRU cache, never the imported notebook.
    expect(peakLoaded).toBeLessThanOrEqual(1 + PAGE_CACHE);
    const diagnostics = runtime.getMemoryDiagnostics();
    expect(diagnostics.loadedPages).toBeLessThanOrEqual(1 + PAGE_CACHE);
    expect(diagnostics.pageDocuments).toBe(49);

    const state = runtime.getState();
    if (state.schemaVersion !== 3) throw new Error('Expected schema v3.');
    expect(state.notebooks.map((notebook) => notebook.title)).toEqual(['Schule', 'bm (synthetisch) (OneNote import)']);
    let strokes = 0;
    for (const page of stage.pages) {
      const read = await runtime.readPage(page.pageId, (document) => ({
        title: document.title,
        strokes: Object.values(getSharedAutomergeSnapshot<LivePageDocV2>(document).elementsById).filter((element) => element.kind === 'stroke').length,
        printouts: Object.values(getSharedAutomergeSnapshot<LivePageDocV2>(document).elementsById).filter((element) => element.kind === 'pdf').length,
      }));
      expect(read.title).toBe(page.outline.title);
      strokes += read.strokes;
      expect(runtime.getMemoryDiagnostics().loadedPages).toBeLessThanOrEqual(1 + PAGE_CACHE);
    }
    expect(strokes).toBe(totals.strokes);

    // Applying the same reviewed stage again (a lost acknowledgement) is recognised.
    const replay = await applyOneNoteImportApplication(target, stage, {
      approvalArtifactFingerprint: stage.review.approvalArtifactFingerprint,
    });
    expect(replay).toMatchObject({ status: 'already-committed', importId: result.importId });
  }, 120_000);

  it('leaves the workspace unchanged when a page fails part-way', async () => {
    const runtime = await openRuntime();
    const before = runtime.getState();
    if (before.schemaVersion !== 3) throw new Error('Expected schema v3.');
    const { stage, target } = await stageExport(runtime, 12);
    const readPage = stage.source.readPage;
    let reads = 0;
    stage.source = {
      ...stage.source,
      readPage: async (outline, signal) => {
        reads += 1;
        if (reads === 9) throw new Error('Seite 9 ist beschädigt.');
        return readPage(outline, signal);
      },
    };
    await expect(applyOneNoteImportApplication(target, stage, {
      approvalArtifactFingerprint: stage.review.approvalArtifactFingerprint,
    })).rejects.toThrow('Seite 9 ist beschädigt.');

    const after = runtime.getState();
    if (after.schemaVersion !== 3) throw new Error('Expected schema v3.');
    expect(after.activation.artifactFingerprint).toBe(before.activation.artifactFingerprint);
    expect(after.notebooks.map((notebook) => notebook.title)).toEqual(['Schule']);
    expect(runtime.getMemoryDiagnostics().pageDocuments).toBe(1);
  }, 60_000);
});

/**
 * Benchmark at full size, outside the normal test run:
 *   node scripts/onenote-synthetic-export.mjs --out /tmp/bm-export
 *   CANVINK_ONENOTE_BENCH_EXPORT=/tmp/bm-export npx vitest run src/import/apply/runtimeImport.test.ts
 * Optional CANVINK_ONENOTE_BENCH_OUT=<file> receives the JSON summary.
 * It imports through the real runtime with an in-memory store (which keeps
 * every stored byte, so RSS includes the written workspace) and samples the
 * process memory at every page.
 */
const bench = benchConfig();

describe.runIf(Boolean(bench.exportDir))('OneNote import benchmark (node, real runtime)', () => {
  it('imports the export and reports time and memory', async () => {
    const root = bench.exportDir!;
    const runtime = await openRuntime();
    const opened = performance.now();
    const acquisition = await openOneNoteDesktopExport(await exportFolderFiles(root), { createdAt: TIME });
    const target = createWorkspaceV2RuntimeOneNoteApplyTarget(runtime);
    const stage = await prepareOneNoteImportApplication({ outline: acquisition.outline, source: acquisition.reader, target });
    const reviewMs = performance.now() - opened;
    const baseline = memoryUsage();
    const peak = { rss: baseline.rss, heapUsed: baseline.heapUsed, external: baseline.external, arrayBuffers: baseline.arrayBuffers };
    let peakLoaded = 0;
    let lastLog = 0;
    const series: Array<[number, number, number, number]> = [];
    const result = await applyOneNoteImportApplication(target, stage, {
      approvalArtifactFingerprint: stage.review.approvalArtifactFingerprint,
      onProgress: (progress) => {
        const memory = memoryUsage();
        peak.rss = Math.max(peak.rss, memory.rss);
        peak.heapUsed = Math.max(peak.heapUsed, memory.heapUsed);
        peak.external = Math.max(peak.external, memory.external);
        peak.arrayBuffers = Math.max(peak.arrayBuffers, memory.arrayBuffers);
        peakLoaded = Math.max(peakLoaded, runtime.getMemoryDiagnostics().loadedPages);
        if (progress.phase === 'writing-pages') {
          series.push([progress.completed, Math.round(progress.elapsedMs ?? 0), Math.round(memory.rss / 1048576), Math.round(memory.external / 1048576)]);
        }
        if ((progress.elapsedMs ?? 0) - lastLog > 15_000) {
          lastLog = progress.elapsedMs ?? 0;
          log(`[${Math.round(lastLog / 1000)} s] page ${progress.completed}/${progress.total}, rss ${Math.round(memory.rss / 1048576)} MB, heap ${Math.round(memory.heapUsed / 1048576)} MB`);
        }
      },
    });
    const mb = (bytes: number) => Math.round(bytes / 1048576);
    const summary = {
      reviewMs: Math.round(reviewMs),
      timing: result.timing,
      stats: result.stats,
      peakLoadedPages: peakLoaded,
      memoryMb: {
        baselineRss: mb(baseline.rss),
        peakRss: mb(peak.rss),
        peakHeapUsed: mb(peak.heapUsed),
        peakExternal: mb(peak.external),
        peakArrayBuffers: mb(peak.arrayBuffers),
      },
      /** [pages written, elapsed ms, RSS MB, external (WASM) MB] after each page. */
      series,
    };
    if (bench.out) await writeJson(bench.out, summary);
    log(JSON.stringify({ ...summary, series: series.length }, null, 2));
    expect(result.stats.pages).toBe(stage.pages.length);
    expect(peakLoaded).toBeLessThanOrEqual(1 + PAGE_CACHE);
  }, 45 * 60_000);
});
