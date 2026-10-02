import { describe, expect, it } from 'vitest';
import { getAutomergeSnapshot, loadAutomergeDocument, type LivePageDocV2 } from '../../crdt';
import type { WorkspaceState } from '../../domain/types';
import { DEFAULT_MATH_PAGE_SETTINGS, type PageDocV3 } from '../../domain/v3';
import { readCanvinkBundle } from '../../io';
import { MemoryWorkspaceStore, memoryRepoFactory } from '../../storage/testing/memoryWorkspaceStore';
import {
  BrowserV2WorkspaceActivationStore,
  DefaultAutomergeMigrationMaterializer,
  InMemoryAutomergeRepoMigrationAdapter,
  V2WorkspaceMigrationOrchestrator,
} from '../../storage/v2WorkspaceStorage';
import { WorkspaceV2Runtime } from '../../storage/workspaceV2Runtime';
import { exportWorkspaceBackup, type WorkspaceBackupIndex } from './workspaceBackup';

const TIME = '2026-09-25T08:00:00.000Z';

function v1(): WorkspaceState {
  return {
    schemaVersion: 1, updatedAt: TIME,
    notebooks: [{ id: 'notebook-1', title: 'Schule', color: '#123456', createdAt: TIME, updatedAt: TIME,
      sections: [{ id: 'section-1', title: 'Physik', createdAt: TIME, updatedAt: TIME,
        pages: [{ id: 'page-1', title: 'Start', mode: 'a4', createdAt: TIME, updatedAt: TIME, elements: [] }] }] }],
    trash: [], activeNotebookId: 'notebook-1', activeSectionId: 'section-1', activePageId: 'page-1',
  };
}

function inkPage(pageId: string, strokes: number): PageDocV3 {
  const elementsById: PageDocV3['elementsById'] = {};
  for (let index = 0; index < strokes; index += 1) {
    elementsById[`s${index}`] = {
      id: `s${index}`, kind: 'stroke', frame: { x: index, y: index, width: 10, height: 10, rotation: 0 },
      createdAt: TIME, updatedAt: TIME, locked: false, tool: 'pen', color: '#000000', size: 2, opacity: 1,
      points: [{ x: index, y: index, pressure: 0.5, tiltX: 0, tiltY: 0, time: 0, pointerType: 'pen' }],
    };
  }
  return {
    schemaVersion: 3, documentId: `page:${pageId}`, kind: 'page', notebookId: 'notebook-1', sectionId: 'section-1', pageId,
    title: `Seite ${pageId}`, tags: [], pageType: 'a4', background: { type: 'grid', color: '#ffffff' },
    createdAt: TIME, updatedAt: TIME, elementsById, zOrder: Object.keys(elementsById),
    mathSettings: { ...DEFAULT_MATH_PAGE_SETTINGS }, pageContent: { version: 1, kind: 'canvas' },
    version: { protocol: 'uninitialized', heads: [] },
  };
}

/** Splits a canonical stored ZIP into its entries (the backup's outer archive). */
function storedZipEntries(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries = new Map<string, Uint8Array>();
  let offset = 0;
  while (view.getUint32(offset, true) === 0x0403_4b50) {
    const size = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 30, offset + 30 + nameLength));
    const start = offset + 30 + nameLength;
    entries.set(name, bytes.slice(start, start + size));
    offset = start + size;
  }
  return entries;
}

describe('whole-workspace backup', () => {
  it('contains every page, including pages never opened, and reads them one at a time', async () => {
    const store = new MemoryWorkspaceStore();
    const activationStore = new BrowserV2WorkspaceActivationStore(store);
    const source = { loadWorkspace: async () => ({ workspace: v1(), backend: 'indexeddb' as const }), loadRecoveryDraft: async () => null };
    await new V2WorkspaceMigrationOrchestrator(
      source, activationStore, new InMemoryAutomergeRepoMigrationAdapter(), new DefaultAutomergeMigrationMaterializer(), { now: () => TIME },
    ).run();
    const runtime = new WorkspaceV2Runtime({ source, activationStore, repoFactory: memoryRepoFactory(store), pageCacheSize: 1 });
    await runtime.startup();
    const initial = await runtime.ensureSchemaV3();
    const pages = Array.from({ length: 12 }, (_, index) => inkPage(`p${index}`, 30 + index));
    await runtime.commitWorkspaceGraphRevision({
      operationId: 'add-pages',
      expectedActivationArtifactFingerprint: initial.activation.artifactFingerprint,
      message: 'Add pages',
      newDocuments: pages,
      changes: [{
        documentId: 'notebook:notebook-1',
        change: (document) => {
          if (document.kind === 'notebook') document.sections[0].pageDocumentIds.push(...pages.map((page) => page.documentId));
        },
      }],
      updateManifest: (manifest) => { manifest.pageDocumentIds.push(...pages.map((page) => page.documentId)); },
    });
    const state = runtime.getState();
    if (state.schemaVersion !== 3) throw new Error('Expected schema v3.');

    let maxLoaded = 0;
    const progress: number[] = [];
    const blob = await exportWorkspaceBackup(runtime, state, {
      onProgress: (done) => {
        progress.push(done);
        maxLoaded = Math.max(maxLoaded, runtime.getMemoryDiagnostics().loadedPages);
      },
    });
    expect(maxLoaded).toBeLessThanOrEqual(2);
    expect(progress.at(-1)).toBe(13);

    const outer = storedZipEntries(new Uint8Array(await blob.arrayBuffer()));
    const index = JSON.parse(new TextDecoder().decode(outer.get('workspace.json'))) as WorkspaceBackupIndex;
    expect(index.notebooks).toMatchObject([{ documentId: 'notebook:notebook-1', title: 'Schule', pages: 13 }]);
    const bundle = await readCanvinkBundle(outer.get(index.notebooks[0].file) as Uint8Array);
    expect(bundle.pages.map((page) => page.id)).toEqual(['page:page-1', ...pages.map((page) => page.documentId)]);
    for (const [position, page] of bundle.pages.entries()) {
      const document = loadAutomergeDocument<LivePageDocV2>(page.bytes, { expectedKind: 'page' });
      // The bundle holds the ink of a page as segments next to the page's document.
      expect(getAutomergeSnapshot<LivePageDocV2>(document).zOrder).toHaveLength(position === 0 ? 0 : 30 + position - 1);
    }
    expect(bundle.assets.filter((asset) => asset.mimeType === 'application/vnd.canvink.ink-segment').length).toBeGreaterThan(0);
    await runtime.shutdown();
  });
});
