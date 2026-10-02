import * as Automerge from '@automerge/automerge';
import { describe, expect, it } from 'vitest';
import { advanceHeads, isChangeSequence, readSavedDocumentHeads } from './documentHeads';

describe('readSavedDocumentHeads', () => {
  it('matches Automerge.getHeads for saves with several actors and concurrent heads', () => {
    let left = Automerge.from<{ items: string[]; n: number }>({ items: ['a'], n: 0 });
    let right = Automerge.clone(left, { actor: 'b'.repeat(64) });
    for (let i = 0; i < 20; i += 1) left = Automerge.change(left, (doc) => { doc.items.push(`l${i}`); doc.n += 1; });
    right = Automerge.change(right, (doc) => { doc.items.push('r'); });
    const concurrent = Automerge.merge(Automerge.clone(left), right);
    expect(Automerge.getHeads(concurrent).length).toBe(2);
    for (const doc of [left, right, concurrent]) {
      const bytes = Automerge.save(doc);
      expect(readSavedDocumentHeads(bytes)?.sort()).toEqual([...Automerge.getHeads(doc)].sort());
    }
  });

  it('declines anything that is not a lone document chunk', () => {
    const doc = Automerge.change(Automerge.init<{ n: number }>(), (d) => { d.n = 1; });
    const change = Automerge.getLastLocalChange(doc);
    expect(change).toBeDefined();
    expect(readSavedDocumentHeads(change as Uint8Array)).toBeUndefined();
    const saved = Automerge.save(doc);
    expect(readSavedDocumentHeads(new Uint8Array([...saved, 1, 2, 3]))).toBeUndefined();
    expect(readSavedDocumentHeads(saved.subarray(0, 12))).toBeUndefined();
    expect(readSavedDocumentHeads(new Uint8Array(40))).toBeUndefined();
  });
});

describe('advanceHeads', () => {
  it('follows the heads of a document through appended changes, including concurrent ones', () => {
    let base = Automerge.from<{ items: string[] }>({ items: [] });
    const baseHeads = Automerge.getHeads(base);
    let other = Automerge.clone(base, { actor: 'c'.repeat(64) });
    base = Automerge.change(base, (doc) => { doc.items.push('one'); });
    base = Automerge.change(base, (doc) => { doc.items.push('two'); });
    other = Automerge.change(other, (doc) => { doc.items.push('x'); });
    const appended = Automerge.saveSince(base, baseHeads);
    expect(advanceHeads(baseHeads, appended)?.sort()).toEqual([...Automerge.getHeads(base)].sort());
    const merged = Automerge.merge(Automerge.clone(base), other);
    const concurrent = Automerge.saveSince(other, baseHeads);
    const both = advanceHeads(advanceHeads(baseHeads, appended) ?? [], concurrent);
    expect(both?.sort()).toEqual([...Automerge.getHeads(merged)].sort());
  });

  it('declines documents, garbage and empty input', () => {
    const doc = Automerge.from<{ n: number }>({ n: 1 });
    expect(advanceHeads([], Automerge.save(doc))).toBeUndefined();
    expect(advanceHeads([], new Uint8Array(0))).toBeUndefined();
    expect(advanceHeads([], new Uint8Array(30))).toBeUndefined();
  });
});

describe('isChangeSequence', () => {
  it('accepts appended change chunks and declines saves, garbage and cut chunks', () => {
    const base = Automerge.from<{ items: string[] }>({ items: [] });
    const heads = Automerge.getHeads(base);
    const next = Automerge.change(Automerge.clone(base), (doc) => { doc.items.push('one'); });
    const changes = Automerge.saveSince(next, heads);
    expect(isChangeSequence(changes)).toBe(true);
    expect(isChangeSequence(new Uint8Array([...changes, ...changes]))).toBe(true);
    expect(isChangeSequence(Automerge.save(next))).toBe(false);
    expect(isChangeSequence(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]))).toBe(false);
    expect(isChangeSequence(changes.subarray(0, changes.byteLength - 1))).toBe(false);
    expect(isChangeSequence(new Uint8Array(0))).toBe(false);
  });
});
