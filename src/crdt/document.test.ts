import * as Automerge from '@automerge/automerge';
import { describe, expect, it } from 'vitest';
import type { NotebookDoc, PageDoc } from '../domain/v2';
import type { PageDocV3 } from '../domain/v3';
import { UNDERLINE_MARK } from '../editor/richText/schema';
import {
  applyPageChanges,
  changePageDocument,
  createBrowserAutomergeRepo,
  createNotebookAutomergeDoc,
  createPageAutomergeDoc,
  createPageAutomergeDocV3,
  documentHasHeads,
  extractPageChanges,
  getAutomergeConflicts,
  getAutomergeHeads,
  getAutomergeHistory,
  getAutomergeSnapshot,
  getAutomergeSnapshotAt,
  projectLiveRichText,
  proseMirrorFromLiveRichText,
  loadAutomergeDocument,
  mergeAutomergeDocuments,
  saveAutomergeDocument,
  upgradeAutomergeDocumentV2ToV3,
  type LivePageDocV2,
} from './index';

const TIME = '2026-08-03T08:00:00.000Z';
const ACTOR_A = 'a'.repeat(64);
const ACTOR_B = 'b'.repeat(64);
const ACTOR_C = 'c'.repeat(64);

function notebookFixture(): NotebookDoc {
  return {
    schemaVersion: 2,
    documentId: 'notebook:notebook-1',
    kind: 'notebook',
    notebookId: 'notebook-1',
    title: 'School',
    color: '#123456',
    createdAt: TIME,
    updatedAt: TIME,
    sections: [{
      id: 'section-1',
      title: 'Physics',
      createdAt: TIME,
      updatedAt: TIME,
      pageDocumentIds: ['page:page-1'],
    }],
    settings: { defaultPageType: 'a4' },
    version: { protocol: 'uninitialized', heads: [] },
  };
}

function pageFixture(): PageDoc {
  return {
    schemaVersion: 2,
    documentId: 'page:page-1',
    kind: 'page',
    notebookId: 'notebook-1',
    sectionId: 'section-1',
    pageId: 'page-1',
    title: 'Vectors',
    tags: ['physics'],
    pageType: 'a4',
    background: { type: 'grid', color: '#fffefa' },
    createdAt: TIME,
    updatedAt: TIME,
    elementsById: {
      'text-1': {
        id: 'text-1',
        kind: 'richText',
        frame: { x: 10, y: 20, width: 320, height: 160, rotation: 0 },
        createdAt: TIME,
        updatedAt: TIME,
        locked: false,
        content: {
          type: 'doc',
          blocks: [{
            id: 'paragraph-1',
            type: 'paragraph',
            spans: [{ text: 'Vector', marks: [{ type: 'bold' }] }],
          }],
        },
        style: {
          color: '#111111',
          fontFamily: 'Inter',
          fontSize: 18,
          textAlign: 'left',
        },
      },
    },
    zOrder: ['text-1'],
    version: { protocol: 'uninitialized', heads: [] },
  };
}

