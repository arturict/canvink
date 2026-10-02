import * as Automerge from '@automerge/automerge';
import { describe, expect, it } from 'vitest';
import { getAutomergeConflicts, hasPackedPoints, revealPageStrokes, type LivePageDocV2, type StrokeStorageFormat } from '../crdt';
import type { StrokeElementV2 } from '../domain/v2';
import type { PageElementV3 } from '../domain/v3';
import { setReadOnlyDocuments } from '../storage/readOnlyDocuments';
import {
  applyPageElementChanges,
  changesForIds,
  syncListOrder,
  zOrderAnchors,
  type PageElementChanges,
} from './pageChanges';

const TIME = '2026-09-24T00:00:00.000Z';

function stroke(id: string, x = 0, color = '#1d4ed8'): StrokeElementV2 {
  const points = Array.from({ length: 12 }, (_, index) => ({
    x: x + index, y: index % 3, pressure: 0.5, tiltX: 0, tiltY: 0, time: index, pointerType: 'pen' as const,
  }));
  return {
    id, kind: 'stroke', frame: { x, y: 0, width: 11, height: 2, rotation: 0 },
    createdAt: TIME, updatedAt: TIME, locked: false, tool: 'pen', points, color, size: 3, opacity: 1,
  };
}

function pageWith(count: number): Automerge.Doc<LivePageDocV2> {
  const elementsById: Record<string, StrokeElementV2> = {};
  const zOrder: string[] = [];
  for (let index = 0; index < count; index += 1) {
    elementsById[`s${index}`] = stroke(`s${index}`, index * 20);
    zOrder.push(`s${index}`);
  }
  return Automerge.from<LivePageDocV2>({
    schemaVersion: 3, documentId: 'page:1', kind: 'page', notebookId: 'n', sectionId: 's', pageId: 'p',
    title: 'Physik', tags: [], pageType: 'free', background: { type: 'grid', color: '#fff' },
    createdAt: TIME, updatedAt: TIME, elementsById, zOrder,
  } as unknown as LivePageDocV2);
}

function plain(document: Automerge.Doc<LivePageDocV2>) {
  const snapshot = Automerge.toJS(document);
  return { elements: snapshot.elementsById as Record<string, PageElementV3>, zOrder: snapshot.zOrder };
}

function commit(
  document: Automerge.Doc<LivePageDocV2>,
  changes: PageElementChanges,
  base = plain(document),
): Automerge.Doc<LivePageDocV2> {
  return Automerge.change(document, (draft) => {
    applyPageElementChanges(draft, changes, base.elements, 'later', base.zOrder);
  });
}

function operationCount(before: Automerge.Doc<LivePageDocV2>, after: Automerge.Doc<LivePageDocV2>): number {
  return Automerge.getChanges(before, after)
    .reduce((total, change) => total + Automerge.decodeChange(change).ops.length, 0);
}

function assertMapMatchesOrder(document: Automerge.Doc<LivePageDocV2>): void {
  expect(new Set(document.zOrder).size).toBe(document.zOrder.length);
  expect([...document.zOrder].sort()).toEqual(Object.keys(document.elementsById).sort());
}

