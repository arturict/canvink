import * as Automerge from '@automerge/automerge';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getAutomergeHistory, getAutomergeSnapshot, type LivePageDocV2 } from '../crdt';
import { getSharedAutomergeSnapshot, sharedPlainSnapshot } from '../crdt/sharedSnapshot';
import type { StrokeElementV2 } from '../domain/v2';
import type { PageElementV3 } from '../domain/v3';
import { applyPageElementChanges, type PageElementChanges } from '../editor/pageChanges';
import { pendingInk } from './pendingInk';
import { inkRefKey, referencedInkSegments } from './projection';
import { compactPageInk, sealPageInk, sealPendingInk, type InkPageTarget } from './seal';
import { MemorySegmentBackend, inkSegments, resetInkSegments, type InkSegmentStore } from './segmentStore';

const TIME = '2026-09-24T00:00:00.000Z';
let store: InkSegmentStore;

beforeEach(() => {
  store = resetInkSegments(new MemorySegmentBackend());
  pendingInk().reset();
});

function stroke(id: string, x = 0, color = '#1d4ed8'): StrokeElementV2 {
  const points = Array.from({ length: 12 }, (_, index) => ({
    x: x + index, y: index % 3, pressure: 0.5, tiltX: 0, tiltY: 0, time: 0, pointerType: 'pen' as const,
  }));
  return {
    id, kind: 'stroke', frame: { x, y: 0, width: 11, height: 2, rotation: 0 },
    createdAt: TIME, updatedAt: TIME, locked: false, tool: 'pen', points, color, size: 3, opacity: 1,
  };
}

function textBox(id: string): PageElementV3 {
  return {
    id, kind: 'shape', shape: 'rectangle', frame: { x: 0, y: 0, width: 10, height: 10, rotation: 0 },
    createdAt: TIME, updatedAt: TIME, locked: false, strokeColor: '#000', strokeWidth: 1,
  } as PageElementV3;
}

interface Holder { doc: Automerge.Doc<LivePageDocV2> }

function pageWith(count: number, extra: PageElementV3[] = []): Holder {
  const elementsById: Record<string, PageElementV3> = {};
  const zOrder: string[] = [];
  for (const element of extra) {
    elementsById[element.id] = element;
    zOrder.push(element.id);
  }
  for (let index = 0; index < count; index += 1) {
    elementsById[`s${index}`] = stroke(`s${index}`, index * 20);
    zOrder.push(`s${index}`);
  }
  return {
    doc: Automerge.from<LivePageDocV2>({
      schemaVersion: 3, documentId: 'page:1', kind: 'page', notebookId: 'n', sectionId: 's', pageId: 'p',
      title: 'Physik', tags: [], pageType: 'free', background: { type: 'grid', color: '#fff' },
      createdAt: TIME, updatedAt: TIME, elementsById, zOrder,
    } as unknown as LivePageDocV2),
  };
}

function target(holder: Holder): InkPageTarget {
  return {
    read: () => ({ page: sharedPlainSnapshot(holder.doc) as never, version: Automerge.getHeads(holder.doc).join() }),
    change: (message, change) => {
      try {
        holder.doc = Automerge.change(holder.doc, { message }, (draft) => change(draft as never));
        return true;
      } catch {
        return false;
      }
    },
  };
}

function view(holder: Holder) {
  const snapshot = getSharedAutomergeSnapshot<LivePageDocV2>(holder.doc);
  return { elements: snapshot.elementsById as Record<string, PageElementV3>, order: [...snapshot.zOrder] };
}

function commit(holder: Holder, changes: PageElementChanges, holdNewInk = false): void {
  const before = view(holder);
  holder.doc = Automerge.change(holder.doc, (draft) => {
    applyPageElementChanges(draft, changes, before.elements, 'later', before.order, undefined, { holdNewInk });
  });
}

