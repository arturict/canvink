import * as Automerge from '@automerge/automerge';
import { describe, expect, it } from 'vitest';
import {
  activeClaims,
  claimChange,
  leaseWinner,
  nextGenerationDocumentId,
  releaseChange,
  swappedDocuments,
} from './rebuildLease';

interface Notebook { title: string; sections: Array<{ pageDocumentIds: string[] }>; [key: string]: unknown }

function notebook(): Automerge.Doc<Notebook> {
  return Automerge.from<Notebook>({ title: 'Schule', sections: [{ pageDocumentIds: ['page:a', 'page:b'] }] });
}

const NOW = new Date('2026-10-01T10:00:00.000Z');
const later = (seconds: number): Date => new Date(NOW.getTime() + seconds * 1000);

function claim(doc: Automerge.Doc<Notebook>, page: string, device: string, at: Date, ttlMs?: number) {
  return Automerge.change(doc, (draft) => claimChange(page, device, at, ttlMs)(draft as never));
}

describe('page rebuild lease', () => {
  it('two devices that claim the same page at once agree on one winner, whichever way they merge', () => {
    const base = notebook();
    const a = claim(Automerge.clone(base), 'page:a', 'device-a', later(2));
    const b = claim(Automerge.clone(base), 'page:a', 'device-b', later(1));
    const ab = Automerge.merge(Automerge.clone(a), b);
    const ba = Automerge.merge(Automerge.clone(b), a);
    for (const merged of [ab, ba]) {
      expect(activeClaims(merged, 'page:a', later(3).getTime())).toHaveLength(2);
      expect(leaseWinner(merged, 'page:a', later(3).getTime())).toBe('device-b');
    }
    // Each device sees itself as the loser or the winner from its own merged copy, never both.
    const winners = ['device-a', 'device-b'].filter((id) => leaseWinner(ab, 'page:a', later(3).getTime()) === id);
    expect(winners).toEqual(['device-b']);
  });

  it('breaks an exact tie by device id and keeps claims on other pages apart', () => {
    let doc = claim(notebook(), 'page:a', 'device-b', NOW);
    doc = claim(doc, 'page:a', 'device-a', NOW);
    doc = claim(doc, 'page:b', 'device-b', later(5));
    expect(leaseWinner(doc, 'page:a', NOW.getTime())).toBe('device-a');
    expect(leaseWinner(doc, 'page:b', NOW.getTime())).toBe('device-b');
    expect(leaseWinner(doc, 'page:c', NOW.getTime())).toBeUndefined();
  });

  it('lets another device take over once a claim has expired', () => {
    const doc = claim(notebook(), 'page:a', 'device-a', NOW, 60_000);
    expect(leaseWinner(doc, 'page:a', later(30).getTime())).toBe('device-a');
    expect(leaseWinner(doc, 'page:a', later(61).getTime())).toBeUndefined();
    const taken = claim(doc, 'page:a', 'device-b', later(61));
    expect(leaseWinner(taken, 'page:a', later(62).getTime())).toBe('device-b');
  });

  it('a released claim frees the page for the others', () => {
    let doc = claim(notebook(), 'page:a', 'device-a', NOW);
    doc = claim(doc, 'page:a', 'device-b', later(1));
    doc = Automerge.change(doc, (draft) => releaseChange('page:a', 'device-a')(draft as never));
    expect(leaseWinner(doc, 'page:a', later(2).getTime())).toBe('device-b');
    doc = Automerge.change(doc, (draft) => releaseChange('page:a')(draft as never));
    expect(leaseWinner(doc, 'page:a', later(2).getTime())).toBeUndefined();
  });

  it('only the winner may swap: a device that lost the race sees it and writes nothing', () => {
    const base = notebook();
    const a = claim(Automerge.clone(base), 'page:a', 'device-a', later(2));
    const b = claim(Automerge.clone(base), 'page:a', 'device-b', later(1));
    const merged = Automerge.merge(Automerge.clone(a), b);
    const swapIfWinner = (doc: Automerge.Doc<Notebook>, device: string): Automerge.Doc<Notebook> => {
      if (leaseWinner(doc, 'page:a', later(10).getTime()) !== device) return doc;
      return Automerge.change(doc, (draft) => {
        const list = draft.sections[0].pageDocumentIds;
        list.splice(list.indexOf('page:a'), 1, nextGenerationDocumentId('page:a'));
        draft[`swap:${nextGenerationDocumentId('page:a')}`] = 'page:a';
        releaseChange('page:a')(draft as never);
      });
    };
    const afterA = swapIfWinner(merged, 'device-a');
    const afterB = swapIfWinner(merged, 'device-b');
    expect(afterA).toBe(merged);
    expect([...afterB.sections[0].pageDocumentIds]).toEqual(['page:a~r1', 'page:b']);
    expect(swappedDocuments(afterB)).toEqual([{ replacement: 'page:a~r1', replaced: 'page:a' }]);
    expect(activeClaims(afterB, 'page:a', later(10).getTime())).toEqual([]);
  });

  it('counts generations of a rebuilt document', () => {
    expect(nextGenerationDocumentId('page:x')).toBe('page:x~r1');
    expect(nextGenerationDocumentId('page:x~r1')).toBe('page:x~r2');
    expect(nextGenerationDocumentId('migrated:page:y~r9')).toBe('migrated:page:y~r10');
  });
});
