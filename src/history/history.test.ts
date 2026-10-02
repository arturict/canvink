import { describe, expect, it } from 'vitest';
import {
  changePageDocument,
  createPageAutomergeDoc,
  createPageAutomergeDocV3,
  type PageAutomergeDoc,
} from '../crdt';
import type { NotebookDoc, PageDoc, Sha256Checksum } from '../domain/v2';
import type { PageDocV3 } from '../domain/v3';
import type { V2RuntimeState, WorkspaceGraphRevisionRequest } from '../storage/workspaceV2Runtime';
import { sealProjection } from '../ink/seal';
import { MemorySegmentBackend, resetInkSegments } from '../ink/segmentStore';
import { WorkspaceHistory, copiedPageProjection, validateCheckpointName, type HistoryRuntimePort } from './history';
import type { HistorySnapshot, HistorySnapshotMetadata, HistorySnapshotStore } from './types';

const TIME = '2026-08-03T10:00:00.000Z';
const ASSET_ID = `sha256:${'a'.repeat(64)}` as Sha256Checksum;

class MemoryHistoryStore implements HistorySnapshotStore {
  readonly records = new Map<string, HistorySnapshot>();
  listCalls = 0;

  async put(snapshot: HistorySnapshot): Promise<HistorySnapshotMetadata> {
    this.records.set(snapshot.snapshotId, structuredClone(snapshot));
    const { bytes: _bytes, ...metadata } = snapshot;
    void _bytes;
    return structuredClone(metadata);
  }

  async get(snapshotId: string): Promise<HistorySnapshot | undefined> {
    const value = this.records.get(snapshotId);
    return value ? structuredClone(value) : undefined;
  }

  async list(documentId: string, limit = 100): Promise<HistorySnapshotMetadata[]> {
    this.listCalls += 1;
    return [...this.records.values()]
      .filter((snapshot) => snapshot.documentId === documentId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt)
        || right.snapshotId.localeCompare(left.snapshotId))
      .slice(0, limit)
      .map(({ bytes: _bytes, ...metadata }) => {
        void _bytes;
        return structuredClone(metadata);
      });
  }

  async deleteGuarded(snapshotId: string, expectedChecksum: Sha256Checksum): Promise<boolean> {
    const value = this.records.get(snapshotId);
    if (!value) return false;
    if (value.checksum !== expectedChecksum) throw new Error('guard conflict');
    return this.records.delete(snapshotId);
  }
}

function pageProjection(): PageDoc {
  return {
    schemaVersion: 2,
    documentId: 'page:page-1',
    kind: 'page',
    notebookId: 'notebook-1',
    sectionId: 'section-1',
    pageId: 'page-1',
    title: 'Impulserhaltung',
    tags: ['Physik'],
    pageType: 'a4',
    background: { type: 'grid', color: '#ffffff' },
    createdAt: TIME,
    updatedAt: TIME,
    elementsById: {
      text: {
        id: 'text',
        kind: 'richText',
        frame: { x: 10, y: 20, width: 300, height: 80, rotation: 0 },
        createdAt: TIME,
        updatedAt: TIME,
        locked: false,
        content: {
          type: 'doc',
          blocks: [{ id: 'paragraph', type: 'paragraph', spans: [{ text: 'p = m · v', marks: [] }] }],
        },
        style: { color: '#111111', fontFamily: 'Inter', fontSize: 18, textAlign: 'left' },
      },
      image: {
        id: 'image',
        kind: 'image',
        frame: { x: 20, y: 140, width: 180, height: 120, rotation: 0 },
        createdAt: TIME,
        updatedAt: TIME,
        locked: false,
        asset: {
          assetId: ASSET_ID,
          checksum: ASSET_ID,
          mimeType: 'image/png',
          size: 4,
          role: 'original',
        },
        alt: 'Versuchsaufbau',
      },
    },
    zOrder: ['text', 'image'],
    version: { protocol: 'uninitialized', heads: [] },
  };
}

