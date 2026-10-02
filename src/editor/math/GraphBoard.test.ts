import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { GraphBoard, createViewportCommitter, validateGraphSeries, validateGraphViewport } from './GraphBoard';
import {
  createJsxGraphFactory,
  type JsxGraphBoard,
  type JsxGraphCurve,
  type JsxGraphNamespace,
} from './jsxGraphAdapter';

describe('GraphBoard validation', () => {
  it('copies finite numeric points and rejects executable-looking colors', () => {
    const result = validateGraphSeries([{
      id: 'f',
      color: '#1769aa',
      visible: true,
      points: [{ x: 0, y: 1 }, { x: 1, y: 2 }],
    }]);
    expect(result[0]?.points).toEqual([{ x: 0, y: 1 }, { x: 1, y: 2 }]);
    expect(() => validateGraphSeries([{
      id: 'bad', color: 'url(javascript:alert(1))', visible: true, points: [],
    }])).toThrow(/colors/);
    expect(() => validateGraphSeries([{
      id: 'nan', color: '#000', visible: true, points: [{ x: Number.NaN, y: 0 }],
    }])).toThrow(/finite/);
  });

  it('requires increasing finite viewport bounds', () => {
    expect(validateGraphViewport({ xMin: -1, xMax: 1, yMin: -2, yMax: 2 })).toEqual({
      xMin: -1, xMax: 1, yMin: -2, yMax: 2,
    });
    expect(() => validateGraphViewport({ xMin: 1, xMax: 1, yMin: -2, yMax: 2 })).toThrow();
  });

  it('keeps coordinate accessibility on a wrapper JSXGraph does not own', () => {
    const markup = renderToStaticMarkup(createElement(GraphBoard, {
      factory: { create: () => { throw new Error('effects do not run during SSR'); } },
      series: [], viewport: { xMin: -1, xMax: 1, yMin: -1, yMax: 1 }, equalScale: true,
      axesVisible: false, gridVisible: true,
      labels: { graph: 'Graph', reset: 'Reset', equalScale: 'Equal', axesVisible: 'Axes', gridVisible: 'Grid', visible: 'visible', coordinate: 'Inspect coordinates' },
    }));
    expect(markup).toContain('class="graph-board__surface-frame" role="img" aria-label="Inspect coordinates"');
    expect(markup).toContain('class="graph-board__surface" aria-hidden="true"');
  });
});

describe('viewport persistence', () => {
  it('debounces pan/zoom into one bundled viewport commit and can flush', () => {
    const timers = new Map<number, () => void>();
    const committed: unknown[] = [];
    let nextTimer = 1;
    const committer = createViewportCommitter(
      (viewport) => committed.push(viewport),
      (callback) => { const id = nextTimer++; timers.set(id, callback); return id; },
      (id) => { timers.delete(id); },
    );
    committer.schedule({ xMin: -1, xMax: 1, yMin: -1, yMax: 1 });
    committer.schedule({ xMin: -2, xMax: 2, yMin: -3, yMax: 3 });
    expect(timers.size).toBe(1);
    committer.flush();
    expect(committed).toEqual([{ xMin: -2, xMax: 2, yMin: -3, yMax: 3 }]);
    expect(timers.size).toBe(0);
  });
});