describe('Automerge schema-v2 documents', () => {
  it('creates, saves, loads, and snapshots notebook and page documents', () => {
    const notebook = createNotebookAutomergeDoc(notebookFixture(), { actorId: ACTOR_A });
    const page = createPageAutomergeDoc(pageFixture(), { actorId: ACTOR_B });

    const notebookSnapshot = getAutomergeSnapshot(notebook);
    expect(notebookSnapshot.kind).toBe('notebook');
    expect(notebookSnapshot).not.toHaveProperty('version');

    const bytes = saveAutomergeDocument(page);
    expect(bytes.byteLength).toBeGreaterThan(0);
    const loaded = loadAutomergeDocument<LivePageDocV2>(bytes, {
      actorId: ACTOR_C,
      expectedDocumentId: 'page:page-1',
      expectedKind: 'page',
    });
    expect(getAutomergeSnapshot(loaded)).toEqual(getAutomergeSnapshot(page));
    const liveRichText = getAutomergeSnapshot(loaded).elementsById['text-1'];
    expect(liveRichText).toMatchObject({
      kind: 'richText',
    });
    expect(liveRichText.kind === 'richText' ? liveRichText.text : '').toContain('Vector');
    expect(liveRichText).not.toHaveProperty('content');
    const portableRichText = pageFixture().elementsById['text-1'];
    if (portableRichText.kind !== 'richText') throw new Error('Expected rich text fixture.');
    expect(projectLiveRichText(loaded, 'text-1')).toEqual(portableRichText.content);
  });

  it('tracks changes, history, snapshots, and optimistic heads per page', () => {
    const initial = createPageAutomergeDoc(pageFixture(), { actorId: ACTOR_A });
    const initialHeads = getAutomergeHeads(initial);
    const changed = changePageDocument(
      initial,
      { message: 'Rename lesson', expectedHeads: initialHeads },
      (draft) => {
        draft.title = 'Forces';
        draft.tags.push('mechanics');
      },
    );
    const changes = extractPageChanges(initial, changed);
    const applied = applyPageChanges(initial, changes);

    expect(changes).toHaveLength(1);
    expect(getAutomergeSnapshot(applied).title).toBe('Forces');
    expect(getAutomergeSnapshotAt(changed, initialHeads).title).toBe('Vectors');
    expect(getAutomergeHistory(changed).map((entry) => entry.message)).toEqual([
      'Initialize Canvink schema-v2 document',
      'Rename lesson',
    ]);
    expect(() => changePageDocument(
      changed,
      { message: 'Stale edit', expectedHeads: initialHeads },
      (draft) => { draft.title = 'Stale'; },
    )).toThrow(/expected heads/i);
  });

  it('merges concurrent changes and reports scalar conflicts with their path', () => {
    const base = createPageAutomergeDoc(pageFixture(), { actorId: ACTOR_A });
    const leftBase = loadAutomergeDocument<LivePageDocV2>(saveAutomergeDocument(base), {
      actorId: ACTOR_B,
    });
    const rightBase = loadAutomergeDocument<LivePageDocV2>(saveAutomergeDocument(base), {
      actorId: ACTOR_C,
    });
    const left = changePageDocument(leftBase, { message: 'Left title' }, (draft) => {
      draft.title = 'Momentum';
    });
    const right = changePageDocument(rightBase, { message: 'Right title' }, (draft) => {
      draft.title = 'Acceleration';
    });
    const merged = mergeAutomergeDocuments(left, right);
    const titleConflict = getAutomergeConflicts(merged).find(
      (conflict) => conflict.path.join('.') === 'title',
    );

    expect(titleConflict?.values.map(({ value }) => value).sort()).toEqual([
      'Acceleration',
      'Momentum',
    ]);
    expect(getAutomergeHeads(merged)).toHaveLength(2);
  });

  it('converges concurrent rich-text inserts and marks at the stable element path', () => {
    const base = createPageAutomergeDoc(pageFixture(), { actorId: ACTOR_A });
    const bytes = saveAutomergeDocument(base);
    const aliceBase = loadAutomergeDocument<LivePageDocV2>(bytes, { actorId: ACTOR_B });
    const bobBase = loadAutomergeDocument<LivePageDocV2>(bytes, { actorId: ACTOR_C });
    const path: Automerge.Prop[] = ['elementsById', 'text-1', 'text'];
    const alice = changePageDocument(aliceBase, { message: 'Alice rich text' }, (draft) => {
      const start = draft.elementsById['text-1'].kind === 'richText'
        ? draft.elementsById['text-1'].text.length
        : 0;
      Automerge.splice(draft, path, start, 0, ' left');
      Automerge.mark(draft, path, { start: 1, end: start + 5, expand: 'both' }, 'strong', true);
    });
    const bob = changePageDocument(bobBase, { message: 'Bob rich text' }, (draft) => {
      const start = draft.elementsById['text-1'].kind === 'richText'
        ? draft.elementsById['text-1'].text.length
        : 0;
      Automerge.splice(draft, path, start, 0, ' right');
      Automerge.mark(
        draft,
        path,
        { start: 1, end: start + 6, expand: 'both' },
        UNDERLINE_MARK,
        true,
      );
    });

    const mergedFromAlice = mergeAutomergeDocuments(alice, bob);
    const mergedFromBob = mergeAutomergeDocuments(bob, alice);
    const alicePm = proseMirrorFromLiveRichText(mergedFromAlice, 'text-1');
    const bobPm = proseMirrorFromLiveRichText(mergedFromBob, 'text-1');

    expect(alicePm.eq(bobPm)).toBe(true);
    expect(alicePm.textContent).toContain('Vector');
    expect(alicePm.textContent).toContain('left');
    expect(alicePm.textContent).toContain('right');
    const markNames = new Set<string>();
    alicePm.descendants((node) => node.marks.forEach((mark) => markNames.add(mark.type.name)));
    expect(markNames).toEqual(new Set(['strong', UNDERLINE_MARK]));
    expect(projectLiveRichText(mergedFromAlice, 'text-1').blocks[0].id).toBe('paragraph-1');
  });

  it('repairs an element missing from zOrder on read and rejects duplicated portable rich text', () => {
    // Concurrent merges can leave zOrder and the element map out of step;
    // that is legal, and readers get every element exactly once.
    const page = createPageAutomergeDoc(pageFixture(), { actorId: ACTOR_A });
    const elementIds = Object.keys(getAutomergeSnapshot(page).elementsById).sort();
    const changed = changePageDocument(page, { message: 'Drop an id from z-order' }, (draft) => {
      draft.zOrder.splice(0, 1);
    });
    expect([...getAutomergeSnapshot(changed).zOrder].sort()).toEqual(elementIds);
    const freshPage = createPageAutomergeDoc(pageFixture(), { actorId: ACTOR_B });
    expect(() => changePageDocument(freshPage, { message: 'Duplicate text authority' }, (draft) => {
      const element = draft.elementsById['text-1'] as unknown as Record<string, unknown>;
      element.content = { type: 'doc', blocks: [] };
    })).toThrow(/duplicates mutable portable content/i);
  });

  it('rejects corrupted or mismatched binary documents', () => {
    const page = createPageAutomergeDoc(pageFixture(), { actorId: ACTOR_A });
    const bytes = saveAutomergeDocument(page);

    expect(() => loadAutomergeDocument(new Uint8Array())).toThrow(/empty/i);
    expect(() => loadAutomergeDocument(bytes, { expectedKind: 'notebook' })).toThrow(
      /expected a notebook/i,
    );
  });

  it('keeps the IndexedDB repo factory browser-only and networking-free', () => {
    expect(() => createBrowserAutomergeRepo()).toThrow(/IndexedDB/i);
  });
});

