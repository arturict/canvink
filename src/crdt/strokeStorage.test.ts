import * as Automerge from '@automerge/automerge';
import { describe, expect, it } from 'vitest';
import type { StrokeElementV2 } from '../domain/v2';
import { DEFAULT_MATH_PAGE_SETTINGS, type PageDocV3 } from '../domain/v3';
import {
  changePageDocument,
  convertPageStrokes,
  createPageAutomergeDocV3,
  getAutomergeConflicts,
  getAutomergeHistory,
  getAutomergeSnapshot,
  getAutomergeSnapshotAt,
  getAutomergeHeads,
  getSharedAutomergeSnapshot,
  hasPackedPoints,
  loadAutomergeDocument,
  saveAutomergeDocument,
  type PageAutomergeDoc,
  type StrokeStorageFormat,
} from './index';

const TIME = '2026-09-25T08:00:00.000Z';

function stroke(id: string, x: number): StrokeElementV2 {
  return {
    id, kind: 'stroke',
    frame: { x, y: 10, width: 9, height: 3, rotation: 0 },
    createdAt: TIME, updatedAt: TIME, locked: false, tool: 'pen', color: '#1b1b8f', size: 1.5, opacity: 1,
    // Values on the packed grid, so the round trip is exact.
    points: Array.from({ length: 10 }, (_, index) => ({
      x: x + index, y: 10 + (index % 4) * 0.5, pressure: index % 2 === 0 ? 0.5 : 1, tiltX: 0, tiltY: 0,
      time: index * 8, pointerType: 'pen',
    })),
  };
}

function pageFixture(count = 4): PageDocV3 {
  const elementsById: PageDocV3['elementsById'] = {};
  const zOrder: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = `stroke-${index}`;
    elementsById[id] = stroke(id, index * 20);
    zOrder.push(id);
  }
  return {
    schemaVersion: 3, documentId: 'page:packed', kind: 'page', notebookId: 'notebook', sectionId: 'section',
    pageId: 'packed', title: 'Ink', tags: [], pageType: 'free', background: { type: 'plain', color: '#ffffff' },
    createdAt: TIME, updatedAt: TIME, elementsById, zOrder, mathSettings: { ...DEFAULT_MATH_PAGE_SETTINGS },
    pageContent: { version: 1, kind: 'canvas' }, version: { protocol: 'uninitialized', heads: [] },
  };
}

function build(format: StrokeStorageFormat, count?: number): PageAutomergeDoc {
  return createPageAutomergeDocV3(pageFixture(count), { strokeFormat: format });
}

function rawElement(document: PageAutomergeDoc, id: string): Record<string, unknown> {
  return document.elementsById[id] as unknown as Record<string, unknown>;
}

