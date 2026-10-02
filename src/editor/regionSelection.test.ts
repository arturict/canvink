import { describe, expect, it } from 'vitest';
import type { StrokeElementV2 } from '../domain/v2';
import type { PageElementV3 } from '../domain/v3';
import { selectByLasso } from './inkGeometry';
import { elementIdsInRegion, isUsableRegion, rectBetween, selectByRect } from './regionSelection';

const TIME = '2026-09-24T00:00:00.000Z';

function stroke(id: string, points: Array<[number, number]>, extra: Partial<StrokeElementV2> = {}): StrokeElementV2 {
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  return {
    id, kind: 'stroke', createdAt: TIME, updatedAt: TIME, locked: false, tool: 'pen', color: '#000', size: 3, opacity: 1,
    frame: { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys), rotation: 0 },
    points: points.map(([x, y], time) => ({ x, y, pressure: 0.5, tiltX: 0, tiltY: 0, time, pointerType: 'pen' })),
    ...extra,
  };
}

function text(id: string, x: number, y: number, width: number, height: number): PageElementV3 {
  return {
    id, kind: 'richText', frame: { x, y, width, height, rotation: 0 }, createdAt: TIME, updatedAt: TIME, locked: false,
    content: { type: 'doc', blocks: [] },
    style: { color: '#000', fontFamily: 'sans', fontSize: 16, textAlign: 'left' },
  };
}

function image(id: string, x: number, y: number, width: number, height: number): PageElementV3 {
  return {
    id, kind: 'image', frame: { x, y, width, height, rotation: 0 }, createdAt: TIME, updatedAt: TIME, locked: false,
    asset: { assetId: `sha256:${'b'.repeat(64)}`, mimeType: 'image/png', byteLength: 1 }, alt: 'x',
  } as unknown as PageElementV3;
}

describe('lasso hit-testing of strokes and elements', () => {
  // A hand-drawn loop (not a rectangle) around the left part of the page.
  const loop = [
    { x: 0, y: 50 }, { x: 40, y: 0 }, { x: 120, y: 10 }, { x: 150, y: 60 },
    { x: 110, y: 120 }, { x: 30, y: 110 },
  ];

  it('takes ink and boxes inside the loop, leaves the rest, skips erased ink', () => {
    const elements = {
      word: stroke('word', [[40, 40], [70, 60], [100, 50]]),
      outside: stroke('outside', [[300, 40], [330, 60]]),
      erased: stroke('erased', [[50, 50], [60, 60]], { tombstonedAt: TIME }),
      note: text('note', 50, 70, 40, 20),
      farNote: text('farNote', 400, 400, 40, 20),
    };
    expect(selectByLasso(elements, loop)).toEqual(['note', 'word']);
  });

  it('takes an image only when the whole image is circled', () => {
    const elements = { small: image('small', 40, 30, 50, 40), large: image('large', 40, 30, 300, 40) };
    expect(selectByLasso(elements, loop)).toEqual(['small']);
  });

  it('selects nothing for a scribble that is too short to be a loop', () => {
    expect(selectByLasso({ word: stroke('word', [[1, 1], [2, 2]]) }, [{ x: 0, y: 0 }, { x: 10, y: 10 }])).toEqual([]);
  });
});

describe('rectangle selection and region capture', () => {
  it('builds the rectangle from either drag direction', () => {
    expect(rectBetween({ x: 100, y: 80 }, { x: 20, y: 30 })).toEqual({ x: 20, y: 30, width: 80, height: 50 });
    expect(isUsableRegion({ x: 0, y: 0, width: 2, height: 90 })).toBe(false);
    expect(isUsableRegion({ x: 0, y: 0, width: 40, height: 40 })).toBe(true);
  });

  it('selects like a lasso around the same rectangle and ignores a tap', () => {
    const elements = {
      inside: stroke('inside', [[10, 10], [30, 30]]),
      outside: stroke('outside', [[200, 200], [220, 220]]),
      note: text('note', 20, 20, 30, 10),
    };
    expect(selectByRect(elements, { x: 0, y: 0, width: 100, height: 100 })).toEqual(['inside', 'note']);
    expect(selectByRect(elements, { x: 10, y: 10, width: 1, height: 1 })).toEqual([]);
  });

  it('captures every live element that touches the region, in page order, locked ones included', () => {
    const elements = {
      paper: { ...image('paper', 0, 0, 800, 1000), locked: true },
      near: stroke('near', [[90, 40], [140, 40]]),
      far: stroke('far', [[500, 500], [520, 520]]),
      erased: stroke('erased', [[50, 50], [60, 60]], { tombstonedAt: TIME }),
    };
    expect(elementIdsInRegion(elements, ['paper', 'near', 'far', 'erased', 'gone'], { x: 0, y: 0, width: 100, height: 100 }))
      .toEqual(['paper', 'near']);
  });
});