describe('Automerge schema-v3 compatibility', () => {
  it('upgrades a v2 page losslessly and lets an explicit legacy reader reject it', () => {
    const v2 = createPageAutomergeDoc(pageFixture(), { actorId: ACTOR_A });
    const upgraded = upgradeAutomergeDocumentV2ToV3(v2);
    const snapshot = getAutomergeSnapshot(upgraded);

    expect(snapshot).toEqual({ ...getAutomergeSnapshot(v2), schemaVersion: 3 });
    expect(snapshot).not.toHaveProperty('mathSettings');
    expect(snapshot).not.toHaveProperty('pageContent');
    expect(() => loadAutomergeDocument(saveAutomergeDocument(upgraded), {
      expectedSchemaVersion: 2,
    })).toThrow('Expected schema version 2, received 3');
    expect(loadAutomergeDocument(saveAutomergeDocument(upgraded), {
      expectedSchemaVersion: 3,
    }).schemaVersion).toBe(3);
  });

  it('round-trips validated MathElement and same-page GraphElement data', () => {
    const projection = { ...pageFixture(), schemaVersion: 3 } as PageDocV3;
    projection.pageContent = { version: 1, kind: 'markdown', source: '# Formula notes\n\ny = x^2\n' };
    projection.elementsById = {
      'math-1': {
        id: 'math-1', kind: 'math', frame: { x: 10, y: 10, width: 160, height: 50, rotation: 0 },
        createdAt: TIME, updatedAt: TIME, locked: false, inputKind: 'typed', autoRecognition: 'inherit',
        typedLatex: 'y=x^2', recognition: { state: 'recognized', alternatives: [], warnings: [] },
        result: { state: 'valid', exactLatex: 'x^2', diagnostics: [] },
        dependencies: { defines: ['y'], references: ['x'], dependsOnElementIds: [], state: 'valid' },
      },
      'graph-1': {
        id: 'graph-1', kind: 'graph', frame: { x: 10, y: 70, width: 400, height: 280, rotation: 0 },
        createdAt: TIME, updatedAt: TIME, locked: false,
        series: [{ id: 'series-1', sourceMathElementId: 'math-1', color: '#2463eb', visible: true }],
        viewport: { xMin: -5, xMax: 5, yMin: -5, yMax: 25, equalScale: false, axesVisible: true, gridVisible: true },
      },
    };
    projection.zOrder = ['math-1', 'graph-1'];
    const page = createPageAutomergeDocV3(projection, { actorId: ACTOR_B });
    const reopened = loadAutomergeDocument(saveAutomergeDocument(page), { expectedSchemaVersion: 3 });

    expect(getAutomergeSnapshot(reopened)).toEqual(getAutomergeSnapshot(page));
    expect((getAutomergeSnapshot(reopened) as LivePageDocV2).pageContent).toEqual(projection.pageContent);
  });

  it('rejects schema-v3 page content on a schema-v2 live page', () => {
    const page = createPageAutomergeDoc(pageFixture(), { actorId: ACTOR_A });
    expect(() => changePageDocument(page, { message: 'invalid v2 page content' }, (draft) => {
      (draft as unknown as { pageContent: unknown }).pageContent = { version: 1, kind: 'canvas' };
    })).toThrow(/schema-v3 page settings/);
  });

  describe('documentHasHeads', () => {
    it('answers like Automerge.hasHeads for current, older and unknown heads', () => {
      const first = createPageAutomergeDoc(pageFixture(), { actorId: ACTOR_A });
      const olderHeads = [...Automerge.getHeads(first)];
      const second = Automerge.change(first, (draft) => { draft.title = 'Geändert'; });
      const currentHeads = [...Automerge.getHeads(second)];
      const stranger = [...Automerge.getHeads(Automerge.from({ other: true }))];

      for (const heads of [currentHeads, olderHeads, [...olderHeads, ...currentHeads], stranger, [...currentHeads, ...stranger], []]) {
        expect(documentHasHeads(second, heads)).toBe(Automerge.hasHeads(second, heads));
      }
      expect(documentHasHeads(second, olderHeads)).toBe(true);
      expect(documentHasHeads(second, stranger)).toBe(false);
    });

    it('ignores what queued changes wait for when the requested heads are present', () => {
      const base = createPageAutomergeDoc(pageFixture(), { actorId: ACTOR_A });
      const olderHeads = [...Automerge.getHeads(base)];
      const second = Automerge.change(base, (draft) => { draft.title = 'Zwei'; });
      const third = Automerge.change(second, (draft) => { draft.title = 'Drei'; });
      const fourth = Automerge.change(third, (draft) => { draft.title = 'Vier'; });
      // The fourth change depends on the third, which `second` lacks: it waits in the queue.
      const partial = Automerge.loadIncremental(Automerge.clone(second), Automerge.saveSince(fourth, [...Automerge.getHeads(third)]));
      expect(Automerge.getMissingDeps(partial, [])).toEqual([...Automerge.getHeads(third)]);
      expect(documentHasHeads(partial, olderHeads)).toBe(true);
      expect(documentHasHeads(partial, [...Automerge.getHeads(third)])).toBe(false);
    });
  });
});