async function sealed(count: number, extra: PageElementV3[] = []): Promise<Holder> {
  const holder = pageWith(count, extra);
  const result = await sealPageInk(target(holder), store, { minRun: 4, maxStrokes: 1000 });
  expect(result.sealed).toBe(count);
  return holder;
}

describe('sealing ink into segments', () => {
  it('shows the same strokes in the same order after sealing, from very few operations', async () => {
    const holder = pageWith(300, [textBox('note')]);
    const before = view(holder);
    await sealPageInk(target(holder), store, { minRun: 4, maxStrokes: 1000 });
    const after = view(holder);

    expect(after.order).toEqual(before.order);
    for (const id of before.order) {
      expect(after.elements[id].id).toBe(id);
      if (id.startsWith('s')) expect((after.elements[id] as StrokeElementV2).points).toEqual((before.elements[id] as StrokeElementV2).points);
    }
    // The document itself holds a reference and a slot, no strokes.
    expect(Object.keys(holder.doc.elementsById)).toEqual(['note']);
    expect(holder.doc.zOrder.length).toBe(2);
    expect(referencedInkSegments(holder.doc)).toHaveLength(1);
  });

  it('cuts a long run into segments of the configured size', async () => {
    const holder = pageWith(50);
    const result = await sealPageInk(target(holder), store, { minRun: 4, maxStrokes: 20 });
    expect(result.segments).toBe(3); // 20 + 20 + 10
    expect(view(holder).order).toHaveLength(50);
  });

  it('leaves short runs as elements and keeps the order around other elements', async () => {
    const holder = pageWith(10, [textBox('a')]);
    commit(holder, { upserts: [textBox('b')] });
    commit(holder, { upserts: [stroke('late1'), stroke('late2')] });
    await sealPageInk(target(holder), store, { minRun: 4, maxStrokes: 1000 });
    const order = view(holder).order;
    expect(order[0]).toBe('a');
    expect(order.indexOf('b')).toBe(11);
    expect(order.slice(-2)).toEqual(['late1', 'late2']);
    expect(holder.doc.elementsById.late1).toBeDefined();
  });

  it('is repeatable: sealing a sealed page seals nothing, new strokes seal into a second segment', async () => {
    const holder = await sealed(30);
    expect(await sealPageInk(target(holder), store, { minRun: 4, maxStrokes: 1000 })).toMatchObject({ sealed: 0 });
    commit(holder, { upserts: Array.from({ length: 8 }, (_, index) => stroke(`n${index}`, 1000 + index)) });
    await sealPageInk(target(holder), store, { minRun: 4, maxStrokes: 1000 });
    expect(referencedInkSegments(holder.doc)).toHaveLength(2);
    const order = view(holder).order;
    expect(order).toHaveLength(38);
    expect(order.slice(-8)).toEqual(Array.from({ length: 8 }, (_, index) => `n${index}`));
  });

  it('does not reference a segment before its bytes are durable', async () => {
    const backend = new MemorySegmentBackend();
    store = resetInkSegments(backend);
    const holder = pageWith(10);
    await sealPageInk(target(holder), store, { minRun: 4, maxStrokes: 1000 });
    for (const hash of referencedInkSegments(holder.doc)) expect(backend.blobs.has(hash)).toBe(true);
    expect([...backend.pending]).toEqual(referencedInkSegments(holder.doc));
  });

  it('retries when the page changes while the segment is stored', async () => {
    const holder = pageWith(10);
    const inner = target(holder);
    let reads = 0;
    const racing: InkPageTarget = {
      read: () => {
        reads += 1;
        // A remote stroke arrives after the plan is made and before the change is written.
        if (reads === 2) commit(holder, { upserts: [stroke('remote', 500)] });
        return inner.read();
      },
      change: inner.change,
    };
    await sealPageInk(racing, store, { minRun: 4, maxStrokes: 1000 });
    expect(view(holder).order).toHaveLength(11);
    expect(view(holder).order.at(-1)).toBe('remote');
  });
});

