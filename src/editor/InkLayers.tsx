import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { StrokeElementV2 } from "../domain/v2";
import type { PageElementV3 as PageElementV2 } from "../domain/v3";
import { isBackgroundElement } from "./canvasOrder";
import { inkTileSize, isContextLost, onTabVisible, watchCanvasContext } from "./canvasSafety";
import { drawInkStroke, prepareInkStroke } from "./ink";
import { framesOverlap, strokeBounds } from "./inkGeometry";
import type { Rect } from "./operations";

/**
 * Finished ink is painted onto canvas tiles instead of one DOM node per
 * stroke. A school page holds thousands of strokes; as DOM nodes they cost
 * hundreds of megabytes and re-rendered on every pen move.
 *
 * Z-order is kept exactly: consecutive strokes in the page order form one
 * run, and each run is one layer whose z-index sits between the DOM elements
 * (text, images, PDF pages, Math) around it. A layer only creates canvases
 * for tiles that are near the visible part of the page and hold some of its
 * ink, and only repaints a tile when a stroke on it changed. Ink that is
 * being erased or dragged is hidden by the layer, not removed from its run,
 * so the run and its tile grid stay as they are while a swipe touches
 * stroke after stroke.
 */
export interface InkRun {
  kind: "ink";
  key: string;
  zIndex: number;
  strokes: readonly StrokeElementV2[];
  highlighter: boolean;
}

export interface DomElementEntry {
  kind: "element";
  id: string;
  zIndex: number;
  /** A page background (see canvasOrder), drawn below all ink and text. */
  background?: boolean;
}

export type PageLayer = InkRun | DomElementEntry;

/** Splits the page order into ink runs and DOM elements, skipping erased ink. */
export function buildPageLayers(
  order: readonly string[],
  elements: Readonly<Record<string, PageElementV2>>,
): PageLayer[] {
  const layers: PageLayer[] = [];
  let run: (InkRun & { strokes: StrokeElementV2[] }) | null = null;
  order.forEach((id, index) => {
    const element = elements[id];
    if (!element) return;
    if (element.kind === "stroke") {
      if (element.tombstonedAt) return;
      if (!run) {
        run = { kind: "ink", key: `ink:${id}`, zIndex: index + 1, strokes: [], highlighter: false };
        layers.push(run);
      }
      run.strokes.push(element);
      if (element.tool === "highlighter") run.highlighter = true;
      return;
    }
    run = null;
    // Backgrounds share z-index 0 below every run and element; among
    // themselves the page order (DOM order) still decides.
    if (isBackgroundElement(element)) layers.push({ kind: "element", id, zIndex: 0, background: true });
    else layers.push({ kind: "element", id, zIndex: index + 1 });
  });
  return layers;
}

/** Page units per tile side for a backing-store scale, keeping tiles near 1,000 px. */
export function tileSizeForScale(scale: number): number {
  if (scale > 5) return 128;
  if (scale > 2.5) return 256;
  return 512;
}

function tileKey(column: number, row: number): string {
  return `${column}:${row}`;
}

/** Strokes per tile, in z-order. A stroke spanning tiles is listed in each. */
function bucketStrokes(
  strokes: readonly StrokeElementV2[],
  tile: number,
): Map<string, StrokeElementV2[]> {
  const buckets = new Map<string, StrokeElementV2[]>();
  for (const stroke of strokes) {
    const bounds = strokeBounds(stroke);
    const reach = stroke.size;
    const firstColumn = Math.floor((bounds.x - reach) / tile);
    const lastColumn = Math.floor((bounds.x + bounds.width + reach) / tile);
    const firstRow = Math.floor((bounds.y - reach) / tile);
    const lastRow = Math.floor((bounds.y + bounds.height + reach) / tile);
    for (let row = firstRow; row <= lastRow; row += 1) {
      for (let column = firstColumn; column <= lastColumn; column += 1) {
        const key = tileKey(column, row);
        let bucket = buckets.get(key);
        if (!bucket) {
          bucket = [];
          buckets.set(key, bucket);
        }
        bucket.push(stroke);
      }
    }
  }
  return buckets;
}

