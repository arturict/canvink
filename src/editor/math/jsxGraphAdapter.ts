import type {
  GraphBoardController,
  GraphBoardFactory,
  GraphPoint,
  GraphSeries,
  GraphViewport,
} from './GraphBoard';

/**
 * Security/CSP boundary for JSXGraph.
 *
 * The upstream bundle contains an optional JessieCode parser with `eval`, so
 * bundlers report it even though this adapter never calls that parser. Keep
 * this port numeric-only: the only created object is `curve`, whose parents
 * are copied number arrays validated by GraphBoard. Do not add functiongraph,
 * text expressions, JessieCode, string parsers, or executable callbacks from
 * persisted/user formula data. A strict CSP can therefore leave unsafe-eval
 * disabled; attempting to use the unused upstream parser must remain blocked.
 */

export interface JsxGraphCurve {
  setAttribute(attributes: Record<string, unknown>): void;
}

export interface JsxGraphBoard {
  create(kind: 'curve', parents: readonly [readonly number[], readonly number[]], attributes: Record<string, unknown>): JsxGraphCurve;
  removeObject(object: JsxGraphCurve): void;
  setBoundingBox(bounds: readonly [number, number, number, number], keepAspectRatio?: boolean): void;
  resizeContainer?(width: number, height: number): void;
  fullUpdate?(): void;
  on?(event: 'down' | 'boundingbox', callback: (event: unknown) => void): void;
  off?(event: 'down' | 'boundingbox', callback: (event: unknown) => void): void;
  getUsrCoordsOfMouse?(event: unknown): readonly [number, number];
  getBoundingBox?(): readonly [number, number, number, number];
  /** JSXGraph clears this internal lifecycle object when a board is freed. */
  jc?: unknown | null;
}

export interface JsxGraphNamespace {
  JSXGraph: {
    initBoard(container: HTMLElement, options: Record<string, unknown>): JsxGraphBoard;
    freeBoard(board: JsxGraphBoard): void;
  };
}

function boundingBox(viewport: GraphViewport): readonly [number, number, number, number] {
  return [viewport.xMin, viewport.yMax, viewport.xMax, viewport.yMin];
}

function drawSeries(board: JsxGraphBoard, series: readonly GraphSeries[]): JsxGraphCurve[] {
  return series.map((item) => board.create(
    'curve',
    [item.points.map((point) => point.x), item.points.map((point) => point.y)],
    {
      name: item.id,
      strokeColor: item.color,
      visible: item.visible,
      fixed: true,
      highlight: false,
    },
  ));
}

export function createJsxGraphFactory(namespace: JsxGraphNamespace): GraphBoardFactory {
  return {
    create(container, options): GraphBoardController {
      const board = namespace.JSXGraph.initBoard(container, {
        axis: options.axesVisible,
        grid: options.gridVisible,
        boundingbox: boundingBox(options.viewport),
        keepAspectRatio: options.equalScale,
        pan: { enabled: options.interactive },
        zoom: { enabled: options.interactive, wheel: options.interactive },
        showNavigation: options.interactive,
        showCopyright: false,
        // JSXGraph's delayed observer can run after freeBoard() and access its
        // cleared renderer. GraphBoard owns the only guarded ResizeObserver.
        resize: { enabled: false },
      });
      let curves = drawSeries(board, options.series);
      const inspect = (event: unknown) => {
        const coords = board.getUsrCoordsOfMouse?.(event);
        if (coords && Number.isFinite(coords[0]) && Number.isFinite(coords[1])) {
          options.onCoordinateInspect?.({ x: coords[0], y: coords[1] });
        }
      };
      // JSXGraph emits `boundingbox` for every change of the visible area,
      // including the ones this adapter causes itself by resizing the
      // container or resetting the view. Only the user's pan and zoom belong
      // in the document (and its undo history); layout-driven changes would
      // otherwise stack up as commands the user never made.
      let programmatic = false;
      const withoutReporting = (action: () => void) => {
        programmatic = true;
        try {
          action();
        } finally {
          programmatic = false;
        }
      };
      const viewportChanged = () => {
        if (programmatic) return;
        const bounds = board.getBoundingBox?.();
        if (!bounds || !bounds.every(Number.isFinite)) return;
        options.onViewportChange?.({
          xMin: bounds[0],
          yMax: bounds[1],
          xMax: bounds[2],
          yMin: bounds[3],
        });
      };
      board.on?.('down', inspect);
      board.on?.('boundingbox', viewportChanged);
      let disposed = false;
      return {
        update(series) {
          for (const curve of curves) board.removeObject(curve);
          curves = drawSeries(board, series);
          board.fullUpdate?.();
        },
        reset(viewport = options.viewport) {
          withoutReporting(() => {
            board.setBoundingBox(boundingBox(viewport), options.equalScale);
            board.fullUpdate?.();
          });
        },
        resize(width, height) {
          if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
          withoutReporting(() => {
            board.resizeContainer?.(width, height);
            board.fullUpdate?.();
          });
        },
        dispose() {
          if (disposed) return;
          disposed = true;
          // initBoard can retire a previous board for the same container before
          // React runs that controller's cleanup. JSXGraph then leaves `jc`
          // null, and calling freeBoard again throws while reading jc.creator.
          if (board.jc === null) return;
          board.off?.('down', inspect);
          board.off?.('boundingbox', viewportChanged);
          try {
            namespace.JSXGraph.freeBoard(board);
          } catch (error) {
            // A partially/previously freed board is already safe to forget.
            // Preserve unrelated cleanup failures so they remain observable.
            if (board.jc == null) return;
            throw error;
          }
        },
      };
    },
  };
}

export function isNumericGraphPoint(point: GraphPoint): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}