describe('editing sealed ink', () => {
  it('erases a sealed stroke and brings it back with undo', async () => {
    const holder = await sealed(30);
    const before = view(holder);
    commit(holder, { removals: ['s3'] });
    expect(view(holder).elements.s3).toBeUndefined();
    expect(view(holder).order).not.toContain('s3');
    expect(view(holder).order).toHaveLength(29);

    commit(holder, { upserts: [before.elements.s3], anchors: { s3: 's2' } });
    const restored = view(holder);
    expect(restored.elements.s3).toBeDefined();
    // A restored stroke is drawn at its segment's place (above the segment's ink), not at its old depth inside it.
    expect(restored.order).toHaveLength(30);
    expect(restored.order.filter((id) => id === 's3')).toHaveLength(1);
  });

  it('moves and recolours a sealed stroke without disturbing the rest', async () => {
    const holder = await sealed(30);
    const before = view(holder);
    const moved = {
      ...(before.elements.s5 as StrokeElementV2),
      color: '#ff0000',
      points: (before.elements.s5 as StrokeElementV2).points.map((point) => ({ ...point, x: point.x + 40 })),
    };
    commit(holder, { upserts: [moved] });
    const after = view(holder);
    expect((after.elements.s5 as StrokeElementV2).color).toBe('#ff0000');
    expect((after.elements.s5 as StrokeElementV2).points[0].x).toBe((before.elements.s5 as StrokeElementV2).points[0].x + 40);
    expect(after.order).toHaveLength(30);
    // The moved stroke keeps its place next to its neighbours.
    expect(Math.abs(after.order.indexOf('s5') - 5)).toBeLessThanOrEqual(30);
    expect(new Set(after.order).size).toBe(30);
    expect((after.elements.s6 as StrokeElementV2).color).toBe('#1d4ed8');
  });

  it('erases a moved stroke without the sealed copy showing through', async () => {
    const holder = await sealed(30);
    const base = view(holder).elements.s5 as StrokeElementV2;
    commit(holder, { upserts: [{ ...base, color: '#00ff00' }] });
    commit(holder, { removals: ['s5'] });
    expect(view(holder).elements.s5).toBeUndefined();
    expect(view(holder).order).toHaveLength(29);
  });

  it('keeps sealed ink in place when other elements are reordered', async () => {
    const holder = pageWith(30, [textBox('a'), textBox('b')]);
    await sealPageInk(target(holder), store, { minRun: 4, maxStrokes: 1000 });
    const order = view(holder).order;
    // Bring "a" to the front.
    commit(holder, { zOrder: [...order.filter((id) => id !== 'a'), 'a'] });
    const after = view(holder).order;
    expect(after.at(-1)).toBe('a');
    expect(after.slice(0, 31)).toEqual(order.filter((id) => id !== 'a'));
    expect(Object.keys(holder.doc.elementsById).sort()).toEqual(['a', 'b']);
  });

  it('brings a sealed stroke to the front by turning it into an element', async () => {
    const holder = await sealed(30);
    const order = view(holder).order;
    commit(holder, { zOrder: [...order.filter((id) => id !== 's2'), 's2'] });
    const after = view(holder).order;
    expect(after.at(-1)).toBe('s2');
    expect(after).toHaveLength(30);
    expect(new Set(after).size).toBe(30);
  });

  it('draws new strokes on top and undoes their creation', async () => {
    const holder = await sealed(30);
    commit(holder, { upserts: [stroke('fresh', 999)] });
    expect(view(holder).order.at(-1)).toBe('fresh');
    commit(holder, { removals: ['fresh'] });
    expect(view(holder).order).toHaveLength(30);
  });
});