interface DrawnTile {
  scale: number;
  strokes: readonly StrokeElementV2[];
}

function sameStrokes(left: readonly StrokeElementV2[], right: readonly StrokeElementV2[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/** Whether `longer` is `shorter` with strokes added at the end. */
export function extendsStrokes(shorter: readonly StrokeElementV2[], longer: readonly StrokeElementV2[]): boolean {
  if (longer.length <= shorter.length) return false;
  for (let index = 0; index < shorter.length; index += 1) {
    if (shorter[index] !== longer[index]) return false;
  }
  return true;
}

/** Time slice for background work between frames. */
const IDLE_SLICE_MS = 4;
/** Page units by which the region whose outlines are prepared ahead of time moves. */
const PREPARE_STEP = 256;

/**
 * Runs `work` in the browser's idle periods, repeatedly while it returns
 * true. `work` is told how many milliseconds it may take. Returns a cancel.
 */
export function whenIdle(work: (budgetMs: number) => boolean, sliceMs = IDLE_SLICE_MS): () => void {
  if (typeof requestIdleCallback === "function") {
    let handle = 0;
    const run = (deadline: IdleDeadline) => {
      if (work(Math.min(sliceMs, Math.max(1, deadline.timeRemaining() - 1)))) {
        handle = requestIdleCallback(run);
      }
    };
    handle = requestIdleCallback(run);
    return () => cancelIdleCallback(handle);
  }
  let timer: ReturnType<typeof setTimeout> = setTimeout(function run() {
    if (work(sliceMs)) timer = setTimeout(run, 30);
  }, 100);
  return () => clearTimeout(timer);
}

export interface InkLayerProps {
  run: InkRun;
  /** Strokes of the run to leave off its tiles for now. */
  hidden: ReadonlySet<string>;
  /** The part of the page to keep painted, in page units. */
  view: Rect;
  /** Device pixels per page unit for the canvases. */
  scale: number;
}

function sameLayerProps(previous: InkLayerProps, next: InkLayerProps): boolean {
  return previous.scale === next.scale
    && previous.view.x === next.view.x
    && previous.view.y === next.view.y
    && previous.view.width === next.view.width
    && previous.view.height === next.view.height
    && previous.hidden === next.hidden
    && previous.run.key === next.run.key
    && previous.run.zIndex === next.run.zIndex
    && previous.run.highlighter === next.run.highlighter
    && sameStrokes(previous.run.strokes, next.run.strokes);
}

export const InkLayer = memo(function InkLayer({ run, hidden, view, scale }: InkLayerProps) {
  const tile = inkTileSize(tileSizeForScale(scale), scale, view);
  const buckets = useMemo(() => bucketStrokes(run.strokes, tile), [run.strokes, tile]);
  const visible = useMemo(() => {
    const keys: Array<{ key: string; column: number; row: number }> = [];
    const firstColumn = Math.floor(view.x / tile);
    const lastColumn = Math.floor((view.x + view.width) / tile);
    const firstRow = Math.floor(view.y / tile);
    const lastRow = Math.floor((view.y + view.height) / tile);
    for (let row = firstRow; row <= lastRow; row += 1) {
      for (let column = firstColumn; column <= lastColumn; column += 1) {
        const key = tileKey(column, row);
        if (buckets.has(key)) keys.push({ key, column, row });
      }
    }
    return keys;
  }, [buckets, tile, view.height, view.width, view.x, view.y]);
  const canvases = useRef(new Map<string, HTMLCanvasElement>());
  const drawn = useRef(new WeakMap<HTMLCanvasElement, DrawnTile>());
  // A browser drops a canvas's pixels under memory pressure, after a GPU
  // reset and while a tab is hidden, and shows the canvas empty (or black)
  // until it is painted again. A tile therefore forgets what it was painted
  // with when that may have happened, and the effect below paints it again
  // from the strokes.
  const [repaintEpoch, setRepaintEpoch] = useState(0);
  const forgetTile = useCallback((canvas?: HTMLCanvasElement) => {
    if (canvas) drawn.current.delete(canvas);
    else drawn.current = new WeakMap();
    setRepaintEpoch((epoch) => epoch + 1);
  }, []);
  useEffect(() => onTabVisible(() => forgetTile()), [forgetTile]);

  useLayoutEffect(() => {
    for (const { key, column, row } of visible) {
      const canvas = canvases.current.get(key);
      const bucket = buckets.get(key);
      if (!canvas || !bucket) continue;
      const strokes = hidden.size === 0 ? bucket : bucket.filter((stroke) => !hidden.has(stroke.id));
      const previous = drawn.current.get(canvas);
      if (previous && previous.scale === scale && sameStrokes(previous.strokes, strokes)) continue;
      const context = canvas.getContext("2d");
      if (!context || isContextLost(context)) continue;
      // A stroke that was just written lands at the end of its tile: paint it
      // over what is there instead of repainting every stroke of the tile,
      // which would cost more with every stroke of a full page.
      const appendedOnly = previous !== undefined && previous.scale === scale && extendsStrokes(previous.strokes, strokes);
      if (!appendedOnly) {
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.clearRect(0, 0, canvas.width, canvas.height);
      }
      context.setTransform(scale, 0, 0, scale, -column * tile * scale, -row * tile * scale);
      for (const stroke of appendedOnly ? strokes.slice(previous.strokes.length) : strokes) drawInkStroke(context, stroke);
      drawn.current.set(canvas, { scale, strokes });
    }
  }, [buckets, hidden, repaintEpoch, scale, tile, visible]);

  // Idle time builds the outlines of the ink just beyond the painted region,
  // so that scrolling to it only has to fill them: a tile that comes into
  // view otherwise computes several hundred outlines in one frame. The region
  // is taken in coarse steps, so a view that moves continuously (a dragged
  // selection) does not restart the work on every move.
  const regionX = Math.floor(view.x / PREPARE_STEP) * PREPARE_STEP;
  const regionY = Math.floor(view.y / PREPARE_STEP) * PREPARE_STEP;
  useEffect(() => {
    let pending: StrokeElementV2[] | undefined;
    let next = 0;
    return whenIdle((budgetMs) => {
      const started = performance.now();
      if (!pending) {
        const ahead = {
          x: regionX - view.width,
          y: regionY - view.height,
          width: view.width * 3,
          height: view.height * 3,
        };
        const centre = { x: regionX + view.width / 2, y: regionY + view.height / 2 };
        pending = run.strokes
          .flatMap((stroke) => {
            const bounds = strokeBounds(stroke);
            return framesOverlap(bounds, ahead)
              ? [{ stroke, distance: Math.hypot(bounds.x - centre.x, bounds.y - centre.y) }]
              : [];
          })
          .sort((left, right) => left.distance - right.distance)
          .map((entry) => entry.stroke);
      }
      while (next < pending.length && performance.now() - started < budgetMs) {
        prepareInkStroke(pending[next]);
        next += 1;
      }
      return next < pending.length;
    });
  }, [run.strokes, regionX, regionY, view.height, view.width]);

  const pixels = Math.ceil(tile * scale);
  return (
    <div
      className="live-canvas-ink-layer"
      data-ink-layer={run.key}
      data-ink-blend={run.highlighter ? "multiply" : undefined}
      style={{ zIndex: run.zIndex }}
      aria-hidden="true"
    >
      {visible.map(({ key, column, row }) => (
        <canvas
          key={`${key}@${tile}`}
          ref={(node) => {
            if (!node) return;
            canvases.current.set(key, node);
            const unwatch = watchCanvasContext(node, {
              onLost: () => forgetTile(node),
              onRestored: () => forgetTile(node),
            });
            return () => {
              unwatch();
              if (canvases.current.get(key) === node) canvases.current.delete(key);
            };
          }}
          className="live-canvas-ink-tile"
          width={pixels}
          height={pixels}
          style={{ left: column * tile, top: row * tile, width: tile, height: tile }}
        />
      ))}
    </div>
  );
}, sameLayerProps);
