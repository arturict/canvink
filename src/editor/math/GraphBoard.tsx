import { useEffect, useEffectEvent, useMemo, useRef } from 'react';
import { isolateCanvasEvent } from './canvasIsolation';
import './mathCanvas.css';

export interface GraphPoint {
  x: number;
  y: number;
}

export interface GraphSeries {
  id: string;
  color: string;
  visible: boolean;
  points: readonly GraphPoint[];
}

export interface GraphViewport {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}

export interface GraphBoardController {
  update(series: readonly GraphSeries[]): void;
  reset(viewport?: GraphViewport): void;
  resize(width: number, height: number): void;
  dispose(): void;
}

export interface ViewportCommitter {
  schedule(viewport: GraphViewport): void;
  flush(): void;
  cancel(): void;
}

export interface GraphBoardFactory {
  create(
    container: HTMLElement,
    options: {
      series: readonly GraphSeries[];
      viewport: GraphViewport;
      equalScale: boolean;
      axesVisible: boolean;
      gridVisible: boolean;
      interactive: boolean;
      onCoordinateInspect?: (point: GraphPoint) => void;
      onViewportChange?: (viewport: GraphViewport) => void;
    },
  ): GraphBoardController;
}

export interface GraphBoardLabels {
  graph: string;
  reset: string;
  equalScale: string;
  axesVisible: string;
  gridVisible: string;
  visible: string;
  coordinate: string;
}

export interface GraphBoardProps {
  factory: GraphBoardFactory;
  series: readonly GraphSeries[];
  viewport: GraphViewport;
  resetViewport?: GraphViewport;
  equalScale: boolean;
  axesVisible: boolean;
  gridVisible: boolean;
  labels: GraphBoardLabels;
  viewer?: boolean;
  onVisibilityChange?: (seriesId: string, visible: boolean) => void;
  onEqualScaleChange?: (equalScale: boolean) => void;
  onAxesVisibleChange?: (visible: boolean) => void;
  onGridVisibleChange?: (visible: boolean) => void;
  onCoordinateInspect?: (point: GraphPoint) => void;
  onViewportChange?: (viewport: GraphViewport) => void;
  onReset?: () => void;
  viewportCommitDelayMs?: number;
}

const MAX_SERIES = 16;
const MAX_POINTS_PER_SERIES = 20_000;
const COLOR_PATTERN = /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i;

function assertFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) throw new TypeError(`${name} must be finite`);
}

export function validateGraphViewport(viewport: GraphViewport): GraphViewport {
  assertFinite(viewport.xMin, 'xMin');
  assertFinite(viewport.xMax, 'xMax');
  assertFinite(viewport.yMin, 'yMin');
  assertFinite(viewport.yMax, 'yMax');
  if (viewport.xMin >= viewport.xMax || viewport.yMin >= viewport.yMax) {
    throw new RangeError('Graph viewport bounds must be increasing');
  }
  return { ...viewport };
}

export function validateGraphSeries(series: readonly GraphSeries[]): GraphSeries[] {
  if (series.length > MAX_SERIES) throw new RangeError('Too many graph series');
  const ids = new Set<string>();
  return series.map((item) => {
    if (!item.id || item.id.length > 128 || ids.has(item.id)) {
      throw new TypeError('Graph series IDs must be unique and bounded');
    }
    ids.add(item.id);
    if (!COLOR_PATTERN.test(item.color)) throw new TypeError('Graph colors must be hexadecimal');
    if (item.points.length > MAX_POINTS_PER_SERIES) throw new RangeError('Too many graph points');
    return {
      id: item.id,
      color: item.color,
      visible: item.visible,
      points: item.points.map((point) => {
        assertFinite(point.x, 'point.x');
        assertFinite(point.y, 'point.y');
        return { x: point.x, y: point.y };
      }),
    };
  });
}

export function createViewportCommitter(
  commit: (viewport: GraphViewport) => void,
  scheduleTimer: (callback: () => void, delayMs: number) => number,
  cancelTimer: (handle: number) => void,
  delayMs = 250,
): ViewportCommitter {
  let pending: GraphViewport | null = null;
  let timer: number | null = null;
  const flush = () => {
    if (timer != null) cancelTimer(timer);
    timer = null;
    if (!pending) return;
    const next = pending;
    pending = null;
    commit(next);
  };
  return {
    schedule(viewport) {
      pending = validateGraphViewport(viewport);
      if (timer != null) cancelTimer(timer);
      timer = scheduleTimer(flush, delayMs);
    },
    flush,
    cancel() {
      if (timer != null) cancelTimer(timer);
      timer = null;
      pending = null;
    },
  };
}

