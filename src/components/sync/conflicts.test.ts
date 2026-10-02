import * as Automerge from '@automerge/automerge';
import { describe, expect, it } from 'vitest';
import { enumerateAutomergeConflicts, mayHaveConflicts } from './conflicts';

describe('enumerateAutomergeConflicts', () => {
  it('reports concurrent field alternatives for a visible conflict badge', () => {
    const base = Automerge.from({ title: 'Chemie', nested: { note: 'Start' } });
    const left = Automerge.change(Automerge.clone(base), (document) => { document.nested.note = 'Ada'; });
    const right = Automerge.change(Automerge.clone(base), (document) => { document.nested.note = 'Vera'; });
    const merged = Automerge.merge(left, right);
    expect(enumerateAutomergeConflicts(merged)).toEqual([{ path: '$.nested.note', alternatives: 2 }]);
  });

  it('walks Automerge lists with numeric indexes instead of invalid map operations', () => {
    const document = Automerge.from({
      sections: [{ id: 'section-1', pageDocumentIds: ['page:one'] }],
      zOrder: ['rich-text-1'],
    });

    expect(() => enumerateAutomergeConflicts(document)).not.toThrow();
    expect(enumerateAutomergeConflicts(document)).toEqual([]);
  });

  it('still reports a concurrently replaced ink point list without walking every point', () => {
    const base = Automerge.from({ elementsById: { ink: { points: [{ x: 1, y: 1 }, { x: 2, y: 2 }] } } });
    const left = Automerge.change(Automerge.clone(base), (document) => {
      document.elementsById.ink.points = [{ x: 5, y: 5 }];
    });
    const right = Automerge.change(Automerge.clone(base), (document) => {
      document.elementsById.ink.points = [{ x: 9, y: 9 }];
    });
    expect(enumerateAutomergeConflicts(Automerge.merge(left, right)))
      .toEqual([{ path: '$.elementsById.ink.points', alternatives: 2 }]);
  });
});

describe('mayHaveConflicts', () => {
  it('is false for a history in which every change follows the one before', () => {
    let document = Automerge.from({ title: 'Chemie', nested: { note: 'Start' } });
    document = Automerge.change(document, (draft) => { draft.nested.note = 'Ada'; });
    document = Automerge.change(document, (draft) => { draft.title = 'Physik'; });
    // Reloading gives the next session its own actor; the history stays linear.
    document = Automerge.change(Automerge.load<typeof document>(Automerge.save(document)), (draft) => { draft.nested.note = 'Vera'; });
    expect(mayHaveConflicts(document)).toBe(false);
    expect(enumerateAutomergeConflicts(document)).toEqual([]);
  });

  it('is true while branches are unmerged and after they are merged by a further change', () => {
    const base = Automerge.from({ nested: { note: 'Start' } });
    const left = Automerge.change(Automerge.clone(base), (draft) => { draft.nested.note = 'Ada'; });
    const right = Automerge.change(Automerge.clone(base), (draft) => { draft.nested.note = 'Vera'; });
    const merged = Automerge.merge(left, right);
    expect(mayHaveConflicts(merged)).toBe(true);
    const resolved = Automerge.change(merged, (draft) => { draft.nested.note = 'Ada'; });
    expect(Automerge.getHeads(resolved)).toHaveLength(1);
    expect(mayHaveConflicts(resolved)).toBe(true);
  });
});
