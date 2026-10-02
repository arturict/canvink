import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StrokeElementV2 } from '../domain/v2';
import { PendingInk } from './pendingInk';
import { MemorySegmentBackend, resetInkSegments } from './segmentStore';

const TIME = '2026-09-25T08:00:00.000Z';

function stroke(id: string, x = 0): StrokeElementV2 {
  return {
    id, kind: 'stroke', frame: { x: x + 0.123456, y: 0, width: 9.87654, height: 2, rotation: 0 },
    createdAt: TIME, updatedAt: TIME, locked: false, tool: 'pen', color: '#111', size: 2, opacity: 1,
    points: Array.from({ length: 6 }, (_, point) => ({
      x: x + point * 1.111, y: point, pressure: 0.5, tiltX: 0, tiltY: 0, time: 0, pointerType: 'pen',
    })),
  };
}

let backend: MemorySegmentBackend;
let pending: PendingInk;

beforeEach(() => {
  backend = new MemorySegmentBackend();
  resetInkSegments(backend);
  pending = new PendingInk();
});

afterEach(() => pending.reset());

describe('pending ink', () => {
  it('keeps drawing order, versions every change and shares one frozen list until it changes', () => {
    expect(pending.version('p')).toBe(0);
    pending.upsert('p', stroke('a'));
    pending.upsert('p', stroke('b', 5));
    const first = pending.strokes('p');
    expect(first.map((item) => item.id)).toEqual(['a', 'b']);
    expect(pending.strokes('p')).toBe(first);
    const version = pending.version('p');
    pending.upsert('p', { ...stroke('a'), color: '#f00' });
    expect(pending.version('p')).toBeGreaterThan(version);
    // Updating a stroke keeps its place in the drawing order.
    expect(pending.strokes('p').map((item) => item.id)).toEqual(['a', 'b']);
    expect(pending.strokes('p')[0].color).toBe('#f00');
    expect(Object.isFrozen(pending.strokes('p')[0])).toBe(true);
    expect(Object.isFrozen(pending.strokes('p')[0].points[0])).toBe(true);
  });

  it('stores strokes at the precision a segment holds, so undo compares equal', () => {
    pending.upsert('p', stroke('a'));
    const stored = pending.strokes('p')[0];
    expect(stored.frame.x).toBe(Math.round(0.123456 * 128) / 128);
    pending.upsert('p', stored);
    expect(pending.strokes('p')[0]).toEqual(stored);
  });

  it('tells listeners how many strokes wait and forgets sealed ones', () => {
    const calls: Array<[string, number]> = [];
    pending.subscribe((documentId, count) => calls.push([documentId, count]));
    pending.upsert('p', stroke('a'));
    pending.upsert('p', stroke('b'));
    pending.remove('p', 'a');
    pending.clear('p', ['b', 'missing']);
    expect(calls).toEqual([['p', 1], ['p', 2], ['p', 1], ['p', 0]]);
    expect(pending.documentsWithPendingInk()).toEqual([]);
    expect(pending.remove('p', 'a')).toBe(false);
  });

  it('writes a journal record that a later session restores, and deletes it when empty', async () => {
    pending.upsert('p', stroke('a'));
    pending.upsert('p', stroke('b', 5));
    await pending.flushJournals();
    expect(backend.journals.has('p')).toBe(true);

    const next = new PendingInk();
    expect(await next.journaledDocuments()).toEqual(['p']);
    expect(await next.recover('p', (id) => id === 'a')).toBe(1);
    expect(next.strokes('p').map((item) => item.id)).toEqual(['b']);

    pending.clear('p', ['a', 'b']);
    await pending.flushJournals();
    expect(backend.journals.has('p')).toBe(false);
    next.reset();
  });

  it('drops a journal whose strokes the page already shows', async () => {
    pending.upsert('p', stroke('a'));
    await pending.flushJournals();
    const next = new PendingInk();
    expect(await next.recover('p', () => true)).toBe(0);
    expect(backend.journals.has('p')).toBe(false);
  });

  it('ignores a damaged journal', async () => {
    backend.journals.set('p', new Uint8Array([9, 9, 9]));
    expect(await pending.recover('p', () => false)).toBe(0);
  });
});