export function GraphBoard({
  factory,
  series,
  viewport,
  resetViewport,
  equalScale,
  axesVisible,
  gridVisible,
  labels,
  viewer = false,
  onVisibilityChange,
  onEqualScaleChange,
  onAxesVisibleChange,
  onGridVisibleChange,
  onCoordinateInspect,
  onViewportChange,
  onReset,
  viewportCommitDelayMs = 250,
}: GraphBoardProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const controllerRef = useRef<GraphBoardController | null>(null);
  const viewportCommitterRef = useRef<ViewportCommitter | null>(null);
  const dispatchCoordinateInspect = useEffectEvent((point: GraphPoint) => onCoordinateInspect?.(point));
  const dispatchViewportChange = useEffectEvent((next: GraphViewport) => onViewportChange?.(next));
  const { xMin, xMax, yMin, yMax } = viewport;
  const resetBounds = resetViewport ?? viewport;
  const validatedSeries = useMemo(() => validateGraphSeries(series), [series]);
  const validatedViewport = useMemo(
    () => validateGraphViewport({ xMin, xMax, yMin, yMax }),
    [xMax, xMin, yMax, yMin],
  );
  const validatedResetViewport = useMemo(() => validateGraphViewport({
    xMin: resetBounds.xMin,
    xMax: resetBounds.xMax,
    yMin: resetBounds.yMin,
    yMax: resetBounds.yMax,
  }), [resetBounds.xMax, resetBounds.xMin, resetBounds.yMax, resetBounds.yMin]);
  useEffect(() => {
    const committer = createViewportCommitter(
      dispatchViewportChange,
      (callback, delayMs) => globalThis.setTimeout(callback, delayMs) as unknown as number,
      (handle) => globalThis.clearTimeout(handle),
      viewportCommitDelayMs,
    );
    viewportCommitterRef.current = committer;
    // A pan or zoom is committed after a short pause. Leaving the page inside
    // that pause (a reload, closing the tab) would lose it, so it is committed
    // first. The capture phase runs this before the workspace's own flush on
    // the same event, which then writes it.
    const commitWhenLeaving = () => {
      if (document.visibilityState === 'hidden') committer.flush();
    };
    const commitOnPageHide = () => committer.flush();
    window.addEventListener('pagehide', commitOnPageHide, true);
    document.addEventListener('visibilitychange', commitWhenLeaving, true);
    return () => {
      window.removeEventListener('pagehide', commitOnPageHide, true);
      document.removeEventListener('visibilitychange', commitWhenLeaving, true);
      committer.flush();
      if (viewportCommitterRef.current === committer) viewportCommitterRef.current = null;
    };
  }, [viewportCommitDelayMs]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const controller = factory.create(container, {
      series: [],
      viewport: validatedViewport,
      equalScale,
      axesVisible,
      gridVisible,
      interactive: !viewer,
      onCoordinateInspect: dispatchCoordinateInspect,
      onViewportChange: (next) => viewportCommitterRef.current?.schedule(next),
    });
    controllerRef.current = controller;
    let disposed = false;
    const resize = (width: number, height: number) => {
      if (!disposed && Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
        controller.resize(width, height);
      }
    };
    const observer = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver((entries) => {
          const rect = entries.find((entry) => entry.target === container)?.contentRect;
          if (rect) resize(rect.width, rect.height);
        });
    observer?.observe(container);
    const rect = container.getBoundingClientRect();
    resize(rect.width, rect.height);
    return () => {
      disposed = true;
      observer?.disconnect();
      controller.dispose();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, [axesVisible, equalScale, factory, gridVisible, validatedViewport, viewer]);

  // A toggle rebuilds the board from the viewport in the props, so a pan or
  // zoom still waiting for its pause is committed first, not overwritten.
  const commitThen = (change: () => void) => {
    viewportCommitterRef.current?.flush();
    change();
  };

  useEffect(() => {
    controllerRef.current?.update(validatedSeries);
  }, [validatedSeries]);

  return (
    <section
      className="graph-board"
      aria-label={labels.graph}
      onPointerDown={isolateCanvasEvent}
      onPointerMove={isolateCanvasEvent}
      onPointerUp={isolateCanvasEvent}
      onPointerCancel={isolateCanvasEvent}
      onKeyDown={isolateCanvasEvent}
      onWheel={isolateCanvasEvent}
    >
      <div className="graph-board__toolbar">
        <button
          type="button"
          disabled={viewer}
          onClick={() => {
            controllerRef.current?.reset(validatedResetViewport);
            viewportCommitterRef.current?.schedule(validatedResetViewport);
            onReset?.();
          }}
        >
          {labels.reset}
        </button>
        <label>
          <input
            type="checkbox"
            checked={equalScale}
            disabled={viewer}
            onChange={(event) => commitThen(() => onEqualScaleChange?.(event.target.checked))}
          />
          {labels.equalScale}
        </label>
        <label>
          <input type="checkbox" checked={axesVisible} disabled={viewer} onChange={(event) => commitThen(() => onAxesVisibleChange?.(event.target.checked))} />
          {labels.axesVisible}
        </label>
        <label>
          <input type="checkbox" checked={gridVisible} disabled={viewer} onChange={(event) => commitThen(() => onGridVisibleChange?.(event.target.checked))} />
          {labels.gridVisible}
        </label>
      </div>
      <div className="graph-board__surface-frame" role="img" aria-label={labels.coordinate}>
        <div ref={containerRef} className="graph-board__surface" aria-hidden="true" />
      </div>
      <ul className="graph-board__legend">
        {validatedSeries.map((item) => (
          <li key={item.id}>
            <label>
              <input
                type="checkbox"
                checked={item.visible}
                disabled={viewer}
                onChange={(event) => onVisibilityChange?.(item.id, event.target.checked)}
              />
              <span className="graph-board__swatch" style={{ backgroundColor: item.color }} />
              {item.id} {labels.visible}
            </label>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default GraphBoard;