describe('stroke storage forms', () => {
  it.each(['points', 'packed'] as const)('reads the strokes of a %s document back as point lists', (format) => {
    const document = build(format);

    const snapshot = getAutomergeSnapshot(document);

    expect(snapshot.elementsById).toEqual(pageFixture().elementsById);
    expect(getSharedAutomergeSnapshot(document).elementsById).toEqual(pageFixture().elementsById);
    expect(hasPackedPoints(rawElement(document, 'stroke-0'))).toBe(format === 'packed');
    expect(Array.isArray(rawElement(document, 'stroke-0').points)).toBe(format === 'points');
  });

  it('keeps every reader working after the bytes were saved and loaded', () => {
    const loaded = loadAutomergeDocument<PageAutomergeDoc>(saveAutomergeDocument(build('packed')));

    expect(getAutomergeSnapshot(loaded).elementsById).toEqual(pageFixture().elementsById);
    expect(getSharedAutomergeSnapshot(loaded).elementsById['stroke-3']).toEqual(pageFixture().elementsById['stroke-3']);
    expect(getAutomergeSnapshotAt(loaded, getAutomergeHeads(loaded)).elementsById)
      .toEqual(pageFixture().elementsById);
    expect(getAutomergeHistory(loaded).at(-1)?.snapshot.elementsById).toEqual(pageFixture().elementsById);
  });

  it('shrinks a page to a fraction of the Automerge operations', () => {
    const listed = Automerge.stats(build('points', 40)).numOps;
    const packed = Automerge.stats(build('packed', 40)).numOps;

    expect(packed).toBeLessThan(listed / 2);
  });

  it('shares a decoded stroke between snapshots until it changes and freezes it', () => {
    const before = build('packed');
    const first = getSharedAutomergeSnapshot(before);
    const after = changePageDocument(before, { message: 'Touch a stroke' }, (draft) => {
      (draft.elementsById['stroke-1'] as StrokeElementV2).color = '#dc2626';
    });

    const second = getSharedAutomergeSnapshot(after);

    expect(second.elementsById['stroke-0']).toBe(first.elementsById['stroke-0']);
    expect(second.elementsById['stroke-1']).not.toBe(first.elementsById['stroke-1']);
    expect((second.elementsById['stroke-1'] as StrokeElementV2).points)
      .toBe((first.elementsById['stroke-1'] as StrokeElementV2).points);
    expect(Object.isFrozen((first.elementsById['stroke-0'] as StrokeElementV2).points)).toBe(true);
    expect(Object.isFrozen((first.elementsById['stroke-0'] as StrokeElementV2).points[0])).toBe(true);
    expect(hasPackedPoints(first.elementsById['stroke-0'])).toBe(false);
  });

  it('opens a page that mixes both forms and converts it in either direction', () => {
    const packed = build('packed');
    const mixed = changePageDocument(packed, { message: 'Add a list stroke' }, (draft) => {
      draft.elementsById['listed'] = stroke('listed', 500) as never;
      draft.zOrder.push('listed');
    });
    expect(getAutomergeSnapshot(mixed).elementsById.listed).toEqual(stroke('listed', 500));

    const toPacked = changePageDocument(mixed, { message: 'Migrate' }, (draft) => {
      expect(convertPageStrokes(draft, 'packed')).toBe(1);
    });
    const toList = changePageDocument(toPacked, { message: 'Roll back' }, (draft) => {
      expect(convertPageStrokes(draft, 'points')).toBe(5);
    });

    for (const document of [mixed, toPacked, toList]) {
      expect(getAutomergeSnapshot(document).elementsById).toEqual({
        ...pageFixture().elementsById,
        listed: stroke('listed', 500),
      });
    }
    expect(hasPackedPoints(rawElement(toPacked, 'listed'))).toBe(true);
    expect(Array.isArray(rawElement(toList, 'stroke-0').points)).toBe(true);
    expect(rawElement(toList, 'stroke-0').packedPoints).toBeUndefined();
  });

  it('refuses a change that leaves a stroke without any samples', () => {
    const document = build('packed', 1);

    expect(() => changePageDocument(document, { message: 'Break it' }, (draft) => {
      delete (draft.elementsById['stroke-0'] as unknown as Record<string, unknown>).packedPoints;
    })).toThrow(/neither a point list nor packed points/);
  });

  it('finds conflicts around packed strokes without descending into the bytes', () => {
    const base = build('packed', 2);
    const left = Automerge.change(Automerge.clone(base, { actor: 'aa'.repeat(16) }), (draft) => {
      (draft.elementsById['stroke-0'] as StrokeElementV2).size = 2;
    });
    const right = Automerge.change(Automerge.clone(base, { actor: 'bb'.repeat(16) }), (draft) => {
      (draft.elementsById['stroke-0'] as StrokeElementV2).size = 4;
    });

    const conflicts = getAutomergeConflicts(Automerge.merge(left, right));

    expect(conflicts.map((conflict) => conflict.path.join('.'))).toEqual(['elementsById.stroke-0.size']);
  });

  it('rejects unreadable packed bytes with the stroke named', () => {
    const document = build('packed', 1);
    const corrupted = Automerge.change(document, (draft) => {
      (draft.elementsById['stroke-0'] as unknown as Record<string, unknown>).packedPoints = new Uint8Array([9, 9, 9]);
    });

    expect(() => getAutomergeSnapshot(corrupted)).toThrow(/Stroke stroke-0 holds packed points/);
    expect(() => getSharedAutomergeSnapshot(corrupted)).toThrow(/Stroke stroke-0 holds packed points/);
  });
});