describe('incremental page changes', () => {
  it('saves a new stroke with the same Automerge operations on a small and a large page', () => {
    const small = pageWith(5);
    const large = pageWith(300);
    const drawn = stroke('new', 5_000);

    const smallAfter = commit(small, { upserts: [drawn] });
    const largeAfter = commit(large, { upserts: [drawn] });

    expect(operationCount(large, largeAfter)).toBe(operationCount(small, smallAfter));
    expect(largeAfter.zOrder.at(-1)).toBe('new');
    assertMapMatchesOrder(largeAfter);
  });

  it('keeps a stroke another device drew meanwhile when both are merged', () => {
    const base = pageWith(20);
    const local = commit(Automerge.clone(base, { actor: 'aa'.repeat(16) }), { upserts: [stroke('mine', 900)] });
    const remote = commit(Automerge.clone(base, { actor: 'bb'.repeat(16) }), { upserts: [stroke('theirs', 950)] });

    const merged = Automerge.merge(local, remote);

    expect(merged.zOrder.slice(-2).sort()).toEqual(['mine', 'theirs']);
    assertMapMatchesOrder(merged);
  });

  it('writes only the fields a command changed, so a concurrent recolour survives a move', () => {
    const base = pageWith(3);
    const snapshot = plain(base);
    const moved = { ...(snapshot.elements.s1 as StrokeElementV2) };
    moved.frame = { ...moved.frame, x: 400 };
    moved.points = moved.points.map((point) => ({ ...point, x: point.x + 380 }));
    const local = commit(Automerge.clone(base, { actor: 'aa'.repeat(16) }), { upserts: [moved] }, snapshot);
    const remote = Automerge.change(Automerge.clone(base, { actor: 'bb'.repeat(16) }), (draft) => {
      (draft.elementsById.s1 as StrokeElementV2).color = '#dc2626';
    });

    const merged = Automerge.merge(local, remote).elementsById.s1 as StrokeElementV2;

    expect(merged.frame.x).toBe(400);
    expect(merged.color).toBe('#dc2626');
  });

  it('removes the right ids even when a remote insert shifted the stored positions', () => {
    const base = pageWith(6);
    const staleOrder = plain(base);
    const shifted = Automerge.change(base, (draft) => {
      draft.elementsById.front = stroke('front');
      draft.zOrder.unshift('front');
    });

    const after = commit(shifted, { removals: ['s2', 's4'] }, staleOrder);

    expect([...after.zOrder]).toEqual(['front', 's0', 's1', 's3', 's5']);
    assertMapMatchesOrder(after);
  });

  it('puts the pieces of a point-erased stroke at the depth of the stroke they came from', () => {
    const base = pageWith(4);
    const after = commit(base, {
      upserts: [stroke('piece-a'), stroke('piece-b')],
      anchors: { 'piece-a': 's1', 'piece-b': 'piece-a' },
    });

    expect([...after.zOrder]).toEqual(['s0', 's1', 'piece-a', 'piece-b', 's2', 's3']);
  });

  it('keeps every piece of a swipe that erased several strokes at its own stroke\'s depth', () => {
    // Each insertion shifts the positions behind it, so later pieces cannot
    // rely on the stored positions of their strokes.
    const base = pageWith(8);
    const after = commit(base, {
      upserts: [stroke('a1'), stroke('a2'), stroke('b1'), stroke('c1'), stroke('c2')],
      anchors: { a1: 's1', a2: 'a1', b1: 's4', c1: 's6', c2: 'c1' },
    });

    expect([...after.zOrder]).toEqual([
      's0', 's1', 'a1', 'a2', 's2', 's3', 's4', 'b1', 's5', 's6', 'c1', 'c2', 's7',
    ]);
  });

  it('restores deleted neighbours at their old depth on undo', () => {
    const base = pageWith(5);
    const before = plain(base);
    const removed = ['s1', 's2'];
    const anchors = zOrderAnchors(before.zOrder, removed);
    const deleted = commit(base, { removals: removed });
    const afterDelete = plain(deleted);

    const restore = changesForIds(afterDelete.elements, before.elements, removed, anchors);
    const restored = commit(deleted, restore, afterDelete);

    expect([...restored.zOrder]).toEqual(['s0', 's1', 's2', 's3', 's4']);
  });

  it('restores long deleted runs and scattered ids at their old depth on undo', () => {
    const base = pageWith(240);
    const before = plain(base);
    // Two long runs and a few single ids: anchors chain within the runs and
    // point at surviving ids between them.
    const removed = [
      ...Array.from({ length: 80 }, (_, index) => `s${30 + index}`),
      ...Array.from({ length: 60 }, (_, index) => `s${150 + index}`),
      's10', 's120', 's239',
    ];
    const anchors = zOrderAnchors(before.zOrder, removed);
    const deleted = commit(base, { removals: removed });
    const afterDelete = plain(deleted);
    expect(afterDelete.zOrder).toHaveLength(240 - removed.length);

    const restore = changesForIds(afterDelete.elements, before.elements, removed, anchors);
    const restored = commit(deleted, restore, afterDelete);

    expect([...restored.zOrder]).toEqual(before.zOrder);
    assertMapMatchesOrder(restored);
  });

  it('leaves ink untouched in the read-only ink mode of the phone viewer', () => {
    const base = pageWith(2);
    const viewer = (changes: PageElementChanges) => Automerge.change(base, (draft) => {
      const view = plain(base);
      applyPageElementChanges(draft, changes, view.elements, 'later', view.zOrder, undefined, { readOnlyInk: true });
    });

    const drawn = viewer({ upserts: [stroke('new', 900)] });
    const moved = viewer({ upserts: [{ ...stroke('s0'), color: '#dc2626' }] });
    const erased = viewer({ removals: ['s0', 's1'] });
    const reordered = viewer({ zOrder: ['s1', 's0'] });
    for (const result of [drawn, moved, erased, reordered]) {
      expect(plain(result)).toEqual(plain(base));
    }

    const typed = viewer({
      upserts: [{
        id: 'text', kind: 'richText', frame: { x: 1, y: 2, width: 100, height: 40, rotation: 0 },
        createdAt: TIME, updatedAt: TIME, locked: false,
        content: { type: 'doc', blocks: [{ id: 'block', type: 'paragraph', spans: [] }] },
        style: { color: '#000', fontFamily: 'sans-serif', fontSize: 16, textAlign: 'left' },
      }],
    });
    expect(typed.zOrder).toEqual(['s0', 's1', 'text']);
  });

  it('leaves ink untouched on a page of a notebook shared read-only, and only on that page', () => {
    const base = pageWith(2);
    const edit = (changes: PageElementChanges) => Automerge.change(Automerge.clone(base), (draft) => {
      const view = plain(base);
      applyPageElementChanges(draft, changes, view.elements, 'later', view.zOrder);
    });

    setReadOnlyDocuments(['page:1']);
    try {
      for (const result of [
        edit({ upserts: [stroke('new', 900)] }),
        edit({ upserts: [{ ...stroke('s0'), color: '#dc2626' }] }),
        edit({ removals: ['s0'] }),
      ]) expect(plain(result)).toEqual(plain(base));

      // The same command on a page of another notebook is an ordinary edit.
      const other = Automerge.change(Automerge.clone(base), (draft) => {
        draft.documentId = 'page:2';
        const view = plain(base);
        applyPageElementChanges(draft, { upserts: [stroke('new', 900)] }, view.elements, 'later', view.zOrder);
      });
      expect(other.zOrder).toContain('new');
    } finally {
      setReadOnlyDocuments([]);
    }
    expect(edit({ upserts: [stroke('new', 900)] }).zOrder).toContain('new');
  });

  it('creates live rich text with its spans and z-order in one change', () => {
    const base = pageWith(0);
    const after = commit(base, {
      upserts: [{
        id: 'text', kind: 'richText', frame: { x: 1, y: 2, width: 100, height: 40, rotation: 0 },
        createdAt: TIME, updatedAt: TIME, locked: false,
        content: { type: 'doc', blocks: [{ id: 'block', type: 'paragraph', spans: [] }] },
        style: { color: '#000', fontFamily: 'sans-serif', fontSize: 16, textAlign: 'left' },
      }],
    });

    expect(after.zOrder).toEqual(['text']);
    expect(Automerge.spans(after, ['elementsById', 'text', 'text'])[0]?.type).toBe('block');
  });

  it('moves a rich-text container without touching text typed on another device', () => {
    const base = commit(pageWith(0), {
      upserts: [{
        id: 'text', kind: 'richText', frame: { x: 1, y: 2, width: 100, height: 40, rotation: 0 },
        createdAt: TIME, updatedAt: TIME, locked: false,
        content: { type: 'doc', blocks: [{ id: 'block', type: 'paragraph', spans: [{ text: 'Hallo', marks: [] }] }] },
        style: { color: '#000', fontFamily: 'sans-serif', fontSize: 16, textAlign: 'left' },
      }],
    });
    const snapshot = plain(base);
    const remote = Automerge.change(Automerge.clone(base, { actor: 'bb'.repeat(16) }), (draft) => {
      Automerge.splice(draft, ['elementsById', 'text', 'text'], 1, 0, 'Welt ');
    });
    const moved = { ...snapshot.elements.text, frame: { ...snapshot.elements.text.frame, x: 80 } } as PageElementV3;
    const local = commit(Automerge.clone(base, { actor: 'aa'.repeat(16) }), { upserts: [moved] }, snapshot);

    const merged = Automerge.merge(local, remote).elementsById.text;

    expect(merged.frame.x).toBe(80);
    expect(merged.kind === 'richText' && merged.text).toContain('Welt');
  });

  it('treats an undefined field as absent, so undoing an erase brings the stroke back', () => {
    const base = pageWith(2);
    const erased = commit(base, { upserts: [{ ...stroke('s1', 20), tombstonedAt: 'later' }] });
    const snapshot = plain(erased);

    const restored = commit(erased, {
      upserts: [{ ...(snapshot.elements.s1 as StrokeElementV2), tombstonedAt: undefined }],
    }, snapshot);

    expect('tombstonedAt' in restored.elementsById.s1).toBe(false);
  });

  it('reorders with list edits and leaves ids it was not told about in place', () => {
    const list = ['a', 'b', 'remote', 'c', 'd'];
    syncListOrder(list, ['a', 'c', 'b', 'e', 'd']);

    expect(list.indexOf('c')).toBeLessThan(list.indexOf('b'));
    expect(list.indexOf('e')).toBe(list.indexOf('b') + 1);
    expect(list).toContain('remote');
    expect(new Set(list).size).toBe(list.length);
  });
});