function notebookProjection(): NotebookDoc {
  return {
    schemaVersion: 2,
    documentId: 'notebook:notebook-1',
    kind: 'notebook',
    notebookId: 'notebook-1',
    title: 'Schule',
    color: '#123456',
    createdAt: TIME,
    updatedAt: TIME,
    sections: [{
      id: 'section-1',
      title: 'Physik',
      createdAt: TIME,
      updatedAt: TIME,
      pageDocumentIds: ['page:page-1'],
    }],
    settings: { defaultPageType: 'a4' },
    version: { protocol: 'uninitialized', heads: [] },
  };
}

function fixture(options: { missingAsset?: boolean } = {}) {
  let document = createPageAutomergeDoc(pageProjection());
  const notebook = notebookProjection();
  const state: V2RuntimeState = {
    schemaVersion: 2,
    authoritative: 'v2',
    activation: {
      version: 1,
      schemaVersion: 2,
      format: 'canvink-automerge-v2',
      migrationId: 'migration-1',
      sourceFingerprint: `sha256:${'1'.repeat(64)}`,
      artifactFingerprint: `sha256:${'2'.repeat(64)}`,
      activatedAt: TIME,
      manifest: {
        schemaVersion: 2,
        format: 'canvink-schema-v2',
        migration: {
          name: 'workspace-v1-to-v2',
          version: 1,
          migrationId: 'migration-1',
          sourceFingerprint: `sha256:${'1'.repeat(64)}`,
          preparedAt: TIME,
        },
        active: { notebookId: 'notebook-1', sectionId: 'section-1', pageId: 'page-1' },
        notebookDocumentIds: [notebook.documentId],
        pageDocumentIds: ['page:page-1'],
        assetIds: [ASSET_ID],
        trash: [],
      },
      documents: [],
      chunks: [],
      assetIds: [ASSET_ID],
    },
    active: { notebookId: 'notebook-1', sectionId: 'section-1', pageId: 'page-1' },
    notebooks: [{
      ...notebook,
      version: undefined,
    } as unknown as V2RuntimeState['notebooks'][number]],
    pages: [],
  };
  const commits: WorkspaceGraphRevisionRequest[] = [];
  // Model the real runtime: a topology commit first ensures schema v3 (which
  // rewrites the activation fingerprint), then rejects a stale expected
  // fingerprint. A lax mock is exactly what hid the restore regression.
  const ensureSchemaV3 = (): V2RuntimeState => {
    if (state.schemaVersion === 2) {
      state.schemaVersion = 3;
      state.authoritative = 'v2';
      state.activation = {
        ...state.activation,
        schemaVersion: 3,
        format: 'canvink-automerge-v3',
        artifactFingerprint: `sha256:${'3'.repeat(64)}`,
      };
    }
    return structuredClone(state);
  };
  const runtime: HistoryRuntimePort = {
    getState: () => structuredClone(state),
    readPage: async (_pageId, reader) => reader(document),
    getAsset: async (assetId) => !options.missingAsset && assetId === ASSET_ID ? { assetId } : undefined,
    ensureSchemaV3: async () => ensureSchemaV3(),
    commitWorkspaceGraphRevision: async (request) => {
      ensureSchemaV3();
      if (request.expectedActivationArtifactFingerprint !== state.activation.artifactFingerprint) {
        throw new Error('The active workspace changed before the topology transaction.');
      }
      commits.push(request);
      return structuredClone(state);
    },
  };
  return {
    runtime,
    commits,
    setDocument: (next: PageAutomergeDoc) => { document = next; },
    document: () => document,
  };
}