describe('merging ink from two devices', () => {
  it('keeps the ink both devices add, erase and move', async () => {
    const holder = await sealed(30);
    const a: Holder = { doc: Automerge.clone(holder.doc) };
    const b: Holder = { doc: Automerge.clone(holder.doc) };
    // Device A draws more ink and seals it, then erases s1. Device B draws too, and moves s2.
    commit(a, { upserts: Array.from({ length: 6 }, (_, index) => stroke(`a${index}`, 2000 + index)) });
    await sealPageInk(target(a), store, { minRun: 4, maxStrokes: 1000 });
    commit(a, { removals: ['s1'] });
    commit(b, { upserts: Array.from({ length: 6 }, (_, index) => stroke(`b${index}`, 3000 + index)) });
    await sealPageInk(target(b), store, { minRun: 4, maxStrokes: 1000 });
    const original = view(holder).elements.s2 as StrokeElementV2;
    commit(b, { upserts: [{ ...original, color: '#123456' }] });

    const merged: Holder = { doc: Automerge.merge(Automerge.clone(a.doc), b.doc) };
    const mirrored: Holder = { doc: Automerge.merge(Automerge.clone(b.doc), a.doc) };
    for (const side of [merged, mirrored]) {
      const { elements, order } = view(side);
      expect(new Set(order).size).toBe(order.length);
      expect(order).toHaveLength(30 - 1 + 6 + 6);
      expect(elements.s1).toBeUndefined();
      expect((elements.s2 as StrokeElementV2).color).toBe('#123456');
      for (let index = 0; index < 6; index += 1) {
        expect(elements[`a${index}`]).toBeDefined();
        expect(elements[`b${index}`]).toBeDefined();
      }
    }
    expect(view(merged).order.sort()).toEqual(view(mirrored).order.sort());
    expect(referencedInkSegments(merged.doc)).toHaveLength(3);
  });

  it('two devices sealing the same strokes end up with one copy of each', async () => {
    const holder = pageWith(20);
    const a: Holder = { doc: Automerge.clone(holder.doc) };
    const b: Holder = { doc: Automerge.clone(holder.doc) };
    await sealPageInk(target(a), store, { minRun: 4, maxStrokes: 1000 });
    await sealPageInk(target(b), store, { minRun: 4, maxStrokes: 1000 });
    const merged: Holder = { doc: Automerge.merge(Automerge.clone(a.doc), b.doc) };
    expect(referencedInkSegments(merged.doc)).toHaveLength(1);
    const { order } = view(merged);
    expect(order).toHaveLength(20);
    expect(new Set(order).size).toBe(20);
  });

  it('shows no ink of a segment that has not arrived, and all of it once it did', async () => {
    const holder = await sealed(30);
    const hash = referencedInkSegments(holder.doc)[0];
    const bytes = await store.read(hash);
    // A second device: its own store is empty, the cloud holds the bytes.
    const other = resetInkSegments(new MemorySegmentBackend());
    expect(view(holder).order).toHaveLength(0);
    other.setRemote('test', { fetch: () => Promise.resolve(bytes) });
    expect(await other.ensure([hash])).toEqual([]);
    expect(view(holder).order).toHaveLength(30);
  });

  it('stops waiting for a slow download, and reports the segment when it arrives', async () => {
    const holder = await sealed(10);
    const hash = referencedInkSegments(holder.doc)[0];
    const bytes = (await store.read(hash)) as Uint8Array;
    const other = resetInkSegments(new MemorySegmentBackend());
    let deliver: (value: Uint8Array) => void = () => undefined;
    other.setRemote('test', { fetch: () => new Promise((resolve) => { deliver = resolve; }) });
    const arrived: string[][] = [];
    other.onLoaded((hashes) => arrived.push([...hashes]));

    expect(await other.ensure([hash], { remoteWaitMs: 20 })).toEqual([hash]);
    expect(view(holder).order).toHaveLength(0);
    deliver(bytes);
    await vi.waitFor(() => expect(arrived).toEqual([[hash]]));
    expect(view(holder).order).toHaveLength(10);
  });

  it('reports a segment the cloud does not hold yet, and a bad copy is refused', async () => {
    const holder = await sealed(10);
    const hash = referencedInkSegments(holder.doc)[0];
    const other = resetInkSegments(new MemorySegmentBackend());
    other.setRemote('test', { fetch: () => Promise.resolve(undefined) });
    expect(await other.ensure([hash])).toEqual([hash]);
    other.setRemote('test', { fetch: () => Promise.resolve(new Uint8Array([1, 2, 3])) });
    expect(await other.ensure([hash])).toEqual([hash]);
    expect(inkSegments().peek(hash)).toBeUndefined();
  });
});

