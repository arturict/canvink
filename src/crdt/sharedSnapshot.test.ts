import * as Automerge from '@automerge/automerge';
import { describe, expect, it } from 'vitest';
import { sharedPlainSnapshot } from './sharedSnapshot';

type Fixture = {
  elementsById: Record<string, { frame: { x: number }; points: Array<{ x: number }> }>;
  zOrder: string[];
};

describe('shared Automerge snapshots', () => {
  it('matches a full materialisation and reuses every element a change did not touch', () => {
    const initial = Automerge.from<Fixture>({
      elementsById: {
        a: { frame: { x: 1 }, points: [{ x: 1 }, { x: 2 }] },
        b: { frame: { x: 2 }, points: [{ x: 3 }] },
      },
      zOrder: ['a', 'b'],
    });
    const first = sharedPlainSnapshot(initial);
    const changed = Automerge.change(initial, (draft) => {
      draft.elementsById.a.points[1].x = 9;
      draft.elementsById.c = { frame: { x: 3 }, points: [] };
      draft.zOrder.push('c');
    });

    const second = sharedPlainSnapshot(changed);

    expect(second).toEqual(Automerge.toJS(changed));
    expect(second.elementsById.b).toBe(first.elementsById.b);
    expect(second.elementsById.a).not.toBe(first.elementsById.a);
    expect(second.elementsById.a.points[0]).toBe(first.elementsById.a.points[0]);
    expect(first.elementsById.a.points[1].x).toBe(2);
  });

  it('freezes what it shares so one consumer cannot change another consumer’s page', () => {
    const snapshot = sharedPlainSnapshot(Automerge.from<Fixture>({
      elementsById: { a: { frame: { x: 1 }, points: [] } },
      zOrder: ['a'],
    }));

    expect(Object.isFrozen(snapshot.elementsById.a.frame)).toBe(true);
    expect(() => { snapshot.elementsById.a.frame.x = 5; }).toThrow(TypeError);
    expect(structuredClone(snapshot).elementsById.a.frame.x).toBe(1);
  });
});