describe('WorkspaceHistory', () => {
  it('restores Math/Graph snapshots losslessly with fresh transitive IDs', () => {
    const page: PageDocV3 = {
      ...pageProjection(), schemaVersion: 3, documentId: 'page:math', pageId: 'math',
      mathSettings: { version: 1, resultMode: 'suggest', numberMode: 'exact', angleMode: 'degrees', autoRecognition: true },
      pageContent: { version: 1, kind: 'markdown', source: '# Saved lesson\n\na = 2\n' },
      elementsById: {
        source: {
          id: 'source', kind: 'math', frame: { x: 0, y: 0, width: 100, height: 40, rotation: 0 },
          createdAt: TIME, updatedAt: TIME, locked: false, inputKind: 'typed', autoRecognition: 'inherit', typedLatex: 'a=2',
          recognition: { state: 'idle', alternatives: [], warnings: [] }, result: { state: 'valid', exactLatex: '2', diagnostics: [] },
          dependencies: { defines: ['a'], references: [], dependsOnElementIds: [], state: 'valid' },
        },
        dependent: {
          id: 'dependent', kind: 'math', frame: { x: 0, y: 50, width: 100, height: 40, rotation: 0 },
          createdAt: TIME, updatedAt: TIME, locked: false, inputKind: 'typed', autoRecognition: 'inherit', typedLatex: 'a+1',
          recognition: { state: 'idle', alternatives: [], warnings: [] }, result: { state: 'valid', exactLatex: '3', diagnostics: [] },
          dependencies: { defines: [], references: ['a'], dependsOnElementIds: ['source'], state: 'valid' },
        },
        graph: {
          id: 'graph', kind: 'graph', frame: { x: 120, y: 0, width: 200, height: 150, rotation: 0 },
          createdAt: TIME, updatedAt: TIME, locked: false,
          series: [{ id: 'series-old', sourceMathElementId: 'dependent', color: '#3366cc', visible: true }],
          viewport: { xMin: -5, xMax: 5, yMin: -5, yMax: 5, equalScale: true, axesVisible: true, gridVisible: true },
        },
      },
      zOrder: ['source', 'dependent', 'graph'],
    };
    const document = createPageAutomergeDocV3(page);
    let sequence = 0;
    const copy = copiedPageProjection(document, 'restored-math', TIME, () => `id-${++sequence}`);
    expect(copy.schemaVersion).toBe(3);
    expect('mathSettings' in copy && copy.mathSettings).toEqual(page.mathSettings);
    expect('pageContent' in copy && copy.pageContent).toEqual(page.pageContent);
    const values = Object.values(copy.elementsById);
    const source = values.find((element) => element.kind === 'math' && element.dependencies.defines.includes('a'));
    const dependent = values.find((element) => element.kind === 'math' && element.dependencies.references.includes('a'));
    const graph = values.find((element) => element.kind === 'graph');
    expect(source?.id).not.toBe('source');
    expect(dependent?.kind === 'math' && dependent.dependencies.dependsOnElementIds).toEqual([source?.id]);
    expect(graph?.kind === 'graph' && graph.series[0].sourceMathElementId).toBe(dependent?.id);
    expect(graph?.kind === 'graph' && graph.series[0].id).not.toBe('series-old');
  });

  it('copies a converted-ink math page whose first stroke has no source, without an undefined key', () => {
    const stroke = (id: string, sourceStrokeId?: string) => ({
      id, kind: 'stroke' as const, tool: 'pen' as const,
      frame: { x: 0, y: 0, width: 10, height: 10, rotation: 0 },
      createdAt: TIME, updatedAt: TIME, locked: false,
      color: '#111111', size: 2, opacity: 1,
      points: [{ x: 0, y: 0, pressure: 0.5, tiltX: 0, tiltY: 0, time: 0, pointerType: 'pen' }],
      ...(sourceStrokeId ? { sourceStrokeId } : {}),
    });
    const page: PageDocV3 = {
      ...pageProjection(), schemaVersion: 3, documentId: 'page:ink', pageId: 'ink',
      mathSettings: { version: 1, resultMode: 'suggest', numberMode: 'exact', angleMode: 'degrees', autoRecognition: true },
      pageContent: { version: 1, kind: 'canvas' },
      elementsById: {
        m: {
          id: 'm', kind: 'math', frame: { x: 0, y: 0, width: 100, height: 40, rotation: 0 },
          createdAt: TIME, updatedAt: TIME, locked: false, inputKind: 'converted-ink', autoRecognition: 'inherit',
          recognizedLatex: 'x+1',
          recognition: { state: 'idle', alternatives: [], warnings: [] }, result: { state: 'valid', exactLatex: 'x+1', diagnostics: [] },
          dependencies: { defines: [], references: [], dependsOnElementIds: [], state: 'valid' },
          rawInk: {
            captureFrame: { x: 0, y: 0, width: 100, height: 40, rotation: 0 },
            sourceStrokes: [stroke('s1'), stroke('s2', 's1')],
          },
        },
      },
      zOrder: ['m'],
    };
    const document = createPageAutomergeDocV3(page);
    let sequence = 0;
    const copy = copiedPageProjection(document, 'restored-ink', TIME, () => `id-${++sequence}`);
    const math = Object.values(copy.elementsById).find((element) => element.kind === 'math');
    const strokes = math?.kind === 'math' ? math.rawInk?.sourceStrokes ?? [] : [];
    expect(strokes).toHaveLength(2);
    expect('sourceStrokeId' in strokes[0]).toBe(false);
    expect(strokes[1].sourceStrokeId).toBe(strokes[0].id);
    // The real failure mode: Automerge rejects an explicit undefined value.
    expect(() => createPageAutomergeDocV3(copy)).not.toThrow();
  });

  it('enforces checkpoint name and bounded manual retention limits', async () => {
    expect(() => validateCheckpointName('')).toThrow(/1 to 120/i);
    expect(() => validateCheckpointName('x'.repeat(121))).toThrow(/120/i);
    expect(validateCheckpointName('  Vor Prüfung  ')).toBe('Vor Prüfung');
    const test = fixture();
    const history = new WorkspaceHistory(test.runtime, new MemoryHistoryStore(), {
      now: () => new Date(TIME), idFactory: () => 'fixed', deviceId: 'device-a',
      policy: { maxManualPerPage: 1 },
    });
    await history.createManualCheckpoint('page-1', 'Erster Stand');
    await expect(history.createManualCheckpoint('page-1', 'Zweiter Stand')).rejects.toThrow(/at most 1/i);
  });

  it('rotates automatic and trash snapshots while surviving service restart', async () => {
    const test = fixture();
    const store = new MemoryHistoryStore();
    let clock = Date.parse(TIME);
    let id = 0;
    const options = {
      now: () => new Date(clock),
      idFactory: () => `id-${++id}`,
      deviceId: 'device-a',
      policy: {
        automaticIntervalMs: 1,
        automaticChangeThreshold: 1,
        maxAutomaticPerPage: 2,
        maxTrashPerPage: 1,
      },
    };
    const history = new WorkspaceHistory(test.runtime, store, options);
    for (let index = 0; index < 3; index += 1) {
      test.setDocument(changePageDocument(test.document(), { message: `Edit ${index}` }, (page) => {
        page.title = `Version ${index}`;
      }));
      clock += 1_000;
      await history.captureAutomaticIfDue('page-1');
    }
    await history.createTrashCheckpoint('page-1');
    clock += 1_000;
    await history.createTrashCheckpoint('page-1');

    const restarted = new WorkspaceHistory(test.runtime, store, options);
    const records = await restarted.list('page-1');
    expect(records.filter((item) => item.kind === 'automatic')).toHaveLength(2);
    expect(records.filter((item) => item.kind === 'trash')).toHaveLength(1);
  });

  it('takes the next automatic snapshot only once enough changes piled up within the interval', async () => {
    const test = fixture();
    const store = new MemoryHistoryStore();
    let id = 0;
    const history = new WorkspaceHistory(test.runtime, store, {
      now: () => new Date(TIME),
      idFactory: () => `id-${++id}`,
      deviceId: 'device-a',
      policy: { automaticIntervalMs: 60_000, automaticChangeThreshold: 3 },
    });
    const edit = (index: number) => test.setDocument(changePageDocument(test.document(), { message: `Edit ${index}` }, (page) => {
      page.title = `Version ${index}`;
    }));
    const automaticCount = async () => (await history.list('page-1')).filter((item) => item.kind === 'automatic').length;

    await history.captureAutomaticIfDue('page-1');
    expect(await automaticCount()).toBe(1);
    for (let index = 0; index < 2; index += 1) {
      edit(index);
      await history.captureAutomaticIfDue('page-1');
    }
    expect(await automaticCount()).toBe(1);
    edit(2);
    await history.captureAutomaticIfDue('page-1');
    expect(await automaticCount()).toBe(2);
  });

  it('takes the next automatic snapshot at once when the page became a new document that lacks the last one\'s history', async () => {
    const test = fixture();
    const store = new MemoryHistoryStore();
    let id = 0;
    const history = new WorkspaceHistory(test.runtime, store, {
      now: () => new Date(TIME),
      idFactory: () => `id-${++id}`,
      deviceId: 'device-a',
      policy: { automaticIntervalMs: 60_000, automaticChangeThreshold: 50 },
    });
    await history.captureAutomaticIfDue('page-1');
    // A rebuilt page keeps its id and content but has no change in common with the old document.
    test.setDocument(createPageAutomergeDoc(pageProjection()));
    await history.captureAutomaticIfDue('page-1');
    expect([...store.records.values()].filter((item) => item.kind === 'automatic')).toHaveLength(2);
    // The snapshot just taken is the new baseline: the next check finds the page unchanged.
    await history.captureAutomaticIfDue('page-1');
    expect([...store.records.values()].filter((item) => item.kind === 'automatic')).toHaveLength(2);
  });

  it('checks after every change without listing the stored snapshots again', async () => {
    const test = fixture();
    const store = new MemoryHistoryStore();
    let id = 0;
    const history = new WorkspaceHistory(test.runtime, store, {
      now: () => new Date(TIME),
      idFactory: () => `id-${++id}`,
      deviceId: 'device-a',
      policy: { automaticIntervalMs: 60_000, automaticChangeThreshold: 50 },
    });

    await history.captureAutomaticIfDue('page-1');
    const listedAfterFirstSnapshot = store.listCalls;
    for (let index = 0; index < 5; index += 1) {
      test.setDocument(changePageDocument(test.document(), { message: `Edit ${index}` }, (page) => {
        page.title = `Version ${index}`;
      }));
      await history.captureAutomaticIfDue('page-1');
    }

    expect(store.listCalls).toBe(listedAfterFirstSnapshot);
    expect([...store.records.values()].filter((item) => item.kind === 'automatic')).toHaveLength(1);
  });

  it('detects corrupt snapshots before preview or restore', async () => {
    const test = fixture();
    const store = new MemoryHistoryStore();
    const history = new WorkspaceHistory(test.runtime, store, {
      now: () => new Date(TIME), idFactory: () => 'corrupt', deviceId: 'device-a',
    });
    const snapshot = await history.createManualCheckpoint('page-1', 'Sauber');
    const record = store.records.get(snapshot.snapshotId);
    if (!record) throw new Error('snapshot missing');
    record.bytes[0] ^= 0xff;
    await expect(history.preview(snapshot.snapshotId)).rejects.toThrow(/integrity/i);
    await expect(history.restoreAsCopy(snapshot.snapshotId)).rejects.toThrow(/integrity/i);
    expect(test.commits).toHaveLength(0);
  });

  it('previews later collaborative changes and restores rich text/assets only as a new-ID copy', async () => {
    const test = fixture();
    const store = new MemoryHistoryStore();
    let id = 0;
    const history = new WorkspaceHistory(test.runtime, store, {
      now: () => new Date(TIME), idFactory: () => `copy-${++id}`, deviceId: 'device-a',
    });
    const snapshot = await history.createManualCheckpoint('page-1', 'Vor Zusammenarbeit');
    test.setDocument(changePageDocument(test.document(), { message: 'Änderung von Mia' }, (page) => {
      page.title = 'Aktueller Stand von Mia';
    }));

    const preview = await history.preview(snapshot.snapshotId);
    expect(preview.changesAfterSnapshot).toBeGreaterThan(0);
    expect(preview.changeMessages.map((item) => item.message)).toContain('Änderung von Mia');
    const restored = await history.restoreAsCopy(snapshot.snapshotId);
    expect(test.document().title).toBe('Aktueller Stand von Mia');
    expect(restored.documentId).not.toBe('page:page-1');
    expect(test.commits).toHaveLength(1);
    expect(test.commits[0].changes?.map((change) => change.documentId)).toEqual(['notebook:notebook-1']);
    const copy = test.commits[0].newDocuments?.[0];
    expect(copy).toMatchObject({
      kind: 'page',
      title: 'Impulserhaltung (wiederhergestellt)',
      zOrder: expect.arrayContaining([expect.stringMatching(/^element-copy-/)]),
    });
    if (!copy || copy.kind !== 'page') throw new Error('restore copy missing');
    expect(Object.keys(copy.elementsById)).not.toContain('text');
    expect(Object.values(copy.elementsById).find((element) => element.kind === 'richText'))
      .toMatchObject({ content: { blocks: [{ spans: [{ text: 'p = m · v' }] }] } });
    expect(Object.values(copy.elementsById).find((element) => element.kind === 'image'))
      .toMatchObject({ asset: { assetId: ASSET_ID }, alt: 'Versuchsaufbau' });
  });

  it('restores a pre-v3 snapshot into the upgraded workspace and stays restorable', async () => {
    const test = fixture();
    let id = 0;
    const history = new WorkspaceHistory(test.runtime, new MemoryHistoryStore(), {
      now: () => new Date(TIME), idFactory: () => `copy-${++id}`, deviceId: 'device-a',
    });
    const snapshot = await history.createManualCheckpoint('page-1', 'Vor dem Upgrade');
    expect(test.runtime.getState().schemaVersion).toBe(2);

    const restored = await history.restoreAsCopy(snapshot.snapshotId);
    expect(restored.documentId).not.toBe('page:page-1');
    expect(test.runtime.getState().schemaVersion).toBe(3);
    const copy = test.commits.at(-1)?.newDocuments?.[0];
    expect(copy?.schemaVersion).toBe(3);

    // The workspace is now v3; a second restore of the same v2 snapshot must
    // still succeed rather than being permanently refused.
    const again = await history.restoreAsCopy(snapshot.snapshotId);
    expect(again.documentId).not.toBe(restored.documentId);
    expect(test.commits).toHaveLength(2);
  });

  it('fails closed on missing snapshot assets without starting a graph commit', async () => {
    const test = fixture({ missingAsset: true });
    const history = new WorkspaceHistory(test.runtime, new MemoryHistoryStore(), {
      now: () => new Date(TIME), idFactory: () => 'missing', deviceId: 'device-a',
    });
    const snapshot = await history.createManualCheckpoint('page-1', 'Mit Bild');
    await expect(history.restoreAsCopy(snapshot.snapshotId)).rejects.toThrow(/asset.*missing/i);
    expect(test.commits).toHaveLength(0);
  });

  it('restores a snapshot whose ink lives in segments, and refuses one whose segments are missing', async () => {
    const backend = new MemorySegmentBackend();
    const store = resetInkSegments(backend);
    const strokes: Record<string, PageDocV3['elementsById'][string]> = {};
    const order: string[] = [];
    for (let index = 0; index < 30; index += 1) {
      const id = `s${index}`;
      strokes[id] = {
        id, kind: 'stroke', tool: 'pen', frame: { x: index, y: 0, width: 10, height: 10, rotation: 0 },
        createdAt: TIME, updatedAt: TIME, locked: false, color: '#111111', size: 2, opacity: 1,
        points: [{ x: index, y: 0, pressure: 0.5, tiltX: 0, tiltY: 0, time: 0, pointerType: 'pen' }, { x: index + 5, y: 5, pressure: 0.5, tiltX: 0, tiltY: 0, time: 0, pointerType: 'pen' }],
      };
      order.push(id);
    }
    const page: PageDocV3 = {
      ...pageProjection(), schemaVersion: 3, documentId: 'page:page-1', pageId: 'page-1',
      elementsById: strokes, zOrder: order,
    };
    const sealed = await sealProjection(page as never, store);
    const test = fixture();
    test.setDocument(createPageAutomergeDocV3(sealed as never));
    let sequence = 0;
    const history = new WorkspaceHistory(test.runtime, new MemoryHistoryStore(), {
      now: () => new Date(TIME), idFactory: () => `id-${++sequence}`, deviceId: 'device-a',
    });
    const snapshot = await history.createManualCheckpoint('page-1', 'Mit Tinte');

    const restored = await history.restoreAsCopy(snapshot.snapshotId);
    expect(restored.title).toBeTruthy();
    const copy = test.commits.at(-1)?.newDocuments?.[0] as PageDocV3;
    expect(Object.values(copy.elementsById).filter((element) => element.kind === 'stroke')).toHaveLength(30);

    // Another device that has the snapshot but not the segments must not restore an empty page.
    resetInkSegments(new MemorySegmentBackend());
    await expect(history.restoreAsCopy(snapshot.snapshotId)).rejects.toThrow(/ink .* is missing/i);
  });
});