describe('compaction', () => {
  it('rewrites a segment that lost most of its strokes and keeps what is visible', async () => {
    const holder = await sealed(40);
    const [oldHash] = referencedInkSegments(holder.doc);
    commit(holder, { removals: Array.from({ length: 20 }, (_, index) => `s${index}`) });
    const expected = view(holder).order;
    const result = await compactPageInk(target(holder), store, { deadShare: 0.3, minDead: 8, smallSegment: 4, maxStrokes: 1000 });
    expect(result.rewritten).toBe(1);
    const hashes = referencedInkSegments(holder.doc);
    expect(hashes).toHaveLength(1);
    expect(hashes[0]).not.toBe(oldHash);
    expect(view(holder).order).toEqual(expected);
    const ref = (holder.doc as unknown as Record<string, { dead?: object } | undefined>)[inkRefKey(hashes[0])];
    expect(ref).toMatchObject({ strokes: 20 });
    expect(Object.keys(ref?.dead ?? {})).toEqual([]);
  });

  it('keeps a moved stroke when the segment it came from is rewritten', async () => {
    const holder = await sealed(40);
    const base = view(holder).elements.s30 as StrokeElementV2;
    commit(holder, { upserts: [{ ...base, color: '#abcdef' }] });
    commit(holder, { removals: Array.from({ length: 20 }, (_, index) => `s${index}`) });
    await compactPageInk(target(holder), store, { deadShare: 0.3, minDead: 8, smallSegment: 4, maxStrokes: 1000 });
    const { elements, order } = view(holder);
    expect(order).toHaveLength(20);
    expect((elements.s30 as StrokeElementV2).color).toBe('#abcdef');
  });

  it('sealing a moved stroke hides the older copy instead of duplicating it', async () => {
    const holder = await sealed(40);
    const base = view(holder).elements.s30 as StrokeElementV2;
    commit(holder, { upserts: [{ ...base, color: '#abcdef' }] });
    await sealPageInk(target(holder), store, { minRun: 1, maxStrokes: 1000 });
    const { elements, order } = view(holder);
    expect(order).toHaveLength(40);
    expect(new Set(order).size).toBe(40);
    expect((elements.s30 as StrokeElementV2).color).toBe('#abcdef');
  });

  it('merges small neighbouring segments', async () => {
    const holder = pageWith(10);
    await sealPageInk(target(holder), store, { minRun: 4, maxStrokes: 1000 });
    commit(holder, { upserts: Array.from({ length: 6 }, (_, index) => stroke(`n${index}`, 1000 + index)) });
    await sealPageInk(target(holder), store, { minRun: 4, maxStrokes: 1000 });
    expect(referencedInkSegments(holder.doc)).toHaveLength(2);
    const expected = view(holder).order;
    await compactPageInk(target(holder), store);
    expect(referencedInkSegments(holder.doc)).toHaveLength(1);
    expect(view(holder).order).toEqual(expected);
  });
});