describe('stroke storage forms in page changes', () => {
  function revealed(document: Automerge.Doc<LivePageDocV2>) {
    const snapshot = revealPageStrokes(Automerge.toJS(document));
    return { elements: snapshot.elementsById as Record<string, PageElementV3>, zOrder: snapshot.zOrder };
  }

  function commitAs(
    document: Automerge.Doc<LivePageDocV2>,
    changes: PageElementChanges,
    format: StrokeStorageFormat,
    base = revealed(document),
  ): Automerge.Doc<LivePageDocV2> {
    // Cloned so that one starting document can branch into several changes.
    return Automerge.change(Automerge.clone(document), (draft) => {
      applyPageElementChanges(draft, changes, base.elements, 'later', base.zOrder, format);
    });
  }

  const raw = (document: Automerge.Doc<LivePageDocV2>, id: string) => document.elementsById[id] as unknown as Record<string, unknown>;

  function movedBy(element: StrokeElementV2, dx: number): StrokeElementV2 {
    return {
      ...element,
      frame: { ...element.frame, x: element.frame.x + dx },
      points: element.points.map((point) => ({ ...point, x: point.x + dx })),
    };
  }

  it('writes a new stroke as packed samples only when asked to', () => {
    const page = pageWith(2);
    const packed = commitAs(page, { upserts: [stroke('new', 40)] }, 'packed');
    const listed = commitAs(page, { upserts: [stroke('new', 40)] }, 'points');

    expect(hasPackedPoints(raw(packed, 'new'))).toBe(true);
    expect(raw(packed, 'new').points).toBeUndefined();
    expect(Array.isArray(raw(listed, 'new').points)).toBe(true);
    expect(raw(listed, 'new').packedPoints).toBeUndefined();
    expect(revealed(packed).elements.new).toEqual(stroke('new', 40));
    expect(operationCount(page, packed)).toBeLessThan(operationCount(page, listed) / 2);
  });

  it('moves a packed stroke by rewriting its one byte string, and undo restores it', () => {
    const base = commitAs(pageWith(3), { upserts: [stroke('a', 10)] }, 'packed');
    const before = revealed(base);
    const original = before.elements.a as StrokeElementV2;

    const moved = commitAs(base, { upserts: [movedBy(original, 500)] }, 'packed', before);
    const movedAsList = commitAs(base, { upserts: [movedBy(original, 500)] }, 'points', before);
    const afterMove = revealed(moved);
    const undone = commitAs(moved, changesForIds(afterMove.elements, before.elements, ['a']), 'packed', afterMove);

    // Rewriting the samples is one operation instead of one list of maps.
    expect(operationCount(base, moved)).toBeLessThan(operationCount(base, movedAsList) / 2);
    expect((afterMove.elements.a as StrokeElementV2).points[0].x).toBe(510);
    expect(revealed(undone).elements.a).toEqual(original);
    expect(raw(undone, 'a').points).toBeUndefined();
  });

  it('leaves a stroke in the form it has when only its colour changes', () => {
    const legacy = pageWith(2);
    const base = revealed(legacy);
    const recoloured = { ...(base.elements.s0 as StrokeElementV2), color: '#dc2626' };

    const changed = commitAs(legacy, { upserts: [recoloured] }, 'packed', base);

    expect(Array.isArray(raw(changed, 's0').points)).toBe(true);
    expect(raw(changed, 's0').packedPoints).toBeUndefined();
    expect(raw(changed, 's0').color).toBe('#dc2626');
  });

  it('migrates a list stroke to packed samples when its samples are rewritten, and back', () => {
    const legacy = pageWith(2);
    const base = revealed(legacy);
    const moved = movedBy(base.elements.s1 as StrokeElementV2, 7);

    const packed = commitAs(legacy, { upserts: [moved] }, 'packed', base);
    const packedView = revealed(packed);
    const listed = commitAs(packed, { upserts: [movedBy(packedView.elements.s1 as StrokeElementV2, 1)] }, 'points', packedView);

    expect(hasPackedPoints(raw(packed, 's1'))).toBe(true);
    expect(raw(packed, 's1').points).toBeUndefined();
    expect((packedView.elements.s1 as StrokeElementV2).points.map((point) => point.x)).toEqual(moved.points.map((point) => point.x));
    expect(Array.isArray(raw(listed, 's1').points)).toBe(true);
    expect(raw(listed, 's1').packedPoints).toBeUndefined();
    // The neighbour that was never rewritten is untouched in both.
    expect(Array.isArray(raw(packed, 's0').points)).toBe(true);
  });

  it('keeps a stroke as a list when its samples cannot be packed', () => {
    const outOfRange = { ...stroke('odd', 5), points: stroke('odd', 5).points.map((point) => ({ ...point, pressure: 1.5 })) };

    const after = commitAs(pageWith(1), { upserts: [outOfRange] }, 'packed');

    expect(Array.isArray(raw(after, 'odd').points)).toBe(true);
    expect(revealed(after).elements.odd).toEqual(outOfRange);
  });

  it('merges a concurrent recolour with a move of the same packed stroke, and two moves to one whole stroke', () => {
    const base = commitAs(pageWith(1), { upserts: [stroke('a', 10)] }, 'packed');
    const view = revealed(base);
    const original = view.elements.a as StrokeElementV2;
    const local = commitAs(Automerge.clone(base, { actor: 'aa'.repeat(16) }), { upserts: [movedBy(original, 100)] }, 'packed', view);
    const remoteMove = commitAs(Automerge.clone(base, { actor: 'bb'.repeat(16) }), { upserts: [movedBy(original, 200)] }, 'packed', view);
    const remoteColour = commitAs(
      Automerge.clone(base, { actor: 'cc'.repeat(16) }),
      { upserts: [{ ...original, color: '#dc2626' }] },
      'packed',
      view,
    );

    const withColour = revealed(Automerge.merge(Automerge.clone(local), remoteColour)).elements.a as StrokeElementV2;
    const bothMoved = Automerge.merge(Automerge.clone(local), remoteMove);
    const winner = revealed(bothMoved).elements.a as StrokeElementV2;

    expect(withColour.color).toBe('#dc2626');
    expect(withColour.points[0].x).toBe(110);
    // Whichever move wins, its samples and frame come from that one move.
    expect([110, 210]).toContain(winner.points[0].x);
    expect(winner.frame.x).toBe(winner.points[0].x);
    expect(getAutomergeConflicts(bothMoved as never).some((conflict) => conflict.path.includes('packedPoints'))).toBe(true);
  });
});