describe('JSXGraph numeric adapter', () => {
  it('creates only numeric curve arrays, updates, resets, inspects and disposes', () => {
    const parents: Array<readonly [readonly number[], readonly number[]]> = [];
    const callbacks = new Map<string, (event: unknown) => void>();
    const curve = { setAttribute: vi.fn() } satisfies JsxGraphCurve;
    const board: JsxGraphBoard = {
      create: vi.fn((_kind, values) => { parents.push(values); return curve; }),
      removeObject: vi.fn(),
      setBoundingBox: vi.fn(),
      resizeContainer: vi.fn(),
      fullUpdate: vi.fn(),
      on: vi.fn((event, callback) => { callbacks.set(event, callback); }),
      off: vi.fn(),
      getUsrCoordsOfMouse: vi.fn(() => [2, 3] as const),
      getBoundingBox: vi.fn(() => [-6, 5, 6, -5] as const),
    };
    const namespace: JsxGraphNamespace = {
      JSXGraph: { initBoard: vi.fn(() => board), freeBoard: vi.fn() },
    };
    const inspected: Array<{ x: number; y: number }> = [];
    const controller = createJsxGraphFactory(namespace).create({} as HTMLElement, {
      series: [{ id: 'f', color: '#123456', visible: true, points: [{ x: 1, y: 4 }] }],
      viewport: { xMin: -5, xMax: 5, yMin: -4, yMax: 4 },
      equalScale: true,
      axesVisible: false,
      gridVisible: true,
      interactive: true,
      onCoordinateInspect: (point) => inspected.push(point),
    });

    expect(parents).toEqual([[[1], [4]]]);
    expect(namespace.JSXGraph.initBoard).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ axis: false, grid: true, resize: { enabled: false } }),
    );
    expect(parents.flat(2).every((value) => typeof value === 'number')).toBe(true);
    callbacks.get('down')?.({});
    expect(inspected).toEqual([{ x: 2, y: 3 }]);
    callbacks.get('boundingbox')?.({});
    controller.update([{ id: 'g', color: '#abc', visible: false, points: [{ x: 2, y: 8 }] }]);
    expect(board.removeObject).toHaveBeenCalledOnce();
    expect(parents[1]).toEqual([[2], [8]]);
    controller.reset();
    expect(board.setBoundingBox).toHaveBeenCalledWith([-5, 4, 5, -4], true);
    controller.resize(Number.NaN, 100);
    controller.resize(0, 100);
    expect(board.resizeContainer).not.toHaveBeenCalled();
    controller.resize(640, 360);
    expect(board.resizeContainer).toHaveBeenCalledOnce();
    expect(board.resizeContainer).toHaveBeenCalledWith(640, 360);
    controller.dispose();
    controller.dispose();
    expect(namespace.JSXGraph.freeBoard).toHaveBeenCalledWith(board);
    expect(namespace.JSXGraph.freeBoard).toHaveBeenCalledOnce();
  });

  it('reports pan and zoom but not the bounds JSXGraph emits for a resize or reset', () => {
    const callbacks = new Map<string, (event: unknown) => void>();
    const notify = () => callbacks.get('boundingbox')?.({});
    const board: JsxGraphBoard = {
      create: vi.fn(() => ({ setAttribute: vi.fn() })),
      removeObject: vi.fn(),
      setBoundingBox: vi.fn(notify),
      resizeContainer: vi.fn(notify),
      fullUpdate: vi.fn(),
      on: vi.fn((event, callback) => { callbacks.set(event, callback); }),
      off: vi.fn(),
      getBoundingBox: vi.fn(() => [-6, 5, 6, -5] as const),
    };
    const namespace: JsxGraphNamespace = {
      JSXGraph: { initBoard: vi.fn(() => board), freeBoard: vi.fn() },
    };
    const reported: unknown[] = [];
    const controller = createJsxGraphFactory(namespace).create({} as HTMLElement, {
      series: [], viewport: { xMin: -5, xMax: 5, yMin: -4, yMax: 4 },
      equalScale: true, axesVisible: true, gridVisible: true, interactive: true,
      onViewportChange: (viewport) => reported.push(viewport),
    });
    controller.resize(640, 360);
    controller.reset();
    expect(reported).toEqual([]);
    notify();
    expect(reported).toEqual([{ xMin: -6, yMax: 5, xMax: 6, yMin: -5 }]);
  });

  it('does not free a board whose JSXGraph lifecycle was already retired', () => {
    const board = {
      create: vi.fn(), removeObject: vi.fn(), setBoundingBox: vi.fn(), jc: null,
    } as unknown as JsxGraphBoard;
    const namespace: JsxGraphNamespace = {
      JSXGraph: { initBoard: vi.fn(() => board), freeBoard: vi.fn() },
    };
    const controller = createJsxGraphFactory(namespace).create({} as HTMLElement, {
      series: [], viewport: { xMin: -1, xMax: 1, yMin: -1, yMax: 1 },
      equalScale: true, axesVisible: true, gridVisible: true, interactive: true,
    });
    controller.dispose();
    expect(namespace.JSXGraph.freeBoard).not.toHaveBeenCalled();
  });

  it('contains the known JSXGraph partial-free failure during cleanup', () => {
    const board = {
      create: vi.fn(), removeObject: vi.fn(), setBoundingBox: vi.fn(), jc: {},
    } as unknown as JsxGraphBoard;
    const freeBoard = vi.fn(() => {
      board.jc = null;
      throw new TypeError("Cannot read properties of null (reading 'creator')");
    });
    const namespace: JsxGraphNamespace = { JSXGraph: { initBoard: vi.fn(() => board), freeBoard } };
    const controller = createJsxGraphFactory(namespace).create({} as HTMLElement, {
      series: [], viewport: { xMin: -1, xMax: 1, yMin: -1, yMax: 1 },
      equalScale: true, axesVisible: true, gridVisible: true, interactive: true,
    });
    expect(() => controller.dispose()).not.toThrow();
    expect(() => controller.dispose()).not.toThrow();
    expect(freeBoard).toHaveBeenCalledOnce();
  });
});