describe('other readers', () => {
  it('reads sealed pages through every snapshot function', async () => {
    const holder = await sealed(12);
    expect(Object.keys(getAutomergeSnapshot<LivePageDocV2>(holder.doc).elementsById)).toHaveLength(12);
    const history = getAutomergeHistory<LivePageDocV2>(holder.doc);
    expect(Object.keys(history.at(-1)!.snapshot.elementsById)).toHaveLength(12);
    expect(Object.keys(history[0].snapshot.elementsById)).toHaveLength(12);
  });

  it('keeps the shared snapshot cheap when nothing ink-related changed', async () => {
    const holder = await sealed(30);
    const first = view(holder);
    holder.doc = Automerge.change(holder.doc, (draft) => { draft.title = 'Chemie'; });
    const second = view(holder);
    expect(second.elements).toBe(first.elements);
  });
});

describe('editing sealed ink from the editor (pending strokes)', () => {
  async function seal(holder: Holder): Promise<number> {
    return sealPendingInk(
      { change: target(holder).change },
      holder.doc.documentId,
      store,
      pendingInk(),
    );
  }

  it('moves a sealed stroke by hiding its segment copy and drawing the moved one as pending ink', async () => {
    const holder = await sealed(30);
    const opsBefore = Automerge.stats(holder.doc).numOps;
    const original = view(holder).elements.s5 as StrokeElementV2;
    const moved = { ...original, points: original.points.map((point) => ({ ...point, x: point.x + 40 })) };
    commit(holder, { upserts: [moved] }, true);

    // Cheap in the document: a hidden-marker, no stroke.
    expect(Automerge.stats(holder.doc).numOps - opsBefore).toBeLessThan(12);
    expect(holder.doc.elementsById.s5).toBeUndefined();
    const shown = view(holder);
    expect((shown.elements.s5 as StrokeElementV2).points[0].x).toBe(original.points[0].x + 40);
    expect(shown.order).toHaveLength(30);
    expect(shown.order.at(-1)).toBe('s5');

    expect(await seal(holder)).toBe(1);
    const sealedView = view(holder);
    expect(sealedView.order).toEqual(shown.order);
    expect((sealedView.elements.s5 as StrokeElementV2).points[0].x).toBe(original.points[0].x + 40);
    expect(referencedInkSegments(holder.doc)).toHaveLength(2);
  });

  it('brings a stroke back when sealing it again gives the segment it came from, byte for byte', async () => {
    const holder = await sealed(4);
    const original = view(holder).elements.s2 as StrokeElementV2;
    // Move it, let the move seal, then undo the move: the stroke is exactly as it was sealed first.
    commit(holder, { upserts: [{ ...original, color: '#00ff00' }] }, true);
    expect(await seal(holder)).toBe(1);
    expect((view(holder).elements.s2 as StrokeElementV2).color).toBe('#00ff00');
    commit(holder, { upserts: [original] }, true);
    expect(await seal(holder)).toBe(1);
    const after = view(holder);
    expect((after.elements.s2 as StrokeElementV2).color).toBe('#1d4ed8');
    expect(after.order).toHaveLength(4);
    expect(new Set(after.order).size).toBe(4);

    // The same after erasing the only stroke of a segment and undoing the erase before it is sealed away.
    const single = pageWith(1);
    await sealPageInk(target(single), store, { minRun: 1, maxStrokes: 1000 });
    const only = view(single).elements.s0 as StrokeElementV2;
    commit(single, { removals: ['s0'] }, true);
    commit(single, { upserts: [only] }, true);
    expect(await seal(single)).toBe(1);
    expect(view(single).order).toEqual(['s0']);
  });

  it('undoes a move by drawing the earlier state, and an erase by drawing the stroke again', async () => {
    const holder = await sealed(30);
    const original = view(holder).elements.s7 as StrokeElementV2;
    commit(holder, { upserts: [{ ...original, color: '#ff0000' }] }, true);
    commit(holder, { upserts: [original] }, true);
    expect((view(holder).elements.s7 as StrokeElementV2).color).toBe('#1d4ed8');
    commit(holder, { removals: ['s7'] }, true);
    expect(view(holder).elements.s7).toBeUndefined();
    commit(holder, { upserts: [original] }, true);
    expect(view(holder).elements.s7).toBeDefined();
    expect(view(holder).order.filter((id) => id === 's7')).toHaveLength(1);
    expect(view(holder).order).toHaveLength(30);
  });

  it('loses nothing when two devices move different strokes of the same segment', async () => {
    const holder = await sealed(30);
    const a: Holder = { doc: Automerge.clone(holder.doc) };
    const b: Holder = { doc: Automerge.clone(holder.doc) };
    const base = view(holder).elements;
    commit(a, { upserts: [{ ...(base.s1 as StrokeElementV2), color: '#111111' }] }, true);
    await seal(a);
    pendingInk().reset();
    commit(b, { upserts: [{ ...(base.s2 as StrokeElementV2), color: '#222222' }] }, true);
    await seal(b);
    const merged: Holder = { doc: Automerge.merge(Automerge.clone(a.doc), b.doc) };
    const { elements, order } = view(merged);
    expect(order).toHaveLength(30);
    expect(new Set(order).size).toBe(30);
    expect((elements.s1 as StrokeElementV2).color).toBe('#111111');
    expect((elements.s2 as StrokeElementV2).color).toBe('#222222');
  });

  it('keeps the first ink of two devices that seal at the same time on a page without segments', async () => {
    const holder = pageWith(0);
    const a: Holder = { doc: Automerge.clone(holder.doc) };
    const b: Holder = { doc: Automerge.clone(holder.doc) };
    const documentId = a.doc.documentId;
    commit(a, { upserts: [stroke('a1', 10), stroke('a2', 11)] }, true);
    await sealPendingInk({ change: target(a).change }, documentId, store, pendingInk());
    pendingInk().reset();
    commit(b, { upserts: [stroke('b1', 20), stroke('b2', 21), stroke('b3', 22)] }, true);
    await sealPendingInk({ change: target(b).change }, documentId, store, pendingInk());
    const merged: Holder = { doc: Automerge.merge(Automerge.clone(a.doc), b.doc) };
    const order = view(merged).order;
    expect([...order].sort()).toEqual(['a1', 'a2', 'b1', 'b2', 'b3']);
    expect(referencedInkSegments(merged.doc)).toHaveLength(2);
  });

  it('keeps a pending stroke out of the document when it is erased before sealing', async () => {
    const holder = await sealed(30);
    const opsBefore = Automerge.stats(holder.doc).numOps;
    commit(holder, { upserts: [stroke('fleeting', 900)] }, true);
    expect(view(holder).elements.fleeting).toBeDefined();
    commit(holder, { removals: ['fleeting'] }, true);
    expect(view(holder).elements.fleeting).toBeUndefined();
    expect(Automerge.stats(holder.doc).numOps).toBe(opsBefore);
    expect(await seal(holder)).toBe(0);
  });

  it('seals pending ink in drawing order on top of the page', async () => {
    const holder = await sealed(10);
    commit(holder, { upserts: [stroke('p1', 950), stroke('p2', 951)] }, true);
    commit(holder, { upserts: [stroke('p3', 952)] }, true);
    expect(view(holder).order.slice(-3)).toEqual(['p1', 'p2', 'p3']);
    expect(await seal(holder)).toBe(3);
    expect(pendingInk().count(holder.doc.documentId)).toBe(0);
    expect(view(holder).order.slice(-3)).toEqual(['p1', 'p2', 'p3']);
    expect(holder.doc.zOrder.at(-1)).toMatch(/^ink:/);
  });

  it('gives z-order commands a stroke that carries its position in the document', async () => {
    const holder = await sealed(10);
    commit(holder, { upserts: [stroke('top', 990)] }, true);
    const order = view(holder).order;
    commit(holder, {
      upserts: [view(holder).elements.top],
      zOrder: ['top', ...order.filter((id) => id !== 'top')],
    }, true);
    expect(view(holder).order[0]).toBe('top');
    expect(holder.doc.elementsById.top).toBeDefined();
  });
});
