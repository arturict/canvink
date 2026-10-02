import { describe, expect, it } from 'vitest';
import type { StrokeElementV2 } from '../domain/v2';
import type { PageElementV3 } from '../domain/v3';
import { buildPageLayers } from './InkLayers';
import {
  selectByLasso,
  strokeCrossedBy,
  strokeHitAt,
  strokesCrossedBy,
  topmostStrokeAt,
} from './inkGeometry';

const TIME = '2026-09-24T00:00:00.000Z';

function stroke(id: string, points: Array<[number, number]>, size = 3): StrokeElementV2 {
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  return {
    id, kind: 'stroke', createdAt: TIME, updatedAt: TIME, locked: false, tool: 'pen', color: '#000', size, opacity: 1,
    frame: { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys), rotation: 0 },
    points: points.map(([x, y], time) => ({ x, y, pressure: 0.5, tiltX: 0, tiltY: 0, time, pointerType: 'pen' })),
  };
}

function box(id: string, kind: 'richText' | 'pdf', x: number, y: number, width: number, height: number, locked = false): PageElementV3 {
  const base = { id, frame: { x, y, width, height, rotation: 0 }, createdAt: TIME, updatedAt: TIME, locked };
  return kind === 'richText'
    ? { ...base, kind, content: { type: 'doc', blocks: [] }, style: { color: '#000', fontFamily: 'sans', fontSize: 16, textAlign: 'left' } }
    : {
        ...base, kind, pageCount: 1, sourcePageNumber: 1,
        previewAsset: { assetId: `sha256:${'a'.repeat(64)}`, mimeType: 'image/png', byteLength: 1 },
      } as unknown as PageElementV3;
}

describe('ink geometry without DOM hit targets', () => {
  it('hits a stroke on its ink, not anywhere inside its bounding box', () => {
    // An "L": the corner of its bounding box far from the ink is empty paper.
    const corner = stroke('l', [[0, 0], [0, 100], [100, 100]]);

    expect(strokeHitAt(corner, { x: 1, y: 50 }, 2)).toBe(true);
    expect(strokeHitAt(corner, { x: 60, y: 99 }, 2)).toBe(true);
    expect(strokeHitAt(corner, { x: 80, y: 20 }, 2)).toBe(false);
  });

  it('counts the drawn width: a thick stroke is hit farther from its centre line', () => {
    const thin = stroke('thin', [[0, 0], [100, 0]], 2);
    const thick = stroke('thick', [[0, 0], [100, 0]], 20);

    expect(strokeHitAt(thin, { x: 50, y: 8 }, 1)).toBe(false);
    expect(strokeHitAt(thick, { x: 50, y: 8 }, 1)).toBe(true);
  });

  it('finds the topmost stroke but not ink hidden below a text box that was hit', () => {
    const elements = {
      below: stroke('below', [[0, 10], [100, 10]]),
      text: box('text', 'richText', 0, 0, 100, 40),
      above: stroke('above', [[0, 30], [100, 30]]),
      top: stroke('top', [[0, 10], [100, 12]]),
    };
    const order = ['below', 'text', 'above', 'top'];

    expect(topmostStrokeAt(elements, order, { x: 50, y: 11 }, 3)).toBe('top');
    expect(topmostStrokeAt(elements, order, { x: 50, y: 30 }, 3, order.indexOf('text'))).toBe('above');
    expect(topmostStrokeAt({ ...elements, top: { ...elements.top, tombstonedAt: TIME } }, order, { x: 50, y: 10 }, 3, 1))
      .toBeUndefined();
  });

  it('erases every stroke a fast swipe crosses between two pointer samples', () => {
    const elements = {
      a: stroke('a', [[10, 0], [10, 100]]),
      b: stroke('b', [[40, 0], [40, 100]]),
      c: stroke('c', [[70, 0], [70, 100]]),
      locked: { ...stroke('locked', [[55, 0], [55, 100]]), locked: true },
      far: stroke('far', [[10, 300], [90, 300]]),
    };

    expect(strokesCrossedBy(elements, { x: 0, y: 50 }, { x: 80, y: 50 }, 4).sort()).toEqual(['a', 'b', 'c']);
  });

  it('lassos the strokes mostly inside the loop and leaves placed printouts alone', () => {
    const loop = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
    const elements = {
      inside: stroke('inside', [[10, 10], [50, 50], [90, 90]]),
      poking: stroke('poking', [[20, 50], [60, 50], [80, 50], [120, 50]]),
      crossing: stroke('crossing', [[90, 50], [150, 50], [200, 50], [250, 50]]),
      worksheet: box('worksheet', 'pdf', -50, -50, 400, 400),
      lockedPrintout: box('lockedPrintout', 'pdf', 10, 10, 30, 30, true),
      note: box('note', 'richText', 30, 30, 40, 20),
    };

    expect(selectByLasso(elements, loop)).toEqual(['inside', 'note', 'poking']);
  });

  it('groups consecutive strokes into one ink layer between DOM elements, keeping z-order', () => {
    const elements = {
      pdf: box('pdf', 'pdf', 0, 0, 100, 100),
      s1: stroke('s1', [[0, 0], [1, 1]]),
      s2: stroke('s2', [[0, 0], [1, 1]]),
      text: box('text', 'richText', 0, 0, 10, 10),
      s3: { ...stroke('s3', [[0, 0], [1, 1]]), tool: 'highlighter' as const },
      erased: { ...stroke('erased', [[0, 0], [1, 1]]), tombstonedAt: TIME },
    };

    const layers = buildPageLayers(['pdf', 's1', 's2', 'text', 's3', 'erased'], elements);

    expect(layers.map((layer) => layer.kind === 'ink'
      ? `ink(${layer.strokes.map((item) => item.id).join(',')})@${layer.zIndex}${layer.highlighter ? '*' : ''}`
      : `${layer.id}@${layer.zIndex}`)).toEqual(['pdf@1', 'ink(s1,s2)@2', 'text@4', 'ink(s3)@5*']);
  });

  it('finds the same strokes through the grid as by testing every stroke', () => {
    // A tiny deterministic generator: short words, thick marker lines and
    // page-wide rules that are too large for the grid's cells.
    let seed = 7;
    const random = () => {
      seed = (seed * 1_664_525 + 1_013_904_223) % 4_294_967_296;
      return seed / 4_294_967_296;
    };
    const elements: Record<string, PageElementV3> = {};
    for (let index = 0; index < 600; index += 1) {
      const x = random() * 2_000 - 200;
      const y = random() * 2_000 - 200;
      const wide = index % 50 === 0;
      const points: Array<[number, number]> = wide
        ? [[x, y], [x + 3_000, y + 40]]
        : Array.from({ length: 6 }, (_, step) => [x + step * 3, y + random() * 8] as [number, number]);
      elements[`s${index}`] = { ...stroke(`s${index}`, points, index % 7 === 0 ? 18 : 2), locked: index % 11 === 0 };
    }
    elements.erased = { ...stroke('erased', [[500, 500], [520, 520]]), tombstonedAt: TIME };

    for (let sweep = 0; sweep < 40; sweep += 1) {
      const start = { x: random() * 2_000 - 200, y: random() * 2_000 - 200 };
      const end = { x: start.x + random() * 200 - 100, y: start.y + random() * 200 - 100 };
      const expected = Object.values(elements)
        .filter((element): element is StrokeElementV2 => element.kind === 'stroke'
          && !element.tombstonedAt && !element.locked && strokeCrossedBy(element, start, end, 6))
        .map((element) => element.id);

      expect(strokesCrossedBy(elements, start, end, 6)).toEqual(expected);
    }
  });
});
