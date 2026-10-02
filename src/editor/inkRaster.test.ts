import { describe, expect, it } from 'vitest';
import {
  INK_RASTER_MAX_SIDE,
  inkFingerprint,
  inkRasterRegion,
  inkRasterScale,
  measureInkRasterFrame,
} from './inkRaster';
import { inkRasterPlacement } from './inkRasterDisplay';
import { stroke } from './operations/testFixtures';

const line = (id: string, x: number, y: number, length = 40, size = 2) => stroke({
  id,
  size,
  points: [0, length].map((dx, index) => ({ x: x + dx, y, pressure: 0.5, tiltX: 0, tiltY: 0, time: index, pointerType: 'mouse' })),
});

describe('ink raster region', () => {
  const visible = { x: 0, y: 0, width: 1000, height: 700 };

  it('covers the ink that shows when the page opens, grown by the pen width', () => {
    const region = inkRasterRegion([line('a', 100, 100), line('b', 300, 400, 40, 6)], visible);
    expect(region?.strokes.map((entry) => entry.id)).toEqual(['a', 'b']);
    // 100 - (2/2 + 1) = 98 on the left; 340 + (6/2 + 1) = 344 on the right.
    expect(region?.bounds).toEqual({ x: 98, y: 98, width: 246, height: 306 });
  });

  it('leaves out ink below the opening view and cuts ink that crosses its edge', () => {
    const region = inkRasterRegion([line('a', 100, 100), line('far', 100, 2000), line('edge', 980, 300, 100)], visible);
    expect(region?.strokes.map((entry) => entry.id)).toEqual(['a', 'edge']);
    expect(region!.bounds.x + region!.bounds.width).toBe(1000);
  });

  it('has nothing to draw on a page without ink in view', () => {
    expect(inkRasterRegion([], visible)).toBeNull();
    expect(inkRasterRegion([line('far', 100, 2000)], visible)).toBeNull();
  });
});

describe('ink raster scale', () => {
  it('follows the screen density up to twice', () => {
    expect(inkRasterScale({ x: 0, y: 0, width: 400, height: 300 }, 1)).toBe(1);
    expect(inkRasterScale({ x: 0, y: 0, width: 400, height: 300 }, 1.5)).toBe(1.5);
    expect(inkRasterScale({ x: 0, y: 0, width: 400, height: 300 }, 3)).toBe(2);
  });

  it('keeps the long side within the cap', () => {
    const scale = inkRasterScale({ x: 0, y: 0, width: 1200, height: 700 }, 2);
    expect(1200 * scale).toBeLessThanOrEqual(INK_RASTER_MAX_SIDE);
  });
});

describe('ink raster placement', () => {
  const record = {
    origin: { x: 280, y: 190 },
    bounds: { x: 98, y: 50, width: 300, height: 200 },
    view: { x: 256, y: 166, width: 1184, height: 734 },
    paper: { x: 256, y: 166, width: 1184, height: 734, color: '#fff' },
  };

  it('puts the picture where the page shows its ink, relative to the page area', () => {
    const placement = inkRasterPlacement(record, { left: 256, top: 60 });
    expect(placement.box).toEqual({ x: 0, y: 106, width: 1184, height: 734 });
    expect(placement.paper).toEqual({ x: 0, y: 0, width: 1184, height: 734 });
    // Page origin 24 px into the viewport, plus the ink's page position.
    expect(placement.ink).toEqual({ x: 24 + 98, y: 24 + 50, width: 300, height: 200 });
  });

  it('uses window coordinates on the startup screen', () => {
    const placement = inkRasterPlacement(record, { left: 0, top: 0 });
    expect(placement.box.x + placement.ink.x).toBe(280 + 98);
    expect(placement.box.y + placement.ink.y).toBe(190 + 50);
  });
});

describe('ink raster frame', () => {
  const element = (left: number, top: number, width: number, height: number) =>
    ({ getBoundingClientRect: () => ({ left, top, width, height }) }) as unknown as HTMLElement;

  it('measures the opening position of a panned page', () => {
    // The surface was panned 300 px up; the page opens at its top again.
    const frame = measureInkRasterFrame({
      viewport: element(256, 166, 1184, 734),
      surface: element(280, 190 - 300, 900, 3000),
      current: { panX: 0, panY: -300 },
      opening: { panX: 0, panY: 0 },
      sheet: null,
      paperColor: '#fdfdf8',
    });
    expect(frame?.origin).toEqual({ x: 280, y: 190 });
    expect(frame?.visible).toEqual({ x: -24, y: -24, width: 1184, height: 734 });
    expect(frame?.paper).toEqual({ x: 256, y: 166, width: 1184, height: 734, color: '#fdfdf8' });
  });

  it('clips a fixed sheet to the viewport', () => {
    const frame = measureInkRasterFrame({
      viewport: element(0, 100, 1000, 600),
      surface: element(24, 124, 794, 1123),
      current: { panX: 0, panY: 0 },
      opening: { panX: 0, panY: 0 },
      sheet: { width: 794, height: 1123 },
      paperColor: '#ffffff',
    });
    expect(frame?.paper).toEqual({ x: 24, y: 124, width: 794, height: 576, color: '#ffffff' });
  });

  it('has no frame before the editor is laid out', () => {
    expect(measureInkRasterFrame({
      viewport: element(0, 0, 0, 0),
      surface: element(0, 0, 0, 0),
      current: { panX: 0, panY: 0 },
      opening: { panX: 0, panY: 0 },
      sheet: null,
      paperColor: '#fff',
    })).toBeNull();
  });
});

describe('ink fingerprint', () => {
  it('changes when ink is added, moved or recoloured', () => {
    const base = [line('a', 0, 0), line('b', 10, 10)];
    const same = inkFingerprint([line('a', 0, 0), line('b', 10, 10)]);
    expect(inkFingerprint(base)).toBe(same);
    expect(inkFingerprint([...base, line('c', 5, 5)])).not.toBe(same);
    expect(inkFingerprint([line('a', 0, 0), line('b', 11, 10)])).not.toBe(same);
    expect(inkFingerprint([line('a', 0, 0), { ...line('b', 10, 10), color: '#ff0000' }])).not.toBe(same);
  });
});
