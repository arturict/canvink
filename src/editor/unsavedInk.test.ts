import { beforeEach, describe, expect, it } from 'vitest';
import type { StrokeElementV2 } from '../domain/v2';
import { stashUnsavedInk, takeUnsavedInk } from './unsavedInk';

function stroke(id: string): StrokeElementV2 {
  return {
    id, kind: 'stroke', frame: { x: 0, y: 0, width: 1, height: 1, rotation: 0 }, createdAt: '', updatedAt: '', locked: false,
    tool: 'pen', points: [{ x: 1, y: 2, pressure: 0.5, tiltX: 0, tiltY: 0, time: 1, pointerType: 'pen' }], color: '#000', size: 3, opacity: 1,
  };
}

describe('unsaved ink', () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
        removeItem: (key: string) => void store.delete(key),
      },
    });
  });

  it("hands the strokes of a page back once, and only that page's", () => {
    stashUnsavedInk('page-a', [stroke('s1'), stroke('s2')]);
    stashUnsavedInk('page-b', [stroke('s3')]);
    expect(takeUnsavedInk('page-a').map((item) => item.id)).toEqual(['s1', 's2']);
    expect(takeUnsavedInk('page-a')).toEqual([]);
    expect(takeUnsavedInk('page-b').map((item) => item.id)).toEqual(['s3']);
  });

  it('ignores damaged records', () => {
    store.set('canvink:unsaved-ink:page-a', '{not json');
    expect(takeUnsavedInk('page-a')).toEqual([]);
    store.set('canvink:unsaved-ink:page-a', JSON.stringify([{ kind: 'text' }, 5]));
    expect(takeUnsavedInk('page-a')).toEqual([]);
  });
});
